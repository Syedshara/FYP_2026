"""
Application configuration — loads from environment variables.
"""

from __future__ import annotations

import json
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Central settings loaded from .env / environment."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ── Database ─────────────────────────────────
    DATABASE_URL: str = "postgresql+asyncpg://iot_admin:iot_secure_pass@postgres:5432/iot_ids"
    DATABASE_URL_SYNC: str = "postgresql+psycopg2://iot_admin:iot_secure_pass@postgres:5432/iot_ids"

    # ── Redis ────────────────────────────────────
    REDIS_URL: str = "redis://redis:6379/0"

    # ── JWT ──────────────────────────────────────
    JWT_SECRET_KEY: str = "dev-secret-key-change-in-production-please"
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    JWT_REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    # ── ML Model ─────────────────────────────────
    MODEL_PATH: str = "/app/models/cnn_lstm_global_with_HE_25rounds_16k.pt"
    SCALER_PATH: str = "/app/models/standard_scaler.pkl"
    DEFAULT_THRESHOLD: float = 0.5
    SEQUENCE_LENGTH: int = 10
    NUM_FEATURES: int = 78

    # ── FL Server ────────────────────────────────
    FL_SERVER_HOST: str = "fl_server"
    FL_SERVER_PORT: int = 8080
    FL_NUM_ROUNDS: int = 25
    FL_MIN_CLIENTS: int = 2

    # ── HE ───────────────────────────────────────
    HE_SCHEME: str = "ckks"
    HE_POLY_MODULUS: int = 16384
    HE_GLOBAL_SCALE: int = 1099511627776  # 2**40

    # ── Docker SDK ──────────────────────────────
    HOST_PROJECT_ROOT: str = "/host_project"  # set via docker-compose env

    # ── App ──────────────────────────────────────
    APP_NAME: str = "IoT IDS Platform"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = True
    LOG_LEVEL: str = "info"
    CORS_ORIGINS: str = '["http://localhost:3000","http://localhost:5173"]'

    @property
    def cors_origins_list(self) -> List[str]:
        """Parse CORS_ORIGINS JSON string into a list."""
        return json.loads(self.CORS_ORIGINS)


# Singleton instance — import this everywhere
settings = Settings()
