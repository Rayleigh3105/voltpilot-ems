# UEMS-Periodenwerte berechneter Messstellen: gespeichert nach den gemessenen (AP-10 IP-10)

**E6 = A.** Viertelstunde, Tag, Monat und Jahr einer berechneten Messstelle (`gewichtete_summe`, `rest`) liegen in
der VORHANDENEN Speicherklasse — Spur `berechnet` — samt ihren Eingängen; der Live-Wert bleibt live und wird nie
gespeichert. Bericht `data/vp-uems-ap10-bilanzen/report.md` §8 IP-10, §4.5, E6.

| Was | Wo |
|---|---|
| Migration | `V20260914100000`: an `messreihe_viertelstunde` / `_tag` / `messreihe_periode` die Spur-Spalten `messstelle_id`, `formel_fassung_id`, `formel_typ` (Bestand NULL), `…_spur_chk`, Teil-Index `uq_…_berechnet`; neu `bilanzwert_eingang` (Hypertable, 10 Jahre, RLS + FORCE) und `messreihe_berechnet_stand` (Nachholen je Messstelle) |
| Regel (rein) | `uems/BerechnetePeriode`: `rechne` (ruft `MessstelleFormelRegeln.periodenwert` + `TagRegeln.zustand`), `reihenfolge` (Abhängigkeitsordnung, Kreis über `MessstelleFormelRegeln.zyklus`) |
| Lauf | `uems/BerechnetePeriodenLauf` im Stundentakt `EndgueltigkeitLaeufer` NACH `TagVerdichter`/`PeriodeVerdichter`, vor den Korrektur-Vorschlägen |
| Speicher | `uems/BerechnetePeriodenRepository` (schreibt über die Lauf-Transaktion, liest hinter RLS) |
| Leser | `MessstelleWerteService` (Route `…/messstellen/{kennzeichen}/werte`): Viertelstunde/Tag/Monat/Jahr aus der Spur, ohne Zeile `noch_nicht_gebildet`, Stunde und Momentanwert weiter `berechnet` |
| Tests | `BerechnetePeriodeVectorsTest` (F1–F7 rein) · `UemsBerechnetePeriodenwerteTest` (12, Testcontainers) · `UemsBerechnetePeriodenwerteMigrationTest` (5) · `EndgueltigkeitLaeuferReihenfolgeTest` |

```bash
(cd services/api && ./mvnw test -Dtest='BerechnetePeriodeVectorsTest,UemsBerechnetePeriodenwerteTest,UemsBerechnetePeriodenwerteMigrationTest,EndgueltigkeitLaeuferReihenfolgeTest')
```

## Die Fallen

1. **Die Reihenfolge ist der Kern.** Erst alle gemessenen Stufen (der Takt), dann die berechneten in der Ordnung
   ihrer Eingänge — Kanten aus den wirksamen Fassungen (Baustein-/Verteilungs-Term) und beim `rest` aus der Stellung
   der Tage. Der benannte Test `dieBerechneteMessstelleRechnetNachIhremEingangNichtNachIhremKennzeichen` legt die
   Summe im Kennzeichen VOR ihren Eingang: in Kennzeichen-Reihenfolge ergäbe er 1 739 statt 850 kWh (Mutationsprobe).
   Ein Kreis wird `formel_kreis` (Kette `[KR-1, KR-2, KR-1]`), wer daran hängt `haengt_an_kreis` — `Lauf.abgelehnt`
   + Log, nie gerechnet.
2. **Eine berechnete Zeile hat keine Reihe.** `entity_id`/`messkanal` NULL, ebenso erhalten/erwartet, Kadenz,
   Slots/Teile, Wertart — eine 0 wäre eine Behauptung. ⚠ Darum filtern die Quellen, die OHNE Reihe über die Klassen
   laufen, auf `entity_id IS NOT NULL`: `EndgueltigkeitLauf.FAELLIG` (sonst hielte eine nie umschaltbare Zeile jeden
   Stapel voll), `TagVerdichter` (Viertelstunden, Frist, Rückrechnung), `PeriodeVerdichter` (Frist, Nachholen). Wer
   eine neue solche Quelle schreibt, filtert genauso; Leser über `entity_id = ?` sehen die Spur nie.
