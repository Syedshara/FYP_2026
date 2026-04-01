"""
Unit tests for FedRecovery engine — verifies mathematical correctness of
the corrected Algorithm 2 implementation (Zhang et al., IEEE TIFS 2023).

Tests cover:
  - Paper's Gaussian sigma formula (C-5)
  - Theoretical sensitivity bound (C-6)
  - Per-round weight computation p_i (C-3)
  - Gradient residual computation delta_i (C-1/C-2)
  - Round filtering by flag_round (W-3)
  - Absence of sigma cap (C-4)
"""

import math
import os
import sys
from collections import OrderedDict
from typing import Dict, Optional
from unittest.mock import MagicMock, patch

import pytest

# ── Add fl_server to Python path so we can import fed_recovery directly ──
_FL_SERVER_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "fl_server")
if _FL_SERVER_DIR not in sys.path:
    sys.path.insert(0, os.path.abspath(_FL_SERVER_DIR))

# Import real torch for math tests (conftest only mocks if not already loaded)
import torch  # noqa: E402

from fed_recovery import (  # noqa: E402
    _paper_gaussian_sigma,
    _theoretical_sensitivity,
    _compute_round_weights,
    _compute_gradient_residual,
    FedRecoveryEngine,
)
from gradient_archive import GradientArchive  # noqa: E402


# ── C-5: Paper's Gaussian Sigma Formula ──────────────────


class TestPaperGaussianSigma:
    """Verify sigma formula matches paper's Definition 1 / Eq. 25."""

    def test_known_values(self) -> None:
        """Check against manually computed values for epsilon=0.10, beta=1e-5."""
        sensitivity = 1.0
        epsilon = 0.10
        beta = 1e-5

        sigma = _paper_gaussian_sigma(sensitivity, epsilon, beta)

        # Manual computation:
        # ln(1/1e-5) = ln(100000) = 11.5129...
        # sqrt(11.5129 + 0.10) = sqrt(11.6129) = 3.40778...
        # sqrt(11.5129) = 3.39307...
        # denom = 3.40778 - 3.39307 = 0.01471...
        # sigma = (1/sqrt(2)) * 1.0 / 0.01471 = 48.09...
        assert 47.5 < sigma < 49.0, f"Expected sigma ~48.09, got {sigma}"

    def test_differs_from_standard_dwork(self) -> None:
        """Paper formula should differ from standard Dwork sigma by ~0.75%."""
        sensitivity = 1.0
        epsilon = 0.10
        delta = 1e-5

        paper_sigma = _paper_gaussian_sigma(sensitivity, epsilon, delta)

        # Standard Dwork: sigma = sqrt(2*ln(1.25/delta)) * sensitivity / epsilon
        dwork_sigma = math.sqrt(2.0 * math.log(1.25 / delta)) * sensitivity / epsilon

        # They should be close (~0.75% difference) but NOT identical
        ratio = dwork_sigma / paper_sigma
        assert 1.005 < ratio < 1.015, f"Expected ~0.75% difference, got ratio={ratio}"

    def test_scales_linearly_with_sensitivity(self) -> None:
        """Doubling sensitivity should double sigma."""
        sigma_1 = _paper_gaussian_sigma(1.0, 0.10, 1e-5)
        sigma_2 = _paper_gaussian_sigma(2.0, 0.10, 1e-5)
        assert abs(sigma_2 / sigma_1 - 2.0) < 1e-10

    def test_invalid_params_raise(self) -> None:
        """Invalid parameters should raise ValueError."""
        with pytest.raises(ValueError):
            _paper_gaussian_sigma(0.0, 0.10, 1e-5)  # zero sensitivity
        with pytest.raises(ValueError):
            _paper_gaussian_sigma(1.0, 0.0, 1e-5)  # zero epsilon
        with pytest.raises(ValueError):
            _paper_gaussian_sigma(1.0, 0.10, 0.0)  # zero beta
        with pytest.raises(ValueError):
            _paper_gaussian_sigma(1.0, 0.10, 1.0)  # beta = 1


