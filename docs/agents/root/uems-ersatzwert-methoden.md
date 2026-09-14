# UEMS-Ersatzwert-Methoden: die geschätzte Verteilung ändert den gemessenen Betrag nie (AP-08 IP-13)

Neu angelegt am 13.09.2026. Entscheid AP-08 **E7 = A** (11.09.2026). Baut auf den Tabellen von IP-12
(`uems-korrektur-ersatzwert.md`) und dem Zuwachs über eine Lücke von IP-6 (`uems-luecken-zuwachs.md`) auf.

| Teil | Stelle |
|---|---|
| Rechenregel | Java `uems/VerbrauchRegeln` (Abschnitt Ersatzwert) ⟷ Python `voltpilot_optimization/verbrauch.py` |
| Vertrag | `docs/contracts/v2/verbrauch-vectors.json` Block `ersatzwerte` + `regeln.ersatzwert_*`, Prosa `verbrauch.md` §11 |
| Kennzeichen | `ergebnis-zustand` 1.4: `mit_ersatzwert` Rang 70 — `ErgebnisZustand.ersatzwert` ⟷ `uemsErgebnis.ersatzwert` |
| Tabellen | `V20260913210000`: `messreihe_viertelstunde_version`, `messreihe_ersatzwert_wirkung` |
| Lauf | `uems/ErsatzwertLauf` (Takt `ErsatzwertLaeufer`, `voltpilot.uems.ersatzwert.enabled`: yml AN, surefire AUS) |

## ⚠ Die Invariante „Summe = gemessener Zuwachs“ (a–c)

Über einer Zählerstand-Lücke ist der Zuwachs GEMESSEN; a–c legen nur fest, WANN er anfiel.
`VerbrauchRegeln.verteilen` ⟷ `verbrauch.verteilen` ist die EINE Stelle: Anteil = Zuwachs × Gewicht ÷
Summe der Gewichte, ungerundet gerechnet (MathContext 40) und auf **9 Nachkommastellen abgeschnitten**
(nie aufgerundet, darum nie negativ); die **letzte Viertelstunde der Lücke** bekommt Zuwachs − Summe der
übrigen — dort schließt der Stand nach der Lücke den Zuwachs ab. Die Summe der GESPEICHERTEN Anteile
(`messreihe_viertelstunde_version.anteil`) ist darum exakt der Zuwachs. Benannte Tests:
`ErsatzwertInvarianteTest` (450 Kombinationen aus Lückenlänge, Zuwachs, Profil) ⟷
`test_invariante_summe_gleich_gemessenem_zuwachs`, dazu die Datenbank in `UemsErsatzwertMethodenTest`.

- Viertelstunden einer Lücke = `[Boden(data_gap.von), Decke(data_gap.bis))` — dieselbe Rechnung wie der
  Auslöser `messreihe_ersatzwert_luecke`. Der Zuwachs kommt aus der `data_gap`-Meldung, nie getippt.
- a–c über einen anderen Zeitraum als genau diese Viertelstunden: `zeitraum_nicht_die_luecke` (der
  Auslöser erlaubt einen Teilzeitraum, die Regel nicht — sonst stünde die Energie der ganzen Lücke in
  einem Teil).

## ⚠ Benannte Ablehnungen — nie ein stiller Rückfall

`regeln.ersatzwert_ablehnungen` (geschlossen, Java `ERSATZWERT_ABLEHNUNGEN`, SQL
`messreihe_ersatzwert_wirkung_woerter()` Zeile für Zeile): `wertart_passt_nicht` ·
`kein_gemessener_zuwachs` · `zeitraum_nicht_die_luecke` · `vorperiode_fehlt` · `vergleichsquelle_fehlt` ·
`profil_negativ` · `profil_ohne_verbrauch` · `betrag_fuer_mehrere_viertelstunden` · `einheit_passt_nicht` ·
`endstand_unter_letztem_wert` · `anfangsstand_ueber_naechstem_wert` · `ueberschneidet_ersatzwert`; nur der
Lauf kennt dazu `rohwerte_fehlen` (d rechnet Z4 aus Rohwerten, Aufbewahrung 90 Tage).

- b/f brauchen für JEDE Viertelstunde eine `vollständig`e Menge der Vorperiode, c/g der Vergleichsquelle
  (`messstelle_quelle` mit `rolle = 'vergleich'` desselben Kundenbereichs). Profil gelesen aus Version 1.
