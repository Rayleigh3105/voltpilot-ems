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
#      LIMIT_KB) — Basis am Tag von P0: 228,15 kB gz, heute 226,01 (P7 mit P2).
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
#         LIMIT_KB=240 test/bundle-smoke.sh   (einmalig, nur mit Begründung im PR)
set -euo pipefail

cd "$(dirname "$0")/.."

# Die Grenze aus der Haus-Regel (AGENTS.md „Bewegung"): die gemessene Basis plus
# ein knapper Kopfraum.
#
# ⚠ SIE IST EINE RATSCHE: sie geht NACH UNTEN von selbst und NACH OBEN nur mit
#   einem Grund, der im PR steht — wer sie ohne Grund erhöht, hat den Wächter
#   abgeschafft, nicht bestanden.
#
# Verlauf:
#   228,15  P0 (Grenze 230)   — Basis am Tag des Wächters
#   229,84  nach P1/P3/P4/P6  — der Kopfraum von 1,85 kB war damit aufgebraucht
#   230,99  P5 (Grenze 232)   — Captain-Entscheid 04.09.2026, Option (A)
#   225,74  P7 (Grenze 230)   — die Ratsche geht ZURÜCK, wie eine Ratsche soll
#   246,22  main am 24.09.2026 — der Wächter war rot (UX-Review V-01)
#   224,57  V-01 (Grenze 230)  — vier Hilfs-Module statt ganzer Fach-Module
#   357,89  uems am 09.10.2026 — der Wächter war rot (Gesamtlauf vor uems → main)
#   252,37  UEMS-Schnitt (Grenze 256) — firstmate-Entscheid `bel-grenze-230` = B
#   259,77  main → mispel am 10.10.2026 — der Wächter war rot: `speicherAussage.ts` (MiSpeL
#           MP-18c) holte drei Wörter aus `glossar.ts` und damit das ganze Glossar zurück
#   253,81  MiSpeL-Nachzug (Grenze 256) — die drei Wörter stehen in `glossarEinstieg.ts`;
#           die +1,44 kB über `main` sind `speicherAussage.ts`, `main.tsx` und `api.ts`
#
# WAS DER UEMS-SCHNITT HERAUSGENOMMEN HAT (−105,52 kB gz, ohne eine Funktion zu ändern):
#   Der Sammelzweig `uems` hatte 71 Quellen neu im Einstieg. Zwei Flächen sind
#   jetzt Lazy-Stücke: `pages/BenutzerPage.tsx` (zieht `UnterstuetzungKarte` mit,
#   `pageChunks.ts`) und der Dialog „Unterstützung beenden?“ des Banners (kommt
#   mit seinem Klick). Dazu zehn Hilfs-Module statt ganzer Fach-Module, die alten
#   Module reichen sie unverändert weiter:
#   `bereichSicht.ts` (statt `bewertung`/`energieziele`/`energiemanagementPortal`),
#   `uemsSprung.ts` (statt `uemsOberflaechen`), `funktionenRegeln.ts` (statt
#   `uebersicht`), `messstellenReiter.ts` (statt `kostenstellenUebersicht`),
#   `energiebilanzReiter.ts` (statt `anlageEnergiebilanz`), `uemsBilanzSaetze.ts`
#   (statt `uemsBilanz`), `rechteTexte.ts` (statt `rechte`),
#   `unterstuetzungFrist.ts` (aus `unterstuetzung`), `anlageFlowSchritte.ts`
#   (statt `anlageFlow`), `glossarEinstieg.ts` (statt `glossar`).
#
# WARUM DIE GRENZE DABEI VON 230 AUF 256 GEHT (gemessen, 09.10.2026): `main`
#   liegt bei 220,32 kB gz, die 230 liessen also 9,68 kB Luft. Nach dem Schnitt
#   bleiben 32,05 kB über `main`, und nichts davon ist ein Rückfall:
#   14,3 kB  die SCHALE des ersten Bilds ist mit UEMS gewachsen — Ebenen, Routen,
#            Reiter-Leiste, Seiten-Tabelle (`App.tsx` +4,0, `nav.ts` +2,0,
#            `pageChunks.ts` +1,3, `PortfolioTabs` +1,2, …);
#   11,6 kB  31 UEMS-Quellen, die das erste Bild selbst braucht (`ebenenNav.ts`,
#            Unterstützungs-Banner, Rechte-Sätze, die Hilfs-Module von oben);
#    6,5 kB  `api.ts`: das EINE `api`-Objekt trägt jede Route und liegt als
#            Ganzes im Einstieg. Es zu teilen ist ein eigenes Paket (über tausend
#            Test-Spione hängen an genau diesem Objekt) — der Boden mit Teilung
#            läge bei rund 246 kB.
#   Die Anlagen-Seite bleibt im Einstieg (Haus-Regel: sie ist das Ziel fast
#   jedes Besuchs). Die 3,6 kB Luft folgen der Regel weiter unten.
#
# WAS V-01 HERAUSGENOMMEN HAT (−21,65 kB gz, ohne eine Funktion zu ändern):
#   Der Einstieg zog vier große Fach-Module für je eine kleine Hilfe mit.
#   Die Hilfen wohnen jetzt in eigenen Modulen, die alten Module reichen sie
#   unverändert weiter:
#   `ladestandVon.ts` (statt `batterieAnschluss`/`selbstbau`),
#   `geraetAdresse.ts` (statt `geraetSeite`), `provenienz.ts` (statt
#   `historieWelten`), `geldWelt.ts` (statt `portfolioHistorie`).
#
# WAS P7 HERAUSGENOMMEN HAT (−5,20 kB gz, ohne eine Funktion zu ändern):
#   −4,77  `components/DeviceDrawers.tsx` — der Einrichtungspfad renderte die
#          GESCHLOSSENE „Gerät hinzufügen"-Fläche vorsorglich mit; sie ist
#          jetzt ein Lazy-Stück (`DeviceDrawers-*.js`, 3,97 kB gz) und kommt
#          mit dem Klick, der sie öffnet.
#   −0,56  `admin/adminApi` in `App.tsx` — der Einstieg trug die Admin-Anbindung
#          für JEDEN Kunden mit, obwohl nur ein Plattform-Admin sie je aufruft.
#
#   226,01  mit P2 darin     — Chart-Familien kosten +0,27 kB gz
#
# ⚠ DIE KNAPP 4 kB LUFT SIND ABSICHT, NICHT NACHLÄSSIGKEIT: sie ist der
#   Kopfraum, den P0 mit 1,85 kB zu klein bemessen hatte — er war nach vier
#   Paketen aufgebraucht und zwang P5, die Grenze zu heben. Wer sie jetzt
#   wieder auf den Messwert zurückzieht, baut dieselbe Falle noch einmal.
#
# WARUM P5 DIE GRENZE BEWEGEN DURFTE: die Seitenwechsel-Hülle ist per Entscheid
# E5 (a) EINSTIEGS-Code — sie ist die Browser-eigene View-Transitions-API, kein
# Motion-Paket, und sie muss beim ERSTEN Hash-Wechsel schon dastehen. Gemessen
# kostet sie +1,13 kB gz, und das ist nicht drückbar: eine P5-Variante mit
# KOMPLETT entferntem Rumpf (kein `pageTransition`-Import, `transitionKind` aus
# `nav.ts` raus, `commit` = nacktes `setRoute`) liegt bei 230,28 kB — immer noch
# über 230, weil der Kopfraum von main (158 Byte) kleiner war als die reine
# Vorlade-Grenze `pageChunks.ts` plus die `view-transition-name`-Attribute.
LIMIT_KB="${LIMIT_KB:-256}"

