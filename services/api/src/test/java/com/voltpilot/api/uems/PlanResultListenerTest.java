package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.web.dto.DeviceDto;
import com.voltpilot.api.repo.DeviceRepository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** Vertragsprüfung der Plan-Quittung ohne Datenbank (AP-15 IP-10); Go-Zwilling agent/plan_result_test.go. */
class PlanResultListenerTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path VERTRAG = Path.of("../../docs/contracts/v2");
    private final PlanResultListener listener = new PlanResultListener("tcp://unused", "", "",
            mock(PlanZustellungRepository.class), JSON);

    private static JsonNode vectors() throws Exception {
        return JSON.readTree(Files.readString(VERTRAG.resolve("plan-result-vectors.json")));
    }

    @Test
    void geteilteVektorenUndGeschlossenesVokabular() throws Exception {
        JsonNode v = vectors();
        JsonNode schema = JSON.readTree(Files.readString(VERTRAG.resolve("mqtt-plan-result.schema.json")));
        List<String> gruende = new ArrayList<>();
        v.path("gruende").forEach(g -> gruende.add(g.asText()));
        assertThat(PlanResultListener.GRUENDE).containsExactlyElementsOf(gruende);
        List<String> schemaGruende = new ArrayList<>();
        schema.path("properties").path("grund").path("enum").forEach(g -> schemaGruende.add(g.asText()));
        assertThat(schemaGruende).containsExactlyElementsOf(gruende);
        String migration = Files.readString(Path.of(
                "src/main/resources/db/migration/V20260921130000__plan_zustellung.sql"));
        gruende.forEach(g -> assertThat(migration).contains("'" + g + "'"));

        JsonNode id = v.path("identitaet");
        String topic = "ems/" + id.path("tenant_id").asText() + "/" + id.path("site_id").asText() + "/"
                + id.path("device_id").asText() + "/v2/plan-result";
        Instant jetzt = Instant.parse("2027-06-15T08:15:04Z");
        for (JsonNode c : v.path("cloud")) {
            ObjectNode payload = JSON.createObjectNode().put("schema_version", "1.0")
                    .put("tenant_id", id.path("tenant_id").asText()).put("site_id", id.path("site_id").asText())
                    .put("device_id", c.path("payload_device_id").asText(id.path("device_id").asText()))
                    .put("ts", "2027-06-15T08:15:03Z");
            payload.setAll((ObjectNode) c.path("quittung"));
            var geprueft = listener.pruefe(topic, JSON.writeValueAsBytes(payload), jetzt);
            assertThat(geprueft != null).as(c.path("name").asText()).isEqualTo(c.path("gilt").asBoolean());
            if (c.path("gilt").asBoolean()) {
                assertThat(UemsSchemaLaeufer.verstoesse(payload, schema)).as(c.path("name").asText()).isEmpty();
                var q = geprueft.quittung();
                assertThat(q.angenommen()).isEqualTo(c.path("quittung").path("angenommen").asBoolean());
                assertThat(q.grund()).isEqualTo(c.path("quittung").path("grund").textValue());
                assertThat(q.quittiertUm()).isEqualTo(Instant.parse("2027-06-15T08:15:03Z"));
                assertThat(q.empfangenUm()).isEqualTo(jetzt);
            }
        }
        // Jede Box-Quittung aus den Vektoren, die einem Plan zuzuordnen ist, nimmt die Cloud an.
        for (JsonNode c : v.path("box")) {
            ObjectNode payload = JSON.createObjectNode().put("schema_version", "1.0")
                    .put("tenant_id", id.path("tenant_id").asText()).put("site_id", id.path("site_id").asText())
                    .put("device_id", id.path("device_id").asText()).put("ts", "2027-06-15T08:15:03Z");
            payload.setAll((ObjectNode) c.path("erwartet"));
            boolean zuzuordnen = c.path("erwartet").has("plan_id");
            assertThat(listener.pruefe(topic, JSON.writeValueAsBytes(payload), jetzt) != null)
                    .as(c.path("name").asText()).isEqualTo(zuzuordnen);
            assertThat(UemsSchemaLaeufer.verstoesse(payload, schema)).as(c.path("name").asText()).isEmpty();
        }
        assertThat(listener.pruefe(topic.replace("plan-result", "plan"), JSON.writeValueAsBytes(
                JSON.createObjectNode()), jetzt)).isNull();
    }

    /**
     * Alte Box gegen neue Box am Status-Zuhörer: der Block gemeinsame_steuerung ändert weder das
     * Lebenszeichen noch die Fähigkeiten noch den Quellenstatus - Empfang und Flottenbild bleiben.
     */
    @Test
    void herzschlagMitBlockWirktWieOhne() throws Exception {
        UUID tenant = UUID.fromString("00000000-0000-0000-0000-000000000001");
        UUID site = UUID.fromString("00000000-0000-0000-0000-000000000002");
        UUID device = UUID.fromString("00000000-0000-0000-0000-000000000003");
        String topic = "ems/" + tenant + "/" + site + "/" + device + "/status";
        ObjectNode alt;
        try (var in = PlanResultListenerTest.class.getResourceAsStream("/fixtures/data-source-status-heartbeat-new.json")) {
            alt = (ObjectNode) JSON.readTree(in);
        }
        alt.putArray("supports").add("data_sources").add("events");
        ObjectNode neu = alt.deepCopy();
        ((com.fasterxml.jackson.databind.node.ArrayNode) neu.get("supports")).add("plan_quittung");
        neu.set("gemeinsame_steuerung", JSON.readTree("""
                {"plan_id":"4711aaaa-0000-4000-8000-000000004711","waechter":{"einspeisung":"regelt"},
                 "messpunkt_alter_s":4}"""));
        JsonNode schema = JSON.readTree(Files.readString(VERTRAG.resolve("mqtt-plan-result.schema.json")));
        var blockSchema = JSON.createObjectNode();
        blockSchema.setAll((ObjectNode) schema.path("$defs").path("herzschlag_block"));
        blockSchema.set("$defs", schema.path("$defs"));
        assertThat(UemsSchemaLaeufer.verstoesse(neu.get("gemeinsame_steuerung"), blockSchema)).isEmpty();

        List<List<Object>> gesehen = new ArrayList<>();
        for (ObjectNode herzschlag : List.of(alt, neu)) {
            DeviceRepository devices = mock(DeviceRepository.class);
            DeviceDataSourceStatusRepository statuses = mock(DeviceDataSourceStatusRepository.class);
            BoxFaehigkeiten faehigkeiten = mock(BoxFaehigkeiten.class);
            when(devices.findById(device)).thenReturn(Optional.of(new DeviceDto(device, site,
                    "VP-BOX-1", "gateway", null, "claimed", Instant.now(), Instant.now())));
            new DataSourceStatusListener("tcp://unused", "", "", devices, statuses, faehigkeiten)
                    .handle(topic, JSON.writeValueAsBytes(herzschlag));
            verify(devices).markStatusSeen(device);
            @SuppressWarnings("unchecked")
            var supports = org.mockito.ArgumentCaptor.forClass((Class<List<String>>) (Class<?>) List.class);
            verify(faehigkeiten).record(eq(device), any(), supports.capture());
            @SuppressWarnings("unchecked")
            var meldungen = org.mockito.ArgumentCaptor.forClass(
                    (Class<List<DeviceDataSourceStatusRepository.Meldung>>) (Class<?>) List.class);
            verify(statuses).replaceForDevice(eq(device), eq(tenant), any(), meldungen.capture());
            gesehen.add(List.of(supports.getValue(), meldungen.getValue()));
        }
        assertThat(gesehen.get(1).get(1)).isEqualTo(gesehen.get(0).get(1));
        assertThat(gesehen.get(0).get(0)).isEqualTo(List.of("data_sources", "events"));
        assertThat(gesehen.get(1).get(0)).isEqualTo(List.of("data_sources", "events", "plan_quittung"));
    }
}
