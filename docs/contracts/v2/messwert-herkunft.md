# Herkunftsvertrag je Messwert (UEMS AP-07 IP-1)

Stand 11.09.2026 · Vertrag 1.0 · Bezug: AP-07 §4.1/§4.2/§4.5/§4.7/§4.8/§4.9 und die
Captain-Entscheide **E1–E4, E13** vom 10.09.2026 (alle Option A).

Dieser Vertrag sagt, **was jeder Messwert des Unternehmens-Energiemanagements über seine
Herkunft trägt** und **wie aus dem, was die Box liefert, und dem, was die Cloud zur Messzeit
weiß, genau ein Urteil wird** — gespeichert, Wiederholung, abgewiesen oder kein Wert —, samt
den Ereignissen, die dabei entstehen.

| Datei | Rolle |
|---|---|
| [`messwert-herkunft-vectors.json`](./messwert-herkunft-vectors.json) | 20 Fälle im Referenzunternehmen Ahrenberg, dazu die 15 Angaben, das Vokabular und die Regel-Zahlen |
| [`messwert-herkunft.schema.json`](./messwert-herkunft.schema.json) | JSON Schema 2020-12 der Vektor-Datei (Eingang, Ergebnis, Herkunft) |
| `services/api/.../uems/MesswertHerkunft.java` | die reine Ableitung (ohne Spring, ohne Datenbank, ohne Uhr) |
| `services/api/.../uems/MesswertHerkunftVectorsTest.java` | Schema, Fälle, Regel-Zahlen, Vokabular — und jeder Fall gegen [`uems-referenzunternehmen.json`](./uems-referenzunternehmen.json) |

Der TS-Zwilling folgt mit der Rohtabelle (AP-07 IP-6). **Wer die Regel ändert, ändert die
Java-Klasse UND die Vektor-Datei.**

> **Wer anruft.** Seit IP-7 der Writer (`services/timescale-writer`): er hält einen Zwilling von
> `MesswertHerkunft` (`MesswertHerkunftZwillingTest` spielt diese Vektor-Datei) und ruft
> `stelleFest` je Wert mit den Fakten, die er ZUR MESSZEIT nachschlägt. Die Datenannahme prüft
> seit IP-5 die Messzeit selbst (§3 Regel 1). ⚠ `measurements.raw` 1.0 trägt weder `entity_id`
> noch `applied_revision` — Komponente und Fassung kommen deshalb heute IMMER aus dem Nachschlag
> (`quelle: zustellung`); das Durchreichen der 2.1-Felder ist IP-18.

## 1. Die Reihe und die Spur

- **Reihe** = Kundenbereich + Komponente + Messkanal (E2). Sie folgt der Komponente und
  überlebt Geräte-, Box- und Zuständigkeitswechsel; Gerät, Box und Fassung sind Herkunft JE
  WERT, nie Schlüssel.
- **Messzeit** = Zeitpunkt der Messung nach der Uhr der Box, gespeichert in UTC — auch beim
  Nachliefern das Original. **Eingangszeit** = Zeitpunkt der Entgegennahme in der
  Datenannahme, nach der Uhr der Cloud. Verdichtung, Verbrauch und Berichte rechnen mit der
  Messzeit; „liefert Daten“, Nachlieferung, Sequenz und der Nachweis der Zustellung mit der
  Eingangszeit.
- **Spur.** Die Werte einer Reihe liegen in der **zuständigen Spur** (Rolle `fuehrend`,
  `vergleich` oder `beobachtung` — die Box, die zur Messzeit zuständig war) oder in der
  **Spiegel-Spur** der lesenden Box (Rolle `spiegel`). Der Idempotenz-Schlüssel gilt je Spur
  (§3 Regel 5). So hält der Vertrag E3 („Reihe + Messzeit“) und E4 („nie in der führenden
  Reihe“, A9 „kein stilles Verdrängen bei identischen Messzeiten“) zugleich.

## 2. Die fünfzehn Angaben je Wert

Jeder gespeicherte Rohwert trägt diese Angaben, und sie überleben bis in den
Viertelstundenwert (AP-07 §4.2). **Woher:** *Box* = die Box liefert es · *Datenannahme* = die
Datenannahme stempelt es bzw. liest es aus der Anmeldung der Box · *Nachschlag* = die Cloud
schlägt es beim Schreiben ZUR MESSZEIT nach · *Ableitung* = der Writer leitet es ab.

