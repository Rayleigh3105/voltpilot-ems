# flowc — der Flow-Graph → Node-RED-Compiler (E2)

Übersetzt ein validiertes Flow-Graph-Dokument
([`docs/contracts/v2/flow-graph.schema.json`](../../../docs/contracts/v2/flow-graph.schema.json))
in ein deploybares Flow-Artefakt
([`docs/contracts/v2/flow-artifact.schema.json`](../../../docs/contracts/v2/flow-artifact.schema.json)).
Offline, dependency-frei (Node ≥ 18), als Bibliothek konsumierbar — der
Cloud-Aktivierungspfad (E3a) ruft `compile()` auf, der v2-Rig kompiliert
Fixtures zur Testzeit.

```js
const { compile, validate } = require('edge-app/nodered/flowc/compile');
const artifact = compile(flowGraph, { compiledAt: new Date().toISOString() });
```

## Garantien

- **Nur Katalog-Implementierungen** (`catalog.js`): vp-palette-Knoten
  (`vp-entity-read`, `vp-feed`, `vp-desired`, `vp-notify`, ab 0.3.0
  `vp-modbus-read`) plus GENERIERTE `function`-Knoten aus festen Templates.
  Parameter gelangen ausschließlich als strikt validierte JSON-Literale
  (`const P = {...}`) in den Code; Nutzertext (Labels, Nachrichten) landet
  nur in Daten-Properties. Es gibt keine freien Code-Knoten (D1) — das,
  nicht Review, macht Nutzer-Flows unfähig, beliebige Sockets zu erreichen.
  Die EINE dokumentierte Ausnahme ist die `vp.modbus.*`-Domäne (Decision
  D-15, docs/contracts/v2/README.md): der vp-modbus-read-Knoten liest rohe
  Register über die getestete Palette-Implementierung (lib/modbus-conn.js),
  weiterhin nur Daten-Konfiguration, nie generierter Code.
- **Deterministisch**: gleicher Graph (+ gleiche `opts`) → byte-identisches
  Bundle → identischer `content_hash` (`sha256:` über die RFC-8785-Kanonform,
  `canonicalize.js`; Go-Zwilling `edge-app/core/internal/flowdeploy/jcs.go`,
  gemeinsame Vektoren `jcs-vectors.json`). Tab-/Knoten-IDs leiten sich aus
  `(flow_id, flow_version)` ab (`vpflow-<id8>-v<n>`), ein Redeploy ERSETZT.
  `compiled_at` default: feste Epoche (Cloud übergibt die Aktivierungszeit).
  Der Test `compile.test.js` pinnt den Hash jedes Repo-Fixtures
  (`pinned-*.txt`) und `testdata/pv-surplus-heatrod.artifact.json` ist die
  committete Cross-Language-Probe, die der Go-Deployer verifiziert. **Pins
  werden NIE vom Test selbst erzeugt** (LOW-6): ein fehlender Pin lässt den
  Test fehlschlagen, die Datei wird bewusst erzeugt und eingecheckt — ein
  selbst-geschriebener Pin belegt Determinismus, nicht Korrektheit.
- **`@vp-flow`-Tab-Marker** (D-12): jeder Artefakt-Tab trägt
  `info: "@vp-flow flow_id=<uuid> flow_version=<n>"` — der Reseed ersetzt nur
  die Vendor-Tab-Gruppe, der Deployer verweigert unmarkierte Bundles.

## Kompilierte Auswertungssemantik (v1)

Datenknoten emittieren bei Wertänderung; `interval`-/`slot-boundary`-Trigger
werden zu `inject`-Knoten, die in alle triggerbaren Datenknoten verdrahtet
sind (re-emittieren den letzten Wert — stehende Wünsche frischen ihre TTL auch
bei flachem Wert auf). Ein `value-change`-Trigger schreibt sein `deadband` in
den beobachteten `vp-entity-read`-Knoten. Alle Katalogtypen sind bewusst
Ein-Eingang-Formen — mit EINER Ausnahme: die booleschen Kombinatoren
`vp.logic.and`/`.or` (`discriminateInputs`). Für sie erzeugt der Compiler pro
eingehender Kante einen generierten Tag-Knoten, der `msg._vp_src` auf den
GRAPH-Portnamen setzt; der Kombinator schlüsselt seinen `seen`-Zustand darauf.
Ohne diesen Compile-Zeit-Diskriminator kollabierten zwei Zweige ohne (oder mit
gleichem) `msg.topic` — z. B. zwei `vp.schedule.window` — auf einen Slot, und
das UND rechnete nicht ungenau, sondern falsch (#519 H3-b). Delegierende
Strategie-Knoten (`vp.strategy.*`, `delegated: true`) kompilieren zu einem
No-op: der Cloud-Plan kommandiert die Entität als Klasse `market`
(plan-execution-ownership.md); der `vp-desired`-Publisher ist die EINZIGE
aktuationsfähige Kompilat-Form und publiziert nur Wünsche.

Datenfeeds (`vp.price.dayahead`, `vp.forecast.pv`) abonnieren die
RESERVIERTEN lokalen Topics `edge/prices` / `edge/forecast/pv` (Whitelist im
`vp-feed`-Knoten; der Core liefert sie mit E4 — bis dahin idle-safe "keine
Daten").

## Validator (`validate()`)

Implementiert die compiler-relevante Teilmenge von flow-graph.md §4:
V-1 Porttypen/Aritäten (Widenings `price→timeseries`, `number→timeseries`),
V-2 azyklisch modulo `feedback`, V-3 ID-/Referenz-Integrität, V-4
Katalog-Auflösung + Parameter, V-5 exklusive Claims INNERHALB des Flows
(Cross-Flow-Exklusivität prüft die Plattform bei Aktivierung) + D-13-Abgleich
deklarierter vs. abgeleiteter Claims, V-7 Trigger, V-8 Runtime-Whitelist.
Findings sind maschinenlesbar `{rule, nodes, edges, message}` (deutsche
Meldungen).

## Tests

```
node --test edge-app/nodered/flowc/          # Compiler + JCS
(cd edge-app/core && go test ./internal/flowdeploy/)  # Go-Zwilling + Cross-Check
```
