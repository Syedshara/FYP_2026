"""
Monitoring loop — runs inside the FL client container in MONITOR mode.

Workflow:
  1. Resolve this client's DB record (auto‑register if missing)
  2. Fetch device list (auto‑create a virtual device if the client has none)
  3. Replay real CIC‑IDS2017 data via ReplaySimulator
  4. Run local CNN‑LSTM inference on each 10‑flow window
  5. POST prediction results back to the backend

Supports two data sources:
  • **Client data** (default): .npy files from the client's training partition
  • **Scenario data**: pre‑built scenario packs (ddos_attack, portscan, …)

Env vars
--------
CLIENT_ID        : str   — e.g. "bank_a"
BACKEND_URL      : str   — e.g. "http://iot_ids_backend:8000"
MONITOR_INTERVAL : float — seconds between prediction cycles (default 1.0)
SCENARIO         : str   — scenario name (optional; uses client data if unset)
REPLAY_SPEED     : float — replay speed multiplier (default 1.0)
REPLAY_LOOP      : bool  — loop replay when exhausted (default true)
REPLAY_SHUFFLE   : bool  — shuffle window order (default true)
SCENARIO_DIR     : str   — base path for scenario data (default /app/scenarios)
MAX_DURATION     : int   — maximum run time in seconds (0 = unlimited)
"""

from __future__ import annotations

import os
import sys
import time
import logging
import asyncio
from pathlib import Path
from typing import Optional

import numpy as np
import torch
import httpx

# Shared model definition
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from fl_common.model import CNN_LSTM_IDS, DEFAULT_CONFIG
from replay_simulator import ReplaySimulator, WINDOW_SIZE, NUM_FEATURES
from synthetic_generator import SyntheticGenerator

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(message)s")
log = logging.getLogger("monitor")

# ── Config from env ──────────────────────────────────────
CLIENT_ID        = os.environ.get("CLIENT_ID", "client_0")
BACKEND_URL      = os.environ.get("BACKEND_URL", "http://iot_ids_backend:8000")
MONITOR_INTERVAL = float(os.environ.get("MONITOR_INTERVAL", "1.0"))
MODEL_DIR        = os.environ.get("MODEL_DIR", "/app/models")
SCENARIO         = os.environ.get("SCENARIO", "")
REPLAY_SPEED     = float(os.environ.get("REPLAY_SPEED", "1.0"))
REPLAY_LOOP      = os.environ.get("REPLAY_LOOP", "true").lower() in ("true", "1", "yes")
REPLAY_SHUFFLE   = os.environ.get("REPLAY_SHUFFLE", "true").lower() in ("true", "1", "yes")
SCENARIO_BASE    = os.environ.get("SCENARIO_DIR", "/app/scenarios")
DATA_DIR         = os.environ.get("DATA_PATH", "/app/data")
MAX_DURATION     = int(os.environ.get("MAX_DURATION", "0"))

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
SEQ_LEN   = DEFAULT_CONFIG["SEQUENCE_LENGTH"]
THRESHOLD = DEFAULT_CONFIG["THRESHOLD"]


# ── Model loading ────────────────────────────────────────

def _find_model() -> Optional[str]:
    """Find the best available model checkpoint."""
    candidates = [
        os.path.join(MODEL_DIR, "global_final.pt"),
        os.path.join(MODEL_DIR, "cnn_lstm_global_with_HE_25rounds_16k.pt"),
    ]
    for p in candidates:
        if os.path.isfile(p):
            return p
    if os.path.isdir(MODEL_DIR):
        for fname in sorted(os.listdir(MODEL_DIR)):
            if fname.endswith(".pt"):
                return os.path.join(MODEL_DIR, fname)
    return None


def load_model() -> CNN_LSTM_IDS:
    """Load the CNN‑LSTM model from the best available checkpoint."""
    model_path = _find_model()
    if model_path is None:
        log.warning("No model checkpoint found — using randomly initialised model")
        model = CNN_LSTM_IDS(SEQ_LEN, NUM_FEATURES).to(DEVICE)
        model.eval()
        return model

    model = CNN_LSTM_IDS(SEQ_LEN, NUM_FEATURES).to(DEVICE)
    state = torch.load(model_path, map_location=DEVICE, weights_only=True)
    model.load_state_dict(state)
    model.eval()
    log.info("Loaded model from %s", model_path)
    return model


# ── Inference ────────────────────────────────────────────

