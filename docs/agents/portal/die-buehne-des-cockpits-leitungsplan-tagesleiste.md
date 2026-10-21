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
- **Kopf und Zeitwahl (Konzept b1, 20.10.2026):** Der Kopf ist ein Raster mit festen Plätzen
  (Telefon `uhr modus` / `marke marke`, Rechner eine Zeile); der Umschalter Jetzt/Heute bricht nie um.
  Die Plan-Tätigkeit steht in der Marke („Plan · …“, abseits von jetzt gemessen „gemessen · Plan: …“),
  es gibt keine zweite Plakette. Die Tagesleiste steht direkt unter dem Fluss: „Verbrauch im Detail“
  schrumpft beim Verlassen von „jetzt“ von vier Zeilen auf eine, darunter sprang die Leiste nach dem
  ersten Tipp 135 px unter dem Finger weg. Ein Finger wählt nur durch einen Tipp (`touch-action: pan-y`,
  Loslassen unter 10 px vom Aufsetzpunkt), Wischen scrollt die Seite; die Maus zieht weiter. ‹ › gehen
  je eine Viertelstunde, „Zurück zu Jetzt“ erscheint nur abseits von jetzt. „Tag abspielen“ und der
  Hinweissatz entfallen. Beweis: `e2e/cockpit-buehne.spec.ts` (Wisch über CDP, Tipp, Lage der Leiste).
- **Bewegung heißt live:** Punkte (`.vp-lp-punkte`, benannter Loop `vp-flow`) laufen nur bei `is-live`;
  unter `prefers-reduced-motion` entfallen sie im EINEN Block am Ende von `index.css`.
- **Ein Gerät, eine Stelle:** Unter dem Fluss steht nur „Verbrauch im Detail“ (auch die Ladepunkte,
  `ladenKachelSichtbar: false`); die Erzeugung je Gerät steht nur im Blatt des Sonnen-Knotens. Die Blätter
  zeigen dieselbe Listenform vollständig (`ListeBlock` ohne `onOpen`, Zeilen verlinken auf Geräteseiten),
  kanonische Rollen über `flussListen.rollenListe` - die alten Panels `PvCompositionDetails`,
  `VerbrauchDetails`, `RollenBreakdown` rendern im Cockpit nicht mehr; Komponenten-Board (`KomponentenSection`) und
  Verbraucherstreifen rendern im Cockpit nicht mehr (`komponenten` ist nicht mehr `verfuegbar`, die Id
  bleibt im Katalog für gespeicherte Layouts). Jede Zeile und jeder Knoten öffnet ein Blatt mit Herkunft,
  Aufschlüsselung je Gerät und den Wegen
  „Verlauf ansehen“/„Ihre Geräte“. Tagessummen je Gerät werden erst mit „Heute“ bzw. dem Blatt geholt.
- **Kachelraster wie im Prototyp:** aufeinanderfolgende Bausteine `geld`, `strompreis`, `fahrplan`,
  `laden`, `kacheln` teilen EIN Raster (`stapelMitRaster` in `AnlagenPage`, 2 Spalten Telefon, 4 Rechner).
  Hülle `components/kacheln/Kachel.tsx` (Kopf = Absprung, Stern = Leitkachel), Inhalte im nachgeladenen
  Stück `components/kacheln/CockpitKacheln.tsx`, Ableitungen in `kacheln.ts` (Autarkie/Eigenverbrauch mit
  den Server-Kennzahlen des Tages und bilanzieller Aufteilung, Speicher, Fahrplan-Tagesuhr, Handel, Sonne,
  Netz heute, Steuerspalten). Börsenpreis und Laden tragen die Hülle selbst (`kachel`-Prop). Der
  Börsenpreis zeigt Stundenbalken (`strompreis.boersenKachel`: Mittel je Berliner Stunde, Drittel wie das
  Urteil, Lücke bleibt Lücke) und die zwei Fenster aus `streifenFenster` mit Ø-Preis.
- **Rechte Spalte der Bühne (Rechner):** die Leitkachel. Den Werteblock „Dieser Moment“ (die vier
  Werte noch einmal, mit Menü ⋯ „Überwachen“) gibt es seit Konzept b1 nicht mehr (Entscheide E1/E3,
  20.10.2026): die Werte stehen an den Knoten, und eine Überwachung entsteht nur unter Meldungen ›
  Überwachungen („+ Überwachung“, `NeueUeberwachung.tsx`; Wächter `ueberwachenNurMeldungen.test.ts`).
  Ohne Leitkachel ist die Bühne einspaltig. Unter der Liste „Zahlen als Liste“ (Tabelle Moment/Tag). Das Cockpit spricht in `--vp-c-font` (Plus Jakarta
  Sans) wie der Prototyp; der Zustand ist eine schmale Zeile ohne Modus-Fuß (`ZustandCard kompakt`).
- **Leitkachel:** am Rechner rechts neben dem Fluss (`CockpitHero seite`), am Telefon erste Kachel:
  Marktoptimierung → Börsenpreis, Lead `peak-band` → Lastspitze, sonst „Unterm Strich“. Sie steht dann
  nicht noch einmal im Raster.
