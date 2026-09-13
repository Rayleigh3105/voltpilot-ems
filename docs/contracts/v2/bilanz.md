# Bilanz-Vertrag: aus Stellungen wird die Energiebilanz eines Systems (UEMS AP-10)

Stand 12.09.2026 · Vertrag 1.0 · Konzept `data/vp-uems-ap10-bilanzen` §4.3–§4.9, Entscheide
E1–E19 vom 12.09.2026 (alle auf Empfehlung).

Eine **Anlage** ist das elektrische System und damit die einzige Bilanzgrenze. Dieser Vertrag sagt,
wie aus der zeitgültigen **Stellung** einer Messstelle (AP-04) ihre Bilanz-Rolle wird, wie daraus
der **Rest** eines Hauptzählers entsteht, welche **Richtung** ein Ergebnis je Formel-Typ trägt, wie
sich Zustand, Abdeckung, Kennzeichen und Version **fortpflanzen** und was ein Standort, ein
Unternehmen und ein Gebäude daraus sehen.

| Datei | Rolle |
|---|---|
| [`bilanz-vectors.json`](./bilanz-vectors.json) | **die eine Wahrheit**: die handgerechneten Referenzfälle F1–F19 mit Eingang und erwartetem Ergebnis je Prüfung |
| [`bilanz.schema.json`](./bilanz.schema.json) | das Schema für Vokabulare, Regeln und die Vektor-Datei selbst (JSON-Schema 2020-12) |
| [`bilanzwert-herkunft.schema.json`](./bilanzwert-herkunft.schema.json) | die Form des Herkunfts-Satzes, den die Regel `herkunft` baut ([Prosa](./bilanzwert-herkunft.md)) |
| `services/api/.../uems/BilanzAbleitung.java` · `BilanzwertHerkunft.java` | der **Java-Zwilling** (rein: ohne Spring, ohne DB, ohne Uhr) |
| `frontend/portal/src/uemsBilanz.ts` | der **TypeScript-Zwilling** |
| `…/uems/BilanzVectorsTest.java` · `…/src/uemsBilanz.test.ts` | beide fahren DIESELBE Vektor-Datei, per Pfad |

**Wer eine Regel ändert, ändert die Vektor-Datei UND beide Zwillinge.**

> **Wer anruft (Stand AP-10 IP-9): das Formel-Modul und die Bilanz je Anlage.**
> `MessstelleFormelRegeln.hauptgroesse` und `.periodenwert` (TS: `uemsMessstelleFormel.ts`) verzweigen
> je Formel-Typ in diese Regeln ([`messstelle-formel.md`](./messstelle-formel.md) §6.2). Seit IP-9 ist
> `GET /api/v1/sites/{siteId}/bilanz` der erste Produktionsweg: `restAusStellung` je Tag, `summe`
> für Zufluss/Abfluss/zugeordnet, `periodenwert("rest")` und `live` für die Live-Zeile — die Route
> rechnet nichts selbst. Periodenwerte berechneter Messstellen (IP-10), Herkunft (IP-12) und die
> Portal-Fläche (IP-14) folgen.

## 1. Warum es zwei Umsetzungen gibt

Dieselbe Bilanz wird an zwei Stellen gebildet: die **Cloud** rechnet die gespeicherten
Periodenwerte, das **Portal** setzt die Zeilen einer Fläche zusammen und zeigt die Live-Zeile. Zwei
Umsetzungen sind zwei Gelegenheiten, auseinanderzulaufen — deshalb gibt es EINE Vektor-Datei, die
beide per Pfad lesen, und `zwillinge` sagt je Regel, wer sie prüft. Eine Regel ohne TS-Zwilling
nennt in `zwillinge_grund` den Grund; ohne Grund gibt es keine Lücke.

## 2. Was dieser Vertrag NICHT rechnet

- **Die Menge einer Periode** — das tut die Verbrauchsregel AP-08
  ([`verbrauch-vectors.json`](./verbrauch-vectors.json), `VerbrauchRegeln`). Hier kommen die Mengen
  fertig an; von dort kommen auch die Zustandswörter „vollständig“, „unvollständig“ und
  „keine Werte“ — `BilanzAbleitung` setzt sie nicht selbst.
