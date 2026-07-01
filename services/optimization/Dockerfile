# syntax=docker/dockerfile:1
# Build context is the REPO ROOT (unlike the sibling services): the optimizer
# reuses the forecast package for its persistence-baseline fallback, so both
# sibling directories must be visible to the build. Compose/CI set
#   context: .  /  dockerfile: services/optimization/Dockerfile
FROM python:3.11-slim AS base
WORKDIR /app
COPY services/forecast/pyproject.toml services/forecast/README.md forecast/
COPY services/forecast/voltpilot_forecast/ forecast/voltpilot_forecast/
COPY services/optimization/pyproject.toml services/optimization/README.md optimization/
COPY services/optimization/voltpilot_optimization/ optimization/voltpilot_optimization/
# solver = HiGHS wheel, db = psycopg, mqtt = paho; forecast provides the
# persistence-baseline fallback (predict-then-optimize reuse, see AGENTS.md).
RUN pip install --no-cache-dir ./forecast './optimization[solver,db,mqtt]'
# Long-running rolling planner: cycle on startup, then every 15 min.
# POSTGRES_* / MQTT_* / OPTIMIZER_* come from the environment.
ENTRYPOINT ["python", "-m", "voltpilot_optimization"]
CMD ["serve"]
