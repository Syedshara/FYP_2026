# AGENTS.md — FYP_2026 Coding Agent Instructions

## Project Overview

AI-powered **Intrusion Detection System for IoT networks** combining CNN-LSTM deep learning,
Federated Learning (Flower 1.13), and Homomorphic Encryption (CKKS via TenSEAL). Multiple
organisations ("banks") collaboratively train a shared model without sharing raw traffic data.

**Stack:** FastAPI + SQLAlchemy async + PostgreSQL + Redis | React 19 + Vite 7 + TypeScript 5.9
+ Tailwind v4 | Flower gRPC (mTLS) + TenSEAL CKKS + Ed25519 gradient signing

## Build / Lint / Test Commands

### Backend (Python / FastAPI)
```bash
cd backend
pip install -r requirements.txt -r requirements-ml.txt

# Run ALL tests
pytest

# Run a single test file
pytest tests/test_fl_training.py

# Run a single test by fully-qualified name
pytest tests/test_fl_training.py::TestStartTraining::test_start_training

# Pattern match across files
pytest -k "training" -v

# Show stdout; run only marked tests
pytest -s
pytest -m integration
pytest -m websocket

# Dev server (outside Docker)
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Database migrations
docker exec iot_ids_backend alembic upgrade head
docker exec iot_ids_backend alembic revision --autogenerate -m "description"
```

### Frontend (TypeScript / React)
```bash
cd frontend
npm install
npm run dev      # Vite dev server + hot-reload (proxies /api, /ws → backend:8000)
npm run build    # tsc -b && vite build
npm run lint     # ESLint (flat config, no Prettier)
npm run preview  # Serve production build locally
```
No frontend test runner is configured (no vitest/jest).

### Docker (primary dev workflow)
```bash
# Full dev stack (core + FL)
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml down
docker compose -f docker-compose.dev.yml logs -f

# Rebuild / restart a single service
docker compose -f docker-compose.dev.yml build backend
docker compose -f docker-compose.dev.yml restart backend

# First-time setup (certs, .env, DB init)
./scripts/linux/setup.sh
```

## Code Style — Python

- **Module docstring** on every `.py` file — always first line.
- **Fully async**: all FastAPI route handlers and service functions are `async def`. Use
  `async with` sessions from `database.py`. Never call blocking I/O in a route handler.
- **Layer separation** — no cross-layer imports in the wrong direction:
  `api/v1/` → `services/` → `models/` + `schemas/`. Never import service logic into models.
- **Type annotations** on every function signature. Use `list[T]` / `dict[K, V]` builtins
  (Python 3.10+), except inside Pydantic models where `from typing import List` is acceptable.
- **Naming**: `snake_case` for variables, functions, modules; `PascalCase` for classes.
- **Config**: all env vars declared in `backend/app/config.py` (`BaseSettings`). Never
  hardcode secrets or hostnames.
- **Error handling**: raise `fastapi.HTTPException` in services for user-facing errors;
  use `try/except Exception as e: log.warning(...)` in startup/background code.
- **Dependency injection**: DB session via `Depends(get_db)`; auth via `Depends(get_current_user)`.
- **Imports**: stdlib → third-party → local, separated by blank lines. Use `from __future__
  import annotations` only when necessary (forward refs in config / conftest).
- **ORM**: SQLAlchemy 2.0 style — `Mapped[T]` + `mapped_column()`. Primary keys are `uuid.UUID`
  with `default=uuid.uuid4`. Timestamps use `datetime.now(timezone.utc)`.
- **Migrations**: always create an Alembic migration when changing a model. Never mutate
  DB schema directly.
- No configured linter (no ruff/flake8/mypy). Follow existing file patterns.

## Code Style — TypeScript / React

- **Components**: `export default function ComponentName()` (named function, not arrow).
  PascalCase `.tsx` filenames. One component per file.
