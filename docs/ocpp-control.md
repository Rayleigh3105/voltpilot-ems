# OCPP-Steuerung: Einrichtung und Nachweise

Die Kunden-Box bleibt das lokale OCPP-1.6-Central-System. Das Portal speichert
Einstellungen und zeigt die Meldungen der Box. Ein Speichern beweist weder die
Übernahme noch die physische Wirkung an einer Säule.

## Kundenablauf

1. **Anlage → Komponenten → Ladepunkt → Steuerung & Grenzen** öffnen. Die Säule
   muss mit ihrer eingetragenen Kennung an der Box verbunden sein. Verbindung,
   Fähigkeiten, Schutzprofile, Messung und Rücklesung werden einzeln angezeigt.
2. Bei AC-Steuerung in Ampere **AC-Anschluss und Phasengrenzen** ausfüllen:
   bestätigte obere Betriebsspannung Phase–Neutralleiter, tatsächlich angeschlossene
   Netzphasen, maximaler Steckerstrom und das verfügbare Ladepark-Budget je Phase.
   Keine angenommene Spannung oder Phasenzahl. Alle betroffenen Säulen hängen an
   derselben Box; alle Stecker müssen beim Ändern frei und die Säulen verbunden sein.
3. **OCPP-Regelung freigeben**. Das gilt ausschließlich für OCPP. Der globale
   Steuerungsstopp bleibt wirksam. Ohne neue Einstellung gilt die bisherige
   Kombination der Box-Schalter weiter. Die Anzeige unterscheidet gespeichert,
   noch nicht übernommen und auf der Box freigegeben.
4. Optional unter **Ladekarten und Zugang** eine an der Säule gesichtete Karte
   freigeben und **Nur freigegebene Karten** wählen. Die Box entscheidet lokal,
   auch bei ausgefallener Cloud. Zurücknehmen einer Freigabe sperrt neue Vorgänge;
   ein laufender Vorgang wird dadurch nicht beendet. Fahrzeugprofile regeln weiterhin
   unabhängig Stromquelle und Priorität. Ohne Kartenmodus bleibt freies Laden erhalten.
5. Am gewählten Stecker eine **zeitlich begrenzte Ladegrenze** setzen. 0 kW
   pausiert. Die Grenze wirkt höchstens 24 Stunden und kann kein Anschluss-,
   Phasen-, Sicherheits- oder aktuell zugeteiltes Budget erhöhen.
6. Mit einem ladenden Fahrzeug die **beaufsichtigte Regelprüfung** anfordern:
   60 Sekunden begrenzen, 60 Sekunden pausieren, 60 Sekunden wieder laden.
   Die Prüfgrenze liegt zwischen Mindestladeleistung und aktueller Ausgangsleistung.
   Frische Leistung, passende Transaktion,
   angenommene Grenze und Rücklesung sind nötig. Die drei gemessenen Schritte,
   Modell, Firmware und Zeitpunkt bleiben im Ergebnis sichtbar. Fehlende Belege
   heißen „nicht vollständig nachgewiesen“, nicht „Säule defekt“.

Einrichtung, Freigabe und Änderungen benötigen Anlagenverwaltung (`site-admin`),
Mandantenverwaltung (`admin`) oder Plattformverwaltung mit gewähltem Mandanten.
Operatoren können den Zustand lesen. Die bestehenden betrieblichen OCPP-Aktionen
behalten ihre jeweiligen Berechtigungen.

## Durchsetzung auf der Box

- `ocpp_control` ist ein additives Feld im retained `v2/charging-config`-Dokument.
  Es wird mit monotoner Revision lokal gespeichert. Abwesend bewahrt den bisherigen
  Zustand. Gleiche Revision mit anderem Inhalt und ältere Revisionen werden abgelehnt.
- Schutz- und Live-Profile gehören dem Verteiler. Rohe `SetChargingProfile`,
  `ClearChargingProfile` und eingebettete Profile in `RemoteStartTransaction`
  werden an API und Box abgelehnt. Beim Einrichten werden fremde Tx-, Default-
  und Max-Profile unter einer temporären Nullgrenze abgeglichen.
