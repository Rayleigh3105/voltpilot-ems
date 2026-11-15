package com.voltpilot.api.steuerlogik;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.flows.FlowActivationService;
import com.voltpilot.api.flows.FlowCompiler;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import com.voltpilot.api.ota.BoxArt;
import com.voltpilot.api.repo.FlowClaimRepository;
import com.voltpilot.api.repo.FlowRepository;
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
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Steuerlogik Stufe 6, Zusammenführen, über die echte API und Datenbank: eine Regel des Regel-Baukastens läuft als
 * Logik des Kerns. Docker-Box: der Schalter der Anlage ist ab Werk aus; an läuft die Übersetzung mit (Node-RED
 * schaltet weiter), erst nach „Übernehmen“ schaltet sie und das Node-RED-Artefakt der Regel bleibt aus dem Satz;
 * „Zurück“ wirkt in derselben Anfrage. Edge Light: eine Regel läuft dort beim Einschalten als scharfe Übersetzung,
 * was sich nicht übersetzt, wird mit Grund abgelehnt. Der Dienst antwortet mit seiner gepinnten Übersetzung
 * ({@code steuerlogik-aus-regel.valid.sonne.json}, gehalten von {@code logikdienst/regel_test.go}).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class SteuerwegApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path V2 = Path.of("../../docs/contracts/v2");
    /** Die Kennungen der Vektoren (regel-kern-vectors.json), die die Welt durch ihre eigenen ersetzt. */
    private static final String NETZ_IM_VEKTOR = "11111111-1111-4111-8111-111111111111";
    private static final String PUMPE_IM_VEKTOR = "44444444-4444-4444-8444-444444444444";

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
        registry.add("voltpilot.flows.activation.enabled", () -> "true");
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot");
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot/protocol/openid-connect/certs");
    }

    @Autowired MockMvc mvc;
    @Autowired FlowActivationService aktivierung;
    @Autowired FlowRepository flows;
    @Autowired FlowClaimRepository claims;
    @Autowired SteuerlogikBesitz besitz;
    @MockitoSpyBean BoxFaehigkeiten faehigkeiten;
    @MockitoSpyBean UpdateStatusRepository updateStatus;
    @MockitoBean SteuerlogikDienst dienst;
    @MockitoBean FlowCompiler compiler;
    @MockitoBean FlowDeploymentPublisher publisher;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();
    private final List<SteuerlogikDienst.Auftrag> auftraege = new ArrayList<>();
    /** Statt der Übersetzung antwortet der Dienst „nicht übersetzbar“ mit diesem Grund (null = übersetzt). */
    private String nichtUebersetzbar;

    /**
     * Eine Anlage mit Box, Netz-Zähler, einem zum Steuern freigegebenen Verbraucher (ein Heizstab, in der Regel
     * „Pumpe“ genannt wie in den Vektoren) und zwei Menschen; {@code regel} ist die eingeschaltete Regel.
     */
    private record Welt(UUID mandant, UUID site, UUID box, UUID netz, UUID pumpe, UUID regel) {
        String weg() {
            return "/api/v1/sites/" + site + "/steuerlogik/steuerweg";
        }

        String sub(String rolle) {
            return "sub-" + rolle + "-" + mandant;
        }
    }

    private record Antwort(int status, JsonNode body) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    /**
     * Der Dienst übersetzt wie gepinnt, auf die Pumpe der Welt gestellt, und baut ein Artefakt mit Logik, Fassung und
     * Zustand des Auftrags; flowc liefert das Beispiel-Artefakt des Vertrags für die Regel.
     */
    @BeforeEach
    void dienstWieGepinnt() throws Exception {
        String gepinnt = Files.readString(V2.resolve("examples/steuerlogik-aus-regel.valid.sonne.json"));
        when(dienst.ausRegel(any(), anyString(), anyInt(), any())).thenAnswer(inv -> {
            if (nichtUebersetzbar != null) {
                ObjectNode n = MAPPER.createObjectNode().put("uebersetzt", false);
                n.putArray("gruende").addObject().put("code", "messwert").put("text", nichtUebersetzbar);
                return n;
            }
            String registry = inv.getArgument(3);
            String pumpe = pumpeAus(registry);
            return MAPPER.readTree(gepinnt.replace(PUMPE_IM_VEKTOR, pumpe));
        });
        when(dienst.artefakt(any())).thenAnswer(inv -> {
            SteuerlogikDienst.Auftrag a = inv.getArgument(0);
            auftraege.add(a);
            String pumpe = pumpeAus(a.registry());
            JsonNode bericht = MAPPER.readTree(gepinnt.replace(PUMPE_IM_VEKTOR, pumpe)).path("bericht");
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
            var caps = art.putArray("required_entities").addObject().put("entity_id", pumpe).putArray("capabilities");
            if (a.scharf()) caps.add("actuate:on_off");
            art.put("content_hash", "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(bundle.toString().getBytes(StandardCharsets.UTF_8))));
            return new SteuerlogikDienst.Artefakt(art, bericht);
        });
        when(compiler.compile(any())).thenAnswer(inv -> nodeRedArtefakt(inv.getArgument(0)));
        when(publisher.publishDeployment(any(), any(), any(), any())).thenReturn(true);
        nichtUebersetzbar = null;
    }

    @Test
    void dockerBoxSchalterAbWerkAusMitlaufenUebernehmenZurueck() throws Exception {
        Welt w = welt(BoxArt.DOCKER);
        UUID logik = SteuerwegService.logikIdFuer(w.regel());

        // Ab Werk: der alte Weg, die Regel läuft in Node-RED, nichts ist übersetzt.
        JsonNode stand = als(w, "kundenadministrator", get(w.weg())).body();
        assertThat(stand.path("stand").path("modus").asText()).isEqualTo("alt");
        assertThat(stand.path("darf").asBoolean()).isTrue();
        assertThat(stand.path("stand").path("regeln").get(0).path("weg").asText()).isEqualTo("alt");
        assertThat(zustaende(logik)).isEmpty();

        // Wer die Betriebsweise ändert, stellt den Schalter nicht; übernehmen geht erst nach dem Mitlauf.
        assertThat(als(w, "bedienberechtigt", post(w.weg() + "/mitlauf")).status()).isEqualTo(403);
        assertThat(als(w, "bedienberechtigt", get(w.weg())).body().path("darf").asBoolean()).isFalse();
        assertThat(als(w, "kundenadministrator", post(w.weg() + "/uebernehmen")).body().path("grund").asText())
                .isEqualTo("erst_mitlaufen");

        // An: die Übersetzung läuft mit, Node-RED schaltet weiter - beide im Satz, die Logik nicht scharf.
        clearInvocations(publisher);
        Antwort an = als(w, "kundenadministrator", post(w.weg() + "/mitlauf"));
        assertThat(an.status()).as(an.body().toString()).isEqualTo(200);
        assertThat(an.body().path("stand").path("modus").asText()).isEqualTo("mitlauf");
        assertThat(an.body().path("stand").path("regeln").get(0).path("weg").asText()).isEqualTo("mitlauf");
        assertThat(zustaende(logik)).containsExactly("mitlaufend");
        assertThat(root.queryForObject("SELECT herkunft_flow_id FROM steuerlogik WHERE logik_id = ?", UUID.class,
                logik)).isEqualTo(w.regel());
        JsonNode satz = letzterSatz(w);
        assertThat(nodeRed(satz)).containsExactly(w.regel().toString());
        assertThat(steuerlogik(satz)).hasSize(1);
        assertThat(steuerlogik(satz).get(0).path("bundle").path("armed").asBoolean()).isFalse();

        // Die Übersetzung steht an ihrer Regel, nicht in der Liste der Logiken, und lässt sich dort nicht bearbeiten.
        JsonNode liste = als(w, "kundenadministrator", get("/api/v1/sites/" + w.site() + "/steuerlogik/logiken"))
                .body();
        assertThat(liste.path("logiken")).isEmpty();
        Antwort still = als(w, "kundenadministrator",
                post("/api/v1/sites/" + w.site() + "/steuerlogik/" + logik + "/stilllegen"));
        assertThat(still.status()).isEqualTo(409);
        assertThat(still.body().path("grund").asText()).isEqualTo("aus_regel");

        // Der ausdrückliche Schritt: die Übersetzung schaltet, das Node-RED-Artefakt der Regel bleibt aus dem Satz.
        clearInvocations(publisher);
        Antwort ueber = als(w, "kundenadministrator", post(w.weg() + "/uebernehmen"));
        assertThat(ueber.status()).as(ueber.body().toString()).isEqualTo(200);
        assertThat(ueber.body().path("stand").path("regeln").get(0).path("weg").asText()).isEqualTo("kern");
        assertThat(zustaende(logik)).containsExactly("stillgelegt", "scharf");
        satz = letzterSatz(w);
        assertThat(nodeRed(satz)).isEmpty();
        assertThat(steuerlogik(satz)).hasSize(1);
        assertThat(steuerlogik(satz).get(0).path("bundle").path("armed").asBoolean()).isTrue();
        assertThat(besitzer(w)).as("das Gerät gehört weiter der Regel").containsEntry(w.pumpe(), "Sonnen-Überschuss");

        // Meldet die Box steuerlogik_regeln nicht mehr, ginge die Übersetzung nicht hinaus: dann schaltet Node-RED.
        doReturn(false).when(faehigkeiten).kann(w.box(), SteuerlogikAuslieferung.FAEHIGKEIT_REGELN);
        clearInvocations(publisher);
        TenantContext.set(w.mandant());
        try {
            aktivierung.republishForSite(w.site());
        } finally {
            TenantContext.clear();
        }
        satz = letzterSatz(w);
        assertThat(nodeRed(satz)).containsExactly(w.regel().toString());
        assertThat(steuerlogik(satz)).isEmpty();
        doReturn(true).when(faehigkeiten).kann(w.box(), SteuerlogikAuslieferung.FAEHIGKEIT_REGELN);

        // Zurück wirkt sofort: in derselben Anfrage geht der Satz mit Node-RED und ohne Übersetzung hinaus.
        clearInvocations(publisher);
        Antwort zurueck = als(w, "kundenadministrator", post(w.weg() + "/zurueck"));
        assertThat(zurueck.status()).as(zurueck.body().toString()).isEqualTo(200);
        assertThat(zurueck.body().path("stand").path("modus").asText()).isEqualTo("alt");
        assertThat(zustaende(logik)).containsExactly("stillgelegt", "stillgelegt");
        satz = letzterSatz(w);
        assertThat(nodeRed(satz)).containsExactly(w.regel().toString());
        assertThat(steuerlogik(satz)).isEmpty();
        assertThat(root.queryForList("SELECT was FROM steuerweg_schritt WHERE site_id = ? ORDER BY am", String.class,
                w.site())).containsExactly("mitlauf", "kern", "zurueck");
        JsonNode schritte = als(w, "kundenadministrator", get(w.weg())).body().path("stand").path("schritte");
        assertThat(schritte.get(0).path("wer").asText()).isEqualTo("Person kundenadministrator");
        assertThat(schritte.get(0).has("von")).as("keine Kennung eines Kontos im Stand").isFalse();
    }

    @Test
    void eineRegelDieSichNichtUebersetztBleibtAufDemAltenWeg() throws Exception {
        Welt w = welt(BoxArt.DOCKER);
        nichtUebersetzbar = "„Wallbox“ (power_kw) liest die Box für eine Logik nicht.";
        Antwort an = als(w, "kundenadministrator", post(w.weg() + "/mitlauf"));
        assertThat(an.status()).as(an.body().toString()).isEqualTo(200);
        JsonNode regel = an.body().path("stand").path("regeln").get(0);
        assertThat(regel.path("weg").asText()).isEqualTo("alt");
        assertThat(regel.path("gruende").get(0).asText()).contains("Wallbox");
        assertThat(nodeRed(letzterSatz(w))).containsExactly(w.regel().toString());
        assertThat(zustaende(SteuerwegService.logikIdFuer(w.regel()))).isEmpty();
    }

    @Test
    void aufEdgeLightLaeuftEineRegelAlsScharfeUebersetzung() throws Exception {
        Welt w = welt(BoxArt.LIGHT);
        UUID logik = SteuerwegService.logikIdFuer(w.regel());
        // Die Welt legt die Regel aktiv an; hier wird eine zweite Fassung eingeschaltet, wie das Portal es tut.
        root.update("UPDATE flow_definition SET lifecycle = 'retired' WHERE flow_id = ?", w.regel());
        FlowRepository.FlowVersionRow zwei = neueFassung(w, 2);

        // Ohne steuerlogik_regeln lehnt die Edge Light ab wie bisher, mit dem Grund.
        doReturn(false).when(faehigkeiten).kann(w.box(), SteuerlogikAuslieferung.FAEHIGKEIT_REGELN);
        FlowActivationService.ActivationOutcome ohne = aktiviere(w, zwei);
        assertThat(ohne.activated()).isFalse();
        assertThat(ohne.reason()).isEqualTo("box_ohne_regeln");
        doReturn(true).when(faehigkeiten).kann(w.box(), SteuerlogikAuslieferung.FAEHIGKEIT_REGELN);

        // Was sich nicht übersetzt, lehnt sie mit dem Grund der Übersetzung ab; nichts ändert sich.
        nichtUebersetzbar = "„Unterzähler“ (power_kw) liest die Box für eine Logik nicht.";
        FlowActivationService.ActivationOutcome nicht = aktiviere(w, zwei);
        assertThat(nicht.activated()).isFalse();
        assertThat(nicht.reason()).isEqualTo("edge_light_unsupported");
        assertThat(nicht.message()).contains("Unterzähler");
        assertThat(zustaende(logik)).isEmpty();
        nichtUebersetzbar = null;

        // Übersetzbar: die Regel läuft scharf im Kern; ein Node-RED-Artefakt bekommt die Edge Light nicht.
        clearInvocations(publisher);
        FlowActivationService.ActivationOutcome an = aktiviere(w, zwei);
        assertThat(an.activated()).as(an.message()).isTrue();
        assertThat(zustaende(logik)).containsExactly("scharf");
        assertThat(root.queryForObject("SELECT herkunft_fassung FROM steuerlogik WHERE logik_id = ?", Integer.class,
                logik)).isEqualTo(2);
        JsonNode satz = letzterSatz(w);
        assertThat(nodeRed(satz)).isEmpty();
        assertThat(steuerlogik(satz)).hasSize(1);
        assertThat(steuerlogik(satz).get(0).path("bundle").path("armed").asBoolean()).isTrue();
        assertThat(auftraege.get(auftraege.size() - 1).scharf()).isTrue();

        JsonNode stand = als(w, "kundenadministrator", get(w.weg())).body().path("stand");
        assertThat(stand.path("modus").asText()).isEqualTo("kern");
        assertThat(stand.path("boxArt").asText()).isEqualTo("light");
        assertThat(stand.path("regeln").get(0).path("weg").asText()).isEqualTo("kern");
        assertThat(als(w, "kundenadministrator", post(w.weg() + "/mitlauf")).body().path("grund").asText())
                .isEqualTo("edge_light");

        // Ausschalten: die Übersetzung hört mit der Regel auf.
        clearInvocations(publisher);
        TenantContext.set(w.mandant());
        try {
            aktivierung.deactivate(w.site(), w.regel(), flows.findActive(w.regel()));
        } finally {
            TenantContext.clear();
        }
        assertThat(zustaende(logik)).containsExactly("stillgelegt");
        assertThat(steuerlogik(letzterSatz(w))).isEmpty();
    }

    /**
     * Eine geschriebene Logik bekommt kein Gerät, das eine Regel steuert (der Besitz liest die eingeschalteten Regeln
     * der Anlage; vorher fragte er mit {@code flow_id <> NULL} und fand nie eine).
     */
    @Test
    void eineLogikBekommtKeinGeraetDasEineRegelSteuert() throws Exception {
        Welt w = welt(BoxArt.DOCKER);
        ObjectNode bericht = MAPPER.createObjectNode();
        bericht.putArray("geraete").addObject().put("entity_id", w.pumpe().toString()).put("name", "Pumpe");
        TenantContext.set(w.mandant());
        try {
            List<SteuerlogikBesitz.Konflikt> k = besitz.pruefe(w.site(), UUID.randomUUID(), bericht);
            assertThat(k).extracting(SteuerlogikBesitz.Konflikt::art).contains("regel");
        } finally {
            TenantContext.clear();
        }
    }

    // --- Welt ----------------------------------------------------------------------------------------------------

    private Welt welt(String boxArt) throws Exception {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Steuerweg #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, "
                + "'Europe/Berlin') RETURNING id", UUID.class, t, "Haus " + nr);
        UUID standort = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, "
                + "zeitzone, zustand) VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u,
                "Haus " + nr, "W-" + nr);
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name, latitude, longitude) VALUES (?, 'Haus "
                + nr + "', 48.137, 11.575) RETURNING id", UUID.class, t);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES "
                + "(?, ?, ?, '2024-01-01')", t, site, standort);
        UUID box = UUID.randomUUID();
        root.update("INSERT INTO device (id, tenant_id, site_id, external_ref, kind) VALUES (?, ?, ?, ?, 'edge')",
                box, t, site, "edge-steuerweg-" + nr);
        UUID netz = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "capabilities) VALUES (?, ?, 'grid-meter', 'Netzanschluss', 'grid-meter', '{\"measure\":"
                + "[{\"channel\":\"power_kw\"}],\"actuate\":[]}'::jsonb) RETURNING id", UUID.class, t, site);
        UUID pumpe = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "capabilities) VALUES (?, ?, 'heating-rod', 'Pumpe', 'heating-rod', '{\"measure\":[],\"actuate\":"
                + "[{\"command\":\"on_off\"},{\"command\":\"setpoint_kw\"}]}'::jsonb) RETURNING id", UUID.class,
                t, site);
        root.update("INSERT INTO consumer_profile (entity_id, tenant_id, site_id, control_kind, rated_power_kw) "
                + "VALUES (?, ?, ?, 'on_off', 0.4)", pumpe, t, site);
        UUID regel = UUID.randomUUID();
        Welt w = new Welt(t, site, box, netz, pumpe, regel);
        for (String[] r : List.of(new String[] {"kundenadministrator", null}, new String[] {"bedienberechtigt", "s"})) {
            root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', "
                    + "?, 'aktiv')", t, w.sub(r[0]), "Person " + r[0]);
            root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                    + "VALUES (?, ?, ?, ?, '2024-01-01T00:00:00+01:00'::timestamptz, 'Europe/Berlin')", t, w.sub(r[0]),
                    r[0], r[1] == null ? null : standort);
        }
        for (String f : List.of(SteuerlogikAuslieferung.FAEHIGKEIT, SteuerlogikAuslieferung.FAEHIGKEIT_SCHARF,
                SteuerlogikAuslieferung.FAEHIGKEIT_REGELN)) {
            doReturn(true).when(faehigkeiten).kann(box, f);
        }
        doReturn(boxArt).when(updateStatus).boxArt(box);
        // Die Regel „Sonnen-Überschuss: Pumpe einschalten“ aus den Gleichheitsvektoren, eingeschaltet, mit ihrem
        // Node-RED-Artefakt und ihrem Anspruch auf die Pumpe.
        JsonNode doc = dokument(w);
        root.update("INSERT INTO flow_definition (flow_id, flow_version, tenant_id, site_id, name, runtime, lifecycle, "
                + "document, artifact, activated_at) VALUES (?, 1, ?, ?, 'Sonnen-Überschuss', 'edge', 'active', "
                + "?::jsonb, ?::jsonb, now())", regel, t, site, doc.toString(), nodeRedArtefakt(mitId(doc, regel, 1))
                .toString());
        root.update("INSERT INTO flow_claim (entity_id, command, tenant_id, site_id, flow_id, flow_version, flow_name) "
                + "VALUES (?, 'on_off', ?, ?, ?, 1, 'Sonnen-Überschuss')", pumpe, t, site, regel);
        return w;
    }

    private JsonNode dokument(Welt w) throws Exception {
        JsonNode v = MAPPER.readTree(Files.readString(V2.resolve("regel-kern-vectors.json")));
        String doc = v.path("faelle").get(0).path("dokument").toString().replace(NETZ_IM_VEKTOR, w.netz().toString())
                .replace(PUMPE_IM_VEKTOR, w.pumpe().toString());
        ObjectNode n = (ObjectNode) MAPPER.readTree(doc);
        n.put("site_id", w.site().toString());
        return n;
    }

    private static JsonNode mitId(JsonNode doc, UUID flowId, int fassung) {
        ObjectNode n = doc.deepCopy();
        n.put("flow_id", flowId.toString());
        n.put("flow_version", fassung);
        return n;
    }

    private FlowRepository.FlowVersionRow neueFassung(Welt w, int fassung) throws Exception {
        root.update("INSERT INTO flow_definition (flow_id, flow_version, tenant_id, site_id, name, runtime, lifecycle, "
                + "document) VALUES (?, ?, ?, ?, 'Sonnen-Überschuss', 'edge', 'simulated', ?::jsonb)", w.regel(),
                fassung, w.mandant(), w.site(), dokument(w).toString());
        TenantContext.set(w.mandant());
        try {
            return flows.versionsForFlow(w.regel()).get(0);
        } finally {
            TenantContext.clear();
        }
    }

    private FlowActivationService.ActivationOutcome aktiviere(Welt w, FlowRepository.FlowVersionRow row)
            throws Exception {
        TenantContext.set(w.mandant());
        try {
            return aktivierung.activate(w.site(), row, mitId(dokument(w), w.regel(), row.flowVersion()));
        } finally {
            TenantContext.clear();
        }
    }

    /** Das Beispiel-Artefakt des Vertrags (nodered-tabs), auf die Regel gestellt. */
    private static JsonNode nodeRedArtefakt(JsonNode doc) throws Exception {
        ObjectNode art = (ObjectNode) MAPPER.readTree(Files.readString(V2.resolve(
                "examples/flow-artifact.valid.artifact.json")));
        art.put("flow_id", doc.path("flow_id").asText(UUID.randomUUID().toString()));
        art.put("flow_version", doc.path("flow_version").asInt(1));
        return art;
    }

    private static String pumpeAus(String registry) throws Exception {
        for (JsonNode e : MAPPER.readTree(registry).path("entities")) {
            if ("heating-rod".equals(e.path("entity_type").asText())) return e.path("entity_id").asText();
        }
        throw new AssertionError("keine Pumpe im Registry-Inhalt: " + registry);
    }

    private static List<String> zustaende(UUID logik) {
        return root.queryForList("SELECT zustand FROM steuerlogik WHERE logik_id = ? ORDER BY fassung", String.class,
                logik);
    }

    private Map<UUID, String> besitzer(Welt w) {
        TenantContext.set(w.mandant());
        try {
            return claims.claimedEntities(w.site());
        } finally {
            TenantContext.clear();
        }
    }

    private JsonNode letzterSatz(Welt w) throws Exception {
        ArgumentCaptor<byte[]> satz = ArgumentCaptor.forClass(byte[].class);
        verify(publisher, atLeastOnce()).publishDeployment(eq(w.mandant()), eq(w.site()), eq(w.box()), satz.capture());
        return MAPPER.readTree(new String(satz.getValue(), StandardCharsets.UTF_8));
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
