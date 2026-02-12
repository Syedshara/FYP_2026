"""
Synthetic traffic simulation service for backend.

Generates synthetic network flows with temporal attack patterns based on
CIC-IDS2017 statistics, then runs REAL inference using the trained model.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Optional, Dict, Any
from pathlib import Path
import numpy as np

from app.core.websocket import ws_manager, WSMessageType, build_ws_message
from app.services.prediction_service import run_inference  # IMPORT REAL INFERENCE

log = logging.getLogger("synthetic_simulation")

# Feature indices matching CIC-IDS2017
FEATURE_IDX = {
    "fwd_packets": 0,
    "bwd_packets": 1,
    "fwd_length": 2,
    "bwd_length": 3,
    "flow_duration": 4,
    "flow_iat_mean": 5,
    "fwd_packets_sec": 6,
    "bwd_packets_sec": 7,
    "packet_length_mean": 8,
    "packet_length_std": 9,
    "flow_iat_std": 10,
    "flow_iat_max": 11,
    "fwd_iat_mean": 12,
    "fin_flag": 20,
    "syn_flag": 21,
    "rst_flag": 22,
    "psh_flag": 23,
    "ack_flag": 24,
    "urg_flag": 25,
}

NUM_FEATURES = 78
WINDOW_SIZE = 10


class SyntheticTrafficGenerator:
    """Generate realistic synthetic network traffic based on CIC-IDS2017 patterns."""
    
    def __init__(self, rng: Optional[np.random.Generator] = None):
        self.rng = rng if rng is not None else np.random.default_rng()
        self._benign_baseline = self._create_benign_baseline()
    
    def _create_benign_baseline(self) -> np.ndarray:
        """Baseline benign flow from CIC-IDS2017 statistics."""
        flow = np.zeros(NUM_FEATURES, dtype=np.float32)
        flow[FEATURE_IDX["fwd_packets"]] = 10.0
        flow[FEATURE_IDX["bwd_packets"]] = 8.0
        flow[FEATURE_IDX["fwd_length"]] = 500.0
        flow[FEATURE_IDX["bwd_length"]] = 400.0
        flow[FEATURE_IDX["flow_duration"]] = 1000.0
        flow[FEATURE_IDX["flow_iat_mean"]] = 100.0
        flow[FEATURE_IDX["fwd_packets_sec"]] = 10.0
        flow[FEATURE_IDX["bwd_packets_sec"]] = 8.0
        flow[FEATURE_IDX["packet_length_mean"]] = 50.0
        flow[FEATURE_IDX["packet_length_std"]] = 20.0
        flow[FEATURE_IDX["flow_iat_max"]] = 500.0
        flow[FEATURE_IDX["fwd_iat_mean"]] = 100.0
        flow[FEATURE_IDX["syn_flag"]] = 2.0
        flow[FEATURE_IDX["ack_flag"]] = 10.0
        return flow
    
    def _generate_benign_flow(self) -> np.ndarray:
        """Generate benign flow with natural variation."""
        flow = self._benign_baseline.copy()
        noise = self.rng.normal(0, 0.05, NUM_FEATURES)
        flow = flow * (1 + noise)
        return np.maximum(flow, 0).astype(np.float32)
    
    def _generate_ddos_flow(self, intensity: float) -> np.ndarray:
        """
        DDoS attack based on CIC-IDS2017 DoS Hulk pattern.
        Key: Extremely high packet rates, flood characteristics.
        """
        flow = np.zeros(NUM_FEATURES, dtype=np.float32)
        
        # Massive packet flood
        flow[FEATURE_IDX["fwd_packets"]] = 10 + (1400 * intensity)      # 10 → 1410
        flow[FEATURE_IDX["bwd_packets"]] = 8 + (992 * intensity)        # 8 → 1000
        flow[FEATURE_IDX["fwd_length"]] = 500 + (149500 * intensity)    # 500 → 150000
        flow[FEATURE_IDX["bwd_length"]] = 400 + (79600 * intensity)     # 400 → 80000
        flow[FEATURE_IDX["flow_duration"]] = 1000 + (4000 * intensity)  # 1s → 5s
        flow[FEATURE_IDX["flow_iat_mean"]] = 100 - (90 * intensity)     # 100ms → 10ms
        
        # CRITICAL: Packet rate explosion
        flow[FEATURE_IDX["fwd_packets_sec"]] = 10 + (1990 * intensity)  # 10 → 2000 (200x)
        flow[FEATURE_IDX["bwd_packets_sec"]] = 8 + (1492 * intensity)   # 8 → 1500 (187x)
        
        flow[FEATURE_IDX["packet_length_mean"]] = 50 + (50 * intensity)
        flow[FEATURE_IDX["packet_length_std"]] = 20 + (30 * intensity)
        flow[FEATURE_IDX["flow_iat_max"]] = 500 + (500 * intensity)
        flow[FEATURE_IDX["syn_flag"]] = 2 + (48 * intensity)            # Many connections
        flow[FEATURE_IDX["ack_flag"]] = 10 + (40 * intensity)
        
        # Add realistic noise
        noise = self.rng.normal(0, 0.05, NUM_FEATURES)
        flow = flow * (1 + noise)
        
        return np.maximum(flow, 0).astype(np.float32)
    
    def _generate_portscan_flow(self, intensity: float) -> np.ndarray:
        """
        Port Scan attack based on CIC-IDS2017 PortScan pattern.
        
        PortScan characteristics (matching Colab rules):
        - Many connections to different ports (high SYN flags)
        - Small packet sizes (probes)
        - Low ACK response (rejected connections)
        - Rapid scanning pattern
        """
        flow = np.zeros(NUM_FEATURES, dtype=np.float32)
        
        # Scanning = many small probe packets (key: more packets but still smaller than DDOS)
        flow[FEATURE_IDX["fwd_packets"]] = 5 + (195 * intensity)        # 5 → 200 (many probes)
        flow[FEATURE_IDX["bwd_packets"]] = 2 + (8 * intensity)          # 2 → 10 (few responses)
        
        # Small packet volumes (probes are small) - This is CRITICAL for portscan vs DDOS
        flow[FEATURE_IDX["fwd_length"]] = 200 + (3800 * intensity)      # 200 → 4000 (small probes)
        flow[FEATURE_IDX["bwd_length"]] = 150 + (2850 * intensity)      # 150 → 3000 (small responses)
        
        # Moderate to fast packet rates (scanning speed)
        flow[FEATURE_IDX["fwd_packets_sec"]] = 50 + (150 * intensity)   # 50 → 200 packets/sec
        flow[FEATURE_IDX["bwd_packets_sec"]] = 30 + (110 * intensity)   # 30 → 140
        
        # Short to moderate duration (quick scan)
        flow[FEATURE_IDX["flow_duration"]] = 500 - (300 * intensity)    # 500ms → 200ms (quick)
        
        # Small packets in probe
        flow[FEATURE_IDX["packet_length_mean"]] = 40 + (20 * intensity) # 40-60 bytes (tiny)
        flow[FEATURE_IDX["packet_length_std"]] = 10 + (10 * intensity)  # 10-20
        
        # Low IAT (rapid scanning)
        flow[FEATURE_IDX["flow_iat_mean"]] = 20 + (10 * intensity)      # 20-30ms between packets
        flow[FEATURE_IDX["flow_iat_max"]] = 100 + (50 * intensity)      # 100-150ms max
        
        # CRITICAL: HIGH SYN flags (connection attempts) - DIAGNOSTIC FEATURE FOR PORTSCAN
        flow[FEATURE_IDX["syn_flag"]] = 10 + (90 * intensity)           # 10 → 100 (HIGH for port probing)
        flow[FEATURE_IDX["ack_flag"]] = 5 - (4 * intensity)             # 5 → 1 (LOW - rejected connections)
        flow[FEATURE_IDX["rst_flag"]] = 2 + (3 * intensity)             # 2 → 5 (reset responses)
        
        # Add realistic noise
        noise = self.rng.normal(0, 0.08, NUM_FEATURES)
        flow = flow * (1 + noise)
        
        return np.maximum(flow, 0).astype(np.float32)
    
    def _generate_slowloris_flow(self, intensity: float) -> np.ndarray:
        """
        Slowloris (DoS Slowloris) based on CIC-IDS2017.
        Key: Very long duration, slow transmission, low packet rate.
        """
        flow = np.zeros(NUM_FEATURES, dtype=np.float32)
        
        # Few packets
        flow[FEATURE_IDX["fwd_packets"]] = 2 + (18 * intensity)         # 2 → 20
        flow[FEATURE_IDX["bwd_packets"]] = 1 + (14 * intensity)
        flow[FEATURE_IDX["fwd_length"]] = 500 + (4500 * intensity)
        flow[FEATURE_IDX["bwd_length"]] = 300 + (2700 * intensity)
        
        # CRITICAL: Very long duration
        flow[FEATURE_IDX["flow_duration"]] = 10000 + (110000 * intensity)  # 10s → 120s
        flow[FEATURE_IDX["flow_iat_mean"]] = 1000 + (9000 * intensity)     # 1s → 10s
        flow[FEATURE_IDX["flow_iat_max"]] = 15000 + (135000 * intensity)   # Very long pauses
        flow[FEATURE_IDX["fwd_iat_mean"]] = 2000 + (18000 * intensity)
        
        # Very slow rate
        flow[FEATURE_IDX["fwd_packets_sec"]] = 2 - (1.8 * intensity)    # → 0.2
        flow[FEATURE_IDX["bwd_packets_sec"]] = 1.5 - (1.3 * intensity)
        
        flow[FEATURE_IDX["packet_length_mean"]] = 150.0
        flow[FEATURE_IDX["packet_length_std"]] = 30.0
        flow[FEATURE_IDX["ack_flag"]] = 5 + (25 * intensity)
        
        noise = self.rng.normal(0, 0.05, NUM_FEATURES)
        flow = flow * (1 + noise)
        
        return np.maximum(flow, 0).astype(np.float32)
    
    def _generate_infiltration_flow(self, intensity: float) -> np.ndarray:
        """Infiltration/data exfiltration pattern."""
        flow = np.zeros(NUM_FEATURES, dtype=np.float32)
        
        flow[FEATURE_IDX["fwd_packets"]] = 8 + (42 * intensity)
        flow[FEATURE_IDX["bwd_packets"]] = 10 + (40 * intensity)
        flow[FEATURE_IDX["fwd_length"]] = 2000 + (18000 * intensity)
        flow[FEATURE_IDX["bwd_length"]] = 3000 + (27000 * intensity)
        flow[FEATURE_IDX["flow_duration"]] = 50000 + (450000 * intensity)
        flow[FEATURE_IDX["flow_iat_mean"]] = 3000 + (12000 * intensity)
        flow[FEATURE_IDX["fwd_packets_sec"]] = 2 + (8 * intensity)
        flow[FEATURE_IDX["bwd_packets_sec"]] = 2 + (8 * intensity)
        flow[FEATURE_IDX["packet_length_mean"]] = 250 + (250 * intensity)
        flow[FEATURE_IDX["ack_flag"]] = 8 + (42 * intensity)
        
        noise = self.rng.normal(0, 0.05, NUM_FEATURES)
        flow = flow * (1 + noise)
        
        return np.maximum(flow, 0).astype(np.float32)
    
    def generate_flow(self, attack_type: str, intensity: float) -> np.ndarray:
        """Generate a single flow based on type and intensity."""
        if attack_type == "benign":
            return self._generate_benign_flow()
        elif attack_type == "ddos":
            return self._generate_ddos_flow(intensity)
        elif attack_type == "portscan":
            return self._generate_portscan_flow(intensity)
        elif attack_type == "slowloris":
            return self._generate_slowloris_flow(intensity)
        elif attack_type == "infiltration":
            return self._generate_infiltration_flow(intensity)
        else:
            return self._generate_benign_flow()


class SyntheticSimulationThread:
    """
    Manages synthetic traffic generation with REAL model inference.
    
    Generates temporal attack patterns, runs inference using trained
    CNN-LSTM model, and broadcasts predictions via WebSocket.
    """
    
    def __init__(
        self,
        backend_db,
        monitor_interval: float = 3.0,
        attack_ratio: float = 0.3,
        window_size: int = 10,
        device_id: Optional[str] = None,
        client_id: Optional[str] = None,
        selected_attack_type: Optional[str] = None,
    ):
        self.backend_db = backend_db
        self.monitor_interval = monitor_interval
        self.attack_ratio = attack_ratio
        self.window_size = window_size
        self.device_id = device_id or "00000000-0000-0000-0000-000000000001"
        self.client_id = client_id or "00000000-0000-0000-0000-000000000001"
        
        self.traffic_gen = SyntheticTrafficGenerator()
        self.is_running = False
        self._task: Optional[asyncio.Task] = None
        
        # Temporal attack scenario
        self.attack_types = ["ddos", "portscan", "slowloris", "infiltration"]
        self.current_attack_idx = 0
        self.attack_flow_count = 0
        self.benign_count = 0
        # Optional forced attack type (if provided, only that attack will be generated)
        self.selected_attack_type = selected_attack_type
        
        # Sliding window buffer
        self._window_buffer = []
    
    async def start(self):
        """Start the synthetic simulation thread."""
        if self.is_running:
            log.warning("Synthetic simulation already running")
            return
        
        self.is_running = True
        self._task = asyncio.create_task(self._run_loop())
        log.info("✅ Synthetic simulation started with REAL inference")
        log.info(f"   Attack types: {self.attack_types}")
        log.info(f"   Interval: {self.monitor_interval}s")
    
    async def stop(self):
        """Stop the synthetic simulation thread."""
        self.is_running = False
        if self._task:
            self._task.cancel()
            await asyncio.sleep(0.1)
    
    def _get_current_attack_config(self) -> tuple[str, float]:
        """Determine current attack type and intensity."""
        
        # Temporal escalation: benign → attack (gradual) → benign
        if self.benign_count < 15:
            return "benign", 0.0
        
        # Attack phase
        # If UI requested a specific attack type, honor it
        if self.selected_attack_type:
            attack_type = self.selected_attack_type
        else:
            attack_type = self.attack_types[self.current_attack_idx % len(self.attack_types)]
        
        # Intensity escalates over 30 flows: 0.1 → 1.0
        intensity = min(0.1 + (self.attack_flow_count / 30.0), 1.0)
        
        # After full intensity, switch attack type
        if intensity >= 1.0 and self.attack_flow_count > 35:
            self.current_attack_idx += 1
            self.attack_flow_count = 0
            self.benign_count = 0
            log.info(f"🔄 Switching to next attack type")
        
        return attack_type, intensity
    
    async def _run_loop(self):
    
        try:
            flow_idx = 0
            attack_phase_active = False
            attack_start_flow = 15  # Start attacks after this many flows
            
            while self.is_running:
                
                # Phase 1: Initial benign period (flows 0-14)
                if flow_idx < attack_start_flow:
                    flow = self.traffic_gen.generate_flow("benign", 0.0)
                    ground_truth = "benign"
                
                # Phase 2: Attack phase (flows 15+)
                else:
                    # Randomly decide attack or benign based on attack_ratio
                    is_attack = self.traffic_gen.rng.random() < self.attack_ratio
                    
                    if is_attack:
                        # Get current attack type and intensity
                        # If UI requested a specific attack type, honor it
                        if self.selected_attack_type:
                            attack_type = self.selected_attack_type
                        else:
                            attack_type = self.attack_types[self.current_attack_idx % len(self.attack_types)]
                        
                        # Intensity escalates from 0.1 → 1.0 over 30 attack flows
                        intensity = min(0.1 + (self.attack_flow_count * 0.03), 1.0)
                        
                        # Generate attack flow
                        flow = self.traffic_gen.generate_flow(attack_type, intensity)
                        ground_truth = attack_type
                        
                        # DEBUG: Log which attack type is being generated
                        if self.attack_flow_count % 5 == 0:
                            log.info(f"[DEBUG] Flow {flow_idx}: Generating {attack_type} (intensity={intensity:.2f}, selected={self.selected_attack_type})")
                        
                        self.attack_flow_count += 1
                        
                        # Switch to next attack type after 40 flows at max intensity (only if not forced)
                        if not self.selected_attack_type and intensity >= 1.0 and self.attack_flow_count > 40:
                            self.current_attack_idx += 1
                            self.attack_flow_count = 0
                            log.info(f"🔄 Switching attack: {attack_type} → {self.attack_types[self.current_attack_idx % len(self.attack_types)]}")
                    else:
                        # Generate benign flow
                        flow = self.traffic_gen.generate_flow("benign", 0.0)
                        ground_truth = "benign"
                
                # Add to sliding window
                self._window_buffer.append(flow)
                if len(self._window_buffer) > WINDOW_SIZE:
                    self._window_buffer.pop(0)
                
                # Only infer when window is full
                if len(self._window_buffer) == WINDOW_SIZE:
                    try:
                        # REAL INFERENCE using trained model
                        window_array = [f.tolist() for f in self._window_buffer]
                        result = run_inference(window_array)
                        
                        # Determine attack type for labeled attacks
                        predicted_attack_type = None
                        if result["label"] == "attack":
                            predicted_attack_type = ground_truth if ground_truth != "benign" else "unknown"
                        
                        # Create prediction
                        # Create prediction with explanation
                        prediction = {
                            "device_id": self.device_id,
                            "client_id": self.client_id,
                            "label": result["label"],
                            "confidence": result["confidence"],
                            "score": result["score"],
                            "attack_type": predicted_attack_type,
                            "ground_truth": ground_truth,
                            "inference_latency_ms": result["inference_latency_ms"],
                            "model_version": result["model_version"],
                            "timestamp": time.time(),
                            "flow_idx": flow_idx,
                            # ADD EXPLAINABILITY FIELDS
                            "explanation": result.get("explanation", ""),
                            "top_anomalies": result.get("top_anomalies", []),
                            "temporal_pattern": result.get("temporal_pattern", ""),
                            "anomaly_count": result.get("anomaly_count", 0),
                                # include the full window for later analysis
                                "window": window_array,
                        }
                        
                        # Broadcast prediction
                        await ws_manager.broadcast(build_ws_message(
                            WSMessageType.PREDICTION,
                            prediction,
                        ))

                        # Persist generated window + prediction to JSONL for offline analysis
                        try:
                            logs_dir = Path("logs")
                            logs_dir.mkdir(parents=True, exist_ok=True)
                            out_path = logs_dir / "synthetic_windows.jsonl"
                            with open(out_path, "a", encoding="utf-8") as fh:
                                fh.write(json.dumps({
                                    "timestamp": time.time(),
                                    "device_id": self.device_id,
                                    "flow_idx": flow_idx,
                                    "ground_truth": ground_truth,
                                    "prediction": result.get("label"),
                                    "score": result.get("score"),
                                    "confidence": result.get("confidence"),
                                    "top_anomalies": result.get("top_anomalies", []),
                                    "temporal_pattern": result.get("temporal_pattern", ""),
                                    "window": window_array,
                                }) + "\n")
                        except Exception as e:
                            log.error(f"Failed to write synthetic window log: {e}")

                        # Also persist the prediction to the database so frontend exports include anomalies
                        # Create a fresh DB session for the background task (do not reuse request-scoped sessions)
                        if self.device_id:
                            try:
                                from app.database import async_session
                                from app.services import prediction_service as pred_svc
                                import uuid

                                async def _save():
                                    try:
                                        async with async_session() as db:
                                            # convert device_id to UUID if necessary
                                            did = self.device_id
                                            try:
                                                did = uuid.UUID(str(did))
                                            except Exception:
                                                pass
                                            await pred_svc.save_prediction(
                                                db,
                                                device_id=did,
                                                result=prediction,
                                            )
                                    except Exception as e:
                                        log.error(f"Failed to save synthetic prediction to DB: {e}")

                                # Schedule save coroutine
                                asyncio.create_task(_save())
                            except Exception as e:
                                log.error(f"Failed to schedule DB save for synthetic prediction: {e}")
                        
                        # Log detection results\
                        # Log detection results with explanation
                        correct = "✓" if (result["label"] == "attack") == (ground_truth != "benign") else "✗"
                        correct_emoji = "✓" if correct == "✓" else "✗"

                        # Show detailed explanation
                        if ground_truth != "benign":
                            emoji = "🚨" if result["label"] == "attack" else "✅"
                            
                            # Build detailed log message
                            log_msg = [
                                f"\n{'='*70}",
                                f"Flow #{flow_idx}",
                                f"{'='*70}",
                                f"Ground Truth: {ground_truth.upper()} | Prediction: {result['label'].upper()} (p={result['score']:.3f}) [{correct_emoji}]",
                                f"\n📊 TEMPORAL PATTERN (last 3 flows):",
                                f"   {result.get('temporal_pattern', 'Unknown')}",
                            ]
                            
                            # Show anomalies if present
                            anomalies = result.get('top_anomalies', [])
                            if anomalies:
                                log_msg.append(f"\n🔍 TOP ANOMALOUS FEATURES:")
                                for i, anom in enumerate(anomalies[:5], 1):
                                    log_msg.append(
                                        f"   {i}. {anom['feature']:<25} = {anom['value']:>8.1f} "
                                        f"(baseline: {anom['baseline']:.1f}, {anom['ratio']:.1f}x higher)"
                                    )
                            else:
                                log_msg.append(f"\n✅ No significant anomalies detected")
                            
                            # Show explanation
                            log_msg.append(f"\n💡 DETECTION REASONING:")
                            explanation_lines = result.get('explanation', '').split('\n')
                            log_msg.extend(f"   {line}" for line in explanation_lines if line.strip())
                            
                            # Print all at once
                            log.info("\n".join(log_msg))

                        elif result["label"] == "attack":
                            # False positive
                            log.warning(
                                f"Flow {flow_idx:3d}: ⚠️  BENIGN → False Alarm (p={result['score']:.3f})"
                            )
                        
                    
                    except Exception as e:
                        log.error(f"Inference error: {e}", exc_info=True)
                
                flow_idx += 1
                await asyncio.sleep(self.monitor_interval / WINDOW_SIZE)
        
        except asyncio.CancelledError:
            log.info("Synthetic simulation task cancelled")
        except Exception as exc:
            log.error(f"Synthetic simulation error: {exc}", exc_info=True)
            self.is_running = False

# Global singleton instance
_synthetic_thread: Optional[SyntheticSimulationThread] = None


async def start_synthetic_simulation(
    backend_db,
    monitor_interval: float = 3.0,
    attack_ratio: float = 0.3,
    window_size: int = 10,
    device_id: Optional[str] = None,
    client_id: Optional[str] = None,
    selected_attack_type: Optional[str] = None,
):
    """Start the synthetic simulation thread with REAL inference."""
    global _synthetic_thread
    
    _synthetic_thread = SyntheticSimulationThread(
        backend_db=backend_db,
        monitor_interval=monitor_interval,
        attack_ratio=attack_ratio,
        window_size=window_size,
        device_id=device_id,
        client_id=client_id,
        selected_attack_type=selected_attack_type,
    )
    await _synthetic_thread.start()


async def stop_synthetic_simulation():
    """Stop the synthetic simulation thread."""
    global _synthetic_thread
    
    if _synthetic_thread:
        await _synthetic_thread.stop()
        _synthetic_thread = None


def is_synthetic_running() -> bool:
    """Check if synthetic simulation is running."""
    return _synthetic_thread is not None and _synthetic_thread.is_running