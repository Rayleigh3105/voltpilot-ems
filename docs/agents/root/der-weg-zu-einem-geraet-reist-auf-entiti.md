# Der WEG zu einem Gerät reist auf `/entities` (Anlagen-Zentrale Stufe 2, PR 2b)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 143).


Anlagen-Zentrale Stufe 2 PR 2b (Konzept `data/vp-anlagen-zentrale-konzept-h6`
§8.3). **Rein ADDITIV — keine Migration, keine Tabelle, kein Feld auf dem
Draht:** die sechs Verbindungsfelder liegen seit `V20260819000000` in
`entity_observed_state.edge_*`, geschrieben vom `EntityStatusListener`; gelesen
hat sie bis hierher NUR die Bestands-Übernahme.

- **Der behobene Befund ist der PFAD, nicht die Datenlage.** Die Flächen mussten
  ihre Adressen woanders zusammensuchen: die Geräteseite aus den gespeicherten
  Komponenten-Definitionen (`/components` — die es auf einer BOX-verwalteten
  Bestandsanlage gar nicht gibt, dort stand deshalb immer „Dieses Gerät meldet
  keine Verbindungsdaten"), die Register-Fläche aus `/register-write/targets`.
  Derselbe Inhalt, drei Pfade — und drei Pfade über dieselbe Adresse sind drei
  Gelegenheiten, sie verschieden zu nennen.
- **`LocalSetupDto` trägt sie jetzt:** `communication` · `family` · `host` ·
  `port` · `unitId` · `serial` · `intervalS`. Die Adresse wird aus dem
  gemeldeten `edge_connection`-Block gelesen, NICHT durchgereicht — der Block
  ist die `inverter.Connection` der Box mit Steuer-, Vorzeichen- und
  Skalen-Feldern, und davon gehört auf eine Kundenfläche genau nichts.
- **⚠ `unitId` ist EIN Feld für dieselbe Sache:** der Solarman-Weg nennt die
  Modbus-Adresse `mb_slave_id`, jeder andere `unit_id`. `serial` ist die
  Logger-Nummer des Solarman-Wegs — auf einer box-verwalteten Anlage liegt sie
  nirgendwo sonst vor, deshalb reist sie neben den sechs des Konzepts mit.
- **⚠ Die Ehrlichkeitsregel ist die von `EntityObservedRepository.EdgeLink`:**
  `null` heißt „diese Box meldet (noch) keine Verbindungen" — NIE „dieses Gerät
  hat keine". Ein älterer Box-Stand lässt die Felder weg, und daraus darf nur
  „Weg unbekannt" folgen, nie eine erfundene Adresse.
- **Portal:** `geraetSeite.verbindungsWeg` nimmt das gespeicherte SOLL, wo es
  vorliegt (auf einer portal-verwalteten Anlage ist es das Gepflegte), sonst das
  gemeldete IST — und ohne beides wird nichts behauptet. Das
  Struktur-Schaltbild beschriftet seine Kanten aus DEMSELBEN Lesepfad.
- **Beweise:** `PortalApiTest.localSetupCarriesTheReportedConnectionAndAnOlderBoxStandStaysNull`
  (echte DB, echter `EntityStatusListener`: Feld für Feld, `mb_slave_id` landet
  auf `unitId`, ein älterer Bericht liefert überall `null`) ·
  `geraetSeite.test.ts` (der box-verwaltete Weg, das führende Soll, der ehrliche
  Leer-Satz).

