"""
Security Status API endpoints.

- GET  /security/status            — aggregated security snapshot
- GET  /security/trust_scores      — current trust scores
- GET  /security/flagged           — flagged client history
- GET  /security/detection_rounds  — all detection rounds
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.core.dependencies import get_current_user
from app.services import fl_service

log = logging.getLogger(__name__)

router = APIRouter()


# ── Response schemas ─────────────────────────────────────

class VSSStatus(BaseModel):
    clients: list[str]
    commitmentsHeld: bool
    lastRefreshRound: int


class TrustScoreOut(BaseModel):
    clientId: str
    score: float
    flagged: bool
    lastDetectionRound: int


class SecurityStatus(BaseModel):
    vss: VSSStatus
    trustScores: list[TrustScoreOut]
    recentDetectionRounds: list[dict]
    flaggedClients: list[dict]


# ── Security Endpoints ────────────────────────────────────

@router.get("/status", response_model=SecurityStatus)
async def get_security_status(
    _user=Depends(get_current_user),
):
    """Get the aggregated security snapshot."""
    trust_scores_raw = fl_service.get_trust_scores()
    detection_rounds = fl_service.get_detection_rounds()
    flagged_clients = fl_service.get_flagged_clients()

    flagged_ids = {entry["client_id"] for entry in flagged_clients}

    # Derive last detection round per client from detection_rounds
    last_round_per_client: dict[str, int] = {}
    for dr in detection_rounds:
        rn = dr.get("round_number", 0)
        for cid in dr.get("scores", {}):
            if last_round_per_client.get(cid, -1) < rn:
                last_round_per_client[cid] = rn

    trust_score_list = [
        TrustScoreOut(
            clientId=cid,
            score=score,
            flagged=cid in flagged_ids,
            lastDetectionRound=last_round_per_client.get(cid, 0),
        )
        for cid, score in trust_scores_raw.items()
    ]

    client_ids = list(trust_scores_raw.keys())
    recent_detection_rounds = detection_rounds[-10:] if len(detection_rounds) > 10 else detection_rounds

    vss = VSSStatus(
        clients=client_ids,
        commitmentsHeld=True,
        lastRefreshRound=detection_rounds[-1]["round_number"] if detection_rounds else 0,
    )

    return SecurityStatus(
        vss=vss,
        trustScores=trust_score_list,
        recentDetectionRounds=recent_detection_rounds,
        flaggedClients=flagged_clients,
    )


@router.get("/trust_scores")
async def get_trust_scores(
    _user=Depends(get_current_user),
):
    """Return the current trust scores as a dict."""
    return fl_service.get_trust_scores()


@router.get("/flagged")
async def get_flagged_clients(
    _user=Depends(get_current_user),
):
    """Return the full flagged client history."""
    return fl_service.get_flagged_clients()


@router.get("/detection_rounds")
async def get_detection_rounds(
    _user=Depends(get_current_user),
):
    """Return all detection rounds."""
    return fl_service.get_detection_rounds()
