# Code Map — Study Reference

Quick-reference for finding implementation code by topic.
Each section lists files in **reading order** — start at the top and follow the flow.

---

## 1. RECESS Defense (Byzantine-Robust Aggregation)

RECESS periodically sends a known **probe gradient** to every client.
Each client must echo back a signed response.
The server compares the echo to the probe and scores each client's trustworthiness.
Clients whose trust score drops below a threshold are downweighted or excluded.

### Reading order

```
fl_common/recess_utils.py          ← math + scoring primitives (start here)
fl_server/server.py                ← orchestration: when/how RECESS fires
fl_client/client.py                ← client-side response to a detection round
backend/app/api/v1/fl.py           ← REST endpoints that persist RECESS results
backend/app/services/fl_service.py ← in-memory trust store + DB persistence
backend/app/models/fl.py           ← ORM: trust_score column
```

### `fl_common/recess_utils.py` — primitives

| Line | Symbol | What it does |
|------|--------|--------------|
| 22–31 | constants | `RECESS_INTERVAL=5`, `DIRECTION_THRESH=0.9510`, `TRUST_DECAY=0.9`, `FLAG_THRESHOLD=0.3` |
| 38 | `flatten_gradient` | Flattens `dict[str, Tensor]` → single 1-D float32 tensor (sorted keys, deterministic) |
| 58 | `construct_test_gradient` | Builds a synthetic probe from the last aggregated delta: adds small Gaussian noise to ~10% of dims, re-normalises, verifies cosine similarity ≥ `DIRECTION_THRESH` |
| 151 | `compute_abnormality_components` | Returns `(abnormality, direction_score, magnitude_score)` — combined = 0.5×cosine-divergence + 0.5×magnitude-ratio |
| 206 | `compute_abnormality` | Backward-compatible wrapper — returns only the scalar abnormality score |
| 230 | `update_trust_score` | Exponential decay: `new = 0.9 × old + 0.1 × (1 − abnormality)` |
| 254 | `is_flagged` | Returns `True` when `trust_score < FLAG_THRESHOLD` (0.3) |

### `fl_server/server.py` — orchestration

| Line | What it does |
|------|--------------|
| 55–61 | Imports from `fl_common.recess_utils` |
| 83 | `RECESS_INTERVAL = 5` module constant |
| 229–235 | `FedAvgHE.__init__` — declares `_last_agg_gradient`, `_current_probe`, `_trust_scores` state fields |
| 291 | `configure_fit` — sets `is_detect = server_round % RECESS_INTERVAL == 0` |
| 310–314 | `configure_fit` — calls `construct_test_gradient`, serialises probe to base64, embeds in `config["recess_probe_b64"]` |
| 383 | `aggregate_fit` — routes detection rounds to `_run_recess_round` |
| 477–676 | `_run_recess_round` — **full RECESS logic**: nonce echo verify → Ed25519 sig check → base64-decode client response → `flatten_gradient(probe)` → `compute_abnormality_components` → `update_trust_score` → POST to backend |
| 572 | `flatten_gradient(self._current_probe)` — flattens server-side probe for comparison |
| 609 | `compute_abnormality_components(test_flat, response_flat)` — per-client score |
| 635 | `update_trust_score(current, abnormality)` |
| 699–714 | `_update_last_agg_gradient` — caches post−pre delta for `SELECTED_LAYERS` after each normal round (feeds the next probe) |
| 880 | `_build_trust_weights` — excludes clients with `trust_score < FLAG_THRESHOLD` from aggregation |

### `fl_client/client.py` — client-side response

| Line | What it does |
|------|--------------|
| 45 | `from fl_common import recess_utils` |
| 441–445 | `_serialise_gradient` — calls `recess_utils.flatten_gradient` → bytes for signing |
| 466–467 | `fit` — if `config["detect"] == "true"` → calls `_fit_recess` |
| 553–606 | `_fit_recess` — computes local−global gradient for `SELECTED_LAYERS`, serialises + signs, returns `recess_response` in metrics |

