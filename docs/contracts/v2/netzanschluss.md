# Netzanschluss-Vertrag: das Objekt am Standort und seine Bindung (UEMS AP-10)

Stand 12.09.2026 · Vertrag 1.0 · Konzept `data/vp-uems-ap10-bilanzen` §4.1/§4.2, Entscheid E8 vom
12.09.2026, AP-00 E6/E10.

Bis hierher war der Netzanschluss ein Wort im Fachmodell und im Produktionspfad **immer `null`**.
Mit AP-10 wird er ein **Objekt am Standort**: Kennzeichen, Name, Marktlokation, Netzbetreiber,
Anschlussleistung (kVA), vereinbarte Leistung (kW), Messung — und eine **zeitgültige Bindung** an
genau eine Anlage je Tag.

| Datei | Rolle |
|---|---|
| [`netzanschluss-vectors.json`](./netzanschluss-vectors.json) | **die eine Wahrheit**: Referenzfall F16 mit den drei Anschlüssen NA-1, NA-2, NA-3 |
| [`netzanschluss.schema.json`](./netzanschluss.schema.json) | das Schema für Vokabulare, Regeln und die Vektor-Datei selbst (JSON-Schema 2020-12) |
| `services/api/.../uems/NetzanschlussRegeln.java` | der **Java-Zwilling** (rein: ohne Spring, ohne DB, ohne Uhr) |
| `frontend/portal/src/uemsNetzanschluss.ts` | der **TypeScript-Zwilling** |
| `…/uems/NetzanschlussVectorsTest.java` · `…/src/uemsNetzanschluss.test.ts` | beide fahren DIESELBE Vektor-Datei, per Pfad |
| [`netzanschluss-grenze-vectors.json`](./netzanschluss-grenze-vectors.json) | das **Grenzblatt** (AP-15 IP-3, §5): Auflösung und Plausibilität — Java `uems/GrenzeAufloesung` ⟷ Python `voltpilot_optimization/grenze_aufloesung.py` |
| [`netzanschluss-grenznachweis-vectors.json`](./netzanschluss-grenznachweis-vectors.json) | der **Grenz-Nachweis** (AP-15 IP-31, §6): Viertelstunden-Mittel am Hauptzähler gegen die wirksame Grenze — Java `uems/GrenzNachweisRegel` |

**Wer eine Regel ändert, ändert die Vektor-Datei UND beide Zwillinge.**

> **Wer anruft (Stand AP-10 IP-6):** `NetzanschlussService` — die Tabellen `netzanschluss` und
> `anlage_netzanschluss` (`V20260913235000`), die Routen unter `/api/v1/standorte/{id}/netzanschluesse`,
> und das Standort-Lesemodell füllt das Feld `netzanschluss` einer Anlage. Der Reiter im Portal kommt
> mit IP-13. Wegweiser: `docs/agents/root/uems-netzanschluss.md`.

## 1. Die fünf Regeln

| Regel | Was sie beantwortet |
|---|---|
| `kennzeichen` | AP-00 E10: Darf dieser Anschluss so heißen — und was schlägt die automatische Vergabe vor? |
| `malo` | Ist „47110000001“ eine Marktlokation? |
| `felder` | Was ist Pflicht, was ist frei, und was ist nur ein Hinweis? |
| `bindung` | Welche Anlage hängt ab wann an welchem Anschluss? |
| `kopfzeile` | Was steht im Kopf der Bilanz-Seite? |

## 2. Die Fallen

1. **Die Kennzeichen-Form ist die der Messstelle** (AP-00 E10) — nur das Präfix ist eigen (`NA-`)
   und der Zähler ist ein eigener. `NetzanschlussRegeln` ruft dafür
   `MessstelleRegeln.kennzeichenFormatGueltig` auf, statt das Muster zu kopieren. Ein einmal
   vergebenes Kennzeichen wird nie an einen anderen Anschluss weitergegeben; die automatische
   Vergabe überspringt Belegtes und zählt weiter.
2. **Eine zehnstellige Marktlokation wird abgelehnt, nie aufgefüllt.** Ohne Marktlokation ist der
   Anschluss anlegbar — sie ist dann `null`, nicht „unbekannt 0“.
3. **Eine Messung außerhalb von `RLM` · `SLP` wird VERWORFEN, nie geraten** (Hausregel: ein Wort
   außerhalb eines geschlossenen Vokabulars wird verworfen).
