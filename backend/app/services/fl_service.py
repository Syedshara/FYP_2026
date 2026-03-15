"""
Federated Learning service — manages FL training rounds, metrics, and clients.
"""

from datetime import datetime, timezone
from typing import Optional
import logging
import os

from sqlalchemy import select, func, delete, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.fl import FLRound, FLClientMetric, FLClient
from app.core.exceptions import NotFoundException, ConflictException
from app.services import docker_service, data_service
from app.config import settings

log = logging.getLogger(__name__)


# ── FL Rounds ────────────────────────────────────────────

async def create_fl_round(
    db: AsyncSession,
    round_number: int,
    num_clients: int,
    aggregation_method: str = "fedavg_he",
    he_scheme: Optional[str] = "ckks",
    he_poly_modulus: Optional[int] = 16384,
    duration_seconds: Optional[float] = None,
    global_loss: Optional[float] = None,
    global_accuracy: Optional[float] = None,
    global_f1: Optional[float] = None,
    global_precision: Optional[float] = None,
    global_recall: Optional[float] = None,
    model_checkpoint_path: Optional[str] = None,
    security_data: Optional[dict] = None,
    trust_scores: Optional[dict] = None,
) -> FLRound:
    """Record a completed FL round."""
    fl_round = FLRound(
        round_number=round_number,
        num_clients=num_clients,
        aggregation_method=aggregation_method,
        he_scheme=he_scheme,
        he_poly_modulus=he_poly_modulus,
        duration_seconds=duration_seconds,
        global_loss=global_loss,
        global_accuracy=global_accuracy,
        global_f1=global_f1,
        global_precision=global_precision,
        global_recall=global_recall,
        model_checkpoint_path=model_checkpoint_path,
        security_data=security_data,
        trust_scores=trust_scores,
    )
    db.add(fl_round)
    await db.commit()
    await db.refresh(fl_round)
    return fl_round


async def create_client_metric(
    db: AsyncSession,
    round_id: int,
    client_id: str,
    local_loss: float,
    local_accuracy: float,
    num_samples: int,
    training_time_sec: float,
    encrypted: bool = True,
) -> FLClientMetric:
    """Record a client's training metrics for a given round."""
    metric = FLClientMetric(
        round_id=round_id,
        client_id=client_id,
        local_loss=local_loss,
        local_accuracy=local_accuracy,
        num_samples=num_samples,
        training_time_sec=training_time_sec,
        encrypted=encrypted,
    )
    db.add(metric)
    await db.commit()
    await db.refresh(metric)
    return metric


async def get_all_rounds(db: AsyncSession) -> list[FLRound]:
    """Return all FL rounds across every training session, ordered by id."""
    result = await db.execute(
        select(FLRound).order_by(FLRound.id)
    )
    return list(result.scalars().all())


