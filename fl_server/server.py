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
    compute_abnormality,
    construct_test_gradient,
    update_trust_score,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(message)s")
log = logging.getLogger("fl_server")

# ── env config ───────────────────────────────────────────
ROUNDS = int(os.environ.get("ROUNDS", DEFAULT_CONFIG["ROUNDS"]))
MIN_CLIENTS = int(os.environ.get("MIN_CLIENTS", 2))
MIN_FIT_CLIENTS = int(os.environ.get("MIN_FIT_CLIENTS", MIN_CLIENTS))
SERVER_ADDRESS = os.environ.get("FL_SERVER_ADDRESS", "0.0.0.0:8080")
USE_HE = os.environ.get("USE_HE", "true").lower() in ("true", "1", "yes")
MODEL_DIR = os.environ.get("MODEL_DIR", "/app/models")
BACKEND_URL = os.environ.get("BACKEND_URL", "http://iot_ids_backend:8000")
CLIENT_KEY_DIR = os.environ.get("CLIENT_KEY_DIR", "./certs/client_keys/")

SEQ_LEN = DEFAULT_CONFIG["SEQUENCE_LENGTH"]
NUM_FEATURES = DEFAULT_CONFIG["NUM_FEATURES"]

# ── RECESS / refresh intervals ───────────────────────────
RECESS_INTERVAL: int = 5
REFRESH_INTERVAL: int = 20

# ── Well-known FL client names ────────────────────────────
FL_CLIENT_NAMES: List[str] = ["Bank_A", "Bank_B", "Bank_C"]

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


# ── Security helpers ─────────────────────────────────────

def generate_round_nonce(session_id: str, round_number: int) -> str:
    """Return a unique nonce for a given session and round."""
    return hashlib.sha256(
        f"{session_id}:{round_number}:{secrets.token_hex(16)}".encode()
    ).hexdigest()


def _load_client_public_keys() -> Dict[str, bytes]:
    """Load Ed25519 public keys for each FL client from PEM files.

    Files are expected at ``CLIENT_KEY_DIR/<client_name>.pub.pem``, e.g.
    ``./certs/client_keys/Bank_A.pub.pem``.  Missing keys are skipped with
    a warning so the server can still start even when certs are not yet
    provisioned.
    """
    keys: Dict[str, bytes] = {}
    for name in FL_CLIENT_NAMES:
        path = os.path.join(CLIENT_KEY_DIR, f"{name}.pub.pem")
        if os.path.isfile(path):
            with open(path, "rb") as fh:
                keys[name] = fh.read()
            log.info("Loaded public key for %s from %s", name, path)
        else:
            log.warning("Public key not found for %s at %s — signature checks will be skipped", name, path)
    return keys


