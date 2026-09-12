# Verteilungs-Vertrag: eine Messstelle auf Kostenstellen (UEMS AP-10)

Stand 12.09.2026 · Vertrag 1.0 · Konzept `data/vp-uems-ap10-bilanzen` §4.6, Entscheide E4, E11,
E12, E13 vom 12.09.2026.

Eine **feste Verteilung** ist eine eigene zeitgültige Beziehung **Messstelle → Kostenstelle** mit
Anteil (Tage, Muster A). Sie verteilt MENGEN, nie Stammdaten, und sie wirkt je Tag auf die
Tagesmenge.

| Datei | Rolle |
|---|---|
| [`verteilung-vectors.json`](./verteilung-vectors.json) | **die eine Wahrheit**: die Referenzfälle F3, F6, F10–F13 mit Eingang und erwartetem Ergebnis je Prüfung |
| [`verteilung.schema.json`](./verteilung.schema.json) | das Schema für Vokabulare, Regeln und die Vektor-Datei selbst (JSON-Schema 2020-12) |
| `services/api/.../uems/VerteilungRegeln.java` | der **Java-Zwilling** (rein: ohne Spring, ohne DB, ohne Uhr) |
| `frontend/portal/src/uemsVerteilung.ts` | der **TypeScript-Zwilling** |
| `…/uems/VerteilungVectorsTest.java` · `…/src/uemsVerteilung.test.ts` | beide fahren DIESELBE Vektor-Datei, per Pfad |

**Wer eine Regel ändert, ändert die Vektor-Datei UND beide Zwillinge.**

> **Wer anruft (Stand AP-10 IP-1): niemand.** Die Tabelle `messstelle_verteilung`, die Routen und
> der Verteilen-Dialog kommen mit IP-7, IP-8, IP-11 und IP-15.

## 1. Die sieben Regeln

| Regel | Was sie beantwortet |
|---|---|
| `satz` | §4.6: Darf dieser Verteilungs-Satz an diesem Tag geschrieben werden? |
| `am_tag` | §4.6/F12: Welche Zeilen gelten an diesem Tag — und was heißt „keine“? |
| `fassung` | §4.6: Was passiert mit der laufenden Fassung, wenn ab einem Tag eine neue gilt? |
| `mengen` | E12/F13: Wie viel bekommt jedes Ziel über eine Periode? |
| `erbe` | §4.5: Was erbt der verteilte Wert von seiner Quelle? |
| `term` | E11/F11: Wie liest ein Formel-Term „Anteil 4100 von MS-07“? |
| `herkunft` | §4.7/E13: Woher kommt dieser verteilte Wert? (gemeinsam mit [`bilanzwert-herkunft.md`](./bilanzwert-herkunft.md)) |

## 2. Die Fallen

1. **Ein Satz wird als GANZES geschrieben.** Alle Ziele eines Tages kommen in einer Anfrage —
   anders ließen sich die 100 % gar nicht prüfen. 110 % werden abgelehnt (`verteilung_summe` mit
   Summe und Tag), nie stillschweigend normiert; 0 % ist keine Zeile, sondern ein Fehler.
2. **Es gilt die TAGES-Regel, kein Stichtag.** Ändert sich die Verteilung am 15.01., rechnet der
   Januar mit 14 Tagen zu 70 % und 17 Tagen zu 60 % (F13: 10 000 kWh). Ein Stichtag-Lesen ergäbe
   9 300 kWh — um 700 kWh daneben. Deshalb verlangt `mengen` Tagesmengen, sobald sich die
   Verteilung innerhalb der Periode ändert, und lehnt sonst mit `tagesmengen_noetig` ab: einen
   Periodenbetrag anteilig aufzuteilen hieße, die Tagesmengen zu erfinden. Deckt genau EIN
   Abschnitt die ganze Periode, genügt der Periodenbetrag — das Ergebnis ist dann exakt dasselbe.
3. **Ein Anteil endet mit seinem Ziel.** Endet die Kostenstelle 9000 am 31.12.2026, ist MS-03 im
   Januar 2027 „nicht verteilt“ — der Anteil wandert NIE still auf einen Nachfolger (F12).
   „Nicht verteilt“ ist ein Zustand, kein Fehler.
4. **Ein verteilter Wert wird nie ein gemessener.** Er erbt Zustand, Abdeckung, Version UND die
   Kennzeichen seiner Quelle und bekommt „verteilt (n % von MS-xx)“ dazu. Ein verteilter Rest trägt
   deshalb weiter „berechnet (Differenz)“ (F3) — drei Wörter, nie vermischt.
5. **Zwei Quellen werden NICHT verteilt**: eine ohne Werte, und ein unplausibler (negativer) Rest.
   Das Ziel bekommt dann „keine Werte (Rest unplausibel)“ — nie einen negativen
   Kostenstellen-Wert (F6).
6. **Ein Verteilungs-Term verweist, er kopiert nicht.** „Anteil 4100 von MS-07“ liest den Anteil
   des Tages; ein eingetragener Faktor 0,7 wird abgelehnt (`verteilungs_term_ohne_faktor`), weil er
   der Verteilung davonliefe, sobald sie sich ändert (F11).
7. **Keine dynamischen Schlüssel.** Kein Anteil aus Messwerten, Flächen, Stückzahlen oder
   Betriebsstunden — Grenze des Captains (AP-09 S2). Was verteilt wird, hat jemand eingetragen.
8. **Rückwirkend ist erlaubt, aber nie unsichtbar.** Eine Fassung mit Beginn vor heute trägt ihr
   Abzeichen samt Zahl der Tage; eine Fassung, die vor der laufenden beginnt, überlappt und wird
   abgelehnt.

## 3. Was hier NICHT steht

Die Tabelle mit ihrem Commit-Zeit-Trigger für die 100 %, die Routen `PUT …/messstellen/{id}/verteilung`
und `GET …/verteilung?am=`, das Kostenstellen-Lesemodell und die Korrektur-Kaskade. Sie kommen mit
IP-8 und IP-11 — gegen diesen Vertrag.

## 4. Herkunft der Zahlen

Alle Kennzeichen, Anteile und Beträge stammen aus
[`uems-referenzunternehmen.json`](./uems-referenzunternehmen.json) (Fassung 1.1);
`_abweichungen` nennt jede bewusste Abweichung von der Vorlage, `_nicht_geprueft` jede Erwartung
ohne Zwilling.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='VerteilungVectorsTest')      # rein, kein Docker
(cd frontend/portal && npx vitest run src/uemsVerteilung.test.ts)
```