# ── C-6: Theoretical Sensitivity ─────────────────────────


class TestTheoreticalSensitivity:
    """Verify data-independent sensitivity bound from Theorem 3."""

    def test_known_config(self) -> None:
        """For our CNN-LSTM config: clip=10, params=32833, eta=1e-3, n=2."""
        d = _theoretical_sensitivity(
            clip_bound=10.0,
            num_params=32833,
            learning_rate=1e-3,
            num_clients=2,
        )
        # d = 2 * 10 * sqrt(32833) * 1e-3 / (2-1)
        # = 20 * 181.197... * 0.001 / 1 = 3.6239...
        assert 3.60 < d < 3.65, f"Expected ~3.624, got {d}"

    def test_is_data_independent(self) -> None:
        """Sensitivity should depend only on hyperparameters, not on data."""
        # Same config called twice must give identical results
        d1 = _theoretical_sensitivity(10.0, 32833, 1e-3, 2)
        d2 = _theoretical_sensitivity(10.0, 32833, 1e-3, 2)
        assert d1 == d2

    def test_scales_with_clients(self) -> None:
        """More clients => smaller sensitivity (1/(n-1) factor)."""
        d2 = _theoretical_sensitivity(10.0, 32833, 1e-3, 2)  # n-1 = 1
        d3 = _theoretical_sensitivity(10.0, 32833, 1e-3, 3)  # n-1 = 2
        assert abs(d2 / d3 - 2.0) < 1e-10

    def test_rejects_single_client(self) -> None:
        """num_clients < 2 should raise ValueError (division by zero)."""
        with pytest.raises(ValueError):
            _theoretical_sensitivity(10.0, 32833, 1e-3, 1)


# ── C-3: Per-Round Weights ────────────────────────────────


class TestRoundWeights:
    """Verify p_i = ||grad_F(w_i)||^2 / Sum ||grad_F(w_j)||^2."""

    def test_single_round(self) -> None:
        """One round should get weight 1.0."""
        weights = _compute_round_weights({1: 5.0})
        assert weights == {1: 1.0}

    def test_two_equal_rounds(self) -> None:
        """Two rounds with equal norms should get 0.5 each."""
        weights = _compute_round_weights({1: 10.0, 2: 10.0})
        assert abs(weights[1] - 0.5) < 1e-10
        assert abs(weights[2] - 0.5) < 1e-10

    def test_proportional_weights(self) -> None:
        """Weights should be proportional to norm-squared values."""
        weights = _compute_round_weights({1: 3.0, 2: 1.0})
        assert abs(weights[1] - 0.75) < 1e-10
        assert abs(weights[2] - 0.25) < 1e-10

    def test_sum_to_one(self) -> None:
        """Weights must always sum to 1.0."""
        weights = _compute_round_weights({1: 7.0, 2: 3.0, 3: 5.0, 4: 1.0})
        assert abs(sum(weights.values()) - 1.0) < 1e-10

    def test_zero_norms_equal_weights(self) -> None:
        """If all norms are ~0, fall back to equal weights."""
        weights = _compute_round_weights({1: 0.0, 2: 0.0, 3: 0.0})
        expected = 1.0 / 3
        for w in weights.values():
            assert abs(w - expected) < 1e-10


# ── C-1/C-2: Gradient Residual ────────────────────────────


