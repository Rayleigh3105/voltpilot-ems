<!-- ERZEUGT von docs/fachmodell/tools/build_fachmodell.py aus fachmodell.py — nicht von Hand ändern. -->

# Zustandsvokabular

Zwei Familien, entschieden in AP-00 E8 (10.09.2026): der **Lebenszyklus**, den der Kunde setzt (Entwurf → eingerichtet → aktiv → archiviert, dazu angehalten), und die **Beobachtung**, die nie jemand von Hand setzt (liefert Daten · steuert). Die Wörter bedeuten bei JEDEM Objekt dasselbe; welche davon ein Objekt haben kann, sagt die Matrix.

AP-01 E8 bildet die drei Wörter des Programm-Plans darauf ab: **sichtbar** = kein Objekt (ein Angebot auf der Funktions-Karte), **begonnen** = Entwurf (bei „Steuern & Optimieren“ auch eingerichtet, noch nicht gestartet), **aktiv** = aktiv.

## Definitionen

| Zustand | Familie | Bedeutung | Was der Kunde liest |
|---|---|---|---|
| Entwurf | Lebenszyklus | Objekt angelegt, Pflichtangaben unvollständig oder Prüfung nicht bestanden. Zählt in keiner Auswertung. | „Noch nicht eingerichtet — es fehlt: …“ |
| eingerichtet | Lebenszyklus | Alle Pflichtangaben vorhanden und die technische Prüfung bestanden (Verbindungstest, Quelle gebunden, Anschluss zugeordnet). | „Eingerichtet am 01.10.2026“ |
| aktiv | Lebenszyklus | Nimmt am Betrieb teil: erscheint in Auswertungen, Berichten, Steuerung. Wird mit der Einrichtung automatisch aktiv, außer bei Funktionen, die der Kunde ausdrücklich startet (Betriebsmodell, Steuerung). | kein Abzeichen — der Normalzustand |
| angehalten | Lebenszyklus | Vom Kunden vorübergehend aus dem Betrieb genommen; Daten und Zuordnungen bleiben; Wiederaufnahme ohne Neu-Einrichtung. | „Angehalten seit 03.11.2026 — Fortsetzen“ |
| archiviert | Lebenszyklus | Endgültig beendet; Daten und Historie bleiben lesbar und in alten Berichten unverändert; keine neuen Werte, keine neuen Zuordnungen. | „Archiviert am …“, ausgegraut, in Berichten des alten Zeitraums weiterhin vorhanden |
| liefert Daten | Beobachtung | Innerhalb der erwarteten Kadenz plus Toleranz kam ein Wert mit Qualität „gut“ an. Nie von Hand gesetzt. | „Liefert Daten“ · „Liefert keine Daten seit 14:00 Uhr“ · „Wartet auf erste Daten“ |
| steuert | Beobachtung | Steuer-Freigabe erteilt UND ein Betriebsmodell oder eine Regel läuft UND die Box bestätigt die Ausführung. Nie von Hand gesetzt. | „Wird von VoltPilot gesteuert“ · „Steuert nicht — nicht freigegeben“ · „Steuert nicht — Box meldet sich nicht“ |

## Matrix je Objekt

