# Betriebs-Runbook: steuerbare Verbraucher

**Stand:** 2026-08-10 (Verbrauchssteuerung Inkrement 5)
**Zielgruppe:** VoltPilot-Betreiber (Plattform-Admin).
**Zweck:** Die Scharfschaltung der Verbrauchersteuerung je Anlage ist eine
dokumentierte, umkehrbare Betreiber-Entscheidung.
Dieses Runbook nennt die Reihenfolge, die Zertifizierung je Gerätetyp, den
kontrollierten Rollback und die Beobachtung.

Konzept + Verträge: [`verbrauchssteuerung.md`](verbrauchssteuerung.md) (§9.4,
§11, §14, §15, §16, §17, §18, §19).

## 1. Die Ehrlichkeitsgrenze dieses Inkrements

Inkrement 5 ist die **Produktivierung**: vollständige Kundenflächen,
Erfüllungsnachweis aus Telemetrie, Diagnose und dieses Runbook.
Es enthält **keinen realen Herstellertreiber** und **kein Site-Entgating** –
die Scharfschaltung bleibt hinter den vier Flags, alle Standard **AUS**.

> Mit allen vier Flags AUS verhält sich eine Anlage zeichengleich wie vor der
> Verbrauchersteuerung.
> Neu sichtbar sind nur die (ehrlich beschrifteten) Anzeigeflächen:
> ohne Verbraucher zeigen sie ihren Leerzustand, ein angelegter Verbraucher
> liest „Steuerung noch nicht aktiviert“.

## 2. Die vier Flags

| Flag | Ebene | Standard | Was es tut, wenn AUS |
|---|---|---:|---|
| `VOLTPILOT_CONSUMER_CONTROL_ENABLED` | api | AUS | Aktivierung antwortet ehrlich „Steuerung noch nicht aktiviert“; ein manueller Eingriff wird **notiert + auditiert, aber nicht ans Gerät gesendet**. |
| `VOLTPILOT_CONSUMER_POLICY_COMPILER_ENABLED` | api | AUS | Zusätzlich: die Policy wird nicht zu einem Edge-Artefakt kompiliert/ausgerollt. |
| `OPTIMIZER_CONTROLLABLE_LOADS_ENABLED` | optimization | AUS | Auch eine `VOLTPILOT_V2_PLAN_SITES`-geflaggte Anlage erhält einen **verbraucherlosen** v2-Schattenplan, bytegleich zum Vor-Inkrement-2-Modell. |
| `VP_CONSUMER_CONTROL_ENABLED` | edge (`edge-app/.env`) | AUS | Der Edge sendet **nie** ein Verbraucher-Kommando (Sofortaktion/Fahrplan). `VP_CONTROL_ENABLED` bleibt der globale Not-Aus darüber. |

**Der Stopppfad ist flag-UNABHÄNGIG (die OTA/Flow-Lehre).**
Deaktivieren und Pausieren einer Policy ziehen das ausgerollte Artefakt zurück,
**auch wenn die Flags aus sind** – ein ausgeschalteter Flag darf nie eine
bereits ausgerollte Regel als gestoppt erscheinen lassen.
Beweis: `ConsumerPolicyActivationBrokerTest` (echtes EMQX: der Flag-aus-Stopppfad
zieht das retained Artefakt wirklich zurück).

## 3. Zertifizierung je Gerätetyp (plattformweit)

**Captain-Produktentscheid 2026-08-10.**

- Die Treiber-**Zertifizierung gilt JE GERÄTETYP PLATTFORMWEIT.**
  Eine einmalige Bench-Session zertifiziert einen Typ (z. B. `go-e` Wallbox);
  danach ist der Typ für **alle** Kunden frei.
  Das ist das bestehende `CERTIFIED_CONTROL_FAMILIES`-Muster – **niemals** eine
  Zertifizierung pro Kunde oder pro Anlage.
- **Je physischem Kundengerät** bleibt nur ein **automatischer Verbindungstest**
  im Einrichtungsassistenten (Testschaltung + Readback, Self-Service, ohne
  Betreiber).
  Er beweist „dieses Gerät antwortet und die Steuerung erreicht es“, **nicht**
  die Modell-Zertifizierung.
