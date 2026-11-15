package com.voltpilot.api.tenant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die eine Verbindung je Anfrage ({@link AnfrageVerbindung}, Lasttest Rang 13) an einem echten Pool mit ZWEI
 * Verbindungen: welche physische Verbindung ({@code pg_backend_pid()}) jeder Griff bekommt, was auf ihr steht, was
 * nach dem Ende der Anfrage roh im Pool liegt, und wie oft {@code set_config} wirklich an der Datenbank ankam
 * ({@code pg_stat_statements}).
 *
 * <p>„Roh" leiht ALLE Verbindungen des Pools gleichzeitig am Wrapper vorbei - so ist jede physische Verbindung
 * geprüft, nicht nur die zuletzt benutzte. Der Pool verbindet sich als eigene Rolle ohne Superuser-Recht: so lässt
 * sich das Zurücksetzen gezielt zum Scheitern bringen (Recht auf {@code set_config} entzogen).
 */
@Testcontainers(disabledWithoutDocker = true)
class AnfrageVerbindungTest {

    private static final UUID AHRENBERG = UUID.fromString("a0000000-0000-0000-0000-000000000001");
    private static final UUID NORDWIND = UUID.fromString("b0000000-0000-0000-0000-000000000001");
    private static final int POOL = 2;
    private static final String ROLLE = "vp_sockel";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw")
            .withCommand("postgres", "-c", "shared_preload_libraries=timescaledb,pg_stat_statements");

    private static HikariDataSource pool;
    private static TenantAwareDataSource ds;

    private record Sitzung(int pid, String tenant, String zugriff, String standortIds) {
        boolean leer() {
            return tenant.isEmpty() && zugriff.isEmpty() && standortIds.isEmpty();
        }
    }

