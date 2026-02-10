"""
WebSocket connection manager — tracks connected clients by user ID.

Usage from anywhere in the backend:
    from app.core.websocket import ws_manager

    await ws_manager.broadcast({"type": "prediction", "data": {...}})
    await ws_manager.send_to_user(user_id, {"type": "alert", ...})
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from fastapi import WebSocket
from starlette.websockets import WebSocketState

log = logging.getLogger(__name__)


class ConnectionManager:
    """
    Manages WebSocket connections per user.

    One user can have multiple tabs / connections open, so we keep a
    ``set[WebSocket]`` per user_id.
    """

    def __init__(self) -> None:
        # user_id (str/UUID) → set of active WebSocket connections
        self._connections: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    # ── Connect / disconnect ────────────────────────────

    async def connect(self, websocket: WebSocket, user_id: str) -> None:
        """Accept the WebSocket and register it under *user_id*."""
        await websocket.accept()
        async with self._lock:
            if user_id not in self._connections:
                self._connections[user_id] = set()
            self._connections[user_id].add(websocket)
        log.info("WS connected: user=%s  (total=%d)", user_id, self.total_connections)

    async def disconnect(self, websocket: WebSocket, user_id: str) -> None:
        """Remove the connection for *user_id*."""
        async with self._lock:
            conns = self._connections.get(user_id)
            if conns:
                conns.discard(websocket)
                if not conns:
                    del self._connections[user_id]
        log.info("WS disconnected: user=%s  (total=%d)", user_id, self.total_connections)

    # ── Send helpers ────────────────────────────────────

    async def send_to_user(self, user_id: str, message: dict[str, Any]) -> None:
        """Send a JSON message to all connections of a specific user."""
        async with self._lock:
            conns = list(self._connections.get(user_id, []))
        await self._send_many(conns, message)

    async def broadcast(self, message: dict[str, Any]) -> None:
        """Broadcast a JSON message to ALL connected clients."""
        async with self._lock:
            conns = [ws for conns in self._connections.values() for ws in conns]
        await self._send_many(conns, message)

    async def broadcast_except(self, message: dict[str, Any], exclude_user: str) -> None:
        """Broadcast to all except a specific user."""
        async with self._lock:
            conns = [
                ws
                for uid, user_conns in self._connections.items()
                if uid != exclude_user
                for ws in user_conns
            ]
        await self._send_many(conns, message)

    # ── Info ────────────────────────────────────────────

    @property
    def total_connections(self) -> int:
        return sum(len(c) for c in self._connections.values())

    @property
    def connected_users(self) -> list[str]:
        return list(self._connections.keys())

    # ── Internal ────────────────────────────────────────

    async def _send_many(self, connections: list[WebSocket], message: dict[str, Any]) -> None:
        """Send *message* to a list of WebSocket connections (best-effort)."""
        payload = self._serialise(message)
        dead: list[tuple[WebSocket, str]] = []

        async def _send_one(ws: WebSocket) -> None:
            try:
                if ws.client_state == WebSocketState.CONNECTED:
                    await ws.send_text(payload)
            except Exception:
                # Find user_id for this ws so we can clean up
                for uid, conns in self._connections.items():
                    if ws in conns:
                        dead.append((ws, uid))
                        break

        await asyncio.gather(*[_send_one(ws) for ws in connections], return_exceptions=True)

        # Clean up dead connections
        if dead:
            async with self._lock:
                for ws, uid in dead:
                    conns = self._connections.get(uid)
                    if conns:
                        conns.discard(ws)
                        if not conns:
                            del self._connections[uid]

    @staticmethod
    def _serialise(obj: Any) -> str:
        """JSON-serialise with UUID and datetime support."""

        def _default(o: Any) -> Any:
            if isinstance(o, UUID):
                return str(o)
            if isinstance(o, datetime):
                return o.isoformat()
            raise TypeError(f"Object of type {type(o)} is not JSON serializable")

        return json.dumps(obj, default=_default)


# ── Singleton instance ──────────────────────────────────
ws_manager = ConnectionManager()


# ── Message type helpers ────────────────────────────────
# Each outbound message MUST have a "type" field.

class WSMessageType:
    """Well-known WebSocket message types."""
    PREDICTION      = "prediction"        # new prediction result
    FL_PROGRESS     = "fl_progress"       # per-client training progress
    FL_ROUND        = "fl_round"          # completed round summary
    TRAINING_START  = "training_start"    # training session started
    TRAINING_STOP   = "training_complete" # training session ended
    CLIENT_STATUS   = "client_status"     # FL client container status change
    DEVICE_STATUS   = "device_status"     # device status change
    ALERT           = "alert"             # high-severity alert
    PING            = "ping"              # keep-alive ping
    PONG            = "pong"              # keep-alive pong
    ERROR           = "error"             # server-side error


def build_ws_message(msg_type: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
    """Construct a standard WebSocket message envelope."""
    return {
        "type": msg_type,
        "data": data or {},
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
