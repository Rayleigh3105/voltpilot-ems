# Herkunft eines berechneten oder verteilten Werts (UEMS AP-10)

Stand 12.09.2026 · Vertrag 1.0 · Konzept `data/vp-uems-ap10-bilanzen` §4.7, Entscheid E13 vom
12.09.2026.

Es gibt **drei Herkunfts-Arten** eines Werts: *gemessen*, *berechnet*, *verteilt*. Für den
gemessenen gilt unverändert [`messwert-herkunft.md`](./messwert-herkunft.md) (AP-07) — dieser
Vertrag legt den Satz **daneben**, er baut ihn nicht um (E13). Ein berechneter Wert hat andere
Angaben als ein gemessener: keine Box, kein Gerät, keine Zustellart — dafür einen Formel-Typ, eine
Formel-Fassung und jeden EINGANG mit seiner Version.

| Datei | Rolle |
|---|---|
| [`bilanzwert-herkunft.schema.json`](./bilanzwert-herkunft.schema.json) | die Form des Satzes (JSON-Schema 2020-12) |
| [`bilanz-vectors.json`](./bilanz-vectors.json) · [`verteilung-vectors.json`](./verteilung-vectors.json) | die Fälle: Regel `herkunft` je Referenzfall |
| `services/api/.../uems/BilanzwertHerkunft.java` | der Java-Zwilling — er BAUT den Satz und prüft ihn |
| `frontend/portal/src/uemsBilanz.ts` (`herkunft`) | der TS-Zwilling |

Beide Vektor-Tests halten den gebauten Satz zusätzlich gegen dieses Schema: die Form ist damit
nicht nur beschrieben, sondern bewiesen.

> **Wer anruft (Stand AP-10 IP-1): niemand.** Die Herkunfts-Karte im Portal und die Antworten der
> Bilanz-Routen kommen mit IP-9, IP-12 und IP-14.

## 1. Was im Satz steht

`art` (`berechnet` · `verteilt`) · Messstelle (bei `verteilt` das ZIEL) · Periode (Art und
Schlüssel) · `formel_typ` und `formel_fassung` (nur bei `berechnet`) · Periodenende und
Rechenzeitpunkt · Version · Auslöser · bei `verteilt` die Verteilungs-Fassung mit Ziel und Anteil ·
**jeder Eingang** mit Messstelle, Bilanz-Rolle, Anteil, Menge, Zustand, Abdeckung, Version und
Kennzeichen · und das Ergebnis selbst mit Menge, Zustand, Abdeckung und Kennzeichen.

## 2. Die Regeln

1. **`verteilt` hat genau EINEN Eingang** und immer eine Verteilung; einen Formel-Typ hat es nie.
2. **`berechnet` hat einen Formel-Typ** und mindestens einen Eingang.
3. **Beim Typ `rest` trägt jeder Eingang seine Bilanz-Rolle** — ohne sie wäre nicht erkennbar, ob
   er zugeflossen, abgeflossen oder zugeordnet war, und die Zahl ließe sich nicht nachrechnen.
   Die Formel-Fassung ist dort kein Termsatz, sondern der Satz, mit dem sie je Tag aus der Stellung
   entsteht („aus der Stellung je Tag“).
4. **Ab Version 2 ist der Auslöser Pflicht.** Eine Neuberechnung, die ihre Ursache verschweigt, ist
   keine Herkunft (F14: `correction MS-17 2026-10-18 Version 2`).
5. **Die Kennzeichen des Ergebnisses reisen unverändert in den Satz.** Zwei verschiedene Listen für
   denselben Wert wären genau die Drift, die diese Verträge verhindern.
6. **Eine halbe Herkunft wird nie ausgeliefert.** Fehlt eine Pflichtangabe, ist der Satz `null` und
   `fehlt` nennt jede fehlende — kein Feld wird ergänzt, geraten oder auf eine Vorgabe aufgelöst.
7. **Beträge sind Dezimaltext**, `null` heißt „keine Werte“ und nie „gemessen 0“ (F5: der Eingang
   MS-14 steht mit Menge `null` und Abdeckung 0 im Satz — er wird nicht weggelassen).

## 3. Was hier NICHT steht

Der Messwert-Herkunftsvertrag bleibt unberührt: kein Feld von
[`messwert-herkunft.schema.json`](./messwert-herkunft.schema.json) ändert sich, und keine seiner
15 Angaben wird hier wiederholt. Wer die Herkunft eines GEMESSENEN Eingangs braucht, folgt der
Messstelle des Eingangs dorthin.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='BilanzVectorsTest,VerteilungVectorsTest')
(cd frontend/portal && npx vitest run src/uemsBilanz.test.ts src/uemsVerteilung.test.ts)
```
