# UEMS-Endgültigkeit und Tageswerte: wann eine Viertelstunde feststeht

**AP-07 IP-13.** Migration `V20260912190000__uems_endgueltigkeit_tageswerte.sql`; Regeln
`uems/TagRegeln`, Stundenlauf `uems/EndgueltigkeitLauf`, Tageslauf `uems/TagVerdichter`,
Spätankunft `uems/SpaetankunftMelder`, Takt `uems/EndgueltigkeitLaeufer`
(+ `EndgueltigkeitSchedulingConfig`). Tests: `UemsEndgueltigkeitTagesklasseTest` (Testcontainers,
26 Fälle), `TagRegelnTest`, `EndgueltigkeitWiringTest`, `DataRetentionPolicyTest`.

## Der eine Satz

**Ein endgültiger Wert ist ein Versprechen: er wird nie hinter dem Rücken des Kunden anders.**
Gleichzeitig darf ein zu spät eintreffender Messwert nicht verschwinden. Beides zusammen heißt:
**speichern, melden, vorschlagen — aber nicht anwenden.**

## Die FRIST gehört dem INTERVALL, nicht der Zeile

Entscheid E5 (Captain, 10.09.2026, Option A): ein Viertelstundenwert ist **vorläufig bis 7 Tage
nach Intervallende** — eine Nachlieferung rechnet ihn in dieser Zeit automatisch neu — und danach
**endgültig**. IP-12 legte `endgueltig_ab` an (CHECK: Intervallbeginn + 10 095 Minuten); IP-13
vollzieht es.

`TagRegeln.geschlossen(beginn, jetzt)` fragt **die Uhr und die Frist, nie eine Zeile**. Das ist
Absicht:

- Eine **Lücke hat gar keine Zeile** (IP-12: eine Viertelstunde ohne Rohwert bekommt keine) — ohne
  diese Regel könnte ein Nachzügler einen Zeitraum nachträglich füllen, den ein Bericht längst als
  abgeschlossen ausgewiesen hat.
- Das Verhalten hängt **nicht daran, wann der Stundenlauf zuletzt lief**. Er schreibt nur nieder,
  was ohnehin schon gilt.

## Der Stundenlauf (`EndgueltigkeitLauf`)

Ein `UPDATE` je Stapel, Prädikat `zustand = 'vorlaeufig'` — also **idempotent** (ein zweiter Lauf
findet nichts) und **abbruchsicher** (jeder Stapel ist seine eigene Transaktion; ein Abbruch lässt
den Rest unverändert stehen). Die Entnahme greift unter `FOR UPDATE SKIP LOCKED`: zwei
gleichzeitige Läufe bekommen disjunkte Stapel, und selbst bei derselben Zeile schriebe der zweite
null Zeilen.

Er setzt **genau ein Wort in genau einer Spalte**: `berechnet_am` bleibt stehen, weil die Zahlen
der Zeile nicht neu berechnet wurden.

⚠ Das Prädikat steht auf `intervall_beginn`, nicht auf `endgueltig_ab` — das ist die
Partitionierungs-Spalte (Chunk-Ausschluss), und der CHECK aus V20260912170000 bindet beide
zeichengleich aneinander. Dazu der TEILWEISE Index `idx_messreihe_viertelstunde_vorlaeufig`, der
mit jeder endgültig gewordenen Zeile schrumpft.

⚠ Seit AP-10 IP-10 wählt er nur REIHEN (`entity_id IS NOT NULL`): eine Zeile der Spur `berechnet` wird endgültig,
wenn ihre Eingänge es sind (`BerechnetePeriodenLauf`) — ausgewählt, aber über den Reihen-Schlüssel nie umgeschaltet,
hielte sie jeden Stapel voll. Dasselbe Filter tragen die Quellen des Tageslaufs (`uems-berechnete-periodenwerte.md`).

## Die Spätankunft (`SpaetankunftMelder`)

Ein **Nachzügler** ist ein Rohwert dieser Reihe in diesem Intervall, dessen **Eingangszeit nach der
Frist** liegt. Findet der Verdichtungs-Lauf für einen `eingang`-Eintrag welche, dann

