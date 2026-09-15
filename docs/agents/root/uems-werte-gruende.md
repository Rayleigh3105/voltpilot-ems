# UEMS-Fläche: warum eine Zahl fehlt — Grund-Sätze, Auskünfte, Leerzustände (AP-13 IP-6)

Neu am 15.09.2026. Reines Portal: keine Route, keine Migration, keine Vertragsdatei. Spezifikation:
`data/vp-uems-ap13-oberflaechen/report.md` §4.11 (Z1–Z8), §5.8, Kasten E11, §8 IP-6, Fälle O15/O16/O19; die acht Sätze
stehen seit IP-1 im Block `grund` von `ergebnis-zustand-vectors.json` (drei davon bewusst anders als O15 —
`data/vp-uems-ap13-oberflaechen/befunde-ip1.md`). Der dritte Teil der Abnahme: der Kunde erkennt, **warum eine Zahl fehlt
oder eingeschränkt ist**.

| Teil | Datei (`frontend/portal/…`) |
|---|---|
| Grund-Satz an der Karte, Namen der Bindungen, Leerzustand ohne Datenquelle und sein Schritt, Nebengrößen (V8) | `src/uemsWerteKarte.ts` (`grundDes`, `quellenNamen`, `ohneQuelle`, `ohneQuelleWeg`, `nebengroessen`) · `uemsWerteKarte.test.ts` (O15 alle acht, O16, Z4, V8) |
| 400-Sätze je Grund, 404, Frist, Störung; Leerzustände Vergleich und Energiebilanz | `src/uemsOberflaechen.ts` §6 (`auskunft`, `ablehnungSatz`, `vergleichOhnePassende`, `OHNE_HAUPTZAEHLER`) · `uemsOberflaechen.test.ts` (liest `MessstelleWerteRegeln.Grund` und die Schritt-Grenzen aus Java) |
| Wirt | `src/components/WerteSektion.tsx` (`quelle`, `onQuelleZuordnen`; `WerteAuskunft`, `WerteLeer`) · `WerteSektion.test.tsx`; Seite `src/pages/MessstelleSeite.tsx` (Register-Quelle an die Sektion, „Quelle zuordnen“ öffnet `MessstelleDialog` mit `schritt={3}`, Zeile „Weitere Größen“) |
| Wörter | `copy.test.ts` Block „Welt Oberflächen“ liest jeden Satz zur Laufzeit |
| Browser, 375/1440 | `e2e/messstelle-seite.spec.ts` (Z4 MS-21, O16 MS-16, Z2 und V9/O19 gestellt, V8 MS-06); Antworten `src/test/werteKarteFixtures.ts` (`ms16Oktober`, `ms16OktoberTage`), Stammdaten `messstelleSeiteFixtures.ts` (`ms16`, `ms21`) |

## Die Fallen

1. **Die Werte-Route liefert Kennungen, das Register Namen.** `{quelle}` und `{kanal}` des Vertrags brauchen Namen, die
   nur `MessstelleRegisterZeile.quelle` (führend + davor) trägt; `quellen[].id` der Route ist `fuehrend.id` des Registers.
   Ohne Wirt mit Register (der Dialog an den Gesamtwert-Karten) sprechen `quelle_teilweise` und
   `anteil_nicht_gespeichert` KEINEN Satz — nie eine Kennung statt eines Namens (D5).
2. **`{kanal}` nennt den Namen der Komponente, nicht ihr Kennzeichen.** Der Vertrag schreibt „Wirkenergie Bezug (K-3)“;
   `RegisterBindung.komponente` ist die Entity-ID, das Kennzeichen kennt das Register nicht. Darum „Wirkenergie Bezug
   (Netzzähler Halle 1)“. `{quelle}` ist „Netzzähler Lindach (GR-10)“ (O15 schrieb „Netzzähler K-11“ — K-11 heißt so nicht).
