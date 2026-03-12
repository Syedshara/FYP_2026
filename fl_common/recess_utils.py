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

    # Reconstruct dict with original shapes (use sorted key order to match flatten)
    test_gradient: dict[str, torch.Tensor] = {}
    offset = 0
    for key in sorted(last_agg_gradient.keys()):
        shape = last_agg_gradient[key].shape
        numel = last_agg_gradient[key].numel()
        test_gradient[key] = result_flat[offset : offset + numel].reshape(shape)
        offset += numel

    return test_gradient


def compute_abnormality(
    test_flat: torch.Tensor,
    response_flat: torch.Tensor,
) -> float:
    """Compute an abnormality score in [0, 1] from flat gradient vectors.

    A score near 0 means the response is benign; a score near 1 means the
    response is highly anomalous.

    Score = 0.5 × direction_score + 0.5 × magnitude_score

    Where::

        direction_score = clamp(1 − cosine_similarity(test, response), 0, 1)

        magnitude_score = clamp(
            (‖response‖ / (‖test‖ + ε) − 1) / 2,
            0, 1
        )

    The magnitude score rises when the response norm is substantially larger
    than the test norm, which is a common signature of gradient amplification
    attacks.

    Args:
        test_flat:     1-D float32 tensor — the (normalised) test gradient.
        response_flat: 1-D float32 tensor — the client's response gradient,
                       flattened to the same length.

    Returns:
        Abnormality score as a Python ``float`` in [0.0, 1.0].
    """
    norm_test = torch.norm(test_flat).item()
    norm_resp = torch.norm(response_flat).item()

    # Zero-vector edge case → maximally abnormal
    if norm_test < 1e-8 or norm_resp < 1e-8:
        return 1.0

    # Direction score
    cos_sim = F.cosine_similarity(
        test_flat.unsqueeze(0), response_flat.unsqueeze(0)
    ).item()
    direction_score = max(0.0, min(1.0, 1.0 - cos_sim))

    # Magnitude score
    magnitude_score = max(0.0, min(1.0, (norm_resp / (norm_test + 1e-8) - 1.0) / 2.0))

    return 0.5 * direction_score + 0.5 * magnitude_score


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

    # ── 2. construct_test_gradient ──────────────────────────────────────────
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

    # ── 3. compute_abnormality ──────────────────────────────────────────────
    # Identical normalised vectors → score ≈ 0
    unit_vec = orig_flat / torch.norm(orig_flat)
    same_score = compute_abnormality(unit_vec, unit_vec)
    assert same_score < 0.1, (
        f"Identical vectors should yield score < 0.1, got {same_score:.6f}"
    )

    # Orthogonal vectors → large direction divergence → score > 0.4
    n = unit_vec.numel()
    orth_vec = torch.randn(n)
    # Project out the component along unit_vec to make truly orthogonal
    orth_vec = orth_vec - (orth_vec @ unit_vec) * unit_vec
    orth_norm = torch.norm(orth_vec).item()
    if orth_norm > 1e-8:
        orth_vec = orth_vec / orth_norm
    orth_score = compute_abnormality(unit_vec, orth_vec)
    assert orth_score > 0.4, (
        f"Orthogonal vectors should yield score > 0.4, got {orth_score:.6f}"
    )

    # ── 4. update_trust_score — decay to below FLAG_THRESHOLD ───────────────
    score = 1.0
    for _ in range(20):
        score = update_trust_score(score, abnormality=1.0)
    assert score < FLAG_THRESHOLD, (
        f"After 20 rounds of max abnormality, trust score {score:.6f} "
        f"should be < FLAG_THRESHOLD ({FLAG_THRESHOLD})"
    )

    # ── 5. is_flagged ────────────────────────────────────────────────────────
    assert is_flagged(0.29) is True,  "0.29 should be flagged"
    assert is_flagged(0.31) is False, "0.31 should NOT be flagged"

    print("ALL RECESS TESTS PASSED")
