# Kennzahl: Menge je Bezugsgröße, Anteil, Summe durch Summe (UEMS AP-11)

Stand 14.09.2026 · Vertrag 1.0 · Konzept `data/vp-uems-ap11-kennzahlen` §4, §5.8, §7, §8 IP-1/IP-3, Entscheide
E1–E13 und W1–W8 vom 14.09.2026.

Die Abnahme des Captains: **„kWh je Stück funktioniert für Gebäude und Unternehmen. Standortquotienten werden nicht
ungewichtet gemittelt.“** — Halle 2 6 100 kWh ÷ 41 000 Stück = **0,15 kWh je Stück**, Montagehalle Lindach 3 600 ÷ 7 200 =
**0,50**, das Unternehmen (6 100 + 3 600) ÷ (41 000 + 7 200) = **0,20**. Das ungewichtete Mittel 0,32 entsteht nirgends.

| Datei | Rolle |
|---|---|
| [`kennzahl.schema.json`](./kennzahl.schema.json) | die Form der Vektor-Datei |
| [`kennzahl-vectors.json`](./kennzahl-vectors.json) | 22 Fälle K1–K22, 120 Prüfungen, Vokabulare, Kundensätze, `zwillinge`, `_abweichungen`, `_nicht_geprueft` |
| [`kennzahlwert-herkunft.md`](./kennzahlwert-herkunft.md) + Schema | die Herkunft eines Kennzahl-Werts (Hülle `{satz, fehlt}`) |
| [`ergebnis-zustand-vectors.json`](./ergebnis-zustand-vectors.json) Block `kennzahl_kennzeichen` (1.9) | Wortlaut, Rang und Erbregeln der Kennzeichen ([`ergebnis-zustand.md`](./ergebnis-zustand.md) §7) |
| [`events-vocabulary-vectors.json`](./events-vocabulary-vectors.json) Block `reserviert` | `correction` mit Bezug `bezugsgroesse`, `kennzahl_neu_gebildet` — reserviert; angelegt seit V20260915010000 bzw. V20260915061500 |
| [`uems-referenzunternehmen.json`](./uems-referenzunternehmen.json) 1.3 | BZ-6, BZ-7 und `kennzahlen[]` KZ-0001 … KZ-0005 — die Fallquelle der Regel `referenz` |
| `services/api/.../uems/KennzahlRegeln.java` | der Java-Zwilling (rein) |
| `frontend/portal/src/uemsKennzahl.ts` | der TS-Zwilling (rein) |

> **Wer anruft:** noch niemand. Tabellen (IP-4), Routen (IP-5), Rechenlauf (IP-6), Werte und Herkunft lesen (IP-7),
> Kaskade (IP-8/IP-9), Vorlagen (IP-10), Zusammenfassung im Lauf (IP-11) und das Portal (IP-13 ff.) rufen diese Regeln an.

## 1. Das Objekt (E1)

Eine Kennzahl ist ein **eigenes Objekt neben der Messstelle** — nicht eine Messstelle mit Nenner und nicht ein Baustein
der Eigenen Auswertung. Sie trägt ein Kennzeichen `KZ-0001` (nie weitergegeben), Name, genau einen Geltungsbereich (§10),
Verantwortlichen und Zweck. Ihre **Berechnung** (Rechenform und Eingänge) lebt in tagesgültigen **Fassungen** (§8); ihr
**Wert** je Periode trägt Zustand, Richtung, Abdeckung, Kennzeichen, vorläufig/endgültig, **Version** und Herkunft. Die
Kennzahl *benutzt* die erprobten Muster — sie kopiert sie nicht: der Kreis ist `MessstelleFormelRegeln.zyklus`, eine Fassung
`MessstelleFormelRegeln.fassungEintrag`/`fassungAm`, der Stichtag `BezugsdatenRegeln.wertAm`, die Periodengrenzen
`BezugsPeriode.spanneVon`, die Zahlform `ErgebnisZustand`, das Recht `RechteAbleitung.darf`.

## 2. Rechenformen (E2) — ein geschlossener Satz

