# Mandanten-Sockel: eine Verbindung je Anfrage (15.11.2026)

Umsetzung von Kundenpfade B1 / Welle 2 H4 / Lasttest Rang 13: Je Kundenanfrage werden die Sitzungs-Variablen der
Zeilen-Sicherheit (`app.tenant_id`, `app.zugriff`, `app.standort_ids`) nicht mehr je Repository-Aufruf gesetzt und
zurückgesetzt, sondern einmal je Anfrage (`AnfrageVerbindung`, `TenantAwareDataSource`). Diese Seite hält die Messung
im Labor fest. **Laborwerte, keine Produktions-Perzentile.**

## Labor

| Teil | Stand |
|---|---|
| Datenbank | `timescale/timescaledb:2.17.2-pg16`, `pg_stat_statements` (`track=all`, `track_planning`), alle Migrationen der api, Dev-Seed |
| api | Jar je Stand aus `git archive` (vorher `adf5492e5`, nachher mit dieser Änderung), Container im Docker-Netz, Profil `local`, Anfrage-Pool 10 (Vorgabe), Modus „ruhig“ (Überwachung und Steuerungs-Vorsprung aus, damit `pg_stat_statements` je Route zählbar ist) |
| Bestand | 400 Lasttest-Anlagen (100 Kunden je 4 Anlagen), 30 Tage Verlauf für `lt-kunde-0001`, UEMS-Struktur mit Hauptzählern, Monatsperioden, Stammdaten (Werkzeug der Wellen 2/3) |
| Last | Mac fremdbelastet (Load 4–40, je Reihe notiert). Belastbar sind Anweisungen je Aufruf; Antwortzeiten und Durchsatz nur gepaart (A/B/A) |

## Anweisungen je Aufruf (`lt-kunde-0001`, nur was in jedem von 8 Läufen vorkommt)

| Route | Anweisungen vorher → nachher | davon Sockel-`set_config` |
|---|---:|---:|
| `/me` | 21 → 15 | 10 → 3 |
| `/overview` | 105 → 40 | 68 → 3 |
| `/portfolio/kpis` | 113 → 48 | 68 → 3 |
| `/devices` | 31 → 16 | 18 → 3 |
| `/meldungen/zahl` | 19 → 10 | 12 → 3 |
| `/sites/{id}/topology` | 28 → 14 | 18 → 3 |
| `/sites/{id}/control-status` | 19 → 10 | 12 → 3 |
| `/sites/{id}/telemetry` (24 h) | 19 → 10 | 12 → 3 |
| `/sites/{id}/history?range=day` | 69 → 26 | 46 → 3 |
| `/sites/{id}/history?range=month` | 62 → 23 | 42 → 3 |
| `/earnings?range=day` | 66 → 23 | 46 → 3 |
| `/sites/{id}/earnings?range=day` | 62 → 21 | 44 → 3 |
| `/sites/{id}/sources` | 19 → 10 | 12 → 3 |
| `/sites/{id}/entities` | 31 → 14 | 20 → 3 |
| `/sites/{id}/erzeuger/jetzt` | 18 → 11 | 10 → 3 |
| `/sites/{id}/curtailment-status` | 19 → 10 | 12 → 3 |
| `/sites/{id}/chargers` | 25 → 12 | 16 → 3 |
| `/sites/{id}/schedule` | 19 → 10 | 12 → 3 |
| `/sites/{id}/rollen/pv` | 19 → 10 | 12 → 3 |
| **Summe** | **764 → 333 (−56 %)** | |

Die drei Sockel-Anweisungen je Anfrage: gesetzt beim Laden des Zugriffs (`ZugriffFilter`, noch ohne Zugriff), neu
gesetzt mit dem Zugriff, einmal zurückgesetzt. Die übrigen Abfragen sind dieselben (die transaktionslokale Aufhebung
des Standort-Zauns der Teilansicht, `Geltungsbereich.ganzenKundenbereichLesen`, zählt dort mit). Die JSON-Antworten
aller 19 Routen sind gleich; `telemetry-24h` verschiebt nur sein 24-h-Fenster mit der Wanduhr.

## Gleichzeitigkeit (Anfrage-Pool 10, alle 19 Routen in Zufallsfolge, 60 s)

| Reihe | Anfragen/s | p50 / p95 ms | Anweisungen der App-Rolle je Anfrage | Sockel-`set_config` je Anfrage |
|---|---:|---:|---:|---:|
| 12 Nutzer vorher (1. / 2. Lauf) | 362,6 / 324,5 | 21 / 91 · 23 / 105 | 36,6 / 35,9 | 23,3 / 23,2 |
| 12 Nutzer nachher | 378,8 | 20 / 90 | 15,7 | 3,0 |
| 40 Nutzer vorher (1. / 2. Lauf) | 276,0 / 368,4 | 101 / 392 · 77 / 270 | 35,9 / 35,8 | 23,2 / 23,1 |
| 40 Nutzer nachher (1. / 2. Lauf) | 439,0 / 428,2 | 75 / 204 · 79 / 198 | 15,6 | 3,0 |

Anweisungen je Anfrage über das ganze Fenster, Hintergrundjobs derselben Rolle eingeschlossen. DB-CPU bei 40 Nutzern
(Stichproben `docker stats` alle 10 s): vorher 452 % bei 368 Anfragen/s, nachher 388 % bei 428 Anfragen/s – je Anfrage
rund ein Viertel weniger. Eine Anfrage hält ihre Verbindung jetzt vom ersten Zugriff bis zum Ende; selbst mit 40
Nutzern auf 10 Verbindungen kostet das keinen Durchsatz, weil jede Anfrage rund 20 Rundreisen weniger braucht.
Wartestellen außerhalb der Datenbank (Box-Antworten, Keycloak, fremde HTTP-Dienste) geben die Verbindung vorher frei.

## Wiederholen

Werkzeug und Rohdaten liegen außerhalb des Repos (`firstmate/data/vp-perf-mandanten-sockel/labor`): Compose-Projekt
`vpms` (Ports 19xxx), `api-start.sh <jar> ruhig`, `bestand-sockel.sh`, `reihe-sockel.sh <label>` (sqlspur, einzeln,
12 Nutzer, Antworten), `gleich-cpu.sh <label> <n> 60`, `vergleich.py vorher nachher`.
