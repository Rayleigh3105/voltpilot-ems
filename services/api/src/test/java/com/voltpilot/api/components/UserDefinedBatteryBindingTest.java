package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
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
import com.voltpilot.api.topology.TopologyDeriver;
import com.voltpilot.api.topology.TopologyRepository;
import com.voltpilot.api.web.dto.SaveUserDefinedBatteryRequest;
import com.voltpilot.api.web.dto.SaveUserDefinedBatteryRequest.BindingRequest;
import com.voltpilot.api.web.dto.SaveUserDefinedBatteryRequest.MappingRequest;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die SPEISER-BINDUNG als das, was sie WIRKLICH tut (P6, Konzept
 * {@code vp-deye-diybms-luecke-l5} §3.2b, Captain-Entscheid E6 (a)): sie
 * schreibt Rollen-Zuordnungen und sie legt sie auch wieder ab.
 *
 * <p>Rein mit Mockito, ohne Docker und ohne Spring - geprüft wird das
 * Zusammenspiel, das keine der reinen Regel-Klassen sehen kann: WELCHE Zeilen
 * {@code entity_role_assignment} bekommt, welche wieder verschwinden, und dass
 * eine Bindung an ein fremdes oder falsches Ziel gar nicht erst geschrieben
 * wird.
 */
class UserDefinedBatteryBindingTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID BATTERY = UUID.fromString("00000000-0000-0000-0000-0000000000b1");
    private static final UUID INVERTER = UUID.fromString("00000000-0000-0000-0000-0000000000c1");
    private static final UUID WALLBOX = UUID.fromString("00000000-0000-0000-0000-0000000000d1");

    private final ObjectMapper mapper = new ObjectMapper();
    private EntityRegistryRepository entityRepo;
    private EntityRegistryService entityRegistry;
    private ComponentDefinitionRepository definitions;
    private TopologyRepository topology;
    private FlowRepository flows;
    private UserDefinedBatteryService service;

    @BeforeEach
    void setUp() {
        SiteRepository sites = mock(SiteRepository.class);
        entityRepo = mock(EntityRegistryRepository.class);
        entityRegistry = mock(EntityRegistryService.class);
        definitions = mock(ComponentDefinitionRepository.class);
        ComponentService components = mock(ComponentService.class);
        topology = mock(TopologyRepository.class);
        flows = mock(FlowRepository.class);
        FlowActivationService deployments = mock(FlowActivationService.class);
        FlowCompiler compiler = mock(FlowCompiler.class);
        @SuppressWarnings("unchecked")
        ObjectProvider<FlowCompiler> flowc = mock(ObjectProvider.class);

        when(sites.existsForCurrentTenant(eq(SITE))).thenReturn(true);
        when(definitions.componentAuthority(eq(SITE))).thenReturn("portal");
        when(entityRepo.siteDeviceIds(eq(SITE)))
                .thenReturn(List.of(UUID.fromString("00000000-0000-0000-0000-00000000e001")));
        when(entityRepo.entityForSite(eq(SITE), eq(BATTERY))).thenReturn(battery());
        when(entityRepo.entityForSite(eq(SITE), eq(INVERTER))).thenReturn(inverter());
        when(entityRepo.entityForSite(eq(SITE), eq(WALLBOX))).thenReturn(wallbox());
        when(entityRegistry.createEntity(any(), any(), any(), any(), any(), any()))
                .thenReturn(battery());
        when(definitions.applyDefinition(any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any()))
                .thenReturn(new ComponentDefinitionRepository.Applied(1, "DIY-Speicher"));
        when(flowc.getIfAvailable()).thenReturn(compiler);
        // Der Compiler ist hier nicht der Gegenstand - er liefert ein gültiges
        // Artefakt, damit der Schreibweg bis zum Ende läuft.
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
     * ⚠ DER Entscheid dieses Pakets: ohne ausdrückliche Bindung wird KEINE
     * Rolle geschrieben - die Batterie bleibt ein Topologie-Knoten mit eigenen
     * Messwerten, ausserhalb der Energiebilanz.
     */
    @Test
    void ohneBindungEntstehtKeineEinzigeRollenzeile() {
        service.create(SITE, request(null), "tester");

        verify(topology, never()).upsertOverride(any(), any(), any(), any(), any(),
                anyBoolean());
        // Und die alten Zeilen werden ABGERÄUMT - sonst überlebte eine gelöste
        // Bindung ihr eigenes Lösen.
        verify(topology).deleteOverride(SITE, BATTERY, "soc_pct");
        verify(topology).deleteOverride(SITE, BATTERY, "power_kw");
    }

    /**
     * Der Speiser: Ladestand und Grenzen werden MASSGEBLICH zugeordnet - ein
     * Hybrid-Wechselrichter, der im Spannungsmodus seinen eigenen (erfundenen)
     * Ladestand meldet, darf ihn sonst überstimmen. Die LEISTUNG bleibt aussen
     * vor.
     */
    @Test
    void derSpeiserSchreibtLadestandUndGrenzenAberNieDieLeistung() {
        service.create(SITE, request(new BindingRequest("feeds_inverter", INVERTER.toString())),
                "tester");

        verify(topology).upsertOverride(TENANT, SITE, BATTERY, "soc_pct",
                TopologyDeriver.ROLE_STORAGE, true);
        verify(topology).upsertOverride(TENANT, SITE, BATTERY, "charge_limit_a",
                TopologyDeriver.ROLE_STORAGE, true);
        verify(topology, never()).upsertOverride(any(), any(), any(), eq("power_kw"), any(),
                anyBoolean());
        verify(topology).deleteOverride(SITE, BATTERY, "power_kw");
    }

    /** Ohne Hybriden IST sie der Speicher - dann reist auch die Leistung mit. */
    @Test
    void dieEigenstaendigeBatterieBekommtAuchDieLeistungsrolle() {
        service.create(SITE, request(new BindingRequest("standalone", null)), "tester");

        verify(topology).upsertOverride(TENANT, SITE, BATTERY, "power_kw",
                TopologyDeriver.ROLE_STORAGE, true);
    }

    /** Die Bindung steht in der gespeicherten Definition - auch als „unbound". */
    @Test
    void dieBindungStehtInDerGespeichertenDefinition() {
        service.create(SITE, request(new BindingRequest("standalone", null)), "tester");

        ArgumentCaptor<String> json = ArgumentCaptor.forClass(String.class);
        verify(definitions).applyDefinition(any(), any(), any(), any(), any(), any(), any(),
                json.capture(), any(), any(), any());
        assertThat(json.getValue()).contains("\"binding\"").contains("\"standalone\"");
    }

    /**
     * Eine Bindung an eine fremde Anlage ist unter RLS unsichtbar - die
     * ehrliche Antwort ist 404, nie 403 (die Hausregel), und geschrieben wird
     * dabei NICHTS.
     */
    @Test
    void einZielAusserhalbDerAnlageIst404UndSchreibtNichts() {
        UUID fremd = UUID.fromString("00000000-0000-0000-0000-0000000000f1");
        assertThatThrownBy(() -> service.create(SITE,
                request(new BindingRequest("feeds_inverter", fremd.toString())), "tester"))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("404");
        verify(topology, never()).upsertOverride(any(), any(), any(), any(), any(),
                anyBoolean());
        verify(entityRegistry, never()).createEntity(any(), any(), any(), any(), any(), any());
    }

    /** Ein Speiser speist einen SPEICHER - eine Wallbox ist keiner. */
    @Test
    void eineBatterieKannNichtAnEinerWallboxHaengen() {
        assertThatThrownBy(() -> service.create(SITE,
                request(new BindingRequest("feeds_inverter", WALLBOX.toString())), "tester"))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("kein Speicher-Wechselrichter");
    }

    /**
     * Eine Batterie, die sich an sich selbst hängt, ist der eigenständige Fall
     * - die beiden auseinanderzuhalten ist der Punkt der ausdrücklichen
     * Bindung.
     */
    @Test
    void eineBatterieKannNichtAnSichSelbstHaengen() {
        assertThatThrownBy(() -> service.update(SITE, BATTERY,
                request(new BindingRequest("feeds_inverter", BATTERY.toString())), "tester"))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("nicht an sich selbst");
    }

    // ---- Fixtures ---------------------------------------------------------

    private SaveUserDefinedBatteryRequest request(BindingRequest binding) {
        List<MappingRequest> mappings = new ArrayList<>();
        mappings.add(new MappingRequest("soc_pct", "emon/pack", "soc", "last", "number",
                1.0, 0.0, null, 300, null, null));
        mappings.add(new MappingRequest("charge_limit_a", "emon/pack", "cl", "last", "number",
                1.0, 0.0, null, 300, null, null));
        mappings.add(new MappingRequest("power_kw", "emon/pack", "p", "last", "number",
                0.001, 0.0, null, 300, null, null));
        return new SaveUserDefinedBatteryRequest("DIY-Speicher", null,
                new SaveUserDefinedBatteryRequest.Broker("192.168.40.20", 1883), null, null,
                mappings, 15, null, binding, null);
    }

    private static EntityRow battery() {
        return row(BATTERY, UserDefinedBatteryDefinition.ENTITY_TYPE,
                UserDefinedBatteryDefinition.COMMUNICATION, "DIY-Speicher");
    }

    private static EntityRow inverter() {
        return row(INVERTER, "battery-hybrid", "modbus_tcp", "Deye SUN-30K");
    }

    private static EntityRow wallbox() {
        return row(WALLBOX, "wallbox", "modbus_tcp", "Wallbox Garage");
    }

    private static EntityRow row(UUID id, String type, String communication, String label) {
        return new EntityRow(id, null, label, null, null, null, communication, null, null, null,
                false, type, "{\"measure\":[]}", "{}", null, null, null, null, 1, null);
    }

    /**
     * Ein formal GÜLTIGES Artefakt - der Compiler ist hier nicht der
     * Gegenstand, aber {@code FlowDeployment.requireArtifactShape} steht
     * zwischen ihm und dem Schreibweg und muss echt durchlaufen werden.
     */
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
        root.put("min_palette_version", "1.0.0");
        root.put("min_core_version", "1.0.0");
        root.putArray("required_entities");
        ObjectNode bundle = root.putObject("bundle");
        bundle.put("format", "nodered-tabs");
        bundle.putArray("tab_ids").add("tab-1");
        bundle.putArray("nodered_flows").addObject().put("id", "tab-1");
        return root;
    }

}