| # | Angabe (Feld) | Art | Woher | Ältere Box (Vertrag 2.0) | Am Draht / in der Tabelle |
|---|---|---|---|---|---|
| 1 | Kundenbereich (`kundenbereich`) | Schlüssel | Datenannahme (Topic = mTLS-Identität, im Paket byte-gleich) | — | `tenant_id` |
| 2 | Komponente (`komponente`) | Schlüssel | Box (Mess-Plan je Komponente, Stufe 3c) | Nachschlag: die Cloud ergänzt sie aus der Auswahl | `entity_id` je Sample (2.1, IP-2) |
| 3 | Messkanal (`messkanal`) | Schlüssel | Box (Mess-Plan / Katalog) | — | `point_key` |
| 4 | Messzeit (`messzeit`) | Schlüssel | Box (Layer 1 stempelt; je Sample möglich, sonst die Hülle) | — | `observed_at` → `time` |
| 5 | Eingangszeit (`eingangszeit`) | Marker | Datenannahme | — | `ingested_at` → `received_at` |
| 6 | Wert (`wert`: `raw`, `decoded`, `einheit`) | Inhalt | Box; Einheit: Katalog/Fassung | — | `raw`, `decoded`; Einheit aus dem Katalog |
| 7 | Qualität (`qualitaet`) | Marker | Box (`good · uncertain · invalid · stale · device_error`, unverändert) | — | `quality` |
| 8 | Wertart (`wertart`) | Marker | Nachschlag (Katalog/Vorlage zur Messzeit, E12) | — | `value_kind` (IP-6) |
| 9 | Lesende Box (`lesende_box`) | Marker | Datenannahme (Topic/mTLS) | — | `device_id` |
| 10 | Gerät + Einbau (`geraet_einbau`) | Marker | Nachschlag (Gerät-Historie der Komponente zur Messzeit, AP-04) | — | `device_install_id` (IP-6) |
| 11 | Einstellungs-Fassung (`einstellungs_fassung`) | Marker | Box meldet die angewendete Fassung (AP-04 E5) | Nachschlag: die zur Messzeit angewendete Fassung der Zustellung (`applied_at`) | `applied_revision` je Umschlag (2.1, IP-2) |
| 12 | Katalogstand (`katalogstand`) | Marker | Box (aktiver Plan) | — | `catalog_version` |
| 13 | Sequenz (`sequenz`) | Marker | Box (monoton je Box) — Kennzeichen, KEIN Schlüssel mehr (E3) | — | `sequence` / `edge_sequence` |
| 14 | Zustellart (`zustellart`: `art`, `verzoegerung_s`) | Marker | Ableitung aus Messzeit, Eingangszeit und Kadenz | — | `delivery`, `delay_s` (IP-6) |
| 15 | Rolle (`rolle`) | Marker | Ableitung aus Zuständigkeit (AP-06) und Quellenbindung (AP-04) zur Messzeit | — | `role` (IP-6) |

Die Einstellungs-Fassung trägt zusätzlich, woher sie stammt (`quelle`: `box` | `zustellung`);
so bleibt sichtbar, welche Werte die Cloud vervollständigt hat. Eine ältere Box wird
vervollständigt, **nie abgelehnt** (Invariante 8) — abgelehnt wird nur, was die Cloud auch
nicht nachschlagen kann (§3 Regel 3).

## 3. Die Ableitung — sechs Prüfungen in fester Reihenfolge

1. **Zeit (E13, Datenannahme).**
   Messzeit **mehr als** 300 s nach der Cloud-Uhr → abgewiesen, Ereignis `clock_ahead` (je Box
   gezählt). Messzeit **älter als** 90 × 24 h (7 776 000 s, in UTC gerechnet — über die
   Zeitumstellung liegt die Kante eine Stunde anders als in Ortszeit) → abgewiesen, `too_old`.
   Genau 300 s vor bzw. genau 90 Tage alt wird angenommen. Die Cloud ersetzt nie eine
   unplausible Messzeit (E13 Option C wäre eine geratene Zeit). Ein abgewiesener Wert erzeugt
   genau sein Abweisungs-Ereignis und nichts sonst.
2. **Sequenz der Box (E3/E13),** gegen den zuletzt gesehenen Umschlag derselben Box:
   gleiche Sequenz → nichts (Wiederholung desselben Umschlags); `+1` → aufeinanderfolgend, und
   liegen die Messzeiten der beiden Hüllen **mehr als** 300 s auseinander, ist die Uhr
   gesprungen → `clock_jump` (vorwärts positiv); größer als `+1` → `sequence_gap` mit Anzahl
   der fehlenden Umschläge; kleiner → `sequence_reset`. **Der Wert bleibt** in jedem Fall,
   seine Qualität bleibt unverändert.
