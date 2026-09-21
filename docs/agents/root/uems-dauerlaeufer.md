# UEMS-Dauerläufer: interner Kundenbereich mit zwei simulierten Boxen (AP-14 IP-18, Kasten E11)

Neu angelegt am 21.09.2026. Keine Migration, keine Route, keine Fläche. Einrichtung in Betreibersprache:
`docs/rollout/uems-erste-freigabe.md` §14.

| Was | Wo |
|---|---|
| Schalter | `voltpilot.uems.dauerlaeufer.tenant` / `VOLTPILOT_UEMS_DAUERLAEUFER_TENANT` (`application.yml`), gelesen von `metrics/Dauerlaeufer.kennung` |
| Ausschluss | `FleetMetricsCollector.collect` überspringt die Anlagen des Dauerläufers: `voltpilot_sites`, alle `voltpilot_site_*`, Gebotszonen |
| Bleibt sichtbar | `voltpilot_uems_kundenbereich_*{tenant}` (`UemsMetricsCollector`): Ziel der gitops-Regel `VoltPilotDauerlaeuferStumm` |
| Simulator | `tools/edge-simulator/uems_dauerlaeufer.py`, `Dockerfile.dauerlaeufer`, `.env.dauerlaeufer.example` |
| Tests | `DauerlaeuferMetrikenDbTest` (Testcontainers) · `test_uems_dauerlaeufer.py` |
| Box-Seite (Weg a+) | `uems_dauerlaeufer.py`: `probe_antwort` (Baukasten-Lesung), `auswahl_lernen` (Zustellung → Quittung), `umschlag` (nur gelernte Schlüssel); Zähler-Tabelle `GATEWAY`/`register` = Drehbuch §14.2 |
| NW-6 im Kleinen | api `DauerlaeuferGanzerWegDbTest` (ganze Einrichtung über Routen, Box-Antworten aus der Vorlage über `ProbeResultListener`/`MeasurementConfigStatusListener`, Zustellung über `ZustellungOhneBroker`) · Writer `DauerlaeuferWriterNahtTest` (quittierte Auswahl, jeder Wert zugeordnet) · ingest `DauerlaeuferVorlageAnnahmeTest`; alle lesen `abnahme/dauerlaeufer-nw6.json` (`make abnahme`), MQTT läuft in keinem. Tor G1 `nw6_im_kleinen` |

## Die Fallen

- **Die Kennung wird nicht vorgegeben.** Die Plattform vergibt die Tenant-UUID beim Anlegen. Kein Sämann, keine Migration:
  Der Betreiber legt an und überträgt die UUID an zwei Stellen (gitops-Platzhalter, api-Schalter).
- **Ein falscher Schalterwert stoppt den Start.** Das ist gewollt, siehe `Dauerlaeufer.kennung`. Das Etikett ist immer
  `UUID.toString()`, also klein geschrieben; gitops PR 37 vergleicht es wörtlich.
- **Feste Schlüssel gehen nicht, der Simulator lernt sie.** Die Katalog-Route lehnt die Szenario-Schlüssel ab (400),
  „Eigenen Messwert hinzufügen“ vergibt `custom.<hex>`. Darum abonniert der Simulator `v2/measurement-config` (gehalten),
  quittiert auf `…-status` und sendet nur Gelerntes; ohne Zustellung sendet er nichts. Kein Schlüssel im Geheimnis.
- **Messkunden-Alter entsteht nur mit Zuordnung.** Der Lücken-Melder zählt nur Werte mit `entity_id` (`LueckenMelder.SPUR`).
  Dafür braucht es eine Komponente MIT Anschluss (Baukasten, Lesung = Verbindungsbeleg; `POST …/measurement-points` hat keinen
  und bekommt keinen Vorschlag), „Vorschlag übernehmen“ (Datenquelle UND Zuständigkeit, sonst Spiegel; das Portal hat dafür
  keinen Knopf) und die Quittung (sonst bleibt der erste Wert je Schlüssel ohne Fassung).
- **Vor dem ersten Wert** gibt es kein Alter, aber `messwert_zustand{zustand="nie"} 1`; daran hängt die nie-Regel in gitops.
- **Arbeitslisten und Speicher zählen ihn mit.** Beide messen die Verarbeitung, sie zählen keine Kunden. Der Dauerläufer soll
  dort gerade auffallen, wenn die Strecke steht.
- **Neustart ohne Reset.** Sequenz, Messzeit und Zählerstand sind Funktionen der Minute seit 1970. Ein Zustand auf der
  Platte würde das nur brechen.
- **Kein Image-Push, kein CI-Job.** Der gitops-Teil baut die Arbeit (siehe PR-Text von IP-18).