| Objekt | Entwurf | eingerichtet | aktiv / angehalten / archiviert | liefert Daten | steuert | Was der Kunde sieht |
|---|---|---|---|---|---|---|
| Kundenbereich | — | immer (mit Registrierung) | aktiv \| archiviert (Offboarding) | — | — | nichts — der Bereich ist unsichtbar; der Kunde sieht sein Unternehmen |
| Unternehmen | — | immer (automatisch) | aktiv | abgeleitet: „x von y Messstellen liefern Daten“ | abgeleitet: „x von y Anlagen steuern“ | Kopfzeile: Unternehmensname, Zahl der Standorte, Datenlage |
| Standort | ja (Name fehlt) | Name + Adresse + Zeitzone | aktiv \| archiviert (nur ohne aktive Anlagen) | abgeleitet über seine Messstellen | abgeleitet über seine Anlagen | Standortkarte: „2 Anlagen · 1 steuert · 14 von 14 Messstellen liefern Daten“ |
| Gebäude / Bereich | ja | Name (+ Fläche für Kennzahlen) | aktiv \| archiviert | abgeleitet über zugeordnete Messstellen | — | Zeile im Ortsbaum mit Monatsverbrauch und Datenlage |
| Netzanschluss | ja | Marktlokation + vereinbarte Leistung + Anlage | aktiv \| archiviert (gekündigt) | abgeleitet über den Hauptzähler | — | „Hauptanschluss Halle 1 · 550 kW vereinbart · Hauptzähler liefert Daten“ |
| Anlage | ja (kein Anschluss) | Standort + Netzanschluss + ≥ 1 Komponente oder Messstelle | aktiv \| angehalten (Anlage in Ruhe) \| archiviert (Betriebsmodell muss aus sein) | abgeleitet: alle Boxen verbunden UND Hauptzähler liefert | genau dann, wenn ≥ 1 Komponente steuert | heutiges Cockpit; neu: Zeile unter dem Standort mit „reine Messung“ oder „Lastspitzenkappung läuft seit …“ |
| Box | ja (registriert, nicht angemeldet) | angemeldet (Zertifikat ausgestellt) + Heimat-Anlage | aktiv \| archiviert (ausgebaut) | „Verbunden“ = Heartbeat in der Kadenz | führt gerade Kommandos einer freigegebenen Komponente aus | Box-Seite: „Verbunden · liest 3 Datenquellen · steuert 1 Komponente“ |
| Datenquelle | ja (Adresse fehlt) | Verbindungstest bestanden + zuständige Box | aktiv \| angehalten (Box liest nicht) \| archiviert | letzte erfolgreiche Lesung in der Kadenz | — | nur auf Einrichtungsflächen: „Modbus 192.168.10.31 · zuständig Box Halle 1 · zuletzt gelesen 10:15“ |
| Gerät | ja (nicht identifiziert) | Hersteller/Typ erkannt oder eingegeben | aktiv \| archiviert (ausgebaut, z. B. alter Zähler) | abgeleitet über seine Komponenten | — | Geräteseite wie heute; ein ausgebauter Zähler bleibt als „ausgebaut am 18.11.2026“ lesbar |
| Komponente | ja | Verbindungstest bestanden + Rolle + Anlage (heute: Anlege-Weg) | aktiv \| angehalten \| archiviert | „Liefert Daten / Meldet sich gerade nicht / Wartet auf erste Daten“ (heutige Wörter bleiben) | „Wird von VoltPilot gesteuert“ — nur mit Freigabe UND laufendem Betriebsmodell/Regel | Komponentenkarte wie heute, ergänzt um „speist Messstellen MS-05, MS-06“ |
| Messkanal | — | mit der Komponente | mit der Komponente | je Wert: Qualität gut/unsicher/ungültig/veraltet/Gerätefehler | — | „Beobachtete Messwerte“ wie heute |
| Messstelle (gemessen) | ja (Kennzeichen/Messgröße fehlt) | Kennzeichen + Messgröße + Ort; Quelle darf fehlen | aktiv \| angehalten \| archiviert | über die führende Quelle; ohne Quelle: „keine Datenquelle“ | — (eine Messstelle steuert nie) | Messstellenliste: „MS-06 Spritzguss SG01–SG06 · 148,6 kW · liefert Daten“ |
| Messstelle (berechnet) | ja (Formel unvollständig) | Formel + alle Eingänge eingerichtet | aktiv \| archiviert | „vollständig“ nur, wenn alle Eingänge liefern; sonst „unvollständig (fehlt: MS-12)“ | — | „berechnet aus 3 Messstellen · unvollständig seit 14:00“ |
| Prozess / Kostenstelle | ja | Name (+ Nummer) | aktiv \| archiviert (Kostenstellenplan-Wechsel) | abgeleitet über zugeordnete Messstellen | — | Zeile in der Prozess-/Kostenstellensicht mit Monatswert |
| Betriebsmodell (übernommen) | — | Voraussetzungen der Anlage erfüllt | läuft \| gewählt, wartet — Grund \| aus | — | „läuft seit …“ = steuert | Radiogruppe wie heute |

## Übergänge

