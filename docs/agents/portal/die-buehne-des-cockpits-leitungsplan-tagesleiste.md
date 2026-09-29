# Die Bühne des Cockpits: Leitungsplan, Jetzt/Heute, Tagesleiste (Konzept „Cockpit als Tagesfilm“)

Umsetzung des abgenommenen Konzepts [`docs/konzepte/cockpit-tagesfilm`](../../konzepte/cockpit-tagesfilm/README.md)
(Freigabe 29.09.2026). Seitdem gilt im Anlagen-Cockpit:

- **Ein Diagramm:** `components/EnergieBuehne.tsx` (nachgeladenes Stück, Platzhalter hält die Höhe) mit
  `components/Leitungsplan.tsx` ersetzt `AdaptiveEnergyFlow`/`EnergyFlow` in `CockpitHero`. Die alten
  Komponenten sind nicht gelöscht (E2E-Harnesse und `GeraetBuehne` nutzen Teile davon), rendern aber
  nicht mehr im Cockpit.
- **Reine Ableitungen:** `leitungsplan.ts` (Herkunft bilanziell je Weg, Spurbreiten/-pfade, Texte in
  Worten, der Satz), `tagesleiste.ts` (96 Viertelstunden aus `/history?range=day` bis jetzt und
  `/schedule` danach), `flussListen.ts` („Verbrauch/Erzeugung im Detail“, größte zuerst, Telefon 4 bzw.
  3 + „n weitere“, Rechner 6 bzw. 5), `flussJetzt.ts` (Moment „jetzt“ aus Topologie, sonst Snapshot).
- **Ehrlichkeit:** Meldet der Speicher keine Leistung, wird sie NICHT aus der Bilanz errechnet (ergab
  im Browser ein erfundenes „lädt 332 kW“); dann gibt es keine Aufteilung und einen Satz dazu. Kanonische
  Rollenwerte (`pvRollen`/`verbrauchRollen`/`netzRollen` mit Zuordnung) haben Vorrang. Zahlen mit einer
  Nachkommastelle wie überall im Portal.
- **Bewegung heißt live:** Punkte (`.vp-lp-punkte`, benannter Loop `vp-flow`) laufen nur bei `is-live`;
  unter `prefers-reduced-motion` entfallen sie im EINEN Block am Ende von `index.css`.
- **Ein Gerät, eine Stelle:** Der Verbraucherstreifen (`ConsumerStrip`) rendert im Cockpit nicht mehr;
  der Zustand je Verbraucher steht in „Verbrauch im Detail“. Zusätzliche Live-Kacheln (Speicher, Sonne,
  Autarkie, Netz heute) aus dem Konzeptkatalog sind bewusst NICHT gebaut: ihre Zahlen stehen schon im
  Fluss, in den Ringen der Geld-Leiste bzw. im Komponenten-Board (R2).
- **Kachelgrößen:** `LayoutDocument.groessen` (Kachel-Id → `klein`|`breit`), Katalog-Liste `kacheln`
  (beide Kopien), Server-Prüfung in `CockpitLayoutService.validateGroessen`, Standard überall `klein`
  (= Bild vorher). Wählbar im Anpassen-Modus am Rechner direkt an der Kachel.
- **Voreinstellung je Betriebsmodell:** `cockpitLayout.betriebAus(blocks)` + `canonicalFuer(isPhone,
  betrieb)`: Marktoptimierung rückt `strompreis`, Lastspitzenkappung `kacheln` direkt hinter die Bühne.
  Eigenverbrauch bleibt Zeichen für Zeichen die alte Reihenfolge (`migration.test.ts`). Gespeicherte
  Schichten gewinnen.
- **Beweise:** `leitungsplan.test.ts`, `tagesleiste.test.ts`, `flussListen.test.ts`,
  `kachelGroessen.test.ts`, `WidgetGrid.test.tsx`; E2E `cockpit-buehne` (drei Betriebsmodelle, 375/1440,
  Tasten, Blätter, Überlauf), `cockpit-rollen`, `laden-bei-bezug`, `layout-waechter` auf den Leitungsplan
  umgestellt. Bündel: Einstieg 224,9 kB gz (Grenze 230).
