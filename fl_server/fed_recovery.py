"""
FedRecovery engine — retroactively corrects the global model by removing a
flagged client's poisoned gradient contributions, following Algorithm 2 from
Zhang et al., "FedRecovery: Differentially Private Machine Unlearning for
Federated Learning Frameworks", IEEE TIFS Vol. 18, 2023.

Implementation notes vs. the paper:
  - Algorithm 1 (perturbed training) is NOT implemented. Adding Gaussian
    noise with sigma ~ 48 (for epsilon=0.1) to 32,833 parameters destroys
    IDS model accuracy. This means the full (epsilon, beta)-
    indistinguishability guarantee from Theorem 1 does not hold. The
    unlearning noise is still applied (Algorithm 2) and calibrated to the
    paper's formula.
  - The trigger semantic differs from the paper's GDPR "right to be
    forgotten" use case. Here FedRecovery is triggered automatically when
    RECESS anomaly detection flags a client (abnormality > 0.7). This is
    a security countermeasure, not a legal compliance mechanism.

Algorithm (paper Algorithm 2 — Unlearning Algorithm MU):
  1. Collect all archived rounds for the flagged client (up to flag_round).
  2. Reconstruct the CKKS private context ONCE via VSS cooperative decrypt.
  3. For each archived round i:
       a. Decrypt the flagged client's CKKS-encrypted weighted delta.
       b. Recover unweighted delta using archived metadata weight.
       c. Compute gradient residual delta_i using aggregated gradient.
  4. Compute per-round weights p_i from aggregated gradient norms (step 8).
  5. Compute weighted correction: correction = Sum(p_i * delta_i).
  6. Calibrate Gaussian DP noise using paper's sigma formula (Eq. 25)
     with data-independent theoretical sensitivity (Theorem 3).
  7. Apply noised correction to the live global model once.
  8. Destroy private context.

Properties:
  - One VSS ceremony per recovery run (not per round).
  - DP noise: paper's Gaussian mechanism (epsilon=0.10, beta=1e-5 default).
  - Theoretical sensitivity: data-independent (Theorem 3, Eqs. 34-36).
  - No sigma cap — sigma is calibrated purely by the formula.
  - Per-round weights p_i from aggregated gradient norms (step 8).
  - Round filtering: only rounds <= flag_round are processed (W-3).
  - Partial recovery: VSS failure -> abort; round decrypt failure -> skip.
  - Crash-safe: each step committed individually via backend POST.
  - Cancellation: set engine.cancel() to abort.
  - Thread isolation: caller must hold _fedrecovery_lock before calling run().
"""

import gc
import logging
import math
import secrets
import time
from collections import OrderedDict
from typing import Any, Callable, Dict, List, Optional

import numpy as np
import torch

from gradient_archive import GradientArchive

log = logging.getLogger(__name__)

# ── Defaults ──────────────────────────────────────────────
DEFAULT_EPSILON: float = 0.10
DEFAULT_BETA: float = 1e-5  # paper uses beta (failure probability)
DEFAULT_VSS_TIMEOUT_SEC: float = 2.0
DEFAULT_CLIP_BOUND: float = 10.0
DEFAULT_LEARNING_RATE: float = 1e-3
DEFAULT_NUM_CLIENTS: int = 2


# ── Standalone math functions (testable without engine) ───


def _paper_gaussian_sigma(sensitivity: float, epsilon: float, beta: float) -> float:
    """Return Gaussian mechanism sigma per the paper's Definition 1 / Eq. 25.

    Formula:
        sigma = (1/sqrt(2)) * d / (sqrt(ln(1/beta) + epsilon) - sqrt(ln(1/beta)))

    This inverts the paper's epsilon-expression (Eq. 6):
        epsilon = 1/(2*sigma^2) + (1/sigma)*sqrt(2*ln(1/beta))

    Args:
        sensitivity: The L2 sensitivity bound d (from Theorem 3).
        epsilon:     Privacy budget epsilon > 0.
        beta:        Privacy failure probability beta in (0, 1).

    Returns:
        sigma — the standard deviation for the Gaussian noise.
    """
    if epsilon <= 0 or beta <= 0 or beta >= 1 or sensitivity <= 0:
        raise ValueError(
            f"Invalid DP params: sensitivity={sensitivity}, epsilon={epsilon}, beta={beta}"
        )
    ln_inv_beta = math.log(1.0 / beta)
    denominator = math.sqrt(ln_inv_beta + epsilon) - math.sqrt(ln_inv_beta)
    if denominator < 1e-15:
        raise ValueError(
            f"Denominator too small (epsilon too small?): epsilon={epsilon}, beta={beta}"
        )
    return (1.0 / math.sqrt(2.0)) * sensitivity / denominator


