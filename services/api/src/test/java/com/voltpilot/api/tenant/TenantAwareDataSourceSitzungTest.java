package com.voltpilot.api.tenant;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.zugriff.ZugriffContext;
import com.voltpilot.api.zugriff.ZugriffContext.Zugang;
import com.voltpilot.api.zugriff.ZugriffContext.Zugriff;
import com.voltpilot.api.zugriff.ZugriffRepository.Zeile;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Sitzungs-Einstellungen je Verbindung (UEMS AP-03 IP-4): {@link TenantAwareDataSource} setzt {@code app.tenant_id},
 * {@code app.zugriff} und {@code app.standort_ids} beim Ausleihen und setzt alle drei beim Zurückgeben zurück — geprüft
 * an EINER wiederverwendeten Verbindung (ein Pool mit genau einer Verbindung, dieselbe {@code pg_backend_pid()}).
 *
 * <p>„Roh" liest dieselbe Verbindung am Wrapper vorbei — das, was ein Ausleiher ohne das Setzen erben würde. Die
 * Einstellungen sind Platzhalter-Variablen, die jede Rolle setzen darf; der Test braucht deshalb keine Migration.
 */
@Testcontainers(disabledWithoutDocker = true)
class TenantAwareDataSourceSitzungTest {

    private static final UUID AHRENBERG = UUID.fromString("a0000000-0000-0000-0000-000000000001");
    private static final UUID NORDWIND = UUID.fromString("b0000000-0000-0000-0000-000000000001");
    private static final UUID ST1 = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
    private static final UUID ST2 = UUID.fromString("00000000-0000-0000-0000-0000000000a2");
    private static final Instant JETZT = Instant.parse("2026-10-20T08:15:00Z");
    private static final Sitzung LEER = new Sitzung(0, "", "", "");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static HikariDataSource pool;
    private static TenantAwareDataSource ds;

    private record Sitzung(int pid, String tenant, String zugriff, String standortIds) {
        Sitzung mitPid(int p) {
            return new Sitzung(p, tenant, zugriff, standortIds);
        }
    }

    @BeforeAll
    static void pool() {
        HikariConfig c = new HikariConfig();
        c.setJdbcUrl(POSTGRES.getJdbcUrl());
        c.setUsername(POSTGRES.getUsername());
        c.setPassword(POSTGRES.getPassword());
        c.setMaximumPoolSize(1);
        c.setMinimumIdle(1);
        pool = new HikariDataSource(c);
        ds = new TenantAwareDataSource(pool);
    }

    @AfterAll
    static void zu() {
        pool.close();
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        ZugriffContext.clear();
    }

    @Test
    void jedeAusleiheSetztIhreEinstellungenUndDieRueckgabeSetztAlleDreiZurueck() throws SQLException {
        int pid = roh().pid();

        TenantContext.set(AHRENBERG);
        ZugriffContext.set(claudia());
        assertThat(geliehen()).as("Claudia, Leserin an zwei Standorten")
                .isEqualTo(new Sitzung(pid, AHRENBERG.toString(), "standorte", "{" + ST1 + "," + ST2 + "}"));
        assertThat(roh()).as("nach der Rückgabe").isEqualTo(LEER.mitPid(pid));

        TenantContext.set(NORDWIND);
        ZugriffContext.set(jonas(NORDWIND));
        assertThat(geliehen()).as("Jonas, Kundenadministrator")
                .isEqualTo(new Sitzung(pid, NORDWIND.toString(), "unternehmen", "{}"));
        assertThat(roh()).as("nach der Rückgabe").isEqualTo(LEER.mitPid(pid));

        TenantContext.set(AHRENBERG);
        ZugriffContext.set(new Zugriff("sub-lena", Konto.PLATTFORM, AHRENBERG, Zugang.UMSCHALTER, List.of(), JETZT));
        assertThat(geliehen()).as("Plattform am Umschalter (X-Tenant-Id, bis IP-8)")
                .isEqualTo(new Sitzung(pid, AHRENBERG.toString(), "unternehmen", "{}"));

        TenantContext.set(AHRENBERG);
        ZugriffContext.set(new Zugriff("sub-jonas", Konto.BENUTZER, AHRENBERG, Zugang.KONTO, List.of(), JETZT));
        assertThat(geliehen()).as("Kundenkonto ohne wirksame Zuweisung: der engste Zaun")
                .isEqualTo(new Sitzung(pid, AHRENBERG.toString(), "standorte", "{}"));

        TenantContext.clear();
        ZugriffContext.clear();
        assertThat(geliehen()).as("ohne Kontext (Job, Admin-Route)").isEqualTo(LEER.mitPid(pid));
    }

