# Gemeinsame Steuerung: Box-Metriken (AP-15 IP-11, Übergabe an Teil B)

Teil A (dieses Repo, `services/api`) liefert die Metriken; Teil B baut im gitops-Repo die acht
Regeln mit promtool-Tests. Merge und Sync dort sind die Hand des Betreibers. Ziel (M2): der
Betreiber sieht je Box, was sie fährt und was sie hält; der Ausfall EINER Box ist nicht lautlos.

## Woher, für wen, an welchem Schalter

- Sammler `metrics/GemeinsameSteuerungMetrikSammler`, Takt und Schalter der UEMS-Metriken
  (`VOLTPILOT_METRICS_UEMS_ENABLED`, `…_INTERVAL_MS` 60 s). Ein Scrape führt kein SQL aus; jedes
  `…_age_seconds` wächst zwischen zwei Sammel-Läufen weiter — ein stehender Sammler macht die Alter
  also groß, nicht still.
- Reihen gibt es nur für **aktive Boxen mit Bezug**: eine Zeile in `plan_zustellung` (Plan 2.0
  veröffentlicht oder quittiert), ein Herzschlag-Block `gemeinsame_steuerung` seit dem Start
  der api, oder eine JETZT gültige Mitgliedschaft in `steuerungsverbund_mitglied` (IP-4: nicht
  aufgehoben, `[gueltig_ab, gueltig_bis)`). Eine Bestandsbox ohne all das hat keine Reihe; ohne solche Box und bei abgeschaltetem
  Schalter ist der Export byte-gleich wie vorher (`GemeinsameSteuerungMetrikScrapeTest`).
- Labels: `tenant`, `site`, `device` = interne UUIDs, nie ein Name. Die Prometheus-Anbindung setzt
  wie bei allen api-Metriken `namespace` dazu.
- **Dauerläufer:** der Schalter `VOLTPILOT_UEMS_DAUERLAEUFER_TENANT` wirkt nur auf die
  Flottenkennzahlen (`FleetMetricsCollector`); diese Box-Metriken lesen ihn nicht und nehmen den
  Kundenbereich NICHT aus. ⚠ Der Dauerläufer steuert heute nicht (AP-15 §6.8, Zeile AP-14): seine
  simulierten Boxen bekommen keinen Plan 2.0 und senden keinen Block — sie erscheinen erst, wenn dort
  eine Box einen Plan 2.0 erhält oder Mitglied einer Gemeinsamen Steuerung wird (Einrichten über
  die Routen von IP-5). Die Alarm-Übung von NW-9 braucht diesen Schritt.

## Die Metriken

