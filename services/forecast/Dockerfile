# syntax=docker/dockerfile:1
FROM python:3.11-slim AS base
WORKDIR /app
COPY pyproject.toml README.md ./
COPY voltpilot_forecast/ voltpilot_forecast/
# `db` (psycopg) + `weather` (requests) extras so the containerised weather
# collector can fetch Open-Meteo and persist into the weather_forecast hypertable.
RUN pip install --no-cache-dir '.[db,weather]'
# Default entrypoint runs the offline demo forecast; the compose `feeds` profile
# overrides it to run the weather collector (voltpilot_forecast.weather_collect).
ENTRYPOINT ["python", "-m", "voltpilot_forecast"]
