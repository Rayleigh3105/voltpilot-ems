package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.interventions.DeviceOverrideRenewalRunner;
import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.kundenbereich.Rueckmeldeweg;
import com.voltpilot.api.kundenbereich.RueckmeldewegArchitekturTest;
import com.voltpilot.api.purge.PurgeRequestListener;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.config.AutowireCapableBeanFactory;
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
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Wege OHNE Route für einen beendeten Kundenbereich (UEMS AP-20, Folgepaket zu IP-16, E10 = A „alles gesperrt"):
 * die MQTT-Rückmeldewege, die Läufer und der Flotten-Rollout. {@code KundenbereichBeendetApiTest} beweist die Routen;
 * hier je Weg-Art ein Beweis, mit einem aktiven Kundenbereich nebenan als Gegenprobe.
 *
 * <ul>
 *   <li><b>Rückmeldewege:</b> die Liste kommt aus dem Code ({@code RueckmeldewegArchitekturTest}, jede Klasse, die
 *       bei einem Paho-Client abonniert) — keine Liste von Hand. Jeder Weg bekommt eine Nachricht auf seinem
 *       eigenen Topic aus dem beendeten Bereich; er zählt sie als verworfen, und der Fingerabdruck der ganzen
 *       Datenbank ist danach unverändert. Gegenprobe: dieselbe Lösch-Anfrage einer Box schreibt im aktiven Bereich.</li>
 *   <li><b>Läufer:</b> die Erneuerung der Handeingriffe erneuert die Pause des aktiven Bereichs, die des beendeten
 *       nicht.</li>
 *   <li><b>Rollout:</b> ein Auftrag über Boxen beider Bereiche weist nur die aktive zu und nennt die ausgelassene;
 *       ein Auftrag nur über beendete Boxen entsteht nicht.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class KundenbereichBeendetWegeTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String MANIFEST = """
            {
              "schema_version" : "1.0",
              "release": "edge-2026.08.0",
              "release_seq" :12,
              "target_commit": "3bf8c038a1b2",
              "signing_key_id": "rel-2026-a"
            }
            """;
    private static final String SIGNATURE =
            "{\"schema_version\":\"1.0\",\"alg\":\"ed25519\",\"key_id\":\"rel-2026-a\","
                    + "\"domain\":\"release\",\"signature\":\"AAAA\"}\n";

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
    @Autowired AutowireCapableBeanFactory fabrik;
    @Autowired MeterRegistry metriken;
    @MockBean KeycloakAdminClient keycloak;

    private JdbcTemplate root;
    private Bereich beendet;
    private Bereich aktiv;

    /** Ein Kundenbereich mit einer Anlage und einer Box. */
    private record Bereich(UUID tenant, UUID site, UUID box, String name) {}

    @BeforeEach
    void seed() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        beendet = bereich("Kunststoffwerk Ahrenberg");
        aktiv = bereich("Nachbarwerk");
    }

    @Test
    void jederRueckmeldewegVerwirftDieNachrichtEinesBeendetenBereichsUndZaehltSie() throws Exception {
        beenden(beendet);
        List<String> wege = RueckmeldewegArchitekturTest.wegeImCode();
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());

        List<String> gezaehlt = new ArrayList<>();
        for (String klasse : wege) {
            Rueckmeldeweg weg = rueckmeldeweg(Class.forName(klasse));
            double zuvor = verworfen(weg.weg());
            empfangen(weg, topic(weg.getClass(), beendet), nutzlast(beendet));
            assertThat(verworfen(weg.weg())).as("%s zählt die verworfene Rückmeldung", klasse).isEqualTo(zuvor + 1);
            gezaehlt.add(weg.weg());
        }

        assertThat(gezaehlt).as("jeder Rückmeldeweg des Codes").hasSameSizeAs(wege).isNotEmpty();
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of())))
                .as("%d Rückmeldewege haben nichts in den beendeten Bereich geschrieben", wege.size()).isEmpty();
    }

    @Test
    void gegenprobeDieLoeschAnfrageEinerBoxSchreibtNurImAktivenBereich() throws Exception {
        beenden(beendet);
        Rueckmeldeweg purge = rueckmeldeweg(PurgeRequestListener.class);
        double zuvor = verworfen(purge.weg());

        empfangen(purge, topic(PurgeRequestListener.class, aktiv), nutzlast(aktiv));
        empfangen(purge, topic(PurgeRequestListener.class, beendet), nutzlast(beendet));

        assertThat(geloeschtVor(aktiv)).as("die Anfrage schreibt im aktiven Bereich (sonst bewiese der Test nichts)")
                .isNotNull();
        assertThat(geloeschtVor(beendet)).as("im beendeten Bereich nicht").isNull();
        assertThat(verworfen(purge.weg())).isEqualTo(zuvor + 1);
    }

    @Test
    void einLaeuferLaesstDenBeendetenBereichAus() throws Exception {
        long pauseAktiv = pause(aktiv);
        long pauseBeendet = pause(beendet);
        beenden(beendet);
        DeviceOverrideRenewalRunner laeufer = (DeviceOverrideRenewalRunner) fabrik.autowire(
                DeviceOverrideRenewalRunner.class, AutowireCapableBeanFactory.AUTOWIRE_CONSTRUCTOR, false);
        fabrik.autowireBean(laeufer);
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());

        Method takt = DeviceOverrideRenewalRunner.class.getDeclaredMethod("renewOnce", Instant.class);
        takt.setAccessible(true);
        takt.invoke(laeufer, Instant.now());

        assertThat(erneuert(pauseAktiv)).as("der Läufer arbeitet (Gegenprobe im aktiven Bereich)").isNotNull();
        assertThat(erneuert(pauseBeendet)).as("den beendeten Bereich lässt er aus").isNull();
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of())))
                .as("nur die Pause des aktiven Bereichs hat sich bewegt")
                .containsExactly("device_override: bestehender Inhalt geändert");
    }

    @Test
    void derRolloutErreichtDieBoxenDesBeendetenBereichsNichtUndNenntSie() throws Exception {
        beenden(beendet);
        MvcResult release = ruf(post("/api/v1/admin/edge-releases").contentType(MediaType.APPLICATION_JSON)
                .content(JSON.writeValueAsString(Map.of("version", "edge-2026.08.0", "releaseSeq", 12,
                        "manifest", MANIFEST, "signature", SIGNATURE))));
        assertThat(release.getResponse().getStatus()).as(text(release)).isEqualTo(201);

        MvcResult beide = ruf(post("/api/v1/admin/rollouts").contentType(MediaType.APPLICATION_JSON)
                .content(JSON.writeValueAsString(Map.of("releaseSeq", 12,
                        "devices", List.of(aktiv.box().toString(), beendet.box().toString())))));
        assertThat(beide.getResponse().getStatus()).as(text(beide)).isEqualTo(201);
        JsonNode antwort = JSON.readTree(text(beide));
        assertThat(antwort.path("ausgelassen")).hasSize(1);
        assertThat(antwort.path("ausgelassen").get(0).path("deviceId").asText()).isEqualTo(beendet.box().toString());
        assertThat(antwort.path("ausgelassen").get(0).path("kundenbereich").asText()).isEqualTo(beendet.name());
        assertThat(antwort.path("ausgelassen").get(0).path("grund").asText()).isEqualTo("kundenbereich_beendet");
        UUID rollout = UUID.fromString(antwort.path("rolloutId").asText());
        assertThat(root.queryForList("SELECT device_id FROM rollout_device WHERE rollout_id = ?", UUID.class, rollout))
                .containsExactly(aktiv.box());
        assertThat(zugewiesen(aktiv)).as("die aktive Box hat ihre Zuweisung").isEqualTo(1);
        assertThat(zugewiesen(beendet)).as("die Box des beendeten Bereichs nicht").isZero();

        MvcResult nurBeendet = ruf(post("/api/v1/admin/rollouts").contentType(MediaType.APPLICATION_JSON)
                .content(JSON.writeValueAsString(Map.of("releaseSeq", 12,
                        "devices", List.of(beendet.box().toString())))));
        assertThat(nurBeendet.getResponse().getStatus()).as(text(nurBeendet)).isEqualTo(409);
        assertThat(zugewiesen(beendet)).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM rollout", Integer.class))
                .as("ein Auftrag nur über beendete Boxen entsteht nicht").isEqualTo(1);

        MvcResult einzeln = ruf(post("/api/v1/admin/devices/" + beendet.box() + "/update-target")
                .contentType(MediaType.APPLICATION_JSON).content("{\"releaseSeq\":12}"));
        assertThat(einzeln.getResponse().getStatus()).as("Einzelweg: " + text(einzeln)).isEqualTo(409);
        assertThat(zugewiesen(beendet)).isZero();
    }

    // ---------------------------------------------------------------------------------------------

    private Bereich bereich(String name) {
        String nr = UUID.randomUUID().toString().substring(0, 8);
        String voll = name + " " + nr;
        UUID tenant = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, voll);
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name, bidding_zone) VALUES (?, 'Werk', 'DE-LU') "
                + "RETURNING id", UUID.class, tenant);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, tenant, site, "kb-wege-" + nr);
        return new Bereich(tenant, site, box, voll);
    }

    private void beenden(Bereich b) throws Exception {
        MvcResult r = ruf(post("/api/v1/admin/tenants/" + b.tenant() + "/beenden")
                .contentType(MediaType.APPLICATION_JSON)
                .content(JSON.writeValueAsString(Map.of("auftrag", "Kündigung zum 30.06.2029 (Annahme)",
                        "begruendung", "Vertragsende RF-08", "confirmName", b.name()))));
        assertThat(r.getResponse().getStatus()).as(text(r)).isEqualTo(200);
    }

    /** Ein Rückmeldeweg, gebaut wie Spring ihn baut — auch wenn sein Schalter im Testlauf aus ist; ohne Broker. */
    private Rueckmeldeweg rueckmeldeweg(Class<?> klasse) {
        Object weg = fabrik.autowire(klasse, AutowireCapableBeanFactory.AUTOWIRE_CONSTRUCTOR, false);
        fabrik.autowireBean(weg);
        return (Rueckmeldeweg) weg;
    }

    /** Der Eingang des Weges — derselbe, den sein Paho-Abonnement aufruft. */
    private static void empfangen(Rueckmeldeweg weg, String topic, byte[] nutzlast) throws Exception {
        for (Method m : weg.getClass().getDeclaredMethods()) {
            Class<?>[] p = m.getParameterTypes();
            if (m.getName().equals("handle") && p.length >= 2 && p[0] == String.class && p[1] == byte[].class) {
                m.setAccessible(true);
                if (p.length == 2) {
                    m.invoke(weg, topic, nutzlast);
                } else {
                    m.invoke(weg, topic, nutzlast, Instant.now());
                }
                return;
            }
        }
        throw new AssertionError(weg.getClass() + " hat keinen Eingang handle(String, byte[], …)");
    }

    /** Das Topic, das der Weg abonniert, mit den Kennungen des Bereichs statt der Platzhalter. */
    private static String topic(Class<?> klasse, Bereich b) throws Exception {
        for (Field f : klasse.getDeclaredFields()) {
            if (Modifier.isStatic(f.getModifiers()) && f.getType() == String.class && f.getName().endsWith("FILTER")) {
                f.setAccessible(true);
                return ((String) f.get(null)).replaceFirst("\\+", b.tenant().toString())
                        .replaceFirst("\\+", b.site().toString()).replaceFirst("\\+", b.box().toString());
            }
        }
        throw new AssertionError(klasse + " hat kein …FILTER");
    }

    /** Eine Lösch-Anfrage der Box: Identität im Topic und in der Nutzlast gleich. */
    private static byte[] nutzlast(Bereich b) {
        return ("{\"type\":\"purge_request\",\"schema_version\":\"1.0\",\"tenant_id\":\"" + b.tenant()
                + "\",\"site_id\":\"" + b.site() + "\",\"device_id\":\"" + b.box() + "\"}")
                .getBytes(StandardCharsets.UTF_8);
    }

    private double verworfen(String weg) {
        Counter c = metriken.find(BeendeteKundenbereiche.VERWORFEN).tag("weg", weg)
                .tag("grund", BeendeteKundenbereiche.GRUND).counter();
        return c == null ? 0 : c.count();
    }

    private Object geloeschtVor(Bereich b) {
        return root.queryForObject("SELECT data_purged_before FROM device WHERE id = ?", Object.class, b.box());
    }

    private long pause(Bereich b) {
        return root.queryForObject("INSERT INTO device_override (tenant_id, site_id, kind, entity_id, ends_at, "
                + "created_by) VALUES (?, ?, 'pause', NULL, ?, 'test') RETURNING id", Long.class, b.tenant(), b.site(),
                Timestamp.from(Instant.now().plus(2, ChronoUnit.HOURS)));
    }

    private Object erneuert(long pause) {
        return root.queryForObject("SELECT renewed_at FROM device_override WHERE id = ?", Object.class, pause);
    }

    private int zugewiesen(Bereich b) {
        return root.queryForObject("SELECT count(*) FROM device_update_target WHERE device_id = ?", Integer.class,
                b.box());
    }

    private MvcResult ruf(MockHttpServletRequestBuilder anfrage) throws Exception {
        return mvc.perform(anfrage.with(authentication(plattform()))).andReturn();
    }

    private static String text(MvcResult r) throws Exception {
        return r.getResponse().getContentAsString(StandardCharsets.UTF_8);
    }

    private static Authentication plattform() {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", "betrieb-voss");
        claims.put("preferred_username", "betrieb-voss");
        claims.put("realm_access", Map.of("roles", List.of("platform-admin")));
        return new KeycloakRealmRoleConverter().convert(new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600),
                Map.of("alg", "none"), claims));
    }
}
