# FedRecovery Implementation QA Report

**Date:** March 31, 2026
**Reviewer:** QA Agent
**Paper:** Zhang et al., *"FedRecovery: Differentially Private Machine Unlearning for Federated Learning Frameworks"*, IEEE TIFS Vol. 18, 2023
**PDF:** `phase3-docs/FedRecovery_Differentially_Private_Machine_Unlearning_for_Federated_Learning_Frameworks (1).pdf`

---

## Files Reviewed

| File | Lines | Role |
|------|-------|------|
| `fl_server/fed_recovery.py` | 472 | FedRecovery unlearning engine (core subject) |
| `fl_server/gradient_archive.py` | 227 | Per-round gradient storage used by FedRecovery |
| `fl_server/server.py` | 1659 | FL server — populates archive, triggers FedRecovery |

---

## Test Coverage

| Category | Result |
|----------|--------|
| Backend test suite | **12 / 14 passing** (2 pre-existing Docker fixture errors, unrelated) |
| `fed_recovery.py` unit tests | **None exist** |
| `gradient_archive.py` unit tests | **None exist** |
| Type checker | Not configured |
| Linter | Not configured |

---

## Verdict

> **The implementation diverges from the paper on every mathematical component that is essential for the (ε, β)-machine unlearning guarantee.**
>
> The implementation performs a *reasonable approximation* (subtract the flagged client's contribution, add Gaussian noise) but **cannot claim the theoretical unlearning guarantees proved in the paper**. Five of the six deviations are independently sufficient to invalidate Theorem 1.

---

## Algorithm Reference (Paper Algorithm 2)

For reference, the paper's Algorithm 2 (*Unlearning Algorithm MU*) proceeds as follows:

```
Input:  unlearning request from client i_u
        global model w_t ∈ R^d
        per-client gradients ∇f_i(w_j) for all clients i ∈ [n], rounds j ∈ [t]
        privacy budget ε

Output: unlearned model w_u

Step 1: Compute σ = (1/√2) · d / (√(log(1/β) + ε) − √(log(1/β)))
        where d = upper bound of ‖w̄_t − w̃_t‖ from Theorem 3 (Eqs. 34–36)

Steps 2–4:  For each round i ∈ [t], aggregate all client gradients:
            ∇F(w_i) = (1/n) · Σ_j ∇f_j(w_i)

Steps 5–7:  For each round i ∈ [t], compute gradient residual for client i_u:
            δ_i = (η/n) · [(1/(n−1)) · Σ_{j≠i_u} ∇f_j(w_i) − ∇f_{i_u}(w_i)]

Step 8:     Compute per-round weights:
            p_i = ‖∇F(w_i)‖² / Σ_{j=1}^{t−1} ‖∇F(w_j)‖²

Step 9:     Subtract weighted residuals from the model:
            w̄_t = w_t − Σ_{i=1}^{t−1} p_i · δ_i

Steps 10–11: Sample z ~ N(0, σ²I_d), return  w_u = w̄_t + z
```

The `(ε, β)`-indistinguishability guarantee (Theorem 1) holds only when **all** steps are executed correctly and σ is calibrated by the theoretical bound `d`.

---

## Critical Issues (must fix before merge)

### C-1 · Wrong Data Type Archived — Weighted Deltas Instead of Gradients

**Location:** `fl_server/fed_recovery.py` (entire engine) | `fl_server/server.py:1374–1401`

**What the paper requires:**
Algorithm 2 takes as input **individual per-client gradients** `∇f_i(w_j)` — the raw gradient vector returned by each client for each training round.

**What the implementation archives:**
`server.py:1374–1401` computes and archives:

```python
delta = ndarrays[i] - global_state[key].cpu().numpy()          # Δw_i = client_params − global_params
delta = np.clip(delta, -10.0, 10.0)
scaled = (delta * w).flatten().tolist()                         # w = trust_weight / total_weight
cipher = ts.ckks_vector(self.ckks_ctx, scaled)                  # CKKS encrypt the scaled delta
```

This is `α_i · Δw_i` — a **trust-weighted, normalised parameter delta** — not the gradient `∇f_i(w_j)`. The individual contributions of non-flagged clients are irrecoverably merged into the weight scheme before archival.

**Impact:**
The gradient residual `δ_i` (Eq. 13) cannot be computed from the archived data:

```
δ_i = (η/n) · [(1/(n−1)) · Σ_{j≠i_u} ∇f_j(w_i) − ∇f_{i_u}(w_i)]
```

Both `∇f_{i_u}(w_i)` (flagged client's gradient) and `Σ_{j≠i_u} ∇f_j(w_i)` (sum of remaining clients' gradients) are unavailable. **The entire mathematical core of the algorithm is absent.**

---

### C-2 · Gradient Residual `δ_i` Never Computed

**Location:** `fl_server/fed_recovery.py:434`

**What the paper requires (Algorithm 2, steps 5–7):**
For each round `i`, compute:
```
δ_i = (η/n) · [(1/(n−1)) · Σ_{j≠i_u} ∇f_j(w_i) − ∇f_{i_u}(w_i)]
```

**What the implementation does:**
```python
raw_correction = {k: -v for k, v in flagged_contribution.items()}
```

The implementation simply negates the stored weighted delta. This is not equivalent to the gradient residual — it omits the `1/(n−1)` scaling of remaining clients' contributions, the learning rate `η`, and the per-round `n` normalisation factor. The correction applied to the model is not `Σ p_i · δ_i` but an unnormalised, unweighted negation of a proxy quantity.

**Impact:**
Theorem 2 proves `sup‖w̄_t − w̃_t‖ ≤ sup‖w_t − w̃_t‖` only for a `w̄_t` computed via the correct `δ_i`. Without this, the distance bound used to calibrate `σ` does not hold.

---

### C-3 · Per-Round Weights `p_i` Never Computed or Applied

**Location:** `fl_server/fed_recovery.py:193–204`, `369–472`

**What the paper requires (Algorithm 2, step 8):**
```
p_i = ‖∇F(w_i)‖² / Σ_{j=1}^{t−1} ‖∇F(w_j)‖²
```

The weights reflect each round's gradient norm squared, so that rounds where the global model changed most (highest gradient activity) receive the largest weight in the correction.

**What the implementation does:**
Flat unweighted subtraction — every round's correction is applied equally, with no reference to the aggregated gradient norms.

**Evidence that the data exists but is unused:**

`server.py:562` *does* call `self._archive.store_agg(rnd, self._last_agg_gradient)` every round, meaning `‖∇F(w_i)‖` is available via `GradientArchive.get_agg()`. However, searching `fed_recovery.py` for `get_agg` returns **zero hits** — the stored aggregated gradients are never read during recovery.

**Impact:**
- Theorem 2's proof (Eq. 28) relies on `p_j ≤ 1` ∀ j to bound the distance. Without weights, this inequality is replaced by a flat weight of 1 per round, which can accumulate to far exceed the bound.
- Rounds with near-zero gradient activity receive the same weight as high-activity rounds, distorting the correction.

---

### C-4 · Sigma Cap Always Fires, Degrading Effective ε by ~48×

**Location:** `fl_server/fed_recovery.py:354`

**The line:**
```python
sigma = min(sigma, sensitivity * 10.0)  # cap at 10× sensitivity
```

**Numerical analysis** (default `ε=0.10`, `δ=1e-5`):

| Sensitivity | σ required | Cap (10×) | σ applied | Actual ε |
|-------------|-----------|-----------|-----------|----------|
| 0.1 | 4.84 | 1.0 | **1.0** ✗ | 0.484 |
| 0.5 | 24.2 | 5.0 | **5.0** ✗ | 0.484 |
| 1.0 | 48.4 | 10.0 | **10.0** ✗ | 0.484 |
| 2.0 | 96.9 | 20.0 | **20.0** ✗ | 0.484 |
| 5.0 | 242 | 50.0 | **50.0** ✗ | 0.484 |
| 10.0 | 484 | 100.0 | **100.0** ✗ | 0.484 |
| 20.0 | 969 | 200.0 | **200.0** ✗ | 0.484 |

The cap fires for **every** sensitivity value with the default parameters. Because `sigma_required = k × sensitivity` and `cap = 10 × sensitivity`, the cap always applies when `k > 10`, i.e., when `k = √(2 ln(1.25/δ))/ε = 48.4 >> 10`. As a result, the effective ε is always locked at approximately **4.84** — regardless of what value is passed as `epsilon`.

The claimed `ε=0.10` is **never** achieved. The model is under-noised by a factor of ~4.84×.

**The paper specifies no such cap.** It would only be valid if the correct theoretical bound `d` (Theorem 3) were used as sensitivity, which would naturally be bounded.

---

### C-5 · Sigma Formula Is from a Different DP Framework

**Location:** `fl_server/fed_recovery.py:48–54`

**Implementation:**
```python
def _gaussian_sigma(sensitivity: float, epsilon: float, delta: float) -> float:
    """Uses the standard formula: σ = sqrt(2 ln(1.25/δ)) · Δf / ε"""
    return math.sqrt(2.0 * math.log(1.25 / delta)) * sensitivity / epsilon
```

**Paper (Algorithm 2, step 1 / Eq. 25):**
```
σ = (1/√2) · d / (√(log(1/β) + ε) − √(log(1/β)))
```
Derived by inverting the paper's Gaussian Mechanism definition (Eq. 6):
```
ε = 1/(2σ²) + (1/σ) · √(2 log(1/β))
```

These are **two different formulas** from two different parameterisations of the Gaussian mechanism. The implementation uses the standard Dwork/Roth `(ε, δ)`-DP formula. The paper's Theorem 1 proof is built explicitly on its Eq. 6 / Eq. 25 derivation and achieves `(ε, β)`-indistinguishability (Definition 1). The implementation does not achieve the notion proved in Theorem 1.

Numerically, for `ε=0.10, δ=1e-5, sensitivity=1`:
- Implementation: σ ≈ **48.45**
- Paper: σ ≈ **48.09**
- Ratio: 1.0075 (≈ 0.75% larger — close, but mathematically distinct guarantees)

The formulas are numerically close for small `ε`, but they are not the same guarantee and their divergence grows for larger `ε`.

---

### C-6 · Sensitivity Is Data-Dependent; Paper Requires a Theoretical Bound

**Location:** `fl_server/fed_recovery.py:350–351`

**Implementation:**
```python
sensitivity = sum(t.norm().item() for t in correction.values())
sensitivity = max(sensitivity, 1e-6)
```

**Paper (Theorem 3, Eqs. 34–36):**
The sensitivity `d` is derived analytically from training hyperparameters:
```
d = √( Σ η_t · [F(w_0)−F(w*) + (LG²/2) · Σ η_t²] ) + D_t
```

This is a **data-independent, theoretical upper bound** on `‖w̄_t − w̃_t‖` that depends on learning rate `η`, smoothness `L`, gradient norm bound `G`, number of rounds `t`, and the training trajectory constant `D_t`.

**Impact of using a data-dependent sensitivity:**
1. The noise magnitude reveals information about the model update, potentially allowing an adversary to infer characteristics of the corrected layers by observing the noise level.
2. If the correction happens to be small (benign-looking), the noise is also small, offering less protection precisely when the model is closest to the retrained one — inverting the intended privacy relationship.
3. Using different sensitivity values across different recovery runs for the same client makes it impossible to compose the privacy budget across runs.

---

## Warnings (should fix)

### W-1 · Perturbed Learning Algorithm (Algorithm 1) Not Implemented

**Location:** `fl_server/server.py` — standard FL training, no corresponding `fed_recovery.py` location

The paper requires **both** the retrained model *and* the unlearned model to be Gaussian-perturbed outputs:
- `ŵ_t = w̃_t + z`  (perturbed retrained model — Algorithm 1)
- `w_u = w̄_t + z`  (unlearned model — Algorithm 2)

Where `z ~ N(0, σ²I_d)` in **both** cases with the **same** `σ`.

Theorem 1's proof compares `ŵ_t ~ N(w̃_t, σ²I_d)` against `w_u ~ N(w̄_t, σ²I_d)` and uses Theorem 2/3 to bound `‖w̄_t − w̃_t‖`, allowing the Gaussian mechanism to guarantee indistinguishability.

Without noise in training (Algorithm 1 missing), there is no distribution `N(w̃_t, σ²I_d)` — only a point `w̃_t`. The two-sided indistinguishability condition (Eq. 7 / Eq. 22) cannot hold.

---

### W-2 · Aggregated Gradient Norms Stored but Never Consumed

**Location:** `fl_server/server.py:559–564` (writes), `fl_server/fed_recovery.py` (never reads)

Every normal FL round writes the aggregated gradient delta to the archive:
```python
if self._last_agg_gradient:
    self._archive.store_agg(rnd, self._last_agg_gradient)
```

These tensors are needed to compute weights `p_i = ‖∇F(w_i)‖² / Σ‖∇F(w_j)‖²` (C-3 above). `GradientArchive.get_agg()` is fully implemented and thread-safe, but `FedRecoveryEngine` never calls it — zero hits for `get_agg` in `fed_recovery.py`.

The stored tensors consume up to 200 MB of the archive budget (`MAX_BYTES`) without providing any benefit in the current implementation.

---

### W-3 · `flag_round` Parameter Accepted but Ignored in Round Filtering

**Location:** `fl_server/fed_recovery.py:101–105, 133`

```python
def run(self, flagged_client_id: str, flag_round: int) -> dict:
    ...
    archived_rounds: List[int] = self._archive.get_client_rounds(flagged_client_id)
```

`flag_round` is logged and included in the backend POST payload, but `get_client_rounds()` returns **all** archived rounds for the client regardless of `flag_round`. The paper addresses unlearning up to the point of the request — rounds after the flag round represent the client's post-detection behaviour and should arguably not be processed (the client may already have been excluded from aggregation at that point). The current behaviour processes all rounds indiscriminately.

---

## Nitpicks (optional)

### N-1 · `_apply_correction` Uses Addition on a Pre-Negated Correction

**Location:** `fl_server/fed_recovery.py:315–324`

```python
def _apply_correction(self, correction: Dict[str, torch.Tensor]) -> None:
    state = OrderedDict(self._model.state_dict())
    for layer, delta in correction.items():
        if layer in state:
            state[layer] = state[layer].cpu() + delta.cpu()   # ← addition
```

The correction is negated before this call (`raw_correction = {k: -v ...}` at line 434), so `state += (−contribution + noise)` is mathematically equivalent to subtraction. The result is correct, but the method name `_apply_correction` with a `+` operator will mislead future readers. Either negate inside `_apply_correction` and pass the positive contribution, or rename to `_add_correction_delta`.

---

### N-2 · `sigma_used` Summary Captures Only the First Round's Sigma

**Location:** `fl_server/fed_recovery.py:201–202`

```python
if sigma_used is None:
    sigma_used = step_result.get("sigma")
```

Because sensitivity is data-dependent (C-6), `sigma` varies per round. The summary dict and backend POST reflect only round-1's sigma value, which may not be representative of the protection applied across all corrected rounds. The per-round sigma is correctly logged to the backend via the `/step` POST, so this is a reporting inconsistency rather than a security issue.

---

### N-3 · Architectural Divergence from Paper's Intended Use Case

The paper positions FedRecovery as a **GDPR "right to be forgotten" mechanism**, triggered by a client's explicit unlearning request after training completes.

The implementation triggers FedRecovery as a **security countermeasure**, activated when RECESS anomaly detection flags a client (`abnormality > 0.7` → trust score falls below `FLAG_THRESHOLD`). This is a valid and arguably more useful design choice for an IoT IDS context, but the docstring (`fed_recovery.py:1–25`) references the paper's security framing without acknowledging that the trigger semantics differ fundamentally. Consider updating the module docstring to clarify the intended use.

---

## Coverage Gaps

| Component | Gap |
|-----------|-----|
| `fl_server/fed_recovery.py` | **No tests at all.** None of the following are exercised: sigma calculation, correction application, VSS reconstruction failure, cancellation mid-run, `partial`/`failed` status transitions, per-round skipping logic. |
| `fl_server/gradient_archive.py` | No tests for FIFO eviction under memory pressure, `evict_before`, concurrent `store_enc`/`store_agg` under lock contention, or `stats()` accuracy. |
| Sigma formula | No test verifies that the effective ε achieved matches the requested ε (which would catch C-4 and C-5). |

---

## What Did Pass

| Check | Result |
|-------|--------|
| Python syntax (`py_compile`) | ✅ Clean for `fed_recovery.py` and `gradient_archive.py` |
| Backend test suite | ✅ 12/14 passing (2 pre-existing fixture errors, Docker-dependent) |
| Thread safety (`GradientArchive`) | ✅ `threading.Lock` guards all read/write paths correctly |
| VSS private key lifecycle | ✅ Private context destroyed in `finally` block (line 207–208) regardless of exception |
| Crash-safe step commits | ✅ Each round POSTs to `/fedrecovery/step` individually before proceeding |
| Cancellation guard | ✅ `_cancelled` checked at the top of the per-round loop |
| FIFO eviction logic | ✅ Alternates between enc/agg stores, terminates correctly when both are empty |
| Overflow / NaN guards | ✅ `np.nan_to_num` applied after decryption; `np.clip` applied before encryption |

---

## Issue Priority Matrix

| ID | Severity | File | Line(s) | Summary |
|----|----------|------|---------|---------|
| C-1 | 🔴 Critical | `server.py` + `fed_recovery.py` | 1374–1401 / all | Archived data is weighted deltas, not gradients |
| C-2 | 🔴 Critical | `fed_recovery.py` | 434 | Gradient residual `δ_i` never computed |
| C-3 | 🔴 Critical | `fed_recovery.py` | 193–204, 369–472 | Per-round weights `p_i` absent |
| C-4 | 🔴 Critical | `fed_recovery.py` | 354 | Sigma cap locks effective ε ≈ 4.84 always |
| C-5 | 🔴 Critical | `fed_recovery.py` | 48–54 | Wrong sigma formula (different DP framework) |
| C-6 | 🔴 Critical | `fed_recovery.py` | 350–351 | Data-dependent sensitivity instead of theoretical bound |
| W-1 | 🟡 Warning | `server.py` | — | Algorithm 1 (perturbed learning) not implemented |
| W-2 | 🟡 Warning | `fed_recovery.py` | 193–204 | Aggregated gradient norms stored but never consumed |
| W-3 | 🟡 Warning | `fed_recovery.py` | 101–105 | `flag_round` ignored in round selection |
| N-1 | 🔵 Nitpick | `fed_recovery.py` | 315–324 | Confusing `+` on pre-negated correction |
| N-2 | 🔵 Nitpick | `fed_recovery.py` | 201–202 | `sigma_used` reflects only round-1 sigma |
| N-3 | 🔵 Nitpick | `fed_recovery.py` | 1–25 (docstring) | Trigger semantics diverge from paper |

---

*Report generated by QA Agent — March 31, 2026*
