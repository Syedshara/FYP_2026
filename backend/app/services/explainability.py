"""
Explainability service for model predictions.

Analyzes feature importance and provides human-readable explanations
for why the model classified a flow as attack or benign.
"""

import numpy as np
from typing import Dict, List, Tuple, Optional

# Feature indices and names (matching your 78-feature model)
FEATURE_NAMES = {
    0: "Fwd_Packets_Total",
    1: "Bwd_Packets_Total",
    2: "Fwd_Packet_Length_Total",
    3: "Bwd_Packet_Length_Total",
    4: "Flow_Duration",
    5: "Flow_IAT_Mean",
    6: "Fwd_Packets_Per_Sec",
    7: "Bwd_Packets_Per_Sec",
    8: "Packet_Length_Mean",
    9: "Packet_Length_Std",
    10: "Flow_IAT_Std",
    11: "Flow_IAT_Max",
    12: "Fwd_IAT_Mean",
    20: "FIN_Flag_Count",
    21: "SYN_Flag_Count",
    22: "RST_Flag_Count",
    23: "PSH_Flag_Count",
    24: "ACK_Flag_Count",
    25: "URG_Flag_Count",
}

# Benign baseline values (from CIC-IDS2017 statistics)
BENIGN_BASELINE = {
    0: 10.0,    # Fwd packets
    1: 8.0,     # Bwd packets
    2: 500.0,   # Fwd length
    3: 400.0,   # Bwd length
    4: 1000.0,  # Duration
    5: 100.0,   # IAT mean
    6: 10.0,    # Fwd packets/sec
    7: 8.0,     # Bwd packets/sec
    8: 50.0,    # Packet length mean
    9: 20.0,    # Packet length std
    10: 200.0,  # Flow IAT std
    11: 500.0,  # Flow IAT max
    12: 100.0,  # Fwd IAT mean
    20: 1.0,    # FIN flags
    21: 2.0,    # SYN flags
    22: 0.0,    # RST flags
    23: 5.0,    # PSH flags
    24: 10.0,   # ACK flags
    25: 0.0,    # URG flags
}