async def get_round_by_number(db: AsyncSession, round_number: int) -> Optional[FLRound]:
    """Get a specific round by its number (latest session's version)."""
    result = await db.execute(
        select(FLRound)
        .where(FLRound.round_number == round_number)
        .order_by(FLRound.id.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def get_client_metrics_for_round(
    db: AsyncSession, round_id: int
) -> list[FLClientMetric]:
    """Get all client metrics for a given round."""
    result = await db.execute(
        select(FLClientMetric).where(FLClientMetric.round_id == round_id)
    )
    return list(result.scalars().all())


async def get_latest_round(db: AsyncSession) -> Optional[FLRound]:
    """Get the most recent FL round."""
    result = await db.execute(
        select(FLRound).order_by(FLRound.round_number.desc()).limit(1)
    )
    return result.scalar_one_or_none()


# ── FL Client CRUD ──────────────────────────────────────

def _generate_client_keys(client_id: str) -> None:
    """
    Auto-generate an Ed25519 signing key pair for a new FL client.

    Writes:
      <certs_dir>/<cert_name>_ed25519.pem          — private key (PEM)
      <certs_dir>/client_keys/<cert_name>.pub.pem  — public key (PEM)

    Also generates mTLS RSA certificate (.crt/.key) signed by the project CA
    if one doesn't already exist. This allows dynamically-created canvas clients
    to authenticate with the FL server over mTLS.

    Silently skips if keys already exist or if the cryptography library is unavailable.
    """
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.hazmat.primitives.serialization import (
            Encoding, PrivateFormat, PublicFormat, NoEncryption, load_pem_private_key,
        )
        from cryptography.hazmat.primitives.hashes import SHA256
        from cryptography import x509
        from cryptography.x509.oid import NameOID
        import datetime as dt

        # Certs dir: use /app/certs inside the backend container (mounted from ./certs on host)
        # This path is shared with FL client/server containers via their own ./certs mount
        certs_dir = "/app/certs"
        cert_name = docker_service._cert_name(client_id)

        # ── 1. Ed25519 signing keys ──
        priv_path = os.path.join(certs_dir, f"{cert_name}_ed25519.pem")
        pub_path  = os.path.join(certs_dir, "client_keys", f"{cert_name}.pub.pem")

        os.makedirs(os.path.dirname(pub_path), exist_ok=True)

        if not (os.path.isfile(priv_path) and os.path.isfile(pub_path)):
            key = Ed25519PrivateKey.generate()
            priv_pem = key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
            pub_pem  = key.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)

            with open(priv_path, "wb") as f:
                f.write(priv_pem)
            with open(pub_path, "wb") as f:
                f.write(pub_pem)
            log.info("Generated Ed25519 keys for client %s → %s", client_id, cert_name)
        else:
            log.info("Ed25519 keys already exist for client %s — skipping", client_id)

        # ── 2. mTLS RSA certificate signed by project CA ──
        mtls_key_path = os.path.join(certs_dir, f"{cert_name}.key")
        mtls_crt_path = os.path.join(certs_dir, f"{cert_name}.crt")
        ca_crt_path = os.path.join(certs_dir, "ca.crt")
        ca_key_path = os.path.join(certs_dir, "ca.key")

        if os.path.isfile(mtls_crt_path) and os.path.isfile(mtls_key_path):
            log.info("mTLS cert already exists for client %s — skipping", client_id)
        elif os.path.isfile(ca_crt_path) and os.path.isfile(ca_key_path):
            # Generate RSA key
            client_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            with open(mtls_key_path, "wb") as f:
                f.write(client_key.private_bytes(Encoding.PEM, PrivateFormat.TraditionalOpenSSL, NoEncryption()))

            # Load CA
            with open(ca_crt_path, "rb") as f:
                ca_cert = x509.load_pem_x509_certificate(f.read())
            with open(ca_key_path, "rb") as f:
                ca_key = load_pem_private_key(f.read(), password=None)

            # Create CSR-equivalent subject and sign
            subject = x509.Name([
                x509.NameAttribute(NameOID.COMMON_NAME, cert_name),
                x509.NameAttribute(NameOID.ORGANIZATION_NAME, "IoT IDS Platform"),
                x509.NameAttribute(NameOID.COUNTRY_NAME, "MY"),
            ])
            cert = (
                x509.CertificateBuilder()
                .subject_name(subject)
                .issuer_name(ca_cert.subject)
                .public_key(client_key.public_key())
                .serial_number(x509.random_serial_number())
                .not_valid_before(dt.datetime.now(dt.timezone.utc))
                .not_valid_after(dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=3650))
                .sign(ca_key, SHA256())
            )
            with open(mtls_crt_path, "wb") as f:
                f.write(cert.public_bytes(Encoding.PEM))

            log.info("Generated mTLS cert for client %s → %s.crt/.key", client_id, cert_name)
        else:
            log.warning("CA cert/key not found at %s — cannot generate mTLS cert for %s", certs_dir, client_id)

    except ImportError:
        log.warning("cryptography library not available — skipping Ed25519 keygen for %s", client_id)
    except Exception as exc:
        log.warning("Ed25519 keygen failed for %s: %s — signing will be disabled", client_id, exc)


