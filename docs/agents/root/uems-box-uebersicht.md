# Box-Übersicht je Standort

AP-06 IP-16 bündelt die vorhandenen Box-Fakten auf `Standort › Boxen` und auf der Box-Seite.
Die Fläche liest keine neue Route: `/api/v1/devices` kennzeichnet additiv die führende Box,
`/api/v1/sites/{siteId}/data-sources` liefert additiv die jüngste Quell-Rückmeldung aus
`device_data_source_status`, und die vorhandene Edge-Versionen-Antwort liefert den Software-Stand.

Bei mehreren Boxen wird nie die erste Listenzeile als führend geraten. `fuehrendeBoxOf` nimmt die
genau eine vom Server markierte Box; nur bei einer echten Ein-Box-Anlage bleibt der bisherige
Rückfall. Eine Datenquelle gehört auf der Oberfläche zu ihrer `zustaendige_box`. Fehlerklassen
werden über `uemsDatenquelle.fehlerklasse` in Kundenwörter übersetzt; eine Bestandsbox ohne
Quellblock bleibt „Box meldet noch nicht je Quelle“.

Der Software-Hinweis folgt der Fähigkeitstabelle `docs/contracts/v2/edge-capabilities.json` und
führt zur bestehenden Seite `edge-updates`. Die neue Fläche liegt in `boxUebersicht.ts`,
`pages/StandortBoxenPage.tsx` und `boxSeite.ts`; ihre reine Abnahme steht in
`boxUebersicht.test.ts`, die 375/1440-Abnahme in `e2e/standort-ebenen.spec.ts`.

AP-06 IP-12 ergänzt auf derselben Box-Seite den bestätigten Quellenwechsel und den Box-Tausch.
`DatenquelleWechselDialog` prüft die Ziel-Box, plant auf die Minute, zeigt Budgetablehnungen und
Folgen vor dem Schreiben und nimmt einen noch nicht wirksamen Plan über dessen Zeitraum-Kennung
zurück. `AddDeviceDrawer` bleibt der einzige Claim-Weg; von „Box tauschen“ aus folgt nach dem
Claim eine zweite Folgen-Bestätigung für `POST …/succeed/…`. `zugestellt=false` heißt dort
„vorbereitet“, nie abgeschlossen. Steuerquellen zeigen nur den AP-15-Hinweis.
