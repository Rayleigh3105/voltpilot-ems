package com.voltpilot.api.uems;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * AP-14 IP-1: die drei Betriebsabfrage-Blätter unter {@code tools/betriebsabfragen/} gegen
 * Wegwerf-Datenbanken — das Vorher-Blatt gegen GENAU den Migrationssatz von {@code main}
 * ({@code migration/main-migrations.txt}), Nachher- und Pilot-Blatt gegen den vollen Satz von
 * {@code uems}. Die Blätter werden aus den Dateien GELESEN, nie in den Test kopiert: eine Quelle.
 *
 * <p>Geprüft wird, was der Betreiber am Tag des Ausrollens braucht: jede Abfrage LÄUFT, keine
 * schreibt ({@code READ ONLY} erzwingt es), die Ergebnisform je Abfrage ist in
 * {@code betriebsabfragen/ergebnisformen.txt} festgehalten — eine spätere Migration, die eine
 * Abfrage bricht, macht diesen Test rot —, und Teil A–C des Vorher-Blatts tragen KEINE Kennung,
 * damit der Betreiber sie herausgeben kann. Ohne Docker übersprungen.
 */
@Testcontainers(disabledWithoutDocker = true)
class BetriebsabfragenBlaetterTest {

    private static final Path ORDNER = Path.of("..", "..", "tools", "betriebsabfragen");
    private static final Path FORMEN = Path.of("src", "test", "resources", "betriebsabfragen",
            "ergebnisformen.txt");

    private static final String VORHER = "bestand-vor-uems.sql";
    private static final String NACHHER = "bestand-nach-rollout.sql";
    private static final String PILOT = "pilot-tagesblick.sql";

    /** Die Kennung einer Abfrage steht am Anfang ihres Kommentarblocks: {@code -- Q01 · FRAGE: …}. */
    private static final Pattern KENNUNG = Pattern.compile("^--\\s+(Q\\d{2}|Z\\d{2}|T\\d{2}[a-z]?)\\s+\\u00b7");
    private static final Pattern TEIL = Pattern.compile("^--\\s+TEIL\\s+([A-D])\\b");
    /** Eine Kennung in der Ergebnisform: Personen- und Gerätekennung, nicht eine Zahl. */
    private static final Pattern KENNUNG_IN_SPALTE = Pattern.compile(
            "(^|_)(id|ids|name|names|serial|seriennummer|referenz|ref|sub|email|mail|adresse|"
                    + "anschrift|telefon|kennung)($|_)", Pattern.CASE_INSENSITIVE);

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("uems")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw")
            .withCommand("postgres", "-c", "timescaledb.max_background_workers=0");

    @TempDir
    static Path mainSatzOrdner;

    /** Die Kundenbereiche der Entwicklungs-Saat — im Pilot-Blatt die „Betreiber-Liste“. */
    private static String betreiberListe;

    @BeforeAll
    static void zweiWegwerfDatenbanken() throws Exception {
        // (1) `uems`: der volle Satz plus die vorhandene Entwicklungs-Saat (db/dev), damit keine
        //     Abfrage nur auf leeren Tabellen „läuft“.
        flyway("uems").locations("classpath:db/migration", "classpath:db/dev").load().migrate();

        // (2) `bestand_main`: GENAU die 168 Migrationen, die heute in Produktion stehen.
        try (Connection c = verbindung("uems"); Statement s = c.createStatement()) {
            s.execute("CREATE DATABASE bestand_main");
        }
        List<String> mainSatz = mainSatz();
        for (String name : mainSatz) {
            try (var eingang = BetriebsabfragenBlaetterTest.class
                    .getResourceAsStream("/db/migration/" + name)) {
                assertThat(eingang).as("main-Migration %s ist noch mitgeliefert", name).isNotNull();
                Files.copy(eingang, mainSatzOrdner.resolve(name));
            }
        }
        Flyway bestand = flyway("bestand_main")
                .locations("filesystem:" + mainSatzOrdner.toAbsolutePath(), "classpath:db/dev")
                .outOfOrder(true).load();
        bestand.migrate();
        assertThat(java.util.Arrays.stream(bestand.info().applied()).map(MigrationInfo::getScript)
                .filter(name -> !name.startsWith("V100__") && !name.contains("dev_")).toList())
                .as("genau der ausgelieferte main-Satz, keine Versionsdecke")
                .containsExactlyInAnyOrderElementsOf(mainSatz);

        saeeWerteFuerDasPilotBlatt();
    }

