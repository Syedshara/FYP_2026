"""
Generate synthetic IDS data for FL testing.

Creates .npy files in data/clients/{bank_a,bank_b,bank_c}/
with the same shape as the real CIC-IDS2017 processed data:
  X: (N, 10, 78)  — sequences of 10 timesteps × 78 features
  y: (N,)          — binary labels (0 = benign, 1 = attack)

Usage:
    python generate_synthetic_data.py
"""

import os
import numpy as np

SEED = 42
NUM_FEATURES = 78
SEQ_LEN = 10
SAMPLES_PER_CLIENT = 2000   # small for fast testing
ATTACK_RATIO = 0.3           # 30 % attacks

CLIENTS = ["bank_a", "bank_b", "bank_c"]
BASE_DIR = os.path.join(os.path.dirname(__file__), "data", "clients")


def generate_client_data(client_name: str, rng: np.random.Generator) -> None:
    """Generate and save synthetic X and y arrays for one client."""
    client_dir = os.path.join(BASE_DIR, client_name)
    os.makedirs(client_dir, exist_ok=True)

    num_attack = int(SAMPLES_PER_CLIENT * ATTACK_RATIO)
    num_benign = SAMPLES_PER_CLIENT - num_attack

    # Benign traffic ≈ low-magnitude random
    x_benign = rng.normal(loc=0.0, scale=0.3, size=(num_benign, SEQ_LEN, NUM_FEATURES)).astype(np.float32)
    y_benign = np.zeros(num_benign, dtype=np.float32)

    # Attack traffic ≈ higher magnitude + different distribution
    x_attack = rng.normal(loc=1.5, scale=1.0, size=(num_attack, SEQ_LEN, NUM_FEATURES)).astype(np.float32)
    y_attack = np.ones(num_attack, dtype=np.float32)

    # Combine & shuffle
    X = np.concatenate([x_benign, x_attack], axis=0)
    y = np.concatenate([y_benign, y_attack], axis=0)

    indices = rng.permutation(len(X))
    X = X[indices]
    y = y[indices]

    np.save(os.path.join(client_dir, "X_seq_chunk_0.npy"), X)
    np.save(os.path.join(client_dir, "y_seq_chunk_0.npy"), y)

    print(f"  {client_name}: X={X.shape}, y={y.shape} (attacks={num_attack})")


def main() -> None:
    rng = np.random.default_rng(SEED)
    print("Generating synthetic FL data …")
    for client in CLIENTS:
        generate_client_data(client, rng)
    print("Done. Data saved under", os.path.abspath(BASE_DIR))


if __name__ == "__main__":
    main()
