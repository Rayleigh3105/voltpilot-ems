# Box-Übersicht je Standort

AP-06 IP-16 bündelt die vorhandenen Box-Fakten auf der Box-Seite; im `Standort › Aufbau` steht jede Box mit
dem, was an ihr hängt. Die frühere Seite `Standort › Boxen` ist darin aufgegangen, ihre Adresse leitet um; seit
GE-4 (Konzept „Ein Gerät, ein Eintrag", 23.10.2026) sagt die Box-Zeile dort „n Geräte · Last p %". Der Bereich
erscheint nur, wenn die Messfunktion des Standorts eingerichtet, angehalten oder aktiv ist;
ein Betriebskunde ohne Messfunktion behält nach O18 seine bisherige Standort-Navigation ohne neuen Reiter.
Die Fläche liest keine neue Route: `/api/v1/devices` kennzeichnet additiv die führende Box,
`/api/v1/sites/{siteId}/data-sources` liefert additiv die jüngste Quell-Rückmeldung aus
`device_data_source_status`, und die vorhandene Edge-Versionen-Antwort liefert den Software-Stand.

Bei mehreren Boxen wird nie die erste Listenzeile als führend geraten. `fuehrendeBoxOf` nimmt die
genau eine vom Server markierte Box; nur bei einer echten Ein-Box-Anlage bleibt der bisherige
Rückfall. Eine Datenquelle gehört auf der Oberfläche zu ihrer `zustaendige_box`. Fehlerklassen
werden über `uemsDatenquelle.fehlerklasse` in Kundenwörter übersetzt; eine Bestandsbox ohne
Quellblock bleibt „Box meldet noch nicht je Quelle“.

Der Software-Hinweis folgt der Fähigkeitstabelle `docs/contracts/v2/edge-capabilities.json` und
führt zur bestehenden Seite `edge-updates`. Die Ableitung liegt in `boxUebersicht.ts` (`quellZeile`: Titel ohne
doppeltes Kennzeichen, Weg aus Protokoll, Adresse und Geräte-IDs; `boxLast`: die Last einer Box), `aufbauBaum.ts`
und `boxSeite.ts`; ihre reine Abnahme steht in `boxUebersicht.test.ts`, die 375/1440-Abnahme in
`e2e/standort-ebenen.spec.ts` und `e2e/box-seite-geraete.spec.ts`.

GE-4: der Baustein „Geräte an dieser Box" (`boxGeraete.ts`) rechnet die Geräte über DIESELBE Kette wie der Aufbau
(`aufbauDerAnlage`: `plantModel` → `zentraleListe` → `aufbauBaum`, Weg → Gerät nur über `geraet.data_source_id`) —
kein zweites Zählen über `localSetup`. Je Gerät Anbindung und Last, Gateways mit ihren Geräten, Anschlüsse ohne
Gerät, darüber die Summe; die Bühne „x von y Geräten liefern Daten" zählt dieselben Geräte. Die Last
(max(Anfragen/30, Messwerte/600) über alle Wege mit dieser zuständigen Box, auch einer Nachbaranlage) rechnet nur
`boxLast` — Box-Seite und Box-Zeile im Aufbau rufen sie beide; nicht gemeldet heißt „Last nicht gemeldet", nie
„0 %". „Zuständige Box wechseln" steht an der Zeile, deren Weg es ist (beim Gateway für alle Geräte dahinter).

AP-06 IP-12 ergänzt auf derselben Box-Seite den bestätigten Quellenwechsel und den Box-Tausch.
`DatenquelleWechselDialog` prüft die Ziel-Box, plant auf die Minute, zeigt Budgetablehnungen und
Folgen vor dem Schreiben und nimmt einen noch nicht wirksamen Plan über dessen Zeitraum-Kennung
zurück. `AddDeviceDrawer` bleibt der einzige Claim-Weg; von „Box tauschen“ aus folgt nach dem
Claim eine zweite Folgen-Bestätigung für `POST …/succeed/…`. `zugestellt=false` heißt dort
„vorbereitet“, nie abgeschlossen. Steuerquellen zeigen nur den AP-15-Hinweis.
