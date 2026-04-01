# Watcher Drill-Down — AWS Step Functions Node Graph UI

> **Status**: Wireframe approved. Ready for implementation.
> **Owner**: Watcher drill-down tabs (Events, Trust, Recovery).
> **Does NOT touch**: Certs tab, top bar, canvas, FL drill-down.

---

## 1. Goal

Replace the flat log / card-based tabs in the Watcher drill-down with an
**AWS Step Functions-style node graph**. Each tab shows a vertical pipeline
of rectangular state nodes connected by SVG arrows. Clicking any node opens
a detail panel showing its full state data.

This gives the user a clear visual story: "here is exactly what happened
at each step of the security pipeline, with real values."

---

## 2. Overall Layout

Split each tab's content area into two panels:

```
┌──────────────────────────────────────────────────────────────┐
│  WATCHER DRILL-DOWN (top bar — unchanged)                    │
│  ← Back    👁 Watcher_1    Security Audit                    │
│  Watching: FL_Server_1                                       │
│  [ Events ] [ Trust ] [ Certs ] [ Recovery ]                 │
├──────────────────────────────────────────────────────────────┤
│                              │                               │
│  Left: Node Graph (≈65%)     │  Right: State Detail (≈35%)   │
│  Scrollable vertically       │  Sticky, doesn't scroll with  │
│                              │  the graph                    │
│  ┌─────────────────┐         │  ┌───────────────────────┐    │
│  │  State Node A   │         │  │  State Detail Panel   │    │
│  │  [real values]  │────▶    │  │                       │    │
│  └─────────────────┘         │  │  Selected: Node A     │    │
│          │                   │  │                       │    │
│          ▼                   │  │  INPUT:  { ... }      │    │
│  ┌─────────────────┐         │  │  OUTPUT: { ... }      │    │
│  │  State Node B   │←click   │  │  Duration: 0.45s      │    │
│  │  [real values]  │         │  │  Status: Succeeded    │    │
│  └─────────────────┘         │  │                       │    │
│          │                   │  └───────────────────────┘    │
│          ▼                   │                               │
│         ...                  │                               │
│                              │                               │
└──────────────────────────────────────────────────────────────┘
```

When no node is selected, the right panel shows:
> "Click any state to inspect its data"

---

## 3. Node Visual Design

Each state node is a **rounded rectangle** (`border-radius: 8px`):

```
┌──────────────────────────────────┐
│ ● Status Dot    STATE LABEL      │  ← 13px bold, --n8n-text-primary
│                                  │
│  metric_a: 0.9521                │  ← 11px mono, real values
│  metric_b: 97.1%                 │
│  clients: 3                      │
│                                  │
│  ✓ Succeeded          0.45s      │  ← status badge + duration
└──────────────────────────────────┘
```

- **4px left border** coloured by status
- **Subtle background** tinted by status
- **Clickable** — sets this node as selected in the detail panel
- **Hover** — border highlight with `--n8n-accent-light`
- **Keyboard** — Tab to focus, Enter to select

### Node Status Colours

| Status    | Left border          | Background                    | Badge              |
|-----------|----------------------|-------------------------------|---------------------|
| Succeeded | `--n8n-success`      | `rgba(24, 160, 88, 0.05)`    | green "Succeeded"   |
| Running   | `--n8n-accent`       | `rgba(255, 109, 90, 0.05)`   | orange pulse "Running" |
| Failed    | `--n8n-danger`       | `rgba(208, 48, 80, 0.05)`    | red "Failed"        |
| Warning   | `--n8n-warning`      | `rgba(240, 160, 32, 0.05)`   | yellow "Warning"    |
| Pending   | `--n8n-card-border`  | `transparent`                 | grey "Pending"      |

### Node Sizing

- **Sequential nodes**: full width of graph area (minus padding)
- **Parallel branch nodes**: evenly split horizontal space with 8px gap

---

## 4. SVG Connectors (Arrows)

An absolutely-positioned `<svg>` overlay on top of the CSS Grid draws
the arrows between nodes.

- Stroke: `1.5px` solid `var(--n8n-card-border)`
- Arrowhead: small filled triangle (6px)
- Running status: animated dashed stroke

```
Straight vertical:        Fork:                  Join:
      │                     │                 │     │     │
      │                ┌────┼────┐            └─────┼─────┘
      │                ▼    ▼    ▼                  │
      ▼                                             ▼
```

Fork: single vertical line → horizontal bar → vertical lines down to each child.
Join: vertical lines up from each child → horizontal bar → single vertical line down.

---

## 5. Tab 1: Events — Round Security Pipeline

