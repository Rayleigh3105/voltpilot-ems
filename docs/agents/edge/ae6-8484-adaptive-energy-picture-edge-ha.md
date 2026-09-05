# AE6 :8484 adaptive energy picture (edge half of AE2/AE3)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 17).


`static/dashboard.js` renders the topology block: `createFlow($("flowWrap"))`
routes the energy diagram between the ADAPTIVE topology diagram (v2 entities
present) and the fixed 4-node `buildV1Flow` (v1 fallback), and `renderKpis`
swaps the fixed `#kpis` cards for entity/role-driven `#kpisAdaptive` tiles
(`renderAdaptiveTiles`/`deriveTiles`). Both are read-only ports of the portal's
pure derivations, so the :8484 view matches the portal AE2/AE3 (same
lightning-hub / soft-circle-node / animated-dashed-spoke look,
`--pv/--load/--grid-c/--batt` role hues). **Since PR 4b (vp-vier-erzeuger-p9)
the adaptive diagram is the portal A1 picture: ONE circle per ROLE**
(`ROLE_NODE_LABEL` pv/storage/consumer/grid, `subLabelFor` verbatim from
`adaptiveFlow.ts` — „N Geräte" on a multi-device PV = the click affordance,
else the state in words), CONSTANT viewBox (1 or 6 inverters draw the same
picture), and the per-device breakdown behind a click on the PV circle
(`.flow-comp`, a SIBLING of the flow wrap after the legend — inside the wrap it
overlaps the legend because the SVG keeps 100 % height; a device without an own
value is NAMED with its reason, never a bare „–" ring). Keep `ROLE_NODE_LABEL`/
`subLabelFor` in lockstep with the portal. A device with NO topology stays
byte-identical v1 (`hasTopology` gates it). `static/*` is `//go:embed`-ed —
REBUILD the core binary after edits (any `go build`/`go test ./internal/web`
re-embeds). Test: `internal/web` `TestAdaptiveEnergyPictureServed`.

### Die ROLLEN wohnen seit Befund L3 in `static/flowrollen.js`

Seit PR 550 liefert die Go-Topologie (`internal/topology` `DefaultRole`) fuer
eine Wallbox/einen Ladepunkt `charging` bzw. `charging-own` statt `consumer`.
`dashboard.js` kannte nur `pv/storage/consumer/grid` und uebersprang alles
andere STILL - die Wallbox waere mit dem naechsten Edge-Release ohne ein Wort
aus Kachel-Leiste UND Energiefluss verschwunden (Scout
`vp-portal-box-spiegel-s2` L3). Das Rollen-Vokabular liegt deshalb jetzt an
EINER Stelle (`window.VPFlowRollen`: `ROLE_SIDE` · `ROLE_NODE_LABEL` ·
`ROLE_ORDER`), aus der Kacheln UND Diagramm lesen - zwei Listen waeren genau
die Doppeldeutigkeit, aus der der Befund entstanden ist.
**⚠ `charging` haengt am HAUS** (seine Kilowatt stecken schon in der gemessenen
Hauslast), **`charging-own` am HUB** (eigener Netzanschluss) - dieselbe
Grammatik wie im Portal; wer eine Rolle ergaenzt, traegt sie in BEIDE Karten
ein, sonst faellt der Wächter in `jstest/ui.test.js` („die Rollen-Liste deckt
das Vokabular der Go-Topologie ab"). Ein unbekanntes Wort wird weiterhin
uebersprungen, nie geraten.

### Eine Sperre, EINE Antwort: `web.deviceConfigError`

`agent.refuseIfPortalManaged` ist EIN Gatter fuer alle vier lokalen
Schreibwege und meldet ueberall einen `*inverter.ValidationError`. Die drei
Quellen-Handler fragten nur den `*sources.ValidationError` ab und antworteten
deshalb mit HTTP 500 „Energiequelle konnte nicht gespeichert werden", waehrend
`POST /api/inverter` sauber 400 mit dem deutschen Hinweis gab (Befund L2).
Seither laufen alle vier durch die EINE Zuordnung `web.deviceConfigError` -
dieselbe Sperre darf nicht zwei Antworten haben. Test:
`web_test.go` `TestPortalManagedRefusalIsAHintNotAServerError` (inkl. der
Gegenprobe, dass ein ECHTER Fehler ein 500 bleibt).