    // -----------------------------------------------------------------------------------------
    // Die drei Läufe
    // -----------------------------------------------------------------------------------------

    @Test
    void dasVorherBlattLaeuftAufDemSchemaVonMain() throws Exception {
        Map<String, Integer> zeilen = new LinkedHashMap<>();
        Map<String, String> formen = fahre("bestand_main", VORHER, zeilen);

        assertThat(formen.keySet()).as("alle achtzehn Abfragen des Blatts gelaufen")
                .contains("Q01#1", "Q02#1", "Q03#1", "Q04#1", "Q05#1", "Q06#1", "Q06#2", "Q07#1",
                        "Q08#1", "Q09#1", "Q10#1", "Q11#1", "Q12#1", "Q13#1", "Q14#1", "Q14#2",
                        "Q14#3", "Q15#1", "Q16#1", "Q17#1", "Q18#1");
        assertThat(vergleichbar(VORHER, formen)).isEqualTo(erwarteteFormen(VORHER));
        // Auf der gesäten Datenbank müssen die Abfragen über den Bestand ETWAS finden.
        assertThat(zeilen).as("gesäte Zeilen, nicht nur leere Tabellen")
                .containsEntry("Q01#1", 1).containsEntry("Q11#1", 1).containsEntry("Q12#1", 1)
                .containsEntry("Q14#1", 1).containsEntry("Q15#1", 1);
        assertThat(zeilen.get("Q02#1")).as("Kundenbereiche der Entwicklungs-Saat").isPositive();
        assertThat(zeilen.get("Q03#1")).as("Lage der Standort-Übernahme").isPositive();
        assertThat(zeilen.get("Q06#1")).as("Boxen der Entwicklungs-Saat").isPositive();
        assertThat(zeilen.get("Q07#1")).as("Edge-Stände der Entwicklungs-Saat").isPositive();
        assertThat(zeilen.get("Q14#2")).as("Hypertabellen").isPositive();
    }

    @Test
    void nachherUndPilotBlattLaufenAufDemSchemaVonUems() throws Exception {
        Map<String, Integer> nachZeilen = new LinkedHashMap<>();
        Map<String, String> nachFormen = fahre("uems", NACHHER, nachZeilen);
        assertThat(nachFormen.keySet()).contains("Z01#1", "Z01#2", "Z02#1", "Z03#1", "Z03#2",
                "Z04#1", "Z05#1", "Z06#1", "Z07#1", "Z08#1");
        assertThat(vergleichbar(NACHHER, nachFormen)).isEqualTo(erwarteteFormen(NACHHER));
        assertThat(nachZeilen).as("der CHECK und die Läufer-Zählungen stehen")
                .containsEntry("Z02#1", 1).containsEntry("Z04#1", 1).containsEntry("Z05#1", 1)
                .containsEntry("Z06#1", 1).containsEntry("Z07#1", 1);
        assertThat(nachZeilen.get("Z01#1")).isEqualTo(1);

        Map<String, Integer> pilotZeilen = new LinkedHashMap<>();
        Map<String, String> pilotFormen = fahre("uems", PILOT, pilotZeilen);
        assertThat(pilotFormen.keySet()).contains("T01a#1", "T01b#1", "T02#1", "T03#1", "T04#1");
        assertThat(vergleichbar(PILOT, pilotFormen)).isEqualTo(erwarteteFormen(PILOT));
        // Jede der vier Fragen findet die gesäten Zeilen; sonst prüfte das Blatt nur Syntax.
        assertThat(pilotZeilen.get("T01a#1")).as("Eingang je Quelle").isPositive();
        assertThat(pilotZeilen.get("T01b#1")).as("Rohwerte der letzten 24 h").isPositive();
        assertThat(pilotZeilen.get("T02#1")).as("offene Lücken").isPositive();
        assertThat(pilotZeilen.get("T03#1")).as("Arbeitslisten-Alter").isPositive();
        assertThat(pilotZeilen.get("T04#1")).as("letzter Lauf je Läufer").isPositive();
    }

