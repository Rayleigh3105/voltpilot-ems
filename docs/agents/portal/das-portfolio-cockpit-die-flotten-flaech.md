# Das PORTFOLIO-COCKPIT: die Flotten-Fläche (Stufe 4, **Revision 2**)

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 16).


Captain-Entscheid **E5** (EINE Fläche für jeden Mehr-Anlagen-Kunden), seit dem 25.08.2026 in
der **Revision 2** (Scout `data/vp-portfolio-konzept-r2` §5.2/§5.4, `…-b3` §6a; Entscheide E1
„A · Tabelle mit Vorschau-Zeile", E2 „Geld-Held entfällt", E5 „Anpassen = Zellen + Spalten" plus
die drei Schärfungen: Status als EINE Zeile · kein kumulierter Ladestand · Reset ohne Drohung).
Regeln, Katalog und Server-Seite stehen in der Root-`AGENTS.md`; hier die Fläche.

**⚠ Stand 25.09.2026:** Die Fläche zeigt für JEDE Betriebsart die Übersicht in vier Blöcken
(Konzept „Meine Anlagen neu", Ü1–Ü5 = A: Statuszeile mit ⋯-Menü → Heute → Jetzt → Ihre Anlagen;
`components/portfolio/KundenUebersicht.tsx`, rein in `src/kundenUebersicht.ts`). Die Betriebsart
wählt nur noch die Navigation (`betriebsart.ts`); `PortfolioCockpit` kennt sie nicht mehr (Wächter
in `migration.test.ts`). Kennzahlen-Leiste, Anlagen-Tabelle und Vorschau-Zeile sind aus der Fläche
entfallen; `KennzahlLeiste`, `AnlagenTabelle` und `portfolioVorschau` rendert nur noch die
Prüfbühne `e2e/erloese-minus.tsx`. Die Regeln unten zu Leiste, Tabelle, Dichte und Vorschau
beschreiben diese Bauteile, nicht mehr die Übersicht.

Bis dahin (Revision 2) las sie von oben nach unten: **Kopf** (Titel + die EINE Flotten-Aussage
als Unterzeile, Aktionen im „···"-Menü, daneben „Anpassen") → **Kennzahlen-Leiste** → **EINE
Anlagen-Tabelle** in zwei Dichten mit aufklappbarer Vorschau je Zeile.

### Was Revision 2 ERSATZLOS entfernt hat, und warum

- **Der Geld-HELD** (`EarningsHero`) und die **Flotten-Status-KARTE** (`FleetStatusCard`) sind
  aus `components/FleetOverview.tsx` GELÖSCHT — der Marken-Verlauf gehört Login und Marketing,
  im Betriebs-Portal ist Geld eine Zelle der Leiste wie jede andere Zahl. Die TONALITÄT trägt
  weiterhin das WORT (`vorteilLabel`: „Mehrerlös heute" vs. „Vorteil heute"). Ihre
  Ehrlichkeitsregeln (Verlusttag unter der Nulllinie, Strich statt Mindesthöhe, kein Nullbalken)
  sind unberührt — sie wohnen im reinen `miniChart.ts` und sind dort geprüft, deshalb ging mit
  `FleetOverview.test.tsx` nichts verloren. **`FleetSiteCard` lebt weiter**: sie ist die Karte
  der Anlagen-LISTE (`#/anlagen`).
- **Die neun Icon-Kacheln** sind eine LEISTE (`components/KennzahlLeiste.tsx` + `.css`) — dieselben
  Katalog-Bausteine, nur als Zellen. Das 235-px-`auto-fit`-Gitter (`.vp-portfolio-kpis`, samt
  `kachelFuer`/`ladestandFussnote`/`vp-portfolio-kpi-paar`) ist weg: seine letzte Kachel stand bei
  fast jeder Breite als WAISE in einer eigenen Reihe.
- **Karten und Tabelle sind EINE Tabelle** (`components/AnlagenTabelle.tsx` + `.css`). `dichte`
  entscheidet nur noch über Zeilenhöhe und Unterzeile, **nicht mehr über den INHALT** — das war
  Befund K4. Karten rendert erst das Telefon, und zwar in derselben Zeilen-Grammatik.
