# syntax=docker/dockerfile:1
FROM python:3.11-slim AS base
WORKDIR /app
COPY pyproject.toml README.md ./
COPY voltpilot_market_data/ voltpilot_market_data/
# Install the DB extra so the containerised job can persist to TimescaleDB.
RUN pip install --no-cache-dir '.[db]'
# Default command runs the day-ahead fetch for the next delivery day and
# persists it. The zone comes from MARKET_DATA_ZONE (fallback DE-LU);
# ENTSOE_SECURITY_TOKEN and POSTGRES_* also come from the environment.
ENTRYPOINT ["python", "-m", "voltpilot_market_data"]
CMD ["fetch", "--persist"]
