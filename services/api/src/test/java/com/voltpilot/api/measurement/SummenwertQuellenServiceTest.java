package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.LeadDeviceService;
import com.voltpilot.api.uems.ZustaendigkeitRepository;
import java.time.Instant;
import java.util.List;
import java.util.Map;
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
        when(registry.datenquelleJeEntitaet(site)).thenReturn(Map.of());
        when(registry.zustaendigkeitenDerQuellen(site)).thenReturn(List.of());
    }
    @Test void legacyComponentWithoutDeviceIdUsesTheExistingPushAssignment() {
        setup();
        assertThat(service.sources(site)).containsExactly(new SummenwertQuellenService.Quelle(entity, box, "Unterzähler", null));
    }
    @Test void explicitSourceFollowsItsCurrentReaderRatherThanTheLeadBox() {
        setup(); UUID reader = UUID.randomUUID(), source = UUID.randomUUID();
        when(registry.siteDeviceIds(site)).thenReturn(List.of(box, reader));
        when(registry.datenquelleJeEntitaet(site)).thenReturn(Map.of(entity, source));
        when(registry.zustaendigkeitenDerQuellen(site)).thenReturn(List.of(new ZustaendigkeitRepository.Zeitraum(UUID.randomUUID(), source, reader, Instant.now().minusSeconds(60), null)));
        assertThat(service.sources(site).getFirst().deviceId()).isEqualTo(reader);
    }
    @Test void missingAssignmentStaysVisibleWithAReasonAndWithoutAGuessedReader() {
        setup(); when(registry.datenquelleJeEntitaet(site)).thenReturn(Map.of(entity, UUID.randomUUID()));
        assertThat(service.sources(site).getFirst()).satisfies(q -> {
            assertThat(q.deviceId()).isNull(); assertThat(q.grund()).isEqualTo("quelle_ohne_zustaendige_box");
        });
    }
}