    @Test
    void derZugriffGiltNurInSeinemKundenbereich() throws SQLException {
        int pid = roh().pid();

        TenantContext.set(NORDWIND);
        ZugriffContext.set(claudia());
        assertThat(geliehen()).as("ein Hörer schaltet im Anfrage-Thread auf einen anderen Mandanten")
                .isEqualTo(new Sitzung(pid, NORDWIND.toString(), "", ""));

        TenantContext.clear();
        assertThat(geliehen()).as("ohne Mandant nie ein Zugriff").isEqualTo(LEER.mitPid(pid));
    }

    /**
     * Scheitert das Zurücksetzen (die Verbindung kommt mit abgebrochener Transaktion zurück), trägt die rohe Sitzung
     * noch die Werte der vorigen Ausleihe — die nächste Ausleihe setzt trotzdem ihre eigenen. Das Setzen beim Ausleihen
     * ist die Garantie, das Zurücksetzen der Gürtel dazu.
     */
    @Test
    void auchWennDasZuruecksetzenScheitertErbtDieNaechsteAusleiheNichts() throws SQLException {
        TenantContext.set(AHRENBERG);
        ZugriffContext.set(claudia());
        try (Connection c = ds.getConnection()) {
            c.setAutoCommit(false);
            try (Statement s = c.createStatement()) {
                s.execute("SELECT 1 / 0");
            } catch (SQLException erwartet) {
                // die Transaktion ist abgebrochen: das Zurücksetzen beim close() scheitert still
            }
        }
        TenantContext.clear();
        ZugriffContext.clear();
        Sitzung roh = roh();
        assertThat(roh.tenant()).as("roh: das Zurücksetzen lief in die abgebrochene Transaktion")
                .isEqualTo(AHRENBERG.toString());

        TenantContext.set(NORDWIND);
        ZugriffContext.set(peter(NORDWIND));
        assertThat(geliehen()).isEqualTo(new Sitzung(roh.pid(), NORDWIND.toString(), "standorte", "{" + ST2 + "}"));

        TenantContext.clear();
        ZugriffContext.clear();
        assertThat(geliehen()).isEqualTo(LEER.mitPid(roh.pid()));
    }

    // ------------------------------------------------------------------ Hilfen

    private static Sitzung geliehen() throws SQLException {
        try (Connection c = ds.getConnection()) {
            return lies(c);
        }
    }

    private static Sitzung roh() throws SQLException {
        try (Connection c = pool.getConnection()) {
            return lies(c);
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

    private static Zeile zeile(Rolle rolle, UUID standort, String kurzzeichen) {
        return new Zeile(UUID.randomUUID(), "sub", rolle, standort, kurzzeichen, null, null, JETZT.minusSeconds(86_400),
                null, null, ZoneId.of("Europe/Berlin"), null, null, null, null);
    }

    private static Zugriff claudia() {
        return new Zugriff("sub-claudia", Konto.BENUTZER, AHRENBERG, Zugang.KONTO,
                List.of(zeile(Rolle.LESER, ST2, "ST-2"), zeile(Rolle.LESER, ST1, "ST-1")), JETZT);
    }

    private static Zugriff jonas(UUID tenant) {
        return new Zugriff("sub-jonas", Konto.BENUTZER, tenant, Zugang.KONTO,
                List.of(zeile(Rolle.KUNDENADMINISTRATOR, null, null)), JETZT);
    }

    private static Zugriff peter(UUID tenant) {
        return new Zugriff("sub-peter", Konto.BENUTZER, tenant, Zugang.KONTO,
                List.of(zeile(Rolle.BEARBEITER, ST2, "ST-2")), JETZT);
    }
}