### Round Selector

Horizontal pill bar at the top of the tab:

```
  [ R1 ] [ R2 ] [ R3 ] [ R4 ] [ R5● ] [ R6 ] [ R7● ]
                                  ↑               ↑
                          RECESS rounds get a dot indicator
```

- Default: latest round selected
- Auto-selects latest round when a new round arrives during training
- Accent background on the selected pill

### Pipeline Nodes (for selected round, top to bottom)

```
         ┌────────────────────────────┐
         │  ● Round Start             │
         │                            │
         │  round: 7                  │
         │  expected_clients: 3       │
         │  timestamp: 14:32:01       │
         │                            │
         │  ✓ Succeeded       0.01s   │
         └──────────────┬─────────────┘
                        │
                        ▼
         ┌────────────────────────────┐
         │  ● Dispatch                │
         │                            │
         │  layers: 4                 │
         │  ‖W‖ total: 12.45         │
         │  clients_notified: 3       │
         │                            │
         │  ✓ Succeeded       0.12s   │
         └──────────────┬─────────────┘
                        │
              ┌─────────┼─────────┐       ← FORK (parallel)
              ▼         ▼         ▼
  ┌──────────────┐┌──────────────┐┌──────────────┐
  │ ● Bank_A     ││ ● Bank_B     ││ ● Bank_C     │
  │              ││              ││              │
  │ loss: 0.034  ││ loss: 0.013  ││ loss: 0.892  │
  │ acc: 96.8%   ││ acc: 98.1%   ││ acc: 12.3%   │
  │ samples: 5k  ││ samples: 5k  ││ samples: 5k  │
  │              ││              ││              │
  │ ✓ Done 1.2s  ││ ✓ Done 1.1s  ││ ⚠ Done 1.3s  │
  └──────┬───────┘└──────┬───────┘└──────┬───────┘
         └───────────────┼───────────────┘
                         ▼                ← JOIN
         ┌────────────────────────────┐
         │  ● Security Verification   │
         │                            │
         │  nonces: 3/3 ✓            │
         │  mTLS:   3/3 ✓            │
         │  signatures: 3/3 ✓        │
         │                            │
         │  ✓ All passed      0.08s   │
         └──────────────┬─────────────┘
                        │
                        ▼
         ┌────────────────────────────┐
         │  ● HE + Aggregation        │
         │                            │
         │  encrypted_layers: 4       │
         │  vss_ceremony: ✓           │
         │  agg_method: trust_weight  │
         │                            │
         │  ✓ Succeeded       0.45s   │
         └──────────────┬─────────────┘
                        │
                        ▼
    ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┐
         ● RECESS Detection               ← ONLY on RECESS rounds
    │                                     │  (every 5th round).
         clients_evaluated: 3              Dashed border if absent.
    │    flagged: Bank_C (0.12)           │
         threshold: 0.3
    │                                     │
         ⚠ 1 flagged       0.15s
    └ ─ ─ ─ ─ ─ ─ ─┬─ ─ ─ ─ ─ ─ ─ ─ ─ ─┘
                    │
                    ▼
         ┌────────────────────────────┐
         │  ● Enforcement             │  ← EVERY round
         │                            │
         │  Bank_A: included (1.0)    │
         │  Bank_B: included (1.0)    │
         │  Bank_C: excluded (0.0)    │
         │                            │
         │  trust from: R5            │  ← shows which round's
         │  ✓ Applied         0.01s   │    scores are being used
         └──────────────┬─────────────┘
                        │
                        ▼
         ┌────────────────────────────┐
         │  ● Model Update            │
         │                            │
         │  acc: 93.2% → 97.1%       │
         │  loss: 0.042 → 0.019      │
         │  Δ total: 1.234           │
         │                            │
         │  ✓ Succeeded       0.02s   │
         └──────────────┬─────────────┘
                        │
                        ▼
         ┌────────────────────────────┐
         │  ● Round Complete          │
         │                            │
         │  duration: 2.04s           │
         │  next_round: 8             │
         │                            │
         │  ✓ Done                    │
         └────────────────────────────┘
```

### Non-RECESS round vs RECESS round

Non-RECESS (e.g. R8): No RECESS Detection node. Pipeline goes directly
from HE+Aggregation → Enforcement → Model Update.

RECESS (e.g. R10): RECESS Detection node appears between HE+Aggregation
and Enforcement. Trust scores are freshly computed.

### Enforcement node appears EVERY round

The Enforcement node shows who was included/excluded even on non-RECESS
rounds. Trust scores from the last RECESS round are reused.
Data from `enforcementHistory[round]`.

