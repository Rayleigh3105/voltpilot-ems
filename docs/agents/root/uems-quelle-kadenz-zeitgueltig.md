# UEMS-Kadenz: die erwartete Häufigkeit als zeitgültiges Feld der Quellenbindung (AP-07 IP-10)

Captain-Entscheid **E9** (10.09.2026, Option A): „Kadenz = Feld der Quellenbindung (AP-04) mit
Vorgabe aus Vorlage/Katalog, **zeitgültig (Fassung)**; reist als Soll zur Box (`cadence_s`,
**unverändert**) und wird je Viertelstundenwert als `erwartet` gespeichert; Lücke ab 2 × Kadenz
ohne guten Wert."

Bis hierher war die Kadenz eine **abgeleitete Zahl**, die jede Fläche frisch las. Ab hier ist sie
eine **Tatsache mit Geschichte**: was am 3. März erwartet wurde, darf etwas anderes sein als heute,
und die Auswertung eines alten Zeitraums sieht die alte Zahl.

## Die Zeitform — keine dritte

`quelle_kadenz` (`V20260912160000`) hängt an EINER Quellenbindung (`messstelle_quelle`,
V20260911250000) und trägt genau die Zeitform, die im Repo schon steht: **halboffen
`[gueltig_ab, gueltig_bis)` auf die Minute**, je Bindung zu jedem Zeitpunkt höchstens EINE Fassung
(Exklusion), **nur verkürzt, nie umgeschrieben, nie gelöscht** (Trigger + Spaltenrechte: die
App-Rolle darf allein `gueltig_bis` setzen) — dieselbe Form wie die Einstellungs-Fassungen
(`quelle_einstellung`, V20260911280000) und wie die Bindung selbst. Ein Trigger hält jede Fassung
IN ihrer Bindung (`quelle_kadenz_vor_beginn` · `quelle_kadenz_nach_ende`). Die Bindung bekommt
dafür additiv ihren zusammengesetzten Schlüssel `uq_messstelle_quelle_id_tenant` (der Mandant reist
in jedem Verweis mit) — das ist die EINZIGE Änderung an ihr.

Die Regeln urteilt `uems/KadenzRegeln` (rein): Prüfreihenfolge **Zahl → Zeitpunkt → vor dem Beginn
→ nach dem Ende → Beginn belegt → unverändert**; die neue Fassung beendet die zu ihrem Beginn
gültige GENAU DORT und gilt bis zum Beginn der nächsten späteren (höchstens bis zum Ende der
Bindung). **Was davor liegt, bleibt unangetastet.**

## Die Vorgabe-Kette (`KadenzRegeln.wirksam`)

1. die eingetragene **Fassung** der Bindung, die zu DIESEM Zeitpunkt gilt;
2. sonst die **Mess-Selektion** des Kanals (`device_measurement_selection.cadence_s` — dort hat die
   Vorlage bzw. der Anlege-Weg ihre Zahl hinterlassen);
3. sonst der **Katalog** (`default_cadence_s`);
4. sonst **300 s**.

Die Glieder 2–4 sind die Ableitung von VOR diesem Paket, Zeichen für Zeichen (`MesskanalService.kadenzS`
delegiert jetzt an die Kette). ⚠ Eine **Vorlage** (`component_template`) trägt heute KEINE Kadenz —
die Kette endet deshalb faktisch beim Katalog; kommt eine Vorlagen-Kadenz, gehört sie zwischen 2
und 3.

**Bestand:** die Migration übernimmt die heute geltende Vorgabe aus der Messauswahl — **nur wo sie
eindeutig folgt**: für den Messkanal der Bindung (Komponente + Kanal desselben Mandanten) gibt es
mindestens eine Auswahlzeile, JEDE trägt eine Kadenz, und alle nennen DIESELBE. Sonst entsteht
keine Fassung, und die Ableitung bleibt genau wie heute. Das ist ein EINMALIGER Lauf
(`uems_kadenz_bestand()`, wiederholbar, legt nur an, wo es noch keine Fassung gibt): eine NACH der
Migration angelegte Bindung bekommt keine Fassung 1 — sie lebt von der Vorgabe, bis jemand eine
einträgt.

## ⚠ Der Draht bleibt, wie er ist

