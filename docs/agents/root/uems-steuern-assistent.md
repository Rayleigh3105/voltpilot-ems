# Assistent „Steuern & Optimieren“ — Schritte 1–4

AP-01 IP-10a baut den Kundenablauf bis zur vorbereiteten Betriebsweise im Portal. Reine Regeln liegen in `frontend/portal/src/steuernAssistent.ts`, die Fläche in `components/SteuernAssistent.tsx`. Der bewusste Einstieg kommt aus der Karte „Funktionen“; deren Steuern-Regel bleibt erhalten, sodass eine reine Messfläche nicht vor diesem Einstieg mit Steuer-Wörtern wirbt.

## Grenzen

- Die Funktion gilt am Standort, die technische Auswahl bleibt je Anlage. Schritt 1 zeigt bestehende Teilnahmen aus `GET /api/v1/funktionen`.
- Steuerbarkeit kommt ausschließlich aus `GET /sites/{id}/entities` (`control`). Schritt 2 nennt die vorhandenen Freigabe-Wege; ihre vertiefte Einbettung folgt IP-12.
- Schritt 3 schreibt ausschließlich die Kunden-Route `PUT /sites/{id}/charging-frame`; die vereinbarte Leistung stammt möglichst aus dem gebundenen Netzanschluss.
- Schritt 4 verwendet den bestehenden Steuerart-Dialog als Entwurf und bietet am Speicher die Betriebsmodelle einschließlich „Marktoptimierung“ als Wahl an.
- Der Assistent ruft weder `PUT /profiles` noch `PUT …/steuerart` auf und startet nichts. Aktivierung, Prüfliste und Start gehören IP-10b. „Betriebsweise übernehmen“ schließt daher nur den Browser-Entwurf ab.

## Nachweise

`SteuernAssistent.test.tsx` spielt Referenzfall 5 bis Schritt 4 und zählt die verbotenen Aufrufe. `e2e/steuern-assistent.spec.ts` durchläuft die vier Schritte je zweimal bei 375 und 1440 px, prüft Querlauf und dieselbe Schreibgrenze.
