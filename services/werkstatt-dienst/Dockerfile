# Werkstatt-Dienst (services/werkstatt-dienst): ein Go-Programm ohne CGO.
# Laufzeit Alpine statt distroless: die Schritte P3/P5 rufen die Skripte des
# Release-Stands (install.sh, service-tunnel.sh) mit /bin/sh auf.
# Läuft als Benutzer 10001 mit schreibgeschütztem Dateisystem (PodSecurity
# restricted); schreibbar sind nur die Daten (PVC) und /tmp (emptyDir).
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS bau
ARG TARGETOS=linux
ARG TARGETARCH
ARG FASSUNG=entwicklung
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X main.fassung=${FASSUNG}" -o /out/vp-werkstatt-dienst ./cmd/vp-werkstatt-dienst

FROM alpine:3.22
RUN apk add --no-cache ca-certificates \
 && adduser -D -H -u 10001 -s /sbin/nologin werkstatt
COPY --from=bau /out/vp-werkstatt-dienst /usr/local/bin/vp-werkstatt-dienst
USER 10001:10001
EXPOSE 8100
HEALTHCHECK NONE
ENTRYPOINT ["/usr/local/bin/vp-werkstatt-dienst"]
CMD ["dienst"]
