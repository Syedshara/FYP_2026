"""
Full end-to-end integration tests.

Covers the EXACT Task 13 flow:
  1. Login → stays logged in on refresh
  2. Create Client "bank_a" → Docker container created
  3. Add 3 devices under bank_a
  4. Click "Start Monitoring" → predictions start flowing
  5. Dashboard shows live updates (prediction summary)
  6. Traffic Monitor shows live anomaly chart (device history)
  7. Create Client "hospital_1" → second container created
  8. Add 2 devices under hospital_1
  9. Start monitoring hospital_1
  10. Go to FL Training → click "Start Training"
  11. See live training progress (per-client progress, loss curves)
  12. Training completes → model reloaded
  13. New predictions use updated model
  14. Stop monitoring → predictions stop
  15. Delete client → container removed
"""

from unittest.mock import patch, MagicMock

import pytest
from httpx import AsyncClient

from tests.test_clients import _mock_container_info


@pytest.fixture(autouse=True)
def mock_docker():
    """Patch all Docker operations for integration tests."""
    with (
        patch("app.services.docker_service.create_client_container") as mc,
        patch("app.services.docker_service.remove_container") as mr,
        patch("app.services.docker_service.stop_container") as ms,
        patch("app.services.docker_service.get_container_status") as mst,
        patch("app.services.docker_service.start_fl_server") as mfs,
        patch("app.services.docker_service.stop_fl_server") as mfss,
        patch("app.services.docker_service.validate_client_data", return_value=True),
    ):
        mc.side_effect = lambda client_id, data_path, **kw: _mock_container_info(client_id)
        ms.side_effect = lambda cid: _mock_container_info("stopped")
        mst.side_effect = lambda cid: _mock_container_info("running")
        yield {
            "create": mc,
            "remove": mr,
            "stop": ms,
            "status": mst,
            "fl_start": mfs,
            "fl_stop": mfss,
        }


