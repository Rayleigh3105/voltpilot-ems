# UEMS AP-13 IP-1: Grund-Sätze, Oberflächen-Wörter, Referenzfälle und das reine Modul

Angelegt am 15.09.2026. Das erste Bau-Paket der Messdaten- und Analyseoberflächen (AP-13). Es baut keine Fläche, legt
aber fest, was die Folgepakete IP-2 … IP-14 sprechen und lesen.

| Was | Wo | Test |
|---|---|---|
| Block `grund`: acht Codes der Werte-Route, je EIN Satz | `docs/contracts/v2/ergebnis-zustand-vectors.json` 1.11, Prosa `ergebnis-zustand.md` §9 | Java `ErgebnisZustandVectorsTest` ⟷ TS `uemsErgebnis.test.ts` (Familie `grund`) |
| Sprecher | Java `uems/ErgebnisZustand.grundSatz` ⟷ TS `uemsErgebnis.grundSatz` | dieselbe Vektor-Datei per Pfad |
| Kundenwörter | `frontend/portal/src/glossar.ts` (`UEMS_WERTE` … `UEMS_MANUELL_ABGELESEN`), `docs/fachmodell/glossar.md` (Nachträge Werte, Verlauf, Vergleich, Datenlage, Grund) | `copy.test.ts` Block „Welt Oberflächen“ |
| Referenzfälle O1…O19 | `frontend/portal/src/test/oberflaechenFaelle.json` — Byte-Kopie von `data/vp-uems-ap13-oberflaechen/referenzfaelle.json` | `uemsOberflaechen.test.ts` › Gleichheit |
| Reines Modul | `frontend/portal/src/uemsOberflaechen.ts`: `passend`, `kacheln`, `sprungziel`, `verlaufRaster`, `zoneSatz` | `uemsOberflaechen.test.ts` (O10, O12, O14, O17) |

## Die Fallen

1. **Ein Grund, EIN Satz — und der Satz behauptet nichts, was die Route nicht liefert (D5).** Drei Sätze weichen vom
   Vorschlag O15 ab (firstmate 001 vom 15.09.2026 = A): `noch_nicht_gebildet` spricht den Satz der Tageskarte
   (`UEMS_NOCH_NICHT_GERECHNET_SATZ`, zeichengleich geprüft), `ohne_menge_gespeichert` sagt nicht „Zustand bekannt“
   (die Route liefert `zustand = null`, auch an Zeiträumen), `berechnet` verspricht keine Tageswerte (eine Formel aus
   Momentanwerten hat keine). Begründung im Block `befunde` und in `data/vp-uems-ap13-oberflaechen/befunde-ip1.md`.
2. **Die Codes sind die der Route.** Java prüft `GRUENDE` gegen `MessstelleWerteRegeln.OhneZahl` in Reihenfolge. Ein
   neunter Grund der Route macht den Vektor-Test rot — dann Satz in Vektor-Datei, `ErgebnisZustand` und
   `uemsErgebnis.ts`. Die API gibt nur Codes; der Java-Zwilling spricht nur im Test.
3. **Die Portal-Kopie wird nie von Hand bearbeitet.** Ändert das Konzept seine Fälle: neu kopieren und
   `REFERENZFAELLE_SHA256` mitziehen. `ABWEICHUNGEN` nennt GENAU die drei Codes, deren Wortlaut von O15 abweicht; eine
   vierte oder eine still zurückgenommene macht den Gleichheitstest rot. Die Bühne lädt die Kopie, nie `docs/contracts`.
4. **„Abdeckung“ nur im Bestand (W7).** `ABDECKUNG_BESTAND` in `copy.test.ts` ist die Liste von heute; eine
   Oberflächen-Datei sagt „Verlauf n %“ (`UEMS_VERLAUF_PROZENT` = `satz.abdeckung`). Wer eine Fläche baut, trägt sie in
   `FLAECHEN` des Blocks ein, ein Diagramm in `CHART_FILES_OBERFLAECHEN` (vorbereitet, leer).
5. **Das Modul rechnet nichts** — keine Menge, keine Summe, kein Δ; Zahlen sprechen die Zwillinge. `kacheln` wirft
   Kacheln unter der Schwelle NICHT weg (anders als `ebenenLeiste`); eine Kachel gibt es nur mit Seite in
   `EBENEN_SEITEN`. `sprungziel` gibt `null` für Objekte ohne Seite (Bezugsgröße, Ereignis, Box; Kostenstelle und
   Gebäude bis IP-9/IP-2) — keine Fläche dafür erfinden. `periode=`/`version=` hängen am Hash, `parseRoute` liest
   dieselbe Seite; auswerten muss sie IP-3.
6. **Der Tag im Verlauf sind Viertelstunden (E5).** O14 „25 Balken“ ist ein Befund: der 25.10.2026 hat 100
   Viertelstunden; 25 sind die Zeilen der Stundenliste an der Karte.
