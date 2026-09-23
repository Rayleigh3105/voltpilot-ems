package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import java.util.List;
import java.util.Map;
import java.util.UUID;
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
 * Die Abfrage hinter {@code registerbilder} gegen die echte Datenbank, als Laufzeitrolle
 * {@code voltpilot_app} unter RLS: ALLE heute eingebauten Karten des Controllers zählen (auch die
 * ohne Messpunkt im Plan), eine ausgebaute nicht, ein fremder Mandant nie.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@ActiveProfiles("local")
class WagoRegisterbilderDbTest {
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "wago_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "wago_test_pw");
        r.add("spring.flyway.placeholders.adminDbPassword", () -> "wago_admin_pw");
        r.add("voltpilot.admin-datasource.password", () -> "wago_admin_pw");
    }

    @Autowired WagoRegisterbilder registerbilder;
    static JdbcTemplate root;

    @BeforeAll static void start() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    private static final String VERBINDUNG =
            "{\"ip\":\"10.0.0.5\",\"port\":502,\"mb_slave_id\":1,\"base_address\":4096,\"function_code\":\"4\","
            + "\"word_order\":\"little\",\"slot\":%d}";

    private UUID karte(UUID tenant, UUID site, UUID controller, int steckplatz, String typ, boolean mitKomponente,
            boolean ausgebaut) {
        // Zeiten auf volle Minuten (CHECK *_volle_minute); eine ausgebaute Karte endete gestern.
        UUID teil = root.queryForObject("INSERT INTO geraet_teil (tenant_id, geraet_id, steckplatz, typ, eingebaut_am, "
                + "ausgebaut_am) VALUES (?, ?, ?, ?, date_trunc('minute', now()) - interval '2 days', CASE WHEN ? "
                + "THEN date_trunc('minute', now()) - interval '1 day' END) RETURNING id", UUID.class,
                tenant, controller, steckplatz, typ, ausgebaut);
        if (!mitKomponente) return null;
        return root.queryForObject("WITH m AS (INSERT INTO measurement_point (tenant_id, site_id, role, entity_type, "
                + "brand, model, template_ref, template_version, connection_json) VALUES (?, ?, 'modbus-generic', "
                + "'modbus-generic', 'wago', 'pm494_pm495_registerbild_v1', ?, 1, ?::jsonb) RETURNING id) INSERT INTO geraet_komponente (tenant_id, "
                + "geraet_id, entity_id, teil_id, gueltig_ab) SELECT ?, ?, m.id, ?, date_trunc('minute', now()) - interval '2 days' FROM m "
                + "RETURNING entity_id", UUID.class, tenant, site,
                com.voltpilot.api.templates.WagoComponentTemplateSeeder.REF, VERBINDUNG.formatted(steckplatz),
                tenant, controller, teil);
    }

    @Test
    void jedeEingebauteKarteDesControllersZaehltUndDerZaunHaelt() {
        UUID tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('WAGO-Registerbild') RETURNING id", UUID.class);
        UUID site = root.queryForObject("INSERT INTO site(tenant_id,name) VALUES (?, 'Halle 2') RETURNING id",
                UUID.class, tenant);
        UUID controller = root.queryForObject("INSERT INTO geraet (tenant_id, site_id, kennzeichen, einbau_kennzeichen, "
                + "geraeteart, hersteller, typ, eingebaut_am) VALUES (?, ?, uems_geraet_kennzeichen(?), 'PFC200', "
                + "'controller', 'WAGO', 'PFC200 750-8212', date_trunc('minute', now()) - interval '2 days') RETURNING id", UUID.class,
                tenant, site, tenant);
        karte(tenant, site, controller, 2, "750-494/000-001 (5 A)", false, false); // ohne Komponente, zählt mit
        UUID gemessen = karte(tenant, site, controller, 3, "750-495", true, false);
        karte(tenant, site, controller, 5, "750-495", true, true); // ausgebaut: zählt nicht
        List<MeasurementPlan.Entry> plan = List.of(new MeasurementPlan.Entry(gemessen,
                "wago.pm495.karte[1].frequency", 60, null, "x", 90, null, null));

        TenantContext.set(tenant);
        List<Map<String, Object>> bilder;
        try {
            bilder = registerbilder.fuer(site, plan);
        } finally {
            TenantContext.clear();
        }
        assertThat(new ObjectMapper().valueToTree(bilder).toString()).isEqualTo("[{\"entity_id\":\"" + gemessen
                + "\",\"basisadresse\":4096,\"funktionscode\":4,\"wortfolge\":\"little\",\"kartenzahl\":2,"
                + "\"karten\":[{\"steckplatz\":2,\"kartentyp\":494},{\"steckplatz\":3,\"kartentyp\":495}]}]");

        // Das aus der Steuerung GELESENE Soll (WagoSollLesung) geht mit; fehlend blieb es oben Byte für Byte weg.
        root.update("UPDATE geraet SET controller_kennung=8212 WHERE id=?", controller);
        root.update("UPDATE geraet_teil SET variante=25001 WHERE geraet_id=? AND steckplatz=3", controller);
        TenantContext.set(tenant);
        try {
            bilder = registerbilder.fuer(site, plan);
        } finally {
            TenantContext.clear();
        }
        assertThat(new ObjectMapper().valueToTree(bilder).toString()).isEqualTo("[{\"entity_id\":\"" + gemessen
                + "\",\"basisadresse\":4096,\"funktionscode\":4,\"wortfolge\":\"little\",\"kartenzahl\":2,"
                + "\"controller_kennung\":8212,\"karten\":[{\"steckplatz\":2,\"kartentyp\":494},"
                + "{\"steckplatz\":3,\"kartentyp\":495,\"variante\":25001}]}]");

        UUID fremd = root.queryForObject("INSERT INTO tenant(name) VALUES ('Fremd') RETURNING id", UUID.class);
        TenantContext.set(fremd);
        try {
            assertThat(registerbilder.fuer(site, plan)).isEmpty();
        } finally {
            TenantContext.clear();
        }
    }
}