    @Test
    void dasVorherBlattLaeuftNichtAufEinemFrischenUemsSchemaAlsErsatz() throws Exception {
        // Nicht gefordert, aber festgehalten: V20260916010000 benennt die Akteur-Spalten um,
        // deshalb ist das Vorher-Blatt genau das — ein Blatt für den Stand VOR der Zusammenführung.
        assertThatThrownBy(() -> fahre("uems", VORHER, new LinkedHashMap<>()))
                .isInstanceOf(SQLException.class)
                .hasMessageContaining("akteur_name");
    }

    // -----------------------------------------------------------------------------------------
    // Die drei Zusicherungen an die Form
    // -----------------------------------------------------------------------------------------

    @Test
    void nachherBlattErkenntErfolgreicheDeleteMarkerOhneSieAlsSqlZuZaehlen() throws Exception {
        try (Connection c = verbindung("uems"); Statement s = c.createStatement()) {
            // Session-local copy: the actual migrated history remains untouched for all other tests.
            s.execute("CREATE TEMP TABLE flyway_schema_history AS TABLE public.flyway_schema_history");
            long sqlCount;
            try (ResultSet rs = s.executeQuery("SELECT count(*) FROM flyway_schema_history WHERE type='SQL' AND success")) {
                rs.next();
                sqlCount = rs.getLong(1);
            }
            for (int i = 0; i < 2; i++) {
                s.executeUpdate("""
                        INSERT INTO flyway_schema_history
                        SELECT (SELECT max(installed_rank)+1 FROM flyway_schema_history), version, description,
                               'DELETE', script, checksum, installed_by, installed_on, 0, true
                        FROM flyway_schema_history WHERE type='SQL' ORDER BY installed_rank LIMIT 1
                        """);
            }
            s.executeUpdate("""
                    INSERT INTO flyway_schema_history
                    SELECT (SELECT max(installed_rank)+1 FROM flyway_schema_history), '99999999999999',
                           'failed probe', 'SQL', 'failed.sql', 0, current_user, now(), 0, false
                    """);
            s.execute("BEGIN TRANSACTION READ ONLY");
            for (Abfrage query : lies(NACHHER)) {
                if (!List.of("Z01#1", "Z08#1").contains(query.kennung())) continue;
                try (ResultSet rs = s.executeQuery(query.sql())) {
                    assertThat(rs.next()).isTrue();
                    assertThat(rs.getLong("fehlgeschlagen")).isEqualTo(1);
                    if (query.kennung().equals("Z01#1")) {
                        assertThat(rs.getLong("angewandt")).isEqualTo(sqlCount);
                    } else {
                        assertThat(rs.getLong("sql_erfolgreich")).isEqualTo(sqlCount);
                        assertThat(rs.getLong("geloescht_markiert")).isEqualTo(2);
                        assertThat(rs.getLong("versionen_geloescht")).isEqualTo(1);
                    }
                }
            }
            s.execute("ROLLBACK");
        }
    }

