# UEMS-Kennzahl-Vertrag (AP-11 IP-1 bis IP-3): Vertrag, Referenzdatei 1.3, Regel-Module

Das Fundament des Kennzahlenbaukastens. Es legt den Vertrag, gegen den alle folgenden AP-11-Pakete gebaut werden, und
**ändert kein Verhalten**: keine Migration, keine Tabelle, keine Route, keine Fläche, kein Rechenlauf. Niemand ruft die
Regeln an (Tabellen IP-4, Routen IP-5, Lauf IP-6, Werte IP-7, Kaskade IP-8/IP-9, Portal IP-13 ff.).

| Was | Wo |
|---|---|
| Prosa | `docs/contracts/v2/kennzahl.md` · `kennzahlwert-herkunft.md`; additiv `ergebnis-zustand.md` §7, `events-vocabulary.md` („Reserviert“), `bezugsdaten.md` §11 „Lesart als Nenner“ |
| Vektoren + Schema | `kennzahl-vectors.json` (22 Fälle K1–K22, 120 Prüfungen) + `kennzahl.schema.json`, `kennzahlwert-herkunft.schema.json`; Block `kennzahl_kennzeichen` in `ergebnis-zustand-vectors.json` (1.9); Block `reserviert` in `events-vocabulary-vectors.json` |
| Referenzdatei | `uems-referenzunternehmen.json` 1.3: BZ-6, BZ-7, `kennzahlen[]` KZ-0001 … KZ-0005, Zeitachse 03.11.2026 |
| Java | `services/api/.../uems/KennzahlRegeln` (rein); additiv `ErgebnisZustand.zahlMitStellen` |
| TS | `frontend/portal/src/uemsKennzahl.ts` (rein); additiv `uemsErgebnis.zahlMitStellen` |
| Tests (rein) | `KennzahlVectorsTest` · `uemsKennzahl.test.ts`; Referenz-Zwillinge; `copy.test.ts` Abschnitt „AP-11 IP-3“ |

```bash
(cd services/api && ./mvnw test -Dtest='KennzahlVectorsTest,UemsReferenzunternehmenVectorsTest')
(cd frontend/portal && npx vitest run src/uemsKennzahl.test.ts src/uemsReferenzunternehmen.test.ts src/copy.test.ts)
```

## Die Fallen

- **Summe durch Summe, nie ein Mittel.** 0,20 für das Unternehmen, 0,2361 für das Jahr; 0,32 und 0,2346 entstehen nirgends.
  Beide Tests prüfen den Quelltext beider Zwillinge darauf, dass nichts durch die Zahl seiner Teile teilt — wer eine
  „Durchschnitt“-Hilfe einbaut, bricht sie absichtlich.
- **Wiederverwendet, nicht kopiert (E1).** Kreis = `MessstelleFormelRegeln.zyklus` (TS: `uemsMessstelleFormel.zyklus`),
  Fassung = `fassungEintrag`/`fassungAm`, Stichtag = `BezugsdatenRegeln.wertAm`, Periodengrenzen = `BezugsPeriode.spanneVon`,
  Recht = `RechteAbleitung.darf`. Fassung, Fassung am Tag und Stichtag haben keinen TS-Zwilling — `zwillinge_grund` sagt es;
  ein TS-Nachbau wäre eine zweite Wahrheit.
- **Der Zustand eines Nenners wird abgeleitet (Q1)**, nie übergeben: wirksame Fassung → vollständig, alles andere → keine
  Werte. Ohne Zahl und ohne früheren Wert gibt es noch **keine Version** (K8); mit früherem endgültigem Wert ist auch „keine
  Werte“ Version n + 1 (K19).
- **Ein Anteil ist Prozent** (50,82), nicht der Bruch des Konzeptkatalogs (0,5082) — sonst spräche `ErgebnisZustand.zahl`
  „1 %“. Steht in `_abweichungen`.
- **Kennzeichen einer Kennzahl sind NICHT die Verbrauchs-Liste.** Eigener Block `kennzahl_kennzeichen` mit eigenem Rang;
  über Ebenen erbt ein Paar sein „ab …“ mit Geltungsobjekt („G-5 ab 15.10.2026“), über die Zeit ersetzt das eigene „ab …“
  die der Teile und „x von y …“ bleibt nur, wenn es in jeder Teilperiode steht.
- **Referenzdatei 1.3 hat einen Diff-Test**: beide Zwillinge nehmen die Zusätze heraus und vergleichen den kanonischen
  SHA-256 mit dem der Fassung 1.2. Wer eine 1.2-Angabe ändert, bricht ihn — zu Recht. Wer 1.4 anlegt, nimmt die neuen Zusätze
  genauso heraus. BZ-6/BZ-7 haben Arten-Beispiele in `bezugsdaten-vectors.json`; `UemsBezugsgroesseMigrationTest` zählt sie mit.
- **Befund K18 (Claudia):** der Konzeptkatalog lässt die standortbeschränkte Leserin Unternehmens-Kennzahlen sehen; W3 und
  `RechteAbleitung.darf` sagen nein. Der Vertrag folgt W3; AP-03 IP-11 ist die Stelle, es anders zu entscheiden.
- **Reservierung, keine Anlage:** `correction` mit Bezug `bezugsgroesse` (AP-09 IP-7) und `kennzahl_neu_gebildet` (AP-11 IP-8)
  stehen im Block `reserviert` — keine Migration hier. Beide sind inzwischen zusätzlich in `vokabular.arten` angelegt:
  `correction`/`bezugsgroesse` seit AP-09 IP-7 (`uems-bezugswert-eingeben.md`), `kennzahl_neu_gebildet` seit AP-11 IP-8
  (`V20260915061500`, `uems-kennzahl-kaskade.md`); `KennzahlVectorsTest` akzeptiert beide Stände.