- **Wahrheitsquelle der Zertifizierung sind DATEN im entitytypes-Katalog**
  (`services/api/.../entitytypes/catalog.json`, Felder `certified`/`certified_at`/
  `certification_notes` je Typ).
  Eine Bench-Session endet als **PR**, der das Flag setzt – kein DB-Eintrag, kein
  Kunden-Pfad.
  Der bestehende Katalog-Endpunkt liefert die Fakten; die Plattform-Admin-Seite
  „Steuerbare Gerätetypen“ rendert sie read-only.
- **Heutiger ehrlicher Anfangszustand:** nur der generische Simulator, **kein
  realer Typ** ist zertifiziert.

## 4. Scharfschalt-Reihenfolge je Anlage (Einführungsphase)

> **Die per-Anlage-Scharfschaltung ist Einführungsphasen-Disziplin.**
> Dokumentierter **Zielzustand: default-AN nach der Pilotphase.**
> Bis dahin schaltet der Betreiber jede Anlage bewusst frei.

1. **Shadow prüfen.**
   Die Anlage muss in `VOLTPILOT_V2_PLAN_SITES` stehen (v2-Schattenplan an) und
   der Verbraucher muss verbunden sein (Verbindungstest bestanden, §3).
   Der Verbraucher-Fahrplan (`GET /consumer-schedule`) und die Soll/Ist-Diagnose
   (`GET /consumer-deviation`) müssen plausibel aussehen, **bevor** irgendein
   Kommando fließt.
2. **Optimizer-Gate an.**
   `OPTIMIZER_CONTROLLABLE_LOADS_ENABLED=true` + `up -d optimization simulation`.
   Jetzt plant der Optimierer den Verbraucher mit (weiterhin Shadow – der Edge
   führt nichts aus, solange der Edge-Flag aus ist).
   Die Soll/Ist-Diagnose zeigt jetzt echte geplante Slots.
3. **api-Gate an.**
   `VOLTPILOT_CONSUMER_CONTROL_ENABLED=true` +
   `VOLTPILOT_CONSUMER_POLICY_COMPILER_ENABLED=true` + api-Redeploy.
   Aktivierung, Kompilierung und der manuelle Override-Push funktionieren jetzt.
4. **Edge-Gate an – nur auf der Canary-Anlage.**
   `VP_CONSUMER_CONTROL_ENABLED=true` in `edge-app/.env` der Canary-Box, dann
   `./update.sh`.
   Ab hier führt der Edge Verbraucher-Kommandos physisch aus – aber nur für
   **zertifizierte** Gerätetypen (§3), sonst bleibt es beim Verbindungstest.
5. **Erste Regel.**
   Eine einzelne, harmlose Regel scharfschalten (z. B. ein Zeitfenster) und über
   den Erfüllungsnachweis (§6) beobachten, ob Soll und Ist zusammenpassen.

Nach der Pilotphase wird der Zielzustand (default-AN) dokumentiert umgestellt.

## 5. Canary-Prozess je Hardwaretyp

Reale Treiber folgen der Simulator-Scheibe pro Gerät (Verbrauchssteuerung §23,
D10):

1. **Simulator.**
   `cmd/vp-consumer-sim` beweist den ganzen Pfad
   `plan → desired → arbitration → guard → command → readback` hardwarefrei
   (Rig `edge-app/test/e2e-v2-compose.sh`, Szenarien C1–C5).
2. **Bench-Zertifizierung des Typs (einmalig, plattformweit).**
   go-e Wallbox zuerst (Consumer-Control-Executor mit Readback existiert;
   Phasenumschaltung D4), danach Shelly-Heizstab (HTTP-Relais).
   Ein Shelly **mit** Leistungsmessung liefert D3-Bestätigungsstufe 2
   (kW-Telemetrie), **ohne** nur Stufe 3 (Relais-Readback, Energie „angenommen“).
   Die Bench-Checkliste je Typ steht in
   [`../edge-app/nodered/CONTROL-BENCH.md`](../edge-app/nodered/CONTROL-BENCH.md);
   das Ergebnis wird als PR ins entitytypes-Katalog-Flag geschrieben (§3).
3. **Canary-Anlage.**
   Genau eine reale Anlage mit dem frisch zertifizierten Typ scharfschalten
   (§4), 24 h+ beobachten (Erfüllungsnachweis §6, Metriken §7), dann die Fläche
   erweitern.

## 6. Erfüllungsnachweis – aus Telemetrie, nie aus Sollwerten