async def register_fl_client(
    db: AsyncSession,
    client_id: str,
    name: str,
    data_path: str = "/app/data",
    description: Optional[str] = None,
    ip_address: Optional[str] = None,
    canvas_node_id: Optional[str] = None,
    data_source: str = "cic-ids2017",
    create_container: bool = True,
    skip_data_generation: bool = False,
) -> FLClient:
    """
    Register a new FL client.
    - Generates training data unless skip_data_generation=True (data generated at training start).
    - Auto-generates Ed25519 signing keys if not already present.
    - Creates a Docker container in IDLE mode if create_container=True.
    - Raises ConflictException if client_id already exists.
    """
    result = await db.execute(
        select(FLClient).where(FLClient.client_id == client_id)
    )
    existing = result.scalar_one_or_none()
    if existing:
        raise ConflictException(f"FL client with ID '{client_id}' already exists")

    # Auto-generate Ed25519 signing keys
    _generate_client_keys(client_id)

    # Ensure trust score entry
    ensure_trust_score(client_id)

    container_id = None
    container_name = None
    total_samples = 0

    # Generate training data based on chosen source (skipped when data will be generated at training start)
    if not skip_data_generation:
        data_info = data_service.generate_client_data(client_id, data_source=data_source)
        total_samples = data_info.get("total_samples", 0)
        if data_info.get("created"):
            log.info(
                "Generated %s training data for %s: %d chunks, %d samples (source: %s)",
                data_source, client_id, data_info["chunks"], total_samples, data_info["source"],
            )
        elif not data_info.get("created") and data_info.get("source") == "existing":
            existing_info = data_service.get_client_data_info(client_id)
            total_samples = existing_info.get("total_samples", 0)
    else:
        log.info("Skipping data generation for %s — will be generated at training start", client_id)

    if create_container:
        try:
            info = docker_service.create_client_container(
                client_id=client_id,
                data_path=data_path,
            )
            container_id = info.container_id
            container_name = info.name
            log.info("Created container %s for client %s", container_name, client_id)
        except Exception as exc:
            log.error("Failed to create container for %s: %s", client_id, exc)

    client = FLClient(
        client_id=client_id,
        name=name,
        description=description,
        ip_address=ip_address,
        data_path=data_path,
        status="inactive",
        container_id=container_id,
        container_name=container_name,
        total_samples=total_samples,
        canvas_node_id=canvas_node_id,
        data_source=data_source,
        last_seen_at=datetime.now(timezone.utc),
    )
    db.add(client)
    await db.commit()
    await db.refresh(client)
    return client


async def get_fl_client(db: AsyncSession, pk: int) -> FLClient:
    """Get a single FL client by primary key, with devices eagerly loaded."""
    result = await db.execute(
        select(FLClient)
        .options(selectinload(FLClient.devices))
        .where(FLClient.id == pk)
    )
    client = result.scalar_one_or_none()
    if not client:
        raise NotFoundException("FL client not found")
    return client


async def get_fl_client_by_canvas_node_id(
    db: AsyncSession,
    canvas_node_id: str,
) -> Optional[FLClient]:
    """Return the FL client bound to a canvas node ID, or None if not registered."""
    result = await db.execute(
        select(FLClient).where(FLClient.canvas_node_id == canvas_node_id)
    )
    return result.scalar_one_or_none()


async def get_fl_client_by_client_id(db: AsyncSession, client_id: str) -> Optional[FLClient]:
    """Get a single FL client by its short client_id string."""
    result = await db.execute(
        select(FLClient).where(FLClient.client_id == client_id)
    )
    return result.scalar_one_or_none()


async def update_fl_client(
    db: AsyncSession,
    pk: int,
    **kwargs,
) -> FLClient:
    """Update FL client fields."""
    client = await get_fl_client(db, pk)
    for key, value in kwargs.items():
        if value is not None and hasattr(client, key):
            setattr(client, key, value)
    await db.commit()
    await db.refresh(client)
    return client


async def delete_fl_client(db: AsyncSession, pk: int) -> None:
    """Delete an FL client, remove its Docker container, and cascade-delete its devices."""
    client = await get_fl_client(db, pk)

    # Remove Docker container if one was created
    if client.container_id:
        try:
            docker_service.remove_container(client.container_id, force=True)
            log.info("Removed container %s for client %s", client.container_id, client.client_id)
        except Exception as exc:
            log.error("Failed to remove container for %s: %s", client.client_id, exc)

    # Remove training data directory (safety: won't delete source clients)
    data_service.delete_client_data(client.client_id)

    await db.delete(client)
    await db.commit()


async def get_all_fl_clients(db: AsyncSession) -> list[FLClient]:
    """Return all registered FL clients."""
    result = await db.execute(
        select(FLClient).order_by(FLClient.created_at.desc())
    )
    return list(result.scalars().all())


async def get_active_fl_clients(db: AsyncSession) -> list[FLClient]:
    """Return only active FL clients."""
    result = await db.execute(
        select(FLClient).where(FLClient.status == "active").order_by(FLClient.client_id)
    )
    return list(result.scalars().all())


# ── Cleanup ─────────────────────────────────────────────

async def delete_fl_round_data(db: AsyncSession) -> int:
    """Delete all FL round and metric data (reset). Returns count deleted."""
    metrics_result = await db.execute(select(func.count(FLClientMetric.id)))
    metrics_count = metrics_result.scalar() or 0

    rounds_result = await db.execute(select(func.count(FLRound.id)))
    rounds_count = rounds_result.scalar() or 0

    await db.execute(delete(FLClientMetric))
    await db.execute(delete(FLRound))
    await db.commit()

    return rounds_count + metrics_count