- **Die gewichtete Summe einer Formel** — das tut der Formel-Vertrag
  ([`messstelle-formel.md`](./messstelle-formel.md), PR #688). Die Richtungsregel des Typs
  `gewichtete_summe` und der Live-Wert werden AUFGERUFEN (`MessstelleFormelRegeln.formelGroesse`
  bzw. `.gewichteteSumme`), nie nachgebaut.
- **Die Stellung selbst** — sie gehört AP-04 ([`messstelle.md`](./messstelle.md) §6). Dieser Vertrag
  LIEST sie und ändert sie nie.
- **Die Rechte** — sie gehören AP-03 (`rechte-matrix.json`). Die neuen Kennungen tragen IP-3, IP-6,
  IP-7 und IP-8 als Nachtrag dort ein; `_nicht_geprueft` nennt das je Fall.

## 3. Die Regeln

Jede Prüfung der Vektor-Datei nennt ihre `regel`; beide Zwillinge haben zu jeder eine Funktion.

| Regel | Was sie beantwortet |
|---|---|
| `rolle` | §4.3: Was tut diese Messstelle an diesem Tag in der Bilanz ihres Systems? |
| `rest` | §4.3/§4.5: Was ist nicht zugeordnet — und was ist es NICHT? |
| `rest_aus_stellung` | §4.3/E3 (AP-10 IP-4): Mit welchen Termen rechnet der Rest eines Hauptzählers an DIESEM Tag — aus den Stellungen des Referenzunternehmens? |
| `summe` | §4.5: Was ist die Summe, wenn ein Summand fehlt? |
| `saldo` | §4.4: Was ist Bezug minus Abgabe derselben Grenze? |
| `richtung` | E1: Welche Größe und Richtung trägt das Ergebnis je Formel-Typ? |
| `ebene` | §4.8: Was sehen Standort und Unternehmen — und aus wie vielen Systemen? |
| `live` | §4.5: Was zeigt die Live-Zeile, wenn ein Term veraltet ist? |
| `gebaeude` | §4.8: Was ist in diesem Gebäude gemessen — und was ist es ausdrücklich nicht? |
| `versorgung` | F15: Welches System versorgt welches Gebäude an diesem Tag? |
| `herkunft` | §4.7/E13: Woher kommt dieser berechnete Wert? |

## 4. Die Fallen

1. **Die Richtung ist je Typ eine REGEL, keine Ableitung aus Vorzeichen.** 100 kWh Bezug minus
   60 minus 30 ergibt 10 kWh **Bezug** — nicht „richtungslos“. Genau daran hängt die Abnahme des
   Captains (F1). `richtung_je_typ` in der Vektor-Datei ist deshalb Vertrag, nicht Kommentar.
2. **Eine Differenz ist eine Differenz.** Der Rest heißt „nicht zugeordnet“; er wird nie einem
   Gerät, Gebäude, Prozess oder einer Ursache zugeschrieben. `verbotene_woerter` listet, was kein
   Satz dieses Vertrags tragen darf — der Test prüft jeden Kundensatz und jedes Kennzeichen dagegen.
3. **Summe und Differenz verhalten sich GEGENSÄTZLICH, wenn ein Eingang fehlt.** Die Summe rechnet
   mit den vorhandenen weiter und heißt „mindestens … (MS-xx fehlt)“ — sie ist dann eine
   Untergrenze. Die Differenz rechnet gar nicht: 1 200 − 1 055 wäre zu HOCH, weil der fehlende
   Unterzähler im Abzug fehlt. Sie heißt „keine Werte“ (F5).
4. **Ein negativer Rest wird gezeigt, nicht geklemmt.** „Messwerte passen nicht zusammen (−5 kWh)“
   ist die ganze Aussage; die Fläche deutet nichts (F6). Das Minuszeichen ist U+2212, nicht der
   ASCII-Bindestrich.
5. **Ein Speicher geht mit ZWEI Anteilen ein** (E4): der positive ist ein Abfluss (Laden), der
   negative ein Zufluss (Entladen) — nie als Saldo 800, nie nur mit einer Hälfte (F4).
6. **Nicht jedes Kennzeichen erbt.** `kennzeichen_erbend` sagt, was von einem Eingang in das
   Ergebnis wandert: was über die PERIODE spricht („ab 15.10.2026“, „mit Ersatzwert“), nicht was
   über einen einzelnen Messwert spricht („nachgeliefert“). Jedes Eingangs-Kennzeichen bleibt je
   Eingang in der Herkunft sichtbar (F2 gegen F14).
7. **`null` und 0 sehen nie gleich aus.** Eine Menge `null` heißt „keine Werte“; eine 0 heißt
   „gemessen 0“. Beträge reisen als Dezimaltext und werden numerisch verglichen — „10“ und
   „10.000000“ sind derselbe Betrag, ein umformatierter Text wäre eine zweite Wahrheit.
8. **Ein Gebäude hat keinen Rest.** Die Gebäude-Sicht nennt, was im Gebäude gemessen wurde, was im
   selben System außerhalb liegt und was der Rest des Systems ist („nicht verortet“) — sie bildet
   daraus nie eine Summe (F17). `gebaeudeverbrauch` ist deshalb immer `null`.
9. **Ein Standort hat keine eigene Bilanzgrenze.** Er summiert seine Systeme und sagt „x von y“;
   das geerbte Kennzeichen eines Systems steht in der Anzeige mit dem Systemnamen davor
   („Lindach ab 15.10.2026“), an der Zahl selbst nur, was die Regel sagt (F8).
10. **Der Rest folgt der STELLUNG, nicht einer bearbeiteten Formel.** Zieht ein Unterzähler in ein
    anderes System um, ändern sich beide Reste am selben Tag, ohne dass jemand eine Formel anfasst —
    die Herkunft nennt den Grund als Vermerk (F7). Vermerke werden hereingereicht, nie erraten.
    `rest_aus_stellung` (IP-4) liest die Stellungen aus `uems-referenzunternehmen.json`, nicht aus
    einer Kopie; jede Fassung mit Termen ist genau die Eingangsmenge einer `rest`-Prüfung desselben
    Falls (beide Tests prüfen das). ⚠ Nur der Rest eines **Hauptzählers Bezug** ist gebaut — den
    eigenen Rest eines Unterzählers mit Unterzählern (§4.3, Satz 2) hat das Referenzunternehmen nicht
    als Fall; die Regel antwortet dort `rest_ohne_hauptzaehler`.
11. **Der Kundensatz kommt aus `saetze`.** Die Vorlagen `rest_zugeordnet`, `rest_negativ` und
    `rest_keine_werte` stehen wörtlich als Konstanten in beiden Zwillingen und werden gegen die Datei
    geprüft — F1 sagt „10 kWh sind keiner Messstelle zugeordnet“. Zahl und Einheit (`{zahl}`)
    schreibt der Ergebnis-Zustand ([`ergebnis-zustand.md`](./ergebnis-zustand.md) §3, E11):
    `rest`/`summe` bekommen die Ebene der Periode als `zahl_ebene` (Tag, Monat ganze kWh;
    Viertelstunde/Stunde eine Stelle), Tausenderpunkt und U+00A0 vor der Einheit — „mindestens
    1.055 kWh (MS-14 fehlt)“. Die beschreibenden `anzeige`-Texte je Fall bleiben im Wortlaut der
    Vorlage (`_abweichungen`).

## 5. Was hier NICHT steht

Tabellen, Migrationen, Routen und Portal-Flächen. Dieses Paket ist der Vertrag, gegen den sie
gebaut werden: die Formel-Fassungen (IP-3), die Typen `rest` und `saldo` im Formel-Modul (IP-4),
die Term-Art `verteilung` (IP-5), der Netzanschluss (IP-6), Kostenstellen und Prozesse (IP-7), die
Verteilung (IP-8), das Bilanz-Lesemodell (IP-9) und die Periodenwerte berechneter Messstellen
(IP-10). Der Katalog-Eintrag `Wirkenergie · saldiert` steht hier als Vokabular
(`vokabulare.richtung_berechnet_additiv`) und seit IP-4 in [`messstelle.md`](./messstelle.md) §2
und `MessstelleRegeln.GROESSEN_KATALOG` (`richtungen_nur_berechnet`); `saldo` fragt den Katalog.

## 6. Herkunft der Zahlen

Alle Kennzeichen, Namen, Orte und Beträge stammen aus
[`uems-referenzunternehmen.json`](./uems-referenzunternehmen.json) (Kunststoffwerk Ahrenberg GmbH,
Fassung 1.1). Was die Ergänzung 1.2 nachträgt (E19) — MS-22, die Tageswerte des 18.10.2026, die
Speichermengen als Zahlen, MS-09 = 54 580 und das Ende der 9000-Anteile — steht in
`referenz_stand` und je Fall unter `annahmen`; die Fälle rechnen nach der Ergänzung unverändert
weiter. `_abweichungen` nennt jede Stelle, an der die Vektor-Datei bewusst von der Vorlage
abweicht, `_nicht_geprueft` jede Erwartung der Vorlage ohne Zwilling.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='BilanzVectorsTest,MessstelleFormelTypenTest')   # rein, kein Docker
(cd frontend/portal && npx vitest run src/uemsBilanz.test.ts src/uemsMessstelleFormelTypen.test.ts)
```
