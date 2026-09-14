# UEMS-Fläche: Unternehmens- und Standort-Übersicht (AP-01 IP-6)

Die Übersicht IST das Portfolio-Cockpit (Entscheid E2) — mit einer **Ebene**: Kopfzeile (Name, Standorte,
Anlagen, wer steuert, Datenlage), Standort-Gruppen der Anlagen-Tabelle mit dem Zustand BEIDER Funktionen je
Standort (E6 = C), Standort-Filter (die Standort-Übersicht ist dieselbe Seite) und die Geld-Regel
(Captain 10.09.2026: „Die Messdatenkunden brauchen keine Geldanzeige."). Kein Backend, keine Migration:
gelesen über `GET /api/v1/overview`, `/earnings`, `/funktionen` (IP-3, `uems-funktionen-routen.md`) und den
Standort-Schnappschuss aus IP-5 (`uems-startansicht.md`).

| Teil | Datei |
|---|---|
| Reine Hälfte: Filter `anlagenDerEbene`, Geld-Fakt `geldAnlagen`, `kopfzeile`, `funktionsZeilen`, `standortGruppen` | `frontend/portal/src/uebersicht.ts` · `uebersicht.test.ts` (A7, A13-Wächter) |
| Bausteine und Geld-Regel in den Zahlen: `GELD_BAUSTEINE`, `UEBERSICHT_BAUSTEINE`, `portfolioKennzahlen(…, geld)`, `verfuegbareBausteine({ uebersicht })`, `anlagenZeilen({ geld })`, `flottenHinweis` | `src/portfolioCockpit.ts` |
| Katalog: `datenlage` (`je_anlage`, Ort Kopfzeile, abwählbar, nicht verschiebbar) und `netzbezug-gesamt` (`summe`, Leiste), beide an `monitoring` | BEIDE `anwendungen/catalog.json` · `anwendungen.sync.test.ts` · `AnwendungKatalogTest` · `CockpitLayoutServiceTest` |
| Fläche: `PortfolioCockpit` Prop `ebene`; `AnlagenTabelle` Prop `gruppen` (ein `tbody` je Standort); `StandortGruppeKopf`, `FunktionsZustaende` | `src/components/` · `components/Uebersicht.test.tsx` |
| Verdrahtung: `unternehmensEbene` für `#/portfolio`, `geldIds` für den Reiter „Erlöse“ und `PortfolioErloese`; `StandortUebersichtPage` nimmt IMMER das Cockpit mit Ebene „Standort“ | `src/App.tsx`, `src/pages/StandortUebersichtPage.tsx` |
| 375/1440 px + Bilder | `e2e/uebersicht.spec.ts` auf der Bühne `startansicht.html` (`bild=messkunde`, `ansicht=werk`, `messen=bestand`); `UEBERSICHT_BILDER=<Ordner>` |

## Die Fallen

1. **Die Geld-Regel wirkt nur mit Ebene.** Ohne `ebene` (Betreiber, Admin, Kunde ohne Standorte) zählt das
   Cockpit zeichengleich wie vorher, und die zwei Übersichts-Bausteine gibt es dort nicht. Je Anlage gilt:
   unbekannt ist nie „erlaubt“ — ohne `roleCounts` keine Rolle, ohne Funktionen keine Teilnahme.
2. **Wer einen Baustein mit Euro ergänzt, trägt ihn in `GELD_BAUSTEINE` ein.** Der A13-Wächter in
   `uebersicht.test.ts` baut über einen Proxy JEDE Leisten-Zelle und prüft jede Zelle und jede Spalte mit
   Euro gegen die Liste; ein Leisten-Baustein, der keine Zelle baut, wird dort ebenfalls rot.
3. **Zwei Schichten, beide nötig:** `verfuegbareBausteine` blendet Geld-Bausteine aus, UND
   `portfolioKennzahlen`/`anlagenZeilen` zählen nur Geld-Anlagen. Die zweite hält, wenn die erste fehlt
   (Gegenprobe: ohne `lastspitzen` in der Liste bleibt die Render-Probe grün, der Wächter wird rot).
4. **Reiter „Erlöse“:** `App.tsx` holt `overview` + `funktionen` NUR auf einer Ebene, Schlüssel sind die
   Anlagen-Ids (nicht die Array-Identität — sonst bei jeder Hintergrund-Auffrischung). Solange die Fakten
   unbekannt sind, gilt `hatGeldWelt(sites)` von heute.
5. **Datenlage = Datenlage der Anlage**, bis AP-04 sie je Messstelle trägt: `siteStatus` → Wort des Vertrags
   `liefertDaten` → `aggregatLiefertDaten(…, 'anlage')`. Die Messstellen-Datenlage des Servers
   (`messen.datenlage`) steht nur im Satz der Messen-Zeile, nie in einer Summe.
6. **Die Standort-Karte steht am Rechner in `<th scope="rowgroup">`** — dort sind keine Überschriften erlaubt
   (der Name ist ein Knopf), und `.vp-at-gruppe th` hebt Versalien und `nowrap` des Tabellenkopfs auf.
7. **Funktionen:** `undefined` = lädt („Wird geladen …“), `null` = nicht abrufbar (eigener Satz); nie eine
   leere Zeile. Bei `kein_objekt` streicht `funktionsZeilen` den doppelten Funktionsnamen aus dem Server-Satz.
8. **Nicht hier:** Knöpfe „einrichten“/„aufnehmen“ und die Funktions-Karte (IP-8), Telefon-Leiste je Ebene
   (IP-7), Messstellen-Datenlage in der Kopfzeile (AP-04); die Erlöse-Welt selbst ist nur auf die
   Geld-Anlagen gefiltert, nicht umgebaut.
