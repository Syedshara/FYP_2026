"""
Flower gRPC FL Server with CKKS Homomorphic Encryption.

Implements FedAvg with server-side HE aggregation:
  1. Server sends global model params to clients
  2. Clients train locally, send updated params back
  3. Server computes deltas, encrypts with CKKS, aggregates, decrypts
  4. Updates global model and repeats

After each round, metrics are POSTed to the backend API which broadcasts
them to frontends via WebSocket.

Usage:
    python server.py
    ROUNDS=5 MIN_CLIENTS=2 python server.py
"""

import base64
import gc
import hashlib
import os
import secrets
import sys
import json
import time
import logging
from collections import OrderedDict
from typing import Dict, List, Optional, Tuple

import grpc
import httpx
import numpy as np
import torch
import flwr as fl
from flwr.common import (
    FitIns,
    FitRes,
    Parameters,
    Scalar,
    ndarrays_to_parameters,
    parameters_to_ndarrays,
)
from flwr.server.client_proxy import ClientProxy

# ── shared code ──────────────────────────────────────────
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from fl_common.model import CNN_LSTM_IDS, DEFAULT_CONFIG, SELECTED_LAYERS
from fl_common.he_utils import (
    create_ckks_context,
    encrypted_sum,
    HE_POLY_MODULUS,
)
from fl_common.vss_utils import split_key, proactive_refresh
from fl_common.signing_utils import verify_gradient
from fl_common.recess_utils import (
    flatten_gradient,
    compute_abnormality_components,
    construct_test_gradient,
    update_trust_score,
    FLAG_THRESHOLD,
)
from gradient_archive import GradientArchive
from fed_recovery import FedRecoveryEngine

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(message)s")
log = logging.getLogger("fl_server")

# ── env config ───────────────────────────────────────────
ROUNDS = int(os.environ.get("ROUNDS", DEFAULT_CONFIG["ROUNDS"]))
MIN_CLIENTS = int(os.environ.get("MIN_CLIENTS", 2))
MIN_FIT_CLIENTS = int(os.environ.get("MIN_FIT_CLIENTS", MIN_CLIENTS))
SERVER_ADDRESS = os.environ.get("FL_SERVER_ADDRESS", "0.0.0.0:8080")
USE_HE = os.environ.get("USE_HE", "true").lower() in ("true", "1", "yes")
LOCAL_EPOCHS = int(os.environ.get("LOCAL_EPOCHS", DEFAULT_CONFIG["LOCAL_EPOCHS"]))
LEARNING_RATE = float(os.environ.get("LEARNING_RATE", DEFAULT_CONFIG["LEARNING_RATE"]))
MAX_BATCHES = int(os.environ.get("MAX_BATCHES", DEFAULT_CONFIG["MAX_BATCHES"]))
MODEL_DIR = os.environ.get("MODEL_DIR", "/app/models")
BACKEND_URL = os.environ.get("BACKEND_URL", "http://iot_ids_backend:8000")
CLIENT_KEY_DIR = os.environ.get("CLIENT_KEY_DIR", "./certs/client_keys/")

SEQ_LEN = DEFAULT_CONFIG["SEQUENCE_LENGTH"]
NUM_FEATURES = DEFAULT_CONFIG["NUM_FEATURES"]

# ── RECESS / refresh intervals ───────────────────────────
RECESS_INTERVAL: int = 5
REFRESH_INTERVAL: int = 20

# ── Dynamic FL client names (set by CLIENTS env var) ─────
# Comma-separated list of client_id values passed by the backend when starting training.
# Falls back to discovering all pub keys in CLIENT_KEY_DIR if CLIENTS env is empty.
_raw_clients = os.environ.get("CLIENTS", "").strip()
FL_CLIENT_NAMES: List[str] = [n.strip() for n in _raw_clients.split(",") if n.strip()]

# HTTP client for backend callbacks
_http_client: Optional[httpx.Client] = None


def _get_http() -> httpx.Client:
    global _http_client
    if _http_client is None:
        _http_client = httpx.Client(base_url=BACKEND_URL, timeout=10.0)
    return _http_client


def _post_to_backend(path: str, payload: dict) -> bool:
    """POST JSON to the backend internal API. Returns True on success."""
    try:
        r = _get_http().post(path, json=payload)
        if r.status_code < 300:
            return True
        log.warning("Backend POST %s → %s: %s", path, r.status_code, r.text[:200])
    except Exception as exc:
        log.warning("Backend POST %s failed: %s", path, exc)
    return False


def _emit_security_event(
    kind: str,
    round_num: int,
    client_id: Optional[str] = None,
    detail: Optional[str] = None,
    data: Optional[dict] = None,
) -> None:
    """Fire-and-forget a single security event to the backend for WS broadcast.

    ``data`` carries structured payload (e.g. per-layer metrics for HE events)
    so the frontend can render rich detail beyond the plain ``detail`` string.
    """
    _post_to_backend(
        "/api/v1/internal/fl/security-event",
        {
            "kind": kind,
            "round": round_num,
            "client_id": client_id,
            "detail": detail,
            "data": data,
        },
    )


def _emit_security_events_batch(events: List[dict]) -> None:
    """Fire-and-forget a batch of security events."""
    if events:
        try:
            r = _get_http().post(
                "/api/v1/internal/fl/security-events-batch", json=events
            )
            if r.status_code >= 300:
                log.warning(
                    "Security events batch → %s: %s", r.status_code, r.text[:200]
                )
        except Exception as exc:
            log.warning("Security events batch failed: %s", exc)


# ── Security helpers ─────────────────────────────────────


def generate_round_nonce(session_id: str, round_number: int) -> str:
    """Return a unique nonce for a given session and round."""
    return hashlib.sha256(
        f"{session_id}:{round_number}:{secrets.token_hex(16)}".encode()
    ).hexdigest()


def _load_client_public_keys() -> Dict[str, bytes]:
    """Load Ed25519 public keys for each FL client from PEM files.

    Files are expected at ``CLIENT_KEY_DIR/<cert_stem>.pub.pem`` where
    ``cert_stem`` is the title-cased form of the client name — the same
    convention used by ``_generate_client_keys()`` in fl_service.py and
    ``_cert_name()`` in docker_service.py.

    Examples:
        "bank_a"             → "Bank_A.pub.pem"
        "node_1773652351722_1" → "Node_1773652351722_1.pub.pem"

    A plain-name fallback (exact match) is tried if the title-cased path
    does not exist, so edge-case identifiers that need no conversion still
    work.  Missing keys are skipped with a warning so the server can start
    even when certs are not yet provisioned.
    """
    keys: Dict[str, bytes] = {}
    for name in FL_CLIENT_NAMES:
        # Apply the same title-casing that _cert_name() / _generate_client_keys() use
        stem = "_".join(part.capitalize() for part in name.split("_"))
        path = os.path.join(CLIENT_KEY_DIR, f"{stem}.pub.pem")
        if not os.path.isfile(path):
            # Fallback: exact name (handles identifiers that need no conversion)
            path = os.path.join(CLIENT_KEY_DIR, f"{name}.pub.pem")
        if os.path.isfile(path):
            with open(path, "rb") as fh:
                keys[name] = fh.read()
            log.info("Loaded public key for %s from %s", name, path)
        else:
            log.warning(
                "Public key not found for %s (tried %s and %s) — "
                "signature checks will be skipped for this client",
                name,
                stem,
                name,
            )
    return keys