### Detail Panel — Events Tab

When you click a node, the right panel shows sections depending on node type:

**Client Training node (e.g. Bank_C)**:
```
┌─────────────────────────────────┐
│  Bank_C — Client Training       │
│  Status: Done (with warning)    │
│  Duration: 1.3s                 │
├─────────────────────────────────┤
│  INPUT                          │
│  ┌─────────────────────────┐    │
│  │ round: 7                │    │
│  │ epochs: 5               │    │
│  │ lr: 0.001               │    │
│  └─────────────────────────┘    │
│                                 │
│  OUTPUT                         │
│  ┌─────────────────────────┐    │
│  │ local_loss: 0.892       │    │
│  │ local_accuracy: 0.123   │    │
│  │ num_samples: 5000       │    │
│  │ poison_strategy:        │    │
│  │   "direction_flip"      │    │
│  └─────────────────────────┘    │
│                                 │
│  SECURITY                       │
│  ┌─────────────────────────┐    │
│  │ nonce: verified ✓       │    │
│  │ mTLS: verified ✓        │    │
│  │ signature: verified ✓   │    │
│  │ he_encrypt: 4 layers    │    │
│  └─────────────────────────┘    │
│                                 │
│  TRUST (at this round)          │
│  ┌─────────────────────────┐    │
│  │ trust_score: 0.120      │    │
│  │ direction: 0.08         │    │
│  │ magnitude: 0.15         │    │
│  │ abnormality: 0.92       │    │
│  │ enforcement: excluded   │    │
│  └─────────────────────────┘    │
└─────────────────────────────────┘
```

**Enforcement node**: Full per-client breakdown with trust scores, weights.
**RECESS node**: Per-client abnormality scores, direction/magnitude.
**Model Update node**: Per-layer weight norms before/after, delta norms.

---

## 6. Tab 2: Trust — Detection Pipeline

### Round Selector

Same pill bar style, but showing **only RECESS detection rounds**
(R5, R10, R15, ...). Default: latest detection round.

### Pipeline Nodes (for selected detection round)

```
         ┌────────────────────────────┐
         │  ● RECESS Trigger          │
         │                            │
         │  round: 15                 │
         │  detection_interval: 5     │
         │  probe_built: ✓            │
         │                            │
         │  ✓ Started         0.02s   │
         └──────────────┬─────────────┘
                        │
              ┌─────────┼─────────┐       ← FORK (per-client)
              ▼         ▼         ▼
  ┌──────────────┐┌──────────────┐┌──────────────┐
  │ ● Bank_A     ││ ● Bank_B     ││ ● Bank_C     │
  │              ││              ││              │
  │ score: 0.952 ││ score: 0.918 ││ score: 0.120 │
  │ dir:   0.96  ││ dir:   0.93  ││ dir:   0.08  │
  │ mag:   0.94  ││ mag:   0.90  ││ mag:   0.15  │
  │ abn:   0.05  ││ abn:   0.09  ││ abn:   0.92  │
  │              ││              ││              │
  │ ✓ Included   ││ ✓ Included   ││ ✗ Excluded   │
  └──────┬───────┘└──────┬───────┘└──────┬───────┘
         └───────────────┼───────────────┘
                         ▼                ← JOIN
         ┌────────────────────────────┐
         │  ● Enforcement Decision    │
         │                            │
         │  included: 2               │
         │  downweighted: 0           │
         │  excluded: 1 (Bank_C)      │
         │                            │
         │  ⚠ Action taken    0.01s   │
         └──────────────┬─────────────┘
                        │
                        ▼
         ┌────────────────────────────┐
         │  ● Outcome                 │
         │                            │
         │  Bank_C: trust 0.12        │
         │    → excluded (weight: 0)  │
         │    → FedRecovery triggered │
         │                            │
         │  ✗ Flagged                 │
         └────────────────────────────┘
```

### Detail Panel — Trust Tab

Clicking a client node shows: full trust components, sparkline history
(reuse existing `Sparkline` SVG component), enforcement weight, comparison
to previous detection round scores.

### Keep existing features

- Reset Trust Scores button (with confirmation dialog) in tab header
- Flagged events count badge in header

---

## 7. Tab 3: Recovery — Correction Pipeline

### Top-level

If multiple recovery runs exist, show them as a vertical list of
collapsible cards. Each card header: flagged client name, flag round,
status badge, timestamp. Click to expand → shows pipeline graph.

### Pipeline Nodes (for one FedRecovery run)

