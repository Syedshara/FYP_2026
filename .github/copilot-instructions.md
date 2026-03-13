# Copilot Instructions

## Project Overview

AI-powered **Intrusion Detection System (IDS) for IoT networks** combining CNN-LSTM deep learning, Federated Learning (Flower framework), and Homomorphic Encryption (CKKS via TenSEAL). Multiple organizations (modelled as "banks") collaboratively train a shared model without sharing raw network traffic data.

## Architecture

Five services communicate as follows:

```
Frontend (React SPA)
    ↕ REST + WebSocket
Backend (FastAPI)
    ↕ PostgreSQL (SQLAlchemy async) + Redis (pub/sub for WS broadcasts)
    ↕ Docker SDK → spawns FL Client containers
    ↕ gRPC (mTLS)
FL Server (Flower orchestrator)
    ↕ gRPC (mTLS) ← gradient updates signed with Ed25519 + CKKS-encrypted
FL Clients (one per "bank": Bank_A, Bank_B, Bank_C)
    → POST predictions back to Backend REST API
```

- **`fl_common/`** is shared Python code imported by both `fl_server/` and `fl_client/` — the CNN-LSTM model definition lives here (`fl_common/model.py`).
- **`attack_engine/`** uses Scapy to generate synthetic attack traffic for testing.
- Backend talks to FL Server via gRPC but also spawns/manages FL Client containers via the Docker SDK — FL orchestration goes through the backend, not directly from the frontend.
- Redis is used exclusively as a WebSocket broadcast channel (not for general caching).
- Each FL client has its own mTLS certificate and Ed25519 signing key pair under `certs/`. Server-side public keys are in `certs/client_keys/`.

## Commands

### Docker (primary dev workflow)

```bash
# Full dev stack (core + FL server + 3 FL clients)
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml down
docker compose -f docker-compose.dev.yml logs -f

# Production stack (no FL services)
docker compose up -d

# Rebuild a single service
docker compose -f docker-compose.dev.yml build backend
docker compose -f docker-compose.dev.yml restart backend

# First-time setup (generates certs, .env, volumes)
./scripts/linux/setup.sh        # Linux/macOS
.\scripts\windows\setup.ps1     # Windows
```

### Backend

```bash
cd backend
pip install -r requirements.txt && pip install -r requirements-ml.txt

# Run tests
pytest                                                    # all tests
pytest tests/test_fl_training.py                          # single file
pytest tests/test_fl_training.py::test_start_training     # single test
pytest -k "training" -v                                   # pattern match
pytest -s                                                 # show stdout

# Database migrations
docker exec iot_ids_backend alembic upgrade head
docker exec iot_ids_backend alembic revision --autogenerate -m "description"

# Dev server (outside Docker)
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev      # Vite dev server with hot-reload (proxies /api and /ws to backend)
npm run build    # TypeScript compile + Vite bundle
npm run lint     # ESLint
npm run preview  # Serve production build locally
```

### FL Components (standalone)

```bash
cd fl_server && python server.py
cd fl_client && MODE=TRAIN python client.py   # IDLE | MONITOR | TRAIN
```

## Key Conventions

### Backend (Python/FastAPI)

- **Fully async stack**: all route handlers and service functions are `async def`. SQLAlchemy sessions use async context managers from `database.py`.
- **Layer separation**: `api/v1/` (endpoints) → `services/` (business logic) → `models/` (ORM) + `schemas/` (Pydantic DTOs). Never import service logic directly into models or schemas.
- **Dependency injection**: DB session and current user are injected via `Depends(get_db)` / `Depends(get_current_user)` — add new dependencies the same way.
- **Config via Pydantic Settings**: all env vars are declared in `backend/app/config.py`. Add new variables there, not hardcoded.
- **Migrations**: always create an Alembic migration when changing SQLAlchemy models; don't modify the DB schema directly.
- Test fixtures are in `backend/tests/conftest.py`; `asyncio_mode=auto` is set in `pytest.ini` so all async tests run without `@pytest.mark.asyncio`.

### Frontend (TypeScript/React)

- **Path alias**: `@/` maps to `src/`. Use `@/types`, `@/stores/authStore`, etc. everywhere.
- **API clients**: one file per resource in `src/api/` (e.g., `auth.ts`, `fl.ts`). All API calls go through the typed client, not raw axios.
- **State management**: Zustand stores in `src/stores/`. Use `persist()` middleware for state that must survive page refresh. Don't use component-level state for anything shared.
- **Event handlers**: prefix with `handle*` (e.g., `handleStart`, `handleDelete`).
- **Component file naming**: PascalCase `.tsx`; hooks/stores/utilities use camelCase `.ts`.
- The Vite dev proxy forwards `/api` and `/ws` to `http://localhost:8000` — no CORS workaround needed in dev.

### FL / Security

- **CKKS context** is created in `fl_common/he_utils.py`. Use `create_ckks_context()` / `encrypted_sum()` rather than instantiating TenSEAL contexts inline.
- **Gradient signing**: every client signs its gradient tensor with Ed25519 before sending; the server verifies using public keys from `certs/client_keys/`. See `fl_common/signing_utils.py`.
- **Byzantine defense (RECESS)**: abnormality detection and trust scoring live in `fl_common/recess_utils.py`; the server calls this before aggregating weights.
- FL client mode is controlled by the `MODE` env var (`IDLE` | `MONITOR` | `TRAIN`).

## Environment Setup

Copy `.env.example` to `.env` before first run. Critical variables:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | async PostgreSQL URL (asyncpg driver) |
| `DATABASE_URL_SYNC` | sync URL for Alembic |
| `JWT_SECRET_KEY` | must be changed in production |
| `MODEL_PATH` / `SCALER_PATH` | paths to `.pt` model and `.pkl` scaler inside container |
| `FL_SERVER_HOST` / `FL_SERVER_PORT` | gRPC FL server address |
| `HE_POLY_MODULUS` / `HE_GLOBAL_SCALE` | CKKS HE parameters — must match across server and all clients |

Certificates are auto-generated by `setup.sh` into `./certs/` (gitignored). Regenerate them if clients fail gRPC handshake.

## GitNexus MCP

This codebase is indexed by GitNexus as **FYP_2026** (1495 symbols, 3273 relationships, 114 execution flows). Use it to navigate complex cross-service relationships:

- Read `gitnexus://repo/FYP_2026/context` for a live index overview.
- If the index seems stale, run `npx gitnexus analyze` first.
- Skill files for architecture, impact analysis, debugging, and refactoring: `.claude/skills/gitnexus/`
