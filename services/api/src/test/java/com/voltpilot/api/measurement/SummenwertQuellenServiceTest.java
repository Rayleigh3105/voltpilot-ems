package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.LeadDeviceService;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class SummenwertQuellenServiceTest {
    private final EntityRegistryRepository registry = mock(EntityRegistryRepository.class);
    private final LeadDeviceService lead = mock(LeadDeviceService.class);
    private final MeasurementSelectionRepository components = mock(MeasurementSelectionRepository.class);
    private final SummenwertQuellenService service = new SummenwertQuellenService(registry, lead, components);
    private final UUID site = UUID.randomUUID(), box = UUID.randomUUID(), entity = UUID.randomUUID();

    private void setup() {
        var row = mock(EntityRegistryRepository.EntityRow.class);
        when(row.id()).thenReturn(entity); when(row.label()).thenReturn("Unterzähler");
        when(row.entityType()).thenReturn("modbus-generic");
        // Das alte device_id bleibt absichtlich null: viele gültige Komponenten haben keines.
        when(registry.entitiesForSite(site)).thenReturn(List.of(row));
        when(lead.fuehrendeBox(site)).thenReturn(new LeadDeviceService.FuehrendeBox(box, null));
        when(registry.siteDeviceIds(site)).thenReturn(List.of(box));
    }
    @Test void legacyComponentWithoutDeviceIdUsesTheExistingPushAssignment() {
        setup();
        assertThat(service.sources(site)).containsExactly(new SummenwertQuellenService.Quelle(entity, box, "Unterzähler", null));
    }
    @Test void ambiguousLeadingBoxStaysVisibleWithoutAGuessedReader() {
        setup();
        when(lead.fuehrendeBox(site)).thenReturn(new LeadDeviceService.FuehrendeBox(null,
                com.voltpilot.api.uems.FuehrendeBoxAbleitung.Grund.KEINE_WAHL));
        assertThat(service.sources(site).getFirst()).satisfies(q -> {
            assertThat(q.deviceId()).isNull(); assertThat(q.grund()).isNotBlank();
        });
    }
    @Test void deviceSourcesResolveTheStableReferenceAndExcludeAnotherDeviceOnTheSameBox() {
        setup();
        UUID second = UUID.randomUUID(), other = UUID.randomUUID();
        when(components.deviceScope(box)).thenReturn(new MeasurementSelectionRepository.DeviceScope(UUID.randomUUID(), site, box));
        when(components.geraeteKomponenten(site, box)).thenReturn(List.of(
                new MeasurementSelectionRepository.GeraeteKomponente(entity, "inverter", "hybrid_3p"),
                new MeasurementSelectionRepository.GeraeteKomponente(second, "inverter", "hybrid_3p"),
                new MeasurementSelectionRepository.GeraeteKomponente(other, "src-other", "hybrid_3p")));
        assertThat(service.geraet(site, box, "inverter")).containsExactlyInAnyOrder(entity, second);
        assertThat(service.sources(site, box, "inverter")).extracting(SummenwertQuellenService.Quelle::entityId).containsExactly(entity);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> service.geraet(UUID.randomUUID(), box, "inverter"))
                .isInstanceOf(org.springframework.web.server.ResponseStatusException.class)
                .satisfies(e -> assertThat(((org.springframework.web.server.ResponseStatusException) e).getStatusCode().value()).isEqualTo(404));
    }
}
