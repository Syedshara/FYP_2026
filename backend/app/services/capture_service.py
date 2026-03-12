"""
Packet capture & CICFlowMeter-like feature extraction service.

Pipeline:
    tcpdump (Docker network) → raw packets → flow aggregation → 78-feature vectors

Runs as an async background task while an attack is active.
The 78 features mirror CICFlowMeter / CIC-IDS2017 dataset columns used by the
CNN-LSTM model:
    Destination Port, Flow Duration, Total Fwd Packets, Total Backward Packets, …

Because we're inside the backend Docker container, we use `tcpdump -i any` to
capture on the virtual bridge network.  The subprocess writes pcap to a pipe;
we parse packets in near-real-time with dpkt (lightweight, no Scapy dependency
needed in the backend).
"""

from __future__ import annotations

import asyncio
import logging
import struct
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator

import numpy as np

log = logging.getLogger(__name__)

# ── Constants ────────────────────────────────────────────

CAPTURE_INTERFACE = "any"  # Docker bridge — captures all traffic
CAPTURE_SNAP_LEN = 96     # We only need headers, not payloads
FLOW_TIMEOUT_SEC = 120.0   # Max lifetime of a flow before forced export
IDLE_TIMEOUT_SEC = 30.0    # Idle timeout before a flow is exported
EXPORT_INTERVAL_SEC = 1.0  # How often to check for exportable flows
NUM_FEATURES = 78          # Must match settings.NUM_FEATURES

# CICFlowMeter 78 feature names (for reference / ordering)
FEATURE_NAMES = [
    "Destination Port", "Flow Duration", "Total Fwd Packets",
    "Total Backward Packets", "Total Length of Fwd Packets",
    "Total Length of Bwd Packets", "Fwd Packet Length Max",
    "Fwd Packet Length Min", "Fwd Packet Length Mean",
    "Fwd Packet Length Std", "Bwd Packet Length Max",
    "Bwd Packet Length Min", "Bwd Packet Length Mean",
    "Bwd Packet Length Std", "Flow Bytes/s", "Flow Packets/s",
    "Flow IAT Mean", "Flow IAT Std", "Flow IAT Max", "Flow IAT Min",
    "Fwd IAT Total", "Fwd IAT Mean", "Fwd IAT Std", "Fwd IAT Max",
    "Fwd IAT Min", "Bwd IAT Total", "Bwd IAT Mean", "Bwd IAT Std",
    "Bwd IAT Max", "Bwd IAT Min", "Fwd PSH Flags", "Bwd PSH Flags",
    "Fwd URG Flags", "Bwd URG Flags", "Fwd Header Length",
    "Bwd Header Length", "Fwd Packets/s", "Bwd Packets/s",
    "Min Packet Length", "Max Packet Length", "Packet Length Mean",
    "Packet Length Std", "Packet Length Variance", "FIN Flag Count",
    "SYN Flag Count", "RST Flag Count", "PSH Flag Count",
    "ACK Flag Count", "URG Flag Count", "CWE Flag Count",
    "ECE Flag Count", "Down/Up Ratio", "Average Packet Size",
    "Avg Fwd Segment Size", "Avg Bwd Segment Size",
    "Fwd Avg Bytes/Bulk", "Fwd Avg Packets/Bulk",
    "Fwd Avg Bulk Rate", "Bwd Avg Bytes/Bulk",
    "Bwd Avg Packets/Bulk", "Bwd Avg Bulk Rate",
    "Subflow Fwd Packets", "Subflow Fwd Bytes",
    "Subflow Bwd Packets", "Subflow Bwd Bytes",
    "Init_Win_bytes_forward", "Init_Win_bytes_backward",
    "act_data_pkt_fwd", "min_seg_size_forward",
    "Active Mean", "Active Std", "Active Max", "Active Min",
    "Idle Mean", "Idle Std", "Idle Max", "Idle Min",
    "Label",  # We fill this as 0 (placeholder — model ignores it or it's stripped)
]


# ── Flow tracking ────────────────────────────────────────

