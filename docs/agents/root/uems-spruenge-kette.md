# UEMS-Fläche: die Sprünge der Kette (AP-13 IP-11, E2/E10 = A, D1–D4)

Der Befund, mit dem AP-13 anfing, lautete: **„Die Kette bricht am Text ab.“** Herkunft, Nachweis und Quelle standen
als Zeichenketten da — lesbar, nicht anklickbar. IP-11 gibt ihnen Kanten. Es ändert **keinen Wortlaut**: jede Zeile
bleibt zeichengleich der Satz, den ihre Fläche schon sprach; sie bekommt nur Sprünge hinein.

## Der Vertrag: EINE Form für alle Flächen

Reines Modul `frontend/portal/src/uemsOberflaechen.ts` (Abschnitte 3b/3c), Render `components/HerkunftsZeile.tsx`.

- `herkunftsZeile(text, ziel)` schneidet einen Satz in `Stueck[]` — `{ text, sprung }`. Zusammengefügt ergeben die
  Stücke wieder den Satz; das ist in jedem Test der Flächen nachgerechnet.
- `kennzeichenSprung(kennzeichen, rahmen)` entscheidet je Kennzeichen: `MS-…` → Messstellen-Seite › Werte,
  `KZ-…` → Kennzahl-Seite. **Alles andere ist `null` und bleibt Text (D3)** — Bezugsgröße (AP-09), Ereignis (AP-07),
  Box (AP-06 IP-16): kein Paket hat dafür eine Kundenfläche, und es wird keine erfunden.
- **`Rahmen` = Periode + Version (D2).** Ein Sprung, der beides verliert, ist schlimmer als kein Sprung: der Kunde
  landet bei einer ANDEREN Zahl als der, auf die er geklickt hat. Die Periode ist die der ZEILE, nie die der gerade
  offenen Seite; die Version die des EINGANGS, nie die der Zeile.
- `periodeSchluessel(art, am)` schneidet den Kalendertag einer Fläche auf `2026-11-03` · `2026-11` · `2026`.
  `kostenstellenUebersicht.werteperiode` ist seither nur noch der Name dieser einen Regel.

## Wo die Kanten sitzen

| Fläche | Zeile | Ziel |
|---|---|---|
| Kennzahl-Seite (`kennzahlKarte.herkunftAnzeige`) | `eingaengeStuecke`, `paareStuecke` | MS-… › Werte (Periode des Satzes, Version des Eingangs) · KZ-… |
| Berichtsseite (`berichtSeite`, `QuellenZahl.sprung`) | „Zur Messstelle“ / „Zur Kennzahl“ neben „heutigen Wert zeigen“ | Periode = **Zeitraum des Berichts** |
| Bericht-Nachweis einer Kennzahl | `Nachweis.herkunftStuecke` | je Eingang mit der Version des Abzugs |
| Bericht-Quellenverzeichnis | `QuellenEintrag.sprung` | **zusätzlich gefunden** — §8 nennt es nicht; dieselbe Zeile führt zu denselben Objekten |
| Energiebilanz (`anlageEnergiebilanz`) | `TeilBild.sprung`, `HerkunftBild.zeilenStuecke`/`eingaengeStuecke` | Messstelle · **Kostenstelle** der Verteilung |
| Kostenstellen-Reiter (IP-9, schon gebaut) | `posten[].sprung` | Messstelle mit Periode |
| Register (`messstellen.zeileWoerter`) | `quelle.sprung` | Geräte-Seite › Komponente (`#/anlage/{id}/modell?komponente=`) |
| Werte-Karte einer BERECHNETEN Zahl (D4) | `uemsWerteKarte.berechneteHerkunft` | je Eingang mit Periode und seiner Version |
| Anlagen-Cockpit (E2 = A) | `cockpitWeg` | gefiltertes Register `#/portfolio/messstellen?anlage=` |

## Die Fallen