### Backend — persistence

| File | Line | What it does |
|------|------|--------------|
| `backend/app/api/v1/fl.py` | 708–720 | `TrustScoreComponents`, `DetectionRoundBody` Pydantic schemas |
| `backend/app/api/v1/fl.py` | 745–769 | `POST /detection_round` — receives results, persists, broadcasts WS `CLIENT_TRUST_UPDATE` |
| `backend/app/api/v1/fl.py` | 772–800 | `GET/POST /trust_scores`, `POST /trust_scores/reset` |
| `backend/app/services/fl_service.py` | 426–477 | `update_trust_scores`, `save_trust_scores_to_db`, `load_trust_scores_from_db`, `reset_all_trust_scores` |
| `backend/app/services/fl_service.py` | 480–493 | `record_detection_round` — appends history entry |
| `backend/app/models/fl.py` | 116 | `FLClient.trust_score` ORM column |

---

## 2. Homomorphic Encryption (CKKS / TenSEAL)

Clients train locally and send **plain parameters** back to the server.
The server computes per-client **deltas** (Δ = local − global), **encrypts** them with CKKS,
sums them homomorphically (no decryption during aggregation), then **decrypts** the final aggregate.

### Reading order

```
fl_common/model.py                 ← HE parameters + SELECTED_LAYERS (start here)
fl_common/he_utils.py              ← context creation, encrypt, sum, decrypt
fl_server/server.py                ← _aggregate_he(): full three-phase pipeline
backend/app/config.py              ← HE config mirrored for backend use
backend/app/api/v1/internal.py     ← schemas that carry HE metadata
backend/app/models/fl.py           ← ORM: encrypted column
```

### `fl_common/model.py` — parameters & layer selection

| Line | Symbol | What it does |
|------|--------|--------------|
| 60–65 | `SELECTED_LAYERS` | The 4 layers encrypted by CKKS: `lstm.weight_ih_l0`, `lstm.weight_hh_l0`, `fc.weight`, `fc.bias` |
| 68 | `HE_POLY_MODULUS = 16384` | CKKS polynomial modulus degree |
| 69 | `HE_SCALE_BITS = 40` | Scale = 2^40 |
| 70 | `HE_COEFF_MOD_BITS` | `[60, 40, 40, 40, 40, 60]` coefficient modulus chain |

### `fl_common/he_utils.py` — primitives

| Line | Symbol | What it does |
|------|--------|--------------|
| 18 | `create_ckks_context` | Creates TenSEAL CKKS context (`poly_modulus_degree=16384`, `scale=2**40`, generates Galois keys) |
| 30 | `compute_model_update` | Computes `ΔW = W_local − W_global` for `SELECTED_LAYERS`, clamped to `[-10, 10]` |
| 43 | `encrypt_update` | Encrypts each layer delta as a `ts.CKKSVector`; sanitises NaN/Inf first |
| 63 | `encrypted_sum` | Homomorphic element-wise sum of encrypted updates from N clients (no decryption) |
| 81 | `decrypt_update` | Decrypts aggregated CKKS vectors, reshapes to original tensor shape, divides by `num_clients` |

### `fl_server/server.py` — HE aggregation pipeline

| Line | What it does |
|------|--------------|
| 48–52 | Imports `create_ckks_context`, `encrypted_sum`, `HE_POLY_MODULUS` |
| 71 | `USE_HE` env var — boolean toggle (default `true`) |
| 242 | `FedAvgHE.__init__` — calls `create_ckks_context()`, stores as `self.ckks_ctx` |
| 456 | `aggregate_fit` — dispatches to `_aggregate_he` when `USE_HE=true` |
| 939–1112 | `_aggregate_he` — **full three-phase HE pipeline** (see below) |

#### `_aggregate_he` phase breakdown

