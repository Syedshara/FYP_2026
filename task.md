Task 1: ✅ Fix Rounds Widget (Shows "2/0" instead of "2/10")
Subtasks:
1.1. ✅ Verify total_rounds is sent in training_start WebSocket message from backend
1.2. ✅ Check WebSocketProvider.tsx sets total_rounds correctly in flGlobal state
1.3. ✅ Ensure FLTrainingPage.tsx displays currentRound / totalRounds format
1.4. Test: Start training with 5 rounds, verify widget shows "1/5", "2/5", etc.

Task 2: ✅ Fix Live Refresh (Blank Widgets on Start)
Subtasks:
2.1. ✅ Verify optimistic state update in handleStart is working
2.2. ✅ Check if flGlobal and flClientProgress populate immediately after API call
2.3. ✅ Test: Click "Start Training", verify widgets render without tab switch
2.4. ✅ Add loading skeleton if data takes >500ms to arrive

Task 3: ✅ Fix Phantom Clients Appearing
Subtasks:
3.1. ✅ Add debug logging to fl_progress WebSocket handler
3.2. ✅ Check if client_id in WS message is UUID (Flower internal) vs registered client_id
3.3. ✅ Backend: Map Flower's cid to registered client_id in client.py
3.4. ✅ Frontend: Filter flClientProgress to only show registered clients
3.5. Test: Train with 2 clients, verify no phantom clients appear

Task 4: ✅ Add Detailed Training Progress
Subtasks:
4.1. ✅ Backend client.py: Update local_train() to track:

batches_processed, total_batches
samples_processed, total_samples
throughput (samples/sec)
eta_seconds
current_loss, current_accuracy
last_update_time
4.2. ✅ Post progress to /internal/fl/progress after each batch (throttled every 2s)
4.3. ✅ Calculate throughput: samples_processed / elapsed_time
4.4. ✅ Calculate ETA: (total_samples - samples_processed) / throughput
4.5. ✅ Update FLProgressIn schema in internal.py
4.6. ✅ Frontend: Update FLClientProgress type in liveStore.ts
4.7. ✅ Update WebSocketProvider.tsx to parse new fields
4.8. ✅ Update FLTrainingPage.tsx client cards to show:

Progress bar with % complete
"Batch 45/150 • 28,800/96,000 samples"
"342 samples/sec • ETA 3m 12s"
"Loss: 0.145 • Acc: 96.2%"
"Last update: 2s ago"
4.9. ✅ Add per-step breakdown: Current Batch X/Y in Epoch A/B of Round C/D

Task 5: ✅ Show Metrics by Default with Charts
Subtasks:
5.1. ✅ Remove collapsed/hidden state from metrics sections
5.2. ✅ Show global metrics by default: Accuracy, Loss, Round, Aggregation Method, Encryption
5.3. ✅ Show per-client metrics by default: Accuracy, Loss per round via multi-line chart
5.4. ✅ recharts already installed — no action needed
5.5. ✅ Charts shown by default (removed liveRoundResults.length > 0 guard)
5.6. ✅ Add global accuracy/loss line chart (X: round, Y: metric)
5.7. ✅ Add per-client accuracy/loss multi-line chart (one line per client, color-coded)
5.8. ✅ Store chart data in liveStore.ts:

flRoundResults: Array<{round, loss, accuracy}> (already existed)
flClientRoundHistory: Record<client_id, Array<{round, loss, accuracy}>> (new)
5.9. ✅ Subscribe to fl_round WS messages to update chart data (addFLClientRoundEntry)
5.10. ✅ Style charts with theme colors, add tooltips on hover
5.11. ✅ Layout: Global charts (2 col), then Per-client charts (2 col) below

Task 6: ✅ Fix Range Filters
Subtasks:
6.1. ✅ Test range filters on Dashboard (1h/6h/24h/7d/30d)
6.2. ✅ Test range filters on Traffic Monitor
6.3. ✅ Verify filteredPredictions logic works
6.4. ✅ Dashboard: Added dashRange state + dashRangeToMs() + onClick on range buttons
6.5. ✅ Added visual feedback (active button highlighted with accent color, smooth transition)

