# Kern-Kanal und Katalogpunkt am selben Register (AP-07 IP-17)

`catalog/measurement-points/core-channel-mirrors.json` enthält nur geprüfte direkte Registerpaare.
Familie und Komponententyp schränken die Zuordnung ein; Register/Selektor kommen aus dem Katalog,
der Decoder-Fingerabdruck hält die Gegenprüfung am Kern-Leser fest. Prüf-/Packwerkzeug:
`python3 catalog/measurement-points/tools/check_core_mirrors.py` (`--write` aktualisiert die
Cloud-Writer-Kopie). Die Daten gehören nicht zu `EDGE_FIELDS` oder zur Box-Konfiguration.

## Schreiben und Identität

`KernSpiegelNachschlag` prüft dieselbe Komponente, denselben Mandanten/Anlagenkontext und die
zur **Messzeit** gültige Auswahl an der lesenden Box. Ein aktiver Katalogpunkt genügt nur mit
genau einem belegten Registerpaar. Eine Auswahl ohne Komponente oder ein alter Publisher-Merge
mehrerer Komponenten ist kein Identitätsbeweis. Niemals anhand von Host/Port/Unit-ID zuordnen.
Eine beendete Auswahl zählt für Nachlieferungen davor; die Endgrenze selbst ist ausgeschlossen.
Der zweite Weg muss bereits bestätigt sein (`applied_at` oder eine bestätigte Auswahlfassung
derselben Aktivierung); ein bloßer Auftrag an die Box reicht nicht. Kein Treffer oder mehrere
Treffer lassen die Kennzeichnung leer.
Eigene und zertifizierte Vorlagen können andere Kanäle definieren; für sie wird aus einem
bekannten Familiennamen allein kein Kernspiegel abgeleitet.

`TelemetryV2WriteRepository` annotiert den Kernwert mit `role='spiegel'` und
`spiegel_point_key`. Beide Schreibaufrufer (v2-Umschlag und v1-`ComposedEntityFanout`) gehen durch
dasselbe `insertRow`. Der Wert, seine Idempotenz, RLS und die Ausgebaut-/Purge-Sperre bleiben.
Ein fehlgeschlagener Nachschlag rollt auf seinen Savepoint zurück, zählt
`voltpilot_writer_kern_spiegel_total{ergebnis="fehler"}` und lässt den Kernwert ohne neue Aussage
schreiben. Die Katalogwerte und ihre Herkunft aus IP-7 werden nicht umetikettiert.

`V20260917111000` ergänzt nur zwei leere Spalten samt CHECK an `telemetry_v2`; keine
Bestandsumschreibung, Vorgabe, neue Tabelle oder Änderung einer Rollup-Prozedur. Tabellenweite
Rechte und FORCE RLS gelten weiter. Der Writer-Testspiegel steht in `writer-schema.sql`.

## Führende Quellen und Bestand

Der Filter **an der führenden Quellenbindung** bleibt: `MessstelleWerteService.fuehrend`
wählt die Hauptgröße mit `messstelle_quelle.rolle='fuehrend'`. BilanzService, KennzahlEingangLeser
und BerichtAbzugBildung lesen diesen Weg. AP-08 verdichtet ausschließlich Katalogreihen;
Kernwerte werden dort auch vor IP-17 nicht zusätzlich eingerechnet. Es gibt keine rückwirkende
Zahlenkorrektur. Die betrieblichen Kern-Rollups/Cockpit-Leser behalten ihre Werte.

**Kein pauschales `device_measurement_sample.role='fuehrend'`.** IP-6 ließ eindeutige Altwerte
bewusst mit NULL-Rolle stehen. Die bestehende Nicht-Spiegel-Spur dient auch der Beobachtungs-
und Vergleichshistorie. Die IP-17-Bestandsprobe in `UemsViertelstundeMengeTest` hält deshalb
16 eindeutige NULL-Rollenwerte ohne Kernweg bei 36,000 kWh; A10 hält die Katalogverdichtung bei
1 000 W samt Qualitätszählern bytegleich, wenn der entsprechende 1-kW-Kernspiegel hinzukommt.
Ohne ausdrückliche Integrationsbindung wird daraus keine Energiemenge erfunden.

Weitere Rohleser: MessstelleRegisterRepository (letzter Wert), MessstelleFormelWerteRepository
(Katalog live/15-min-Rollup), QuelleAnteilWerte, SpaetankunftMelder, KanalbindungService/-Lauf,
LueckenMelder und SpeicherklasseHistorie. Sie bekommen mit diesem Paket keinen schärferen Filter.

## Grenzen und Nachweise

- Belegte Paare: Deye hybrid_1p Netz/Last, Kostal Netz, Fronius Solar API Netz sowie
  SunSpec 211/212/213 Wirkleistung. Ohne passende Registry-Familie und Komponente keine Aussage.
- Deye hybrid_3p wechselt zwischen verschiedenen Netzregistern; SoC kann geschätzt sein,
  Batterie-/PV-Leistung kann aus mehreren Registern berechnet sein. Solche Kanäle werden
  ausdrücklich nicht pauschal einer ähnlich benannten Kataloggröße zugeordnet.
- `KernSpiegelTest`: beide Writer-Wege, Wiederholung, Messzeit/Endgrenze, Modell/Kanal,
  Komponenten-/Mandantentrennung und Savepoint-Fehler. `WriterPipeTest` hält IP-7 und den
  bisherigen Kafka-Weg; die sechs AP-08-Migrationsnachbarn schützen die vorhandenen Daten.
- `generate.py --check`, `package_edge_runtime.py --check`, Katalogtests und
  `check_core_mirrors.py` sichern die Cloud-Grenze. Kein Hardware-Nachweis wird behauptet.
