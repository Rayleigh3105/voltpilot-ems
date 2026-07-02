# syntax=docker/dockerfile:1
# VoltPilot Edge-App Layer 2: the Go core agent. One static binary; the same
# image runs on arm64 (Pi) and amd64:
#   docker buildx build --platform linux/amd64,linux/arm64 -t <tag> .
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath \
      -ldflags "-s -w -X git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/agent.Version=$VERSION" \
      -o /out/vp-edge-core ./cmd/vp-edge-core

FROM alpine:3.20
# ca-certificates: the enrollment endpoint is public HTTPS.
RUN apk add --no-cache ca-certificates && \
    addgroup -S voltpilot && adduser -S -G voltpilot voltpilot && \
    mkdir -p /data && chown voltpilot:voltpilot /data
COPY --from=build /out/vp-edge-core /usr/local/bin/vp-edge-core
USER voltpilot
VOLUME /data
# 8484 local web app, 1883 embedded local MQTT bus (LAN/compose network).
EXPOSE 8484 1883
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:8484/health || exit 1
ENTRYPOINT ["vp-edge-core"]
