package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Bestandsnachweis des Standort-Zauns (UEMS AP-03 IP-5, {@code V20260915190000}): jedes heutige Konto sieht nach der
 * Migration auf jeder Standort-Tabelle genau die Zeilen, die es davor sah.
 *
 * <p>„Heutige Konten" sind nach der Bestandsübernahme E12 die Kundenadministratoren ({@code unternehmen}), dazu der
 * Umschalter der Plattform ({@code unternehmen}) und alles ohne Zugriff: Jobs, Takt, Start-Läufer, {@code /admin/**},
 * die Plattform ohne Kopf ({@code NULL} auf einer frischen Verbindung, leer nach dem Zurücksetzen). Welches Konto
 * welche Einstellungen bekommt, beweisen {@code TenantAwareDataSourceSitzungTest} und {@code ZugriffZaunApiTest}.
 *
 * <p>Vorher ist der Stand direkt vor der Migration (Flyway {@code target}) mit dem Dev-Seed und einem Kundenbereich,
 * der alles hat, was der Zaun unterscheidet: drei Standorte, eine Anlage mit, eine ohne und eine mit heute gewechselter
 * Zuordnung, Gebäude mit Bereich und beendeter Zuordnung, Messkomponenten und Geräte. Verglichen wird je Kundenbereich und
 * Tabelle die Menge der Zeilen-Kennungen.
 */
@Testcontainers(disabledWithoutDocker = true)
class SiteScopeBestandTest {

    private static final String DIESE = "20260915190000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final List<String> TABELLEN =
            List.of("site", "standort", "anlage_standort", "ort", "measurement_point", "device");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private record Variante(String name, String zugriff, String standortIds) {}

    private static final List<Variante> HEUTIGE_KONTEN = List.of(
            new Variante("ohne Zugriff, frische Verbindung", null, null),
            new Variante("ohne Zugriff, zurückgesetzt", "", ""),
            new Variante("Kundenadministrator", "unternehmen", "{}"),
            new Variante("unternehmensweit mit Standort-Kennungen", "unternehmen", "{" + UUID.randomUUID() + "}"));

    private static final String KB = "b5000000-0000-0000-0000-000000000001";

    private static Map<String, List<String>> vorher;

    @BeforeAll
    static void bauenUndMigrieren() throws Exception {
        flyway().target(letzteFassungVorDieser()).load().migrate();
        assertThat(richtlinien()).as("vorher gibt es den Zaun nicht").isZero();
        kundenbereichMitStandorten();
        vorher = sicht(new Variante("vorher, nur Mandant", null, null));
        assertThat(sicht(new Variante("vorher, mit IP-4-Einstellungen", "standorte", "{}"))).isEqualTo(vorher);
        flyway().load().migrate();
    }

    @Test
    void derZaunIstNachherDaUndHaetteEtwasZuFiltern() throws Exception {
        assertThat(richtlinien()).isEqualTo(TABELLEN.size());
        Map<String, List<String>> eng = sicht(new Variante("standortbeschränkt ohne Standort", "standorte", "{}"));
        assertThat(vorher.keySet()).allSatisfy(k -> assertThat(vorher.get(k)).as(k).isNotEmpty());
        assertThat(eng.values()).allSatisfy(zeilen -> assertThat(zeilen).isEmpty());
    }

    @Test
    void jedesHeutigeKontoSiehtJeKundenbereichUndTabelleDieselbenZeilenWieVorher() throws Exception {
        for (Variante v : HEUTIGE_KONTEN) {
            assertThat(sicht(v)).as(v.name()).isEqualTo(vorher);
        }
    }

    // ------------------------------------------------------------------ Hilfen

    /** Je „Kundenbereich Tabelle" die sortierten Kennungen, die die App-Rolle mit diesen Einstellungen sieht. */
    private static Map<String, List<String>> sicht(Variante v) throws Exception {
        Map<String, List<String>> aus = new TreeMap<>();
        for (String tenant : kundenbereiche()) {
            for (String tabelle : TABELLEN) {
                List<String> ids = new ArrayList<>();
                try (Connection c = ds(APP_USER, APP_PW).getConnection()) {
                    try (PreparedStatement ps = c.prepareStatement("SELECT set_config('app.tenant_id', ?, false), "
                            + "set_config('app.zugriff', ?, false), set_config('app.standort_ids', ?, false)")) {
                        ps.setString(1, tenant);
                        ps.setString(2, v.zugriff());
                        ps.setString(3, v.standortIds());
                        ps.execute();
                    }
                    try (Statement s = c.createStatement();
                            ResultSet rs = s.executeQuery("SELECT id::text FROM " + tabelle + " ORDER BY id")) {
                        while (rs.next()) {
                            ids.add(rs.getString(1));
                        }
                    }
                }
                if (!ids.isEmpty() || tenant.equals(KB)) {
                    aus.put(tenant + " " + tabelle, ids);
                }
            }
        }
        return aus;
    }

    private static List<String> kundenbereiche() throws Exception {
        List<String> aus = new ArrayList<>();
        try (Connection c = root(); Statement s = c.createStatement();
                ResultSet rs = s.executeQuery("SELECT id::text FROM tenant ORDER BY id")) {
            while (rs.next()) {
                aus.add(rs.getString(1));
            }
        }
        return aus;
    }

    private static long richtlinien() throws Exception {
        try (Connection c = root(); Statement s = c.createStatement();
                ResultSet rs = s.executeQuery("SELECT count(*) FROM pg_policies WHERE policyname = 'site_scope'")) {
            rs.next();
            return rs.getLong(1);
        }
    }

    private static void kundenbereichMitStandorten() throws Exception {
        String t = "'" + KB + "'";
        String heute = "(now() AT TIME ZONE 'Europe/Berlin')::date";
        try (Connection c = root(); Statement s = c.createStatement()) {
            s.execute("INSERT INTO tenant (id, name) VALUES (" + t + ", 'Bestand mit Standorten')");
            s.execute("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (" + t + ", 'Bestand', 'Europe/Berlin')");
            s.execute("INSERT INTO standort (id, tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                    + "SELECT v.id::uuid, u.tenant_id, u.id, v.name, v.kz, 'Europe/Berlin', 'aktiv' FROM unternehmen u, "
                    + "(VALUES ('b5000000-0000-0000-0001-000000000001', 'Werk A', 'ST-1'), "
                    + "('b5000000-0000-0000-0001-000000000002', 'Werk B', 'ST-2'), "
                    + "('b5000000-0000-0000-0001-000000000003', 'Werk C', 'ST-3')) v(id, name, kz) "
                    + "WHERE u.tenant_id = " + t);
            s.execute("INSERT INTO site (id, tenant_id, name) VALUES "
                    + "('b5000000-0000-0000-0002-000000000001', " + t + ", 'mit Standort'), "
                    + "('b5000000-0000-0000-0002-000000000002', " + t + ", 'heute umgezogen'), "
                    + "('b5000000-0000-0000-0002-000000000003', " + t + ", 'ohne Standort')");
            s.execute("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab, gueltig_bis) VALUES "
                    + "(" + t + ", 'b5000000-0000-0000-0002-000000000001', 'b5000000-0000-0000-0001-000000000001', "
                    + "'2024-01-01', NULL), "
                    + "(" + t + ", 'b5000000-0000-0000-0002-000000000002', 'b5000000-0000-0000-0001-000000000001', "
                    + "'2024-01-01', " + heute + " - 1), "
                    + "(" + t + ", 'b5000000-0000-0000-0002-000000000002', 'b5000000-0000-0000-0001-000000000002', "
                    + heute + ", NULL)");
            s.execute("INSERT INTO ort (id, tenant_id, art, name, kurzzeichen, zustand) VALUES "
                    + "('b5000000-0000-0000-0003-000000000001', " + t + ", 'gebaeude', 'Halle', 'G-1', 'aktiv'), "
                    + "('b5000000-0000-0000-0003-000000000002', " + t + ", 'bereich', 'Halle Nord', 'B-1', 'aktiv'), "
                    + "('b5000000-0000-0000-0003-000000000003', " + t + ", 'gebaeude', 'Lager', 'G-2', 'aktiv')");
            s.execute("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab, gueltig_bis) VALUES "
                    + "(" + t + ", 'b5000000-0000-0000-0003-000000000001', 'b5000000-0000-0000-0001-000000000001', "
                    + "'2024-01-01', NULL), "
                    + "(" + t + ", 'b5000000-0000-0000-0003-000000000003', 'b5000000-0000-0000-0001-000000000003', "
                    + "'2024-01-01', " + heute + " - 1)");
            s.execute("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_ort_id, gueltig_ab) VALUES (" + t
                    + ", 'b5000000-0000-0000-0003-000000000002', 'b5000000-0000-0000-0003-000000000001', '2024-01-01')");
            s.execute("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type) VALUES "
                    + "(" + t + ", 'b5000000-0000-0000-0002-000000000001', 'grid-meter', 'Zähler A', 'grid-meter'), "
                    + "(" + t + ", 'b5000000-0000-0000-0002-000000000002', 'grid-meter', 'Zähler umgezogen', 'grid-meter'), "
                    + "(" + t + ", 'b5000000-0000-0000-0002-000000000003', 'grid-meter', 'Zähler ohne', 'grid-meter')");
            s.execute("INSERT INTO device (tenant_id, site_id, external_ref) VALUES "
                    + "(" + t + ", 'b5000000-0000-0000-0002-000000000001', 'bestand-mit'), "
                    + "(" + t + ", 'b5000000-0000-0000-0002-000000000002', 'bestand-umgezogen'), "
                    + "(" + t + ", 'b5000000-0000-0000-0002-000000000003', 'bestand-ohne')");
        }
    }

    private static String letzteFassungVorDieser() {
        MigrationVersion diese = MigrationVersion.fromVersion(DIESE);
        return Arrays.stream(flyway().load().info().all())
                .map(MigrationInfo::getVersion)
                .filter(v -> v != null && v.compareTo(diese) < 0)
                .max(Comparator.naturalOrder())
                .orElseThrow()
                .getVersion();
    }

    private static FluentConfiguration flyway() {
        return Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration", "classpath:db/dev")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "voltpilot_admin_test_pw"));
    }

    private static Connection root() throws Exception {
        return ds(POSTGRES.getUsername(), POSTGRES.getPassword()).getConnection();
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