Die Box bekommt dieselbe Nachricht (`…/v2/measurement-config`, `schema_version` **2.0**, Feld
`cadence_s`) in derselben Form; nur die **Quelle** der Zahl wechselt. `MeasurementConfigPublisher`
setzt `cadence_s` aus der Fassung des Messkanals zum Publish-Zeitpunkt (`ErwarteteKadenz`), sonst
aus der Auswahl. Darum trägt `erwartet_s` **genau die Schranken des Drahtvertrags** (1 … 86 400 s,
`mqtt-measurement-config.schema.json`): eine Fassung, die der Box nicht zustellbar wäre, entsteht
gar nicht erst; eine von Hand in die Datenbank geschriebene außerhalb wird ÜBERGANGEN, nie
zurechtgebogen. Lesen mehrere Bindungen denselben Messkanal, gilt für den Draht die SCHNELLSTE
ihrer Fassungen — dieselbe Regel, mit der der Publisher seit je zwei Komponenten auf einem Punkt
zusammenlegt. Der Beweis steht in `MeasurementContractsTest`: mit einer Fassung gleicher Zahl ist
das Dokument zeichengleich mit der festgeschriebenen Beispieldatei, mit einer anderen unterscheidet
sich GENAU ein Wert. **Kein Edge-Release, keine neue Vertragsfassung.**

Eine manuell abgelesene Messstelle (Referenz MS-21 Gas, „monatlich") hat **keine Quellenbindung**
und darum auch keine Fassung; ihre Erwartung ist AP-09 — die Referenzdatei trägt dort ausdrücklich
`kadenz_s: null`.

## Wer die Kadenz ZUM ZEITPUNKT holt — und wer noch nicht

* **Beobachtung / Messstellen-Register** (AP-04 IP-15): `MessstelleRegisterService` holt die
  Fassungen aller führenden Bindungen zum **Stichtag** in EINEM Zug (`QuelleKadenzRepository.jeBindung`)
  — nie „jetzt", nie je Zeile. Ohne abweichende Fassung ist die Registerzeile zeichengleich mit
  vorher (Test `dieBeobachtungBleibtVerhaltensgleichBisEineAbweichendeFassungExistiert`).
* **Publisher**: zum Publish-Zeitpunkt (das IST „jetzt" — der Mess-Plan ist ein Soll für die
  Gegenwart).
* **Noch nicht umgestellt** (sie lesen weiter die Mess-Selektion, und das ist dieselbe Zahl,
  solange keine abweichende Fassung eingetragen ist): das Messkanal-Read-Model
  (`GET …/komponenten/{id}/messkanaele`, Feld `kadenzS` — es zeigt die AUSWAHL der Box) und
  `MeasurementBudget` (die Last-Rechnung beim Ändern der Auswahl). Beide gehören zur Auswahl-Seite
  und wandern mit AP-06/IP-4 (Budget je Box) bzw. IP-14 (Lesepfad).

## Schnittstelle

`GET /api/v1/messstellen/{id}/quellen/{qid}/kadenz?stichtag=` — was zum Stichtag erwartet wird
(`erwartet_s`), woher die Zahl kommt (`herkunft`: `fassung` · `auswahl` · `katalog` · `vorgabe`),
was ohne Fassung gälte (`vorgabe_s`), die geltende Fassung und die ganze Historie.
`POST …/kadenz` trägt eine neue Fassung ein (Recht `messstelle.quelle`; rückwirkend zusätzlich
`aenderung.rueckwirkend`) und schreibt in derselben Transaktion GENAU EINEN Protokolleintrag
`kadenz_geaendert` an der Messstelle (CHECK-Weitung in V20260912160000). Ablehnungen:
`kadenz_ungueltig` 400 · `zeitpunkt_ungueltig` 400 · `vor_beginn` 422 · `nach_ende` 422 ·
`beginn_belegt` 409 · `unveraendert` 400 · `anfrage_ungueltig` 400 — jede schreibt nichts.

## Nicht dieses Paket

Die Viertelstunden-Tabelle und der Verdichtungs-Job (IP-12), Endgültigkeit und Tageswerte (IP-13),
der Lesepfad-Umbau (IP-14), die Lücken-Erkennung als Job (IP-9 — die SCHWELLE „ab 2 × Kadenz" steht
schon in `ZustandAbleitung.LUECKE_FAKTOR` und `VerbrauchRegeln.LUECKE_FAKTOR`), die
Rechte-Durchsetzung (AP-03 IP-6/IP-7).

## Prüfnachweis

`KadenzRegelnTest` (rein: Kette, Geltung ab Zeitpunkt, Vokabular, **A15** über den schon gebauten
Verbrauchsvertrag — MS-01 „85 von 90 · 94 %", nie 100 %), `MeasurementContractsTest` (der Draht),
`UemsQuelleKadenzMigrationTest` (Tabelle, Zaun, Rechte, Trigger, Bestand in beiden Ausprägungen,
Bestandsschutz-Fingerabdruck), `QuelleKadenzApiTest` (Ende zu Ende), `MessstelleRegisterApiTest`
(die Beobachtung verhaltensgleich).
