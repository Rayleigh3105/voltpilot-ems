# UEMS AP-08 IP-2: die MENGE je Viertelstunde — die erste echte Verbrauchsrechnung

Migration `V20260912180000__uems_viertelstunde_menge.sql` (vier Spalten an
`messreihe_viertelstunde`), Lauf `uems/ViertelstundeVerdichter` (unverändert im Ablauf),
Konstanten `uems/ViertelstundeRegeln.FAKTOR_DER_FASSUNG` + `kennzeichenJson`. Tests:
`UemsViertelstundeMengeTest` (Testcontainers, 18 Fälle), `ViertelstundeRegelnTest`.

## Was entsteht

Bis AP-07 IP-12 legte der Fünf-Minuten-Lauf je Viertelstunde nur die **Fakten** ab —
Anfangs- und Endstand nach Z1, Summe, Mittel/Min/Max, erster und letzter Wert,
Qualitätszähler, Abdeckung, Herkunfts-Anker — und rechnete bewusst **keine Differenz**
(„die Strecke rechnet keine Differenz", A5). Diese Stufe ergänzt genau diese eine Aussage:

| Spalte | Was sie ist |
|---|---|
| `menge` | die Menge der Periode in der Einheit der Reihe (Z2/Z3). **`NULL` heißt „keine Menge bildbar" — nie `0`.** |
| `menge_zustand` | `vollständig` · `unvollständig` · `keine Werte` (§4.5). `NULL` = AP-08 kennt für die Wertart keine Regel. |
| `kennzeichen` | `jsonb`-**ARRAY** von Klartext-Sätzen; Wortlaut UND Reihenfolge sind Vertrag. |
| `faktor` | Z8, der Faktor, mit dem gerechnet wurde — damit `menge` erklärbar ist. Heute immer `1`, siehe unten. |

**Was schon dastand und NICHT doppelt angelegt wurde:** `abdeckung_prozent`,
`erhalten`/`erwartet`, `kadenz_s`/`kadenz_herkunft` und `zustand` kommen alle aus IP-12.

⚠ **`zustand` und `menge_zustand` sind zwei verschiedene Fragen.** `zustand` trägt die
Vorläufigkeit (`vorlaeufig`/`endgueltig`, AP-07 E5), `menge_zustand` die Vollständigkeit der
Menge. „Ist die Zahl endgültig?" und „ist jede Kilowattstunde gezählt?" haben nichts
miteinander zu tun — darum zwei Spalten und nicht eine.

## Gerechnet wird NICHT hier

Der Lauf rief `VerbrauchRegeln.ergebnis(...)` schon vorher auf (für Periodenstand, Mittel,
Abdeckung) — **neu ist nur, dass er `menge`, `zustand` und `kennzeichen` desselben
`Ergebnis` nicht mehr wegwirft.** Es entsteht kein zweiter Rechenweg; wer die Regel ändert,
ändert `docs/contracts/v2/verbrauch-vectors.json` und **beide** Zwillinge (Python
`verbrauch.py` ⟷ Java `uems/VerbrauchRegeln`).

## ⚠ Der Ort des Faktors: beim Erfassen, nie hier

`ViertelstundeRegeln.FAKTOR_DER_FASSUNG` ist `1`, und das ist **kein Platzhalter**, sondern
die Antwort von `docs/contracts/v2/quelle-einstellung.md` §3:

* `angewendet` — „VoltPilot wendet sie **beim Erfassen** an" → der Rohwert trägt den Faktor.
  Steht die Zustellung einer eingetragenen Fassung aus, sagt derselbe Vertrag: „bis dahin
  erfasst sie wie bisher. Bereits erfasste Werte berechnet VoltPilot nie neu."
* `dokumentiert` — „im Gerät eingestellt, **VoltPilot rechnet nichts um**" → das Gerät trägt
  den Faktor.

In **beiden** Fällen steckt der Faktor schon im gespeicherten Wert; ihn hier anzuwenden
verdoppelte ihn. Genau deshalb legte IP-12 den Wert ab, „wie die Box ihn geliefert hat", und
schrieb die Fassung nur als ANKER dazu. Der Test hängt eine Skalierung ×10 an F1 und prüft,
dass die Menge 36,0 bleibt (nicht 360,0).

**⚠ Befund:** Für eine Fassung, die die **Cloud** umrechnen müsste, gibt es im Vokabular von
`quelle_einstellung.anwendung` heute **kein Wort** — es kennt nur `angewendet` und
`dokumentiert`. Entstünde sie, braucht es erst das dritte Wort (AP-04/AP-06); die Rechnung
selbst hat dann genau EINE Stelle zu ändern.

## Die vier Fallen

* **Eine Lücke ist nie eine Null.** Eine Viertelstunde ohne einen einzigen Rohwert bekommt
  **gar keine Zeile** (IP-12); wo eine Zeile steht, aber keine Menge bildbar ist, steht
  `NULL`. Der CHECK `…_keine_werte_chk` hält das auch an der Datenbankgrenze.
  Plan-Abnahme 1 (F6): ein Zählerrücksprung ergibt 14,28 kWh (11,22 + 3,06) — nie ±6 184,37.
  Plan-Abnahme 2 (F8): der Box-Ausfall 14:00–17:31 erzeugt in keiner Viertelstunde eine 0.
* **Abdeckung ist nicht Vollständigkeit.** F15 ist `vollständig` bei 93 %, F6 ist
  `unvollständig` bei 100 %. Nichts wird aufgefüllt und nichts auf 100 % gerundet.
* **Eine Lücke beginnt ÜBER 2 × Kadenz** — mit der Kadenz, die **zum Intervall** galt
  (`KadenzRegeln`, IP-10), nie der von „jetzt". Dasselbe Loch von 400 s ist mit 300 s keine
  Lücke und mit 60 s eine; ein Test zeigt beide Seiten.
* **Der Faktor wirkt genau einmal** (oben).

## ⚠ Die Grenzen

* **AP-07 IP-13:** der Lauf schreibt weiter NUR `vorlaeufig` und rührt eine `endgueltig`e
  Zeile nie an — auch nicht, um sie zu heilen (geprüft: eine von Hand verbogene endgültige
  Zeile bleibt Zeichen für Zeichen stehen, dieselbe Zeile wieder `vorlaeufig` wird geheilt).
  Umschalten, `late_arrival` und Tageswerte sind IP-13.
* **AP-08 IP-12 ff.:** keine Korrekturen, keine Kaskade, keine Versionierung. `version`
  bleibt 1; eine Zeile mit `version > 1` wird ebenso wenig angefasst wie eine endgültige.
* **AP-08 IP-9 (E7):** keine Ersatzwerte. Das Wort `mit Ersatzwert` steht im CHECK, weil der
  Vertrag es kennt — der Lauf schreibt es nie.
* **AP-08 IP-5:** Stunde, Tag, Monat, Jahr. Die Vektor-Fälle **F16 und F20 tragen
  ausschließlich Monats-, Tages- und Zeitraum-Erwartungen** — von ihnen prüft dieses Paket
  die Viertelstunden-Hälfte (F16: die Periodengrenze P2, der Stand um Mitternacht gehört
  beiden Nachbarn; F20: die Lücke über die Tagesgrenze ist nie eine Null).
* **AP-07 IP-14:** kein Lesepfad, keine Route, keine Portal-Fläche.

## Wertarten ohne Regel

`state`, `bitfield` und `text` haben bei AP-08 keine Regel (S1/S2). Ihre Zeilen tragen
`menge`, `menge_zustand` **und** `kennzeichen` leer — **keine Aussage**, statt
„unvollständig" zu behaupten. Abdeckung und Qualitätszähler stehen weiterhin da.

## Rechte

Nichts zu tun: Rechte hängen an der TABELLE (IP-12: App-Rolle nur `SELECT`, Schreiben nur
über die BYPASSRLS-Rolle), die neuen Spalten erben sie, und RLS + FORCE gilt je ZEILE.
Geprüft wird es trotzdem (`derZaunStehtAuchUeberDerMenge`).

Prüfnachweis (gezielt): `(cd services/api && ./mvnw test -Dtest=UemsViertelstundeMengeTest)`
— JDK 21 und Docker nötig.