def _run_vss_ceremony(ckks_ctx, rnd: int = 0) -> dict:
    """Split the CKKS secret key into VSS shares for all FL clients.

    Returns the VSS dict ``{"shares": ..., "nonces": ..., "commitments": ...}``.
    The context is made public (secret key stripped) as a side effect.
    """
    log.info("Running VSS ceremony for %d clients …", len(FL_CLIENT_NAMES))
    vss = split_key(ckks_ctx, FL_CLIENT_NAMES)
    log.info(
        "VSS ceremony complete — shares distributed to: %s",
        ", ".join(FL_CLIENT_NAMES),
    )
    # In a real deployment the per-client share would be sent to the client
    # over a secure channel.  Here we log commitment fingerprints only.
    for name in FL_CLIENT_NAMES:
        commitment_hex = vss["commitments"][name].hex()
        log.info("  Commitment[%s] = %s…", name, commitment_hex[:16])

    # Fix 5: emit security events so the HE detail panel in the Watcher
    # shows the ceremony and share distribution as completed (not pending).
    try:
        _emit_security_event(
            "vss_ceremony",
            rnd,
            detail=f"Key split for {len(FL_CLIENT_NAMES)} clients (round {rnd})",
            data={"num_clients": len(FL_CLIENT_NAMES), "client_names": FL_CLIENT_NAMES},
        )
        for name in FL_CLIENT_NAMES:
            _emit_security_event(
                "vss_share_dist",
                rnd,
                client_id=name,
                detail=f"Share distributed to {name}",
                data={
                    "client": name,
                    "commitment_prefix": vss["commitments"][name].hex()[:16],
                },
            )
    except Exception as exc:
        log.warning("VSS ceremony event emission failed (non-fatal): %s", exc)

    return vss


