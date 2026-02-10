"""
Auth API tests — register, login, token refresh, /me, persistence.

Covers Task 13 items:
  ✓ Login → stays logged in on refresh
  ✓ Invalid inputs show proper error messages
"""

import pytest
from httpx import AsyncClient


class TestRegister:
    """POST /api/v1/auth/register"""

    async def test_register_success(self, app_client: AsyncClient):
        resp = await app_client.post("/api/v1/auth/register", json={
            "username": "newuser",
            "email": "new@example.com",
            "password": "securepass123",
        })
        assert resp.status_code == 201
        data = resp.json()
        assert data["username"] == "newuser"
        assert data["email"] == "new@example.com"
        assert data["role"] == "viewer"
        assert data["is_active"] is True
        assert "id" in data

    async def test_register_duplicate_username(self, app_client: AsyncClient, registered_user):
        """Registering with the same username should fail with 409."""
        resp = await app_client.post("/api/v1/auth/register", json={
            "username": "testuser",
            "email": "other@example.com",
            "password": "anotherpass123",
        })
        assert resp.status_code == 409
        assert "already taken" in resp.json()["detail"].lower()

    async def test_register_duplicate_email(self, app_client: AsyncClient, registered_user):
        """Registering with the same email should fail with 409."""
        resp = await app_client.post("/api/v1/auth/register", json={
            "username": "otheruser",
            "email": "test@example.com",
            "password": "anotherpass123",
        })
        assert resp.status_code == 409
        assert "already registered" in resp.json()["detail"].lower()

    async def test_register_invalid_email(self, app_client: AsyncClient):
        """Invalid email format should be rejected."""
        resp = await app_client.post("/api/v1/auth/register", json={
            "username": "baduser",
            "email": "not-an-email",
            "password": "securepass123",
        })
        assert resp.status_code == 422

    async def test_register_short_password(self, app_client: AsyncClient):
        """Password shorter than 8 chars should be rejected."""
        resp = await app_client.post("/api/v1/auth/register", json={
            "username": "shortpw",
            "email": "short@example.com",
            "password": "abc",
        })
        assert resp.status_code == 422

    async def test_register_short_username(self, app_client: AsyncClient):
        """Username shorter than 3 chars should be rejected."""
        resp = await app_client.post("/api/v1/auth/register", json={
            "username": "ab",
            "email": "short@example.com",
            "password": "securepass123",
        })
        assert resp.status_code == 422


class TestLogin:
    """POST /api/v1/auth/login"""

    async def test_login_success(self, app_client: AsyncClient, registered_user):
        resp = await app_client.post("/api/v1/auth/login", json={
            "username": "testuser",
            "password": "testpass123",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "access_token" in data
        assert "refresh_token" in data
        assert data["token_type"] == "bearer"

    async def test_login_wrong_password(self, app_client: AsyncClient, registered_user):
        resp = await app_client.post("/api/v1/auth/login", json={
            "username": "testuser",
            "password": "wrongpassword",
        })
        assert resp.status_code == 404
        assert "invalid" in resp.json()["detail"].lower()

    async def test_login_nonexistent_user(self, app_client: AsyncClient):
        resp = await app_client.post("/api/v1/auth/login", json={
            "username": "ghost",
            "password": "doesntmatter",
        })
        assert resp.status_code == 404


class TestTokenRefresh:
    """POST /api/v1/auth/refresh — simulates 'stays logged in on refresh'"""

    async def test_refresh_returns_new_tokens(self, app_client: AsyncClient, auth_tokens):
        """Refresh token should return a new valid access token."""
        resp = await app_client.post("/api/v1/auth/refresh", json={
            "refresh_token": auth_tokens["refresh_token"],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "access_token" in data
        assert "refresh_token" in data
        # New access token should work
        me_resp = await app_client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {data['access_token']}"},
        )
        assert me_resp.status_code == 200

    async def test_refresh_with_access_token_fails(self, app_client: AsyncClient, auth_tokens):
        """Using an access token as refresh should fail."""
        resp = await app_client.post("/api/v1/auth/refresh", json={
            "refresh_token": auth_tokens["access_token"],
        })
        assert resp.status_code == 401

    async def test_refresh_with_invalid_token(self, app_client: AsyncClient):
        resp = await app_client.post("/api/v1/auth/refresh", json={
            "refresh_token": "invalid.jwt.token",
        })
        assert resp.status_code == 401


class TestMe:
    """GET /api/v1/auth/me"""

    async def test_me_authenticated(self, app_client: AsyncClient, auth_headers):
        resp = await app_client.get("/api/v1/auth/me", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["username"] == "testuser"
        assert data["email"] == "test@example.com"
        assert data["is_active"] is True

    async def test_me_no_token(self, app_client: AsyncClient):
        resp = await app_client.get("/api/v1/auth/me")
        assert resp.status_code == 401

    async def test_me_invalid_token(self, app_client: AsyncClient):
        resp = await app_client.get(
            "/api/v1/auth/me",
            headers={"Authorization": "Bearer invalid.token.here"},
        )
        assert resp.status_code == 401


class TestTokenPersistence:
    """Simulate 'login → stays logged in on page refresh'."""

    async def test_token_works_across_multiple_requests(
        self, app_client: AsyncClient, auth_headers
    ):
        """Access token should remain valid for multiple sequential requests."""
        for _ in range(5):
            resp = await app_client.get("/api/v1/auth/me", headers=auth_headers)
            assert resp.status_code == 200

    async def test_refresh_flow_simulates_page_refresh(
        self, app_client: AsyncClient, auth_tokens
    ):
        """
        Simulate: user has tokens in localStorage → page refresh →
        use refresh token to get new access token → continue.
        """
        # Step 1: Original access token works
        r1 = await app_client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {auth_tokens['access_token']}"},
        )
        assert r1.status_code == 200

        # Step 2: "Page refresh" — use refresh token to get new pair
        r2 = await app_client.post("/api/v1/auth/refresh", json={
            "refresh_token": auth_tokens["refresh_token"],
        })
        assert r2.status_code == 200
        new_tokens = r2.json()

        # Step 3: New access token works
        r3 = await app_client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {new_tokens['access_token']}"},
        )
        assert r3.status_code == 200
        assert r3.json()["username"] == "testuser"
