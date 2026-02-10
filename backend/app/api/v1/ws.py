"""
WebSocket endpoint — authenticated real-time communication.

Connect:  ws://localhost:8000/api/v1/ws?token=<JWT>

The token is validated on connection. If invalid, the socket is closed with
code 4001.  Once connected, the server pushes events (predictions, FL
progress, alerts) and responds to keep-alive pings.
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
from jose import JWTError, jwt
from starlette.websockets import WebSocketState

from app.config import settings
from app.core.websocket import ws_manager, WSMessageType, build_ws_message

log = logging.getLogger(__name__)

router = APIRouter()

# ── Keep-alive interval (seconds) ───────────────────────
PING_INTERVAL = 30


# ── JWT helper (can't use Depends inside WS) ───────────
def _verify_ws_token(token: str) -> dict | None:
    """Decode JWT. Returns payload dict or None on failure."""
    try:
        payload = jwt.decode(
            token,
            settings.JWT_SECRET_KEY,
            algorithms=[settings.JWT_ALGORITHM],
        )
        if payload.get("type") != "access":
            return None
        return payload
    except JWTError:
        return None


@router.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    token: str = Query(default=""),
):
    """
    Main WebSocket endpoint.

    Query param ``token`` must be a valid JWT access token.
    Once authenticated the connection is registered and kept alive with
    periodic pings.
    """

    # ── 1. Authenticate ─────────────────────────────────
    if not token:
        await websocket.close(code=4001, reason="Missing token")
        return

    payload = _verify_ws_token(token)
    if payload is None:
        await websocket.close(code=4001, reason="Invalid or expired token")
        return

    user_id: str = payload.get("sub", "unknown")

    # ── 2. Register connection ──────────────────────────
    await ws_manager.connect(websocket, user_id)

    # ── 3. Send welcome message ─────────────────────────
    await websocket.send_text(
        json.dumps(build_ws_message("connected", {
            "message": "WebSocket connected",
            "user_id": user_id,
        }))
    )

    # ── 4. Keep-alive ping task ─────────────────────────
    async def _ping_loop() -> None:
        """Send periodic pings so proxies don't drop the connection."""
        try:
            while websocket.client_state == WebSocketState.CONNECTED:
                await asyncio.sleep(PING_INTERVAL)
                if websocket.client_state == WebSocketState.CONNECTED:
                    await websocket.send_text(
                        json.dumps(build_ws_message(WSMessageType.PING))
                    )
        except Exception:
            pass  # connection already closed

    ping_task = asyncio.create_task(_ping_loop())

    # ── 5. Listen for client messages ───────────────────
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type", "")

            # Respond to client-side pings
            if msg_type == WSMessageType.PING:
                await websocket.send_text(
                    json.dumps(build_ws_message(WSMessageType.PONG))
                )
            # Client-side pong — just acknowledge
            elif msg_type == WSMessageType.PONG:
                pass
            else:
                # Future: handle client-to-server messages here
                log.debug("WS recv from %s: %s", user_id, msg_type)

    except WebSocketDisconnect:
        log.info("WS client disconnected: user=%s", user_id)
    except Exception as exc:
        log.error("WS error for user=%s: %s", user_id, exc)
    finally:
        ping_task.cancel()
        await ws_manager.disconnect(websocket, user_id)