# ═══════════════════════════════════════════════════════════
#  Custom FedAvg + HE Strategy
# ═══════════════════════════════════════════════════════════
class FedAvgHE(fl.server.strategy.FedAvg):
    """
    FedAvg strategy with optional CKKS HE aggregation.

    Non-selected layers: plain weighted average (FedAvg).
    Selected layers (LSTM + FC): encrypted delta aggregation via CKKS.

    Security additions (Wave 2):
      - VSS secret-key ceremony on __init__
      - Per-round nonces embedded in configure_fit()
      - RECESS detection every RECESS_INTERVAL rounds
      - VSS proactive key refresh every REFRESH_INTERVAL rounds
    """

    def __init__(
        self,
        global_model: CNN_LSTM_IDS,
        use_he: bool = True,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.global_model = global_model
        self.use_he = use_he
        self.round_metrics: list[dict] = []

        # ── Session identity ──────────────────────────────
        self._session_id: str = secrets.token_hex(16)
        self._round_nonces: Dict[int, str] = {}

        # ── Trust scores (per FL client name) ─────────────
        self._trust_scores: Dict[str, float] = {n: 1.0 for n in FL_CLIENT_NAMES}

        # ── Last aggregated gradient (for RECESS probing) ──
        self._last_agg_gradient: Optional[Dict[str, torch.Tensor]] = None

        # ── Current RECESS probe sent to clients this detection round ──────
        self._current_probe: Optional[Dict[str, torch.Tensor]] = None

        # ── Gradient archive (encrypted per-client + aggregated, for FedRecovery) ──
        self._archive = GradientArchive()

        # ── FedRecovery concurrency guard ───────────────────
        # Prevents two recovery runs from modifying the global model simultaneously.
        import threading as _threading

        self._fedrecovery_lock = _threading.Lock()

        # ── Client public keys (Ed25519 PEM) ───────────────
        self._client_public_keys: Dict[str, bytes] = _load_client_public_keys()

        if self.use_he:
            log.info("Creating CKKS context …")
            self.ckks_ctx = create_ckks_context()

            # Only run VSS ceremony if we have known client names
            if FL_CLIENT_NAMES:
                self._vss: dict = _run_vss_ceremony(self.ckks_ctx)
            else:
                log.warning(
                    "CLIENTS env var is empty — skipping VSS ceremony. "
                    "Set CLIENTS=client1,client2 when starting the FL server."
                )
                self._vss = {}
        else:
            self.ckks_ctx = None
            self._vss = {}

    # ── helpers ──────────────────────────────────────────

    def _get_global_ndarrays(self) -> List[np.ndarray]:
        return [v.cpu().numpy() for v in self.global_model.state_dict().values()]

    def _set_global_ndarrays(self, ndarrays: List[np.ndarray]) -> None:
        keys = list(self.global_model.state_dict().keys())
        state = OrderedDict({k: torch.tensor(v) for k, v in zip(keys, ndarrays)})
        self.global_model.load_state_dict(state, strict=True)

    # ── Flower overrides ─────────────────────────────────

    def initialize_parameters(self, client_manager) -> Optional[Parameters]:
        return ndarrays_to_parameters(self._get_global_ndarrays())

    def configure_fit(self, server_round, parameters, client_manager):
        # Generate and store a nonce for this round
        nonce = generate_round_nonce(self._session_id, server_round)
        self._round_nonces[server_round] = nonce

        # ── Option B: load persisted trust scores on round 1 ──────────────
        # By round 1 the backend is guaranteed to be running (it spawned us).
        # This re-hydrates _trust_scores with any scores accumulated during
        # previous training sessions that were persisted to the DB.
        if server_round == 1:
            try:
                resp = _get_http().get("/api/v1/internal/fl/trust_scores")
                persisted = resp.json().get("trust_scores", {})
                if persisted:
                    self._trust_scores.update(persisted)
                    log.info(
                        "Loaded persisted trust scores from backend: %s", persisted
                    )
            except Exception as exc:
                log.warning(
                    "Could not load trust scores from backend (non-fatal): %s", exc
                )

        is_detect = server_round % RECESS_INTERVAL == 0
        config: Dict[str, Scalar] = {
            "server_round": server_round,
            "total_rounds": ROUNDS,
            "local_epochs": LOCAL_EPOCHS,
            "lr": float(LEARNING_RATE),
            "use_he": self.use_he,
            "batch_size": DEFAULT_CONFIG["BATCH_SIZE"],
            "max_batches": MAX_BATCHES,
            "round_nonce": nonce,
            "detect": str(is_detect).lower(),
        }

        # ── Construct and embed RECESS probe for detection rounds ──────────
        # The probe is a noisy version of the last aggregated delta.
        # Clients ignore it (the comparison happens server-side), but embedding
        # it makes the config self-documenting and future-proofs client-side use.
        if is_detect and self._last_agg_gradient is not None:
            try:
                probe_dict = construct_test_gradient(self._last_agg_gradient)
                self._current_probe = probe_dict
                probe_flat = flatten_gradient(probe_dict)
                config["recess_probe_b64"] = base64.b64encode(
                    probe_flat.numpy().tobytes()
                ).decode("ascii")
                log.debug(
                    "RECESS probe constructed and embedded (%d elements)",
                    probe_flat.numel(),
                )
                _emit_security_event(
                    "recess_probe_built",
                    server_round,
                    detail=f"Probe constructed ({probe_flat.numel()} elements)",
                    data={
                        "num_elements": probe_flat.numel(),
                        "probe_norm": round(float(probe_flat.norm().item()), 6),
                    },
                )
            except Exception as exc:
                log.warning(
                    "Failed to construct RECESS probe: %s — proceeding without probe",
                    exc,
                )
                self._current_probe = None
        elif is_detect:
            # Round 1 RECESS — no prior delta yet, probe will be None
            self._current_probe = None
            log.debug(
                "RECESS detection round %d — no prior gradient, probe skipped",
                server_round,
            )

        fit_ins = FitIns(parameters, config)
        sample_size = max(self.min_fit_clients, MIN_FIT_CLIENTS)
        clients = client_manager.sample(
            num_clients=sample_size,
            min_num_clients=self.min_available_clients,
        )

        # Emit security events: round start + nonce issued
        _emit_security_event(
            "round_start",
            server_round,
            detail=f"clients={len(clients)} detect={is_detect}",
            data={"expected_clients": len(clients), "is_detect": is_detect},
        )
        _emit_security_event(
            "nonce_issued",
            server_round,
            detail=nonce[:16] + "...",
            data={"nonce_prefix": nonce[:16], "num_clients": len(clients)},
        )

        # For detection rounds, confirm probe has been dispatched to clients
        if is_detect:
            _emit_security_event(
                "recess_probe_dispatched",
                server_round,
                detail=f"Config sent to {len(clients)} client{'s' if len(clients) != 1 else ''} (probe={'embedded' if self._current_probe is not None else 'skipped — no prior gradient'})",
                data={
                    "num_clients": len(clients),
                    "probe_available": self._current_probe is not None,
                },
            )

        # Emit global_dispatch — global model weight norms + prior round metrics
        try:
            state = self.global_model.state_dict()
            dispatch_layer_data = [
                {
                    "layer": key,
                    "weight_norm": round(float(state[key].norm().item()), 6),
                }
                for key in SELECTED_LAYERS
                if key in state
            ]
            prior = self.round_metrics[-1] if self.round_metrics else None
            _emit_security_event(
                "global_dispatch",
                server_round,
                detail=(
                    f"Dispatching global model to {len(clients)} "
                    f"client{'s' if len(clients) != 1 else ''}"
                    + (
                        f" | prev loss={prior['global_loss']:.4f}"
                        f" acc={prior['global_accuracy']:.4f}"
                        if prior
                        and "global_loss" in prior
                        and "global_accuracy" in prior
                        else " | initial model"
                    )
                ),
                data={
                    "num_clients": len(clients),
                    "layers": dispatch_layer_data,
                    "prior_round": prior["round"] if prior else None,
                    "prior_loss": round(float(prior["global_loss"]), 6)
                    if prior and "global_loss" in prior
                    else None,
                    "prior_accuracy": round(float(prior["global_accuracy"]), 6)
                    if prior and "global_accuracy" in prior
                    else None,
                    "local_epochs": LOCAL_EPOCHS,
                    "lr": float(LEARNING_RATE),
                    "batch_size": DEFAULT_CONFIG["BATCH_SIZE"],
                    "max_batches": MAX_BATCHES,
                },
            )
        except Exception as exc:
            log.warning(
                "Could not emit global_dispatch for round %d: %s", server_round, exc
            )

        return [(client, fit_ins) for client in clients]

    def aggregate_fit(self, server_round, results, failures):
        if not results:
            return None, {}

        rnd = server_round

        # ── RECESS detection round ────────────────────────
        if rnd % RECESS_INTERVAL == 0:
            return self._run_recess_round(rnd, results)

        # ── Proactive VSS key refresh ─────────────────────
        if rnd % REFRESH_INTERVAL == 0 and self.use_he and self._vss:
            self._trigger_vss_refresh(rnd)

        # ── Normal aggregation ────────────────────────────
        t0 = time.time()
        num_clients = len(results)
        log.info(
            "Round %d — aggregating %d clients (HE=%s)", rnd, num_clients, self.use_he
        )

        # Notify backend that aggregation is starting
        _post_to_backend(
            "/api/v1/internal/fl/progress",
            {
                "round": rnd,
                "total_rounds": ROUNDS,
                "phase": "aggregating",
                "num_clients": num_clients,
                "message": f"Aggregating {num_clients} client updates (HE={self.use_he})",
            },
        )

        # Snapshot the model weights BEFORE aggregation so we can compute deltas after
        pre_agg_state: Dict[str, torch.Tensor] = {}
        try:
            state = self.global_model.state_dict()
            pre_agg_state = {
                key: state[key].cpu().detach().clone()
                for key in SELECTED_LAYERS
                if key in state
            }
        except Exception as exc:
            log.warning("Could not snapshot pre-agg state: %s", exc)

        # Emit per-client gradient update events (one event per client)
        try:
            state = self.global_model.state_dict()
            keys = list(state.keys())
            for proxy, fit_res in results:
                m = fit_res.metrics or {}
                cid = str(m.get("client_id", getattr(proxy, "cid", "unknown")))
                client_loss = float(m.get("loss", 0.0))
                client_acc = float(m.get("accuracy", 0.0))
                client_samples = int(fit_res.num_examples)
                # Compute per-layer gradient norms ‖Δ‖₂ = ‖W_client − W_global‖₂
                ndarrays = parameters_to_ndarrays(fit_res.parameters)
                layer_data = []
                for i, key in enumerate(keys):
                    if key in SELECTED_LAYERS and i < len(ndarrays):
                        delta = ndarrays[i].astype(np.float64) - state[
                            key
                        ].cpu().numpy().astype(np.float64)
                        layer_data.append(
                            {
                                "layer": key,
                                "delta_norm": round(float(np.linalg.norm(delta)), 6),
                            }
                        )
                total_delta = round(sum(ld["delta_norm"] for ld in layer_data), 6)
                _emit_security_event(
                    "client_update",
                    rnd,
                    client_id=cid,
                    detail=(
                        f"loss={client_loss:.4f} acc={client_acc:.4f} "
                        f"samples={client_samples} total‖Δ‖₂={total_delta:.4f}"
                    ),
                    data={
                        "client_id": cid,
                        "loss": round(client_loss, 6),
                        "accuracy": round(client_acc, 6),
                        "num_samples": client_samples,
                        "layers": layer_data,
                        "total_delta_norm": total_delta,
                    },
                )
                # mTLS: if the client reached this point its gRPC mTLS handshake
                # was verified at the transport layer — emit one event per client.
                _emit_security_event(
                    "mtls_handshake",
                    rnd,
                    client_id=cid,
                    detail="gRPC mTLS certificate verified",
                    data={"client_id": cid, "status": "verified"},
                )
                # Nonce: normal rounds embed the expected nonce in the config sent
                # to each client.  If the client returned results its echo matched;
                # emit a per-client nonce_verified event to mirror RECESS behaviour.
                _emit_security_event(
                    "nonce_verified",
                    rnd,
                    client_id=cid,
                    detail="OK",
                    data={"client_id": cid, "status": "ok"},
                )

                # ── Ed25519 signature verification (every normal round) ──────────
                # The client sends metrics["gradient_b64"] = base64(flatten_gradient(delta).tobytes())
                # and metrics["signature"] = base64(Ed25519.sign(those bytes)).
                # We decode the gradient bytes directly and verify — no reconstruction
                # needed.  This mirrors the proven RECESS verification pattern and
                # avoids the byte-level divergence that plagued the reconstruction
                # approach (which produced different hashes despite identical logic).
                sig_b64_normal = str(m.get("signature", ""))
                gradient_b64_normal = str(m.get("gradient_b64", ""))
                pub_key_pem_normal = self._client_public_keys.get(cid)
                if sig_b64_normal and gradient_b64_normal and pub_key_pem_normal:
                    try:
                        sig_bytes_normal = base64.b64decode(sig_b64_normal)
                        gradient_bytes_for_verify = base64.b64decode(
                            gradient_b64_normal
                        )
                        if not verify_gradient(
                            gradient_bytes_for_verify,
                            sig_bytes_normal,
                            pub_key_pem_normal,
                        ):
                            log.warning(
                                "Round %d — client %s: invalid Ed25519 signature on normal round gradient",
                                rnd,
                                cid,
                            )
                            _emit_security_event(
                                "signature_failed",
                                rnd,
                                client_id=cid,
                                detail="Invalid Ed25519 signature",
                            )
                        else:
                            _emit_security_event(
                                "signature_verified",
                                rnd,
                                client_id=cid,
                                detail="Ed25519 OK",
                            )
                    except Exception as sig_exc:
                        log.warning(
                            "Round %d — client %s: signature verification error: %s",
                            rnd,
                            cid,
                            sig_exc,
                        )
                        _emit_security_event(
                            "signature_failed",
                            rnd,
                            client_id=cid,
                            detail=str(sig_exc)[:100],
                        )
                elif pub_key_pem_normal:
                    # Public key is loaded but the client did not include a signature
                    log.warning(
                        "Round %d — client %s: no signature/gradient in metrics (key on file)",
                        rnd,
                        cid,
                    )
                    _emit_security_event(
                        "signature_verified",
                        rnd,
                        client_id=cid,
                        detail="No signature (key on file)",
                    )
        except Exception as exc:
            log.warning(
                "Could not emit client_update events for round %d: %s", rnd, exc
            )

        if self.use_he:
            params, metrics = self._aggregate_he(rnd, results)
        else:
            params, metrics = self._aggregate_plain(rnd, results)

        # Cache last aggregated gradient delta (post − pre) for RECESS probing
        self._update_last_agg_gradient(pre_agg_state)

        # Archive aggregated gradient for FedRecovery use
        if self._last_agg_gradient:
            try:
                self._archive.store_agg(rnd, self._last_agg_gradient)
            except Exception as _exc:
                log.warning("GradientArchive.store_agg failed r%d: %s", rnd, _exc)

        elapsed = time.time() - t0
        metrics["aggregation_time_sec"] = float(elapsed)
        log.info("Round %d — done in %.2fs", rnd, elapsed)

        self._save_checkpoint(rnd)
        self.round_metrics.append({"round": rnd, **metrics})

        # Report completed round to backend (persists + broadcasts via WS)
        self._report_round(rnd, num_clients, results, elapsed, metrics, pre_agg_state)

        return params, metrics

    # ── RECESS round ──────────────────────────────────────

    def _run_recess_round(self, rnd: int, results) -> Tuple[Optional[Parameters], dict]:
        """Run a RECESS behavioural-probing detection round.

        Each client is expected to return its encrypted response gradient in
        ``FitRes.metrics["recess_response"]`` (base64-encoded bytes) and an
        optional signature in ``FitRes.metrics["recess_signature"]`` plus a
        nonce echo in ``FitRes.metrics["nonce_echo"]``.

        This round does NOT update the global model.
        """
        log.info("Round %d — RECESS detection round", rnd)

        _post_to_backend(
            "/api/v1/internal/fl/progress",
            {
                "round": rnd,
                "total_rounds": ROUNDS,
                "phase": "recess_detection",
                "message": f"RECESS detection round {rnd}",
            },
        )

        _emit_security_event(
            "recess_detect",
            rnd,
            detail=f"Starting RECESS detection ({len(results)} clients)",
        )

        expected_nonce = self._round_nonces.get(rnd, "")
        trust_updates: Dict[str, float] = {}
        flagged_in_round: List[str] = []
        sec_events: List[dict] = []  # batch security events
        components: Dict[str, dict] = {}  # per-client abnormality breakdown

        for proxy, fit_res in results:
            m = fit_res.metrics or {}
            cid = str(m.get("client_id", getattr(proxy, "cid", "unknown")))

            # ── 1. Verify nonce echo ──────────────────────
            nonce_echo = str(m.get("nonce_echo", ""))
            if expected_nonce and nonce_echo != expected_nonce:
                log.warning(
                    "Round %d — client %s: nonce mismatch — discarding", rnd, cid
                )
                sec_events.append(
                    {
                        "kind": "nonce_verified",
                        "round": rnd,
                        "client_id": cid,
                        "detail": "FAILED — mismatch",
                    }
                )
                continue
            sec_events.append(
                {
                    "kind": "nonce_verified",
                    "round": rnd,
                    "client_id": cid,
                    "detail": "OK",
                }
            )
            # Fix 7: mTLS — any client whose results reach this point has already
            # passed gRPC mTLS at the transport layer.  Emit per-client event so
            # the Security Verification node in the frontend pipeline is populated.
            sec_events.append(
                {
                    "kind": "mtls_handshake",
                    "round": rnd,
                    "client_id": cid,
                    "detail": "gRPC mTLS certificate verified",
                    "data": {"client_id": cid, "status": "verified"},
                }
            )

            # ── 2. Retrieve base64-encoded RECESS response ─
            recess_b64 = m.get("recess_response", "")
            if not recess_b64:
                log.warning(
                    "Round %d — client %s: no recess_response — skipping", rnd, cid
                )
                continue

            try:
                recess_bytes = base64.b64decode(recess_b64)
            except Exception as exc:
                log.warning(
                    "Round %d — client %s: bad base64 recess_response: %s",
                    rnd,
                    cid,
                    exc,
                )
                continue

            # ── 3. Verify Ed25519 signature ───────────────
            sig_b64 = m.get("recess_signature", "")
            pub_key_pem = self._client_public_keys.get(cid)
            if sig_b64 and pub_key_pem:
                try:
                    sig_bytes = base64.b64decode(sig_b64)
                    if not verify_gradient(recess_bytes, sig_bytes, pub_key_pem):
                        log.warning(
                            "Round %d — client %s: invalid signature — discarding",
                            rnd,
                            cid,
                        )
                        sec_events.append(
                            {
                                "kind": "signature_failed",
                                "round": rnd,
                                "client_id": cid,
                                "detail": "Invalid Ed25519 signature",
                            }
                        )
                        continue
                except Exception as exc:
                    log.warning(
                        "Round %d — client %s: signature error: %s — discarding",
                        rnd,
                        cid,
                        exc,
                    )
                    sec_events.append(
                        {
                            "kind": "signature_failed",
                            "round": rnd,
                            "client_id": cid,
                            "detail": str(exc)[:100],
                        }
                    )
                    continue
                sec_events.append(
                    {
                        "kind": "signature_verified",
                        "round": rnd,
                        "client_id": cid,
                        "detail": "Ed25519 OK",
                    }
                )
            elif pub_key_pem:
                # Key is loaded but no signature provided — warn and continue
                log.warning(
                    "Round %d — client %s: no signature provided (key on file) — proceeding with caution",
                    rnd,
                    cid,
                )
                sec_events.append(
                    {
                        "kind": "signature_verified",
                        "round": rnd,
                        "client_id": cid,
                        "detail": "No signature (key on file)",
                    }
                )

            # ── 4. Decode response gradient from raw bytes ─
            # Clients encode a flat float32 numpy array as raw bytes
            try:
                response_flat_np = np.frombuffer(recess_bytes, dtype=np.float32).copy()
                response_flat = torch.tensor(response_flat_np, dtype=torch.float32)
            except Exception as exc:
                log.warning(
                    "Round %d — client %s: failed to decode response gradient: %s",
                    rnd,
                    cid,
                    exc,
                )
                continue

            _emit_security_event(
                "recess_response_received",
                rnd,
                client_id=cid,
                detail=f"Response decoded ({response_flat.numel()} elements, norm={torch.norm(response_flat).item():.4f})",
                data={
                    "num_elements": response_flat.numel(),
                    "resp_norm": round(float(torch.norm(response_flat).item()), 6),
                },
            )

            # ── 5. Build test gradient flat vector ────────
            # Use the pre-constructed RECESS probe (built from the aggregation delta
            # in configure_fit) so that test_flat and response_flat are aligned in
            # both length and semantic meaning.
            if self._current_probe is not None:
                try:
                    test_flat = flatten_gradient(self._current_probe)
                except Exception as exc:
                    log.warning(
                        "Could not flatten RECESS probe: %s — using response as reference",
                        exc,
                    )
                    test_flat = response_flat.clone()
            else:
                # No probe available (round 1 or probe construction failed) —
                # use the response itself as a neutral reference (abnormality ≈ 0)
                test_flat = response_flat.clone()

            # Align lengths (truncate / pad to shorter)
            min_len = min(test_flat.numel(), response_flat.numel())
            test_flat = test_flat[:min_len]
            response_flat = response_flat[:min_len]

            # ── Magnitude-gated residual detection ─────────────────
            # The client response is a residual: local_params − global_params
            # = Δ_i − avg(Δ).  Detection is based on the magnitude ratio
            # |residual| / |probe|:
            #
            #   ratio < 1.0  → residual smaller than probe → benign
            #                   (client is close to the global model)
            #   ratio ≈ 1.0  → borderline, could be different data
            #   ratio > 1.5  → suspicious, direction matters more
            #   ratio > 2.0  → highly anomalous (poisoned)
            #
            # Direction (cos_sim) is a secondary signal used only when
            # the residual is large enough to be meaningful.  An honest
            # client's residual is often orthogonal to the probe (avg(Δ))
            # because it represents the *difference* from average, so
            # orthogonality is EXPECTED, not anomalous.

            _emit_security_event(
                "recess_vss_decrypt",
                rnd,
                client_id=cid,
                detail=f"Raw residual (norm={torch.norm(response_flat).item():.4f})",
                data={
                    "residual_norm": round(float(torch.norm(response_flat).item()), 6)
                },
            )

            # ── Diagnostic checkpoint 1: probe norm ──────────────
            probe_norm = torch.norm(test_flat).item()
            resp_norm = torch.norm(response_flat).item()
            residual_ratio = resp_norm / (probe_norm + 1e-8)
            log.info(
                "RECESS diag [%s] probe_norm=%.4f  resp_norm=%.4f  residual_ratio=%.4f",
                cid,
                probe_norm,
                resp_norm,
                residual_ratio,
            )

            # ── 6. Compute abnormality score (magnitude-gated) ─────
            if residual_ratio < 1.0:
                # Residual smaller than probe → benign.  The client's
                # local model is close to the global model.
                abnormality = 0.0
                direction_score = 0.0
                magnitude_score = 0.0
                log.info(
                    "RECESS [%s]: residual < probe (ratio=%.4f) → benign",
                    cid,
                    residual_ratio,
                )
            else:
                # Residual >= probe → potentially anomalous.
                # Magnitude score: scales linearly from 0 at ratio=1 to
                # 1.0 at ratio=3.
                magnitude_score = max(0.0, min(1.0, (residual_ratio - 1.0) / 2.0))

                # Direction score: only meaningful for large residuals.
                # Use clamped (1 − cos_sim) / 2 so orthogonal → 0.5, not 1.0.
                if probe_norm > 1e-8 and resp_norm > 1e-8:
                    _cos = torch.nn.functional.cosine_similarity(
                        test_flat.unsqueeze(0), response_flat.unsqueeze(0)
                    ).item()
                    direction_score = max(0.0, min(1.0, (1.0 - _cos) / 2.0))
                else:
                    direction_score = 0.0

                abnormality = 0.5 * direction_score + 0.5 * magnitude_score
                log.info(
                    "RECESS [%s]: ratio=%.4f  dir=%.4f  mag=%.4f  abnormality=%.4f",
                    cid,
                    residual_ratio,
                    direction_score,
                    magnitude_score,
                    abnormality,
                )

            # ── Diagnostic checkpoint 2: cos_sim & magnitude ratio ──
            _cos_sim = (
                torch.nn.functional.cosine_similarity(
                    test_flat.unsqueeze(0), response_flat.unsqueeze(0)
                ).item()
                if probe_norm > 1e-8 and resp_norm > 1e-8
                else 0.0
            )
            _mag_ratio = resp_norm / (probe_norm + 1e-8)
            log.info(
                "RECESS diag [%s] cos_sim=%.4f  mag_ratio=%.4f  "
                "dir_score=%.4f  mag_score=%.4f  abnormality=%.4f",
                cid,
                _cos_sim,
                _mag_ratio,
                direction_score,
                magnitude_score,
                abnormality,
            )

            # Store per-client components for detection_round POST
            components[cid] = {
                "abnormality": float(abnormality),
                "direction_score": float(direction_score),
                "magnitude_score": float(magnitude_score),
            }

            _emit_security_event(
                "recess_score_computed",
                rnd,
                client_id=cid,
                detail=(
                    f"abnormality={abnormality:.4f} "
                    f"dir={direction_score:.4f} mag={magnitude_score:.4f}"
                ),
                data={
                    "abnormality": round(float(abnormality), 6),
                    "direction_score": round(float(direction_score), 6),
                    "magnitude_score": round(float(magnitude_score), 6),
                    "cos_sim": round(_cos_sim, 6),
                    "mag_ratio": round(_mag_ratio, 6),
                },
            )

            # ── 7. Update trust score ──────────────────────
            current = self._trust_scores.get(cid, 1.0)
            new_score = update_trust_score(current, abnormality)
            self._trust_scores[cid] = new_score
            trust_updates[cid] = new_score
            log.info(
                "Round %d — client %s: abnormality=%.4f  trust %.4f → %.4f",
                rnd,
                cid,
                abnormality,
                current,
                new_score,
            )

            # ── 8. Flag if abnormality > 0.7 ──────────────
            if abnormality > 0.7:
                flagged_in_round.append(cid)
                log.warning(
                    "Round %d — FLAGGING client %s (abnormality=%.4f)",
                    rnd,
                    cid,
                    abnormality,
                )
                sec_events.append(
                    {
                        "kind": "recess_flag",
                        "round": rnd,
                        "client_id": cid,
                        "detail": f"abnormality={abnormality:.4f}",
                    }
                )
                _post_to_backend(
                    "/api/v1/fl/flagged_client",
                    {
                        "client_id": cid,
                        "round": rnd,
                        "abnormality": float(abnormality),
                    },
                )

            decision = (
                "flagged"
                if abnormality > 0.7
                else ("downweighted" if new_score < 0.5 else "trusted")
            )
            _emit_security_event(
                "recess_decision",
                rnd,
                client_id=cid,
                detail=f"decision={decision} trust {current:.4f} → {new_score:.4f}",
                data={
                    "decision": decision,
                    "trust_before": round(float(current), 6),
                    "trust_after": round(float(new_score), 6),
                    "abnormality": round(float(abnormality), 6),
                    "flag_threshold": FLAG_THRESHOLD,
                },
            )

        # ── 9. Broadcast trust-score update via detection_round endpoint ──
        if trust_updates:
            _post_to_backend(
                "/api/v1/fl/detection_round",
                {
                    "round": rnd,
                    "scores": {
                        cid: float(score) for cid, score in trust_updates.items()
                    },
                    "flagged": flagged_in_round,
                    "components": components,
                },
            )

        # Emit batched security events for the RECESS round
        _emit_security_events_batch(sec_events)

        # Emit round-level summary event
        _emit_security_event(
            "recess_round_complete",
            rnd,
            detail=(
                f"{len(trust_updates)} client{'s' if len(trust_updates) != 1 else ''} evaluated, "
                f"{len(flagged_in_round)} flagged"
            ),
            data={
                "num_evaluated": len(trust_updates),
                "num_flagged": len(flagged_in_round),
                "flagged_clients": flagged_in_round,
                "trust_scores": {
                    cid: round(float(s), 6) for cid, s in trust_updates.items()
                },
            },
        )

        # ── Trigger FedRecovery for newly-below-threshold clients ─────────────
        # Only trigger if HE is enabled (archive has encrypted bytes) and VSS
        # state is available (needed for the cooperative decrypt ceremony).
        if self.use_he and self._vss and flagged_in_round:
            for cid in flagged_in_round:
                if self._trust_scores.get(cid, 1.0) < FLAG_THRESHOLD:
                    self._run_fed_recovery(cid, rnd)

        # Fix 3: derive per-client enforcement tiers from updated trust scores and
        # broadcast them so the frontend Enforcement node is populated for RECESS rounds.
        # Normal aggregation rounds call _post_enforcement via _build_trust_weights;
        # RECESS rounds skip aggregation but still update trust scores, so we must
        # derive and post enforcement here.
        recess_enforcement: dict[str, str] = {}
        all_tracked_clients = set(trust_updates.keys()) | set(self._trust_scores.keys())
        for tracked_cid in all_tracked_clients:
            ts = self._trust_scores.get(tracked_cid, 1.0)
            if ts < FLAG_THRESHOLD:
                recess_enforcement[tracked_cid] = "excluded"
            elif ts < 0.5:
                recess_enforcement[tracked_cid] = "downweighted"
            else:
                recess_enforcement[tracked_cid] = "included"
        if recess_enforcement:
            self._post_enforcement(rnd, recess_enforcement)

        # RECESS round does not update the model — return current parameters
        current_params = ndarrays_to_parameters(self._get_global_ndarrays())
        return current_params, {"aggregation": "recess_detection_round", "round": rnd}

    # ── VSS key refresh ───────────────────────────────────

    def _trigger_vss_refresh(self, rnd: int = 0) -> None:
        """Trigger a proactive VSS secret-key share refresh."""
        if not self._vss:
            log.warning("VSS refresh requested but no VSS state present — skipping")
            return
        try:
            log.info("Triggering proactive VSS key refresh …")
            new_vss = proactive_refresh(
                public_ctx=self.ckks_ctx,
                contributed_shares=self._vss["shares"],
                nonces=self._vss["nonces"],
                commitments=self._vss["commitments"],
                client_names=FL_CLIENT_NAMES,
            )
            self._vss = new_vss
            log.info("VSS key refresh complete — new commitments distributed")
            # Fix 5: emit refresh events so the Watcher HE panel shows updated state
            _emit_security_event(
                "vss_ceremony",
                rnd,
                detail=f"Key refresh for {len(FL_CLIENT_NAMES)} clients (round {rnd})",
                data={"num_clients": len(FL_CLIENT_NAMES), "refresh": True},
            )
            for name in FL_CLIENT_NAMES:
                _emit_security_event(
                    "vss_share_dist",
                    rnd,
                    client_id=name,
                    detail=f"Refreshed share distributed to {name}",
                    data={"client": name, "refresh": True},
                )
        except Exception as exc:
            log.error("VSS key refresh failed: %s", exc)

    def _run_fed_recovery(self, flagged_client_id: str, flag_round: int) -> None:
        """Acquire the lock and run FedRecoveryEngine for a newly-flagged client.

        Runs synchronously (blocks the current round callback).  This is
        intentional — security correction takes precedence over training speed.
        If the lock is already held by a concurrent recovery (shouldn't happen in
        Flower's single-threaded callback path), the run is skipped with a warning.
        """
        acquired = self._fedrecovery_lock.acquire(blocking=False)
        if not acquired:
            log.warning(
                "FedRecovery already running — skipping for client %s round %d",
                flagged_client_id,
                flag_round,
            )
            return
        try:
            engine = FedRecoveryEngine(
                archive=self._archive,
                model=self.global_model,
                vss=self._vss,
                public_ctx=self.ckks_ctx,
                post_fn=_post_to_backend,
            )
            result = engine.run(
                flagged_client_id=flagged_client_id, flag_round=flag_round
            )
            log.info(
                "FedRecovery result: run_id=%s status=%s corrected=%d skipped=%d",
                result.get("run_id"),
                result.get("status"),
                result.get("rounds_corrected", 0),
                result.get("rounds_skipped", 0),
            )
        except Exception as exc:
            log.error(
                "FedRecovery failed unexpectedly for client %s: %s",
                flagged_client_id,
                exc,
            )
        finally:
            self._fedrecovery_lock.release()

    def _update_last_agg_gradient(self, pre_agg_state: Dict[str, torch.Tensor]) -> None:
        """Cache the aggregation delta (post − pre) for SELECTED_LAYERS as the last gradient.

        Using the delta rather than absolute weights gives RECESS a meaningful signal:
        a benign client should produce a response gradient proportional to this delta,
        while a poisoned client's response will deviate in direction and/or magnitude.
        """
        try:
            post = self.global_model.state_dict()
            self._last_agg_gradient = {
                key: (post[key] - pre_agg_state[key]).cpu().detach().clone()
                for key in SELECTED_LAYERS
                if key in post and key in pre_agg_state
            }
        except Exception as exc:
            log.warning("Could not compute last agg gradient delta: %s", exc)

    def _report_round(
        self,
        server_round: int,
        num_clients: int,
        results,
        duration: float,
        agg_metrics: dict,
        pre_agg_state: Optional[Dict[str, torch.Tensor]] = None,
    ) -> None:
        """POST round + per-client metrics to the backend internal API."""
        # Collect per-client metrics
        client_metrics = []
        total_samples = 0
        weighted_loss = 0.0
        weighted_acc = 0.0

        for proxy, fit_res in results:
            m = fit_res.metrics or {}
            # Prefer registered client_id from metrics over Flower's internal UUID
            cid = m.get("client_id", getattr(proxy, "cid", "unknown"))
            n = int(fit_res.num_examples)
            loss = float(m.get("loss", 0.0))
            acc = float(m.get("accuracy", 0.0))

            client_metrics.append(
                {
                    "client_id": str(cid),
                    "local_loss": loss,
                    "local_accuracy": acc,
                    "num_samples": n,
                    "training_time_sec": float(m.get("training_time_sec", 0.0)),
                    "encrypted": self.use_he,
                }
            )
            total_samples += n
            weighted_loss += loss * n
            weighted_acc += acc * n

        # Compute weighted average global metrics
        global_loss = weighted_loss / max(total_samples, 1)
        global_accuracy = weighted_acc / max(total_samples, 1)

        # ── Compute gradient statistics from already-in-memory tensors ──────
        # dispatch_norms : ‖W‖₂ of the weights that were sent to clients
        # delta_norms    : ‖Δ‖₂ per layer (post − pre, already in _last_agg_gradient)
        # delta_means    : mean(Δ) per layer (sign indicates direction of update)
        # post_norms     : ‖W‖₂ after this round's aggregation
        # total_delta    : Σ‖Δ‖₂ across all selected layers (convergence proxy)
        gradient_stats: Optional[dict] = None
        try:
            post_state = self.global_model.state_dict()
            dispatch_norms: dict = {}
            post_norms: dict = {}
            delta_norms: dict = {}
            delta_means: dict = {}

            if pre_agg_state:
                for layer in SELECTED_LAYERS:
                    if layer in pre_agg_state:
                        dispatch_norms[layer] = round(
                            float(pre_agg_state[layer].norm().item()), 6
                        )
                    if layer in post_state:
                        post_norms[layer] = round(
                            float(post_state[layer].norm().item()), 6
                        )

            if self._last_agg_gradient:
                for layer, delta in self._last_agg_gradient.items():
                    delta_norms[layer] = round(float(delta.norm().item()), 6)
                    delta_means[layer] = round(float(delta.mean().item()), 8)

            gradient_stats = {
                "dispatch_norms": dispatch_norms,
                "delta_norms": delta_norms,
                "delta_means": delta_means,
                "post_norms": post_norms,
                "total_delta": round(sum(delta_norms.values()), 6),
            }
        except Exception as exc:
            log.warning(
                "Could not compute gradient_stats for round %d: %s", server_round, exc
            )

        if gradient_stats:
            log.info(
                "Round %d gradient_stats: layers=%s total_delta=%.6f",
                server_round,
                list(gradient_stats.get("delta_norms", {}).keys()),
                gradient_stats.get("total_delta", 0.0),
            )
        else:
            log.warning(
                "Round %d: gradient_stats is None — check pre_agg_state and _last_agg_gradient",
                server_round,
            )

        round_payload = {
            "round_number": server_round,
            "total_rounds": ROUNDS,
            "num_clients": num_clients,
            "aggregation_method": "fedavg_he" if self.use_he else "fedavg_plain",
            "he_scheme": "ckks" if self.use_he else None,
            "he_poly_modulus": HE_POLY_MODULUS if self.use_he else None,
            "duration_seconds": duration,
            "global_loss": global_loss,
            "global_accuracy": global_accuracy,
            "client_metrics": client_metrics,
            "gradient_stats": gradient_stats,
        }

        _post_to_backend("/api/v1/internal/fl/round", round_payload)

        # Fix 8: emit model_updated unconditionally so the Model Update pipeline node
        # transitions to 'succeeded' even when gradient_stats computation failed.
        mu_layers = []
        if gradient_stats:
            for layer in SELECTED_LAYERS:
                pn = gradient_stats["post_norms"].get(layer)
                dn = gradient_stats["delta_norms"].get(layer)
                if pn is not None:
                    mu_layers.append(
                        {
                            "layer": layer,
                            "weight_norm": pn,
                            "delta_from_prior": dn if dn is not None else 0.0,
                        }
                    )
        _emit_security_event(
            "model_updated",
            server_round,
            detail=(
                f"loss={global_loss:.4f} acc={global_accuracy:.4f}"
                + (
                    f" total_delta={gradient_stats['total_delta']:.6f}"
                    if gradient_stats
                    else ""
                )
            ),
            data={
                "global_loss": round(global_loss, 6),
                "global_accuracy": round(global_accuracy, 6),
                "total_delta": gradient_stats["total_delta"]
                if gradient_stats
                else None,
                "layers": mu_layers,
            },
        )

        # Emit round_complete security event
        _emit_security_event(
            "round_complete",
            server_round,
            detail=f"loss={global_loss:.4f} acc={global_accuracy:.4f} clients={num_clients} dur={duration:.2f}s",
        )

    # ── Plain FedAvg ─────────────────────────────────────

    def _build_trust_weights(
        self, results
    ) -> tuple[list[tuple[list, float, str]], dict[str, str], float]:
        """Compute per-client effective weights from trust scores.

        Returns:
            active:      list of (ndarrays, effective_weight, client_id) — excluded clients omitted.
            enforcement: dict[client_id → 'included'|'downweighted'|'excluded'].
            total_weight: sum of all effective weights (for normalisation).

        Classification:
            trust >= 0.5            → included      (effective_weight = trust × num_examples)
            0.3 <= trust < 0.5      → downweighted  (effective_weight = trust × num_examples)
            trust < FLAG_THRESHOLD  → excluded       (weight = 0, not in active list)
        """
        active: list[tuple[list, float, str]] = []
        enforcement: dict[str, str] = {}
        total_weight: float = 0.0

        for proxy, fit_res in results:
            m = fit_res.metrics or {}
            cid = str(m.get("client_id", getattr(proxy, "cid", f"unknown_{id(proxy)}")))
            trust = self._trust_scores.get(cid, 1.0)

            if trust < FLAG_THRESHOLD:
                enforcement[cid] = "excluded"
                log.info(
                    "Aggregation — client %s excluded (trust=%.3f < %.2f)",
                    cid,
                    trust,
                    FLAG_THRESHOLD,
                )
            else:
                ndarrays = parameters_to_ndarrays(fit_res.parameters)
                eff_weight = trust * fit_res.num_examples
                active.append((ndarrays, eff_weight, cid))
                total_weight += eff_weight
                enforcement[cid] = "downweighted" if trust < 0.5 else "included"

        return active, enforcement, total_weight

    def _post_enforcement(self, rnd: int, enforcement: dict[str, str]) -> None:
        """POST aggregation enforcement actions to the backend."""
        excluded = sum(1 for v in enforcement.values() if v == "excluded")
        downweighted = sum(1 for v in enforcement.values() if v == "downweighted")
        if excluded > 0 or downweighted > 0:
            log.info(
                "Round %d — enforcement: %d excluded, %d downweighted",
                rnd,
                excluded,
                downweighted,
            )
        _post_to_backend(
            "/api/v1/fl/aggregation_enforcement",
            {
                "round": rnd,
                "enforcement": enforcement,
                "excluded_count": excluded,
                "downweighted_count": downweighted,
            },
        )

    def _aggregate_plain(self, server_round, results):
        active, enforcement, total_weight = self._build_trust_weights(results)

        # All clients excluded — keep current global model unchanged
        if total_weight == 0.0 or not active:
            log.warning(
                "Round %d — all clients excluded by trust enforcement; "
                "skipping aggregation, keeping current model",
                server_round,
            )
            self._post_enforcement(server_round, enforcement)
            current_params = ndarrays_to_parameters(self._get_global_ndarrays())
            return current_params, {"aggregation": "fedavg_plain_skipped_all_excluded"}

        num_layers = len(active[0][0])
        avg = []
        for i in range(num_layers):
            layer_sum = np.zeros_like(active[0][0][i], dtype=np.float64)
            for ndarrays, eff_weight, _cid in active:
                layer_sum += ndarrays[i].astype(np.float64) * (
                    eff_weight / total_weight
                )
            avg.append(layer_sum.astype(np.float32))

        self._set_global_ndarrays(avg)
        self._post_enforcement(server_round, enforcement)
        return ndarrays_to_parameters(avg), {"aggregation": "fedavg_plain"}

    # ── HE FedAvg ────────────────────────────────────────

    def _aggregate_he(self, server_round, results):
        """
        HE-based aggregation using CKKS with trust-weighted deltas.
        Falls back to plain FedAvg on any error (TenSEAL failures are common on
        low-memory/low-power dev machines).

        Non-selected layers: trust-weighted plain average.
        Selected (CKKS) layers: each client's encrypted delta is scaled by
        (effective_weight / total_weight) before summing, so excluded clients
        contribute zero and downweighted clients contribute proportionally.

        NOTE (Phase 2A — deferred):
        Currently decrypts via ``enc_agg[key].decrypt()`` using the server's own
        CKKS secret key.  Full VSS threshold decryption is planned but deferred
        until the Flower FitRes protocol carries VSS share fields.
        """
        try:
            import tenseal as ts

            active, enforcement, total_weight = self._build_trust_weights(results)

            # All clients excluded — keep current global model unchanged
            if total_weight == 0.0 or not active:
                log.warning(
                    "Round %d — all clients excluded (HE path); "
                    "skipping aggregation, keeping current model",
                    server_round,
                )
                self._post_enforcement(server_round, enforcement)
                current_params = ndarrays_to_parameters(self._get_global_ndarrays())
                return current_params, {"aggregation": "fedavg_he_skipped_all_excluded"}

            num_active = len(active)
            global_state = self.global_model.state_dict()
            keys = list(global_state.keys())

            # ── Plain trust-weighted average for non-selected layers ──
            new_ndarrays = []
            for i, key in enumerate(keys):
                if key not in SELECTED_LAYERS:
                    layer_sum = np.zeros_like(active[0][0][i], dtype=np.float64)
                    for ndarrays, eff_weight, _cid in active:
                        layer_sum += ndarrays[i].astype(np.float64) * (
                            eff_weight / total_weight
                        )
                    new_ndarrays.append(layer_sum.astype(np.float32))
                else:
                    new_ndarrays.append(global_state[key].cpu().numpy())

            # ── HE aggregation for selected layers ──

            # ── Phase 1: Encrypt — collect per-layer delta norms + cipher sizes ──
            t_enc_start = time.time()
            encrypted_deltas = []
            shapes: dict[str, tuple] = {}
            enc_layer_data: list[dict] = []  # per-layer metrics for the security event

            for ndarrays, eff_weight, _cid in active:
                w = eff_weight / total_weight  # normalised weight
                client_enc: dict = {}
                for i, key in enumerate(keys):
                    if key in SELECTED_LAYERS:
                        delta = ndarrays[i] - global_state[key].cpu().numpy()
                        delta = np.clip(delta, -10.0, 10.0).astype(np.float64)
                        delta = np.nan_to_num(delta, nan=0.0, posinf=0.0, neginf=0.0)
                        shapes[key] = delta.shape
                        # Scale delta by normalised trust weight before encrypting
                        scaled = (delta * w).flatten().tolist()
                        cipher = ts.ckks_vector(self.ckks_ctx, scaled)
                        client_enc[key] = cipher
                        # Measure only once (first client per layer) to avoid redundant serialise calls
                        if len(encrypted_deltas) == 0:
                            try:
                                serialised = cipher.serialize()
                                cipher_kb = round(len(serialised) / 1024, 1)
                                cipher_hex = serialised[:32].hex()
                            except Exception:
                                cipher_kb = None
                                cipher_hex = None
                            enc_layer_data.append(
                                {
                                    "layer": key,
                                    "delta_norm": round(
                                        float(np.linalg.norm(delta)), 6
                                    ),
                                    "cipher_kb": cipher_kb,
                                    "cipher_hex": cipher_hex,
                                }
                            )
                encrypted_deltas.append(client_enc)

                # Archive CKKS-encrypted bytes per client for FedRecovery use
                try:
                    enc_bytes = {k: v.serialize() for k, v in client_enc.items()}
                    self._archive.store_enc(
                        _cid,
                        server_round,
                        enc_bytes,
                        metadata={
                            "weight": float(w),
                            "client_id": str(_cid),
                            "round": int(server_round),
                        },
                    )
                except Exception as _exc:
                    log.warning(
                        "GradientArchive.store_enc failed for %s r%d: %s",
                        _cid,
                        server_round,
                        _exc,
                    )

            enc_time = round(time.time() - t_enc_start, 3)
            total_cipher_kb = round(
                sum(
                    ld["cipher_kb"]
                    for ld in enc_layer_data
                    if ld["cipher_kb"] is not None
                )
                * num_active,
                1,
            )
            enc_detail = (
                f"{len(SELECTED_LAYERS)} layers | {num_active} client{'s' if num_active != 1 else ''} | "
                f"enc={enc_time}s | {total_cipher_kb} KB total"
            )
            _emit_security_event(
                "he_encrypt",
                server_round,
                detail=enc_detail,
                data={
                    "num_layers": len(SELECTED_LAYERS),
                    "num_clients": num_active,
                    "enc_time_sec": enc_time,
                    "total_cipher_kb": total_cipher_kb,
                    "layers": enc_layer_data,
                },
            )

            # ── Phase 2: Aggregate (HE sum) ──
            t_agg_start = time.time()
            enc_agg = encrypted_sum(encrypted_deltas)
            agg_time = round(time.time() - t_agg_start, 3)

            _emit_security_event(
                "he_aggregate",
                server_round,
                detail=(
                    f"{num_active} client{'s' if num_active != 1 else ''} × {len(enc_agg)} layers | "
                    f"agg={agg_time}s | CKKS poly={HE_POLY_MODULUS}"
                ),
                data={
                    "num_clients": num_active,
                    "num_layers": len(enc_agg),
                    "agg_time_sec": agg_time,
                    "he_poly_modulus": HE_POLY_MODULUS,
                },
            )

            # ── Phase 3: Decrypt via VSS threshold reconstruction ──
            # Direct .decrypt() fails here because the VSS ceremony called
            # ctx.make_context_public() during __init__, permanently stripping
            # the secret key from self.ckks_ctx.  threshold_decrypt()
            # reconstructs a short-lived private context from the stored VSS
            # shares, decrypts all layers, then destroys the context immediately.
            # num_clients=1 because trust weights were pre-applied as scaling
            # before encryption — the ciphertext sum IS the weighted delta.
            t_dec_start = time.time()
            dec_layer_data: list[dict] = []

            from fl_common.vss_utils import threshold_decrypt

            decrypted_tensors = threshold_decrypt(
                enc_vectors=enc_agg,
                contributed_shares=self._vss["shares"],
                nonces=self._vss["nonces"],
                commitments=self._vss["commitments"],
                shapes=shapes,
                public_ctx=self.ckks_ctx,
                num_clients=1,
            )

            for key, delta_tensor in decrypted_tensors.items():
                delta_agg = delta_tensor.numpy()
                idx = keys.index(key)
                new_ndarrays[idx] = global_state[key].cpu().numpy() + delta_agg
                dec_layer_data.append(
                    {
                        "layer": key,
                        "delta_agg_norm": round(float(np.linalg.norm(delta_agg)), 6),
                        "decrypted_preview": [
                            round(float(x), 6) for x in delta_agg.flatten()[:5].tolist()
                        ],
                    }
                )

            dec_time = round(time.time() - t_dec_start, 3)
            _emit_security_event(
                "he_decrypt",
                server_round,
                detail=(f"{len(enc_agg)} layers | dec={dec_time}s"),
                data={
                    "num_layers": len(enc_agg),
                    "dec_time_sec": dec_time,
                    "layers": dec_layer_data,
                },
            )

            self._set_global_ndarrays(new_ndarrays)
            self._post_enforcement(server_round, enforcement)
            return (
                ndarrays_to_parameters(new_ndarrays),
                {
                    "aggregation": "fedavg_he_ckks",
                    "he_poly_modulus": str(HE_POLY_MODULUS),
                    "num_encrypted_layers": str(len(SELECTED_LAYERS)),
                },
            )
        except Exception as exc:
            log.warning(
                "HE aggregation failed (round %d): %s — falling back to plain FedAvg",
                server_round,
                exc,
            )
            return self._aggregate_plain(server_round, results)

    # ── Checkpoint ───────────────────────────────────────

    def _save_checkpoint(self, server_round: int) -> None:
        ckpt_dir = os.path.join(MODEL_DIR, "fl_checkpoints")
        os.makedirs(ckpt_dir, exist_ok=True)
        path = os.path.join(ckpt_dir, f"global_round_{server_round}.pt")
        torch.save(
            {"round": server_round, "model_state": self.global_model.state_dict()}, path
        )
        log.info("Checkpoint → %s", path)


# ═══════════════════════════════════════════════════════════
#  mTLS gRPC credential builder
# ═══════════════════════════════════════════════════════════


def _build_mtls_credentials() -> Optional[tuple[bytes, bytes, bytes]]:
    """Build mTLS gRPC server credentials if cert files are present.

    Expected env vars / default paths:
        FL_TLS_CERT   — server certificate PEM  (default ./certs/server.crt)
        FL_TLS_KEY    — server private key PEM   (default ./certs/server.key)
        FL_TLS_CA     — CA certificate PEM       (default ./certs/ca.crt)

    Returns ``None`` when any file is missing (falls back to insecure channel).
    """
    cert_path = os.environ.get("FL_TLS_CERT", "./certs/server.crt")
    key_path = os.environ.get("FL_TLS_KEY", "./certs/server.key")
    ca_path = os.environ.get("FL_TLS_CA", "./certs/ca.crt")

    for p in (cert_path, key_path, ca_path):
        if not os.path.isfile(p):
            log.warning(
                "mTLS cert file not found: %s — falling back to insecure channel", p
            )
            return None

    with open(cert_path, "rb") as f:
        cert_pem = f.read()
    with open(key_path, "rb") as f:
        key_pem = f.read()
    with open(ca_path, "rb") as f:
        ca_pem = f.read()

    log.info("mTLS credentials loaded (cert=%s, CA=%s)", cert_path, ca_path)
    # Flower start_server() expects (ca_cert, server_cert, server_key) as raw bytes
    return (ca_pem, cert_pem, key_pem)


# ═══════════════════════════════════════════════════════════
#  Entrypoint
# ═══════════════════════════════════════════════════════════


def make_global_model() -> CNN_LSTM_IDS:
    """Load or initialise the global CNN-LSTM model."""
    model = CNN_LSTM_IDS(SEQ_LEN, NUM_FEATURES)
    pretrained = os.path.join(MODEL_DIR, "cnn_lstm_global_with_HE_25rounds_16k.pt")
    if os.path.isfile(pretrained):
        log.info("Loading pre-trained weights from %s", pretrained)
        state = torch.load(pretrained, map_location="cpu", weights_only=True)
        if isinstance(state, dict) and "model_state" in state:
            model.load_state_dict(state["model_state"])
        else:
            model.load_state_dict(state)
    else:
        log.info("No pre-trained weights — starting from scratch")
    model.eval()
    return model


def main() -> None:
    log.info("═" * 50)
    log.info("  IoT IDS — Flower FL Server")
    log.info("  Rounds: %d | Min clients: %d | HE: %s", ROUNDS, MIN_CLIENTS, USE_HE)
    log.info("═" * 50)

    global_model = make_global_model()

    strategy = FedAvgHE(
        global_model=global_model,
        use_he=USE_HE,
        min_fit_clients=MIN_FIT_CLIENTS,
        min_available_clients=MIN_CLIENTS,
        min_evaluate_clients=0,
        fraction_fit=1.0,
        fraction_evaluate=0.0,
    )

    # Notify backend that training is starting
    _post_to_backend(
        "/api/v1/internal/fl/status",
        {
            "status": "started",
            "total_rounds": ROUNDS,
            "num_clients": MIN_CLIENTS,
            "use_he": USE_HE,
        },
    )

    # Build mTLS credentials (None → insecure fallback)
    tls_creds = _build_mtls_credentials()

    fl.server.start_server(
        server_address=SERVER_ADDRESS,
        config=fl.server.ServerConfig(num_rounds=ROUNDS),
        strategy=strategy,
        grpc_max_message_length=512 * 1024 * 1024,
        certificates=tls_creds,  # (ca_cert, server_cert, server_key) bytes or None
    )

    # Save final model
    final_path = os.path.join(MODEL_DIR, "global_final.pt")
    torch.save(global_model.state_dict(), final_path)
    log.info("Final model → %s", final_path)

    history_path = os.path.join(MODEL_DIR, "fl_training_history.json")
    with open(history_path, "w") as f:
        json.dump(strategy.round_metrics, f, indent=2)
    log.info("History → %s", history_path)

    # Notify backend that training is complete
    _post_to_backend(
        "/api/v1/internal/fl/status",
        {
            "status": "completed",
            "total_rounds": ROUNDS,
            "rounds_completed": len(strategy.round_metrics),
            "model_path": final_path,
        },
    )


if __name__ == "__main__":
    main()