| Metrik | Labels | Einheit | Bedeutung | leer bis |
|---|---|---|---|---|
| `voltpilot_uems_box_herzschlag_age_seconds` | `tenant`, `site`, `device` | s | Alter des jüngsten gültigen Status-Herzschlags (Cloud-Ankunft, `device.device_status_seen_at`). Fehlt bei `zustand="nie"`. | gefüllt |
| `voltpilot_uems_box_herzschlag_zustand` | + `zustand` = `bekannt` \| `nie` | 1/0 | 1 für den aktiven Zustand. `nie`: seit AP-06 IP-15 kein Herzschlag — eine Box ohne Alter, die trotzdem sichtbar ist. | gefüllt |
| `voltpilot_uems_box_plan_veroeffentlicht_age_seconds` | `tenant`, `site`, `device` | s | Alter ab ERZEUGUNG (`generated_at`, Uhr des Optimierers) des jüngsten veröffentlichten Plans 2.0; Ordnung wie `PlanZustellungRepository#stand`. Fehlt, wenn nie. | gefüllt (Optimierer seit IP-10) |
| `voltpilot_uems_box_plan_angenommen_age_seconds` | `tenant`, `site`, `device` | s | Alter ab Erzeugung des jüngsten ANGENOMMENEN Plans 2.0. R11 „erzeugt 10:15 · angenommen 10:00“ = 900 s Abstand zur Reihe darüber. Fehlt, wenn nie. | Edge-Release mit IP-10 (Box quittiert) |
| `voltpilot_uems_box_plan_quittung_gemeldet` | `tenant`, `site`, `device` | 1/0 | 1, wenn die Box `plan_quittung` in `supports[]` meldet. 0 = alte Box: „angenommen“ bleibt leer, daraus darf kein Alarm werden. | gefüllt |
| `voltpilot_uems_box_waechter_stufe` | + `richtung` = `einspeisung` \| `bezug`, `stufe` = `aus` \| `ueberwacht` \| `regelt` \| `haelt` \| `zieht_zusammen` \| `sicherheitskappe` | 1/0 | 1 für die aktive Stufe je GESENDETER Richtung, aus dem Herzschlag-Block; eine nicht gesendete Richtung hat keine Reihe. Im Prozess gehalten: nach einem api-Neustart leer bis zum nächsten Herzschlag; eine stumme Box behält ihren letzten Wert (Alter: erste Zeile). | `einspeisung`: Edge-Release mit IP-10; `bezug`: IP-18/IP-19 |
| `voltpilot_uems_box_anteile_revision_gesendet` | + `epoche` | Revision | Revision des zuletzt an die Box gesendeten Anteils-Dokuments (`steuerungsverbund_mitglied.gesendet_*`). Fehlt, wenn nie gesendet. | **IP-7** (Veröffentlicher der Anteile schreibt die Spalten) |
| `voltpilot_uems_box_anteile_revision_quittiert` | + `epoche` | Revision | Revision, die die Box quittiert hat (`quittiert_*`). Fehlt, wenn nie. | **IP-7** (Empfang der Quittung) + IP-17 (Box quittiert) |
| `voltpilot_uems_box_anteile_unbestaetigt_age_seconds` | `tenant`, `site`, `device` | s | Alter des gesendeten Anteils-Dokuments, solange (Epoche, Revision) der Quittung darunter liegt oder es keine gibt; fehlt, wenn bestätigt oder nie gesendet. Vergleicht Epoche vor Revision — die Regel muss es nicht. | **IP-7** |
| `voltpilot_uems_box_rolle` | + `rolle` = `fuehrt` \| `steuert_mit`, `stufe` = `erklaert` \| `beobachtet` \| `geprueft` \| `anteile_aktiv` \| `angehalten` | 1/0 | 1 für die Rolle der jetzt gültigen Mitgliedschaft, `stufe` = Stufe der Gemeinsamen Steuerung. Aus der erklärten Mitgliedschaft (IP-4), NICHT aus dem Herzschlag — eine stumme führende Box sendet keinen. `liest` ist kein Mitglied (T6) und hat keine Reihe. | gefüllt, sobald jemand einrichtet (Routen: **IP-5**) |

Die Spalten `gesendet_*`/`quittiert_*` legt IP-4 an; bis IP-7 sie beschreibt, bleiben die drei
Anteils-Reihen leer.

## Die acht Regeln: woraus, und was heute fehlt

Schwellen aus der Ausfallmatrix (AP-15 §5.1). Empfehlung für alle Box-Regeln: auf Mitglieder
einer scharfen Gemeinsamen Steuerung begrenzen (`and on (device) voltpilot_uems_box_rolle{stufe="anteile_aktiv"} == 1`),
sonst meldeten sie auch Boxen mit Plan 2.0 ohne Gemeinsame Steuerung — gegen „Bestandsanlagen merken
nichts, bis jemand einrichtet“. Bis jemand einrichtet (IP-5), schweigen die Regeln damit;
promtool-Tests setzen die Reihe als Eingang.

