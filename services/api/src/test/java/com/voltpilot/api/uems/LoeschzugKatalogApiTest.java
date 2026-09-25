package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.repo.TenantRepository;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * UEMS AP-20, Folge zu IP-18 (E10 = A): der Löschzug ist vollständig — über den GANZEN Katalog.
 *
 * <p>Der Wächter: ein Bereich, der in jeder Tabelle ohne Fremdschlüssel auf den Mandanten Zeilen hat ({@link #REST},
 * der Befund aus PR 1279, dazu eine Probe-Tabelle, die keine Liste kennt), wird nach Vertragsende und Frist über die
 * Route gelöscht. Danach ist {@code verblieben} im Löschnachweis leer und keine Katalog-Tabelle mit {@code tenant_id}
 * trägt noch seine Kennung; ein Nachbarbereich mit denselben Tabellen bleibt Zeile für Zeile unberührt. Was der
 * Löschzug NICHT löschen kann (kein Löschrecht der Verwaltungsrolle, ein append-only-Trigger), nennt der Nachweis
 * ehrlich — genau daran wird der Wächter rot.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class LoeschzugKatalogApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String BETREIBER = "betrieb-voss";
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");

    /** Die 31 Tabellen mit {@code tenant_id}, aber ohne Fremdschlüssel und ohne Entfernen-Funktion (PR 1279, Punkt 5). */
    private static final List<String> REST = List.of("telemetry_v2", "telemetry_v2_rollup_15m",
            "telemetry_v2_rollup_1h", "telemetry_v2_rollup_1d", "device_measurement_rollup_5m",
            "device_measurement_rollup_15m", "device_command_log", "device_command_recording", "consumer_audit_event",
            "consumer_override", "consumer_requirement_state", "consumer_runtime_status", "device_charge_connector",
            "device_charge_point", "device_charging_budget", "device_control_status", "device_curtailment_status",
            "device_curtailment_unit", "device_edge_version", "device_override", "device_source_status",
            "device_update_status", "entity_plan_slot", "flow_claim", "flow_device_ack", "flow_node_status",
            "move_provisioning_operation", "rule_event", "rule_event_recording", "site_plan_run",
            "component_activation_outbox");

    /** Je Tabelle eine Zeile; {t} Bereich, {s} Anlage, {d} Box. Die Protokolle tragen einen Namen wie im Betrieb. */
    private static final List<String> SAAT = List.of(
            "INSERT INTO telemetry_v2 (time, tenant_id, site_id, device_id, entity_id, channel, value)"
                    + " VALUES (now(), {t}, {s}, {d}, gen_random_uuid()::text, 'power', 1.0)",
            "INSERT INTO telemetry_v2_rollup_15m (bucket, tenant_id, site_id, entity_id, channel, n_samples)"
                    + " VALUES (date_trunc('hour', now()), {t}, {s}, gen_random_uuid()::text, 'power', 1)",
            "INSERT INTO telemetry_v2_rollup_1h (bucket, tenant_id, site_id, entity_id, channel, n_samples)"
                    + " VALUES (date_trunc('hour', now()), {t}, {s}, gen_random_uuid()::text, 'power', 1)",
            "INSERT INTO telemetry_v2_rollup_1d (bucket, tenant_id, site_id, entity_id, channel, n_samples)"
                    + " VALUES (date_trunc('day', now()), {t}, {s}, gen_random_uuid()::text, 'power', 1)",
            "INSERT INTO device_measurement_rollup_5m (bucket, tenant_id, site_id, device_id, point_key,"
                    + " aggregation_kind, sample_count, catalog_version)"
                    + " VALUES (date_trunc('hour', now()), {t}, {s}, {d}, 'grid.power', 'instant', 1, '1')",
            "INSERT INTO device_measurement_rollup_15m (bucket, tenant_id, site_id, device_id, point_key,"
                    + " aggregation_kind, sample_count, catalog_version)"
                    + " VALUES (date_trunc('hour', now()), {t}, {s}, {d}, 'grid.power', 'instant', 1, '1')",
            "INSERT INTO device_command_log (tenant_id, site_id, device_id, stream, kind, event_kind, started_at,"
                    + " last_seen_at, source, actor_art, actor_sub, actor_name, actor_rolle) VALUES ({t}, {s}, {d},"
                    + " 'batterie', 'ereignis', 'gestartet', now(), now(), 'geraet', 'kunde', 'jw',"
                    + " 'Jonas Wendlinger', 'kundenadministrator')",
            "INSERT INTO device_command_recording (site_id, tenant_id, started_at) VALUES ({s}, {t}, now())",
            "INSERT INTO consumer_audit_event (tenant_id, site_id, event_type, actor_art, actor_sub, actor_name,"
                    + " actor_rolle) VALUES ({t}, {s}, 'paused', 'kunde', 'jw', 'Jonas Wendlinger',"
                    + " 'kundenadministrator')",
            "INSERT INTO consumer_override (entity_id, tenant_id, site_id, kind, target_command, ends_at, actor_art,"
                    + " actor_sub, actor_name) VALUES (gen_random_uuid(), {t}, {s}, 'start', 'on_off',"
                    + " now() + interval '1 hour', 'kunde', 'jw', 'Jonas Wendlinger')",
            "INSERT INTO consumer_requirement_state (requirement_instance_id, requirement_id, entity_id, tenant_id,"
                    + " site_id, period_start, deadline, state) VALUES (gen_random_uuid(), 'r1', gen_random_uuid(),"
                    + " {t}, {s}, now(), now() + interval '1 day', 'pending')",
            "INSERT INTO consumer_runtime_status (entity_id, tenant_id, site_id, device_id, state, reported_at)"
                    + " VALUES (gen_random_uuid(), {t}, {s}, {d}, 'on', now())",
            "INSERT INTO device_charge_connector (device_id, charge_point_id, connector_id, tenant_id, site_id,"
                    + " reported_at) VALUES ({d}, 'CP1', 1, {t}, {s}, now())",
            "INSERT INTO device_charge_point (device_id, charge_point_id, tenant_id, site_id, reported_at)"
                    + " VALUES ({d}, 'CP1', {t}, {s}, now())",
            "INSERT INTO device_charging_budget (device_id, tenant_id, site_id, reported_at)"
                    + " VALUES ({d}, {t}, {s}, now())",
            "INSERT INTO device_control_status (device_id, tenant_id, site_id, all_match, control_enabled, certified,"
                    + " checked_at) VALUES ({d}, {t}, {s}, true, true, false, now())",
            "INSERT INTO device_curtailment_status (device_id, tenant_id, site_id, units, certified_units,"
                    + " control_enabled, active, possible_override, checked_at)"
                    + " VALUES ({d}, {t}, {s}, 1, 0, true, false, false, now())",
            "INSERT INTO device_curtailment_unit (device_id, source_id, tenant_id, site_id, certified)"
                    + " VALUES ({d}, 'wr-1', {t}, {s}, false)",
            "INSERT INTO device_edge_version (device_id, tenant_id, site_id, reported_at)"
                    + " VALUES ({d}, {t}, {s}, now())",
            "INSERT INTO device_override (tenant_id, site_id, kind, entity_id, ends_at, actor_art, actor_sub,"
                    + " actor_name) VALUES ({t}, {s}, 'speicher_halten', gen_random_uuid(), now() + interval '1 hour',"
                    + " 'kunde', 'jw', 'Jonas Wendlinger')",
            "INSERT INTO device_source_status (device_id, source_id, tenant_id, site_id, kind, health, reported_at)"
                    + " VALUES ({d}, 'wr-1', {t}, {s}, 'modbus', 'ok', now())",
            "INSERT INTO device_update_status (device_id, tenant_id, site_id, reported_at)"
                    + " VALUES ({d}, {t}, {s}, now())",
            "INSERT INTO entity_plan_slot (time, tenant_id, site_id, plan_id, generated_at, entity_id, command)"
                    + " VALUES (date_trunc('hour', now()), {t}, {s}, gen_random_uuid(), now(),"
                    + " gen_random_uuid()::text, 'on_off')",
            "INSERT INTO flow_claim (entity_id, command, tenant_id, site_id, flow_id, flow_version, flow_name)"
                    + " VALUES (gen_random_uuid(), 'on_off', {t}, {s}, gen_random_uuid(), 1, 'Fluss')",
            "INSERT INTO flow_device_ack (device_id, flow_id, tenant_id, site_id, flow_version, state, reported_at)"
                    + " VALUES ({d}, gen_random_uuid(), {t}, {s}, 1, 'applied', now())",
            "INSERT INTO flow_node_status (device_id, flow_id, node_id, tenant_id, site_id, state, reported_at)"
                    + " VALUES ({d}, gen_random_uuid(), 'n1', {t}, {s}, 'ok', now())",
            "INSERT INTO move_provisioning_operation (tenant_id, device_id, from_site_id, to_site_id, revision,"
                    + " external_ref) VALUES ({t}, {d}, {s}, gen_random_uuid(), 1, 'umzug')",
            "INSERT INTO rule_event (tenant_id, site_id, kind, occurred_at) VALUES ({t}, {s}, 'ausgeloest', now())",
            "INSERT INTO rule_event_recording (site_id, tenant_id, started_at) VALUES ({s}, {t}, now())",
            "INSERT INTO site_plan_run (plan_id, tenant_id, site_id, generated_at, horizon_slots, slot_minutes)"
                    + " VALUES (gen_random_uuid(), {t}, {s}, now(), 96, 15)",
            "INSERT INTO component_activation_outbox (tenant_id, site_id, operation, entity_id, revision)"
                    + " VALUES ({t}, {s}, 'component_create', gen_random_uuid(), 1)");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> APP_USER);
        registry.add("spring.datasource.password", () -> APP_PW);
        registry.add("voltpilot.admin-datasource.url", POSTGRES::getJdbcUrl);
        registry.add("voltpilot.admin-datasource.username", () -> "voltpilot_admin");
        registry.add("voltpilot.admin-datasource.password", () -> "voltpilot_admin_test_pw");
        registry.add("spring.flyway.placeholders.adminDbUser", () -> "voltpilot_admin");
        registry.add("spring.flyway.placeholders.adminDbPassword", () -> "voltpilot_admin_test_pw");
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> APP_USER);
        registry.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot");
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot/protocol/openid-connect/certs");
    }

    @Autowired MockMvc mvc;
    @MockBean KeycloakAdminClient keycloak;

    private JdbcTemplate root;

    /** Ein Bereich, wie der Test ihn anlegt: Kennung, Name (für die Bestätigung), eine Anlage, eine Box. */
    private record Bereich(UUID id, String name, UUID site, UUID box) {}

    @BeforeEach
    void verbinden() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    /**
     * Der Wächter: jede Katalog-Tabelle, auch eine, die keine Liste kennt, geht mit; der Nachbar bleibt unberührt.
     */
    @Test
    void jedeTabelleMitDerKennungGehtMitUndDerNachbarBleibt() throws Exception {
        root.execute("CREATE TABLE loeschzug_probe (tenant_id uuid NOT NULL, notiz text)");
        try {
            Bereich weg = bereich();
            Bereich nachbar = bereich();
            for (Bereich b : List.of(weg, nachbar)) {
                saeRest(b);
                root.update("INSERT INTO loeschzug_probe (tenant_id, notiz) VALUES (?, 'Jonas Wendlinger')", b.id());
            }
            Map<String, Long> vorher = katalog(weg.id());
            assertThat(vorher.keySet()).as("der Bereich hat in jeder Rest-Tabelle und in der Probe Zeilen")
                    .containsAll(REST).contains("loeschzug_probe");
            Map<String, Long> nachbarVorher = katalog(nachbar.id());
            String nachbarInhaltVorher = inhalt(nachbar.id());

            vertragsendeVor(weg.id(), 91);
            MvcResult geloescht = loeschen(weg);
            assertThat(geloescht.getResponse().getStatus()).as(text(geloescht)).isEqualTo(200);
            JsonNode nachweis = json(geloescht).get("loeschnachweis");
            Map<String, Long> zaehlungen = map(nachweis.get("zaehlungen"));
            Map<String, Long> verblieben = map(nachweis.get("verblieben"));

            assertThat(zaehlungen).as("der Nachweis zählt jede Rest-Tabelle vor dem Löschen").containsAllEntriesOf(
                    vorher);
            assertThat(verblieben).as("E10 = A: nichts bleibt mit der Kennung").isEmpty();
            assertThat(katalog(weg.id())).as("der ganze Katalog, nicht nur die Liste des Nachweises").isEmpty();
            assertThat(katalog(nachbar.id())).as("der Nachbar: jede Tabelle, jede Zahl").isEqualTo(nachbarVorher);
            assertThat(inhalt(nachbar.id())).as("der Nachbar: jede Zeile unverändert").isEqualTo(nachbarInhaltVorher);
            assertThat(root.queryForObject("SELECT count(*) FROM tenant WHERE id = ?", Long.class, nachbar.id()))
                    .isOne();
            System.out.printf("Löschzug vollständig: %s, %d Tabellen gezählt (%d ohne Fremdschlüssel + Probe),"
                    + " verblieben %s; Nachbar unverändert in %d Tabellen%n", nachweis.get("kennzeichen").asText(),
                    zaehlungen.size(), REST.size(), verblieben, nachbarVorher.size());
        } finally {
            root.execute("DROP TABLE loeschzug_probe");
        }
    }

    /**
     * Was der Löschzug nicht löschen darf oder kann, bleibt — und der Nachweis nennt es; alles andere geht trotzdem.
     * Das ist der Fall, an dem der Wächter oben rot würde.
     */
    @Test
    void wasNichtGeloeschtWerdenKannNenntDerNachweisUnterVerblieben() throws Exception {
        root.execute("CREATE TABLE loeschzug_probe_ohne_recht (tenant_id uuid NOT NULL)");
        root.execute("REVOKE DELETE ON loeschzug_probe_ohne_recht FROM voltpilot_admin");
        root.execute("CREATE TABLE loeschzug_probe_append_only (tenant_id uuid NOT NULL)");
        root.execute("CREATE FUNCTION loeschzug_probe_bleibt() RETURNS trigger LANGUAGE plpgsql AS"
                + " $$ BEGIN RAISE EXCEPTION 'append-only'; END $$");
        root.execute("CREATE TRIGGER loeschzug_probe_bleibt BEFORE DELETE ON loeschzug_probe_append_only"
                + " FOR EACH ROW EXECUTE FUNCTION loeschzug_probe_bleibt()");
        try {
            Bereich weg = bereich();
            saeRest(weg);
            root.update("INSERT INTO loeschzug_probe_ohne_recht (tenant_id) VALUES (?)", weg.id());
            root.update("INSERT INTO loeschzug_probe_append_only (tenant_id) VALUES (?)", weg.id());

            vertragsendeVor(weg.id(), 91);
            MvcResult geloescht = loeschen(weg);
            assertThat(geloescht.getResponse().getStatus()).as(text(geloescht)).isEqualTo(200);
            Map<String, Long> verblieben = map(json(geloescht).get("loeschnachweis").get("verblieben"));
            assertThat(verblieben).isEqualTo(Map.of("loeschzug_probe_ohne_recht", 1L,
                    "loeschzug_probe_append_only", 1L));
            assertThat(katalog(weg.id())).isEqualTo(verblieben);
        } finally {
            root.execute("DROP TABLE loeschzug_probe_ohne_recht");
            root.execute("DROP TABLE loeschzug_probe_append_only");
            root.execute("DROP FUNCTION loeschzug_probe_bleibt()");
        }
    }

    /**
     * Laufzeit an einem großen Bereich (nur auf Wunsch: {@code -Dloeschzug.zeilen=2000000}): so viele Zeilen in
     * {@code telemetry_v2} je Bereich, ein Zehntel in jedem Rollup; der Nachbar ist gleich groß.
     */
    @Test
    @EnabledIfSystemProperty(named = "loeschzug.zeilen", matches = "\\d+")
    void laufzeitAnEinemGrossenBereich() throws Exception {
        long zeilen = Long.parseLong(System.getProperty("loeschzug.zeilen"));
        Bereich weg = bereich();
        Bereich nachbar = bereich();
        for (Bereich b : List.of(weg, nachbar)) {
            saeRest(b);
            root.update("INSERT INTO telemetry_v2 (time, tenant_id, site_id, device_id, entity_id, channel, value)"
                    + " SELECT now() - make_interval(secs => g), ?, ?, ?, ? || (g % 20), 'power', g"
                    + " FROM generate_series(1, ?) g", b.id(), b.site(), b.box(), b.id() + "-", zeilen);
            for (String rollup : List.of("telemetry_v2_rollup_15m", "telemetry_v2_rollup_1h",
                    "telemetry_v2_rollup_1d")) {
                root.update("INSERT INTO " + rollup + " (bucket, tenant_id, site_id, entity_id, channel, n_samples)"
                        + " SELECT now() - make_interval(mins => (g / 20 * 15)::int), ?, ?, ? || (g % 20), 'power', 1"
                        + " FROM generate_series(1, ?) g", b.id(), b.site(), b.id() + "-", zeilen / 10);
            }
            root.update("INSERT INTO device_measurement_rollup_5m (bucket, tenant_id, site_id, device_id, point_key,"
                    + " aggregation_kind, sample_count, catalog_version) SELECT now() - make_interval(mins => (g / 20 * 5)::int),"
                    + " ?, ?, ?, 'p' || (g % 20), 'instant', 1, '1' FROM generate_series(1, ?) g", b.id(), b.site(),
                    b.box(), zeilen / 10);
        }
        root.execute("ANALYZE");
        long nachbarVorher = katalog(nachbar.id()).values().stream().mapToLong(Long::longValue).sum();

        vertragsendeVor(weg.id(), 91);
        long start = System.nanoTime();
        MvcResult geloescht = loeschen(weg);
        long ms = (System.nanoTime() - start) / 1_000_000;
        assertThat(geloescht.getResponse().getStatus()).as(text(geloescht)).isEqualTo(200);
        JsonNode nachweis = json(geloescht).get("loeschnachweis");
        long gezaehlt = map(nachweis.get("zaehlungen")).values().stream().mapToLong(Long::longValue).sum();
        assertThat(map(nachweis.get("verblieben"))).isEmpty();
        assertThat(katalog(nachbar.id()).values().stream().mapToLong(Long::longValue).sum()).isEqualTo(nachbarVorher);
        System.out.printf("Löschzug Laufzeit: %d Zeilen des Bereichs (Nachbar %d) in %d ms über die Route,"
                + " samt Zählung vorher/nachher%n", gezaehlt, nachbarVorher, ms);
    }

    private Bereich bereich() throws Exception {
        String nr = UUID.randomUUID().toString().substring(0, 8);
        String name = "Kunststoffwerk Ahrenberg " + nr;
        MvcResult angelegt = mvc.perform(post("/api/v1/admin/tenants").contentType(MediaType.APPLICATION_JSON)
                .content(JSON.writeValueAsString(Map.of("name", name))).with(authentication(plattform()))).andReturn();
        assertThat(angelegt.getResponse().getStatus()).isEqualTo(201);
        UUID id = UUID.fromString(json(angelegt).get("id").asText());
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name, bidding_zone) VALUES (?, 'Werk', 'DE-LU')"
                + " RETURNING id", UUID.class, id);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?)"
                + " RETURNING id", UUID.class, id, site, "loeschzug-" + nr);
        root.update("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw) VALUES (now(), ?, ?, ?, 1.0)",
                id, site, box);
        return new Bereich(id, name, site, box);
    }

    private void saeRest(Bereich b) {
        for (String sql : SAAT) {
            root.update(sql.replace("{t}", "'" + b.id() + "'::uuid").replace("{s}", "'" + b.site() + "'::uuid")
                    .replace("{d}", "'" + b.box() + "'::uuid"));
        }
    }

    /** Zeitraffer: der Bereich endete vor {@code tage} Kalendertagen (Berlin, mittags), Frist 90 Tage. */
    private void vertragsendeVor(UUID tenant, int tage) {
        root.update("UPDATE tenant SET beendet_am = ?, beendet_frist_tage = 90, beendet_von = ? WHERE id = ?",
                LocalDate.now(BERLIN).minusDays(tage).atTime(LocalTime.NOON).atZone(BERLIN).toOffsetDateTime(),
                BETREIBER, tenant);
    }

    private List<String> tabellen() {
        return root.queryForList(TenantRepository.KATALOG_MIT_MANDANT, String.class);
    }

    /** Zeilen mit der Kennung je Katalog-Tabelle, nur die mit Zeilen. */
    private Map<String, Long> katalog(UUID tenant) {
        Map<String, Long> je = new TreeMap<>();
        for (String tabelle : tabellen()) {
            long n = root.queryForObject("SELECT count(*) FROM \"" + tabelle + "\" WHERE tenant_id = ?", Long.class,
                    tenant);
            if (n > 0) {
                je.put(tabelle, n);
            }
        }
        return je;
    }

    /** Der Inhalt aller Zeilen mit der Kennung, je Tabelle sortiert — für „jede Zeile unverändert“. */
    private String inhalt(UUID tenant) {
        StringBuilder alles = new StringBuilder();
        for (String tabelle : tabellen()) {
            for (String zeile : root.queryForList("SELECT row_to_json(x)::text AS z FROM \"" + tabelle
                    + "\" x WHERE tenant_id = ? ORDER BY 1", String.class, tenant)) {
                alles.append(tabelle).append(' ').append(zeile).append('\n');
            }
        }
        return alles.toString();
    }

    private MvcResult loeschen(Bereich b) throws Exception {
        return mvc.perform(post("/api/v1/admin/tenants/" + b.id() + "/delete").contentType(MediaType.APPLICATION_JSON)
                .content(JSON.writeValueAsString(Map.of("confirmName", b.name()))).with(authentication(plattform())))
                .andReturn();
    }

    private static Map<String, Long> map(JsonNode knoten) {
        Map<String, Long> m = new TreeMap<>();
        for (Iterator<Map.Entry<String, JsonNode>> it = knoten.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> e = it.next();
            m.put(e.getKey(), e.getValue().asLong());
        }
        return m;
    }

    private static JsonNode json(MvcResult r) throws Exception {
        return JSON.readTree(text(r));
    }

    private static String text(MvcResult r) throws Exception {
        return r.getResponse().getContentAsString(StandardCharsets.UTF_8);
    }

    private static Authentication plattform() {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", BETREIBER);
        claims.put("preferred_username", BETREIBER);
        claims.put("realm_access", Map.of("roles", List.of("platform-admin")));
        return new KeycloakRealmRoleConverter().convert(new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600),
                Map.of("alg", "none"), claims));
    }
}
