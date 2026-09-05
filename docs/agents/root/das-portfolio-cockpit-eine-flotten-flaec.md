# Das PORTFOLIO-COCKPIT: EINE Flotten-Fläche für jeden Mehr-Anlagen-Kunden (Stufe 4, Rev. 2)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 122).


Captain-Entscheide **E5** (ein Portfolio-Cockpit aus den Anwendungen komponiert; die Betriebsart
steuert nur noch DICHTE und TONALITÄT; `FleetUebersicht` geht darin auf) und **E1** (das
Portfolio-Layout hängt am KUNDEN) vom 24.08.2026, Konzept `data/vp-portal-zielbild-anwendungen`
§2.5/§3.5/§4.3 C — seit dem 25.08.2026 in der **Revision 2** (Scout
`data/vp-portfolio-konzept-r2` §5.2/§5.4, `…-b3` §6a: Kopf mit EINER Flotten-Zeile,
Kennzahlen-LEISTE statt Icon-Kacheln, EINE Anlagen-Tabelle in zwei Dichten, **kein Geld-Held**
und **kein kumulierter Ladestand**; die Fläche selbst steht in `frontend/portal/AGENTS.md`). **Der behobene Befund war die KOMPOSITION, nicht die Datenlage:** die
Grammatik war schon die des Cockpits, die KPI-Zeile aber fest Geld-und-Speicher-zuerst — ein
Gewerbekunde mit drei Filialen und reinem Monitoring sah dort **„—, —, —"**.

- **⚠ Es gab ZWEI Flotten-Flächen für dieselbe Frage, und das war die eigentliche Ursache:**
  `PortfolioPage` (Betreiber, feste KPI-Zeile + Operator-Tabelle) und `FleetUebersicht`
  (Endkunde ≥ 2, ruhige Karten). Seit Stufe 4 gibt es NUR `components/PortfolioCockpit.tsx`;
  `FleetUebersicht` ist ERSATZLOS darin aufgegangen (seine Karten-Dichte IST ihr Bild), und
  `pages/PortfolioPage.tsx` ist nur noch der Kopf darüber. Ein Wächter in `migration.test.ts`
  hält fest, dass sie nicht zurückkommt.
- **⚠ `showPortfolioNav` hängt seit Stufe 4 an der FLOTTEN-EBENE, nicht mehr am Betreiber-Rahmen**
  (`betriebsart.ts`). Das ist die **sichtbare U0/U5-Änderung**: ein Endkunde ab zwei Anlagen sieht
  statt „Übersicht" den Punkt „Portfolio" — dieselbe ruhige Karten-Dichte, jetzt mit den Bausteinen
  seiner Anwendungen und den zwei Portfolio-Welten. Sein altes Lesezeichen `#/uebersicht` gilt
  weiter (`redirectToPortfolio` leitet es). **Ein EINZEL-Anlagen-Kunde ist zeichengleich unberührt**
  — er hat keine Flotten-Ebene, seine Übersicht IST seine Anlagen-Seite wie seit je.
- **Die Betriebsart entscheidet nur noch zweierlei:** die DICHTE (`portfolioDichte` — seit
  Revision 2 `kompakt` für den Betreiber und `komfortabel` für jeden anderen; **beide rendern
  DIESELBE Tabelle**, sie unterscheiden sich in Zeilenhöhe und Unterzeile. Die frühere Lesart
  „Tabelle vs. Karten" war der Grund, warum die Betriebsart nicht die Dichte, sondern den INHALT
  änderte) und die TONALITÄT (`fleetTonalitaet`). Ihr dritter, unveränderter Nutzen ist
  die Frage, AB WANN es eine Flotten-Ebene gibt (Betreiber ab der ersten Anlage, Endkunde ab der
  zweiten).
