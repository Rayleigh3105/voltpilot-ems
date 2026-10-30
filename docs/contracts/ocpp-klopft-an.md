# OCPP „klopft an“: abgewiesene Ladesäulen im Herzschlag

Eine Ladesäule wird nicht gesucht, sie ruft die Box an (`ws://<Box>:<Port><Pfad>/<Kennung>`). Steht ihre Kennung nicht
in der Freigabeliste, weist die Box sie ab und schreibt das heute nur in ihr Log (`edge-app/core/internal/csms/ocppmap.go`).
Eine falsch eingetippte Kennung bleibt so im Portal unsichtbar („Wartet auf die Wallbox“). Mit diesem Feld merkt sich
die Box jede abgewiesene Kennung 24 h und meldet sie; das Portal zeigt „Ladesäule klopft an“, und „Zulassen“ trägt sie mit
einem Tipp über die bestehende Route `POST /api/v1/sites/{siteId}/charging-config/charge-points` ein (Konzept
Gerätesuche §6, Stufe 2). Ein Anlern-Fenster entsteht nicht: zugelassen wird nur durch einen Menschen.
[Schema](ocpp-klopft-an.schema.json), [Fälle](ocpp-klopft-an-vectors.json).

```json
"chargers": {
  "reported_at": "2026-11-02T09:00:00Z", "enabled": true, "ocpp_port": 8887, "url_path": "/ocpp",
  "chargers": [{"id": "CP-HALLE-1", "connected": false, "ready": false}],
  "rejected": [{"id": "CP-HALLE1", "ip": "192.168.178.80", "first_seen": "2026-11-02T08:10:00Z",
                "last_seen": "2026-11-02T08:59:30Z", "attempts": 50}]
}
```

| Feld | Bedeutung |
|---|---|
| `id` | Die Kennung, zeichengleich. Nur Kennungen, die die Freigabeliste aufnehmen könnte (`^[A-Za-z0-9._-]{1,64}$`, dieselbe Prüfung wie die Route); eine andere merkt sich die Box nicht. |
| `ip` | Adresse der Säule, nur als private RFC1918-Host-Adresse und nie eine eigene Adresse der Box ([`lan-range-vectors.json`](lan-range-vectors.json) `suchbereich` ohne Präfix). Fehlt sonst: die Docker-Box hinter dem Userland-Proxy sieht nur ihr Bridge-Gateway. Die API kennt die Netze der Box außerhalb einer Suche nicht sicher; darum prüft sie nur diese Form. |
| `first_seen`, `last_seen` | Erster und letzter abgewiesener Versuch im Fenster; `last_seen` älter als 24 h = vergessen. |
| `attempts` | Versuche im Fenster, ≥ 1, bleibt bei 100 000 stehen. |

Das Feld steht im Herzschlag-Block `chargers` (Go `cloud.ChargersSummary`) neben der gleichnamigen Liste der
geführten Säulen. Höchstens 16 Einträge, der jüngste `last_seen` zuerst (dieselbe Obergrenze wie die Liste); eine
zugelassene Kennung verschwindet mit dem nächsten Herzschlag. Die Box hält das Fenster im RAM: nach einem Neustart
beginnt es leer. Heute sendet eine Box ohne geführte Säule gar keinen Block; mit diesem Feld sendet sie ihn auch dann,
wenn sie eine abgewiesene Kennung im Fenster hat (mit leerer Liste `chargers`) - sonst bliebe gerade die erste Säule
einer Anlage unsichtbar. Ohne beides bleibt der Herzschlag byte-gleich.

## Warum im Herzschlag-Block `chargers`

- **Es ist Zustand, kein Ereignis.** „Wer hat in den letzten 24 h angeklopft“ ist ein Stand, den die Box hält; der
  Herzschlag spiegelt Stände alle 15 s (wie `chargers`, das [Ladequellen-Echo](ladepunkt-quelle-echo.md) und
  `gemeinsame_steuerung`). Ein verlorener Herzschlag kostet nichts, der nächste trägt dasselbe.
- **Derselbe Block, den der Anbinde-Assistent schon liest.** `ocpp_port` und `url_path` stehen dort; der Assistent
  „Säule anbinden“ und die Wallbox-Seite brauchen den Hinweis ohne Suche, sobald eine Säule anklopft. Die API liest den
  Block schon heute in `ChargerStatusListener`; kein neues Topic, keine ACL-Änderung.
- **Nicht im Ereignis-Vertrag `v2/ocpp-events`.** Der ist das Journal der Protokoll-Nachrichten einer ZUGELASSENEN
  Säule (Call/CallResult/CallError mit `charge_point_id`); eine abgewiesene Verbindung erreicht nie einen Handler, und
  fremde Kennungen gehören nicht in ein Journal, das dauerhaft gespeichert wird.
- **Nicht im Ergebnis der Gerätesuche.** Eine Säule ruft an, wann sie will; an eine Suche gebunden wäre sie nur sichtbar,
  solange jemand sucht. Die Suche zeigt die Liste trotzdem: die API legt sie der Antwort als `ladesaeulenKlopfenAn` bei
  (OpenAPI `GeraetesucheLadesaeuleKlopftAn`).

## Lesen und Verträglichkeit

- Fehlt `rejected` oder der ganze Block (ältere Box) oder ist es keine Liste, ist der Stand **unbekannt** (`null`), nie
  „keine Säule klopft an“. `[]` heißt: die Box meldet, dass keine fremde Säule angeklopft hat.
- Die API liest tolerant: ein Eintrag, der eine Regel verletzt (Kennungsform, Zeiten verdreht, Versuche, doppelte
  Kennung), wird überlesen, die übrigen gelten; eine unzulässige Adresse wird allein überlesen, die Kennung bleibt -
  sie ist, was „Zulassen“ braucht. Unbekannte Felder je Eintrag werden überlesen. Die Box prüft
  streng, bevor sie sendet (`geraetesuche.PruefeKlopftAn`).
- Eine ältere API ignoriert das Feld; der Herzschlag bleibt sonst byte-gleich. Keine eigene Fähigkeit in `supports[]`:
  das Feld selbst sagt, ob die Box es kann.

| Seite | Ort |
|---|---|
| Box (schreibt, Paket Stufe 2) | `internal/csms` merkt sich die Abweisung, `internal/cloud` (`ChargersSummary`) sendet; Prüfer `internal/geraetesuche/klopftan.go` |
| API (liest) | `geraetesuche/KlopftAn.lesen`; Speicher und Route im Paket Stufe 2 |
| Portal (zeigt) | Gruppe „Ladesäule klopft an“ und „Zulassen“, Paket Stufe 2 |
