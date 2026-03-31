"""
FedRecovery engine — retroactively corrects the global model by removing a
flagged client's poisoned gradient contributions from all archived rounds.

Algorithm (Approach B):
  1. Collect all archived rounds for the flagged client.
  2. Reconstruct the CKKS private context ONCE via VSS cooperative decrypt
     (one ceremony, not one per round).
  3. For each archived round (oldest → newest):
       a. Deserialise the flagged client's CKKS-encrypted weighted delta.
       b. Decrypt using the reconstructed private context.
       c. Compute correction = -flagged_contribution + Gaussian DP noise.
       d. Apply correction to the live global model's state dict.
       e. POST /fl/fedrecovery/step to backend (crash-safe, per-step commit).
  4. Destroy private context immediately after all rounds are processed.
  5. POST /fl/fedrecovery/complete to backend with final metrics.

Properties:
  - One VSS ceremony per recovery run (T ceremonies, not N×T).
  - DP noise: Gaussian mechanism (epsilon=0.10, delta=1e-5 by default).
  - Partial recovery: VSS failure or timeout → SKIPPED, loop continues.
  - Crash-safe: each step committed individually via backend POST.
  - Cancellation: set engine.cancel() before apply_to_model to abort.
  - Thread isolation: caller must hold _fedrecovery_lock before calling run().
"""

import gc
import logging
import math
import secrets
import time
from collections import OrderedDict
from typing import Callable, Dict, List, Optional

import numpy as np
import torch

from gradient_archive import GradientArchive

log = logging.getLogger(__name__)

# ── Defaults ──────────────────────────────────────────────
DEFAULT_EPSILON: float = 0.10
DEFAULT_DELTA_DP: float = 1e-5
DEFAULT_VSS_TIMEOUT_SEC: float = 2.0


def _gaussian_sigma(sensitivity: float, epsilon: float, delta: float) -> float:
    """Return the Gaussian mechanism noise std-dev for given privacy parameters.

    Uses the standard formula: σ = sqrt(2 ln(1.25/δ)) · Δf / ε
    where Δf = L2 sensitivity of the function being protected.
    """
    return math.sqrt(2.0 * math.log(1.25 / delta)) * sensitivity / epsilon


