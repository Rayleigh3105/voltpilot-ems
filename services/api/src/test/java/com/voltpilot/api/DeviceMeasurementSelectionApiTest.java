package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.*;
import com.voltpilot.api.registerwrite.RegisterWriteService;
import com.voltpilot.api.registerwrite.RegisterWriteTargets;
import com.voltpilot.api.web.DeviceMeasurementSelectionController;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpStatus;
import org.springframework.security.web.method.annotation.AuthenticationPrincipalArgumentResolver;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.server.ResponseStatusException;

/** Echte HTTP-Route und Katalog-Dekodierung, bestehende Vorschau-Lane als Probe-Stub. Kein Geräte-Schreiben. */
class DeviceMeasurementSelectionApiTest {
    private static final UUID DEVICE = UUID.randomUUID(), ENTITY = UUID.randomUUID(), SITE = UUID.randomUUID();
    private static final String GEN = "deye.hybrid_3p.generator-smartload-microinverter.generator-power";
    private final MeasurementSelectionService selections = mock(MeasurementSelectionService.class);
    private final RegisterWriteTargets targets = mock(RegisterWriteTargets.class);
    private final RegisterWriteService preview = mock(RegisterWriteService.class);
    private final SummenwertQuellenService sources = mock(SummenwertQuellenService.class);
    private final MeasurementCatalog catalog = new MeasurementCatalog(new ObjectMapper());
    private MockMvc http;

    @BeforeEach void setup() {
        when(selections.requireDevice(DEVICE)).thenReturn(new MeasurementSelectionRepository.DeviceScope(UUID.randomUUID(), SITE, DEVICE));
        when(selections.requireEntity(any(), eq(ENTITY))).thenReturn(ENTITY);
        when(selections.availableFamilies(DEVICE, ENTITY)).thenReturn(Set.of("hybrid_3p"));
        when(targets.forSite(SITE)).thenReturn(List.of(new RegisterWriteTargets.Target("primary", DEVICE, ENTITY,
                "Deye", "Deye", "SUN-30K", "hybrid_3p", "solarman_v5", "192.168.1.10", 8899, 1, true, null, true)));
        when(sources.sources(SITE)).thenReturn(List.of(new SummenwertQuellenService.Quelle(ENTITY, DEVICE, "Deye", null)));
        var reads = new MeasurementPointReadService(selections, catalog, targets, preview, sources);
        var controller = new DeviceMeasurementSelectionController(selections, catalog, null, null, reads);
        http = MockMvcBuilders.standaloneSetup(controller)
                .setCustomArgumentResolvers(new AuthenticationPrincipalArgumentResolver()).build();
    }

    @Test void genPortReadsBothCatalogAddressesOnTheExistingReadLane() throws Exception {
        when(preview.preview(eq(SITE), any(), any())).thenReturn(answer(2000, true, null), answer(0, true, null));
        read(GEN).andExpect(status().isOk()).andExpect(jsonPath("$.wert").value(2000))
                .andExpect(jsonPath("$.einheit").value("W")).andExpect(jsonPath("$.gelesen_am").isNotEmpty())
                .andExpect(jsonPath("$.grund").isEmpty());
        var commands = ArgumentCaptor.forClass(RegisterWriteService.Command.class);
        verify(preview, times(2)).preview(eq(SITE), commands.capture(), any());
        assertThat(commands.getAllValues()).extracting(RegisterWriteService.Command::addressInput).containsExactly("667", "671");
        assertThat(commands.getAllValues()).allSatisfy(c -> {
            assertThat(c.entityId()).isEqualTo(ENTITY); assertThat(c.deviceId()).isEqualTo(DEVICE);
            assertThat(c.registerKind()).isEqualTo("holding"); assertThat(c.lane()).isEqualTo("primary");
            assertThat(c.valueInput()).isNull();
        });
        verify(preview, never()).write(any(), any(), any());
        verify(selections, never()).change(any(), any(), any(), any(), any());
    }

