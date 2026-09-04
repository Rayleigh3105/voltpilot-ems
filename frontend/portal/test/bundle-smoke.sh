#!/usr/bin/env bash
# Bündel-Wächter des Portals (Bewegungs-Programm P0, Captain-Entscheid E10 a).
#
# Er bewacht EINE Haus-Regel: **das Einstiegs-Bündel trägt NUR das erste Bild.**
#
# Warum das ein eigener Wächter ist (gemessen, Konzept
# `data/vp-motion-konzept-m1/report.md` §7.1): `motion/react` voll im Einstieg
# kostet +45,1 kB gz, `LazyMotion`+`m` im Einstieg +16,1 kB gz, Motion nur in
# einem Lazy-Stück +0,07 kB gz. Der Unterschied entsteht NICHT im Quelltext,
# sondern im Bündler — ein `import('motion/react')` NEBEN einem statischen
# Import legt Vite das Paket zurück in den Einstieg (gemessen: +65,2 kB gz).
# Das sieht man nur, indem man wirklich baut.
#
# Der schnelle Zwilling ist `src/motionTokens.test.ts` („kein vom Einstieg aus
# statisch erreichbares Modul importiert `motion`"): er läuft in Millisekunden
# bei jedem Testlauf. DIESER hier ist die Gegenprobe am echten Artefakt — er
# fängt auch, was ein Quelltext-Scan nicht sehen kann (eine `optimizeDeps`- oder
# `manualChunks`-Änderung, ein Paket, das Motion seinerseits mitzieht).
#
# Prüfungen:
#   1. `vite build` läuft durch (in ein EIGENES Ausgabeverzeichnis, damit der
#      Wächter das echte `dist/` des Deploys nie überschreibt).
#   2. Der Einstiegs-Chunk `index-*.js` bleibt unter der Grenze (gz, siehe
#      LIMIT_KB) — Basis am Tag von P0: 228,15 kB gz.
#   3. In den QUELLEN des Einstiegs-Chunks steht kein Motion-Modul.
#
# ⚠ WARUM ÜBER DIE SOURCEMAP UND NICHT PER `grep` IM CHUNK: der Minifizierer
#   benennt `LazyMotion` um und der Paketname steht nirgends als Zeichenkette —
#   ein Namens-`grep` fand Motion NICHT, obwohl es drin war (beim Bau dieses
#   Wächters mutationsgeprüft). Die `sources`-Liste der Sourcemap nennt jede
#   Datei, die in den Chunk geflossen ist, beim Pfad — exakt und
#   umbenennungs-fest.
#
# Aufruf: test/bundle-smoke.sh        (aus `frontend/portal/`)
#         LIMIT_KB=240 test/bundle-smoke.sh   (nur mit Begründung im PR)
set -euo pipefail

cd "$(dirname "$0")/.."

# Die Grenze aus der Haus-Regel (AGENTS.md „Bewegung"): Basis 228,15 kB gz plus
# ein knapper Kopfraum. ⚠ SIE WIRD NUR KLEINER — wer sie erhöht, hat den
# Wächter abgeschafft, nicht bestanden.
LIMIT_KB="${LIMIT_KB:-230}"

OUT="dist-bundle-smoke"
trap 'rm -rf "$OUT"' EXIT

echo "== 1/3 · Bündel bauen =="
rm -rf "$OUT"
npx vite build --sourcemap --outDir "$OUT" --emptyOutDir >/tmp/vp-bundle-build.log 2>&1 || {
  echo "FAIL: vite build ist gescheitert"; tail -30 /tmp/vp-bundle-build.log; exit 1;
}
echo "ok"

entry=$(ls "$OUT"/assets/index-*.js 2>/dev/null | head -1)
[ -n "$entry" ] || { echo "FAIL: kein Einstiegs-Chunk $OUT/assets/index-*.js"; exit 1; }

echo "== 2/3 · Einstiegs-Chunk unter $LIMIT_KB kB gz =="
# ⚠ DIE ZAHL KOMMT AUS VITES EIGENER AUSGABE, nicht aus `gzip -9`. Vite
# komprimiert mit einer anderen Stufe (gemessen: 228,16 gegen 222,46 kB für
# dasselbe Artefakt) — nähme der Wächter seine eigene Zahl, stünde im PR eine
# andere als in der Build-Ausgabe, und die Grenze bezöge sich auf nichts, was
# ein Mensch sieht.
line=$(grep -E "assets/$(basename "$entry")" /tmp/vp-bundle-build.log | tail -1)
gz_kb=$(printf '%s' "$line" | sed -nE 's/.*gzip:[[:space:]]*([0-9.,]+) kB.*/\1/p' | tr -d ',')
[ -n "$gz_kb" ] || { echo "FAIL: konnte die gz-Größe nicht aus der Build-Ausgabe lesen"; echo "$line"; exit 1; }
echo "   $(basename "$entry"): ${gz_kb} kB gz (Grenze ${LIMIT_KB} kB)"
awk -v g="$gz_kb" -v l="$LIMIT_KB" 'BEGIN{ exit !(g <= l) }' || {
  echo "FAIL: der Einstieg ist auf ${gz_kb} kB gz gewachsen (Grenze ${LIMIT_KB} kB)."
  echo "      Neues Gewicht gehört in ein Lazy-Stück, nicht in das erste Bild."
  exit 1
}
echo "ok"

echo "== 3/3 · kein Motion im Einstiegs-Chunk =="
map="$entry.map"
[ -f "$map" ] || { echo "FAIL: keine Sourcemap neben $entry"; exit 1; }
# `motion` re-exportiert `framer-motion`; dazu kommen `motion-dom` und
# `motion-utils`. Alle vier zählen.
hits=$(node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const re = /node_modules\/(motion|framer-motion|motion-dom|motion-utils)\//;
  const bad = (m.sources || []).filter((s) => re.test(s));
  process.stdout.write(bad.slice(0, 8).join("\n"));
  process.exitCode = bad.length ? 1 : 0;
' "$map") || {
  echo "FAIL: Motion ist im Einstiegs-Chunk gelandet (E10 a: nur in Lazy-Stücken)."
  echo "$hits" | sed 's/^/       /'
  exit 1
}
# Nicht-vakuum: die Sourcemap muss überhaupt Quellen nennen.
node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (!(m.sources || []).length) { console.error("FAIL: leere sources-Liste"); process.exit(1); }
' "$map"
echo "ok"

echo
echo "PASS · Einstieg ${gz_kb} kB gz, kein Motion darin."