- **Die Begrüßung** („Guten Tag, …") ist aus beiden Wirten weg: unter dem Titel steht jetzt die
  Flotten-Aussage, und eine Begrüßung darüber wäre die zweite Zeile, die nichts über die Flotte
  sagt. `PortfolioPage`/`UebersichtPage` reichen nur noch ihren `titel` durch.

### Die Regeln der Fläche

- **⚠ ALLES Rechnende liegt im reinen `src/portfolioCockpit.ts`**, die Vorschau in
  `src/portfolioVorschau.ts`, die Anordnung in `src/cockpitLayout.ts` — die drei Bauteile
  rendern. `portfolioVorschau` erfindet dabei KEINE Aussage: jede Zeile ist eine Komposition
  bestehender, anderswo geprüfter Ableitungen (`schedule.planSentence` · `preisFenster` ·
  `control.controlStrip` · `health.healthChecklist`). Zwei Formulierungen über dieselbe Sache
  wären zwei Wahrheiten.
- **`bausteinOrt(id)` sagt, WO ein Baustein rendert** — Zelle der Leiste, Spalte der Tabelle oder
  beides. „PV jetzt" ist BEIDES (einmal Σ über die Flotte, einmal je Anlage), und das ist kein
  Widerspruch, sondern der Kern der Zeilen-Grammatik. Deshalb gibt es **EIN Auge je Baustein**:
  wer „PV jetzt" ausblendet, meint die GRÖSSE, nicht den Ort.
- **⚠ Der kumulierte Ladestand ist RAUS** (Captain: „ist doch nicht aussagekräftig oder?").
  `speicher` ist `aggregation: 'je_anlage'` und rendert NUR die Spalte; `PortfolioKennzahlen`
  trägt kein `ladestandPct` mehr, nur `ladestandAnlagen` (der Zähler, der über die Spalte
  entscheidet). Ein wieder auftauchendes `gewichtet` im Katalog ist der Hinweis darauf, dass
  jemand erneut einen Prozentsatz zusammenfasst — beidseitig gepinnt (`portfolioCockpit.test.ts`
  + Java `AnwendungKatalogTest`).
- **Eine Zelle ohne Wert wird gar nicht erst gebaut, eine Spalte ohne einen einzigen Wert
  weggelassen** (`leistenZellen` / `tabellenSpalten`) — das ist die Antwort auf „—, —, —". **Ein
  EINZELNES „—" bleibt dagegen stehen:** in einer gemischten Flotte ist es die wahre Aussage über
  genau diese Anlage. `tabellenSpalten` hält dabei die feste Lese-Reihenfolge Jetzt → Heute: die
  ANORDNUNG entscheidet, WELCHE Spalte es gibt, nicht in welcher Reihenfolge sie stehen — eine je
  Kunde anders sortierte Tabelle liesse sich zwischen zwei Anlagen nicht mehr lesen.
- **`flottenAussage` ist EINE Zeile und zählt ANLAGEN**, nicht Geräte; ihr Urteil je Anlage ist
  wörtlich `portfolio.siteStatus`. Eine Anlage mit Aufmerksamkeitsbedarf wird BEIM NAMEN genannt
  und trägt ihr Alter.
- **`anlagenZeilen` sortiert Zustand zuerst, dann Name** — die Anlage, die Aufmerksamkeit braucht,
  steht oben, ohne dass jemand sortiert. Ein „jetzt"-Wert entsteht nur mit FRISCHEM Messwert
  (`siteLiveFresh`); die Tages-Summen bleiben davon unberührt (sie sind Historie).
- **⚠ Die Vorschau lädt LAZY, je Anlage genau einmal** (`useVorschau`): zwei Abrufe je Anlage bei
  jedem Seitenaufruf wären der Preis für eine Fläche, die der Kunde meistens gar nicht aufklappt.
  Beide Abrufe sind fail-soft, und `null` heisst „lädt noch" — Laden und „nichts da" sind zwei
  verschiedene Auskünfte, und die Fläche sagt beide.
- **Die ZEILE ist der direkte Absprung in die Anlage** (Captain-Entscheid 28.08.2026): ein Klick
  auf Zeile oder Name navigiert sofort. Nur der räumlich getrennte Chevron klappt die Vorschau
  lazy auf/zu; er stoppt die Zeilen-Navigation und nennt Vorlesesoftware „Details anzeigen" bzw.
  „ausblenden". „Cockpit öffnen ›" bleibt als zusätzlicher Absprung in der offenen Vorschau.
- **Anpassen ordnet BAUSTEINE in einer Liste** (seit dem 25.09.2026 blenden und ordnen sie die
  drei Blöcke, `uebersichtBloecke`) — auf BEIDEN Breiten die kompakte `AnpassenListe`, nie
  eine `AnpassenHuelle`. `AnpassenListe` hat
  dafür das additive `note` bekommen und zeigt den `ortsHinweis` eines unbeweglichen Bausteins
  („Der Block „Ihre Anlagen" steht immer zuletzt.") — ein „fest" ohne Begründung ist eine Sperre ohne
  Grund. **Das Portfolio hat keine Bühne**, also `blocks: []` und kein Stern.
- **⚠ Der Reset-Satz nennt das ERGEBNIS, nicht den Verlust** („Danach gilt wieder …" statt „Ihre
  Anordnung wird verworfen — …"). Beides ist wahr, aber die zweite Form droht mit einer Handlung,
  die der Kunde selbst ausgelöst hat.
- **⚠ Der Kopf NENNT die Ebene nur, wo sie sonst niemand nennt (Passung zu #503).** Seit der
  Navigations-Runde „zwei Ebenen" trägt die Flotten-Ebene die Reiter `Übersicht · Energie ·
  Erlöse` ÜBER dem Seitenkopf, und die Kopfzeile führt die Krume „Portfolio" — die Überschrift
  stünde dort als DRITTE Nennung, während der aktive Reiter „Übersicht" sagt und sie „Portfolio".
  `titelBereitsGenannt` macht sie deshalb zum reinen Sprungziel (`vp-sr-only`, das
  `AnlageSeite`-Muster des Mobil-Umbaus), die Statuszeile führt sichtbar. **Der Endkunden-Wirt
  setzt es NICHT** — `isPortfolioPage('uebersicht')` ist false, dort gibt es keine Reiter, und die
  Überschrift ist die einzige Stelle, die die Fläche benennt.
- **`RowMenu` ist das „···"-Menü** — dasselbe Bauteil wie in den Tabellen (portaliert,
  viewport-geklemmt, Escape/Klick-daneben). Kein zweiter Popover-Mechanismus.
- **⚠ Die Tabelle ist BEWUSST nicht `.vp-table.responsive`:** deren Telefon-Fassung klappt jede
  Zelle zu einer Etikett/Wert-Zeile, und acht davon je Anlage sind genau die Wand, gegen die
  diese Revision gebaut ist. Am Telefon rendert `AnlagenTabelle` stattdessen EINE Karte je Zeile
  mit den DREI Jetzt-Werten; die Tages-Summen stehen in der Vorschau. Der horizontale Überlauf
  der acht Spalten bleibt im EIGENEN Rahmen (`.vp-at-wrap`), nie auf der Seite.
- **Beweise:** `src/portfolioCockpit.test.ts` (56, rein) · `src/portfolioVorschau.test.ts` (11) ·
  `components/KennzahlLeiste.test.tsx` (7) · `components/AnlagenTabelle.test.tsx` (16, inkl. der
  Telefon-Fassung mit `matchMedia`-Attrappe) · `components/PortfolioCockpit.test.tsx` (20, vier
  Blöcke) · `pages/PortfolioPage.test.tsx` (3) · `src/betriebsart.test.ts` (24) ·
  `src/shell/PortfolioNav.test.tsx` (4) · `src/migration.test.ts` (41, mit vier neuen
  Abbau-Wächtern).