| Übergang | Auslöser | Regel |
|---|---|---|
| Entwurf → eingerichtet | Kunde vervollständigt Pflichtangaben; technische Prüfung (Verbindungstest, Quelle gebunden) bestanden. | Assistent sagt, was fehlt; kein Objekt wird ohne Prüfung eingerichtet. |
| eingerichtet → aktiv | Automatisch für Struktur- und Messobjekte; ausdrücklicher Start für Betriebsmodelle und Steuerung („nach technischen Prüfungen starten“). | Das Hinzufügen einer Funktion löst keine Steuerung aus (AP-01-Grenze): „Steuern freigeben“ bleibt ein eigener Schritt. |
| aktiv → angehalten → aktiv | Kunde hält an (Anlage in Ruhe, Messstelle stillgelegt für Umbau) und setzt fort. | Zuordnungen und Daten bleiben; die Lücke bleibt sichtbar, nie aufgefüllt. |
| aktiv → archiviert | Kunde beendet; bei einer Anlage muss das Betriebsmodell aus sein, bei einem Standort dürfen keine aktiven Anlagen bleiben. | Alte Berichte bleiben unverändert; das Objekt bleibt lesbar; ein Wiederbeleben ist ein neues Objekt (Ausnahme: Standort/Gebäude dürfen reaktiviert werden). |
| liefert Daten ↔ liefert keine Daten | Beobachtung je Kadenz; Toleranz = 3 × Kadenz (AP-07 E9), mindestens 5 Minuten (heutiges Fenster), höchstens 1 Tag (Zähler mit Tageswerten). | Text nennt immer den Zeitpunkt: „seit 14:00 Uhr“; Schweigen ist nie ein bewiesener Fehlschlag. |
| steuert ↔ steuert nicht | Beobachtung: Freigabe UND laufendes Betriebsmodell/Regel UND Box-Bestätigung; fehlt eines, „steuert nicht — Grund“. | Der Grund ist einer der bekannten Wächter-/Wartegründe (Steuerung Stufe 5), nie geraten. |

## Verfeinerungen der Nachbarpakete

- **AP-01 E8:** Die drei Wörter des Plans werden auf dieses Vokabular abgebildet: sichtbar = kein Objekt (Angebot auf der Karte), begonnen = Entwurf (bei „Steuern“ auch eingerichtet, noch nicht gestartet), aktiv = aktiv.
- **AP-01 E7/E8:** „angehalten“ heißt bei einer Anlage: Ruhe OHNE Enddatum; alles bleibt gespeichert, nur Fahrplan, Regeln und Steuerarten wirken nicht.
- **AP-01 E9:** Beim Fortsetzen läuft die Prüfliste erneut, dann zeigt eine Folgen-Karte, was passiert — und dann genügt ein Klick.
- **AP-07 E9:** „liefert Daten“ ist geschärft: letzter guter Wert jünger als 3 × Kadenz nach Eingangszeit, mindestens 5 Minuten und höchstens 1 Tag; eine Lücke der Reihe beginnt schon ab 2 × Kadenz. Die Kadenz ist ein zeitgültiges Feld der Quellenbindung, kein fester 5-Minuten-Deckel.
- **AP-04 E8:** Eine Messstelle ohne Quelle hat die Beobachtung „keine Datenquelle“ — sie ist eingerichtet und aktiv, zeigt aber nie eine 0.
- **AP-07 E11:** Ereignisse (Lücke, Nachlieferung, Gerätegrenze, Zeitfehler, Konflikt) reisen über einen additiven Vertrag `…/v2/events` in eine Ereignis-Tabelle je Mandant, append-only und NIE gelöscht — sie sind der Beweis hinter jeder Zustandsaussage.

⚠ **Ableitungsregel als Vertrag:** `docs/contracts/v2/uems-zustand-vectors.json` (Schema `uems-zustand.schema.json`, AP-00 IP-3). Dort stehen die Toleranz (3 × Kadenz, mindestens 5 Minuten, höchstens 1 Tag), die Lücke ab 2 × Kadenz und die Reihenfolge der „steuert nicht“-Gründe (angehalten → nicht freigegeben → Funktion nicht gestartet → kein Betriebsmodell → Box meldet sich nicht → Box bestätigt nicht); die Zwillinge sind `services/api .../uems/ZustandAbleitung` und `frontend/portal/src/uemsZustand.ts`. Noch ruft niemand an: in `services/api` und im Portal lebt weiterhin das harte 5-Minuten-Fenster.

## Entscheidungslog

### AP-00 (Fachmodell)

