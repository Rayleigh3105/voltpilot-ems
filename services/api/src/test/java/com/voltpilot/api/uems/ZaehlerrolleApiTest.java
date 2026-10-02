package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
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
 * MiSpeL MP-6 gegen die Datenbank: {@code GET/PUT /api/v1/messstellen/{id}/zaehlerrolle}.
 *
 * <p><b>Der Prüfnachweis des Pakets (Anlage 1 S. 25, Abschn. 3.2.4):</b> eine Messstelle, hinter der eine
 * Wärmepumpe als Unterzähler hängt, wird nicht Z2 (422 {@code zaehler_nicht_getrennt}, nichts gespeichert); ein
 * Z2, hinter das SPÄTER über einen anderen Weg ein Verbraucher gehängt wird, ist beim Lesen
 * {@code nicht_tauglich} mit dem Befund {@code sonstiger_verbrauch_hinter_zaehler}. Dazu Form, Passung,
 * „vergeben“, „ohne Anlage“, Fassungen und der Mandantenzaun.
 *
 * <p>Die Welt entsteht über SQL (Komponenten mit Topologie-Rollen, Messstellen, Stellungen, führende
 * Quellen); geprüft werden nur die Routen dieses Pakets.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class ZaehlerrolleApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String AB = "2026-01-01";
    private static final String ZP = "DE0001234567890000000000000000001";
    private static final AtomicInteger NR = new AtomicInteger();

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

    @MockBean
    EntityRegistryPublisher registryPublisher;

    @MockBean
    FlowDeploymentPublisher flowPublisher;

    @Autowired
    MockMvc mvc;

    private static JdbcTemplate root;

    @BeforeAll
    static void verbinden() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    private record Welt(UUID mandant, UUID anlage, UUID box, Map<String, UUID> ms) {
        UUID m(String kz) {
            return ms.get(kz);
        }
    }

    private record Antwort(int status, JsonNode body) {}

    // ------------------------------------------------------------------ der Prüfnachweis

    @Test
    void hinterZ2darfKeinSonstigerVerbrauchHaengen() throws Exception {
        Welt w = welt();
        // MS-03 (Speicher) trägt die Wärmepumpe MS-04 als Unterzähler: kein Z2 (A1 S. 25).
        Antwort r = ruf(w, HttpMethod.PUT, w.m("MS-03"), z2());
        assertThat(r.status()).isEqualTo(422);
        assertThat(r.body().path("code").asText()).isEqualTo("zaehler_nicht_getrennt");
        assertThat(r.body().path("fundstelle").asText()).isEqualTo("Anlage 1 S. 25, Abschn. 3.2.4");
        assertThat(r.body().path("befunde").get(0).path("code").asText())
                .isEqualTo("sonstiger_verbrauch_hinter_zaehler");
        assertThat(r.body().path("befunde").get(0).path("betroffen").asText()).isEqualTo("MS-04");
        assertThat(ruf(w, HttpMethod.GET, w.m("MS-03"), null).body().path("rolle").isNull()).isTrue();
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle_zaehlerrolle WHERE tenant_id = ?",
                Integer.class, w.mandant())).isZero();

        // MS-05 (zweiter Speicher, nichts dahinter) wird Z2 …
        Antwort ok = ruf(w, HttpMethod.PUT, w.m("MS-05"), z2());
        assertThat(ok.status()).isEqualTo(200);
        assertThat(ok.body().path("festlegungsgroesse").asText()).isEqualTo("Z2V");
        assertThat(ok.body().path("befunde").toString()).doesNotContain("\"fehler\"");
        // … und bekommt SPÄTER über den Stellungs-Weg einen Verbraucher dahinter: der Befund zeigt es.
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, unterzaehler_von, "
                + "gueltig_ab) VALUES (?, ?, ?, 'Unterzähler', ?, ?::date)", w.mandant(), w.m("MS-06"), w.anlage(),
                w.m("MS-05"), AB);
        JsonNode spaeter = ruf(w, HttpMethod.GET, w.m("MS-05"), null).body();
        assertThat(spaeter.path("urteil").asText()).isEqualTo("nicht_tauglich");
        assertThat(spaeter.path("befunde").toString()).contains("sonstiger_verbrauch_hinter_zaehler", "MS-06");
    }

    // ------------------------------------------------------------------ Form, Passung, Fassungen, Zaun

    @Test
    void z1paarFormVergebenOhneAnlageUndFassungen() throws Exception {
        Welt w = welt();
        Antwort z1 = ruf(w, HttpMethod.PUT, w.m("MS-01"), z1("Netze Musterstadt GmbH"));
        assertThat(z1.status()).isEqualTo(200);
        assertThat(z1.body().path("festlegungsgroesse").asText()).isEqualTo("Z1NB");
        assertThat(z1.body().path("rolle").path("zaehlpunkt").asText()).isEqualTo(ZP);
        assertThat(z1.body().path("befunde").toString()).contains("gegenrichtung_fehlt");
        Antwort ne = ruf(w, HttpMethod.PUT, w.m("MS-02"), z1("Netze Musterstadt GmbH"));
        assertThat(ne.body().path("festlegungsgroesse").asText()).isEqualTo("Z1NE");
        assertThat(ne.body().path("urteil").asText()).isEqualTo("tauglich");

        // Z1NB gibt es schon (MS-01): 409 mit der anderen Messstelle.
        Antwort vergeben = ruf(w, HttpMethod.PUT, w.m("MS-04"), z1("Netze Musterstadt GmbH"));
        assertThat(vergeben.status()).isEqualTo(409);
        assertThat(vergeben.body().path("code").asText()).isEqualTo("zaehlerrolle_vergeben");
        assertThat(vergeben.body().path("messstelle").asText()).isEqualTo("MS-01");

        // Form und Passung.
        Map<String, Object> falsch = z1("X");
        falsch.put("zaehlpunkt", ZP.toLowerCase());
        assertThat(ruf(w, HttpMethod.PUT, w.m("MS-01"), falsch).body().path("grund").asText()).isEqualTo("zaehlpunkt");
        Map<String, Object> unbekannt = z1("X");
        unbekannt.put("marktlokation", "x");
        Antwort feld = ruf(w, HttpMethod.PUT, w.m("MS-01"), unbekannt);
        assertThat(feld.status()).isEqualTo(400);
        assertThat(feld.body().path("feld").asText()).isEqualTo("marktlokation");
        assertThat(ruf(w, HttpMethod.PUT, w.m("MS-07"), z1("X")).body().path("grund").asText())
                .isEqualTo("nicht_gemessen");
        Antwort ohne = ruf(w, HttpMethod.PUT, w.m("MS-08"), z1("X"));
        assertThat(ohne.status()).isEqualTo(422);
        assertThat(ohne.body().path("code").asText()).isEqualTo("ohne_anlage");

        // Korrektur desselben Tages hebt auf, gleiche Angaben sind 409, „keine Rolle“ beendet ab einem Tag.
        assertThat(ruf(w, HttpMethod.PUT, w.m("MS-01"), z1("Stadtwerke Muster")).status()).isEqualTo(200);
        assertThat(ruf(w, HttpMethod.PUT, w.m("MS-01"), z1("Stadtwerke Muster")).body().path("code").asText())
                .isEqualTo("zaehlerrolle_unveraendert");
        Map<String, Object> ende = new LinkedHashMap<>();
        ende.put("rolle", null);
        ende.put("gueltig_ab", "2026-07-01");
        assertThat(ruf(w, HttpMethod.PUT, w.m("MS-01"), ende).status()).isEqualTo(200);
        JsonNode juni = ruf(w, HttpMethod.GET, w.m("MS-01"), null, "?am=2026-06-30").body();
        assertThat(juni.path("rolle").path("messstellenbetreiber").asText()).isEqualTo("Stadtwerke Muster");
        assertThat(juni.path("fassungen")).hasSize(3);
        assertThat(juni.path("fassungen").get(0).path("aufgehoben_am").isNull()).isFalse();
        assertThat(juni.path("fassungen").get(1).path("gueltig_bis").asText()).isEqualTo("2026-06-30");
        assertThat(ruf(w, HttpMethod.GET, w.m("MS-01"), null, "?am=2026-07-01").body().path("urteil").asText())
                .isEqualTo("keine_rolle");

        // Ein anderer Kundenbereich sieht die Messstelle nicht.
        Welt fremd = welt();
        assertThat(ruf(fremd, HttpMethod.GET, w.m("MS-01"), null).status()).isEqualTo(404);
        assertThat(ruf(fremd, HttpMethod.PUT, w.m("MS-01"), z1("X")).status()).isEqualTo(404);
    }

    // ------------------------------------------------------------------ die Welt

    private static Map<String, Object> z1(String msb) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("rolle", "Z1");
        b.put("zaehlpunkt", ZP);
        b.put("messstellenbetreiber", msb);
        b.put("eichstatus", "eichrechtskonform");
        b.put("eichfrist_bis", "2034-12-31");
        b.put("wertequelle", "messstellenbetreiber");
        b.put("gueltig_ab", AB);
        return b;
    }

    private static Map<String, Object> z2() {
        Map<String, Object> b = z1("Netze Musterstadt GmbH");
        b.put("rolle", "Z2");
        b.put("zaehlpunkt", "DE0001234567890000000000000000002");
        return b;
    }

    /**
     * Eine Anlage mit Netzzähler (MS-01 Bezug, MS-02 Abgabe), Speicher MS-03 mit der Wärmepumpe MS-04 als
     * Unterzähler, zweitem Speicher MS-05, Verbraucher MS-06 (noch ohne Stellung), einer berechneten MS-07 und
     * MS-08 ohne Stellung.
     */
    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "MiSpeL Zählerrollen #" + nr);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, 'Halle M', "
                + "'2025-12-01') RETURNING id", UUID.class, t);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, "
                + "'claimed') RETURNING id", UUID.class, t, anlage, "VP-BOX-MISPEL-" + nr);
        UUID netz = komponente(t, anlage, box, "grid-meter", "power_kw");
        UUID speicher = komponente(t, anlage, box, "battery-hybrid", "battery_power_kw");
        UUID wp = komponente(t, anlage, box, "heat-pump-sgready", "power_kw");
        UUID speicher2 = komponente(t, anlage, box, "user-defined-battery", "power_kw");
        UUID last = komponente(t, anlage, box, "generic-load", "power_kw");
        Map<String, UUID> ms = new LinkedHashMap<>();
        ms.put("MS-01", messstelle(t, "MS-01", "gemessen", "Bezug"));
        ms.put("MS-02", messstelle(t, "MS-02", "gemessen", "Abgabe"));
        ms.put("MS-03", messstelle(t, "MS-03", "gemessen", "Laden"));
        ms.put("MS-04", messstelle(t, "MS-04", "gemessen", "Bezug"));
        ms.put("MS-05", messstelle(t, "MS-05", "gemessen", "Laden"));
        ms.put("MS-06", messstelle(t, "MS-06", "gemessen", "Bezug"));
        ms.put("MS-07", messstelle(t, "MS-07", "berechnet", "Bezug"));
        ms.put("MS-08", messstelle(t, "MS-08", "gemessen", "Bezug"));
        stellung(t, anlage, ms.get("MS-01"), "Hauptzähler", null);
        stellung(t, anlage, ms.get("MS-02"), "Hauptzähler", null);
        stellung(t, anlage, ms.get("MS-03"), "Speicher", null);
        stellung(t, anlage, ms.get("MS-04"), "Unterzähler", ms.get("MS-03"));
        stellung(t, anlage, ms.get("MS-05"), "Speicher", null);
        quelle(t, box, ms.get("MS-01"), "Bezug", netz, "sunspec.model_203.totwhimp");
        quelle(t, box, ms.get("MS-02"), "Abgabe", netz, "sunspec.model_203.totwhexp");
        quelle(t, box, ms.get("MS-03"), "Laden", speicher, "battery.charge-energy");
        quelle(t, box, ms.get("MS-04"), "Bezug", wp, "sunspec.model_203.totwhimp");
        quelle(t, box, ms.get("MS-05"), "Laden", speicher2, "battery.charge-energy");
        quelle(t, box, ms.get("MS-06"), "Bezug", last, "sunspec.model_203.totwhimp");
        return new Welt(t, anlage, box, ms);
    }

    private static UUID komponente(UUID t, UUID anlage, UUID box, String typ, String kanal) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "device_id, control, communication, connection_json, capabilities, created_at) VALUES (?, ?, ?, ?, ?, "
                + "?, false, 'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, ?::jsonb, '2025-12-01') "
                + "RETURNING id", UUID.class, t, anlage, typ, typ, typ, box,
                "{\"measure\":[{\"channel\":\"" + kanal + "\",\"unit\":\"kW\"}]}");
    }

    private static UUID messstelle(UUID t, String kz, String art, String richtung) {
        return root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, ?, 'Strom', 'Wirkenergie', ?, 'kWh', ?) RETURNING id",
                UUID.class, t, kz, kz, art, richtung, "berechnet".equals(art) ? "Intervallmenge" : "Zählerstand");
    }

    private static void stellung(UUID t, UUID anlage, UUID ms, String stellung, UUID ueber) {
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, unterzaehler_von, "
                + "gueltig_ab) VALUES (?, ?, ?, ?, ?, ?::date)", t, ms, anlage, stellung, ueber, AB);
    }

    private static void quelle(UUID t, UUID box, UUID ms, String richtung, UUID komponente, String kanal) {
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) SELECT ?, site_id, ?, ?, ?, true, 60, 1, ?::timestamptz, "
                + "'2026.09.11.1', 'test', 'pending_edge', 'energy_counter', 'fifteen_minute' FROM measurement_point "
                + "WHERE id = ? ON CONFLICT DO NOTHING", t, box, komponente, kanal, AB, komponente);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, komponente);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_sub, "
                + "actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', ?, ?, ?, ?, 'counter', 'zaehlerstand', 'fuehrend', "
                + "?::timestamptz, true, now(), 'sub-test', 'Test', 'kunde')", t, ms, richtung, komponente, geraet, kanal,
                AB);
    }

    private Antwort ruf(Welt w, HttpMethod methode, UUID ms, Object body) throws Exception {
        return ruf(w, methode, ms, body, "");
    }

    private Antwort ruf(Welt w, HttpMethod methode, UUID ms, Object body, String query) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, "/api/v1/messstellen/" + ms + "/zaehlerrolle" + query)
                .with(jwt().jwt(j -> {
                    j.subject("sub-mispel-" + w.mandant());
                    j.claim("name", "Mara Test");
                    j.claim("tenant_id", w.mandant().toString());
                }))
                .contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