4. **Vereinbart über Anschluss ist ein HINWEIS, keine Ablehnung.** Was der Netzbetreiber vereinbart
   hat, wissen wir nicht besser als er; die Fläche sagt es, sie verhindert es nicht.
5. **Je Tag höchstens eine Bindung je Anlage UND je Anschluss.** Ein Wechsel beendet die laufende
   Bindung am VORTAG — nichts wird überschrieben. Eine zweite Bindung derselben Anlage am selben
   Tag ist `bindung_ueberlappt`; ein Anschluss, der an dem Tag schon an einer anderen Anlage hängt,
   ist `anschluss_belegt`. Die Regel sieht ALLE Tage der neuen Bindung (seit AP-10 IP-6): ein
   früherer Beginn vor einer späteren Bindung derselben Anlage ist ebenfalls `bindung_ueberlappt`,
   ein Anschluss, der an einem späteren Tag an einer anderen Anlage hängt, ebenfalls
   `anschluss_belegt` — nur die LAUFENDE wird am Vortag beendet.
6. **Die Kopfzeile ZEIGT, sie prüft nicht.** „vereinbart 550 kW · Anschluss 630 kVA · Momentan
   312,4 kW“ ist eine Anzeige (Zahlform aus [`ergebnis-zustand.md`](./ergebnis-zustand.md) §3, E11:
   vereinbarte kW und Anschluss-kVA ganzzahlig, echte Dezimalstellen bleiben; gemessene kW
   eine Stelle, U+00A0 vor der Einheit). Seit AP-15 IP-31 trägt sie das Urteil des Grenz-Nachweises
   (§6): „Grenze im September 2026 eingehalten“ · „… überschritten“ · „… nicht belegt“ — und
   `grenze_geprueft` ist genau dann `true`, wenn der Nachweis Grenze UND Hauptzähler hatte. Ohne
   Nachweis bleibt die Zeile, wie sie war (`false`): den Momentanwert gegen die vereinbarte Leistung
   vergleicht weiterhin niemand. Was fehlt, steht nicht da: ein fehlender Momentanwert wird nie zu „0 kW“.
7. **Die Preisspalten ziehen NICHT mit (W9).** `site_supply_price` und die übrigen Preisspalten
   bleiben unverändert an der Anlage; ein Preisblatt ist ein eigenes, ungeplantes Paket und keine
   Voraussetzung von AP-15. Die zwei GRENZEN bekommen mit AP-15 IP-3 ein Grenzblatt am
   Netzanschluss (§5) — die Spalten der Anlage (`site.max_feed_in_kw`,
   `site_charging_config.grid_limit_kw`) bleiben dabei, wo sie sind. Die Auswirkungs-Karte des
   Fachmodells ([`docs/fachmodell/auswirkungen.md`](../../fachmodell/auswirkungen.md)) sagt das so.

## 3. Wo die Vektoren liegen — und warum hier

Der Konzept-Schnitt sah die Familie `netzanschluss` in `ortsbaum-vectors.json` vor. Diese Datei
gehört AP-02 und wird von `OrtsbaumAbleitung` ⟷ `uemsOrtsbaum.ts` gefahren; eine
Netzanschluss-Familie dort hieße, eine fremde, schon gemergte Ableitung um Regeln eines anderen
Pakets zu erweitern. Der Hausstandard ist ein Vertrag = eine Prosa + ein Schema + eine Vektor-Datei
+ zwei reine Zwillinge — dem folgt diese Datei. `_abweichungen` nennt das ausdrücklich; IP-6 füllt
weiterhin das Feld `netzanschluss` der Anlage im Standort-Lesemodell und liest dafür diese Regeln.

## 4. Herkunft der Zahlen

Die drei Anschlüsse, ihre Marktlokationen, Leistungen und Bindungstage stammen aus
[`uems-referenzunternehmen.json`](./uems-referenzunternehmen.json) (Fassung 1.1).

## 5. Das Grenzblatt am Netzanschluss (AP-15 IP-3, Kasten W1)

Zwei Grenzen, keine Preise: **Einspeisegrenze** und **Bezugsgrenze** in kW, zeitgültig je Netzanschluss
(`netzanschluss_grenze`, `V20260921120000`). Eine Fassung gilt ab ihrem Tag (Zeitzone des Standorts) bis
zum Vortag der nächsten; `null` in einer Richtung setzt dort keine Grenze; eine zweite Fassung am selben
Tag hebt die erste auf (nie überschrieben). Jeder Schreibvorgang ist GENAU EIN Protokolleintrag der Art
`grenze` in `netzanschluss_aenderung` (alt/neu = die Fassung des Tages).

