# Dokumentation

Starten Sie mit der Frage, die Sie beantworten möchten. Jede Erklärung hat einen festen Ort; lokale READMEs nennen die passenden Befehle und verweisen auf Details.

| Bereich | Dokumente |
|---|---|
| Überblick | [Architektur](architecture.md), [Portal und Bedienmodell](portal.md) |
| Entwicklung | [Lokal starten und testen](development.md), [API und Datenbank](api.md) |
| Cloud-Betrieb | [Deployment](deploy.md), [Kubernetes-Betriebsvertrag](k8s-readiness.md), [Rollout-Drehbuch der ersten UEMS-Freigabe](rollout/uems-erste-freigabe.md), [Prüfstand- und Pilot-Drehbuch der Gemeinsamen Steuerung](rollout/gemeinsame-steuerung-pilot.md) |
| Geräte verbinden | [Enrollment](connect-a-device.md), [MQTT-Sicherheit](security-mqtt.md) |
| Box betreiben | [Edge-App](../edge-app/README.md), [Installation](../edge-app/DEPLOY.md), [Laufzeitregeln](edge-runtime.md) |
| Updates | [Edge-Updates bedienen](ota-autonomie.md), [Signaturkette und Schlüssel](ota-signing.md) |
| Energie planen | [Optimierung](../services/optimization/README.md), [Prognose und Modellwahl](forecasting.md) |
| Verbraucher | [Funktionsmodell](verbrauchssteuerung.md), [Betrieb und Fehlerdiagnose](verbrauchssteuerung-betrieb.md) |
| Schnittstellen | [Vertragsübersicht](contracts/README.md), [v2-Verträge](contracts/v2/README.md), [v1/v2-Umstellung](migration-v1-to-v2.md) |
| Gerätewissen | [Messpunktkatalog](../catalog/measurement-points/README.md), [Wechselrichter-Konfiguration](../edge-app/INVERTER-CONFIG.md), [Steuerungsprüfstand](../edge-app/nodered/CONTROL-BENCH.md) |
| Gebäudeautomation | [Modbus-Datenspiegel](../edge-app/MODBUS-SPIEGEL.md), [Loxone-Zuordnung](loxone-voltpilot-map.md) |

## Dokumentation pflegen

- Deutsch schreiben; technische Kennungen, API-Felder und Befehle unverändert lassen.
- Mit Zweck und Ergebnis beginnen. Einen Ablauf als Diagramm oder kurze Schrittfolge erklären.
- Bei Änderungen Code, Tests, Konfiguration und Doku zusammen prüfen. Ein Datum allein belegt keine Aktualität.
- Nur tatsächlich verfügbare Funktionen als verfügbar beschreiben. Entwürfe ausdrücklich kennzeichnen.
- Erledigte Pläne und doppelte Erklärungen entfernen, relevante Regeln vorher übernehmen.
- Fachdetails in Themendokumenten pflegen; `AGENTS.md` enthält Arbeitsregeln und Verweise.
- Nach Umzügen Links und Anker reparieren. Herstellerquellen, Lizenzen und Schema-Fixtures sind keine redaktionellen Altlasten.

Die [Portal-Hilfe](../frontend/portal/src/help/README.md) erklärt Kundenaufgaben mit echten, reproduzierbaren Screenshots. Technische Betriebsdetails bleiben hier.

## Gesonderte Unterlagen

[Arbitrage-Partnermodell](../VoltPilot_Arbitrage-Partnermodell.pdf): Gesprächsunterlage vom 01.09.2026 zu einem möglichen Vertriebsmodell. Als Original erhalten; daraus folgt keine implementierte Vergütungs- oder Abrechnungsfunktion. [Drei-Töpfe-Zuordnung](attribution-three-pot.md) bleibt ausdrücklich ein fachlicher Entwurf.

## Ergänzungen auf dem aktuellen Hauptzweig

[Fachmodell und UEMS-Begriffe](fachmodell/README.md), [Backup und Wiederherstellung](backup-restore.md), [OCPP-Steuerung](ocpp-control.md) und [ergänzende Arbeitsregeln](agents/README.md) werden eigenständig gepflegt. Die folgenden Vertragsübersichten verlinken auch die neueren UEMS-Schnittstellen.