| Form | Eingänge | Ergebnis | Einheit |
|---|---|---|---|
| `quotient` | Menge (Messstelle · Bezugsgröße · Kennzahl) und Bezugsgröße (Bezugsgröße · Messstelle · Kennzahl) | Menge ÷ Bezugsgröße | Paar „kWh/Stück“, nie gekürzt |
| `anteil` | Teil und Ganzes: Messstellen derselben Größe | Teil ÷ Ganzes × 100; mit `komplement` 100 − das | % |
| `zusammenfassung` | 2 … n Kennzahlen derselben Form und Einheit, je mit Zähler UND Nenner — oder die Teilperioden einer Kennzahl | Σ Zähler ÷ Σ Nenner | Einheit der Paare |
| `produkt` | — vorgesehen, nicht gebaut | — | `rechenform_unbekannt` |

- **R1** Summen und Differenzen sind Gesamtwerte (AP-10), keine Kennzahl: eine Kennzahl summiert nie selbst.
- **R2** Genau zwei Rollen je `quotient`/`anteil`, keine Konstante als Eingang.
- **R3** Eine Kennzahl als Eingang wird mit ihrem gespeicherten Wert DERSELBEN Periode gelesen; ist sie selbst schon ein
  Verhältnis, entsteht keine prüfbare Einheit (`einheit_unpassend`).
- **R4** Eine Zusammenfassung liest je Paar Zähler und Nenner in der Version, die das Paar gerechnet hat.
- **R5** Gleiche Größe legt `anteil` nahe, sonst `quotient`; ein Anteil ist nie aus kWh und Stück.

## 3. Eingänge (B1–B4) und ihr Zustand (Q1)

Jeder Eingang ist **ausdrücklich gebunden** (Kennzeichen) — nie aus Ortsbaum, Stellung oder Prozess-Zuordnung abgeleitet.
Eine Messstelle wird auf ihre Anzeige-Einheit normiert (Wh → kWh, B3), eine Bezugsgröße nie umgerechnet. Der Zustand eines
Nenners wird **abgeleitet**, nicht übergeben:

| Eingang | Zustand |
|---|---|
| Bezugsgröße, Periodenwert | wirksame Fassung → vollständig; kein wirksamer Wert (fehlt, nur Vorschlag, zurückgenommen, abgelehnt) → keine Werte |
| Bezugsgröße, Stammdatum | Wert am Stichtag (letzter Tag der Periode, E17) → vollständig; keiner → keine Werte |
| Bezugsgröße aus Messkanal, Messstelle, Kennzahl | ihr eigener Zustand und ihre Abdeckung |

Ein Messwert ohne Vertrags-Messgröße ist kein Eingang (`groesse_unbekannt`, B4); ein Momentanwert auch nicht (U3,
`einheit_unpassend`), ebenso eine Bezugsgröße, die Stände führt.

## 4. Perioden (E3)

- **P1** Grundperiode = die gröbste Periode, in der ALLE Periodenwert-Eingänge restlos aufgehen; eine Messstelle liefert
  jede Periode ab dem Tag, ein Stammdatum zählt nicht. Nur Stammdaten → `anfrage_ungueltig`.
- **P2** Gebildet wird die Grundperiode und jede gröbere, in der sie aufgeht: Tag → Woche · Monat · Jahr; Woche → nichts;
  Monat → Jahr.
- **P3** Ein gröberer oder nicht aufgehender Eingang wird **nie verteilt**: `periode_passt_nicht` mit Satz (K13).
- **P4** Vor dem Bestehen eines Eingangs ist kein Fehlbestand: angeschnitten „ab TT.MM.JJJJ“, ganz davor `vor_bestehen`.
- **P5** Perioden in der Zeitzone des Standorts; Woche Montag–Sonntag.
- **P6** Die laufende Periode hat keinen Live-Wert: mit Periodenwert-Nenner `periode_nicht_zu_ende`, sonst „vorläufig“ (K21).

## 5. Einheiten und Anzeige (E11)

- **U1** Die Einheit entsteht aus den Eingängen: `quotient` → „Zähler/Nenner“ in der Anzeige-Einheit der Messstelle und der
  Einheit der Bezugsgröße, der Nenner in der Einzahl („kWh/Person“); `anteil` → %; `zusammenfassung` → die der Paare.
