# Deye P4: der BMS-Block `0x00D2` — OPTIONAL gelesen, sonst reißt er den ganzen Poll

Angelegt am 09.09.2026. Die Edge-Hälfte von
[`root/der-bms-block-ueber-den-deye-p4.md`](../root/der-bms-block-ueber-den-deye-p4.md);
dort stehen Registerkarte, Skalen und der Cloud-Weg.

## Die tragende Falle: `optional` ist kein Schmuck

Der Solarman-V5-Leser bricht bei einem Fehler in einem **Pflicht**-Block den GANZEN Poll ab
(`finish(err)` → kein Sample). Ein dritter Block, den irgendeine Firmware ablehnt, hätte der
Anlage damit JEDEN Kanal gekostet. Deshalb trägt der BMS-Block das Feld `optional: true`
durch die ganze Kette, und drei Leser behandeln ihn wie einen auto-gelernten Spiegel-Block —
Fehler → leerer Block, Zyklus läuft weiter:

- `flows.json` `auto-solarman` (`if (r.learned || r.optional)`) — ⚠ und er setzt dabei NICHT
  `learned: true`, sonst verwürfe der Lerner des Cores den Plan-Block als abgelehnten Wunsch.
- der Quellen-Executor in `build-flows.js` (`readSolarmanReading`), für einen Deye, der als
  zusätzliche QUELLE eingebunden ist.
- `test-read.js` (der Verbindungstest).

`planReads()` trägt das Flag mit; der Router in `build-flows.js` (`DEYE_READS` +
`reads.map`) muss es erhalten, sonst schlägt `flows-sync.test.js` zu.

## Der Block ist ein PLAN-Block, kein gelernter

Er reitet NACH Kennung und Messblock, aber VOR den auto-gelernten Wunschblöcken und vor der
Tages-Lesung der Einspeisegrenze. Die e2e-Erwartungen in `mirror-poll.e2e.test.js` pinnen
genau diese Reihenfolge (`[0x0000, 0x024b, 0x00d2, …]`).

## `blockAlive` urteilt NICHT über den BMS-Block

Er ist bewusst aus `blockAlive()` ausgenommen (wie `battVolt`). Sonst verschöbe ein
antwortendes BMS die Grenze zwischen „Leerantwort des Loggers" und „BMS meldet nichts" für
JEDE Anlage — der Wechselrichter hat nicht geantwortet, nur weil seine Batterie es tat.

## Wo die Kopien liegen

Ein Node-RED-Flow ist selbstenthaltenes JSON: der Knoten `auto-deye-decode` trägt eine
SYNCHRONE Kopie von `deye/deye-decode.js` (BMS-Feldkarte, `hvMult`, `decodeBms`, zweite
SoC-Ausfahrt). `flows-sync.test.js` vergleicht Flow gegen Modul für jeden dieser Fälle —
Modul ändern heißt Knoten ändern, dann `node build-flows.js`.