# ── Trust / Anomaly Detection (in-memory) ────────────────

# Dynamic: populated when clients register or when the server reports scores.
# No hardcoded client names.
_trust_scores: dict[str, float] = {}
_detection_rounds: list[dict] = []
_flagged_clients: list[dict] = []

# ── Aggregation Enforcement (in-memory) ──────────────────

# Latest per-client enforcement status from the most recent aggregation round.
# Values: 'included' | 'downweighted' | 'excluded'
_enforcement_status: dict[str, str] = {}
# History of enforcement decisions per aggregation round
_enforcement_rounds: list[dict] = []


def ensure_trust_score(client_id: str) -> None:
    """Ensure a client has a trust score entry (default 1.0)."""
    if client_id not in _trust_scores:
        _trust_scores[client_id] = 1.0


def update_trust_scores(scores: dict[str, float]) -> None:
    """Update in-memory trust scores. Merges with existing."""
    _trust_scores.update(scores)


async def save_trust_scores_to_db(db: AsyncSession) -> None:
    """Persist the current in-memory trust scores to the fl_clients table.

    Called after every RECESS detection round so scores survive a backend
    restart.  Only updates clients that already have an in-memory entry.
    """
    if not _trust_scores:
        return
    for client_id, score in _trust_scores.items():
        await db.execute(
            update(FLClient)
            .where(FLClient.client_id == client_id)
            .values(trust_score=float(score))
        )
    await db.commit()
    log.debug("Trust scores persisted to DB: %s", _trust_scores)


async def load_trust_scores_from_db(db: AsyncSession) -> None:
    """Re-hydrate the in-memory trust scores from the fl_clients table.

    Called when a new training session starts so the FL server inherits the
    scores that were accumulated during previous sessions.
    """
    result = await db.execute(select(FLClient))
    clients = list(result.scalars().all())
    for client in clients:
        _trust_scores[client.client_id] = float(client.trust_score)
    log.info("Trust scores loaded from DB: %s", _trust_scores)


async def reset_all_trust_scores(db: AsyncSession) -> None:
    """Reset every client's trust score to 1.0 in both DB and memory."""
    await db.execute(update(FLClient).values(trust_score=1.0))
    await db.commit()
    _trust_scores.clear()
    # Re-populate memory with all registered clients at 1.0
    result = await db.execute(select(FLClient))
    for client in result.scalars().all():
        _trust_scores[client.client_id] = 1.0
    log.info("All trust scores reset to 1.0")


def record_detection_round(
    round_number: int,
    scores: dict[str, float],
    flagged: list[str],
) -> None:
    """Append a detection round record with ISO timestamp."""
    _detection_rounds.append(
        {
            "round_number": round_number,
            "scores": dict(scores),
            "flagged": list(flagged),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    )


def record_flagged_client(
    client_id: str,
    round_number: int,
    abnormality: float,
) -> None:
    """Append a flagged client record with ISO timestamp."""
    _flagged_clients.append(
        {
            "client_id": client_id,
            "round_number": round_number,
            "abnormality": abnormality,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    )


def get_trust_scores() -> dict[str, float]:
    """Return current trust scores."""
    return dict(_trust_scores)


def get_detection_rounds() -> list[dict]:
    """Return all detection round records."""
    return list(_detection_rounds)


def get_flagged_clients() -> list[dict]:
    """Return all flagged client records."""
    return list(_flagged_clients)


def update_enforcement_status(enforcement: dict[str, str]) -> None:
    """Overwrite the current per-client enforcement status dict."""
    _enforcement_status.clear()
    _enforcement_status.update(enforcement)


def record_enforcement_round(
    round_number: int,
    enforcement: dict[str, str],
    excluded_count: int,
    downweighted_count: int,
) -> None:
    """Append an enforcement round record with ISO timestamp."""
    _enforcement_rounds.append(
        {
            "round_number": round_number,
            "enforcement": dict(enforcement),
            "excluded_count": excluded_count,
            "downweighted_count": downweighted_count,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    )


def get_enforcement_status() -> dict[str, str]:
    """Return the current per-client enforcement status."""
    return dict(_enforcement_status)


def get_enforcement_rounds() -> list[dict]:
    """Return the full history of enforcement rounds."""
    return list(_enforcement_rounds)