@dataclass
class FlowRecord:
    """Accumulates packet-level stats for a single 5-tuple flow."""
    src_ip: str
    dst_ip: str
    src_port: int
    dst_port: int
    protocol: int

    start_time: float = 0.0
    last_time: float = 0.0

    # Forward = src→dst, Backward = dst→src
    fwd_packet_lengths: list[int] = field(default_factory=list)
    bwd_packet_lengths: list[int] = field(default_factory=list)
    fwd_iats: list[float] = field(default_factory=list)
    bwd_iats: list[float] = field(default_factory=list)
    all_iats: list[float] = field(default_factory=list)

    fwd_header_lengths: list[int] = field(default_factory=list)
    bwd_header_lengths: list[int] = field(default_factory=list)

    # TCP flags (cumulative counts)
    fin_count: int = 0
    syn_count: int = 0
    rst_count: int = 0
    psh_count: int = 0
    ack_count: int = 0
    urg_count: int = 0
    cwe_count: int = 0
    ece_count: int = 0

    fwd_psh_flags: int = 0
    bwd_psh_flags: int = 0
    fwd_urg_flags: int = 0
    bwd_urg_flags: int = 0

    # Window sizes
    init_win_fwd: int = -1
    init_win_bwd: int = -1

    # Active/idle periods
    active_times: list[float] = field(default_factory=list)
    idle_times: list[float] = field(default_factory=list)

    _last_fwd_time: float = 0.0
    _last_bwd_time: float = 0.0
    _last_active_start: float = 0.0
    _is_active: bool = True

    def add_packet(
        self,
        timestamp: float,
        payload_len: int,
        header_len: int,
        is_forward: bool,
        tcp_flags: int = 0,
        window_size: int = 0,
    ) -> None:
        """Add a packet to this flow."""
        if self.start_time == 0:
            self.start_time = timestamp
            self._last_active_start = timestamp

        # IAT calculation
        if self.last_time > 0:
            iat = timestamp - self.last_time
            self.all_iats.append(iat)

            # Active/idle tracking (threshold: 1 second)
            if iat > 1.0:
                if self._is_active:
                    active_dur = self.last_time - self._last_active_start
                    if active_dur > 0:
                        self.active_times.append(active_dur)
                    self.idle_times.append(iat)
                    self._is_active = False
                else:
                    self.idle_times.append(iat)
                self._last_active_start = timestamp
                self._is_active = True
            else:
                self._is_active = True

        self.last_time = timestamp

        if is_forward:
            self.fwd_packet_lengths.append(payload_len)
            self.fwd_header_lengths.append(header_len)
            if self._last_fwd_time > 0:
                self.fwd_iats.append(timestamp - self._last_fwd_time)
            self._last_fwd_time = timestamp
            if self.init_win_fwd < 0:
                self.init_win_fwd = window_size

            if tcp_flags & 0x08:  # PSH
                self.fwd_psh_flags += 1
            if tcp_flags & 0x20:  # URG
                self.fwd_urg_flags += 1
        else:
            self.bwd_packet_lengths.append(payload_len)
            self.bwd_header_lengths.append(header_len)
            if self._last_bwd_time > 0:
                self.bwd_iats.append(timestamp - self._last_bwd_time)
            self._last_bwd_time = timestamp
            if self.init_win_bwd < 0:
                self.init_win_bwd = window_size

            if tcp_flags & 0x08:  # PSH
                self.bwd_psh_flags += 1
            if tcp_flags & 0x20:  # URG
                self.bwd_urg_flags += 1

        # Cumulative TCP flags
        if tcp_flags & 0x01:
            self.fin_count += 1
        if tcp_flags & 0x02:
            self.syn_count += 1
        if tcp_flags & 0x04:
            self.rst_count += 1
        if tcp_flags & 0x08:
            self.psh_count += 1
        if tcp_flags & 0x10:
            self.ack_count += 1
        if tcp_flags & 0x20:
            self.urg_count += 1
        if tcp_flags & 0x40:
            self.ece_count += 1
        if tcp_flags & 0x80:
            self.cwe_count += 1

    def to_feature_vector(self) -> np.ndarray:
        """Export this flow as a 78-dimensional feature vector."""
        duration = max(self.last_time - self.start_time, 1e-6)

        fwd_lens = self.fwd_packet_lengths or [0]
        bwd_lens = self.bwd_packet_lengths or [0]
        all_lens = fwd_lens + bwd_lens

        total_fwd_pkt = len(fwd_lens)
        total_bwd_pkt = len(bwd_lens)
        total_pkts = total_fwd_pkt + total_bwd_pkt

        total_fwd_bytes = sum(fwd_lens)
        total_bwd_bytes = sum(bwd_lens)
        total_bytes = total_fwd_bytes + total_bwd_bytes

        features = np.zeros(NUM_FEATURES, dtype=np.float64)

        features[0] = self.dst_port                                   # Destination Port
        features[1] = duration * 1e6                                  # Flow Duration (microseconds)
        features[2] = total_fwd_pkt                                   # Total Fwd Packets
        features[3] = total_bwd_pkt                                   # Total Backward Packets
        features[4] = total_fwd_bytes                                 # Total Length of Fwd Packets
        features[5] = total_bwd_bytes                                 # Total Length of Bwd Packets
        features[6] = max(fwd_lens)                                   # Fwd Packet Length Max
        features[7] = min(fwd_lens)                                   # Fwd Packet Length Min
        features[8] = _safe_mean(fwd_lens)                            # Fwd Packet Length Mean
        features[9] = _safe_std(fwd_lens)                             # Fwd Packet Length Std
        features[10] = max(bwd_lens)                                  # Bwd Packet Length Max
        features[11] = min(bwd_lens)                                  # Bwd Packet Length Min
        features[12] = _safe_mean(bwd_lens)                           # Bwd Packet Length Mean
        features[13] = _safe_std(bwd_lens)                            # Bwd Packet Length Std
        features[14] = total_bytes / duration if duration > 0 else 0  # Flow Bytes/s
        features[15] = total_pkts / duration if duration > 0 else 0   # Flow Packets/s

        all_iats = self.all_iats or [0]
        features[16] = _safe_mean(all_iats)                           # Flow IAT Mean
        features[17] = _safe_std(all_iats)                            # Flow IAT Std
        features[18] = max(all_iats)                                  # Flow IAT Max
        features[19] = min(all_iats)                                  # Flow IAT Min

        fwd_iats = self.fwd_iats or [0]
        features[20] = sum(fwd_iats)                                  # Fwd IAT Total
        features[21] = _safe_mean(fwd_iats)                           # Fwd IAT Mean
        features[22] = _safe_std(fwd_iats)                            # Fwd IAT Std
        features[23] = max(fwd_iats)                                  # Fwd IAT Max
        features[24] = min(fwd_iats)                                  # Fwd IAT Min

        bwd_iats = self.bwd_iats or [0]
        features[25] = sum(bwd_iats)                                  # Bwd IAT Total
        features[26] = _safe_mean(bwd_iats)                           # Bwd IAT Mean
        features[27] = _safe_std(bwd_iats)                            # Bwd IAT Std
        features[28] = max(bwd_iats)                                  # Bwd IAT Max
        features[29] = min(bwd_iats)                                  # Bwd IAT Min

        features[30] = self.fwd_psh_flags                             # Fwd PSH Flags
        features[31] = self.bwd_psh_flags                             # Bwd PSH Flags
        features[32] = self.fwd_urg_flags                             # Fwd URG Flags
        features[33] = self.bwd_urg_flags                             # Bwd URG Flags
        features[34] = sum(self.fwd_header_lengths)                   # Fwd Header Length
        features[35] = sum(self.bwd_header_lengths)                   # Bwd Header Length
        features[36] = total_fwd_pkt / duration if duration > 0 else 0  # Fwd Packets/s
        features[37] = total_bwd_pkt / duration if duration > 0 else 0  # Bwd Packets/s

        features[38] = min(all_lens)                                  # Min Packet Length
        features[39] = max(all_lens)                                  # Max Packet Length
        features[40] = _safe_mean(all_lens)                           # Packet Length Mean
        features[41] = _safe_std(all_lens)                            # Packet Length Std
        features[42] = _safe_var(all_lens)                            # Packet Length Variance

        features[43] = self.fin_count                                 # FIN Flag Count
        features[44] = self.syn_count                                 # SYN Flag Count
        features[45] = self.rst_count                                 # RST Flag Count
        features[46] = self.psh_count                                 # PSH Flag Count
        features[47] = self.ack_count                                 # ACK Flag Count
        features[48] = self.urg_count                                 # URG Flag Count
        features[49] = self.cwe_count                                 # CWE Flag Count
        features[50] = self.ece_count                                 # ECE Flag Count

        features[51] = total_bwd_pkt / total_fwd_pkt if total_fwd_pkt > 0 else 0  # Down/Up Ratio
        features[52] = total_bytes / total_pkts if total_pkts > 0 else 0           # Average Packet Size
        features[53] = _safe_mean(fwd_lens)                           # Avg Fwd Segment Size
        features[54] = _safe_mean(bwd_lens)                           # Avg Bwd Segment Size

        # Bulk features (simplified — set to 0 as CICFlowMeter often does)
        features[55] = 0  # Fwd Avg Bytes/Bulk
        features[56] = 0  # Fwd Avg Packets/Bulk
        features[57] = 0  # Fwd Avg Bulk Rate
        features[58] = 0  # Bwd Avg Bytes/Bulk
        features[59] = 0  # Bwd Avg Packets/Bulk
        features[60] = 0  # Bwd Avg Bulk Rate

        # Subflow features (1 subflow = the entire flow for simplicity)
        features[61] = total_fwd_pkt                                  # Subflow Fwd Packets
        features[62] = total_fwd_bytes                                # Subflow Fwd Bytes
        features[63] = total_bwd_pkt                                  # Subflow Bwd Packets
        features[64] = total_bwd_bytes                                # Subflow Bwd Bytes

        features[65] = max(self.init_win_fwd, 0)                     # Init_Win_bytes_forward
        features[66] = max(self.init_win_bwd, 0)                     # Init_Win_bytes_backward

        # act_data_pkt_fwd = packets with payload > 0 in forward direction
        features[67] = sum(1 for l in fwd_lens if l > 0)             # act_data_pkt_fwd
        features[68] = 20  # min_seg_size_forward (TCP header baseline)

        active = self.active_times or [0]
        features[69] = _safe_mean(active)                             # Active Mean
        features[70] = _safe_std(active)                              # Active Std
        features[71] = max(active)                                    # Active Max
        features[72] = min(active)                                    # Active Min

        idle = self.idle_times or [0]
        features[73] = _safe_mean(idle)                               # Idle Mean
        features[74] = _safe_std(idle)                                # Idle Std
        features[75] = max(idle)                                      # Idle Max
        features[76] = min(idle)                                      # Idle Min

        features[77] = 0  # Label placeholder (stripped before inference)

        # Replace any NaN/inf with 0
        features = np.nan_to_num(features, nan=0.0, posinf=0.0, neginf=0.0)

        return features