def run_local_inference(model: CNN_LSTM_IDS, window: np.ndarray) -> dict:
    """Run inference on a single (10, 78) window and return result dict."""
    t0 = time.perf_counter()
    tensor = torch.from_numpy(window).unsqueeze(0).to(DEVICE)

    with torch.no_grad():
        logit = model(tensor).squeeze()
        prob = torch.sigmoid(logit).item()

    latency = (time.perf_counter() - t0) * 1000
    label = "attack" if prob >= THRESHOLD else "benign"
    confidence = prob if label == "attack" else 1.0 - prob

    return {
        "score": round(prob, 6),
        "label": label,
        "confidence": round(confidence, 6),
        "inference_latency_ms": round(latency, 2),
    }


# ── Backend API helpers ──────────────────────────────────

async def fetch_client_info(http: httpx.AsyncClient) -> Optional[dict]:
    """Fetch this client's DB record by client_id string."""
    try:
        r = await http.get(
            f"{BACKEND_URL}/api/v1/internal/client/by-client-id/{CLIENT_ID}",
        )
        r.raise_for_status()
        return r.json()
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            return None
        log.error("Client lookup failed: %s", exc)
        return None
    except Exception as exc:
        log.error("Client lookup failed: %s", exc)
        return None


async def auto_register_client(http: httpx.AsyncClient) -> Optional[dict]:
    """Auto‑register this client in the backend DB if it doesn't exist."""
    friendly = CLIENT_ID.replace("_", " ").title()
    try:
        # Use the public FL client endpoint (requires no auth token for
        # internal service‑to‑service calls inside the Docker network)
        r = await http.post(
            f"{BACKEND_URL}/api/v1/internal/client/register",
            json={
                "client_id": CLIENT_ID,
                "name": friendly,
                "description": f"Auto‑registered by simulation ({CLIENT_ID})",
            },
        )
        if r.status_code in (200, 201):
            log.info("Auto‑registered client '%s'", CLIENT_ID)
            return r.json()
        # If 409 conflict, it already exists — just fetch again
        if r.status_code == 409:
            return await fetch_client_info(http)
        log.error("Auto‑register returned %d: %s", r.status_code, r.text[:200])
        return None
    except Exception as exc:
        log.error("Auto‑register failed: %s", exc)
        return None


async def fetch_devices(http: httpx.AsyncClient, client_db_id: int) -> list[dict]:
    """Fetch devices assigned to this FL client from the backend."""
    try:
        r = await http.get(
            f"{BACKEND_URL}/api/v1/internal/client/{client_db_id}/devices",
        )
        r.raise_for_status()
        return r.json()
    except Exception as exc:
        log.error("Failed to fetch devices: %s", exc)
        return []


async def create_virtual_device(
    http: httpx.AsyncClient, client_db_id: int,
) -> Optional[dict]:
    """Create a virtual device for a client that has none."""
    friendly = CLIENT_ID.replace("_", " ").title()
    try:
        r = await http.post(
            f"{BACKEND_URL}/api/v1/internal/device/create",
            json={
                "name": f"{friendly} Sensor 1",
                "device_type": "sensor",
                "protocol": "tcp",
                "port": 0,
                "traffic_source": "simulated",
                "client_id": client_db_id,
                "description": f"Virtual device auto‑created for simulation ({CLIENT_ID})",
            },
        )
        if r.status_code in (200, 201):
            log.info("Created virtual device for client %s", CLIENT_ID)
            return r.json()
        log.warning("Virtual device creation returned %d: %s", r.status_code, r.text[:200])
        return None
    except Exception as exc:
        log.error("Virtual device creation failed: %s", exc)
        return None


async def post_prediction(
    http: httpx.AsyncClient,
    device_id: str,
    client_db_id: int,
    result: dict,
) -> bool:
    """POST prediction result to the backend internal endpoint."""
    payload = {
        "device_id": device_id,
        "client_id": client_db_id,
        "score": result["score"],
        "label": result["label"],
        "confidence": result["confidence"],
        "inference_latency_ms": result["inference_latency_ms"],
        "model_version": "local",
        "attack_type": SCENARIO if SCENARIO else None,
    }
    try:
        r = await http.post(
            f"{BACKEND_URL}/api/v1/internal/predictions",
            json=payload,
        )
        r.raise_for_status()
        return True
    except Exception as exc:
        log.error("Prediction POST failed: %s", exc)
        return False


# ── Main monitoring loop ────────────────────────────────

