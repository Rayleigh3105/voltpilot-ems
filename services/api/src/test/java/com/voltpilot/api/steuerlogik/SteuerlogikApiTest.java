package com.voltpilot.api.steuerlogik;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.SteuerlogikRepository;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Steuerlogik Stufe 2, zweiter Teil, über die echte API und Datenbank: die Plattform gibt das Beispiel der
 * Wärmepumpe aus dem Vertrag als Datei ab, der Logik-Dienst (hier sein gepinntes Artefakt,
 * {@code flow-artifact.valid.steuerlogik.json}, das {@code logikdienst_test.go} gegen den echten Dienst hält) baut es,
 * der vollständige Satz geht auf {@code …/v2/flows} an die führende Box, und der Herzschlag-Block, den die Box im
 * selben Beispiel schreibt ({@code steuerlogik-rueckmeldung.valid.waermepumpe.json}, gepinnt von
 * {@code logiklauf_test.go}), landet als Mitlauf und Vergleichsprotokoll im Blatt der Plattform.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class SteuerlogikApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path V2 = Path.of("../../docs/contracts/v2");

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

    @Autowired MockMvc mvc;
    @Autowired DeviceRepository devices;
    @Autowired SteuerlogikRepository logiken;
    @Autowired TransactionTemplate tx;
    @MockitoSpyBean BoxFaehigkeiten faehigkeiten;
    @MockitoBean SteuerlogikDienst dienst;
    @MockitoBean FlowDeploymentPublisher publisher;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();
    private final List<SteuerlogikDienst.Auftrag> auftraege = new ArrayList<>();

    private record Welt(UUID mandant, UUID site, UUID box) {
        String admin() {
            return "/api/v1/admin/sites/" + site + "/steuerlogik";
        }
    }

    private record Antwort(int status, JsonNode body) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    /** Der Dienst antwortet mit seinem gepinnten Artefakt, auf die erbetene Logik und Fassung gestellt. */
    @BeforeEach
    void dienstWieGepinnt() throws Exception {
        JsonNode gepinnt = MAPPER.readTree(Files.readString(V2.resolve("examples/flow-artifact.valid.steuerlogik.json")));
        when(dienst.artefakt(any())).thenAnswer(inv -> {
            SteuerlogikDienst.Auftrag a = inv.getArgument(0);
            auftraege.add(a);
            ObjectNode art = gepinnt.deepCopy();
            art.put("flow_id", a.logikId().toString());
            art.put("flow_version", a.fassung());
            ObjectNode bericht = MAPPER.createObjectNode().put("name", "Wärmepumpe").put("sperrt", false);
            return new SteuerlogikDienst.Artefakt(art, bericht);
        });
        when(publisher.publishDeployment(any(), any(), any(), any())).thenReturn(true);
    }

    @Test
    void beispielLaeuftMitUndDerHerzschlagTraegtDenVergleich() throws Exception {
        Welt w = welt();
        String text = Files.readString(V2.resolve("steuerlogik/waermepumpe.logic.yaml"));

        // Eine Box ohne die Fähigkeit bekommt keine Logik - und nichts ändert sich.
        doReturn(false).when(faehigkeiten).kann(w.box(), SteuerlogikAuslieferung.FAEHIGKEIT);
        Antwort ohne = plattform(w, post(w.admin()).content(text(text)));
        assertThat(ohne.status()).isEqualTo(409);
        assertThat(ohne.body().path("grund").asText()).isEqualTo("box_ohne_mitlauf");
        assertThat(root.queryForObject("SELECT count(*) FROM steuerlogik WHERE site_id = ?", Long.class, w.site()))
                .isZero();
        verify(publisher, never()).publishDeployment(any(), any(), any(), any());

        // Mit der Fähigkeit: angenommen, abgelegt wie gekommen, im Satz an die Box.
        doReturn(true).when(faehigkeiten).kann(w.box(), SteuerlogikAuslieferung.FAEHIGKEIT);
        Antwort neu = plattform(w, post(w.admin()).content(text(text)));
        assertThat(neu.status()).as(neu.body().toString()).isEqualTo(201);
        UUID logik = UUID.fromString(neu.body().path("logikId").asText());
        assertThat(neu.body().path("fassung").asInt()).isEqualTo(1);
        assertThat(neu.body().path("name").asText()).isEqualTo("Wärmepumpe");
        assertThat(neu.body().path("veroeffentlicht").asBoolean()).isTrue();
        assertThat(auftraege.get(0).text()).isEqualTo(text);
        assertThat(auftraege.get(0).ort().zeitzone()).isEqualTo("Europe/Berlin");
        assertThat(auftraege.get(0).ort().breite()).isEqualByComparingTo("48.137");
        assertThat(MAPPER.readTree(auftraege.get(0).registry()).path("site_id").asText())
                .as("der Dienst bekommt den Registry-Inhalt der Anlage für die Proben").isEqualTo(w.site().toString());
        assertThat(root.queryForObject("SELECT quelltext FROM steuerlogik WHERE logik_id = ?", String.class, logik))
                .as("der Text bleibt Byte für Byte").isEqualTo(text);

        JsonNode satz = letzterSatz(w);
        assertThat(satz.path("device_id").asText()).isEqualTo(w.box().toString());
        JsonNode artefakt = einzigesSteuerlogikArtefakt(satz);
        JsonNode gepinnt = MAPPER.readTree(Files.readString(V2.resolve("examples/flow-artifact.valid.steuerlogik.json")));
        assertThat(artefakt.path("flow_id").asText()).isEqualTo(logik.toString());
        assertThat(artefakt.path("bundle")).as("das Bündel des Dienstes, unverändert").isEqualTo(gepinnt.path("bundle"));
        assertThat(artefakt.path("content_hash")).isEqualTo(gepinnt.path("content_hash"));

        // Ein Kundenkonto sieht das Blatt der Plattform nicht.
        assertThat(kunde(w, get(w.admin())).status()).isEqualTo(403);

        // Der Herzschlag der Box mit dem Block aus dem Beispiel.
        SteuerlogikRueckmeldungListener eingang = new SteuerlogikRueckmeldungListener("tcp://127.0.0.1:9", "", "",
                devices, logiken, tx);
        byte[] herzschlag = herzschlag(w, logik, artefakt.path("content_hash").asText());
        eingang.handle(topic(w), herzschlag);
        eingang.handle(topic(w), herzschlag); // dieselbe Meldung noch einmal: nichts doppelt

        JsonNode blatt = plattform(w, get(w.admin())).body();
        assertThat(blatt.path("box").asText()).isEqualTo(w.box().toString());
        assertThat(blatt.path("boxKann").asBoolean()).isTrue();
        JsonNode l = blatt.path("logiken").get(0);
        assertThat(l.path("logikId").asText()).isEqualTo(logik.toString());
        assertThat(l.path("fassungen").get(0).path("zustand").asText()).isEqualTo("mitlaufend");
        JsonNode lauf = l.path("laeufe").get(0);
        assertThat(lauf.path("zustand").asText()).isEqualTo("mitlaufend");
        assertThat(lauf.path("rueckmeldung").path("lage").path("titel").asText()).isEqualTo("Speichert Sonnenstrom");
        JsonNode wp = lauf.path("rueckmeldung").path("geraete").path("wp");
        assertThat(wp.path("abweichend_s").asInt()).isEqualTo(61);
        assertThat(wp.path("verglichen_s").asInt()).isEqualTo(1320);

        JsonNode protokoll = plattform(w, get(w.admin() + "/" + logik + "/wechsel").param("tag", "2026-11-14")).body();
        JsonNode zeilen = protokoll.path("wechsel");
        assertThat(zeilen).hasSize(2);
        assertThat(zeilen.get(0).path("was").asText()).isEqualTo("wunsch");
        assertThat(zeilen.get(0).path("neu").path("ein").asBoolean()).isTrue();
        assertThat(zeilen.get(0).path("andere").path("ein").asBoolean()).isFalse();
        assertThat(zeilen.get(1).path("was").asText()).isEqualTo("ist");
        assertThat(zeilen.get(1).path("t").asText()).isEqualTo("2026-11-14T10:21:01Z");

        // Eine neue Fassung löst die laufende ab; der Satz trägt nur noch sie.
        clearInvocations(publisher);
        Antwort zwei = plattform(w, post(w.admin() + "/" + logik + "/fassungen").content(text(text)));
        assertThat(zwei.status()).isEqualTo(201);
        assertThat(zwei.body().path("fassung").asInt()).isEqualTo(2);
        assertThat(einzigesSteuerlogikArtefakt(letzterSatz(w)).path("flow_version").asInt()).isEqualTo(2);
        assertThat(root.queryForList("SELECT zustand FROM steuerlogik WHERE logik_id = ? ORDER BY fassung", String.class,
                logik)).containsExactly("stillgelegt", "mitlaufend");

        // Stilllegen: der Satz geht ohne die Logik hinaus.
        clearInvocations(publisher);
        Antwort still = plattform(w, post(w.admin() + "/" + logik + "/stilllegen"));
        assertThat(still.body().path("stillgelegt").asBoolean()).isTrue();
        assertThat(steuerlogikArtefakte(letzterSatz(w))).isEmpty();

        // Ein Block ohne gültigen Lauf leert den Mitlauf der Box; ein Herzschlag ohne Block lässt ihn stehen.
        eingang.handle(topic(w), herzschlag);
        eingang.handle(topic(w), MAPPER.writeValueAsBytes(umschlag(w)));
        assertThat(root.queryForObject("SELECT count(*) FROM steuerlogik_lauf WHERE device_id = ?", Long.class,
                w.box())).isOne();
        ObjectNode leer = umschlag(w);
        leer.putObject("logik").putArray("laeufe");
        eingang.handle(topic(w), MAPPER.writeValueAsBytes(leer));
        assertThat(root.queryForObject("SELECT count(*) FROM steuerlogik_lauf WHERE device_id = ?", Long.class,
                w.box())).isZero();
    }

    @Test
    void ehrlicheHalte() throws Exception {
        Welt w = welt();
        doReturn(true).when(faehigkeiten).kann(w.box(), SteuerlogikAuslieferung.FAEHIGKEIT);
        doThrow(new SteuerlogikDienstException(SteuerlogikDienstException.GESPERRT, "Die Prüfung sperrt die Logik",
                MAPPER.createObjectNode().put("sperrt", true))).when(dienst).artefakt(any());
        Antwort gesperrt = plattform(w, post(w.admin()).content(text("logic: 1")));
        assertThat(gesperrt.status()).isEqualTo(422);
        assertThat(gesperrt.body().path("grund").asText()).isEqualTo("pruefung_sperrt");
        assertThat(gesperrt.body().path("bericht").path("sperrt").asBoolean()).isTrue();

        assertThat(plattform(w, post(w.admin()).content(text(" "))).status()).isEqualTo(400);
        assertThat(plattform(w, post(w.admin() + "/" + UUID.randomUUID() + "/fassungen").content(text("x")))
                .status()).isEqualTo(404);
        assertThat(plattform(w, get(w.admin() + "/kein-uuid/wechsel")).status()).isEqualTo(404);

        // Eine Anlage eines anderen Mandanten ist am Umschalter unsichtbar.
        Welt fremd = welt();
        Antwort quer = plattform(w, get("/api/v1/admin/sites/" + fremd.site() + "/steuerlogik"));
        assertThat(quer.status()).isEqualTo(404);
        verify(publisher, never()).publishDeployment(eq(w.mandant()), any(), any(), any());
        assertThat(root.queryForObject("SELECT count(*) FROM steuerlogik WHERE site_id = ?", Long.class, w.site()))
                .isZero();
    }

    // --- Welt und Wege ----------------------------------------------------------------------------------------------

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Steuerlogik #" + nr);
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name, latitude, longitude) VALUES (?, 'Haus "
                + nr + "', 48.137, 11.575) RETURNING id", UUID.class, t);
        UUID box = UUID.randomUUID();
        root.update("INSERT INTO device (id, tenant_id, site_id, external_ref, kind) VALUES (?, ?, ?, ?, 'edge')",
                box, t, site, "edge-steuerlogik-" + nr);
        return new Welt(t, site, box);
    }

    private static String text(String logik) throws Exception {
        return MAPPER.writeValueAsString(MAPPER.createObjectNode().put("text", logik));
    }

    private static String topic(Welt w) {
        return "ems/" + w.mandant() + "/" + w.site() + "/" + w.box() + "/status";
    }

    private static ObjectNode umschlag(Welt w) {
        ObjectNode n = MAPPER.createObjectNode();
        n.put("schema_version", "1.0");
        n.put("tenant_id", w.mandant().toString());
        n.put("site_id", w.site().toString());
        n.put("device_id", w.box().toString());
        n.put("ts", "2026-11-14T10:21:05Z");
        return n;
    }

    /** Der Herzschlag mit dem gepinnten Block der Box, auf diese Logik gestellt. */
    private static byte[] herzschlag(Welt w, UUID logik, String hash) throws Exception {
        ObjectNode block = (ObjectNode) MAPPER.readTree(
                Files.readString(V2.resolve("examples/steuerlogik-rueckmeldung.valid.waermepumpe.json")));
        ObjectNode lauf = (ObjectNode) block.path("laeufe").get(0);
        lauf.put("flow_id", logik.toString());
        lauf.put("content_hash", hash);
        ObjectNode n = umschlag(w);
        n.set("logik", block);
        return MAPPER.writeValueAsBytes(n);
    }

    private JsonNode letzterSatz(Welt w) throws Exception {
        ArgumentCaptor<byte[]> satz = ArgumentCaptor.forClass(byte[].class);
        verify(publisher, org.mockito.Mockito.atLeastOnce())
                .publishDeployment(eq(w.mandant()), eq(w.site()), eq(w.box()), satz.capture());
        return MAPPER.readTree(new String(satz.getValue(), StandardCharsets.UTF_8));
    }

    private static List<JsonNode> steuerlogikArtefakte(JsonNode satz) {
        List<JsonNode> out = new ArrayList<>();
        satz.path("artifacts").forEach(a -> {
            if ("steuerlogik".equals(a.path("bundle").path("format").asText())) out.add(a);
        });
        return out;
    }

    private static JsonNode einzigesSteuerlogikArtefakt(JsonNode satz) {
        List<JsonNode> a = steuerlogikArtefakte(satz);
        assertThat(a).hasSize(1);
        return a.get(0);
    }

    private Antwort kunde(Welt w, MockHttpServletRequestBuilder r) throws Exception {
        return ruf(r.with(jwt().jwt(j -> {
            j.subject("sub-kunde-" + w.mandant());
            j.claim("tenant_id", w.mandant().toString());
        })));
    }

    private Antwort plattform(Welt w, MockHttpServletRequestBuilder r) throws Exception {
        return ruf(r.header("X-Tenant-Id", w.mandant().toString()).with(jwt().jwt(j -> {
            j.subject("sub-betrieb");
            j.claim("preferred_username", "VoltPilot Betrieb");
        }).authorities(new SimpleGrantedAuthority("ROLE_platform-admin"))));
    }

    private Antwort ruf(MockHttpServletRequestBuilder r) throws Exception {
        MvcResult res = mvc.perform(r.contentType(MediaType.APPLICATION_JSON)).andReturn();
        String text = res.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(res.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