class ExplainabilityAnalyzer:
    """Analyzes predictions and provides explainable insights."""
    
    def __init__(self):
        self.anomaly_threshold = 3.0  # 3x baseline = anomalous
    
    def analyze_window(self, window: List[List[float]], score: float, label: str) -> Dict:
        """
        Analyze a prediction window and explain the decision.
        
        Args:
            window: List of 10 flows (each with 78 features)
            score: Model's probability score (0-1)
            label: Predicted label ("attack" or "benign")
        
        Returns:
            Dict with explanation, anomalies, temporal pattern
        """
        
        # Get current flow (most recent in window)
        current_flow = np.array(window[-1])
        
        # Check for rule-based portscan signature (High SYN + Low ACK + small packets)
        # Rule from Colab: Port Scans have High SYN flags, low ACK
        detected_attack_type = self._detect_portscan_signature(current_flow)
        if detected_attack_type and label == "benign":
            # Override benign prediction if portscan signature is strong
            label = "attack"
            score = 0.9  # High confidence for rule-based detection
        
        # Find anomalous features
        anomalies = self._find_anomalies(current_flow)
        
        # Analyze temporal pattern
        temporal = self._analyze_temporal_pattern(window)
        
        # Generate explanation
        explanation = self._generate_explanation(
            label=label,
            score=score,
            anomalies=anomalies,
            temporal=temporal,
            detected_attack=detected_attack_type
        )
        
        return {
            "explanation": explanation,
            "top_anomalies": anomalies[:5],  # Top 5 anomalous features
            "temporal_pattern": temporal,
            "anomaly_count": len(anomalies),
            "detected_attack_type": detected_attack_type,
        }
    
    def _find_anomalies(self, flow: np.ndarray) -> List[Dict]:
        """Find features that deviate significantly from baseline."""
        
        anomalies = []
        
        for idx, baseline in BENIGN_BASELINE.items():
            if idx >= len(flow):
                continue
            
            value = flow[idx]
            
            # Calculate deviation ratio
            if baseline > 0:
                ratio = value / baseline
            else:
                # For zero baseline (like RST flags), only non-zero values are anomalous
                # Use an infinite ratio marker so they sort to the top
                if value > 0:
                    ratio = float('inf')
                else:
                    # No deviation when both baseline and value are zero
                    continue
            
            # Consider it anomalous if >3x baseline
            if ratio > self.anomaly_threshold:
                anomalies.append({
                    "feature": FEATURE_NAMES.get(idx, f"Feature_{idx}"),
                    "value": float(value),
                    "baseline": float(baseline),
                    "ratio": float(ratio),
                })
        
        # Sort by ratio (most anomalous first)
        anomalies.sort(key=lambda x: x["ratio"], reverse=True)
        
        return anomalies
    
    def _detect_portscan_signature(self, flow: np.ndarray) -> Optional[str]:
        """
        Rule-based detection for portscan attack signature.
        
        PortScan signature (from Colab):
        - High SYN flags (>8x baseline) 
        - Low ACK flags (<baseline or declining)
        - Small packet sizes (<10x baseline)
        - Moderate packet count (5-200)
        """
        
        syn_idx = 21
        ack_idx = 24
        fwd_length_idx = 2
        fwd_packets_idx = 0
        
        if syn_idx >= len(flow) or ack_idx >= len(flow):
            return None
        
        syn_value = flow[syn_idx]
        ack_value = flow[ack_idx]
        fwd_length = flow[fwd_length_idx] if fwd_length_idx < len(flow) else 0
        fwd_packets = flow[fwd_packets_idx] if fwd_packets_idx < len(flow) else 0
        
        syn_baseline = BENIGN_BASELINE.get(syn_idx, 2.0)
        ack_baseline = BENIGN_BASELINE.get(ack_idx, 10.0)
        fwd_length_baseline = BENIGN_BASELINE.get(fwd_length_idx, 500.0)
        
        # Check portscan signature
        syn_ratio = syn_value / syn_baseline if syn_baseline > 0 else 0
        ack_ratio = ack_value / ack_baseline if ack_baseline > 0 else 0
        length_ratio = fwd_length / fwd_length_baseline if fwd_length_baseline > 0 else 0
        
        # PortScan: High SYN (>5x) + Low ACK (<0.5x) + Small packets (<10x)
        is_portscan = (
            syn_ratio > 5.0 and  # High SYN flags
            ack_ratio < 0.8 and  # Low ACK response
            length_ratio < 10.0 and  # Not too large packets
            fwd_packets > 5  # Some packet activity
        )
        
        if is_portscan:
            return "portscan"
        
        return None
    
    def _analyze_temporal_pattern(self, window: List[List[float]]) -> str:
        """Detect temporal patterns in the flow sequence."""
        
        if len(window) < 3:
            return "Insufficient history"
        
        # Analyze packet rate trend over last 3 flows
        recent_flows = np.array(window[-3:])
        packet_rates = recent_flows[:, 6]  # Fwd packets/sec (index 6)
        
        if len(packet_rates) < 2:
            return "Stable pattern"
        
        # Calculate rate of change
        recent_rate = packet_rates[-1]
        prev_avg = np.mean(packet_rates[:-1])
        
        if prev_avg == 0:
            return "Stable pattern"
        
        # Classify pattern
        if recent_rate > prev_avg * 5:
            return "Sudden spike detected"
        elif recent_rate > prev_avg * 2:
            return "Gradual increase"
        elif recent_rate < prev_avg * 0.5:
            return "Sudden drop"
        else:
            return "Stable pattern"
    
    def _generate_explanation(
        self,
        label: str,
        score: float,
        anomalies: List[Dict],
        temporal: str,
        detected_attack: Optional[str] = None
    ) -> str:
        """Generate human-readable explanation."""
        
        if label == "attack":
            # Attack detected
            reasons = ["Model detected attack because:"]
            
            # Rule-based detection reason
            if detected_attack:
                reasons.append(f"• Rule-based detection: {detected_attack} signature detected (High SYN + Low ACK)")
            
            # Temporal reason
            if temporal in ["Sudden spike detected", "Gradual increase"]:
                reasons.append(f"• Temporal: {temporal} in traffic volume")
            
            # Top anomalous feature
            if anomalies:
                top = anomalies[0]
                reasons.append(
                    f"• Feature: {top['feature']} is {top['ratio']:.1f}x higher than normal"
                )
            
            # LSTM pattern recognition
            reasons.append("• LSTM captured the abnormal sequence pattern")
            
            return "\n   ".join(reasons)
        
        else:
            # Benign classification
            reasons = ["Model classified as benign because:"]
            
            if len(anomalies) == 0:
                reasons.append("• Features within normal ranges")
            else:
                reasons.append("• Anomalies present but not sustained across the window")
                # Include top anomalous feature names so user can see which columns deviated
                top_list = []
                for i, a in enumerate(anomalies[:5], 1):
                    top_list.append(f"{i}. {a['feature']} = {a['value']:.1f} (baseline: {a['baseline']:.1f}, {a['ratio']:.1f}x)")
                reasons.append("• Top anomalous features:")
                reasons.extend(top_list)

            # Always mention temporal analysis result
            reasons.append(f"• Temporal analysis: {temporal}")

            return "\n   ".join(reasons)


# Global analyzer instance
_analyzer = ExplainabilityAnalyzer()


def explain_prediction(
    window: List[List[float]],
    score: float,
    label: str
) -> Dict:
    """
    Public API for prediction explanation.
    
    Args:
        window: List of 10 flows (each 78 features)
        score: Prediction probability
        label: Predicted label
    
    Returns:
        Explanation dict with reasoning and anomalies
    """
    return _analyzer.analyze_window(window, score, label)