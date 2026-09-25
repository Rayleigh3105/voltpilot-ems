# UEMS-Energiemanagement: Portal (AP-19 IP-9, IP-13, IP-15)

Neu am 25.09.2026: der Bereich „Energiemanagement“ als neunte Unternehmens-Seite über den Routen von IP-6/IP-7/IP-8
([Personen](uems-energiemanagement-personen.md), [Dokumente](uems-energiemanagement-dokumente.md), Verzeichnis in der
[Übersicht](uems-uebersicht.md)). Konzept: AP-19 §5.1, §5.8, §6.3, R1–R4 (`vp-uems-ap19-fundament/report.md`).

| Stelle | Was |
|---|---|
| `pages/EnergiemanagementBereich.tsx` | `#/portfolio/energiemanagement[/dokumente\|/zuschnitt]`, Reiter Verzeichnis · Dokumente (Register inline, Bezug über `bezugWort` auch für Einsatz/Person/Aufgabe aus IP-14), Link auf die Zuschnitt-Hilfe im Kopf; Kachel nur mit `energiemanagement.ansehen` UND einem messenden Standort (`ebenenNav.ts`, wie Bewertung und „Ziele und Maßnahmen“) |
| `components/VerzeichnisTabelle.tsx` | Leser `GET …/verzeichnis`: elf Gruppen, leere mit Satz + Zuschnitt, Filter Gruppe/Tag/Person („in meinem Namen“ = Person mit dem eigenen Konto), CSV-Abruf, Dokument-Zeile öffnet das Dokument |
| `pages/DokumentSeite.tsx` | `#/portfolio/energiemanagement/dokumente/{id}`: Kopf-, Überprüfungs- und Sperr-Satz wörtlich von der Route, Ort-Satz, gezeigte Fassung, Anwendungsbereich + `components/AnwendungsbereichVergleich.tsx`, Fassungen, Einträge |
| `components/DokumentDialoge.tsx` | Anlegen (Art mit Satz je Art, Bezug Unternehmen/Standort, Original als Verweis), Fassung (Wortlaut ODER Verweis), Freigabe (entschieden von; Leitungs-Arten nur die Leitung am Tag, 409 `vieraugen_beantragen` schaltet auf „Freigabe beantragen“), Person anlegen (mit Aufgabe „Leitung des Unternehmens“) |
| `components/ZuschnittHilfe.tsx` | statische Seite „Was VoltPilot führt — was bei Ihnen liegt.“: 16 Teile + 4 Nachbarn aus §3.2 in Kundenwörtern, ohne Norm-Spalte |
| `components/EnergiemanagementAufgaben.tsx` (IP-13) | Reiter `#/portfolio/energiemanagement/aufgaben`: je Wort des Vokabulars die laufenden Zuordnungen am „Stand am“ (`GET …/aufgaben?tag=`), ohne Person der Satz der Route, künftige Zuordnungen mit „ab“ darunter; Zuordnen (auch aus der Zeile, Aufgabe vorbelegt), Beenden, Person anlegen; darunter die Personen im Energiemanagement |
| `components/EnergiemanagementVerantwortung.tsx` (IP-13) | „Wer ist wofür verantwortlich“ als Ansicht unter dem Reiter „Aufgaben“ (`…/verantwortung`, Reiter bleibt markiert): Aufgaben, Objekte nach Art (`GET …/verantwortung`), Freigaben der Bezugsbasen mit Satz nur, wenn EINE Person alle freigab — kein Urteil |
| `pages/EnergiemanagementPersonSeite.tsx` (IP-13) | `…/personen/{id}`: Funktion, Konto oder der Satz „… ohne Konto — erscheint als ‚entschieden von‘.“, Aufgaben als Person und als Vertretung, Verlauf; „Angaben ändern“ (PUT = ganzer Stand, Konto aus der Benutzerliste, „bis“ beendet) |
| `components/EnergiemanagementAufgabeDialoge.tsx` (IP-13) | Aufgabe zuordnen („entschieden von“ Pflicht außer Leitung, Vertretung, Beleg als Verweis, Beschluss `BR-…/Bn`), Zuordnung beenden, Angaben ändern |
| `components/EinsichtRecht.tsx` (IP-13) | `EinsichtRecht` (ein Knopf) und `EinsichtGruppe` (mehrere Knöpfe, EIN Satz): mit der Rolle „Einsicht“ und ohne das Recht steht dort „Mit ‚Einsicht‘ können Sie hier nichts ändern. …“; sonst verhält es sich wie `Recht` |
| `components/Nachweise.tsx` (IP-15) | Abschnitt „Nachweise“ an der Einsatz-Seite (`NachweiseAmEinsatz`, AP-16-Fläche, nur mit `energiemanagement.ansehen`) und an der Personen-Seite (`NachweiseDerPerson`) über die Leser von IP-14 ([Nachweise](uems-energiemanagement-nachweise.md)): je Dokument Ort-Satz wörtlich von der Route, https-Adresse als Text, „Prüfsumme der Datei festgehalten am …“, Überprüfung wie die Dokument-Seite, Bekanntmachungen; „Nachweis festhalten“ = Anlegen mit festem Bezug (`fest`, Arten `NACHWEIS_ARTEN`) → Fassung als Verweis (`form="verweis"`) → Freigabe, wer sie darf; ein Abbruch lässt den Entwurf im Abschnitt |
| `components/BenutzerEinladen.tsx` (IP-13, Folge) | „Einsicht“ bietet „Gültig bis einschließlich“ überall: „Weitere Rolle zuweisen“ dazu Grund wahlfrei → `POST /api/v1/zugriff` (`benutzerApi.einsichtZuweisen`); beim Ändern `gueltig_bis` im Wechsel (`PUT …/zugriff`), beim Anlegen im Körper von `POST /api/v1/benutzer` (Schritt 2 nennt die Frist); ohne Frist der bisherige Aufruf, byte-gleich |
| `energiemanagementPortal.ts` | Rechte, Reiter, Wörter, Entwürfe → Körper, Ablehnungs-Sätze; Sätze nur über die Schablonen von `energiemanagement.ts`; seit IP-13 `mitEinsicht`, `zuordnenKoerper`, `beendenKoerper`, `personAendernKoerper`, `zuordnungRest` |
| Bühne | Einsatz: `e2e/bewertung.html?stand=voll&ee=EE-1` spielt seit IP-15 immer die Energiemanagement-Routen (Lage `ahrenberg`, Einsätze der Bewertung als Bezug, Körper in `window.__emGesendet`) · `e2e/energiemanagement.html?person=IK\|JW\|CB\|RF&lage=start\|ahrenberg&dok=1\|2\|3&seite=dokumente\|aufgaben\|verantwortung\|zuschnitt&ps=RF\|IK…` (RF = „Einsicht“), Routen in `src/test/energiemanagementFixtures.ts` (Lage `ahrenberg` mit den zehn Zuordnungen aus R5), Schreib-Körper in `window.__emGesendet` |
| Nachweis | `e2e/energiemanagement.spec.ts` (R1-Fluss, Verweis-Probe, Stand 12.02.2029), `e2e/energiemanagement-aufgaben.spec.ts` (IP-13: zuordnen mit „entschieden von“, R5, Einsicht ohne Schreib-Knopf), `e2e/nachweise.spec.ts` (IP-15: R7 Verweis am Einsatz mit Netz-Probe, Entwurf nach Abbruch, R8 Kompetenz an der Person, Einsicht; `NACHWEISE_BILDER=<Ordner>`), `src/energiemanagementPortal.test.ts`, `pages/BenutzerPage.test.tsx`, `copy.test.ts` Block „Energiemanagement“ (`ENERGIEMANAGEMENT_FLAECHEN`) |