3. **Vorläufig/endgültig über die EINGÄNGE.** Teile sind die Eingänge mit gespeicherter Zeile (oder mit Rohwerten
   darunter, `noch_nicht_gebildet`); endgültig erst, wenn jeder vorhandene Eingang endgültig ist und die Frist der
   Periode (Ende + 7 Tage) vorbei ist. Hat KEIN Eingang etwas, entsteht keine Zeile (wie eine Lücke).
4. **Tag, Monat, Jahr aus den Perioden der Eingänge**, nie als Summe darunter. Monat/Jahr nur, wenn an allen Tagen
   mit Formel dieselbe Fassung mit denselben Termen gilt — sonst KEINE Zeile (`terme_wechseln`): eine Zahl über
   Abschnitte wäre eine neue Rechenregel (auch die Bilanz-Route rechnet dann Tag für Tag).
5. **Wiederholbar, abbruchsicher.** Je Messstelle eine Transaktion je Tagesscheibe (≤ 21 Tage, Viertelstunden + Tage),
   je Monat, je Jahr, unter `pg_advisory_xact_lock`; geschrieben wird nur, was sich an Zeile ODER Eingängen ändert;
   eine endgültige Zeile samt Eingängen nie. Ein Abbruch rollt die ganze Scheibe zurück (Test mit Trigger).
6. **Welche Tage.** Fenster heute − 9 Tage … heute; vorläufige berechnete Tage/Monate/Jahre vor dem Fenster mit
   abgelaufener Frist; Nachholen rückwärts in Scheiben von 28 Tagen bis zum frühesten gemessenen Tageswert — nie
   weiter zurück als ein berechneter Eingang, der selbst noch nicht fertig ist.
7. **Was nicht gerechnet wird.** Formel mit Momentanwert (nur live); `saldo` (kein Schreibweg, IP-16); ein Term mit
   `anteil` positiv/negativ (`anteil_nicht_gespeichert`) oder Verteilung (`verteilung_nicht_gespeichert`, IP-11) —
   der Eingang steht mit Grund und ohne Menge in `bilanzwert_eingang`. Darum sind F4 und F7/AN-1 (Speicher MS-04)
   nur rein geprüft. Vermerke „Stellung geändert (…)“ reicht der Lauf nicht herein (IP-12).

## Das befristete Kennzeichen ist entfallen

„vorläufig (Geräte-Verdichtung)“ (IP-9) stand an `GET …/messstellen/{id}/wert`, `…/verlauf` und `live` der Bilanz:
`BilanzAbleitung.VORLAEUFIG_GERAETE_VERDICHTUNG`, `MessstelleFormelService.BEFRISTET`, `BilanzService`, die Felder
`kennzeichen` in `MessstelleFormelDto.Wert`/`Verlauf` und `BilanzDto.Live`, `bilanz-vectors.json`
(`kennzeichen_neu`, `kennzeichen_befristet`), `uemsBilanz.ts`, `api.ts`, OpenAPI `BilanzLive`. Alles entfernt; die
Tests prüfen jetzt das Fehlen. Der Verlauf (`verlauf.ts` `seriesFromMessstelleVerlauf`) liest `punkte` unverändert.

## Nach einer Korrektur (AP-08 IP-17)

Versionen ≥ 2 bildet die Kaskade an `BerechnetePeriodenLauf.nachKorrektur` (dieselbe Ordnung, derselbe Kreis, dieselbe
Rechnung, Eingänge in ihrer neuesten Version) und speichert sie in `messreihe_periode_version`, ihre Eingänge in
`bilanzwert_eingang` mit `version` = n — `uems-korrektur-kaskade.md`. Eine Summe ohne einen Eingang mit Wert trägt
seitdem keine Menge mehr (vorher 0 und CHECK-Fehler).

## Verteilte Werte (AP-10 IP-11)

Werden NICHT gespeichert: die Kostenstellen-Sicht bildet sie beim Lesen aus den Tageswerten dieser Spur (und der
gemessenen) mit der Version der Quelle; die Kaskade meldet `bilanz_neu_berechnet` — `uems-kostenstelle-energie.md`.

## Nicht gebaut

Herkunft aus `bilanzwert_eingang` (IP-12), Portal (IP-14), Rechte-Durchsetzung (AP-03), eine Periodenzahl über einen Termwechsel.