| Regel | Matrix | Gebaut aus | Fehlt heute |
|---|---|---|---|
| `GemeinsameSteuerungBoxStumm` (je Box, 5 min) | A1, A4, A5 | `voltpilot_uems_box_herzschlag_age_seconds > 300`, dazu `voltpilot_uems_box_herzschlag_zustand{zustand="nie"} == 1` mit `for: 5m` | nichts (Mitglieder kommen mit dem Einrichten, IP-5) |
| `GemeinsameSteuerungOhneFuehrendeBox` (kritisch, 5 min) | A2 | `voltpilot_uems_box_herzschlag_age_seconds > 300 and on (device) voltpilot_uems_box_rolle{rolle="fuehrt"} == 1` | nichts; wirksam, sobald eine Anlage eingerichtet ist (IP-5) |
| `GemeinsameSteuerungAufAnteil` (Wächter > 10 min auf dem Anteil) | A7 | `voltpilot_uems_box_waechter_stufe{stufe="sicherheitskappe"} == 1` mit `for: 10m`, `and on (device) voltpilot_uems_box_herzschlag_age_seconds < 120` (eine stumme Box meldet `BoxStumm`, nicht ihren letzten Wächter-Wert) | Bedeutung „= eigener Anteil“ erst mit IP-18 (davor ist es die heutige Sicherheitskappe der Einzelbox); Richtung `bezug` erst IP-18/IP-19; Mitglieder-Begrenzung |
| `GemeinsameSteuerungBilanzUnplausibel` | A17 | `voltpilot_uems_verbund_bilanz_zustand{zustand="unplausibel"} == 1` (je Anlage, ohne `for`: der Wert ändert sich höchstens einmal am Tag) | nichts: gefüllt seit IP-12, sobald für eine Anlage mit Mitgliedern ein Tag gerechnet ist (siehe unten) |
| `GemeinsameSteuerungUhrUnsicher` | A8 | — | eine Quelle je Box. `clock_jump` gehört der Datenannahme und ist ein Ereignis, keine Metrik mit `device`. Vorschlag: der Versatz Herzschlag-`ts` gegen Cloud-Ankunft als `voltpilot_uems_box_uhr_versatz_seconds` in diesem Sammler (der Status ist nicht retained, der Versatz also echt) — in IP-11 nicht gebaut, weil die Zelle ihn nicht nennt |
| `GemeinsameSteuerungVorbehaltZuKlein` | A20 | `max by (namespace, tenant, site) (increase(voltpilot_uems_vorbehalt_erhoeht_total[1h])) > 0` | nichts: gefüllt seit IP-13 (siehe unten) |
| `PlanNichtAngenommen{device}` (30 min) | A3, A9 | `voltpilot_uems_box_plan_angenommen_age_seconds > 1800 and on (device) voltpilot_uems_box_plan_quittung_gemeldet == 1`; der Nie-Fall: `(voltpilot_uems_box_plan_quittung_gemeldet == 1) unless on (device) voltpilot_uems_box_plan_angenommen_age_seconds` mit `for: 30m` | baubar; wirksam, sobald Boxen mit dem IP-10-Edge-Release quittieren. Ob ohne Mitglieder-Begrenzung, entscheidet Teil B (die Regel ist reine Betreibersicht) |
| `AnteileNichtBestaetigt` (30 min) | A10 | `voltpilot_uems_box_anteile_unbestaetigt_age_seconds > 1800` | die Werte: IP-7 schreibt `gesendet_*`/`quittiert_*`, IP-17 lässt die Box quittieren |

## Verbund-Bilanz je Anlage (AP-15 IP-12)

| Metrik | Labels | Einheit | Bedeutung | leer bis |
|---|---|---|---|---|
| `voltpilot_uems_verbund_bilanz_zustand` | `tenant`, `site`, `zustand` = `plausibel` \| `unplausibel` \| `unbekannt` | 1/0 | 1 für den Zustand des jüngsten gerechneten Tages (`steuerungsverbund_bilanz`, täglicher Läufer `verbund_bilanz` 04:37 Europe/Berlin, rechnet den Vortag). `unbekannt` ist kein `plausibel` (B5): eine Lücke, ein Messpunkt ohne Messstelle oder genau eine abweichende Viertelstunde. | gefüllt, sobald für eine Anlage mit JETZT wirksamen Mitgliedern ein Tag gerechnet ist |

- Sammler `metrics/VerbundBilanzMetrik` am selben Schalter und Takt wie oben; gelesen über die
  Admin-Rolle (`repo/VerbundBilanzMetrikRepository`). Eine Anlage ohne Gemeinsame Steuerung, eine
  aufgelöste (keine wirksamen Mitglieder) und eine ohne gerechneten Tag hat keine Reihe.