    @Test
    void keineAbfrageDerBlaetterSchreibt() throws Exception {
        List<Abfrage> kopf = lies(VORHER).stream().filter(a -> a.kennung().startsWith("kopf")).toList();
        assertThat(kopf).as("BEGIN READ ONLY, die drei SET LOCAL und COMMIT").hasSize(5);
        assertThat(kopf.get(0).sql()).isEqualTo("BEGIN TRANSACTION READ ONLY");
        assertThat(kopf.get(4).sql()).isEqualTo("COMMIT");

        try (Connection c = verbindung("bestand_main"); Statement s = c.createStatement()) {
            for (Abfrage a : kopf.subList(0, 4)) {
                s.execute(a.sql());
            }
            assertThatThrownBy(() -> s.execute(
                    "INSERT INTO ort_aenderung (tenant_id, objekt_art, objekt_id, art, gilt_ab, "
                            + "rueckwirkend, akteur_name) VALUES "
                            + "('00000000-0000-0000-0000-000000000001', 'anlage', "
                            + "'00000000-0000-0000-0000-000000000002', 'angelegt', DATE '2026-09-18', "
                            + "false, 'Prüfung')"))
                    .as("READ ONLY erzwingt es, nicht die Disziplin des Lesers")
                    .isInstanceOf(SQLException.class)
                    .hasMessageContaining("read-only transaction");
            s.execute("ROLLBACK");
        }

        // Dieselbe Sperre trägt jedes der drei Blätter.
        for (String datei : List.of(VORHER, NACHHER, PILOT)) {
            List<String> anweisungen = lies(datei).stream().map(Abfrage::sql).toList();
            assertThat(anweisungen.get(0)).as("%s beginnt READ ONLY", datei)
                    .isEqualTo("BEGIN TRANSACTION READ ONLY");
            assertThat(anweisungen).as("%s: keine schreibende Anweisung", datei)
                    .allMatch(sql -> sql.matches("(?is)^(SELECT|WITH|BEGIN|SET|COMMIT)\\b.*"));
        }
    }

    @Test
    void teilAbisCDesVorherBlattsTraegtKeineKennung() throws Exception {
        Map<String, String> formen = fahre("bestand_main", VORHER, new LinkedHashMap<>());
        Map<String, String> teile = new LinkedHashMap<>();
        lies(VORHER).forEach(a -> teile.put(a.kennung(), a.teil()));

        List<String> verstoesse = new ArrayList<>();
        formen.forEach((kennung, form) -> {
            if (!List.of("A", "B", "C").contains(teile.get(kennung))) {
                return;
            }
            for (String spalte : form.split(" ")) {
                String name = spalte.substring(0, spalte.indexOf(':'));
                String typ = spalte.substring(spalte.indexOf(':') + 1);
                if (typ.contains("uuid") || KENNUNG_IN_SPALTE.matcher(name).find()) {
                    verstoesse.add(kennung + " · " + spalte);
                }
            }
        });
        assertThat(verstoesse).as("Teil A–C ist teilbar: nur Zählungen, keine Kennung").isEmpty();

        // Und der Gegenbeweis: Teil D nennt sie, sonst prüfte die Regel nichts.
        assertThat(formen.get("Q16#1")).contains("tenant_id:uuid").contains("site_id:uuid");
    }

    // -----------------------------------------------------------------------------------------
    // Werkzeug
    // -----------------------------------------------------------------------------------------

    /** Eine Anweisung des Blatts mit ihrer Kennung und dem Teil, in dem sie steht. */
    private record Abfrage(String kennung, String teil, String sql) {}

    /** Zerlegt ein Blatt in seine Anweisungen — dieselbe Datei, die der Betreiber fährt. */
    private static List<Abfrage> lies(String datei) throws IOException {
        List<Abfrage> aus = new ArrayList<>();
        StringBuilder puffer = new StringBuilder();
        String teil = "-";
        String kennung = "kopf";
        int lfd = 0;
        int kopfLfd = 0;
        for (String zeile : Files.readAllLines(ORDNER.resolve(datei), UTF_8)) {
            Matcher mt = TEIL.matcher(zeile);
            if (mt.find()) {
                teil = mt.group(1);
            }
            Matcher mk = KENNUNG.matcher(zeile);
            if (mk.find() && puffer.toString().isBlank()) {
                kennung = mk.group(1);
                lfd = 0;
            }
            String ohneKommentar = zeile.replaceFirst("--.*$", "").strip();
            if (ohneKommentar.isEmpty()) {
                continue;
            }
            puffer.append(ohneKommentar).append('\n');
            int ende;
            while ((ende = puffer.indexOf(";")) >= 0) {
                String sql = puffer.substring(0, ende).strip();
                puffer.delete(0, ende + 1);
                if (sql.isEmpty()) {
                    continue;
                }
                boolean lesend = sql.toUpperCase(Locale.ROOT).matches("(?s)^(SELECT|WITH)\\b.*");
                aus.add(lesend
                        ? new Abfrage(kennung + "#" + (++lfd), teil, sql)
                        : new Abfrage("kopf#" + (++kopfLfd), "-", sql));
            }
        }
        assertThat(puffer.toString().strip()).as("%s endet ohne angefangene Anweisung", datei).isEmpty();
        return aus;
    }