3. **Herkunft vollständig (Invariante 1).** Ohne Komponente (weder von der Box noch aus der
   Auswahl), ohne Gerät-Einbau zur Messzeit oder ohne Fassung ist der Wert kein Messwert des
   Unternehmens-Energiemanagements → abgewiesen, Ereignis `rejected` mit Grund
   `herkunft_unvollstaendig`. Nie geraten, nie einem Gerät zugeschlagen.
4. **Rolle zur Messzeit (E4, §4.7).** Geprüft wird die Zuständigkeit ZUR MESSZEIT, nicht zur
   Eingangszeit (W8: ein Nachzügler nach einer Übergabe ist führend, wenn seine Box zur
   Messzeit zuständig war).
   - lesende Box ≠ zur Messzeit zuständige Box → `spiegel`, gespeichert, nie in der führenden
     Reihe, nie in der Verdichtung; Ereignis `unassigned_reader` **höchstens einmal je Stunde
     je Box und Datenquelle** (gemessen an der Eingangszeit; genau eine Stunde später wieder).
   - sonst entscheidet die Quellenbindung zur Messzeit: führende Quelle einer Messstelle →
     `fuehrend`; gekennzeichnete, bestätigte Vergleichsquelle (AP-04 E3, AP-06 E10) →
     `vergleich`; an keine Messstelle gebunden → `beobachtung`.
   - Liest dasselbe Gerät über eine ZWEITE Box als Vergleich (AP-06 E10), ist die
     Vergleichsquelle eine eigene Komponente an dieser Box — dort zuständig, als Vergleich
     gebunden; die Regel ist dieselbe. „Dieselbe Komponente aus zwei Boxen“ ist nie ein
     Vergleich, sondern ein Spiegel.
   - Nur `fuehrend` fließt in Verbrauch, Bilanz, Kennzahl und Bericht (AP-08/AP-10/AP-11/AP-12);
     `vergleich` wird angezeigt, nie verrechnet.
5. **Idempotenz (E3).** Schlüssel = **Reihe + Messzeit**, je Spur (§1). Liegt dort schon ein
   Wert:
   - **gleicher Wert** — `raw`, `decoded` und Qualität gleich (Zahlen nach Betrag) → Urteil
     `wiederholung`: nicht gespeichert, nur gezählt (Zähler „wiederholt“ je Box und Tag), kein
     Ereignis. Katalogstand, Fassung und Sequenz entscheiden nicht; der erste Wert behält seine
     Herkunft. Dasselbe Paket zweimal (QoS-1-Wiederholung, Cursor-Replay, Box-Neustart,
     zurückgesetzter Zähler) ist also EIN Wert.
   - **abweichender Wert** → abgewiesen, Ereignis `duplicate_conflict` mit beiden Werten und
     beiden Sequenzen; der erste gespeicherte Wert bleibt (AP-04 E5), nie still, nie
     überschrieben. Eine Korrektur ist ein eigener Vorgang (AP-08).
6. **Zustellart.** Verzögerung = Eingangszeit − Messzeit in Sekunden. Eingang **später als**
   `max(300 s, 3 × Kadenz)` → `nachgeliefert`, sonst `direkt`. Die Verzögerung reist
   ungeschönt mit — auch negativ, wenn die Uhr der Box innerhalb der Toleranz vorgeht.
   Nachgelieferte Werte sind GEMESSENE Werte, keine Auffüllung.

## 4. Ereignisse

Diese Ableitung kann acht Ereignisarten aus dem geschlossenen Vokabular (AP-07 §4.8, E11)
auslösen. Die Vektoren tragen je Ereignis nur die Felder, die beim Annehmen EINES Werts bekannt
sind; die volle Nutzlast (Zeitraum, Anzahl über viele Werte, Urheber) legt der Ereignis-Vertrag
**AP-07 IP-3** fest und bleibt additiv dazu.