- **U2** Ein Anteil braucht dieselbe Größe; Wh und kWh sind dieselbe Größe.
- **U3** Nur Mengen (Zählerstand-Differenz, Intervallmenge) und Stammdaten.
- **U4** Gerechnet ungerundet (10 Stellen, kaufmännisch), verglichen auf 4, angezeigt ein Quotient mit 2 Stellen
  („0,15 kWh je Stück“, `ErgebnisZustand.zahlMitStellen`), ein Anteil ganzzahlig über `ErgebnisZustand.zahl` mit „%“
  („51 %“); de-DE, geschütztes Leerzeichen, „−“. Ohne Zahl „—“. Die Richtung steht davor: „mindestens …“, „höchstens …“.

## 6. Qualität (E4) — Q1 bis Q10

| Regel | Inhalt |
|---|---|
| Q1 | Zustand des Nenners wie §3. |
| Q2 | Eine Zahl nur mit Zähler UND Nenner und Nenner ≠ 0. Reihenfolge der Gründe: `nenner_fehlt` → `nenner_null` → `zaehler_fehlt`. Nie ∞, nie 0 statt „keine Werte“ (K8, K9). |
| Q3 | Zustand = der schlechteste (vollständig < mit Ersatzwert < unvollständig < keine Werte). Unvollständig trägt eine Zahl MIT Richtung: Menge unvollständig → Untergrenze, Bezugsgröße unvollständig → Obergrenze, beide → unbestimmt (K10, K11). |
| Q4 | Abdeckung = Minimum der Eingänge; ein Nenner ohne Verlauf hat 100 %. |
| Q5 | Summe durch Summe (§7). |
| Q6 | Endgültig, wenn alle Eingänge endgültig sind; sonst vorläufig. |
| Q7 | Ohne früheren Wert Version 1 — ohne Zahl noch keine Version; ein vorläufiger Wert zieht ohne neue Version nach; ein endgültiger wird Version n + 1 mit „korrigiert (Version n+1)“ (Eingang) oder „Berechnung geändert (Fassung f)“ (Definition). Auch eine Version ohne Zahl ist eine Version (K19). |
| Q8 | Kennzeichen: eigenes „berechnet (Kennzahl)“ nur mit Zahl, dazu die geerbten Sätze über die Periode (`kennzahl_kennzeichen.erbend`); ohne Zahl nur die Sätze mit „ohne Zahl“. |
| Q9 | Ein Anteil über 100 % oder unter 0 % ist „unplausibel (…)“ — ein Kennzeichen, nie ein geklemmter Wert (K15). |
| Q10 | Ein Kreis wird am Schreibweg abgelehnt (`formel_zyklus` mit Kette, K16); im Lauf ist `haengt_an_kreis` ein Grund. |

## 7. Summe durch Summe (E5) — über Ebenen und über die Zeit

Eine Unternehmens-, Standort- oder Prozess-Kennzahl aus Gebäude-Kennzahlen rechnet **Σ Zähler ÷ Σ Nenner über die Paare,
die Zähler UND Nenner tragen** — ein Paar mit 0 im Nenner zählt mit (K9). Dasselbe gilt über die Zeit: das Jahr aus Monaten
ist Σ ÷ Σ (K14: 0,2361, nicht 0,2346). **Ein Mittel von Quotienten wird nirgends gebildet** — die Zwillinge haben keine
Funktion dafür, und beide Tests prüfen den Quelltext darauf.

- Kennzeichen: „berechnet (Kennzahl)“ · „gewichtet (Summe ÷ Summe)“. **Über Ebenen** immer „x von y Gebäuden“ und aus jedem
  Paar sein „ab …“ mit dem Geltungsobjekt davor („G-5 ab 15.10.2026“, K3). **Über die Zeit** ersetzt das eigene „ab …“ jedes
  „ab …“ der Teile; „x von y …“ eines Teils bleibt nur, wenn es in JEDER Teilperiode steht; die übrigen Sätze über die
  Periode werden übernommen.
- Fehlt ein Paar oder eine Teilperiode: unvollständig, Richtung unbestimmt, „x von y … (… fehlt)“; fehlen alle: keine Werte.

## 8. Fassungen der Berechnung und Versionen des Werts (E7)

- **V1** Eine Fassung beginnt an einem Tag und beendet die laufende am Vortag; überlappend → `fassung_ueberlappt` („Ab diesem
  Tag gilt schon Fassung 2.“); vor dem Eintragstag mit „rückwirkend (n Tage)“ — alles aus `MessstelleFormelRegeln.fassungEintrag`.