# ── Flow table ───────────────────────────────────────────

class FlowTable:
    """
    Tracks active network flows and exports completed ones as feature vectors.
    Thread-safe (single-threaded async, no lock needed).
    """

    def __init__(self) -> None:
        self._flows: dict[str, FlowRecord] = {}

    def _flow_key(self, src_ip: str, dst_ip: str, src_port: int, dst_port: int, proto: int) -> str:
        """Canonical flow key — direction-normalized."""
        a = (src_ip, src_port)
        b = (dst_ip, dst_port)
        if a > b:
            a, b = b, a
        return f"{a[0]}:{a[1]}-{b[0]}:{b[1]}-{proto}"

    def add_packet(
        self,
        timestamp: float,
        src_ip: str,
        dst_ip: str,
        src_port: int,
        dst_port: int,
        protocol: int,
        payload_len: int,
        header_len: int,
        tcp_flags: int = 0,
        window_size: int = 0,
    ) -> None:
        """Add a packet to the flow table."""
        key = self._flow_key(src_ip, dst_ip, src_port, dst_port, protocol)

        if key not in self._flows:
            # Determine forward direction: first packet seen defines it
            self._flows[key] = FlowRecord(
                src_ip=src_ip,
                dst_ip=dst_ip,
                src_port=src_port,
                dst_port=dst_port,
                protocol=protocol,
            )

        flow = self._flows[key]
        is_forward = (src_ip == flow.src_ip and src_port == flow.src_port)

        flow.add_packet(
            timestamp=timestamp,
            payload_len=payload_len,
            header_len=header_len,
            is_forward=is_forward,
            tcp_flags=tcp_flags,
            window_size=window_size,
        )

    def export_expired(self, now: float) -> list[np.ndarray]:
        """Export flows that have timed out (idle or max lifetime)."""
        expired_keys = []
        vectors = []

        for key, flow in self._flows.items():
            idle_time = now - flow.last_time
            lifetime = now - flow.start_time

            if idle_time > IDLE_TIMEOUT_SEC or lifetime > FLOW_TIMEOUT_SEC:
                expired_keys.append(key)
                total_pkts = len(flow.fwd_packet_lengths) + len(flow.bwd_packet_lengths)
                if total_pkts >= 2:  # Need at least 2 packets for meaningful features
                    vectors.append(flow.to_feature_vector())

        for key in expired_keys:
            del self._flows[key]

        return vectors

    def export_all(self) -> list[np.ndarray]:
        """Export all active flows (for final flush)."""
        vectors = []
        for flow in self._flows.values():
            total_pkts = len(flow.fwd_packet_lengths) + len(flow.bwd_packet_lengths)
            if total_pkts >= 2:
                vectors.append(flow.to_feature_vector())
        self._flows.clear()
        return vectors

    @property
    def active_flow_count(self) -> int:
        return len(self._flows)