- **Steuerzeile (Konzept b1, 20.10.2026, Entscheid E2):** EINE Zeile Auftrag › Gerät › Wirkung
  (`steuerSpalten`, `ControlStrip variant="zeile"`), am Rechner rechts unter der Leitkachel, am Telefon und
  ohne Leitkachel am Bühnenfuß; die Wirkung nennt die Leistung nur, wenn sie vom Auftrag abweicht. Die
  Sätze (Plan, Gerät, Einspeisung, Ausblick, Einspeisegrenze) stehen unverändert, aber je Herkunft
  gegliedert im Blatt „Warum?“ (Telefon `BottomSheet`, Rechner `Modal`) - vorher bis zu drei Absätze unter
  der Bühne. Die Abweichung der Einspeisegrenze im Wechselrichter (`deviceLimitLine`) zählt die Zeile als
  „1 Hinweis“; sie ist ein Befund im Zustand und im Kopf-Abzeichen (`health.ts` Schlüssel `grenze`, Hebel
  Einstellungen). Der Folge-Satz nennt `executionTargetKw` „nach Solar verbleibenden Verbrauch“, nie
  „Ihr Verbrauch“. Beweis: `e2e/cockpit-steuerzeile.spec.ts` (`help.html?steuerung=abweichung`). Keine Bestätigungszeile am
  Speicher-Knoten, kein Plan-Satz in der Leiste; der Zustand lässt Steuerungs- und Plan-Befunde weg, die in
  Steuerzeile bzw. Fahrplan-Kachel stehen. Börsenpreis im Satz nur abseits von „jetzt“.
- **Erzeugeranlage an einer Anlagensteuerung (EZ-8, Konzept „Erzeuger am WAGO-Modbus-Server“, EW-11 A):**
  kein Reiter, dieselben Flächen. Quelle `api.erzeugerJetzt` (`GET …/sites/{id}/erzeuger/jetzt`, 204/404 =
  Cockpit wie bisher), Ableitung `erzeuger.ts` als eigenes Stück (lädt erst mit Anlagensteuerung,
  Einstiegs-Budget). Kopf: Vorgaben als Abzeichen; Bühne: Moment aus dem Bild der Steuerung (nicht aus der
  Hausbilanz), oberer Knoten „Erzeugung“ mit Motor/Sonne, „Hof“ = Erzeugung + Netzpunkt, ohne Netzpunkt
  (EW-16 C) Netz und Hof „—“; Steuerzeile = Kette Netzbetreiber › Direktvermarkter › (eigene Grenze) ›
  Anlage nur, wenn kein Speicher gesteuert wird (`!batteryLinked && controlStatus == null`), sonst bleibt
  die Speicher-Zeile; Tagesleiste mit Spuren der Vorgaben; Kacheln „Motoren“/„Wechselrichter“ und
  „Wer hat heute geregelt?“ (aus den Wechseln von `quelle_p`, `nb.bits`, `dv.bits`), Biogas „Unterm
  Strich“ „—“. Gültigkeitsbit = 0 ist unbekannt, nie 0. Beweis: `erzeuger.test.ts`,
  `ControlStrip.erzeuger.test.tsx`, `EnergieBuehne.erzeuger.test.tsx`, `e2e/cockpit-erzeuger.spec.ts`
  (`help.html?erzeuger=buettner|gore`).
- **Kachelgrößen:** `LayoutDocument.groessen` (Kachel-Id → `klein`|`breit`), Katalog-Liste `kacheln`
  (beide Kopien; Sonne Standard breit, Handel/Lastspitze nur breit), Server-Prüfung in
  `CockpitLayoutService.validateGroessen`. Wählbar im Anpassen-Modus unter der Kachel (`GroessenWahl`).
- **Voreinstellung je Betriebsmodell:** `cockpitLayout.betriebAus(blocks)` + `canonicalFuer(isPhone,
  betrieb)` aus `TAGESFILM` (Rechner und Telefon gleich); die Kacheln im Baustein `kacheln` folgen
  `KACHEL_REIHE` in `AnlagenPage` (Prototyp `DEFAULTS`), „@geld“ setzt „Unterm Strich“ an seinen Platz im
  Raster, solange `geld` direkt hinter `kacheln` steht. `verstecktFuer(betrieb)` blendet bei
  Marktoptimierung und Lastspitze den Fahrplan vor (zurückholbar über `shown`). „Unterm Strich“ ist
  kompakt (Zahl, Zeitraum, Zurechnung, „Zwischenstand“), die Langform steht auf der Erlöse-Seite.
  Gespeicherte Schichten gewinnen.
- **Beweise:** `leitungsplan.test.ts`, `tagesleiste.test.ts`, `flussListen.test.ts`, `kacheln.test.ts`,
  `kacheln/CockpitKacheln.test.tsx`, `kachelGroessen.test.ts`, `AnlagenPage.test.tsx`; E2E
  `cockpit-buehne`, `cockpit-rollen`, `laden-bei-bezug`, `summenwert-abnahme` (Rollen im Blatt),
  `layout-waechter`. Browserprüfung: `e2e/help.html?betrieb=eigen#/anlage/help-site` (Eigenverbrauch)
  bzw. ohne Parameter (Marktoptimierung), Uhr auf `2026-09-10T10:00:00Z`, `TZ=Europe/Berlin`. Bündel:
  Einstieg 210,6 kB gz (Grenze 230).
