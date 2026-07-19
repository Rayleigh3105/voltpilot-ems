# syntax=docker/dockerfile:1
# flowc-serve: the CLOUD-side flow-graph -> flow-artifact compiler sidecar
# (E2 flowc + serve.js). It is deployed alongside the api / simulation on the
# server network - NOT on the edge/Pi - so the api (no Node runtime, and never
# reimplementing the JCS content hash in Java) can compile flows during
# activation over a tiny internal HTTP call, mirroring `simulate-serve`.
#
# Dependency-free (Node >= 18, stdlib only), so no `npm install` and no
# node_modules. Only the four runtime files are copied (tests/testdata stay out
# of the image). Internal-only: no host port is published in prod.
FROM node:22-alpine

WORKDIR /app

# The compiler + its deps + the HTTP surface. compile.js -> catalog.js +
# canonicalize.js; serve.js -> compile.js. Nothing else is required at runtime.
COPY canonicalize.js catalog.js compile.js serve.js ./

ENV FLOWC_PORT=8099
EXPOSE 8099

# BusyBox wget ships in the alpine base; /health is ungated and cheap.
HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8099/health >/dev/null 2>&1 || exit 1

USER node
CMD ["node", "serve.js"]