OUT="dist-bundle-smoke"
trap 'rm -rf "$OUT"' EXIT

echo "== 1/6 · Bündel bauen =="
rm -rf "$OUT"
npx vite build --sourcemap --outDir "$OUT" --emptyOutDir >/tmp/vp-bundle-build.log 2>&1 || {
  echo "FAIL: vite build ist gescheitert"; tail -30 /tmp/vp-bundle-build.log; exit 1;
}
echo "ok"

entry=$(ls "$OUT"/assets/index-*.js 2>/dev/null | head -1)
[ -n "$entry" ] || { echo "FAIL: kein Einstiegs-Chunk $OUT/assets/index-*.js"; exit 1; }

echo "== 2/6 · Einstiegs-Chunk unter $LIMIT_KB kB gz =="
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

echo "== 3/6 · kein Motion im Einstiegs-Chunk =="
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

echo "== 4/6 · Chart-Bündel unter 210 kB gz =="
# Nur benötigte ECharts-Module: 344,50 -> 203,28 kB gz (09.09.2026).
# AP-01 registrierte `Graphic`+`VisualMap` für REPLACE_MERGE: 219,92 kB gz,
# rot. V-01 (24.09.2026) nimmt `VisualMap` wieder heraus (kein Diagramm setzt
# ihn; Wächter `src/chartRegistrierung.test.ts`): 208,5 kB gz.
# Ein erneuter Vollimport muss am ausgelieferten Artefakt auffallen.
chart_line=$(grep -E 'assets/useEChart-[^ ]+\.js[[:space:]]' /tmp/vp-bundle-build.log | tail -1)
chart_gz_kb=$(printf '%s' "$chart_line" | sed -nE 's/.*gzip:[[:space:]]*([0-9.,]+) kB.*/\1/p' | tr -d ',')
[ -n "$chart_gz_kb" ] || { echo "FAIL: Chart-Bündel fehlt in der Build-Ausgabe"; exit 1; }
awk -v g="$chart_gz_kb" 'BEGIN{ exit !(g <= 210) }' || {
  echo "FAIL: Chart-Bündel ${chart_gz_kb} kB gz (Grenze 210 kB)."
  exit 1
}
echo "ok: ${chart_gz_kb} kB gz"