Task 7: ✅ Show Device Names in Alerts
Subtasks:
7.1. ✅ Backend: WS broadcast now includes device_name via device_service.get_device() lookup
7.2. ✅ Add device_name to PredictionOut response schema + /device/{id} endpoint
7.3. ✅ Frontend DashboardPage.tsx: Display alert.device_name with deviceMap fallback
7.4. ✅ Frontend TrafficMonitorPage.tsx: Added DEVICE column to Live Event Log with device name
7.5. ✅ Fallback: If device_name is null, show truncated device_id with ⚠ icon + tooltip

Task 8: Animated Traffic Topology
Subtasks:
8.1. Install reactflow library: npm install reactflow
8.2. Create new component: TrafficTopology.tsx
8.3. Design hierarchical layout:

Top: Global server node (large, central)
Middle: Client nodes (medium, arranged in arc)
Bottom: Device nodes under each client (small, grouped)
8.4. Add edges:

Devices → Clients (predictions flowing up)
Clients → Global (weights flowing up during training)
8.5. Add animations:

Pulse effect on edges when data flows
Edge color: green (healthy), yellow (degraded), red (error/attack)
Edge thickness proportional to throughput
8.6. Show node status:

Devices: online (green dot), offline (gray), under_attack (red pulse)
Clients: training (blue pulse), monitoring (green), idle (gray)
Global: aggregating (purple pulse), idle (blue)
8.7. Add live/simulated toggle badge
8.8. Add legend explaining colors and animations
8.9. Subscribe to WebSocket for live updates (predictions, training progress)
8.10. Place on Traffic Monitor page as a new tab or top section

Task 9: Real Traffic Simulation with Scenario Control
Subtasks:
9A. Replace TrafficSimulator with ReplaySimulator (Backend)

9A.1. Create fl_client/replay_simulator.py:

Load real .npy data from client's data directory
Support scenario-based data selection
9A.2. Define attack scenarios from CIC-IDS2017 dataset:

Scenario	Dataset Day	Attack Types
DDoS Attack	Friday	DDoS
PortScan Reconnaissance	Friday	PortScan
Brute Force SSH/FTP	Tuesday	FTP-Patator, SSH-Patator
Web Attacks	Thursday	XSS, SQL Injection, Brute Force
Infiltration	Thursday	Infiltration
Botnet	Friday	Bot
Benign Only	Monday	None (clean traffic)
Mixed Attack	All Days	Random mix of all attacks
Stress Test	All Days	80% attack ratio
Custom	User-selected	User picks attack types
9A.3. Create scenario data preprocessor:

scripts/create_scenarios.py
Reads CIC-IDS2017 CSVs
Filters by attack label
Creates data/scenarios/<scenario_name>/X.npy, y.npy, metadata.json
metadata.json: attack types, sample count, benign/attack ratio, description
9A.4. Update monitor.py:

Accept SCENARIO env var
Load scenario data from data/scenarios/<scenario>/
Replay data through CNN-LSTM model
Post real predictions to backend
Respect REPLAY_SPEED env var (samples/sec)
9A.5. Model predicts on real CIC-IDS2017 features → meaningful scores

9B. Simulation Control Page (Frontend)

9B.1. Create new page: SimulationControlPage.tsx
9B.2. Add route: /simulation
9B.3. Add link in sidebar navigation with icon

9B.4. Design UI — Control Section:

Start / Stop / Pause / Reset buttons
Status indicator: Running (green) / Stopped (red) / Paused (yellow)
Uptime counter, total messages sent, current throughput
9B.5. Design UI — Scenario Selector:

Dropdown: Select scenario from list (loaded from backend)
Preview panel showing:
Scenario description
Attack types involved
Sample count
Benign/attack ratio (pie chart)
Expected duration at current speed
9B.6. Design UI — Configuration Sliders:

Replay Speed: 1-100 samples/sec (slider)
Attack Ratio Override: 0-100% (slider, optional override)
Number of Active Clients: 1-10 (slider)
Client Selector: Checkboxes for which clients to simulate
Payload Size: Display only (from scenario metadata)
9B.7. Design UI — Advanced Section (collapsible):

Random seed input (number field for reproducibility)
Distribution type: Sequential replay vs Random sampling (radio)
Loop mode: Stop at end / Loop forever / Loop N times
Batch size: How many samples per interval
9B.8. Design UI — Live Metrics Section:

Real-time chart: Messages/sec over time
Attack detection rate (true positive %)
Confusion matrix mini-widget (TP, FP, TN, FN)
Model confidence distribution histogram
9C. Simulation Control Backend