def _theoretical_sensitivity(
    clip_bound: float,
    num_params: int,
    learning_rate: float,
    num_clients: int,
) -> float:
    """Compute the data-independent sensitivity bound d from Theorem 3.

    Simplified bound for our FL setup:
        d = 2 * clip * sqrt(num_params) * eta / (n - 1)

    This bounds ||w_bar_t - w_tilde_t|| (the distance between the unlearned
    model and the fully retrained model) without depending on training data.

    Args:
        clip_bound:    Gradient clipping bound (L-inf, applied in server.py).
        num_params:    Total number of parameters in SELECTED_LAYERS.
        learning_rate: FL training learning rate eta.
        num_clients:   Total number of FL clients n.

    Returns:
        d — the theoretical sensitivity bound.

    Raises:
        ValueError: If num_clients < 2.
    """
    if num_clients < 2:
        raise ValueError(
            f"Theoretical sensitivity requires num_clients >= 2, got {num_clients}"
        )
    return 2.0 * clip_bound * math.sqrt(num_params) * learning_rate / (num_clients - 1)


def _compute_round_weights(agg_norms_sq: Dict[int, float]) -> Dict[int, float]:
    """Compute per-round weights p_i from aggregated gradient norm-squared values.

    Paper Algorithm 2, step 8:
        p_i = ||grad_F(w_i)||^2 / Sum_j ||grad_F(w_j)||^2

    Args:
        agg_norms_sq: {round_num: ||agg_gradient||^2} for each round.

    Returns:
        {round_num: p_i} with Sum(p_i) = 1.0.
        Falls back to equal weights if total norm is approximately 0.
    """
    total = sum(agg_norms_sq.values())
    if total < 1e-12:
        # All aggregated gradients are near-zero — use equal weights
        n = max(len(agg_norms_sq), 1)
        return {rnd: 1.0 / n for rnd in agg_norms_sq}
    return {rnd: norm_sq / total for rnd, norm_sq in agg_norms_sq.items()}


def _compute_gradient_residual(
    flagged_weighted: Dict[str, torch.Tensor],
    agg_delta: Optional[Dict[str, torch.Tensor]],
    weight: float,
) -> Dict[str, torch.Tensor]:
    """Compute gradient residual delta_i for one round.

    Adapted from paper Algorithm 2, steps 5-7 for trust-weighted FL:
        delta_i = w * (Dw_{i_u} - agg) / (1 - w)

    Where:
        w        = trust-weighted normalised weight of the flagged client
        Dw_{i_u} = flagged_weighted / w  (unweighted delta)
        agg      = total aggregated model update (post - pre state)

    With equal weights (w = 1/n), this reduces to:
        delta_i = (Dw_{i_u} - agg) / (n - 1)

    Falls back to raw weighted delta if agg is unavailable or w is near 1.

    Args:
        flagged_weighted: Decrypted {layer: tensor} — the weighted delta w*Dw.
        agg_delta:        Aggregated gradient {layer: tensor}, or None.
        weight:           The flagged client's normalised weight w.

    Returns:
        {layer: tensor} — the gradient residual delta_i.
    """
    # Guard: if weight is approximately 0, the client had no impact
    if weight < 1e-12:
        return {k: torch.zeros_like(v) for k, v in flagged_weighted.items()}

    # Recover unweighted delta
    flagged_unweighted = {k: v / weight for k, v in flagged_weighted.items()}

    # If no aggregated gradient available or weight is near 1.0, fall back
    if agg_delta is None or (1.0 - weight) < 1e-12:
        log.debug(
            "Gradient residual fallback: agg=%s, weight=%.4f",
            "None" if agg_delta is None else "present",
            weight,
        )
        return dict(flagged_weighted)

    residual: Dict[str, torch.Tensor] = {}
    for layer, fw in flagged_weighted.items():
        if layer in agg_delta:
            # delta_i = w * (Dw_{i_u} - agg) / (1 - w)
            residual[layer] = (
                weight * (flagged_unweighted[layer] - agg_delta[layer]) / (1.0 - weight)
            )
        else:
            # Agg missing for this layer — use the raw weighted contribution
            residual[layer] = fw

    return residual


