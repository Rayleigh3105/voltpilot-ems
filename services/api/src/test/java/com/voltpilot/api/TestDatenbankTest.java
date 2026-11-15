package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.testcontainers.DockerClientFactory;

/**
 * Belegt, dass eine {@link TestDatenbank} so isoliert ist wie der eigene Container, den sie ersetzt:
 * nichts aus einer Klasse (Zeilen, Tabellen, Datenbanken, Rollen, Rollenattribute) erreicht die
 * nächste, und eine Kopie aus der Vorlage ist dieselbe Datenbank wie ein eigener vollständiger
 * Flyway-Lauf - Schema, Rechte, Zeilen-Sicherheit, Daten, TimescaleDB-Katalog. Läufe zu
 * verschiedenen Zeitpunkten vergleicht der Abdruck mit Mikrosekunden; eine Migration, die
 * {@code now()} in eine Zeile schriebe, fiele hier auf.
 */
class TestDatenbankTest {

    private static final Path MIGRATIONEN = Path.of("src/main/resources/db/migration");

    /**
     * Die einzigen Werte, die zwei volle Läufe zu verschiedenen Zeitpunkten verschieden schreiben:
     * der Zeitpunkt der Migration selbst ({@code DEFAULT now()} in Zeilen, die eine Migration anlegt,
     * und der Startpunkt der TimescaleDB-Jobs). Eine Kopie aus der Vorlage trägt hier den Zeitpunkt
     * des Vorlagenbaus. Kein Code leitet aus ihrem Alter ein Verhalten ab: die {@code *_lauf}-Zeiten
     * werden nur geschrieben, die Freigabe zeigt ihr Anlagedatum nur an, die Jobs laufen nach ihrem
     * Takt. Kommt hier ein Wert dazu, schlägt {@link #vorlageIstDieselbeDatenbankWieEinVollerLauf()}
     * fehl - dann prüfen, ob ein Test von seinem Alter abhängt, bevor er in diese Liste darf.
     */
    static final Map<String, List<String>> ZEITPUNKT_DER_MIGRATION = Map.of(
            "_timescaledb_config.bgw_job", List.of("initial_start"),
            "public.inverter_control_certification", List.of("created_at"),
            "public.messreihe_luecke_lauf", List.of("geaendert_am"),
            "public.messreihe_tag_lauf", List.of("geaendert_am"),
            "public.messreihe_viertelstunde_lauf", List.of("geaendert_am"));

    private static void docker() {
        Assumptions.assumeTrue(DockerClientFactory.instance().isDockerAvailable(), "Docker fehlt");
    }

    @Test
    void nichtsAusEinerKlasseErreichtDieNaechste() throws Exception {
        docker();
        TestDatenbank erste = new TestDatenbank();
        erste.start();
        String ersterName = erste.getDatabaseName();
        try (Connection c = erste.createConnection(""); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE spur (x int)");
            s.execute("INSERT INTO spur VALUES (1)");
            s.execute("CREATE ROLE spur_rolle LOGIN PASSWORD 'x'");
            s.execute("CREATE ROLE voltpilot_app LOGIN PASSWORD 'erste'");
            s.execute("GRANT SELECT ON spur TO voltpilot_app");
            s.execute("CREATE DATABASE voltpilot_spaet");
        }
        erste.stop();
        assertThatThrownBy(erste::getJdbcUrl).isInstanceOf(IllegalStateException.class);

        TestDatenbank zweite = new TestDatenbank();
        zweite.start();
        try (Connection c = zweite.createConnection("")) {
            assertThat(werte(c, "SELECT datname FROM pg_database ORDER BY datname"))
                    .doesNotContain(ersterName, "voltpilot_spaet")
                    .contains(zweite.getDatabaseName());
            assertThat(werte(c, "SELECT rolname FROM pg_roles"))
                    .doesNotContain("spur_rolle", "voltpilot_app");
            assertThat(werte(c, "SELECT relname FROM pg_class WHERE relname = 'spur'")).isEmpty();
            // Wie POSTGRES_DB des Abbilds: dieselben Erweiterungen, Scheduler läuft sofort.
            assertThat(werte(c, "SELECT extname || ' ' || extversion FROM pg_extension ORDER BY 1"))
                    .isEqualTo(erweiterungenDerContainerDatenbank(zweite));
            assertThat(werte(c, "SELECT backend_type FROM pg_stat_activity WHERE datname = current_database()"
                    + " AND backend_type = 'TimescaleDB Background Worker Scheduler'")).hasSize(1);
        } finally {
            zweite.stop();
        }
    }

