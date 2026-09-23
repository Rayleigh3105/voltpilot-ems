# UEMS-Korrektur-Kaskade: automatisch bis zum Jahr — aber nie ein freigegebener Bericht (AP-08 IP-17)

Neu angelegt am 14.09.2026. Entscheid AP-08 **E9 = A** (11.09.2026). Baut auf IP-12 (`uems-korrektur-ersatzwert.md`),
IP-13 (`uems-ersatzwert-methoden.md`), IP-14 (`uems-korrektur-vorschlaege.md`) und AP-10 IP-10
(`uems-berechnete-periodenwerte.md`) auf.

## Die zwei Sätze, die das Paket definieren

1. **Eine freigegebene Korrektur wirkt AUTOMATISCH durch:** die Viertelstunden der Korrektur, alle Tage, Monate und
   Jahre der Reihe, die berechneten Messstellen (AP-10) und die Kennzahlen (AP-11) — jede Stufe, die sich ändert, als
   Version n + 1 mit **„korrigiert (Version n)“** (Rang 80, `ergebnis-zustand` 1.5). Keine zweite Rückfrage: der Mensch
   entscheidet EINMAL (die Freigabe, E14), der Rest ist Rechnen.
2. **Ein freigegebener Bericht wird NIE geändert.** Er bekommt nur den Revisions-Auslöser (die Meldung `correction`);
   ein Bericht-ENTWURF bildet sich neu. Die Grenze steht an EINER Stelle: `KorrekturKaskade.berichteBenachrichtigen`
   ruft für `FREIGEGEBEN` ausschließlich `revisionAusloesen` — die Naht entscheidet das nicht. Benannter Test:
   `UemsKorrekturKaskadeTest.einFreigegebenerBerichtBleibtUnveraendertUndBekommtNurDenAusloeserEinEntwurfAktualisiertSich`.
   **Die Naht hat seit AP-12 IP-8 eine Bean:** `BerichtKaskade` bildet den Entwurf in derselben Transaktion neu
   (`bericht_entwurf`, Meldung `bericht_entwurf_neu_gebildet`) und schreibt am gültigen Stand den Anstoß
   (`bericht_revision_anstoss`, idempotent, Meldung `bericht_revision_angestossen`) — `uems-bericht-kaskade.md`.
   `BerichteNaht.Keine` gilt nur bei `voltpilot.uems.berichte.enabled` = false und im Testlauf (surefire). Pfad 2
   (rückwirkende Struktur) ruft dieselbe Grenze über `StrukturAenderungLaeufer.benachrichtigen`. Dass die Naht
   außerhalb von `bericht%` nichts schreibt außer ihren Meldungen: `UemsBerichteBestandsschutzTest`
   (`uems-berichte-abschluss.md`). ⚠ Aus heißt: freigegebene Stände erfahren von einer Korrektur NICHTS, und der
   Anstoß wird beim Wieder-Einschalten nicht nachgeholt — die Wirkung des Anlasses ist geschrieben.

| Teil | Stelle |
|---|---|
| Lauf | `uems/KorrekturKaskade` (Takt `KorrekturKaskadeLaeufer`, 5 min, `voltpilot.uems.kaskade.enabled`: yml AN, surefire AUS) |
| Stufen (Tag/Monat/Jahr) | `uems/KaskadeStufen` — ruft `ViertelstundenTeile.zaehlerstand`/`werte`, `VerbrauchRegeln.erwartetAusTeilperioden`, `mitErsatzwerten` über `ErsatzwertLauf.geltende` |
| Hook AP-10 | `BerechnetePeriodenLauf.nachKorrektur` — dieselbe Ordnung, derselbe Kreis, dieselbe Rechnung, Eingänge überlagert |
| Naht AP-11 | `uems/KennzahlenNaht` — seit AP-11 IP-8 die Bean `KennzahlKaskade` (`uems-kennzahl-kaskade.md`) |
| Naht AP-12 | `uems/BerichteNaht` — seit AP-12 IP-8 die Bean `BerichtKaskade` (`uems-bericht-kaskade.md`); `Keine` nur bei `voltpilot.uems.berichte.enabled` = false |
| Migration | `V20260914120000`: `messreihe_viertelstunde_version` + Anlass `K-…` + Rohwert-Fakten; `messreihe_periode_version`; `messreihe_kaskade_wirkung` |
| Meldung AP-10 IP-11 | `uems/BilanzNeuBerechnet.melden` in derselben Transaktion: `bilanz_neu_berechnet` je berechneter Messstelle mit neuer Version und je gemessener Messstelle einer korrigierten Reihe mit Anteil (`uems-kostenstelle-energie.md`) |
| Vertrag | `ergebnis-zustand-vectors.json` 1.5: Kennzeichen `korrigiert` (derselbe Wortlaut wie `bilanz-vectors.json` F14) |