- **Hooks / stores / utils**: `export const name = ...`. camelCase `.ts` filenames.
- **Path alias**: `@/` → `src/`. Use absolute `@/` imports everywhere; avoid `../..` beyond one level.
- **Types**: `interface` for object shapes (not `type`). Types mirror backend Pydantic schemas
  (snake_case field names). Optional fields `?:`, nullable `T | null`. No `any`.
- **Import style**: use `import type { Foo }` for type-only imports (`verbatimModuleSyntax` is on).
- **API clients**: one file per resource in `src/api/` (`auth.ts`, `fl.ts`, etc.). All calls
  go through the typed client. Never use raw `axios` or `fetch` in components.
- **Server state**: TanStack Query for all server data. No `useEffect + fetch` pattern.
- **Client state**: Zustand stores in `src/stores/`. Use `persist()` for refresh-surviving
  state. No component-level state for anything shared.
- **Event handlers**: prefix `handle*` (e.g., `handleStart`, `handleDelete`).
- **Tailwind v4**: via `@tailwindcss/vite` plugin. Do not add `tailwind.config.js` or
  `postcss.config.js`. No arbitrary magic pixel values — use design tokens / CSS variables.
- **ESLint**: flat config in `frontend/eslint.config.js`. `strict` mode TypeScript.
  `noUnusedLocals` / `noUnusedParameters` are OFF in app code (on in vite.config.ts only).
- **No Prettier** configured — follow spacing/style conventions already in the file.

## Architecture Quick-Reference

```
Frontend (React SPA, port 5173)
    ↕ REST + WebSocket
Backend (FastAPI, port 8000)
    ↕ PostgreSQL (SQLAlchemy async) + Redis (pub/sub for WS broadcast only)
    ↕ Docker SDK → spawns / monitors FL Client containers
    ↕ gRPC mTLS
FL Server (Flower orchestrator, port 8080)
    ↕ gRPC mTLS ← gradients: Ed25519-signed + CKKS-encrypted
FL Clients (Bank_A, Bank_B, Bank_C) → POST predictions back to Backend REST
```

- `fl_common/` is shared Python — CNN-LSTM model, HE utils, signing, RECESS defense, VSS.
- Redis is used **only** for WebSocket broadcast — not for caching.
- Internal API (`api/v1/internal.py`): service-to-service endpoints (FL progress, rounds,
  predictions). **No JWT** — protected by Docker network isolation. Do not add auth guards.
- WebSocket JWT: passed as query param `?token=<JWT>` (cannot use `Depends()` in WS handlers).
- FL client `MODE` env var: `IDLE` | `MONITOR` | `TRAIN`.
- CKKS-encrypted layers: `lstm.weight_ih_l0`, `lstm.weight_hh_l0`, `fc.weight`, `fc.bias`.
- Default admin credentials (seeded on first start): `admin` / `admin123`.

## Testing Conventions (pytest)

- `asyncio_mode = auto` in `pytest.ini` — **no `@pytest.mark.asyncio` decorator** needed.
- Fixtures live in `backend/tests/conftest.py`: in-memory SQLite DB, `app_client`,
  `auth_headers`, `registered_user`.
- Tests use `httpx.AsyncClient` + `ASGITransport` — no real HTTP server required.
- ML/Docker heavy deps are mocked at `sys.modules` level in conftest.
- Tests grouped in `class Test*` with `async def test_*` methods.
- Mark integration tests `@pytest.mark.integration`, WebSocket tests `@pytest.mark.websocket`.

<!-- gitnexus:start -->
# GitNexus MCP

This project is indexed by GitNexus as **FYP_2026** (1862 symbols, 4226 relationships, 143 execution flows).

## Always Start Here

1. **Read `gitnexus://repo/{name}/context`** — codebase overview + check index freshness
2. **Match your task to a skill below** and **read that skill file**
3. **Follow the skill's workflow and checklist**

> If step 1 warns the index is stale, run `npx gitnexus analyze` in the terminal first.

## Skills

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
