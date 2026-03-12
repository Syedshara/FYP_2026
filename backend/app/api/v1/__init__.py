"""
API v1 router — aggregates all sub-routers.
"""

from fastapi import APIRouter

from app.api.v1.auth import router as auth_router
from app.api.v1.fl import router as fl_router
from app.api.v1.devices import router as devices_router
from app.api.v1.predictions import router as predictions_router
from app.api.v1.ws import router as ws_router
from app.api.v1.internal import router as internal_router
from app.api.v1.simulation import router as simulation_router
from app.api.v1.security import router as security_router
from app.api.v1.pipeline import router as pipeline_router
from app.api.v1.workspace import router as workspace_router
from app.api.v1.attacks import router as attacks_router

router = APIRouter()

router.include_router(auth_router, prefix="/auth", tags=["auth"])
router.include_router(fl_router, prefix="/fl", tags=["federated-learning"])
router.include_router(devices_router, prefix="/devices", tags=["devices"])
router.include_router(predictions_router, prefix="/predictions", tags=["predictions"])
router.include_router(ws_router, tags=["websocket"])
router.include_router(internal_router, prefix="/internal", tags=["internal"])
router.include_router(simulation_router, prefix="/simulation", tags=["simulation"])
router.include_router(security_router, prefix="/security", tags=["security"])
router.include_router(pipeline_router, prefix="/pipelines", tags=["pipelines"])
router.include_router(workspace_router, prefix="/workspaces", tags=["workspaces"])
router.include_router(attacks_router, prefix="/attacks", tags=["attacks"])
