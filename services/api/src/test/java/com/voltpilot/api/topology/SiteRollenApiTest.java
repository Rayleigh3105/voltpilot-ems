package com.voltpilot.api.topology;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.tenant.TenantContext;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
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
 * Die KUNDEN-Fläche der geraeteseitigen Rollen-Zuordnung ({@link com.voltpilot.api.web.SiteRollenController})
 * gegen die echte Kette: Tenant-Scoping/RLS (fremde Anlage = 404), das Setzen/Lesen des
 * massgeblichen PV-Werts eines Geraets (nativer Kanal ODER Gesamtwert) mit is_primary-Ablösung,
 * und der kanonische, ehrlich benannte Rollen-Wert der Anlage (Teil-Summe + stumme Geraete benannt,
 * Rueckfall wenn keine Zuordnung existiert).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class SiteRollenApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String PV = "pv_power_kw";

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

    @Autowired
    MockMvc mvc;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    // ================================================= Geraete-Zuordnung schreiben/lesen

    @Test
    void kundeSetztUndLiestDenMassgeblichenPvWertEinesGeraets() throws Exception {
        Welt w = welt();
        UUID entity = komponente(w, "Wechselrichter 1");
        UUID ms = gesamtwert(w, entity);
        String pfad = "/api/v1/sites/" + w.anlage() + "/komponenten/" + entity + "/rollen/pv";

        // Ein Gesamtwert wird zugeordnet — noch nichts abgeloest.
        JsonNode a = ok(ruf(w, HttpMethod.PUT, pfad, gesamtwertWert(ms)), 200);
        assertThat(a.at("/zugeordnet/art").asText()).isEqualTo("gesamtwert");
        assertThat(a.at("/zugeordnet/quell_messstelle_id").asText()).isEqualTo(ms.toString());
        assertThat(a.get("abgeloest").isNull()).isTrue();

        JsonNode gelesen = ok(ruf(w, HttpMethod.GET, pfad, null), 200);
        assertThat(gelesen.at("/zugeordnet/art").asText()).isEqualTo("gesamtwert");

        // Ein zweiter Wert auf dieselbe Rolle ERSETZT den ersten (is_primary-Semantik) und nennt ihn.
        JsonNode b = ok(ruf(w, HttpMethod.PUT, pfad, kanalWert(PV)), 200);
        assertThat(b.at("/zugeordnet/art").asText()).isEqualTo("messkanal");
        assertThat(b.at("/zugeordnet/capability").asText()).isEqualTo(PV);
        assertThat(b.at("/abgeloest/art").asText()).isEqualTo("gesamtwert");
        assertThat(b.at("/abgeloest/quell_messstelle_id").asText()).isEqualTo(ms.toString());

        // Genau eine massgebliche Zuordnung bleibt.
        assertThat(root.queryForObject("SELECT count(*) FROM entity_role_assignment "
                + "WHERE entity_id = ? AND role = 'pv' AND is_primary", Long.class, entity)).isOne();
    }

    @Test
    void eineFremdeAnlageIst404NieEine403() throws Exception {
        Welt a = welt();
        Welt b = welt();
        UUID entity = komponente(a, "WR");
        String pfad = "/api/v1/sites/" + a.anlage() + "/komponenten/" + entity + "/rollen/pv";
        assertThat(ruf(b, HttpMethod.GET, pfad, null).status()).isEqualTo(404);
        assertThat(ruf(b, HttpMethod.PUT, pfad, kanalWert(PV)).status()).isEqualTo(404);
        assertThat(ruf(b, HttpMethod.GET, "/api/v1/sites/" + a.anlage() + "/rollen/pv", null).status())
                .isEqualTo(404);
    }

    @Test
    void einGesamtwertMussEineBerechneteMessstelleSein() throws Exception {
        Welt w = welt();
        UUID entity = komponente(w, "WR");
        UUID gemessen = gemesseneMessstelle(w);
        String pfad = "/api/v1/sites/" + w.anlage() + "/komponenten/" + entity + "/rollen/pv";
        assertThat(ruf(w, HttpMethod.PUT, pfad, gesamtwertWert(gemessen)).status()).isEqualTo(400);
        assertThat(ruf(w, HttpMethod.PUT, pfad, gesamtwertWert(UUID.randomUUID())).status()).isEqualTo(404);
    }

    @Test
    void einGesamtwertEinerFremdenAnlageDesselbenMandantenWirdAbgelehnt() throws Exception {
        Welt a = welt();
        Welt b = zweiteAnlage(a);                 // gleicher Mandant, andere Anlage
        UUID entityA = komponente(a, "WR A");
        UUID entityB = komponente(b, "WR B");
        UUID msA = gesamtwert(a, entityA);        // ein Gesamtwert aus einem Kanal von Anlage A

        // An ein Geraet auf Anlage B zuordnen -> 400 (der Gesamtwert gehoert zu Anlage A).
        String pfadB = "/api/v1/sites/" + b.anlage() + "/komponenten/" + entityB + "/rollen/pv";
        assertThat(ruf(a, HttpMethod.PUT, pfadB, gesamtwertWert(msA)).status()).isEqualTo(400);

        // An das Geraet auf Anlage A -> 200 (same-site, alles korrekt).
        String pfadA = "/api/v1/sites/" + a.anlage() + "/komponenten/" + entityA + "/rollen/pv";
        assertThat(ruf(a, HttpMethod.PUT, pfadA, gesamtwertWert(msA)).status()).isEqualTo(200);
    }

    // ================================================= kanonischer Rollen-Wert der Anlage

    @Test
    void derKanonischeWertIstEineBenannteTeilSummeMitStummenGeraeten() throws Exception {
        Welt w = welt();
        UUID e1 = komponente(w, "WR 1");
        UUID e2 = komponente(w, "WR 2");
        ordneKanalZu(w, e1);
        ordneKanalZu(w, e2);
        // e1 liefert frisch 5 kW; e2 ist veraltet (10 min alt) -> stumm, aber benannt.
        telemetrie(w, e1, 5.0, 0);
        telemetrie(w, e2, 4.0, 600);

        JsonNode k = ok(ruf(w, HttpMethod.GET, "/api/v1/sites/" + w.anlage() + "/rollen/pv", null), 200);
        assertThat(k.get("zuordnung_vorhanden").asBoolean()).isTrue();
        assertThat(k.get("wert").asDouble()).as("Teil-Summe der liefernden, nicht 9").isEqualTo(5.0);
        assertThat(k.get("einheit").asText()).isEqualTo("kW");
        assertThat(k.get("unvollstaendig").asBoolean()).isTrue();
        assertThat(k.get("geraete")).hasSize(2);
        // Jedes Geraet ist benannt — eines liefernd, eines mit Grund „veraltet".
        long liefernd = 0;
        boolean veraltetBenannt = false;
        for (JsonNode g : k.get("geraete")) {
            assertThat(g.get("name").asText()).isNotBlank();
            if (g.get("liefernd").asBoolean()) {
                liefernd++;
            } else if ("veraltet".equals(g.get("grund").asText())) {
                veraltetBenannt = true;
            }
        }
        assertThat(liefernd).isOne();
        assertThat(veraltetBenannt).isTrue();
    }

    @Test
    void ohneZuordnungFaelltDasCockpitAufDieRohTelemetrieZurueck() throws Exception {
        Welt w = welt();
        komponente(w, "WR");
        JsonNode k = ok(ruf(w, HttpMethod.GET, "/api/v1/sites/" + w.anlage() + "/rollen/pv", null), 200);
        assertThat(k.get("zuordnung_vorhanden").asBoolean()).as("Rueckfall auf telemetry.pv_power_kw")
                .isFalse();
        assertThat(k.get("wert").isNull()).isTrue();
        assertThat(k.get("geraete")).isEmpty();
    }

    @Test
    void nurDieRollePvWirdBisherZusammengefasst() throws Exception {
        Welt w = welt();
        assertThat(ruf(w, HttpMethod.GET, "/api/v1/sites/" + w.anlage() + "/rollen/grid", null).status())
                .isEqualTo(400);
    }

    // ================================================= Cockpit-Uebersicht: Umlenkung + Rueckfall

    @Test
    void dieUebersichtUebernimmtDieKanonischePvMitRueckfall() throws Exception {
        Welt w = welt();
        UUID e1 = komponente(w, "WR 1");
        // Roh-Telemetrie der Anlage: pv_power_kw = 99 — der Rueckfall, wenn nichts zugeordnet ist.
        telemetrieLegacy(w, 99.0);

        // Ohne PV-Zuordnung zeigt die Uebersicht die Roh-Zahl (nichts aendert sich).
        assertThat(uebersichtPv(w, w.anlage())).as("Rueckfall auf telemetry.pv_power_kw").isEqualTo(99.0);

        // Mit einer PV-Zuordnung eines frischen 5-kW-Kanals zeigt die Uebersicht die KANONISCHE Zahl.
        ordneKanalZu(w, e1);
        telemetrie(w, e1, 5.0, 0);
        assertThat(uebersichtPv(w, w.anlage()))
                .as("kanonische PV-Rolle statt telemetry.pv_power_kw").isEqualTo(5.0);
    }

    @Test
    void eineZugeordneteAberStummeAnlageZeigtKeinePvNieEineNull() throws Exception {
        Welt w = welt();
        UUID e1 = komponente(w, "WR 1");
        telemetrieLegacy(w, 99.0);       // Roh-Telemetrie liegt vor …
        ordneKanalZu(w, e1);             // … aber die Zuordnung liefert nichts (kein frischer v2-Wert).

        // Ehrlich: zugeordnet, aber stumm -> PV unbekannt (null), nie ein Rueckfall auf 99 und nie 0.
        assertThat(uebersichtPv(w, w.anlage())).as("null statt Rueckfall/0 bei stummer Zuordnung").isNull();
    }

    // ================================================================ die Welt

    private record Welt(UUID mandant, UUID anlage, UUID box) {}

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Rollen-Probe #" + nr);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) "
                + "VALUES (?, 'Anlage #" + nr + "', now()) RETURNING id", UUID.class, t);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, name, status, "
                + "created_at) VALUES (?, ?, ?, 'Box', 'claimed', now()) RETURNING id",
                UUID.class, t, anlage, "E-" + nr);
        return new Welt(t, anlage, box);
    }

    /** Eine zweite Anlage (Site + Box) im SELBEN Mandanten — für den within-tenant-cross-site-Fall. */
    private Welt zweiteAnlage(Welt w) {
        int nr = NR.incrementAndGet();
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) "
                + "VALUES (?, 'Anlage B #" + nr + "', now()) RETURNING id", UUID.class, w.mandant());
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, name, "
                + "status, created_at) VALUES (?, ?, ?, 'Box B', 'claimed', now()) RETURNING id",
                UUID.class, w.mandant(), anlage, "EB-" + nr);
        return new Welt(w.mandant(), anlage, box);
    }

    private UUID komponente(Welt w, String label) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, control, communication, created_at) VALUES (?, ?, "
                + "'battery-hybrid', ?, 'battery-hybrid', ?, false, 'modbus_tcp', now()) RETURNING id",
                UUID.class, w.mandant(), w.anlage(), label, w.box());
    }

    /** Ein Gesamtwert (berechnete Messstelle), gebaut aus EINEM Kanal des Geräts {@code entity}
     *  — damit er (über seine Terme) zur Anlage dieses Geräts gehört. */
    private UUID gesamtwert(Welt w, UUID entity) {
        UUID ms = messstelle(w, "berechnet");
        root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, position, "
                + "eingang_art, entity_id, point_key, vorzeichen, faktor, gilt_als_erzeugung) "
                + "VALUES (?, ?, 0, 'messkanal', ?, 'deye.hybrid_3p.pv.pv1-power', '+', 1, false)",
                w.mandant(), ms, entity);
        return ms;
    }

    private UUID gemesseneMessstelle(Welt w) {
        return messstelle(w, "gemessen");
    }

    private UUID messstelle(Welt w, String art) {
        return root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, "
                + "groesse, richtung, einheit, wertart) VALUES (?, ?, 'Gesamt-PV', ?, 'Strom', "
                + "'Wirkleistung', 'Erzeugung', 'kW', 'Momentanwert') RETURNING id",
                UUID.class, w.mandant(), String.format("MS-%05d", NR.incrementAndGet()), art);
    }

    private void ordneKanalZu(Welt w, UUID entity) throws Exception {
        ok(ruf(w, HttpMethod.PUT, "/api/v1/sites/" + w.anlage() + "/komponenten/" + entity
                + "/rollen/pv", kanalWert(PV)), 200);
    }

    private void telemetrie(Welt w, UUID entity, double kw, long alterSekunden) {
        Instant zeit = Instant.now().minus(alterSekunden, ChronoUnit.SECONDS);
        root.update("INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, "
                + "entity_id, channel, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                Timestamp.from(zeit), Timestamp.from(zeit), w.mandant(), w.anlage(), w.box(),
                entity.toString(), PV, kw);
    }

    /** Die ROH-Telemetrie der Anlage ({@code telemetry.pv_power_kw}) — der Cockpit-Rueckfall. */
    private void telemetrieLegacy(Welt w, double pvKw) {
        Instant zeit = Instant.now();
        root.update("INSERT INTO telemetry (time, received_at, tenant_id, site_id, device_id, "
                + "pv_power_kw) VALUES (?, ?, ?, ?, ?, ?)",
                Timestamp.from(zeit), Timestamp.from(zeit), w.mandant(), w.anlage(), w.box(), pvKw);
    }

    /** Der PV-Live-Wert einer Anlage in {@code GET /api/v1/overview} (null, wenn keiner). */
    private Double uebersichtPv(Welt w, UUID site) throws Exception {
        JsonNode ov = ok(ruf(w, HttpMethod.GET, "/api/v1/overview", null), 200);
        for (JsonNode s : ov.get("sites")) {
            if (site.toString().equals(s.get("id").asText())) {
                JsonNode live = s.get("live");
                if (live == null || live.isNull() || live.get("pvKw").isNull()) {
                    return null;
                }
                return live.get("pvKw").asDouble();
            }
        }
        return null;
    }

    // ================================================================ das Gerüst

    private static Map<String, Object> kanalWert(String capability) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("art", "messkanal");
        m.put("capability", capability);
        return m;
    }

    private static Map<String, Object> gesamtwertWert(UUID quell) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("art", "gesamtwert");
        m.put("quell_messstelle_id", quell.toString());
        return m;
    }

    private record Antwort(int status, JsonNode body) {}

    private static JsonNode ok(Antwort a, int status) {
        assertThat(a.status()).as("Antwort " + a.body()).isEqualTo(status);
        return a.body();
    }

    private Antwort ruf(Welt w, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-" + w.mandant());
                    j.claim("name", "Test");
                    j.claim("tenant_id", w.mandant().toString());
                }))
                .contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(),
                text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
