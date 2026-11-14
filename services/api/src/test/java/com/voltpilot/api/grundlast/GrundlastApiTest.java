package com.voltpilot.api.grundlast;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.IntToDoubleFunction;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * {@code GET /api/v1/sites/{siteId}/grundlast} gegen gesäte Rollups (Bauplan G1/G3): eine v1-Anlage
 * ({@code telemetry_rollup_15m}), eine v2-Anlage mit zwei Unterzählern ({@code telemetry_v2_rollup_15m}),
 * Mandantentrennung (fremde Anlage = 404) und die Zeiträume.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class GrundlastApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Eine Woche im November 2025 (Mo–So), weit vor der Uhr des Tests; keine Zeitumstellung. */
    private static final LocalDate MO = LocalDate.of(2025, 11, 3);

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
    @MockitoBean KeycloakAdminClient keycloak;

    private JdbcTemplate root;

    @BeforeEach
    void verbinden() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    private record Anlage(UUID tenant, UUID site) {}

    private Anlage anlage(String name) {
        UUID tenant = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                name + " " + UUID.randomUUID().toString().substring(0, 8));
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name, bidding_zone) VALUES (?, ?, 'DE-LU')"
                + " RETURNING id", UUID.class, tenant, name);
        return new Anlage(tenant, site);
    }

    /** Die Viertelstunden der Nacht eines Datums. */
    private static List<Instant> viertel(LocalDate d) {
        List<Instant> out = new ArrayList<>();
        for (Instant t = GrundlastRegel.nachtBeginn(d); t.isBefore(GrundlastRegel.nachtEnde(d));
                t = t.plus(Duration.ofMinutes(15))) {
            out.add(t);
        }
        return out;
    }

    /** v1: Hausverbrauch je Nacht-Viertelstunde (Watt je Index; NaN = keine Zeile). Liefert die Summe kWh. */
    private double v1Nacht(Anlage a, LocalDate d, IntToDoubleFunction watt) {
        double summe = 0;
        List<Instant> v = viertel(d);
        for (int i = 0; i < v.size(); i++) {
            double w = watt.applyAsDouble(i);
            if (Double.isNaN(w)) {
                continue;
            }
            v1(a, v.get(i), w / 4000.0);
            summe += w / 4000.0;
        }
        return summe;
    }

    private void v1(Anlage a, Instant bucket, double loadKwh) {
        root.update("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh, grid_import_kwh,"
                        + " grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, n_samples)"
                        + " VALUES (?, ?, ?, 0, ?, ?, 0, 0, 0, 15)",
                Timestamp.from(bucket), a.tenant(), a.site(), loadKwh, loadKwh);
    }

    private void v2(Anlage a, UUID entity, Instant bucket, double kw) {
        root.update("INSERT INTO telemetry_v2_rollup_15m (bucket, tenant_id, site_id, entity_id, channel, avg_value,"
                        + " min_value, max_value, last_value, n_samples) VALUES (?, ?, ?, ?, 'power_kw', ?, ?, ?, ?, 15)",
                Timestamp.from(bucket), a.tenant(), a.site(), entity.toString(), kw, kw, kw, kw);
    }

    private UUID punkt(Anlage a, String typ, String label) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type,"
                        + " capabilities) VALUES (?, ?, ?, ?, ?,"
                        + " '{\"measure\":[{\"channel\":\"power_kw\",\"unit\":\"kW\"}]}'::jsonb) RETURNING id",
                UUID.class, a.tenant(), a.site(), typ, label, typ);
    }

    @Test
    void v1WocheMitLueckenNachtUndVorwoche() throws Exception {
        Anlage haus = anlage("Haus Birkenweg");
        double nachtKwh = 0;
        int nachtViertel = 0;
        double[] tief = {280, 300, 320, Double.NaN, 300, 300, 300};
        for (int i = 0; i < 7; i++) {
            LocalDate d = MO.plusDays(i);
            if (i == 3) {
                // Donnerstag: nur 10 von 20 Viertelstunden – nicht gewertet.
                nachtKwh += v1Nacht(haus, d, x -> x < 10 ? 500 : Double.NaN);
                nachtViertel += 10;
                continue;
            }
            double w = tief[i];
            nachtKwh += v1Nacht(haus, d, x -> x == 8 ? w : 800);
            nachtViertel += 20;
        }
        // Tagsüber eine Viertelstunde je Tag mit 2 kWh (zählt zum Verbrauch, nicht zur Nacht).
        for (int i = 0; i < 7; i++) {
            v1(haus, GrundlastRegel.nachtBeginn(MO.plusDays(i)).plus(Duration.ofHours(12)), 2.0);
        }
        double verbrauch = nachtKwh + 7 * 2.0;
        long viertelGesamt = nachtViertel + 7;
        // Vorwoche: drei Nächte mit 250 W ab Freitag; davor nichts gemessen.
        for (int i = 4; i < 7; i++) {
            v1Nacht(haus, MO.minusWeeks(1).plusDays(i), x -> 250);
        }

        JsonNode b = lies(haus, kunde(haus.tenant()), "woche", MO.plusDays(2));
        assertThat(b.get("z").asText()).isEqualTo("woche");
        assertThat(b.get("von").asText()).isEqualTo("2025-11-03");
        assertThat(b.get("bis").asText()).isEqualTo("2025-11-09");
        assertThat(b.get("hausverbrauchGemessen").asBoolean()).isTrue();
        assertThat(b.get("typischW").asDouble()).isEqualTo(300.0);
        assertThat(b.get("gewertet").asInt()).isEqualTo(6);
        assertThat(b.get("mindestens").asInt()).isEqualTo(3);
        assertThat(b.get("luecken").asInt()).isEqualTo(1);
        assertThat(b.get("naechte")).hasSize(7);
        assertThat(b.at("/naechte/0/w").asDouble()).isEqualTo(280.0);
        assertThat(b.at("/naechte/3/status").asText()).isEqualTo("luecke");
        assertThat(b.at("/naechte/3/w").isNull()).isTrue();
        assertThat(b.get("monate")).isEmpty();
        assertThat(b.get("kwhAmTag").asDouble()).isEqualTo(7.2);
        assertThat(b.get("anteil").asDouble())
                .isCloseTo(0.3 * viertelGesamt * 0.25 / verbrauch, within(0.001));
        assertThat(b.get("vorperiodeW").asDouble()).isEqualTo(250.0);
        assertThat(b.get("teile")).isEmpty();
        assertThat(b.get("rest").isNull()).isTrue();

        // Die Vorwoche selbst: vier Nächte vor der ersten Messung sind „vorher“, keine Lücke.
        JsonNode vor = lies(haus, kunde(haus.tenant()), "woche", MO.minusWeeks(1));
        assertThat(vor.at("/naechte/0/status").asText()).isEqualTo("vorher");
        assertThat(vor.get("luecken").asInt()).isZero();
        assertThat(vor.get("typischW").asDouble()).isEqualTo(250.0);

        // Tag: der Wert dieser Nacht, die Vornacht als Vorperiode; eine Nacht reicht.
        JsonNode tag = lies(haus, kunde(haus.tenant()), "tag", MO.plusDays(1));
        assertThat(tag.get("typischW").asDouble()).isEqualTo(300.0);
        assertThat(tag.get("mindestens").asInt()).isEqualTo(1);
        assertThat(tag.get("vorperiodeW").asDouble()).isEqualTo(280.0);
        JsonNode luecke = lies(haus, kunde(haus.tenant()), "tag", MO.plusDays(3));
        assertThat(luecke.get("typischW").isNull()).isTrue();
        assertThat(luecke.get("luecken").asInt()).isEqualTo(1);

        // Jahr: je Monat ab 7 Nächten. November: 6 dieser Woche + 01./02.11. der Vorwoche = 8 (Median 300);
        // Oktober: nur der 31.10. – keine Monatszahl.
        JsonNode jahr = lies(haus, kunde(haus.tenant()), "jahr", MO);
        assertThat(jahr.get("naechte")).isEmpty();
        assertThat(jahr.get("monate")).hasSize(12);
        assertThat(jahr.at("/monate/10/monat").asText()).isEqualTo("2025-11");
        assertThat(jahr.at("/monate/10/gewertet").asInt()).isEqualTo(8);
        assertThat(jahr.at("/monate/10/w").asDouble()).isEqualTo(300.0);
        assertThat(jahr.at("/monate/9/gewertet").asInt()).isEqualTo(1);
        assertThat(jahr.at("/monate/9/w").isNull()).isTrue();
        assertThat(jahr.get("gewertet").asInt()).isEqualTo(9);
        assertThat(jahr.get("typischW").asDouble()).isEqualTo(300.0);
    }

    @Test
    void v2MitZweiUnterzaehlernTeiltAufUndRest() throws Exception {
        Anlage halle = anlage("Sonnenhof");
        root.update("UPDATE site SET v2_history_cutover_at = '2025-01-01T00:00:00Z' WHERE id = ?", halle.site());
        UUID netz = punkt(halle, "grid-meter", "Netzanschluss");
        UUID uvHalle = punkt(halle, "sub-meter", "UV Halle");
        UUID uvKeller = punkt(halle, "sub-meter", "UV Keller");
        for (int i = 0; i < 7; i++) {
            List<Instant> v = viertel(MO.plusDays(i));
            for (int x = 0; x < v.size(); x++) {
                boolean tief = x == 4;
                v2(halle, netz, v.get(x), tief ? 0.64 : 0.9);
                v2(halle, uvHalle, v.get(x), tief ? 0.56 : 0.7);
                v2(halle, uvKeller, v.get(x), tief ? 0.03 : 0.05);
            }
        }

        JsonNode b = lies(halle, kunde(halle.tenant()), "woche", MO);
        assertThat(b.get("typischW").asDouble()).isEqualTo(640.0);
        assertThat(b.get("gewertet").asInt()).isEqualTo(7);
        assertThat(b.get("teile")).hasSize(2);
        Map<String, Double> teile = new HashMap<>();
        for (JsonNode t : b.get("teile")) {
            teile.put(t.get("label").asText(), t.get("w").asDouble());
            assertThat(t.get("unterzaehler").asBoolean()).isTrue();
        }
        assertThat(teile).containsEntry("UV Halle", 560.0).containsEntry("UV Keller", 30.0);
        assertThat(b.at("/rest/w").asDouble()).isEqualTo(50.0);
        assertThat(b.at("/rest/grund").isNull()).isTrue();
    }

    @Test
    void fremdeAnlageIst404UndFalscherZeitraum400() throws Exception {
        Anlage meine = anlage("Haus am Mühlbach");
        Anlage fremde = anlage("Haus Fremd");
        v1Nacht(fremde, MO, x -> 400);

        MvcResult r = mvc.perform(get("/api/v1/sites/" + fremde.site() + "/grundlast").param("z", "woche")
                .param("at", MO.toString()).with(authentication(kunde(meine.tenant())))).andReturn();
        assertThat(r.getResponse().getStatus()).as(text(r)).isEqualTo(404);

        MvcResult falsch = mvc.perform(get("/api/v1/sites/" + meine.site() + "/grundlast").param("z", "quartal")
                .with(authentication(kunde(meine.tenant())))).andReturn();
        assertThat(falsch.getResponse().getStatus()).isEqualTo(400);

        // Ohne je einen Messwert: keine Karte, keine Kachel.
        JsonNode leer = lies(meine, kunde(meine.tenant()), "aktuell", null);
        assertThat(leer.get("hausverbrauchGemessen").asBoolean()).isFalse();
        assertThat(leer.get("typischW").isNull()).isTrue();
        assertThat(leer.get("naechte")).hasSize(14);
    }

    private JsonNode lies(Anlage a, Authentication wer, String z, LocalDate at) throws Exception {
        var anfrage = get("/api/v1/sites/" + a.site() + "/grundlast").param("z", z).with(authentication(wer));
        if (at != null) {
            anfrage = anfrage.param("at", at.toString());
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        assertThat(r.getResponse().getStatus()).as(text(r)).isEqualTo(200);
        return JSON.readTree(text(r));
    }

    private static String text(MvcResult r) throws Exception {
        return r.getResponse().getContentAsString(StandardCharsets.UTF_8);
    }

    private static Authentication kunde(UUID tenant) {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", "kunde-" + tenant);
        claims.put("preferred_username", "kunde-" + tenant);
        claims.put("tenant_id", tenant.toString());
        claims.put("realm_access", Map.of("roles", List.of("tenant-admin")));
        return new KeycloakRealmRoleConverter().convert(new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600),
                Map.of("alg", "none"), claims));
    }
}