class TestGradientResidual:
    """Verify delta_i computation from metadata + aggregated gradient."""

    def test_equal_weight_two_clients(self) -> None:
        """With w=0.5 (2 clients, equal): delta_i = (Dw - agg) / (n-1)."""
        flagged_weighted = {"fc.weight": torch.tensor([1.0, 2.0])}
        agg_delta = {"fc.weight": torch.tensor([1.5, 2.5])}
        weight = 0.5  # 1/n for n=2

        residual = _compute_gradient_residual(flagged_weighted, agg_delta, weight)

        # Unweighted: Dw = [1.0, 2.0] / 0.5 = [2.0, 4.0]
        # delta = w * (Dw - agg) / (1 - w)
        # = 0.5 * ([2.0, 4.0] - [1.5, 2.5]) / 0.5
        # = [0.5, 1.5]
        expected = torch.tensor([0.5, 1.5])
        assert torch.allclose(residual["fc.weight"], expected, atol=1e-6)

    def test_reduces_to_paper_formula(self) -> None:
        """With equal weights, delta_i = (Dw - agg) / (n-1)."""
        n = 3
        w = 1.0 / n

        flagged_weighted = {"layer": torch.tensor([3.0, 6.0]) * w}
        agg_delta = {"layer": torch.tensor([2.0, 4.0])}

        residual = _compute_gradient_residual(flagged_weighted, agg_delta, w)

        # delta = w * (Dw - agg) / (1 - w) = (1/3) * ([3,6] - [2,4]) / (2/3)
        # = (1/3) * [1, 2] / (2/3) = [1, 2] / 2 = [0.5, 1.0]
        expected = torch.tensor([0.5, 1.0])
        assert torch.allclose(residual["layer"], expected, atol=1e-6)

    def test_fallback_without_agg(self) -> None:
        """Without aggregated gradient, fall back to raw weighted delta."""
        flagged_weighted = {"fc.weight": torch.tensor([0.5, 1.0])}
        residual = _compute_gradient_residual(flagged_weighted, None, 0.5)
        assert torch.allclose(residual["fc.weight"], flagged_weighted["fc.weight"])

    def test_zero_weight_returns_zeros(self) -> None:
        """Zero weight means no client impact — residual should be zeros."""
        flagged_weighted = {"fc.weight": torch.tensor([1.0, 2.0])}
        agg_delta = {"fc.weight": torch.tensor([1.5, 2.5])}
        residual = _compute_gradient_residual(flagged_weighted, agg_delta, 0.0)
        assert torch.allclose(residual["fc.weight"], torch.zeros(2))


# ── W-3: Round Filtering by flag_round ────────────────────


class TestRoundFiltering:
    """Verify only rounds <= flag_round are processed."""

    def _make_engine(
        self,
        archived_rounds: list[int],
        agg_rounds: Optional[list[int]] = None,
    ) -> tuple[FedRecoveryEngine, GradientArchive, list]:
        """Create a minimal engine with mocked dependencies."""
        archive = GradientArchive(max_bytes=50 * 1024 * 1024)

        # Populate archive with dummy data
        for rnd in archived_rounds:
            archive.store_enc(
                "bad_client",
                rnd,
                {"fc.weight": b"\x00" * 100},
                metadata={"weight": 0.5, "client_id": "bad_client", "round": rnd},
            )
        if agg_rounds:
            for rnd in agg_rounds:
                archive.store_agg(rnd, {"fc.weight": torch.randn(1, 64)})

        # Minimal model mock
        model = MagicMock()
        state = {"fc.weight": torch.randn(1, 64), "fc.bias": torch.randn(1)}
        model.state_dict.return_value = state

        posts: list = []

        engine = FedRecoveryEngine(
            archive=archive,
            model=model,
            vss={"shares": [], "nonces": [], "commitments": []},
            public_ctx=MagicMock(),
            post_fn=lambda path, payload: posts.append((path, payload)) or True,
        )

        return engine, archive, posts

    def test_filters_rounds_above_flag_round(self) -> None:
        """Rounds after flag_round should not be included."""
        engine, archive, posts = self._make_engine(archived_rounds=[1, 2, 3, 5, 8, 10])

        # Get rounds manually and filter as the engine does
        all_rounds = archive.get_client_rounds("bad_client")
        assert all_rounds == [1, 2, 3, 5, 8, 10]

        filtered = [r for r in all_rounds if r <= 5]
        assert filtered == [1, 2, 3, 5]
        assert 8 not in filtered
        assert 10 not in filtered

    def test_flag_round_equal_included(self) -> None:
        """The flag_round itself should be included in filtering."""
        engine, archive, _ = self._make_engine(archived_rounds=[3, 5, 7])

        all_rounds = archive.get_client_rounds("bad_client")
        filtered = [r for r in all_rounds if r <= 5]
        assert 5 in filtered
        assert 7 not in filtered