    @Test
    void vorlageIstDieselbeDatenbankWieEinVollerLauf() throws Exception {
        docker();
        TestDatenbank voll = new TestDatenbank();
        voll.start();
        flyway(voll, "pw_voll").load().migrate();
        List<String> erwartet = abdruck(voll);
        anmeldung(voll, "pw_voll");
        voll.stop();

        TestDatenbank gebaut = new TestDatenbank();
        gebaut.start();
        gebaut.migriere(flyway(gebaut, "pw_gebaut"));
        assertThat(abdruck(gebaut)).isEqualTo(erwartet);
        anmeldung(gebaut, "pw_gebaut");
        // Die Klasse ändert ihre Kopie ...
        try (Connection c = gebaut.createConnection(""); Statement s = c.createStatement()) {
            s.execute("TRUNCATE tenant CASCADE");
            s.execute("ALTER TABLE site DISABLE ROW LEVEL SECURITY");
            s.execute("DROP TABLE flyway_schema_history");
        }
        gebaut.stop();

        // ... und die nächste Kopie ist wieder genau der volle Lauf, ohne neuen Lauf.
        TestDatenbank kopie = new TestDatenbank();
        kopie.start();
        assertThat(kopie.migriere(flyway(kopie, "pw_kopie")).migrationsExecuted).isZero();
        assertThat(abdruck(kopie)).isEqualTo(erwartet);
        anmeldung(kopie, "pw_kopie");
        try (Connection c = DriverManager.getConnection(kopie.getJdbcUrl(), "voltpilot_app", "pw_kopie")) {
            // Zeilen-Sicherheit greift für die App-Rolle: ohne Mandant keine Zeile.
            assertThat(werte(c, "SELECT count(*) FROM site")).containsExactly("0");
        }
        // Ändert eine Klasse die geliehenen Rollen (sie gelten im ganzen Cluster), ...
        try (Connection c = kopie.createConnection(""); Statement s = c.createStatement()) {
            s.execute("ALTER ROLE voltpilot_app CREATEDB BYPASSRLS");
            s.execute("ALTER ROLE voltpilot_admin SET work_mem = '1MB'");
        }
        kopie.stop();

        // ... ist die Vorlage verbraucht und wird neu gebaut: die nächste Klasse sieht die Rollen wieder
        // so, wie ein voller Lauf sie anlegt (der Abdruck enthält Attribute und Einstellungen).
        TestDatenbank danach = new TestDatenbank();
        danach.start();
        danach.migriere(flyway(danach, "pw_danach"));
        assertThat(abdruck(danach)).isEqualTo(erwartet);
        anmeldung(danach, "pw_danach");
        danach.stop();
    }

    @Test
    void nieAusDerVorlageWasVomZeitpunktOderZielAbhaengt() {
        assertThat(TestDatenbank.Cluster.vorlagenSchluessel(basis("x").load().getConfiguration())).isNotNull();
        assertThat(TestDatenbank.Cluster.vorlagenSchluessel(
                basis("x").locations("classpath:db/migration", "classpath:db/dev").load().getConfiguration()))
                .isNull();
        assertThat(TestDatenbank.Cluster.vorlagenSchluessel(
                basis("x").target("20260101000000").load().getConfiguration())).isNull();
        assertThat(TestDatenbank.Cluster.vorlagenSchluessel(basis("x").load().getConfiguration()))
                .isEqualTo(TestDatenbank.Cluster.vorlagenSchluessel(basis("y").load().getConfiguration()));
    }

