"""
Auth API endpoints — register, login, refresh, me.
"""

from fastapi import APIRouter, Depends, Body
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.core.dependencies import get_current_user
from app.models.user import User
from app.schemas.user import UserCreate, UserLogin, TokenResponse, UserOut
from app.services.auth_service import register_user, authenticate_user, refresh_tokens

router = APIRouter()


@router.post("/register", response_model=UserOut, status_code=201)
async def register(payload: UserCreate, db: AsyncSession = Depends(get_db)):
    """Register a new user account."""
    user = await register_user(db, payload)
    return user


@router.post("/login", response_model=TokenResponse)
async def login(payload: UserLogin, db: AsyncSession = Depends(get_db)):
    """Authenticate and receive JWT tokens."""
    tokens = await authenticate_user(db, payload.username, payload.password)
    return tokens


@router.post("/refresh", response_model=TokenResponse)
async def refresh(refresh_token: str = Body(..., embed=True), db: AsyncSession = Depends(get_db)):
    """Exchange a refresh token for new token pair."""
    tokens = await refresh_tokens(db, refresh_token)
    return tokens


@router.get("/me", response_model=UserOut)
async def me(current_user: User = Depends(get_current_user)):
    """Get the current authenticated user's profile."""
    return current_user
