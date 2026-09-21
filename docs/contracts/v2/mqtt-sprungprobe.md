# Sprungprobe über MQTT (mqtt-sprungprobe 1.0)

UEMS AP-15 IP-21, Kasten E3 = A, Regeln T5/I3/I4, Fälle R1/R19, Befund A17. Cloud-Seite, Auswertung, Protokoll und Naht:
[steuerungsverbund.md §10](steuerungsverbund.md#10-die-sprungprobe-ip-21). Regel und Vektoren:
`uems/SprungprobeRegel` ⟷ [`sprungprobe-vectors.json`](sprungprobe-vectors.json) — die Box rechnet sie **nicht**.

**Stand:** Cloud-Seite (Auftrag senden, Bericht prüfen und auswerten) und Box-Ausführer (`edge-app/core`:
`internal/sprungprobe` + `agent/sprungprobe.go`, Fähigkeit `sprungprobe` in `BuiltSupports()`) sind gebaut. Wirksam an
einer Anlage wird die Box-Seite erst mit einem Edge-Release (Hand des Betreibers); bis dahin meldet keine Box die
Fähigkeit, und die Route antwortet 409 `sprungprobe_nicht_gemeldet`.

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

**Pflichten der Box** (gebaut in `internal/sprungprobe`, verdrahtet in `agent/sprungprobe.go`): sie prüft die Identität wie beim Anteils-Dokument (T4) und verwirft sonst still;
sie verstellt EINE ihrer Stellgrößen für `dauer_s` um höchstens `sprung_kw` — nie mehr, als sie gerade erzeugt bzw.
verbraucht, und nie über das hinaus, was Plan und Anteil gerade erlauben (die Probe ist ein weiterer SENKENDER Wunsch;
kein neuer Schreibpfad zu einem Gerät, keine neue Registerfreigabe, §6.3) — stellt danach zurück, wartet `pause_s`,
wiederholt. Sie **bricht sofort ab**, sobald ein eigener Wächter eingreift (Einspeise-, Bezugs-, Eingefroren-,
Geräteschutz), bei Regelung aus, ohne passende Stellgröße, nach einem Neustart. Ein Anteils-Dokument setzt die Probe
nicht voraus: sie läuft in S1, vor dem Scharfschalten (§5.3); die Wächter stehen über ihr. Ohne Auftrag ist die Box
Byte für Byte wie vorher. Nach dem letzten Sprung wartet sie 30 s (der Netzpunkt kommt über die Telemetrie an) und
berichtet.

**So hält die Box das (Box-Seite):**

- **Stellgrößen:** `erzeugung_senken` = die Anlagen-PV-Kappe (`pv_limit_kw`, dieselbe Größe, die Plan und
  Einspeisewächter tragen); `verbrauch_senken` = das Laden der Batterie (`battery_setpoint_kw` > 0). Der Deckel wird zu
  Beginn jedes Sprungs an der EIGENEN Messung verankert (PV gemessen bzw. `battery_power_kw` gemessen, + = Laden):
  max(Messung − `sprung_kw`, 0), fest für den ganzen Sprung. Unter 1 kW oder ohne Messung: kein Sprung
  (`keine_stellgroesse`).
- **Verknüpfung:** nur als Minimum in den fertigen Sollwert (`sprungprobe.Kappe`/`Laden`): das Laden hinter allen
  Klemmen und beiden Bezugs-Wächtern, vor Abregel-Verfolger und Einspeisewächter; die PV-Kappe NACH dem
  Einspeisewächter. Eine Entladung, ein ruhender Speicher oder eine fehlende Kappe werden nie angehoben.
- **Abbruch (derselbe Takt):** Einspeisewächter hält die Erzeuger zurück, regelt blind oder senkt die Entladung →
  `einspeisewaechter`; ein Bezugs-Wächter (Lastspitze, Netzladen-Deckel IP-19) senkt den Sollwert → `bezugswaechter`;
  eingefrorener Netzpunkt-Wert (IP-20, nur gelesen) → `eingefroren`; Schutz-Sperre des Batterie-BMS → `geraeteschutz`;
  Regelung aus → `regelung_aus`; über `gueltig_bis` bzw. die Gesamtdauer → `abgelaufen`. In der Pause bricht ein
  Wächter genauso ab; im Nachlauf nicht mehr.
- **Genau ein Bericht:** er wartet, bis der Link ihn nimmt; der offene Auftrag steht auf der Platte
  (`sprungprobe-offen.json`) — nach einem Neustart meldet die Box ihn `abgebrochen`/`neustart`, sie setzt nie einen
  Sprung fort. Ein zweiter Auftrag, solange einer läuft oder unberichtet ist, wird nicht genommen.
- **Hinweis für das Auslösen:** andere Regelkreise der Box (Eigenverbrauch, Lastspitze) können einen Sprung am
  Netzpunkt ausgleichen; ein Bezugs-Eingriff bricht ab, ein Eigenverbrauchs-Ausgleich zeigt sich als `nicht_gesehen`
  bzw. `zu_klein` — nie als Bestanden. Auslösen, wenn die Bedingungen passen (§5.3).

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
(cd edge-app/core && go test ./internal/sprungprobe/ ./internal/cloud/ ./internal/agent/ -run 'Sprungprobe|Sprung|Abbruch|OhneAuftrag|Lesen|MitProbe|KeinSprung')
```