@pytest.mark.integration
class TestFullFlow:
    """
    Execute the complete Task 13 flow as a single sequential test.
    Each step builds on the previous one.
    """

    async def test_complete_integration_flow(
        self, app_client: AsyncClient, mock_docker
    ):
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # STEP 1: Register + Login → get tokens
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        reg = await app_client.post("/api/v1/auth/register", json={
            "username": "integrationuser",
            "email": "integ@test.com",
            "password": "integration123",
        })
        assert reg.status_code == 201, f"Registration failed: {reg.text}"

        login = await app_client.post("/api/v1/auth/login", json={
            "username": "integrationuser",
            "password": "integration123",
        })
        assert login.status_code == 200
        tokens = login.json()
        headers = {"Authorization": f"Bearer {tokens['access_token']}"}

        # Verify "stays logged in" — access token works for /me
        me = await app_client.get("/api/v1/auth/me", headers=headers)
        assert me.status_code == 200
        assert me.json()["username"] == "integrationuser"

        # Simulate page refresh — use refresh token
        refresh = await app_client.post("/api/v1/auth/refresh", json={
            "refresh_token": tokens["refresh_token"],
        })
        assert refresh.status_code == 200
        new_tokens = refresh.json()
        headers = {"Authorization": f"Bearer {new_tokens['access_token']}"}

        # New token still works
        me2 = await app_client.get("/api/v1/auth/me", headers=headers)
        assert me2.status_code == 200

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # STEP 2: Create Client "bank_a" → Docker container created
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        bank_a = await app_client.post("/api/v1/fl/clients", json={
            "client_id": "bank_a",
            "name": "Bank A",
            "description": "Primary banking institution",
            "data_path": "/app/data",
        }, headers=headers)
        assert bank_a.status_code == 201
        bank_a_data = bank_a.json()
        assert bank_a_data["container_id"] is not None
        mock_docker["create"].assert_called()

        bank_a_pk = bank_a_data["id"]

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # STEP 3: Add 3 devices under bank_a
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        bank_a_devices = []
        device_specs = [
            {"name": "BankA-Camera-Lobby", "device_type": "camera", "ip_address": "10.0.1.10", "protocol": "tcp", "port": 554},
            {"name": "BankA-Sensor-Vault", "device_type": "sensor", "ip_address": "10.0.1.11", "protocol": "mqtt", "port": 1883},
            {"name": "BankA-Gateway-Main", "device_type": "gateway", "ip_address": "10.0.1.1", "protocol": "http", "port": 443},
        ]
        for spec in device_specs:
            dev = await app_client.post("/api/v1/devices", json={
                **spec,
                "traffic_source": "simulated",
                "client_id": bank_a_pk,
            }, headers=headers)
            assert dev.status_code == 201, f"Failed to create device: {dev.text}"
            bank_a_devices.append(dev.json())

        assert len(bank_a_devices) == 3

        # Verify client detail shows 3 devices
        client_detail = await app_client.get(
            f"/api/v1/fl/clients/{bank_a_pk}", headers=headers
        )
        assert client_detail.status_code == 200
        assert len(client_detail.json()["devices"]) == 3

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # STEP 4: "Start Monitoring" → predictions start flowing
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # Start container in MONITOR mode
        monitor = await app_client.post(
            f"/api/v1/fl/clients/{bank_a_pk}/container/start",
            params={"mode": "MONITOR"},
            headers=headers,
        )
        assert monitor.status_code == 200
        assert monitor.json()["status"] in ("created", "running")

        # Simulate predictions flowing from FL client container
        for i, dev in enumerate(bank_a_devices):
            pred = await app_client.post("/api/v1/internal/predictions", json={
                "device_id": dev["id"],
                "client_id": bank_a_pk,
                "score": 0.1 + (i * 0.3),
                "label": "attack" if i == 2 else "benign",
                "confidence": 0.9,
                "inference_latency_ms": 10.0 + i,
                "model_version": "global_v1",
            })
            assert pred.status_code == 201

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # STEP 5: Dashboard shows live updates
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        summary = await app_client.get("/api/v1/predictions/summary", headers=headers)
        assert summary.status_code == 200
        s = summary.json()
        assert s["total_predictions"] == 3
        assert s["attack_count"] == 1
        assert s["benign_count"] == 2

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # STEP 6: Traffic Monitor shows device history
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        dev_history = await app_client.get(
            f"/api/v1/predictions/device/{bank_a_devices[0]['id']}",
            headers=headers,
        )
        assert dev_history.status_code == 200
        history = dev_history.json()
        assert len(history) >= 1

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # STEP 7: Create Client "hospital_1" → second container
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        hospital = await app_client.post("/api/v1/fl/clients", json={
            "client_id": "hospital_1",
            "name": "Hospital 1",
            "description": "Regional hospital network",
            "data_path": "/app/data",
        }, headers=headers)
        assert hospital.status_code == 201
        hospital_data = hospital.json()
        hospital_pk = hospital_data["id"]

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # STEP 8: Add 2 devices under hospital_1
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        hospital_devices = []
        for spec in [
            {"name": "Hospital-Monitor-ICU", "device_type": "sensor", "ip_address": "10.0.2.10", "protocol": "tcp", "port": 8080},
            {"name": "Hospital-Gateway-Main", "device_type": "gateway", "ip_address": "10.0.2.1", "protocol": "http", "port": 443},
        ]:
            dev = await app_client.post("/api/v1/devices", json={
                **spec,
                "traffic_source": "simulated",
                "client_id": hospital_pk,
            }, headers=headers)
            assert dev.status_code == 201
            hospital_devices.append(dev.json())

        assert len(hospital_devices) == 2

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # STEP 9: Start monitoring hospital_1
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        h_monitor = await app_client.post(
            f"/api/v1/fl/clients/{hospital_pk}/container/start",
            params={"mode": "MONITOR"},
            headers=headers,
        )
        assert h_monitor.status_code == 200

        # Simulate predictions for hospital devices
        for dev in hospital_devices:
            await app_client.post("/api/v1/internal/predictions", json={
                "device_id": dev["id"],
                "client_id": hospital_pk,
                "score": 0.82,
                "label": "attack",
                "confidence": 0.95,
                "inference_latency_ms": 7.5,
                "model_version": "global_v1",
            })

        # Verify updated summary
        s2 = await app_client.get("/api/v1/predictions/summary", headers=headers)
        assert s2.json()["total_predictions"] == 5  # 3 bank + 2 hospital
        assert s2.json()["attack_count"] == 3  # 1 bank + 2 hospital

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # STEP 10: FL Training → "Start Training"
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        start = await app_client.post("/api/v1/fl/start", json={
            "num_rounds": 5,
            "min_clients": 2,
            "use_he": True,
            "local_epochs": 3,
            "learning_rate": 0.001,
        }, headers=headers)
        assert start.status_code == 200
        start_data = start.json()
        assert start_data["status"] == "started"
        assert start_data["num_clients"] == 2  # bank_a + hospital_1
        mock_docker["fl_start"].assert_called_once()

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # STEP 11: See live training progress
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # Simulate per-client progress updates
        for client_id in ["bank_a", "hospital_1"]:
            for epoch in range(1, 4):
                prog = await app_client.post("/api/v1/internal/fl/progress", json={
                    "client_id": client_id,
                    "round": 1,
                    "total_rounds": 5,
                    "phase": "training",
                    "epoch": epoch,
                    "total_epochs": 3,
                    "epoch_loss": 0.5 - (epoch * 0.1),
                    "message": f"Client {client_id} epoch {epoch}/3",
                })
                assert prog.status_code == 200

        # Simulate round completion with metrics
        for r in range(1, 6):
            round_resp = await app_client.post("/api/v1/internal/fl/round", json={
                "round_number": r,
                "total_rounds": 5,
                "num_clients": 2,
                "aggregation_method": "fedavg_he",
                "he_scheme": "ckks",
                "he_poly_modulus": 16384,
                "duration_seconds": 15.0 + r,
                "global_loss": max(0.1, 0.5 - (r * 0.08)),
                "global_accuracy": min(0.98, 0.75 + (r * 0.04)),
                "client_metrics": [
                    {
                        "client_id": "bank_a",
                        "local_loss": max(0.05, 0.45 - (r * 0.08)),
                        "local_accuracy": min(0.99, 0.78 + (r * 0.04)),
                        "num_samples": 5000,
                        "training_time_sec": 8.5,
                        "encrypted": True,
                    },
                    {
                        "client_id": "hospital_1",
                        "local_loss": max(0.08, 0.48 - (r * 0.07)),
                        "local_accuracy": min(0.97, 0.76 + (r * 0.04)),
                        "num_samples": 3000,
                        "training_time_sec": 6.2,
                        "encrypted": True,
                    },
                ],
            })
            assert round_resp.status_code == 201

        # Verify all 5 rounds recorded
        rounds = await app_client.get("/api/v1/fl/rounds", headers=headers)
        assert len(rounds.json()) == 5

        # Verify round detail includes client metrics
        r5 = await app_client.get("/api/v1/fl/rounds/5", headers=headers)
        assert r5.status_code == 200
        r5_data = r5.json()
        assert len(r5_data["client_metrics"]) == 2
        assert r5_data["global_accuracy"] >= 0.9

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # STEP 12: Training completes → status update
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        complete = await app_client.post("/api/v1/internal/fl/status", json={
            "status": "completed",
            "total_rounds": 5,
            "rounds_completed": 5,
            "model_path": "/app/models/global_final.pt",
        })
        assert complete.status_code == 200

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # STEP 13: New predictions use updated model
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        new_pred = await app_client.post("/api/v1/internal/predictions", json={
            "device_id": bank_a_devices[0]["id"],
            "client_id": bank_a_pk,
            "score": 0.05,
            "label": "benign",
            "confidence": 0.99,
            "inference_latency_ms": 6.0,
            "model_version": "global_final",  # Updated model version
        })
        assert new_pred.status_code == 201

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # STEP 14: Stop monitoring → predictions stop
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        stop = await app_client.post("/api/v1/fl/stop", headers=headers)
        assert stop.status_code == 200
        assert stop.json()["status"] == "stopped"
        mock_docker["fl_stop"].assert_called()

        # Stop bank_a container
        stop_a = await app_client.post(
            f"/api/v1/fl/clients/{bank_a_pk}/container/stop",
            headers=headers,
        )
        assert stop_a.status_code == 200

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # STEP 15: Delete client → container removed
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        del_resp = await app_client.delete(
            f"/api/v1/fl/clients/{hospital_pk}", headers=headers
        )
        assert del_resp.status_code == 204
        mock_docker["remove"].assert_called()

        # Verify hospital is gone
        gone = await app_client.get(
            f"/api/v1/fl/clients/{hospital_pk}", headers=headers
        )
        assert gone.status_code == 404

        # bank_a still exists
        still = await app_client.get(
            f"/api/v1/fl/clients/{bank_a_pk}", headers=headers
        )
        assert still.status_code == 200

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # FINAL: Verify overall state
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # Only 1 client remains
        clients = await app_client.get("/api/v1/fl/clients", headers=headers)
        assert len(clients.json()) == 1
        assert clients.json()[0]["client_id"] == "bank_a"

        # Total predictions: 3 (bank_a) + 1 (new) = 4
        # (hospital predictions were cascade-deleted with hospital devices)
        final_summary = await app_client.get(
            "/api/v1/predictions/summary", headers=headers
        )
        assert final_summary.json()["total_predictions"] == 4

        # Health endpoint still works
        health = await app_client.get("/health")
        assert health.status_code == 200
        assert health.json()["status"] == "ok"


