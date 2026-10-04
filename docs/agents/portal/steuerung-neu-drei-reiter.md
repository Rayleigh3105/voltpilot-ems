# Steuerung neu: drei Reiter Geräte · Laden · Regeln

Konzept und Prototyp: [`docs/konzepte/steuerung`](../../konzepte/steuerung/README.md), Entscheide E1–E9 = A
(29.09.2026). Löst die Zonen-Seite der Stufen 1–9 ab (Jetzt-Zone, Verbraucher-Zone,
Betriebsmodell-Radiogruppe, Regel-Kapsel, Ladepark-Rahmen-Karte); deren Notizen gelten nur noch für
die Server-Regeln, die sie nennen.

## Aufbau

- **Routen:** `steuerung` (Reiter Geräte), `laden` (nur mit Ladepunkt), `regeln`. Alle drei gehören
  zum Bereich Steuerung (`anlageNav.ts` `SUB_BEREICH`); `AnlagenPage` rendert für sie keinen
  Seitenkopf und keine Bereichsreiter, sondern `SteuerungSection` → `steuerung/SteuerungSeite.tsx`.
  Alte Lesezeichen `steuerung?vorlage|verbraucher|komponente=` leitet `canonicalAnlageHash` auf
  `regeln` um, der Query bleibt; die Seite öffnet daraus den Satzbaukasten und räumt die Adresse mit
  `replaceCurrentNavigation` auf.
- **Reine Module** unter `src/steuerung/`: `zeit.ts` (192 Viertelstunden heute + morgen), `bild.ts`
  (Reihen aus Verlauf/Plan/Telemetrie, `GeraetBild`, Quellen-Anteil), `seite.ts` (EIN `seitenBild`
  je Datenstand), `neu.ts`, `regeln.ts` (Satz ↔ geführte Regel), `laden.ts`, `szenen.ts`.
  Komponenten rendern nur deren Ergebnis.
- **Daten:** `useSteuerungDaten` lädt jede Quelle einzeln und fehlertolerant; nur die
  Verbraucher-Liste trägt die Seite. Takte aus `pollCadence.ts` (`LIVE_POLL_MS` / `LIST_POLL_MS`).
- **Blätter** (`Blatt.tsx`) sind das Blatt des Prototyps: unten am Telefon, zentriert am Rechner,
  Fokusfalle, Escape, Rückkehr zum Auslöser, Scroll-Sperre. Die Styles liegen unter
  `:is(.stn, .stn-blatt)`, weil das Blatt per Portal außerhalb von `.stn` hängt.
- **Zweispaltig** über `@container stn (min-width: 900px)`: `.links` / `.rechts` / `.voll`. Die
  rechte Spalte beginnt in Zeile 1 — Hinweisbänder (Pause, Szene) stehen deshalb in
  `.stn-baender` VOR dem Raster, nie als `.voll`-Kind darin.

## Ehrlichkeit (nicht verhandelbar)

- Vergangenheit nur aus Messung (`entityHistory`); ein Gerät ohne Leistungsmessung hat keine
  Vergangenheitszeilen. Zukunft aus dem Verbraucher-Fahrplan, sonst „erwartet“ aus Steuerart und
  Prognose — die Legende sagt „Plan und Erwartung“. Pausierte Geräte haben weder Plan noch Erwartung.
- „Strom aus Sonne/Speicher/Netz“ ist ein anteiliger Schluss (`quellenAnteil`), nie eine Messung.
- Ein Ladeziel wird nur mit angestecktem Auto geschätzt; sonst „Kein Auto angesteckt“.
- Bausteine, die die Box nicht ausführen kann (Außentemperatur, günstigste Stunden, anderes Gerät,
  „nie wenn“), stehen als „kommt noch“ da, nie als stiller Knopf.

## Schreibwege (alle bestehend, außer Szene und „nur messen“)

Eingriff am Verbraucher `consumersApi.startOverride/clearOverride` (Server-Deckel 4 h), Ladepunkt
`chargingBoost`, Speicher `startBatteryOverride`, Pause `pauseAutomation`, Smart `setzeSteuerart`,
Reihenfolge `saveRangliste`, Betriebsmodell `setSiteProfile`, Regeln über die Flow-API
(`create`/`save` → `activate`). **„Nur messen“** ist die Haltung `nur_messen` ohne Frist in
`suggestion-states` (V20260929120000) und wird beim Übernehmen per `DELETE` zurückgenommen.
**Szenen** (`/scene`, `SzenenService`) pausieren gewählte Verbraucher über den Pausenweg und setzen
beim Beenden genau die fort, die die Szene pausiert hat; ohne `voltpilot.consumer-control.enabled`
verweigert der Server das Einschalten, weil er danach nicht fortsetzen könnte.

## Prüfen

`src/steuerung/*.test.ts`, `src/pages/SteuerungSection.test.tsx`, Playwright
`e2e/steuerung.spec.ts` (Beispielanlage `e2e/steuerung.*`, Uhr 29.09.2026 13:10 Berlin, 1440 und 375).
Die Hilfe-Aufnahmen `steuerung`, `steuerung-geraete`, `regeln`, `regeln-mobil`, `ladepark` kommen aus
derselben Beispielanlage (`seite: 'steuerung'` in `e2e/help-captures.mjs`).
