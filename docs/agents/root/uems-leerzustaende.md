# UEMS-Fläche: Karte „Funktionen", Leerzustände und Geld-Regel je Anlage (AP-01 IP-8)

Neu am 14.09.2026. Kein Backend, keine Migration. Gelesen werden `GET /api/v1/funktionen` (IP-3,
`uems-funktionen-routen.md`) und die Zeile der Übersicht (`roleCounts`) — dieselben Fakten wie in der
Übersicht aus IP-6 (`uems-unternehmens-uebersicht.md`). Captain-Vorgabe 10.09.2026: „Die Messdatenkunden
brauchen keine Geldanzeige."

| Teil | Datei |
|---|---|
| Geld-Regel je Anlage: `anlageOhneGeld` (= `geldAnlagen` der Ebene), `ohneGeld` (Blöcke, Ströme, Ansichten), vollständige Einordnung `GELD_BAUSTEIN`/`GELD_BLOCK`/`GELD_ANSICHT`, `GELD_UNTERSEITEN` aus `VERLAUF_TABS` | `frontend/portal/src/anlageGeld.ts` · `anlageGeld.test.ts` |
| Verdrahtung: `useAnlageSurface` holt die Funktionen IN der Cockpit-Entscheidung (die Übersicht nur für Anlagen auf einer Ebene) und gibt die Projektion mit `geldfrei` zurück; `AnlagenPage` filtert `verfuegbar` (`bausteineOhneGeld`) und zeigt auf einer Geld-Unterseite die Messwerte (`unterseiteOhneGeld`) | `src/useAnlageSurface.ts`, `src/pages/AnlagenPage.tsx`, `src/surface.ts` (`geldfrei?`) · `pages/AnlagenPage.test.tsx` |
| Steuerung einer Anlage, die nur misst: seit 15.09.2026 KEIN Hinweis mehr (Steuern-Regel, `uems-steuern-still.md`) — Seite und Zonen bleiben | `pages/SteuerungSection.tsx` · `pages/SteuerungSection.test.tsx` |
| Karte „Funktionen" (unter der Anlagen-Tabelle beider Ebenen) und Leerzustand der Standort-Übersicht: `funktionenKarte` (Steuern nur mit teilnehmender Anlage), `standortLeerzustand` | `src/uebersicht.ts`, `components/FunktionenKarte.tsx`, `components/PortfolioCockpit.tsx` · `funktionenKarte.test.ts`, `components/Uebersicht.test.tsx` |
| 375/1440 px + Bilder | `e2e/leerzustaende.spec.ts` auf `startansicht.html` (`ansicht=steuerung-halle2`, `ansicht=steuerung-lindach`, `bild=vor-lindach&ansicht=lindach`); `LEERZUSTAENDE_BILDER=<Ordner>` |

## Die Fallen

1. **Der nächste Schritt ist ein benannter Hinweis, kein Knopf** (Captain zu PR 771): die Assistenten
   IP-9a/IP-10a gibt es noch nicht, ein Knopf ohne Ziel wäre eine Sackgasse. Heute steht darum nirgends ein
   Knopf (das frühere „Gerät anbinden" der Steuerungsseite ist mit der Steuern-Regel entfallen). Kommt ein Assistent, wird sein Hinweis
   zum Einstieg; die Tests prüfen „kein Knopf" ausdrücklich und werden dann bewusst angepasst. Seit IP-9a gibt es
   das ZIEL für Messen (`MessenAssistent`, Text und Start aus `messenAssistent.messenEinstieg`,
   `uems-messen-assistent.md`) — der Knopf selbst ist eine eigene Entscheidung und noch nicht gesetzt.
2. **Schritte aus dem ZUSTAND, nie aus `aktionen`.** Der Server nennt dort nur starten, anhalten, fortsetzen
   und beenden (`FunktionService.ANLAGEN_AKTIONEN`/`STANDORT_AKTIONEN`). Die Fixture `funktionenFixtures.ts`
   trägt `einrichten`/`aufnehmen` trotzdem — nicht darauf bauen.
3. **Geld je Anlage folgt grundsätzlich demselben Fakt wie auf der Ebene; W7 erhält jedoch auf den
   Anlagenflächen bei `tarifArt` `fest`/`dynamisch` die tarifbasierten Kosten, während `geldAnlagen` der
   Ebene unverändert bleibt:** `geldAnlagen` über `roleCounts` (Katalog-Kategorie)
   und die aktive Teilnahme. Nie die AE7-Signale `hasPv`/`hasStorage` — sie lesen gemessene Rollen und dürften
   über dieselbe Anlage Verschiedenes sagen. Die Regel greift nur für Anlagen in `GET /funktionen`; ohne
   Funktionen oder ohne Standort bleibt alles zeichengleich (Betreiber, ältere Backends). Ohne Zeile der
   Übersicht zählt keine Rolle — unbekannt ist nie „erlaubt".
4. **In der Entscheidung laden, nicht danach:** `useAnlageSurface` wartet auf die Funktionen, sonst stünde das
   Geld einen Augenblick da und verschwände. Die Übersicht kommt nur für Anlagen auf einer Ebene dazu.
5. **Wer einen Cockpit-Baustein, einen Block oder einen Verlauf-Reiter ergänzt, ordnet ihn in `anlageGeld.ts`
   ein.** Die `Record`-Typen erzwingen es, `anlageGeld.test.ts` vergleicht mit `CANONICAL_DESKTOP`/
   `CANONICAL_PHONE` und `VERLAUF_TABS`, und der Render-Test in `AnlagenPage.test.tsx` sucht mit JEDER
   Geld-Quelle (Netto, Leistungspreis, dynamischer Tarif, Markt) nach Euro im Text — samt Gegenprobe.
6. **Die Steuerungsseite einer Anlage, die nur misst, trägt KEINEN Hinweis** (Steuern-Regel 15.09.2026,
   `uems-steuern-still.md`): kein „aufnehmen", kein „einrichten", kein „Gerät anbinden" — auch nicht, wenn am
   Standort eine andere Anlage steuert. Die Zonen bleiben die Wege (Steuerart, „＋ Neue Regel", „Komponente
   anlegen", Schutz): nie einen Hinweis ergänzen, der sie anpreist, und nie die Zonen wegnehmen.
7. **Der Leerzustand der Standort-Übersicht zählt am Lese-Modell der Standorte** (`standort.anlagen`), nicht an
   den Zeilen der Übersicht. Hat der Mandant gar keine Anlage, greift vorher der bestehende Zustand
   „Noch keine Anlage" des Cockpits.
8. **Kopf und Karte nennen auf der Standort-Übersicht denselben Zustand** (zwei Sätze doppelt). Tests aus IP-6
   suchen diese Sätze darum `within('.vp-portfolio-funktionen')`, nicht seitenweit.

## Prüfen

```bash
(cd frontend/portal && npx vitest run src/anlageGeld.test.ts src/funktionenKarte.test.ts \
  src/pages/AnlagenPage.test.tsx src/pages/SteuerungSection.test.tsx src/components/Uebersicht.test.tsx)
(cd frontend/portal && npx playwright test e2e/leerzustaende.spec.ts --project=desktop-chromium)
```
