# Prediction Flow — Complete Reference

IoT IDS prediction pipeline: data sources, inference logic, API endpoints, database persistence, and WebSocket broadcast. Covers all three prediction paths in the system.

---

## 1. Architecture Overview

Three independent paths produce predictions. All three ultimately write to the same `predictions` table and broadcast via WebSocket.

```
┌─────────────────────────────────────────────────────────────────────┐
│  PATH A — Direct User Inference (authenticated REST)                │
│                                                                     │
│  Client → POST /api/v1/predictions/predict                         │
│         → prediction_service.run_inference()                        │
│         → prediction_service.save_prediction() → DB                │
│         → returns PredictResponse (no WS broadcast)                │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  PATH B — FL Client MONITOR Mode (internal Docker network)          │
│                                                                     │
│  FL Client (monitor.py)                                             │
│    → ReplaySimulator / SyntheticGenerator / CVAEGenerator           │
│         → (10, 78) window                                           │
│    → run_local_inference() [local CNN-LSTM inside FL container]     │
│    → POST /api/v1/internal/predictions                              │
│         → DB insert + WS broadcast + device status update          │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  PATH C — Real-time Packet Capture Pipeline                         │
│                                                                     │
│  capture_service.capture_packets() [tcpdump + pcap parsing]         │
│    → FlowTable → FlowRecord.to_feature_vector() → (78,) array      │
│    → InferenceWindow.add_features() → (10, 78) window              │
│    → inference_service.run_inference()                              │
│    → broadcast_fn() → WS only (no DB save in this path)            │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Model Architecture

**Class:** `CNN_LSTM_IDS`  
**Defined in two places:**
- `fl_common/model.py` — canonical definition, used by FL server/clients
- `backend/app/services/prediction_service.py:36-51` — local copy to avoid fl_common dependency

**Architecture (lines 36-51, prediction_service.py):**
```
Input:  (batch, seq_len=10, num_features=78)
  → permute to (batch, 78, seq_len=10)         [for Conv1d channels-first]
  → Conv1d(in=78, out=64, kernel=3, padding=1)
  → ReLU
  → permute back to (batch, seq_len=10, 64)
  → LSTM(input=64, hidden=64, num_layers=1, batch_first=True)
  → take final hidden state h_n[-1]: (batch, 64)
  → Linear(64 → 1)