echo "== 5/6 · Wortmarke inline (Review SOLLTE-1), kein Netz-Asset =="
# Die Wortmarke MUSS als Data-URI im Bündel stehen (build.assetsInlineLimit),
# damit der React-Lader sie ohne Netz-Request zeigt - byte-genau dasselbe Bild
# wie der Inline-Lader in index.html. `?inline` (Vite 6) taeuscht das auf Vite
# 5.4 nur vor und liesse sie als eigenes Asset stehen.
if ls "$OUT"/assets/voltpilot-wordmark-*.* >/dev/null 2>&1; then
  echo "FAIL: die Wortmarke wurde als eigenes Asset emittiert - der React-Lader luede sie ueber das Netz."
  echo "      Sie gehoert als Data-URI ins Buendel (build.assetsInlineLimit, vite.config.ts)."
  exit 1
fi
if grep -q '?inline' "$entry"; then
  echo "FAIL: '?inline' im Einstieg - ein Vite-6-Feature, auf Vite 5.4 wirkungslos."
  exit 1
fi
grep -q 'data:image/png;base64' "$entry" || {
  echo "FAIL: keine Data-URI-Wortmarke im Einstiegs-Chunk (sollte inline sein)."
  exit 1
}
echo "ok"

echo "== 6/6 · index.html unter Grenze (Data-URI-Wortmarke, no-cache) =="
# ⚠ index.html ist no-cache: jeder Vollaufruf laedt sie NEU. Der bewusste
# Zuwachs ist die Data-URI-Wortmarke (~12 kB, Feedback-6) - die echte Marke vor
# dem JS ohne Extra-Request. Mehr gehoert nicht in diesen Pfad; die Grenze ist
# eine Ratsche (nach unten von selbst, nach oben nur mit Grund im PR).
INDEX_LIMIT="${INDEX_LIMIT:-27000}"
idx_bytes=$(wc -c < "$OUT/index.html")
echo "   index.html: ${idx_bytes} B (Grenze ${INDEX_LIMIT} B)"
[ "$idx_bytes" -le "$INDEX_LIMIT" ] || {
  echo "FAIL: index.html ${idx_bytes} B > ${INDEX_LIMIT} B - der no-cache-Boot-Pfad waechst."
  exit 1
}
echo "ok"

echo
echo "PASS · Einstieg ${gz_kb} kB gz, Charts ${chart_gz_kb} kB gz, index.html ${idx_bytes} B, Wortmarke inline, kein Motion im Einstieg."