class FedRecoveryEngine:
    """Retroactive correction engine for gradient-poisoning attacks.

    Implements Algorithm 2 (Unlearning Algorithm MU) from Zhang et al.,
    IEEE TIFS 2023, adapted for trust-weighted FL with CKKS homomorphic
    encryption.

    The engine operates in two phases:
      Phase 1 — Decrypt all archived rounds and compute per-round gradient
                residuals (delta_i) and aggregated gradient norms. Each round
                is reported to the backend for live UI progress.
      Phase 2 — Compute weighted correction Sum(p_i * delta_i), add DP noise
                calibrated by theoretical sensitivity, and apply the combined
                correction to the model once.

    Args:
        archive:         GradientArchive instance shared with FedAvgHE.
        model:           The live global CNN_LSTM_IDS model (mutated in-place).
        vss:             VSS state dict {"shares", "nonces", "commitments"}.
        public_ctx:      Public (key-stripped) TenSEAL CKKS context.
        post_fn:         Callable(path, payload) -> bool for backend POSTs.
        epsilon:         DP privacy budget epsilon (default 0.10).
        beta:            DP failure probability beta (default 1e-5).
        num_clients:     Total number of FL clients n (default 2).
        clip_bound:      Gradient clipping bound (default 10.0).
        learning_rate:   FL learning rate eta (default 1e-3).
        vss_timeout_sec: VSS reconstruction timeout (default 2.0s).
    """

    def __init__(
        self,
        archive: GradientArchive,
        model,  # CNN_LSTM_IDS
        vss: dict,
        public_ctx,  # ts.Context
        post_fn: Callable[[str, dict], bool],
        epsilon: float = DEFAULT_EPSILON,
        beta: float = DEFAULT_BETA,
        num_clients: int = DEFAULT_NUM_CLIENTS,
        clip_bound: float = DEFAULT_CLIP_BOUND,
        learning_rate: float = DEFAULT_LEARNING_RATE,
        vss_timeout_sec: float = DEFAULT_VSS_TIMEOUT_SEC,
        # Legacy alias — server.py may still pass delta_dp=...
        delta_dp: Optional[float] = None,
    ) -> None:
        self._archive = archive
        self._model = model
        self._vss = vss
        self._public_ctx = public_ctx
        self._post = post_fn
        self.epsilon = epsilon
        self.beta = delta_dp if delta_dp is not None else beta
        self.num_clients = num_clients
        self.clip_bound = clip_bound
        self.learning_rate = learning_rate
        self.vss_timeout_sec = vss_timeout_sec
        self._cancelled = False

    # ── public API ────────────────────────────────────────

    def cancel(self) -> None:
        """Signal the engine to abort before the next round computation."""
        self._cancelled = True

    def run(
        self,
        flagged_client_id: str,
        flag_round: int,
    ) -> dict:
        """Run the full recovery pipeline for a single flagged client.

        Implements Algorithm 2 in two phases:
          Phase 1: Decrypt all archived rounds (up to flag_round), compute
                   per-round gradient residuals delta_i and aggregated gradient
                   norms. POST per-step progress to backend.
          Phase 2: Compute per-round weights p_i, weighted correction
                   Sum(p_i * delta_i), add DP noise with theoretical
                   sensitivity, apply to model once.

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

        # ── Collect archived rounds, filtered by flag_round (W-3) ──
        all_rounds = self._archive.get_client_rounds(flagged_client_id)
        archived_rounds = [r for r in all_rounds if r <= flag_round]

        if not archived_rounds:
            log.warning(
                "FedRecovery: no archived rounds for client %s up to round %d",
                flagged_client_id,
                flag_round,
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

        # ── Snapshot norms before correction ──────────────
        before_norms = self._compute_model_norms()

        # ── VSS: reconstruct private context ONCE ─────────
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

        # ── Phase 1: Decrypt all rounds, compute residuals and norms ──
        round_residuals: Dict[int, Dict[str, torch.Tensor]] = {}
        round_agg_norms_sq: Dict[int, float] = {}
        rounds_skipped = 0

        try:
            for rnd in archived_rounds:
                if self._cancelled:
                    log.info("FedRecovery run %s cancelled at round %d", run_id, rnd)
                    break

                result = self._compute_round_residual(
                    run_id=run_id,
                    flagged_client_id=flagged_client_id,
                    rnd=rnd,
                    private_ctx=private_ctx,
                )

                if result is not None:
                    round_residuals[rnd] = result["residual"]
                    round_agg_norms_sq[rnd] = result["agg_norm_sq"]
                else:
                    rounds_skipped += 1
        finally:
            # ── Destroy private context regardless of outcome ──
            del private_ctx
            gc.collect()
            log.debug("FedRecovery: private CKKS context destroyed (run_id=%s)", run_id)

        rounds_corrected = len(round_residuals)

        if rounds_corrected == 0:
            status = "cancelled" if self._cancelled else "failed"
            self._post(
                "/api/v1/internal/fl/fedrecovery/complete",
                {
                    "run_id": run_id,
                    "status": status,
                    "rounds_corrected": 0,
                    "rounds_skipped": rounds_skipped,
                    "before_norms": before_norms,
                },
            )
            return {
                "run_id": run_id,
                "status": status,
                "rounds_corrected": 0,
                "rounds_skipped": rounds_skipped,
                "before_norms": before_norms,
            }

        # ── Phase 2: Compute weighted correction (C-3) ────
        p_weights = _compute_round_weights(round_agg_norms_sq)
        log.info(
            "FedRecovery round weights (p_i): %s",
            {rnd: round(p, 4) for rnd, p in p_weights.items()},
        )

        # Weighted sum: Sum(p_i * delta_i)
        correction: Dict[str, torch.Tensor] = {}
        for rnd, residual in round_residuals.items():
            p_i = p_weights.get(rnd, 0.0)
            for layer, tensor in residual.items():
                if layer not in correction:
                    correction[layer] = torch.zeros_like(tensor)
                correction[layer] = correction[layer] + p_i * tensor

        # Negate: w_bar_t = w_t - Sum(p_i * delta_i)
        # => delta to add to model = -Sum(p_i * delta_i)
        correction = {k: -v for k, v in correction.items()}

        # ── Phase 3: Add DP noise (C-4, C-5, C-6) ────────
        noised_correction, sigma, sigma_per_layer = self._add_dp_noise(correction)

        # ── Phase 4: Apply correction to model (N-1) ─────
        self._apply_correction_delta(noised_correction)

        # ── Audit data ────────────────────────────────────
        delta_norms = {
            k: round(float(v.norm().item()), 6) for k, v in noised_correction.items()
        }
        total_delta = round(sum(delta_norms.values()), 6)

        # ── Determine final status ────────────────────────
        if self._cancelled:
            status = "cancelled"
        elif rounds_skipped > 0:
            status = "partial"
        else:
            status = "complete"

        after_norms = self._compute_model_norms()
        duration = round(time.time() - t_start, 2)

        log.info(
            "FedRecovery complete: run_id=%s status=%s corrected=%d skipped=%d "
            "sigma=%.6f total_delta=%.6f dur=%.2fs",
            run_id,
            status,
            rounds_corrected,
            rounds_skipped,
            sigma,
            total_delta,
            duration,
        )

        # N-2: Report all per-layer sigma values
        log.info(
            "FedRecovery sigma per layer: %s",
            {k: round(v, 6) for k, v in sigma_per_layer.items()},
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
                "sigma": sigma,
                "sigma_per_layer": {k: round(v, 6) for k, v in sigma_per_layer.items()},
                "delta_norms": delta_norms,
                "total_delta": total_delta,
                "round_weights": {rnd: round(p, 6) for rnd, p in p_weights.items()},
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
            "sigma": sigma,
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
        """Deserialise archived CKKS bytes and decrypt.

        Returns {layer: tensor} or None on failure. The returned tensors
        are the trust-weighted scaled deltas (w * Dw_i) as archived.
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
                    log.warning("FedRecovery: no shape for layer %s — skipping", layer)
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

    def _get_num_selected_params(self) -> int:
        """Count total parameters across SELECTED_LAYERS in the model."""
        try:
            from fl_common.model import SELECTED_LAYERS

            state = self._model.state_dict()
            return sum(state[k].numel() for k in SELECTED_LAYERS if k in state)
        except Exception:
            return 32833  # known default for our CNN-LSTM IDS

    def _apply_correction_delta(
        self,
        correction: Dict[str, torch.Tensor],
    ) -> None:
        """Add correction delta tensors to the live global model in-place.

        The correction is expected to be pre-computed (including negation
        and noise), so this method simply adds each tensor to the
        corresponding layer in the model's state dict.
        """
        state = OrderedDict(self._model.state_dict())
        for layer, delta in correction.items():
            if layer in state:
                state[layer] = state[layer].cpu() + delta.cpu()
        self._model.load_state_dict(state, strict=True)

    def _compute_model_norms(self) -> Dict[str, float]:
        """Return per-layer L2 norms for SELECTED_LAYERS."""
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
    ) -> tuple[Dict[str, torch.Tensor], float, Dict[str, float]]:
        """Add Gaussian DP noise calibrated by theoretical sensitivity.

        Uses:
          - C-6: Data-independent theoretical sensitivity (Theorem 3).
          - C-5: Paper's sigma formula (Definition 1 / Eq. 25).
          - C-4: No artificial sigma cap.

        Returns:
            (noised_correction, sigma_used, sigma_per_layer)
        """
        num_params = self._get_num_selected_params()

        # C-6: Theoretical sensitivity (data-independent)
        try:
            sensitivity = _theoretical_sensitivity(
                clip_bound=self.clip_bound,
                num_params=num_params,
                learning_rate=self.learning_rate,
                num_clients=self.num_clients,
            )
        except ValueError as exc:
            log.warning(
                "FedRecovery: theoretical sensitivity failed (%s), "
                "falling back to correction norm",
                exc,
            )
            sensitivity = sum(t.norm().item() for t in correction.values())
            sensitivity = max(sensitivity, 1e-6)

        # C-5: Paper's sigma formula (no cap — C-4)
        sigma = _paper_gaussian_sigma(sensitivity, self.epsilon, self.beta)

        noised: Dict[str, torch.Tensor] = {}
        per_layer_sigma: Dict[str, float] = {}
        for layer, tensor in correction.items():
            noise = torch.randn_like(tensor) * sigma
            noised[layer] = tensor + noise
            # N-2: Track per-layer sigma (same sigma for all layers)
            per_layer_sigma[layer] = sigma

        log.info(
            "FedRecovery DP noise: theoretical_sensitivity=%.6f epsilon=%.3f "
            "beta=%.1e sigma=%.6f num_params=%d",
            sensitivity,
            self.epsilon,
            self.beta,
            sigma,
            num_params,
        )

        return noised, sigma, per_layer_sigma

    def _compute_round_residual(
        self,
        run_id: str,
        flagged_client_id: str,
        rnd: int,
        private_ctx,
    ) -> Optional[Dict[str, Any]]:
        """Decrypt one round and compute the gradient residual delta_i.

        Returns {"residual": {layer: tensor}, "agg_norm_sq": float} or None.
        Also POSTs per-step progress to the backend.
        """
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
            return None

        # Shapes from current model (invariant during training)
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
            return None

        # Decrypt flagged client's weighted delta
        flagged_weighted = self._decrypt_enc_bytes(enc_bytes, private_ctx, shapes)
        if flagged_weighted is None:
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
            return None

        # C-1: Retrieve metadata to recover weight
        meta = self._archive.get_meta(rnd, flagged_client_id)
        weight = float(meta["weight"]) if meta and "weight" in meta else 1.0

        # C-1/C-2: Get aggregated gradient for this round (W-2: consuming it)
        agg_delta = self._archive.get_agg(rnd)

        # C-1/C-2: Compute gradient residual delta_i
        residual = _compute_gradient_residual(flagged_weighted, agg_delta, weight)

        # W-2/C-3: Compute aggregated gradient norm-squared for p_i weights
        agg_norm_sq = 0.0
        if agg_delta is not None:
            agg_norm_sq = sum(float((t**2).sum()) for t in agg_delta.values())

        # Per-layer residual norms for audit
        residual_norms = {
            k: round(float(v.norm().item()), 6) for k, v in residual.items()
        }

        log.info(
            "FedRecovery round %d: weight=%.4f agg_norm_sq=%.4f residual_norms=%s",
            rnd,
            weight,
            agg_norm_sq,
            residual_norms,
        )

        self._post(
            "/api/v1/internal/fl/fedrecovery/step",
            {
                "run_id": run_id,
                "round": rnd,
                "step": "corrected",
                "detail": (
                    f"residual computed: weight={weight:.4f} "
                    f"agg_norm_sq={agg_norm_sq:.4f}"
                ),
                "data": {
                    "residual_norms": residual_norms,
                    "weight": weight,
                    "agg_norm_sq": agg_norm_sq,
                },
            },
        )

        return {
            "residual": residual,
            "agg_norm_sq": agg_norm_sq,
        }