1. **bildet er das Intervall NICHT** (der endgültige Wert bleibt Zeichen für Zeichen stehen),
2. **meldet** `late_arrival` in `messreihe_ereignis` — Urheber `cloud`, `von`/`bis` = das
   Intervall, Nutzlast `eingangszeit` + `anzahl`,
3. **schreibt einen Vorschlag** in `messreihe_korrektur_vorschlag`,

und zwar in der Transaktion, in der der Eintrag aus der Arbeitsliste entnommen wird. Der Zusatz liegt
in einem eigenen **Savepoint**: scheitert eine Meldung oder ein Vorschlag, werden alle Nachzügler des
Stapels erneut eingereiht, aber die normale Verdichtung der übrigen Intervalle darf festschreiben.
Fang, Warn-Log, `spaetankunftFehlerAnzahl()` und
`voltpilot_uems_spaetankunft_total{ergebnis="fehler"}` machen den Fehler laut. Der nächste Takt
versucht den Zusatz erneut; ein Nachzügler gelangt auch in diesem Fehlerfall nie in die Neubildung.

⚠ **Nur bei einem WIRKLICHEN Nachzügler.** Ein geschlossenes Intervall kann auch ohne einen wieder
in der Arbeitsliste landen (die Überlappung des Zeigers, ein Betriebs-Anstoß, die Rückrechnung);
dann ist das Bilden harmlos — es entsteht dieselbe Zeile, und eine endgültige rührt der Schreibsatz
ohnehin nicht an. Verboten ist genau das eine: einen zu spät eingetroffenen Wert ANWENDEN.

⚠ **Die Frist fragt JEDEN Grund, nicht nur `eingang`** (AP-08 IP-19): vor der Frist wird eine
Nachlieferung automatisch neu gebildet (F9), nach der Frist gemeldet und über IP-14 vorgeschlagen (F10)
— auch wenn der Eintrag aus der Rückrechnung oder einem Bruch stammt oder der Eingang einen schon
belegten Schlüssel fand (`ON CONFLICT DO NOTHING`). Die Vorprüfung ist EINE Abfrage je Stapel
(`SpaetankunftMelder.mitNachzueglern`). Auch die Rückrechnung bildet ein geschlossenes Intervall
mit Nachzügler darum NICHT (keine Zeile, Vorschau „alt“ = keine Werte), sondern meldet es. Paar-Test:
`UemsFristVorschlagTest`.

⚠ **Die Ereignis-Kennung ist ABGELEITET** (aus Reihe, Intervall, letzter Eingangszeit und Anzahl),
nicht gewürfelt: eine Wiederholung trifft denselben Idempotenz-Schlüssel und schreibt nichts,
eine ZWEITE Welle ist ein anderes Ereignis. Eine zufällige Kennung hinterließe bei jedem Takt ein
weiteres Ereignis.

⚠ **Das Vokabular wurde GEWEITET**: `late_arrival` darf jetzt auch von `cloud` kommen (bisher nur
`writer`), weil den Lauf die `api` fährt — dieselbe Weitung in der DB-Funktion
`messreihe_ereignis_vokabular()`, in beiden Java-Zwillingen (`api`/`writer`), in
`events-vocabulary.md` und in `events-vocabulary-vectors.json` (neuer Fall
`ms10-nach-abschluss-eingegangen-von-der-cloud`). Und die BYPASSRLS-Rolle bekam **INSERT** auf
`messreihe_ereignis`: der Hintergrund-Lauf hat keinen Mandanten-Kontext. **Append-only bleibt** —
UPDATE bekommt weiterhin niemand, DELETE nur das Offboarding.

## Die Korrektur-Liste ist die SCHNITTSTELLE, nicht die Korrektur

`messreihe_korrektur_vorschlag`: eine Zeile je Reihe und Intervall (ein zweiter Nachzügler erhöht
die Zählung derselben Zeile), Grund `nachlieferung_nach_endgueltigkeit`, mit Frist, Anzahl,
frühester/spätester Messzeit, erster/letzter Eingangszeit, der zugehörigen `ereignis_id` und
`version_bezug` (NULL = für das Intervall steht gar keine Zeile). Alle Zahlen sind eine **Funktion
der Rohwerte** — ein wiederholter Lauf schreibt denselben Inhalt.

