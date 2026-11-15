#!/usr/bin/env bash
# api-teil.sh <teil> <teile> - fuehrt Teil <teil> von <teile> der services/api-Testklassen aus
# (Nachtlauf, .forgejo/workflows/nightly-tests.yaml). Jeder Teil waehlt per Modulo auf der
# sortierten, vollstaendigen Liste der *Test.java-Klassen - deterministisch und ohne Pflege, auch
# wenn Klassen dazukommen oder wegfallen; jede Klasse liegt in genau einem Teil.
# Mit --liste nur die Klassen des Teils ausgeben, ohne Maven.
set -euo pipefail
liste=false
if [ "${1:-}" = "--liste" ]; then liste=true; shift; fi
teil="$1"
teile="$2"
cd "$(dirname "$0")/../../services/api"
klassen=$(find src/test/java -name '*Test.java' \
  | sed -e 's#^src/test/java/##' -e 's#\.java$##' -e 's#/#.#g' \
  | LC_ALL=C sort \
  | awk -v n="$teile" -v i="$((teil - 1))" 'NR % n == i')
if $liste; then
  printf '%s\n' "$klassen"
  exit 0
fi
./mvnw -B test -Dtest="$(printf '%s\n' "$klassen" | paste -sd, -)"
