# syntax=docker/dockerfile:1
FROM python:3.11-slim AS base
WORKDIR /app
# libgomp1: OpenMP runtime the xgboost Linux wheel links against (the `ml`
# extra powering the shadow challengers; macOS devs: `brew install libomp`).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml README.md ./
COPY voltpilot_forecast/ voltpilot_forecast/
# `db` (psycopg) + `weather` (requests) extras for the collectors, `ml`
# (xgboost/numpy) for the shadow challenger models (voltpilot_forecast.ml).
RUN pip install --no-cache-dir '.[db,weather,ml]'
# Default entrypoint runs the offline demo forecast; the compose `feeds` profile
# overrides it to run the weather collector (voltpilot_forecast.weather_collect)
# or the forecast collector (voltpilot_forecast.forecast_collect).
ENTRYPOINT ["python", "-m", "voltpilot_forecast"]
