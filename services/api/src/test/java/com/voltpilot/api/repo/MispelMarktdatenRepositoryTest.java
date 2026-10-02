package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.voltpilot.api.repo.MispelMarktdatenRepository.AwHerkunft;
import com.voltpilot.api.repo.MispelMarktdatenRepository.AwViertelstunde;
import com.voltpilot.api.repo.MispelMarktdatenRepository.AwZeitraum;
import com.voltpilot.api.repo.MispelMarktdatenRepository.SpotViertelstunde;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.Map;
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
 * MiSpeL MP-7: der Lesezugriff auf SP¼, AW¼ &gt; 0 und den Jahresmarktwert - gelesen als
 * {@code voltpilot_app}, also auch der Beweis für die {@code GRANT SELECT} der Migration.
 *
 * <p>Probe 15.06.2026 08:00-11:00 UTC (zwölf Viertelstunden): Liste der UeNB für 08:00-09:00
 * als Viertelstunden, 09:00-10:00 als EINE Stundenzeile (Regel {@code stunden_1}), 10:00-11:00 ohne
 * Liste - dort greift der Rückfall auf SP¼, und 10:45 hat weder Liste noch Preis. Die Werte
 * stammen aus dem echten Tag (UeNB-Liste und energy-charts, Fixtures in services/market-data):
 * 09:45 UTC ist die erste Viertelstunde mit negativem Preis und "Nein".
 */
@Testcontainers(disabledWithoutDocker = true)
class MispelMarktdatenRepositoryTest {

    private static final Instant T0 = Instant.parse("2026-06-15T08:00:00Z");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static MispelMarktdatenRepository repo;

    @BeforeAll
    static void migrateAndSeed() {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of(
                        "appDbUser", "voltpilot_app", "appDbPassword", "pw_app",
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "pw_admin"))
                .load()
                .migrate();

        JdbcTemplate su = new JdbcTemplate(dataSource(POSTGRES.getUsername(), POSTGRES.getPassword()));
        // SP: 08:00-10:00 als zwei Stundenpreise (vor dem 15-min-Day-Ahead nicht mehr üblich, aber
        // die Lückenregel muss sie ausrollen), 10:00-10:45 als Viertelstunden, 10:45 fehlt.
        price(su, "PT60M", T0, "41.20");
        price(su, "PT15M", T0.plusSeconds(3600), "12.00");
        price(su, "PT15M", T0.plusSeconds(3600 + 900), "3.10");
        price(su, "PT15M", T0.plusSeconds(3600 + 1800), "0.00");
        price(su, "PT15M", T0.plusSeconds(3600 + 2700), "-0.01");
        price(su, "PT15M", T0.plusSeconds(7200), "-5.00");
        price(su, "PT15M", T0.plusSeconds(7200 + 900), "0.00");
        price(su, "PT15M", T0.plusSeconds(7200 + 1800), "8.50");

        for (int q = 0; q < 4; q++) {
            aw(su, "viertelstunde", T0.plusSeconds(q * 900L), "PT15M", true);
        }
        aw(su, "viertelstunde", T0.plusSeconds(3600), "PT15M", true);
        aw(su, "viertelstunde", T0.plusSeconds(3600 + 900), "PT15M", true);
        aw(su, "viertelstunde", T0.plusSeconds(3600 + 1800), "PT15M", true);
        aw(su, "viertelstunde", T0.plusSeconds(3600 + 2700), "PT15M", false);
        aw(su, "stunden_1", T0.plusSeconds(3600), "PT60M", false);

        su.update("INSERT INTO annual_market_value (year, technology, value_ct_kwh, provisional) "
                + "VALUES (2025, 'solar', 4.508, false), (2026, 'solar', 4.900, true)");