`consumer_requirement_state` (§9.4) trägt je wiederkehrender Anforderung die
Ist-Erfüllung, **abgeleitet aus BESTÄTIGTER Verbrauchertelemetrie/Readback**:

- **kWh-Messung** bestätigt Laufzeit + Energie → „erfüllt“ (`measured`).
- **kW-Telemetrie** integriert die Energie, Laufzeit exakt → „erfüllt“ (`integrated`).
- **Relais-/Zustands-Readback** bestätigt nur Laufzeit; Energie **„angenommen“**
  (Nennleistung × Zeit, `assumed`).
- **kein Readback** → nie „erfüllt“; Status „Ausführung nicht bestätigt“.

„Frist gefährdet“ (§17) ist ein **abgeleiteter Warnzustand** (die Restzeit reicht
nicht mehr für den offenen Bedarf), kein gespeicherter Zustand.
Lesepfad je Verbraucher: `GET /api/v1/sites/{siteId}/consumers/{id}/fulfillment`.

## 7. Beobachtung (Metriken, §18)

Der api-`/metrics`-Endpunkt trägt seit Inkrement 5 die Verbraucher-Messwerte
(Prometheus, getaktet gesammelt, nie je Scrape):

| Metrik | Bedeutung |
|---|---|
| `voltpilot_consumers` | steuerbare Verbraucher gesamt (Nenner) |
| `voltpilot_consumers_active` | mit aktiver Policy (freigeschaltet) |
| `voltpilot_consumers_connected` | verbunden |
| `voltpilot_consumers_disturbed` | gestört (offline/geklemmt/verpasst/Readback-Abweichung) |
| `voltpilot_consumer_tasks{state}` | Anforderungs-Instanzen je Zustand (`missed` alarmierbar) |
| `voltpilot_consumer_tasks_at_risk` | Fristen in Gefahr |
| `voltpilot_consumer_clamped{reason}` | durch Guard geklemmt je Grund |
| `voltpilot_consumer_overrides_active` | aktive manuelle Eingriffe |
| `voltpilot_consumer_metrics_collect_age_seconds` | Wächter über dem Wächter |

Gauge-Namen enden **nie auf `_total`** (Prometheus-Client-Falle); der Sammler
ist im Testlauf aus (`@Scheduled`-Falle, `pom.xml`).
Die Soll/Ist-**Abweichung in kW** je Verbraucher liegt auf dem Diagnose-Lesepfad
`GET /consumer-deviation` (Plattform-Schicht), nicht als flottenweite Serie.

## 8. Kontrollierter Rollback

Zwei Hebel, beide erprobt:

1. **Flag aus + Redeploy.**
   `VP_CONSUMER_CONTROL_ENABLED=false` (Edge) bzw. `VOLTPILOT_CONSUMER_CONTROL_
   ENABLED=false` (api) + Redeploy → **neue** Kommandos/Aktivierungen unterbleiben.
   Ein Flag-aus macht eine bereits ausgerollte Regel **nicht** automatisch
   gestoppt.
2. **Echter Stopppfad (flag-unabhängig).**
   `POST /consumers/{id}/pause` oder `.../policy/deactivate` → die aktive Policy
   wird stillgelegt **und das retained Artefakt zurückgezogen**.
   Der laufende manuelle Eingriff endet über `DELETE /consumers/{id}/override`
   („Automatik fortsetzen“) oder verfällt nach seiner TTL (nie unbegrenzt, §16).
   Beweis: `ConsumerPolicyActivationBrokerTest` (Inkrement 4).

## 9. Benannte Anschlussarbeit

- **Benachrichtigung „Frist gefährdet“ (`vp.notify.push`).**
  Der abgeleitete Warnzustand aus §6/§17 ist der natürliche Auslöser einer
  Push-Benachrichtigung.
  In Inkrement 5 ist er als Lesepfad + Metrik (`voltpilot_consumer_tasks_at_risk`)
  vorhanden; die aktive `vp.notify.push`-Verdrahtung ist Anschlussarbeit.
- **Replan-Latenz-Histogramm (§18).**
  Der D8-Replan-Trigger feuert best-effort; eine gemessene Latenz-Metrik ist
  Anschlussarbeit.
- **Kundenseitiger Verbraucher-Erlösausweis** bleibt „geplant“ gelabelt
  (`consumer_plan_economics` intern).