    /**
     * Neue Testklassen nehmen die geteilte Datenbank: ein eigener Container je Klasse kostete im Nachtlauf
     * Start und vollen Flyway-Lauf (Lauf 595: fünf api-Teile je 80 bis 104 min). Ausnahmen mit Grund.
     */
    @Test
    void keineTestklasseStartetEinenEigenenDatenbankContainer() throws IOException {
        Map<String, String> ausnahmen = Map.of(
                "VmCompressionMeasurementTest.java", "eigener Superuser und eigene Datenbank, Messwerkzeug",
                "UemsBestandSteuerungAusEinemStueckTest.java",
                "fester Containername für tools/buehne-vorher-nachher (buehne.container-prefix)",
                "TestDatenbank.java", "der geteilte Container selbst",
                "TestDatenbankTest.java", "dieser Wächter");
        List<String> eigene = new ArrayList<>();
        try (Stream<Path> dateien = Files.walk(Path.of("src/test/java"))) {
            for (Path datei : dateien.filter(d -> d.toString().endsWith(".java")).sorted().toList()) {
                if (!ausnahmen.containsKey(datei.getFileName().toString())
                        && Files.readString(datei, StandardCharsets.UTF_8).contains("new PostgreSQLContainer")) {
                    eigene.add(datei.toString());
                }
            }
        }
        assertThat(eigene).as("statt new PostgreSQLContainer: new TestDatenbank()").isEmpty();
    }

    /** Der Vorlagenschlüssel lässt nur die Passwörter weg; das trägt nur, solange sie nur dort stehen. */
    @Test
    void passwortPlatzhalterStehenNurInRollenAnweisungen() throws IOException {
        Pattern platzhalter = Pattern.compile("\\$\\{(\\w+)}");
        Pattern rollenAnweisung = Pattern.compile(
                "(CREATE|ALTER) ROLE \\$\\{(\\w+)}[^;]*PASSWORD '\\$\\{(\\w+)}'");
        List<String> fremd = new ArrayList<>();
        try (Stream<Path> dateien = Files.list(MIGRATIONEN)) {
            for (Path datei : dateien.sorted().toList()) {
                String sql = Files.readString(datei, StandardCharsets.UTF_8);
                int erlaubt = 0;
                Matcher r = rollenAnweisung.matcher(sql);
                while (r.find()) {
                    assertThat(TestDatenbank.PASSWORT_ZU_ROLLE).containsEntry(r.group(3), r.group(2));
                    erlaubt++;
                }
                int gesamt = 0;
                Matcher p = platzhalter.matcher(sql);
                while (p.find()) {
                    if (TestDatenbank.PASSWORT_ZU_ROLLE.containsKey(p.group(1))) {
                        gesamt++;
                    }
                }
                if (gesamt != erlaubt) {
                    fremd.add(datei.getFileName().toString());
                }
            }
        }
        assertThat(fremd).isEmpty();
    }