**AP-07 schreibt hier nur `offen`.** `zustand`/`erledigt_am`/`erledigt_notiz` sind die Hälfte von
AP-08; von dieser Liste aus führt **kein Weg** zu einer Zeile der Viertelstunden- oder
Tagesklasse. Die versionierte Korrektur ist **AP-08 IP-12 ff.** — seit 13.09.2026 die Tabelle
`messreihe_korrektur` (der Vorgang; diese Liste bleibt die Erkennung), siehe `uems-korrektur-ersatzwert.md`.

## Die Tagesklasse `messreihe_tag`

Hypertable auf `tag DATE`, **Chunk 1 Jahr**, **Aufbewahrung 3 653 Tage**, RLS + FORCE, **ohne
Kompression** — Layout `segmentby Reihe / orderby tag DESC` VORBEREITET und über
`messreihe_tag_kompression_layout()` abrufbar (E7, wie die Viertelstunde).

**Die Tagesgrenze liegt in der ZEITZONE DES STANDORTS** (Widerspruch W10), und die Zone steht **in
der Zeile** — samt `zeitzone_herkunft` (`standort` → `unternehmen` → `vorgabe`, dieselbe Form wie
die Kadenz-Kette). Erst dann reproduziert ein Bericht in zehn Jahren dieselbe Grenze (A8). Die
Zeile trägt zusätzlich `beginn`/`ende` in UTC und `stunden`.

⚠ **96 ist nicht immer 96.** Am **25.10.2026** hat der Tag **25 Stunden = 100 Viertelstunden**, am
**28.03.2027** **23 = 92**. Die Stundenzahl wird **nicht hier gezählt**:
`TagRegeln.stunden` → `BezugsPeriode.stundenDesTages` → `VerbrauchRegeln.stunden` (AP-08 IP-1).
Zwei Zählungen derselben Stunden wären zwei Zahlen für dieselbe Aussage.

⚠ Heute tragen alle drei zugelassenen Zonen (`Europe/Berlin|Vienna|Zurich`) **denselben Versatz** —
die Wahl kann die Tagesgrenze also nicht verschieben. Gespeichert wird sie trotzdem.

**Zustand:** endgültig, wenn **jede vorhandene Viertelstunde endgültig ist UND die Frist des Tages
(Tagesende + 7 Tage) abgelaufen ist**. Der Zusatz ist nötig, weil eine fehlende Viertelstunde gar
keine Zeile hat: erst nach der Frist kann keine mehr entstehen. `slots_endgueltig` ist der Stand zu
`berechnet_am` und **untertreibt nie**.

**Abdeckung ist nicht Vollständigkeit** (zweimal, auf zwei Achsen): `slots_vorhanden` von
`slots_erwartet` sagt, wie viele Viertelstunden es gibt; `erhalten`/`erwartet`/`abdeckung_prozent`
summieren über die VORHANDENEN und werden nie auf 100 % gerundet.

## ⚠ Die Grenze zu AP-08 IP-5

Die Tagesklasse trägt **FAKTEN** — Periodenstände (`stand_anfang`/`stand_ende` mit ihren
Messzeiten), Abdeckung, Qualitätszähler, Anker, Zustand. Sie trägt **KEINE `menge` und KEINE
`summe`**: die Tages- und Monatsmengen bildet **AP-08 IP-5 aus den PERIODENSTÄNDEN**, nicht als
Summe der Viertelstunden. Genau diese Stände liefert die Zeile.

**Nachtrag AP-08 IP-5:** die Zeile trägt jetzt `menge`/`menge_zustand`/`kennzeichen`/`kadenz_s`
aus den Periodenständen, `stand_anfang`/`stand_ende` sind die Stände an den TAGESGRENZEN, und
`erwartet`/`abdeckung_prozent` zählen fehlende Viertelstunden mit — siehe
`uems-periodenmengen.md`.

