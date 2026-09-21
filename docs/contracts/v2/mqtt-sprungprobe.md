# Sprungprobe über MQTT (mqtt-sprungprobe 1.0)

UEMS AP-15 IP-21, Kasten E3 = A, Regeln T5/I3/I4, Fälle R1/R19, Befund A17. Cloud-Seite, Auswertung, Protokoll und Naht:
[steuerungsverbund.md §10](steuerungsverbund.md#10-die-sprungprobe-ip-21). Regel und Vektoren:
`uems/SprungprobeRegel` ⟷ [`sprungprobe-vectors.json`](sprungprobe-vectors.json) — die Box rechnet sie **nicht**.

**Stand:** die Cloud-Seite ist gebaut (Auftrag senden, Bericht prüfen und auswerten). Der Box-Ausführer (`edge-app/core`)
folgt als eigener PR; bis dahin meldet keine Box die Fähigkeit `sprungprobe`, und die Route antwortet 409
`sprungprobe_nicht_gemeldet`. Es gibt kein Edge-Release in diesem Schritt.

## 1. Topics

| Richtung | Topic | retained | QoS |
|---|---|---|---|
| Cloud → Box | `ems/{tenant}/{site}/{device}/v2/sprungprobe` | **nein** — ein Auftrag läuft nie ein zweites Mal nach einem Wiederverbinden | 1 |
| Box → Cloud | `ems/{tenant}/{site}/{device}/v2/sprungprobe-result` | beliebig (die Cloud wertet je `probe_id` genau einmal aus) | 1 |

Topic- und Payload-Identität müssen übereinstimmen (`tenant_id`, `site_id`, `device_id`); v1-Topics werden nicht berührt.
Nur die Plattform-Rolle löst aus (`POST /api/v1/admin/sites/{siteId}/gemeinsame-steuerung/sprungprobe`); eine Anlage
ohne Gemeinsame Steuerung bekommt nie ein Topic.

## 2. Auftrag (Cloud → Box)

```json
{
  "schema_version": "1.0",
  "tenant_id": "…", "site_id": "…", "device_id": "…",
  "probe_id": "…",
  "art": "erzeugung_senken",
  "sprung_kw": 30,
  "dauer_s": 60,
  "wiederholungen": 2,
  "pause_s": 60,
  "gueltig_bis": "2027-06-13T11:02:00Z",
  "ts": "2027-06-13T11:00:00Z"
}
```

- `art`: `erzeugung_senken` (eine Erzeugung abregeln) oder `verbrauch_senken` (einen Verbrauch — Ladepunkt, Speicher-
  Laden — zurücknehmen). Beides ist die sichere Richtung (§5.3); ein Anheben gibt es nicht.
- Obergrenzen (benannte Konstanten in `SprungprobeRegel`, CHECK in der Tabelle): `sprung_kw` > 0 und ≤ 50, `dauer_s` 60,
  `wiederholungen` 2, `pause_s` 60. Nach `gueltig_bis` (Auslösen + 120 s) beginnt die Box den Auftrag nicht mehr.

**Pflichten der Box (für den Box-PR):** sie prüft die Identität wie beim Anteils-Dokument (T4) und verwirft sonst still;
sie verstellt EINE ihrer Stellgrößen für `dauer_s` um höchstens `sprung_kw` — nie mehr, als sie gerade erzeugt bzw.
verbraucht, und nie über das hinaus, was Plan und Anteil gerade erlauben (die Probe ist ein weiterer SENKENDER Wunsch;
kein neuer Schreibpfad zu einem Gerät, keine neue Registerfreigabe, §6.3) — stellt danach zurück, wartet `pause_s`,
wiederholt. Sie **bricht sofort ab**, sobald ein eigener Wächter eingreift (Einspeise-, Bezugs-, Eingefroren-,
Geräteschutz), bei Regelung aus, ohne passende Stellgröße, nach einem Neustart. Ein Anteils-Dokument setzt die Probe
nicht voraus: sie läuft in S1, vor dem Scharfschalten (§5.3); die Wächter stehen über ihr. Ohne Auftrag ist die Box
Byte für Byte wie vorher. Nach dem letzten Sprung wartet sie 30 s (der Netzpunkt kommt über die Telemetrie an) und
berichtet.

## 3. Bericht (Box → Cloud)

```json
{
  "schema_version": "1.0",
  "tenant_id": "…", "site_id": "…", "device_id": "…",
  "probe_id": "…",
  "art": "erzeugung_senken",
  "stellgroesse": "pv_kappe",
  "spruenge": [
    { "von": "2027-06-13T11:00:10Z", "bis": "2027-06-13T11:01:10Z", "vorher_kw": 55.0, "waehrend_kw": 25.0 },
    { "von": "2027-06-13T11:02:10Z", "bis": "2027-06-13T11:03:10Z", "vorher_kw": 55.0, "waehrend_kw": 25.0 }
  ],
  "abgebrochen": false,
  "grund": null,
  "ts": "2027-06-13T11:03:40Z"
}
```

- `spruenge` (0–3): je Sprung von/bis (höchstens `dauer_s` + 5 s) und die EIGENE Messung der verstellten Größe als Betrag
  (Erzeugung bzw. Verbrauch, ≥ 0) vorher und während; `null` = unbekannt. Die eigene Änderung ist während − vorher.
- `abgebrochen` true verlangt `grund` aus `einspeisewaechter` · `bezugswaechter` · `eingefroren` · `geraeteschutz` ·
  `regelung_aus` · `keine_stellgroesse` · `abgelaufen` · `neustart`; sonst fehlt `grund` (oder ist null).
- `stellgroesse` wahlfrei, ein Wort `[a-z][a-z0-9_]{0,63}`. Unbekannte Felder: verworfen.
- Verworfen (ohne Urteil) wird auch ein Bericht zu einer unbekannten, fremden, schon ausgewerteten oder mehr als 10 min
  alten Probe oder mit einer anderen `art` als im Auftrag (`uems/SprungprobeBericht#lesen`,
  `SprungprobeDienst#berichtEmpfangen`).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='SprungprobeRegelTest,GemeinsameSteuerungSchnittstelleVertragTest')
(cd services/api && ./mvnw test -Dtest='SprungprobeApiTest')   # Testcontainers, Anlagenmodell — nie eine echte Anlage
```
