# Assistent „Steuern & Optimieren“ — Schritte 1–6 und Freigabe-Wege

AP-01 IP-10a/IP-10b bauen den Kundenablauf von der Anlagenwahl bis zum ausdrücklichen Start im Portal. Reine Regeln liegen in `frontend/portal/src/steuernAssistent.ts`, die Fläche in `components/SteuernAssistent.tsx`. Der bewusste Einstieg kommt aus der Karte „Funktionen“; deren Steuern-Regel bleibt erhalten, sodass eine reine Messfläche nicht vor diesem Einstieg mit Steuer-Wörtern wirbt.

## Grenzen

- Die Funktion gilt am Standort, die technische Auswahl bleibt je Anlage. Schritt 1 zeigt bestehende Teilnahmen aus `GET /api/v1/funktionen`.
- Steuerbarkeit kommt aus `GET /sites/{id}/entities` (`control`). Schritt 2 liest den komponentengenauen Stand additiv aus derselben Quelle wie Schritt 5: `GET …/funktionen/steuern/pruefung.freigaben`; kein zweiter Endpunkt und keine neue Freigabe-Tabelle.
- Selbstbau öffnet den bestehenden `SchaltFreigabeDrawer` mit unverändertem Pflicht-Test und Bestätigung. OCPP zeigt Station + Steuerart; die Wahl bleibt im bestehenden Steuerart-Dialog. Beim Wechselrichter sieht der Kunde nur die VoltPilot-Scharfschaltung aus `device_control_activation`.
- Schritt 3 schreibt ausschließlich die Kunden-Route `PUT /sites/{id}/charging-frame`; die vereinbarte Leistung stammt möglichst aus dem gebundenen Netzanschluss.
- Schritt 4 verwendet den bestehenden Steuerart-Dialog als Entwurf und bietet am Speicher die Betriebsmodelle einschließlich „Marktoptimierung“ als Wahl an.
- Schritt 1 nimmt die Anlage über die bestehende Funktionsroute auf. Dabei entstehen nur Teilnahme im Entwurf und Ruhe ohne Enddatum; keine Betriebsweise wird aktiviert.
- Schritt 5 liest `GET /sites/{id}/funktionen/steuern/pruefung`. Jede Zeile kommt mit Fakt; rote Zeilen zusätzlich mit Grund und Weg. Bei einer roten Zeile gibt es keinen Start-Knopf.
- „Betriebsweise übernehmen“ bewahrt den Browser-Entwurf und führt zur Prüfung. Erst `PUT …/funktionen/steuern` mit `aktion: starten` hebt die Ruhe in derselben Transaktion wie Teilnahme und Standort-Funktion auf. Schritt 6 zeigt die fertige Anlagenzeile; „steuert“ bleibt eine getrennte Box-Beobachtung.

## Nachweise

`SteuernAssistent.test.tsx` spielt Referenzfall 5 bis Schritt 6 und belegt: rote Zeile → kein Start-Knopf. `steuernAssistent.test.ts` prüft Selbstbau, OCPP und Wechselrichter einzeln. `FunktionApiTest` prüft Fakt/Grund/Weg, „2 von 3 freigegeben“, Fremd-404, A3 sowie den vollständigen Rollback eines erzwungen fehlgeschlagenen Starts. `e2e/steuern-assistent.spec.ts` durchläuft alle sechs Schritte und den eingebetteten Schalt-Drawer je zweimal bei 375 und 1440 px und prüft Querlauf.
