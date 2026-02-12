"""
Pydantic schemas for Prediction / Inference endpoints.
"""

from datetime import datetime
from typing import Optional, Dict, Any
from uuid import UUID

from pydantic import BaseModel


class PredictionOut(BaseModel):
    id: int
    device_id: UUID
    client_id: Optional[int] = None
    score: float
    label: str
    confidence: float
    attack_type: Optional[str]
    model_version: str
    feature_importance: Optional[Dict[str, Any]]
    top_anomalies: Optional[list] = None
    temporal_pattern: Optional[str] = None
    inference_latency_ms: Optional[float]
    timestamp: datetime

    model_config = {"from_attributes": True}


class PredictionSummary(BaseModel):
    """Dashboard summary card data."""
    total_predictions: int
    attack_count: int
    benign_count: int
    attack_rate: float
    avg_confidence: float
    avg_latency_ms: float
