"""
FastAPI application factory.
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy import select

from app.config import settings
from app.database import async_session
from app.core.middleware import setup_cors
from app.core.exceptions import register_exception_handlers
from app.core.security import hash_password
from app.models.user import User
from app.api.v1 import router as api_v1_router


async def seed_admin():
    """Create a default admin user if none exists."""
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: startup and shutdown logic."""
    # ── Startup ──────────────────────────────────────────
    print(f"🚀 Starting {settings.APP_NAME} v{settings.APP_VERSION}")
    await seed_admin()
    # TODO: Load ML model into app.state
    # TODO: Connect to Redis
    yield
    # ── Shutdown ─────────────────────────────────────────
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
        return {"status": "ok", "version": settings.APP_VERSION}

    return app


app = create_app()