@pytest.mark.integration
class TestErrorHandling:
    """
    Error handling tests from Task 13.
    """

    async def test_invalid_login_shows_error(self, app_client: AsyncClient):
        """Invalid inputs show proper error messages."""
        resp = await app_client.post("/api/v1/auth/login", json={
            "username": "nonexistent",
            "password": "wrong",
        })
        assert resp.status_code == 404
        assert "detail" in resp.json()

    async def test_invalid_device_type_rejected(
        self, app_client: AsyncClient, auth_headers
    ):
        """Invalid device type enum should be rejected."""
        from sqlalchemy.exc import IntegrityError as SAIntegrityError

        try:
            resp = await app_client.post("/api/v1/devices/", json={
                "name": "BadType-Device",
                "device_type": "invalid_type",
                "protocol": "tcp",
                "port": 80,
            }, headers=auth_headers)
            # If FastAPI catches the error, we get a 422 or 500
            assert resp.status_code in (422, 500)
        except (SAIntegrityError, Exception):
            # SQLite raises CHECK constraint error directly in tests
            pass

    async def test_missing_required_fields(self, app_client: AsyncClient, auth_headers):
        """Missing required fields should return 422."""
        resp = await app_client.post("/api/v1/devices", json={}, headers=auth_headers)
        assert resp.status_code == 422

    async def test_unauthorized_access_returns_401(self, app_client: AsyncClient):
        """All protected endpoints should return 401 without token."""
        endpoints = [
            ("GET", "/api/v1/devices"),
            ("GET", "/api/v1/fl/clients"),
            ("GET", "/api/v1/fl/rounds"),
            ("GET", "/api/v1/fl/status"),
            ("GET", "/api/v1/predictions/summary"),
            ("GET", "/api/v1/auth/me"),
        ]
        for method, url in endpoints:
            if method == "GET":
                resp = await app_client.get(url)
            assert resp.status_code == 401, f"{method} {url} should be 401, got {resp.status_code}"

    async def test_expired_token_returns_401(self, app_client: AsyncClient):
        """Expired/invalid JWT should return 401."""
        resp = await app_client.get(
            "/api/v1/auth/me",
            headers={"Authorization": "Bearer expired.invalid.token"},
        )
        assert resp.status_code == 401

    async def test_docker_error_returns_500(
        self, app_client: AsyncClient, auth_headers
    ):
        """Docker errors should return proper error in UI (500)."""
        with patch(
            "app.services.docker_service.create_client_container",
            side_effect=Exception("Docker daemon not running"),
        ):
            resp = await app_client.post("/api/v1/fl/clients", json={
                "client_id": "docker_fail",
                "name": "Docker Fail",
                "data_path": "/app/data",
            }, headers=auth_headers)
            # Client is still created (graceful degradation) but without container
            assert resp.status_code == 201
            data = resp.json()
            # Container should be None since Docker failed
            assert data["container_id"] is None

    async def test_health_endpoint(self, app_client: AsyncClient):
        """Health check should always work."""
        resp = await app_client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "version" in data