        repo = new MispelMarktdatenRepository(
                new JdbcTemplate(dataSource("voltpilot_app", "pw_app")));
    }

    @Test
    void spotmarktpreisJeViertelstundeInCtKwhLueckeBleibtNull() {
        var sp = repo.spotmarktpreise("DE-LU", T0, T0.plusSeconds(3 * 3600));
        assertThat(sp).hasSize(12);
        // die Stundenzeile 08:00 gilt für ihre vier Viertelstunden
        assertThat(sp.subList(0, 4)).extracting(SpotViertelstunde::spCtKwh)
                .allSatisfy(v -> assertThat(v).isEqualByComparingTo("4.120"));
        assertThat(sp.get(7).spCtKwh()).isEqualByComparingTo("-0.001");
        assertThat(sp.get(8).spCtKwh()).isEqualByComparingTo("-0.500");
        assertThat(sp.get(11).spCtKwh()).as("10:45 ohne Preis ist unbekannt, nicht 0").isNull();
        assertThat(sp.get(11).beginn()).isEqualTo(T0.plusSeconds(2 * 3600 + 2700));
    }

    @Test
    void awListeGewinntRueckfallNurOhneListeUnbekanntOhneBeides() {
        AwZeitraum z = repo.awZeiten("viertelstunde", "DE-LU", T0, T0.plusSeconds(3 * 3600));
        assertThat(z.vorlaeufig()).isTrue();
        assertThat(z.viertelstunden()).hasSize(12);
        assertThat(z.viertelstunden().subList(0, 8)).extracting(AwViertelstunde::herkunft)
                .containsOnly(AwHerkunft.UENB_LISTE);
        // 09:45: Liste "Nein" (SP -0,01 €/MWh)
        assertThat(z.viertelstunden().get(7).awGroesserNull()).isFalse();
        // ohne Liste: SP < 0 -> keine Prämie, SP = 0 -> Prämie (nur negative Preise nullen)
        assertThat(z.viertelstunden().subList(8, 11)).extracting(AwViertelstunde::herkunft)
                .containsOnly(AwHerkunft.RUECKFALL_SPOT);
        assertThat(z.viertelstunden().subList(8, 11)).extracting(AwViertelstunde::awGroesserNull)
                .containsExactly(false, true, true);
        assertThat(z.viertelstunden().get(11).herkunft()).isEqualTo(AwHerkunft.UNBEKANNT);
        assertThat(z.viertelstunden().get(11).awGroesserNull()).isNull();
    }

    @Test
    void vollstaendigeListeIstNichtVorlaeufig() {
        AwZeitraum z = repo.awZeiten("viertelstunde", "DE-LU", T0, T0.plusSeconds(2 * 3600));
        assertThat(z.vorlaeufig()).isFalse();
        assertThat(z.viertelstunden()).extracting(AwViertelstunde::awGroesserNull)
                .containsExactly(true, true, true, true, true, true, true, false);
    }

    @Test
    void stundenzeileGiltFuerIhreVierViertelstunden() {
        AwZeitraum z = repo.awZeiten("stunden_1", "DE-LU",
                T0.plusSeconds(3600 + 900), T0.plusSeconds(2 * 3600));
        assertThat(z.vorlaeufig()).isFalse();
        assertThat(z.viertelstunden()).hasSize(3).extracting(AwViertelstunde::awGroesserNull)
                .containsOnly(false);
    }

    @Test
    void jahresmarktwertMitVorlaeufigkeitUndOhneWert() {
        assertThat(repo.jahresmarktwert(2025, "solar")).get()
                .satisfies(j -> {
                    assertThat(j.ctKwh()).isEqualByComparingTo(new BigDecimal("4.508"));
                    assertThat(j.vorlaeufig()).isFalse();
                    assertThat(j.quelle()).isEqualTo("netztransparenz");
                });
        assertThat(repo.jahresmarktwert(2026, "solar")).get()
                .extracting(MispelMarktdatenRepository.Jahresmarktwert::vorlaeufig).isEqualTo(true);
        assertThat(repo.jahresmarktwert(2024, "solar")).isEmpty();
    }

    @Test
    void unbekannteRegelUndSchiefesRasterWerdenAbgewiesen() {
        assertThatThrownBy(() -> repo.awZeiten("stunden_5", "DE-LU", T0, T0.plusSeconds(900)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> repo.spotmarktpreise("DE-LU", T0.plusSeconds(60), T0.plusSeconds(900)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void checkKenntGenauDieRegelnDesLesers() {
        JdbcTemplate su = new JdbcTemplate(dataSource(POSTGRES.getUsername(), POSTGRES.getPassword()));
        String check = su.queryForObject(
                "SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c "
                        + "WHERE c.conrelid = 'eeg_aw_zeit'::regclass AND c.contype = 'c' "
                        + "AND pg_get_constraintdef(c.oid) LIKE '%regel%'", String.class);
        for (String regel : MispelMarktdatenRepository.REGELN) {
            assertThat(check).contains("'" + regel + "'");
        }
        assertThatThrownBy(() -> aw(su, "stunden_5", T0, "PT60M", true))
                .hasMessageContaining("eeg_aw_zeit_regel_check");
    }

    private static void price(JdbcTemplate su, String resolution, Instant ts, String eurMwh) {
        su.update("INSERT INTO day_ahead_prices (bidding_zone, resolution, ts, price_eur_mwh, currency) "
                + "VALUES ('DE-LU', ?, ?, ?, 'EUR')",
                resolution, java.sql.Timestamp.from(ts), new BigDecimal(eurMwh));
    }

    private static void aw(JdbcTemplate su, String regel, Instant ts, String aufloesung, boolean ja) {
        su.update("INSERT INTO eeg_aw_zeit (regel, ts, aufloesung, aw_groesser_null) VALUES (?, ?, ?, ?)",
                regel, java.sql.Timestamp.from(ts), aufloesung, ja);
    }

    private static PGSimpleDataSource dataSource(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
