"""
Flower gRPC FL Server with CKKS Homomorphic Encryption.

Implements FedAvg with server-side HE aggregation:
  1. Server sends global model params to clients
  2. Clients train locally, send updated params back
  3. Server computes deltas, encrypts with CKKS, aggregates, decrypts
  4. Updates global model and repeats

Usage:
    python server.py
    ROUNDS=5 MIN_CLIENTS=2 python server.py
"""

import os
import sys
import json
import time
import logging
from collections import OrderedDict
from typing import Dict, List, Optional, Tuple

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

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(message)s")
log = logging.getLogger("fl_server")

# ── env config ───────────────────────────────────────────
ROUNDS = int(os.environ.get("ROUNDS", DEFAULT_CONFIG["ROUNDS"]))
MIN_CLIENTS = int(os.environ.get("MIN_CLIENTS", 2))
MIN_FIT_CLIENTS = int(os.environ.get("MIN_FIT_CLIENTS", MIN_CLIENTS))
SERVER_ADDRESS = os.environ.get("FL_SERVER_ADDRESS", "0.0.0.0:8080")
USE_HE = os.environ.get("USE_HE", "true").lower() in ("true", "1", "yes")
MODEL_DIR = os.environ.get("MODEL_DIR", "/app/models")
BACKEND_URL = os.environ.get("BACKEND_URL", "http://backend:8000")

SEQ_LEN = DEFAULT_CONFIG["SEQUENCE_LENGTH"]
NUM_FEATURES = DEFAULT_CONFIG["NUM_FEATURES"]


# ═══════════════════════════════════════════════════════════
#  Custom FedAvg + HE Strategy
# ═══════════════════════════════════════════════════════════
class FedAvgHE(fl.server.strategy.FedAvg):
    """
    FedAvg strategy with optional CKKS HE aggregation.

    Non-selected layers: plain weighted average (FedAvg).
    Selected layers (LSTM + FC): encrypted delta aggregation via CKKS.
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
        if self.use_he:
            log.info("Creating CKKS context …")
            self.ckks_ctx = create_ckks_context()

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
        config: Dict[str, Scalar] = {
            "server_round": server_round,
            "local_epochs": DEFAULT_CONFIG["LOCAL_EPOCHS"],
            "lr": float(DEFAULT_CONFIG["LEARNING_RATE"]),
            "use_he": self.use_he,
            "batch_size": DEFAULT_CONFIG["BATCH_SIZE"],
            "max_batches": DEFAULT_CONFIG["MAX_BATCHES"],
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

        t0 = time.time()
        log.info("Round %d — aggregating %d clients (HE=%s)", server_round, len(results), self.use_he)

        if self.use_he:
            params, metrics = self._aggregate_he(server_round, results)
        else:
            params, metrics = self._aggregate_plain(server_round, results)

        elapsed = time.time() - t0
        metrics["aggregation_time_sec"] = float(elapsed)
        log.info("Round %d — done in %.2fs", server_round, elapsed)

        self._save_checkpoint(server_round)
        self.round_metrics.append({"round": server_round, **metrics})
        return params, metrics

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

    fl.server.start_server(
        server_address=SERVER_ADDRESS,
        config=fl.server.ServerConfig(num_rounds=ROUNDS),
        strategy=strategy,
    )

    # Save final model
    final_path = os.path.join(MODEL_DIR, "global_final.pt")
    torch.save(global_model.state_dict(), final_path)
    log.info("Final model → %s", final_path)

    history_path = os.path.join(MODEL_DIR, "fl_training_history.json")
    with open(history_path, "w") as f:
        json.dump(strategy.round_metrics, f, indent=2)
    log.info("History → %s", history_path)


if __name__ == "__main__":
    main()