    @BeforeAll
    static void pool() throws SQLException {
        try (Connection c = admin(); Statement s = c.createStatement()) {
            s.execute("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
            s.execute("CREATE ROLE " + ROLLE + " LOGIN PASSWORD 'vp_sockel_pw'");
        }
        HikariConfig c = new HikariConfig();
        c.setJdbcUrl(POSTGRES.getJdbcUrl());
        c.setUsername(ROLLE);
        c.setPassword("vp_sockel_pw");
        c.setMaximumPoolSize(POOL);
        c.setMinimumIdle(POOL);
        pool = new HikariDataSource(c);
        ds = new TenantAwareDataSource(pool);
    }

    @AfterAll
    static void zu() {
        pool.close();
    }

    @BeforeEach
    void anfrageAuf() throws SQLException {
        zaehlerLeeren();
    }

    @AfterEach
    void aufraeumen() {
        AnfrageVerbindung.ende();
        AnfrageZeitgrenze.ende();
        TenantContext.clear();
    }

    @Test
    void jederGriffDerAnfrageLiegtAufDerselbenVerbindungUndSetztNurEinmal() throws SQLException {
        anfrage();
        TenantContext.set(AHRENBERG);
        Sitzung erste = geliehen();
        Sitzung zweite = geliehen();
        Sitzung dritte = geliehen();

        assertThat(List.of(zweite.pid(), dritte.pid())).as("dieselbe physische Verbindung").containsOnly(erste.pid());
        assertThat(List.of(erste, zweite, dritte)).extracting(Sitzung::tenant).containsOnly(AHRENBERG.toString());
        assertThat(setConfigAufrufe()).as("einmal gesetzt, nicht dreimal gesetzt und zurückgesetzt").isEqualTo(1);

        AnfrageVerbindung.ende();
        assertThat(roh()).as("nach der Anfrage liegt jede Verbindung leer im Pool").allMatch(Sitzung::leer);
        assertThat(setConfigAufrufe()).as("plus einmal zurückgesetzt").isEqualTo(2);
    }

    @Test
    void einMandantenwechselImAnfrageFadenSetztNeuUndNurDann() throws SQLException {
        anfrage();
        TenantContext.set(AHRENBERG);
        Sitzung a = geliehen();
        TenantContext.set(NORDWIND);
        Sitzung n = geliehen();
        Sitzung n2 = geliehen();
        TenantContext.set(AHRENBERG);
        Sitzung a2 = geliehen();
        TenantContext.clear();
        Sitzung ohne = geliehen();

        assertThat(List.of(a, n, n2, a2, ohne)).extracting(Sitzung::tenant)
                .containsExactly(AHRENBERG.toString(), NORDWIND.toString(), NORDWIND.toString(), AHRENBERG.toString(),
                        "");
        assertThat(List.of(n.pid(), n2.pid(), a2.pid(), ohne.pid())).containsOnly(a.pid());
        assertThat(setConfigAufrufe()).as("vier Wechsel, der gleiche Griff dazwischen setzt nichts").isEqualTo(4);
    }

    @Test
    void eineZweiteVerbindungWaehrendDerGriffVerliehenIstBekommtEigeneUndGibtSieZurueckgesetztZurueck()
            throws SQLException {
        anfrage();
        TenantContext.set(AHRENBERG);
        try (Connection transaktion = ds.getConnection()) {
            transaktion.setAutoCommit(false);
            int gebunden = lies(transaktion).pid();
            TenantContext.set(NORDWIND);
            Sitzung zweite;
            try (Connection eigene = ds.getConnection()) {
                zweite = lies(eigene);
            }
            assertThat(zweite.pid()).as("REQUIRES_NEW in einer Transaktion: eine eigene Verbindung")
                    .isNotEqualTo(gebunden);
            assertThat(zweite.tenant()).isEqualTo(NORDWIND.toString());
            assertThat(lies(transaktion).tenant()).as("die Transaktion behält ihren Mandanten")
                    .isEqualTo(AHRENBERG.toString());
            transaktion.commit();
            transaktion.setAutoCommit(true);
        }
        // Die eigene Verbindung kam einzeln zurück: zurückgesetzt. Die gebundene trägt bis zum Ende ihre Sitzung.
        AnfrageVerbindung.ende();
        assertThat(roh()).allMatch(Sitzung::leer);
    }

    @Test
    void eineAbgebrocheneTransaktionDesGriffsWirdBeimZurueckgebenZurueckgerollt() throws SQLException {
        anfrage();
        TenantContext.set(AHRENBERG);
        int pid;
        try (Connection c = ds.getConnection()) {
            pid = lies(c).pid();
            c.setAutoCommit(false);
            try (Statement s = c.createStatement()) {
                s.execute("SELECT 1 / 0");
            } catch (SQLException erwartet) {
                // abgebrochene Transaktion, kein rollback() - so lässt manch ein Aufrufer die Verbindung liegen
            }
        }
        Sitzung danach = geliehen();
        assertThat(danach.pid()).isEqualTo(pid);
        assertThat(danach.tenant()).as("Autocommit und Mandant wie vorher").isEqualTo(AHRENBERG.toString());

        AnfrageVerbindung.ende();
        assertThat(roh()).allMatch(Sitzung::leer);
    }

    @Test
    void eineZeitueberschreitungLaesstNichtsZurueck() throws SQLException {
        anfrage();
        TenantContext.set(AHRENBERG);
        try (Connection c = ds.getConnection(); Statement s = c.createStatement()) {
            c.setAutoCommit(false);
            s.execute("SET LOCAL statement_timeout = 50");
            assertThatThrownBy(() -> s.execute("SELECT pg_sleep(2)")).isInstanceOf(SQLException.class)
                    .extracting(e -> ((SQLException) e).getSQLState()).isEqualTo("57014");
        }
        assertThat(geliehen().tenant()).isEqualTo(AHRENBERG.toString());
        AnfrageVerbindung.ende();
        assertThat(roh()).allMatch(Sitzung::leer);
    }

    @Test
    void einNieGeschlossenerGriffWirdAmEndeUngueltigUndDieVerbindungLeer() throws SQLException {
        anfrage();
        TenantContext.set(AHRENBERG);
        Connection liegengelassen = ds.getConnection();
        liegengelassen.setAutoCommit(false);
        int pid = lies(liegengelassen).pid();

        AnfrageVerbindung.ende();

        assertThat(liegengelassen.isClosed()).isTrue();
        assertThatThrownBy(() -> lies(liegengelassen)).isInstanceOf(SQLException.class);
        List<Sitzung> roh = roh();
        assertThat(roh).allMatch(Sitzung::leer);
        assertThat(roh).extracting(Sitzung::pid).as("zurückgerollt und zurück im Pool").contains(pid);
        assertThat(pool.getHikariPoolMXBean().getActiveConnections()).isZero();
    }

    @Test
    void eineAbgerisseneVerbindungWirdErsetztUndDasEndeWirftNicht() throws SQLException {
        anfrage();
        TenantContext.set(AHRENBERG);
        int pid = geliehen().pid();
        try (Connection admin = admin(); Statement s = admin.createStatement()) {
            s.execute("SELECT pg_terminate_backend(" + pid + ")");
        }
        try (Connection c = ds.getConnection(); Statement s = c.createStatement()) {
            assertThatThrownBy(() -> s.execute("SELECT 1")).isInstanceOf(SQLException.class);
        }
        Sitzung neu = geliehen();
        assertThat(neu.pid()).as("die nächste Abfrage leiht frisch").isNotEqualTo(pid);
        assertThat(neu.tenant()).isEqualTo(AHRENBERG.toString());

        AnfrageVerbindung.ende();
        assertThat(roh()).allMatch(Sitzung::leer).extracting(Sitzung::pid).doesNotContain(pid);
    }

    /**
     * Die Garantie, wenn das Zurücksetzen selbst scheitert (hier: Recht auf {@code set_config} mitten in der Anfrage
     * entzogen): die Verbindung geht NICHT mit Mandant in den Pool, sondern wird abgebrochen und ersetzt.
     */
    @Test
    void scheitertDasZuruecksetzenWirdDieVerbindungVerworfenStattMitMandantZurueckgegeben() throws SQLException {
        anfrage();
        TenantContext.set(AHRENBERG);
        int pid = geliehen().pid();
        rechtAufSetConfig(false);
        try {
            AnfrageVerbindung.ende();
        } finally {
            rechtAufSetConfig(true);
        }
        List<Sitzung> roh = roh();
        assertThat(roh).allMatch(Sitzung::leer);
        assertThat(roh).extracting(Sitzung::pid).as("verworfen, nicht zurückgegeben").doesNotContain(pid);
    }

    @Test
    void scheitertDasSetzenBekommtDerAufruferDenFehlerUndDerPoolKeineHalbeVerbindung() throws SQLException {
        anfrage();
        TenantContext.set(AHRENBERG);
        rechtAufSetConfig(false);
        try {
            assertThatThrownBy(AnfrageVerbindungTest::geliehen).isInstanceOf(SQLException.class);
        } finally {
            rechtAufSetConfig(true);
        }
        assertThat(pool.getHikariPoolMXBean().getActiveConnections()).isZero();
        assertThat(geliehen().tenant()).isEqualTo(AHRENBERG.toString());
        AnfrageVerbindung.ende();
        assertThat(roh()).allMatch(Sitzung::leer);
    }

    @Test
    void transaktionsZustandDenHikariZurueckstelltLoestDieBindung() throws SQLException {
        anfrage();
        TenantContext.set(AHRENBERG);
        try (Connection c = ds.getConnection()) {
            c.setTransactionIsolation(Connection.TRANSACTION_SERIALIZABLE);
            c.setReadOnly(true);
        }
        try (Connection c = ds.getConnection(); Statement s = c.createStatement();
                ResultSet rs = s.executeQuery("SHOW transaction_isolation")) {
            rs.next();
            assertThat(rs.getString(1)).isEqualTo("read committed");
            assertThat(c.isReadOnly()).isFalse();
            assertThat(c.getAutoCommit()).isTrue();
        }
        assertThat(setConfigAufrufe()).as("gesetzt, beim Schließen zurückgesetzt, frisch geliehen und gesetzt")
                .isEqualTo(3);
        AnfrageVerbindung.ende();
        assertThat(roh()).allMatch(Sitzung::leer);
    }

    @Test
    void freigebenGibtDieVerbindungLeerZurueckUndDieNaechsteAbfrageSetztWieder() throws SQLException {
        anfrage();
        TenantContext.set(AHRENBERG);
        geliehen();
        AnfrageVerbindung.freigeben();
        assertThat(roh()).as("während des Wartens hält die Anfrage keine Verbindung").allMatch(Sitzung::leer);
        assertThat(geliehen().tenant()).isEqualTo(AHRENBERG.toString());

        try (Connection transaktion = ds.getConnection()) {
            transaktion.setAutoCommit(false);
            AnfrageVerbindung.freigeben();
            assertThat(lies(transaktion).tenant()).as("eine laufende Transaktion behält ihre Verbindung")
                    .isEqualTo(AHRENBERG.toString());
            transaktion.rollback();
            transaktion.setAutoCommit(true);
        }
        AnfrageVerbindung.ende();
        assertThat(roh()).allMatch(Sitzung::leer);
    }

    @Test
    void ohneAnfrageZeitgrenzeOderOhneRahmenGiltJedeAusleiheEinzeln() throws SQLException {
        // Ein Läufer oder MQTT-Hörer: kein TenantFilter, also weder Rahmen noch Zeitgrenze.
        TenantContext.set(AHRENBERG);
        assertThat(geliehen().tenant()).isEqualTo(AHRENBERG.toString());
        assertThat(roh()).as("einzeln: bei der Rückgabe zurückgesetzt").allMatch(Sitzung::leer);
        assertThat(setConfigAufrufe()).isEqualTo(2);

        // Eine Anfrage, deren Zeitgrenze ausgenommen wurde: wieder einzeln (Hintergrund-Pool in der api).
        anfrage();
        AnfrageZeitgrenze.ausnahme();
        assertThat(geliehen().tenant()).isEqualTo(AHRENBERG.toString());
        assertThat(roh()).allMatch(Sitzung::leer);
        assertThat(setConfigAufrufe()).isEqualTo(4);
    }

    @Test
    void einGeschlossenerGriffIstGeschlossen() throws SQLException {
        anfrage();
        TenantContext.set(AHRENBERG);
        Connection c = ds.getConnection();
        c.close();
        c.close();
        assertThat(c.isClosed()).isTrue();
        assertThatThrownBy(() -> c.createStatement()).isInstanceOf(SQLException.class);
        assertThat(geliehen().tenant()).as("die Bindung dient weiter").isEqualTo(AHRENBERG.toString());
    }

    // ------------------------------------------------------------------ Hilfen

    private static void anfrage() {
        AnfrageZeitgrenze.start();
        AnfrageVerbindung.beginn();
    }

    private static Sitzung geliehen() throws SQLException {
        try (Connection c = ds.getConnection()) {
            return lies(c);
        }
    }

    /** Alle Verbindungen des Pools zugleich, am Wrapper vorbei. */
    private static List<Sitzung> roh() throws SQLException {
        List<Connection> alle = new ArrayList<>();
        try {
            for (int i = 0; i < POOL; i++) {
                alle.add(pool.getConnection());
            }
            List<Sitzung> sitzungen = new ArrayList<>();
            Set<Integer> pids = new HashSet<>();
            for (Connection c : alle) {
                Sitzung s = lies(c);
                sitzungen.add(s);
                pids.add(s.pid());
            }
            assertThat(pids).as("jede Verbindung des Pools genau einmal").hasSize(POOL);
            return sitzungen;
        } finally {
            for (Connection c : alle) {
                c.close();
            }
        }
    }

    private static Sitzung lies(Connection c) throws SQLException {
        try (Statement s = c.createStatement(); ResultSet rs = s.executeQuery("SELECT pg_backend_pid(), "
                + "current_setting('app.tenant_id', true), current_setting('app.zugriff', true), "
                + "current_setting('app.standort_ids', true)")) {
            rs.next();
            return new Sitzung(rs.getInt(1), leer(rs.getString(2)), leer(rs.getString(3)), leer(rs.getString(4)));
        }
    }

    private static String leer(String s) {
        return s == null ? "" : s;
    }

    private static Connection admin() throws SQLException {
        return DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    private static void zaehlerLeeren() throws SQLException {
        try (Connection c = admin(); Statement s = c.createStatement()) {
            s.execute("SELECT pg_stat_statements_reset()");
        }
    }

    /** Wie oft die Pool-Rolle {@code set_config} an die Datenbank geschickt hat. */
    private static int setConfigAufrufe() throws SQLException {
        try (Connection c = admin(); Statement s = c.createStatement(); ResultSet rs = s.executeQuery(
                "SELECT coalesce(sum(calls), 0) FROM pg_stat_statements s JOIN pg_roles r ON r.oid = s.userid "
                        + "WHERE r.rolname = '" + ROLLE + "' AND s.query ILIKE '%set_config%'")) {
            rs.next();
            return rs.getInt(1);
        }
    }

    private static void rechtAufSetConfig(boolean gewaehrt) throws SQLException {
        try (Connection c = admin(); Statement s = c.createStatement()) {
            s.execute((gewaehrt ? "GRANT" : "REVOKE") + " EXECUTE ON FUNCTION set_config(text, text, boolean) "
                    + (gewaehrt ? "TO" : "FROM") + " PUBLIC");
        }
    }
}
