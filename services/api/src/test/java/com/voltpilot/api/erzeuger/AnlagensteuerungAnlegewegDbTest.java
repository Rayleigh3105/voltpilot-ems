package com.voltpilot.api.erzeuger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.tuple;

import com.voltpilot.api.entities.EntityAutoComposer;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.entities.EntityRegistryService.BackfillOutcome;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.AnlagensteuerungDto;
import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
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
 * UEMS EZ-20: welche Komponenten eine reine Erzeugeranlage (Gore Pleinfeld, „Neue Halle“) nach dem Anlege-Weg
 * Anlage anlegen → Box verbinden → Steuerung verbinden in der Datenbank hat. Der Aufbau zeigte darunter ein Gerät
 * „Wechselrichter“, das es nicht gibt: die Datenbank kennt keinen Wechselrichter und keinen Speicher, nur die beiden
 * beim Verbinden der Box zusammengesetzten Rollen Netz und Haus (über die Box gemessen, `device_id` = Box) und die
 * Anlagensteuerung. Den Namen „Wechselrichter“ gab erst das Portal dem Ersatzgerät für Netz und Haus
 * (`komponenten.ts` `plantModel`); diese Rollen bleiben, sie tragen Energiefluss und Cockpit.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@ActiveProfiles("local")
class AnlagensteuerungAnlegewegDbTest {
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw")
            // Ohne Timescale-Jobs: ein Job direkt nach dem Start lief einmal in eine Verklemmung mit dem Anlegen.
            .withCommand("postgres", "-c", "timescaledb.max_background_workers=0");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "anlegeweg_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "anlegeweg_test_pw");
        r.add("spring.flyway.placeholders.adminDbPassword", () -> "anlegeweg_admin_pw");
        r.add("voltpilot.admin-datasource.password", () -> "anlegeweg_admin_pw");
    }

    @Autowired DeviceRepository devices;
    @Autowired EntityAutoComposer autoCompose;
    @Autowired EntityRegistryService registry;
    @Autowired AnlagensteuerungService steuerungen;
    static JdbcTemplate root;

    @BeforeAll static void start() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    private static <T> T als(UUID tenant, Supplier<T> was) {
        TenantContext.set(tenant);
        try {
            return was.get();
        } finally {
            TenantContext.clear();
        }
    }

    private static List<Map<String, Object>> komponenten(UUID site) {
        return root.queryForList("SELECT entity_type, device_id, edge_source_id, source_kind FROM measurement_point "
                + "WHERE site_id = ? AND entity_type IS NOT NULL ORDER BY entity_type", site);
    }

    @Test
    void goreHatNachDemAnlegewegNetzHausUndDieSteuerungAberKeinenWechselrichter() {
        // 1. Anlage anlegen: eine Zeile `site`, noch keine Komponente.
        UUID tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Gore Pleinfeld') RETURNING id",
                UUID.class);
        UUID site = root.queryForObject("INSERT INTO site(tenant_id,name) VALUES (?, 'Neue Halle') RETURNING id",
                UUID.class, tenant);
        assertThat(komponenten(site)).isEmpty();

        // 2. Box verbinden: derselbe Claim und dieselbe Komposition wie `DeviceController.claim`.
        UUID box = als(tenant, () -> {
            UUID id = devices.claim(tenant, site, "edge-5mz8bdd", null).id();
            autoCompose.ensureComposed(site);
            return id;
        });
        assertThat(komponenten(site))
                .as("nur Netz und Haus, über die Box zusammengesetzt - ohne Speicher-Asset kein battery-hybrid")
                .extracting(m -> m.get("entity_type"), m -> m.get("device_id"), m -> m.get("edge_source_id"),
                        m -> m.get("source_kind"))
                .containsExactly(tuple("grid-meter", box, null, "composed"),
                        tuple("house-load", box, null, "composed"));

        // 3. Steuerung verbinden (EZ-15): Datenquelle DQ-1 an der Box, dann die Anlagensteuerung mit drei Einheiten.
        UUID quelle = root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, "
                + "adresse, geraete_ids, kadenz_s) VALUES (?, ?, 'DQ-1', 'modbus_tcp', '192.168.4.165:503', '{1}', 5) "
                + "RETURNING id", UUID.class, tenant, site);
        root.update("INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, protokoll, adresse, "
                + "effective_from) SELECT d.tenant_id, d.id, ?, d.protokoll, d.adresse, "
                + "date_trunc('minute', now()) - interval '1 day' FROM data_source d WHERE d.id = ?", box, quelle);
        root.update("UPDATE device SET supports = '[\"erzeuger_registerbild\"]'::jsonb, supports_reported_at = now() "
                + "WHERE id = ?", box);
        List<AnlagensteuerungDto.NeueEinheit> einheiten = List.of(1, 2, 3).stream()
                .map(n -> new AnlagensteuerungDto.NeueEinheit(n, "pv_wechselrichter", "WR " + n, null,
                        "Growatt MAX 125KTL3-X", new BigDecimal("125"), null))
                .toList();
        AnlagensteuerungDto.Anlagensteuerung s = als(tenant, () -> steuerungen.anlegen(site,
                new AnlagensteuerungDto.Anlegen(quelle, 1, null, "WAGO", "PFC200", null, null, null, "pv", null,
                        null, null, null, einheiten, null), "sub-einrichter"));
        assertThat(s.einheiten()).hasSize(3);

        assertThat(komponenten(site))
                .as("die Steuerung kommt als EINE Komponente ohne Box-Bindung dazu; kein Wechselrichter, kein Speicher")
                .extracting(m -> m.get("entity_type"), m -> m.get("device_id"))
                .containsExactly(tuple("anlagensteuerung", null), tuple("grid-meter", box), tuple("house-load", box));
        // Die UEMS-Geräte: Netz und Haus bekommen ohne battery-hybrid je ihr eigenes (Zähler bzw. sonstiges, Regel
        // `uems_geraet_ableiten_fuer`), die Steuerung ist der Controller; ein Wechselrichter ist keines. Die
        // Erzeugungseinheiten sind Teile der Steuerung, keine Geräte.
        assertThat(root.queryForList("SELECT geraeteart FROM geraet WHERE site_id = ? ORDER BY geraeteart",
                String.class, site)).containsExactly("controller", "sonstiges", "zaehler");

        // Der Abgleich im Takt komponiert nichts nach - und bringt keinen Platzhalter zurück.
        assertThat(als(tenant, () -> registry.bootstrapIfEligible(site))).isEqualTo(BackfillOutcome.ALREADY_V2);
        assertThat(komponenten(site)).hasSize(3);
    }
}