## Was ein Anlass ist

- **Korrektur:** neueste Fassung `freigegeben` oder `zurueckgenommen`, weiter als `messreihe_kaskade_wirkung.fassung`.
- **Ersatzwert:** neueste Fassung, sobald `ErsatzwertLauf` sie gerechnet hat (`messreihe_ersatzwert_wirkung.fassung`) —
  seine Viertelstunden bildet weiter der Ersatzwert-Lauf (jetzt ebenfalls mit „korrigiert (Version n)“), die Kaskade
  folgt mit Tag, Monat, Jahr und AP-10.
- **Seit AP-11 IP-9 ohne Stufen:** `correction` mit Bezug `bezugsgroesse` (`BK-…`), eine rückwirkende Kennzahl-Fassung
  (`kennzahl_fassung:<ID>`) und ein rückwirkendes Stammdatum (`bezugsgroesse_stammdatum:<ID>`) rufen nur die Kennzahl- und die
  Berichts-Naht (`ohneStufen`, `uems-kennzahl-ausloeser.md`).

Ein Anlass = EINE Transaktion (Viertelstunden, Stufen, berechnete Messstellen, Meldungen, Nähte, Wirkung); ein Abbruch
irgendwo — auch in einer Naht — rollt ALLES zurück. Eine benannte Ablehnung rollt die Stufen zurück und schreibt nur die
Wirkung (`messreihe_kaskade_woerter()` = `KorrekturKaskade.WOERTER`).

## ⚠ Die Fallen

1. **Version 1 bleibt.** Die Kaskade schreibt nie in `messreihe_viertelstunde`/`_tag`/`messreihe_periode` (Test mit
   Fingerabdruck). Versionen ≥ 2 stehen in `messreihe_viertelstunde_version` (Reihe, Viertelstunde) und
   `messreihe_periode_version` (Tag/Monat/Jahr der Reihe; Viertelstunde bis Jahr einer berechneten Messstelle; deren
   Eingänge in `bilanzwert_eingang` mit `version` = n und `eingang_version` = Version des Eingangs).
2. **Die Viertelstunde der Korrektur = die freigegebene Vorschau „neu“** — mit den Rohwert-Fakten derselben Zeile
   (`ViertelstundeVerdichter.waereZeile`). Sagt sie heute etwas anderes (neue Rohwerte): `vorschau_veraltet`, der
   nächste Vorschlag zeigt es. Rohwerte weg (90 Tage), Vorschau mit Werten: `rohwerte_fehlen`. Umklassifizierung: nur
   erhalten/erwartet/Abdeckung müssen stimmen (die umgedeutete Deklaration ist nicht gespeichert).
3. **Die Fakten reisen mit.** Tag und Monat werden aus den Viertelstunden in ihrer NEUESTEN Fassung gebildet
   (`korrekturen` gesetzt = Fakten dieser Version, ohne „korrigiert“), das Jahr aus Monaten: ein Monat mit
   Viertelstunden-Version geht mit seiner neu gebildeten Grundlage ein (ohne Ersatzwerte — sonst zählte das Jahr sie
   doppelt), jeder andere mit Version 1.
4. **Eine ERSTE Version nur, wenn etwas wirkt** (Korrektur, Ersatzwert oder Viertelstunden-Version in der Periode) — eine
   Version 1, die die Verdichtung noch nicht neu gebildet hat, ist nicht Sache der Kaskade. Danach vergleicht jede Stufe
   Aussage UND was wirkt: eine Version mit denselben Zahlen, die eine zurückgenommene Korrektur noch nennt, bekommt
   eine neue.