# ── Packet parser (raw IP from tcpdump) ──────────────────

def parse_ip_packet(raw: bytes, timestamp: float, flow_table: FlowTable) -> None:
    """
    Parse a raw IP packet (from pcap) and add it to the flow table.
    Handles IPv4 TCP/UDP only (sufficient for attack detection).
    """
    if len(raw) < 20:
        return

    # Check for Linux cooked capture (SLL) header — 16 bytes
    # tcpdump -i any uses SLL encapsulation
    # SLL header: 2 (pkttype) + 2 (arphrd) + 2 (ll addr len) + 8 (ll addr) + 2 (protocol)
    # Protocol field at offset 14: 0x0800 = IPv4
    if len(raw) >= 16:
        proto_field = struct.unpack("!H", raw[14:16])[0] if len(raw) > 15 else 0
        if proto_field == 0x0800:
            raw = raw[16:]  # Strip SLL header
        elif raw[0] >> 4 != 4:
            # Not IPv4 and not SLL — try Ethernet
            if len(raw) >= 14:
                eth_proto = struct.unpack("!H", raw[12:14])[0]
                if eth_proto == 0x0800:
                    raw = raw[14:]  # Strip Ethernet header
                else:
                    return
            else:
                return

    if len(raw) < 20:
        return

    # IPv4 header
    version_ihl = raw[0]
    version = version_ihl >> 4
    if version != 4:
        return

    ihl = (version_ihl & 0x0F) * 4
    total_length = struct.unpack("!H", raw[2:4])[0]
    protocol = raw[9]

    src_ip = f"{raw[12]}.{raw[13]}.{raw[14]}.{raw[15]}"
    dst_ip = f"{raw[16]}.{raw[17]}.{raw[18]}.{raw[19]}"

    if protocol == 6 and len(raw) >= ihl + 20:  # TCP
        tcp_header = raw[ihl:]
        src_port = struct.unpack("!H", tcp_header[0:2])[0]
        dst_port = struct.unpack("!H", tcp_header[2:4])[0]
        tcp_data_offset = ((tcp_header[12] >> 4) * 4)
        tcp_flags = tcp_header[13]
        window_size = struct.unpack("!H", tcp_header[14:16])[0]
        payload_len = total_length - ihl - tcp_data_offset
        header_len = ihl + tcp_data_offset

        flow_table.add_packet(
            timestamp=timestamp,
            src_ip=src_ip, dst_ip=dst_ip,
            src_port=src_port, dst_port=dst_port,
            protocol=protocol,
            payload_len=max(payload_len, 0),
            header_len=header_len,
            tcp_flags=tcp_flags,
            window_size=window_size,
        )

    elif protocol == 17 and len(raw) >= ihl + 8:  # UDP
        udp_header = raw[ihl:]
        src_port = struct.unpack("!H", udp_header[0:2])[0]
        dst_port = struct.unpack("!H", udp_header[2:4])[0]
        udp_length = struct.unpack("!H", udp_header[4:6])[0]
        payload_len = udp_length - 8
        header_len = ihl + 8

        flow_table.add_packet(
            timestamp=timestamp,
            src_ip=src_ip, dst_ip=dst_ip,
            src_port=src_port, dst_port=dst_port,
            protocol=protocol,
            payload_len=max(payload_len, 0),
            header_len=header_len,
        )

    elif protocol == 1:  # ICMP — treat as flow with port=0
        payload_len = total_length - ihl
        flow_table.add_packet(
            timestamp=timestamp,
            src_ip=src_ip, dst_ip=dst_ip,
            src_port=0, dst_port=0,
            protocol=protocol,
            payload_len=max(payload_len, 0),
            header_len=ihl,
        )