def _run_vss_ceremony(ckks_ctx) -> dict:
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

        # ── Client public keys (Ed25519 PEM) ───────────────
        self._client_public_keys: Dict[str, bytes] = _load_client_public_keys()

        if self.use_he:
            log.info("Creating CKKS context …")
            self.ckks_ctx = create_ckks_context()

            # ── VSS ceremony: split secret key to clients ──
            self._vss: dict = _run_vss_ceremony(self.ckks_ctx)
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

        config: Dict[str, Scalar] = {
            "server_round": server_round,
            "total_rounds": ROUNDS,
            "local_epochs": DEFAULT_CONFIG["LOCAL_EPOCHS"],
            "lr": float(DEFAULT_CONFIG["LEARNING_RATE"]),
            "use_he": self.use_he,
            "batch_size": DEFAULT_CONFIG["BATCH_SIZE"],
            "max_batches": DEFAULT_CONFIG["MAX_BATCHES"],
            "round_nonce": nonce,
        }
        fit_ins = FitIns(parameters, config)
        sample_size = max(self.min_fit_clients, MIN_FIT_CLIENTS)
        clients = client_manager.sample(
            num_clients=sample_size,
            min_num_clients=self.min_available_clients,
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
            self._trigger_vss_refresh()

        # ── Normal aggregation ────────────────────────────
        t0 = time.time()
        num_clients = len(results)
        log.info("Round %d — aggregating %d clients (HE=%s)", rnd, num_clients, self.use_he)

        # Notify backend that aggregation is starting
        _post_to_backend("/api/v1/internal/fl/progress", {
            "round": rnd,
            "total_rounds": ROUNDS,
            "phase": "aggregating",
            "num_clients": num_clients,
            "message": f"Aggregating {num_clients} client updates (HE={self.use_he})",
        })

        if self.use_he:
            params, metrics = self._aggregate_he(rnd, results)
        else:
            params, metrics = self._aggregate_plain(rnd, results)

        # Cache last aggregated gradient for RECESS probing
        self._update_last_agg_gradient()

        elapsed = time.time() - t0
        metrics["aggregation_time_sec"] = float(elapsed)
        log.info("Round %d — done in %.2fs", rnd, elapsed)

        self._save_checkpoint(rnd)
        self.round_metrics.append({"round": rnd, **metrics})

        # Report completed round to backend (persists + broadcasts via WS)
        self._report_round(rnd, num_clients, results, elapsed, metrics)

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

        _post_to_backend("/api/v1/internal/fl/progress", {
            "round": rnd,
            "total_rounds": ROUNDS,
            "phase": "recess_detection",
            "message": f"RECESS detection round {rnd}",
        })

        expected_nonce = self._round_nonces.get(rnd, "")
        trust_updates: Dict[str, float] = {}

        for proxy, fit_res in results:
            m = fit_res.metrics or {}
            cid = str(m.get("client_id", getattr(proxy, "cid", "unknown")))

            # ── 1. Verify nonce echo ──────────────────────
            nonce_echo = str(m.get("nonce_echo", ""))
            if expected_nonce and nonce_echo != expected_nonce:
                log.warning("Round %d — client %s: nonce mismatch — discarding", rnd, cid)
                continue

            # ── 2. Retrieve base64-encoded RECESS response ─
            recess_b64 = m.get("recess_response", "")
            if not recess_b64:
                log.warning("Round %d — client %s: no recess_response — skipping", rnd, cid)
                continue

            try:
                recess_bytes = base64.b64decode(recess_b64)
            except Exception as exc:
                log.warning("Round %d — client %s: bad base64 recess_response: %s", rnd, cid, exc)
                continue

            # ── 3. Verify Ed25519 signature ───────────────
            sig_b64 = m.get("recess_signature", "")
            pub_key_pem = self._client_public_keys.get(cid)
            if sig_b64 and pub_key_pem:
                try:
                    sig_bytes = base64.b64decode(sig_b64)
                    if not verify_gradient(recess_bytes, sig_bytes, pub_key_pem):
                        log.warning(
                            "Round %d — client %s: invalid signature — discarding", rnd, cid
                        )
                        continue
                except Exception as exc:
                    log.warning(
                        "Round %d — client %s: signature error: %s — discarding", rnd, cid, exc
                    )
                    continue
            elif pub_key_pem:
                # Key is loaded but no signature provided — warn and continue
                log.warning(
                    "Round %d — client %s: no signature provided (key on file) — proceeding with caution",
                    rnd, cid,
                )

            # ── 4. Decode response gradient from raw bytes ─
            # Clients encode a flat float32 numpy array as raw bytes
            try:
                response_flat_np = np.frombuffer(recess_bytes, dtype=np.float32).copy()
                response_flat = torch.tensor(response_flat_np, dtype=torch.float32)
            except Exception as exc:
                log.warning(
                    "Round %d — client %s: failed to decode response gradient: %s", rnd, cid, exc
                )
                continue

            # ── 5. Build test gradient flat vector ────────
            if self._last_agg_gradient is not None:
                try:
                    test_flat = flatten_gradient(self._last_agg_gradient)
                except Exception as exc:
                    log.warning("Could not flatten last agg gradient: %s", exc)
                    test_flat = response_flat.clone()
            else:
                # No prior round gradient — use the response itself as neutral reference
                test_flat = response_flat.clone()

            # Align lengths (truncate / pad to shorter)
            min_len = min(test_flat.numel(), response_flat.numel())
            test_flat = test_flat[:min_len]
            response_flat = response_flat[:min_len]

            # ── 6. Compute abnormality score ───────────────
            try:
                abnormality = compute_abnormality(test_flat, response_flat)
            except Exception as exc:
                log.warning("Round %d — client %s: compute_abnormality error: %s", rnd, cid, exc)
                abnormality = 1.0

            # ── 7. Update trust score ──────────────────────
            current = self._trust_scores.get(cid, 1.0)
            new_score = update_trust_score(current, abnormality)
            self._trust_scores[cid] = new_score
            trust_updates[cid] = new_score
            log.info(
                "Round %d — client %s: abnormality=%.4f  trust %.4f → %.4f",
                rnd, cid, abnormality, current, new_score,
            )

            # ── 8. Flag if abnormality > 0.7 ──────────────
            if abnormality > 0.7:
                log.warning(
                    "Round %d — FLAGGING client %s (abnormality=%.4f)", rnd, cid, abnormality
                )
                _post_to_backend(
                    "/api/v1/fl/flagged_client",
                    {
                        "client_id": cid,
                        "round": rnd,
                        "abnormality": float(abnormality),
                    },
                )
                # Broadcast CLIENT_FLAGGED via backend WS relay
                _post_to_backend(
                    "/api/v1/internal/fl/progress",
                    {
                        "round": rnd,
                        "total_rounds": ROUNDS,
                        "phase": "client_flagged",
                        "client_id": cid,
                        "message": (
                            f"Client {cid} flagged in RECESS round {rnd}: "
                            f"abnormality={abnormality:.4f}"
                        ),
                    },
                )

        # ── 9. Broadcast trust-score update ───────────────
        if trust_updates:
            _post_to_backend(
                "/api/v1/internal/fl/progress",
                {
                    "round": rnd,
                    "total_rounds": ROUNDS,
                    "phase": "client_trust_update",
                    "message": f"Trust scores updated after RECESS round {rnd}",
                    **{f"trust_{cid}": score for cid, score in trust_updates.items()},
                },
            )

        # RECESS round does not update the model — return current parameters
        current_params = ndarrays_to_parameters(self._get_global_ndarrays())
        return current_params, {"aggregation": "recess_detection_round", "round": rnd}

    # ── VSS key refresh ───────────────────────────────────

    def _trigger_vss_refresh(self) -> None:
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
        except Exception as exc:
            log.error("VSS key refresh failed: %s", exc)

    def _update_last_agg_gradient(self) -> None:
        """Cache the current global model state as the last aggregated gradient."""
        try:
            state = self.global_model.state_dict()
            self._last_agg_gradient = {
                key: state[key].cpu().detach().clone()
                for key in SELECTED_LAYERS
                if key in state
            }
        except Exception as exc:
            log.warning("Could not cache last agg gradient: %s", exc)

    def _report_round(
        self,
        server_round: int,
        num_clients: int,
        results,
        duration: float,
        agg_metrics: dict,
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

            client_metrics.append({
                "client_id": str(cid),
                "local_loss": loss,
                "local_accuracy": acc,
                "num_samples": n,
                "training_time_sec": float(m.get("training_time_sec", 0.0)),
                "encrypted": self.use_he,
            })
            total_samples += n
            weighted_loss += loss * n
            weighted_acc += acc * n

        # Compute weighted average global metrics
        global_loss = weighted_loss / max(total_samples, 1)
        global_accuracy = weighted_acc / max(total_samples, 1)

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
        }

        _post_to_backend("/api/v1/internal/fl/round", round_payload)

    # ── Plain FedAvg ─────────────────────────────────────

    def _aggregate_plain(self, server_round, results):
        weights_results = [
            (parameters_to_ndarrays(r.parameters), r.num_examples) for _, r in results
        ]
        total = sum(n for _, n in weights_results)
        num_layers = len(weights_results[0][0])
        avg = []
        for i in range(num_layers):
            layer_sum = np.zeros_like(weights_results[0][0][i])
            for layers, n in weights_results:
                layer_sum += layers[i] * (n / total)
            avg.append(layer_sum)

        self._set_global_ndarrays(avg)
        return ndarrays_to_parameters(avg), {"aggregation": "fedavg_plain"}

    # ── HE FedAvg ────────────────────────────────────────

    def _aggregate_he(self, server_round, results):
        import tenseal as ts

        num_clients = len(results)
        global_state = self.global_model.state_dict()
        keys = list(global_state.keys())

        weights_results = [
            (parameters_to_ndarrays(r.parameters), r.num_examples) for _, r in results
        ]
        total_examples = sum(n for _, n in weights_results)

        # Plain FedAvg for non-selected layers
        new_ndarrays = []
        for i, key in enumerate(keys):
            if key not in SELECTED_LAYERS:
                layer_sum = np.zeros_like(weights_results[0][0][i])
                for layers, n in weights_results:
                    layer_sum += layers[i] * (n / total_examples)
                new_ndarrays.append(layer_sum)
            else:
                new_ndarrays.append(global_state[key].cpu().numpy())

        # HE aggregation for selected layers
        encrypted_deltas = []
        shapes = {}
        for layers, _n in weights_results:
            client_enc = {}
            for i, key in enumerate(keys):
                if key in SELECTED_LAYERS:
                    delta = layers[i] - global_state[key].cpu().numpy()
                    delta = np.clip(delta, -10.0, 10.0).astype(np.float64)
                    delta = np.nan_to_num(delta, nan=0.0, posinf=0.0, neginf=0.0)
                    shapes[key] = delta.shape
                    client_enc[key] = ts.ckks_vector(self.ckks_ctx, delta.flatten().tolist())
            encrypted_deltas.append(client_enc)

        enc_agg = encrypted_sum(encrypted_deltas)

        for key in enc_agg:
            flat = np.array(enc_agg[key].decrypt(), dtype=np.float32)
            flat = np.nan_to_num(flat, nan=0.0, posinf=0.0, neginf=0.0)
            shape = shapes[key]
            num_el = int(np.prod(shape))
            delta_avg = flat[:num_el].reshape(shape) / num_clients
            idx = keys.index(key)
            new_ndarrays[idx] = global_state[key].cpu().numpy() + delta_avg

        self._set_global_ndarrays(new_ndarrays)
        return (
            ndarrays_to_parameters(new_ndarrays),
            {
                "aggregation": "fedavg_he_ckks",
                "he_poly_modulus": str(HE_POLY_MODULUS),
                "num_encrypted_layers": str(len(SELECTED_LAYERS)),
            },
        )

    # ── Checkpoint ───────────────────────────────────────

    def _save_checkpoint(self, server_round: int) -> None:
        ckpt_dir = os.path.join(MODEL_DIR, "fl_checkpoints")
        os.makedirs(ckpt_dir, exist_ok=True)
        path = os.path.join(ckpt_dir, f"global_round_{server_round}.pt")
        torch.save({"round": server_round, "model_state": self.global_model.state_dict()}, path)
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
    key_path  = os.environ.get("FL_TLS_KEY",  "./certs/server.key")
    ca_path   = os.environ.get("FL_TLS_CA",   "./certs/ca.crt")

    for p in (cert_path, key_path, ca_path):
        if not os.path.isfile(p):
            log.warning("mTLS cert file not found: %s — falling back to insecure channel", p)
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
    _post_to_backend("/api/v1/internal/fl/status", {
        "status": "started",
        "total_rounds": ROUNDS,
        "num_clients": MIN_CLIENTS,
        "use_he": USE_HE,
    })

    # Build mTLS credentials (None → insecure fallback)
    tls_creds = _build_mtls_credentials()

    fl.server.start_server(
        server_address=SERVER_ADDRESS,
        config=fl.server.ServerConfig(num_rounds=ROUNDS),
        strategy=strategy,
        grpc_max_message_length=512 * 1024 * 1024,
        certificates=tls_creds,   # (ca_cert, server_cert, server_key) bytes or None
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
    _post_to_backend("/api/v1/internal/fl/status", {
        "status": "completed",
        "total_rounds": ROUNDS,
        "rounds_completed": len(strategy.round_metrics),
        "model_path": final_path,
    })


if __name__ == "__main__":
    main()
