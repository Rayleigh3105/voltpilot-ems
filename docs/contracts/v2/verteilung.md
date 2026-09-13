# Verteilungs-Vertrag: eine Messstelle auf Kostenstellen (UEMS AP-10)

Stand 13.09.2026 · Vertrag 1.1 · Konzept `data/vp-uems-ap10-bilanzen` §4.6, Entscheide E4, E11,
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

> **Wer anruft (Stand AP-10 IP-8):** der Schreibweg `PUT /api/v1/messstellen/{id}/verteilung`
> (`uems/VerteilungService` → `satz_ab_tag`), das Lesen `GET …/verteilung?am=` (`am_tag`) und der Leseweg
> des Formel-Terms (`AnteilLeseweg#lies` → `am_tag` + `term`). Tabelle `messstelle_verteilung`
> (`V20260913230000`). Kostenstellen-Lesemodell, Kaskade und Verteilen-Dialog kommen mit IP-11 und IP-15.

## 1. Die acht Regeln

| Regel | Was sie beantwortet |
|---|---|
| `satz` | §4.6: Darf dieser Verteilungs-Satz an diesem Tag geschrieben werden? |
| `am_tag` | §4.6/F12: Welche Zeilen gelten an diesem Tag — und was heißt „keine“? |
| `fassung` | §4.6: Was passiert mit der laufenden Fassung, wenn ab einem Tag eine neue gilt? |
| `satz_ab_tag` | AP-10 IP-8: Was schreibt `PUT …/verteilung` — ab einem Tag GENAU dieser Satz (Anteil, Ziel, Summe, Ende mit dem Ziel, Wiederholung, Korrektur, Fassung)? |
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
9. **Der Schreibweg ist EIN Satz ab einem Tag (`satz_ab_tag`, AP-10 IP-8).** Reihenfolge: jeder Anteil
   in (0, 100] mit höchstens EINER Nachkommastelle (33,33 % ist `anteil_ungueltig`, nie still
   gerundet) → `satz` (Ziel besteht, 100 %) → jede neue Zeile endet mit ihrem Ziel, und an keinem Tag
   danach bleibt ein Rest ≠ 100 % (50 % an 9000 + 50 % an 9100 ab 01.12.2026 ergäben ab 01.01.2027 nur
   50 % → `verteilung_summe` mit diesem Tag) → steht derselbe Stand schon da, ändert sich nichts
   (`unveraendert`: kein Protokoll, kein Ereignis) → mit `korrektur` werden die Zeilen, die GENAU am Tag
   beginnen, aufgehoben → `fassung`. Ein **leerer Satz** heißt ab dem Tag „nicht verteilt“ — nie
   „zu 0 % verteilt“. Die Datenbank hält die 100 % noch einmal **zur Commit-Zeit**: ein Satz mit zwei
   Zielen verschiebt Anteile zwischen ihnen und ist zwischen zwei Anweisungen nie 100 %.

## 2.1 Der Leseweg des Formel-Terms (AP-10 IP-5, eingelöst mit IP-8)

Ein Term der Art `verteilung` („4100 von MS-07“, `messstelle-formel.md` §1.1) liest den Anteil des
TAGES aus dieser Verteilung — über EINE Stelle, `uems/AnteilLeseweg#lies`. Seit AP-10 IP-8 liest sie die
Zeilen von `messstelle_verteilung` am Tag (`am_tag`) und rechnet `term`; ohne Zeile ist das Urteil
`nicht_verteilt`. Solange der Teil eines Messwerts (`anteil` = `positiv`/`negativ`) nicht lesbar ist
(AP-08 IP-7), lehnt sie **benannt** ab. Der Block `leseweg` der Vektor-Datei trägt die geschlossene Menge
dieser Ablehnungen mit Kundensatz, ihre Prüfreihenfolge und je Referenzfall (F1, F4, F11) das erwartete
Urteil samt `lesung` (`ganz` · `tagesanteil`). `verteilung_wartet_auf_ip8` gibt es nicht mehr. Der
TS-Zwilling bildet die Ablehnung nicht (`zwillinge_grund`).

## 3. Was hier NICHT steht

Die Tabelle und die Routen (gebaut mit IP-8 gegen diesen Vertrag, Wegweiser
`docs/agents/root/uems-verteilung.md`), das Kostenstellen-Lesemodell und die Korrektur-Kaskade (IP-11).

## 4. Herkunft der Zahlen

Alle Kennzeichen, Anteile und Beträge stammen aus
[`uems-referenzunternehmen.json`](./uems-referenzunternehmen.json) (Fassung 1.1);
`_abweichungen` nennt jede bewusste Abweichung von der Vorlage, `_nicht_geprueft` jede Erwartung
ohne Zwilling.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='VerteilungVectorsTest,AnteilLesewegVectorsTest,VerteilungSchnittstelleVertragTest')  # rein, kein Docker
(cd services/api && ./mvnw test -Dtest='UemsMessstelleVerteilungMigrationTest,VerteilungApiTest,MessstelleFormelVerteilungsTermApiTest')  # Docker
(cd frontend/portal && npx vitest run src/uemsVerteilung.test.ts)
```
