package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.tuple;

import com.voltpilot.api.zugriff.SqlAnweisungen.Treffer;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * Architektur-Test des Standort-Zauns (UEMS AP-03 IP-5, §6.2 Punkt 4): keine Abfrage auf die Messdaten — die
 * Telemetrie-Hypertables und ihre Rollups — ohne {@code site}-Join oder begründeten Eintrag in {@link #LISTE}.
 *
 * <p>{@code site_scope} filtert {@code site} und die Tabellen, die ihre Anlage oder ihren Standort selbst tragen. Die
 * Messdaten tragen nur den Mandanten-Zaun. Wer sie über {@code site_id}, {@code device_id} oder eine Komponente liest,
 * ohne über {@code site} zu gehen, ist nur dicht, wenn vorher etwas die Anlage geprüft hat — genau das steht in der
 * Liste, mit einem Beleg, den der Test nachliest.
 *
 * <p>Die Liste zählt je Datei und Tabelle die Anweisungen ohne {@code site}. Eine NEUE Anweisung macht den Test rot,
 * bis sie über {@code site} geht oder mit Grund eingetragen ist; eine entfernte ebenfalls, damit die Liste nie mehr
 * erlaubt als nötig. Der Scanner steht in {@link SqlAnweisungen}; die Tests unten zeigen, woran er anschlägt.
 */
class SiteScopeArchitekturTest {

    private static final Path QUELLE = Path.of("src/main/java/com/voltpilot/api");
    private static final String ZAUN_GERAET = "db/migration/V20260915190000__uems_site_scope.sql";

    enum Grund {
        /** Der Einstieg prüft die Anlage vorher: {@link Geltungsbereich} oder ein Lesen über {@code site}, das 404 gibt. */
        ANLAGE_GEPRUEFT,
        /** Komponentenlose Ablesung: RechtPruefung löst den Standort der Messstelle auf. */
        MESSSTELLE_GEPRUEFT,
        /** Das Gerät kommt nur aus {@code device}, das {@code site_scope} trägt: ein fremdes Gerät ist nicht da. */
        UEBER_GERAET,
        /** Die Reihe kommt nur aus {@code measurement_point}, das {@code site_scope} trägt. */
        UEBER_MESSKOMPONENTE,
        /** Liest je Anlage des Kundenbereichs, die Antwort nimmt nur Anlagen aus {@code site}; Summen-Teilansicht: IP-10. */
        ZEIGT_NUR_SICHTBARE,
        /** Nur Takt, Läufer oder Hörer — ohne Anfrage, also ohne Zugriff. */
        OHNE_ANFRAGE,
        /** Nur {@code /api/v1/admin/**} (platform-admin). */
        PLATTFORM,
        /** Das Literal ist kein SQL (Topic, Vokabular). */
        KEIN_SQL,
        /** Bekannte Lücke mit Folgepaket; der Wegweiser nennt sie beim Dateinamen. */
        OFFEN
    }

    /**
     * @param datei relativ zu {@code com/voltpilot/api}
     * @param beleg die Datei, die den Grund trägt: Java relativ zu {@code com/voltpilot/api}, {@code db/…} unter
     *     {@code src/main/resources}, {@code docs/…} im Repository
     * @param pruefzeichen der Text, der dort stehen muss
     */
    record Erlaubt(String datei, String tabelle, int anzahl, Grund grund, String beleg, String pruefzeichen) {}

    static final List<Erlaubt> LISTE = List.of(
            // Ablesungen besitzen keine Anlage/Box; beide Schreibwege prüfen die Messstelle.
            new Erlaubt("uems/AblesungRepository.java", "device_measurement_sample", 1,
                    Grund.MESSSTELLE_GEPRUEFT, "web/AblesungController.java",
                    "rechte.pruefen(aktion,RechtZiel.MESSSTELLE,m.id()"),
            // --- Einstieg prüft die Anlage
            new Erlaubt("measurement/MeasurementHistoryService.java", "device_measurement_sample", 3,
                    Grund.ANLAGE_GEPRUEFT, "measurement/MeasurementHistoryService.java",
                    "geltungsbereich.requireSite(scope.siteId())"),
            new Erlaubt("measurement/MeasurementHistoryService.java", "device_measurement_rollup_5m", 1,
                    Grund.ANLAGE_GEPRUEFT, "measurement/MeasurementHistoryService.java",
                    "geltungsbereich.requireSite(scope.siteId())"),
            new Erlaubt("measurement/MeasurementHistoryService.java", "device_measurement_rollup_15m", 1,
                    Grund.ANLAGE_GEPRUEFT, "measurement/MeasurementHistoryService.java",
                    "geltungsbereich.requireSite(scope.siteId())"),
            new Erlaubt("uems/KanalbindungService.java", "device_measurement_sample", 1,
                    Grund.ANLAGE_GEPRUEFT, "uems/KanalbindungService.java",
                    "geltung.siteVisible(anlagen.getFirst())"),
            new Erlaubt("uems/KanalbindungService.java", "device_measurement_sample", 2,
                    Grund.ANLAGE_GEPRUEFT, "uems/KanalbindungService.java", "geltung.siteVisible(site)"),
            new Erlaubt("repo/HistoryRepository.java", "telemetry", 1, Grund.ANLAGE_GEPRUEFT,
                    "web/SiteController.java", "SiteDto site = sites.findById(siteId);"),
            new Erlaubt("repo/HistoryRepository.java", "telemetry_rollup_15m", 3, Grund.ANLAGE_GEPRUEFT,
                    "web/SiteController.java", "SiteDto site = sites.findById(siteId);"),
            new Erlaubt("repo/HistoryRepository.java", "telemetry_rollup_1h", 1, Grund.ANLAGE_GEPRUEFT,
                    "web/SiteController.java", "SiteDto site = sites.findById(siteId);"),
            new Erlaubt("repo/HistoryRepository.java", "telemetry_rollup_1d", 1, Grund.ANLAGE_GEPRUEFT,
                    "web/SiteController.java", "SiteDto site = sites.findById(siteId);"),
            new Erlaubt("repo/HistoryRepository.java", "telemetry_v2", 1, Grund.ANLAGE_GEPRUEFT,
                    "web/SiteController.java", "SiteDto site = sites.findById(siteId);"),
            new Erlaubt("repo/HistoryRepository.java", "telemetry_v2_rollup_15m", 1, Grund.ANLAGE_GEPRUEFT,
                    "web/SiteController.java", "SiteDto site = sites.findById(siteId);"),
            new Erlaubt("repo/TelemetryRepository.java", "telemetry", 1, Grund.ANLAGE_GEPRUEFT,
                    "web/SiteController.java", "geltungsbereich.requireSite(siteId);"),
            new Erlaubt("repo/ScheduleRepository.java", "telemetry", 1, Grund.ANLAGE_GEPRUEFT,
                    "web/SiteController.java", "geltungsbereich.requireSite(siteId);"),
            // Löschvorschau und Löschen der Anlage.
            new Erlaubt("repo/SeriesRepository.java", "telemetry", 2, Grund.ANLAGE_GEPRUEFT,
                    "web/SiteController.java", "geltungsbereich.requireSite(siteId);"),
            new Erlaubt("repo/SeriesRepository.java", "telemetry_rollup_15m", 1, Grund.ANLAGE_GEPRUEFT,
                    "web/SiteController.java", "geltungsbereich.requireSite(siteId);"),
            new Erlaubt("repo/SeriesRepository.java", "telemetry_rollup_1h", 1, Grund.ANLAGE_GEPRUEFT,
                    "web/SiteController.java", "geltungsbereich.requireSite(siteId);"),
            new Erlaubt("repo/SeriesRepository.java", "telemetry_rollup_1d", 1, Grund.ANLAGE_GEPRUEFT,
                    "web/SiteController.java", "geltungsbereich.requireSite(siteId);"),
            // Verlauf einer Komponente und Eigene Auswertung.
            new Erlaubt("repo/EntityHistoryRepository.java", "telemetry", 1, Grund.ANLAGE_GEPRUEFT,
                    "web/EntityController.java", "geltungsbereich.requireSite"),
            new Erlaubt("repo/EntityHistoryRepository.java", "telemetry_rollup_15m", 1, Grund.ANLAGE_GEPRUEFT,
                    "web/EntityController.java", "geltungsbereich.requireSite"),
            new Erlaubt("repo/EntityHistoryRepository.java", "telemetry_v2", 2, Grund.ANLAGE_GEPRUEFT,
                    "web/EntityController.java", "geltungsbereich.requireSite"),
            new Erlaubt("repo/EntityHistoryRepository.java", "telemetry_v2_rollup_1h", 1, Grund.ANLAGE_GEPRUEFT,
                    "web/EntityController.java", "geltungsbereich.requireSite"),
            new Erlaubt("repo/EntityHistoryRepository.java", "telemetry_v2_rollup_1d", 1, Grund.ANLAGE_GEPRUEFT,
                    "web/EntityController.java", "geltungsbereich.requireSite"),
            // Erlöse je Anlage (Speicher-Bank, Start-SoC).
            new Erlaubt("repo/EarningsRepository.java", "telemetry", 1, Grund.ANLAGE_GEPRUEFT,
                    "web/SiteEarningsController.java", "SiteDto site = sites.findById(siteId);"),
            new Erlaubt("repo/EarningsRepository.java", "telemetry_rollup_15m", 1, Grund.ANLAGE_GEPRUEFT,
                    "web/SiteEarningsController.java", "SiteDto site = sites.findById(siteId);"),
            // I/O-Modul (main #1202/8edb7c6da): Ausgangszahl und Ein-/Ausgangszustände je Modul DIESER Anlage;
            // beide Routen (consumer-options, io-modules/{id}/zustand) rufen vorher requireSite.
            new Erlaubt("consumers/ConsumerRepository.java", "telemetry_v2", 2, Grund.ANLAGE_GEPRUEFT,
                    "web/SiteConsumerController.java", "geltungsbereich.requireSite(siteId);"),

            // --- über Gerät oder Messkomponente, die selbst site_scope tragen
            // last_seen EINER Box: eine Hilfe lastSeen(alias) für alle vier Lesewege (main da0b6129f), v1- und
            // v2-Ankunft je device.id; das Gerät selbst trägt site_scope.
            new Erlaubt("repo/DeviceRepository.java", "telemetry", 1, Grund.UEBER_GERAET, ZAUN_GERAET,
                    "CREATE POLICY site_scope ON device"),
            new Erlaubt("repo/DeviceRepository.java", "telemetry_v2", 1, Grund.UEBER_GERAET, ZAUN_GERAET,
                    "CREATE POLICY site_scope ON device"),
            new Erlaubt("repo/OverviewRepository.java", "telemetry", 1, Grund.UEBER_GERAET, ZAUN_GERAET,
                    "CREATE POLICY site_scope ON device"),
            // Geräte-Daten löschen: das Gerät kommt aus devices.findById, danach die Rollups seiner Anlage.
            // Der Neuaufbau nach dem Löschen liest telemetry_anlage_15m(…, site) statt telemetry
            // (V20260922170000); geblieben sind die beiden DELETE.
            new Erlaubt("repo/SeriesRepository.java", "telemetry", 1, Grund.UEBER_GERAET, "web/DeviceController.java",
                    "devices.findById(deviceId)"),
            new Erlaubt("repo/SeriesRepository.java", "telemetry_rollup_15m", 3, Grund.UEBER_GERAET,
                    "web/DeviceController.java", "devices.findById(deviceId)"),
            new Erlaubt("repo/SeriesRepository.java", "telemetry_rollup_1h", 3, Grund.UEBER_GERAET,
                    "web/DeviceController.java", "devices.findById(deviceId)"),
            new Erlaubt("repo/SeriesRepository.java", "telemetry_rollup_1d", 2, Grund.UEBER_GERAET,
                    "web/DeviceController.java", "devices.findById(deviceId)"),
            new Erlaubt("measurement/SpeicherklasseHistorie.java", "device_measurement_sample", 1,
                    Grund.UEBER_MESSKOMPONENTE, "uems/MessstelleQuelleRepository.java", "measurement_point"),
            new Erlaubt("uems/MessstelleFormelWerteRepository.java", "device_measurement_sample", 2,
                    Grund.UEBER_MESSKOMPONENTE, "uems/MessstelleFormelWerteRepository.java", "FROM measurement_point mp"),
            new Erlaubt("uems/MessstelleFormelWerteRepository.java", "device_measurement_rollup_15m", 1,
                    Grund.UEBER_MESSKOMPONENTE, "uems/MessstelleFormelWerteRepository.java", "FROM measurement_point mp"),
            new Erlaubt("uems/QuelleAnteilWerte.java", "device_measurement_sample", 1, Grund.UEBER_MESSKOMPONENTE,
                    "uems/QuelleAnteilWerte.java", "measurement_point"),

            // --- liest je Anlage, zeigt nur sichtbare (Teilansicht der Summen: IP-10)
            new Erlaubt("repo/OverviewRepository.java", "telemetry_rollup_15m", 1, Grund.ZEIGT_NUR_SICHTBARE,
                    "web/OverviewController.java", "sites.findAll()"),
            // Zwei: Start-SoC und der Monatsanker des Vergleichsspeichers (main caf807de9, Tages-Einordnung) - je
            // Anlage gerechnet, die Antwort nimmt nur die Zeilen aus sites.findAll().
            new Erlaubt("repo/EarningsRepository.java", "telemetry_rollup_15m", 2, Grund.ZEIGT_NUR_SICHTBARE,
                    "web/EarningsController.java", "sites.findAll()"),
            // Zwei: latestValues (Bestand) und liveValues mit 30-s-Mittel (main 5f155b124, K8) - dieselben Aufrufer.
            new Erlaubt("topology/TopologyRepository.java", "telemetry_v2", 2, Grund.ZEIGT_NUR_SICHTBARE,
                    "web/OverviewController.java", "sites.findAll()"),

            // --- ohne Anfrage
            new Erlaubt("uems/LueckenMelder.java", "device_measurement_sample", 11, Grund.OHNE_ANFRAGE,
                    "uems/LueckenLaeufer.java", "@Scheduled"),
            new Erlaubt("uems/LueckenMelder.java", "telemetry", 3, Grund.OHNE_ANFRAGE, "uems/LueckenLaeufer.java",
                    "@Scheduled"),
            new Erlaubt("uems/SpaetankunftMelder.java", "device_measurement_sample", 2, Grund.OHNE_ANFRAGE,
                    "uems/ViertelstundeLaeufer.java", "@Scheduled"),
            new Erlaubt("uems/ViertelstundeVerdichter.java", "device_measurement_sample", 3, Grund.OHNE_ANFRAGE,
                    "uems/ViertelstundeLaeufer.java", "@Scheduled"),
            new Erlaubt("uems/KanalbindungLauf.java", "device_measurement_sample", 3, Grund.OHNE_ANFRAGE,
                    "uems/EndgueltigkeitLaeufer.java", "@Scheduled"),
            new Erlaubt("repo/FleetMetricsRepository.java", "telemetry", 1, Grund.OHNE_ANFRAGE,
                    "metrics/FleetMetricsCollector.java", "@Scheduled"),
            // AP-07 IP-16: systemweiter, taeglich gecachter Speicher-Waechter
            // ueber die BYPASSRLS-Admin-Rolle; nie in einem Kunden-Request.
            new Erlaubt("repo/DbHealthMetricsRepository.java", "device_measurement_sample", 1,
                    Grund.OHNE_ANFRAGE, "metrics/DbStorageMetricsCollector.java", "@Scheduled"),
            // Die Plan-Tabelle nennt die vier physischen Tabellen nur als Daten,
            // nicht als SQL; der Scanner erkennt ihren Text trotzdem.
            new Erlaubt("metrics/DbHealthMetrics.java", "device_measurement_sample", 1,
                    Grund.KEIN_SQL, "metrics/DbHealthMetrics.java", "STORAGE_PLAN"),
            new Erlaubt("repo/ConsumerRequirementStateRepository.java", "telemetry_v2", 1, Grund.OHNE_ANFRAGE,
                    "consumers/ConsumerRuntimeStatusListener.java", "client.subscribe(STATUS_FILTER"),

            // --- Plattform
            // boxes() und deviceStatsPerSite(): ausschließlich der plattformweiten Admin-Flotte
            // übergeben; der Controller trägt den belegten platform-admin-Zaun.
            new Erlaubt("repo/AdminFleetRepository.java", "telemetry", 2, Grund.PLATTFORM,
                    "web/AdminFleetController.java", "@PreAuthorize(\"hasRole('platform-admin')\")"),
            // AP-15 IP-21: der Netzpunkt der führenden Box beim Auslösen der Sprungprobe (nur /admin) und beim
            // Auswerten des Box-Berichts (MQTT-Hörer, ohne Anfrage); die Probe gehört zu Verbund und Anlage.
            new Erlaubt("uems/SprungprobeRepository.java", "telemetry", 1, Grund.PLATTFORM,
                    "web/AdminGemeinsameSteuerungController.java", "@PreAuthorize(\"hasRole('platform-admin')\")"),
            new Erlaubt("uems/SprungprobeRepository.java", "telemetry", 1, Grund.OHNE_ANFRAGE,
                    "uems/SprungprobeBerichtListener.java", "IMqttMessageListener"),
            new Erlaubt("repo/AdminFleetRepository.java", "telemetry_rollup_15m", 2, Grund.PLATTFORM,
                    "web/AdminFleetController.java", "@PreAuthorize(\"hasRole('platform-admin')\")"),
            new Erlaubt("repo/TenantRepository.java", "telemetry", 1, Grund.PLATTFORM, "web/AdminController.java",
                    "hasRole('platform-admin')"),
            new Erlaubt("repo/TenantRepository.java", "telemetry_rollup_15m", 1, Grund.PLATTFORM,
                    "web/AdminController.java", "hasRole('platform-admin')"),
            new Erlaubt("repo/TenantRepository.java", "telemetry_rollup_1h", 1, Grund.PLATTFORM,
                    "web/AdminController.java", "hasRole('platform-admin')"),
            new Erlaubt("repo/TenantRepository.java", "telemetry_rollup_1d", 1, Grund.PLATTFORM,
                    "web/AdminController.java", "hasRole('platform-admin')"),

            // --- kein SQL
            new Erlaubt("uems/EreignisVokabular.java", "telemetry", 1, Grund.KEIN_SQL, "uems/EreignisVokabular.java",
                    "STROM = List.of(\"telemetry\""),
            new Erlaubt("consumers/LoadResidualReplanListener.java", "telemetry", 1, Grund.KEIN_SQL,
                    "consumers/LoadResidualReplanListener.java", "\"telemetry\".equals(parts[4])"),
            // AP-20 IP-17: das Literal ordnet eine Tabelle ihrer Objektart (Ordner) zu. Gelesen wird über den Katalog
            // (Tabellenname aus pg_class, für den Scanner unsichtbar) und nur vom Kundenadministrator — unternehmensweit,
            // der Standort-Zaun hat für ihn nichts zu filtern; jede andere Person bekommt vorher 403.
            new Erlaubt("kundenbereich/Gesamtabzug.java", "telemetry", 1, Grund.KEIN_SQL,
                    "web/UnternehmenAbzugController.java", "if (!KundenbereichEndeFilter.kundenadministrator(z)"));

    @Test
    void keineAbfrageAufMessdatenOhneSiteOderBegruendetenEintrag() throws IOException {
        Map<String, List<String>> ist = new TreeMap<>();
        try (Stream<Path> dateien = Files.walk(QUELLE)) {
            for (Path p : dateien.filter(x -> x.toString().endsWith(".java")).sorted().toList()) {
                String datei = QUELLE.relativize(p).toString().replace('\\', '/');
                for (Treffer t : SqlAnweisungen.treffer(Files.readString(p))) {
                    ist.computeIfAbsent(datei + " " + t.tabelle(), k -> new ArrayList<>())
                            .add("Zeile " + t.zeile() + ": " + t.auszug());
                }
            }
        }
        Map<String, Integer> soll = new TreeMap<>();
        LISTE.forEach(e -> soll.merge(e.datei() + " " + e.tabelle(), e.anzahl(), Integer::sum));

        List<String> fehler = new ArrayList<>();
        for (String k : ist.keySet()) {
            int gefunden = ist.get(k).size();
            int erlaubt = soll.getOrDefault(k, 0);
            if (gefunden > erlaubt) {
                fehler.add("Abfrage auf Messdaten ohne site: " + k + " (" + gefunden + ", erlaubt " + erlaubt
                        + ") — über site joinen, vorher Geltungsbereich.requireSite rufen und in LISTE begründen\n    "
                        + String.join("\n    ", ist.get(k)));
            }
        }
        soll.forEach((k, erlaubt) -> {
            int gefunden = ist.getOrDefault(k, List.of()).size();
            if (gefunden < erlaubt) {
                fehler.add("LISTE veraltet: " + k + " erlaubt " + erlaubt + ", gefunden " + gefunden);
            }
        });
        System.out.printf("Standort-Zaun: %d Anweisungen auf Messdaten ohne site in %d Datei/Tabelle-Paaren, "
                + "%d Einträge in der Liste%n", ist.values().stream().mapToInt(List::size).sum(), ist.size(), LISTE.size());
        assertThat(fehler).isEmpty();
    }

    @Test
    void jederEintragBelegtSeinenGrund() throws IOException {
        for (Erlaubt e : LISTE) {
            Path beleg = aufloesen(e.beleg());
            assertThat(beleg).as(e.toString()).exists();
            assertThat(Files.readString(beleg)).as(e.datei() + " → " + e.beleg()).contains(e.pruefzeichen());
            assertThat(e.anzahl()).as(e.toString()).isPositive();
            if (e.grund() == Grund.OFFEN) {
                assertThat(e.beleg()).as("eine offene Lücke steht im Wegweiser").startsWith("docs/");
            }
        }
    }

    /**
     * Die Aufhebung des Standort-Zauns bleibt die Ausnahme: genau diese Dateien rufen sie.
     *
     * <p>Beide geben daraus nichts Unsichtbares aus: die Selbstauskunft rechnet die Sichtbarkeit selbst nach
     * dem Rechte-Vertrag, und {@code TeilansichtDienst} liest ausschließlich eine KARDINALZAHL — wie viele
     * Standorte der Kundenbereich hat (AP-03 IP-10). Beide halten die Aufhebung in einer eigenen Transaktion,
     * damit sie mit der Abfrage endet.
     */
    @Test
    void denGanzenKundenbereichLesenNurZweiStellen() throws IOException {
        List<String> aufrufer = new ArrayList<>();
        try (Stream<Path> dateien = Files.walk(QUELLE)) {
            for (Path p : dateien.filter(x -> x.toString().endsWith(".java")).sorted().toList()) {
                String datei = QUELLE.relativize(p).toString().replace('\\', '/');
                if (!datei.equals("zugriff/Geltungsbereich.java")
                        && Files.readString(p).contains("ganzenKundenbereichLesen(")) {
                    aufrufer.add(datei);
                }
            }
        }
        assertThat(aufrufer).containsExactly("zugriff/Selbstauskunft.java", "zugriff/TeilansichtDienst.java");
    }

    @Test
    void kennzahlenBerichteUndExporteFuehrenZumSelbenPruefpunkt() throws IOException {
        for (String dienst : List.of("uems/KennzahlService.java", "uems/BerichtService.java", "uems/BestandGeraeteCsv.java")) {
            assertThat(Files.readString(QUELLE.resolve(dienst))).as(dienst).contains("Geltungsbereich.requireScope(");
        }
        assertThat(Files.readString(QUELLE.resolve("uems/KennzahlWerteService.java")))
                .contains("kennzahlen.eine(id)", "kennzahlen.fassungen(id)");
        assertThat(Files.readString(QUELLE.resolve("cockpit/EigeneAuswertungService.java")))
                .contains("geltungsbereich.requireSite(siteId)");
        assertThat(Files.readString(QUELLE.resolve("measurement/MeasurementHistoryService.java")))
                .contains("geltungsbereich.requireSite(scope.siteId())", "geltungsbereich.requireSite(siteId)");
    }

    // ------------------------------------------------------------------ woran der Scanner anschlägt

    @Test
    void eineAbfrageOhneSiteWirdGefunden() {
        String quelle = """
                class A {
                    List<X> werte(UUID site) {
                        return jdbc.query("SELECT time, pv_kw FROM telemetry WHERE site_id = ? ORDER BY time", M, site);
                    }
                }
                """;
        assertThat(SqlAnweisungen.treffer(quelle)).extracting(Treffer::zeile, Treffer::tabelle)
                .containsExactly(tuple(3, "telemetry"));
    }

    @Test
    void nurEinJoinUeberSiteSelbstMachtDieAbfrageDicht() {
        assertThat(tabellen("jdbc.query(\"SELECT r.pv_kwh FROM telemetry_rollup_15m r JOIN site s ON s.id = r.site_id\");"))
                .isEmpty();
        assertThat(tabellen("jdbc.query(\"SELECT 1 FROM device_measurement_sample d WHERE EXISTS "
                + "(SELECT 1 FROM site WHERE id = d.site_id)\");")).isEmpty();
        assertThat(tabellen("jdbc.query(\"SELECT 1 FROM telemetry t JOIN site_plan_run p ON p.site_id = t.site_id\");"))
                .containsExactly("telemetry");
        assertThat(tabellen("jdbc.query(\"SELECT 1 FROM telemetry_v2 t -- JOIN site s\\n WHERE t.site_id = ?\");"))
                .containsExactly("telemetry_v2");
        assertThat(tabellen("jdbc.update(\"DELETE FROM device_measurement_rollup_5m WHERE device_id = ?\");"))
                .containsExactly("device_measurement_rollup_5m");
    }

    @Test
    void konstantenUndTextbloeckeWerdenAnIhrerVerwendungGeprueft() {
        String quelle = """
                class B {
                    private static final String AUS_ROLLUP = "FROM device_measurement_rollup_15m r ";
                    private static final String MIT_SITE = "JOIN site s ON s.id = r.site_id ";
                    List<X> offen() { return jdbc.query("SELECT r.value " + AUS_ROLLUP + "WHERE r.site_id = ?", M); }
                    List<X> dicht() { return jdbc.query("SELECT r.value " + AUS_ROLLUP + MIT_SITE, M); }
                    List<X> block() {
                        return jdbc.query(\"""
                                SELECT s.value
                                  FROM device_measurement_sample s
                                 WHERE s.entity_id = ?
                                \""", M);
                    }
                }
                """;
        assertThat(SqlAnweisungen.treffer(quelle)).extracting(Treffer::zeile, Treffer::tabelle)
                .containsExactly(tuple(4, "device_measurement_rollup_15m"), tuple(7, "device_measurement_sample"));
    }

    @Test
    void einTabellennameAlsTextZaehltAuchOhneFrom() {
        assertThat(tabellen("String tabelle = grob ? \"telemetry_rollup_1h\" : \"telemetry_rollup_15m\";"))
                .containsExactlyInAnyOrder("telemetry_rollup_1h", "telemetry_rollup_15m");
        assertThat(tabellen("log.info(\"telemetry_rollup_15m neu gerechnet\");")).isEmpty();
    }

    @Test
    void javaKommentareZaehlenNicht() {
        assertThat(tabellen("// jdbc.query(\"SELECT 1 FROM telemetry\");\n/* SELECT 1 FROM telemetry_v2 */ int x = 1;"))
                .isEmpty();
    }

    private static List<String> tabellen(String quelle) {
        return SqlAnweisungen.treffer(quelle).stream().map(Treffer::tabelle).toList();
    }

    private static Path aufloesen(String beleg) {
        if (beleg.startsWith("docs/")) {
            return Path.of("../..").resolve(beleg);
        }
        if (beleg.startsWith("db/")) {
            return Path.of("src/main/resources").resolve(beleg);
        }
        return QUELLE.resolve(beleg);
    }
}
