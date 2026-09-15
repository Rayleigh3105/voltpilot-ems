# UEMS — Übersichts-Bausteine je Ebene (AP-13 IP-7)

Konzept: AP-13 §4.4 (Ü1–Ü5), Kästen E3 = A und E13 = A, Referenzfälle O2/O3 (`frontend/portal/src/test/oberflaechenFaelle.json`).

## Was wo steht

- **Ort (Ü1):** Unternehmens- und Standort-Übersicht (`PortfolioCockpit` mit `ebene`), unter der Anlagen-Tabelle, vor der Karte „Funktionen“. Nicht auf „Standort › Anlagen“ (`nurAnlagen`), nie auf der Flotte eines Betreibers.
- **Rein:** `frontend/portal/src/uebersichtBausteine.ts` — `messstellenBaustein`, `energiebilanzBaustein`, `gebaeudeZeilen`, `kennzahlenDerEbene`, `bausteineMitInhalt`, Zeitraum-Helfer (`letzterGebildeter`, `blaettere`, `laeuftNoch`). Tests: `uebersichtBausteine.test.ts` (O2, O3, O4-Gegenprobe).
- **Laden + Render:** `components/UebersichtBausteine.tsx` (`useUebersichtBausteine`). Die Listen-Karte der Kennzahlen und ihr Lade-Hook sind nach `components/KennzahlListe.tsx` gezogen (dieselbe Karte wie „Unternehmens › Kennzahlen“).
- **Katalog:** `anwendungen/catalog.json` (Portal UND `services/api/src/main/resources`, byte-gleich) Bausteine `messstellen` · `energiebilanz` · `kennzahlen`, beigesteuert von `monitoring`; `portfolioCockpit.ts` `UEMS_UEBERSICHT_BAUSTEINE` — angeboten nur mit Ebene UND Inhalt (`verfuegbareBausteine({ uebersicht: { uems } })`), „Anpassen“ darf sie ausblenden.

## Quelle je Baustein (nichts wird im Portal gezählt oder gerechnet)

| Baustein | Quelle | Sprung |
|---|---|---|
| Messstellen | `GET /api/v1/messstellen` → `aggregat` wörtlich (Unternehmen + je lebendem Standort) | Standort › Messstellen bzw. Unternehmen › Messstellen |
| Energiebilanz | `GET /api/v1/sites/{id}/bilanz?periode=&am=` je Anlage der Ebene → Periodenwert des Hauptzählers (Eingang `zufluss`) → `uemsBilanz.ebene` („x von y Systemen“, „mindestens … (… fehlt)“); im Unternehmen zusätzlich je Standort | Anlage › Messwerte (bis AP-13 IP-8 den Reiter „Energiebilanz“ baut) |
| Gebäude-Zeilen (nur Standort, im Baustein Energiebilanz) | Ortsbaum `GET …/standorte/{id}/orte`; Register `?ort=<Kurzzeichen>` heute (Datenlage) und `&stichtag=<letzter Tag des Zeitraums>` („im Gebäude“); Zahl über `uemsBilanz.gebaeude` aus den Eingängen `zugeordnet` | Standort › Gebäude |
| Kennzahlen | `GET /api/v1/kennzahlen` (lebend, Geltung in der Ebene) + Werte je Karte | Kennzahl-Seite |

Zeit-Leiste: Tag · Monat · Jahr (die Bilanz-Route kennt keine Woche), Vorgabe = letzter GEBILDETER Monat in der Zone des Standorts (Unternehmen: `VORGABE_ZEITZONE`); ein laufender Zeitraum zeigt `UEMS_NOCH_NICHT_GERECHNET_SATZ`, keine Zahl.

## E13 — die Datenlage-Zeile der Karte „Funktionen“

- `FunktionZustandAbleitung.datenlage(registerZeilen, manuell)` ⟷ `uemsFunktion.datenlage`; Eingang `register_zeilen` im Vertrag `funktion-zustand` (Schema + Vektoren, zwei E13-Fälle). `FunktionService.messenEingang` füllt ihn aus `MessstelleRegisterService.aggregatZustand` — EINE Stelle für Register, Baustein und Karte.
- Die Prüfliste (was fehlt, was blockiert) liest weiter nur die gemessenen, nicht archivierten Messstellen — Zustand und `fehlt` ändern sich nicht.
- Beweis: `FunktionApiTest.dieDatenlageVonMessenIstDieZaehlungDesRegisters` (vorher „1 von 1 Messstelle liefert Daten“, nachher = Register „1 von 3 Messstellen liefert Daten“).

## Fallen

- ⚠ **Archivierte Messstellen stehen im Register und damit im Nenner** — das war vor IP-7 an der Karte „Funktionen“ nicht so. Wer das ändern will, ändert das Register-Aggregat (dann folgen Baustein und Karte von selbst), nie nur eine Stelle.
- ⚠ **Keine Abgabe-Summe:** die Bilanz-Route liefert nur Hauptzähler BEZUG (`BilanzService.hauptzaehlerDerAnlage`); „Netzeinspeisung … · 1 von 3 Systemen“ aus O2 ist nicht gebaut.
- ⚠ **Wechselt der Hauptzähler im Zeitraum** (mehrere Abschnitte), hat die Anlage keine EINE Zahl — sie zählt ohne Zahl, die Summe sagt „mindestens“, die Zeile nennt den Grund.
- ⚠ **Register-Filter `ort` mit Kurzzeichen senden:** die Route nimmt ID oder Kurzzeichen; die Bühnen-Fixtures von Register und Ortsbaum haben verschiedene Ort-IDs.
- ⚠ **Bühne:** Werte nur aus O2 (Oktober 2026), O4 (Halle 2) und O3 (Lindach, 18.10.2026) — `test/bilanzFixtures.ts`; jeder andere Zeitraum „keine Werte“. O2 braucht die Uhr ≥ 01.11.2026 (die Anlagen-Zeilen bleiben die Momentaufnahme vom 20.10.).
- ⚠ **O2/O3 „4 von 4“ für Werk Lindach** ist eine Annahme des Konzepts (MS-22 über die Stellung); das Register verortet nach dem ORT und sagt „3 von 3“ — der Baustein spricht das Register.
