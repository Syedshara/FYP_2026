"""
FL Client CRUD tests.

Covers Task 13 items:
  ✓ Create Client "bank_a" → Docker container created (mocked)
  ✓ Create Client "hospital_1" → second container created
  ✓ Delete client → container removed
"""

from unittest.mock import patch, MagicMock

import pytest
from httpx import AsyncClient


# ── Mock Docker service ──────────────────────────────────
# Tests run without Docker — we mock the docker_service

def _mock_container_info(client_id: str):
    """Create a mock ContainerInfo."""
    from app.services.docker_service import ContainerInfo
    return ContainerInfo(
        container_id=f"sha256-fake-{client_id}",
        name=f"iot_ids_fl_client_{client_id}",
        status="created",
        image="iot-ids-fl-client:latest",
    )


@pytest.fixture(autouse=True)
def mock_docker():
    """Patch Docker operations for all client tests."""
    with (
        patch("app.services.docker_service.create_client_container") as mock_create,
        patch("app.services.docker_service.remove_container") as mock_remove,
        patch("app.services.docker_service.stop_container") as mock_stop,
        patch("app.services.docker_service.get_container_status") as mock_status,
    ):
        mock_create.side_effect = lambda client_id, data_path, **kw: _mock_container_info(client_id)
        mock_remove.return_value = None
        mock_stop.side_effect = lambda cid: _mock_container_info("stopped")
        mock_status.return_value = _mock_container_info("status")
        yield {
            "create": mock_create,
            "remove": mock_remove,
            "stop": mock_stop,
            "status": mock_status,
        }


class TestCreateClient:
    """POST /api/v1/fl/clients"""

    async def test_create_client_bank_a(self, app_client: AsyncClient, auth_headers, mock_docker):
        resp = await app_client.post(
            "/api/v1/fl/clients",
            json={
                "client_id": "bank_a",
                "name": "Bank A",
                "description": "Primary banking institution",
                "data_path": "/app/data",
            },
            headers=auth_headers,
        )
        assert resp.status_code == 201, resp.text
        data = resp.json()
        assert data["client_id"] == "bank_a"
        assert data["name"] == "Bank A"
        assert data["status"] == "inactive"
        assert data["container_id"] is not None
        assert data["container_name"] is not None
        # Docker create was called
        mock_docker["create"].assert_called_once()

    async def test_create_client_hospital_1(self, app_client: AsyncClient, auth_headers, mock_docker):
        resp = await app_client.post(
            "/api/v1/fl/clients",
            json={
                "client_id": "hospital_1",
                "name": "Hospital 1",
                "description": "Regional hospital network",
                "data_path": "/app/data",
            },
            headers=auth_headers,
        )
        assert resp.status_code == 201, resp.text
        data = resp.json()
        assert data["client_id"] == "hospital_1"
        assert data["name"] == "Hospital 1"

    async def test_create_duplicate_client_fails(
        self, app_client: AsyncClient, auth_headers
    ):
        # Create first
        await app_client.post(
            "/api/v1/fl/clients",
            json={"client_id": "dup_client", "name": "Dup", "data_path": "/app/data"},
            headers=auth_headers,
        )
        # Create duplicate
        resp = await app_client.post(
            "/api/v1/fl/clients",
            json={"client_id": "dup_client", "name": "Dup 2", "data_path": "/app/data"},
            headers=auth_headers,
        )
        assert resp.status_code == 409

    async def test_create_client_no_auth(self, app_client: AsyncClient):
        resp = await app_client.post(
            "/api/v1/fl/clients",
            json={"client_id": "noauth", "name": "No Auth", "data_path": "/app/data"},
        )
        assert resp.status_code == 401


class TestListClients:
    """GET /api/v1/fl/clients"""

    async def test_list_empty(self, app_client: AsyncClient, auth_headers):
        resp = await app_client.get("/api/v1/fl/clients", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json() == []

    async def test_list_after_create(self, app_client: AsyncClient, auth_headers):
        # Create two clients
        await app_client.post(
            "/api/v1/fl/clients",
            json={"client_id": "c1", "name": "Client 1", "data_path": "/app/data"},
            headers=auth_headers,
        )
        await app_client.post(
            "/api/v1/fl/clients",
            json={"client_id": "c2", "name": "Client 2", "data_path": "/app/data"},
            headers=auth_headers,
        )

        resp = await app_client.get("/api/v1/fl/clients", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 2
        client_ids = {c["client_id"] for c in data}
        assert client_ids == {"c1", "c2"}


class TestGetClient:
    """GET /api/v1/fl/clients/{pk}"""

    async def test_get_client_detail(self, app_client: AsyncClient, auth_headers):
        create_resp = await app_client.post(
            "/api/v1/fl/clients",
            json={"client_id": "detail_test", "name": "Detail", "data_path": "/app/data"},
            headers=auth_headers,
        )
        pk = create_resp.json()["id"]

        resp = await app_client.get(f"/api/v1/fl/clients/{pk}", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["client_id"] == "detail_test"
        assert "devices" in data  # FLClientDetailOut includes devices

    async def test_get_nonexistent_client(self, app_client: AsyncClient, auth_headers):
        resp = await app_client.get("/api/v1/fl/clients/99999", headers=auth_headers)
        assert resp.status_code == 404


class TestUpdateClient:
    """PATCH /api/v1/fl/clients/{pk}"""

    async def test_update_client_name(self, app_client: AsyncClient, auth_headers):
        create_resp = await app_client.post(
            "/api/v1/fl/clients",
            json={"client_id": "update_me", "name": "Original", "data_path": "/app/data"},
            headers=auth_headers,
        )
        pk = create_resp.json()["id"]

        resp = await app_client.patch(
            f"/api/v1/fl/clients/{pk}",
            json={"name": "Updated Name"},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        assert resp.json()["name"] == "Updated Name"


class TestDeleteClient:
    """DELETE /api/v1/fl/clients/{pk}"""

    async def test_delete_client_removes_container(
        self, app_client: AsyncClient, auth_headers, mock_docker
    ):
        create_resp = await app_client.post(
            "/api/v1/fl/clients",
            json={"client_id": "delete_me", "name": "Delete Me", "data_path": "/app/data"},
            headers=auth_headers,
        )
        pk = create_resp.json()["id"]

        resp = await app_client.delete(f"/api/v1/fl/clients/{pk}", headers=auth_headers)
        assert resp.status_code == 204

        # Docker remove was called for the container
        mock_docker["remove"].assert_called()

        # Client no longer exists
        get_resp = await app_client.get(f"/api/v1/fl/clients/{pk}", headers=auth_headers)
        assert get_resp.status_code == 404

    async def test_delete_nonexistent_client(self, app_client: AsyncClient, auth_headers):
        resp = await app_client.delete("/api/v1/fl/clients/99999", headers=auth_headers)
        assert resp.status_code == 404
