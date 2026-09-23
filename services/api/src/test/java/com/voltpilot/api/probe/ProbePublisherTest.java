package com.voltpilot.api.probe;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * The bytes that go on the wire, without a broker: the envelope must be exactly
 * what {@code docs/contracts/mqtt-probe.schema.json} describes, because the box
 * refuses anything else and the customer would only see "die Anlage hat nicht
 * geantwortet".
 */
class ProbePublisherTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");

    private final ObjectMapper json = new ObjectMapper();

    private JsonNode envelope(List<ProbeRequest.Op> ops, String requestedBy) throws Exception {
        byte[] raw = ProbePublisher.envelope(TENANT, SITE, DEVICE, "9f2c41ab77d0e315",
                Instant.parse("2026-08-11T09:12:00Z"), requestedBy, ops);
        return json.readTree(new String(raw, StandardCharsets.UTF_8));
    }

    private static ProbeRequest.Op minimal() {
        return new ProbeRequest.Op("soc", "192.168.0.28", null, null, "holding", 588,
                "u16", null, null, null);
    }

    @Test
    void theEnvelopeIsContractShapedAndAppliesTheDefaults() throws Exception {
        JsonNode doc = envelope(List.of(minimal()), null);

        assertThat(doc.get("schema_version").asText()).isEqualTo("1.0");
        assertThat(doc.get("type").asText()).isEqualTo("probe_request");
        assertThat(doc.get("tenant_id").asText()).isEqualTo(TENANT.toString());
        assertThat(doc.get("site_id").asText()).isEqualTo(SITE.toString());
        assertThat(doc.get("device_id").asText()).isEqualTo(DEVICE.toString());
        assertThat(doc.get("request_id").asText()).isEqualTo("9f2c41ab77d0e315");
        // requested_at is what starts the box's expiry window - it is the second
        // half of "non-retained" and must always be present.
        assertThat(doc.get("requested_at").asText()).isEqualTo("2026-08-11T09:12:00Z");
        assertThat(doc.has("requested_by")).as("omitted when unknown, never empty").isFalse();

        JsonNode op = doc.get("ops").get(0);
        assertThat(op.get("op").asText()).isEqualTo("read");
        assertThat(op.get("transport").asText()).isEqualTo("modbus_tcp");
        assertThat(op.get("id").asText()).isEqualTo("soc");
        assertThat(op.get("host").asText()).isEqualTo("192.168.0.28");
        assertThat(op.get("port").asInt()).isEqualTo(502);
        assertThat(op.get("unit_id").asInt()).isEqualTo(1);
        assertThat(op.get("register_kind").asText()).isEqualTo("holding");
        assertThat(op.get("address").asInt()).isEqualTo(588);
        assertThat(op.get("data_type").asText()).isEqualTo("u16");
        assertThat(op.get("word_order").asText()).isEqualTo("big");
    }

    /**
     * scale/offset are DISPLAY arithmetic and are OMITTED when not asked for -
     * so raw == value reads as "no scaling was requested", which is a different
     * statement to a customer than "scaled by 1".
     */
    @Test
    void scalingTravelsOnlyWhenItWasAskedFor() throws Exception {
        JsonNode plain = envelope(List.of(minimal()), null).get("ops").get(0);
        assertThat(plain.has("scale")).isFalse();
        assertThat(plain.has("offset")).isFalse();

        JsonNode scaled = envelope(List.of(new ProbeRequest.Op("t", "10.0.0.5", 1502, 71,
                "input", 100, "s32", "little", 0.1, -273.15)), null).get("ops").get(0);
        assertThat(scaled.get("scale").asDouble()).isEqualTo(0.1);
        assertThat(scaled.get("offset").asDouble()).isEqualTo(-273.15);
        assertThat(scaled.get("word_order").asText()).isEqualTo("little");
        assertThat(scaled.get("port").asInt()).isEqualTo(1502);
        assertThat(scaled.get("unit_id").asInt()).isEqualTo(71);

        // A zero offset IS a statement and must survive; a non-finite one is
        // not a number and must not reach the wire.
        JsonNode zero = envelope(List.of(new ProbeRequest.Op("t", "10.0.0.5", null, null,
                "holding", 0, "u16", null, 1.0, 0.0)), null).get("ops").get(0);
        assertThat(zero.get("offset").asDouble()).isEqualTo(0.0);
        JsonNode nan = envelope(List.of(new ProbeRequest.Op("t", "10.0.0.5", null, null,
                "holding", 0, "u16", null, Double.NaN, Double.POSITIVE_INFINITY)), null)
                .get("ops").get(0);
        assertThat(nan.has("scale")).isFalse();
        assertThat(nan.has("offset")).isFalse();
    }

    /**
     * The envelope is assembled by hand (like its OTA sibling), so the escaping
     * has to hold on its own: no customer-supplied string may break the frame.
     */
    @Test
    void customerSuppliedStringsCannotBreakTheFrame() throws Exception {
        JsonNode doc = envelope(List.of(new ProbeRequest.Op("t",
                "wr\"1\n\\.local", null, null, "holding", 0, "u16", null, null, null)),
                "sub\"ject");
        assertThat(doc.get("ops").get(0).get("host").asText()).isEqualTo("wr\"1\n\\.local");
        assertThat(doc.get("requested_by").asText()).isEqualTo("sub\"ject");
    }

    @Test
    void everyOpTravelsInOrder() throws Exception {
        JsonNode ops = envelope(List.of(
                new ProbeRequest.Op("a", "192.168.0.1", null, null, "holding", 1, "u16",
                        null, null, null),
                new ProbeRequest.Op("b", "192.168.0.2", null, null, "input", 2, "float32",
                        null, null, null)), null).get("ops");
        assertThat(ops).hasSize(2);
        assertThat(ops.get(0).get("id").asText()).isEqualTo("a");
        assertThat(ops.get(1).get("id").asText()).isEqualTo("b");
        assertThat(ops.get(1).get("register_kind").asText()).isEqualTo("input");
    }

    /** Both topics live in the v2/# subtree the per-device ACL already covers. */
    @Test
    void bothTopicsLiveInTheAlreadyGrantedSubtree() {
        assertThat(ProbePublisher.probeTopic(TENANT, SITE, DEVICE))
                .isEqualTo("ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/v2/probe");
        assertThat(ProbePublisher.resultTopic(TENANT, SITE, DEVICE))
                .isEqualTo("ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/v2/probe-result");
    }

    /** AP-05: der Kopf geht als {@code wago_kopf} VOR den Lese-Schritten hinaus, ohne Typenschild. */
    @Test
    void aWagoHeadGoesOutFirstInTheContractShape() throws Exception {
        byte[] raw = ProbePublisher.envelope(TENANT, SITE, DEVICE, "9f2c41ab77d0e315",
                Instant.parse("2026-09-23T10:00:00Z"), null,
                new ProbePublisher.WagoKopfOp("kopf", " 192.168.20.10 ", 502, 1, "input", 4096, "little"),
                List.of(minimal()));
        JsonNode ops = new ObjectMapper().readTree(raw).path("ops");
        assertThat(ops).hasSize(2);
        assertThat(ops.get(0).toString()).isEqualTo("{\"op\":\"wago_kopf\",\"transport\":\"modbus_tcp\","
                + "\"id\":\"kopf\",\"host\":\"192.168.20.10\",\"port\":502,\"unit_id\":1,"
                + "\"register_kind\":\"input\",\"address\":4096,\"word_order\":\"little\"}");
        assertThat(ops.get(1).path("op").asText()).isEqualTo("read");
        // Ohne Kopf bleibt der Umschlag Byte für Byte der bisherige.
        assertThat(ProbePublisher.envelope(TENANT, SITE, DEVICE, "9f2c41ab77d0e315",
                Instant.parse("2026-09-23T10:00:00Z"), null, List.of(minimal())))
                .isEqualTo(ProbePublisher.envelope(TENANT, SITE, DEVICE, "9f2c41ab77d0e315",
                        Instant.parse("2026-09-23T10:00:00Z"), null, null, List.of(minimal())));
    }
}
