package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.EdgeVersionRepository;
import com.voltpilot.api.web.dto.DeviceDto;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class EdgeSupportsListenerTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final UUID TENANT = UUID.randomUUID(), SITE = UUID.randomUUID(), DEVICE = UUID.randomUUID();
    private static final String TOPIC = "ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/status";
    private final DeviceRepository devices = mock(DeviceRepository.class);
    private final DeviceDataSourceStatusRepository sources = mock(DeviceDataSourceStatusRepository.class);
    private final BoxFaehigkeiten capabilities = mock(BoxFaehigkeiten.class);
    private final DataSourceStatusListener listener = new DataSourceStatusListener("tcp://unused", "", "", devices, sources, capabilities);

    private ObjectNode heartbeat() {
        when(devices.findById(DEVICE)).thenReturn(Optional.of(new DeviceDto(DEVICE, SITE, "VP-BOX", "gateway", null, "claimed", null, null)));
        return JSON.createObjectNode().put("schema_version", "1.0").put("tenant_id", TENANT.toString())
                .put("site_id", SITE.toString()).put("device_id", DEVICE.toString()).put("ts", "2026-09-18T12:00:00Z");
    }

    @Test
    void sharedVectorsExerciseListenerAndReportedOrTableRule() throws Exception {
        var vectors = JSON.readTree(Files.readString(Path.of("../../docs/contracts/v2/edge-supports-vectors.json")));
        var schema = JSON.readTree(Files.readString(Path.of("../../docs/contracts/v2/edge-supports.schema.json")));
        var names = new java.util.ArrayList<String>();
        vectors.path("capabilities").forEach(c -> names.add(c.path("name").asText()));
        assertThat(EdgeSupports.NAMES).containsExactlyElementsOf(names);
        for (var v : vectors.path("cases")) {
            reset(capabilities);
            var payload = heartbeat();
            if (!v.path("supports").isNull()) {
                assertThat(UemsSchemaLaeufer.verstoesse(v.path("supports"), schema)).isEmpty();
                payload.set("supports", v.path("supports"));
            }
            listener.handle(TOPIC, JSON.writeValueAsBytes(payload));
            @SuppressWarnings("unchecked")
            var captured = org.mockito.ArgumentCaptor.forClass((Class<List<String>>) (Class<?>) List.class);
            verify(capabilities).record(eq(DEVICE), eq(Instant.parse("2026-09-18T12:00:00Z")), captured.capture());
            List<String> tableNames = JSON.convertValue(v.path("table"), new com.fasterxml.jackson.core.type.TypeReference<>() {});
            var table = names.stream().map(n -> new DatenquelleRegeln.TabellenEintrag(n, n, tableNames.contains(n) ? "released" : null)).toList();
            var result = DatenquelleRegeln.faehigkeiten(new DatenquelleRegeln.Stand("released", "released", captured.getValue()), table, List.of("released"));
            List<String> expected = JSON.convertValue(v.path("expected"), new com.fasterxml.jackson.core.type.TypeReference<>() {});
            assertThat(BoxFaehigkeiten.effective("released-build", captured.getValue(),
                    List.of(new EdgeVersionRepository.RegisterEntry("released", 7)), table))
                    .as(v.path("name").asText()).containsExactlyElementsOf(expected);
            assertThat(result.faehigkeiten().stream().filter(DatenquelleRegeln.FaehigkeitStatus::vorhanden)
                    .map(DatenquelleRegeln.FaehigkeitStatus::code)).as(v.path("name").asText()).containsExactlyElementsOf(expected);
        }
    }

    @Test
    void unknownNameLogsOnceAndNeverBecomesCapability() throws Exception {
        var log = (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(DataSourceStatusListener.class);
        var appender = new ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent>();
        appender.start(); log.addAppender(appender);
        try {
            var payload = heartbeat(); payload.putArray("supports").add("future_feature").add("data_sources");
            listener.handle(TOPIC, JSON.writeValueAsBytes(payload));
            listener.handle(TOPIC, JSON.writeValueAsBytes(payload));
            verify(capabilities, times(2)).record(eq(DEVICE), any(), eq(List.of("data_sources")));
            assertThat(appender.list.stream().filter(e -> e.getFormattedMessage().contains("future_feature"))).hasSize(1);
        } finally { log.detachAppender(appender); appender.stop(); }
    }

    @Test
    void identityMismatchMalformedBlockAndFailedExtensionCannotChangeLegacyHandling() throws Exception {
        var payload = heartbeat(); payload.putArray("supports").add("data_sources");
        listener.handle(TOPIC.replace(DEVICE.toString(), UUID.randomUUID().toString()), JSON.writeValueAsBytes(payload));
        verifyNoInteractions(capabilities);
        payload.put("supports", "wrong"); payload.putArray("data_sources");
        listener.handle(TOPIC, JSON.writeValueAsBytes(payload));
        verifyNoInteractions(capabilities);
        verify(sources).replaceForDevice(eq(DEVICE), eq(TENANT), any(), eq(List.of()));
        payload.putArray("supports").add("data_sources");
        doThrow(new IllegalStateException("sink unavailable")).when(capabilities).record(any(), any(), any());
        listener.handle(TOPIC, JSON.writeValueAsBytes(payload));
        verify(sources, times(2)).replaceForDevice(eq(DEVICE), eq(TENANT), any(), eq(List.of()));
    }

    @Test
    void existingCustomerRouteCarriesRawReportAndCentralEffectiveResult() {
        var versions = mock(EdgeVersionRepository.class);
        when(versions.releases()).thenReturn(List.of());
        when(versions.findAll()).thenReturn(List.of(new EdgeVersionRepository.EdgeVersion(DEVICE, SITE, "dev", null, Instant.now(),
                List.of("data_sources", "measurement_sample_provenance"))));
        var controller = new com.voltpilot.api.web.EdgeVersionController(versions,
                mock(com.voltpilot.api.zugriff.TeilansichtDienst.class));
        var row = controller.list().eintraege().getFirst();
        assertThat(row.supports()).containsExactly("data_sources", "measurement_sample_provenance");
        assertThat(row.capabilities()).containsExactly("data_sources", "measurement_sample_provenance");
        assertThat(row.coreVersion()).isEqualTo("dev");
    }

    @Test
    void centralQueryIsPerBoxAndRejectsUnknownAndUnbuiltCapabilities() {
        var versions = mock(EdgeVersionRepository.class);
        when(versions.releases()).thenReturn(List.of());
        when(versions.findAll()).thenReturn(List.of(new EdgeVersionRepository.EdgeVersion(DEVICE, SITE, "dev", null, Instant.now(),
                List.of("data_sources", "measurement_sample_provenance", "events"))));
        var service = new BoxFaehigkeiten(mock(org.springframework.jdbc.core.JdbcTemplate.class), versions);
        assertThat(service.kann(DEVICE, "data_sources")).isTrue();
        assertThat(service.kann(DEVICE, "measurement_sample_provenance")).isTrue();
        assertThat(service.kann(DEVICE, "assignment_effective_at")).isFalse();
        assertThat(service.kann(DEVICE, "events")).isFalse();
        assertThat(service.kann(UUID.randomUUID(), "data_sources")).isFalse();
    }
}