```
         ┌────────────────────────────┐
         │  ● Trigger                 │
         │                            │
         │  client: Bank_C            │
         │  flag_round: 15            │
         │  trust_score: 0.120        │
         │  abnormality: 0.920        │
         │                            │
         │  ✗ Flagged                 │
         └──────────────┬─────────────┘
                        │
                        ▼
         ┌────────────────────────────┐
         │  ● DP Calibration          │
         │                            │
         │  epsilon (ε): 0.5000       │
         │  sigma (σ):   0.1234       │
         │  sensitivity: 2.0          │
         │  mechanism: Gaussian       │
         │                            │
         │  ✓ Calibrated      0.03s   │
         └──────────────┬─────────────┘
                        │
                        ▼
         ┌────────────────────────────┐
         │  ● R12 — Correction        │
         │                            │
         │  status: corrected         │
         │  Δ‖w‖: 0.312              │
         │  weight_applied: 0.85      │
         │                            │
         │  ✓ Corrected       0.12s   │
         └──────────────┬─────────────┘
                        │
                        ▼
         ┌────────────────────────────┐
         │  ● R13 — Correction        │
         │                            │
         │  status: corrected         │
         │  Δ‖w‖: 0.201              │
         │  weight_applied: 0.90      │
         │                            │
         │  ✓ Corrected       0.11s   │
         └──────────────┬─────────────┘
                        │
                        ▼
         ┌────────────────────────────┐
         │  ● R14 — Correction        │
         │                            │
         │  status: skipped           │
         │  reason: no contribution   │
         │                            │
         │  — Skipped                 │
         └──────────────┬─────────────┘
                        │
                        ▼
         ┌────────────────────────────┐
         │  ● Model Impact            │
         │                            │
         │  accuracy:                 │
         │    93.2% → 97.1% (+3.9%)  │
         │  loss:                     │
         │    0.042 → 0.019 (-54.8%) │
         │                            │
         │  ✓ Improved        0.02s   │
         └──────────────┬─────────────┘
                        │
                        ▼
         ┌────────────────────────────┐
         │  ● Result                  │
         │                            │
         │  rounds_corrected: 2       │
         │  rounds_skipped: 1         │
         │  total_duration: 0.38s     │
         │  status: complete          │
         │                            │
         │  ✓ Complete                │
         └────────────────────────────┘
```

Correction steps are **sequential** (vertical), not parallel — they are
processed one at a time.

### Detail Panel — Recovery Tab

Clicking a correction step shows: before/after weight norms per layer
(from `run.beforeNorms/afterNorms`), residual norm, DP noise that was
applied at that step.

---

## 8. Implementation Approach

### Rendering — CSS Grid + SVG overlay

**Not React Flow.** This is a read-only fixed-layout pipeline. Use:

- **CSS Grid** for node positioning. Each pipeline row is a grid row.
  Sequential nodes span all columns. Parallel branches get one column each.
- **SVG overlay** (`position: absolute; inset: 0; pointer-events: none`)
  draws arrows between nodes. Arrow paths computed from node DOM positions
  via `getBoundingClientRect()` or ref-based measurement.

### File structure

Create new files:

| File | Purpose |
|------|---------|
| `watcher/StateNode.tsx` | Single state node component (box with metrics) |
| `watcher/StateDetailPanel.tsx` | Right-side detail panel (sections with key-value data) |
| `watcher/StepFunctionGraph.tsx` | Graph renderer: CSS Grid + SVG connectors |
| `watcher/EventsPipelineTab.tsx` | Events tab — round selector + pipeline from security events |
| `watcher/TrustPipelineTab.tsx` | Trust tab — detection round selector + trust pipeline |
| `watcher/RecoveryPipelineTab.tsx` | Recovery tab — run list + correction pipeline |

Modify:

| File | Change |
|------|--------|
| `WatcherDrillDownView.tsx` | Replace inline EventsTab/TrustTab/RecoveryTab with imports. Keep top bar, tabs, CertsTab, handleBack, hydration. |
| `index.css` | Add `.sfn-*` CSS classes for node graph visual |
| `liveStore.ts` | Already has `enforcementHistory` — no changes needed |

### CSS naming

Use `.sfn-` prefix (Step Function Node):

- `.sfn-graph` — grid container
- `.sfn-node` — individual state node
- `.sfn-node--succeeded/running/failed/warning/pending` — status variants
- `.sfn-node__label`, `__metrics`, `__status` — node internals
- `.sfn-node--selected` — active selection ring
- `.sfn-connectors` — SVG overlay layer
- `.sfn-detail` — right detail panel
- `.sfn-detail__section` — section card within detail panel
- `.sfn-round-selector` — round pill bar
- `.sfn-round-pill`, `.sfn-round-pill--active` — individual pills
- `.sfn-parallel-row` — horizontal flex for parallel branches
- `.sfn-split-layout` — the 65/35 split container