- **V2** Eine Periode liest die Fassung ihres LETZTEN Tags; beginnt eine Fassung in der Periode, trägt sie „Berechnung
  geändert am TT.MM.JJJJ (Fassung n → n+1)“ — keine Mischrechnung.
- **V3–V6** Vorläufig zieht nach, endgültig wird Version n + 1 (Q7); Name, Verantwortlicher und Zweck ändern sich ohne
  Fassung; Geltungsbereich und Rechenform sind nach der ersten Fassung fest; der Leser nennt Fassung und Version.

Fassung und Version sind **zwei Achsen**: eine Korrektur macht Version 2 bei Fassung 1 (K7), eine rückwirkende Fassung
macht Fassung 2 bei Version 1, solange der Wert vorläufig ist (K17).

## 9. Neubildung (E8) und das Ereignis-Vokabular

| Auslöser | Ergebnis | Paket |
|---|---|---|
| Regellauf nach den berechneten Messstellen | Version 1 bzw. Nachziehen | IP-6 |
| freigegebene Messreihen-Korrektur (Kaskade PR 741, `KennzahlenNaht`) | Version n + 1 „korrigiert (Version n+1)“ | IP-8 |
| wirksame Fassung ≥ 2 oder Rücknahme einer Bezugsgröße (`correction` mit Bezug `bezugsgroesse`) | Version n + 1, ggf. „keine Werte“ | IP-9 mit AP-09 IP-7 |
| rückwirkende Definitions-Fassung | vorläufig nachziehen, endgültig „Berechnung geändert (Fassung f)“ | IP-9 |

Das Ereignis-Vokabular führt beides als **Reservierung** (`events-vocabulary-vectors.json` Block `reserviert`): `correction`
mit Bezug `bezugsgroesse` legt AP-09 IP-7 an (seit V20260915010000 angelegt), `kennzahl_neu_gebildet` (Urheber `cloud`) legt
AP-11 IP-8 an (seit V20260915061500 angelegt: Bezug `kennzahl`, Pflicht `ausloeser` und `version`); `KennzahlVectorsTest` prüft, dass Reservierung und Anlage sich nicht widersprechen.

## 10. Geltungsbereich und Rechte (E6, E10)

- **G1** Genau ein Fach-Geltungsbereich (`unternehmen` · `standort` · `gebaeude` · `bereich` · `prozess` · `kostenstelle` ·
  `messstelle`); daraus der Rechte-Geltungsbereich: Standort · Gebäude · Bereich · Messstelle → **Standort**; Unternehmen ·
  Prozess · Kostenstelle → **Unternehmen**, auch wenn alle Eingänge an einem Standort liegen (W3). Ein Standort-Objekt ohne
  Standort am Stichtag gibt es nicht (`geltung_unbekannt`).
- **G2** Ein beendetes Geltungsobjekt macht die Kennzahl nicht ungültig.
- **G3** Eingänge einer Standort-Kennzahl liegen an ihrem Standort, sonst `eingang_ausserhalb_geltung`; außerhalb des
  Geltungsobjekts, aber im Standort, ist ein Kennzeichen je Periode: „Eingang MS-08 seit 01.03.2027 außerhalb von Halle 1“ (K22).
- **R1** `kennzahl.standort_definieren` (Kundenadministrator U · Energiemanager U · Bearbeiter S) für Standort-Kennzahlen,
  `kennzahl.unternehmen_definieren` (KA U · EM U) für Unternehmens-Kennzahlen — beide stehen schon in der Rechte-Matrix.
- **R2** Ansehen über `messwerte.ansehen`.
- **R3 = R-A1 ∧ R-A6 — Vertragsregel (AP-03 IP-11 setzt sie durch).** Eine Kennzahl ist **mit Wert** sichtbar, wenn der
  Rechte-Geltungsbereich im Zugriff liegt (R-A1) **und** jeder Standort jedes Eingangs, rekursiv (R-A6) — keine Teilrechnung.
  Umfasst sie Standorte innerhalb UND außerhalb des Zugriffs, sieht ein Benutzer des Kundenbereichs die **Zeile ohne Wert**
  „umfasst Standorte außerhalb Ihres Zugriffs“ (R-A7); sonst ist sie nicht da (404). Die Wahrheitswerte liefert
  `RechteAbleitung.darf`; `KennzahlRegeln.sichtbarkeit` setzt sie zusammen.