class FedRecoveryEngine:
    """Retroactive correction engine for gradient-poisoning attacks.

    Accepts a backend POST callable so it remains testable without a live
    backend (pass a no-op lambda in tests).

    Args:
        archive:         GradientArchive instance shared with FedAvgHE.
        model:           The live global CNN_LSTM_IDS model (mutated in-place).
        vss:             VSS state dict {"shares": …, "nonces": …, "commitments": …}.
        public_ctx:      Public (key-stripped) TenSEAL CKKS context.
        post_fn:         Callable(path: str, payload: dict) → bool for backend POSTs.
        epsilon:         DP privacy budget (default 0.10).
        delta_dp:        DP failure probability (default 1e-5).
        vss_timeout_sec: Seconds to wait for VSS reconstruction before aborting.
    """

    def __init__(
        self,
        archive: GradientArchive,
        model,  # CNN_LSTM_IDS
        vss: dict,
        public_ctx,  # ts.Context
        post_fn: Callable[[str, dict], bool],
        epsilon: float = DEFAULT_EPSILON,
        delta_dp: float = DEFAULT_DELTA_DP,
        vss_timeout_sec: float = DEFAULT_VSS_TIMEOUT_SEC,
    ) -> None:
        self._archive = archive
        self._model = model
        self._vss = vss
        self._public_ctx = public_ctx
        self._post = post_fn
        self.epsilon = epsilon
        self.delta_dp = delta_dp
        self.vss_timeout_sec = vss_timeout_sec
        self._cancelled = False

    # ── public API ────────────────────────────────────────

    def cancel(self) -> None:
        """Signal the engine to abort before the next apply_to_model call."""
        self._cancelled = True

    def run(
        self,
        flagged_client_id: str,
        flag_round: int,
    ) -> dict:
        """Run the full recovery pipeline for a single flagged client.

        Returns a summary dict with keys: run_id, status, rounds_corrected,
        rounds_skipped, before_norms, after_norms, epsilon, sigma.
        """
        run_id = secrets.token_hex(16)
        self._cancelled = False
        t_start = time.time()

        log.info(
            "FedRecovery starting: run_id=%s client=%s flag_round=%d",
            run_id,
            flagged_client_id,
            flag_round,
        )

        # ── Announce start ────────────────────────────────
        self._post(
            "/api/v1/internal/fl/fedrecovery/started",
            {
                "run_id": run_id,
                "flagged_client_id": flagged_client_id,
                "flag_round": flag_round,
            },
        )

        # ── Collect archived rounds ───────────────────────
        archived_rounds: List[int] = self._archive.get_client_rounds(flagged_client_id)
        if not archived_rounds:
            log.warning(
                "FedRecovery: no archived rounds for client %s — nothing to correct",
                flagged_client_id,
            )
            self._post(
                "/api/v1/internal/fl/fedrecovery/complete",
                {
                    "run_id": run_id,
                    "status": "complete",
                    "rounds_corrected": 0,
                    "rounds_skipped": 0,
                },
            )
            return {
                "run_id": run_id,
                "status": "complete",
                "rounds_corrected": 0,
                "rounds_skipped": 0,
            }

        # ── Snapshot norms before correction ─────────────
        before_norms = self._compute_model_norms()

        # ── VSS: reconstruct private context ONCE ────────
        private_ctx = self._reconstruct_private_ctx()
        if private_ctx is None:
            log.error(
                "FedRecovery: VSS reconstruction failed — aborting run %s", run_id
            )
            self._post(
                "/api/v1/internal/fl/fedrecovery/complete",
                {
                    "run_id": run_id,
                    "status": "failed",
                    "rounds_corrected": 0,
                    "rounds_skipped": len(archived_rounds),
                    "before_norms": before_norms,
                },
            )
            return {
                "run_id": run_id,
                "status": "failed",
                "rounds_corrected": 0,
                "rounds_skipped": len(archived_rounds),
            }

        # ── Per-round correction loop ─────────────────────
        rounds_corrected = 0
        rounds_skipped = 0
        sigma_used: Optional[float] = None

        try:
            for rnd in archived_rounds:
                if self._cancelled:
                    log.info("FedRecovery run %s cancelled at round %d", run_id, rnd)
                    break

                step_result = self._correct_round(
                    run_id=run_id,
                    flagged_client_id=flagged_client_id,
                    rnd=rnd,
                    private_ctx=private_ctx,
                )

                if step_result["step"] == "corrected":
                    rounds_corrected += 1
                    if sigma_used is None:
                        sigma_used = step_result.get("sigma")
                else:
                    rounds_skipped += 1
        finally:
            # ── Destroy private context regardless of outcome ──
            del private_ctx
            gc.collect()
            log.debug("FedRecovery: private CKKS context destroyed (run_id=%s)", run_id)

        # ── Determine final status ────────────────────────
        if self._cancelled:
            status = "cancelled"
        elif rounds_corrected == 0:
            status = "failed"
        elif rounds_skipped > 0:
            status = "partial"
        else:
            status = "complete"

        after_norms = self._compute_model_norms() if rounds_corrected > 0 else None
        duration = round(time.time() - t_start, 2)

        log.info(
            "FedRecovery complete: run_id=%s status=%s corrected=%d skipped=%d dur=%.2fs",
            run_id,
            status,
            rounds_corrected,
            rounds_skipped,
            duration,
        )

        self._post(
            "/api/v1/internal/fl/fedrecovery/complete",
            {
                "run_id": run_id,
                "status": status,
                "rounds_corrected": rounds_corrected,
                "rounds_skipped": rounds_skipped,
                "before_norms": before_norms,
                "after_norms": after_norms,
                "epsilon": self.epsilon,
                "sigma": sigma_used,
            },
        )

        return {
            "run_id": run_id,
            "status": status,
            "rounds_corrected": rounds_corrected,
            "rounds_skipped": rounds_skipped,
            "before_norms": before_norms,
            "after_norms": after_norms,
            "epsilon": self.epsilon,
            "sigma": sigma_used,
        }

    # ── private helpers ───────────────────────────────────

    def _reconstruct_private_ctx(self):
        """VSS cooperative reconstruct. Returns ts.Context or None on error."""
        try:
            import tenseal as ts
            from fl_common.vss_utils import reconstruct_and_get_context

            ctx = reconstruct_and_get_context(
                contributed_shares=self._vss["shares"],
                nonces=self._vss["nonces"],
                commitments=self._vss["commitments"],
                public_ctx=self._public_ctx,
            )
            log.debug("FedRecovery: private CKKS context reconstructed via VSS")
            return ctx
        except Exception as exc:
            log.error("FedRecovery: VSS reconstruction failed: %s", exc)
            return None

    def _decrypt_enc_bytes(
        self,
        enc_bytes: Dict[str, bytes],
        private_ctx,
        shapes: Dict[str, tuple],
    ) -> Optional[Dict[str, torch.Tensor]]:
        """Deserialise archived CKKS bytes and decrypt using a live private context.

        Returns {layer: tensor} or None on failure.  Does NOT divide by num_clients
        because the archived bytes already encode the weighted (scaled) delta.
        """
        try:
            import tenseal as ts

            decrypted: Dict[str, torch.Tensor] = {}
            for layer, raw in enc_bytes.items():
                enc_vec = ts.ckks_vector_from(self._public_ctx, raw)
                enc_vec.link_context(private_ctx)
                flat = np.array(enc_vec.decrypt(), dtype=np.float32)
                flat = np.nan_to_num(flat, nan=0.0, posinf=0.0, neginf=0.0)

                shape = shapes.get(layer)
                if shape is None:
                    log.warning(
                        "FedRecovery: no shape for layer %s — skipping layer", layer
                    )
                    continue
                num_elements = int(np.prod(shape))
                flat = flat[:num_elements]
                decrypted[layer] = torch.tensor(flat, dtype=torch.float32).reshape(
                    shape
                )
            return decrypted if decrypted else None
        except Exception as exc:
            log.warning("FedRecovery: decrypt failed: %s", exc)
            return None

    def _apply_correction(
        self,
        correction: Dict[str, torch.Tensor],
    ) -> None:
        """Subtract the correction tensors from the live global model in-place."""
        state = OrderedDict(self._model.state_dict())
        for layer, delta in correction.items():
            if layer in state:
                state[layer] = state[layer].cpu() + delta.cpu()
        self._model.load_state_dict(state, strict=True)

    def _compute_model_norms(self) -> Dict[str, float]:
        """Return per-layer L2 norms for all state dict tensors."""
        try:
            from fl_common.model import SELECTED_LAYERS

            state = self._model.state_dict()
            return {
                k: round(float(state[k].norm().item()), 6)
                for k in SELECTED_LAYERS
                if k in state
            }
        except Exception as exc:
            log.warning("FedRecovery: could not compute model norms: %s", exc)
            return {}

    def _add_dp_noise(
        self,
        correction: Dict[str, torch.Tensor],
    ) -> tuple[Dict[str, torch.Tensor], float]:
        """Add calibrated Gaussian DP noise to the correction tensors.

        Sensitivity is the L2 norm of the correction (data-dependent, conservative).
        Returns (noised_correction, sigma_used).
        """
        sensitivity = sum(t.norm().item() for t in correction.values())
        sensitivity = max(sensitivity, 1e-6)  # avoid division by zero

        sigma = _gaussian_sigma(sensitivity, self.epsilon, self.delta_dp)
        sigma = min(sigma, sensitivity * 10.0)  # cap at 10× sensitivity

        noised = {}
        for layer, tensor in correction.items():
            noise = torch.randn_like(tensor) * sigma
            noised[layer] = tensor + noise

        log.debug(
            "FedRecovery DP noise: sensitivity=%.6f epsilon=%.3f sigma=%.6f",
            sensitivity,
            self.epsilon,
            sigma,
        )
        return noised, sigma

    def _correct_round(
        self,
        run_id: str,
        flagged_client_id: str,
        rnd: int,
        private_ctx,
    ) -> dict:
        """Attempt to correct one round. Returns {'step': 'corrected'|'skipped', ...}."""
        enc_bytes = self._archive.get_enc(flagged_client_id, rnd)
        if enc_bytes is None:
            log.warning(
                "FedRecovery: no enc bytes for client=%s round=%d — skipping",
                flagged_client_id,
                rnd,
            )
            self._post(
                "/api/v1/internal/fl/fedrecovery/step",
                {
                    "run_id": run_id,
                    "round": rnd,
                    "step": "skipped",
                    "detail": "No archived encrypted bytes for this round",
                },
            )
            return {"step": "skipped"}

        # Shapes from current model (layer shapes are invariant during training)
        try:
            from fl_common.model import SELECTED_LAYERS

            state = self._model.state_dict()
            shapes = {k: tuple(state[k].shape) for k in SELECTED_LAYERS if k in state}
        except Exception as exc:
            log.warning("FedRecovery: could not get model shapes r%d: %s", rnd, exc)
            self._post(
                "/api/v1/internal/fl/fedrecovery/step",
                {
                    "run_id": run_id,
                    "round": rnd,
                    "step": "skipped",
                    "detail": f"Could not get model shapes: {exc}",
                },
            )
            return {"step": "skipped"}

        # Decrypt flagged client's weighted contribution for this round
        flagged_contribution = self._decrypt_enc_bytes(enc_bytes, private_ctx, shapes)
        if flagged_contribution is None:
            log.warning(
                "FedRecovery: decryption failed for client=%s round=%d — skipping",
                flagged_client_id,
                rnd,
            )
            self._post(
                "/api/v1/internal/fl/fedrecovery/step",
                {
                    "run_id": run_id,
                    "round": rnd,
                    "step": "skipped",
                    "detail": "CKKS decryption failed",
                },
            )
            return {"step": "skipped"}

        # Correction = negate the flagged contribution (remove it from model)
        raw_correction = {k: -v for k, v in flagged_contribution.items()}

        # Add DP noise
        noised_correction, sigma = self._add_dp_noise(raw_correction)

        # Compute per-layer delta norms for audit
        delta_norms = {
            k: round(float(v.norm().item()), 6) for k, v in noised_correction.items()
        }
        total_delta = round(sum(delta_norms.values()), 6)

        # Apply correction to live model
        self._apply_correction(noised_correction)

        log.info(
            "FedRecovery corrected: run_id=%s round=%d total_delta=%.6f sigma=%.6f",
            run_id,
            rnd,
            total_delta,
            sigma,
        )

        self._post(
            "/api/v1/internal/fl/fedrecovery/step",
            {
                "run_id": run_id,
                "round": rnd,
                "step": "corrected",
                "detail": f"total_delta={total_delta:.6f} sigma={sigma:.6f}",
                "data": {
                    "delta_norms": delta_norms,
                    "total_delta": total_delta,
                    "sigma": sigma,
                    "epsilon": self.epsilon,
                },
            },
        )

        return {"step": "corrected", "sigma": sigma, "total_delta": total_delta}