---

## 9. Data Source Mapping

Where each node gets its real values:

| Node | Store / Selector | Fields |
|------|-----------------|--------|
| Round Start | `liveStore.securityEvents` filtered `kind === 'round_start'` | round, timestamp |
| Dispatch | `securityEvents` `kind === 'global_dispatch'` + `flRoundResults[round].gradient_stats.dispatch_norms` | layers, total norm |
| Client Training | `flRoundResults[round].client_metrics[]` | client_id, local_loss, local_accuracy, num_samples |
| Security Verification | Count `nonce_verified`, `mtls_handshake`, `signature_verified/failed` for that round | pass/fail counts |
| HE + Aggregation | `he_encrypt/aggregate/decrypt`, `vss_ceremony/share_dist` events | event.data for HE metrics |
| RECESS Detection | `recess_detect/flag` events + `trustScoreHistory` at that round | flagged clients, scores |
| Enforcement | `liveStore.enforcementHistory[round]` | per-client: included / downweighted / excluded |
| Model Update | `flRoundResults[round]` | accuracy, loss, gradient_stats.post_norms, total_delta |
| Round Complete | `securityEvents` `kind === 'round_complete'` | timestamp (duration = complete - start) |

### Client label resolution

FL client string IDs (`client_abc123`) differ from canvas node IDs. To resolve:

```ts
function useClientIdLabelMap(): Map<string, string> {
  const nodes = useWorkspaceStore((s) => s.nodes);
  return useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) {
      if ((n.data as { nodeType?: string }).nodeType !== 'client') continue;
      const label = (n.data as { label?: string }).label ?? n.id;
      const derivedId = n.id.replace(/-/g, '_');
      m.set(derivedId, label);
      m.set(n.id, label);
    }
    return m;
  }, [nodes]);
}
```

This is the same derivation logic that `LiveDataSync.tsx` uses (line 149).

### Missing data (may need backend enrichment)

- Per-phase **duration**: Computable from event timestamps (phase start → phase end).
  No backend changes needed.
- Per-step **input/output JSON**: Currently `event.detail` is a string and `event.data`
  is a sparse `Record<string, unknown>`. For richer detail panels, the backend could
  send more structured data in `event.data`. This is a nice-to-have, not a blocker —
  we can show what we have and add richer payloads later.

---

## 10. Interaction Model

| Action | Result |
|--------|--------|
| Click a node | Right panel shows that node's full state |
| Hover a node | Subtle border highlight (`--n8n-accent-light`) |
| No node selected | Right panel: "Click any state to inspect its data" |
| Round selector click | Loads that round's pipeline graph |
| New round arrives (WS) | Auto-selects latest round, auto-scrolls graph |
| Keyboard Tab | Focuses nodes in pipeline order |
| Keyboard Enter | Selects focused node → detail panel |
| Escape | Closes detail panel (deselects node) |

---

## 11. Key Design Decisions

1. **Enforcement node appears EVERY round**, not just RECESS rounds.
   Trust-weighted aggregation uses stored trust scores every round.
   The node shows which clients were included/excluded and which
   detection round's trust scores are being used.

2. **RECESS Detection node only appears on RECESS rounds** (every 5th).
   On non-RECESS rounds the pipeline skips from HE+Aggregation → Enforcement.

3. **Correction steps are sequential** in Recovery tab (not parallel) —
   FedRecovery processes one round at a time.

4. **Client names are always resolved** using `useClientIdLabelMap()` —
   never show raw FL client IDs like `client_abc123`.

5. **No React Flow** — overkill for a fixed read-only pipeline. CSS Grid
   + SVG connectors is lighter and gives us full control over the visual.

6. **Security state lifecycle unchanged** — clearing trust scores,
   security events, RECESS, FedRecovery still happens in `handleBack()`
   when the Watcher drill-down closes.

---

## 12. Verification Checklist

After implementation:

- [ ] `npx tsc --noEmit` passes for all new/modified files
- [ ] `npm run lint` passes
- [ ] All imports resolve correctly
- [ ] No unused imports
- [ ] Client names resolve correctly (no raw IDs shown)
- [ ] Enforcement node shows per-client status on every round
- [ ] RECESS node only appears on detection rounds
- [ ] Detail panel updates on node click
- [ ] Round selector auto-selects latest during training
- [ ] Certs tab unchanged
- [ ] Top bar unchanged
- [ ] handleBack still clears all security state
