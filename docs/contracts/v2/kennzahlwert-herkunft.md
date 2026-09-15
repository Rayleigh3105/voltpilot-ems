# Herkunft eines Kennzahl-Werts (UEMS AP-11)

Stand 14.09.2026 · Vertrag 1.0 · Konzept `data/vp-uems-ap11-kennzahlen` §4.10, §6.2, §8 IP-1, Entscheide E4, E7 und
E8 vom 14.09.2026.

Es gibt jetzt **vier Herkunfts-Arten** eines Werts: *gemessen* ([`messwert-herkunft.md`](./messwert-herkunft.md), AP-07),
*berechnet* und *verteilt* ([`bilanzwert-herkunft.md`](./bilanzwert-herkunft.md), AP-10) und **kennzahl**. Dieser Vertrag legt
den Satz der Kennzahl **daneben** — nach dem Muster von `bilanzwert-herkunft`, ohne einen der beiden anderen umzubauen. Eine
Kennzahl hat keine Box, kein Gerät und keinen Formel-Typ, dafür eine Rechenform, eine Definitions-Fassung und JEDEN Eingang
mit dem Wert, den er beim Bilden trug.

| Datei | Rolle |
|---|---|
| [`kennzahlwert-herkunft.schema.json`](./kennzahlwert-herkunft.schema.json) | die Form der Hülle `{satz, fehlt}` (JSON-Schema 2020-12) |
| [`kennzahl-vectors.json`](./kennzahl-vectors.json) | die Fälle: Regel `herkunft` an K1, K3–K7, K10–K12, K15, K17, K19, K22 |
| `services/api/.../uems/KennzahlRegeln.java` (`herkunft`) | der Java-Zwilling — er BAUT den Satz und nennt, was fehlt |
| `frontend/portal/src/uemsKennzahl.ts` (`herkunft`) | der TS-Zwilling |

Beide Vektor-Tests halten jede gebaute Hülle zusätzlich gegen das Schema. **Seit AP-11 IP-7 ruft die Route an:**
`GET /api/v1/kennzahlen/{id}/werte` bildet den Satz aus den gespeicherten Zeilen (`kennzahl_wert` + `kennzahl_wert_eingang`)
über `KennzahlRegeln.herkunft` — `KennzahlWerteApiTest` hält jede Prüfung der Regel `herkunft` byte-gleich dagegen. Eine
Zeit-Periode, die der Rechenlauf über ihre eigenen Teilperioden bildet, nennt bei einer Zusammenfassung ihre Paare in
derselben Periode (AP-11 IP-11, K14); jede andere hat keine gespeicherten Eingänge: dort antwortet die Route mit Regel 7
(`satz` null, `fehlt` = `eingaenge`).

## 1. Was im Satz steht

`art = kennzahl` · Kennzeichen der Kennzahl · `rechenform` · `definition_fassung` (die Fassung der Berechnung, die am
LETZTEN Tag der Periode galt, V2) · Periode (Art und Schlüssel) · `berechnet_am` · `version` · `anlass` (der Beleg des Vorgangs; im Reihen-Pfad der Kaskade Kennung, Entscheidung und
deren Tag in der Zone des Kundenbereichs — „K-2026-0007 (freigegeben 12.11.2026)“, AP-11 IP-8) · **jeder Eingang**
mit Rolle (`zaehler` · `nenner` · `paar`), Art, `objekt` (Kennzeichen), Wert, bei einem Paar Zähler und Nenner, Einheit,
Zustand, Abdeckung, Version (Messstelle, Kennzahl) oder Fassung (Bezugsgröße mit Periodenwert; ein Stammdatum hat keine) und
seinen eigenen Kennzeichen · und das Ergebnis mit Wert, Einheit, Zustand, Richtung, Grund, Abdeckung und Kennzeichen.

## 2. Die Regeln

1. **Nichts wird nachgerechnet.** Die Eingangswerte sind die gespeicherten Versionen und Fassungen zum Zeitpunkt der
   Bildung; der Satz beschreibt eine Zahl, er rechnet sie nicht noch einmal.
2. **Die Kennzeichen des Ergebnisses sind dieselbe Liste wie neben der Zahl** — zwei Listen für denselben Wert wären Drift
   (Regel 5 von `bilanzwert-herkunft`).
3. **Ein Eingang trägt seine EIGENEN Kennzeichen unverändert**, auch die, die nicht an die Kennzahl erben („gemessene Zeit
   23:00 von 24:00 h“ am Kanal-Nenner, K11; „Stichtag 31.10.2026“ am Stammdatum, K12). Welche erben, sagt
   `ergebnis-zustand-vectors.json` Block `kennzahl_kennzeichen.erbend`.
4. **`objekt` ist das Kennzeichen des Eingangs, `kennzeichen` sind seine Sätze** — nie beides in einem Feld.
5. **Ab Version 2 ist der Anlass Pflicht** („correction BZ-1 2026-10 Fassung 1 → 2 (I-2026-0003)“, „K-2026-0007 (freigegeben
   12.11.2026)“, „Rücknahme I-2026-0001“). Eine Neubildung, die ihre Ursache verschweigt, ist keine Herkunft.
6. **Auch eine Version ohne Zahl hat eine vollständige Herkunft** (K19: der Nenner steht mit Wert `null`, Zustand „keine
   Werte“, Fassung 2 und seinem Satz „zurückgenommen (I-2026-0001)“ im Satz — er wird nicht weggelassen).
7. **Eine halbe Herkunft wird nie ausgeliefert.** Fehlt `kennzahl`, `definition_fassung`, `berechnet_am`, ein Eingang oder ab
   Version 2 der Anlass, ist der Satz `null` und `fehlt` nennt jede Lücke — kein Feld wird ergänzt oder geraten.
8. **Beträge sind Dezimaltext**; `null` heißt „keine Werte“, nie „0“.

## 3. Was hier NICHT steht

Der Messwert-Herkunftsvertrag und der Bilanzwert-Herkunftsvertrag bleiben unberührt. Wer die Herkunft eines Eingangs braucht,
folgt seinem `objekt` dorthin: eine gemessene Messstelle zu `messwert-herkunft`, ein Gesamtwert zu `bilanzwert-herkunft`, eine
Bezugsgröße zu ihren Fassungen (`bezugsdaten.md`), eine Kennzahl zu IHREM Satz.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest=KennzahlVectorsTest)
(cd frontend/portal && npx vitest run src/uemsKennzahl.test.ts)
```
