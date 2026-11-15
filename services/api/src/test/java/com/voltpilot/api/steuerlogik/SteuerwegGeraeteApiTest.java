package com.voltpilot.api.steuerlogik;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.TestDatenbank;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.consumers.ConsumerPolicyCompiler;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.flows.FlowActivationService;
import com.voltpilot.api.flows.FlowCompiler;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import com.voltpilot.api.ota.BoxArt;
import com.voltpilot.api.repo.UpdateStatusRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.InOrder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * Steuerlogik Stufe 6, Zusammenführen, dritter Teil, über die echte API und Datenbank: die Verbraucherregel einer
 * Steuerart (der generierte Flow) und der Heizstab-Regler (der Block im Registry-Push) laufen als Logik des Kerns, nach
 * demselben Schalter je Anlage wie die Regeln. Ab Werk aus; Mitlauf vor Übernehmen; nach „Übernehmen“ bleibt der Flow
 * aus dem Satz und der Block aus der Registry (erst der Satz, dann die Registry); „Zurück“ wirkt sofort (erst die
 * Registry, dann der Satz). Ändert sich eine Quelle, übersetzt die API neu; geht das nicht, führt der alte Weg. Der
 * Dienst antwortet mit seinen gepinnten Übersetzungen ({@code steuerlogik-aus-steuerart.valid.pumpe.json},
 * {@code steuerlogik-aus-heizstab.valid.heizstab.json}, gehalten von {@code logikdienst/zusammen3_test.go}).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class SteuerwegGeraeteApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path V2 = Path.of("../../docs/contracts/v2");
    /** Die Kennungen der gepinnten Antworten, die die Welt durch ihre eigenen ersetzt. */
    private static final String PUMPE_IM_BEISPIEL = "44444444-4444-4444-8444-444444444444";
    private static final String STAB_IM_BEISPIEL = "33333333-3333-4333-8333-333333333333";

    @Container
    static final TestDatenbank POSTGRES = new TestDatenbank();

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
    @Autowired FlowActivationService aktivierung;
    @Autowired EntityRegistryService registry;
    @MockitoSpyBean BoxFaehigkeiten faehigkeiten;
    @MockitoSpyBean UpdateStatusRepository updateStatus;
    @MockitoBean SteuerlogikDienst dienst;
    @MockitoBean FlowCompiler compiler;
    @MockitoBean FlowDeploymentPublisher publisher;
    @MockitoBean EntityRegistryPublisher registryPublisher;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();
    private final List<SteuerlogikDienst.Auftrag> auftraege = new ArrayList<>();
    /** Der Dienst ist nicht erreichbar. */
    private boolean dienstWeg;

    /** Eine Anlage mit Box, einer Pumpe mit Steuerart „Solar-Überschuss“ (Flow) und einem Heizstab (Block). */
    private record Welt(UUID mandant, UUID site, UUID box, UUID pumpe, UUID stab) {
        String weg() {
            return "/api/v1/sites/" + site + "/steuerlogik/steuerweg";
        }

        String sub(String rolle) {
            return "sub-" + rolle + "-" + mandant;
        }

        UUID flow() {
            return ConsumerPolicyCompiler.generatedFlowId(pumpe);
        }

        UUID logikPumpe() {
            return SteuerwegGeraete.logikIdSteuerart(pumpe);
        }

        UUID logikStab() {
            return SteuerwegGeraete.logikIdHeizstab(stab);
        }
    }

    private record Antwort(int status, JsonNode body) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void dienstWieGepinnt() throws Exception {
        String steuerart = Files.readString(V2.resolve("examples/steuerlogik-aus-steuerart.valid.pumpe.json"));
        String stab = Files.readString(V2.resolve("examples/steuerlogik-aus-heizstab.valid.heizstab.json"));
        when(dienst.ausSteuerart(any(), anyString(), anyInt(), any())).thenAnswer(inv -> {
            if (dienstWeg) throw SteuerlogikDienstException.nichtErreichbar();
            JsonNode doc = inv.getArgument(0);
            return MAPPER.readTree(steuerart.replace(PUMPE_IM_BEISPIEL, doc.path("origin").path("entity_id").asText()));
        });
        when(dienst.ausHeizstab(any(), any(), any(), any())).thenAnswer(inv -> {
            if (dienstWeg) throw SteuerlogikDienstException.nichtErreichbar();
            UUID id = inv.getArgument(0);
            return MAPPER.readTree(stab.replace(STAB_IM_BEISPIEL, id.toString()));
        });
        when(dienst.artefakt(any())).thenAnswer(inv -> {
            if (dienstWeg) throw SteuerlogikDienstException.nichtErreichbar();
            SteuerlogikDienst.Auftrag a = inv.getArgument(0);
            auftraege.add(a);
            ObjectNode art = MAPPER.createObjectNode();
            art.put("schema_version", "1.0").put("kind", "artifact")
                    .put("artifact_id", UUID.nameUUIDFromBytes((a.logikId() + "|" + a.fassung())
                            .getBytes(StandardCharsets.UTF_8)).toString())
                    .put("flow_id", a.logikId().toString()).put("flow_version", a.fassung()).put("runtime", "edge")
                    .put("compiled_at", "2026-11-15T12:00:00Z").put("compiler_version", "1.0.0")
                    .put("min_palette_version", "0.0.0").put("min_core_version", "0.1.0");
            ObjectNode bundle = art.putObject("bundle");
            bundle.put("format", "steuerlogik").put("logic", "{\"logic\":1}");
            if (a.scharf()) bundle.put("armed", true);
            art.putArray("required_entities");
            art.put("content_hash", "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(bundle.toString().getBytes(StandardCharsets.UTF_8))));
            ObjectNode bericht = MAPPER.createObjectNode().put("name", a.logikId().toString());
            return new SteuerlogikDienst.Artefakt(art, bericht);
        });
        when(publisher.publishDeployment(any(), any(), any(), any())).thenReturn(true);
        when(registryPublisher.publishRegistry(any(), any(), any(), any())).thenReturn(true);
        dienstWeg = false;
    }

    @Test
    void dockerBoxAbWerkAusMitlaufenUebernehmenZurueck() throws Exception {
        Welt w = welt(BoxArt.DOCKER);

        // Ab Werk: der alte Weg für beide Geräte, nichts ist übersetzt; der Stab hat seinen Block, die Pumpe ihren Flow.
        JsonNode stand = als(w, "kundenadministrator", get(w.weg())).body().path("stand");
        assertThat(stand.path("geraeteModus").asText()).isEqualTo("alt");
        assertThat(stand.path("boxKannSteuerarten").asBoolean()).isTrue();
        assertThat(wege(stand)).containsEntry("steuerart", "alt").containsEntry("heizstab", "alt");
        assertThat(zustaende(w.logikPumpe())).isEmpty();
        assertThat(als(w, "bedienberechtigt", post(w.weg() + "/mitlauf")).status()).isEqualTo(403);
        assertThat(als(w, "kundenadministrator", post(w.weg() + "/uebernehmen")).body().path("grund").asText())
                .isEqualTo("erst_mitlaufen");

        // An: beide laufen mit, der alte Weg schaltet weiter - Flow und Block bleiben.
        clearInvocations(publisher, registryPublisher);
        Antwort an = als(w, "kundenadministrator", post(w.weg() + "/mitlauf"));
        assertThat(an.status()).as(an.body().toString()).isEqualTo(200);
        assertThat(an.body().path("stand").path("geraeteModus").asText()).isEqualTo("mitlauf");
        assertThat(wege(an.body().path("stand"))).containsEntry("steuerart", "mitlauf")
                .containsEntry("heizstab", "mitlauf");
        assertThat(zustaende(w.logikPumpe())).containsExactly("mitlaufend");
        assertThat(zustaende(w.logikStab())).containsExactly("mitlaufend");
        JsonNode satz = letzterSatz(w);
        assertThat(nodeRed(satz)).containsExactly(w.flow().toString());
        assertThat(steuerlogik(satz)).hasSize(2).allSatisfy(a -> assertThat(a.path("bundle").path("armed")
                .asBoolean()).isFalse());
        assertThat(letzteRegistry(w, w.stab()).has("heizstab")).isTrue();

        // Die Übersetzungen stehen an ihrer Steuerart: nicht in der Liste der Logiken, nicht zu bearbeiten.
        assertThat(als(w, "kundenadministrator", get("/api/v1/sites/" + w.site() + "/steuerlogik/logiken")).body()
                .path("logiken")).isEmpty();
        Antwort still = als(w, "kundenadministrator",
                post("/api/v1/sites/" + w.site() + "/steuerlogik/" + w.logikStab() + "/stilllegen"));
        assertThat(still.status()).isEqualTo(409);
        assertThat(still.body().path("grund").asText()).isEqualTo("aus_steuerart");

        // Übernehmen: erst der Satz (Flow raus, beide scharf), dann die Registry ohne den Block des Stabs.
        clearInvocations(publisher, registryPublisher);
        Antwort ueber = als(w, "kundenadministrator", post(w.weg() + "/uebernehmen"));
        assertThat(ueber.status()).as(ueber.body().toString()).isEqualTo(200);
        assertThat(wege(ueber.body().path("stand"))).containsEntry("steuerart", "kern").containsEntry("heizstab", "kern");
        assertThat(zustaende(w.logikPumpe())).containsExactly("stillgelegt", "scharf");
        satz = letzterSatz(w);
        assertThat(nodeRed(satz)).isEmpty();
        assertThat(steuerlogik(satz)).hasSize(2).allSatisfy(a -> assertThat(a.path("bundle").path("armed")
                .asBoolean()).isTrue());
        JsonNode stabImPush = letzteRegistry(w, w.stab());
        assertThat(stabImPush.has("heizstab")).as("der Block bleibt draußen").isFalse();
        assertThat(stabImPush.path("owner_claimed").asBoolean()).as("der Plan bleibt draußen").isTrue();
        InOrder reihe = inOrder(publisher, registryPublisher);
        reihe.verify(publisher).publishDeployment(eq(w.mandant()), eq(w.site()), eq(w.box()), any());
        reihe.verify(registryPublisher).publishRegistry(any(), eq(w.site()), eq(w.box()), any());
        assertThat(auftraege.stream().filter(SteuerlogikDienst.Auftrag::scharf).toList()).isNotEmpty();

        // Zurück: erst die Registry mit dem Block (der Regler führt), dann der Satz mit dem Flow und ohne Übersetzung.
        clearInvocations(publisher, registryPublisher);
        Antwort zurueck = als(w, "kundenadministrator", post(w.weg() + "/zurueck"));
        assertThat(zurueck.status()).as(zurueck.body().toString()).isEqualTo(200);
        assertThat(zurueck.body().path("stand").path("geraeteModus").asText()).isEqualTo("alt");
        assertThat(zustaende(w.logikStab())).containsExactly("stillgelegt", "stillgelegt");
        reihe = inOrder(publisher, registryPublisher);
        reihe.verify(registryPublisher).publishRegistry(any(), eq(w.site()), eq(w.box()), any());
        reihe.verify(publisher).publishDeployment(eq(w.mandant()), eq(w.site()), eq(w.box()), any());
        assertThat(letzteRegistry(w, w.stab()).has("heizstab")).isTrue();
        satz = letzterSatz(w);
        assertThat(nodeRed(satz)).containsExactly(w.flow().toString());
        assertThat(steuerlogik(satz)).isEmpty();
        assertThat(root.queryForList("SELECT was FROM steuerweg_schritt WHERE site_id = ? ORDER BY am", String.class,
                w.site())).containsExactly("mitlauf", "kern", "zurueck");
    }

    /** Keine Anlage wechselt still: eine Anlage, deren Regeln schon im Kern laufen, behält für die Geräte den alten Weg. */
    @Test
    void regelnSchonImKernGeraeteBleibenBisZumSchritt() throws Exception {
        Welt w = welt(BoxArt.DOCKER);
        root.update("INSERT INTO steuerweg (site_id, tenant_id, modus, seit) VALUES (?, ?, 'kern', now())", w.site(),
                w.mandant());
        republish(w);
        assertThat(zustaende(w.logikPumpe())).isEmpty();
        JsonNode stand = als(w, "kundenadministrator", get(w.weg())).body().path("stand");
        assertThat(stand.path("modus").asText()).isEqualTo("kern");
        assertThat(stand.path("geraeteModus").asText()).isEqualTo("alt");
        assertThat(nodeRed(letzterSatz(w))).containsExactly(w.flow().toString());
        // Der Schritt „Vergleich starten“ bewegt jetzt nur die Geräte.
        Antwort an = als(w, "kundenadministrator", post(w.weg() + "/mitlauf"));
        assertThat(an.status()).as(an.body().toString()).isEqualTo(200);
        assertThat(an.body().path("stand").path("modus").asText()).isEqualTo("kern");
        assertThat(an.body().path("stand").path("geraeteModus").asText()).isEqualTo("mitlauf");
    }

    /** Ändert sich die Quelle, übersetzt die API neu; ohne Dienst führt der alte Weg, nie zwei, nie keiner. */
    @Test
    void eineGeaenderteQuelleWirdNeuUebersetztOhneDienstFuehrtDerAlteWeg() throws Exception {
        Welt w = welt(BoxArt.DOCKER);
        assertThat(als(w, "kundenadministrator", post(w.weg() + "/mitlauf")).status()).isEqualTo(200);
        assertThat(als(w, "kundenadministrator", post(w.weg() + "/uebernehmen")).status()).isEqualTo(200);

        // Die Mindestlaufzeit des Stabs ändert sich: der Block ändert sich, die Registry übersetzt vorher neu.
        root.update("UPDATE consumer_profile SET min_on_seconds = 600 WHERE entity_id = ?", w.stab());
        clearInvocations(publisher, registryPublisher);
        schiebeRegistry(w);
        assertThat(zustaende(w.logikStab())).containsExactly("stillgelegt", "stillgelegt", "scharf");
        assertThat(letzteRegistry(w, w.stab()).has("heizstab")).isFalse();

        // Die Steuerart der Pumpe bekommt eine neue Fassung: ihr Flow ändert sich, der Satz übersetzt vorher neu.
        root.update("UPDATE flow_definition SET lifecycle = 'retired' WHERE flow_id = ?", w.flow());
        legeFlowAn(w, 2);
        clearInvocations(publisher);
        republish(w);
        assertThat(zustaende(w.logikPumpe())).containsExactly("stillgelegt", "stillgelegt", "scharf");
        assertThat(root.queryForObject("SELECT herkunft_fassung FROM steuerlogik WHERE logik_id = ? AND zustand = "
                + "'scharf'", Integer.class, w.logikPumpe())).isEqualTo(2);
        assertThat(nodeRed(letzterSatz(w))).isEmpty();

        // Ohne Dienst lässt sich eine geänderte Quelle nicht übersetzen: die Übersetzung hört auf, der alte Weg führt.
        dienstWeg = true;
        root.update("UPDATE consumer_profile SET min_on_seconds = 900 WHERE entity_id = ?", w.stab());
        root.update("UPDATE flow_definition SET lifecycle = 'retired' WHERE flow_id = ?", w.flow());
        legeFlowAn(w, 3);
        clearInvocations(publisher, registryPublisher);
        schiebeRegistry(w);
        assertThat(zustaende(w.logikStab()).get(zustaende(w.logikStab()).size() - 1)).isEqualTo("stillgelegt");
        assertThat(zustaende(w.logikPumpe()).get(zustaende(w.logikPumpe()).size() - 1)).isEqualTo("stillgelegt");
        assertThat(letzteRegistry(w, w.stab()).has("heizstab")).isTrue();
        JsonNode satz = letzterSatz(w);
        assertThat(nodeRed(satz)).containsExactly(w.flow().toString());
        assertThat(steuerlogik(satz)).isEmpty();
        JsonNode stand = als(w, "kundenadministrator", get(w.weg())).body().path("stand");
        assertThat(wege(stand)).containsEntry("steuerart", "alt").containsEntry("heizstab", "alt");
    }

    /** Auf Edge Light gibt es für Steuerarten und den Heizstab-Regler den alten Weg: derselbe Schalter gilt dort auch. */
    @Test
    void edgeLightSchaltetDieGeraeteUeberDenSchalter() throws Exception {
        Welt w = welt(BoxArt.LIGHT);
        JsonNode stand = als(w, "kundenadministrator", get(w.weg())).body().path("stand");
        assertThat(stand.path("boxArt").asText()).isEqualTo("light");
        assertThat(stand.path("modus").asText()).isEqualTo("kern");
        assertThat(stand.path("geraeteModus").asText()).isEqualTo("alt");
        Antwort an = als(w, "kundenadministrator", post(w.weg() + "/mitlauf"));
        assertThat(an.status()).as(an.body().toString()).isEqualTo(200);
        assertThat(an.body().path("stand").path("geraeteModus").asText()).isEqualTo("mitlauf");
        assertThat(als(w, "kundenadministrator", post(w.weg() + "/uebernehmen")).status()).isEqualTo(200);
        assertThat(nodeRed(letzterSatz(w))).isEmpty();
        assertThat(letzteRegistry(w, w.stab()).has("heizstab")).isFalse();

        // Ohne steuerlogik_steuerarten kann die Edge Light den Schalter nicht stellen; der Satz bleibt beim alten Weg.
        Welt alt = welt(BoxArt.LIGHT);
        doReturn(false).when(faehigkeiten).kann(alt.box(), SteuerwegGeraete.FAEHIGKEIT);
        Antwort nein = als(alt, "kundenadministrator", post(alt.weg() + "/mitlauf"));
        assertThat(nein.status()).isEqualTo(409);
        assertThat(nein.body().path("grund").asText()).isEqualTo("edge_light");
        assertThat(nein.body().path("message").asText()).contains(SteuerwegGeraete.FAEHIGKEIT);
    }

    /** Ohne die Fähigkeit bewegt der Schritt auf der Docker-Box nur die Regeln; die Geräte bleiben, mit Grund. */
    @Test
    void ohneFaehigkeitBleibenDieGeraeteAufDemAltenWeg() throws Exception {
        Welt w = welt(BoxArt.DOCKER);
        doReturn(false).when(faehigkeiten).kann(w.box(), SteuerwegGeraete.FAEHIGKEIT);
        Antwort an = als(w, "kundenadministrator", post(w.weg() + "/mitlauf"));
        assertThat(an.status()).as(an.body().toString()).isEqualTo(200);
        assertThat(an.body().path("stand").path("modus").asText()).isEqualTo("mitlauf");
        assertThat(an.body().path("stand").path("geraeteModus").asText()).isEqualTo("alt");
        assertThat(zustaende(w.logikPumpe())).isEmpty();
        assertThat(nodeRed(letzterSatz(w))).containsExactly(w.flow().toString());
    }

    // --- Welt ----------------------------------------------------------------------------------------------------

    private Welt welt(String boxArt) throws Exception {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Geräteweg #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, "
                + "'Europe/Berlin') RETURNING id", UUID.class, t, "Haus " + nr);
        UUID standort = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, "
                + "zeitzone, zustand) VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u,
                "Haus " + nr, "G-" + nr);
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name, latitude, longitude) VALUES (?, 'Haus "
                + nr + "', 48.137, 11.575) RETURNING id", UUID.class, t);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES "
                + "(?, ?, ?, '2024-01-01')", t, site, standort);
        UUID box = UUID.randomUUID();
        root.update("INSERT INTO device (id, tenant_id, site_id, external_ref, kind) VALUES (?, ?, ?, ?, 'edge')",
                box, t, site, "edge-geraeteweg-" + nr);
        UUID pumpe = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "capabilities) VALUES (?, ?, 'switchable-load', 'Pumpe', 'switchable-load', '{\"measure\":[],"
                + "\"actuate\":[{\"command\":\"on_off\"}]}'::jsonb) RETURNING id", UUID.class, t, site);
        root.update("INSERT INTO consumer_profile (entity_id, tenant_id, site_id, control_kind, rated_power_kw) "
                + "VALUES (?, ?, ?, 'on_off', 0.4)", pumpe, t, site);
        UUID stab = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "device_id, communication, connection_json, capabilities) VALUES (?, ?, 'heating-rod', 'Heizstab', "
                + "'heating-rod', ?, 'shelly_http', '{\"ip\":\"192.168.1.20\",\"port\":80,\"channels\":[0,1,2],"
                + "\"output_kw\":[2,2,2],\"stages\":[1,2,3],\"anschluss\":\"stern_mit_n\"}'::jsonb, '{\"measure\":[],"
                + "\"actuate\":[{\"command\":\"on_off\"},{\"command\":\"setpoint_kw\"}]}'::jsonb) RETURNING id",
                UUID.class, t, site, box);
        root.update("INSERT INTO consumer_profile (entity_id, tenant_id, site_id, control_kind, rated_power_kw, "
                + "storage_relation, min_on_seconds, enabled) VALUES (?, ?, ?, 'stepped', 6, 'storage_first', 300, "
                + "true)", stab, t, site);
        root.update("INSERT INTO consumer_policy (entity_id, tenant_id, site_id, version, lifecycle, document, "
                + "content_hash) VALUES (?, ?, ?, 1, 'active', '{\"requirements\":[{\"id\":\"ueberschuss\"}]}'::jsonb, "
                + "'x')", stab, t, site);
        Welt w = new Welt(t, site, box, pumpe, stab);
        for (String[] r : List.of(new String[] {"kundenadministrator", null}, new String[] {"bedienberechtigt", "s"})) {
            root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', "
                    + "?, 'aktiv')", t, w.sub(r[0]), "Person " + r[0]);
            root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                    + "VALUES (?, ?, ?, ?, '2024-01-01T00:00:00+01:00'::timestamptz, 'Europe/Berlin')", t, w.sub(r[0]),
                    r[0], r[1] == null ? null : standort);
        }
        for (String f : List.of(SteuerlogikAuslieferung.FAEHIGKEIT, SteuerlogikAuslieferung.FAEHIGKEIT_SCHARF,
                SteuerlogikAuslieferung.FAEHIGKEIT_REGELN, SteuerwegGeraete.FAEHIGKEIT, "heizstab_regler")) {
            doReturn(true).when(faehigkeiten).kann(box, f);
        }
        doReturn(boxArt).when(updateStatus).boxArt(box);
        legeFlowAn(w, 1);
        return w;
    }

    /** Der generierte Flow der Steuerart der Pumpe, wie die Aktivierung ihn ablegt (eine Fassung je Policy-Fassung). */
    private void legeFlowAn(Welt w, int fassung) throws Exception {
        ObjectNode doc = (ObjectNode) MAPPER.readTree("""
                {"schema_version":"1.0","name":"Verbraucherregel: Pumpe","runtime":"edge",
                 "origin":{"kind":"consumer-policy","policy_id":"7c1e0c9a-0000-4000-8000-000000000001","entity_id":"%s"},
                 "nodes":[{"id":"reaktiv","type":"vp.consumer.reactive","type_version":"1.0.0","parameters":
                  {"entity_id":"%s","command":"on_off","ttl_s":45,"renew_s":15,"off_delay_s":15,"requirements":
                   [{"id":"ueberschuss","must_run":false,"value":true,"condition":{"signal":"site.pv_surplus_kw",
                     "source":"site","channel":"pv_surplus_kw","op":"gt","value":1.5,"reset_value":1.125,
                     "max_age_s":120}}]},"claims":[{"entity_id":"%s","commands":["on_off"]}]}],
                 "edges":[],"triggers":[{"id":"tick","kind":"interval","every_s":15}]}
                """.formatted(w.pumpe(), w.pumpe(), w.pumpe()));
        doc.put("flow_id", w.flow().toString()).put("flow_version", fassung).put("site_id", w.site().toString());
        ObjectNode art = (ObjectNode) MAPPER.readTree(Files.readString(V2.resolve(
                "examples/flow-artifact.valid.artifact.json")));
        art.put("flow_id", w.flow().toString()).put("flow_version", fassung);
        root.update("INSERT INTO flow_definition (flow_id, flow_version, tenant_id, site_id, name, runtime, lifecycle, "
                + "document, artifact, activated_at) VALUES (?, ?, ?, ?, 'Verbraucherregel: Pumpe', 'edge', 'active', "
                + "?::jsonb, ?::jsonb, now())", w.flow(), fassung, w.mandant(), w.site(), doc.toString(),
                art.toString());
    }

    private void republish(Welt w) {
        TenantContext.set(w.mandant());
        try {
            aktivierung.republishForSite(w.site());
        } finally {
            TenantContext.clear();
        }
    }

    private void schiebeRegistry(Welt w) {
        TenantContext.set(w.mandant());
        try {
            registry.pushRegistryBestEffort(w.site());
        } finally {
            TenantContext.clear();
        }
    }

    private static Map<String, String> wege(JsonNode stand) {
        Map<String, String> out = new HashMap<>();
        stand.path("geraete").forEach(g -> out.put(g.path("art").asText(), g.path("weg").asText()));
        return out;
    }

    private static List<String> zustaende(UUID logik) {
        return root.queryForList("SELECT zustand FROM steuerlogik WHERE logik_id = ? ORDER BY fassung", String.class,
                logik);
    }

    private JsonNode letzterSatz(Welt w) throws Exception {
        ArgumentCaptor<byte[]> satz = ArgumentCaptor.forClass(byte[].class);
        verify(publisher, atLeastOnce()).publishDeployment(eq(w.mandant()), eq(w.site()), eq(w.box()), satz.capture());
        return MAPPER.readTree(new String(satz.getValue(), StandardCharsets.UTF_8));
    }

    /** Der Eintrag eines Geräts im zuletzt geschickten Registry-Push. */
    private JsonNode letzteRegistry(Welt w, UUID entity) throws Exception {
        ArgumentCaptor<byte[]> push = ArgumentCaptor.forClass(byte[].class);
        verify(registryPublisher, atLeastOnce()).publishRegistry(any(), eq(w.site()), eq(w.box()), push.capture());
        for (JsonNode e : MAPPER.readTree(new String(push.getValue(), StandardCharsets.UTF_8)).path("entities")) {
            if (entity.toString().equals(e.path("entity_id").asText())) return e;
        }
        throw new AssertionError("Gerät fehlt im Push");
    }

    private static List<String> nodeRed(JsonNode satz) {
        List<String> out = new ArrayList<>();
        satz.path("artifacts").forEach(a -> {
            if ("nodered-tabs".equals(a.path("bundle").path("format").asText())) out.add(a.path("flow_id").asText());
        });
        return out;
    }

    private static List<JsonNode> steuerlogik(JsonNode satz) {
        List<JsonNode> out = new ArrayList<>();
        satz.path("artifacts").forEach(a -> {
            if ("steuerlogik".equals(a.path("bundle").path("format").asText())) out.add(a);
        });
        return out;
    }

    private Antwort als(Welt w, String rolle, MockHttpServletRequestBuilder r) throws Exception {
        Map<String, Object> c = new HashMap<>();
        c.put("sub", w.sub(rolle));
        c.put("preferred_username", w.sub(rolle));
        c.put("realm_access", Map.of("roles", List.of()));
        c.put("tenant_id", w.mandant().toString());
        Jwt jwt = new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600), Map.of("alg", "none"), c);
        MvcResult res = mvc.perform(r.with(authentication(new KeycloakRealmRoleConverter().convert(jwt)))
                .contentType(MediaType.APPLICATION_JSON)).andReturn();
        String text = res.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(res.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
