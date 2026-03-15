"""
RECESS — Robust Evaluation via Controlled Experiment Simulation Suite.

Behavioural probing mechanism for detecting gradient poisoning in federated
learning.  Runs every RECESS_INTERVAL training rounds: the server constructs
a synthetic test gradient close to the last aggregated gradient and sends it
to each client as a probe.  A client whose response deviates abnormally in
direction or magnitude receives a lower trust score; trust scores below
FLAG_THRESHOLD cause that client to be excluded from aggregation.

Gradients are always ``dict[str, torch.Tensor]`` keyed by layer name, matching
the structure used throughout ``fl_common/he_utils.py``.
"""

import torch
import torch.nn.functional as F

from fl_common.model import SELECTED_LAYERS

# ── Module-level constants ─────────────────────────────────────────────────

RECESS_INTERVAL: int = 5
"""Run RECESS detection every N training rounds."""

DIRECTION_THRESH: float = 0.9510
"""Minimum cosine similarity (≈ cos 18°) between original and test gradient."""

TRUST_DECAY: float = 0.9
"""Exponential decay weight applied to the existing trust score each round."""

FLAG_THRESHOLD: float = 0.3
"""Trust score strictly below this value triggers a poisoning flag."""


# ── Public helpers ─────────────────────────────────────────────────────────


def flatten_gradient(
    gradient: dict[str, torch.Tensor],
) -> torch.Tensor:
    """Flatten all tensors in *gradient* into a single 1-D float32 tensor.

    Tensors are concatenated in ascending key order for determinism.

    Args:
        gradient: Layer-name → parameter-update mapping.

    Returns:
        A 1-D ``torch.float32`` tensor containing all values concatenated.
    """
    parts = [
        gradient[key].cpu().detach().float().flatten()
        for key in sorted(gradient.keys())
    ]
    return torch.cat(parts)


