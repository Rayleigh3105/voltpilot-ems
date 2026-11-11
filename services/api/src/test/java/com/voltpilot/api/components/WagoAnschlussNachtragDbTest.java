package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.tenant.TenantContext;
import java.util.List;
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
 * Konzept „Ein Gerät, ein Eintrag“, GE-6 — „WAGO im Bestand“: ein WAGO-Controller, den der Assistent vor GE-6
 * ohne Anschluss angelegt hat, bekommt ihn nachgeholt — allein über die {@code data_source_id}, die die
 * Komponenten seiner Karten schon tragen. Die Gegenproben: eine gleiche Adresse verknüpft nichts, zwei
 * verschiedene Anschlüsse an den Karten auch nicht; ein zweiter Lauf schreibt nichts.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@ActiveProfiles("local")
class WagoAnschlussNachtragDbTest {
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw")
            .withCommand("postgres", "-c", "timescaledb.max_background_workers=0");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "wago_nachtrag_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "wago_nachtrag_test_pw");
        r.add("spring.flyway.placeholders.adminDbPassword", () -> "wago_nachtrag_admin_pw");
        r.add("voltpilot.admin-datasource.password", () -> "wago_nachtrag_admin_pw");
    }

    @Autowired WagoKartenAnlage karten;
    @Autowired WagoAnschlussNachtragLaeufer laeufer;
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

    @Test
    void derBestandWirdNurUeberDieKomponentenVerknuepftNieUeberDieAdresse() {
        UUID tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('WAGO-Bestand GmbH') RETURNING id",
                UUID.class);
        UUID site = root.queryForObject("INSERT INTO site(tenant_id,name) VALUES (?, 'Halle Süd') RETURNING id",
                UUID.class, tenant);
        UUID dqA = quelle(tenant, site, "DQ-1", "192.168.20.30:502");
        UUID dqB = quelle(tenant, site, "DQ-2", "192.168.20.31:502");
        UUID dqGleich = quelle(tenant, site, "DQ-3", "192.168.20.32:502");

        // Drei Steuerungen, wie der Assistent sie vor GE-6 hinterließ: Controller mit Karten, ohne Anschluss.
        UUID[] c1 = steuerung(tenant, site, "192.168.20.30", 1, 2);
        UUID[] c2 = steuerung(tenant, site, "192.168.20.32", 1, 2);
        UUID[] c3 = steuerung(tenant, site, "192.168.20.31", 1, 2);
        UUID g1 = controller(c1[0]);
        UUID g2 = controller(c2[0]);
        UUID g3 = controller(c3[0]);
        assertThat(anschluss(g1)).isNull();

        // C1: eine Karte trägt DQ-1 (z. B. aus der Vorschlagsliste), die andere nichts → verknüpft.
        root.update("UPDATE measurement_point SET data_source_id = ? WHERE id = ?", dqA, c1[0]);
        // C2: KEINE Karte trägt einen Anschluss; DQ-3 hat genau ihre Adresse — Gegenprobe: bleibt leer.
        // C3: die Karten nennen zwei verschiedene Anschlüsse — kein Raten, bleibt leer.
        root.update("UPDATE measurement_point SET data_source_id = ? WHERE id = ?", dqB, c3[0]);
        root.update("UPDATE measurement_point SET data_source_id = ? WHERE id = ?", dqA, c3[1]);

        WagoAnschlussNachtragLaeufer.Lauf erster = laeufer.lauf();
        assertThat(erster.fehler()).isZero();
        assertThat(anschluss(g1)).isEqualTo(dqA);
        assertThat(anschluss(g2)).as("gleiche Adresse ist kein gespeicherter Verweis").isNull();
        assertThat(dqGleich).isNotNull();
        assertThat(anschluss(g3)).as("zwei Anschlüsse an einer Steuerung werden nicht geraten").isNull();

        // Idempotent: ein zweiter Lauf schreibt nichts, auch nicht an C1.
        assertThat(laeufer.lauf().verknuepft()).isZero();
        assertThat(als(tenant, karten::quellenNachholen)).isZero();
        assertThat(anschluss(g1)).isEqualTo(dqA);

        // Ein archivierter Anschluss wird nicht nachgetragen.
        root.update("UPDATE measurement_point SET data_source_id = NULL WHERE id = ?", c3[1]);
        root.update("UPDATE data_source SET archiviert_am = now() WHERE id = ?", dqB);
        assertThat(als(tenant, karten::quellenNachholen)).isZero();
        assertThat(anschluss(g3)).isNull();
    }

    private static UUID quelle(UUID tenant, UUID site, String kennzeichen, String adresse) {
        return root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, name, protokoll, adresse, "
                + "geraete_ids, kadenz_s) VALUES (?, ?, ?, 'WAGO-Steuerung', 'modbus_tcp', ?, '{1}', 60) RETURNING id",
                UUID.class, tenant, site, kennzeichen, adresse);
    }

    /** Zwei WAGO-Komponenten an einer Adresse; der Bestands-Weg der Karten macht daraus EINEN Controller. */
    private UUID[] steuerung(UUID tenant, UUID site, String ip, int... steckplaetze) {
        UUID[] ek = new UUID[steckplaetze.length];
        List<WagoKartenAnlage.Zuordnung> zuordnung = new java.util.ArrayList<>();
        for (int i = 0; i < steckplaetze.length; i++) {
            ek[i] = root.queryForObject("INSERT INTO measurement_point (tenant_id,site_id,role,entity_type,brand,model,"
                    + "connection_json) VALUES (?,?,'consumer','consumer','wago','pm494_pm495_registerbild_v1',"
                    + "jsonb_build_object('ip', ?::text, 'port', 502, 'mb_slave_id', 1, 'base_address', 4096, "
                    + "'function_code', '4', 'word_order', 'little', 'slot', ?::int)) RETURNING id",
                    UUID.class, tenant, site, ip, steckplaetze[i]);
            zuordnung.add(new WagoKartenAnlage.Zuordnung(ek[i], steckplaetze[i], 495));
        }
        als(tenant, () -> karten.nachtragen(site, new WagoKartenAnlage.Nachtragen(zuordnung), "test"));
        return ek;
    }

    private static UUID controller(UUID entity) {
        return root.queryForObject("SELECT v.geraet_id FROM geraet_komponente v WHERE v.entity_id = ? "
                + "AND v.teil_id IS NOT NULL", UUID.class, entity);
    }

    private static UUID anschluss(UUID geraet) {
        return root.queryForObject("SELECT data_source_id FROM geraet WHERE id = ?", UUID.class, geraet);
    }
}