4a. **Das Richtungspaar reist mit** (`V20260923231500`): `messreihe_viertelstunde_version.energie_positiv/_negativ`
   stammen aus DERSELBEN `waereZeile` wie die Rohwert-Fakten und nur, wenn deren `energie` die freigegebene ist
   (Nachlieferung, Ablesestände, Umklassifizierung); `wert_berichtigt` und Ersatzwert (`mitErsatzwerten`) setzen
   eine Nettomenge ohne Richtung → NULL. Tag/Monat summieren die Anteile der Viertelstunden in ihrer neuesten
   Fassung (`Richtungspaar.ausTeilen`), das Jahr seine Monate (`Richtungspaar.Summe`) — dieselbe Regel wie
   Version 1. `Inhalt.gleich` vergleicht das Paar nur, wenn BEIDE Seiten es kennen (eine Version von vor der
   Migration bekommt keine neue Nummer); Nachzug schreibt es mit. Leser: `BilanzRichtungswerte`,
   `Richtungspaar.mengenDerVersion` (Berichts-Abzug). Test: `UemsRichtungspaarLaufTest`,
   `BewertungRanglisteApiTest.korrekturAmSpeicherTraegtIhrRichtungspaarNettoBerichtigungNicht`.
5. **Rücknahme = Stand VOR der Korrektur** (§4.6) als nächste Version — nur, wo die neueste Viertelstunden-Version von
   ihr stammt (eine spätere Entscheidung gilt). Danach nennt keine neueste Version die Korrektur mehr (Test).
6. **Vorläufige Perioden ziehen nach.** Ein laufender Monat/ein laufendes Jahr bekommt seine Version und wächst danach wie
   Version 1: der Nachzug bildet die neueste VORLÄUFIGE Version neu, sobald Version 1 neu gebildet wurde
   (`berechnet_am > basis_berechnet_am`) — dieselbe Nummer; der Trigger `messreihe_periode_version_append_only` lässt
   nur das zu. Endgültig = eingefroren.
7. **Der Kreis endet** wie in AP-10 (`formel_kreis`/`haengt_an_kreis` in `Lauf.kreise`, keine Version).
8. **Die Meldung `correction`** (Urheber `kunde`, je Reihe und Entscheidung, Kennung abgeleitet) entsteht in derselben
   Transaktion — sie IST der Revisions-Auslöser (`Betroffen.ereignisse`). Die Cloud meldet weiter nur `vorschlag`.

## Befunde (benannt, nicht still gelöst)

- **Ersatzwert d–g über gröberen Perioden:** ergänzt über `ErsatzwertPerioden` (Java/TS), einschließlich
  ungeteilter Eingabe bis Monat. Die Viertelstunden-Verteilungsfunktion bleibt unverändert; [Regel und Nachweise](uems-ersatzwert-perioden.md).
- **Korrektur auf einer Viertelstunde mit geltendem Ersatzwert** → `ueberschneidet_ersatzwert`. Umgekehrt rechnet
  `ErsatzwertLauf` ohne Korrekturen (Befund IP-13): ein später erfasster Ersatzwert überschreibt eine korrigierte
  Viertelstunde; die Kaskade folgt dem neuesten Stand, damit keine zwei Wahrheiten entstehen.
- **Korrektur mit mehreren Reihen:** die Vorschau je Viertelstunde (IP-14) nennt keine Reihe → `vorschau_fehlt`.
- **AP-10 Summe ohne Eingang mit Wert** trug 0 bei „keine Werte“ und ließ die Scheibe am CHECK scheitern —
  `BerechnetePeriode.rechne` setzt die Menge dort jetzt `null` (bilanz.md Nr. 7).
- `KorrekturVorschlagRegeln.Stand.gleich` vergleicht ohne „korrigiert (Version n)“ (sonst wäre jede korrigierte
  Viertelstunde für den nächsten Vorschlag eine Änderung).

## Nicht gebaut

Portal (IP-16) nur als Naht; die Kennzahlen hängen seit AP-11 IP-8 an
(`uems-kennzahl-kaskade.md`), die Berichte seit AP-12 IP-8 (`uems-bericht-kaskade.md`). Versionen lesen und die Historie je Periode sind
seit IP-18 gebaut (`uems-versionen-lesen.md`). Freigabe- und Rücknahme-Route mit Vier-Augen und Rechte-Durchsetzung: seit
IP-15 (`uems-vieraugen-freigabe.md`) — die Kaskade liest weiter nur die Fassungen.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='ErgebnisZustandVectorsTest,BerechnetePeriodeVectorsTest,KorrekturKaskadeWiringTest')
(cd services/api && ./mvnw test -Dtest='UemsKorrekturKaskadeTest,UemsKaskadeErsatzwertTest,UemsErsatzwertMethodenTest')   # Testcontainers
(cd services/api && ./mvnw test -Dtest='UemsBerichtKaskadeTest,UemsBerichteBestandsschutzTest')   # Testcontainers
(cd frontend/portal && npx vitest run src/uemsErgebnis.test.ts src/copy.test.ts)
```
