package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementSelectionRepository.DeviceScope;
import com.voltpilot.api.measurement.MeasurementSelectionService.SelectionPoint;
import com.voltpilot.api.measurement.MeasurementSelectionService.State;
import com.voltpilot.api.tenant.TenantContext;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

class MeasurementContractsTest {
    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final String STATUS_TOPIC = "ems/" + TENANT + "/" + SITE + "/" + DEVICE
            + "/v2/measurement-config-status";
    private final ObjectMapper mapper = new ObjectMapper().findAndRegisterModules();

    @Test
    void publisherPayloadIsTheCommittedValidFixture() throws Exception {
        MeasurementConfigPublisher publisher = new MeasurementConfigPublisher(
                "tcp://unused:1883", "", "", mapper);
        SelectionPoint point = new SelectionPoint("deye.hybrid_1p.battery.battery", true, 10,
                7, null, null, "2026.08.25.1", "test", null, null, "pending_edge",
                null, null, null, "thermal_bms", 90, 900, "fifteen_minute",
                null, null, null, null);
        State state = new State(DEVICE, SITE, 7, "2026.08.25.1", "pending_edge", null,
                null, null, List.of(point), List.of(), null);
        var actual = mapper.readTree(publisher.payload(new DeviceScope(TENANT, SITE, DEVICE), state));
        var fixture = mapper.readTree(Files.readString(Path.of("..", "..", "docs", "contracts",
                "v2", "examples", "mqtt-measurement-config.valid.json")));
        assertThat(actual).isEqualTo(fixture);
        assertThat(MeasurementConfigPublisher.topic(TENANT, SITE, DEVICE))
                .isEqualTo("ems/" + TENANT + "/" + SITE + "/" + DEVICE
                        + "/v2/measurement-config");
    }

    @Test
    void publisherCarriesConcreteCustomDefinitionToTheEdge() throws Exception {
        MeasurementConfigPublisher publisher = new MeasurementConfigPublisher(
                "tcp://unused:1883", "", "", mapper);
        var definition = mapper.readTree("{\"label\":\"Test\",\"sourceKind\":\"modbus_input\",\"address\":42,"
                + "\"selector\":\"input:0x002a\",\"valueType\":\"uint16\",\"widthBits\":16,"
                + "\"signed\":false,\"endian\":\"big\",\"scale\":1,\"unit\":\"V\","
                + "\"cadenceS\":30,\"retentionClass\":\"unclassified\",\"readOnly\":true,"
                + "\"requestCostMs\":400}");
        SelectionPoint point = new SelectionPoint("custom.abc", true, 30, 8, null, null,
                "2026.08.25.1", "test", null, null, "pending_edge", null, null, definition,
                "unclassified", 90, 900, "fifteen_minute", "Test", "custom", "custom", "known");
        State state = new State(DEVICE, SITE, 8, "2026.08.25.1", "pending_edge", null,
                null, null, List.of(point), List.of(), null);
        var payload = mapper.readTree(publisher.payload(new DeviceScope(TENANT, SITE, DEVICE), state));
        assertThat(payload.at("/selections/0/definition")).isEqualTo(definition);
        var fixture = mapper.readTree(Files.readString(Path.of("..", "..", "docs", "contracts",
                "v2", "examples", "mqtt-measurement-config.valid.custom.json")));
        assertThat(payload).isEqualTo(fixture);
    }

    @Test
    void statusIdentityAndMonotoneRevisionAreEnforced() throws Exception {
        MeasurementSelectionRepository repository = mock(MeasurementSelectionRepository.class);
        when(repository.deviceScope(DEVICE)).thenReturn(new DeviceScope(TENANT, SITE, DEVICE));
        when(repository.revision(DEVICE)).thenReturn(8L);
        when(repository.acknowledgedRevision(DEVICE)).thenReturn(6L);
        MeasurementConfigStatusListener listener = new MeasurementConfigStatusListener(
                "tcp://unused:1883", "", "", repository, mapper);

        byte[] valid = fixture("mqtt-measurement-config-status.valid.json");
        assertThat(listener.handle(STATUS_TOPIC, valid)).isTrue();
        verify(repository).applyAcknowledgement(eq(DEVICE), eq(7L),
                eq(Instant.parse("2026-08-25T12:00:00Z")),
                eq(Set.of("deye.hybrid_1p.battery.battery")), eq(Map.of()),
                eq("2026.08.25"));
        assertThat(TenantContext.get()).isNull();

        when(repository.acknowledgedRevision(DEVICE)).thenReturn(8L);
        assertThat(listener.handle(STATUS_TOPIC, valid)).isFalse();
        assertThat(listener.handle(STATUS_TOPIC,
                new String(valid).replace("\"edge_version\"", "\"unexpected\":1,\"edge_version\"")
                        .getBytes())).isFalse();
        assertThat(listener.handle(STATUS_TOPIC.replace(TENANT.toString(),
                "10000000-0000-0000-0000-000000000001"), valid)).isFalse();
        verify(repository, never()).applyAcknowledgement(eq(DEVICE), eq(8L), any(), any(), any(), any());
    }

    @Test
    void initialStatusBrokerOutageDoesNotWedgeFutureRetries() {
        var listener = new MeasurementConfigStatusListener("tcp://127.0.0.1:1", "", "",
                mock(MeasurementSelectionRepository.class), mapper);
        listener.ensureConnected();
        assertThat(listener.connectedForTest()).isFalse();
        listener.ensureConnected();
        assertThat(listener.connectedForTest()).isFalse();
        listener.close();
    }

    @SuppressWarnings("unchecked")
    @Test
    void pendingDesiredRevisionIsRepublishedByReconciliation() {
        JdbcTemplate admin = mock(JdbcTemplate.class);
        MeasurementSelectionService service = mock(MeasurementSelectionService.class);
        MeasurementConfigPublisher publisher = mock(MeasurementConfigPublisher.class);
        DeviceScope scope = new DeviceScope(TENANT, SITE, DEVICE);
        State state = new State(DEVICE, SITE, 9, "2026.08.25.1", "pending_edge", null,
                null, null, List.of(), List.of(), null);
        when(admin.query(anyString(), any(RowMapper.class))).thenReturn(List.of(scope));
        when(service.state(DEVICE)).thenReturn(state);
        new MeasurementConfigReconciler(admin, service, publisher).reconcile();
        verify(publisher).publish(scope, state);
        assertThat(TenantContext.get()).isNull();
    }

    @Test
    void rollupHardeningIsReplayAwareAndQualityCorrect() throws Exception {
        String sql = Files.readString(Path.of("src", "main", "resources", "db", "migration",
                "V20260847000000__measurement_pipeline_review_hardening.sql"));
        assertThat(sql).contains("quality = 'good'")
                .contains("now()-INTERVAL '90 days'")
                .doesNotContain("now()-INTERVAL '2 days'");
    }

    private static byte[] fixture(String name) throws Exception {
        return Files.readAllBytes(Path.of("..", "..", "docs", "contracts", "v2", "examples", name));
    }
}
