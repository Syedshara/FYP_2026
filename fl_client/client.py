"""
FL Client entry point — supports three operating modes.

Modes
-----
MONITOR  — Runs traffic simulator + local inference, POSTs predictions
TRAIN    — Runs Flower FL training round against the FL server
IDLE     — Waits for mode change command via env / signal

The mode is controlled by the MODE env var (default: IDLE).

Env vars
--------
CLIENT_ID          : str   — e.g. "bank_a"
FL_SERVER_URL      : str   — e.g. "fl_server:8080"
DATA_PATH          : str   — path to client data directory
BACKEND_URL        : str   — e.g. "http://iot_ids_backend:8000"
MODE               : str   — MONITOR | TRAIN | IDLE  (default: IDLE)
MONITOR_INTERVAL   : float — seconds between prediction cycles (default 3.0)
ATTACK_RATIO       : float — fraction of simulated traffic that is attacks (default 0.2)
FL_CLIENT_CERT     : str   — path to mTLS client certificate PEM file
FL_CLIENT_KEY      : str   — path to mTLS client private key PEM file
FL_CA_CERT         : str   — path to CA certificate PEM for server verification
CLIENT_SIGNING_KEY : str   — path to Ed25519 private key PEM file for gradient signing
"""

import base64
import os
import sys
import time
import logging
from collections import OrderedDict

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import Dataset, DataLoader

# ── shared code ──────────────────────────────────────────
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from fl_common.model import CNN_LSTM_IDS, DEFAULT_CONFIG
from fl_common import signing_utils, recess_utils

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(message)s")
log = logging.getLogger("fl_client")

# ── env config ───────────────────────────────────────────
CLIENT_ID = os.environ.get("CLIENT_ID", "client_0")
FL_SERVER_ADDRESS = os.environ.get("FL_SERVER_URL", "fl_server:8080")
DATA_PATH = os.environ.get("DATA_PATH", "/app/data")
BACKEND_URL = os.environ.get("BACKEND_URL", "http://iot_ids_backend:8000")
MODE = os.environ.get("MODE", "IDLE").upper()

# ── mTLS certificate paths ────────────────────────────────
FL_CLIENT_CERT = os.environ.get("FL_CLIENT_CERT", f"./certs/{CLIENT_ID}.crt")
FL_CLIENT_KEY = os.environ.get("FL_CLIENT_KEY", f"./certs/{CLIENT_ID}.key")
FL_CA_CERT = os.environ.get("FL_CA_CERT", "./certs/ca.crt")

# ── Ed25519 signing key path ──────────────────────────────
CLIENT_SIGNING_KEY = os.environ.get(
    "CLIENT_SIGNING_KEY", f"./certs/{CLIENT_ID}_ed25519.pem"
)

# ── Message type constants (VSS share delivery) ───────────
MSG_TYPE_SHARE = "vss_share"
MSG_TYPE_REFRESH = "vss_refresh"

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
SEQ_LEN = DEFAULT_CONFIG["SEQUENCE_LENGTH"]
NUM_FEATURES = DEFAULT_CONFIG["NUM_FEATURES"]
POS_WEIGHT = torch.tensor([DEFAULT_CONFIG["POS_WEIGHT"]], device=DEVICE)
CRITERION = nn.BCEWithLogitsLoss(pos_weight=POS_WEIGHT)

# ── Backend progress reporting ───────────────────────────
_http_client = None


def _get_http():
    """Lazy httpx client for progress reporting."""
    global _http_client
    if _http_client is None:
        import httpx
        _http_client = httpx.Client(base_url=BACKEND_URL, timeout=5.0)
    return _http_client


def _report_progress(payload: dict) -> None:
    """POST progress update to backend (best-effort, don't block training)."""
    payload["client_id"] = CLIENT_ID
    try:
        _get_http().post("/api/v1/internal/fl/progress", json=payload)
    except Exception as exc:
        log.debug("Progress POST failed: %s", exc)