# ── Capture runner ───────────────────────────────────────

async def capture_packets(
    stop_event: asyncio.Event,
    interface: str = CAPTURE_INTERFACE,
    snap_len: int = CAPTURE_SNAP_LEN,
) -> AsyncGenerator[list[np.ndarray], None]:
    """
    Async generator that captures packets via tcpdump and yields batches
    of 78-feature vectors (one per exported flow).

    Usage:
        stop = asyncio.Event()
        async for feature_batch in capture_packets(stop):
            for vec in feature_batch:
                # vec is np.ndarray shape (78,)
                ...

    Stops when stop_event is set.
    """
    flow_table = FlowTable()

    # tcpdump flags:
    #   -i any       : capture on all interfaces
    #   -U           : packet-buffered output (no delay)
    #   -w -         : write pcap to stdout
    #   -s <snap>    : snap length
    #   --immediate-mode : don't buffer
    cmd = [
        "tcpdump", "-i", interface, "-U", "-w", "-",
        "-s", str(snap_len), "--immediate-mode",
        "ip",  # Only capture IPv4
    ]

    log.info("Starting packet capture: %s", " ".join(cmd))

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        log.error("tcpdump not found — packet capture unavailable")
        return
    except PermissionError:
        log.error("Permission denied for tcpdump — need NET_RAW capability")
        return

    try:
        # Read pcap global header (24 bytes)
        global_header = await _read_exact(proc.stdout, 24)
        if global_header is None:
            log.error("Failed to read pcap global header")
            return

        magic = struct.unpack("<I", global_header[0:4])[0]
        if magic == 0xA1B2C3D4:
            byte_order = "<"
        elif magic == 0xD4C3B2A1:
            byte_order = ">"
        else:
            log.error("Invalid pcap magic: 0x%08X", magic)
            return

        link_type = struct.unpack(f"{byte_order}I", global_header[20:24])[0]
        log.info("Pcap capture started (link_type=%d)", link_type)

        last_export = time.monotonic()

        while not stop_event.is_set():
            # Read pcap packet header (16 bytes)
            try:
                pkt_header = await asyncio.wait_for(
                    _read_exact(proc.stdout, 16),
                    timeout=EXPORT_INTERVAL_SEC,
                )
            except asyncio.TimeoutError:
                # No packet within interval — check for exportable flows
                now = time.monotonic()
                if now - last_export >= EXPORT_INTERVAL_SEC:
                    vectors = flow_table.export_expired(now)
                    if vectors:
                        yield vectors
                    last_export = now
                continue

            if pkt_header is None:
                break  # EOF — tcpdump exited

            ts_sec = struct.unpack(f"{byte_order}I", pkt_header[0:4])[0]
            ts_usec = struct.unpack(f"{byte_order}I", pkt_header[4:8])[0]
            incl_len = struct.unpack(f"{byte_order}I", pkt_header[8:12])[0]
            # orig_len = struct.unpack(f"{byte_order}I", pkt_header[12:16])[0]

            timestamp = ts_sec + ts_usec / 1e6

            # Read packet data
            pkt_data = await _read_exact(proc.stdout, incl_len)
            if pkt_data is None:
                break

            # Parse and add to flow table
            try:
                parse_ip_packet(pkt_data, timestamp, flow_table)
            except Exception:
                pass  # Skip malformed packets silently

            # Periodically export expired flows
            now = time.monotonic()
            if now - last_export >= EXPORT_INTERVAL_SEC:
                vectors = flow_table.export_expired(now)
                if vectors:
                    yield vectors
                last_export = now

    finally:
        # Stop tcpdump
        try:
            proc.terminate()
            await asyncio.wait_for(proc.wait(), timeout=5)
        except Exception:
            proc.kill()

        # Final flush — export all remaining flows
        vectors = flow_table.export_all()
        if vectors:
            yield vectors

        log.info("Packet capture stopped (exported %d final flows)", len(vectors))


async def _read_exact(stream: asyncio.StreamReader | None, n: int) -> bytes | None:
    """Read exactly n bytes from an async stream. Returns None on EOF."""
    if stream is None:
        return None
    data = b""
    while len(data) < n:
        chunk = await stream.read(n - len(data))
        if not chunk:
            return None
        data += chunk
    return data


# ── Helpers ──────────────────────────────────────────────

def _safe_mean(vals: list) -> float:
    return float(np.mean(vals)) if vals else 0.0

def _safe_std(vals: list) -> float:
    return float(np.std(vals)) if len(vals) > 1 else 0.0

def _safe_var(vals: list) -> float:
    return float(np.var(vals)) if len(vals) > 1 else 0.0