async def monitor_loop(stop_event: asyncio.Event | None = None):
    """
    Main loop: resolve client → fetch devices → replay + infer → POST.

    Runs until stop_event is set, data is exhausted (non‑loop), or
    MAX_DURATION seconds have elapsed.
    """
    model = load_model()

    # ── Determine data source ────────────────────
    # Use SyntheticGenerator for scenario-based simulation (infinite supply),
    # fall back to ReplaySimulator only for client_data mode.
    if SCENARIO and SCENARIO != "client_data":
        profiles_path = os.path.join(SCENARIO_BASE, "_profiles.json")
        simulator = SyntheticGenerator(
            scenario=SCENARIO,
            profiles_path=profiles_path if os.path.isfile(profiles_path) else None,
        )
        log.info("Using SYNTHETIC generator for scenario: %s", SCENARIO)
    else:
        simulator = ReplaySimulator(
            data_dir=DATA_DIR,
            scenario_dir=None,
            loop=REPLAY_LOOP,
            shuffle=REPLAY_SHUFFLE,
        )
        log.info("Using REPLAY simulator with client data from %s", DATA_DIR)

    effective_interval = MONITOR_INTERVAL / max(REPLAY_SPEED, 0.1)
    start_time = time.time()

    log.info(
        "Monitor starting: client=%s  interval=%.2fs  speed=%.1fx  "
        "scenario=%s  windows=%d  max_duration=%s",
        CLIENT_ID, effective_interval, REPLAY_SPEED,
        SCENARIO or "client_data", simulator.total_windows,
        f"{MAX_DURATION}s" if MAX_DURATION > 0 else "unlimited",
    )

    async with httpx.AsyncClient(timeout=10.0) as http:
        # ── Resolve client DB id ─────────────────
        client_info = await fetch_client_info(http)
        if client_info is None:
            log.info("Client '%s' not registered — auto‑registering…", CLIENT_ID)
            client_info = await auto_register_client(http)

        # Retry loop if backend is still booting
        retries = 0
        while client_info is None and retries < 12:
            retries += 1
            log.warning("Waiting for client '%s' to be available (attempt %d/12)…", CLIENT_ID, retries)
            await asyncio.sleep(5)
            client_info = await fetch_client_info(http)
            if client_info is None:
                client_info = await auto_register_client(http)
            if stop_event and stop_event.is_set():
                return

        if client_info is None:
            log.error("Could not resolve client '%s' after retries — aborting", CLIENT_ID)
            return

        client_db_id = client_info["id"]
        log.info("Resolved client '%s' → DB id=%d", CLIENT_ID, client_db_id)

        # ── Fetch devices (must exist — no auto-creation) ─
        devices = await fetch_devices(http, client_db_id)
        if not devices:
            log.error(
                "No devices registered for client '%s' (db_id=%d). "
                "Register devices before running simulation.",
                CLIENT_ID, client_db_id,
            )
            return

        log.info("Monitoring %d device(s): %s",
                 len(devices),
                 ", ".join(d.get("name", str(d["id"])[:8]) for d in devices))

        # ── Main prediction loop ─────────────────
        cycle = 0
        while not (stop_event and stop_event.is_set()):
            cycle += 1

            # Duration limit
            if MAX_DURATION > 0 and (time.time() - start_time) >= MAX_DURATION:
                log.info("MAX_DURATION (%ds) reached — stopping", MAX_DURATION)
                break

            # Refresh device list every 30 cycles
            if cycle % 30 == 0:
                refreshed = await fetch_devices(http, client_db_id)
                if refreshed:
                    devices = refreshed

            # Exhaustion check (non‑loop mode)
            if simulator.exhausted:
                log.info("Replay data exhausted — stopping monitor")
                break

            # For each device: get next window → infer → POST
            for device in devices:
                device_id = device["id"]
                device_name = device.get("name", str(device_id)[:8])

                window, true_label, attack_frac = simulator.get_next_window()
                result = run_local_inference(model, window)

                # Enrich result for logging
                result["true_label"] = "attack" if true_label == 1 else "benign"
                result["replay_progress"] = simulator.progress
                result["attack_type"] = SCENARIO if SCENARIO else None

                ok = await post_prediction(http, device_id, client_db_id, result)

                log.info(
                    "[%s] dev=%s  pred=%-6s  truth=%-6s  score=%.4f  "
                    "conf=%.4f  lat=%.1fms  prog=%.0f%%  %s",
                    CLIENT_ID, device_name[:16],
                    result["label"], result["true_label"],
                    result["score"], result["confidence"],
                    result["inference_latency_ms"],
                    simulator.progress * 100,
                    "✓" if ok else "✗",
                )

            # Sleep between cycles
            try:
                await asyncio.sleep(effective_interval)
            except asyncio.CancelledError:
                break

    elapsed = time.time() - start_time
    log.info(
        "Monitor stopped: client=%s  cycles=%d  replayed=%d  elapsed=%.0fs",
        CLIENT_ID, cycle, simulator.total_replayed, elapsed,
    )


def run_monitor():
    """Entry point — runs the async monitor loop."""
    asyncio.run(monitor_loop())