1. **Eine Adresse darf das KENNZEICHEN nennen, die Routen brauchen die ID.** In jeder Herkunfts-Zeile steht `MS-12`,
   nie eine UUID; `GET /api/v1/messstellen/{id}` nimmt aber nur eine UUID (`@PathVariable UUID`). Aufgelöst wird das an
   EINER Stelle: `MessstelleSeite` erkennt `MS-…`, liest einmal das Register und rendert danach mit der ID
   (`MessstelleSeiteKennzeichen.test.tsx`). Ein unbekanntes Kennzeichen sagt „gibt es nicht“ — es stellt keine Anfrage.
2. **Das Cockpit tauscht KEINE Zahl (E2 = A, Q4).** Es bekommt einen Weg, mehr nicht. Dass „Netzbezug heute
   1 212 kWh“ (Rollup der Box) neben „MS-01 1 209 kWh“ steht, sind zwei Abtastungen desselben Zählers (AP-07 W11) —
   kein Abgleich, keine Warnung. Der Umstieg auf Messstellen-Zahlen ist der Bestätigungsschritt in **AP-14**.
3. **Ein Betriebskunde stellt keine Anfrage.** `CockpitMessstellenWeg` fragt das Register nur mit `misst` —
   `ebenenNav.misstAnlage` liest den Standort DIESER Anlage aus dem Lesemodell. Unbekannt ist nie „ja“.
4. **Die Zählung kommt WÖRTLICH aus dem Register** (`aggregat.unternehmen.text`, gefiltert auf die Anlage). Im Portal
   wird nichts gezählt; der Anlagen-Filter ist `messstellen.anlageAus` aus der Adresse, Zwilling zu `ortAus` (IP-10).
5. **Tippflächen am Telefon (E14).** Der Wächter von `energiebilanz.spec.ts` misst JEDES `a` der Fläche gegen 44 px.
   Ein Sprung IN einem Satz darf die Zeile nicht auseinanderziehen: `.vp-herkunft-sprung` bekommt darum senkrechte
   INNENABSTÄNDE (vergrößern die Trefferfläche, nicht die Zeilenhöhe); der Name eines Unterzählers wird unter 721 px
   ein `inline-flex` mit `min-height: 44px`.
6. **Der Rahmen wird am ZUGEKLAPPTEN Bild gemessen.** Die Herkunfts-Karte der Bilanz nennt „verteilt 100 % an
   Kostenstelle 4300“ — eine Prozentzahl, die der B2-Wächter verbietet, solange sie sichtbar ist. Erst messen, dann
   aufklappen (so hält es auch der O5-Test).
7. **Ein Kennzeichen wird als GANZES Wort erkannt.** „MS-1“ in „MS-12“ ist kein Treffer, „MS-12-alt“ ist keiner.
8. **`berechneteHerkunft` nennt die MENGE eines Eingangs nicht.** Die Hülle trägt sie als Dezimaltext ohne Einheit;
   die Einheit des Eingangs steht nirgends, und die der Karte ist nicht seine (eine Messstelle misst auch m³). Eine
   Zahl ohne Einheit wäre geraten — die Zeile nennt Kennzeichen, Zustand, Version und Kennzeichen des Eingangs.
   An der Bilanz steht sie, weil eine Energiebilanz per Vertrag in kWh rechnet.

## Was NICHT gebaut ist

- Gebäude als Sprungziel (`sprungziel({art:'gebaeude'})` gibt weiter `null`): die Gebäude-Karte ist erreichbar, aber
  eine Zeile, die ein Gebäude NENNT, kennt seinen Standort nicht — dafür fehlt das Feld in der Antwort.
- Der gemessene Weg „Ebene → Welt → Zahl → Nachweis“ als EIN Playwright-Lauf ist **IP-13** (`e2e/weg.spec.ts`); IP-11
  misst jede Kante an ihrer Fläche.
- Der Cockpit-Weg hat keinen Playwright-Nachweis: die Bühne `startansicht` rendert das Cockpit nicht (nur Kopf und
  Pfad). Gemessen ist er als Komponenten-Test (`CockpitMessstellenWeg.test.tsx`) und gegen O18.
