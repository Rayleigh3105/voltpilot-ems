package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * AP-15 IP-10 (P3, R11): „veröffentlicht gegen angenommen“ je Box in {@code plan_zustellung}.
 * Der Optimierer-Teil schreibt hier mit derselben Anweisung wie
 * {@code persistence_v2._PUBLICATION_UPSERT_SQL} (vertrauenswürdige Rolle), die Quittung läuft
 * über den echten {@link PlanResultListener} unter der App-Rolle und RLS.
 */
@Testcontainers(disabledWithoutDocker = true)
class PlanZustellungApiTest {
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();
    /** Wortgleich mit services/optimization/voltpilot_optimization/persistence_v2.py. */
    private static final String VEROEFFENTLICHT = """
            INSERT INTO plan_zustellung
                (device_id, plan_id, tenant_id, site_id, generated_at, veroeffentlicht_um)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (device_id, plan_id)
            DO UPDATE SET
                generated_at       = EXCLUDED.generated_at,
                veroeffentlicht_um = COALESCE(plan_zustellung.veroeffentlicht_um,
                                              EXCLUDED.veroeffentlicht_um);
            """;

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static PlanZustellungRepository repository;
    private static PlanResultListener listener;
    private static JsonNode r11;
    private static UUID tenant, site, halle1, verwaltung;

