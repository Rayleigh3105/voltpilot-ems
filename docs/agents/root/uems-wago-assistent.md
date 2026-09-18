# WAGO-Assistent im Portal (AP-05 IP-10)

Der Assistent liegt im bestehenden Fluss „Messen & Auswerten“: Erhebungsbogen → Datenquelle → Gerät → Energiekarten → Komponenten. Danach übernimmt unverändert die Messstellen-Vorschlagsliste. Einstieg und Fluss stehen in `frontend/portal/src/components/MessenAssistent.tsx` und `WagoAssistent.tsx`, die fachliche Auswertung in `frontend/portal/src/wagoAssistent.ts`.

## Aktivierungsgrenze

Der Einstieg erscheint nur, wenn am Standort eine Box die Fähigkeit `wago_registerbild` meldet. Dieses Wort ist bereits die Quellenart der Cloud-Vorlage, gehört aber noch nicht zum geschlossenen Box-Fähigkeitsvertrag. Deshalb ist die Bedingung heute für jede Box falsch. Erst die Edge-Aktivierung darf das Wort in den Fähigkeitsvertrag aufnehmen und melden; bis dahin sendet das Portal nichts an eine Box.

Der Verbindungstest liest nur den WAGO-Kopf. Er zeigt Signatururteil, Registerbild-Version, Kartenzahl, Herzschlag und den Klartextgrund aus der Probe-Antwort. Echte Messwerte beim Anlegen sind ohne aktivierte Box nur als gesäte Antworten der E2E-Bühne belegt.

## Beleggrenzen

Die drei Ergebnisse `belegt`, `belegt_je_kunde` und `nicht_unterstuetzt` folgen der Regel aus `docs/wago/erhebungsbogen.md`; unvollständige Angaben bleiben „in Prüfung“. Für 750-494 werden weder Messwerttabelle noch Skalierungsfaktor als geprüft ausgegeben. Leere Wandler- oder Skalierungsangaben bleiben unbekannt und werden nicht als Null oder erfundener Faktor gespeichert.

## Nachweise

- `frontend/portal/src/wagoAssistent.test.ts`: Auswertung, Sichtbarkeit, Speicherung und Kopfgründe
- `frontend/portal/src/components/MessenAssistent.test.tsx`: kein Einstieg mit heutigen Box-Fähigkeiten
- `frontend/portal/e2e/messen-assistent.spec.ts`: vollständiger Fluss bei 375 und 1440 px samt Übergabe an die Messstellen-Vorschläge
