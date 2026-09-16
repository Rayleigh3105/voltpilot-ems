# UEMS: Datenquelle im Mess-Assistenten anlegen (AP-06 IP-11)

Der zweite Schritt von „Messen & Auswerten“ öffnet je Anlage `DatenquelleAnlegen`. Die Fläche verwendet nur gebaute Routen: `/devices` und `/edge-versions` für Box-Zustand und Software, die Datenquellen-Routen für Entwurf, Prüfung und Zuständigkeit. Eine eigene Seite unter Standort › Boxen bleibt AP-06 IP-16.

## Grenzen und Wörter

- Die Box-Liste enthält alle Boxen, deren Heimat-Anlage zum gewählten Standort gehört. Vorauswahl ist die Box der Anlage; eine andere Box am Standort bleibt wählbar.
- Freies Lesebudget wird vor dem ersten Zuweisungsversuch nicht geraten. Die Liste sagt dann „wird beim Einrichten geprüft“. Erst der strukturierte 422-Körper liefert echte freie Kapazitäten.
- Die 422-Anzeige kommt ausschließlich aus `uemsDatenquelle.budgetAblehnungAnzeige`. Beide Server-Auswege sind Knöpfe: Takt übernehmen oder die genannte andere Box wählen; danach ist eine neue Erreichbarkeitsprüfung Pflicht.
- Entwurf, Erreichbarkeitsprüfung und Zuständigkeit bleiben getrennte Schritte. Nur `ergebnis = ok` öffnet „Einrichtung abschließen“.
- Rechte laufen über `rollen.ts`: `datenquelle.bearbeiten` für Entwurf und Prüfung, `datenquelle.zustaendigkeit` für den Abschluss, jeweils im Standort-Kontext.

## Orte und Nachweise

- Reine Anzeigeableitungen: `frontend/portal/src/datenquelle.ts`
- Fläche: `frontend/portal/src/components/DatenquelleAnlegen.tsx`
- Einstieg: `frontend/portal/src/components/MessenAssistent.tsx`, Schritt 2
- E2E-Bühne: `frontend/portal/e2e/messen-assistent.spec.ts`, 375 und 1440 px einschließlich 422-Ablehnung
- Wächter: `datenquelle.test.ts`, `uemsDatenquelle.test.ts`, `copy.test.ts`, `migration.test.ts`, `uemsKeineRechnung.test.ts`