    @BeforeAll
    static void setUp() throws Exception {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration").baselineOnMigrate(true).baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "voltpilot_admin_test_pw"))
                .load().migrate();
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        repository = new PlanZustellungRepository(new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW))));
        listener = new PlanResultListener("tcp://unused", "", "", repository, JSON);
        r11 = JSON.readTree(Files.readString(Path.of("../../docs/contracts/v2/plan-result-vectors.json"))).path("r11");
        tenant = root.queryForObject("INSERT INTO tenant (name) VALUES ('Kunststoffwerk Ahrenberg') RETURNING id", UUID.class);
        site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Werk Ahrenberg – Halle 1') RETURNING id",
                UUID.class, tenant);
        halle1 = box(tenant, site, "VP-R11-E1");
        verwaltung = box(tenant, site, "VP-R11-E4");
    }

    @AfterEach
    void clear() {
        TenantContext.clear();
    }

    @Test
    void r11VeroeffentlichtGegenAngenommenJeBox() {
        for (JsonNode lauf : r11.path("laeufe")) {
            Instant erzeugt = Instant.parse(lauf.path("generated_at").asText());
            for (UUID box : new UUID[] {halle1, verwaltung}) {
                veroeffentlichen(box, UUID.fromString(lauf.path("plan_id").asText()), erzeugt, erzeugt.plusSeconds(2));
            }
        }
        for (JsonNode b : r11.path("boxen")) {
            UUID box = "E-1".equals(b.path("box").asText()) ? halle1 : verwaltung;
            for (JsonNode planId : b.path("quittiert")) {
                String erzeugt = generatedAt(planId.asText());
                assertThat(quittung(box, planId.asText(), erzeugt, true, null,
                        Instant.parse(erzeugt).plusSeconds(3))).isTrue();
            }
        }
        TenantContext.set(tenant);
        for (JsonNode b : r11.path("boxen")) {
            UUID box = "E-1".equals(b.path("box").asText()) ? halle1 : verwaltung;
            var stand = repository.stand(box);
            assertThat(stand.veroeffentlicht().generatedAt()).as(b.path("box").asText())
                    .isEqualTo(Instant.parse(b.path("erwartet").path("veroeffentlicht").asText()));
            assertThat(stand.angenommen().generatedAt()).as(b.path("box").asText())
                    .isEqualTo(Instant.parse(b.path("erwartet").path("angenommen").asText()));
            assertThat(stand.angenommen().urteil()).isEqualTo("angenommen");
        }
        // „erzeugt 10:15 · angenommen 10:00“: Box Verwaltung fährt den Plan von Lauf 4710,
        // die Zeile des Laufs 4711 trägt nur „veröffentlicht“.
        var offen = root.queryForMap("SELECT urteil, quittiert_um, veroeffentlicht_um FROM plan_zustellung "
                + "WHERE device_id = ? AND plan_id = ?", verwaltung, UUID.fromString("4711aaaa-0000-4000-8000-000000004711"));
        assertThat(offen.get("urteil")).isNull();
        assertThat(offen.get("quittiert_um")).isNull();
        assertThat(offen.get("veroeffentlicht_um")).isNotNull();
    }

    @Test
    void alteBoxOhneQuittungBehaeltAngenommenLeer() {
        UUID alt = box(tenant, site, "VP-R11-ALT");
        veroeffentlichen(alt, UUID.randomUUID(), Instant.parse("2027-06-15T08:15:00Z"), Instant.parse("2027-06-15T08:15:02Z"));
        TenantContext.set(tenant);
        var stand = repository.stand(alt);
        assertThat(stand.veroeffentlicht()).isNotNull();
        assertThat(stand.angenommen()).isNull();
        UUID nie = box(tenant, site, "VP-R11-NIE");
        assertThat(repository.stand(nie)).isEqualTo(new PlanZustellungRepository.Stand(null, null));
    }

    @Test
    void ablehnungQuittungVorVeroeffentlichungUndReihenfolge() {
        UUID box = box(tenant, site, "VP-R11-REIHE");
        UUID plan = UUID.randomUUID();
        Instant erzeugt = Instant.parse("2027-06-15T08:30:00Z");
        // Die Box ist schneller als der Optimierer: die Quittung legt die Zeile an ...
        assertThat(quittung(box, plan.toString(), null, false, "fremde_box", erzeugt.plusSeconds(3))).isTrue();
        veroeffentlichen(box, plan, erzeugt, erzeugt.plusSeconds(4));
        var zeile = root.queryForMap("SELECT urteil, grund, generated_at, veroeffentlicht_um FROM plan_zustellung "
                + "WHERE device_id = ? AND plan_id = ?", box, plan);
        assertThat(zeile.get("urteil")).isEqualTo("abgelehnt");
        assertThat(zeile.get("grund")).isEqualTo("fremde_box");
        assertThat(((Timestamp) zeile.get("generated_at")).toInstant()).isEqualTo(erzeugt);
        assertThat(zeile.get("veroeffentlicht_um")).isNotNull();
        // ... und eine ältere Wiederzustellung überschreibt kein jüngeres Urteil.
        assertThat(quittung(box, plan.toString(), null, true, null, erzeugt.plusSeconds(1))).isFalse();
        assertThat(root.queryForObject("SELECT urteil FROM plan_zustellung WHERE device_id = ? AND plan_id = ?",
                String.class, box, plan)).isEqualTo("abgelehnt");
        // Das Abmelden der Box nimmt ihre Zustellungen mit (ON DELETE CASCADE).
        root.update("DELETE FROM device WHERE id = ?", box);
        assertThat(root.queryForObject("SELECT count(*) FROM plan_zustellung WHERE device_id = ?", Long.class, box)).isZero();
    }

    @Test
    void fremderMandantUndFremderStandortSchreibenNichts() {
        UUID fremd = root.queryForObject("INSERT INTO tenant (name) VALUES ('Fremd') RETURNING id", UUID.class);
        UUID fremderSite = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Fremd') RETURNING id",
                UUID.class, fremd);
        UUID anderer = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Halle 2') RETURNING id",
                UUID.class, tenant);
        String payload = """
                {"schema_version":"1.0","tenant_id":"%s","site_id":"%s","device_id":"%s","ts":"2027-06-15T08:15:03Z",
                 "angenommen":true,"plan_id":"%s"}""";
        UUID plan = UUID.randomUUID();
        UUID zaun = box(tenant, site, "VP-R11-ZAUN");
        // Box von Ahrenberg unter dem Mandanten des Fremden: RLS sieht sie nicht.
        assertThat(listener.handle(topic(fremd, site, zaun),
                payload.formatted(fremd, site, zaun, plan).getBytes(), Instant.now())).isFalse();
        // Richtiger Mandant, falscher Standort im Topic.
        assertThat(listener.handle(topic(tenant, anderer, zaun),
                payload.formatted(tenant, anderer, zaun, plan).getBytes(), Instant.now())).isFalse();
        assertThat(root.queryForObject("SELECT count(*) FROM plan_zustellung WHERE plan_id = ?", Long.class, plan)).isZero();
        assertThat(fremderSite).isNotNull();
        // RLS mit FORCE: die App-Rolle sieht unter einem fremden Mandanten keine Zeile Ahrenbergs.
        veroeffentlichen(zaun, plan, Instant.parse("2027-06-15T08:45:00Z"), Instant.parse("2027-06-15T08:45:02Z"));
        TenantContext.set(fremd);
        assertThat(repository.stand(zaun)).isEqualTo(new PlanZustellungRepository.Stand(null, null));
        assertThat(root.queryForObject("SELECT relforcerowsecurity FROM pg_class WHERE relname = 'plan_zustellung'",
                Boolean.class)).isTrue();
    }

    private static boolean quittung(UUID box, String planId, String generatedAt, boolean angenommen, String grund,
            Instant ts) {
        var q = JSON.createObjectNode().put("schema_version", "1.0").put("tenant_id", tenant.toString())
                .put("site_id", site.toString()).put("device_id", box.toString()).put("ts", ts.toString())
                .put("angenommen", angenommen).put("plan_id", planId);
        if (generatedAt != null) q.put("generated_at", generatedAt);
        if (grund != null) q.put("grund", grund);
        try {
            return listener.handle(topic(tenant, site, box), JSON.writeValueAsBytes(q), ts.plusMillis(200));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static String generatedAt(String planId) {
        for (JsonNode lauf : r11.path("laeufe")) {
            if (lauf.path("plan_id").asText().equals(planId)) return lauf.path("generated_at").asText();
        }
        throw new IllegalArgumentException(planId);
    }

    private static void veroeffentlichen(UUID box, UUID plan, Instant erzeugt, Instant um) {
        root.update(VEROEFFENTLICHT, box, plan, tenant, site, Timestamp.from(erzeugt), Timestamp.from(um));
    }

    private static String topic(UUID t, UUID s, UUID d) {
        return "ems/" + t + "/" + s + "/" + d + "/v2/plan-result";
    }

    private static UUID box(UUID t, UUID s, String ref) {
        return root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, s, ref);
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource dataSource = new PGSimpleDataSource();
        dataSource.setUrl(POSTGRES.getJdbcUrl());
        dataSource.setUser(user);
        dataSource.setPassword(password);
        return dataSource;
    }
}