| Art | Urheber | Anlass | Felder in dieser Ableitung |
|---|---|---|---|
| `clock_ahead` | Datenannahme | Messzeit > 300 s in der Zukunft | `box`, `vor_s` |
| `too_old` | Datenannahme | Messzeit älter als 90 × 24 h | `box`, `alter_s` |
| `clock_jump` | Datenannahme | aufeinanderfolgende Umschläge > 300 s auseinander | `box`, `sequenz`, `sprung_s` |
| `sequence_gap` | Writer | Sequenz springt nach oben | `box`, `sequenz_erwartet`, `sequenz_erhalten`, `anzahl` |
| `sequence_reset` | Writer | Sequenz springt nach unten | `box`, `sequenz_erwartet`, `sequenz_erhalten` |
| `rejected` | Writer | Herkunft unvollständig (Invariante 1) | `box`, `grund` |
| `unassigned_reader` | Writer | Wert aus einer zur Messzeit nicht zuständigen Box | `box`, `datenquelle`, `komponente` |
| `duplicate_conflict` | Writer | gleiche Reihe + Messzeit, anderer Wert | `box`, `komponente`, `messkanal`, `messzeit`, `gespeicherter_wert`, `abgewiesener_wert`, `sequenzen` |

**Nicht hier**, sondern in ihren Paketen: `data_gap` und `backfill` (Lücken-Erkennung aus
Kadenz und Herzschlag, IP-9), `late_arrival` (Rohwert nach Endgültigkeit des
Viertelstundenwerts, IP-13), `device_boundary` (Zählerwechsel, vom Kunden eingetragen, AP-04),
`handover` (Zuständigkeitswechsel, AP-06), die Box-Ereignisse (`box_restart`, `device_restart`,
`frozen_source`, …, IP-19) und die Übergangs-Ereignisse (`counter_reset`, `state_change`, …).

Der Grund `herkunft_unvollstaendig` ist ein neues Wort; das Vokabular der Ablehnungsgründe
schließt IP-3 — es übernimmt dieses Wort oder ersetzt es zusammen mit dieser Datei.

## 5. Zeit

- Messzeiten in UTC in allen Klassen; das Viertelstunden-Raster ist UTC (deckungsgleich mit
  der Ortszeit-Viertelstunde); Tageswerte rechnen in der Zeitzone des Standorts (IP-13, W10).
- Die Vektoren schreiben Eingangs-Zeitpunkte mit dem Versatz von Europe/Berlin (wie die
  Referenzdatei) und die fünfzehn Angaben in UTC (`…Z`, auf die Sekunde).
- Der einzige erlaubte Herkunfts-Nachtrag: trägt der Kunde einen Zählerwechsel rückwirkend ein
  (MS-06: eingetragen 11:05, gültig ab 10:40), wird der Einbau der schon gespeicherten Werte
  10:47–11:05 nachgeführt — protokolliert (AP-07 §5.2). Die Ableitung ist beim Schreiben und
  beim Nachführen dieselbe: der Einbau, den die Gerät-Historie für die Messzeit nennt.

## 6. Die Fälle

| Fall | Belegt | Urteil |
|---|---|---|
| `ms06-1039-letzter-wert-z5a` | §4.2-Karte, A5 | gespeichert · Z-5a · direkt 7 s · führend |
| `ms06-1041-luecke-nie-null` | A5 | kein Wert — nie 0 (Einbau zur Messzeit wäre schon Z-5b) |
| `ms06-1047-erster-wert-z5b` | A5, E2 | gespeichert · Z-5b · dieselbe Reihe |
| `gleiche-messzeit-abweichender-wert-konflikt` | E3, A11 | abgewiesen · `duplicate_conflict` |
| `nachlieferung-box-halle-2-nach-ausfall` | A3, §4.1 | gespeichert · nachgeliefert 8 348 s · Komponente und Fassung von der Cloud ergänzt |
| `umschlag-48213-doppelt-ein-wert` | E3, A1 | Wiederholung · kein Ereignis |
| `umschlag-48213-sequenz-zurueckgesetzt` | E3, A1 | Wiederholung · `sequence_reset` |
| `sequenz-luecke-188-umschlaege` | §4.8, A4 | gespeichert · `sequence_gap` (188) |
| `uebergabe-nachzuegler-vor-der-uebergabe` | E4, A6 | gespeichert · führend (zuständig zur Messzeit) |
| `uebergabe-plan-verspaetet-spiegel` | E4, A6 | gespeichert · Spiegel · `unassigned_reader` |
| `spiegel-bei-gleicher-messzeit-verdraengt-nicht` | E3+E4, A9 | gespeichert · Spiegel · keine Wiederholung, kein Konflikt, kein zweites Ereignis in der Stunde |
| `beobachtung-kanal-ohne-messstelle` | §4.1 | gespeichert · Beobachtung |
| `vergleichsquelle-bestaetigt` | E4, AP-04 E3 | gespeichert · Vergleich (Vergleichsquelle der Referenzdatei, §7) |
| `ohne-einbau-zur-messzeit-abgewiesen` | Invariante 1 | abgewiesen · `rejected` |
| `uhr-6-minuten-vor-clock-ahead` | E13, A13 | abgewiesen · `clock_ahead` (360 s) |
| `uhr-genau-5-minuten-vor-angenommen` | E13 (Kante) | gespeichert · direkt −300 s |
| `zeitsprung-clock-jump-werte-bleiben` | E13 | gespeichert · `clock_jump` (390 s) |
| `wert-91-tage-alt-too-old` | E13 | abgewiesen · `too_old` |
| `genau-90-tage-angenommen` | E13 (Kante) | gespeichert · nachgeliefert 7 776 000 s |
| `nachgeliefert-kante-300-s-direkt` | Zustellart (Kante) | gespeichert · direkt 300 s |

