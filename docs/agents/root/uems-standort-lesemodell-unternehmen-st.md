# UEMS-Standort-Lesemodell: Unternehmen und Standorte zum Stichtag

Neu angelegt am 11.09.2026 (AP-02 IP-3 ★ — das Read-Model, auf das AP-01 IP-5, die
Startansicht-Weiche, wartet). Reine Ableitung `services/api/.../uems/StandortLesemodell.java`
(Zeilen → Antwort, ohne Spring/Uhr), Lesezug `StandortLesemodellService`, Routen
`UnternehmenController` (`GET /api/v1/unternehmen`) und `StandortController`
(`GET /api/v1/standorte?stichtag=`, `GET /api/v1/standorte/{id}`), additiv `standort` an
`GET /api/v1/overview` und am NEUEN `GET /api/v1/sites/{id}`. Beweise: `StandortLesemodellTest`
(jeder `stand_am`-Fall aus `docs/contracts/v2/ortsbaum-vectors.json`, ohne DB) und
`StandortLesemodellApiTest` (Keycloak + Timescale: RLS, 404, Bestand, additive Felder).

## Was es gibt — und was (noch) nicht

- Nur LESEN. Die Ableitung (Stand am, Fläche, Anlagen-Zuordnung) rechnet
  `OrtsbaumAbleitung.standAm`; das Lesemodell übersetzt nur Zeilen in dessen Baum. Kennzeichen
  im Baum sind die UUIDs der Zeilen, nie die Kurzzeichen (änderbar; seit `V20260911210000`
  kollidieren sie zwischen `standort` und `ort` nicht mehr — die Schreibrouten schlüsseln für
  ihre Sätze auf Kurzzeichen um, `uems-standort-schreibrouten-kurzzeichen-archiv.md`).
- Antwortformen sind OBJEKTE, damit `teilansicht {sichtbar, gesamt}` (AP-03 IP-10) additiv
  dazukommt. Keine Rechte-Annotation: `authenticated()` + RLS wie `/api/v1/sites/**`.
- Schreibrouten (IP-4/IP-5) und der Name zum Stichtag (AP-12) sind NICHT hier. Die Lücke
  Archiv → Wiederherstellen lebt nur im Protokoll; seit IP-4 liest das Lesemodell sie von dort
  (`Zeilen.standortArchiv`, `StandortLesemodell.bestehen`).

## ⚠ Die Fallen

- **Ein Standort hat kein Intervall.** Sein Bestehen = `created_at` (Tag in SEINER Zeitzone)
  bis Vortag von `archiviert_am` — ABER früher, sobald etwas wirksam früher an ihm hängt
  (Anlage, Ort, Fläche). Sonst hinge eine von IP-9 ab `site.created_at` zugeordnete
  Bestandsanlage an einem Standort, den es noch nicht gibt (Vektor-Fall
  `a5-bestand-standort-besteht-seit-der-anlage`). Wer in einem Test Stichtage vor „heute“
  prüft, setzt `standort.created_at` auf den Szenario-Beginn.
- **`GET /api/v1/sites/{id}` gab es vorher nicht** (die Portal-Liste reicht bisher). Er ist
  `SiteDetailDto(@JsonUnwrapped SiteDto, standort)`: die Listen-Zeile zeichengleich plus
  `standort` am Ende — `SiteDetailDtoJsonTest` hält das Flach-Sein fest.
- **Kein Unternehmen ist ein Zustand, kein Fehler:** `zustand: nicht_angelegt`, Stammdaten
  `null`, Zahlen trotzdem richtig. Ein Admin OHNE `X-Tenant-Id` bekommt 404 (wie
  `/tenant-context`) — geprüft über die RLS-sichtbare `tenant`-Zeile, nie über die Query.
- **Neuer Kundenbereich ⇒ genau ein Unternehmen im SELBEN Statement**
  (`TenantRepository.create`, datenverändernde CTEs: `tenant` → `unternehmen` →
  `ort_aenderung`, Akteur „VoltPilot“ — nicht „(Bestandsübernahme)“). Die App-Rolle hat kein
  INSERT auf `unternehmen`. Dafür räumt `deleteById` (Kompensation der Registrierung) das
  Unternehmen zuerst ab, in einer Hand-Transaktion (FK `ON DELETE RESTRICT`).
- **Zahlen null statt 0:** ein Standort, den es am Stichtag nicht gab, hat `anlagen: []` und
  `anlagenZahl/gebaeudeZahl/bereichZahl/flaecheM2 = null`; `nochNichtZugeordnet` ist `null`,
  sobald alles zugeordnet ist (A15). `esFehlt` gibt es nur im Entwurf (E10: `adresse`).
- **„heute“** ist der Tag in der Zeitzone des Unternehmens (Vorgabe Europe/Berlin); ohne
  Standort-Zeilen liest der Dienst nur Standorte + Anlagen (das kostet `/overview` fast nichts).
