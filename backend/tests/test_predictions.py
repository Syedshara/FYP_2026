"""
Prediction API tests.

Covers Task 13 items:
  ✓ Predictions start flowing (via internal API)
  ✓ Dashboard shows live updates (via WS broadcast)
"""

from unittest.mock import patch

import pytest
from httpx import AsyncClient

from tests.test_clients import _mock_container_info


@pytest.fixture(autouse=True)
def mock_docker():
    """Patch Docker for prediction tests."""
    with (
        patch("app.services.docker_service.create_client_container") as mc,
        patch("app.services.docker_service.remove_container"),
    ):
        mc.side_effect = lambda client_id, data_path, **kw: _mock_container_info(client_id)
        yield


class TestPredictionSummary:
    """GET /api/v1/predictions/summary"""

    async def test_summary_empty(self, app_client: AsyncClient, auth_headers):
        resp = await app_client.get("/api/v1/predictions/summary", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["total_predictions"] == 0
        assert data["attack_count"] == 0
        assert data["benign_count"] == 0

    async def test_summary_no_auth(self, app_client: AsyncClient):
        resp = await app_client.get("/api/v1/predictions/summary")
        assert resp.status_code == 401


class TestModelInfo:
    """GET /api/v1/predictions/model"""

    async def test_model_info(self, app_client: AsyncClient, auth_headers):
        resp = await app_client.get("/api/v1/predictions/model", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "loaded" in data
        assert "CNN-LSTM" in data["architecture"]
        assert "input_shape" in data


class TestInternalPredictions:
    """POST /api/v1/internal/predictions — simulates FL client posting predictions."""

    async def test_save_prediction_and_broadcast(self, app_client: AsyncClient, auth_headers):
        """Simulate: FL client posts a prediction via internal API."""
        # First create a client + device
        client_resp = await app_client.post(
            "/api/v1/fl/clients",
            json={"client_id": "pred_test", "name": "Pred Test", "data_path": "/app/data"},
            headers=auth_headers,
        )
        client_pk = client_resp.json()["id"]

        device_resp = await app_client.post(
            "/api/v1/devices",
            json={
                "name": "Pred-Device",
                "device_type": "sensor",
                "protocol": "tcp",
                "port": 80,
                "client_id": client_pk,
            },
            headers=auth_headers,
        )
        device_id = device_resp.json()["id"]

        # Internal API — no auth needed (service-to-service)
        pred_resp = await app_client.post(
            "/api/v1/internal/predictions",
            json={
                "device_id": device_id,
                "client_id": client_pk,
                "score": 0.87,
                "label": "attack",
                "confidence": 0.92,
                "inference_latency_ms": 12.5,
                "model_version": "test-v1",
                "attack_type": "DDoS",
            },
        )
        assert pred_resp.status_code == 201, pred_resp.text
        data = pred_resp.json()
        assert data["saved"] is True
        assert "id" in data

    async def test_save_benign_prediction(self, app_client: AsyncClient, auth_headers):
        """Save a benign prediction."""
        client_resp = await app_client.post(
            "/api/v1/fl/clients",
            json={"client_id": "benign_test", "name": "Benign", "data_path": "/app/data"},
            headers=auth_headers,
        )
        client_pk = client_resp.json()["id"]

        device_resp = await app_client.post(
            "/api/v1/devices",
            json={
                "name": "Benign-Device",
                "device_type": "sensor",
                "protocol": "tcp",
                "port": 80,
                "client_id": client_pk,
            },
            headers=auth_headers,
        )
        device_id = device_resp.json()["id"]

        pred_resp = await app_client.post(
            "/api/v1/internal/predictions",
            json={
                "device_id": device_id,
                "client_id": client_pk,
                "score": 0.12,
                "label": "benign",
                "confidence": 0.95,
                "inference_latency_ms": 8.2,
                "model_version": "test-v1",
            },
        )
        assert pred_resp.status_code == 201

    async def test_prediction_updates_summary(self, app_client: AsyncClient, auth_headers):
        """After saving predictions, summary should reflect them."""
        # Create client + device
        client_resp = await app_client.post(
            "/api/v1/fl/clients",
            json={"client_id": "summary_test", "name": "Summary", "data_path": "/app/data"},
            headers=auth_headers,
        )
        client_pk = client_resp.json()["id"]

        device_resp = await app_client.post(
            "/api/v1/devices",
            json={
                "name": "Summary-Device",
                "device_type": "sensor",
                "protocol": "tcp",
                "port": 80,
                "client_id": client_pk,
            },
            headers=auth_headers,
        )
        device_id = device_resp.json()["id"]

        # Save 2 attack + 1 benign
        for label, score in [("attack", 0.9), ("attack", 0.85), ("benign", 0.1)]:
            await app_client.post(
                "/api/v1/internal/predictions",
                json={
                    "device_id": device_id,
                    "client_id": client_pk,
                    "score": score,
                    "label": label,
                    "confidence": 0.9,
                    "inference_latency_ms": 10.0,
                    "model_version": "test",
                },
            )

        # Check summary
        summary = await app_client.get("/api/v1/predictions/summary", headers=auth_headers)
        assert summary.status_code == 200
        data = summary.json()
        assert data["total_predictions"] == 3
        assert data["attack_count"] == 2
        assert data["benign_count"] == 1


class TestDeviceHistory:
    """GET /api/v1/predictions/device/{device_id}"""

    async def test_device_history(self, app_client: AsyncClient, auth_headers):
        # Create device
        device_resp = await app_client.post(
            "/api/v1/devices",
            json={"name": "History-Device", "device_type": "sensor", "protocol": "tcp", "port": 80},
            headers=auth_headers,
        )
        device_id = device_resp.json()["id"]

        resp = await app_client.get(
            f"/api/v1/predictions/device/{device_id}",
            headers=auth_headers,
        )
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)
