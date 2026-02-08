"""
Flower FL Client with local CNN-LSTM training.

Each client:
  1. Receives global model parameters from FL server
  2. Trains locally on its partition of the CIC-IDS2017 data
  3. Sends updated parameters back to server
  4. Server performs HE aggregation (transparent to client)

Env vars:
    CLIENT_ID        — e.g. Bank_A
    FL_SERVER_URL    — e.g. fl_server:8080
    DATA_PATH        — path to client data directory
"""

import os
import sys
import logging
from collections import OrderedDict

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import Dataset, DataLoader

import flwr as fl
from flwr.common import NDArrays

# ── shared code ──────────────────────────────────────────
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from fl_common.model import CNN_LSTM_IDS, DEFAULT_CONFIG

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(message)s")
log = logging.getLogger("fl_client")

# ── env config ───────────────────────────────────────────
CLIENT_ID = os.environ.get("CLIENT_ID", "client_0")
FL_SERVER_ADDRESS = os.environ.get("FL_SERVER_URL", "fl_server:8080")
DATA_PATH = os.environ.get("DATA_PATH", "/app/data")

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
SEQ_LEN = DEFAULT_CONFIG["SEQUENCE_LENGTH"]
NUM_FEATURES = DEFAULT_CONFIG["NUM_FEATURES"]
POS_WEIGHT = torch.tensor([DEFAULT_CONFIG["POS_WEIGHT"]], device=DEVICE)
CRITERION = nn.BCEWithLogitsLoss(pos_weight=POS_WEIGHT)


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
) -> dict:
    """Train model locally and return metrics."""
    model.train()
    optimizer = optim.Adam(model.parameters(), lr=lr)
    total_loss = 0.0
    total_samples = 0

    for epoch in range(epochs):
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

            total_loss += loss.item() * x.size(0)
            total_samples += x.size(0)

    avg_loss = total_loss / max(total_samples, 1)
    return {"loss": avg_loss, "num_samples": total_samples}


# ═══════════════════════════════════════════════════════════
#  Flower NumPy Client
# ═══════════════════════════════════════════════════════════
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

        metrics = local_train(self.model, self.dataloader, epochs, lr, max_batches)

        log.info(
            "[%s] Round %s — loss=%.4f, samples=%d",
            CLIENT_ID, server_round, metrics["loss"], metrics["num_samples"],
        )

        return self.get_parameters(config), self.num_samples, metrics

    def evaluate(self, parameters: NDArrays, config: dict):
        self.set_parameters(parameters)
        self.model.eval()

        total_loss = 0.0
        correct = 0
        total = 0

        with torch.no_grad():
            for batch_idx, (x, y) in enumerate(self.dataloader):
                if batch_idx >= 10:  # quick eval
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


# ═══════════════════════════════════════════════════════════
#  Entrypoint
# ═══════════════════════════════════════════════════════════

def main() -> None:
    log.info("═" * 50)
    log.info("  IoT IDS — Flower FL Client: %s", CLIENT_ID)
    log.info("  Server: %s | Data: %s", FL_SERVER_ADDRESS, DATA_PATH)
    log.info("═" * 50)

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

    # Start client
    client = IDSClient(model, dataloader, len(dataset))
    fl.client.start_numpy_client(
        server_address=FL_SERVER_ADDRESS,
        client=client,
    )
    log.info("[%s] Training complete", CLIENT_ID)


if __name__ == "__main__":
    main()
