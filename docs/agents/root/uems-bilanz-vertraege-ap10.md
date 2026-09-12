# UEMS-Bilanz-Verträge (AP-10 IP-1): Bilanz, Verteilung, Netzanschluss, Bilanzwert-Herkunft

Das ERSTE Bau-Paket der Energiebilanzen. Es legt die Verträge, gegen die alle folgenden AP-10-Pakete
gebaut werden, und **ändert kein Verhalten**: keine Migration, keine Tabelle, keine Route, keine
Portal-Fläche, kein Produktionsweg. Niemand ruft die neuen Regeln an.

| Was | Wo |
|---|---|
| Prosa | `docs/contracts/v2/bilanz.md` · `verteilung.md` · `netzanschluss.md` · `bilanzwert-herkunft.md`, additiv erweitert `messstelle-formel.md` |
| Vektoren + Schema | `bilanz-vectors.json` · `verteilung-vectors.json` · `netzanschluss-vectors.json` (+ je `.schema.json`), dazu `bilanzwert-herkunft.schema.json` |
| Java-Zwillinge | `services/api/.../uems/BilanzAbleitung`, `BilanzwertHerkunft`, `VerteilungRegeln`, `NetzanschlussRegeln` |
| TS-Zwillinge | `frontend/portal/src/uemsBilanz.ts`, `uemsVerteilung.ts`, `uemsNetzanschluss.ts` |
| Tests (rein, kein Docker) | `BilanzVectorsTest`, `VerteilungVectorsTest`, `NetzanschlussVectorsTest` · `uemsBilanz.test.ts`, `uemsVerteilung.test.ts`, `uemsNetzanschluss.test.ts` |

```bash
(cd services/api && ./mvnw test -Dtest='BilanzVectorsTest,VerteilungVectorsTest,NetzanschlussVectorsTest')
(cd frontend/portal && npx vitest run src/uemsBilanz.test.ts src/uemsVerteilung.test.ts src/uemsNetzanschluss.test.ts)
```

## Die zwei neuen Formel-Typen (E1) und ihre FESTE Ergebnis-Richtung

Neben der gewichteten Summe aus PR #688 gibt es zwei Typen:

- **`rest`** — die Bilanz eines Hauptzählers: Zuflüsse minus Abflüsse minus zugeordnete
  Unterzähler. Er speichert **keine Terme**: seine Fassung wird je Tag aus der **Stellung**
  abgeleitet (AP-04). Zieht ein Unterzähler in ein anderes System um, ändern sich beide Reste am
  selben Tag, ohne dass jemand eine Formel anfasst.
- **`saldo`** — Bezug minus Abgabe derselben Grenze; Ergebnis `Wirkenergie · saldiert`, ein
  additiver Katalog-Eintrag **nur für `art = berechnet`**, nie an einem Messkanal bindbar.

⚠ **Die Richtung ist JE TYP eine Regel, keine Ableitung aus Vorzeichen.** `rest` ergibt fest
Wirkenergie · **Bezug**: 100 − 60 − 30 = 10 kWh Bezug, nicht „richtungslos“. Genau daran hängt die
Plan-Abnahme des Captains (Fall F1). Der Live-Wert eines `rest` ist dagegen ein Momentanwert und
trägt die Katalog-Richtung der Wirkleistung (`richtungslos`) — E1 greift nur auf der Mengen-Ebene.

## Das Verhältnis zu PR #688 und PR #689 (E7 = A: übernehmen und nachziehen)

