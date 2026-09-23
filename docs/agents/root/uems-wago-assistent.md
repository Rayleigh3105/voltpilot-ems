# WAGO-Assistent im Portal (AP-05 IP-10)

Der Assistent liegt im bestehenden Fluss „Messen & Auswerten“: Verbindung/Kopfprüfung → ausgelesene Energiekarten → Komponenten. Danach übernimmt unverändert die Messstellen-Vorschlagsliste. Einstieg und Fluss stehen in `frontend/portal/src/components/MessenAssistent.tsx` und `WagoAssistent.tsx`, die fachliche Auswertung in `frontend/portal/src/wagoAssistent.ts`. Der 22-teilige Erhebungsbogen bleibt ausschließlich das Pilot-Formular `docs/wago/erhebungsbogen.md`; das Portal speichert keine Bogenantworten.

## Aktivierungsgrenze

Der Einstieg erscheint nur, wenn am Standort eine Box die Fähigkeit `wago_registerbild` meldet. Dieses Wort ist bereits die Quellenart der Cloud-Vorlage, gehört aber noch nicht zum geschlossenen Box-Fähigkeitsvertrag. Deshalb ist die Bedingung heute für jede Box falsch. Erst die Edge-Aktivierung darf das Wort in den Fähigkeitsvertrag aufnehmen und melden; bis dahin sendet das Portal nichts an eine Box.

Der Verbindungstest liest nur den WAGO-Kopf. Er zeigt Signatururteil, Registerbild-Version, Kartenzahl, Herzschlag und den Klartextgrund aus der Probe-Antwort. Anschließend liest die Box Steckplatz, Kartentyp und Werte der Karten. Kunden ergänzen je Karte nur Messaufgabe, Wandlerpaar und den Ort der Umrechnung. „Komponenten anlegen“ ist EIN Aufruf `POST /api/v1/sites/{siteId}/wago/karten`: Komponenten, Controller und je Karte ein `geraet_teil` mit Steckplatz entstehen zusammen ([Registerbild-Wegweiser](uems-wago-registerbild.md#energiekarten-beim-anlegen-b05-23092026)). Echte Messwerte beim Anlegen sind ohne aktivierte Box nur als gesäte Antworten der E2E-Bühne belegt.

## Beleggrenzen

Die Ergebnisse `belegt_je_kunde` und `nicht_unterstuetzt` folgen ausschließlich aus gelesener Controller- und Kartenkennung. Ein `belegt` kann die Box heute nicht nachweisen; die gelesene PFC200-Kombination bleibt deshalb „in Prüfung — Pilot ausstehend“. Unvollständige Lesungen bleiben „unbekannt“. Für 750-494 werden weder Messwerttabelle noch Skalierungsfaktor als geprüft ausgegeben.

## Nachweise

- `frontend/portal/src/wagoAssistent.test.ts`: Auswertung aus Lesedaten, Sichtbarkeit und Kopfgründe
- `frontend/portal/src/components/MessenAssistent.test.tsx`: kein Einstieg mit heutigen Box-Fähigkeiten
- `frontend/portal/e2e/messen-assistent.spec.ts`: vollständiger Fluss bei 375 und 1440 px samt Übergabe an die Messstellen-Vorschläge
