package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import com.voltpilot.api.measurement.MeasurementSelectionService.State;
import com.voltpilot.api.web.DeviceMeasurementSelectionController;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

class MeasurementSelectionRoutingTest {
    @Test void controllerPublishesTheResolvedBoxAndNamesTransportFailure() {
        UUID old = UUID.randomUUID(), actual = UUID.randomUUID(), entity = UUID.randomUUID();
        var service = mock(MeasurementSelectionService.class);
        var publisher = mock(MeasurementConfigPublisher.class);
        @SuppressWarnings("unchecked") ObjectProvider<MeasurementConfigPublisher> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(publisher);
        var scope = new MeasurementSelectionRepository.DeviceScope(UUID.randomUUID(), UUID.randomUUID(), actual);
        var state = new State(actual, scope.siteId(), entity, 1, "test", "pending_edge", "wartet",
                null, null, List.of(), List.of(), null);
        var full = new State(actual, scope.siteId(), null, 1, "test", "pending_edge", "wartet",
                null, null, List.of(), List.of(), null);
        when(service.change(eq(old), eq(entity), eq("point"), any(), any())).thenReturn(state);
        when(service.requireDevice(actual)).thenReturn(scope);
        when(service.forPublishing(actual)).thenReturn(full);
        var controller = new DeviceMeasurementSelectionController(service, mock(MeasurementCatalog.class),
                provider, mock(MeasurementHistoryService.class), mock(com.voltpilot.api.uems.BestandGeraeteCsv.class));
        var request = new DeviceMeasurementSelectionController.SelectionChangeRequest(0L, UUID.randomUUID(), true, 60);
        var failed = controller.change(old, "point", entity, request, null);
        assertThat(failed.deviceId()).isEqualTo(actual);
        assertThat(failed.statusReason()).contains("Zustellung", "fehlgeschlagen");
        verify(publisher).publish(scope, full);
        verify(service, never()).requireDevice(old);
        when(provider.getIfAvailable()).thenReturn(null);
        assertThat(controller.change(old, "point", entity, request, null).statusReason()).contains("nicht verfügbar");
        when(provider.getIfAvailable()).thenReturn(publisher);
        when(publisher.publish(scope, full)).thenReturn(true);
        assertThat(controller.change(old, "point", entity, request, null)).isEqualTo(state);
    }
}