- Was `unplausibel` auslöst: in mindestens zwei Viertelstunden speist der Netzpunkt mehr ein, als
  die Boxen zusammen erklären (Toleranz max(2 kW, 5 %)) — ein nie eingetragener Erzeuger oder ein
  verdrehtes Vorzeichen (A17). Die api führt eine Anlage über S1 dann selbst auf S1 zurück
  (Protokoll-Akteur „Verbund-Bilanz“, die Anteile bleiben in Kraft); die Regel meldet es.
- Ein stehender Läufer lässt die Reihe auf dem letzten Tag stehen — das deckt die Läufer-Regel über
  `voltpilot_uems_laeufer_*{laeufer="verbund_bilanz"}` (Takt täglich), nicht diese Metrik.

## Vorbehalt aus Messwerten je Anlage (AP-15 IP-13)

| Metrik | Labels | Einheit | Bedeutung | leer bis |
|---|---|---|---|---|
| `voltpilot_uems_vorbehalt_erhoeht_total` | `tenant`, `site` | Zähler | Selbsttätige ERHÖHUNGEN des Vorbehalts der Bezugsseite (Läufer `vorbehalt`, täglich 04:52 Europe/Berlin): die Messung (höchster belegter Viertelstundenwert des Ungeregelten × 1,1) verlangte mehr als den geltenden Vorbehalt — das Ungeregelte ist gewachsen (A20, R23), die Anteile der übrigen Boxen wurden verengt. | gefüllt (0), sobald eine Anlage JETZT wirksame Mitglieder hat |

- Sammler `metrics/VorbehaltMetrik` am selben Schalter und Takt wie oben; gelesen über die Admin-Rolle
  (`repo/VorbehaltMetrikRepository`) als Zahl der Zeilen `erhoeht` in `steuerungsverbund_vorbehalt` — der Stand
  übersteht einen api-Neustart, ist in jeder Instanz gleich und fällt nie. Jede Anlage mit Mitgliedern hat eine Reihe ab
  0, damit `increase()` schon die erste Erhöhung sieht; ohne Gemeinsame Steuerung keine Reihe.
- Was die Regel dem Betreiber sagt: die Verengung ist geschehen (Zweischritt angestoßen). Ob sie ausgerollt ist, steht
  im GET unter `vorbehalt.bezug.zweischritt`: `auslegung_passt_nicht` = mit dem höheren Vorbehalt passt die Auslegung
  nicht mehr, NICHTS wurde erweitert, die Boxen halten ihr letztes Dokument — Handeln nötig (E2 = A: Termin am Gerät,
  G7: große Verbraucher an die führende Box). Ein SENKEN zählt nicht; es bleibt ein Vorschlag bis zur Freigabe
  (`POST /api/v1/admin/sites/{siteId}/gemeinsame-steuerung/vorbehalt/freigeben`).
- Ein stehender Läufer zeigt sich über `voltpilot_uems_laeufer_*{laeufer="vorbehalt"}` (Takt täglich), nicht hier.

## Frist für `plan_zustellung`

Täglich 03:47 Europe/Berlin (`PlanZustellungAufbewahrungLaeufer`, Läufer `plan_zustellung` im
UEMS-Läufer-Katalog; mit IP-11 kam dort auch `ladepark_grenze` aus AP-15 IP-3 dazu): gelöscht wird jede Zeile, deren jüngster Zeitpunkt (Erzeugung,
Veröffentlichung, Ankunft der Quittung) älter als 35 Tage ist — außer je Box der jüngsten
veröffentlichten und der jüngsten angenommenen Zeile. Die Metriken oben sehen nach dem Lauf
dasselbe. Schalter `VOLTPILOT_UEMS_PLAN_ZUSTELLUNG_ENABLED`, Frist
`VOLTPILOT_UEMS_PLAN_ZUSTELLUNG_AUFBEWAHRUNG_TAGE`. Teil B kann `laeufer="plan_zustellung"` (täglich)
und `laeufer="ladepark_grenze"` (stündlich) in die Läufer-Regel aufnehmen.