- e setzt den Betrag EINER Viertelstunde; über mehrere wäre es der Wert einer gröberen Periode (IP-17).
- Die Ablehnung steht in `messreihe_ersatzwert_wirkung.ergebnis` — die Fläche (IP-16) liest sie dort.

## ⚠ Die Versionsregel

- **Version 1 bleibt die Zeile der Verdichtung** (`messreihe_viertelstunde`, unberührt; in einer Lücke gar
  keine). Jede Neubildung ist eine WEITERE Zeile in `messreihe_viertelstunde_version` (Version ≥ 2,
  lückenlos je Viertelstunde, append-only für jede Rolle, App nur SELECT, RLS + FORCE).
- **Immer vom Bestand aus:** gewünscht = Version 1 + die HEUTE geltenden Ersatzwerte; nur wenn das von der
  neuesten gespeicherten Version (ohne eine: von Version 1) abweicht, entsteht die nächste. Ein Widerruf ist
  darum eine Version mit den Zahlen von Version 1 (F21: keine Spur), und eine bessere Methode rechnet aus dem
  Zuwachs, nie aus Version 2. Widerruf + neuer Ersatzwert vor demselben Lauf = EINE Version.
- **Geltend:** nur `wirksam`; in der Folge der Kennung (Jahr, Nummer) hält der frühere seine Viertelstunden,
  ein später überlappender ist `ueberschneidet_ersatzwert` — und gilt, sobald der frühere zurückgenommen ist.
- **Periode mit Ersatzwert** (`mitErsatzwerten` ⟷ `mit_ersatzwerten`): enthält sie die Lücke ganz, bleibt
  die Menge (E2) und der Lücken-Satz weicht; schneidet sie sie an, kommen die Anteile ihrer Viertelstunden zur
  gemessenen Menge (`null` = kein gemessener Teil), ein Rand IN der Lücke ist gedeckt, einer außerhalb bleibt
  „nicht gemessen“. ⚠ Der Stand an einer Grenze gehört beiden Nachbarn: eine Viertelstunde ohne Rohwert hat
  keine Zeile, der Lauf liest ihren Rand aus der Nachbar-Zeile.
- **Wiederholbar und abbruchsicher:** Arbeit = jede Fassung über `messreihe_ersatzwert_wirkung.fassung`;
  Versionen und Wirkung in EINER Transaktion, Sperre je Reihe (`pg_try_advisory_xact_lock`); ein zweiter
  Lauf schreibt nichts.
- **Kennzeichen** „mit Ersatzwert (Methode „Zuwachs gleichmäßig verteilen“, EW-2026-0003)“: der Name in
  Kundensprache, nie das Vertragswort; Rang 70, zuletzt. Befund: der Satz nennt „mit Ersatzwert“ neben dem
  Zustand ein zweites Mal (`befunde`), das Zusammenziehen entscheidet die Fläche.

## Grenzen

Nur die Viertelstunde: Tag, Monat, Jahr und berechnete Messstellen mit Ersatzwert bildet seit 14.09.2026 die Kaskade
(`uems-korrektur-kaskade.md`) über dieselbe Regel — a–c; d–g haben über gröberen Perioden keine Vertragsregel
(`ersatzwert_ohne_periodenregel`). Jede Version trägt seit IP-17 zuletzt „korrigiert (Version n)“. Keine Vorschläge (IP-14), keine
Vier-Augen-Prüfung (seit IP-15 nur an Korrekturen: `uems-vieraugen-freigabe.md`), keine Route/kein Portal (IP-16), keine automatische
Auffüllung. Eine spätere Neuverdichtung einer vorläufigen Version-1-Zeile löst keine Neubildung aus
(`basis_berechnet_am` hält fest, worauf gerechnet wurde).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='ErsatzwertInvarianteTest,VerbrauchErsatzwertVectorsTest,VerbrauchVectorsTest,ErgebnisZustandVectorsTest,ErsatzwertWiringTest')
(cd services/api && ./mvnw test -Dtest='UemsErsatzwertMethodenTest')   # Testcontainers
(cd services/optimization && pytest tests/test_verbrauch.py)
(cd frontend/portal && npx vitest run src/uemsErgebnis.test.ts src/copy.test.ts)
```
