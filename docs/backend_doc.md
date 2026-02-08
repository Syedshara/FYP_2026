# IoT IDS Platform — Backend Architecture & Implementation Plan

---

## Table of Contents

1. [Current State Assessment](#1-current-state-assessment)
2. [Target Architecture Overview](#2-target-architecture-overview)
3. [Environment & Infrastructure Setup](#3-environment--infrastructure-setup)
4. [Containerisation Strategy](#4-containerisation-strategy)
5. [Data Models (Database Schema)](#5-data-models-database-schema)
6. [API Specification](#6-api-specification)
7. [Federated Learning — Production Setup](#7-federated-learning--production-setup)
8. [Real-Time Pipeline Architecture](#8-real-time-pipeline-architecture)
9. [Device Monitoring Strategy](#9-device-monitoring-strategy)
10. [Security Considerations](#10-security-considerations)
11. [Deployment Options](#11-deployment-options)
12. [Implementation Phases](#12-implementation-phases)
13. [File & Folder Structure](#13-file--folder-structure)

---

## 1. Current State Assessment

### What You Have
| Asset | Description |
|-------|-------------|
| `cnn_lstm_global_with_HE_25rounds_16k.pt` | Trained CNN-LSTM model (binary: Benign vs Attack) |
| `FE_with_HE (2).ipynb` | Notebook with FL training loop, CKKS HE aggregation, edge gateway demo |
| `standard_scaler.pkl` | StandardScaler fitted on CIC-IDS2017 (78 features) |
| Frontend wireframes | Complete UI design for 7 pages |

### What's Missing (This Plan Covers)
- Production FastAPI backend with proper project structure
- PostgreSQL database with full schema
- Containerised FL using Flower framework (replacing bare for-loop)
- Per-device async traffic listeners
- WebSocket real-time streaming
- Attack simulation engine
- Prevention/auto-response engine
- CI/CD and deployment pipeline

---

## 2. Target Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        DEPLOYMENT HOST                              │
│  (Cloud VM / On-Prem Server / Your Laptop for Dev)                 │
│                                                                     │
│  ┌─── Docker Compose ─────────────────────────────────────────────┐ │
│  │                                                                 │ │
│  │  ┌─────────────┐  ┌──────────────┐  ┌───────────────────────┐ │ │
│  │  │  Frontend    │  │  Backend     │  │  FL Server            │ │ │
│  │  │  (React+Vite)│  │  (FastAPI)   │  │  (Flower)             │ │ │
│  │  │  Port: 3000  │  │  Port: 8000  │  │  Port: 8080           │ │ │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬────────────────┘ │ │
│  │         │                 │                  │                   │ │
│  │         │    REST + WS    │    gRPC           │                   │ │
│  │         └────────────────►│◄─────────────────┘                   │ │
│  │                           │                                       │ │
│  │                    ┌──────▼───────┐  ┌──────────────┐            │ │
│  │                    │  PostgreSQL   │  │  Redis        │            │ │
│  │                    │  Port: 5432   │  │  Port: 6379   │            │ │
│  │                    └──────────────┘  └──────────────┘            │ │
│  │                                                                   │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │ │
│  │  │  FL Client A  │  │  FL Client B  │  │  FL Client C  │            │ │
│  │  │  (Container)  │  │  (Container)  │  │  (Container)  │            │ │
│  │  └──────────────┘  └──────────────┘  └──────────────┘            │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  ┌── Monitoring ──────────────────────────────────────────────────────┐ │
│  │  Prometheus (metrics) → Grafana (dashboards) → AlertManager       │ │
│  └───────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

### Technology Decisions

| Component | Technology | Why |
|-----------|-----------|-----|
| Backend Framework | **FastAPI** | Async-native, WebSocket support, auto OpenAPI docs |
| Database | **PostgreSQL 16** | Robust, JSONB for flexible fields, production-grade |
| ORM | **SQLAlchemy 2.0** (async) + **Alembic** | Type-safe models, migration versioning |
| Cache / Pub-Sub | **Redis 7** | WebSocket fan-out, rate limiting, session cache |
| Task Queue | **Celery** + Redis broker | Long-running FL rounds, report generation |
| FL Framework | **Flower (flwr)** | Industry-standard federated learning framework, replaces for-loop |
| Containerisation | **Docker** + **Docker Compose** | Isolate services, reproducible environments |
| Reverse Proxy | **Nginx** or **Traefik** | TLS termination, load balancing |
| Monitoring | **Prometheus** + **Grafana** | Metrics, alerting, dashboards |

---

## 3. Environment & Infrastructure Setup

### 3.1 Development Environment (Your Machine)

```
Prerequisites:
  - Python 3.11+
  - Docker Desktop (Windows/Mac) or Docker Engine (Linux)
  - Docker Compose v2
  - Node.js 20+ (for frontend)
  - Git
  - VS Code with Python, Docker extensions
```

### 3.2 Where to Run — Options Comparison

| Option | Cost | Best For | Pros | Cons |
|--------|------|----------|------|------|
| **Local Machine** | Free | Development, demos | Fast iteration, no latency | Limited resources, no real network isolation |
| **Single Cloud VM** (AWS EC2 / Azure VM / GCP) | ~$20-50/mo | FYP demo, small-scale | Simple, full control | Manual setup, single point of failure |
| **Cloud Container Service** (AWS ECS / Azure Container Apps) | ~$30-80/mo | Production-like | Managed scaling, health checks | More complex, higher cost |
| **University Server** | Free | If available | No cost, decent specs | Limited access, bureaucracy |

**Recommended for FYP**: Start with **local Docker Compose** for development, deploy to a **single cloud VM** (AWS EC2 `t3.medium` or Azure `B2s`) for the demo. This gives you real URLs, proper networking, and looks professional.

### 3.3 Cloud VM Setup (Step-by-Step)

```
1. Provision VM:
   - OS: Ubuntu 22.04 LTS
   - Size: 4 vCPU, 8 GB RAM, 50 GB SSD (for model + DB)
   - Open ports: 22 (SSH), 80 (HTTP), 443 (HTTPS), 3000, 8000

2. Install Docker:
   $ sudo apt update && sudo apt install -y docker.io docker-compose-v2
   $ sudo usermod -aG docker $USER

3. Clone repos:
   $ git clone <your-backend-repo>
   $ git clone <your-frontend-repo>

4. Copy model artifacts:
   $ scp cnn_lstm_global_with_HE_25rounds_16k.pt user@vm:/app/models/
   $ scp standard_scaler.pkl user@vm:/app/models/

5. Run:
   $ docker compose up -d
```

### 3.4 IoT Device Simulation — How to "Check Each Device"

Since you're building an IDS (not deploying to real IoT devices), you have three options for traffic sources:

| Mode | Description | Implementation |
|------|-------------|----------------|
| **Simulated** (default) | Backend generates synthetic flows using your notebook's `benign_flow()`, `ddos_flow()`, etc. | Python generators, no hardware needed |
| **PCAP Replay** | Upload `.pcap` files (from CIC-IDS2017 or captured), backend replays them as if live | `scapy` or `cicflowmeter` to extract features |
| **Live Capture** | Sniff real network traffic on an interface | `scapy` / `pyshark` on the backend host's NIC |

**For your FYP**: Use **Simulated** as primary mode. Add **PCAP Replay** as a bonus. Live capture is complex and requires network admin permissions.

**"Checking each device"** means: each registered device in the DB has its own async task that:
1. Buffers incoming flows (from any source) into a sliding window of 10
2. Runs the CNN-LSTM model on each full window
3. Streams predictions via WebSocket to the frontend
4. Stores results in the database

This is done entirely in software — no physical IoT devices needed.

---

## 4. Containerisation Strategy

### 4.1 Why Containers?

Your current setup: a single Jupyter notebook running everything in one Python process.

**Problem**: In production, you need:
- The backend API to be always running (not a notebook)
- The FL server to be separate from the API (different lifecycle)
- Each FL client to be isolated (simulating different "banks" / "organizations")
- The database to persist data across restarts
- Everything reproducible on any machine

**Solution**: Docker containers. Each service gets its own container with its own dependencies.

### 4.2 Container Architecture

```yaml
# docker-compose.yml structure (not the actual file — just the plan)

services:
  # 1. BACKEND API
  backend:
    build: ./backend
    ports: ["8000:8000"]
    depends_on: [postgres, redis]
    volumes:
      - ./models:/app/models          # Model .pt files
      - ./data:/app/data              # PCAP uploads, exports
    environment:
      - DATABASE_URL=postgresql+asyncpg://user:pass@postgres:5432/iot_ids
      - REDIS_URL=redis://redis:6379/0
      - MODEL_PATH=/app/models/cnn_lstm_global_with_HE_25rounds_16k.pt
      - SCALER_PATH=/app/models/standard_scaler.pkl

  # 2. FRONTEND
  frontend:
    build: ./frontend
    ports: ["3000:80"]
    depends_on: [backend]

  # 3. DATABASE
  postgres:
    image: postgres:16-alpine
    volumes: [pgdata:/var/lib/postgresql/data]
    environment:
      - POSTGRES_DB=iot_ids
      - POSTGRES_USER=iot_admin
      - POSTGRES_PASSWORD=<secure_password>

  # 4. CACHE / PUB-SUB
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  # 5. FL SERVER (Flower)
  fl_server:
    build: ./fl_server
    ports: ["8080:8080"]
    volumes: [./models:/app/models]
    depends_on: [backend]

  # 6. FL CLIENTS (one per simulated organization)
  fl_client_a:
    build: ./fl_client
    environment:
      - CLIENT_ID=Bank_A
      - FL_SERVER_URL=fl_server:8080
      - DATA_PATH=/app/data/bank_a
    volumes: [./data/clients/bank_a:/app/data/bank_a]

  fl_client_b:
    build: ./fl_client
    environment:
      - CLIENT_ID=Bank_B
      - FL_SERVER_URL=fl_server:8080
      - DATA_PATH=/app/data/bank_b
    volumes: [./data/clients/bank_b:/app/data/bank_b]

  fl_client_c:
    build: ./fl_client
    environment:
      - CLIENT_ID=Bank_C
      - FL_SERVER_URL=fl_server:8080
      - DATA_PATH=/app/data/bank_c
    volumes: [./data/clients/bank_c:/app/data/bank_c]

  # 7. TASK QUEUE WORKER
  celery_worker:
    build: ./backend
    command: celery -A app.worker worker --loglevel=info
    depends_on: [redis, postgres]

volumes:
  pgdata:
```

### 4.3 Container Communication

```
Frontend ──HTTP/WS──► Backend API ──SQL──► PostgreSQL
                          │
                          ├──Redis Pub/Sub──► WebSocket clients
                          │
                          ├──gRPC──► Flower FL Server
                          │              ├──gRPC──► FL Client A
                          │              ├──gRPC──► FL Client B
                          │              └──gRPC──► FL Client C
                          │
                          └──Celery task──► Worker (report gen, batch jobs)
```

---

## 5. Data Models (Database Schema)

### 5.1 Entity Relationship Diagram

```
┌──────────────┐     ┌──────────────────┐     ┌───────────────────┐
│   devices    │     │   traffic_logs   │     │   predictions     │
├──────────────┤     ├──────────────────┤     ├───────────────────┤
│ id (PK)      │◄───┤ device_id (FK)   │     │ id (PK)           │
│ name         │     │ id (PK)          │◄───┤ traffic_log_id(FK)│
│ device_type  │     │ timestamp        │     │ device_id (FK)    │
│ ip_address   │     │ features (JSON)  │     │ score             │
│ protocol     │     │ raw_packet (BIN) │     │ label             │
│ port         │     │ source_type      │     │ confidence        │
│ status       │     │ flow_index       │     │ model_version     │
│ traffic_src  │     └──────────────────┘     │ window_start      │
│ description  │                               │ window_end        │
│ last_seen_at │     ┌──────────────────┐     │ feature_importance│
│ created_at   │     │     alerts       │     │ inference_latency │
│ updated_at   │     ├──────────────────┤     │ timestamp         │
└──────────────┘     │ id (PK)          │     └───────────────────┘
       │             │ device_id (FK)   │
       │             │ prediction_id(FK)│     ┌───────────────────┐
       │             │ alert_type       │     │ prevention_rules  │
       │             │ severity         │     ├───────────────────┤
       │             │ message          │     │ id (PK)           │
       │             │ is_acknowledged  │     │ device_id (FK)    │
       │             │ action_taken     │     │ rule_name         │
       │             │ timestamp        │     │ threshold         │
       │             └──────────────────┘     │ action_type       │
       │                                       │ is_enabled        │
       │             ┌──────────────────┐     │ cooldown_seconds  │
       │             │  attack_sessions │     │ created_at        │
       │             ├──────────────────┤     └───────────────────┘
       └────────────►│ id (PK)          │
                     │ device_id (FK)   │     ┌───────────────────┐
                     │ pipeline_config  │     │ prevention_logs   │
                     │ status           │     ├───────────────────┤
                     │ progress_pct     │     │ id (PK)           │
                     │ started_at       │     │ rule_id (FK)      │
                     │ completed_at     │     │ device_id (FK)    │
                     │ results (JSON)   │     │ prediction_id(FK) │
                     │ created_by       │     │ action_executed   │
                     └────────┬─────────┘     │ success           │
                              │               │ details (JSON)    │
                     ┌────────▼─────────┐     │ timestamp         │
                     │ attack_steps     │     └───────────────────┘
                     ├──────────────────┤
                     │ id (PK)          │     ┌───────────────────┐
                     │ session_id (FK)  │     │   fl_rounds       │
                     │ step_order       │     ├───────────────────┤
                     │ attack_type      │     │ id (PK)           │
                     │ duration_sec     │     │ round_number      │
                     │ intensity        │     │ num_clients       │
                     │ variant          │     │ global_loss       │
                     │ adversarial      │     │ global_accuracy   │
                     │ adv_epsilon      │     │ global_f1         │
                     │ status           │     │ aggregation_method│
                     │ detected         │     │ he_scheme         │
                     │ avg_confidence   │     │ he_poly_modulus   │
                     │ detection_time   │     │ duration_seconds  │
                     │ auto_action      │     │ model_checkpoint  │
                     │ started_at       │     │ timestamp         │
                     │ completed_at     │     └────────┬──────────┘
                     └──────────────────┘              │
                                               ┌──────▼──────────┐
                                               │fl_client_metrics│
                                               ├─────────────────┤
                                               │ id (PK)         │
                                               │ round_id (FK)   │
                                               │ client_id       │
                                               │ local_loss      │
                                               │ local_accuracy   │
                                               │ num_samples     │
                                               │ training_time   │
                                               │ encrypted       │
                                               └─────────────────┘

                     ┌──────────────────┐
                     │     users        │
                     ├──────────────────┤
                     │ id (PK)          │
                     │ username         │
                     │ email            │
                     │ hashed_password  │
                     │ role             │
                     │ is_active        │
                     │ created_at       │
                     └──────────────────┘

                     ┌──────────────────┐
                     │system_settings   │
                     ├──────────────────┤
                     │ key (PK)         │
                     │ value (JSON)     │
                     │ updated_at       │
                     │ updated_by (FK)  │
                     └──────────────────┘
```

### 5.2 Detailed Table Definitions

#### `devices`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK, default gen | Unique device identifier |
| `name` | VARCHAR(100) | NOT NULL, UNIQUE | Human-readable name (e.g., "Camera_01") |
| `device_type` | ENUM | NOT NULL | `camera`, `sensor`, `gateway`, `actuator`, `smart_plug`, `custom` |
| `ip_address` | INET | NOT NULL | Device IP (supports IPv4/IPv6) |
| `protocol` | ENUM | NOT NULL | `mqtt`, `coap`, `http`, `tcp`, `udp` |
| `port` | INTEGER | NOT NULL, 1-65535 | Service port |
| `status` | ENUM | NOT NULL, default `offline` | `online`, `offline`, `quarantined`, `under_attack` |
| `traffic_source` | ENUM | NOT NULL, default `simulated` | `live_capture`, `pcap_upload`, `simulated` |
| `description` | TEXT | NULLABLE | Optional notes |
| `last_seen_at` | TIMESTAMPTZ | NULLABLE | Last traffic received |
| `threat_count_today` | INTEGER | default 0 | Counter, reset daily |
| `created_at` | TIMESTAMPTZ | NOT NULL, default now | |
| `updated_at` | TIMESTAMPTZ | NOT NULL, auto-update | |

#### `traffic_logs`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | BIGSERIAL | PK | Auto-increment (high volume) |
| `device_id` | UUID | FK → devices.id, NOT NULL | Source device |
| `timestamp` | TIMESTAMPTZ | NOT NULL, indexed | When the flow was captured |
| `features` | JSONB | NOT NULL | 78-feature vector as JSON array |
| `raw_packet_hash` | VARCHAR(64) | NULLABLE | SHA-256 of raw packet (for dedup) |
| `source_type` | ENUM | NOT NULL | `live`, `pcap`, `simulated`, `attack_sim` |
| `flow_index` | INTEGER | NULLABLE | Index within a PCAP file |
| `metadata` | JSONB | NULLABLE | Extra info (src/dst IP, ports, protocol from packet) |

> **Note**: `features` stores the 78 CIC-IDS2017 features as a JSON array. This is computed by the feature extractor from raw packets or generated synthetically.

#### `predictions`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | BIGSERIAL | PK | |
| `device_id` | UUID | FK → devices.id | |
| `traffic_log_id` | BIGINT | FK → traffic_logs.id, NULLABLE | First flow in window |
| `score` | FLOAT | NOT NULL, 0.0–1.0 | Raw sigmoid output |
| `label` | ENUM | NOT NULL | `benign`, `attack` |
| `confidence` | FLOAT | NOT NULL | `abs(score - 0.5) * 2` normalized |
| `model_version` | VARCHAR(100) | NOT NULL | Model file name / checkpoint ID |
| `window_start_idx` | BIGINT | NULLABLE | First traffic_log.id in window |
| `window_end_idx` | BIGINT | NULLABLE | Last traffic_log.id in window |
| `feature_importance` | JSONB | NULLABLE | Top-10 SHAP values `[{feature, value}]` |
| `inference_latency_ms` | FLOAT | NOT NULL | Time taken for prediction |
| `timestamp` | TIMESTAMPTZ | NOT NULL, default now | |

#### `alerts`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | BIGSERIAL | PK | |
| `device_id` | UUID | FK → devices.id | |
| `prediction_id` | BIGINT | FK → predictions.id | Triggering prediction |
| `alert_type` | ENUM | NOT NULL | `threshold_breach`, `sustained_attack`, `new_attack_type`, `device_quarantined` |
| `severity` | ENUM | NOT NULL | `low`, `medium`, `high`, `critical` |
| `message` | TEXT | NOT NULL | Human-readable description |
| `is_acknowledged` | BOOLEAN | default FALSE | User dismissed it |
| `acknowledged_by` | UUID | FK → users.id, NULLABLE | |
| `action_taken` | VARCHAR(100) | NULLABLE | `ip_blocked`, `rate_limited`, `quarantined`, `none` |
| `timestamp` | TIMESTAMPTZ | NOT NULL, default now | |

#### `attack_sessions`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK | |
| `device_id` | UUID | FK → devices.id | Target device |
| `pipeline_config` | JSONB | NOT NULL | Full pipeline spec (attacks, order, settings) |
| `status` | ENUM | NOT NULL | `pending`, `running`, `paused`, `completed`, `failed` |
| `progress_pct` | FLOAT | default 0 | 0–100 |
| `current_step` | INTEGER | NULLABLE | Which attack step is running |
| `results` | JSONB | NULLABLE | Aggregated results summary |
| `started_at` | TIMESTAMPTZ | NULLABLE | |
| `completed_at` | TIMESTAMPTZ | NULLABLE | |
| `created_by` | UUID | FK → users.id | |
| `created_at` | TIMESTAMPTZ | default now | |

#### `attack_steps`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK | |
| `session_id` | UUID | FK → attack_sessions.id, ON DELETE CASCADE | |
| `step_order` | INTEGER | NOT NULL | 1, 2, 3, ... |
| `attack_type` | ENUM | NOT NULL | `ddos_flood`, `slow_rate`, `port_scan`, `brute_force_ssh`, `brute_force_ftp`, `botnet_beacon`, `data_exfiltration`, `web_xss`, `web_sqli`, `hybrid` |
| `duration_seconds` | INTEGER | NOT NULL, default 30 | |
| `intensity` | FLOAT | NOT NULL, default 0.7 | 0.0–1.0 |
| `variant` | VARCHAR(50) | NULLABLE | e.g., "SYN Flood", "UDP Flood" |
| `adversarial_enabled` | BOOLEAN | default FALSE | Inject FGSM perturbation? |
| `adversarial_epsilon` | FLOAT | NULLABLE | FGSM ε value |
| `status` | ENUM | default `pending` | `pending`, `running`, `done`, `skipped` |
| `detected` | BOOLEAN | NULLABLE | Was the attack detected? |
| `avg_confidence` | FLOAT | NULLABLE | Average prediction score during attack |
| `detection_latency_ms` | FLOAT | NULLABLE | Time from start to first detection |
| `auto_action_taken` | VARCHAR(100) | NULLABLE | What prevention action triggered |
| `started_at` | TIMESTAMPTZ | NULLABLE | |
| `completed_at` | TIMESTAMPTZ | NULLABLE | |

#### `prevention_rules`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK | |
| `device_id` | UUID | FK → devices.id, NULLABLE | NULL = global rule |
| `rule_name` | VARCHAR(100) | NOT NULL | |
| `threshold` | FLOAT | NOT NULL, default 0.5 | Score above this triggers action |
| `action_type` | ENUM | NOT NULL | `block_ip`, `rate_limit`, `quarantine`, `alert_only`, `webhook` |
| `is_enabled` | BOOLEAN | default TRUE | |
| `cooldown_seconds` | INTEGER | default 60 | Min time between triggers |
| `webhook_url` | VARCHAR(500) | NULLABLE | For webhook action type |
| `extra_config` | JSONB | NULLABLE | Action-specific params |
| `created_at` | TIMESTAMPTZ | default now | |
| `updated_at` | TIMESTAMPTZ | auto-update | |

#### `prevention_logs`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | BIGSERIAL | PK | |
| `rule_id` | UUID | FK → prevention_rules.id | Which rule fired |
| `device_id` | UUID | FK → devices.id | |
| `prediction_id` | BIGINT | FK → predictions.id | Triggering prediction |
| `action_executed` | VARCHAR(100) | NOT NULL | What was done |
| `success` | BOOLEAN | NOT NULL | Did the action succeed? |
| `details` | JSONB | NULLABLE | Error messages, IP blocked, etc. |
| `timestamp` | TIMESTAMPTZ | default now | |

#### `fl_rounds`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | SERIAL | PK | |
| `round_number` | INTEGER | NOT NULL, UNIQUE | 1, 2, 3, ... |
| `num_clients` | INTEGER | NOT NULL | Clients participated |
| `global_loss` | FLOAT | NULLABLE | Aggregated loss |
| `global_accuracy` | FLOAT | NULLABLE | |
| `global_f1` | FLOAT | NULLABLE | |
| `global_precision` | FLOAT | NULLABLE | |
| `global_recall` | FLOAT | NULLABLE | |
| `aggregation_method` | VARCHAR(50) | NOT NULL | `fedavg`, `fedavg_he` |
| `he_scheme` | VARCHAR(20) | NULLABLE | `ckks`, `bfv`, `none` |
| `he_poly_modulus` | INTEGER | NULLABLE | e.g., 16384 |
| `duration_seconds` | FLOAT | NULLABLE | Total round time |
| `model_checkpoint_path` | VARCHAR(500) | NULLABLE | Path to .pt file |
| `timestamp` | TIMESTAMPTZ | default now | |

#### `fl_client_metrics`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | SERIAL | PK | |
| `round_id` | INTEGER | FK → fl_rounds.id | |
| `client_id` | VARCHAR(50) | NOT NULL | "Bank_A", "Bank_B", etc. |
| `local_loss` | FLOAT | NOT NULL | |
| `local_accuracy` | FLOAT | NOT NULL | |
| `num_samples` | INTEGER | NOT NULL | Training samples used |
| `training_time_sec` | FLOAT | NOT NULL | |
| `encrypted` | BOOLEAN | NOT NULL | Was update encrypted? |

#### `users`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK | |
| `username` | VARCHAR(50) | NOT NULL, UNIQUE | |
| `email` | VARCHAR(255) | NOT NULL, UNIQUE | |
| `hashed_password` | VARCHAR(255) | NOT NULL | bcrypt hash |
| `role` | ENUM | default `viewer` | `admin`, `operator`, `viewer` |
| `is_active` | BOOLEAN | default TRUE | |
| `created_at` | TIMESTAMPTZ | default now | |

#### `system_settings`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `key` | VARCHAR(100) | PK | e.g., `active_model`, `global_threshold` |
| `value` | JSONB | NOT NULL | Setting value |
| `updated_at` | TIMESTAMPTZ | auto-update | |
| `updated_by` | UUID | FK → users.id, NULLABLE | |

---

## 6. API Specification

### 6.1 Base URL & Auth

```
Base URL:     http://localhost:8000/api/v1
WebSocket:    ws://localhost:8000/ws
Auth:         Bearer JWT (access + refresh tokens)
Content-Type: application/json
```

### 6.2 Authentication Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/auth/register` | Create new user account |
| POST | `/auth/login` | Login → returns JWT access + refresh tokens |
| POST | `/auth/refresh` | Refresh access token |
| GET | `/auth/me` | Get current user profile |

### 6.3 Device Endpoints

| Method | Endpoint | Description | Request Body |
|--------|----------|-------------|-------------|
| GET | `/devices` | List all devices (paginated) | Query: `?page=1&size=10&status=online&search=cam` |
| GET | `/devices/{id}` | Get single device | — |
| POST | `/devices` | Create new device | `{name, device_type, ip_address, protocol, port, traffic_source, description}` |
| PUT | `/devices/{id}` | Update device | Partial update fields |
| DELETE | `/devices/{id}` | Delete device (cascade) | — |
| POST | `/devices/{id}/start` | Start traffic listener for device | — |
| POST | `/devices/{id}/stop` | Stop traffic listener | — |
| GET | `/devices/{id}/status` | Get device live status + buffer fill | — |
| GET | `/devices/{id}/stats` | Get device stats (threats today, last seen, etc.) | — |

**Example — Create Device:**
```json
POST /api/v1/devices
{
  "name": "Camera_01",
  "device_type": "camera",
  "ip_address": "192.168.1.101",
  "protocol": "mqtt",
  "port": 1883,
  "traffic_source": "simulated",
  "description": "Front entrance camera"
}

Response 201:
{
  "id": "a1b2c3d4-...",
  "name": "Camera_01",
  "device_type": "camera",
  "ip_address": "192.168.1.101",
  "protocol": "mqtt",
  "port": 1883,
  "status": "offline",
  "traffic_source": "simulated",
  "description": "Front entrance camera",
  "last_seen_at": null,
  "threat_count_today": 0,
  "created_at": "2026-02-07T10:00:00Z"
}
```

### 6.4 Traffic Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/traffic/{device_id}` | Get traffic logs (paginated, filterable by time range) |
| POST | `/traffic/ingest` | Manually push a traffic flow (78 features) |
| POST | `/traffic/upload-pcap` | Upload .pcap file for a device |
| GET | `/traffic/{device_id}/export` | Export traffic logs as CSV |

### 6.5 Prediction Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/predict` | Submit 10×78 window for inference → returns score, label, XAI |
| GET | `/predictions/{device_id}` | Get prediction history (paginated) |
| GET | `/predictions/{id}/explain` | Get SHAP explanation for a specific prediction |
| GET | `/predictions/stats` | Global prediction stats (total, attack %, benign %) |

**Example — Predict:**
```json
POST /api/v1/predict
{
  "device_id": "a1b2c3d4-...",
  "window": [[0.1, 0.2, ...78 values...], ...10 rows...]
}

Response 200:
{
  "prediction_id": 12345,
  "score": 0.87,
  "label": "attack",
  "confidence": 0.74,
  "inference_latency_ms": 11.3,
  "feature_importance": [
    {"feature": "Fwd Pkt Len Mean", "importance": 0.34},
    {"feature": "Flow Duration", "importance": 0.28},
    {"feature": "Bwd Pkt Len Mean", "importance": 0.19},
    {"feature": "Tot Fwd Pkts", "importance": 0.11},
    {"feature": "Pkt Size Avg", "importance": 0.08}
  ],
  "model_version": "cnn_lstm_global_with_HE_25rounds_16k",
  "timestamp": "2026-02-07T10:14:32Z"
}
```

### 6.6 Alert Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/alerts` | List alerts (paginated, filterable) |
| GET | `/alerts/{id}` | Get alert detail |
| PATCH | `/alerts/{id}/acknowledge` | Acknowledge alert |
| GET | `/alerts/unread-count` | Count of unacknowledged alerts |
| GET | `/alerts/stats` | Alert stats (by type, severity, time) |

### 6.7 Attack Simulation Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/attacks/sessions` | Create new attack pipeline session |
| GET | `/attacks/sessions` | List all sessions |
| GET | `/attacks/sessions/{id}` | Get session detail + step results |
| POST | `/attacks/sessions/{id}/start` | Start running the pipeline |
| POST | `/attacks/sessions/{id}/stop` | Stop/abort pipeline |
| GET | `/attacks/types` | List available attack types with descriptions |
| GET | `/attacks/sessions/{id}/report` | Generate PDF/HTML report |

**Example — Create Attack Session:**
```json
POST /api/v1/attacks/sessions
{
  "device_id": "a1b2c3d4-...",
  "steps": [
    {
      "attack_type": "ddos_flood",
      "duration_seconds": 30,
      "intensity": 0.7,
      "variant": "syn_flood",
      "adversarial_enabled": false
    },
    {
      "attack_type": "port_scan",
      "duration_seconds": 20,
      "intensity": 0.5,
      "variant": null,
      "adversarial_enabled": true,
      "adversarial_epsilon": 0.01
    },
    {
      "attack_type": "brute_force_ssh",
      "duration_seconds": 15,
      "intensity": 0.8,
      "variant": null,
      "adversarial_enabled": false
    }
  ]
}

Response 201:
{
  "id": "sess-xyz-...",
  "device_id": "a1b2c3d4-...",
  "status": "pending",
  "progress_pct": 0,
  "steps": [...],
  "created_at": "2026-02-07T11:00:00Z"
}
```

### 6.8 Prevention Rule Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/prevention/rules` | List all rules |
| POST | `/prevention/rules` | Create rule |
| PUT | `/prevention/rules/{id}` | Update rule |
| DELETE | `/prevention/rules/{id}` | Delete rule |
| POST | `/prevention/rules/{id}/toggle` | Enable/disable |
| GET | `/prevention/logs` | Get prevention action history |

### 6.9 FL Training Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/fl/rounds` | List all FL rounds with metrics |
| GET | `/fl/rounds/{round_number}` | Get round detail + client metrics |
| POST | `/fl/start` | Start a new FL training run (N rounds) |
| POST | `/fl/stop` | Stop current FL training |
| GET | `/fl/status` | Current FL status (running/idle, current round) |
| GET | `/fl/model/current` | Get info about current global model |
| GET | `/fl/model/download` | Download current .pt file |

### 6.10 Dashboard Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/dashboard/stats` | Aggregated stats (threat level, active devices, attacks today, benign rate) |
| GET | `/dashboard/timeline` | Recent anomaly scores for timeline chart |
| GET | `/dashboard/attack-distribution` | Attack type breakdown (for pie chart) |
| GET | `/dashboard/device-health` | All devices with status for health map |

### 6.11 Settings Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/settings` | Get all settings |
| PUT | `/settings/{key}` | Update a setting |
| POST | `/settings/model/upload` | Upload new .pt model file |
| POST | `/settings/test-connection` | Test backend/DB connectivity |

### 6.12 WebSocket Channels

| Channel | Direction | Description |
|---------|-----------|-------------|
| `ws://host:8000/ws/live` | Server → Client | Stream all predictions in real-time |
| `ws://host:8000/ws/device/{id}` | Server → Client | Stream predictions for specific device |
| `ws://host:8000/ws/attacks/{session_id}` | Server → Client | Stream attack pipeline progress + results |
| `ws://host:8000/ws/alerts` | Server → Client | Stream new alerts as they're created |

**WebSocket Message Format:**
```json
{
  "type": "prediction",
  "data": {
    "device_id": "a1b2c3d4-...",
    "device_name": "Camera_01",
    "score": 0.87,
    "label": "attack",
    "confidence": 0.74,
    "timestamp": "2026-02-07T10:14:32Z"
  }
}
```

```json
{
  "type": "attack_step_update",
  "data": {
    "session_id": "sess-xyz-...",
    "step_order": 2,
    "attack_type": "port_scan",
    "status": "running",
    "progress_pct": 45,
    "current_score": 0.72
  }
}
```

---

## 7. Federated Learning — Production Setup

### 7.1 Current State (Notebook For-Loop)

Your current approach in the notebook:
```
for round in range(25):
    for client in [Bank_A, Bank_B, Bank_C]:
        train locally
        encrypt weights with TenSEAL
    aggregate encrypted weights
    decrypt and update global model
```

**Problems with this**:
- All clients run sequentially in one process
- No real network communication
- No fault tolerance (if one fails, everything fails)
- Can't add/remove clients dynamically
- Not representative of a real FL deployment

### 7.2 Production Setup with Flower Framework

**Flower (flwr)** is the industry standard for FL. It handles:
- Server-client communication (gRPC)
- Client selection and scheduling
- Custom aggregation strategies
- Fault tolerance
- Metrics logging

**Architecture:**

```
┌─────────────────────────────────────────────────────────────┐
│                    FL Server Container                       │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Flower Server (flwr.server)                        │   │
│  │                                                     │   │
│  │  Strategy: FedAvg with CKKS HE                     │   │
│  │    - on_fit_config: send round config               │   │
│  │    - aggregate_fit: decrypt → average → re-encrypt  │   │
│  │    - on_evaluate_config: send eval config           │   │
│  │    - aggregate_evaluate: collect metrics             │   │
│  │                                                     │   │
│  │  Callbacks:                                         │   │
│  │    - After each round: save metrics to DB via API   │   │
│  │    - Save checkpoint .pt file                       │   │
│  │    - Notify backend via Redis pub/sub               │   │
│  └─────────────────────────────────────────────────────┘   │
│                        gRPC :8080                           │
└────────────────────────┬────────────────────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          │              │              │
  ┌───────▼───────┐ ┌───▼────────┐ ┌──▼──────────┐
  │ FL Client A    │ │ FL Client B │ │ FL Client C  │
  │ (Container)    │ │ (Container) │ │ (Container)  │
  │                │ │             │ │              │
  │ Data: Bank_A/  │ │ Data:Bank_B/│ │ Data:Bank_C/ │
  │ X_seq chunks   │ │ X_seq chunks│ │ X_seq chunks │
  │                │ │             │ │              │
  │ on_fit():      │ │             │ │              │
  │  load local    │ │  (same)     │ │  (same)      │
  │  data chunks   │ │             │ │              │
  │  train model   │ │             │ │              │
  │  encrypt wts   │ │             │ │              │
  │  return wts    │ │             │ │              │
  └────────────────┘ └─────────────┘ └──────────────┘
```

### 7.3 How to Adapt Your Code

Your notebook's training loop maps to Flower like this:

| Notebook Code | Flower Equivalent |
|---------------|-------------------|
| `for round in range(25)` | `fl.server.start_server(config={"num_rounds": 25})` |
| `for client in clients: train(client)` | Each Flower client's `fit()` method |
| `encrypt_weights(tenseal)` | Done inside each client's `fit()` before returning |
| `aggregate(encrypted_updates)` | Custom `Strategy.aggregate_fit()` |
| `global_model.load_state_dict(avg)` | Server-side in strategy |
| `evaluate(test_loader)` | Each client's `evaluate()` method |

### 7.4 What Changes

| Aspect | Notebook (Current) | Production (Flower) |
|--------|-------------------|---------------------|
| Communication | In-memory | gRPC over network |
| Client isolation | Same process | Separate Docker containers |
| Data access | All data in one Colab | Each client only has its partition |
| Fault tolerance | None | Auto-retry, skip failed clients |
| Scalability | Fixed 3 clients | Add/remove containers |
| Monitoring | Print statements | Metrics API + dashboard |
| Checkpoint | Manual save | Automatic per-round |

---

## 8. Real-Time Pipeline Architecture

### 8.1 Traffic Processing Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                    PER-DEVICE ASYNC PIPELINE                         │
│                                                                      │
│  Traffic Source                                                      │
│  (simulated / pcap / live)                                          │
│         │                                                            │
│         ▼                                                            │
│  ┌─────────────────┐                                                │
│  │ Feature Extractor │  Extract 78 CIC-IDS2017 features             │
│  │ (CICFlowMeter-   │  from raw packets or generate                │
│  │  style or synth)  │  synthetic feature vectors                   │
│  └────────┬──────────┘                                               │
│           │  single flow (1 × 78)                                    │
│           ▼                                                          │
│  ┌─────────────────┐                                                │
│  │ Sliding Window   │  Append to deque(maxlen=10)                   │
│  │ Buffer           │  Wait until buffer has 10 flows               │
│  └────────┬──────────┘                                               │
│           │  full window (10 × 78)                                   │
│           ▼                                                          │
│  ┌─────────────────┐                                                │
│  │ Scaler Transform │  Apply StandardScaler.transform()             │
│  └────────┬──────────┘                                               │
│           │  scaled window (10 × 78)                                 │
│           ▼                                                          │
│  ┌─────────────────┐                                                │
│  │ Model Inference  │  CNN-LSTM forward pass                        │
│  │                  │  torch.sigmoid(model(x)) → score ∈ [0,1]     │
│  └────────┬──────────┘                                               │
│           │  prediction result                                       │
│           ▼                                                          │
│  ┌─────────────────┐     ┌───────────────┐     ┌──────────────┐    │
│  │ Store in DB      │────►│ Check Rules   │────►│ Execute      │    │
│  │ (traffic_logs +  │     │ (prevention   │     │ Prevention   │    │
│  │  predictions)    │     │  rules table) │     │ Action       │    │
│  └────────┬──────────┘     └───────────────┘     └──────────────┘    │
│           │                                                          │
│           ▼                                                          │
│  ┌─────────────────┐                                                │
│  │ Publish to Redis │  channel: predictions:{device_id}             │
│  └────────┬──────────┘                                               │
│           │                                                          │
│           ▼                                                          │
│  ┌─────────────────┐                                                │
│  │ WebSocket Fan-out│  All connected clients receive the prediction │
│  └──────────────────┘                                                │
└──────────────────────────────────────────────────────────────────────┘
```

### 8.2 Attack Simulation Pipeline Flow

```
User clicks "Run Pipeline"
         │
         ▼
┌─────────────────────────────┐
│ POST /attacks/sessions/{id} │
│        /start               │
└────────────┬────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────┐
│  Celery Task: run_attack_pipeline(session_id)            │
│                                                          │
│  for step in session.steps (ordered):                    │
│    │                                                     │
│    ├─ Update step status → "running"                     │
│    ├─ Publish progress via WebSocket                     │
│    │                                                     │
│    ├─ Generate synthetic attack traffic:                 │
│    │   for t in range(duration / interval):              │
│    │     flow = attack_generator(attack_type, intensity) │
│    │     if adversarial: flow = fgsm_perturb(flow, eps)  │
│    │     feed flow into device's sliding window          │
│    │     model predicts → store result                   │
│    │     publish prediction via WebSocket                │
│    │                                                     │
│    ├─ Calculate step metrics:                            │
│    │   detected = any(score > threshold)                 │
│    │   avg_confidence = mean(scores)                     │
│    │   detection_latency = time_to_first_detection       │
│    │                                                     │
│    ├─ Update step in DB with results                     │
│    ├─ Insert brief benign gap between attacks            │
│    └─ Continue to next step                              │
│                                                          │
│  After all steps:                                        │
│    - Update session status → "completed"                 │
│    - Calculate aggregate metrics                         │
│    - Publish final results via WebSocket                 │
└──────────────────────────────────────────────────────────┘
```

---

## 9. Device Monitoring Strategy

### 9.1 How "Devices" Work in This System

**Important clarification**: You are NOT deploying software to actual IoT devices. Instead:

1. **A "device" is a database record** representing a real or hypothetical IoT device
2. **The backend simulates traffic** for that device using synthetic generators
3. **The model analyzes the traffic** as if it were coming from that device
4. **This is standard for IDS research projects** — you demonstrate the detection capability without needing physical hardware

### 9.2 Device Lifecycle

```
User registers device → status: OFFLINE
         │
         ▼
User clicks "Start Monitor" → Backend spawns async task
         │                     status: ONLINE
         ▼
Traffic source generates flows:
  - Simulated: Python generator every 0.5–2.0 seconds
  - PCAP: Replay from file at original timing
  - Live: Sniff network interface (advanced)
         │
         ▼
Flows buffer in sliding window (10 × 78)
         │
         ▼
Model predicts → score > threshold?
  │                    │
  NO                   YES
  │                    │
  ▼                    ▼
status: ONLINE    Create alert
                  Check prevention rules
                  status: UNDER_ATTACK
                       │
                       ▼
                  If auto-quarantine rule:
                  status: QUARANTINED
                  Stop traffic listener
```

### 9.3 Traffic Source Implementations

#### Simulated (Primary — Use This)
```
Generator Functions (from your notebook):
  - benign_flow():     np.random.normal(0.05, 0.05, 78)
  - ddos_flow():       np.random.normal(1.2, 0.8, 78) with x[:6] += 3.5
  - slow_attack_flow():np.random.normal(0.6, 0.3, 78) with x[20:25] += 1.5
  - port_scan_flow():  custom pattern emphasizing scan features
  - brute_force_flow():custom pattern emphasizing auth features
  - botnet_flow():     custom pattern emphasizing C2 features
  - exfiltration_flow(): custom pattern emphasizing data transfer features

Each device's async task calls benign_flow() by default,
switching to attack generators during attack simulation.
```

#### PCAP Replay (Bonus Feature)
```
1. User uploads .pcap file via /traffic/upload-pcap
2. Backend extracts flows using CICFlowMeter or custom extractor
3. Extracts 78 features per flow
4. Replays flows at original timing intervals
5. Each flow enters the same pipeline as simulated flows
```

#### Live Capture (Advanced — Optional)
```
1. Backend uses Scapy to sniff a network interface
2. Groups packets into flows (5-tuple: src_ip, dst_ip, src_port, dst_port, protocol)
3. Extracts 78 CIC-IDS2017 features per flow
4. Enters same pipeline

Requires: root/admin permissions, specific NIC config
Not recommended for FYP demo — adds complexity without academic value
```

---

## 10. Security Considerations

### 10.1 Authentication & Authorization

```
Authentication: JWT (JSON Web Tokens)
  - Access token: short-lived (15 min)
  - Refresh token: long-lived (7 days), stored httpOnly cookie
  - Password hashing: bcrypt (12 rounds)

Authorization: Role-Based Access Control (RBAC)
  - admin:    full access (CRUD devices, rules, settings, FL control)
  - operator: manage devices, run attacks, view everything
  - viewer:   read-only access to dashboards and reports
```

### 10.2 API Security

| Measure | Implementation |
|---------|---------------|
| Rate limiting | Redis-based, 100 req/min per user |
| CORS | Whitelist frontend origin only |
| Input validation | Pydantic models with strict types |
| SQL injection | SQLAlchemy ORM (parameterized queries) |
| File upload | Validate .pcap/.pt file types, size limit 100MB |
| WebSocket auth | JWT token in connection query string |

### 10.3 Data Security

| Measure | Implementation |
|---------|---------------|
| DB credentials | Environment variables, never in code |
| Model files | Read-only volume mount |
| PCAP files | Stored encrypted at rest, auto-deleted after processing |
| HE keys | Never exposed via API, stored in FL server container |

---

## 11. Deployment Options

### 11.1 Development (Local Machine)

```bash
# Start everything locally
docker compose -f docker-compose.dev.yml up -d

# Access:
#   Frontend: http://localhost:3000
#   Backend:  http://localhost:8000
#   API Docs: http://localhost:8000/docs  (Swagger UI)
#   DB:       localhost:5432
```

### 11.2 Production (Cloud VM)

```
Recommended: AWS EC2 or Azure VM

Instance: t3.medium (2 vCPU, 4 GB RAM) — minimum
           t3.large (2 vCPU, 8 GB RAM) — recommended (for model inference)

Storage: 50 GB SSD (gp3)

Setup:
  1. Install Docker + Docker Compose
  2. Set up Nginx as reverse proxy with TLS (Let's Encrypt)
  3. Clone repo, copy model files
  4. Set environment variables
  5. docker compose -f docker-compose.prod.yml up -d

Estimated cost: ~$25-40/month (AWS EC2 t3.medium, on-demand)
```

### 11.3 Docker Compose Configuration Overview

```
docker-compose.dev.yml:
  - Hot-reload enabled for backend + frontend
  - Debug mode
  - Exposed DB port for direct access
  - No TLS

docker-compose.prod.yml:
  - Optimized builds
  - No debug mode
  - Nginx with TLS
  - Health checks
  - Restart policies
  - Resource limits
  - Log rotation
```

---

## 12. Implementation Phases

### Phase 1: Foundation (Week 1–2)
```
 ☐ Set up project structure (see Section 13)
 ☐ Set up Docker Compose with PostgreSQL + Redis
 ☐ Create SQLAlchemy models for all tables
 ☐ Set up Alembic migrations
 ☐ Implement JWT auth (register, login, me)
 ☐ Implement Device CRUD endpoints
 ☐ Load CNN-LSTM model at startup
 ☐ Implement basic /predict endpoint
 ☐ Write unit tests for models + auth
```

### Phase 2: Real-Time Pipeline (Week 3–4)
```
 ☐ Implement traffic generators (simulated flows)
 ☐ Implement per-device async traffic listeners
 ☐ Implement sliding window buffer (10 × 78)
 ☐ Implement StandardScaler transform
 ☐ Implement model inference pipeline
 ☐ Set up Redis pub/sub for predictions
 ☐ Implement WebSocket /ws/live and /ws/device/{id}
 ☐ Store predictions + traffic logs in DB
 ☐ Implement dashboard stats endpoints
 ☐ Implement alerts system (create alerts when score > threshold)
```

### Phase 3: Attack Simulation (Week 5–6)
```
 ☐ Implement all attack traffic generators (7 types)
 ☐ Implement FGSM adversarial perturbation
 ☐ Implement attack session + steps CRUD
 ☐ Implement Celery task for pipeline execution
 ☐ Implement WebSocket streaming for attack progress
 ☐ Implement detection metrics calculation
 ☐ Implement report generation (PDF/HTML)
 ☐ Add XAI (SHAP) for feature importance per prediction
```

### Phase 4: Prevention Engine (Week 7)
```
 ☐ Implement prevention rules CRUD
 ☐ Implement rule evaluation engine (check rules on each prediction)
 ☐ Implement actions: alert_only, rate_limit, quarantine
 ☐ Implement webhook notifications
 ☐ Log all prevention actions
 ☐ Auto-update device status on quarantine
```

### Phase 5: Federated Learning Production (Week 8–9)
```
 ☐ Set up Flower server with custom FedAvg + HE strategy
 ☐ Create Flower client that loads data chunks + trains CNN-LSTM
 ☐ Integrate TenSEAL CKKS encryption in client
 ☐ Set up FL client containers (A, B, C)
 ☐ Implement /fl/* API endpoints
 ☐ Store round metrics in fl_rounds + fl_client_metrics tables
 ☐ Implement FL dashboard data endpoints
 ☐ Test full FL round end-to-end in containers
```

### Phase 6: Polish & Deploy (Week 10)
```
 ☐ Integration testing (backend ↔ frontend)
 ☐ Performance testing (concurrent WebSocket connections)
 ☐ Set up production Docker Compose
 ☐ Deploy to cloud VM
 ☐ Set up Nginx + TLS
 ☐ Write documentation
 ☐ Record demo video
```

---

## 13. File & Folder Structure

```
iot-ids-backend/
│
├── docker-compose.dev.yml
├── docker-compose.prod.yml
├── .env.example
├── .gitignore
├── README.md
│
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── alembic.ini
│   ├── alembic/
│   │   ├── env.py
│   │   └── versions/            # DB migration files
│   │
│   └── app/
│       ├── __init__.py
│       ├── main.py              # FastAPI app factory
│       ├── config.py            # Settings (pydantic-settings)
│       ├── database.py          # Async SQLAlchemy engine + session
│       │
│       ├── models/              # SQLAlchemy ORM models
│       │   ├── __init__.py
│       │   ├── device.py
│       │   ├── traffic.py
│       │   ├── prediction.py
│       │   ├── alert.py
│       │   ├── attack.py
│       │   ├── prevention.py
│       │   ├── fl.py
│       │   ├── user.py
│       │   └── settings.py
│       │
│       ├── schemas/             # Pydantic request/response schemas
│       │   ├── __init__.py
│       │   ├── device.py
│       │   ├── traffic.py
│       │   ├── prediction.py
│       │   ├── alert.py
│       │   ├── attack.py
│       │   ├── prevention.py
│       │   ├── fl.py
│       │   ├── user.py
│       │   └── auth.py
│       │
│       ├── api/                 # FastAPI routers
│       │   ├── __init__.py
│       │   ├── v1/
│       │   │   ├── __init__.py
│       │   │   ├── router.py    # Aggregate all routers
│       │   │   ├── auth.py
│       │   │   ├── devices.py
│       │   │   ├── traffic.py
│       │   │   ├── predictions.py
│       │   │   ├── alerts.py
│       │   │   ├── attacks.py
│       │   │   ├── prevention.py
│       │   │   ├── fl.py
│       │   │   ├── dashboard.py
│       │   │   └── settings.py
│       │   └── websocket.py     # WebSocket handlers
│       │
│       ├── services/            # Business logic layer
│       │   ├── __init__.py
│       │   ├── device_service.py
│       │   ├── traffic_service.py
│       │   ├── prediction_service.py
│       │   ├── alert_service.py
│       │   ├── attack_service.py
│       │   ├── prevention_service.py
│       │   ├── fl_service.py
│       │   └── dashboard_service.py
│       │
│       ├── ml/                  # ML inference + XAI
│       │   ├── __init__.py
│       │   ├── model_loader.py  # Load .pt model + scaler at startup
│       │   ├── inference.py     # Predict function
│       │   ├── feature_extractor.py  # Extract 78 features from packets
│       │   ├── xai.py           # SHAP explanations
│       │   └── adversarial.py   # FGSM / PGD perturbations
│       │
│       ├── traffic/             # Traffic generation + capture
│       │   ├── __init__.py
│       │   ├── generators.py    # Synthetic traffic generators
│       │   ├── pcap_replay.py   # PCAP file replay
│       │   ├── live_capture.py  # Scapy live capture (optional)
│       │   └── pipeline.py      # Per-device async pipeline orchestrator
│       │
│       ├── prevention/          # Auto-response engine
│       │   ├── __init__.py
│       │   ├── rule_engine.py   # Evaluate rules against predictions
│       │   ├── actions.py       # Execute actions (block, quarantine, etc.)
│       │   └── notifications.py # Webhook / email notifications
│       │
│       ├── core/                # Cross-cutting concerns
│       │   ├── __init__.py
│       │   ├── auth.py          # JWT creation, validation
│       │   ├── security.py      # Password hashing, rate limiting
│       │   ├── dependencies.py  # FastAPI dependencies (get_db, get_user)
│       │   ├── exceptions.py    # Custom exception handlers
│       │   └── middleware.py    # CORS, logging middleware
│       │
│       ├── worker.py            # Celery app definition
│       └── tasks/               # Celery tasks
│           ├── __init__.py
│           ├── attack_pipeline.py   # Run attack simulation
│           ├── report_generator.py  # Generate PDF reports
│           └── data_cleanup.py      # Periodic data retention cleanup
│
├── fl_server/
│   ├── Dockerfile
│   ├── requirements.txt
│   └── server.py                # Flower server with HE-FedAvg strategy
│
├── fl_client/
│   ├── Dockerfile
│   ├── requirements.txt
│   └── client.py                # Flower client (train + encrypt)
│
├── models/                      # Model artifacts (volume mounted)
│   ├── cnn_lstm_global_with_HE_25rounds_16k.pt
│   └── standard_scaler.pkl
│
├── data/
│   ├── clients/                 # FL client data partitions
│   │   ├── bank_a/
│   │   ├── bank_b/
│   │   └── bank_c/
│   ├── pcap/                    # Uploaded PCAP files
│   └── exports/                 # Generated CSV exports
│
├── nginx/
│   ├── nginx.conf               # Reverse proxy config
│   └── certs/                   # TLS certificates
│
└── tests/
    ├── conftest.py
    ├── test_auth.py
    ├── test_devices.py
    ├── test_predictions.py
    ├── test_attacks.py
    └── test_fl.py
```

---

## Appendix A: Key Python Packages

```
# backend/requirements.txt

# Core
fastapi==0.115.*
uvicorn[standard]==0.34.*
pydantic==2.10.*
pydantic-settings==2.7.*

# Database
sqlalchemy[asyncio]==2.0.*
asyncpg==0.30.*
alembic==1.14.*

# Cache / Pub-Sub
redis==5.2.*

# Task Queue
celery==5.4.*

# ML / AI
torch==2.5.*
numpy==1.26.*
scikit-learn==1.6.*
shap==0.46.*

# Security
python-jose[cryptography]==3.3.*
passlib[bcrypt]==1.7.*
python-multipart==0.0.*

# Traffic / Network
scapy==2.6.*

# WebSocket
websockets==14.*

# File handling
python-multipart==0.0.*
aiofiles==24.*

# Testing
pytest==8.*
pytest-asyncio==0.24.*
httpx==0.28.*

# Utilities
python-dotenv==1.0.*
structlog==24.*
```

```
# fl_server/requirements.txt & fl_client/requirements.txt

flwr==1.13.*
torch==2.5.*
tenseal==0.3.*
numpy==1.26.*
scikit-learn==1.6.*
```

---

## Appendix B: Environment Variables

```bash
# .env.example

# Database
DATABASE_URL=postgresql+asyncpg://iot_admin:secure_password@postgres:5432/iot_ids
DATABASE_URL_SYNC=postgresql://iot_admin:secure_password@postgres:5432/iot_ids

# Redis
REDIS_URL=redis://redis:6379/0

# JWT
JWT_SECRET_KEY=your-256-bit-secret-key-here
JWT_ALGORITHM=HS256
JWT_ACCESS_TOKEN_EXPIRE_MINUTES=15
JWT_REFRESH_TOKEN_EXPIRE_DAYS=7

# Model
MODEL_PATH=/app/models/cnn_lstm_global_with_HE_25rounds_16k.pt
SCALER_PATH=/app/models/standard_scaler.pkl
DEFAULT_THRESHOLD=0.5
SEQUENCE_LENGTH=10
NUM_FEATURES=78

# FL
FL_SERVER_HOST=fl_server
FL_SERVER_PORT=8080
FL_NUM_ROUNDS=25
FL_MIN_CLIENTS=3

# HE
HE_SCHEME=ckks
HE_POLY_MODULUS=16384
HE_COEFF_MOD_SIZES=[60,40,40,40,40,60]
HE_GLOBAL_SCALE=2**40

# App
APP_NAME=IoT IDS Platform
APP_VERSION=1.0.0
DEBUG=false
LOG_LEVEL=info
CORS_ORIGINS=["http://localhost:3000"]

# Celery
CELERY_BROKER_URL=redis://redis:6379/1
CELERY_RESULT_BACKEND=redis://redis:6379/2
```

---

## Appendix C: Software You May Need

| Software | Purpose | Install |
|----------|---------|---------|
| **Docker Desktop** | Run containers | https://docker.com |
| **Postman** / **Bruno** | Test APIs | https://postman.com or https://usebruno.com |
| **pgAdmin** or **DBeaver** | Browse database | https://dbeaver.io |
| **draw.io** (VS Code ext.) | View .drawio files | VS Code marketplace |
| **Redis Insight** | Browse Redis cache | https://redis.io/insight |
| **Wireshark** | Inspect PCAP files | https://wireshark.org |

---

## Appendix D: Quick Reference — What Replaces What

| Notebook Element | Production Replacement |
|-----------------|----------------------|
| `for round in range(25)` | Flower FL server rounds |
| `model = CNN_LSTM_IDS(...)` in cell | `model_loader.py` loads at startup |
| `edge_gateway()` async function | `pipeline.py` per-device task |
| `window = deque(maxlen=10)` | Same, but managed per-device in `pipeline.py` |
| `benign_flow()` / `ddos_flow()` | `generators.py` with all 7 attack types |
| `torch.sigmoid(model(x))` | `inference.py` with batching + timing |
| `print(f"Prob={prob:.4f}")` | WebSocket push + DB storage |
| Colab notebook | Docker containers |
| Google Drive file storage | PostgreSQL + volume-mounted model files |
| Manual `pd.read_csv()` | Alembic-managed DB tables |