- **⚠ DIE AGGREGATIONSREGEL WOHNT AM BAUSTEIN, im EINEN Katalog** (`anwendungen/catalog.json`,
  Portal-Kopie byte-gleich): je Portfolio-Baustein `aggregation` aus dem GESCHLOSSENEN Vokabular
  `summe | gewichtet | je_anlage` plus `aggregation_regel`, dem deutschen Satz, der auch sagt, was
  ausdrücklich NICHT zusammengefasst wird. **In diesem Vokabular kommt ein ungewichtetes
  Prozent-Mittel gar nicht vor** — genau das verhindert „Ø Autarkie der Flotte". Ein
  Cockpit-Baustein trägt beide Felder NIE (er zeigt EINE Anlage und fasst nichts zusammen);
  `AnwendungKatalogTest` nagelt beide Richtungen fest.
  **⚠ Seit Revision 2 trägt KEIN Portfolio-Baustein mehr `gewichtet`** (Captain: „Der kumulierte
  Ladestand ist doch nicht aussagekräftig oder?"): `speicher` ist `je_anlage` und rendert nur noch
  die SPALTE der Tabelle. Ein wieder auftauchendes `gewichtet` ist der Hinweis darauf, dass jemand
  erneut einen Prozentsatz zusammenfasst — beidseitig gepinnt (`AnwendungKatalogTest` +
  `portfolioCockpit.test.ts`).
- **Die drei Regeln, die die Zahlen ehrlich halten** (`frontend/portal/src/portfolioCockpit.ts`,
  rein + Docker-frei geprüft — das `Tagesprotokoll`/`FleetPflege`-Muster):
  - **Σ nur, wo Σ ehrlich ist.** Energie (kWh), Leistung, Geld und Stückzahlen werden summiert;
    **Bezug und Einspeisung GETRENNT, nie saldiert** (eine Filiale, die einspeist, darf den Bezug
    einer anderen nicht rechnerisch tilgen). **⚠ Seit Revision 2 gibt es GAR KEINEN Mittelwert
    mehr:** der Ladestand war der einzige (kapazitätsgewichtet), und er ist raus — er steht
    ausschliesslich JE ANLAGE in der Tabellen-Spalte bzw. der Telefon-Karte. `PortfolioKennzahlen`
    trägt dafür nur noch `ladestandAnlagen`, den Zähler, der über die SPALTE entscheidet. Die
    Flotten-Zeile führt `storageCapacityKwh` weiter (sie war das Gewicht des alten Mittels und
    bleibt für spätere Fragen nützlich), aber nichts liest sie mehr für eine Flotten-Zahl.
  - **`null` statt einer erfundenen 0** — und ein Baustein ohne Wert wird AUSGEBLENDET statt als
    „—" hingestellt. Das ist die Antwort auf den Befund.
  - **Ein Baustein braucht BEIDES: eine aktive Anwendung UND einen Wert** (`verfuegbareBausteine`).
    Die aktiven Anwendungen kommen dabei VOM SERVER (`OverviewSite.anwendungen`) — der gespeicherte
    Kundenwille (`site_profile_state`) liegt allein dort, ohne ihn bliebe eine ABGESCHALTETE
    Anwendung sichtbar. Ein älteres Backend ohne das Feld leitet je Anlage aus der Zeile ab, was
    sie belegt (Monitoring + ggf. Speicher-Fahrplan): ein ehrlicher Rückfall, der zu wenig sagen
    kann, nie zu viel.
- **⚠ „PV jetzt" zählt nur Anlagen mit FRISCHEM Messwert** (`siteLiveFresh`) und die Fläche NENNT
  die Zahl der beitragenden Anlagen: eine Box, die ihren Puffer mit alten Zeitstempeln nachspielt,
  liefert wahre Werte, aber kein „jetzt" (die dokumentierte store-and-forward-Regel).
- **Server:** `GET /api/v1/overview` trägt je Anlage additiv `storageCapacityKwh` ·
  `energyToday` (Σ des laufenden Berliner Tages aus `telemetry_rollup_15m`, jedes Feld einzeln
  `null`) · `chargePointCount` (die Rollen-Zählung fasst Ladepunkte unter `consumer` zusammen und
  kann die Frage nicht beantworten) · `anwendungen`. **Kein neuer Endpunkt, keine Migration** — RLS
  ist wie überall hier der Zaun.
- **Layout-Scope KUNDE** (E1): das Portfolio nutzt DIESELBE `cockpit_layout`-Tabelle und
  DIESELBE `layoutResolve`, mit `scope_kind='tenant'`/`surface='portfolio'` — deshalb waren beide
  seit Stufe 3 scope-generisch gebaut. Kein zweiter Speicher, kein zweiter Editor: der
  Anpassen-Modus der Stufe 3 wird wiederverwendet. **Das Portfolio hat keine Bühne** (kein
  lead-fähiger Baustein), der Server lehnt dort jeden `lead` ab.
- **Beweise:** rein `portfolioCockpit.test.ts` (56) + `portfolioVorschau.test.ts` (11) +
  `migration.test.ts` (41, u. a. „der Einzel-Anlagen-Kunde ist byte-identisch", „die frühere
  FleetUebersicht ist ersatzlos übergegangen" und die vier Revision-2-Abbau-Wächter) + Java
  `AnwendungKatalogTest` (kein Baustein mittelt mehr) · DOM
  `components/PortfolioCockpit.test.tsx` (21, der §4.3-C-Fall mit echten Zahlen, beide Dichten
  über DIESELBE Flotte, der Kopf-Satz, die Vorschau) + `components/AnlagenTabelle.test.tsx` (15)
  + `components/KennzahlLeiste.test.tsx` (7) + `pages/PortfolioPage.test.tsx` (4) ·
  Testcontainers `PortalApiTest.overviewCarriesTheEnergyStorageWeightAndActiveApplicationsOfEachSite`.
  Mutationsgeprüft: das Anwendungs-Tor, die Aggregations-Pflicht im Katalog und die
  `null`-Ehrlichkeit von `energyToday` fallen ohne ihre Regel um.
- **NICHT in dieser Stufe:** eigene Kacheln aus Messwerten (`document.custom`, Stufe 5) ·
  Berichte (Stufe 6) · eine Portfolio-Fläche für den Einzel-Anlagen-Kunden (er hat keine
  Flotten-Ebene, und eine „Flotte von eins" wäre eine Fläche ohne Frage).

