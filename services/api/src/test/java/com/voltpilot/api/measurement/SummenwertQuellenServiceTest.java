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
    private final SummenwertQuellenService service = new SummenwertQuellenService(registry, lead);
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
}
