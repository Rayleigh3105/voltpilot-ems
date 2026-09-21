# Anteils-Dokument und Quittung (MQTT, UEMS AP-15 IP-7)

Kundenwort: **Gemeinsame Steuerung** — „Verbund“ steht nur in Vertrags- und Code-Namen. Die Regeln (G2–G5, T4) und
die Prüfung auf der Box stehen in [`steuerungsverbund.md`](./steuerungsverbund.md); dieses Dokument legt den Draht
fest. Schema: [`mqtt-verbund-anteile.schema.json`](./mqtt-verbund-anteile.schema.json) (Dokument; `$defs/quittung`
für den Uplink). Vektoren: [`verbund-anteile-mqtt-vectors.json`](./verbund-anteile-mqtt-vectors.json).

## 1. Topics

| Richtung | Topic | Retained | QoS |
|---|---|---|---|
| Cloud → Box | `ems/{tenant}/{site}/{device}/v2/verbund-anteile` | ja (Y1: gespeichert, ohne Ablauf) | 1 |
| Box → Cloud | `ems/{tenant}/{site}/{device}/v2/verbund-anteile-result` | wie `plan-result` | 1 |

Beide liegen auf dem eigenen `v2`-Teilbaum der Box — keine ACL-Änderung. v1-Topics werden nicht berührt. **Eine Box
ohne Gemeinsame Steuerung bekommt nie ein Dokument und hat kein solches Topic** (I6): veröffentlicht wird nur für
einen Verbund ab Stufe S1 (LA2), und nur an seine Mitglieder.

## 2. Das Dokument (Downlink)

```json
{
  "schema_version": "1.0",
  "tenant_id": "…", "site_id": "…", "device_id": "<die Box des Topics>",
  "epoche": 1, "revision": 8, "schritt": "uebergang",
  "verteilbar": { "einspeisung": 100.0, "bezug": 77.0 },
  "anteile": {
    "einspeisung": { "<E-1>": 10.0, "<E-4>": 60.0 },
    "bezug":       { "<E-1>": 0.0,  "<E-4>": 77.0 }
  },
  "published_at": "2027-10-20T09:00:00Z"
}
```

- **Die GANZE Tabelle** beider Richtungen und `verteilbar` reisen mit (Y1) — jede Box prüft die Summe selbst.
  Kennungen der Boxen sind die `device.id`; kW mit einer Nachkommastelle (Zehntel-kW, G2).
- **`device_id` = die Box des Topics.** Weicht sie ab, ist das Dokument nicht ihres: verworfen, ohne Quittung.
  Weichen `tenant_id`/`site_id` vom Topic ab, lehnt die Box mit `fremde_anlage` ab (T4).
- **`schritt`**: `uebergang` = je Box das Kleinere aus alt und neu (G5), ein Zielstand folgt; `ziel` = der Zielstand
  (auch, wenn der Übergang schon der Zielstand ist — reines Verengen).
- **Epoche und Revision steigen nur.** Die Revision steigt je Dokument eines Verbunds; eine neue Epoche setzt nur das
  Scharfschalten. Das Dokument reist **nie im Plan**.

Die Box prüft in der Reihenfolge von `steuerungsverbund.md` §1 (`dokument_pruefen`): `fremde_anlage` ·
`box_fehlt_im_dokument` · `revision_aelter` · `summe_ueber_verteilbar`; dieselbe Revision noch einmal (gespeichert,
nach Wiederverbindung) ist angenommen. Die Box-Seite baut IP-17 (Go-Zwilling).

## 3. Die Quittung (Uplink)

```json
{
  "schema_version": "1.0",
  "tenant_id": "…", "site_id": "…", "device_id": "<die Box des Topics>",
  "epoche": 1, "revision": 8,
  "urteil": "abgelehnt", "grund": "revision_aelter",
  "wirksam": { "epoche": 1, "revision": 9 },
  "ts": "2027-10-20T09:00:05Z"
}
```

- `epoche`/`revision` nennen das beurteilte Dokument; `urteil` ∈ `angenommen` · `abgelehnt`.
- `grund` nur bei `abgelehnt`, geschlossen: die vier Wörter aus `dokument_ablehnung` (IP-2). Ein anderes Wort, ein
  fehlender Grund bei `abgelehnt` oder ein Grund bei `angenommen` → die Cloud verwirft die Quittung.
- `wirksam` (wahlfrei): der Stand, den die Box danach hält.
- Topic- und Payload-Identität wie `plan-result`: `tenant_id`/`site_id`/`device_id` = Topic, sonst verworfen; die Box
  muss aktives Mitglied des Verbunds dieser Anlage sein.

## 4. Der Ablauf in der Cloud (`uems/SteuerungsverbundAnteilDienst`)

1. **Scharfschalten der Anteile** (`anteileScharfschalten`, ab S1): Auslegung muss in BEIDEN Richtungen `passt` sein
   (E2 = A), sonst nichts. Neue Epoche; „alt“ = was die Boxen wirksam halten: vor dem ersten Dokument die führende Box
   mit der ganzen Grenze und jede andere mit ihrem Rückfall (§5.3, W11), danach je Box das Größere aus quittiertem und
   gesendetem Dokument, sobald der Herzschlag sie meldet dessen Werte (Y3, IP-17).
2. **Übergang an ALLE Mitglieder**; der Zielstand wartet in der Dokument-Zeile.
3. **Zielstand erst nach der Quittung JEDER verengten Box** (Übergang < alt in irgendeiner Richtung). Fehlt eine, bleibt
   der Übergang — ohne Zeitablauf (R12: bleibt 10/60).
4. **Ändern** (`anteileAendern`) in derselben Epoche; nicht, solange ein Übergang wartet.
5. **Rückspielen (A18)**: meldet eine Box einen Stand über allem, was die Cloud je gemacht hat, oder lehnt sie mit
   `revision_aelter` ab, ist die Cloud-Datenbank zurückgespielt. Dann ändert die Cloud nichts mehr, bis neu
   scharfgeschaltet wird — und das nur mit den WIRKSAMEN Anteilen aller Mitglieder aus dem Herzschlag. Heute liefert
   der Herzschlag sie noch nicht (IP-10 spiegelt `plan_id`, die Anteile kommen mit IP-17): bis dahin antwortet der
   Dienst `WIRKSAME_ANTEILE_UNBEKANNT`.

Gespeichert wird in `V20260921190000`: `steuerungsverbund_anteile` (jedes Dokument, nur anhängen),
`steuerungsverbund_geraet` (Geräte je Box: Nennleistung, Schreibfreigabe — ohne sie zählt ein Gerät als ungeregelt mit
Nennleistung, I1; Ungeregeltes hinter dem Abgang ohne Komponente) und am Verbund der Vorbehalt je Richtung mit
wer/wann (IP-13 füllt ihn später aus Messwerten) sowie die Marke „Rückspielen erkannt“.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='VerbundAnteileVectorsTest,SteuerungsverbundZweischrittTest')
(cd services/api && ./mvnw test -Dtest=SteuerungsverbundAnteilDienstTest)   # Testcontainers
```