    private static FluentConfiguration basis(String passwort) {
        return Flyway.configure()
                .dataSource("jdbc:postgresql://localhost:1/x", "x", "x")
                .locations("classpath:db/migration")
                .baselineOnMigrate(true).baselineVersion("0")
                .placeholders(Map.of("appDbUser", "voltpilot_app", "appDbPassword", passwort,
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", passwort));
    }

    private static FluentConfiguration flyway(TestDatenbank db, String passwort) {
        return basis(passwort).dataSource(db.getJdbcUrl(), db.getUsername(), db.getPassword());
    }

    private static void anmeldung(TestDatenbank db, String passwort) throws SQLException {
        for (String rolle : List.of("voltpilot_app", "voltpilot_admin")) {
            try (Connection c = DriverManager.getConnection(db.getJdbcUrl(), rolle, passwort)) {
                assertThat(werte(c, "SELECT current_user")).containsExactly(rolle);
            }
            assertThatThrownBy(() -> DriverManager.getConnection(db.getJdbcUrl(), rolle, passwort + "_falsch"))
                    .isInstanceOf(SQLException.class);
        }
    }

    private static List<String> erweiterungenDerContainerDatenbank(TestDatenbank db) {
        assertThatThrownBy(() -> db.getJdbcUrl("voltpilot")).isInstanceOf(IllegalArgumentException.class);
        return TestDatenbank.Cluster.fuer(List.of()).liste("voltpilot",
                "SELECT extname || ' ' || extversion FROM pg_extension ORDER BY 1");
    }

    /**
     * Alles, was eine Testklasse von ihrer Datenbank sehen kann: Katalog (Tabellen, Spalten,
     * Einschränkungen, Indizes, Richtlinien, Rechte, Funktionen, Auslöser, Sichten, Sequenzen,
     * Rollen mit Attributen und Einstellungen), TimescaleDB-Katalog und jede Zeile jeder Tabelle.
     * Es fehlen nur die Ausführungsspalten der Flyway-Historie (wann, wie lange), die
     * {@link #ZEITPUNKT_DER_MIGRATION} und die Laufstatistik der TimescaleDB-Jobs (ob der Scheduler
     * einen Job schon ausgeführt hat, hängt auch bei zwei frischen Läufen vom Zeitpunkt ab).
     */
    static List<String> abdruck(TestDatenbank db) throws SQLException {
        List<String> zeilen = new ArrayList<>();
        try (Connection c = db.createConnection("")) {
            zeilen.addAll(werte(c, """
                    SELECT 'rel ' || n.nspname || '.' || c.relname || ' ' || c.relkind::text || ' rls=' || c.relrowsecurity
                           || ' force=' || c.relforcerowsecurity || ' acl=' || coalesce(c.relacl::text, '-')
                           || ' owner=' || pg_get_userbyid(c.relowner)
                    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
                    ORDER BY 1"""));
            zeilen.addAll(werte(c, """
                    SELECT 'col ' || table_schema || '.' || table_name || '.' || column_name || ' ' || data_type
                           || ' ' || is_nullable || ' ' || coalesce(column_default, '-')
                    FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                    ORDER BY 1"""));
            zeilen.addAll(werte(c, """
                    SELECT 'con ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid)
                    FROM pg_constraint WHERE connamespace NOT IN ('pg_catalog'::regnamespace) ORDER BY 1"""));
            zeilen.addAll(werte(c, """
                    SELECT 'idx ' || schemaname || '.' || indexname || ' ' || indexdef FROM pg_indexes
                    WHERE schemaname NOT IN ('pg_catalog') ORDER BY 1"""));
            zeilen.addAll(werte(c, """
                    SELECT 'pol ' || schemaname || '.' || tablename || ' ' || policyname || ' ' || permissive
                           || ' ' || array_to_string(roles, ',') || ' ' || cmd || ' ' || coalesce(qual, '-')
                           || ' ' || coalesce(with_check, '-')
                    FROM pg_policies ORDER BY 1"""));
            zeilen.addAll(werte(c, """
                    SELECT 'fn ' || p.pronamespace::regnamespace || '.' || p.proname || '('
                           || pg_get_function_identity_arguments(p.oid) || ') ' || md5(pg_get_functiondef(p.oid))
                           || ' acl=' || coalesce(p.proacl::text, '-') || ' secdef=' || p.prosecdef
                    FROM pg_proc p
                    WHERE p.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
                      AND p.prokind <> 'a'
                    ORDER BY 1"""));
            zeilen.addAll(werte(c, """
                    SELECT 'trg ' || tgrelid::regclass || ' ' || tgname || ' ' || pg_get_triggerdef(oid)
                    FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1"""));
            zeilen.addAll(werte(c, """
                    SELECT 'view ' || schemaname || '.' || viewname || ' ' || md5(definition) FROM pg_views
                    WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1"""));
            zeilen.addAll(werte(c, """
                    SELECT 'nsp ' || nspname || ' ' || coalesce(nspacl::text, '-') || ' '
                           || pg_get_userbyid(nspowner) FROM pg_namespace ORDER BY 1"""));
            zeilen.addAll(werte(c, """
                    SELECT 'defacl ' || coalesce(defaclnamespace::regnamespace::text, '-') || ' '
                           || pg_get_userbyid(defaclrole) || ' ' || defaclobjtype::text || ' ' || defaclacl::text
                    FROM pg_default_acl ORDER BY 1"""));
            zeilen.addAll(werte(c, """
                    SELECT 'role ' || r.rolname || ' ' || r.rolsuper || r.rolinherit || r.rolcreaterole
                           || r.rolcreatedb || r.rolcanlogin || r.rolbypassrls || ' '
                           || coalesce((SELECT string_agg(array_to_string(s.setconfig, ','), ';')
                                        FROM pg_db_role_setting s WHERE s.setrole = r.oid), '-')
                    FROM pg_roles r WHERE r.rolname IN ('voltpilot_app', 'voltpilot_admin') ORDER BY 1"""));
            zeilen.addAll(werte(c, """
                    SELECT 'job ' || application_name || ' ' || proc_schema || '.' || proc_name || ' '
                           || schedule_interval || ' ' || coalesce(hypertable_name, '-') || ' '
                           || coalesce(config::text, '-') || ' ' || owner
                    FROM timescaledb_information.jobs ORDER BY 1"""));
            List<String> tabellen = werte(c, """
                    SELECT n.nspname || '.' || c.relname
                    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                      AND n.nspname NOT LIKE 'pg_toast%'
                      AND (n.nspname, c.relname) NOT IN (('_timescaledb_catalog', 'metadata'),
                                                       ('_timescaledb_internal', 'bgw_job_stat'),
                                                       ('_timescaledb_internal', 'bgw_job_stat_history'))
                    ORDER BY 1""");
            for (String tabelle : tabellen) {
                List<String> ohne = new ArrayList<>(ZEITPUNKT_DER_MIGRATION.getOrDefault(tabelle, List.of()));
                if (tabelle.endsWith(".flyway_schema_history")) {
                    ohne.addAll(List.of("installed_by", "installed_on", "execution_time"));
                }
                String[] teile = tabelle.split("\\.", 2);
                String spalten = String.join(",", werte(c, "SELECT quote_ident(column_name) FROM information_schema.columns"
                        + " WHERE table_schema = '" + teile[0] + "' AND table_name = '" + teile[1] + "'"
                        + " ORDER BY ordinal_position").stream()
                        .filter(s -> !ohne.contains(s)).toList());
                String zeile = "ROW(" + spalten + ")::text";
                zeilen.addAll(werte(c, "SELECT 'data " + tabelle + " ' || count(*) || ' '"
                        + " || coalesce(md5(string_agg(" + zeile + ", E'\\n' ORDER BY " + zeile + ")), '-')"
                        + " FROM " + teile[0] + "." + teile[1]));
            }
            zeilen.addAll(werte(c, """
                    SELECT 'seq ' || schemaname || '.' || sequencename || ' ' || coalesce(last_value::text, '-')
                    FROM pg_sequences
                    WHERE (schemaname, sequencename) <> ('_timescaledb_internal', 'bgw_job_stat_history_id_seq')
                    ORDER BY 1"""));
        }
        return zeilen;
    }

    private static List<String> werte(Connection c, String abfrage) throws SQLException {
        try (Statement s = c.createStatement(); ResultSet r = s.executeQuery(abfrage)) {
            List<String> werte = new ArrayList<>();
            while (r.next()) {
                werte.add(r.getString(1));
            }
            return werte;
        }
    }
}