Der Gesamtwert als gewichtete Summe (PR #688) und seine Portal-Fläche (PR #689) sind **vor** diesem
Konzept gebaut worden und stammen nicht aus dieser Programm-Reihe. Sie bleiben; kein Paket löst sie
ab.

- `messstelle-formel.md` ist **additiv** erweitert (§0 Typen, §1.1 Term-Art `verteilung` +
  `anteil`, §2.1 Richtung je Typ, §6 Fassungen). §1–§5 gelten unverändert, die Vektoren
  `messstelle-formel-vectors.json` sind **nicht angefasst**.
- `BilanzAbleitung.richtung` und `.live` **rufen** `MessstelleFormelRegeln.formelGroesse` bzw.
  `.gewichteteSumme` auf, statt sie nachzubauen; `uemsBilanz.ts` tut dasselbe mit
  `uemsMessstelleFormel.ts`. Zwei Summen für dieselbe Aussage wären genau die Drift, die diese
  Verträge verhindern.
- Alle neuen Vertragsfelder sind **snake_case wie `MessstelleFormelDto`** (`terme[].entity_id`,
  `formel_vorhanden`, neu `terme[].verteilung_ziel`, `terme[].anteil`). Die 689-Falle: `request()`
  wandelt nichts um — ein camelCase-Feld wäre im Portal still `undefined`.
- Das **Nachziehen des Codes** ist NICHT dieses Paket: Fassungen = IP-3, die Typen im Formel-Modul
  und der Katalog-Eintrag `Wirkenergie · saldiert` = IP-4, die Term-Art `verteilung` = IP-5, die
  Quelle des Verlaufs = IP-10.

## Fallen, die einmal teuer wären

1. **Summe und Differenz verhalten sich gegensätzlich, wenn ein Eingang fehlt.** Die Summe rechnet
   weiter und heißt „mindestens 1 055 kWh (MS-14 fehlt)“; sie ist dann höchstens „unvollständig“ —
   „keine Werte“ heißt eine Summe erst, wenn KEIN Eingang einen Wert hat. Die Differenz rechnet gar
   nicht: 1 200 − 1 055 wäre zu HOCH, weil der fehlende Unterzähler im Abzug fehlt.
2. **Eine Differenz ist eine Differenz.** `verbotene_woerter` in `bilanz-vectors.json` hält jeden
   Kundensatz und jedes Kennzeichen von „Verlust“/„Schwund“/„Diebstahl“ frei; beide Vektor-Tests
   prüfen das. Ein negativer Rest heißt „Messwerte passen nicht zusammen (−5 kWh)“ — mit dem
   Minuszeichen U+2212, nicht dem ASCII-Bindestrich — und wird nie auf 0 geklemmt.
3. **Nicht jedes Kennzeichen erbt.** `kennzeichen_erbend` (Muster + Wortlaut) sagt: es erbt, was
   über die PERIODE spricht („ab 15.10.2026“, „mit Ersatzwert“) und „verteilt (…)“ als „enthält
   verteilt (…)“ — nicht, was über einen einzelnen Messwert spricht („nachgeliefert“). Jedes
   Eingangs-Kennzeichen bleibt je Eingang in der Herkunft sichtbar.
4. **Verteilungen wirken je TAG, nie zum Stichtag.** Ein Periodenbetrag über einen Fassungswechsel
   wird nicht geteilt, sondern verlangt Tagesmengen (`tagesmengen_noetig`) — anteilig schätzen
   hieße, die Tagesmengen zu erfinden (F13: 10 000 statt 9 300 kWh).
5. **Der Netzanschluss bekommt in AP-10 nur den Träger.** Preis- und Grenzspalten bleiben an der
   Anlage; die Auswirkungs-Karte des Fachmodells (`docs/fachmodell/auswirkungen.md`) sagt seit
   diesem Paket „bleibt — bis zum Paket ‚Netzanschluss-Preisblatt‘“ statt „zieht mit AP-10 um“ (W9).
   Die Kopfzeile ZEIGT die vereinbarte Leistung; geprüft wird sie erst in AP-15
   (`grenze_geprueft` ist immer `false`).
6. **Die Vektoren des Netzanschlusses liegen in einer EIGENEN Datei**, nicht in
   `ortsbaum-vectors.json` wie im Konzept-Schnitt vorgesehen — diese Datei gehört AP-02 und wird von
   `OrtsbaumAbleitung` gefahren. `_abweichungen` in `netzanschluss-vectors.json` nennt den Grund;
   IP-6 füllt weiterhin das Feld `netzanschluss` der Anlage im Standort-Lesemodell.

## Wie die Dateien entstanden sind

Alle drei Vektor-Dateien sind aus `data/vp-uems-ap10-bilanzen/referenzfaelle.json` **erzeugt**, nicht
abgeschrieben — die Zahlen sind byte-genau die der Vorlage. Drei Blöcke machen das prüfbar und
werden von beiden Zwillingen gelesen:

- **`zwillinge`** sagt je Regel, WER sie prüft; **`zwillinge_grund`** nennt je Lücke den Grund. Ohne
  Grund gibt es keine Lücke — der Test bricht.
- **`_abweichungen`** nennt jede Stelle, an der die Vektor-Datei bewusst von der Vorlage abweicht
  (mit Grund), **`_nicht_geprueft`** jede Erwartung der Vorlage, die kein Zwilling nachrechnet.
  Fall F19 (Rechte) steht dort: die neuen Kennungen tragen IP-3/IP-6/IP-7/IP-8 als Nachtrag in
  `rechte-matrix.json`; dieser Vertrag baut die Rechte-Ableitung von AP-03 nicht nach.

Die Ergänzung der Referenzdatei auf Fassung 1.2 (E19: MS-22, die Tageswerte des 18.10.2026, MS-04
Laden/Entladen als Zahlen, MS-09 = 54 580, das Ende der 9000-Anteile) ist ein **eigenes Paket**
(AP-10 IP-2). Die Fälle rechnen nach der Ergänzung unverändert weiter; bis dahin steht sie in
`referenz_stand` und je Fall unter `annahmen`.