Output: raw logit (apply sigmoid for probability)
```

**Key constants (same in all locations):**
| Constant | Value | Location |
|---|---|---|
| `SEQ_LEN` | 10 | prediction_service.py:31, inference_service.py via settings |
| `NUM_FEATURES` | 78 | prediction_service.py:32, inference_service.py via settings |
| `THRESHOLD` | 0.5 | prediction_service.py:33, monitor.py:74 via DEFAULT_CONFIG |

**CKKS-encrypted layers** (FL training only, not inference):  
`lstm.weight_ih_l0`, `lstm.weight_hh_l0`, `fc.weight`, `fc.bias` — defined in `fl_common/model.py:SELECTED_LAYERS`

---

## 3. Model Checkpoints

**Search order** (prediction_service.py:56-60):
1. `/app/models/fl_checkpoints/global_final.pt`
2. `/app/models/global_final.pt`
3. `/app/models/cnn_lstm_global_with_HE_25rounds_16k.pt`

**Search order** (monitor.py:81-91 `_find_model()`):
1. `/app/models/global_final.pt`
2. `/app/models/cnn_lstm_global_with_HE_25rounds_16k.pt`
3. Any `.pt` file found in `MODEL_DIR`

**Scaler:** `/app/models/standard_scaler.pkl`  
- Loaded in `inference_service.py:100-110` (Path C only)
- Not used in `prediction_service.py` (Path A) or `monitor.py` (Path B — replay data is pre-scaled)

---

## 4. Feature Format

- **Shape:** `(78,)` per flow, stacked into `(10, 78)` windows
- **Index 77:** label placeholder — set to `0` by capture_service; not used by model
- **78 features** mirror CIC-IDS2017 dataset columns:
  - Flow duration, packet counts (fwd/bwd), total payload lengths
  - Packet length statistics (min/max/mean/std)
  - Inter-arrival times (IAT) fwd/bwd mean/max/min/std
  - TCP flags (SYN/ACK/FIN/RST/URG/PSH counts)
  - Window sizes (fwd/bwd)
  - Active/idle period statistics

---

## 5. Path A — Direct User Inference

### API Endpoint: Single Prediction
```
POST /api/v1/predictions/predict
Auth: JWT required (Depends(get_current_user))
```

**File:** `backend/app/api/v1/predictions.py`

| Step | Code location | What happens |
|---|---|---|
| Receive request | Line 106-111 | Deserialize `PredictRequest` (device_id + 10×78 features) |
| Run inference | Line 117 | `prediction_service.run_inference(body.features)` |
| Save to DB | Lines 124-131 | `prediction_service.save_prediction(db, ...)` |
| Return response | Lines 132-142 | `PredictResponse` with result + saved flag + prediction_id |

**Request schema (lines 27-37):**
```json
{
  "device_id": "uuid",
  "features": [[f0, f1, ..., f77], ...],  // 10 rows × 78 floats
  "window_start_idx": null,               // optional
  "window_end_idx": null                  // optional
}
```

**Response schema (lines 59-63):**
```json
{
  "prediction": {
    "score": 0.873,
    "label": "attack",
    "confidence": 0.873,
    "inference_latency_ms": 1.2,
    "model_version": "cnn_lstm_global_with_HE_25rounds_16k"
  },
  "saved": true,
  "prediction_id": 42
}
```

### API Endpoint: Batch Prediction
```
POST /api/v1/predictions/predict/batch
Auth: JWT required
```

**File:** `backend/app/api/v1/predictions.py:145-175`

- Body: `{ "device_id": "uuid", "sequences": [[[...], ...], ...] }` (1–256 sequences, each 10×78)
- Calls `prediction_service.run_batch_inference(body.sequences)` (line 155)
- Saves all results to DB (lines 163-169)
- Returns array of prediction results

### Inference Logic (Path A)
**File:** `backend/app/services/prediction_service.py`

| Function | Lines | Description |
|---|---|---|
| `load_model()` | 71-97 | Load weights from first available checkpoint path |
| `_find_model_path()` | 63-68 | Search MODEL_SEARCH_PATHS list |
| `get_model_info()` | 100-110 | Return loaded model metadata |
| `run_inference(features)` | 115-156 | Single sequence inference |
| `run_batch_inference(batch)` | 159-204 | Batched inference |
| `save_prediction(db, ...)` | 209-230 | Async DB insert via SQLAlchemy |
| `get_predictions_for_device()` | 233-245 | Query by device_id, ordered by timestamp desc |
| `get_prediction_summary()` | 248-273 | Aggregate counts + averages |

**`run_inference` detail (lines 115-156):**
```
features (list[list[float]], shape 10×78)
  → np.array → assert shape == (10, 78)
  → torch.from_numpy().unsqueeze(0)  → (1, 10, 78)
  → model(tensor).squeeze()          → raw logit
  → sigmoid(logit)                   → prob (0.0–1.0)
  → label = "attack" if prob >= 0.5 else "benign"
  → confidence = prob if attack else 1.0 - prob
  → return {score, label, confidence, inference_latency_ms, model_version}