| Phase | Lines | What it does |
|-------|-------|--------------|
| Phase 1 — Encrypt | 988–1034 | For each client × selected layer: compute trust-weighted delta → sanitise → `ts.ckks_vector(self.ckks_ctx, scaled)` → collect `cipher_hex` (first 32 bytes) and `cipher_kb` for security log |
| Phase 2 — Aggregate | 1047–1063 | `encrypted_sum(encrypted_deltas)` — homomorphic sum; no plaintexts touched |
| Phase 3 — Decrypt | 1066–1094 | `enc_agg[key].decrypt()` → reshape → add back to global weights; collect `decrypted_preview` (first 5 floats) for security log |
| Fallback | 1076–1081 | On any TenSEAL failure → falls back to `_aggregate_plain` |

**Security events emitted:**

| Event | Line | Payload |
|-------|------|---------|
| `he_encrypt` | 1034 | `num_clients`, `num_layers`, `enc_time_sec`, `total_cipher_kb`, per-layer `delta_norm` + `cipher_hex` |
| `he_aggregate` | 1051 | `num_clients`, `num_layers`, `agg_time_sec`, `he_poly_modulus` |
| `he_decrypt` | 1085 | `num_layers`, `dec_time_sec`, per-layer `delta_agg_norm` + `decrypted_preview` |

### Backend — HE metadata

| File | Line | What it does |
|------|------|--------------|
| `backend/app/config.py` | 49–51 | `HE_SCHEME="ckks"`, `HE_POLY_MODULUS=16384`, `HE_GLOBAL_SCALE=2**40` |
| `backend/app/config.py` | 36 | `MODEL_PATH` → `cnn_lstm_global_with_HE_25rounds_16k.pt` (pre-trained HE model) |
| `backend/app/api/v1/internal.py` | 106 | `FLRoundIn.he_scheme: Optional[str]` — round schema |
| `backend/app/api/v1/internal.py` | 122 | `FLClientMetricIn.encrypted: bool` — per-client metric carries HE flag |
| `backend/app/models/fl.py` | 65 | `FLClientMetric.encrypted: Mapped[bool]` — ORM column |
| `backend/tests/conftest.py` | 45 | `"tenseal"` mocked in `sys.modules` to prevent import errors in unit tests |

### Frontend — HE event display

| File | Line | What it does |
|------|------|--------------|
| `frontend/src/stores/liveStore.ts` | 102–104 | `SecurityEventKind` union: `he_encrypt`, `he_aggregate`, `he_decrypt` |
| `frontend/src/components/canvas/fl/FLTimelinePanel.tsx` | 57–82 | `HEEncryptData`, `HEAggregateData`, `HEDecryptData` TypeScript interfaces |
| `frontend/src/components/canvas/fl/FLTimelinePanel.tsx` | 163–210 | `HEEncryptDetail`, `HEAggregateDetail`, `HEDecryptDetail` — expandable row renderers |

---

## Quick cross-reference

| Concept | Core file | Key function | Called from |
|---------|-----------|--------------|-------------|
| Probe construction | `fl_common/recess_utils.py:58` | `construct_test_gradient` | `fl_server/server.py:310` |
| Abnormality scoring | `fl_common/recess_utils.py:151` | `compute_abnormality_components` | `fl_server/server.py:609` |
| Trust score decay | `fl_common/recess_utils.py:230` | `update_trust_score` | `fl_server/server.py:635` |
| Client exclusion gate | `fl_server/server.py:880` | `_build_trust_weights` | `_aggregate_he`, `_aggregate_plain` |
| CKKS context | `fl_common/he_utils.py:18` | `create_ckks_context` | `fl_server/server.py:242` |
| HE encrypt (inline) | `fl_server/server.py:1005` | `ts.ckks_vector(...)` | inside `_aggregate_he` Phase 1 |
| HE sum | `fl_common/he_utils.py:63` | `encrypted_sum` | `fl_server/server.py:1048` |
| HE decrypt | `fl_server/server.py:1070` | `.decrypt()` | inside `_aggregate_he` Phase 3 |
