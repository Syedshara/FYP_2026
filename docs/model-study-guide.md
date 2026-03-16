# IoT IDS Model Study Guide (Team Version)

This document explains how to run and study the model used in this project:

- CNN-LSTM IDS (federated training)
- CVAE synthetic attack generator
- Key training rounds/epochs
- Layers used for training and HE aggregation
- Python graph metrics workflow

---

## 1) Model Architecture Used for FL Training

Source: `fl_common/model.py`

### CNN-LSTM IDS

- Input shape: `(batch, seq_len=10, num_features=78)`
- Output shape: `(batch, 1)` raw logit (sigmoid -> probability)

Layer stack:

1. `Conv1d(78 -> 64, kernel=3, padding=1)`
2. `ReLU`
3. `LSTM(input_size=64, hidden_size=64, num_layers=1, batch_first=True)`
4. `Linear(64 -> 1)`

Training loss and threshold:

- Loss: `BCEWithLogitsLoss(pos_weight=5.0)`
- Threshold: `0.5`

Parameter count (computed from model object):

- Total params: **48,385**
- `conv1.weight`: 14,976
- `conv1.bias`: 64
- `lstm.weight_ih_l0`: 16,384
- `lstm.weight_hh_l0`: 16,384
- `lstm.bias_ih_l0`: 256
- `lstm.bias_hh_l0`: 256
- `fc.weight`: 64
- `fc.bias`: 1

### Layers Selected for CKKS HE Aggregation

From `SELECTED_LAYERS` in `fl_common/model.py`:

- `lstm.weight_ih_l0`
- `lstm.weight_hh_l0`
- `fc.weight`
- `fc.bias`

---

## 2) Data Pipeline and Feature Setup

Preprocessing script: `scripts/preprocess_cicids2017.py`

- Dataset: CIC-IDS2017 (8 CSV files)
- Feature vector size: **78 features** (`EXPECTED_FEATURES`)
- Sequence window: **10**
- Label for each window: label of last row in that window
- Scaler output: `model/standard_scaler.pkl`

Per-client output files:

- `data/clients/<client_id>/X_seq_chunk_*.npy`
- `data/clients/<client_id>/y_seq_chunk_*.npy`

Default client day split:

- `bank_a`: monday + tuesday
- `bank_b`: wednesday + thursday
- `bank_c`: friday

---

## 3) Epochs, Rounds, and How Training Runs

### FL Start Configuration

API request schema: `backend/app/api/v1/fl.py` -> `FLStartRequest`

Main fields:

- `num_rounds` (default 5 in API)
- `min_clients` (default 1)
- `use_he` (default false in API)
- `local_epochs` (default 5)
- `learning_rate` (default 0.001)
- `max_batches` (default 0 = use all batches)

These are passed into FL server container by:

- `backend/app/services/docker_service.py` -> `start_fl_server(...)`

### FL Round Flow

Server code: `fl_server/server.py`

For each round:

1. Server sends global model + round config to clients.
2. Client runs local training for `local_epochs`.
3. Client returns updated weights and metrics.
4. Server aggregates (FedAvg plain or HE).
5. Server saves checkpoint + history.

Security cadence:

- RECESS detection every 5 rounds
- VSS key refresh every 20 rounds

### Client Local Training Loop

Client code: `fl_client/client.py` -> `local_train(...)`

The client reports progress including:

- epoch / total_epochs
- batches processed
- current loss / current accuracy
- throughput
- ETA

---

## 4) Model Artifacts Produced

Saved by server (`fl_server/server.py`):

- Final model: `model/global_final.pt`
- Round checkpoints: `model/fl_checkpoints/global_round_<n>.pt`
- Training history: `model/fl_training_history.json`

Current workspace contains:

- `model/global_final.pt`
- `model/fl_training_history.json`
- Multiple `model/fl_checkpoints/global_round_*.pt`

---

## 5) Python Graph Metrics (for Study)

New graph script:

- `scripts/plot_training_metrics.py`

Run:

```bash
python scripts/plot_training_metrics.py
```

Generated files (in `docs/assets/`):

- `fl_aggregation_time.png`
- `fl_aggregation_type_distribution.png`
- `fl_round_coverage.png`
- `fl_metrics_summary.json`

Optional graphs (auto-generated only if fields exist in history):

- `fl_global_loss.png`
- `fl_global_accuracy.png`

> Note: Current `fl_training_history.json` mostly contains aggregation timing metadata.
> For richer loss/accuracy charts, ensure those fields are persisted into history or query
> the backend `fl_rounds` table/API.

---

## 6) CVAE Model Used for Synthetic Attack Generation

Architecture source: `fl_common/cvae.py`

### CVAE Design

Encoder:

- `Conv1d(78 -> 64)` + ReLU
- `LSTM(64 -> 128)`
- `Linear(128 -> 256)`
- heads: `mu(256 -> 128)` and `log_var(256 -> 128)`

Decoder:

- `Linear((128 + 15) -> 256)` + ReLU + BatchNorm
- `Linear(256 -> 512)` + ReLU + BatchNorm
- `Linear(512 -> 780)` -> reshape `(10, 78)`

Auxiliary classifier:

- `Linear(128 -> 15)` on latent mu

Parameter count (computed):

- Total CVAE params: **785,243**
- Encoder: 213,184
- Decoder: 570,124
- Aux classifier: 1,935

CVAE training script:

- Local: `scripts/train_cvae.py`
- Kaggle full run: `scripts/kaggle/train_cvae.py`

CVAE output artifacts:

- `model/cvae_decoder.pt`
- `model/cvae_scaler.pkl`
- `model/cvae_class_centroids.pkl`

---

## 7) End-to-End Run Commands (Team)

### A. Setup

```bash
./scripts/linux/setup.sh
```

Login:

- Username: `admin`
- Password: `admin123`

### B. Preprocess Dataset (if needed)

```bash
python scripts/preprocess_cicids2017.py --clients 3 --window 10 --stride 1
```

### C. Start FL Training (example payload)

API: `POST /api/v1/fl/start`

```json
{
  "num_rounds": 25,
  "min_clients": 3,
  "use_he": true,
  "local_epochs": 5,
  "learning_rate": 0.001,
  "max_batches": 0
}
```

### D. Regenerate Graphs and PDF

```bash
python scripts/plot_training_metrics.py
python scripts/generate_model_study_pdf.py
```

Outputs:

- `docs/assets/*.png`
- `docs/model-study-guide.pdf`

---

## 8) Study Checklist for Teammate

1. Understand the `(10, 78)` sequence representation.
2. Understand why selected layers are encrypted in HE aggregation.
3. Track round progression and aggregation time trends.
4. Compare FL global model training vs CVAE synthetic data generation.
5. Verify final artifacts (`global_final.pt`, `cvae_decoder.pt`, graphs, and history).
