"""
Import all models so Alembic and SQLAlchemy can discover them.
"""

from app.models.user import User
from app.models.device import Device
from app.models.prediction import Prediction
from app.models.fl import FLRound, FLClientMetric, FLClient

__all__ = [
    "User",
    "Device",
    "Prediction",
    "FLRound",
    "FLClientMetric",
    "FLClient",
]
