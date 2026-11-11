"""Postgres DSN assembly shared by the service's CLI entry points.

``evaluate.py``, ``forecast_collect.py`` and ``weather_collect.py`` each run as
their own ``console_scripts`` entry point (see ``pyproject.toml``), but all
three connect the same way: as the trusted backend DB role (``POSTGRES_USER``),
not the RLS-scoped app role, because each reads/writes across every tenant.
"""

from __future__ import annotations

from urllib.parse import quote


def dsn_from_env(env: dict[str, str]) -> str:
    host = env.get("POSTGRES_HOST", "localhost")
    port = env.get("POSTGRES_PORT", "5432")
    db = env.get("POSTGRES_DB", "voltpilot")
    user = quote(env.get("POSTGRES_USER", "voltpilot"), safe="")
    password = quote(env.get("POSTGRES_PASSWORD", ""), safe="")
    # connect_timeout bounds the connect: without it libpq waits on the OS
    # TCP timeout, so an unreachable DB hangs the cycle (and the shutdown
    # handler) instead of failing into the retry back-off. See
    # docs/k8s-readiness.md.
    timeout = env.get("POSTGRES_CONNECT_TIMEOUT", "10")
    return (
        f"postgresql://{user}:{password}@{host}:{port}/{db}"
        f"?connect_timeout={quote(timeout, safe='')}"
    )
