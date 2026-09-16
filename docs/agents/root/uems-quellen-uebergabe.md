# UEMS: geplante Quellenübergabe (AP-06 IP-7)

`UebergabeLaeufer` fragt `UebergabeAufgaben` nach fälligen Anlagen und ruft mit injizierbarer
Uhr den bestehenden Registry-Dienst unter dem jeweiligen Mandanten auf. Alle Aufrufer von
`EntityRegistryService.pushRegistryBestEffort` gehen bei Datenquellen durch `QuellenUebergabe`.
Der Bestandsweg ohne Datenquellen bleibt unverändert. Ein Transaktions-Advisory-Lock je Anlage
verhindert gleichzeitige Zustellungen durch mehrere API-Instanzen. Ein Entzug muss committed
sein, bevor eine weitere Zustellung freigibt (`written_xid`-Prüfung): auch zwei Pushes innerhalb einer
später zurückgerollten Fachtransaktion können deshalb keinen zweiten Leser einschalten.
Quellen-Pushes bekommen `uems-registry:<sequence>` aus `data_source_registry_revision_seq`
statt der Wanduhr. `nextval` wird auch bei Rollback verbraucht: keine Wiederverwendung, kein
scheinbar neuerer Altstand bei versetzten Cloud-Uhren. Die Box quittiert die bereits vertraglich
opake Kennung; `published_at` und der Bestandsweg ohne Datenquellen bleiben unverändert.

## Ausführung und Plan

`data_source_handover` hält den Ausführungsstand je Quelle; die halboffenen Planzeiträume bleiben
unverändert. `pending` lässt die alte Box weiter lesen, bis die Zielbox frisch gemeldet hat
(300 s, nur nicht ausgebaute Boxen derselben Anlage). `removing` nimmt die Quelle aus ALLEN
Vollmengen. Erst die Quittung einer erfolgreich versandten Entzugsfassung erlaubt `receiving`
mit der Quelle allein an der neuen Box. Deren Quittung schließt ab. Ein fehlgeschlagener Publish,
eine alte Fassung, Schweigen, `held` oder `refused` geben die neue Box nicht frei.

`data_source_box_receipt` speichert auch leere Registry-Herzschläge. Vorrang hat die angewandte
Fassung aus `device_component_apply`; ältere Boxen quittieren mit `entities.revision` in ihrer
Herzschlag-Kadenz. **15 Sekunden ohne Rückmeldung sind kein Beleg eines Entzugs.** Bei fehlender
Quittung bleibt die Übergabe ausstehend; die normale A3-Lücke ist im Fake unter einem Quellentakt
(60 s). Ein späterer Push derselben Phase darf die Entzugsfassung überholen, ohne die Freigabe
verhungern zu lassen. Ohne bisherigen Ausführungsstand nach einem bereits geplanten Wechsel
(`reconciling`) werden alle möglichen bisherigen Leser geleert und quittiert, auch nach mehreren
vergangenen Zeiträumen mit einer dritten Box: niemals blind den früheren
Leser wieder einschalten. Neustarts behalten die Phase in der Datenbank.
Nachweislich ausgebaute historische Boxen brauchen keine neue Quittung; fehlende oder durch
RLS unsichtbare Boxen gelten dagegen weiterhin als unbestätigt.

`GET …/data-sources` trägt additiv `uebergabe {zustand, seit, box_alt, box_neu}` mit
„Übergabe ausstehend“; `zustaendige_box` bleibt die geplante Zuständigkeit. `handover` mit
`anlass=uebergabe`, `box_alt`, `box_neu` und Datenquelle geht durch das bestehende
`MessreiheEreignisRepository`: offen ab erfolgreicher Entzugszustellung, geschlossen durch
Fortschreibung nach der Zielquittung. `von` liegt vertragsgemäß auf der Minute; die interne
Ausführungszeit bleibt präzise. Kein neues Ereigniswort. Markerfehler: Savepoint, Log, Zähler;
Herzschlag-Zusatz: eigene Transaktion, Log, Zähler. Beide Zusätze beschädigen den Bestand nicht.

## Gate und Grenzen

**Das anlagenübergreifende Gate bleibt geschlossen.** AP-07 IP-6/IP-7 gibt der Reihe zwar eine
Komponente, aber `timescale-writer/MeasurementWriteRepository` schreibt `site_id` weiterhin aus
`event.site_id()`. `HerkunftNachschlag.Reihe` hat keine Anlage aus der Entität und schlägt die
Auswahl weiter je Box nach. Der anlagenfremde A3-Test ist deshalb mit diesem Grund `@Disabled`;
ein aktiver Test beweist die Sperre. Die Abnahme innerhalb einer Anlage benutzt ausdrücklich eine
Lese-Box derselben Heimat. AP-06 IP-8 (Mess-Selektion/Einmal-Aufträge), IP-12 (Dialoge) und
IP-19 (Nachfolger) bleiben eigene Pakete. Der Writer bewertet weiterhin den PLAN-Zeitraum:
Werte der alten Box während einer aufgeschobenen Übergabe können deshalb als Spiegel gelten;
IP-7 ändert weder Writer noch Mess-Selektion oder Herkunftsverträge.

## UEMS-Schalter / Zusammenführungs-Liste

| Schalter | Produktion | Tests | Wirkung |
|---|---|---|---|
| `voltpilot.uems.uebergabe.enabled` / `VOLTPILOT_UEMS_UEBERGABE_ENABLED` | AN | AUS in surefire | nur Zeitgeber und Scheduling-Konfiguration; das gemeinsame Push-Tor und die Antwort bleiben aktiv |
| `…interval-ms` / `VOLTPILOT_UEMS_UEBERGABE_INTERVAL_MS` | 1000 | manuell | Prüfintervall, keine erfundene Quittung |
| `…initial-delay-ms` / `VOLTPILOT_UEMS_UEBERGABE_INITIAL_DELAY_MS` | 30000 | manuell | Startverzögerung |

`UebergabeWiringTest` prüft beide Stellungen und die ausgelieferten Dateien. GitOps-Produktion
`mamotec/gitops` wurde bei `1fa223bb9760fedfc4638757fa5d6513012ccaa5` geprüft: kein Override
dieses neuen Schalters; `base/api/api.env` aktiviert den Entitäts-Status-Listener. Wirkt mit dem
nächsten Cloud-Deploy, kein Edge-Release. Das ist ein Zeitgeber-Schalter, kein vollständiger
UEMS-Auslieferungsschalter (Zusammenführungs-Checkliste Punkt 1/2).

## Migration und Prüfungen

`V20260916170000`: zwei anfangs leere Tabellen, FORCE RLS und SELECT/INSERT/UPDATE für die App;
die Revisionssequenz hat einen eigenen USAGE-Grant.
Nur tenant-CASCADE: Offboarding räumt sie mit dem Mandanten ab; keine neue Einschränkung an
Quellen-, Geräte- oder Anlagen-Löschwegen. Keine Bestandszeile und kein Migrationsspiegel geändert.
Beweise: `UemsQuellenUebergabeTest` (Fake-Uhr A3 hin/zurück, MQTT-Fake nach jedem Push,
Ausfälle, Neustart, Upgrade, Fremdanlagen-Gate, RLS, Savepoint, Parallelität, versetzte Uhren),
`RegistryPushJeBoxApiTest` (TimescaleDB + echter MQTT-Broker), `EntityStatusListenerTest`,
`UebergabeWiringTest`, `DatenquelleSchnittstelleVertragTest` und die sechs Migrations-Nachbarn.
