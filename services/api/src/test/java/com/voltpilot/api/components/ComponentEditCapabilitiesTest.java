package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityObservedRepository;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.repo.AssetRepository;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.MeasurementPointRepository;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.templates.ComponentTemplateRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.ComponentTemplateDto;
import com.voltpilot.api.web.dto.SaveComponentRequest;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * Das BEARBEITEN stuft die Fähigkeiten einer Komponente nicht mehr herunter
 * (Scout {@code data/vp-deye-diybms-luecke-l5} §2.2, P1 Punkt 2).
 *
 * <p>Der behobene Befund: {@code applyEditDefinition} schrieb bei JEDEM
 * „Verbindung &amp; Modell"-Klick den Anlege-Vorgabewert in die Spalte, und weil
 * das {@code COALESCE} dort einen Nicht-null-Wert bekam, ersetzte dieser eine
 * Kanal {@code power_kw} die drei aus dem Speicher-Asset komponierten Kanäle
 * eines {@code battery-hybrid}. Eine Anlage, die vorher einen PV-Knoten hatte,
 * verlor ihn beim ersten Bearbeiten - ohne dass jemand etwas an ihrem Typ
 * geändert hätte.
 *
 * <p>Bewusst ohne Docker: bewiesen wird, WAS der Schreibweg der Spalte übergibt
 * ({@code null} = „stehen lassen"), nicht die Zustellung. Die Strecke bis zum
 * PV-Knoten im Read-Model fährt {@code ComponentApiTest}.
 */
class ComponentEditCapabilitiesTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-0000000000b1");
    private static final UUID ENTITY = UUID.fromString("00000000-0000-0000-0000-0000000000c1");
    private static final String TEMPLATE_REF = "builtin:deye:sun-30k";
    private static final Map<String, Object> CONNECTION = Map.of("host", "192.168.0.28");
    private static final String CONNECTION_JSON = "{\"host\":\"192.168.0.28\"}";

    private final ObjectMapper json = new ObjectMapper();

    private final Geltungsbereich sites = mock(Geltungsbereich.class);
    private final MeasurementPointRepository points = mock(MeasurementPointRepository.class);
    private final EntityRegistryRepository entityRepo = mock(EntityRegistryRepository.class);
    private final EntityRegistryService registry = mock(EntityRegistryService.class);
    private final ComponentDefinitionRepository definitions =
            mock(ComponentDefinitionRepository.class);
    private final ComponentApplyRepository applyState = mock(ComponentApplyRepository.class);
    private final ComponentTemplateRepository templates = mock(ComponentTemplateRepository.class);
    private final ComponentConnectionReceipts receipts = mock(ComponentConnectionReceipts.class);
    private final AssetRepository assets = mock(AssetRepository.class);
    private final EntityObservedRepository observed = mock(EntityObservedRepository.class);
    private final ComponentActivationOutboxService outbox =
            mock(ComponentActivationOutboxService.class);
    private final DeviceRepository devices = mock(DeviceRepository.class);
    /** ECHT statt Mock: der Typkatalog IST hier der Prüfgegenstand. */
    private final EntityTypeCatalog entityTypes = new EntityTypeCatalog(new ObjectMapper());

    private final ComponentService service = new ComponentService(sites, points, entityRepo,
            registry, definitions, applyState, templates, receipts, assets, observed, outbox,
            devices, entityTypes, mock(com.voltpilot.api.uems.QuelleEinstellungService.class));

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    void beiUnveraendertemTypBleibenDieVorhandenenFaehigkeitenStehen() {
        // Genau der Live-Fall: die aus dem Speicher-Asset komponierte Zeile
        // trägt ihre drei Kanäle; der Kunde ändert nur den Namen.
        stubEdit(row("battery-hybrid", "battery-hybrid", null));

        service.update(SITE, ENTITY, request(ComponentService.ROLE_INVERTER, "Speicher Nord"),
                "kunde@example.test");

        assertThat(capturedCapabilities())
                .as("null heisst COALESCE-> die gespeicherten Faehigkeiten bleiben unberuehrt")
                .isNull();
    }

    /** Dasselbe für die drei anderen Rollen - keine schreibt beim Bearbeiten. */
    @Test
    void erzeugerNetzUndVerbraucherWerdenBeimBearbeitenEbenfallsNichtUeberschrieben() {
        for (String[] fall : new String[][] {
                {ComponentService.ROLE_ERZEUGER, "pv-generation", "producer"},
                {ComponentService.ROLE_NETZ, "grid-meter", "grid-meter"},
                {ComponentService.ROLE_CONSUMER, "consumer", "generic-load"}}) {
            org.mockito.Mockito.clearInvocations(definitions);
            stubEdit(row(fall[1], fall[2], null));

            service.update(SITE, ENTITY, request(fall[0], "Neuer Name"), "kunde@example.test");

            assertThat(capturedCapabilities()).as(fall[2]).isNull();
        }
    }

    /**
     * Ein ECHTER Typwechsel setzt sie neu - dann sind die alten Kanäle Aussagen
     * über ein anderes Gerät.
     */
    @Test
    void einTypwechselSchreibtDieKanaeleDesNeuenTyps() throws Exception {
        stubEdit(row("pv-generation", "producer", null));

        service.update(SITE, ENTITY, request(ComponentService.ROLE_NETZ, "Netz"),
                "kunde@example.test");

        assertThat(channels(capturedCapabilities())).containsExactly("power_kw");
    }

    /**
     * Eine Zeile, die noch GAR KEINEN Entitätstyp trägt, bekommt ihn samt
     * Katalog-Kanälen - „ergänzen" ist keine Herabstufung.
     */
    @Test
    void eineZeileOhneTypBekommtDieKatalogKanaele() throws Exception {
        stubEdit(row("battery-hybrid", null, null));

        service.update(SITE, ENTITY, request(ComponentService.ROLE_INVERTER, "Speicher"),
                "kunde@example.test");

        assertThat(channels(capturedCapabilities()))
                .containsExactly("soc_pct", "battery_power_kw", "pv_power_kw");
    }

    // ---- Gerüst -------------------------------------------------------------

    private String capturedCapabilities() {
        ArgumentCaptor<String> caps = ArgumentCaptor.forClass(String.class);
        org.mockito.Mockito.verify(definitions).applyEditDefinition(eq(SITE), eq(ENTITY), anyInt(),
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
                caps.capture(), any());
        return caps.getValue();
    }

    private List<String> channels(String capabilitiesJson) throws Exception {
        assertThat(capabilitiesJson).isNotNull();
        List<String> out = new ArrayList<>();
        for (JsonNode m : json.readTree(capabilitiesJson).path("measure")) {
            out.add(m.path("channel").asText());
        }
        return out;
    }

    private EntityRow row(String role, String entityType, BigDecimal capacityKwp) {
        return new EntityRow(ENTITY, role, "Alt", "deye", "sun-30k", "hybrid_3p", "solarman_v5",
                CONNECTION_JSON, capacityKwp, null, false, entityType,
                "{\"measure\":[{\"channel\":\"soc_pct\",\"unit\":\"%\"}]}",
                "{\"failsafe\":{\"behavior\":\"self-consumption\"}}", null, "builtin",
                TEMPLATE_REF, 1, 4, null);
    }

    private SaveComponentRequest request(String role, String label) {
        return new SaveComponentRequest(TEMPLATE_REF, 1, label, role, CONNECTION, null, null, null,
                null, 4, null);
    }

    private void stubEdit(EntityRow existing) {
        TenantContext.set(TENANT);
        when(definitions.componentAuthority(SITE)).thenReturn("portal");
        when(entityRepo.entityForSite(SITE, ENTITY)).thenReturn(existing);
        when(entityRepo.entitiesForSite(SITE)).thenReturn(List.of());
        when(templates.findStoredExactByRef(any(), eq(TEMPLATE_REF), eq(1)))
                .thenReturn(Optional.of(template()));
        when(templates.findExactByRef(any(), eq(TEMPLATE_REF), eq(1)))
                .thenReturn(Optional.of(template()));
        when(receipts.has(eq(SITE), anyString(), anyInt(), any())).thenReturn(true);
        when(definitions.applyEditDefinition(any(), any(), anyInt(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any()))
                .thenReturn(new ComponentDefinitionRepository.Applied(5, "Alt"));
    }

    private static ComponentTemplateDto template() {
        return new ComponentTemplateDto(TEMPLATE_REF, "builtin", 1, "deye", "Deye",
                "sun-30k", "SUN-30K", null, "inverter", null, "hybrid_3p", "Hybrid 3-phasig",
                "solarman_v5", "Solarman V5", null, null, null, BigDecimal.valueOf(30), 0,
                "builtin", null, null, null, null);
    }
}