```

---

## 6. Path B — FL Client MONITOR Mode

### Trigger

**File:** `fl_client/client.py`
- FL client starts in `MODE=MONITOR` env var
- `run_monitor_mode()` called at line 701-708
- Spawns background thread; `monitor.py` is the main logic

### Data Sources (monitor.py:264-288)

Priority order:

| Condition | Source | Class |
|---|---|---|
| `USE_CVAE=true` | CVAE generative model | `CVAEGenerator` |
| `SCENARIO=<name>` (not `client_data`) | Synthetic profiles | `SyntheticGenerator` |
| Default | CIC-IDS2017 `.npy` replay | `ReplaySimulator` |

### Main Loop: `monitor_loop()` (lines 254-416)

```
monitor_loop()
  │
  ├── load_model()                          # lines 95-109: load CNN-LSTM from checkpoint
  ├── Choose simulator (CVAE / Synthetic / Replay)
  │
  ├── async with httpx.AsyncClient:
  │     ├── fetch_client_info()             # GET /internal/client/by-client-id/{id}
  │     ├── auto_register_client()          # POST /internal/client/register (if 404)
  │     ├── fetch_devices()                 # GET /internal/client/{db_id}/devices
  │     │
  │     └── while not stop_event:
  │           ├── (every 30 cycles) fetch_devices() refresh
  │           ├── for each device:
  │           │     ├── simulator.get_next_window() → (window, true_label, attack_frac)
  │           │     ├── run_local_inference(model, window) → result dict
  │           │     └── post_prediction(http, device_id, client_db_id, result)
  │           └── asyncio.sleep(effective_interval)
  │
  └── log summary (cycles, replayed count, elapsed)
```

### Local Inference (lines 114-132)

**File:** `fl_client/monitor.py:114-132`

```python
def run_local_inference(model, window):
    # window shape: (10, 78) numpy float32
    tensor = torch.from_numpy(window).unsqueeze(0)  # (1, 10, 78)
    with torch.no_grad():
        logit = model(tensor).squeeze()
        prob  = torch.sigmoid(logit).item()
    label      = "attack" if prob >= THRESHOLD else "benign"
    confidence = prob if label == "attack" else 1.0 - prob
    return {score, label, confidence, inference_latency_ms}
```

Note: no scaler applied here — replay `.npy` data is pre-normalized.

### Posting Predictions (lines 223-249)

**File:** `fl_client/monitor.py:223-249`

```python
async def post_prediction(http, device_id, client_db_id, result):
    payload = {
        "device_id": device_id,
        "client_id": client_db_id,
        "score": result["score"],
        "label": result["label"],
        "confidence": result["confidence"],
        "inference_latency_ms": result["inference_latency_ms"],
        "model_version": "local",
        "attack_type": SCENARIO or None,
    }
    await http.post(f"{BACKEND_URL}/api/v1/internal/predictions", json=payload)
```

### Internal Prediction Endpoint (backend receives Path B)

```
POST /api/v1/internal/predictions
Auth: NONE — Docker network isolation only
```

**File:** `backend/app/api/v1/internal.py:220-293`

| Step | Lines | What happens |
|---|---|---|
| Deserialize body | 220-224 | `InternalPredictionCreate` Pydantic model |
| DB insert | 231-243 | Create `Prediction` ORM object, commit |
| Look up device name + client string id | 248-261 | JOIN devices + fl_clients |
| WS broadcast | 263-277 | `ws_manager.broadcast(WSMessageType.PREDICTION, {...})` |
| Update device status | 280-291 | `"under_attack"` if label=="attack" AND confidence>0.7, else `"online"` |
| Broadcast device status | 284-289 | `ws_manager.broadcast(WSMessageType.DEVICE_STATUS, {...})` |
| Return | 293 | `InternalPredictionOut(id=pred.id)` |

**WebSocket payload (lines 264-277):**
```json
{
  "id": 42,
  "device_id": "uuid",
  "device_name": "Bank A Sensor 1",
  "client_string_id": "bank_a",
  "client_id": 1,
  "score": 0.873,
  "label": "attack",
  "confidence": 0.873,
  "attack_type": "ddos_attack",
  "inference_latency_ms": 1.2,
  "model_version": "local",
  "timestamp": "2026-03-16T10:00:00Z"
}
```

---

## 7. Path C — Real-time Packet Capture Pipeline

### Entry Point

**File:** `backend/app/services/inference_service.py:279-369`

`run_capture_inference_pipeline(stop_event, run_id, attack_id, broadcast_fn)`

Called when an attack simulation starts (from `pipeline_service.py` or `attack_service.py`).

### Packet Capture and Feature Extraction

**File:** `backend/app/services/capture_service.py`

```
capture_packets(stop_event)         # async generator, yields batches of (78,) arrays
  │
  ├── tcpdump subprocess (all interfaces, libpcap format)
  ├── parse_ip_packet() — extract 5-tuple + payload
  └── FlowTable.update(packet) — per-flow state machine
        └── FlowRecord.to_feature_vector() — export (78,) array on flow timeout
              (IDLE_TIMEOUT_SEC=30s or FLOW_TIMEOUT_SEC=120s)
