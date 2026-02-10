"""Quick sanity check that the test DB engine creates tables."""
import asyncio
from sqlalchemy import text

def test_tables_created(_create_tables, event_loop):
    """Verify that _create_tables actually created the users table."""
    from tests.conftest import _test_engine

    async def _check():
        async with _test_engine.begin() as conn:
            result = await conn.execute(
                text("SELECT name FROM sqlite_master WHERE type='table'")
            )
            tables = [r[0] for r in result.fetchall()]
            print(f"\n--- Tables found: {tables} ---")
            assert "users" in tables, f"users not in {tables}"
            return tables

    tables = event_loop.run_until_complete(_check())
    print(f"All tables: {tables}")
