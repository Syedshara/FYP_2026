"""
Auth service — business logic for registration, login, token refresh.
"""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.core.security import hash_password, verify_password
from app.core.auth import create_access_token, create_refresh_token, decode_token
from app.core.exceptions import ConflictException, NotFoundException
from app.schemas.user import UserCreate, TokenResponse


async def register_user(db: AsyncSession, payload: UserCreate) -> User:
    """Register a new user. Raises ConflictException if username/email taken."""

    # Check username
    result = await db.execute(select(User).where(User.username == payload.username))
    if result.scalar_one_or_none():
        raise ConflictException("Username already taken")

    # Check email
    result = await db.execute(select(User).where(User.email == payload.email))
    if result.scalar_one_or_none():
        raise ConflictException("Email already registered")

    user = User(
        username=payload.username,
        email=payload.email,
        hashed_password=hash_password(payload.password),
    )
    db.add(user)
    await db.flush()
    await db.refresh(user)
    return user


async def authenticate_user(db: AsyncSession, username: str, password: str) -> TokenResponse:
    """Validate credentials and return access + refresh tokens."""
    result = await db.execute(select(User).where(User.username == username))
    user = result.scalar_one_or_none()

    if user is None or not verify_password(password, user.hashed_password):
        raise NotFoundException("Invalid username or password")

    if not user.is_active:
        raise NotFoundException("Account is deactivated")

    tokens = _build_tokens(user)
    return tokens


async def refresh_tokens(db: AsyncSession, refresh_token: str) -> TokenResponse:
    """Validate a refresh token and issue new token pair."""
    payload = decode_token(refresh_token)

    if payload.get("type") != "refresh":
        from fastapi import HTTPException, status
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token type — expected refresh token",
        )

    user_id = payload.get("sub")
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()

    if user is None or not user.is_active:
        raise NotFoundException("User not found or deactivated")

    return _build_tokens(user)


async def get_user_by_id(db: AsyncSession, user_id: UUID) -> User:
    """Fetch a user by ID."""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise NotFoundException("User")
    return user


def _build_tokens(user: User) -> TokenResponse:
    """Build access + refresh token pair for a user."""
    token_data = {"sub": str(user.id), "username": user.username, "role": user.role}
    return TokenResponse(
        access_token=create_access_token(token_data),
        refresh_token=create_refresh_token(token_data),
    )