```

**FlowRecord exports:**
- Flow duration, forward/backward packet counts and byte totals
- Packet length min/max/mean/std
- IAT (inter-arrival time) fwd/bwd mean/max/min/std
- TCP flag counts (SYN, ACK, FIN, RST, URG, PSH)
- Window sizes
- Active/idle period stats
- Index 77 set to `0` (label placeholder)

### Inference Window (lines 123-166)

**File:** `backend/app/services/inference_service.py:123-166`

```python
class InferenceWindow:
    def __init__(self, seq_len=10, num_features=78):
        self._buffer = deque(maxlen=seq_len)

    def add_features(self, features: np.ndarray) -> np.ndarray | None:
        self._buffer.append(features.copy())
        if len(self._buffer) >= self.seq_len:
            return np.array(list(self._buffer), dtype=np.float32)  # (10, 78)
        return None  # buffer not full yet
```

Sliding window: each new feature vector evicts the oldest from the deque. Once 10 samples accumulated, every new sample produces one prediction.

### Path C Inference (lines 169-222)

**File:** `backend/app/services/inference_service.py:169-222`

Adds StandardScaler normalization (unlike Path A/B):
```
window (10, 78)
  → _scaler.transform(window.reshape(-1, 78)).reshape(10, 78)  # if scaler loaded
  → np.nan_to_num(window)
  → torch.from_numpy(window).unsqueeze(0)  → (1, 10, 78)
  → model forward pass → sigmoid → label/confidence
```

### Pipeline Loop (lines 318-352)

```python
async for feature_batch in capture_packets(stop_event):
    for features in feature_batch:
        window = inference_window.add_features(features)
        if window is None:
            continue
        result = run_inference(window)
        await broadcast_fn({
            "type": "prediction",
            "data": {"run_id": run_id, "attack_id": attack_id,
                     "source": "capture_pipeline", **result},
            "timestamp": time.time(),
        })