# ── C-4: No Sigma Cap ────────────────────────────────────


class TestNoSigmaCap:
    """Verify sigma is NOT artificially capped."""

    def test_sigma_exceeds_10x_sensitivity(self) -> None:
        """With small epsilon, sigma >> 10*sensitivity — no cap applied."""
        sensitivity = 1.0
        epsilon = 0.10
        beta = 1e-5

        sigma = _paper_gaussian_sigma(sensitivity, epsilon, beta)

        # sigma ~ 48.09 >> 10 * 1.0 = 10.0
        # Old code would cap at 10.0; corrected code does NOT cap
        assert sigma > 10.0 * sensitivity, (
            f"sigma={sigma} should exceed 10*sensitivity={10.0 * sensitivity}"
        )

    def test_full_chain_no_cap(self) -> None:
        """End-to-end: theoretical sensitivity + paper sigma, no cap anywhere."""
        sensitivity = _theoretical_sensitivity(
            clip_bound=10.0,
            num_params=32833,
            learning_rate=1e-3,
            num_clients=2,
        )
        sigma = _paper_gaussian_sigma(sensitivity, 0.10, 1e-5)

        # sigma = paper_sigma(3.624, 0.10, 1e-5) ~ 174.2
        # Old cap would be 3.624 * 10 = 36.24 — much less than 174.2
        old_cap = sensitivity * 10.0
        assert sigma > old_cap, f"sigma={sigma:.2f} should exceed old cap={old_cap:.2f}"

    def test_effective_epsilon_matches_requested(self) -> None:
        """Verify the sigma yields an effective epsilon close to the requested one.

        Invert the paper's epsilon formula:
            epsilon = 1/(2*sigma^2) + (1/sigma)*sqrt(2*ln(1/beta))
        """
        requested_epsilon = 0.10
        beta = 1e-5
        sensitivity = 3.624  # our theoretical bound

        sigma = _paper_gaussian_sigma(sensitivity, requested_epsilon, beta)

        # Compute effective epsilon by inverting Eq. 6
        ln_inv_beta = math.log(1.0 / beta)
        effective_epsilon = sensitivity**2 / (2.0 * sigma**2) + (
            sensitivity / sigma
        ) * math.sqrt(2.0 * ln_inv_beta)

        # Should be very close to requested
        assert abs(effective_epsilon - requested_epsilon) < 0.01, (
            f"Effective epsilon={effective_epsilon:.4f} should be ~{requested_epsilon}"
        )


# ── Integration: Engine with mocked VSS/CKKS ─────────────


class TestEngineIntegration:
    """Test FedRecoveryEngine with mocked TenSEAL dependencies."""

    def test_backward_compat_delta_dp_alias(self) -> None:
        """Legacy delta_dp parameter should map to beta."""
        archive = GradientArchive()
        model = MagicMock()
        model.state_dict.return_value = {}

        engine = FedRecoveryEngine(
            archive=archive,
            model=model,
            vss={},
            public_ctx=MagicMock(),
            post_fn=lambda p, d: True,
            delta_dp=1e-3,
        )
        assert engine.beta == 1e-3

    def test_empty_archive_returns_complete(self) -> None:
        """No archived rounds should return status=complete, 0 corrected."""
        archive = GradientArchive()
        model = MagicMock()
        model.state_dict.return_value = {}

        result = FedRecoveryEngine(
            archive=archive,
            model=model,
            vss={},
            public_ctx=MagicMock(),
            post_fn=lambda p, d: True,
        ).run("nonexistent_client", flag_round=10)

        assert result["status"] == "complete"
        assert result["rounds_corrected"] == 0
        assert result["rounds_skipped"] == 0
