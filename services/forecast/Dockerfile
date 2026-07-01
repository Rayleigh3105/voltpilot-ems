# syntax=docker/dockerfile:1
FROM python:3.11-slim AS base
WORKDIR /app
COPY pyproject.toml README.md ./
COPY voltpilot_forecast/ voltpilot_forecast/
RUN pip install --no-cache-dir .
ENTRYPOINT ["python", "-m", "voltpilot_forecast"]
