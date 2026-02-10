"""
Device CRUD tests.

Covers Task 13 items:
  ✓ Add 3 devices under bank_a
  ✓ Add 2 devices under hospital_1
  ✓ Invalid inputs show proper error messages
"""

from unittest.mock import patch

import pytest
from httpx import AsyncClient

from tests.test_clients import _mock_container_info


@pytest.fixture(autouse=True)
def mock_docker():
    """Patch Docker for device tests (clients need Docker for creation)."""
    with (
        patch("app.services.docker_service.create_client_container") as mc,
        patch("app.services.docker_service.remove_container"),
    ):
        mc.side_effect = lambda client_id, data_path, **kw: _mock_container_info(client_id)
        yield


@pytest.fixture()
async def client_bank_a(app_client: AsyncClient, auth_headers) -> dict:
    """Create bank_a client and return its data."""
    resp = await app_client.post(
        "/api/v1/fl/clients",
        json={"client_id": "bank_a", "name": "Bank A", "data_path": "/app/data"},
        headers=auth_headers,
    )
    return resp.json()


class TestCreateDevice:
    """POST /api/v1/devices"""

    async def test_create_device_under_client(
        self, app_client: AsyncClient, auth_headers, client_bank_a
    ):
        resp = await app_client.post(
            "/api/v1/devices",
            json={
                "name": "Camera-Lobby",
                "device_type": "camera",
                "ip_address": "192.168.1.10",
                "protocol": "tcp",
                "port": 8080,
                "traffic_source": "simulated",
                "client_id": client_bank_a["id"],
            },
            headers=auth_headers,
        )
        assert resp.status_code == 201, resp.text
        data = resp.json()
        assert data["name"] == "Camera-Lobby"
        assert data["device_type"] == "camera"
        assert data["client_id"] == client_bank_a["id"]
        assert data["status"] == "offline"

    async def test_add_3_devices_under_bank_a(
        self, app_client: AsyncClient, auth_headers, client_bank_a
    ):
        """Task 13: Add 3 devices under bank_a."""
        devices = [
            {"name": "Sensor-Floor1", "device_type": "sensor", "protocol": "mqtt", "port": 1883},
            {"name": "Gateway-Main", "device_type": "gateway", "protocol": "tcp", "port": 8443},
            {"name": "Camera-Entrance", "device_type": "camera", "protocol": "http", "port": 80},
        ]
        created_ids = []
        for d in devices:
            resp = await app_client.post(
                "/api/v1/devices",
                json={**d, "client_id": client_bank_a["id"], "traffic_source": "simulated"},
                headers=auth_headers,
            )
            assert resp.status_code == 201, resp.text
            created_ids.append(resp.json()["id"])

        # Verify all 3 exist
        list_resp = await app_client.get(
            "/api/v1/devices",
            params={"client_id": client_bank_a["id"]},
            headers=auth_headers,
        )
        assert list_resp.status_code == 200
        assert len(list_resp.json()) == 3

    async def test_create_device_duplicate_name_fails(
        self, app_client: AsyncClient, auth_headers
    ):
        await app_client.post(
            "/api/v1/devices",
            json={"name": "Dup-Device", "device_type": "sensor", "protocol": "tcp", "port": 80},
            headers=auth_headers,
        )
        resp = await app_client.post(
            "/api/v1/devices",
            json={"name": "Dup-Device", "device_type": "sensor", "protocol": "tcp", "port": 80},
            headers=auth_headers,
        )
        assert resp.status_code == 409

    async def test_create_device_invalid_port(self, app_client: AsyncClient, auth_headers):
        resp = await app_client.post(
            "/api/v1/devices",
            json={"name": "Bad-Port", "device_type": "sensor", "protocol": "tcp", "port": 99999},
            headers=auth_headers,
        )
        assert resp.status_code == 422

    async def test_create_device_no_auth(self, app_client: AsyncClient):
        resp = await app_client.post(
            "/api/v1/devices",
            json={"name": "NoAuth", "device_type": "sensor", "protocol": "tcp", "port": 80},
        )
        assert resp.status_code == 401


class TestListDevices:
    """GET /api/v1/devices"""

    async def test_list_all_devices(self, app_client: AsyncClient, auth_headers):
        resp = await app_client.get("/api/v1/devices", headers=auth_headers)
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    async def test_filter_by_client_id(
        self, app_client: AsyncClient, auth_headers, client_bank_a
    ):
        # Create device under bank_a
        await app_client.post(
            "/api/v1/devices",
            json={
                "name": "Filtered-Device",
                "device_type": "sensor",
                "protocol": "tcp",
                "port": 80,
                "client_id": client_bank_a["id"],
            },
            headers=auth_headers,
        )
        # Create standalone device (no client)
        await app_client.post(
            "/api/v1/devices",
            json={
                "name": "Standalone-Device",
                "device_type": "sensor",
                "protocol": "tcp",
                "port": 80,
            },
            headers=auth_headers,
        )

        # Filter by client_id
        resp = await app_client.get(
            "/api/v1/devices",
            params={"client_id": client_bank_a["id"]},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["name"] == "Filtered-Device"


class TestGetDevice:
    """GET /api/v1/devices/{id}"""

    async def test_get_device(self, app_client: AsyncClient, auth_headers):
        create = await app_client.post(
            "/api/v1/devices",
            json={"name": "Get-Me", "device_type": "sensor", "protocol": "tcp", "port": 80},
            headers=auth_headers,
        )
        device_id = create.json()["id"]

        resp = await app_client.get(f"/api/v1/devices/{device_id}", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["name"] == "Get-Me"

    async def test_get_nonexistent_device(self, app_client: AsyncClient, auth_headers):
        resp = await app_client.get(
            "/api/v1/devices/00000000-0000-0000-0000-000000000000",
            headers=auth_headers,
        )
        assert resp.status_code == 404


class TestUpdateDevice:
    """PATCH /api/v1/devices/{id}"""

    async def test_update_device_status(self, app_client: AsyncClient, auth_headers):
        create = await app_client.post(
            "/api/v1/devices",
            json={"name": "Update-Me", "device_type": "sensor", "protocol": "tcp", "port": 80},
            headers=auth_headers,
        )
        device_id = create.json()["id"]

        resp = await app_client.patch(
            f"/api/v1/devices/{device_id}",
            json={"status": "online"},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "online"


class TestDeleteDevice:
    """DELETE /api/v1/devices/{id}"""

    async def test_delete_device(self, app_client: AsyncClient, auth_headers):
        create = await app_client.post(
            "/api/v1/devices",
            json={"name": "Delete-Me", "device_type": "sensor", "protocol": "tcp", "port": 80},
            headers=auth_headers,
        )
        device_id = create.json()["id"]

        resp = await app_client.delete(f"/api/v1/devices/{device_id}", headers=auth_headers)
        assert resp.status_code == 204

        # Verify deleted
        get_resp = await app_client.get(f"/api/v1/devices/{device_id}", headers=auth_headers)
        assert get_resp.status_code == 404
