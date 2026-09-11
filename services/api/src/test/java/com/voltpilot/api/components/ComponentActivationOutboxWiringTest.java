package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.entities.EntityObservedRepository;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.repo.AssetRepository;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.MeasurementPointRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.templates.ComponentTemplateRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.ComponentTemplateDto;
import com.voltpilot.api.web.dto.SaveComponentRequest;
import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * L9 (Scout {@code vp-portal-box-spiegel-s2} §4): das ANLEGEN einer Komponente
 * geht denselben Outbox-Weg wie Bearbeiten und Rollback.
 *
 * <p>Der behobene Befund ist die REIHENFOLGE, nicht das Ergebnis: {@code create}
 * ist {@code @Transactional} und veroeffentlichte den Push INNERHALB der
 * Transaktion. Beide Fehlerformen davon sind still - ein Broker-Ausfall genau
 * dort wird nie wiederholt, und ein Rollback nach erfolgreichem Publish liesse
 * die Box mit einem Soll zurueck, das die Datenbank nicht hat. Genau deshalb
 * prueft dieser Test BEIDE Haelften: der Eintrag entsteht, UND es wird waehrend
 * des Anlegens nicht gepusht.
 *
 * <p>Bewusst ohne Docker: geprueft wird die VERDRAHTUNG, nicht die Zustellung -
 * die faehrt der Outbox-Takt, den {@code update}/{@code rollback} seit je
 * benutzen.
 */
class ComponentActivationOutboxWiringTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-0000000000b1");
    private static final UUID ENTITY = UUID.fromString("00000000-0000-0000-0000-0000000000c1");

    private final SiteRepository sites = mock(SiteRepository.class);
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

    /**
     * ECHT statt Mock: die Anlege-Vorgaben lesen ihre Messkanaele seit dem
     * Typkatalog-Umbau aus genau diesem Katalog - ein Mock wuerde die
     * Verdrahtung hier stillschweigend leer halten.
     */
    private final com.voltpilot.api.entities.EntityTypeCatalog entityTypes =
            new com.voltpilot.api.entities.EntityTypeCatalog(
                    new com.fasterxml.jackson.databind.ObjectMapper());

    private final ComponentService service = new ComponentService(sites, points, entityRepo,
            registry, definitions, applyState, templates, receipts, assets, observed, outbox,
            devices, entityTypes, mock(com.voltpilot.api.uems.QuelleEinstellungService.class));

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    void creatingAComponentEnqueuesTheActivationInsteadOfPushingInsideTheTransaction() {
        TenantContext.set(TENANT);
        ComponentTemplateDto template = template();
        Map<String, Object> connection = Map.of("host", "192.168.0.28");
        when(sites.existsForCurrentTenant(SITE)).thenReturn(true);
        when(definitions.componentAuthority(SITE)).thenReturn("portal");
        when(templates.findExactByRef(any(), eq("builtin:deye:sun-30k"), eq(1)))
                .thenReturn(Optional.of(template));
        when(receipts.has(eq(SITE), anyString(), anyInt(), any())).thenReturn(true);
        when(entityRepo.pointsForSite(SITE)).thenReturn(List.of());
        when(observed.forSite(SITE)).thenReturn(List.of());
        when(points.create(any(), any(), anyString(), any(), any(), any(), any(), any()))
                .thenReturn(ENTITY);
        when(definitions.applyDefinition(any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any()))
                .thenReturn(new ComponentDefinitionRepository.Applied(7, "Dach Sued"));
        when(entityRepo.entitiesForSite(SITE)).thenReturn(List.of());

        service.create(SITE, new SaveComponentRequest("builtin:deye:sun-30k", 1, "Dach Sued",
                ComponentService.ROLE_CONSUMER, connection, null, null, null, null, null, null),
                "kunde@example.test");

        ArgumentCaptor<Integer> revision = ArgumentCaptor.forClass(Integer.class);
        ArgumentCaptor<String> operation = ArgumentCaptor.forClass(String.class);
        verify(outbox).enqueue(eq(TENANT), eq(SITE), eq(ENTITY), revision.capture(),
                operation.capture());
        assertThat(revision.getValue())
                .as("die Outbox fuehrt genau die geschriebene Fassung")
                .isEqualTo(7);
        assertThat(operation.getValue()).isEqualTo("component_create");
        verify(registry, never()).pushRegistryBestEffort(any());
    }

    private static ComponentTemplateDto template() {
        return new ComponentTemplateDto("builtin:deye:sun-30k", "builtin", 1, "deye", "Deye",
                "sun-30k", "SUN-30K", null, "inverter", null, "hybrid_3p", "Hybrid 3-phasig",
                "solarman_v5", "Solarman V5", null, null, null, BigDecimal.valueOf(30), 0,
                "builtin", null, null, null, null);
    }
}
