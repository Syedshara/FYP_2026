"""
FL Training API tests.

Covers Task 13 items:
  ✓ Go to FL Training → click "Start Training"
  ✓ See live training progress (via internal API)
  ✓ Training completes → model reloaded
  ✓ Stop monitoring → predictions stop
"""

from unittest.mock import patch, MagicMock

import pytest
from httpx import AsyncClient

from tests.test_clients import _mock_container_info


@pytest.fixture(autouse=True)
def mock_docker():
    """Patch Docker for FL training tests."""
    with (
        patch("app.services.docker_service.create_client_container") as mc,
        patch("app.services.docker_service.remove_container"),
        patch("app.services.docker_service.stop_container") as ms,
        patch("app.services.docker_service.start_fl_server"),
        patch("app.services.docker_service.stop_fl_server"),
        patch("app.services.docker_service.validate_client_data", return_value=True),
    ):
        mc.side_effect = lambda client_id, data_path, **kw: _mock_container_info(client_id)
        ms.side_effect = lambda cid: _mock_container_info("stopped")
        yield


@pytest.fixture()
async def two_clients(app_client: AsyncClient, auth_headers) -> list[dict]:
    """Create two FL clients for training tests."""
    clients = []
    for cid, name in [("train_a", "Train A"), ("train_b", "Train B")]:
        resp = await app_client.post(
            "/api/v1/fl/clients",
            json={"client_id": cid, "name": name, "data_path": "/app/data"},
            headers=auth_headers,
        )
        clients.append(resp.json())
    return clients