```

Note: Path C does **not** save predictions to the database. It broadcasts only via WebSocket.

---

## 8. Database Schema

**File:** `backend/app/models/prediction.py`  
**Table:** `predictions`

| Column | Type | Notes |
|---|---|---|
| `id` | BigInteger PK autoincrement | |
| `device_id` | UUID FK → devices.id CASCADE | indexed |
| `client_id` | Integer FK → fl_clients.id SET NULL | nullable, indexed |
| `traffic_log_id` | BigInteger | nullable, unused in current code |
| `score` | Float | raw sigmoid probability 0.0–1.0 |
| `label` | Enum("benign", "attack") | |
| `confidence` | Float | deviation from 0.5 threshold |
| `attack_type` | String(50) | nullable; scenario name if from MONITOR mode |
| `model_version` | String(100) | checkpoint stem filename |
| `window_start_idx` | BigInteger | nullable; set in Path A only |
| `window_end_idx` | BigInteger | nullable; set in Path A only |
| `feature_importance` | JSON | nullable; not currently populated |
| `inference_latency_ms` | Float | end-to-end inference time |
| `timestamp` | DateTime(timezone) | default: `datetime.now(timezone.utc)` |

---

## 9. Query Endpoints (Path A)

All require JWT auth.

| Method | Path | Handler | Service function | Description |
|---|---|---|---|---|
| GET | `/api/v1/predictions/model` | `model_info()` line 178 | `get_model_info()` | Loaded model metadata |
| GET | `/api/v1/predictions/summary` | `prediction_summary()` line 187 | `get_prediction_summary()` | Aggregate stats |
| GET | `/api/v1/predictions/device/{device_id}` | `device_predictions()` line 197 | `get_predictions_for_device()` | Per-device history (default limit 100) |

**Summary response:**
```json
{
  "total_predictions": 1500,
  "attack_count": 430,
  "benign_count": 1070,
  "attack_rate": 0.2867,
  "avg_confidence": 0.8124,
  "avg_latency_ms": 1.34
}
```

---

## 10. WebSocket Broadcast

**Channel:** `/ws?token=<JWT>`  
**Manager:** `ws_manager` (Redis pub/sub backend for multi-process broadcast)

Prediction-related message types:

| `WSMessageType` | Trigger | Producer |
|---|---|---|
| `PREDICTION` | New prediction from FL client | `internal.py:264` |
| `DEVICE_STATUS` | Device status changed after prediction | `internal.py:284` |
| `prediction` (dict key) | Capture pipeline prediction | `inference_service.py:343` |

Path A (direct predict) does **not** broadcast via WebSocket — it returns synchronously to the caller.

---

## 11. Model Pre-loading at Startup

**File:** `backend/app/main.py:49-57`

On app startup, `inference_service.ensure_model_loaded()` is called so the first inference request has no cold-start latency.

---

## 12. Env Var Reference (FL Client Monitor)

| Variable | Default | Effect |
|---|---|---|
| `CLIENT_ID` | `client_0` | Identifies this FL client to the backend |
| `BACKEND_URL` | `http://iot_ids_backend:8000` | Backend base URL |
| `MONITOR_INTERVAL` | `1.0` | Seconds between prediction cycles |
| `MODEL_DIR` | `/app/models` | Where to search for `.pt` checkpoints |
| `SCENARIO` | `""` | Scenario name; empty = replay client data |
| `REPLAY_SPEED` | `1.0` | Speed multiplier (divides MONITOR_INTERVAL) |
| `REPLAY_LOOP` | `true` | Loop replay when exhausted |
| `REPLAY_SHUFFLE` | `true` | Shuffle window order |
| `SCENARIO_DIR` | `/app/scenarios` | Base path for scenario packs |
| `DATA_PATH` | `/app/data` | Client training `.npy` data |
| `MAX_DURATION` | `0` | Max run seconds (0 = unlimited) |
| `USE_CVAE` | `false` | Use CVAE generator instead of replay |
| `ATTACK_CLASS_ID` | `0` | CVAE attack class |
| `ATTACK_RATIO` | `0.7` | CVAE attack-to-benign ratio |
| `DEVICE_ID` | `""` | Restrict monitoring to single device UUID |

---

## 13. File Index

| File | Lines | Role |
|---|---|---|
| `fl_common/model.py` | 85 | CNN_LSTM_IDS canonical definition; SELECTED_LAYERS for CKKS |
| `backend/app/services/prediction_service.py` | 273 | Path A inference + DB ops; local CNN_LSTM_IDS copy |
| `backend/app/services/inference_service.py` | 369 | Path C inference; InferenceWindow; run_capture_inference_pipeline |
| `backend/app/services/capture_service.py` | 674 | Packet capture; FlowTable; 78-feature extraction |
| `backend/app/api/v1/predictions.py` | 232 | Path A REST endpoints (predict, batch, model, summary, device history) |
| `backend/app/api/v1/internal.py` | 525 | Path B receptor (POST /predictions at line 220); FL client registration |
| `backend/app/models/prediction.py` | 53 | Prediction ORM model (predictions table) |
| `fl_client/monitor.py` | 421 | Path B logic: load_model, run_local_inference, post_prediction, monitor_loop |
| `fl_client/client.py` | 765 | FL client entry point; MONITOR/TRAIN/IDLE mode dispatch |
| `fl_client/replay_simulator.py` | — | ReplaySimulator: load .npy, return (10,78) windows |
| `fl_client/synthetic_generator.py` | — | SyntheticGenerator: scenario-based windows |
| `fl_client/cvae_generator.py` | — | CVAEGenerator: CVAE-sampled windows |
| `backend/app/config.py` | — | MODEL_PATH, SCALER_PATH, DEFAULT_THRESHOLD, SEQUENCE_LENGTH, NUM_FEATURES |
| `backend/app/main.py` | — | App factory; calls ensure_model_loaded() on startup |
