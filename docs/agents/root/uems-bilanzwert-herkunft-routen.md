# UEMS-Herkunft in den Routen: jede berechnete Zahl sagt, woraus sie entstanden ist (AP-10 IP-12)

Neu am 14.09.2026. **Eine berechnete Zahl ohne ihre Herkunft ist nicht nachprüfbar.** Konzept `vp-uems-ap10-bilanzen`
§4.7, §8 IP-12; Entscheid E13 = A (eigener Vertrag `bilanzwert-herkunft`, der Messwert-Herkunftsvertrag bleibt
gemessen-only). Vertrag 1.1: [`bilanzwert-herkunft.md`](../../contracts/v2/bilanzwert-herkunft.md) §2.1.

| Route | Wo die Hülle `herkunft: {satz, fehlt}` steht | `berechnet_am` |
|---|---|---|
| `GET …/messstellen/{kennzeichen}/werte` (IP-10) | `werte[].herkunft` jeder gespeicherten berechneten Zahl | Zeile (Lauf/Kaskade) |
| `GET …/sites/{siteId}/bilanz` (IP-9) | `abschnitte[].werte[].rest.herkunft` | Antwort |
| `GET …/unternehmen/kostenstellen/{id}/energie` (IP-11) | `posten[].herkunft` (`verteilt`) · `posten[].tage[].herkunft` (`berechnet`) | Sicht · Zeile |

| Was | Wo |
|---|---|
| Regel (rein) | `uems/BilanzwertHerkunft` — `herkunft` (Satz), `ausGespeichert` (Ableitung), `umschlag`, `periodeEnde`, `schluessel`, `betrag`, `ausloeser`, `verteilungDerPeriode` |
| Lesen | `uems/BilanzwertHerkunftLeser` (EINER je `MessstelleWerteService`, erreichbar über `herkunft()`) → `BerechnetePeriodenRepository.herkunftFakten`/`.verteilungen`/`.fassungNummer` |
| Vektoren | Sätze: Regel `herkunft` in `bilanz-vectors.json` 1.1 / `verteilung-vectors.json` 1.3; Ableitung + `zuordnung`: `bilanzwert-herkunft-vectors.json` (nur Java) |
| Tests | `BilanzwertHerkunftVectorsTest` (69, rein) · `UemsBerechnetePeriodenwerteTest.f1DieHerkunft…` · `BilanzApiTest.f1DerRestDerBilanz…` · `KostenstelleEnergieApiTest.f10…`/`.f14…` |
| Migration | keine |

```bash
(cd services/api && ./mvnw test -Dtest='BilanzwertHerkunftVectorsTest,BilanzVectorsTest,VerteilungVectorsTest')
(cd services/api && ./mvnw test -Dtest='UemsBerechnetePeriodenwerteTest,BilanzApiTest,KostenstelleEnergieApiTest')  # Docker
```

## Die Fallen

1. **Byte-gleich heißt wörtlich.** Verglichen wird die geschriebene Hülle mit dem Jackson-Stand der Routen
   (`Jackson2ObjectMapperBuilder`), nicht ein `JsonNode`-`equals` (das übersieht die Reihenfolge). Wer ein Feld des
   Satzes anders formatiert (`58.000`, fehlendes `periode_ende`), macht `BilanzwertHerkunftVectorsTest` rot.
2. **`null` ist „nicht berechnet“, nie „Herkunft unbekannt“.** Gemessen und ohne Zahl → `herkunft: null`. Eine
   berechnete Zahl mit Lücke → Hülle mit `satz: null` und `fehlt`. Nie eine leere Hülle an einer gemessenen Zahl.
3. **Nichts nachrechnen.** Eingänge in der VERSION des Werts aus `bilanzwert_eingang`, Anlass aus
   `messreihe_periode_version`; das Ergebnis reicht die Route herein (dieselbe Zahl wie daneben). Das Lese-Modell
   „Werte je Messstelle“ zeigt weiter nur Version 1 (Versionen lesen = AP-08 IP-18) — Auslöser erscheinen dort erst
   damit; die Kostenstellen-Sicht zeigt Versionen schon (F14).
4. **Auslöser-Form geändert:** die Kostenstellen-Sicht schrieb seit IP-11 `correction K-… · MS-17 … Version 2`, jetzt
   wie der Vektor F14 `correction MS-17 2026-10-18 Version 2` (die K-Kennung steht an `bilanz_neu_berechnet`).
5. **Vektor-Nachträge:** `periode_ende` an jedem Satz (vorher nur F1/F5), Beträge ohne nachgestellte Nullen (F10,
   F11, F13) — `_abweichungen` beider Dateien; Schema-Konstanten 1.1/1.3 mitgezogen. Leser: `rg -l
   "bilanz-vectors.json|verteilung-vectors.json" services frontend`.

## Befunde (benannt, nicht still gelöst)

`zuordnung` in `bilanzwert-herkunft-vectors.json` nennt je §7-Satz den Weg: F1/F2/F3/F5/F6/F8/F14 aus gespeicherten
Zeilen, F10 über die Kostenstellen-Sicht. **Keine Route liefert heute** F4 (Anteils-Term ohne Menge gespeichert), F7
(Fassung als Satz „aus der Stellung je Tag“ + Vermerk „Stellung geändert“ — Vermerke nicht gebaut), F9 (`saldo` ohne
Schreibweg, IP-16), F11 (Verteilungs-Term ohne Menge), F13 (rückwirkende Verteilung erzeugt keine Version).

## Nicht gebaut

Herkunfts-Karte und `api.ts`-Typen (IP-14/IP-15), Vermerke „Stellung geändert (…)“, Versionen im Lese-Modell (AP-08
IP-18), Rechte-Durchsetzung (AP-03).