- **R4** Keine Freigabe von Definitionen; kein neues Recht.

## 11. Vorlagen und Kopie (E9)

Eine Vorlage belegt Rechenform, Name („Stromeinsatz je Stück — {Geltungsbereich}“) und Zweck vor. Eine Kopie übernimmt Form,
Name (mit dem neuen Geltungsobjekt) und Zweck und verlangt Eingänge und Geltungsbereich neu; sie bekommt ein neues Kennzeichen
und Fassung 1 „gilt seit Beginn“ (K20). Der Katalog `kennzahl-vorlagen.json` kommt mit IP-10.

## 12. Fehler und Kundensätze (§5.8)

Die Sätze stehen in `saetze` der Vektor-Datei und als Konstanten in beiden Zwillingen; `copy.test.ts` liest sie.

| Code | Satz |
|---|---|
| `periode_passt_nicht` | „BZ-6 Gutteile Montage Halle 2 führt Monatswerte. Eine Kennzahl je Tag ist damit nicht bildbar — ein Monatswert wird nie auf Tage verteilt.“ · für eine Woche: „… gehen nicht restlos in Monatswerten auf.“ |
| `einheit_unpassend` | „Ein Anteil braucht zwei Werte derselben Größe — MS-12 (kWh) und BZ-6 (Stück) ergeben einen Quotienten, keinen Anteil.“ · Momentanwert, Stände, Verhältnis, Paare verschiedener Einheit |
| `groesse_unbekannt` | „Dieser Messwert hat keine Vertrags-Messgröße — er kann keine Menge sein.“ |
| `eingang_ausserhalb_geltung` | „MS-01 liegt in Werk Ahrenberg — eine Kennzahl für Werk Lindach kann sie nicht lesen.“ |
| `formel_zyklus` | „Diese Berechnung würde im Kreis laufen: KZ-0012 → KZ-0011 → KZ-0012. Eine Kennzahl kann sich nicht selbst enthalten.“ |
| `fassung_ueberlappt` | der Satz von `fassungEintrag`: „Ab diesem Tag gilt schon Fassung 2.“ |
| `geltung_unbekannt` · `eingang_unbekannt` · `rechenform_unbekannt` · `anfrage_ungueltig` | „Dieses Gebäude gibt es nicht (mehr).“ · „Die Bezugsgröße BZ-9 gibt es nicht.“ · „Diese Rechenform gibt es noch nicht.“ · „Eine Zusammenfassung braucht mindestens zwei Kennzahlen.“ |
| ohne Zahl | „Für November 2026 fehlt der Wert der Bezugsgröße BZ-6 Gutteile Montage Halle 2.“ · „Nenner 0 (0 Stück) — ein Wert je Stück ist ohne Stück nicht bildbar.“ · „Der Wert der Bezugsgröße für November 2026 kann erst nach Monatsende eingegeben werden.“ |

Ein 403 `rolle_noetig` spricht den Wortlaut von `RechteAbleitung` — eine Rechte-Wahrheit, kein zweiter Satz hier.

### Die Schnittstelle (IP-5)

`/api/v1/kennzahlen` antwortet jede Ablehnung als `{code, message, …Fakten}` aus dem geschlossenen Satz
`schnittstelle.ablehnungen` der Vektor-Datei (Vertrag = `KennzahlAbgelehnt` = OpenAPI `KennzahlFehler`): 400
`anfrage_ungueltig` (`feld`) · `kennzeichen_format`; 403 `recht_fehlt` mit `rolle_noetig` — Satz und Rolle aus
`RechteAbleitung.darf`, auch für den 403 „`rolle_noetig`“ oben; 404 `nicht_gefunden` — fremd ist nicht da, außerhalb des
Geltungsbereichs mit dem Satz der Rechte-Ableitung; 409 `kennzeichen_belegt` · `archiviert` · `hat_werte` („KZ-0001 hat
Werte — archivieren Sie sie.“) · `wird_gelesen`; 422 die Regel-Codes der Tabelle mit dem Satz der Regel. Eine Ablehnung
schreibt nichts, die Vorschau schreibt nie (Nur-Lese-Transaktion). Gelöscht wird nur ohne Wert und ohne lesende Kennzahl;
das Kennzeichen bleibt belegt. Das Protokoll bleibt bei seinen drei Wörtern: Anlegen = `kennzahl_fassung_eingetragen`
(Fassung 1), Stammdaten ändern und Löschen = `kennzahl_geaendert` (beim Löschen ist `neu` leer).

