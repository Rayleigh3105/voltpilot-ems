# syntax=docker/dockerfile:1
# vp-logik-dienst: the Steuerlogik service beside the API (Steuerlogik Stufe 2).
# It lives in the core module because it reads the language with the box's own
# internal packages (logik, logik/textform) - context is edge-app/core:
#   docker build -f cmd/vp-logik-dienst/Dockerfile -t <tag> edge-app/core
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w" -o /out/vp-logik-dienst ./cmd/vp-logik-dienst

FROM alpine:3.20
RUN addgroup -S voltpilot && adduser -S -G voltpilot voltpilot
COPY --from=build /out/vp-logik-dienst /usr/local/bin/vp-logik-dienst
USER voltpilot
ENV LOGIK_DIENST_PORT=8101
EXPOSE 8101
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:8101/health || exit 1
ENTRYPOINT ["vp-logik-dienst"]
