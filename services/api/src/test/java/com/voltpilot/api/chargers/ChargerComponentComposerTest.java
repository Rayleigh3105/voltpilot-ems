package com.voltpilot.api.chargers;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.repo.DeviceChargerStatusRepository;
import com.voltpilot.api.repo.DeviceChargerStatusRepository.UnboundCharger;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class ChargerComponentComposerTest {

    @Test
    void aTechnicalChargePointIdIsNotStoredAsAHumanAlias() {
        UUID siteId = UUID.randomUUID();
        UUID deviceId = UUID.randomUUID();
        UUID entityId = UUID.randomUUID();
        DeviceChargerStatusRepository status = mock(DeviceChargerStatusRepository.class);
        EntityRegistryService registry = mock(EntityRegistryService.class);
        when(status.unbound(siteId)).thenReturn(List.of(
                // Die Box normalisiert ein leeres Label auf die Id; auch diese
                // Drahtform bleibt ein technischer Rückfall, kein Alias.
                new UnboundCharger(deviceId, "CP-TECHNICAL-1", "CP-TECHNICAL-1")));
        when(registry.createEntity(siteId, "ev-charger", null, null, null, null))
                .thenReturn(row(entityId, null));

        new ChargerComponentComposer(status, registry).ensureComposed(siteId, deviceId);

        verify(registry).createEntity(siteId, "ev-charger", null, null, null, null);
        verify(status).bindEntity(deviceId, "CP-TECHNICAL-1", entityId);
    }

    @Test
    void anOperatorGivenNameSeedsTheSharedAliasTrimmed() {
        UUID siteId = UUID.randomUUID();
        UUID deviceId = UUID.randomUUID();
        UUID entityId = UUID.randomUUID();
        DeviceChargerStatusRepository status = mock(DeviceChargerStatusRepository.class);
        EntityRegistryService registry = mock(EntityRegistryService.class);
        when(status.unbound(siteId)).thenReturn(List.of(
                new UnboundCharger(deviceId, "CP-1", "  Hof Nord  ")));
        when(registry.createEntity(siteId, "ev-charger", "Hof Nord", null, null, null))
                .thenReturn(row(entityId, "Hof Nord"));

        new ChargerComponentComposer(status, registry).ensureComposed(siteId, deviceId);

        verify(registry).createEntity(siteId, "ev-charger", "Hof Nord", null, null, null);
        verify(status).bindEntity(deviceId, "CP-1", entityId);
    }

    private static EntityRow row(UUID id, String label) {
        return new EntityRow(id, "consumer", label, null, null, null, null, null, null,
                null, true, "ev-charger", null, null, null, null, null, null, 0, null);
    }
}
