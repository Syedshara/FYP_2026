"""
Shared test fixtures — async SQLite DB, FastAPI test client, auth helpers.

Uses an in-memory SQLite database so tests are fast, isolated, and don't
require Docker/PostgreSQL.
"""

from __future__ import annotations

import asyncio
import sys
from typing import AsyncGenerator, Generator
from unittest.mock import MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    create_async_engine,
    async_sessionmaker,
)

# ── Mock heavy ML dependencies BEFORE any app imports ────
# torch / numpy are not needed for API-level testing
for mod_name in ("torch", "torch.nn", "numpy", "joblib"):
    if mod_name not in sys.modules:
        sys.modules[mod_name] = MagicMock()

# ── Patch settings BEFORE any app imports ────────────────
import app.config as _cfg

_cfg.settings.DATABASE_URL = "sqlite+aiosqlite:////tmp/test_iot_ids.db"
_cfg.settings.DEBUG = False

from app.database import Base, get_db          # noqa: E402
from app.main import create_app                # noqa: E402
from app.core.security import hash_password    # noqa: E402
from app.models.user import User               # noqa: E402
from app.models.prediction import Prediction   # noqa: E402, F401  — ensure table is created
from app.models.device import Device           # noqa: E402, F401
from app.models.fl import FLRound, FLClientMetric, FLClient  # noqa: E402, F401

# ── Async test engine (shared in-memory SQLite) ─────────
# SQLite doesn't support native UUIDs. We monkeypatch the Uuid type
# processor so it can handle plain string UUIDs (from JWT 'sub' claim).
import uuid as _uuid
from sqlalchemy import Uuid as _SAUuid
from sqlalchemy import event as _sa_event

_orig_bind = _SAUuid.bind_processor

def _patched_bind_processor(self, dialect):
    """Return a bind processor that handles both UUID objects and strings."""
    if dialect.name == "sqlite":
        def process(value):
            if value is not None:
                if isinstance(value, _uuid.UUID):
                    return value.hex
                # Already a string (e.g. from JWT sub claim) — convert to hex
                return _uuid.UUID(str(value)).hex
            return value
        return process
    return _orig_bind(self, dialect)

_SAUuid.bind_processor = _patched_bind_processor

# ── Patch BigInteger → Integer for SQLite autoincrement ──
# SQLite only auto-increments INTEGER PRIMARY KEY, not BIGINT.
from sqlalchemy import BigInteger as _SABigInt, Integer as _SAInt

_orig_big_compile = None

@_sa_event.listens_for(Base.metadata, "before_create")
def _fix_bigint_for_sqlite(target, connection, **kw):
    """Replace BigInteger PK columns with Integer for SQLite autoincrement."""
    if connection.dialect.name != "sqlite":
        return
    for table in target.sorted_tables:
        for col in table.columns:
            if isinstance(col.type, _SABigInt):
                col.type = _SAInt()

_test_engine = create_async_engine(
    "sqlite+aiosqlite:////tmp/test_iot_ids.db",
    echo=False,
    connect_args={"check_same_thread": False},
)

# ── Also override the app-level engine AND session factory so any code
#    that uses async_session directly (e.g. seed_admin) shares the same DB ──
import app.database as _db_mod
_db_mod.engine = _test_engine
_db_mod.async_session = async_sessionmaker(
    _test_engine,
    class_=AsyncSession,
    expire_on_commit=False,
)

# main.py captured `async_session` at import time via `from app.database import async_session`,
# so we must also patch the reference there.
import app.main as _main_mod
_main_mod.async_session = _db_mod.async_session

@_sa_event.listens_for(_test_engine.sync_engine, "connect")
def _set_sqlite_pragma(dbapi_conn, connection_record):
    """Enable foreign keys for SQLite."""
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()
_TestSession = async_sessionmaker(
    _test_engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


# ── Event loop fixture ──────────────────────────────────

@pytest.fixture(scope="session")
def event_loop() -> Generator:
    """Create a single event loop for the entire test session."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


# ── Database lifecycle ──────────────────────────────────

@pytest.fixture(scope="session", autouse=True)
def _create_tables(event_loop):
    """Create all tables once before the test session, drop after."""
    import os
    db_path = "/tmp/test_iot_ids.db"
    # Remove stale DB from previous runs
    if os.path.exists(db_path):
        os.remove(db_path)

    async def _setup():
        async with _test_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    async def _teardown():
        async with _test_engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await _test_engine.dispose()

    event_loop.run_until_complete(_setup())
    yield
    event_loop.run_until_complete(_teardown())
    if os.path.exists(db_path):
        os.remove(db_path)


@pytest_asyncio.fixture()
async def db_session() -> AsyncGenerator[AsyncSession, None]:
    """Provide a fresh DB session per test — rolls back after each test."""
    async with _TestSession() as session:
        yield session


# ── FastAPI override for DB dependency ───────────────────

async def _override_get_db() -> AsyncGenerator[AsyncSession, None]:
    async with _TestSession() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


# ── Clean all tables between tests ──────────────────────

async def _clean_all_tables():
    """Delete all rows from all tables for test isolation."""
    async with _TestSession() as session:
        for table in reversed(Base.metadata.sorted_tables):
            await session.execute(table.delete())
        await session.commit()


# ── HTTP client fixture ─────────────────────────────────

@pytest_asyncio.fixture()
async def app_client() -> AsyncGenerator[AsyncClient, None]:
    """
    Provide an ``httpx.AsyncClient`` wired to the FastAPI app with
    DB dependency overridden to use in-memory SQLite.
    Cleans all tables after each test for full isolation.
    """
    app = create_app()
    app.dependency_overrides[get_db] = _override_get_db

    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        follow_redirects=True,
    ) as client:
        yield client

    # Clean up ALL tables after each test for isolation
    await _clean_all_tables()
    app.dependency_overrides.clear()


# ── Auth helper fixtures ────────────────────────────────

TEST_USER = {
    "username": "testuser",
    "email": "test@example.com",
    "password": "testpass123",
}

ADMIN_USER = {
    "username": "admin",
    "email": "admin@iotids.local",
    "password": "admin123",
}


@pytest_asyncio.fixture()
async def registered_user(app_client: AsyncClient) -> dict:
    """Register a test user and return the user data + credentials."""
    resp = await app_client.post("/api/v1/auth/register", json=TEST_USER)
    assert resp.status_code == 201, resp.text
    user_data = resp.json()
    return {**user_data, "password": TEST_USER["password"]}


@pytest_asyncio.fixture()
async def auth_token(app_client: AsyncClient, registered_user: dict) -> str:
    """Login and return a valid access token."""
    resp = await app_client.post("/api/v1/auth/login", json={
        "username": TEST_USER["username"],
        "password": TEST_USER["password"],
    })
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


@pytest_asyncio.fixture()
async def auth_headers(auth_token: str) -> dict[str, str]:
    """Return Authorization headers for authenticated requests."""
    return {"Authorization": f"Bearer {auth_token}"}


@pytest_asyncio.fixture()
async def auth_tokens(app_client: AsyncClient, registered_user: dict) -> dict:
    """Login and return both access + refresh tokens."""
    resp = await app_client.post("/api/v1/auth/login", json={
        "username": TEST_USER["username"],
        "password": TEST_USER["password"],
    })
    assert resp.status_code == 200, resp.text
    return resp.json()