9C.1. Create backend/app/api/v1/simulation.py:

GET /api/v1/simulation/scenarios — list available scenarios
POST /api/v1/simulation/start — start simulation with config
POST /api/v1/simulation/stop — stop simulation
POST /api/v1/simulation/pause — pause simulation
GET /api/v1/simulation/status — current state + metrics
PUT /api/v1/simulation/config — update config mid-run
9C.2. Create backend/app/services/simulation_service.py:

Manage monitor containers with scenario env vars
Track simulation state (running/stopped/paused)
Collect metrics (throughput, total messages, uptime)
9C.3. Wire up Docker: Start client containers with:

MODE=MONITOR
SCENARIO=ddos_attack
REPLAY_SPEED=10
RANDOM_SEED=42
9C.4. WebSocket: Broadcast simulation status changes
9C.5. Add simulation router to main.py

Task 10: Backend — Map Flower Client IDs
Subtasks:
10.1. In client.py, get registered client_id from env var CLIENT_ID
10.2. In fit() and evaluate(), include client_id in metrics dict
10.3. In server.py, extract client_id from results metrics
10.4. When posting to /internal/fl/progress, use registered client_id (not Flower UUID)
10.5. When posting to /internal/fl/round, use registered client_id in client metrics
10.6. Test: Verify fl_progress WS messages contain "bank_a" not UUID

Task 11: Backend — Enhanced Progress Data
Subtasks:
11.1. In client.py local_train(), track per-batch metrics
11.2. Add callback/hook after each batch to post progress
11.3. Calculate throughput: samples_processed / elapsed_time
11.4. Calculate ETA: (total_samples - samples_processed) / throughput
11.5. Include current_loss, current_accuracy per batch
11.6. Add last_update_time (ISO timestamp)
11.7. Update FLProgressIn schema in internal.py
11.8. Throttle updates: Post at most every 2 seconds (avoid flooding)

Task 12: Backend — Device Names in Alerts
Subtasks:
12.1. Update predictions query to join devices table on device_id
12.2. Add device_name to prediction response schema
12.3. Handle null case (device deleted but prediction exists)
12.4. Update alert endpoint response to include device_name
12.5. Test: Fetch predictions, verify device_name is populated

Task 13: Frontend — Chart Integration
Subtasks:
13.1. Install recharts: npm install recharts
13.2. Create reusable chart components in frontend/src/components/charts/:

RoundMetricsChart.tsx — line chart for accuracy/loss over rounds
ClientComparisonChart.tsx — bar chart for per-client comparison
ConfidenceHistogram.tsx — histogram for prediction confidence distribution
13.3. Add charts to FLTrainingPage.tsx:

Global accuracy/loss line chart (X: round, Y: metric)
Per-client accuracy/loss multi-line chart
13.4. Add charts to DashboardPage.tsx:

Attack/benign ratio over time
Predictions per device bar chart
13.5. Store chart data in liveStore.ts
13.6. Subscribe to fl_round WS messages to update chart data
13.7. Style charts with theme colors, tooltips, responsive sizing
13.8. Add zoom/pan if data exceeds 20 data points

Task 14: Frontend — Live Update Fallback
Subtasks:
14.1. Detect WebSocket disconnection in WebSocketProvider.tsx
14.2. If disconnected during training, fallback to polling GET /api/v1/fl/status every 3 seconds
14.3. Update flGlobal and flClientProgress from polling response
14.4. Show warning banner: "Live updates unavailable, polling every 3s"
14.5. Auto-reconnect WebSocket when available
14.6. Test: Disconnect WS during training, verify polling works

Task 15: Testing & Validation
Subtasks:
15.1. End-to-end: Start training with 3 clients, 5 rounds — verify all progress details
15.2. Verify no phantom clients appear
15.3. Verify rounds widget shows "X/5"
15.4. Verify metrics and charts display by default
15.5. Test range filters on Dashboard and Traffic Monitor
15.6. Verify alerts show device names
15.7. Test animated topology updates in real-time
15.8. Test simulation control: Start DDoS scenario, verify predictions use real data
15.9. Test simulation control: Change speed mid-run
15.10. Test simulation control: Switch scenario mid-run
15.11. Verify model scores are meaningful (high for attacks, low for benign)
15.12. Run all backend tests: pytest
15.13. Check frontend build: npm run build
15.14. Test on Chrome, Firefox, Edge