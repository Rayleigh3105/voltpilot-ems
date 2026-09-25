# UEMS-Energiemanagement: Portal (AP-19 IP-9)

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
| `energiemanagementPortal.ts` | Rechte, Reiter, Wörter, Entwürfe → Körper, Ablehnungs-Sätze; Sätze nur über die Schablonen von `energiemanagement.ts` |
| Bühne | `e2e/energiemanagement.html?lage=start\|ahrenberg&dok=1\|2\|3&seite=dokumente\|zuschnitt`, Routen in `src/test/energiemanagementFixtures.ts`, Schreib-Körper in `window.__emGesendet` |
| Nachweis | `e2e/energiemanagement.spec.ts` (R1-Fluss, Verweis-Probe, Stand 12.02.2029), `src/energiemanagementPortal.test.ts`, `copy.test.ts` Block „Energiemanagement“ (`ENERGIEMANAGEMENT_FLAECHEN`) |

⚠ **Nur die Prüfsumme geht hinaus:** ein Verweis bildet die SHA-256 im Browser (`uemsMessmittel.pruefsummeLokal`); der
Körper trägt `bezeichnung · ablage · kennung · adresse (· fassungsangabe · datum) · sha256`, nie die Datei. Die Spec
rechnet die SHA-256 in Node nach und sucht den Datei-Inhalt in jeder Anfrage und jedem Körper.
⚠ **Jede `.tsx`, deren Name mit einem Bereichswort beginnt, ist eine Fläche** und trägt `{UEMS_NORMGRENZE}` UND
`{UEMS_VERANTWORTUNG}` als JSX-Kind in der eigenen Datei — Teile, die im Bereich stehen, tun es hinter `saetze`.
⚠ **Reiter-Reihenfolge und Zuschnitt-Hilfe** ließ das Konzept offen (§6.3, B.5 Z3); der PR von IP-9 zeigt je zwei
Varianten mit Bildern, gebaut ist die empfohlene: Verzeichnis zuerst, Hilfe als eigene Seite. Die übrigen fünf Reiter hängen sich in der Reihenfolge von §6.3 an `REITER` an.
⚠ **Bekannt machen, „geprüft, bleibt“ und Aufheben** haben Routen (IP-7), aber noch keinen Knopf — die Seite zeigt die
Einträge nur. Der Anlegen-Dialog bietet Unternehmen und Standort; „Nachweis festhalten“ mit vorbelegtem Bezug
Einsatz/Person baut IP-15.