### Die Werte (IP-7)

`GET /api/v1/kennzahlen/{id}/werte?periode=&von=&bis=[&version=]` liefert je Periode die gespeicherte Zahl — ungerundet als
Dezimaltext, mit Zustand, Richtung, Abdeckung, Kennzeichen, vorläufig/endgültig, `version`, `versionen` und
`definition_fassung` (V6) — und die Hülle aus `kennzahlwert-herkunft` (gebaut aus den gespeicherten Eingängen, ohne Version
`null`). `von` ist der erste, `bis` der letzte Tag einer Periode; ohne `version` die neueste Zeile, mit `version=n` die der
Version n; eine Version an keinem Schritt ist 404 `version_gibt_es_nicht` (Form der Messstelle). Ein Schritt ohne Zahl nennt
`grund`: ein Wort von `grund_ohne_zahl` oder des Lesers (`noch_nicht_gebildet`, `version_nicht_gespeichert`).
`…/werte/versionen?periode=&von=` nennt je Version den Wert davor und danach und wer, wann, warum (Muster AP-08 IP-18).

## 13. Wörter (E12)

Kennzahl · Berechnung · Fassung (datierter Stand der Berechnung) · Version (Stand des Werts) · Vorlage · Menge ·
Bezugsgröße · Teil · Ganzes · Gesamtwert · „gewichtet (Summe ÷ Summe)“ · „x von y“ · „mindestens“ · „höchstens“. Nie auf einer
Kennzahl-Fläche: KPI, Metrik, Kenngröße, Dashboard, Widget, Template, Durchschnitt, Mittel (`verbotene_woerter`).

## 14. Invarianten

1. Eine Kennzahl teilt; sie summiert nie selbst und mittelt nie Quotienten.
2. Eine Zahl nur mit beiden Eingängen und Nenner ≠ 0; „keine Werte“ nennt den Grund.
3. Keine Kennzahl sieht vollständiger aus als ihr schlechtester Eingang; bei unvollständig steht die Richtung dabei.
4. Perioden werden nie verteilt oder interpoliert; Stammdaten gelten am Stichtag.
5. Eingänge sind ausdrücklich gebunden; außerhalb des Geltungsobjekts ein Kennzeichen, außerhalb des Standorts ein Fehler.
6. Berechnung (Fassungen) und Wert (Versionen) sind zwei Achsen; Version 1 und Fassung 1 bleiben lesbar.
7. Kein Kreis. Sichtbarkeit = R-A1 ∧ R-A6, keine Teilrechnung.
8. Einheiten entstehen aus den Eingängen; gerundet wird nur in der Anzeige.

## 15. Abweichungen und Grenzen

Wo der Vertrag bewusst anders schreibt als der Referenzfallkatalog des Konzepts, nennt `_abweichungen` Vorlage, Vertrag und
Grund — darunter ein **Befund**: K18 lässt Claudia (Leser, beide Standorte) die Unternehmens-Kennzahlen sehen, obwohl W3
(„R-A1 gilt zusätzlich zu R-A6“) entschieden ist und Murat deshalb KZ-0004 nicht sieht; der Vertrag folgt W3 und
`RechteAbleitung.darf`. Was die Vektoren NICHT prüfen (Tabellen, Routen, Lauf, Kaskade, Portal), steht mit dem Paket, das es
trägt, in `_nicht_geprueft`.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='KennzahlVectorsTest,UemsReferenzunternehmenVectorsTest,ErgebnisZustandVectorsTest,EreignisVokabularVectorsTest')
(cd frontend/portal && npx vitest run src/uemsKennzahl.test.ts src/uemsReferenzunternehmen.test.ts src/uemsErgebnis.test.ts src/copy.test.ts)
```
