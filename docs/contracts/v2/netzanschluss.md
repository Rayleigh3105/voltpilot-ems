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

**Wer eine Regel ändert, ändert die Vektor-Datei UND beide Zwillinge.**

> **Wer anruft (Stand AP-10 IP-1): niemand.** Die Tabellen `netzanschluss` und
> `anlage_netzanschluss`, die Routen unter `/api/v1/standorte/{id}/netzanschluesse` und der Reiter
> im Portal kommen mit IP-6 und IP-13; erst dann füllt das Standort-Lesemodell das Feld
> `netzanschluss` einer Anlage.

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
   ist `anschluss_belegt`.
6. **Die Kopfzeile ZEIGT, sie prüft nicht.** „vereinbart 550,0 kW · Anschluss 630,0 kVA · Momentan
   312,4 kW“ ist eine Anzeige (Zahlform aus [`ergebnis-zustand.md`](./ergebnis-zustand.md) §3, E11:
   Leistung kW/kVA eine Stelle, U+00A0 vor der Einheit); die Grenzprüfung ist AP-15. `grenze_geprueft` ist deshalb in jedem
   Fall `false` — eine Fläche, die eine Überschreitung behauptete, hätte hier keinen Fakt, der sie
   trägt. Was fehlt, steht nicht da: ein fehlender Momentanwert wird nie zu „0 kW“.
7. **Die Preisspalten ziehen NICHT mit (W9).** `site.max_feed_in_kw`, `site_supply_price` und die
   übrigen Preis- und Grenzspalten bleiben unverändert an der Anlage; ihr Umzug mit Zeitgültigkeit
   ist ein eigenes Folgepaket („Netzanschluss-Preisblatt“, nach AP-10, vor AP-15), damit Erlöse und
   Optimierer nicht in einem Bilanz-Paket angefasst werden. Die Auswirkungs-Karte des Fachmodells
   ([`docs/fachmodell/auswirkungen.md`](../../fachmodell/auswirkungen.md)) sagt das seit AP-10 IP-1
   so.

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

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='NetzanschlussVectorsTest')   # rein, kein Docker
(cd frontend/portal && npx vitest run src/uemsNetzanschluss.test.ts)
```
