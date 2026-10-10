# Herkunft eines berechneten oder verteilten Werts (UEMS AP-10)

Stand 14.09.2026 · Vertrag 1.1 · Konzept `data/vp-uems-ap10-bilanzen` §4.7, §8 IP-12, Entscheid E13 vom
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
| [`bilanzwert-herkunft-vectors.json`](./bilanzwert-herkunft-vectors.json) | seit 1.1: wie die ROUTEN den Satz aus gespeicherten Zeilen bilden, und `zuordnung` — für JEDEN Satz der beiden Dateien der Weg in eine Route oder der Grund, warum keine ihn heute liefert |
| `services/api/.../uems/BilanzwertHerkunft.java` | der Java-Zwilling — er BAUT den Satz und prüft ihn; seit 1.1 auch die Ableitung der Routen (`ausGespeichert`, `periodeEnde`, `betrag`, `ausloeser`, `verteilungDerPeriode`) |
| `services/api/.../uems/BilanzwertHerkunftLeser.java` | liest die Fakten (Spur `berechnet`, `bilanzwert_eingang` in der Version, Anlass aus `messreihe_periode_version`, Tag-Sätze der Verteilung) — rechnet nichts nach |
| `frontend/portal/src/uemsBilanz.ts` (`herkunft`) | der TS-Zwilling |

Beide Vektor-Tests halten den gebauten Satz zusätzlich gegen dieses Schema: die Form ist damit
nicht nur beschrieben, sondern bewiesen.

> **Wer anruft (Stand AP-10 IP-12) — alle drei Routen, jede als Hülle `herkunft: {satz, fehlt}`:**
> - `GET /api/v1/messstellen/{kennzeichen}/werte` (IP-10): an JEDEM Schritt einer berechneten Messstelle mit
>   gespeicherter Zahl (Viertelstunde, Tag, Monat, Jahr) der Satz der Art `berechnet` aus `bilanzwert_eingang`;
>   `berechnet_am` = Rechenzeitpunkt der Zeile.
> - `GET /api/v1/sites/{siteId}/bilanz` (IP-9): am `rest` jeder Zeile der Satz der Art `berechnet`, Typ `rest`, der
>   Rest-Messstelle — beim Lesen gerechnet, `berechnet_am` = Zeitpunkt der Antwort.
> - `GET /api/v1/unternehmen/kostenstellen/{id}/energie` (IP-11): je Posten (nicht bei „nicht verteilt“) ein Satz
>   der Art `verteilt` (Ziel = die Kostenstelle, Verteilungs-Fassung des letzten verteilten Tages, EIN Eingang = die
>   Quelle über dieselben Tage mit ihrer höchsten Version, `berechnet_am` = Zeitpunkt der Sicht); seit IP-12
>   zusätzlich an `tage[]` jeder BERECHNETEN Quelle der gespeicherte Satz des Tageswerts in der gezeigten Version.
>
> Die Herkunfts-Karte im Portal kommt mit IP-14.

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

## 2.1 Die Regeln der Routen (seit 1.1, AP-10 IP-12)

8. **`null` statt Hülle heißt „nicht berechnet“.** Ein gemessener Wert und ein Schritt ohne Zahl (`grund` gesetzt)
   tragen `herkunft: null` — nie eine leere Hülle, nie einen erfundenen Satz. JEDE berechnete oder verteilte Zahl
   trägt die Hülle; ist sie unvollständig, steht `satz: null` mit `fehlt` da (Regel 6).
9. **Nichts wird nachgerechnet.** Eine Route liest, was der Lauf (IP-10) und die Kaskade (AP-08 IP-17) gespeichert
   haben: die Eingänge in der VERSION des Werts aus `bilanzwert_eingang`, die Nummer der Formel-Fassung aus der Zeile,
   ab Version 2 den Anlass aus `messreihe_periode_version`. Ergebnis (Menge, Zustand, Abdeckung, Kennzeichen) ist
   die Zahl, die die Route daneben zeigt.
10. **Eine Form für jede Route** (`BilanzwertHerkunft`):
    - `periode.schluessel` aus dem Beginn in der Zone des Standorts (`2026-10-18`, `2026-10`, `2026`, eine
      Viertelstunde mit Versatz `2026-10-25T02:45:00+01:00`); `periode_ende` = die LETZTE Sekunde der Periode
      (`2026-10-18T23:59:59+02:00`), an JEDEM Satz;
    - Beträge als Dezimaltext ohne nachgestellte Nullen und ohne Exponent (`58.000` → `58`);
    - ein Eingang ohne Zahl mit Zustand „keine Werte“ und Version 1, ohne gespeicherten Anteil „gesamt“;
    - der Auslöser `correction|substitute <Eingänge in neuerer Version> <Periode> Version <n>` (F14:
      `correction MS-17 2026-10-18 Version 2`; `substitute` bei einem Ersatzwert `EW-…`; ohne Eingang in neuerer
      Version die Kennung des Anlasses; ohne Anlass kein Auslöser → `fehlt: [ausloeser]`);
    - `verteilung` an einem BERECHNETEN Satz nur, wenn an jedem Tag der Periode genau eine Zeile gilt und alle
      dasselbe Ziel, denselben Anteil und dieselbe Fassung tragen (F3) — sonst `null`.
11. **Zusätzlich fehlen** `formel_fassung` (keine Nummer — die Zahl ließe sich nicht nachrechnen),
    `eingang_messstelle` (ein Messkanal-Term aus PR #688 hat keine Messstelle) und — beim Rest der Bilanz ohne
    bestätigte Rest-Messstelle — `messstelle`.

Byte-gleich heißt wörtlich: `BilanzwertHerkunftVectorsTest` schreibt jeden Satz mit dem Jackson-Stand der Routen und
vergleicht ihn Zeichen für Zeichen mit dem Vektor; die API-Tests tun es für F1 (Werte je Messstelle und Bilanz je
Anlage), F10 und F14 (Kostenstellen-Sicht) an der echten Route. Was keine Route heute liefern kann (F4, F7, F9, F11,
F13), nennt `zuordnung` mit Grund.

## 3. Was hier NICHT steht

Der Messwert-Herkunftsvertrag bleibt unberührt: kein Feld von
[`messwert-herkunft.schema.json`](./messwert-herkunft.schema.json) ändert sich, und keine seiner
15 Angaben wird hier wiederholt. Wer die Herkunft eines GEMESSENEN Eingangs braucht, folgt der
Messstelle des Eingangs dorthin.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='BilanzVectorsTest,VerteilungVectorsTest,BilanzwertHerkunftVectorsTest')
(cd services/api && ./mvnw test -Dtest='UemsBerechnetePeriodenwerteTest,BilanzApiTest,KostenstelleEnergieApiTest')  # Docker
(cd frontend/portal && npx vitest run src/uemsBilanz.test.ts src/uemsVerteilung.test.ts)
```