    /** Fährt ein Blatt Anweisung für Anweisung und hält Ergebnisform und Zeilenzahl fest. */
    private static Map<String, String> fahre(String db, String datei, Map<String, Integer> zeilen)
            throws Exception {
        Map<String, String> formen = new LinkedHashMap<>();
        try (Connection c = verbindung(db); Statement s = c.createStatement()) {
            for (Abfrage a : lies(datei)) {
                String sql = a.sql().replace(":'betreiber_liste'", "'" + betreiberListe + "'");
                if (a.kennung().startsWith("kopf")) {
                    s.execute(sql);
                    continue;
                }
                try (ResultSet rs = s.executeQuery(sql)) {
                    formen.put(a.kennung(), form(rs.getMetaData()));
                    int gefunden = 0;
                    while (rs.next()) {
                        gefunden++;
                    }
                    zeilen.put(a.kennung(), gefunden);
                }
            }
        }
        return formen;
    }

    /** Spaltenname und -typ, in der Reihenfolge des SELECT. */
    private static String form(ResultSetMetaData md) throws SQLException {
        StringBuilder sb = new StringBuilder();
        for (int i = 1; i <= md.getColumnCount(); i++) {
            sb.append(i == 1 ? "" : " ").append(md.getColumnLabel(i)).append(':')
                    .append(md.getColumnTypeName(i));
        }
        return sb.toString();
    }

    /**
     * Die beobachtete Form, und daneben als Datei unter {@code target/} — wer ein Blatt bewusst
     * ändert, kopiert sie von dort nach {@code src/test/resources/betriebsabfragen/}.
     */
    private static List<String> vergleichbar(String datei, Map<String, String> formen)
            throws IOException {
        List<String> aus = formen.entrySet().stream().map(e -> e.getKey() + " " + e.getValue()).toList();
        Path ziel = Path.of("target", "betriebsabfragen");
        Files.createDirectories(ziel);
        Files.write(ziel.resolve(datei + ".formen.txt"),
                aus.stream().map(z -> datei + " " + z).toList(), UTF_8);
        return aus;
    }

    /** Die festgehaltene Ergebnisform je Abfrage — eine Migration, die sie ändert, wird rot. */
    private static List<String> erwarteteFormen(String datei) throws IOException {
        List<String> alle = Files.readAllLines(FORMEN, UTF_8);
        List<String> aus = alle.stream()
                .filter(z -> !z.isBlank() && !z.startsWith("#"))
                .filter(z -> z.startsWith(datei + " "))
                .map(z -> z.substring(datei.length() + 1))
                .toList();
        assertThat(aus).as("%s hat festgehaltene Ergebnisformen in %s", datei, FORMEN).isNotEmpty();
        return aus;
    }

    // -----------------------------------------------------------------------------------------
    // Saat: die vorhandene Entwicklungs-Saat plus die Zeilen der Messdaten-Kette
    // -----------------------------------------------------------------------------------------

