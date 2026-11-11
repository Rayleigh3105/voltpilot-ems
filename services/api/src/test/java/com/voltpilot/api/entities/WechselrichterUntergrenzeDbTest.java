package com.voltpilot.api.entities;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementSelectionService;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.EntityController;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die am Wechselrichter gelesene Entladegrenze gegen die echte Datenbank, als Laufzeitrolle {@code voltpilot_app}
 * unter RLS: der Abgleich legt den Messpunkt in den Messplan der Box, übernimmt die jüngste plausible Lesung, trägt
 * jeden Wechsel ins Änderungsprotokoll der Komponente ein und zieht die Schutzgrenze nach. Eine Anlage ohne Lesung
 * bleibt, wie sie war.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@ActiveProfiles("local")
class WechselrichterUntergrenzeDbTest {
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "untergrenze_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "untergrenze_test_pw");
        r.add("spring.flyway.placeholders.adminDbPassword", () -> "untergrenze_admin_pw");
        r.add("voltpilot.admin-datasource.password", () -> "untergrenze_admin_pw");
    }

    private static final String PUNKT = "deye.hybrid_3p.settings.battery-low-soc";
    private static final AtomicLong SEQ = new AtomicLong(1);
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Autowired WechselrichterUntergrenzeAbgleich abgleich;
    @Autowired WechselrichterUntergrenzeRepository untergrenzen;
    @Autowired EntityRegistryService registry;
    @Autowired EntityRegistryRepository registryRepo;
    @Autowired EntityController entities;
    @MockitoBean EntityRegistryPublisher registryPublisher;
    static JdbcTemplate root;

    @BeforeAll static void start() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    record Welt(UUID tenant, UUID site, UUID box, UUID speicher) {}

    /** Eine Anlage mit Speicher-Stammsatz und einer Deye-Speicherkomponente, Schutzgrenze 5 % aus dem Stammsatz. */
    private static Welt welt(String name, String brand, String family, Number socMinPct) {
        UUID tenant = root.queryForObject("INSERT INTO tenant(name) VALUES (?) RETURNING id", UUID.class, name);
        UUID site = root.queryForObject("INSERT INTO site(tenant_id,name) VALUES (?, ?) RETURNING id",
                UUID.class, tenant, name);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, tenant, site, "edge-" + name.toLowerCase().replaceAll("[^a-z0-9]", ""));
        root.update("INSERT INTO asset (tenant_id, site_id, type, device_id, capacity_kwh, max_charge_kw, "
                + "max_discharge_kw, soc_min_pct) VALUES (?, ?, 'battery', ?, 10, 5, 5, ?)", tenant, site, box,
                socMinPct);
        double guard = socMinPct == null ? 5.0 : socMinPct.doubleValue();
        UUID speicher = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "device_id, control, source_kind, entity_type, brand, family, guard_config) "
                + "VALUES (?, ?, 'battery-hybrid', 'Speicher', ?, TRUE, 'composed', 'battery-hybrid', ?, ?, "
                + "?::jsonb) RETURNING id", UUID.class, tenant, site, box, brand, family,
                "{\"limits\":{\"soc_min_pct\":" + guard + ",\"soc_max_pct\":95.0},"
                        + "\"failsafe\":{\"behavior\":\"self-consumption\"}}");
        return new Welt(tenant, site, box, speicher);
    }

    private static void lesung(Welt w, Instant zeit, Number pct, String qualitaet) {
        root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, "
                + "point_key, raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, "
                + "aggregation_kind, long_term_cadence_s) VALUES (?, now(), ?, ?, ?, ?, ?, ?, ?, '2026.10.26.1', ?, "
                + "'gauge', 900)", java.sql.Timestamp.from(zeit), w.tenant(), w.site(), w.box(), PUNKT, pct, pct,
                qualitaet, SEQ.getAndIncrement());
    }

    private static <T> T als(UUID tenant, Supplier<T> was) {
        TenantContext.set(tenant);
        try {
            return was.get();
        } finally {
            TenantContext.clear();
        }
    }

    private double schutzgrenze(Welt w) {
        String json = root.queryForObject("SELECT guard_config::text FROM measurement_point WHERE id = ?",
                String.class, w.speicher());
        try {
            return MAPPER.readTree(json).path("limits").path("soc_min_pct").asDouble();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private List<Map<String, Object>> ereignisse(Welt w) {
        return root.queryForList("SELECT from_value, to_value FROM component_change_event WHERE entity_id = ? "
                + "AND event_type = 'wr_untergrenze_gelesen' ORDER BY id", w.speicher());
    }

    private WechselrichterUntergrenze.Ergebnis abgleichen(Welt w, Instant jetzt) {
        WechselrichterUntergrenzeAbgleich.Kandidat k = abgleich.kandidaten().stream()
                .filter(c -> c.siteId().equals(w.site())).findFirst().orElseThrow();
        return als(w.tenant(), () -> abgleich.abgleichen(k, jetzt));
    }

    @Test
    void dieLesungWirdUebernommenUndJederWechselSteht() {
        Welt w = welt("Untergrenze Pilot", "deye", "hybrid_3p", null);
        Instant jetzt = Instant.now().truncatedTo(ChronoUnit.SECONDS);

        // Ohne Lesung: der Messpunkt steht im Plan der Box, sonst bleibt alles wie vorher.
        abgleichen(w, jetzt);
        assertThat(root.queryForObject("SELECT count(*) FROM device_measurement_selection WHERE device_id = ? "
                + "AND entity_id = ? AND point_key = ? AND enabled AND changed_by = ?", Integer.class, w.box(),
                w.speicher(), PUNKT, MeasurementSelectionService.UNTERGRENZE_AKTEUR)).isEqualTo(1);
        assertThat(root.queryForObject("SELECT count(*) FROM wechselrichter_untergrenze WHERE site_id = ?",
                Integer.class, w.site())).isZero();
        assertThat(schutzgrenze(w)).isEqualTo(5.0);
        // Ein zweiter Lauf legt den Punkt nicht noch einmal an.
        abgleichen(w, jetzt);
        assertThat(root.queryForObject("SELECT count(*) FROM device_measurement_selection WHERE device_id = ?",
                Integer.class, w.box())).isEqualTo(1);

        // Die Box meldet 15 %: übernommen, protokolliert, Schutzgrenze nachgezogen.
        lesung(w, jetzt.minusSeconds(120), 15, "good");
        abgleichen(w, jetzt);
        assertThat(als(w.tenant(), () -> untergrenzen.eintrag(w.site())).stand().socMinPct())
                .isEqualByComparingTo("15");
        assertThat(ereignisse(w)).hasSize(1);
        assertThat(ereignisse(w).getFirst()).containsEntry("from_value", null).containsEntry("to_value", "15");
        assertThat(schutzgrenze(w)).isEqualTo(15.0);
        assertThat(als(w.tenant(), () -> registry.socMinWirksamPct(w.site(), registryRepo.batteryAsset(w.site()))))
                .isEqualTo(15.0);

        // Die Anzeige nennt Quelle und Stand.
        EntityController.EntityDto dto = als(w.tenant(), () -> entities.list(w.site())).entities().stream()
                .filter(e -> e.id().equals(w.speicher())).findFirst().orElseThrow();
        assertThat(dto.socMin()).isNotNull();
        assertThat(dto.socMin().wirksamPct()).isEqualTo(15.0);
        assertThat(dto.socMin().quelle()).isEqualTo("wechselrichter");
        assertThat(dto.socMin().aktuell()).isTrue();

        // Dieselbe Lesung noch einmal: kein zweiter Eintrag.
        lesung(w, jetzt.minusSeconds(60), 15, "good");
        abgleichen(w, jetzt);
        assertThat(ereignisse(w)).hasSize(1);

        // Unplausibel: nicht übernommen, der letzte Wert bleibt, die Zeile nennt den Grund.
        lesung(w, jetzt.minusSeconds(30), 250, "good");
        abgleichen(w, jetzt);
        WechselrichterUntergrenzeRepository.Eintrag e = als(w.tenant(), () -> untergrenzen.eintrag(w.site()));
        assertThat(e.stand().socMinPct()).isEqualByComparingTo("15");
        assertThat(e.letzteLesungVerworfen()).isEqualTo("unplausibel");
        assertThat(schutzgrenze(w)).isEqualTo(15.0);

        // Der Kunde stellt am Wechselrichter 20 % ein, später 10 %: beide Richtungen.
        lesung(w, jetzt.minusSeconds(10), 20, "good");
        abgleichen(w, jetzt);
        assertThat(schutzgrenze(w)).isEqualTo(20.0);
        lesung(w, jetzt.minusSeconds(5), 10, "good");
        abgleichen(w, jetzt);
        assertThat(schutzgrenze(w)).isEqualTo(10.0);
        assertThat(ereignisse(w)).extracting(m -> m.get("from_value") + "->" + m.get("to_value"))
                .containsExactly("null->15", "15->20", "20->10");

        // Zwei Stunden später ohne neue Lesung: der Wert gilt weiter, nur nicht mehr aktuell - nie zurück auf 5 %.
        Instant spaeter = jetzt.plusSeconds(7200);
        abgleichen(w, spaeter);
        assertThat(als(w.tenant(), () -> untergrenzen.eintrag(w.site())).stand().socMinPct())
                .isEqualByComparingTo("10");
        assertThat(WechselrichterUntergrenze.aktuell(als(w.tenant(), () -> untergrenzen.eintrag(w.site())).stand(),
                spaeter)).isFalse();
        assertThat(schutzgrenze(w)).isEqualTo(10.0);
    }

    @Test
    void einHoehererVoltPilotWertBleibtAlsReserve() {
        Welt w = welt("Untergrenze Reserve", "deye", "hybrid_3p", 30);
        Instant jetzt = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        lesung(w, jetzt.minusSeconds(60), 15, "good");
        abgleichen(w, jetzt);
        assertThat(schutzgrenze(w)).isEqualTo(30.0);
        assertThat(als(w.tenant(), () -> registry.socMinWirksamPct(w.site(), registryRepo.batteryAsset(w.site()))))
                .isEqualTo(30.0);
        EntityController.EntityDto dto = als(w.tenant(), () -> entities.list(w.site())).entities().stream()
                .filter(e -> e.id().equals(w.speicher())).findFirst().orElseThrow();
        assertThat(dto.socMin().quelle()).isEqualTo("voltpilot");
        assertThat(dto.socMin().wirksamPct()).isEqualTo(30.0);
    }

    @Test
    void eineVeralteteErsteLesungWirdNichtUebernommen() {
        Welt w = welt("Untergrenze Alt", "deye", "hybrid_3p", null);
        Instant jetzt = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        lesung(w, jetzt.minusSeconds(2 * 3600), 15, "good");
        abgleichen(w, jetzt);
        assertThat(root.queryForObject("SELECT count(*) FROM wechselrichter_untergrenze WHERE site_id = ?",
                Integer.class, w.site())).isZero();
        assertThat(schutzgrenze(w)).isEqualTo(5.0);
    }

    @Test
    void andereHerstellerSindKeineKandidatenUndBleibenUnveraendert() {
        Welt w = welt("Untergrenze Fremd", "huawei", "luna2000", null);
        assertThat(abgleich.kandidaten()).noneMatch(k -> k.siteId().equals(w.site()));
        abgleich.lauf(Instant.now());
        assertThat(root.queryForObject("SELECT count(*) FROM device_measurement_selection WHERE device_id = ?",
                Integer.class, w.box())).isZero();
        assertThat(schutzgrenze(w)).isEqualTo(5.0);
        EntityController.EntityDto dto = als(w.tenant(), () -> entities.list(w.site())).entities().stream()
                .filter(e -> e.id().equals(w.speicher())).findFirst().orElseThrow();
        assertThat(dto.socMin()).isNull();
    }

    @Test
    void eineAbwahlVonHandBleibtStehen() {
        Welt w = welt("Untergrenze Abwahl", "deye", "hybrid_3p", null);
        Instant jetzt = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        abgleichen(w, jetzt);
        root.update("UPDATE device_measurement_selection SET enabled = false, disabled_at = now() "
                + "WHERE device_id = ?", w.box());
        abgleichen(w, jetzt);
        assertThat(root.queryForObject("SELECT count(*) FROM device_measurement_selection WHERE device_id = ? "
                + "AND enabled", Integer.class, w.box())).isZero();
    }
}
