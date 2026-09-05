# OCPP-Lastmanagement Stufe 4: PV-Überschussladen und „Jetzt voll laden" aus dem Portal

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 135).


Die Cloud-Hälfte der letzten Stufe (Konzept `data/vp-ocpp-lastmgmt-konzept-w4`
§2.8, Mockups `data/vp-ocpp-mockups-r5`; Captain-Entscheide: **die Prioritäten
wählt der KUNDE · die Übersteuerung DARF Netzstrom ziehen · KEIN Feature-Flag**).
Budget und Verteilung bleiben unverändert auf der Box (die Anschlussgrenze ist
eine physische Grenze, E1); die Cloud PFLEGT die Wahl, SIEHT das Ergebnis und
ERTEILT die Einmal-Freigabe.

- **Die QUELLEN-Wahl reist auf dem BESTEHENDEN retained Dokument**
  (`mqtt-charging-config.schema.json` additiv um `surplus_policy` /
  `storage_priority` erweitert, `schema_version` bleibt 1.0) — kein zweites
  Topic, keine Broker-Änderung, dieselbe PATCH-Semantik. **⚠ `null` heißt „dazu
  sagt das Portal nichts" und ist NIE `schnell`**: das erste gespeicherte
  Dokument einer Anlage darf ihr nicht still die auf `:8484` gepflegte Politik
  nehmen. Gespeichert in `site_charging_config` (Migration `V20260831000000`,
  zwei Spalten mit CHECK-Vokabular), geschrieben über denselben
  `saveSourceChoice`-Upsert wie die Grenze, validiert mit deutschem Grund.
- **„Jetzt voll laden" ist eine EINMAL-Freigabe, kein Zustand**
  (`ChargingBoostService` + `ChargingBoostPublisher` +
  `POST /api/v1/sites/{siteId}/charging-boost`, RLS-gefenced wie jede
  `/sites/**`-Route — kein `@PreAuthorize`, fremde Anlage 404). **⚠ Reihenfolge:
  erst VERÖFFENTLICHEN, dann protokollieren** (die OTA-Apply-Doktrin) — geht die
  Nachricht nicht hinaus (503), darf keine Zeile eine Freigabe behaupten, die es
  nie gab. Ein Stecker ohne laufende Sitzung ist ein benannter 409; die
  Höchstdauer (4 h) prüfen BEIDE Seiten.
- **⚠ Die Cloud entscheidet NICHTS über den Ladevorgang.** Ob der Stecker
  existiert, ob dort wirklich geladen wird und wie die Freigabe im Verteiler
  wirkt, entscheidet die Box (`Agent.OcppBoost` — derselbe Kern, den die
  `:8484`-Taste ruft). Es gibt also weiterhin GENAU EINEN Übersteuerungs-Pfad.
- **Der Rückkanal ist additiv am BESTEHENDEN `chargers`-Block:** je Standort die
  Quellen-Wahl, der gemessene Überschuss (gesamt / an den Speicher / an die
  Fahrzeuge), der Modus (`gemessen`/`nicht_belegbar`) und der deutsche Satz der
  Box; je Stecker das Flag `boost`. Gespeichert in `device_charging_budget` /
  `device_charge_connector` (dieselbe Migration), **jedes Wort gegen ein
  geschlossenes Vokabular geprüft und sonst VERWORFEN** (die Regel des
  `ChargerStatusListener`), jeder fehlende Messwert bleibt NULL — ein Ladepunkt,
  der nichts meldet, hat nachweislich keinen Überschuss von 0.
- **⚠ Der Speicher-Kanal wird als ARGUMENT durchgereicht, nie aus der
  Messwert-Karte gelesen** (`agent.ocppObserve(ts, measurements, battKw)`):
  `onLocalTelemetry` legt `battery_power_kw` bewusst NICHT in die Karte (interner
  Kanal, kein veröffentlichter Messwert), eine Suche dort ging also auf jeder
  echten Box ins Leere und die Speicher-Arbitrierung war TOT — während die
  Unit-Tests ihre Karte von Hand füllten und grün blieben. **Am Rig gefunden
  (L8), nicht im Test**; der Wächter ist seither
  `TestTheBatteryReachesTheSurplusSplitThroughTheRealTelemetryPath` (echter
  Telemetrie-Weg, mutationsgeprüft).
- **Rig (Docker-frei, `edge-app/test/e2e-ocpp.sh`):** L7 „Nur Sonnenstrom"
  deckelt auf den gemessenen Überschuss, während die physische Bahn offen steht
  (die niedrigere gewinnt) und der Verknüpfungspunkt danach bei 0 kW steht ·
  L8 dieselbe Sonne, umgelegte Priorität, 80 → 120 kW AN DEN SÄULEN · L9 die
  Übersteuerung gilt GENAU EINEM Ladevorgang, der Anschluss hält, die Rücknahme
  stellt die Priorität wieder her.
- **Die OPTIMIERER-Kopplung ist „Weg A" (Captain-Entscheid 20.08.2026): der Plan
  reicht eine OBERGRENZE herunter, nie einen Sollwert.** Getragen wird genau
  EINE Größe — das Lastspitzen-ZIEL, das die Box allein nicht kennen kann
  (`grid_import_limit_kw`, seit PS-3 im mqtt-schedule-Kontrakt; **keine
  Vertrags- und keine Optimierer-Änderung**). Anschlussgrenze und §14a-Hülle
  hat die Box längst selbst, die Einspeisegrenze ist eine Export-Schranke und
  kann das Laden nicht begrenzen. Ohne diese Bahn konnte der Ladepark genau die
  Spitze sprengen, die die Batterie daneben teuer hält. **Strikt fail-open:**
  kein Plan, ein VERALTETER Plan, kein Ziel oder keine Messung ⇒ die lokale
  Logik gilt unverändert — ein Fahrzeug bleibt NIE wegen eines fehlenden Plans
  stehen. Edge-Details + die bewusste Frische-Abweichung zum Batterie-Wächter:
  `edge-app/AGENTS.md` „Stufe 4: die FAHRPLAN-Bahn".
- **⚠ ABGEGRENZT und im Backlog, NICHT gebaut: „Weg B" — eine echte
  Lade-Anforderung je Säule** („bis 06:00 mindestens X kWh") mit Kundenfläche
  und Datenmodell. Erst sie macht aus dem Ladepark einen echten
  `ControllableLoadEntity` im Consumer-Dispatch; ohne Anforderung plant der
  Solver ihn per Konstruktion in JEDEM Slot auf AUS (`entities.py`: „ein
  Verbraucher läuft NUR für seine Anforderungen"), und ein daraus abgeleitetes
  Slot-Budget wäre flächendeckend 0. Das ist der Grund, warum Stufe 4 die
  Obergrenze und nicht den Dispatch trägt.
- **Beweise:** `ChargingConfigPublisherTest` (+1: die Wahl reist, Abwesenheit ist
  nicht `schnell`) · `ChargingBoostPublisherTest` (5: die Draht-Form gegen die
  Kontrakt-Fixtures, nicht-retained, der Stempel) · `ChargerStatusListenerTest`
  (+3: die Überschuss-Felder, das verworfene Wort, der ältere Herzschlag) ·
  `ChargerApiTest` (+1, echtes EMQX: die Wahl wird gespeichert und zugestellt,
  „Jetzt voll laden" erreicht GENAU EINEN Ladevorgang, alle Ablehnungen ohne
  Wirkung, Mandanten-Zaun) · Edge `internal/chargingboost` +
  `agent/charging_boost_test.go`. Portal-Seite in `frontend/portal/AGENTS.md`.

