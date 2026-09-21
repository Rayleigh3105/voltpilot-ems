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

## Die Fallen

- **Die Kennung wird nicht vorgegeben.** Die Plattform vergibt die Tenant-UUID beim Anlegen. Kein Sämann, keine Migration:
  Der Betreiber legt an und überträgt die UUID an zwei Stellen (gitops-Platzhalter, api-Schalter).
- **Ein falscher Schalterwert stoppt den Start.** Das ist gewollt, siehe `Dauerlaeufer.kennung`. Das Etikett ist immer
  `UUID.toString()`, also klein geschrieben; gitops PR 37 vergleicht es wörtlich.
- **Messkunden-Alter entsteht nur mit Zuordnung.** Der Lücken-Melder zählt nur Werte mit `entity_id` (`LueckenMelder.SPUR`).
  Der Dauerläufer braucht deshalb Funktion „Messen“ und eine Mess-Auswahl mit den Punktschlüsseln des Simulators.
- **Arbeitslisten und Speicher zählen ihn mit.** Beide messen die Verarbeitung, sie zählen keine Kunden. Der Dauerläufer soll
  dort gerade auffallen, wenn die Strecke steht.
- **Neustart ohne Reset.** Sequenz, Messzeit und Zählerstand sind Funktionen der Minute seit 1970. Ein Zustand auf der
  Platte würde das nur brechen.
- **Kein Image-Push, kein CI-Job.** Der gitops-Teil baut die Arbeit (siehe PR-Text von IP-18).