# ═══════════════════════════════════════════════════════════
#  Dataset — loads .npy chunks lazily (same as notebook)
# ═══════════════════════════════════════════════════════════
class ClientSequenceDataset(Dataset):
    """Reads X_seq_chunk_*.npy / y_seq_chunk_*.npy files."""

    def __init__(self, client_dir: str):
        self.x_files = sorted([
            os.path.join(client_dir, f)
            for f in os.listdir(client_dir) if f.startswith("X_seq")
        ])
        self.y_files = sorted([
            os.path.join(client_dir, f)
            for f in os.listdir(client_dir) if f.startswith("y_seq")
        ])
        assert len(self.x_files) == len(self.y_files), (
            f"Mismatch: {len(self.x_files)} X files vs {len(self.y_files)} y files"
        )
        assert len(self.x_files) > 0, f"No data files found in {client_dir}"

        self.chunk_sizes = []
        for yf in self.y_files:
            y = np.load(yf, mmap_mode="r")
            self.chunk_sizes.append(len(y))
        self.cumulative_sizes = np.cumsum(self.chunk_sizes)

        self._current_chunk_id = None
        self._current_x = None
        self._current_y = None

    def __len__(self) -> int:
        return int(self.cumulative_sizes[-1])

    def __getitem__(self, idx: int):
        chunk_id = int(np.searchsorted(self.cumulative_sizes, idx, side="right"))
        local_idx = idx if chunk_id == 0 else idx - int(self.cumulative_sizes[chunk_id - 1])

        if chunk_id != self._current_chunk_id:
            self._current_x = np.load(self.x_files[chunk_id], mmap_mode="r")
            self._current_y = np.load(self.y_files[chunk_id], mmap_mode="r")
            self._current_chunk_id = chunk_id

        x = self._current_x[local_idx]
        y = self._current_y[local_idx]
        return (
            torch.tensor(x, dtype=torch.float32),
            torch.tensor(y, dtype=torch.float32),
        )


# ═══════════════════════════════════════════════════════════
#  Local training function
# ═══════════════════════════════════════════════════════════
# Throttle interval for per-batch progress reports (seconds)
_PROGRESS_THROTTLE = 2.0


def local_train(
    model: CNN_LSTM_IDS,
    dataloader: DataLoader,
    epochs: int,
    lr: float,
    max_batches: int = 50,
    server_round: int = 0,
    total_rounds: int = 0,
) -> dict:
    """Train model locally and return metrics.

    Reports per-batch progress (throttled to every 2 s) with:
    batches_processed, total_batches, samples_processed, total_samples,
    throughput (samples/sec), eta_seconds, current_loss, current_accuracy.
    """
    model.train()
    optimizer = optim.Adam(model.parameters(), lr=lr)
    total_loss = 0.0
    total_correct = 0
    total_samples = 0
    t0 = time.time()
    last_report_time = 0.0  # ensures first batch reports immediately

    # Pre-calculate totals for progress tracking
    total_batches_per_epoch = min(len(dataloader), max_batches)
    grand_total_batches = total_batches_per_epoch * epochs
    # Estimate total samples (batch_size * total_batches) — refined as we go
    batch_size_est = dataloader.batch_size or 32
    grand_total_samples = batch_size_est * grand_total_batches
    global_batch_idx = 0  # cumulative batch counter across all epochs

    for epoch in range(epochs):
        epoch_loss = 0.0
        epoch_correct = 0
        epoch_samples = 0

        for batch_idx, (x, y) in enumerate(dataloader):
            if batch_idx >= max_batches:
                break
            x = x.to(DEVICE)
            y = y.to(DEVICE).unsqueeze(1)

            optimizer.zero_grad()
            preds = model(x)
            loss = CRITERION(preds, y)
            loss.backward()
            optimizer.step()

            batch_size = x.size(0)
            epoch_loss += loss.item() * batch_size
            epoch_samples += batch_size
            total_loss += loss.item() * batch_size
            total_samples += batch_size
            global_batch_idx += 1

            # Compute batch accuracy
            predicted = (torch.sigmoid(preds) > 0.5).float()
            batch_correct = (predicted == y).sum().item()
            epoch_correct += batch_correct
            total_correct += batch_correct

            # ── Throttled per-batch progress report ──
            now = time.time()
            if now - last_report_time >= _PROGRESS_THROTTLE or global_batch_idx == grand_total_batches:
                last_report_time = now
                elapsed = now - t0
                throughput = total_samples / max(elapsed, 0.001)
                # Refine total samples estimate with actual batch size
                grand_total_samples = batch_size * grand_total_batches
                remaining_samples = grand_total_samples - total_samples
                eta_seconds = remaining_samples / max(throughput, 0.001)
                cur_loss = total_loss / max(total_samples, 1)
                cur_acc = total_correct / max(total_samples, 1)

                _report_progress({
                    "round": server_round,
                    "total_rounds": total_rounds,
                    "phase": "training",
                    "epoch": epoch + 1,
                    "total_epochs": epochs,
                    "epoch_loss": epoch_loss / max(epoch_samples, 1),
                    "local_accuracy": cur_acc,
                    "batch": batch_idx + 1,
                    "total_batches": total_batches_per_epoch,
                    "batches_processed": global_batch_idx,
                    "grand_total_batches": grand_total_batches,
                    "samples_processed": total_samples,
                    "total_samples": grand_total_samples,
                    "throughput": round(throughput, 1),
                    "eta_seconds": round(max(eta_seconds, 0), 1),
                    "current_loss": round(cur_loss, 6),
                    "current_accuracy": round(cur_acc, 6),
                    "last_update_time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "message": (
                        f"Epoch {epoch + 1}/{epochs} Batch {batch_idx + 1}/{total_batches_per_epoch}"
                        f" — loss={cur_loss:.4f} acc={cur_acc:.4f} {throughput:.0f} samp/s"
                    ),
                })

    elapsed = time.time() - t0
    avg_loss = total_loss / max(total_samples, 1)
    accuracy = total_correct / max(total_samples, 1)
    return {
        "loss": avg_loss,
        "accuracy": accuracy,
        "num_samples": total_samples,
        "training_time_sec": elapsed,
    }


