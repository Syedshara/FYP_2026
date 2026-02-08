"""
API v1 router — aggregates all sub-routers.
"""

from fastapi import APIRouter

from app.api.v1.auth import router as auth_router
from app.api.v1.fl import router as fl_router
from app.api.v1.devices import router as devices_router
from app.api.v1.predictions import router as predictions_router

router = APIRouter()

router.include_router(auth_router, prefix="/auth", tags=["auth"])
router.include_router(fl_router, prefix="/fl", tags=["federated-learning"])
router.include_router(devices_router, prefix="/devices", tags=["devices"])
router.include_router(predictions_router, prefix="/predictions", tags=["predictions"])