Den Zweig, in dem `3 × Kadenz` die Nachlieferungs-Schwelle bestimmt, prüft der Java-Test als
Einheit — kein Ahrenberg-Messkanal hat mehr als 100 s Kadenz.

## 7. Widersprüche und Annahmen

Die Fälle folgen dem Wortlaut der Entscheide; wo das Konzept und die Referenzdatei
auseinanderlaufen, gewinnt für Kennzeichen, Seriennummern und Zeitpunkte die Referenzdatei.

1. **Ausfall Box Halle 2 am 03.11.2026 — aufgelöst (Referenzdatei 1.1).** Die Datei erzählt
   jetzt EINE Folge, die AP-00 §7.6, AP-06 A2/A5 und AP-07 A3 zugleich trägt: 14:00 Ausfall
   (die Box liest weiter und puffert) → 17:30 Rückkehr, 17:31–17:34 Nachlieferung 14:00–17:30
   → Netzteil-Defekt festgestellt, die Box läuft bis zum Tausch weiter → 04.11.2026 09:38 Box
   Halle 2 (neu). Die Fälle `nachlieferung-box-halle-2-nach-ausfall`, `umschlag-48213-*` und
   `sequenz-luecke-188-*` stehen damit so in der Datei. Regel 6 (§4.5 „ein Box-Tausch liefert
   nicht nach“) bleibt wahr: der Puffer war um 17:34 schon geleert; sichtbar bleibt nur die
   Lücke der Übergabe 09:38–09:40. A5s „Herkunft bis 14:00 E-2“ heißt deshalb „bis 09:38 E-2“.
2. **Übergabe DQ-3 am 10.04.2027 — an welche Box?** AP-07 §5.2 nennt Box Halle 2
   (VP-BOX-2026-0482); die Referenzdatei nennt Box Halle 2 (neu), E-2′ (VP-BOX-2027-0090) —
   E-2 ist seit 04.11.2026 ausgebaut. Die Fälle folgen der Datei.
3. **Vergleichsquelle im Referenzunternehmen — aufgelöst (Referenzdatei 1.1).** Die Datei führt
   K-1 · Einspeise-/Bezugsleistung am Wechselrichter an MS-01 als Vergleichsquelle der
   Wirkleistung ab 20.11.2026 08:30 (AP-04 §4.1, eingetragen von Ines Kaltenbach).
   `vergleichsquelle-bestaetigt` spielt zu diesem Zeitpunkt und braucht keine Annahme mehr; der
   Test prüft jede Vergleichsbindung gegen die Datei wie eine führende.
4. **Idempotenz und Spiegel (E3 × E4).** E3 setzt den Schlüssel auf Reihe + Messzeit, E4
   speichert den Wert einer nicht zuständigen Box „nie in der führenden Reihe“, A9 verlangt
   „kein stilles Verdrängen bei identischen Messzeiten“. Beides zugleich geht nur je Spur (§1);
   die Rohtabelle (IP-6) muss den Spiegel deshalb außerhalb des Unique-Index
   `(tenant_id, entity_id, point_key, time)` der zuständigen Spur halten.