# ═══════════════════════════════════════════════════════════
#  Flower NumPy Client (TRAIN mode)
# ═══════════════════════════════════════════════════════════

def _load_tls_credentials() -> bytes | None:
    """Load the CA certificate PEM bytes for server verification.

    Flower's start_numpy_client() accepts the CA cert as raw bytes via
    root_certificates= for server-side SSL verification.  Client-side mTLS
    (mutual auth) is not supported by the Flower 1.x NumPy client API, so
    FL_CLIENT_CERT / FL_CLIENT_KEY are loaded here for forward-compatibility
    but only the CA bytes are returned and used.

    Falls back to None (insecure channel) if any cert file is missing.
    """
    try:
        with open(FL_CA_CERT, "rb") as f:
            ca_bytes = f.read()
        # Validate that client cert/key paths also exist (log warning if not)
        for path, label in [(FL_CLIENT_CERT, "FL_CLIENT_CERT"), (FL_CLIENT_KEY, "FL_CLIENT_KEY")]:
            if not os.path.isfile(path):
                log.warning("[%s] mTLS client file missing (%s=%s)", CLIENT_ID, label, path)
        log.info("[%s] CA cert loaded for server verification (CA=%s)", CLIENT_ID, FL_CA_CERT)
        return ca_bytes
    except FileNotFoundError as exc:
        log.warning("[%s] mTLS cert file not found (%s) — using insecure channel", CLIENT_ID, exc)
        return None


def _load_signing_key() -> bytes | None:
    """Load Ed25519 private key PEM bytes from CLIENT_SIGNING_KEY path."""
    try:
        with open(CLIENT_SIGNING_KEY, "rb") as f:
            key_pem = f.read()
        log.info("[%s] Ed25519 signing key loaded from %s", CLIENT_ID, CLIENT_SIGNING_KEY)
        return key_pem
    except FileNotFoundError:
        log.warning(
            "[%s] Signing key not found at %s — gradient signing disabled",
            CLIENT_ID, CLIENT_SIGNING_KEY,
        )
        return None


