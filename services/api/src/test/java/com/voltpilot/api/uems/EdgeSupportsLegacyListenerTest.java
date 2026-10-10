package com.voltpilot.api.uems;

import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.web.dto.DeviceDto;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** Runs unchanged against the pre-IP-18 listener to prove forward wire compatibility. */
class EdgeSupportsLegacyListenerTest {
    @Test
    void futureSupportsBlockLeavesLegacySourceAndLivenessHandlingIntact() throws Exception {
        var mapper = new ObjectMapper();
        var payload = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.readTree(
                getClass().getResourceAsStream("/fixtures/data-source-status-heartbeat-new.json"));
        payload.putArray("supports").add("data_sources").add("measurement_sample_provenance");
        UUID tenant = UUID.fromString(payload.path("tenant_id").asText());
        UUID site = UUID.fromString(payload.path("site_id").asText());
        UUID device = UUID.fromString(payload.path("device_id").asText());
        var devices = mock(DeviceRepository.class);
        var statuses = mock(DeviceDataSourceStatusRepository.class);
        when(devices.findById(device)).thenReturn(Optional.of(
                new DeviceDto(device, site, "VP-BOX", "gateway", null, "claimed", null, null)));
        var listener = new DataSourceStatusListener("tcp://unused", "", "", devices, statuses, mock(BoxFaehigkeiten.class));
        listener.handle("ems/" + tenant + "/" + site + "/" + device + "/status", mapper.writeValueAsBytes(payload));
        verify(devices).markStatusSeen(device);
        verify(statuses).replaceForDevice(eq(device), eq(tenant), any(), argThat(rows -> rows.size() == 2));
        verifyNoMoreInteractions(statuses);
    }
}
