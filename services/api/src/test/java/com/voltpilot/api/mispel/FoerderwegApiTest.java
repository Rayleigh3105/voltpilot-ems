package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
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
 * MiSpeL MP-5 gegen die Datenbank: {@code GET/PUT /api/v1/sites/{siteId}/foerderweg} und der alte
 * Netzlade-Schalter an {@code PUT /api/v1/sites/{id}}, auf einer frisch migrierten Datenbank.
 *
 * <p><b>Prüfnachweis:</b> eine Bestandsanlage hat ohne Fassung genau den Förderweg ihrer Schalter, und die Schalter
 * bleiben bitgenau; ein Wechsel geht nur zum Monatsersten; mit Fassung bestimmt der Förderweg den alten Schalter
 * (Netzladen 409 wo ausgeschlossen, {@code plant_kind} folgt); der Mandantenzaun hält.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class FoerderwegApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
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
    @Autowired
    FoerderwegService wege;

    private static JdbcTemplate root;

    @BeforeAll
    static void verbinden() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    private record Anlage(UUID mandant, UUID id) {}

    private record Antwort(int status, JsonNode body) {}

    // ------------------------------------------------------------------ Bestand

    @Test
    void bestandsanlagenHabenDenFoerderwegIhrerSchalterUndBleibenBitgenau() throws Exception {
        heute("2026-10-20");
        Object[][] faelle = {
                {false, "eigenverbrauch", "einspeiseverguetung", "Einspeisevergütung"},
                {false, "direktvermarktung", "marktpraemie_ausschliesslichkeit", "Marktprämie mit Ausschließlichkeitsoption"},
                {true, "eigenverbrauch", "ungefoerdert", "ungeförderte Direktvermarktung"},
                {true, "direktvermarktung", "ungefoerdert", "ungeförderte Direktvermarktung"}};
        for (Object[] f : faelle) {
            Anlage a = anlage((Boolean) f[0], (String) f[1]);
            String vorher = zeile(a);
            Antwort r = ruf(a, HttpMethod.GET, "/foerderweg", null);
            assertThat(r.status()).isEqualTo(200);
            assertThat(r.body().path("quelle").asText()).isEqualTo("bestand");
            assertThat(r.body().path("foerderweg").asText()).isEqualTo(f[2]);
            assertThat(r.body().path("begriff").asText()).isEqualTo(f[3]);
            assertThat(r.body().path("netzladen").path("heute").asBoolean()).isEqualTo(f[0]);
            assertThat(r.body().path("netzladen").path("moeglich").asBoolean()).isEqualTo(f[0]);
            assertThat(r.body().path("gueltig_ab").isNull()).isTrue();
            assertThat(zeile(a)).as("die Schalter der Bestandsanlage bleiben bitgenau").isEqualTo(vorher);
            assertThat(fassungen(a)).isZero();
        }
    }

    @Test
    void ohneFassungBleibtDerAlteSchalterWasErWar() throws Exception {
        heute("2026-10-20");
        Anlage a = anlage(false, "direktvermarktung");
        Antwort r = ruf(a, HttpMethod.PUT, "", site(true, "direktvermarktung"));
        assertThat(r.status()).isEqualTo(200);
        assertThat(r.body().path("netzladenErlaubt").asBoolean()).isTrue();
        assertThat(ruf(a, HttpMethod.GET, "/foerderweg", null).body().path("foerderweg").asText())
                .isEqualTo("ungefoerdert");
        assertThat(fassungen(a)).isZero();
    }

    // ------------------------------------------------------------------ setzen

    @Test
    void abgrenzungZumMonatserstenMitFormelsatzUndBindung() throws Exception {
        heute("2026-10-20");
        Anlage a = anlage(false, "eigenverbrauch");
        Antwort mitten = ruf(a, HttpMethod.PUT, "/foerderweg", antrag("marktpraemie_abgrenzung", "A10", "2026-10-15"));
        assertThat(mitten.status()).isEqualTo(422);
        assertThat(mitten.body().path("code").asText()).isEqualTo("wechsel_nur_zum_monatsersten");
        assertThat(mitten.body().path("naechster_monatserster").asText()).isEqualTo("2026-11-01");
        assertThat(fassungen(a)).isZero();

        Antwort r = ruf(a, HttpMethod.PUT, "/foerderweg", antrag("marktpraemie_abgrenzung", "A10", "2026-10-01"));
        assertThat(r.status()).isEqualTo(200);
        assertThat(r.body().path("quelle").asText()).isEqualTo("fassung");
        assertThat(r.body().path("foerderweg").asText()).isEqualTo("marktpraemie_abgrenzung");
        assertThat(r.body().path("formelsatz").asText()).isEqualTo("A10");
        assertThat(r.body().path("formelsatz_gebunden_bis").asText()).isEqualTo("2026-12-31");
        assertThat(r.body().path("eingetragen_von").isMissingNode()).isTrue();
        assertThat(r.body().path("fassungen").get(0).path("eingetragen_von").asText()).isEqualTo("Mara Test");
        // Die Spiegel: Netzladen bleibt die Einstellung (aus), plant_kind folgt der Marktprämie.
        assertThat(root.queryForMap("SELECT netzladen_erlaubt, plant_kind FROM site WHERE id = ?", a.id()))
                .containsEntry("netzladen_erlaubt", false).containsEntry("plant_kind", "direktvermarktung");

        heute("2027-03-20");
        Antwort gebunden = ruf(a, HttpMethod.PUT, "/foerderweg", antrag("marktpraemie_abgrenzung", "A1", "2027-03-01"));
        assertThat(gebunden.status()).isEqualTo(422);
        assertThat(gebunden.body().path("code").asText()).isEqualTo("formelsatz_gebunden");
        assertThat(gebunden.body().path("gebunden_bis").asText()).isEqualTo("2027-12-31");
        assertThat(gebunden.body().path("fundstelle").asText()).isEqualTo("A1 S. 24, Abschn. 3.2.3");

        Map<String, Object> netz = antrag("marktpraemie_abgrenzung", "A1", "2027-03-01");
        netz.put("messkonzept_geaendert", true);
        netz.put("netzladen", true);
        Antwort umgebaut = ruf(a, HttpMethod.PUT, "/foerderweg", netz);
        assertThat(umgebaut.status()).isEqualTo(200);
        assertThat(umgebaut.body().path("netzladen").path("heute").asBoolean()).isTrue();
        assertThat(umgebaut.body().path("fassungen")).hasSize(2);
        assertThat(umgebaut.body().path("fassungen").get(0).path("gueltig_bis").asText()).isEqualTo("2027-02-28");

        // Zurück in die Ausschließlichkeit zum Monatsersten: Netzladen geht aus, der Spiegel folgt.
        Antwort zurueck = ruf(a, HttpMethod.PUT, "/foerderweg", antrag("marktpraemie_ausschliesslichkeit", null,
                "2027-03-01"));
        assertThat(zurueck.status()).isEqualTo(200);
        assertThat(zurueck.body().path("fassungen")).hasSize(3);
        assertThat(zurueck.body().path("fassungen").get(1).path("aufgehoben_am").isNull()).isFalse();
        assertThat(root.queryForObject("SELECT netzladen_erlaubt FROM site WHERE id = ?", Boolean.class, a.id()))
                .isFalse();
    }

    @Test
    void mitFassungBestimmtDerFoerderwegDenAltenSchalter() throws Exception {
        heute("2026-10-20");
        Anlage a = anlage(true, "eigenverbrauch");
        Map<String, Object> ev = antrag("einspeiseverguetung", null, "2026-10-01");
        ev.remove("einverstaendnis");
        assertThat(ruf(a, HttpMethod.PUT, "/foerderweg", ev).status()).isEqualTo(200);
        assertThat(root.queryForObject("SELECT netzladen_erlaubt FROM site WHERE id = ?", Boolean.class, a.id()))
                .as("Einspeisevergütung schließt Netzladen aus").isFalse();

        Antwort netz = ruf(a, HttpMethod.PUT, "", site(true, "eigenverbrauch"));
        assertThat(netz.status()).isEqualTo(409);
        assertThat(netz.body().path("code").asText()).isEqualTo("netzladen_ausgeschlossen");
        assertThat(root.queryForObject("SELECT netzladen_erlaubt FROM site WHERE id = ?", Boolean.class, a.id()))
                .isFalse();

        Antwort art = ruf(a, HttpMethod.PUT, "", site(false, "direktvermarktung"));
        assertThat(art.status()).isEqualTo(200);
        assertThat(art.body().path("plantKind").asText()).as("plant_kind folgt dem Förderweg").isEqualTo("eigenverbrauch");
    }

    @Test
    void formUndPassung() throws Exception {
        heute("2026-10-20");
        Anlage a = anlage(false, "eigenverbrauch");
        Map<String, Object> fremd = antrag("ungefoerdert", null, "2026-10-01");
        fremd.put("schalter", true);
        Antwort r = ruf(a, HttpMethod.PUT, "/foerderweg", fremd);
        assertThat(r.status()).isEqualTo(400);
        assertThat(r.body().path("feld").asText()).isEqualTo("schalter");

        Antwort weg = ruf(a, HttpMethod.PUT, "/foerderweg", antrag("mischbetrieb", null, "2026-10-01"));
        assertThat(weg.status()).isEqualTo(400);
        assertThat(weg.body().path("code").asText()).isEqualTo("foerderweg_ungueltig");

        Antwort pauschal = ruf(a, HttpMethod.PUT, "/foerderweg", antrag("marktpraemie_pauschal", null, "2026-10-01"));
        assertThat(pauschal.status()).isEqualTo(422);
        assertThat(pauschal.body().path("code").asText()).isEqualTo("pauschaloption_noch_nicht_anwendbar");

        Map<String, Object> ohne = antrag("ungefoerdert", "A10", "2026-10-01");
        ohne.remove("einverstaendnis");
        Antwort einv = ruf(a, HttpMethod.PUT, "/foerderweg", ohne);
        assertThat(einv.status()).isEqualTo(422);
        assertThat(einv.body().path("code").asText()).isEqualTo("einverstaendnis_fehlt");
        assertThat(fassungen(a)).isZero();
    }

    @Test
    void fremdeAnlageIst404() throws Exception {
        heute("2026-10-20");
        Anlage a = anlage(false, "eigenverbrauch");
        Anlage b = anlage(false, "eigenverbrauch");
        Anlage fremd = new Anlage(b.mandant(), a.id());
        assertThat(ruf(fremd, HttpMethod.GET, "/foerderweg", null).status()).isEqualTo(404);
        assertThat(ruf(fremd, HttpMethod.PUT, "/foerderweg", antrag("ungefoerdert", null, "2026-10-01")).status())
                .isEqualTo(404);
        assertThat(fassungen(a)).isZero();
        assertThat(root.queryForObject("SELECT netzladen_erlaubt FROM site WHERE id = ?", Boolean.class, a.id()))
                .isFalse();
    }

    // ------------------------------------------------------------------ Hilfen

    private void heute(String tag) {
        wege.uhrStellen(Clock.fixed(Instant.parse(tag + "T10:00:00Z"), ZoneOffset.UTC));
    }

    private Anlage anlage(boolean netzladen, String plantKind) {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "MiSpeL Förderweg #" + nr);
        UUID s = root.queryForObject("INSERT INTO site (tenant_id, name, plant_kind, netzladen_erlaubt, max_feed_in_kw) "
                + "VALUES (?, ?, ?, ?, 29.5) RETURNING id", UUID.class, t, "Halle F" + nr, plantKind, netzladen);
        return new Anlage(t, s);
    }

    private static String zeile(Anlage a) {
        return root.queryForObject("SELECT to_jsonb(s)::text FROM site s WHERE id = ?", String.class, a.id());
    }

    private static int fassungen(Anlage a) {
        return root.queryForObject("SELECT count(*) FROM site_foerderweg WHERE site_id = ?", Integer.class, a.id());
    }

    private static Map<String, Object> antrag(String weg, String formelsatz, String ab) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("foerderweg", weg);
        b.put("formelsatz", formelsatz);
        b.put("einverstaendnis", true);
        b.put("gueltig_ab", ab);
        return b;
    }

    private static Map<String, Object> site(boolean netzladen, String plantKind) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("name", "Halle F");
        b.put("plantKind", plantKind);
        b.put("netzladenErlaubt", netzladen);
        return b;
    }

    private Antwort ruf(Anlage a, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, "/api/v1/sites/" + a.id() + pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-mispel-" + a.mandant());
                    j.claim("name", "Mara Test");
                    j.claim("tenant_id", a.mandant().toString());
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