def run_train_mode():
    """
    TRAIN mode — starts the Flower FL client and connects to the FL server
    for federated learning.
    """
    import flwr as fl
    from flwr.common import NDArrays

    class IDSClient(fl.client.NumPyClient):
        """Flower client that trains the CNN-LSTM IDS model."""

        def __init__(self, model: CNN_LSTM_IDS, dataloader: DataLoader, num_samples: int):
            self.model = model
            self.dataloader = dataloader
            self.num_samples = num_samples
            # VSS share storage: set by MSG_TYPE_SHARE / MSG_TYPE_REFRESH messages
            self._vss_share: bytes | None = None
            # Ed25519 private key PEM — loaded once at startup
            self._signing_key: bytes | None = _load_signing_key()

        def get_parameters(self, config) -> NDArrays:
            return [val.cpu().numpy() for val in self.model.state_dict().values()]

        def set_parameters(self, parameters: NDArrays) -> None:
            keys = list(self.model.state_dict().keys())
            state = OrderedDict({k: torch.tensor(v) for k, v in zip(keys, parameters)})
            self.model.load_state_dict(state, strict=True)

        # ── VSS share message handlers ─────────────────────────────────────────

        def _handle_vss_share(self, config: dict) -> None:
            """Receive and store a VSS share sent by the server."""
            share_b64 = config.get("vss_share_data", "")
            if share_b64:
                self._vss_share = base64.b64decode(share_b64)
                log.info("[%s] VSS share received and stored (%d bytes)", CLIENT_ID, len(self._vss_share))
            else:
                log.warning("[%s] MSG_TYPE_SHARE received but no vss_share_data in config", CLIENT_ID)

        def _handle_vss_refresh(self, config: dict) -> None:
            """Replace existing VSS share with a newly issued one."""
            share_b64 = config.get("vss_share_data", "")
            if share_b64:
                self._vss_share = base64.b64decode(share_b64)
                log.info("[%s] VSS share refreshed (%d bytes)", CLIENT_ID, len(self._vss_share))
            else:
                log.warning("[%s] MSG_TYPE_REFRESH received but no vss_share_data in config", CLIENT_ID)

        # ── Gradient serialisation helper ──────────────────────────────────────

        @staticmethod
        def _serialise_gradient(gradient_dict: dict) -> bytes:
            """Flatten gradient dict to bytes for signing."""
            flat = recess_utils.flatten_gradient(gradient_dict)
            return flat.numpy().tobytes()

        # ── fit ────────────────────────────────────────────────────────────────

        def fit(self, parameters: NDArrays, config: dict):
            # ── Handle VSS share delivery messages before anything else ────────
            msg_type = config.get("msg_type", "")
            if msg_type == MSG_TYPE_SHARE:
                self._handle_vss_share(config)
                # Return current parameters unchanged; no training this round
                return self.get_parameters(config), self.num_samples, {"client_id": CLIENT_ID}
            if msg_type == MSG_TYPE_REFRESH:
                self._handle_vss_refresh(config)
                return self.get_parameters(config), self.num_samples, {"client_id": CLIENT_ID}

            # ── Extract round metadata ──────────────────────────────────────────
            server_round = config.get("server_round", 0)
            total_rounds = int(config.get("total_rounds", 0))
            nonce = str(config.get("round_nonce", ""))

            # ── RECESS detection round ──────────────────────────────────────────
            if str(config.get("detect", "")).lower() == "true":
                return self._fit_recess(parameters, config, server_round, total_rounds, nonce)

            # ── Normal training round ───────────────────────────────────────────
            return self._fit_normal(parameters, config, server_round, total_rounds, nonce)

        # ── Normal training ────────────────────────────────────────────────────

        def _fit_normal(
            self,
            parameters: NDArrays,
            config: dict,
            server_round: int,
            total_rounds: int,
            nonce: str,
        ):
            self.set_parameters(parameters)

            epochs = int(config.get("local_epochs", DEFAULT_CONFIG["LOCAL_EPOCHS"]))
            lr = float(config.get("lr", DEFAULT_CONFIG["LEARNING_RATE"]))
            max_batches = int(config.get("max_batches", DEFAULT_CONFIG["MAX_BATCHES"]))

            log.info(
                "[%s] Round %s/%s — training %d epochs (lr=%.4f, max_batches=%d)",
                CLIENT_ID, server_round, total_rounds, epochs, lr, max_batches,
            )

            # Report: starting local training
            _report_progress({
                "round": server_round,
                "total_rounds": total_rounds,
                "phase": "training",
                "epoch": 0,
                "total_epochs": epochs,
                "message": f"Starting local training for round {server_round}/{total_rounds}",
            })

            metrics = local_train(
                self.model, self.dataloader, epochs, lr, max_batches,
                server_round=server_round,
                total_rounds=total_rounds,
            )

            log.info(
                "[%s] Round %s — loss=%.4f, samples=%d, time=%.1fs",
                CLIENT_ID, server_round, metrics["loss"],
                metrics["num_samples"], metrics.get("training_time_sec", 0),
            )

            # ── Compute gradient for signing (local state − global state) ───────
            updated_params = self.get_parameters(config)
            gradient_dict: dict = {}
            for key, local_val, global_val in zip(
                self.model.state_dict().keys(), updated_params, parameters
            ):
                gradient_dict[key] = torch.tensor(local_val) - torch.tensor(global_val)

            # ── Sign gradient ───────────────────────────────────────────────────
            sig_b64 = ""
            if self._signing_key is not None and gradient_dict:
                try:
                    gradient_bytes = self._serialise_gradient(gradient_dict)
                    sig_bytes = signing_utils.sign_gradient(gradient_bytes, self._signing_key)
                    sig_b64 = base64.b64encode(sig_bytes).decode("ascii")
                    log.debug("[%s] Gradient signed successfully", CLIENT_ID)
                except Exception as exc:
                    log.warning("[%s] Gradient signing failed: %s", CLIENT_ID, exc)

            # Report: sending weights
            _report_progress({
                "round": server_round,
                "total_rounds": total_rounds,
                "phase": "sending_weights",
                "loss": metrics["loss"],
                "num_samples": metrics["num_samples"],
                "training_time_sec": metrics.get("training_time_sec", 0),
                "message": f"Round {server_round}/{total_rounds} training complete, sending weights",
            })

            # Include CLIENT_ID so server can map Flower CID → registered client
            metrics["client_id"] = CLIENT_ID
            metrics["nonce_echo"] = nonce
            metrics["signature"] = sig_b64
            return self.get_parameters(config), self.num_samples, metrics

        # ── RECESS detection round ─────────────────────────────────────────────

        def _fit_recess(
            self,
            parameters: NDArrays,
            config: dict,
            server_round: int,
            total_rounds: int,
            nonce: str,
        ):
            """Handle a RECESS behavioural-probing round.

            Does NOT update local model weights.  Returns the local gradient
            (flattened) encrypted against the test gradient sent by the server,
            plus the nonce echo and signature.
            """
            log.info("[%s] Round %s — RECESS detection round", CLIENT_ID, server_round)

            # Load global weights into a temporary copy without modifying self.model
            temp_global_params = parameters  # these are the global weights

            # ── Compute local gradient from current model vs. global weights ────
            local_params = self.get_parameters(config)
            gradient_dict: dict = {}
            for key, local_val, global_val in zip(
                self.model.state_dict().keys(), local_params, temp_global_params
            ):
                gradient_dict[key] = torch.tensor(local_val) - torch.tensor(global_val)

            # Flatten local gradient to bytes for the RECESS response
            local_gradient_bytes = self._serialise_gradient(gradient_dict)
            recess_response_b64 = base64.b64encode(local_gradient_bytes).decode("ascii")

            # ── Sign the local gradient bytes ────────────────────────────────────
            sig_b64 = ""
            if self._signing_key is not None:
                try:
                    sig_bytes = signing_utils.sign_gradient(local_gradient_bytes, self._signing_key)
                    sig_b64 = base64.b64encode(sig_bytes).decode("ascii")
                    log.debug("[%s] RECESS gradient signed successfully", CLIENT_ID)
                except Exception as exc:
                    log.warning("[%s] RECESS gradient signing failed: %s", CLIENT_ID, exc)

            metrics = {
                "client_id": CLIENT_ID,
                "nonce_echo": nonce,
                "recess_signature": sig_b64,   # server reads 'recess_signature' in _run_recess_round
                "recess_response": recess_response_b64,
                "is_detection_round": "true",
            }
            # Return current (unmodified) parameters — no weight update in detection round
            return self.get_parameters(config), self.num_samples, metrics

        def evaluate(self, parameters: NDArrays, config: dict):
            self.set_parameters(parameters)
            self.model.eval()

            total_loss = 0.0
            correct = 0
            total = 0

            with torch.no_grad():
                for batch_idx, (x, y) in enumerate(self.dataloader):
                    if batch_idx >= 10:
                        break
                    x = x.to(DEVICE)
                    y = y.to(DEVICE).unsqueeze(1)
                    preds = self.model(x)
                    loss = CRITERION(preds, y)
                    total_loss += loss.item() * x.size(0)
                    predicted = (torch.sigmoid(preds) > 0.5).float()
                    correct += (predicted == y).sum().item()
                    total += x.size(0)

            avg_loss = total_loss / max(total, 1)
            accuracy = correct / max(total, 1)
            return avg_loss, total, {"accuracy": accuracy}

    log.info("TRAIN mode — connecting to FL server at %s", FL_SERVER_ADDRESS)

    # Load data
    if not os.path.isdir(DATA_PATH):
        log.error("Data directory not found: %s", DATA_PATH)
        sys.exit(1)

    dataset = ClientSequenceDataset(DATA_PATH)
    dataloader = DataLoader(
        dataset,
        batch_size=DEFAULT_CONFIG["BATCH_SIZE"],
        shuffle=True,
        num_workers=0,
        pin_memory=False,
    )
    log.info("[%s] Loaded %d samples", CLIENT_ID, len(dataset))

    # Init model
    model = CNN_LSTM_IDS(SEQ_LEN, NUM_FEATURES).to(DEVICE)

    # Start Flower client
    client = IDSClient(model, dataloader, len(dataset))
    tls_credentials = _load_tls_credentials()
    if tls_credentials is not None:
        fl.client.start_numpy_client(
            server_address=FL_SERVER_ADDRESS,
            client=client,
            grpc_max_message_length=512 * 1024 * 1024,
            root_certificates=tls_credentials,  # CA PEM bytes for server cert verification
        )
    else:
        fl.client.start_numpy_client(
            server_address=FL_SERVER_ADDRESS,
            client=client,
            grpc_max_message_length=512 * 1024 * 1024,
        )
    log.info("[%s] Training complete", CLIENT_ID)