| Datum | Entscheid | Wortlaut |
|---|---|---|
| 10.09.2026 | E1 | Option A — Anlage bleibt als Betriebseinheit unter einem Standort. Wortlaut: „Entscheidung E1: Option A“ (Lavish-Review, Kasten E1) |
| 10.09.2026 | E2 | Option A — 1 : 1, Konzern vorbereitet. Wortlaut: „Entscheidung E2: Option A“ (Lavish-Review, Kasten E2) |
| 10.09.2026 | E3 | Option A — Messstelle darf direkt am Standort hängen; kein implizites Gebäude. Wortlaut: „Entscheidung E3: Option A“ (Lavish-Review, Kasten E3) |
| 10.09.2026 | E4 | Option A — räumlich (Teil eines Gebäudes oder Standorts). Wortlaut: „Entscheidung E4: Option A“ (Lavish-Review, Kasten E4) |
| 10.09.2026 | E5 | Option A — zwei Achsen: Prozessbaum (eine Ebene Verschachtelung) und flache Kostenstellen mit Prozentanteilen. Wortlaut: „Entscheidung E5: Option A“ (Lavish-Review, Kasten E5) |
| 10.09.2026 | E6 | Option A — eigenes Objekt am Standort, im ersten Umfang genau eines je Anlage; 1..n je System vorbereitet. Wortlaut: „Entscheidung E6: Option A“ (Lavish-Review, Kasten E6) |
| 10.09.2026 | E7 | Option A — Heimat bleibt die Anlage; Zuständigkeit je Datenquelle ist eine eigene, zeitgültige Beziehung. Wortlaut: „Entscheidung E7: Option A“ (Lavish-Review, Kasten E7) |
| 10.09.2026 | E8 | Option A — Lebenszyklus (Entwurf · eingerichtet · aktiv · angehalten · archiviert) + Beobachtung (liefert Daten · steuert). Wortlaut: „Entscheidung E8: Option A“ (Lavish-Review, Kasten E8) |
| 10.09.2026 | E9 | Option B — beides bleibt: Feld der Anlage und Objekt heißen „Standort“; Paket IP-5 entfällt. Wortlaut: „Entscheidung E9: Option B“ (Lavish-Review, Kasten E9) |
| 10.09.2026 | E10 | Option A — automatisch vergeben (MS-0001 …), vom Kunden änderbar, eindeutig je Kundenbereich. Wortlaut: „Entscheidung E10: Option A“ (Lavish-Review, Kasten E10) |
| 10.09.2026 | E11 | Option A — geschlossenes Vokabular am Attribut „Medium“ (Strom · Gas · Wärme · Kälte · Wasser · Druckluft); nur „Strom“ wählbar. Wortlaut: „Entscheidung E11: Option A“ (Lavish-Review, Kasten E11) |
| 10.09.2026 | E12 | Option A — eine Komponente je Energiekarte (Zähler), der Controller ist das Gerät. Wortlaut: „Entscheidung E12: Option A“ (Lavish-Review, Kasten E12) |

### Nachbarpakete — nur was einen AP-00-Begriff berührt

| Datum | Entscheid | Inhalt |
|---|---|---|
| 10.09.2026 | AP-01 E6 | Option C — beide Funktionen gelten je Standort; die Anlage nimmt einzeln teil (W7: Freigabe, Grenze, Betriebsweise, Ruhe und Start bleiben je Anlage) |
| 10.09.2026 | AP-01 E7/E8 | Option A — Ruhe-Eintrag ohne Enddatum; alles bleibt gespeichert, nur Fahrplan/Regeln/Steuerarten wirken nicht |
| 10.09.2026 | AP-01 Geld-Regel | Captain-Vorgabe — eine reine Messanlage zeigt auf keiner Ebene Geld |
| 10.09.2026 | AP-02 E1/E12 | Option A — Archivieren ist der Normalweg; Löschen nur ohne jede Historie; Archivieren nur ohne aktive Messstellen und Anlagen |
| 10.09.2026 | AP-02 E9 | Option A — „gültig ab“ ist ein Tag, wirksam 00:00 Uhr in der Zeitzone des Standorts |
| 10.09.2026 | AP-03 E1 | Option A — fünf Kundenrollen + Unterstützer: Kundenadministrator · Energiemanager · Bearbeiter · Bedienberechtigt · Leser · Unterstützer |
| 10.09.2026 | AP-04 E1 | Option A — eine Hauptgröße + 0..n Nebengrößen (ERSETZT AP-00 „Messstelle 1 : 1 Messgröße“, AP-04 W1) |
| 10.09.2026 | AP-04 E12 | Option A — „Unterzähler von …“ bezieht sich auf die übergeordnete Messstelle derselben Anlage |
| 10.09.2026 | AP-05 E3/E4 | Option A — Kartenzählerstand ist die Hauptgröße, Wirkleistung Nebengröße; Einstellungen an der Quelle, Kartenidentität = (Gerät, Steckplatz) |
| 10.09.2026 | AP-06 E1/E2/E3 | Option A — Datenquelle als eigenes Objekt; Zuständigkeit je Datenquelle; „führende Box“ je Anlage als gespeicherter Fakt |
| 10.09.2026 | AP-07 E2 | Option A — Reihe = Komponente + Messkanal; Gerät, Box und Fassung als Herkunft je Wert (ERSETZT AP-00 §6.4, AP-07 W1) |
| 10.09.2026 | AP-07 E11 | Option A — Ereignis-Vertrag `…/v2/events` + Ereignis-Tabelle je Mandant, append-only, nie gelöscht |
