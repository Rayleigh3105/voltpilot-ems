# Steuerung neu: drei Reiter Geräte · Laden · Regeln

Konzept und Prototyp: [`docs/konzepte/steuerung`](../../konzepte/steuerung/README.md), Entscheide E1–E9 = A
(29.09.2026). Löst die Zonen-Seite der Stufen 1–9 ab (Jetzt-Zone, Verbraucher-Zone,
Betriebsmodell-Radiogruppe, Regel-Kapsel, Ladepark-Rahmen-Karte); deren Notizen gelten nur noch für
die Server-Regeln, die sie nennen.

## Aufbau

- **Routen:** `steuerung` (Reiter Geräte), `laden` (nur mit Ladepunkt), `regeln`. Alle drei gehören
  zum Bereich Steuerung (`ebenenNav.ts` `SUB_BEREICH`); `AnlagenPage` rendert für sie keinen
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

## UEMS: „Steuern & Optimieren“ (Nachzug 1d)

- `funktion.ts` leitet aus `/funktionen` (fail-soft in `useSteuerungDaten`; ohne Antwort behauptet die
  Seite nichts) die Lage der Anlage ab und legt sie als `bild.funktion` ins `seitenBild`.
- **Ruhe** = entwurf, eingerichtet, angehalten (wie `RuheHinweisRegel`) und beendet (auch „beenden“
  schreibt die Ruhe). `/interventions` zeigt die Ruhe bewusst nicht. In Ruhe: Plakette mit Zustand statt
  „Automatik an“ (kein Pause-Knopf), Band „Angehalten seit …“ / „Eingerichtet am … — …“, Ruhe-Satz der
  älteren Box (#986); Aus/Ein im Blatt und Aus/Schnell am Ladepunkt gesperrt mit Grund, und `eingriff`,
  `speicherEingriff`, `pause` sperren zentral - sonst antwortet der Server 409. „Smart“ bleibt.
- **Ohne Teilnahme** (kein Objekt, beendet; Steuern-Regel #779): keine Karte „Neu in Ihrer Anlage“, kein
  „Gerät fehlt?“; Geräte ohne Auftrag stehen als `einordnung.still` mit dem Weg „Steuerart“. Nur „kein
  Objekt“ bekommt den Einstieg (#965, Knopf hinter `funktion.steuern_einrichten`, öffnet `SteuernAssistent`).
- Offen für die Varianten-Pakete: was Geräte einer Messanlage zeigt (SZ-1) und wo man anhält/fortsetzt (SZ-2).

## Schreibwege (alle bestehend, außer Szene und „nur messen“)

Eingriff am Verbraucher `consumersApi.startOverride/clearOverride` (Server-Deckel 4 h), Ladepunkt
`chargingBoost`, Speicher `startBatteryOverride`, Pause `pauseAutomation`, Smart `setzeSteuerart`,
Reihenfolge `saveRangliste`, Betriebsmodell `setSiteProfile`, Regeln über die Flow-API
(`create`/`save` → `activate`). Die Anschlussgrenze im Rahmen-Blatt geht über den Kunden-Schritt
`saveCustomerChargingFrame` (`PUT /charging-frame`, Prüfung gegen den Netzanschluss mit 422, nie über
`saveChargingConfig`): [Ladegrenze](../root/uems-ladegrenze-kundenroute.md). **„Nur messen“** ist die Haltung `nur_messen` ohne Frist in
`suggestion-states` (V20260929120000) und wird beim Übernehmen per `DELETE` zurückgenommen.
**Szenen** (`/scene`, `SzenenService`) pausieren gewählte Verbraucher über den Pausenweg und setzen
beim Beenden genau die fort, die die Szene pausiert hat; ohne `voltpilot.consumer-control.enabled`
verweigert der Server das Einschalten, weil er danach nicht fortsetzen könnte.

## Rechte (AP-03 IP-12, Nachzug 1b)

Jeder Schreibknopf steht in `components/Recht` mit dem Recht seines Schreibwegs: Eingriff, Lademodus,
Speicher-Eingriff, Pause → `handeingriff.setzen`; Smart/„Womit laden“/Ladeziel, Reihenfolge, Betriebsmodell,
Vorrang, Regeln (neu, Vorlage, Schalter, aktivieren, löschen), Szene an/aus, „nur messen“ und „Speicher darf
aushelfen“ → `betriebsweise.aendern`; Fahrzeug → `ladepunkt.betrieb`; Anschlussgrenze → `grenze.eintragen`.
Ohne Recht stehen Grund und Weg an der Stelle des Hebels; eine Gruppe (Aus · Smart · Ein, Chips, Fußzeile) ist
EIN Hebel. Ausnahme: der Automatik-Knopf im Kopf zeigt den Zustand und bleibt sichtbar, gesperrt mit dem Grund als
`title`. In Ruhe (1d) sperrt die Ruhe für alle und sagt ihren Grund (Plakette statt Knopf, Satz unter Aus · Smart · Ein
und am Lademodus, außerhalb von `Recht`); die Knöpfe selbst folgen weiter dem Recht. `PATCH /consumers/{id}` prüft je Feld (`allowStorageDischarge` = Betrieb, jedes andere Feld
`geraet.einrichten`) wie `PUT /charging-config`. Nachweise: `SteuerungSection.test.tsx` (IK ohne Steuerrecht,
MD ohne Grenze), `RechtMatrixApiTest`, `e2e/portal-rechte.spec.ts` (R1).

## Prüfen

`src/steuerung/*.test.ts`, `src/pages/SteuerungSection.test.tsx`, Playwright
`e2e/steuerung-anhalten.spec.ts` und `e2e/leerzustaende.spec.ts` (Funktion), `e2e/steuerung.spec.ts` (Beispielanlage `e2e/steuerung.*`, Uhr 29.09.2026 13:10 Berlin, 1440 und 375).
Die Hilfe-Aufnahmen `steuerung`, `steuerung-geraete`, `regeln`, `regeln-mobil`, `ladepark` kommen aus
derselben Beispielanlage (`seite: 'steuerung'` in `e2e/help-captures.mjs`).