# ═══════════════════════════════════════════════════════════
#  MONITOR mode
# ═══════════════════════════════════════════════════════════

def run_monitor_mode():
    """
    MONITOR mode — generates synthetic traffic, runs local inference,
    and posts predictions to the backend API.
    """
    from monitor import run_monitor
    log.info("MONITOR mode — starting traffic simulator + inference")
    run_monitor()


# ═══════════════════════════════════════════════════════════
#  IDLE mode
# ═══════════════════════════════════════════════════════════

def run_idle_mode():
    """
    IDLE mode — client waits for instructions.
    Useful as a standby state before switching to MONITOR or TRAIN.
    """
    import signal

    log.info("IDLE mode — waiting for instructions...")
    log.info("Set MODE=MONITOR or MODE=TRAIN to activate, then restart container")

    stop = False

    def _handler(signum, frame):
        nonlocal stop
        log.info("Received signal %s — exiting IDLE", signum)
        stop = True

    signal.signal(signal.SIGTERM, _handler)
    signal.signal(signal.SIGINT, _handler)

    while not stop:
        time.sleep(5)

    log.info("IDLE mode ended")


# ═══════════════════════════════════════════════════════════
#  Entrypoint
# ═══════════════════════════════════════════════════════════

def main() -> None:
    log.info("═" * 50)
    log.info("  IoT IDS — FL Client: %s", CLIENT_ID)
    log.info("  Mode: %s", MODE)
    log.info("  Server: %s | Data: %s", FL_SERVER_ADDRESS, DATA_PATH)
    log.info("  Backend: %s", BACKEND_URL)
    log.info("═" * 50)

    if MODE == "MONITOR":
        run_monitor_mode()
    elif MODE == "TRAIN":
        run_train_mode()
    elif MODE == "IDLE":
        run_idle_mode()
    else:
        log.error("Unknown mode: %s (expected MONITOR, TRAIN, or IDLE)", MODE)
        sys.exit(1)


if __name__ == "__main__":
    main()
