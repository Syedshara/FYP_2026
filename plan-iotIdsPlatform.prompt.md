# Plan: IoT IDS Full-Stack Platform — Frontend, Backend & Architecture

Your ML pipeline (CNN-LSTM + FL + CKKS HE) is complete. The plan below covers building a full-stack web platform to **configure IoT devices, analyze traffic in real-time, simulate/prevent attacks, and run multi-attack test pipelines** — all powered by your trained model.

---

## Steps

1. **Scaffold a React + TypeScript frontend** in the `FYP_Frontend` repo using Vite, with Tailwind CSS for styling, React Router for navigation, and Socket.IO-client for real-time data streaming. Create pages: **Dashboard, Device Management, Traffic Monitor, Attack Simulator (Pipeline), FL Training Monitor, and Settings**.

2. **Build a FastAPI backend** (new repo/folder) that loads `cnn_lstm_global_with_HE_25rounds_16k.pt` and `standard_scaler.pkl` at startup, exposing REST endpoints for device CRUD, traffic ingestion (`POST /api/traffic`), prediction (`POST /api/predict`), attack simulation (`POST /api/simulate`), and a WebSocket channel (`/ws/live`) for real-time streaming of predictions to the dashboard.

3. **Design the device configuration flow** — a frontend form where users register IoT devices (name, IP, protocol, port, traffic source) → stored in a **SQLite/PostgreSQL** database → backend spawns a per-device async traffic listener (adapting your notebook's `EdgeGateway` pattern with sliding-window buffering of 10 flows × 78 features → model inference).

4. **Build the real-time traffic analysis dashboard** — use **Recharts** or **Chart.js** for live line charts (traffic rate, anomaly score over time), a threat-level gauge, a scrolling event log (Benign ✅ / Attack 🚨 with timestamp, device, confidence), and a confusion-matrix/metrics panel. Data flows via WebSocket from the backend.

5. **Create the attack simulation pipeline page** — a drag-and-drop or checklist UI where users select multiple attack profiles (DDoS, Slow Attack, Port Scan, Brute Force, Botnet, Exfiltration, Hybrid — matching your notebook's synthetic profiles) against a configured device, then run them sequentially as a **pipeline**. Backend generates synthetic attack traffic, feeds it through the model, and streams results back in real time.

6. **Add the auto-prevention module (Phase 2)** — backend listens to prediction results; when the anomaly score exceeds a configurable threshold, it triggers automated responses: firewall rule injection (via `iptables`/API call), device isolation (mark device quarantined in DB), alert notification (email/webhook), and rate-limiting. The frontend shows a **Prevention Rules** panel where users configure thresholds and response actions per device.

---

## Wireframe Overview

| Page | Key Components |
|------|---------------|
| **Dashboard** | Global threat score gauge · Active devices count · Live attack timeline chart · Recent alerts table |
| **Device Management** | Device list/grid · "Add Device" form (name, IP, protocol, port) · Per-device status badge (Online/Offline/Quarantined) · Edit/Delete actions |
| **Traffic Monitor** | Device selector dropdown · Real-time line chart (traffic volume + anomaly score) · Scrolling event log with Benign/Attack labels · Export CSV button |
| **Attack Pipeline** | Step-builder UI: select device → pick attacks (checkboxes: DDoS, Port Scan, Brute Force, etc.) → set order & duration → "Run Pipeline" → live results table with per-attack accuracy, detection time, confidence |
| **FL Training Monitor** | Round-by-round loss/accuracy charts · Client contribution bars · HE encryption status indicator |
| **Settings / Prevention Rules** | Threshold sliders per device · Auto-response toggles (Block IP, Quarantine, Alert) · Notification webhook config |

---

## Suggested Architecture

```
[React Frontend]  ←— WebSocket + REST —→  [FastAPI Backend]
                                              ├── Model Service (CNN-LSTM .pt)
                                              ├── Edge Gateway (async, per-device)
                                              ├── Attack Simulator (synthetic profiles)
                                              ├── Prevention Engine (auto-block rules)
                                              └── DB (PostgreSQL / SQLite)
```

---

## Novel Additions

1. **Explainable AI (XAI) layer**: Integrate **SHAP** or **LIME** on the backend to explain *which of the 78 features* contributed most to each attack prediction, and display a feature-importance bar chart on the frontend per alert — this significantly strengthens the project's research contribution.

2. **Adversarial Robustness Testing**: Add a pipeline step where users can inject **adversarial perturbations** (FGSM/PGD) into traffic flows to test model robustness, with a report comparing detection rates before/after — demonstrates the HE-protected FL model's resilience.

3. **Multi-class upgrade**: Your current model is binary (Benign vs Attack). Consider training a **multi-class variant** (7 attack types from CIC-IDS2017) so the dashboard can show *which specific attack* is detected, not just "attack detected" — makes the pipeline and prevention engine far more useful.

4. **Tech stack decision**: For the frontend, **React + Vite + Tailwind** is recommended for speed. Alternatively, **Next.js** if you want SSR for the dashboard. For real-time, **Socket.IO** is simplest; **Redis Pub/Sub** if you need to scale to many concurrent devices.
