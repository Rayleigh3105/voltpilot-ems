# syntax=docker/dockerfile:1
FROM python:3.11-slim AS base
WORKDIR /app
COPY pyproject.toml README.md ./
COPY voltpilot_marketing_adapter/ voltpilot_marketing_adapter/
RUN pip install --no-cache-dir .
ENTRYPOINT ["python", "-m", "voltpilot_marketing_adapter"]
