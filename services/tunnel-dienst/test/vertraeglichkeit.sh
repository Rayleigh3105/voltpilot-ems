#!/usr/bin/env bash
# Verträgt ein ÄLTERER Stand des Tunnel-Dienstes den HEUTIGEN Soll-Stand?
#
# Der Soll-Stand wächst additiv (Version bleibt 1). Bevor das Portal ein neues
# Feld ausliefert, muss der Dienst, der gerade auf der Wartungs-VM läuft, es
# überlesen können - sonst verwürfe er jeden Abruf, und kein Fenster ginge mehr
# auf. Diese Probe baut den Dienst vom genannten Commit, gibt ihm den
# Vertragsvektor des Arbeitsverzeichnisses als Antwort der API und vergleicht
# das Ergebnis mit demselben Vektor ohne die Felder, die der alte Stand nicht
# kennt.
#
#   test/vertraeglichkeit.sh <commit>     z. B. der Stand aus `vp-tunnel-dienst version`
#
# Braucht Docker (golang:1.24) und ein Git-Checkout, sonst nichts: kein
# WireGuard, kein nftables, keine Rechte. Der alte Stand wird nach /tmp
# ausgepackt und danach entfernt.
set -euo pipefail

commit="${1:?Aufruf: vertraeglichkeit.sh <commit des laufenden Dienstes>}"
wurzel="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
vektor="$wurzel/docs/contracts/fernwartung-soll-v1.example.json"
probe="$(dirname "$0")/vertraeglichkeit_test.go.txt"
alt="$(mktemp -d)"
trap 'rm -rf "$alt"' EXIT

git -C "$wurzel" archive "$commit" services/tunnel-dienst | tar -x -C "$alt"
mkdir -p "$alt/docs/contracts"
cp "$vektor" "$alt/docs/contracts/heutiger-soll.json"
cp "$probe" "$alt/services/tunnel-dienst/internal/dienst/vertraeglichkeit_test.go"

echo "Tunnel-Dienst vom Stand $(git -C "$wurzel" rev-parse --short=12 "$commit") gegen den heutigen Vertragsvektor"
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e GOCACHE=/tmp/gocache -e GOFLAGS=-buildvcs=false \
  -v "$alt":/repo -w /repo/services/tunnel-dienst golang:1.24 \
  go test -count=1 -v -run 'TestVertraeglichkeit' ./internal/dienst/