def construct_test_gradient(
    last_agg_gradient: dict[str, torch.Tensor],
) -> dict[str, torch.Tensor]:
    """Build a test gradient from the last round's aggregated gradient.

    The result is intentionally close to the original so that an honest client
    whose internal gradient also aligns with the aggregated direction will
    respond coherently.  An attacker cannot easily distinguish the probe from
    a real aggregated gradient.

    Algorithm:
        1. Flatten all tensors into one 1-D float32 vector.
        2. Normalise to unit length.
        3. Add small Gaussian noise (std=0.01) to the first 10 % of dimensions.
        4. Re-normalise.
        5. Verify ``cosine_similarity(original_flat, result_flat)`` ≥
           ``DIRECTION_THRESH``.  If not, reduce noise and retry (max 10
           attempts).
        6. Reshape back into the original ``dict[str, torch.Tensor]`` structure.

    Args:
        last_agg_gradient: The aggregated gradient from the previous round.

    Returns:
        Test gradient dict with the same keys and tensor shapes as the input.

    Raises:
        RuntimeError: If the cosine-similarity threshold cannot be met after
            the maximum number of retry attempts.
    """
    original_flat = flatten_gradient(last_agg_gradient)
    orig_norm = torch.norm(original_flat).item()

    # Handle degenerate zero-vector input
    if orig_norm < 1e-8:
        return {key: tensor.clone() for key, tensor in last_agg_gradient.items()}

    unit = original_flat / orig_norm

    n_dims = unit.numel()
    perturb_len = max(1, n_dims // 10)

    noise_std = 0.01
    max_attempts = 10
    result_flat: torch.Tensor | None = None

    for attempt in range(max_attempts):
        candidate = unit.clone()
        noise = torch.randn(perturb_len, dtype=torch.float32) * noise_std
        candidate[:perturb_len] = candidate[:perturb_len] + noise

        # Re-normalise
        c_norm = torch.norm(candidate).item()
        if c_norm < 1e-8:
            noise_std *= 0.5
            continue
        candidate = candidate / c_norm

        sim = F.cosine_similarity(
            unit.unsqueeze(0), candidate.unsqueeze(0)
        ).item()

        if sim >= DIRECTION_THRESH:
            result_flat = candidate
            break

        # Reduce noise and try again
        noise_std *= 0.5

    if result_flat is None:
        raise RuntimeError(
            f"construct_test_gradient: could not meet DIRECTION_THRESH "
            f"({DIRECTION_THRESH}) after {max_attempts} attempts."
        )

    # ── Fix A: Restore original magnitude ─────────────────────────────────
    # The probe was normalised to unit length for direction perturbation.
    # Scale it back to the original gradient's magnitude so that the
    # magnitude comparison in compute_abnormality_components() is meaningful.
    result_flat = result_flat * orig_norm

    # Reconstruct dict with original shapes (use sorted key order to match flatten)
    test_gradient: dict[str, torch.Tensor] = {}
    offset = 0
    for key in sorted(last_agg_gradient.keys()):
        shape = last_agg_gradient[key].shape
        numel = last_agg_gradient[key].numel()
        test_gradient[key] = result_flat[offset : offset + numel].reshape(shape)
        offset += numel

    return test_gradient


def compute_abnormality_components(
    test_flat: torch.Tensor,
    response_flat: torch.Tensor,
) -> tuple[float, float, float]:
    """Compute the full abnormality breakdown from flat gradient vectors.

    Returns all three values needed to explain *why* a client received a
    particular abnormality score.

    Score = 0.5 × direction_score + 0.5 × magnitude_score

    Where::

        direction_score = clamp(1 − cosine_similarity(test, response), 0, 1)

        magnitude_score = clamp(
            (‖response‖ / (‖test‖ + ε) − 1) / 2,
            0, 1
        )

    Args:
        test_flat:     1-D float32 tensor — the (normalised) test gradient.
        response_flat: 1-D float32 tensor — the client's response gradient,
                       flattened to the same length.

    Returns:
        ``(abnormality, direction_score, magnitude_score)`` — all Python
        ``float`` values in [0.0, 1.0].
    """
    norm_test = torch.norm(test_flat).item()
    norm_resp = torch.norm(response_flat).item()

    # ── Fix C: Graceful near-zero handling ───────────────────────────────
    # Both vectors near zero → no meaningful signal → benign (no penalty).
    # Only one vector near zero → uncertain → mild concern (0.5).
    # Previously this returned (1.0, 1.0, 1.0) which unfairly penalized
    # clients on startup or low-activity rounds.
    if norm_test < 1e-8 and norm_resp < 1e-8:
        return 0.0, 0.0, 0.0
    if norm_test < 1e-8 or norm_resp < 1e-8:
        return 0.5, 0.5, 0.5

    # Direction score
    cos_sim = F.cosine_similarity(
        test_flat.unsqueeze(0), response_flat.unsqueeze(0)
    ).item()
    direction_score = max(0.0, min(1.0, 1.0 - cos_sim))

    # Magnitude score
    magnitude_score = max(0.0, min(1.0, (norm_resp / (norm_test + 1e-8) - 1.0) / 2.0))

    abnormality = 0.5 * direction_score + 0.5 * magnitude_score
    return abnormality, direction_score, magnitude_score


def compute_abnormality(
    test_flat: torch.Tensor,
    response_flat: torch.Tensor,
) -> float:
    """Compute an abnormality score in [0, 1] from flat gradient vectors.

    Backward-compatible wrapper around :func:`compute_abnormality_components`
    that returns only the combined score.

    A score near 0 means the response is benign; a score near 1 means the
    response is highly anomalous.

    Args:
        test_flat:     1-D float32 tensor — the (normalised) test gradient.
        response_flat: 1-D float32 tensor — the client's response gradient,
                       flattened to the same length.

    Returns:
        Abnormality score as a Python ``float`` in [0.0, 1.0].
    """
    abnormality, _, _ = compute_abnormality_components(test_flat, response_flat)
    return abnormality


def update_trust_score(
    current_score: float,
    abnormality: float,
) -> float:
    """Update trust score using exponential decay weighting.

    A benign response (abnormality ≈ 0) keeps the score high; a malicious
    response (abnormality ≈ 1) drives the score towards 0 over time.

    Formula::

        new_score = TRUST_DECAY × current_score + (1 − TRUST_DECAY) × (1 − abnormality)

    Args:
        current_score: Existing trust score in [0.0, 1.0].
        abnormality:   Most recent abnormality measurement in [0.0, 1.0].

    Returns:
        Updated trust score clamped to [0.0, 1.0].
    """
    new_score = TRUST_DECAY * current_score + (1.0 - TRUST_DECAY) * (1.0 - abnormality)
    return max(0.0, min(1.0, new_score))


def is_flagged(trust_score: float) -> bool:
    """Return ``True`` if the client's trust score is below ``FLAG_THRESHOLD``.

    Args:
        trust_score: Current trust score in [0.0, 1.0].

    Returns:
        ``True`` when ``trust_score < FLAG_THRESHOLD``, otherwise ``False``.
    """
    return trust_score < FLAG_THRESHOLD


# ── Inline tests ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    torch.manual_seed(0)

    # ── 1. Fake gradient matching realistic SELECTED_LAYERS shapes ──────────
    # lstm.weight_ih_l0: (4*hidden, input) = (256, 64) — Conv output is 64-dim
    # lstm.weight_hh_l0: (4*hidden, hidden) = (256, 64)
    # fc.weight: (1, 64)
    # fc.bias:   (1,)
    fake_grad: dict[str, torch.Tensor] = {
        "lstm.weight_ih_l0": torch.randn(256, 64),
        "lstm.weight_hh_l0": torch.randn(256, 64),
        "fc.weight":          torch.randn(1, 64),
        "fc.bias":            torch.randn(1),
    }
    assert set(fake_grad.keys()) == set(SELECTED_LAYERS), (
        "Fake gradient keys must match SELECTED_LAYERS"
    )

    # ── 2. construct_test_gradient — direction + magnitude preserved ────────
    test_grad = construct_test_gradient(fake_grad)

    orig_flat = flatten_gradient(fake_grad)
    test_flat = flatten_gradient(test_grad)

    assert orig_flat.shape == test_flat.shape, (
        f"Shape mismatch: {orig_flat.shape} vs {test_flat.shape}"
    )
    for key in fake_grad:
        assert fake_grad[key].shape == test_grad[key].shape, (
            f"Shape mismatch for layer {key}"
        )

    cos_sim = F.cosine_similarity(
        orig_flat.unsqueeze(0), test_flat.unsqueeze(0)
    ).item()
    assert cos_sim >= DIRECTION_THRESH, (
        f"Cosine similarity {cos_sim:.6f} < DIRECTION_THRESH {DIRECTION_THRESH}"
    )

    # Fix A validation: probe magnitude ≈ original magnitude (not 1.0)
    orig_norm = torch.norm(orig_flat).item()
    probe_norm = torch.norm(test_flat).item()
    mag_ratio = probe_norm / (orig_norm + 1e-8)
    print(f"  Probe magnitude: orig_norm={orig_norm:.4f}  probe_norm={probe_norm:.4f}  ratio={mag_ratio:.4f}")
    assert 0.9 < mag_ratio < 1.1, (
        f"Probe norm should be ≈ original norm, got ratio={mag_ratio:.4f} "
        f"(orig={orig_norm:.4f}, probe={probe_norm:.4f})"
    )

    # ── 3. compute_abnormality — benign client (realistic simulation) ───────
    # Simulate what Fix B does server-side: compare Δ_i vs probe (≈ avg(Δ))
    # A benign client's Δ_i should be close in direction and magnitude to avg(Δ)
    # Note: randn_like produces a vector with expected norm ≈ sqrt(n) ≈ orig_norm,
    # so multiplying by 0.1 gives noise with ~10% of the gradient's norm.
    benign_delta = orig_flat + torch.randn_like(orig_flat) * 0.1
    benign_score, benign_dir, benign_mag = compute_abnormality_components(test_flat, benign_delta)
    print(f"  Benign client:  abnormality={benign_score:.4f}  dir={benign_dir:.4f}  mag={benign_mag:.4f}")
    assert benign_score < 0.3, (
        f"Benign client (similar direction+magnitude) should have abnormality < 0.3, got {benign_score:.6f}"
    )

    # Identical vectors → score ≈ 0
    same_score = compute_abnormality(orig_flat, orig_flat)
    print(f"  Identical vecs: abnormality={same_score:.4f}")
    assert same_score < 0.1, (
        f"Identical vectors should yield score < 0.1, got {same_score:.6f}"
    )

    # Orthogonal vectors → large direction divergence → score > 0.4
    n = orig_flat.numel()
    orth_vec = torch.randn(n)
    unit_orig = orig_flat / orig_norm
    orth_vec = orth_vec - (orth_vec @ unit_orig) * unit_orig
    orth_norm = torch.norm(orth_vec).item()
    if orth_norm > 1e-8:
        orth_vec = orth_vec / orth_norm * orig_norm  # same magnitude, perpendicular direction
    orth_score, orth_dir, orth_mag = compute_abnormality_components(test_flat, orth_vec)
    print(f"  Orthogonal:     abnormality={orth_score:.4f}  dir={orth_dir:.4f}  mag={orth_mag:.4f}")
    assert orth_score > 0.4, (
        f"Orthogonal vectors should yield score > 0.4, got {orth_score:.6f}"
    )

    # ── 4. Fix C validation: near-zero edge cases ───────────────────────────
    zero_vec = torch.zeros(100)
    nonzero_vec = torch.randn(100)

    # Both zero → benign (no signal)
    a, d, m = compute_abnormality_components(zero_vec, zero_vec)
    print(f"  Both zero:      abnormality={a:.4f}  dir={d:.4f}  mag={m:.4f}")
    assert a == 0.0 and d == 0.0 and m == 0.0, (
        f"Both-zero should return (0,0,0), got ({a}, {d}, {m})"
    )

    # One zero → uncertain (0.5)
    a, d, m = compute_abnormality_components(zero_vec, nonzero_vec)
    print(f"  One zero:       abnormality={a:.4f}  dir={d:.4f}  mag={m:.4f}")
    assert a == 0.5 and d == 0.5 and m == 0.5, (
        f"One-zero should return (0.5,0.5,0.5), got ({a}, {d}, {m})"
    )

    # ── 5. update_trust_score — decay to below FLAG_THRESHOLD ───────────────
    score = 1.0
    for _ in range(20):
        score = update_trust_score(score, abnormality=1.0)
    assert score < FLAG_THRESHOLD, (
        f"After 20 rounds of max abnormality, trust score {score:.6f} "
        f"should be < FLAG_THRESHOLD ({FLAG_THRESHOLD})"
    )

    # Benign trust: 20 rounds of low abnormality → trust stays high
    score_benign = 1.0
    for _ in range(20):
        score_benign = update_trust_score(score_benign, abnormality=0.1)
    print(f"  Benign trust after 20 rounds: {score_benign:.4f}")
    assert score_benign > 0.85, (
        f"After 20 rounds of low abnormality, trust should stay > 0.85, got {score_benign:.6f}"
    )

    # ── 6. is_flagged ────────────────────────────────────────────────────────
    assert is_flagged(0.29) is True,  "0.29 should be flagged"
    assert is_flagged(0.31) is False, "0.31 should NOT be flagged"

    print("\nALL RECESS TESTS PASSED ✓")
