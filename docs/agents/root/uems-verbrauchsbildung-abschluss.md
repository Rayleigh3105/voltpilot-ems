# UEMS-Verbrauchsbildung: Abschluss und Bestandsschutz (AP-08 IP-20)

AP-08 bildet aus Messstellen-Reihen Viertelstunden-, Tages-, Monats- und Jahresmengen samt Zustand,
Ersatzwerten, Korrekturen und Versionen. Die Detailregeln bleiben in den bestehenden Wegweisern; diese
Seite verbindet sie und hält die Grenze zum bisherigen Messwertkern fest.

## Einstieg je Schicht

| Schicht | Wegweiser | Pakete |
|---|---|---|
| Vertrag, Zustand und Zahlen | `uems-verbrauchsvertrag-python-java-zwill.md`, `uems-ergebnis-zustand.md` | IP-1, IP-8 |
| Bildung und Speicherung | `uems-viertelstundenmenge.md`, `uems-periodenmengen.md`, `uems-intervall-momentanwert.md` | IP-2 bis IP-7 |
| Lesen und Portal | `uems-werte-je-messstelle.md`, `uems-verlauf-messstelle.md`, `uems-tageskarte.md`, `uems-versionen-lesen.md` | IP-9 bis IP-11, IP-18 |
| Ersatzwerte und Korrekturen | `uems-korrektur-ersatzwert.md`, `uems-ersatzwert-methoden.md`, `uems-korrektur-vorschlaege.md`, `uems-korrektur-kaskade.md` | IP-12 bis IP-17, IP-19 |

## Grenze zum Bestand

- AP-08 schreibt ausschließlich die Messstellen-Reihen und ihre Belege. Die drei bestehenden
  Rollup-Prozeduren für Telemetrie v1, Telemetrie v2 und Geräte-Messwerte sind seit dem Stand vor
  AP-08 unverändert.
- `UemsVerbrauchBestandsschutzTest` pinnt die Definitionen dieser Prozeduren und die vollständige
  JSON-Antwort einer plausiblen Historienabfrage. Der Rückbau-Schalter
  `VOLTPILOT_UEMS_HISTORIE_UNGEKLEMMTE_QUOTEN_ENABLED` aus AP-10 IP-18 wird dabei an und aus geprüft:
  plausible Werte bleiben bytegleich; die bewusst ungeklemmte Antwort für unplausible Werte ist kein
  AP-08-Rückschritt.
- Cockpit und Erlöse werden nicht nachgebaut. Die vorhandenen Bestandsmuster
  `PortalApiTest#overviewAggregatesFleetTenantScopedWithBerlinDaySavings` und
  `PortalApiTest#earningsComputesRealizedSavingsPerSiteWithHonestDegradation` rechnen ihre festen
  Beispiele weiterhin aus den Kern-Rollups.

## Prüfen

```bash
(cd services/api && ./mvnw clean test -Dtest=UemsVerbrauchBestandsschutzTest)
(cd services/api && ./mvnw clean test -Dtest=PortalApiTest#overviewAggregatesFleetTenantScopedWithBerlinDaySavings+earningsComputesRealizedSavingsPerSiteWithHonestDegradation)
(cd frontend/portal && npx vitest run src/copy.test.ts)
bash tools/agents-md-budget.sh
```
