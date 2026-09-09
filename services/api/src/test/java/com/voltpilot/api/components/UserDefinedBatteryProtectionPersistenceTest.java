package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;
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
import com.voltpilot.api.web.dto.SaveUserDefinedBatteryRequest.DirectionRequest;
import com.voltpilot.api.web.dto.SaveUserDefinedBatteryRequest.HysteresisRequest;
import com.voltpilot.api.web.dto.SaveUserDefinedBatteryRequest.MappingRequest;
import com.voltpilot.api.web.dto.SaveUserDefinedBatteryRequest.ProtectionRequest;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.ObjectProvider;

/**
 * Wie der SCHUTZ-/GRENZBAUSTEIN (P5c) SPEICHERT - rein mit Mockito, ohne Docker
 * und ohne Spring.
 *
 * <p><b>⚠ Die Regel, die dieser Test bewacht:</b> ein FEHLENDER
 * {@code protection}-Block heißt „unverändert", nicht „weg". Das ist die
 * Ausnahme von der Regel, die für die Speiser-Bindung (P6) gilt - und sie hat
 * einen handfesten Grund: dies ist eine SCHUTZgrenze. Das Portal-Formular kennt
 * den Block heute noch nicht und schickt ihn deshalb nicht mit; würde ein
 * Namenswechsel im Assistenten die Abschaltspannung entfernen, merkte das
 * niemand - bis sie gebraucht wird. Entfernt wird sie nur AUSDRÜCKLICH.
 */
class UserDefinedBatteryProtectionPersistenceTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID BATTERY = UUID.fromString("00000000-0000-0000-0000-0000000000b1");

    private final ObjectMapper mapper = new ObjectMapper();
    private EntityRegistryRepository entityRepo;
    private EntityRegistryService entityRegistry;
    private ComponentDefinitionRepository definitions;
    private UserDefinedBatteryService service;

    @BeforeEach
    void setUp() {
        SiteRepository sites = mock(SiteRepository.class);
        entityRepo = mock(EntityRegistryRepository.class);
        entityRegistry = mock(EntityRegistryService.class);
        definitions = mock(ComponentDefinitionRepository.class);
        ComponentService components = mock(ComponentService.class);
        TopologyRepository topology = mock(TopologyRepository.class);
        FlowRepository flows = mock(FlowRepository.class);
        FlowActivationService deployments = mock(FlowActivationService.class);
        FlowCompiler compiler = mock(FlowCompiler.class);
        @SuppressWarnings("unchecked")
        ObjectProvider<FlowCompiler> flowc = mock(ObjectProvider.class);

        when(sites.existsForCurrentTenant(eq(SITE))).thenReturn(true);
        when(definitions.componentAuthority(eq(SITE))).thenReturn("portal");
        when(entityRepo.siteDeviceIds(eq(SITE)))
                .thenReturn(List.of(UUID.fromString("00000000-0000-0000-0000-00000000e001")));
        when(entityRegistry.createEntity(any(), any(), any(), any(), any(), any()))
                .thenReturn(row(null));
        when(definitions.applyDefinition(any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any()))
                .thenReturn(new ComponentDefinitionRepository.Applied(1, "DIYBMS 176s"));
        when(flowc.getIfAvailable()).thenReturn(compiler);
        when(compiler.compile(any())).thenReturn(artifact());
        when(deployments.republishForSite(eq(SITE))).thenReturn(true);

        service = new UserDefinedBatteryService(sites, entityRepo, entityRegistry,
                new EntityTypeCatalog(mapper), definitions, components,
                new SocCurveTemplateCatalog(mapper), new ProtectionProfileCatalog(mapper),
                new UserDefinedBatteryFlowCompiler(mapper),
                flows, deployments, flowc, topology, mapper);
        TenantContext.set(TENANT);
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    /**
     * Die VORLAGE füllt die Treppen und die vier Schwellen - der Kunde wählt
     * einen Namen und bekommt die gemessenen Werte, nicht erfundene.
     */
    @Test
    void dieVorlageFuelltDenSchutz() throws Exception {
        service.create(SITE, request(new ProtectionRequest(null, null, null, null, null, null,
                "diybms-176s-deye-hp3", null)), "tester");

        JsonNode p = mapper.readTree(storedDefinition()).path("protection");
        assertThat(p.path("template").asText()).isEqualTo("diybms-176s-deye-hp3");
        assertThat(p.path("charge").path("max_a").asDouble()).isEqualTo(40.0);
        assertThat(p.path("charge").path("steps").get(0).get(1).asDouble()).isEqualTo(270.0);
        assertThat(p.path("hysteresis").path("charge_stop_v").asDouble()).isEqualTo(4.06);
        assertThat(p.path("hysteresis").path("discharge_resume_v").asDouble()).isEqualTo(3.5);
        // Jede Vorgabe steht ausgeschrieben - danach rät niemand mehr.
        assertThat(p.path("round_a").asDouble()).isEqualTo(1.0);
        assertThat(p.path("hold_s").asInt()).isEqualTo(900);
        assertThat(p.path("inputs").path("cell_max").asText()).isEqualTo("cell_max_mv");
    }

    /** Ein unbekannter Vorlagen-Name wird BENANNT abgelehnt, nie ignoriert. */
    @Test
    void eineUnbekannteVorlageWirdBenanntAbgelehnt() {
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> service.create(SITE,
                request(new ProtectionRequest(null, null, null, null, null, null,
                        "lifepo4-erfunden", null)), "tester"))
                .hasMessageContaining("Schutz-Vorlage");
    }

    /**
     * ⚠ DIE Kernregel: ein Speichern OHNE {@code protection}-Block behält den
     * gespeicherten Schutz. Genau das tut das Portal-Formular heute.
     */
    @Test
    void einFehlenderBlockBehaeltDenGespeichertenSchutz() throws Exception {
        when(entityRepo.entityForSite(eq(SITE), eq(BATTERY))).thenReturn(row(withProtection()));

        service.update(SITE, BATTERY, request(null), "tester");

        JsonNode p = mapper.readTree(storedDefinition()).path("protection");
        assertThat(p.isMissingNode()).as("der Schutz darf nicht still verschwinden").isFalse();
        assertThat(p.path("hysteresis").path("charge_stop_v").asDouble()).isEqualTo(4.06);
        assertThat(p.path("charge").path("max_a").asDouble()).isEqualTo(40.0);
    }

    /** Ein NEUER Block ersetzt den gespeicherten - vollständig. */
    @Test
    void einNeuerBlockErsetztDenGespeicherten() throws Exception {
        when(entityRepo.entityForSite(eq(SITE), eq(BATTERY))).thenReturn(row(withProtection()));

        service.update(SITE, BATTERY, request(new ProtectionRequest(
                new DirectionRequest(List.of(List.of(0.0, 10.0)), 25.0), null,
                new HysteresisRequest(4.10, 4.05, null, null), null, null, null, null, null)),
                "tester");

        JsonNode p = mapper.readTree(storedDefinition()).path("protection");
        assertThat(p.path("charge").path("max_a").asDouble()).isEqualTo(25.0);
        assertThat(p.path("hysteresis").path("charge_stop_v").asDouble()).isEqualTo(4.10);
        // Die alte Entlade-Seite ist WEG, nicht halb übernommen: ein neuer Block
        // ist eine ganze Aussage, keine Ergänzung.
        assertThat(p.path("discharge").isMissingNode()).isTrue();
        assertThat(p.path("hysteresis").path("discharge_stop_v").isMissingNode()).isTrue();
    }

    /** Entfernt wird nur AUSDRÜCKLICH. */
    @Test
    void nurEineAusdrueckicheEntfernungLoeschtDenSchutz() throws Exception {
        when(entityRepo.entityForSite(eq(SITE), eq(BATTERY))).thenReturn(row(withProtection()));

        service.update(SITE, BATTERY, request(new ProtectionRequest(null, null, null, null, null,
                null, null, true)), "tester");

        assertThat(mapper.readTree(storedDefinition()).path("protection").isMissingNode())
                .isTrue();
    }

    /**
     * Die vier Grenz-Kanäle werden FÄHIGKEITEN der Batterie - sonst könnte die
     * Speiser-Bindung (P6) genau das nicht einspeisen, wofür es diesen Baustein
     * gibt, und der generierte Flow fiele bei der Aktivierung durch.
     */
    @Test
    void dieGrenzenWerdenFaehigkeitenDerBatterie() throws Exception {
        service.create(SITE, request(new ProtectionRequest(null, null, null, null, null, null,
                "diybms-176s-deye-hp3", null)), "tester");

        ArgumentCaptor<JsonNode> caps = ArgumentCaptor.forClass(JsonNode.class);
        verify(entityRegistry).createEntity(any(), any(), any(), any(), caps.capture(), any());
        List<String> channels = new ArrayList<>();
        for (JsonNode m : caps.getValue().path("measure")) {
            channels.add(m.path("channel").asText());
        }
        assertThat(channels).contains("charge_limit_a", "discharge_limit_a", "charge_allowed",
                "discharge_allowed");
    }

    // ---- Fixtures ---------------------------------------------------------

    private String storedDefinition() {
        ArgumentCaptor<String> json = ArgumentCaptor.forClass(String.class);
        verify(definitions).applyDefinition(any(), any(), any(), any(), any(), any(), any(),
                json.capture(), any(), any(), any());
        return json.getValue();
    }

    /** Die Zellspannungen des Kundenfalls - der Schutz braucht sie. */
    private SaveUserDefinedBatteryRequest request(ProtectionRequest protection) {
        List<MappingRequest> mappings = new ArrayList<>();
        mappings.add(new MappingRequest("cell_min_mv", "emon/diybms/+/+", "voltage", "min",
                "number", 1000.0, 0.0, null, 300, null, null));
        mappings.add(new MappingRequest("cell_max_mv", "emon/diybms/+/+", "voltage", "max",
                "number", 1000.0, 0.0, null, 300, null, null));
        mappings.add(new MappingRequest("soc_pct", "emon/diybms/pack", "soc", "last", "number",
                1.0, 0.0, null, 300, null, null));
        return new SaveUserDefinedBatteryRequest("DIYBMS 176s", null,
                new SaveUserDefinedBatteryRequest.Broker("192.168.40.20", 1883), null, null,
                mappings, 15, null, null, protection, null);
    }

    /** Eine gespeicherte Definition MIT Schutz - der Ausgangspunkt beim Ändern. */
    private String withProtection() {
        ObjectNode root = mapper.createObjectNode();
        root.put("schema_version", "1.0");
        root.put("transport", UserDefinedBatteryDefinition.TRANSPORT_MQTT);
        ObjectNode broker = root.putObject("broker");
        broker.put("host", "192.168.40.20");
        broker.put("port", 1883);
        root.put("publish_interval_s", 15);
        root.putArray("mappings");
        ObjectNode p = root.putObject("protection");
        ObjectNode inputs = p.putObject("inputs");
        inputs.put("cell_max", "cell_max_mv");
        inputs.put("cell_min", "cell_min_mv");
        inputs.put("soc", "soc_pct");
        ObjectNode charge = p.putObject("charge");
        charge.putArray("steps").addArray().add(5.0).add(270.0);
        charge.put("max_a", 40.0);
        ObjectNode discharge = p.putObject("discharge");
        discharge.putArray("steps").addArray().add(5.0).add(74.0);
        discharge.put("max_a", 40.0);
        ObjectNode h = p.putObject("hysteresis");
        h.put("charge_stop_v", 4.06);
        h.put("charge_resume_v", 4.0);
        h.put("discharge_stop_v", 3.4);
        h.put("discharge_resume_v", 3.5);
        p.put("round_a", 1.0);
        p.put("hold_s", 900);
        return root.toString();
    }

    private EntityRow row(String connectionJson) {
        return new EntityRow(BATTERY, null, "DIYBMS 176s", null, null, null,
                UserDefinedBatteryDefinition.COMMUNICATION, connectionJson, null, null, false,
                UserDefinedBatteryDefinition.ENTITY_TYPE, "{\"measure\":[]}", "{}", null, null,
                null, null, 1, null);
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
        root.put("min_palette_version", "0.13.0");
        root.put("min_core_version", "1.0.0");
        root.putArray("required_entities");
        ObjectNode bundle = root.putObject("bundle");
        bundle.put("format", "nodered-tabs");
        bundle.putArray("tab_ids").add("tab-1");
        bundle.putArray("nodered_flows").addObject().put("id", "tab-1");
        return root;
    }
}