    @Test void signedWordOrderAndNegativeValueArePreserved() throws Exception {
        when(preview.preview(eq(SITE), any(), any())).thenReturn(answer(63536, true, null), answer(65535, true, null));
        read(GEN).andExpect(status().isOk()).andExpect(jsonPath("$.wert").value(-2000));
    }

    @Test void noReplyIsNotZeroOrAOneWordPartialValue() throws Exception {
        when(preview.preview(eq(SITE), any(), any())).thenReturn(answer(2000, true, null), answer(null, false, "timeout"));
        read(GEN).andExpect(status().isOk()).andExpect(jsonPath("$.wert").isEmpty())
                .andExpect(jsonPath("$.gelesen_am").isEmpty()).andExpect(jsonPath("$.grund").value("box_offline"));
    }

    @Test void aGenuineZeroRemainsZero() throws Exception {
        when(preview.preview(eq(SITE), any(), any())).thenReturn(answer(0, true, null));
        read(GEN).andExpect(status().isOk()).andExpect(jsonPath("$.wert").value(0));
    }

    @Test void anotherDeviceAtTheSameAddressNeverProvesIdentity() throws Exception {
        when(targets.forSite(SITE)).thenReturn(List.of(new RegisterWriteTargets.Target("entity", UUID.randomUUID(), ENTITY,
                "Anderes Gerät", "Deye", null, "hybrid_3p", "modbus_tcp", "192.168.1.10", 502, 1, true, null)));
        read(GEN).andExpect(status().isOk()).andExpect(jsonPath("$.grund").value("nicht_lesbar"));
        verifyNoInteractions(preview);
    }

    @Test void foreignComponentAndUnknownPointStay404() throws Exception {
        when(selections.requireEntity(any(), eq(ENTITY))).thenThrow(new ResponseStatusException(HttpStatus.NOT_FOUND));
        read(GEN).andExpect(status().isNotFound());
        verifyNoInteractions(preview, targets);
    }

    @Test void unsupportedSourceOrFamilyNeverStartsAProbe() throws Exception {
        when(selections.availableFamilies(DEVICE, ENTITY)).thenReturn(Set.of("sunspec"));
        read(GEN).andExpect(status().isOk()).andExpect(jsonPath("$.grund").value("nicht_lesbar"));
        verifyNoInteractions(preview, targets);
    }

    @Test void nullDeviceIdOnTheComponentIsResolvedByThePushRule() throws Exception {
        when(targets.forSite(SITE)).thenReturn(List.of(new RegisterWriteTargets.Target("entity", null, ENTITY,
                "Deye", "Deye", null, "hybrid_3p", "modbus_tcp", "192.168.1.10", 502, 1, true, null)));
        when(preview.preview(eq(SITE), any(), any())).thenReturn(answer(0, true, null));
        read(GEN).andExpect(status().isOk()).andExpect(jsonPath("$.wert").value(0));
    }

    @Test void anUnassignedBoxCannotReadTheComponent() throws Exception {
        when(sources.sources(SITE)).thenReturn(List.of(new SummenwertQuellenService.Quelle(ENTITY, UUID.randomUUID(), "Deye", null)));
        read(GEN).andExpect(status().isOk()).andExpect(jsonPath("$.grund").value("nicht_lesbar"));
        verifyNoInteractions(preview, targets);
    }

    private org.springframework.test.web.servlet.ResultActions read(String point) throws Exception {
        return http.perform(post("/api/v1/devices/" + DEVICE + "/measurement-selection/lesen")
                .param("entityId", ENTITY.toString()).param("pointKey", point));
    }
    private static RegisterWriteService.Outcome answer(Integer raw, boolean ok, String error) {
        return new RegisterWriteService.Outcome("probe", "lesen", ok, "gelesen", raw, null, null, null,
                null, error, null, null, 0, null, null, null, null, null, null, false, null, 0, "primary", Instant.now());
    }
}
