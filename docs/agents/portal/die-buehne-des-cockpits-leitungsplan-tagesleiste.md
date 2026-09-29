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
- **Ein Gerät, eine Stelle:** „Verbrauch/Erzeugung im Detail“ unter dem Fluss sind der EINE Ort der
  Geräte (auch der Ladepunkte, `ladenKachelSichtbar: false`); Komponenten-Board (`KomponentenSection`) und
  Verbraucherstreifen rendern im Cockpit nicht mehr (`komponenten` ist nicht mehr `verfuegbar`, die Id
  bleibt im Katalog für gespeicherte Layouts). Jede Zeile und jeder Knoten öffnet ein Blatt mit Herkunft,
  Aufschlüsselung je Gerät (auch der kanonischen Rollen, `RollenBreakdown anfangsOffen`) und den Wegen
  „Verlauf ansehen“/„Ihre Geräte“. Tagessummen je Gerät werden erst mit „Heute“ bzw. dem Blatt geholt.
- **Kachelraster wie im Prototyp:** aufeinanderfolgende Bausteine `geld`, `strompreis`, `fahrplan`,
  `laden`, `kacheln` teilen EIN Raster (`stapelMitRaster` in `AnlagenPage`, 2 Spalten Telefon, 4 Rechner).
  Hülle `components/kacheln/Kachel.tsx` (Kopf = Absprung, Stern = Leitkachel), Inhalte im nachgeladenen
  Stück `components/kacheln/CockpitKacheln.tsx`, Ableitungen in `kacheln.ts` (Autarkie/Eigenverbrauch mit
  den Server-Kennzahlen des Tages und bilanzieller Aufteilung, Speicher, Fahrplan-Tagesuhr, Handel, Sonne,
  Netz heute, Steuerspalten). Börsenpreis und Laden tragen die Hülle selbst (`kachel`-Prop). Der
  Börsenpreis zeigt Stundenbalken (`strompreis.boersenKachel`: Mittel je Berliner Stunde, Drittel wie das
  Urteil, Lücke bleibt Lücke) und die zwei Fenster aus `streifenFenster` mit Ø-Preis.
- **Leitkachel:** am Rechner rechts neben dem Fluss (`CockpitHero seite`), am Telefon erste Kachel:
  Marktoptimierung → Börsenpreis, Lead `peak-band` → Lastspitze, sonst „Unterm Strich“. Sie steht dann
  nicht noch einmal im Raster.
- **Steuerzeile:** am Fuß der Bühne (Telefon und Rechner) Auftrag · Gerät · Wirkung (`steuerSpalten`); die
  Wirkung nennt die Leistung nur, wenn sie vom Auftrag abweicht. Keine Bestätigungszeile am
  Speicher-Knoten, kein Plan-Satz in der Leiste; der Zustand lässt Steuerungs- und Plan-Befunde weg, die in
  Steuerzeile bzw. Fahrplan-Kachel stehen. Börsenpreis im Satz nur abseits von „jetzt“.
- **Kachelgrößen:** `LayoutDocument.groessen` (Kachel-Id → `klein`|`breit`), Katalog-Liste `kacheln`
  (beide Kopien; Sonne Standard breit, Handel/Lastspitze nur breit), Server-Prüfung in
  `CockpitLayoutService.validateGroessen`. Wählbar im Anpassen-Modus unter der Kachel (`GroessenWahl`).
- **Voreinstellung je Betriebsmodell:** `cockpitLayout.betriebAus(blocks)` + `canonicalFuer(isPhone,
  betrieb)` aus `TAGESFILM` (Rechner und Telefon gleich); die Kacheln im Baustein `kacheln` folgen
  `KACHEL_REIHE` in `AnlagenPage` (Prototyp `DEFAULTS`). Gespeicherte Schichten gewinnen.
- **Beweise:** `leitungsplan.test.ts`, `tagesleiste.test.ts`, `flussListen.test.ts`, `kacheln.test.ts`,
  `kacheln/CockpitKacheln.test.tsx`, `kachelGroessen.test.ts`, `AnlagenPage.test.tsx`; E2E
  `cockpit-buehne`, `cockpit-rollen`, `laden-bei-bezug`, `summenwert-abnahme` (Rollen im Blatt),
  `layout-waechter`. Browserprüfung: `e2e/help.html?betrieb=eigen#/anlage/help-site` (Eigenverbrauch)
  bzw. ohne Parameter (Marktoptimierung), Uhr auf `2026-09-10T10:00:00Z`, `TZ=Europe/Berlin`. Bündel:
  Einstieg 210,6 kB gz (Grenze 230).