**Die eine Lese-Regel** (`GrenzeAufloesung` ⟷ `grenze_aufloesung.py`, Vektoren
[`netzanschluss-grenze-vectors.json`](./netzanschluss-grenze-vectors.json)): je Richtung gilt der
**ENGERE** Wert aus Anlage und Netzanschluss; ohne gebundenen Netzanschluss am Tag oder ohne gültige
Fassung der alte Wert der Anlage — dasselbe Objekt, Byte für Byte. Gleich = Anlage. Unbekannt ist nie 0 kW.

| Richtung | Wert der Anlage | wer liest über die Regel |
|---|---|---|
| Einspeisung | `site.max_feed_in_kw` | Optimierer-Eingang (`inputs.load_battery_sites` → `BatterySite.max_feed_in_kw`, MILP-Kappe und `grid_export_limit_kw` im Plan) |
| Bezug | `site_charging_config.grid_limit_kw` | Ladepark-Dokument (`ChargingConfigService` → `grid_limit_kw`) |

**Plausibilität** (AP-01 E10, 422, schreibt nichts): Bezugsgrenze ≤ vereinbarte Leistung
(`grenze_ueber_vereinbart`); jede Grenze ≤ Anschlussleistung in kVA (`grenze_ueber_anschluss`); zuerst
die vereinbarte Leistung. Fehlt der Vergleichswert, gibt es nichts zu prüfen. Eine Grenze ist leer oder
> 0 kW mit höchstens drei Nachkommastellen (400 `anfrage_ungueltig`).

**Routen:** `GET …/netzanschluesse/{id}/grenzen?stichtag=` (lesend, keine eigene Kennung, Zaun über
`RechtPruefung#pruefenLesen` am Standort) und `POST …/netzanschluesse/{id}/grenzen` (`netzanschluss.verwalten`,
rückwirkend zusätzlich `aenderung.rueckwirkend`). Der Mandant kommt aus der Anmeldung, nie aus dem Körper.
Das Ladepark-Dokument reist neu, sobald sich der HEUTE wirksame Bezug einer Anlage mit Rahmen ändert: sofort
nach einer heute wirksamen oder aufgehobenen Fassung und nach Binden/Umbinden, sonst am Tageswechsel des
Standorts (stündlicher Anstoß, vergleicht mit dem zuletzt zugestellten Wert in
`ladepark_netzgrenze_zugestellt`, holt nach einem Ausfall nach). Gleicher Wert, kein Rahmen oder keine
Bindung: keine Zustellung. Ob die Grenze eingehalten wurde, misst der Grenz-Nachweis (§6).

## 6. Der Grenz-Nachweis am Netzanschluss (AP-15 IP-31, NW-8, M-1, M-2, B5, W10)

**Die Mess-Welt beweist, die Steuer-Welt regelt.** Der Nachweis wird GERECHNET, nie gespeichert (keine
Migration): `GET …/netzanschluesse/{id}/grenznachweis?monat=JJJJ-MM` oder für NW-8 mit freiem Zeitraum
`?von=<Zeitpunkt>&bis=<Zeitpunkt>` (halboffen, beide erforderlich, statt `monat`, höchstens 31 Tage; lesend, keine
eigene Kennung, Zaun über `RechtPruefung#pruefenLesen` am Standort; ohne Parameter der laufende Monat am Standort).
Der Monatsweg umfasst die **abgeschlossenen Tage** — heute und später nicht. Der freie Weg umfasst genau die
vollständigen Viertelstunden in `[von,bis)`; eine Lücke ist auch dort kein sauberer Wert.

