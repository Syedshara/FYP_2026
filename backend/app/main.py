"""
FastAPI application factory.
"""

from contextlib import asynccontextmanager
import asyncio
import logging

from fastapi import FastAPI
from sqlalchemy import select

from app.config import settings
from app.database import async_session
from app.core.middleware import setup_cors
from app.core.exceptions import register_exception_handlers
from app.core.security import hash_password
from app.models.user import User
from app.api.v1 import router as api_v1_router
from app.core.websocket import ws_manager
from app.services import docker_service

log = logging.getLogger(__name__)

_DB_CONNECT_RETRIES = 15
_DB_CONNECT_RETRY_DELAY = 3.0  # seconds — generous window for Docker ARP to settle


async def seed_admin():
    """Create a default admin user if none exists.

    Retries up to _DB_CONNECT_RETRIES times to handle the brief window after a
    container restart where the Docker bridge route isn't yet fully active.
    """
    last_exc: Exception | None = None
    for attempt in range(1, _DB_CONNECT_RETRIES + 1):
        try:
            async with async_session() as db:
                result = await db.execute(select(User).where(User.role == "admin"))
                if result.scalar_one_or_none() is None:
                    admin = User(
                        username="admin",
                        email="admin@iotids.local",
                        hashed_password=hash_password("admin123"),
                        role="admin",
                    )
                    db.add(admin)
                    await db.commit()
                    print("👤 Default admin user created (admin / admin123)")
                else:
                    print("👤 Admin user already exists — skipping seed")
            return  # success
        except Exception as exc:
            last_exc = exc
            if attempt < _DB_CONNECT_RETRIES:
                log.warning(
                    "DB not ready (attempt %d/%d): %s — retrying in %.0fs",
                    attempt,
                    _DB_CONNECT_RETRIES,
                    exc,
                    _DB_CONNECT_RETRY_DELAY,
                )
                await asyncio.sleep(_DB_CONNECT_RETRY_DELAY)
            else:
                log.error(
                    "DB unreachable after %d attempts: %s", _DB_CONNECT_RETRIES, exc
                )
                raise RuntimeError(f"Cannot connect to database: {exc}") from last_exc


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: startup and shutdown logic."""
    # ── Startup ──────────────────────────────────────────
    print(f"🚀 Starting {settings.APP_NAME} v{settings.APP_VERSION}")
    await seed_admin()
    # Pre-load CNN-LSTM model so first inference request is fast
    try:
        from app.services.inference_service import ensure_model_loaded

        model_ready = await ensure_model_loaded()
        if model_ready:
            print("🧠 ML model pre-loaded successfully")
        else:
            print(
                "⚠️  ML model not available (model file missing?) — inference will fail"
            )
    except Exception as exc:
        log.warning("ML model pre-load failed: %s — inference will be unavailable", exc)

    # Connect to Redis for caching / pub-sub
    redis_conn = None
    try:
        import redis.asyncio as aioredis

        redis_conn = aioredis.from_url(
            settings.REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
        )
        await redis_conn.ping()
        app.state.redis = redis_conn
        print(f"🔴 Redis connected at {settings.REDIS_URL}")
    except Exception as exc:
        log.warning("Redis connection failed: %s — caching disabled", exc)
        app.state.redis = None

    yield

    # ── Shutdown ─────────────────────────────────────────
    if redis_conn is not None:
        await redis_conn.close()
        print("🔴 Redis connection closed")
    print("🛑 Shutting down…")


def create_app() -> FastAPI:
    """Build and return the FastAPI application."""
    app = FastAPI(
        title=settings.APP_NAME,
        version=settings.APP_VERSION,
        description="IoT Intrusion Detection System with Federated Learning & Homomorphic Encryption",
        lifespan=lifespan,
    )

    # Middleware
    setup_cors(app)

    # Exception handlers
    register_exception_handlers(app)

    # Routers
    app.include_router(api_v1_router, prefix="/api/v1")

    # Health check
    @app.get("/health", tags=["health"])
    async def health():
        return {
            "status": "ok",
            "version": settings.APP_VERSION,
            "ws_connections": ws_manager.total_connections,
        }

    return app


app = create_app()
