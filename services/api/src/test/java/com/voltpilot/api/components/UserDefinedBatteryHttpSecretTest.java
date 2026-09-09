package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.flows.FlowActivationService;
import com.voltpilot.api.flows.FlowCompiler;
import com.voltpilot.api.repo.FlowRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.topology.TopologyRepository;
import com.voltpilot.api.web.dto.SaveUserDefinedBatteryRequest;
import com.voltpilot.api.web.dto.SaveUserDefinedBatteryRequest.AuthRequest;
import com.voltpilot.api.web.dto.SaveUserDefinedBatteryRequest.EndpointRequest;
import com.voltpilot.api.web.dto.SaveUserDefinedBatteryRequest.MappingRequest;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.web.server.ResponseStatusException;

/**
 * Das GEHEIMNIS des HTTP-Lesetyps (P5-HTTP, Konzept
 * {@code vp-deye-diybms-luecke-l5} §3.2b) - wo es hin darf und wo nicht.
 *
 * <p>Rein mit Mockito, ohne Docker und ohne Spring. Geprüft wird das
 * Zusammenspiel, das keine reine Regel-Klasse sehen kann:
 *
 * <ul>
 *   <li><b>Es wird gespeichert</b>, und zwar an EINER festen Stelle der eigenen
 *       Definition ({@code auth_secret}, oberste Ebene) - dort greift die
 *       Geheimnis-Heuristik von {@link ComponentSecrets}, auch ohne eine
 *       Vorlage, aus der Geheimnis-Schlüssel sonst kämen.</li>
 *   <li><b>Es kommt beim Ändern nicht zurück:</b> schickt das Formular die
 *       Maske oder gar nichts, setzt der SERVER den gespeicherten Wert wieder
 *       ein. Sonst müsste der Kunde sein BMS-Kennwort bei jeder Namensänderung
 *       neu eintippen - oder es käme im Klartext in den Browser, damit er es
 *       nicht muss. Beides ist die falsche Antwort.</li>
 *   <li><b>Es steht NIE im Flow-Dokument:</b> das ist über
 *       {@code GET /sites/{siteId}/flows/{flowId}/versions/{v}} für jeden
 *       Portal-Benutzer des Mandanten lesbar.</li>
 *   <li><b>Eine Anmeldung ohne Schlüssel wird benannt abgelehnt</b>, statt
 *       still gespeichert zu werden: die Box fragt dann gar nicht erst ab, und
 *       die Batterie läse nichts.</li>
 * </ul>
 */
class UserDefinedBatteryHttpSecretTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID BATTERY = UUID.fromString("00000000-0000-0000-0000-0000000000b1");

    private static final String SECRET = "geheim-123";

    private final ObjectMapper mapper = new ObjectMapper();
    private EntityRegistryRepository entityRepo;
    private ComponentDefinitionRepository definitions;
    private FlowRepository flows;
    private UserDefinedBatteryService service;

    @BeforeEach
    void setUp() {
        SiteRepository sites = mock(SiteRepository.class);
        entityRepo = mock(EntityRegistryRepository.class);
        EntityRegistryService entityRegistry = mock(EntityRegistryService.class);
        definitions = mock(ComponentDefinitionRepository.class);
        ComponentService components = mock(ComponentService.class);
        TopologyRepository topology = mock(TopologyRepository.class);
        flows = mock(FlowRepository.class);
        FlowActivationService deployments = mock(FlowActivationService.class);
        FlowCompiler compiler = mock(FlowCompiler.class);
        @SuppressWarnings("unchecked")
        ObjectProvider<FlowCompiler> flowc = mock(ObjectProvider.class);

        when(sites.existsForCurrentTenant(eq(SITE))).thenReturn(true);
        when(definitions.componentAuthority(eq(SITE))).thenReturn("portal");
        when(entityRepo.siteDeviceIds(eq(SITE)))
                .thenReturn(List.of(UUID.fromString("00000000-0000-0000-0000-00000000e001")));
        when(entityRegistry.createEntity(any(), any(), any(), any(), any(), any()))
                .thenReturn(battery(null));
        when(definitions.applyDefinition(any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any()))
                .thenReturn(new ComponentDefinitionRepository.Applied(1, "DIYBMS v4"));
        when(flowc.getIfAvailable()).thenReturn(compiler);
        when(compiler.compile(any())).thenReturn(artifact());
        when(deployments.republishForSite(eq(SITE))).thenReturn(true);

        service = new UserDefinedBatteryService(sites, entityRepo, entityRegistry,
                new EntityTypeCatalog(mapper), definitions, components,
                new SocCurveTemplateCatalog(mapper), new UserDefinedBatteryFlowCompiler(mapper),
                flows, deployments, flowc, topology, mapper);
        TenantContext.set(TENANT);
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    /**
     * Beim ANLEGEN wird der Schlüssel gespeichert - an der Stelle, an der die
     * Maske ihn später findet.
     */
    @Test
    void derSchluesselWirdAlsAuthSecretGespeichert() throws Exception {
        service.create(SITE, request(new AuthRequest("header", "ApiKey", null, SECRET)),
                "tester");

        JsonNode stored = mapper.readTree(storedDefinition());
        assertThat(stored.path("transport").asText())
                .isEqualTo(UserDefinedBatteryDefinition.TRANSPORT_HTTP);
        assertThat(stored.path("endpoint").path("host").asText()).isEqualTo("192.168.40.21");
        assertThat(stored.path("endpoint").path("path").asText()).isEqualTo("/ha");
        assertThat(stored.path("auth").path("mode").asText()).isEqualTo("header");
        assertThat(stored.path("auth").path("header").asText()).isEqualTo("ApiKey");
        // ⚠ Der Schlüssel steht auf der OBERSTEN Ebene und heißt so, weil
        // ComponentSecrets.isSecretKey genau daran greift.
        assertThat(stored.path(UserDefinedBatteryDefinition.SECRET_FIELD).asText())
                .isEqualTo(SECRET);
        assertThat(UserDefinedBatteryDefinition.SECRET_FIELD)
                .matches(ComponentSecrets::isSecretKey);
        // Und die Komponente trägt die Marke, an der die BOX sie als
        // selbst-gelesen erkennt.
        verify(definitions).applyDefinition(any(), any(), any(), any(), any(), any(),
                eq(UserDefinedBatteryDefinition.COMMUNICATION_HTTP), any(), any(), any(), any());
    }

    /**
     * Die MASKE ist kein Kennwort: schickt das Formular sie zurück, behält der
     * Server den gespeicherten Wert - so wie beim Katalog-Gerät.
     */
    @Test
    void dieMaskeBehaeltDenGespeichertenSchluessel() throws Exception {
        when(entityRepo.entityForSite(eq(SITE), eq(BATTERY))).thenReturn(battery(SECRET));

        service.update(SITE, BATTERY,
                request(new AuthRequest("header", "ApiKey", null, ComponentSecrets.MASK)),
                "tester");

        assertThat(mapper.readTree(storedDefinition())
                .path(UserDefinedBatteryDefinition.SECRET_FIELD).asText()).isEqualTo(SECRET);
    }

    /** Ein FEHLENDES Feld heißt genauso „unverändert" wie die Maske. */
    @Test
    void einFehlenderSchluesselBehaeltDenGespeicherten() throws Exception {
        when(entityRepo.entityForSite(eq(SITE), eq(BATTERY))).thenReturn(battery(SECRET));

        service.update(SITE, BATTERY, request(new AuthRequest("header", "ApiKey", null, null)),
                "tester");

        assertThat(mapper.readTree(storedDefinition())
                .path(UserDefinedBatteryDefinition.SECRET_FIELD).asText()).isEqualTo(SECRET);
    }

    /** Ein wirklich neu eingegebener Schlüssel ERSETZT den alten. */
    @Test
    void einNeuerSchluesselErsetztDenAlten() throws Exception {
        when(entityRepo.entityForSite(eq(SITE), eq(BATTERY))).thenReturn(battery(SECRET));

        service.update(SITE, BATTERY, request(new AuthRequest("header", "ApiKey", null, "neu-456")),
                "tester");

        assertThat(mapper.readTree(storedDefinition())
                .path(UserDefinedBatteryDefinition.SECRET_FIELD).asText()).isEqualTo("neu-456");
    }

    /**
     * ⚠ DIE Kernregel: das Flow-Dokument ist über die Portal-API lesbar. Ein
     * Kennwort darin wäre ein Kennwort im Browser.
     */
    @Test
    void dasFlowDokumentTraegtDasGeheimnisNie() {
        service.create(SITE, request(new AuthRequest("header", "ApiKey", null, SECRET)),
                "tester");

        ArgumentCaptor<String> document = ArgumentCaptor.forClass(String.class);
        verify(flows).upsertGenerated(any(), any(), any(), org.mockito.ArgumentMatchers.anyInt(),
                any(), any(), document.capture());
        assertThat(document.getValue()).contains("vp.http.read").contains("\"ApiKey\"");
        assertThat(document.getValue()).doesNotContain(SECRET);
        assertThat(document.getValue())
                .doesNotContain(UserDefinedBatteryDefinition.SECRET_FIELD);
    }

    /**
     * Eine Anmeldung OHNE Schlüssel liest nichts - die Box fragt dann gar nicht
     * erst ab. Sie still zu speichern hieße, eine Batterie anzulegen, die
     * schweigt, ohne dass jemand sagt warum.
     */
    @Test
    void eineAnmeldungOhneSchluesselWirdBenanntAbgelehnt() {
        assertThatThrownBy(() -> service.create(SITE,
                request(new AuthRequest("header", "ApiKey", null, null)), "tester"))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("fehlt der Schlüssel");
    }

    /**
     * Die VORSCHAU tut exakt das, was das Speichern täte - der gespeicherte
     * Schlüssel wird serverseitig eingesetzt, damit sie nicht an einer Maske
     * scheitert und der Kunde ihn nicht neu tippen muss.
     */
    @Test
    void dieVorschauSetztDenGespeichertenSchluesselEin() {
        when(entityRepo.entityForSite(eq(SITE), eq(BATTERY))).thenReturn(battery(SECRET));

        Map<String, Object> connection = service.previewConnection(SITE,
                request(new AuthRequest("header", "ApiKey", null, ComponentSecrets.MASK)),
                BATTERY);

        assertThat(connection.get(UserDefinedBatteryDefinition.SECRET_FIELD)).isEqualTo(SECRET);
        // Das LAUSCHFENSTER gehört dem MQTT-Lesetyp: HTTP fragt EINMAL ab.
        assertThat(connection).doesNotContainKey("listen_s");
    }

    /**
     * Eine selbst geschriebene Definition ist keine unbekannte Vorlage: die
     * Maske trifft den Schlüssel und NUR ihn, sonst bekäme das
     * Bearbeiten-Formular statt Adresse, Pfad und Wertepfad acht Punkte zurück.
     */
    @Test
    void dieMaskeTrifftDenSchluesselUndNichtDieGanzeDefinition() throws Exception {
        String masked = ComponentSecrets.maskedJson(connectionJson(SECRET),
                java.util.Set.of(), false);
        JsonNode out = mapper.readTree(masked);
        assertThat(out.path(UserDefinedBatteryDefinition.SECRET_FIELD).asText())
                .isEqualTo(ComponentSecrets.MASK);
        assertThat(masked).doesNotContain(SECRET);
        assertThat(out.path("transport").asText())
                .isEqualTo(UserDefinedBatteryDefinition.TRANSPORT_HTTP);
        assertThat(out.path("endpoint").path("path").asText()).isEqualTo("/ha");
        assertThat(out.path("auth").path("header").asText()).isEqualTo("ApiKey");
    }

    // ---- Fixtures ---------------------------------------------------------

    private String storedDefinition() {
        ArgumentCaptor<String> json = ArgumentCaptor.forClass(String.class);
        verify(definitions).applyDefinition(any(), any(), any(), any(), any(), any(), any(),
                json.capture(), any(), any(), any());
        return json.getValue();
    }

    private SaveUserDefinedBatteryRequest request(AuthRequest auth) {
        return new SaveUserDefinedBatteryRequest("DIYBMS v4",
                UserDefinedBatteryDefinition.TRANSPORT_HTTP, null,
                new EndpointRequest("192.168.40.21", 80, "/ha", false, 5000), auth,
                List.of(new MappingRequest("soc_pct", null, "soc", "last", "number", 1.0, 0.0,
                        null, null, null, null)),
                15, null, null, null);
    }

    private String connectionJson(String secret) {
        ObjectNode root = mapper.createObjectNode();
        root.put("schema_version", "1.0");
        root.put("transport", UserDefinedBatteryDefinition.TRANSPORT_HTTP);
        ObjectNode endpoint = root.putObject("endpoint");
        endpoint.put("host", "192.168.40.21");
        endpoint.put("port", 80);
        endpoint.put("path", "/ha");
        endpoint.put("tls", false);
        ObjectNode auth = root.putObject("auth");
        auth.put("mode", "header");
        auth.put("header", "ApiKey");
        if (secret != null) {
            root.put(UserDefinedBatteryDefinition.SECRET_FIELD, secret);
        }
        root.put("publish_interval_s", 15);
        root.putArray("mappings");
        return root.toString();
    }

    private EntityRow battery(String secret) {
        return new EntityRow(BATTERY, null, "DIYBMS v4", null, null, null,
                UserDefinedBatteryDefinition.COMMUNICATION_HTTP, connectionJson(secret), null,
                null, false, UserDefinedBatteryDefinition.ENTITY_TYPE, "{\"measure\":[]}", "{}",
                null, null, null, null, 1, null);
    }

    /** Ein formal GÜLTIGES Artefakt - {@code requireArtifactShape} läuft echt. */
    private JsonNode artifact() {
        ObjectNode root = mapper.createObjectNode();
        root.put("schema_version", "1.0");
        root.put("kind", "artifact");
        root.put("artifact_id", UUID.randomUUID().toString());
        root.put("flow_id", UUID.randomUUID().toString());
        root.put("flow_version", 1);
        root.put("runtime", "edge");
        root.put("content_hash", "sha256:" + "0".repeat(64));
        root.put("compiled_at", "2026-09-09T12:00:00Z");
        root.put("compiler_version", "test");
        root.put("min_palette_version", "0.12.0");
        root.put("min_core_version", "1.0.0");
        root.putArray("required_entities");
        ObjectNode bundle = root.putObject("bundle");
        bundle.put("format", "nodered-tabs");
        bundle.putArray("tab_ids").add("tab-1");
        bundle.putArray("nodered_flows").addObject().put("id", "tab-1");
        return root;
    }
}
