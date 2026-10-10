# UEMS-Fläche: der Ortsbaum „Standort › Gebäude“ mit Gebäude- und Bereich-Dialog (AP-02 IP-7)

Die zweite Portal-Fläche der Ortsstruktur: je Standort die Gebäude mit ihren Bereichen und der
Zweig „Direkt am Standort“, jede Zeile mit Nutzung, Fläche, Baujahr und der Datenlage aus dem
Messstellen-Register (Mockup T3); „Gebäude anlegen“ (T4), „Bereich anlegen“ (T5), Bearbeiten über
den Stift; ohne Gebäude und Bereiche der Leerzustand L1. Kein Backend, keine Migration: gelesen und
geschrieben über die Routen aus IP-5 (`uems-orte-schreibweg-gebaeude-bereich-fl.md`).

| Teil | Datei |
|---|---|
| Ableitung (rein): Baum aus der flachen Antwort, L1, Ziel-Regel, Formular, Prüfung, Anfragen | `frontend/portal/src/ortsbaum.ts` · `ortsbaum.test.ts` |
| Baum mit Leerzustand, lädt seinen Standort selbst | `src/components/Ortsbaum.tsx` (+ `.css`, `.test.tsx`) |
| Dialog Gebäude/Bereich (anlegen · bearbeiten) in der Schale des Standort-Dialogs (`vp-sd`) | `src/components/OrtDialog.tsx` (+ `.css`, `.test.tsx`) |
| Wirt heute | jede Karte der Liste „Standorte“ unter dem Standort-Kopf (`StandortePage`, `#/portfolio/standorte`) |
| Daten | `api.standortOrte`, `api.ortKurzzeichenVorschlag`, `api.ortAnlegen`, `api.ortBearbeiten`, `api.ortFlaeche` |
| 375/1440 px + Bilder | `e2e/ortsbaum.spec.ts` (Bühne `standorte.html`, Antworten `src/test/ortsbaumFixtures.ts`); `ORTSBAUM_BILDER=<Ordner>` legt Bilder und `messung-*.json` ab |

## Die Fallen

1. **„Woran darf was hängen“ wird AUFGERUFEN**: `zielPruefen` ruft `eintrag` aus `uemsOrtsbaum.ts`
   mit dem neuen Knoten ohne Intervall — derselbe Aufruf wie `OrtService.anlegen`. Die Zielliste
   „Hängt an“ (`bereichZiele`) filtert ihre Kandidaten durch genau diese Regel; ein Bereich als Ziel
   ist `ziel_art_unzulaessig` mit dem Satz des Vertrags (`ortsbaum.test.ts` prüft Satz = `eintrag`).
   Der Vertragsbaum kennt nur den Stichtag der Antwort — ein früheres „gültig ab“ urteilt der Server,
   sein Satz landet am Feld „Gültig ab“ (`ortFeldAusServer`: die Tages-Gründe meinen das Datum, auch
   wenn der Server `elternId` nennt).
2. **Die Datenlage zählt Register-ZEILEN, nicht Quellen.** Das Gebäude umfasst seine Bereiche;
   Bereiche und „Direkt am Standort“ umfassen jeweils ihre eigenen Knoten. Der Satz
   „n von m Messstellen liefern Daten“ kommt aus derselben Aggregat-Rechnung wie Standort und
   Unternehmen. Die Messstellen-Zahl ist nur Fallback für Antworten eines älteren Servers.
3. **Die Datenlage bleibt am Telefon eine Zeile**, ab 520 px Baumbreite (Container-Abfrage) eine
   Spalte rechts. Gemessen (Werk Ahrenberg): 1440 px Baum 731 → 566 px, 375 px bleibt 833 px.
   Zeilen ohne Stift („Direkt am Standort“) halten den 40-px-Platz, sonst stünde die Spalte schief.
4. **Kurzzeichen werden vorgeschlagen, nicht festgelegt.** `GET …/orte/kurzzeichen-vorschlag?art=`
   liefert die nächste freie G-n/B-n-Nummer, ohne den Zähler zu bewegen; das Dialogfeld ist damit
   vorbelegt und bleibt überschreibbar.
5. **Fläche**: beim Anlegen die erste Fläche ab „Gültig ab“ (= erster Tag des Knotens, POST
   `flaecheM2` + `gueltigAb`); beim Bearbeiten nur, solange es keine gibt („für kWh/m² fehlt die
   Fläche — Fläche eintragen“ öffnet den Dialog an der Fläche) — erst PUT der Stammdaten, dann PUT
   `…/flaeche`. Eine vorhandene Fläche steht lesend da; „Fläche ändern“ darunter öffnet den Flächen-Dialog mit Verlauf (IP-8, `uems-flaeche-aendern-portal.md`).
6. **„Hängt an“ nur beim Anlegen eines Bereichs**; beim Bearbeiten lesend — umhängen ist Verschieben
   mit „gültig ab“ (IP-12). L1 „Bereich direkt am Standort anlegen“ wählt den Standort vor und sendet
   OHNE `elternId`. Ohne Wahl steht der Vertrags-Satz am Feld, nie eine stille Vorbelegung.
7. **L1 nur ohne Gebäude UND ohne Bereiche**; hängen schon Messstellen direkt am Standort, steht der
   Zweig „Direkt am Standort“ unter dem Hinweis. Den Zweig gibt es nur, wenn dort etwas hängt.
8. **E2E-Routen**: `**/api/v1/standorte**` trifft auch `…/{id}/orte` — `standorte.spec.ts` reicht
   diese Pfade weiter (`fallback`), sonst bekäme der Baum die Standort-Liste.
9. **Nicht hier:** Verschieben (IP-12, `uems-ort-verschieben.md`), Archivieren/Löschen von Orten (IP-15, `uems-ort-archivieren.md`),
   Fläche ändern mit Verlauf (IP-8), eine eigene Seite „Standort › Gebäude“
   (kommt mit der Ebenen-Navigation aus AP-01 IP-5/IP-7 — `Ortsbaum` zieht unverändert um).
   „Stand am …“ (IP-13): der Baum nimmt `stichtag` und bietet dann nichts an (`uems-stand-am-portal.md`).

## Prüfen

```bash
(cd frontend/portal && npx vitest run src/ortsbaum.test.ts src/components/Ortsbaum.test.tsx src/components/OrtDialog.test.tsx src/pages/StandortePage.test.tsx src/copy.test.ts)
(cd frontend/portal && npx playwright test e2e/ortsbaum.spec.ts e2e/standorte.spec.ts --project=desktop-chromium)
```
