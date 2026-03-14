"""
Security Status API endpoints.

- GET  /security/status            — aggregated security snapshot
- GET  /security/trust_scores      — current trust scores
- GET  /security/flagged           — flagged client history
- GET  /security/detection_rounds  — all detection rounds
- GET  /security/certificates      — mTLS certificate metadata
"""

import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.x509.oid import NameOID
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.core.dependencies import get_current_user
from app.services import fl_service

log = logging.getLogger(__name__)

router = APIRouter()

# Cert directory shared with FL server/client containers
CERTS_DIR = os.environ.get("CERTS_DIR", "/app/certs")


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

    # commitmentsHeld: VSS ceremony runs on FL server init when >=2 clients
    # are configured + HE is enabled.  We can't query the server directly, so
    # use detection_rounds as proxy — if RECESS has run, security infra is active.
    commitments_held = len(client_ids) >= 2 and len(detection_rounds) > 0

    vss = VSSStatus(
        clients=client_ids,
        commitmentsHeld=commitments_held,
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


# ── Certificate schemas ──────────────────────────────────

class CertificateMetadata(BaseModel):
    clientId: str
    issuer: str
    notBefore: str
    notAfter: str
    fingerprint: str


# ── Certificate endpoint ─────────────────────────────────

@router.get("/certificates", response_model=list[CertificateMetadata])
async def get_certificates(
    _user=Depends(get_current_user),
):
    """
    Read mTLS certificate metadata from the shared certs directory.
    Returns issuer, validity dates, and SHA-256 fingerprint for each .crt file.
    """
    certs_path = Path(CERTS_DIR)
    results: list[CertificateMetadata] = []

    if not certs_path.is_dir():
        log.warning("Certificates directory does not exist: %s", CERTS_DIR)
        return results

    for cert_file in sorted(certs_path.glob("*.crt")):
        try:
            pem_data = cert_file.read_bytes()
            cert = x509.load_pem_x509_certificate(pem_data)

            # Extract common name from issuer, fall back to full issuer string
            issuer_cn = ""
            try:
                cn_attrs = cert.issuer.get_attributes_for_oid(NameOID.COMMON_NAME)
                issuer_cn = str(cn_attrs[0].value) if cn_attrs else str(cert.issuer)
            except Exception:
                issuer_cn = str(cert.issuer)

            fingerprint = cert.fingerprint(hashes.SHA256()).hex()

            # not_valid_before_utc was added in cryptography>=42;
            # fall back to not_valid_before for older versions.
            not_before = getattr(cert, "not_valid_before_utc", None) or cert.not_valid_before
            not_after = getattr(cert, "not_valid_after_utc", None) or cert.not_valid_after

            results.append(CertificateMetadata(
                clientId=cert_file.stem,  # e.g. "Bank_A" from "Bank_A.crt"
                issuer=issuer_cn,
                notBefore=not_before.isoformat(),
                notAfter=not_after.isoformat(),
                fingerprint=fingerprint,
            ))
        except Exception as exc:
            log.warning("Failed to parse certificate %s: %s", cert_file.name, exc)

    return results
