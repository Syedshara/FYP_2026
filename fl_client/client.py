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
CLIENT_ID       : str   — e.g. "bank_a"
FL_SERVER_URL   : str   — e.g. "fl_server:8080"
DATA_PATH       : str   — path to client data directory
BACKEND_URL     : str   — e.g. "http://iot_ids_backend:8000"
MODE            : str   — MONITOR | TRAIN | IDLE  (default: IDLE)
MONITOR_INTERVAL: float — seconds between prediction cycles (default 3.0)
ATTACK_RATIO    : float — fraction of simulated traffic that is attacks (default 0.2)
"""

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

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(message)s")
log = logging.getLogger("fl_client")

# ── env config ───────────────────────────────────────────
CLIENT_ID = os.environ.get("CLIENT_ID", "client_0")
FL_SERVER_ADDRESS = os.environ.get("FL_SERVER_URL", "fl_server:8080")
DATA_PATH = os.environ.get("DATA_PATH", "/app/data")
BACKEND_URL = os.environ.get("BACKEND_URL", "http://iot_ids_backend:8000")
MODE = os.environ.get("MODE", "IDLE").upper()

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
def local_train(
    model: CNN_LSTM_IDS,
    dataloader: DataLoader,
    epochs: int,
    lr: float,
    max_batches: int = 50,
    server_round: int = 0,
) -> dict:
    """Train model locally and return metrics. Reports per-epoch progress."""
    model.train()
    optimizer = optim.Adam(model.parameters(), lr=lr)
    total_loss = 0.0
    total_correct = 0
    total_samples = 0
    t0 = time.time()

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

            # Compute batch accuracy
            predicted = (torch.sigmoid(preds) > 0.5).float()
            batch_correct = (predicted == y).sum().item()
            epoch_correct += batch_correct
            total_correct += batch_correct

        # Report epoch progress
        epoch_acc = epoch_correct / max(epoch_samples, 1)
        _report_progress({
            "round": server_round,
            "phase": "training",
            "epoch": epoch + 1,
            "total_epochs": epochs,
            "epoch_loss": epoch_loss / max(epoch_samples, 1),
            "message": f"Epoch {epoch + 1}/{epochs} — loss={epoch_loss / max(epoch_samples, 1):.4f} acc={epoch_acc:.4f}",
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

        def get_parameters(self, config) -> NDArrays:
            return [val.cpu().numpy() for val in self.model.state_dict().values()]

        def set_parameters(self, parameters: NDArrays) -> None:
            keys = list(self.model.state_dict().keys())
            state = OrderedDict({k: torch.tensor(v) for k, v in zip(keys, parameters)})
            self.model.load_state_dict(state, strict=True)

        def fit(self, parameters: NDArrays, config: dict):
            self.set_parameters(parameters)

            server_round = config.get("server_round", 0)
            epochs = int(config.get("local_epochs", DEFAULT_CONFIG["LOCAL_EPOCHS"]))
            lr = float(config.get("lr", DEFAULT_CONFIG["LEARNING_RATE"]))
            max_batches = int(config.get("max_batches", DEFAULT_CONFIG["MAX_BATCHES"]))

            log.info(
                "[%s] Round %s — training %d epochs (lr=%.4f, max_batches=%d)",
                CLIENT_ID, server_round, epochs, lr, max_batches,
            )

            # Report: starting local training
            _report_progress({
                "round": server_round,
                "phase": "training",
                "epoch": 0,
                "total_epochs": epochs,
                "message": f"Starting local training for round {server_round}",
            })

            metrics = local_train(
                self.model, self.dataloader, epochs, lr, max_batches,
                server_round=server_round,
            )

            log.info(
                "[%s] Round %s — loss=%.4f, samples=%d, time=%.1fs",
                CLIENT_ID, server_round, metrics["loss"],
                metrics["num_samples"], metrics.get("training_time_sec", 0),
            )

            # Report: sending weights
            _report_progress({
                "round": server_round,
                "phase": "sending_weights",
                "loss": metrics["loss"],
                "num_samples": metrics["num_samples"],
                "training_time_sec": metrics.get("training_time_sec", 0),
                "message": f"Round {server_round} training complete, sending weights",
            })

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
    fl.client.start_numpy_client(
        server_address=FL_SERVER_ADDRESS,
        client=client,
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