    private static void saeeWerteFuerDasPilotBlatt() throws Exception {
        try (Connection c = verbindung("uems"); Statement s = c.createStatement()) {
            UUID tenant;
            UUID site;
            UUID device;
            try (ResultSet rs = s.executeQuery(
                    "SELECT id, tenant_id, site_id FROM device ORDER BY id LIMIT 1")) {
                assertThat(rs.next()).as("die Entwicklungs-Saat hat eine Box").isTrue();
                device = rs.getObject(1, UUID.class);
                tenant = rs.getObject(2, UUID.class);
                site = rs.getObject(3, UUID.class);
            }
            UUID entity = UUID.fromString("00000000-0000-0000-0000-0000000014a1");
            betreiberListe = tenant.toString();

            // Der Stand des Lücken-Melders: eine Box mit offener Lücke, eine Reihe ohne.
            s.execute("INSERT INTO messreihe_luecke_stand (tenant_id, einheit, art, device_id, "
                    + "site_id, zuletzt, luecke_seit) VALUES ('" + tenant + "', 'box:" + device
                    + "', 'box', '" + device + "', '" + site + "', now() - interval '20 minutes', "
                    + "now() - interval '12 minutes')");
            s.execute("INSERT INTO messreihe_luecke_stand (tenant_id, einheit, art, device_id, "
                    + "site_id, entity_id, messkanal, zuletzt, geprueft_bis) VALUES ('" + tenant
                    + "', 'reihe:" + entity + ":wirkarbeit', 'reihe', '" + device + "', '" + site
                    + "', '" + entity + "', 'wirkarbeit', now() - interval '5 minutes', now())");

            // Ein Rohwert je Eingangsweg der letzten 24 Stunden (Box-Weg).
            s.execute("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id,"
                    + " device_id, point_key, raw_numeric, decoded_numeric, quality, catalog_version,"
                    + " edge_sequence, aggregation_kind, long_term_cadence_s, gap, dropped_samples)"
                    + " VALUES (now() - interval '6 minutes', now() - interval '5 minutes', '" + tenant
                    + "', '" + site + "', '" + device + "', 'sunspec.model_203.totwhimp', 42, 42,"
                    + " 'good', '2026.08.26.3', 1, 'counter', 300, false, 0)");

            // Die drei Arbeitslisten mit je einem offenen Eintrag.
            s.execute("INSERT INTO messreihe_viertelstunde_arbeit (tenant_id, entity_id, messkanal,"
                    + " intervall_beginn, grund) VALUES ('" + tenant + "', '" + entity + "',"
                    + " 'wirkarbeit', date_trunc('hour', now()), 'eingang')");
            s.execute("INSERT INTO messreihe_tag_arbeit (tenant_id, entity_id, messkanal, utc_tag,"
                    + " grund) VALUES ('" + tenant + "', '" + entity + "', 'wirkarbeit',"
                    + " (now() AT TIME ZONE 'UTC')::date, 'viertelstunde')");
            s.execute("INSERT INTO messreihe_periode_arbeit (tenant_id, entity_id, messkanal, art,"
                    + " tag, grund) VALUES ('" + tenant + "', '" + entity + "', 'wirkarbeit',"
                    + " 'monat', date_trunc('month', now())::date, 'tag')");
        }
    }

    private static List<String> mainSatz() throws IOException {
        try (var eingang = BetriebsabfragenBlaetterTest.class
                .getResourceAsStream("/migration/main-migrations.txt")) {
            assertThat(eingang).isNotNull();
            List<String> main = new String(eingang.readAllBytes(), UTF_8).lines()
                    .filter(zeile -> !zeile.isBlank() && !zeile.startsWith("#")).toList();
            assertThat(main).isNotEmpty().doesNotHaveDuplicates();
            return main;
        }
    }

    private static FluentConfiguration flyway(String db) {
        return Flyway.configure().dataSource(jdbc(db), POSTGRES.getUsername(), POSTGRES.getPassword())
                .placeholders(Map.of("appDbUser", "voltpilot_app", "appDbPassword", "pw_app",
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "pw_admin"));
    }

    private static Connection verbindung(String db) throws SQLException {
        return DriverManager.getConnection(jdbc(db), POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    private static String jdbc(String db) {
        return POSTGRES.getJdbcUrl().replaceFirst("/uems(\\?|$)", "/" + db + "$1");
    }
}
