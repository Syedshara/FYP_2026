"""
In-memory gradient archive for FedRecovery.

Stores per-client CKKS-encrypted gradient bytes (store_enc) and aggregated
plaintext tensors (store_agg) with FIFO eviction when total size exceeds
MAX_BYTES (200 MB default).

Thread-safe via threading.Lock — safe to call from Flower's synchronous
aggregate_fit callback.
"""

import logging
import threading
from collections import OrderedDict
from typing import Any, Dict, Optional

import torch

log = logging.getLogger(__name__)

# Default FIFO memory cap
MAX_BYTES: int = 200 * 1024 * 1024  # 200 MB


class GradientArchive:
    """Thread-safe FIFO archive of per-round gradients.

    Two independent storage namespaces:
    - _enc : OrderedDict[(client_id, round_num) → {layer: bytes}]
             CKKS-serialised encrypted gradient bytes per client per round.
    - _meta: OrderedDict[(client_id, round_num) → {weight, client_id, round}]
             Per-entry metadata for encrypted client deltas.
    - _agg : OrderedDict[round_num → {layer: torch.Tensor}]
             Plaintext aggregated gradient tensors per round.

    Both stores use insertion-order FIFO eviction when the combined byte total
    exceeds max_bytes.  Each store evicts independently in evict_if_needed so
    neither can starve the other indefinitely.
    """

    def __init__(self, max_bytes: int = MAX_BYTES) -> None:
        self._max_bytes = max_bytes
        self._lock = threading.Lock()
        self._enc: OrderedDict[tuple, Dict[str, bytes]] = OrderedDict()
        self._meta: OrderedDict[tuple, Dict[str, Any]] = OrderedDict()
        self._agg: OrderedDict[int, Dict[str, torch.Tensor]] = OrderedDict()
        self._enc_bytes: int = 0
        self._agg_bytes: int = 0
        log.info(
            "GradientArchive initialised (max=%dMB)",
            max_bytes // (1024 * 1024),
        )

    # ── size helpers ──────────────────────────────────────

    @staticmethod
    def _enc_entry_size(layers: Dict[str, bytes]) -> int:
        """Return byte size of one encrypted-gradient entry."""
        return sum(len(v) for v in layers.values())

    @staticmethod
    def _agg_entry_size(layers: Dict[str, torch.Tensor]) -> int:
        """Return byte size of one aggregated-gradient entry."""
        return sum(t.element_size() * t.nelement() for t in layers.values())

    @property
    def total_bytes(self) -> int:
        """Current total bytes used across both stores (not lock-protected — caller must hold lock)."""
        return self._enc_bytes + self._agg_bytes

    # ── FIFO eviction ─────────────────────────────────────

    def _evict_if_needed(self) -> None:
        """Evict oldest entries alternating between enc and agg until under max_bytes.

        Called while _lock is held.
        """
        while (self._enc_bytes + self._agg_bytes) > self._max_bytes:
            evicted = False
            if self._enc:
                key, entry = next(iter(self._enc.items()))
                freed = self._enc_entry_size(entry)
                del self._enc[key]
                self._meta.pop(key, None)
                self._enc_bytes -= freed
                log.debug(
                    "GradientArchive: evicted enc key=%s (freed %dKB)",
                    key,
                    freed // 1024,
                )
                evicted = True
            if (self._enc_bytes + self._agg_bytes) > self._max_bytes and self._agg:
                key, entry = next(iter(self._agg.items()))
                freed = self._agg_entry_size(entry)
                del self._agg[key]
                self._agg_bytes -= freed
                log.debug(
                    "GradientArchive: evicted agg round=%s (freed %dKB)",
                    key,
                    freed // 1024,
                )
                evicted = True
            if not evicted:
                break

    # ── public write API ──────────────────────────────────

    def store_enc(
        self,
        client_id: str,
        round_num: int,
        layers: Dict[str, bytes],
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Archive CKKS-serialised encrypted gradient bytes for one client/round.

        Args:
            client_id: FL client identifier (e.g. 'bank_a').
            round_num: FL training round number.
            layers:    {layer_name: serialised_ckks_bytes}.
            metadata:  Optional metadata dict. Expected keys include
                       {"weight": float, "client_id": str, "round": int}.
        """
        if not layers:
            return
        key = (client_id, round_num)
        entry = {k: v for k, v in layers.items()}
        entry_size = self._enc_entry_size(entry)
        with self._lock:
            if key in self._enc:
                # Overwrite — remove old byte count first
                self._enc_bytes -= self._enc_entry_size(self._enc[key])
                del self._enc[key]
                self._meta.pop(key, None)
            self._enc[key] = entry
            meta = metadata or {}
            self._meta[key] = {
                "weight": float(meta.get("weight", 1.0)),
                "client_id": str(meta.get("client_id", client_id)),
                "round": int(meta.get("round", round_num)),
            }
            self._enc_bytes += entry_size
            self._evict_if_needed()
        log.debug(
            "GradientArchive.store_enc: client=%s round=%d layers=%d size=%dKB",
            client_id,
            round_num,
            len(layers),
            entry_size // 1024,
        )

    def store_agg(
        self,
        round_num: int,
        gradient: Dict[str, torch.Tensor],
    ) -> None:
        """Archive the aggregated gradient tensors for a round.

        Stores isolated (detached, cpu) copies to prevent reference loops
        with the live model or intermediate computation tensors.

        Args:
            round_num: FL training round number.
            gradient:  {layer_name: tensor} — typically self._last_agg_gradient.
        """
        if not gradient:
            return
        isolated = {k: v.cpu().detach().clone() for k, v in gradient.items()}
        entry_size = self._agg_entry_size(isolated)
        with self._lock:
            if round_num in self._agg:
                self._agg_bytes -= self._agg_entry_size(self._agg[round_num])
                del self._agg[round_num]
            self._agg[round_num] = isolated
            self._agg_bytes += entry_size
            self._evict_if_needed()
        log.debug(
            "GradientArchive.store_agg: round=%d layers=%d size=%dKB",
            round_num,
            len(isolated),
            entry_size // 1024,
        )

    # ── public read API ───────────────────────────────────

    def get_enc(
        self,
        client_id: str,
        round_num: int,
    ) -> Optional[Dict[str, bytes]]:
        """Return archived encrypted bytes for a client/round, or None if not found."""
        with self._lock:
            entry = self._enc.get((client_id, round_num))
            return dict(entry) if entry else None

    def get_agg(self, round_num: int) -> Optional[Dict[str, torch.Tensor]]:
        """Return isolated copies of archived aggregated tensors for a round, or None."""
        with self._lock:
            entry = self._agg.get(round_num)
            if entry is None:
                return None
            return {k: v.clone() for k, v in entry.items()}

    def get_meta(self, round_num: int, client_id: str) -> Optional[Dict[str, Any]]:
        """Return archived metadata for a client/round, or None if not found."""
        with self._lock:
            entry = self._meta.get((client_id, round_num))
            return dict(entry) if entry else None

    def get_client_rounds(self, client_id: str) -> list[int]:
        """Return sorted list of rounds archived for a given client."""
        with self._lock:
            return sorted(r for (cid, r) in self._enc if cid == client_id)

    def evict_before(self, round_num: int) -> None:
        """Explicitly evict all entries from rounds strictly older than round_num."""
        with self._lock:
            enc_keys = [
                (cid, r) for (cid, r) in list(self._enc.keys()) if r < round_num
            ]
            for key in enc_keys:
                self._enc_bytes -= self._enc_entry_size(self._enc[key])
                del self._enc[key]
                self._meta.pop(key, None)
            agg_keys = [r for r in list(self._agg.keys()) if r < round_num]
            for r in agg_keys:
                self._agg_bytes -= self._agg_entry_size(self._agg[r])
                del self._agg[r]
        log.debug(
            "GradientArchive.evict_before(%d): removed %d enc + %d agg entries",
            round_num,
            len(enc_keys),
            len(agg_keys),
        )

    def stats(self) -> dict:
        """Return a summary dict suitable for logging or health-check endpoints."""
        with self._lock:
            return {
                "enc_entries": len(self._enc),
                "meta_entries": len(self._meta),
                "agg_entries": len(self._agg),
                "enc_bytes": self._enc_bytes,
                "agg_bytes": self._agg_bytes,
                "total_mb": round(
                    (self._enc_bytes + self._agg_bytes) / (1024 * 1024), 2
                ),
                "max_mb": self._max_bytes // (1024 * 1024),
            }