3. **„gilt seit“ nur für eine Bindung, die IM Schritt beginnt.** `quelle_teilweise` gilt auch, wenn eine Deckung nur
   endet — dann steht kein Satz statt eines falschen.
4. **Der Satz steht nur unter dem Strich** (`zahl === „—“` UND `menge === null`), in der Zeile weiter nur „noch nicht
   gerechnet“. Am noch nicht gebildeten Schritt ist `grundSatz` zeichengleich `UEMS_NOCH_NICHT_GERECHNET_SATZ`.
5. **Auskunft ≠ Störung.** 400, 404 und `wert_nicht_mehr_gespeichert` sind ruhige Sätze (`data-testid="werte-auskunft"`,
   `data-art`) OHNE „Erneut versuchen“ — dieselbe Anfrage gäbe dieselbe Antwort; nur `nicht_abrufbar` ist `ErrorState`
   („Die Werte sind gerade nicht abrufbar.“). „Konnte nicht geladen werden“ steht an der Sektion nirgends mehr.
6. **404 `wert_nicht_mehr_gespeichert` hat heute keinen Sender und keinen Sprung.** AP-12 IP-16 ist offen; die Fläche
   spricht den Satz der Route, sobald er kommt, `sprung` bleibt `null`, bis der Körper den Berichtsstand als FELD nennt.
   Jede andere 404 der Route ist „Diese Messstelle gibt es nicht.“ (nie 403).
7. **Leerzustand ohne Datenquelle nur, wenn der GANZE Zeitraum keine Bindung hat** (`quellen` leer, jeder Schritt
   `keine_quelle`) — Lindach im Oktober hat 14 Tage ohne Quelle, aber die Tage sprechen selbst. Die Zeit-Leiste bleibt.
8. **Kein Knopf ins Leere:** „Ablesung eintragen“ (Z4/O15) fehlt, weil eine Ablesung an einer Messstelle weder Route noch
   Fläche hat (AP-09 IP-7 schreibt Werte einer Bezugsgröße). „Quelle zuordnen“ nur mit `aenderbar`; „Ab … zeigen“ nur, wenn
   der erste Tag der heutigen Quelle schon da ist.
9. **Nebengrößen ohne Sprung:** die Register-Bindung nennt weder Anlage noch Box-Referenz — ohne sie hat die Geräteseite
   keine Adresse (`sprungziel` `geraet` braucht `siteId` + `ref`).
10. **`MessstelleDialog` `schritt` gilt nur beim Bearbeiten**; Anlegen beginnt immer mit Schritt 1.

## Offen (Befunde)

- Ablesung an einer Messstelle (MS-21): Route und Fläche fehlen — dann der Schritt „Ablesung eintragen“ im Leerzustand.
- Sprung zum Berichtsstand (O19): braucht AP-12 IP-16 und die Kennung des Berichtsstands als Feld im 404-Körper.
- Weg Nebengröße → Register-Verlauf der Geräteseite (V8): braucht Anlage und Box-Referenz an der Register-Bindung
  (AP-04 IP-14 / AP-13 IP-12).
- Leerzustände „Vergleich ohne passende“ und „Energiebilanz ohne Hauptzähler“ sind gebaut und geprüft, aber ohne Wirt —
  IP-5 und IP-8 hängen `vergleichOhnePassende` bzw. `OHNE_HAUPTZAEHLER` ein.
- W5 (O16) bleibt Befund an AP-08: die Route antwortet `quelle_teilweise` ohne Zahl, die Referenz erwartet 9 100 kWh.

## Prüfen

```bash
(cd frontend/portal && npx vitest run src/uemsWerteKarte.test.ts src/uemsOberflaechen.test.ts \
  src/components/WerteSektion.test.tsx src/pages/MessstelleSeite.test.tsx src/components/MessstelleDialog.test.tsx src/copy.test.ts)
(cd frontend/portal && MESSSTELLE_SEITE_BILDER=/tmp/mss npx playwright test e2e/messstelle-seite.spec.ts \
  --project=mobile-chromium --project=desktop-chromium)
```
