# syntax=docker/dockerfile:1
FROM python:3.11-slim AS base
WORKDIR /app
# Unbuffered stdout: Python block-buffers stdout when it is a pipe (which it
# always is in a container), so the serve loops' print() output would sit in an
# 8 KB buffer and never reach `docker logs` / `kubectl logs` in real time.
# logging already flushes per record; this covers the print() half.
ENV PYTHONUNBUFFERED=1
COPY pyproject.toml README.md ./
COPY voltpilot_market_data/ voltpilot_market_data/
# Install the DB extra so the containerised job can persist to TimescaleDB.
RUN pip install --no-cache-dir '.[db]'
# Default command runs the day-ahead fetch for the next delivery day and
# persists it. The zone comes from MARKET_DATA_ZONE (fallback DE-LU);
# ENTSOE_SECURITY_TOKEN and POSTGRES_* also come from the environment.
ENTRYPOINT ["python", "-m", "voltpilot_market_data"]
CMD ["fetch", "--persist"]
