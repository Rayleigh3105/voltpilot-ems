# „Verbunden“ je Box

AP-06 IP-15 trennt die Verbindung einer Box von v1-Anlagen-Telemetrie. Der bereits ausgelieferte
`DataSourceStatusListener` validiert jeden Status-Herzschlag über Topic, Payload und RLS und setzt
danach `device.device_status_seen_at` auf die Cloud-Ankunft. Ein fehlender `data_sources[]`-Block
hindert dieses Lebenszeichen nicht; dadurch ist auch eine reine Lese-Box ohne v1-Telemetrie
verbunden.

`DeviceRepository`, `OverviewRepository` und `AdminFleetRepository` lesen denselben Anker. Das
Fenster bleibt fünf Minuten: zwei 15-Sekunden-Takte wären kürzer, deshalb greift die bestehende
Mindesttoleranz. Für eine Bestandsbox mit noch leerer neuer Spalte gilt bis zu ihrem ersten
Status-Herzschlag der bisherige Beleg `max(telemetry.received_at)`; danach entscheidet nur noch der
Status-Herzschlag. So bleibt der Ein-Box-Bestand unverändert, ohne eine Lese-Box auf Telemetrie zu
verpflichten.

Im Portal bleibt der Ein-Box-Wortlaut bestehen. Ab zwei Boxen zeigt `healthChecklist` in jedem
Zustand „n von m Boxen verbunden“; fehlend bleibt von null verschieden.