| Schritt | Woher |
|---|---|
| Anlage am Tag | Bindung `anlage_netzanschluss` (AP-10); ohne Bindung gilt an dem Tag keine Grenze |
| Grenze am Tag, je Richtung | `GrenzeAufloesung` (§5): der engere Wert aus Anlage und Grenzblatt — die Grenze kann im Monat wechseln |
| Hauptzähler am Tag | Stellung `Hauptzähler` der Anlage: Bezug = Richtung `Bezug`, Einspeisung = Richtung `Abgabe`; GENAU EINER, sonst fehlt der Tag |
| Viertelstunden-Mittel | `MessstelleWerteService` (AP-08, Raster `viertelstunde`, mit Zustand): kWh × 4 = kW (kWh ≠ kW), eine Leistungs-Messstelle liefert ihr Mittel |
| Urteil | `GrenzNachweisRegel` gegen [`netzanschluss-grenznachweis-vectors.json`](./netzanschluss-grenznachweis-vectors.json) |

**Die Regel (B5 — unbekannt ist keine Null):** gezählt werden nur Viertelstunden, an deren Tag eine
Grenze gilt. Nur eine **vollständige** Viertelstunde belegt etwas; unvollständig oder mit Ersatzwert zählt
als `unvollstaendig`, ohne Wert oder ohne Hauptzähler als `fehlend`. Über der Grenze heißt echt größer.
`ueberschritten`, sobald eine belegte Viertelstunde darüber liegt (auch mit Lücken daneben); sonst
`nicht_belegt`, sobald eine fehlt oder unvollständig ist; sonst `eingehalten`. `belegt_prozent` wird
abgerundet. **Höchstes Mittel** = die belegte Viertelstunde mit dem größten Abstand Mittel − Grenze (bei
gleicher Grenze das höchste Mittel). **Unterbrechungen** = zusammenhängende belegte Viertelstunden über der
Grenze mit Dauer und Höchstwert — über eine Lücke wird nichts verbunden.

**`grenze_geprueft`** ist je Richtung wahr, wo an mindestens einem Tag Grenze UND Hauptzähler vorliegen;
sonst nennt `grund` `keine_grenze`, `kein_hauptzaehler` oder `kein_abgeschlossener_tag`. Die Antwort ist
wahr, wenn eine Richtung geprüft ist. Liegt ein Hauptzähler außerhalb des Zugriffs
(`RechtPruefung#alleLesbar`), fehlen die Zahlen seiner Richtung ganz (`ausserhalb_zugriff`), und das
Gesamturteil bleibt leer.

**Herkunft der Grenze:** Jede Richtung nennt in `grenzherkunft` `grenzblatt` (zeitgültig) und/oder `anlage`
(nicht zeitgültiges `site.max_feed_in_kw` bzw. `site_charging_config.grid_limit_kw`). Sobald `anlage` vorkommt,
trägt `grenzhinweis` sichtbar: „Grenze aus dem Anlagenfeld - nicht zeitgültig; für den Nachweis die Grenze ins
Grenzblatt eintragen“. Das Anlagenfeld wird bewusst nicht zeitgültig gemacht; die Pilotgrenze gehört ins Grenzblatt.

**Steckerprobe (NW-8/I4):** Die Plattform trägt den Handgriff über
`POST /api/v1/admin/sites/{id}/gemeinsame-steuerung/steckerprobe {von,bis,box_id,bemerkung}` ein. Die Tabelle
`steuerungsverbund_steckerprobe` speichert nur den benannten Zeitraum; das Betreiber-Blatt rechnet beim Lesen mit
derselben Route und Regel den Höchstwert genau in dieser Zeit. Messlücke = `nicht_belegt`, nie „hält“.

**M-2 (Augenblick, Startwert ≤ 60 s) ist `nicht_gemessen`.** Die Mess-Welt hält je Viertelstunde Mittel,
Min und Max, aber keine Dauer über einer Schwelle; der Nachweis erfindet keine. M-2 belegt heute der
Zwei-Agenten-Test und das Ergebnisblatt (IP-27, IP-29).

**Die Kopfzeile** (§2 Falle 6, Regel `kopfzeile` beider Zwillinge) zeigt das Urteil des Monats.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='NetzanschlussVectorsTest')   # rein, kein Docker
(cd frontend/portal && npx vitest run src/uemsNetzanschluss.test.ts)
(cd services/api && ./mvnw test -Dtest='GrenzeAufloesungVectorsTest')   # Grenzblatt, rein
(cd services/api && ./mvnw test -Dtest='GrenzNachweisVectorsTest')      # Grenz-Nachweis, rein
(cd services/api && ./mvnw test -Dtest='NetzanschlussGrenznachweisApiTest')   # Route, Testcontainers
(cd services/optimization && PYTHONPATH=. python -m pytest tests/test_grenze_aufloesung.py)
```