`mittel`, `min_wert`, `max_wert` sind Momentanwert-Fakten, keine Mengen. **Seit AP-08 IP-3**
rechnet sie `VerbrauchRegeln.momentanwertAusTeilperioden`: Mittel = Summe der guten Werte ÷
erhalten (Spalte `summe`), auf eine Nachkommastelle wie die Viertelstunde. Vorher gewichtete dieser
Lauf die GERUNDETEN Viertelstunden-Mittel mit `erhalten` — das war nur auf 0,05 genau. Siehe
`uems-intervall-momentanwert.md`.

## Der Tageslauf (`TagVerdichter`)

Dieselbe Form wie IP-12: durable Arbeitsliste `messreihe_tag_arbeit`, Entnahme unter
`FOR UPDATE SKIP LOCKED`, entnehmen und schreiben in EINER Transaktion (ein Abbruch verliert
nichts), `ON CONFLICT … DO UPDATE … WHERE` lässt eine endgültige und eine unveränderte Zeile in
Ruhe. **Drei Quellen** füllen die Liste:

| Quelle | Was sie findet |
|---|---|
| `viertelstunde` | ein Zeiger auf `messreihe_viertelstunde.berechnet_am` (Index `idx_messreihe_viertelstunde_berechnet`, zusätzlich auf 91 Tage `intervall_beginn` eingegrenzt — der Verdichtungs-Lauf baut nur aus Rohwerten) |
| `frist` | Tage, die noch `vorlaeufig` sind und deren Frist abgelaufen ist — der Durchgang, der einen Tag ENDGÜLTIG macht (der Stundenlauf fasst `berechnet_am` nicht an, die erste Quelle sieht davon also nichts) |
| `rueckrechnung` | die einmalige Bildung der Vergangenheit, in Tagesscheiben rückwärts, jederzeit unterbrechbar |

⚠ **Die Arbeitsliste merkt sich den UTC-TAG, nicht den Ortstag.** Welcher Ortstag betroffen ist,
weiß man erst mit der Zeitzone — und die schlägt der Lauf nach, nicht die Datenbank. Ein UTC-Tag
berührt in jeder Zone höchstens ZWEI Ortstage (`TagRegeln.ortstageEinesUtcTages`); der Lauf bildet
beide.

## Der Takt

`EndgueltigkeitLaeufer`: **einmal je Stunde**, erst umschalten, dann Tage nachziehen (die
Reihenfolge ist Absicht — so trägt eine frisch gebildete Tageszeile schon die umgeschalteten
Slots), dann Monate/Jahre, dann die berechneten Messstellen (AP-10 IP-10, NACH allen gemessenen Stufen,
`EndgueltigkeitLaeuferReihenfolgeTest`), zuletzt die Korrektur-Vorschläge. Schalter `voltpilot.uems.endgueltigkeit.enabled`, **Vorgabe AN** in `application.yml`, **im
Testlauf AUS** (surefire, `pom.xml`) — die dokumentierte `@Scheduled`-Falle; `EndgueltigkeitWiringTest`
prüft beides an den echten Dateien.

**Zum Fünf-Minuten-Lauf:** beide können gleichzeitig laufen. Der Verdichtungs-Lauf baut nur offene
Intervalle und weist einen Nachzügler schon vor dem Schreiben ab; der Stundenlauf schließt nur
fällige. Trifft es dieselbe Zeile im selben Augenblick, verliert der Verdichter seinen
Schreibversuch (0 Zeilen) — der Wert ist dann endgültig, und der Nachzügler holt sich beim nächsten
Takt seine Meldung.

## Was NICHT entstanden ist

Keine versionierte Korrektur und keine Kaskade (AP-08 IP-12 ff.) — nur die Liste. Keine Tages- und
Monatsmengen aus Periodenständen (AP-08 IP-5). Kein Lesepfad und kein Export (IP-14). Keine
Lücken-Meldung als Job (IP-9). Keine Löschwege (IP-11). Keine Route, keine Portal-Fläche, keine
Rechte-Durchsetzung.
