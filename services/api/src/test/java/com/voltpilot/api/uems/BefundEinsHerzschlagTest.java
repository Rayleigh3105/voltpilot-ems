package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Befund 1 (vp-alerting-konzept-m1 §3.1, Alerting Scheibe 1): eine Box, die lebt und sich meldet
 * (Herzschlag), aber keine Messwerte liefert, darf der Lücken-Melder NICHT mehr als „meldet sich
 * nicht" festhalten - der Herzschlag ({@code device_status_seen_at}) ist seit {@link
 * LueckenMelder#boxAusHerzschlag} eine WEITERE Eingangsquelle neben der Ankunft von Daten
 * ({@code telemetry}/{@code device_measurement_sample}), dieselbe Grundlage wie die Live-Flächen
 * und die Übersicht (`P/kundenUebersicht.ts`).
 *
 * <p>Eigene, kleine Datenbank statt {@code UemsLueckenMelderTest}s choreografierter Zeitachse: die
 * einzige Frage hier ist "Herzschlag ALLEIN reicht, Telemetrie ALLEIN reicht (unverändert)".
 */
@Testcontainers(disabledWithoutDocker = true)
class BefundEinsHerzschlagTest {

    private static final String APP = "voltpilot_app";
    private static final String ADMIN = "voltpilot_admin";
    private static final String PW = "befund1_test_pw";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate admin;
    private static LueckenMelder melder;

    @BeforeAll
    static void migrateUndMelder() {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP, "appDbPassword", PW, "adminDbUser", ADMIN,
                        "adminDbPassword", PW))
                .load()
                .migrate();
        admin = new JdbcTemplate(ds(ADMIN, PW));
        melder = new LueckenMelder(admin, new MeasurementCatalog(new ObjectMapper()), 50, 40, 20_000);
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }

    private record Box(UUID tenant, UUID site, UUID device) {}

    private static Box box(String name) {
        UUID tenant = UUID.randomUUID();
        UUID site = UUID.randomUUID();
        UUID device = UUID.randomUUID();
        admin.update("INSERT INTO tenant (id, name) VALUES (?, ?)", tenant, name);
        admin.update("INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, 'Halle', 'DE-LU')", site,
                tenant);
        admin.update("INSERT INTO device (id, tenant_id, site_id, external_ref, kind, status) "
                + "VALUES (?, ?, ?, ?, 'inverter', 'claimed')", device, tenant, site, "ref-" + device);
        return new Box(tenant, site, device);
    }

    private static void herzschlag(UUID device, Instant zeitpunkt) {
        admin.update("UPDATE device SET device_status_seen_at = ? WHERE id = ?", Timestamp.from(zeitpunkt), device);
    }

    private static long offeneBoxLuecken(UUID tenant, UUID device) {
        Long n = admin.queryForObject(
                "SELECT count(*) FROM messreihe_ereignis WHERE tenant_id = ? AND device_id = ? "
                        + "AND art = 'data_gap' AND bis IS NULL",
                Long.class, tenant, device);
        return n == null ? 0 : n;
    }

    @Test
    void einHerzschlagAlleinHaeltDieBoxErreichbarOhneJeTelemetrieZuSenden() {
        Box b = box("Befund1 nur Herzschlag GmbH");
        Instant t0 = Instant.now().minus(2, ChronoUnit.DAYS);
        herzschlag(b.device(), t0);
        melder.lauf(t0); // Anlauf: holt den ersten Herzschlag als Baseline

        // Die Box heartbeatet alle fünf Minuten weiter - NIE Telemetrie, NIE eine Messwert-Probe.
        Instant jetzt = t0;
        for (int i = 0; i < 20; i++) {
            jetzt = jetzt.plusSeconds(300);
            herzschlag(b.device(), jetzt);
            melder.lauf(jetzt);
        }

        assertThat(offeneBoxLuecken(b.tenant(), b.device())).as("Befund 1: nie als 'meldet sich nicht' trotz Herzschlag").isZero();
    }

    @Test
    void ohneHerzschlagUndOhneTelemetrieWirdDieBoxWeiterhinAlsSchweigendErkannt() {
        Box b = box("Ohne jeden Eingang GmbH");
        Instant t0 = Instant.now().minus(2, ChronoUnit.DAYS);
        herzschlag(b.device(), t0);
        melder.lauf(t0); // Baseline

        Instant schweigtSeit = t0.plusSeconds(600); // über die Herzschlag-Toleranz (300 s)
        melder.lauf(schweigtSeit);

        assertThat(offeneBoxLuecken(b.tenant(), b.device()))
                .as("unverändert: schweigt die Box ganz, bleibt die Lücke bestehen").isEqualTo(1);
    }
}