5. **Werte, die die Datei nicht nennt,** sind Werte der Vektor-Datei mit Quelle im Fall:
   Sequenzen, Eingangszeiten, Katalogstand `2026.08.26.3` und Fassung 1 aus AP-07 §4.2;
   Zählerstände von K-8.1 und von Z-5b im April 2027 sind Beispielwerte. Den Zählerstand
   1 061 902,7 kWh und die Momentanleistung 61,3 kW von MS-06 am 20.10.2026 (AP-07 §5.2)
   benutzt kein Fall — die Referenzdatei nennt für diesen Zeitpunkt 148,6 kW.

## 8. Was dieser Vertrag nicht regelt

MQTT `measurement-samples` 2.1 (`entity_id`, `applied_revision` — IP-2), den Ereignis-Vertrag
(IP-3), die Umsetzung in Datenannahme, Rohtabelle und Writer (IP-5/IP-6/IP-7), Lücken und
Nachlieferungs-Ereignisse (IP-9), Viertelstunden- und Tageswerte samt Endgültigkeit
(IP-12/IP-13), die Spiegel-Kennzeichnung Kern-Kanal ↔ Katalogpunkt (IP-17, §4.7 a) und die
Auflösung einer mehrdeutigen Komponente bei einer älteren Box (IP-7, §4.7 c).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='MesswertHerkunftVectorsTest')   # rein, kein Docker
```

## Ablesungen (AP-09 IP-8, additive Spur)

Die bisherige Komponenten-/Messkanal-Spur bleibt unverändert. Eine Ablesung gehört zu
Kundenbereich + Messstelle + Größe und trägt `spur = ablesung`, `woher = eingabe|import`
und `urheber {sub, name, rolle, art}`. Sie hat weder Box noch Komponente, Geräte-Einbau,
Sequenz oder Katalogfassung. `import` ist für den späteren Importweg vorbereitet; diese
API nimmt ausschließlich Eingaben an. Die fünf Ablesungsvektoren stehen separat in
`messwert-herkunft-vectors.json` unter `ablesungen` und laufen in API und Writer.

Der Rohwert steht in `device_measurement_sample`; `ablesung_quelle_id` verweist auf
`messstelle_quelle.art = ablesung`. Der exakte Dezimalstand steht in `ablesung_stand`.
Ein Trigger bewahrt Eingang, Herkunft und jede Fassung dauerhaft in
`messstelle_ablesung_fassung`, auch nach der 90-Tage-Aufbewahrung der Rohwertklasse.
Der Kanalpfad verdichtet nur Werte mit Komponente; Ablesungen haben außerdem keine
`long_term_cadence_s`. Monatszuordnung ist ein Kennzeichen, keine Interpolation.

`POST /api/v1/messstellen/{kennzeichen}/ablesungen` nimmt `zeitpunkt` mit UTC-Versatz
und voller Minute sowie `stand` als deutschen Zahltext an. `zuordnung_monat` ist
`JJJJ-MM`, explizit `null` oder fehlt für die Vorgabe nach größtem Zeitanteil (höchstens
zwei berührte Monate). Der erste Stand schließt keinen Zeitraum. Rücksprünge brauchen
zunächst die Klärung des Zählerwechsels und werden nicht als Verbrauch gewertet.

`POST …/ablesungen/{zeitpunkt}/berichtigung` nimmt `stand`, `zuordnung_monat` und
`begruendung` (10–500 Zeichen) an. Eine unveränderte Wiederholung schreibt nichts;
ein anderer Stand am selben Zeitpunkt braucht diesen Berichtigungsweg. Die gemeinsame
Vier-Augen-Einstellung entscheidet über sofortige Wirkung oder einen `K-…`-Vorschlag.
Freigabe und Rücknahme laufen über die vorhandenen Korrekturrouten. Jede wirksame
Berichtigung hängt eine Rohwertfassung und betroffene Periodenversionen an; kein
endgültiger Betrag wird überschrieben. Erstwerte selbst werden nicht zurückgenommen.
`GET …/ablesungen` liefert alle Fassungen mit Herkunft. Rechte: `ablesung.erfassen`
(U/U/S, keine Unterstützer), Lesen `messwerte.ansehen`, einschließlich Zielumfang.

Das AP-08-Lesemodell liest zugeordnete Monate und Jahre aus der Periodenklasse:
B8/F17 = Oktober 1 240 m³ mit Ablesezeitraum, November keine Werte. Ein Monat summiert
seine zugeordneten Intervalle; Tageswerte werden nicht erzeugt. Ohne Monatszuordnung
bleibt der Betrag unbekannt und der Monatswert trägt den entsprechenden Hinweis.
