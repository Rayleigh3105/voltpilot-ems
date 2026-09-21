package com.voltpilot.api.chargers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.mockingDetails;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
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
 * Der Grenzblatt-Anstoß (UEMS AP-15 IP-3, Folgepaket) gegen die echte Kette: das Ladepark-Dokument reist neu, wenn
 * (a) am Tageswechsel eine Fassung beginnt oder endet ({@link LadeparkGrenzeLaeufer}, auch nach einem Ausfall),
 * (b) die Anlage gebunden oder umgebunden wird, (c) eine wirksame Fassung aufgehoben wird — jeweils NUR mit anderem
 * wirksamem Bezug, und nie ohne Rahmen oder ohne Bindung. Gezählt wird am Publisher (Mock, liefert „zugestellt“).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class LadeparkGrenzeAnstossApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");

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

    @Autowired
    ChargingConfigService ladepark;

    @Autowired
    LadeparkNetzgrenzeRepository zugestellt;

    @Autowired
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate adminJdbc;

    @MockBean
    ChargingConfigPublisher publisher;

    private LadeparkGrenzeLaeufer laeufer;
    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    /** Ein Kundenbereich: Standort ST-1, Anlage AN-1 (mit Box) an ST-1, Netzanschluss NA-1 (630 kVA, 550 kW). */
    private record Welt(UUID mandant, UUID st1, UUID an1, UUID na1) {
        String anschluesse() {
            return "/api/v1/standorte/" + st1 + "/netzanschluesse";
        }

        String grenzen() {
            return anschluesse() + "/" + na1 + "/grenzen";
        }
    }

    private record Antwort(int status, JsonNode body) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void zustellungGelingt() {
        when(publisher.publish(any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(Instant.class))).thenReturn(true);
        laeufer = new LadeparkGrenzeLaeufer(adminJdbc, zugestellt, ladepark);
    }

    @AfterEach
    void uhrZurueck() {
        ladepark.uhrStellen(Clock.systemUTC());
    }

    // ================================================================= (a) Tageswechsel

    @Test
    void aFassungAbMorgenStelltHeuteNichtsZuUndNachDemTageswechselGenauEinmalDenEngerenWert() throws Exception {
        Welt w = welt(600.0);
        binden(w, w.na1(), heute().minusDays(30));
        assertThat(zustellungen(w)).as("gebunden ohne Blatt: Wert gleich").isEmpty();

        ok(ruf(w, HttpMethod.POST, w.grenzen(), grenze(heute().plusDays(1), null, 550)), 201);
        assertThat(zustellungen(w)).as("Fassung ab morgen: heute keine Zustellung").isEmpty();
        laeufer.lauf();
        assertThat(zustellungen(w)).as("Lauf heute: Wert gleich").isEmpty();

        amTag(1);
        laeufer.lauf();
        assertThat(zustellungen(w)).as("nach dem Tageswechsel genau eine Zustellung, der engere Wert")
                .containsExactly(550.0);
        clearInvocations(publisher);
        laeufer.lauf();
        laeufer.lauf();
        assertThat(zustellungen(w)).as("weitere Takte desselben Tages sind still").isEmpty();

        ok(ruf(w, HttpMethod.POST, w.grenzen(), grenze(heute().plusDays(2), null, null)), 201);
        amTag(2);
        laeufer.lauf();
        assertThat(zustellungen(w)).as("die Fassung endet: zurück zum Rahmen").containsExactly(600.0);
    }

    @Test
    void aNachEinemAusfallHoltDerLaufNachStattSichAufGesternZuVerlassen() throws Exception {
        Welt w = welt(600.0);
        binden(w, w.na1(), heute().minusDays(30));
        ok(ruf(w, HttpMethod.POST, w.grenzen(), grenze(heute().plusDays(1), null, 500)), 201);
        amTag(3);
        laeufer.lauf();
        assertThat(zustellungen(w)).as("drei Tage kein Lauf: der erste holt nach").containsExactly(500.0);
        clearInvocations(publisher);
        laeufer.lauf();
        assertThat(zustellungen(w)).isEmpty();
    }

    @Test
    void aEineWeitereFassungAmTageswechselStelltNichtsZuWeilDerWertGleichBleibt() throws Exception {
        Welt w = welt(400.0);
        binden(w, w.na1(), heute().minusDays(30));
        ok(ruf(w, HttpMethod.POST, w.grenzen(), grenze(heute().plusDays(1), null, 500)), 201);
        amTag(1);
        laeufer.lauf();
        assertThat(zustellungen(w)).as("Netzanschluss weiter als der Rahmen: es gilt weiter 400").isEmpty();
    }

    // ================================================================= (b) Bindung

    @Test
    void bBindenUndUmbindenStellenDenNeuenWertZuUndNurWennErSichAendert() throws Exception {
        Welt w = welt(600.0);
        ok(ruf(w, HttpMethod.POST, w.grenzen(), grenze(heute().minusDays(1), null, 550)), 201);
        assertThat(zustellungen(w)).as("ungebunden: das Blatt trifft keine Anlage").isEmpty();

        binden(w, w.na1(), heute().minusDays(30));
        assertThat(zustellungen(w)).as("gebunden: der engere Wert reist sofort").containsExactly(550.0);
        clearInvocations(publisher);

        UUID na2 = anschluss(w, "NA-2", "47110000002");
        binden(w, na2, heute());
        assertThat(zustellungen(w)).as("umgebunden an NA-2 ohne Blatt: zurück zum Rahmen").containsExactly(600.0);
        clearInvocations(publisher);
        laeufer.lauf();
        assertThat(zustellungen(w)).as("der Lauf danach ist still").isEmpty();
    }

    @Test
    void bBindenOhneAnderenWertStelltNichtsZu() throws Exception {
        Welt w = welt(400.0);
        ok(ruf(w, HttpMethod.POST, w.grenzen(), grenze(heute().minusDays(1), 100, 500)), 201);
        binden(w, w.na1(), heute().minusDays(30));
        assertThat(zustellungen(w)).as("Bezug des Anschlusses weiter als der Rahmen").isEmpty();

        Welt v = welt(600.0);
        binden(v, v.na1(), heute().plusDays(1));
        assertThat(zustellungen(v)).as("Bindung erst ab morgen, ohne Blatt").isEmpty();
    }

    // ================================================================= (c) Aufheben

    @Test
    void cEineAufgehobeneWirksameFassungStelltDenRahmenZuUndEineReineEinspeiseaenderungNicht() throws Exception {
        Welt w = welt(600.0);
        binden(w, w.na1(), heute().minusDays(30));
        ok(ruf(w, HttpMethod.POST, w.grenzen(), grenze(heute().minusDays(1), 100, 550)), 201);
        assertThat(zustellungen(w)).containsExactly(550.0);
        clearInvocations(publisher);

        ok(ruf(w, HttpMethod.POST, w.grenzen(), grenze(heute().minusDays(1), 90, 550)), 201);
        assertThat(zustellungen(w)).as("neue Fassung, derselbe Bezug").isEmpty();

        ok(ruf(w, HttpMethod.POST, w.grenzen(), grenze(heute().minusDays(1), 90, null)), 201);
        assertThat(zustellungen(w)).as("die wirksame Bezugsgrenze ist aufgehoben").containsExactly(600.0);
        clearInvocations(publisher);
        laeufer.lauf();
        assertThat(zustellungen(w)).as("der Lauf danach ist still").isEmpty();
    }

    // ================================================================= nie: ohne Rahmen, ohne Bindung

    @Test
    void ohneRahmenOderOhneBindungNieEineZustellung() throws Exception {
        Welt ohneRahmen = welt(null);
        binden(ohneRahmen, ohneRahmen.na1(), heute().minusDays(30));
        ok(ruf(ohneRahmen, HttpMethod.POST, ohneRahmen.grenzen(), grenze(heute().minusDays(1), null, 300)), 201);
        ok(ruf(ohneRahmen, HttpMethod.POST, ohneRahmen.grenzen(), grenze(heute().plusDays(1), null, 200)), 201);

        Welt ohneBindung = welt(600.0);
        ok(ruf(ohneBindung, HttpMethod.POST, ohneBindung.grenzen(), grenze(heute().minusDays(1), null, 300)), 201);
        ok(ruf(ohneBindung, HttpMethod.POST, ohneBindung.grenzen(), grenze(heute().plusDays(1), null, 200)), 201);

        for (int tag = 0; tag <= 2; tag++) {
            amTag(tag);
            laeufer.lauf();
        }
        for (Welt w : List.of(ohneRahmen, ohneBindung)) {
            assertThat(zustellungen(w)).as("nie eine Zustellung").isEmpty();
            assertThat(root.queryForObject("SELECT count(*) FROM ladepark_netzgrenze_zugestellt WHERE site_id = ?",
                    Integer.class, w.an1())).isZero();
        }
    }

    @Test
    void dieTabelleHatErzwungeneRlsUndKeinLoeschrechtDerApp() {
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'ladepark_netzgrenze_zugestellt'", Boolean.class)).isTrue();
        assertThat(root.queryForObject("SELECT has_table_privilege(?, 'ladepark_netzgrenze_zugestellt', 'DELETE')",
                Boolean.class, APP_USER)).isFalse();
    }

    // ============================================================================== Gerüst

    private static LocalDate heute() {
        return LocalDate.now(BERLIN);
    }

    /** Die Uhr des Ladeparks {@code tage} Tage weiter (der Tag des Standorts). */
    private void amTag(int tage) {
        ladepark.uhrStellen(Clock.fixed(Instant.now().plus(Duration.ofDays(tage)), ZoneOffset.UTC));
    }

    /** Die Bezugswerte ({@code grid_limit_kw}) aller Zustellungen an die Anlage der Welt, in Reihenfolge. */
    private List<Double> zustellungen(Welt w) {
        List<Double> werte = new ArrayList<>();
        mockingDetails(publisher).getInvocations().stream()
                .filter(i -> i.getMethod().getName().equals("publish") && w.an1().equals(i.getArgument(1)))
                .forEach(i -> werte.add(i.getArgument(3)));
        return werte;
    }

    private Welt welt(Double rahmen) throws Exception {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Anstoß #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, "
                + "'Kunststoffwerk Ahrenberg GmbH', 'Europe/Berlin') RETURNING id", UUID.class, t);
        UUID st1 = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class,
                t, u);
        UUID an1 = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Werk Ahrenberg – Halle 1') "
                + "RETURNING id", UUID.class, t);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?, ?, ?, ?)", t,
                an1, st1, heute().minusDays(60));
        root.update("INSERT INTO device (id, tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, ?, 'claimed')",
                UUID.randomUUID(), t, an1, "anstoss-box-" + nr);
        if (rahmen != null) {
            root.update("INSERT INTO site_charging_config (site_id, tenant_id, grid_limit_kw) VALUES (?, ?, ?)", an1, t,
                    rahmen);
        }
        Welt ohneNa = new Welt(t, st1, an1, null);
        return new Welt(t, st1, an1, anschluss(ohneNa, "NA-1", "47110000001"));
    }

    private UUID anschluss(Welt w, String kennzeichen, String malo) throws Exception {
        Map<String, Object> na = new LinkedHashMap<>();
        na.put("kennzeichen", kennzeichen);
        na.put("name", "Übergabestation " + kennzeichen);
        na.put("malo", malo);
        na.put("netzbetreiber", "Netzgesellschaft Ahrental (fiktiv)");
        na.put("anschluss_kva", 630);
        na.put("vereinbart_kw", 550);
        na.put("messung", "RLM");
        Antwort a = ok(ruf(w, HttpMethod.POST, w.anschluesse(), na), 201);
        return UUID.fromString(a.body().get("id").asText());
    }

    private void binden(Welt w, UUID na, LocalDate ab) throws Exception {
        ok(ruf(w, HttpMethod.POST, w.anschluesse() + "/" + na + "/anlagen",
                Map.of("anlage_id", w.an1().toString(), "gueltig_ab", ab.toString())), 201);
    }

    private static Map<String, Object> grenze(LocalDate ab, Object einspeisung, Object bezug) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("gueltig_ab", ab.toString());
        m.put("einspeisegrenze_kw", einspeisung);
        m.put("bezugsgrenze_kw", bezug);
        return m;
    }

    private static Antwort ok(Antwort a, int status) {
        assertThat(a.status()).as(a.body().toString()).isEqualTo(status);
        return a;
    }

    private Antwort ruf(Welt w, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-jonas-" + w.mandant());
                    j.claim("preferred_username", "Jonas Wendlinger");
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