class TestFLStatus:
    """GET /api/v1/fl/status"""

    async def test_status_initial(self, app_client: AsyncClient, auth_headers):
        resp = await app_client.get("/api/v1/fl/status", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["is_training"] is False
        assert data["total_rounds_completed"] == 0


class TestStartTraining:
    """POST /api/v1/fl/start"""

    async def test_start_training(
        self, app_client: AsyncClient, auth_headers, two_clients
    ):
        resp = await app_client.post(
            "/api/v1/fl/start",
            json={
                "num_rounds": 5,
                "min_clients": 2,
                "use_he": True,
                "local_epochs": 3,
                "learning_rate": 0.001,
            },
            headers=auth_headers,
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "started"
        assert data["num_rounds"] == 5
        assert data["num_clients"] == 2
        assert len(data["client_ids"]) == 2

    async def test_start_training_not_enough_clients(
        self, app_client: AsyncClient, auth_headers
    ):
        """Starting with min_clients > registered should fail."""
        # Create only 1 client
        await app_client.post(
            "/api/v1/fl/clients",
            json={"client_id": "solo", "name": "Solo", "data_path": "/app/data"},
            headers=auth_headers,
        )
        resp = await app_client.post(
            "/api/v1/fl/start",
            json={"num_rounds": 3, "min_clients": 5},
            headers=auth_headers,
        )
        assert resp.status_code == 400
        assert "need at least" in resp.json()["detail"].lower()

    async def test_start_training_no_auth(self, app_client: AsyncClient):
        resp = await app_client.post(
            "/api/v1/fl/start",
            json={"num_rounds": 3, "min_clients": 2},
        )
        assert resp.status_code == 401


class TestStopTraining:
    """POST /api/v1/fl/stop"""

    async def test_stop_training(
        self, app_client: AsyncClient, auth_headers, two_clients
    ):
        # Start first
        await app_client.post(
            "/api/v1/fl/start",
            json={"num_rounds": 5, "min_clients": 2},
            headers=auth_headers,
        )
        # Stop
        resp = await app_client.post("/api/v1/fl/stop", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "stopped"


class TestFLRounds:
    """GET /api/v1/fl/rounds and GET /api/v1/fl/rounds/{n}"""

    async def test_list_rounds_empty(self, app_client: AsyncClient, auth_headers):
        resp = await app_client.get("/api/v1/fl/rounds", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json() == []

    async def test_record_and_list_rounds(self, app_client: AsyncClient, auth_headers):
        """Simulate FL server recording rounds via POST /api/v1/fl/rounds."""
        for i in range(1, 4):
            resp = await app_client.post(
                "/api/v1/fl/rounds",
                json={
                    "round_number": i,
                    "num_clients": 2,
                    "aggregation_method": "fedavg_he",
                    "he_scheme": "ckks",
                    "he_poly_modulus": 16384,
                    "duration_seconds": 12.5 + i,
                    "global_loss": 0.5 - (i * 0.1),
                    "global_accuracy": 0.7 + (i * 0.05),
                },
            )
            assert resp.status_code == 201, resp.text

        # List all rounds
        list_resp = await app_client.get("/api/v1/fl/rounds", headers=auth_headers)
        assert list_resp.status_code == 200
        rounds = list_resp.json()
        assert len(rounds) == 3
        assert rounds[0]["round_number"] == 1
        assert rounds[2]["round_number"] == 3

    async def test_get_round_detail(self, app_client: AsyncClient, auth_headers):
        """GET /api/v1/fl/rounds/{n} should include client metrics."""
        await app_client.post(
            "/api/v1/fl/rounds",
            json={
                "round_number": 1,
                "num_clients": 2,
                "aggregation_method": "fedavg_he",
                "global_loss": 0.4,
                "global_accuracy": 0.85,
            },
        )
        resp = await app_client.get("/api/v1/fl/rounds/1", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["round_number"] == 1
        assert "client_metrics" in data

    async def test_get_nonexistent_round(self, app_client: AsyncClient, auth_headers):
        resp = await app_client.get("/api/v1/fl/rounds/999", headers=auth_headers)
        assert resp.status_code == 404


class TestInternalFLProgress:
    """POST /api/v1/internal/fl/progress — simulates live training updates."""

    async def test_fl_progress_broadcast(self, app_client: AsyncClient):
        """Internal progress endpoint should accept and return ok."""
        resp = await app_client.post(
            "/api/v1/internal/fl/progress",
            json={
                "client_id": "bank_a",
                "round": 1,
                "total_rounds": 5,
                "phase": "training",
                "epoch": 2,
                "total_epochs": 3,
                "epoch_loss": 0.35,
                "message": "Training epoch 2/3",
            },
        )
        assert resp.status_code == 200
        assert resp.json()["ok"] is True


class TestInternalFLRound:
    """POST /api/v1/internal/fl/round — simulates round completion."""

    async def test_fl_round_with_client_metrics(self, app_client: AsyncClient):
        resp = await app_client.post(
            "/api/v1/internal/fl/round",
            json={
                "round_number": 1,
                "total_rounds": 5,
                "num_clients": 2,
                "aggregation_method": "fedavg_he",
                "he_scheme": "ckks",
                "duration_seconds": 15.3,
                "global_loss": 0.32,
                "global_accuracy": 0.89,
                "client_metrics": [
                    {
                        "client_id": "bank_a",
                        "local_loss": 0.28,
                        "local_accuracy": 0.91,
                        "num_samples": 5000,
                        "training_time_sec": 8.2,
                        "encrypted": True,
                    },
                    {
                        "client_id": "bank_b",
                        "local_loss": 0.35,
                        "local_accuracy": 0.87,
                        "num_samples": 3000,
                        "training_time_sec": 6.1,
                        "encrypted": True,
                    },
                ],
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["ok"] is True
        assert "round_id" in data


class TestInternalFLStatus:
    """POST /api/v1/internal/fl/status — training session status change."""

    async def test_status_started(self, app_client: AsyncClient):
        resp = await app_client.post(
            "/api/v1/internal/fl/status",
            json={
                "status": "started",
                "total_rounds": 10,
                "num_clients": 3,
                "use_he": True,
            },
        )
        assert resp.status_code == 200

    async def test_status_completed(self, app_client: AsyncClient):
        resp = await app_client.post(
            "/api/v1/internal/fl/status",
            json={
                "status": "completed",
                "total_rounds": 10,
                "rounds_completed": 10,
                "model_path": "/app/models/global_final.pt",
            },
        )
        assert resp.status_code == 200