- Ampere-Profile werden mit erklärter Spannung und Phasen auf 0,1 A abgerundet.
  Phasenbudgets werden konservativ und fest auf die erklärten Stecker aufgeteilt,
  einschließlich getrennter Säulen. Es gibt keine dynamische Umverteilung zwischen
  Phasen und keine Phasenumschaltung. Bei Änderungen bleiben neue Starts gesperrt,
  bis sämtliche Säulen die neuen Schutzprofile angenommen haben. Fehlende Angaben
  oder nicht bestätigbare Cache-Einstellungen verhindern die Freigabe.
- Autorisierungscaches und lokale Stationslisten dürfen die Entscheidung der Box
  nicht umgehen. Die relevanten Stationsschlüssel werden gesetzt und zurückgelesen.
  Im verwalteten Modus sperrt das Command Gateway Änderungen dieser Schlüssel und
  `SendLocalList`. Ohne Verbindung zur Box startet die Säule keinen ungeprüften Vorgang.
- Tx-Profile laufen spätestens nach 120 Sekunden ab; manuelle Ablaufzeit und
  Prüfschritt begrenzen diese Laufzeit zusätzlich auf OCPP-Sekundenauflösung. Danach
  gilt das hinterlegte Default-Profil. „Regelung abschalten“ ist kein RemoteStop.
- Leistung, Energie und SoC haben getrennte Messuhren. Historische, zukünftige und
  zurücklaufende Samples aktualisieren die Live-Regelung nicht. Das Protokolljournal
  bewahrt ihre ursprünglichen Zeitstempel. Auch Komponenten-Telemetrie verwendet die
  jeweilige Messuhr; eine Energiemeldung verjüngt keine alte Leistung.
- Aktive Sitzungen werden mit Transaktions-ID, Startzeit, Anfangszähler und
  Kartenpseudonym atomar gespeichert. Klartext-Karten werden nicht persistiert.
  Nach Neustart braucht die Sitzung eine frische passende Transaktionsmeldung.
  Wiederholte Starts behalten ihre ID; geschlossene Starts werden nicht neu eröffnet.
  Für einen neuen Vorgang braucht es unterscheidbare Startdaten, insbesondere bei
  Säulen mit Zeitstempeln auf ganze Sekunden.

## Cloud und Vertrag

`GET/PUT /api/v1/sites/{siteId}/ocpp/control` liefert `desired` sowie getrennte
`observed`-Meldungen je Box. PUT enthält die gelesene Revision; parallele Änderungen
liefern 409. Ein fremder Mandant erhält 404. Versand erfolgt erst nach DB-Commit;
bei Broker-Ausfall bleibt die Änderung gespeichert und muss erneut gesendet werden
(erneutes Speichern). Eine ältere Box bestätigt das neue Feld nicht und das Portal
zeigt diesen offenen Zustand.

Die Migration `V20260909000000` erweitert vorhandene Tabellen mit FORCE RLS.
Validierung ist durch `docs/contracts/v2/ocpp-control-vectors.json` zwischen Java und
Go festgehalten; Profil-Eigentümerschaft durch `ocpp-profile-ownership-vectors.json`.
Der Cloud-Herzschlag enthält den additiven `chargers.control_status`-Block.
Ein späterer Herzschlag ohne diesen Block erneuert keine alte Bestätigung.

## Prüfung und Auslieferung

Regressionsprüfungen umfassen echte Websocket-Kommunikation mit Teststationen,
Ampere-Rücklesung, Kartenfreigabe, Phasengrenzen, Wiederanlauf, Messuhren und
Regelungsnachweise. API-Tests nutzen TimescaleDB und Keycloak für Rollen und RLS.
Der Docker-freie Systemtest `edge-app/test/e2e-ocpp.sh` beendet den Core tatsächlich
und misst den selbstständigen Rückfall der simulierten Station. Portal-Browsertests
prüfen den Kundenablauf auf Desktop, Tablet und Mobilgerät.

Screenshots aus den Browsertests zeigen die echte React-Oberfläche mit Testdaten.
Sie belegen den Bedienablauf, keine Hardware-Kompatibilität. Die beaufsichtigte
Prüfung an einer physischen Säule je Modell/Firmware bleibt erforderlich.
Die Änderungen werden erst nach Auslieferung von API, Portal und einem neuen
Edge-Release auf Kundenanlagen aktiv.
