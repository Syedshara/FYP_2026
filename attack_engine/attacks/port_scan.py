"""
Port scanning module — SYN scan, UDP scan, stealth (FIN/NULL/Xmas) scan.
"""

from __future__ import annotations

import logging
import time

from scapy.all import IP, TCP, UDP, ICMP, sr1, RandShort, conf

log = logging.getLogger(__name__)

# Suppress Scapy warnings for unanswered packets
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
        raise ValueError(f"Unknown port-scan sub_type: {sub_type!r}")
    return handler(target_ip, target_port, duration, rate_multiplier, params)


def _parse_port_range(port_str: str) -> list[int]:
    """Parse '1-1024' or '22,80,443' into a list of port numbers."""
    ports = []
    for part in port_str.split(","):
        part = part.strip()
        if "-" in part:
            lo, hi = part.split("-", 1)
            ports.extend(range(int(lo), int(hi) + 1))
        else:
            ports.append(int(part))
    return ports


# ── SYN Scan ─────────────────────────────────────────────

@_register("syn_scan")
def syn_scan(
    target_ip: str,
    target_port: int,
    duration: float,
    rate_multiplier: float,
    params: dict,
) -> dict:
    """Half-open TCP SYN scan — send SYN, check for SYN-ACK."""
    port_range = params.get("port_range", "1-1024")
    base_rate = params.get("rate", 100)
    pps = int(base_rate * rate_multiplier)
    ports = _parse_port_range(port_range)

    log.info("SYN scan → %s ports %s at ~%d pps", target_ip, port_range, pps)

    packets_sent = 0
    open_ports = []
    closed_ports = 0
    filtered_ports = 0
    deadline = time.time() + duration

    for port in ports:
        if time.time() >= deadline:
            break

        pkt = IP(dst=target_ip) / TCP(sport=RandShort(), dport=port, flags="S")
        resp = sr1(pkt, timeout=0.5, verbose=False)
        packets_sent += 1

        if resp is not None:
            if resp.haslayer(TCP):
                if resp[TCP].flags == 0x12:  # SYN-ACK → open
                    open_ports.append(port)
                elif resp[TCP].flags == 0x14:  # RST-ACK → closed
                    closed_ports += 1
            elif resp.haslayer(ICMP):
                filtered_ports += 1
        else:
            filtered_ports += 1

        time.sleep(1.0 / max(pps, 1))

    return {
        "packets_sent": packets_sent,
        "attack": "syn_scan",
        "open_ports": open_ports,
        "closed_ports": closed_ports,
        "filtered_ports": filtered_ports,
    }


# ── UDP Scan ─────────────────────────────────────────────

@_register("udp_scan")
def udp_scan(
    target_ip: str,
    target_port: int,
    duration: float,
    rate_multiplier: float,
    params: dict,
) -> dict:
    """UDP port scan — send empty UDP datagrams, check for ICMP unreachable."""
    port_range = params.get("port_range", "1-1024")
    base_rate = params.get("rate", 50)
    pps = int(base_rate * rate_multiplier)
    ports = _parse_port_range(port_range)

    log.info("UDP scan → %s ports %s at ~%d pps", target_ip, port_range, pps)

    packets_sent = 0
    open_ports = []
    closed_ports = 0
    deadline = time.time() + duration

    for port in ports:
        if time.time() >= deadline:
            break

        pkt = IP(dst=target_ip) / UDP(sport=RandShort(), dport=port)
        resp = sr1(pkt, timeout=1.0, verbose=False)
        packets_sent += 1

        if resp is None:
            open_ports.append(port)  # no response = open|filtered
        elif resp.haslayer(ICMP):
            if resp[ICMP].type == 3 and resp[ICMP].code == 3:
                closed_ports += 1  # port unreachable

        time.sleep(1.0 / max(pps, 1))

    return {
        "packets_sent": packets_sent,
        "attack": "udp_scan",
        "open_or_filtered_ports": open_ports,
        "closed_ports": closed_ports,
    }


# ── Stealth Scan (FIN / NULL / Xmas) ────────────────────

@_register("stealth_scan")
def stealth_scan(
    target_ip: str,
    target_port: int,
    duration: float,
    rate_multiplier: float,
    params: dict,
) -> dict:
    """
    Stealth scan using non-standard TCP flags to evade simple firewalls.
    scan_type: 'fin' (FIN flag), 'null' (no flags), 'xmas' (FIN+PSH+URG).
    """
    scan_type = params.get("scan_type", "fin")
    port_range = params.get("port_range", "1-1024")
    base_rate = params.get("rate", 80)
    pps = int(base_rate * rate_multiplier)
    ports = _parse_port_range(port_range)

    flags_map = {"fin": "F", "null": "", "xmas": "FPU"}
    flags = flags_map.get(scan_type, "F")

    log.info("Stealth scan (%s) → %s ports %s at ~%d pps", scan_type, target_ip, port_range, pps)

    packets_sent = 0
    open_ports = []
    closed_ports = 0
    deadline = time.time() + duration

    for port in ports:
        if time.time() >= deadline:
            break

        pkt = IP(dst=target_ip) / TCP(sport=RandShort(), dport=port, flags=flags)
        resp = sr1(pkt, timeout=0.5, verbose=False)
        packets_sent += 1

        if resp is None:
            open_ports.append(port)  # no response = open|filtered
        elif resp.haslayer(TCP) and resp[TCP].flags == 0x14:
            closed_ports += 1  # RST → closed

        time.sleep(1.0 / max(pps, 1))

    return {
        "packets_sent": packets_sent,
        "attack": f"stealth_{scan_type}",
        "open_or_filtered_ports": open_ports,
        "closed_ports": closed_ports,
    }