⚠ **Nur die Prüfsumme geht hinaus:** ein Verweis bildet die SHA-256 im Browser (`uemsMessmittel.pruefsummeLokal`); der
Körper trägt `bezeichnung · ablage · kennung · adresse (· fassungsangabe · datum) · sha256`, nie die Datei. Die Spec
rechnet die SHA-256 in Node nach und sucht den Datei-Inhalt in jeder Anfrage und jedem Körper.
⚠ **Jede `.tsx`, deren Name mit einem Bereichswort beginnt, ist eine Fläche** und trägt `{UEMS_NORMGRENZE}` UND
`{UEMS_VERANTWORTUNG}` als JSX-Kind in der eigenen Datei — Teile, die im Bereich stehen, tun es hinter `saetze`.
⚠ **Reiter-Reihenfolge und Zuschnitt-Hilfe** ließ das Konzept offen (§6.3, B.5 Z3); der PR von IP-9 zeigt je zwei
Varianten mit Bildern, gebaut ist die empfohlene: Verzeichnis zuerst, Hilfe als eigene Seite. Die übrigen fünf Reiter hängen sich in der Reihenfolge von §6.3 an `REITER` an.
⚠ **Bekannt machen, „geprüft, bleibt“ und Aufheben** haben Routen (IP-7), aber noch keinen Knopf — die Seite zeigt die
Einträge nur. Der Anlegen-Dialog bietet Unternehmen und Standort; Einsatz und Person nur über „Nachweis festhalten“ (IP-15).
⚠ **„Nachweis festhalten“ prüft das Recht am Unternehmen** (`EinsichtRecht standort={null}`, wie „Maßnahme anlegen“): den
Zaun eines Einsatzes leitet erst die Route ab (Standort seiner Messstellen) — ein reines Standort-Konto sieht den Knopf nicht.
⚠ **Der Abschnitt ist eine Fläche** (`copy.test.ts`, Namensmuster `Nachweis…`): an der Einsatz-Seite trägt er den
Verantwortungs-Satz (`verantwortung`), den Grenz-Satz hat die Seite schon; auf der Personen-Seite stehen beide am Fuß.
⚠ **„Einsicht“ an Schreib-Knöpfen (IP-13):** neue Knöpfe im Bereich stehen in `EinsichtRecht`/`EinsichtGruppe`, nicht nackt
in `Recht` — sonst liest „Einsicht“ den allgemeinen Recht-Satz. Zeilen-Knöpfe (Beenden je Zuordnung) blendet der Reiter
ohne Recht aus; der Satz steht einmal im Kopf. Die Spec `energiemanagement-aufgaben.spec.ts` hält mit `SCHREIBEN` alle
Beschriftungen fest — ein neuer Schreib-Knopf gehört dort hinein.
⚠ **„Wer ist wofür verantwortlich“ ist kein achter Reiter** (§6.3 nennt sieben): der PR von IP-13 zeigt die Ansicht
unter „Aufgaben“ (gebaut) gegen den Abschnitt unter den Aufgaben (Seite 8 365 px bei 375 px).
