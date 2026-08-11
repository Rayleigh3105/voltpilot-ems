package com.voltpilot.api.probe;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;

/**
 * The probe answer's ingest, without Docker: identity, the closed error
 * vocabulary, and the honesty rules applied on ARRIVAL rather than trusted.
 *
 * <p>Everything a device sends here ends up in front of a customer, so the
 * question these tests keep asking is the same one: can a device make the
 * portal say something that is not true?
 */
class ProbeResultListenerTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final String REQ = "9f2c41ab77d0e315";

    private ProbeRegistry registry;
    private ProbeResultListener listener;

    private CompletableFuture<ProbeResult> arm() {
        registry = new ProbeRegistry();
        listener = new ProbeResultListener("tcp://unused", "", "", registry);
        return registry.register(REQ, DEVICE);
    }

    private static String topic(UUID tenant, UUID site, UUID device) {
        return "ems/" + tenant + "/" + site + "/" + device + "/v2/probe-result";
    }

    private static byte[] body(String json) {
        return json.getBytes(StandardCharsets.UTF_8);
    }

    private static String envelope(String results) {
        return envelope(TENANT, SITE, DEVICE, REQ, results, "");
    }

    private static String envelope(UUID tenant, UUID site, UUID device, String requestId,
            String results, String extra) {
        return "{\"schema_version\":\"1.0\",\"type\":\"probe_result\""
                + ",\"tenant_id\":\"" + tenant + "\""
                + ",\"site_id\":\"" + site + "\""
                + ",\"device_id\":\"" + device + "\""
                + ",\"request_id\":\"" + requestId + "\""
                + ",\"answered_at\":\"2026-08-11T09:12:02Z\""
                + extra
                + ",\"results\":[" + results + "]}";
    }

    private static ProbeResult get(CompletableFuture<ProbeResult> f) {
        return new ProbeRegistry().await(f, Duration.ofMillis(50));
    }

    @Test
    void aGoodAnswerReachesTheWaitingRequestWithRawAndValue() {
        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(
                "{\"id\":\"soc\",\"ok\":true,\"raw\":94,\"registers\":[94],\"value\":9.4}")));

        ProbeResult res = get(f);
        assertThat(res).isNotNull();
        assertThat(res.requestId()).isEqualTo(REQ);
        assertThat(res.errorCode()).isNull();
        assertThat(res.results()).hasSize(1);
        ProbeResult.OpResult line = res.results().get(0);
        assertThat(line.ok()).isTrue();
        assertThat(line.raw()).isEqualTo(94.0);
        assertThat(line.value()).isEqualTo(9.4);
        assertThat(line.registers()).containsExactly(94);
    }

    /**
     * The identity rule of every listener on the device topics: a device may
     * not answer for another one. Both halves are checked - a foreign TOPIC and
     * a payload that disagrees with its own topic.
     */
    @Test
    void anAnswerFromAnotherDeviceNeverCompletesTheRequest() {
        UUID other = UUID.randomUUID();

        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, other),
                body(envelope(TENANT, SITE, other, REQ, "", "")));
        assertThat(get(f)).as("a foreign device's answer is not ours").isNull();

        f = arm();
        // Topic says our device, payload claims another - the payload lies.
        listener.handle(topic(TENANT, SITE, DEVICE),
                body(envelope(TENANT, SITE, other, REQ, "", "")));
        assertThat(get(f)).as("payload identity must equal topic identity").isNull();

        f = arm();
        listener.handle(topic(UUID.randomUUID(), SITE, DEVICE),
                body(envelope(TENANT, SITE, DEVICE, REQ, "", "")));
        assertThat(get(f)).as("a foreign tenant topic is not ours").isNull();
    }

    @Test
    void anUnknownOrExpiredCorrelationIsDropped() {
        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE),
                body(envelope(TENANT, SITE, DEVICE, "0000000000000000", "", "")));
        assertThat(get(f)).isNull();
    }

    @Test
    void aForeignFormIsIgnoredEntirely() {
        for (String payload : List.of(
                "nicht json",
                "[]",
                "{\"type\":\"probe_result\"}",
                envelope(TENANT, SITE, DEVICE, REQ, "", "").replace("\"1.0\"", "\"2.0\""),
                envelope(TENANT, SITE, DEVICE, REQ, "", "")
                        .replace("probe_result", "etwas_anderes"))) {
            CompletableFuture<ProbeResult> f = arm();
            listener.handle(topic(TENANT, SITE, DEVICE), body(payload));
            assertThat(get(f)).as(payload).isNull();
        }
    }

    /**
     * ⚠ THE honesty rule, enforced rather than trusted: a line that CLAIMS
     * success but carries no numbers is not a reading. Without this a device
     * could put an empty tile in front of a customer that reads like a
     * measured 0.
     */
    @Test
    void anOkLineWithoutNumbersIsNotAReading() {
        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(
                "{\"id\":\"a\",\"ok\":true},"
                        + "{\"id\":\"b\",\"ok\":true,\"raw\":5},"
                        + "{\"id\":\"c\",\"ok\":true,\"raw\":5,\"value\":5}")));

        ProbeResult res = get(f);
        assertThat(res.results()).hasSize(3);
        assertThat(res.results().get(0).ok()).isFalse();
        assertThat(res.results().get(0).raw()).isNull();
        assertThat(res.results().get(1).ok()).as("raw without value is half a statement").isFalse();
        assertThat(res.results().get(1).value()).isNull();
        assertThat(res.results().get(2).ok()).isTrue();
    }

    /** A failed line never carries a value, whatever the device attached. */
    @Test
    void aFailedLineIsStrippedOfAnyValue() {
        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(
                "{\"id\":\"a\",\"ok\":false,\"raw\":0,\"value\":0,\"registers\":[0],"
                        + "\"error_code\":\"no_answer\",\"message\":\"Das Gerät antwortet nicht.\"}")));

        ProbeResult.OpResult line = get(f).results().get(0);
        assertThat(line.ok()).isFalse();
        assertThat(line.raw()).isNull();
        assertThat(line.value()).isNull();
        assertThat(line.registers()).isNull();
        assertThat(line.errorCode()).isEqualTo("no_answer");
        assertThat(line.message()).isNotBlank();
    }

    /**
     * The closed vocabulary: a word we do not understand must not become a
     * sentence (the sibling listeners' rule). Here it additionally stops a
     * device from inventing a status the portal would then render.
     */
    @Test
    void anInventedErrorCodeIsDropped() {
        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(TENANT, SITE, DEVICE, REQ,
                "{\"id\":\"a\",\"ok\":false,\"error_code\":\"kaputt\",\"message\":\"…\"}",
                ",\"error_code\":\"auch_kaputt\"")));

        ProbeResult res = get(f);
        assertThat(res.errorCode()).as("a whole-request code must be known too").isNull();
        assertThat(res.results().get(0).errorCode()).isNull();
        // The German sentence survives - it is the device's own honest text and
        // carries no claim the portal keys on.
        assertThat(res.results().get(0).message()).isNotBlank();
    }

    @Test
    void aWholeRequestRefusalIsCarriedThroughWithAnEmptyResultList() {
        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(TENANT, SITE, DEVICE, REQ,
                "", ",\"error_code\":\"rate_limited\",\"message\":\"Zu viele Prüfungen.\"")));

        ProbeResult res = get(f);
        assertThat(res.errorCode()).isEqualTo("rate_limited");
        assertThat(res.message()).isEqualTo("Zu viele Prüfungen.");
        assertThat(res.results()).isEmpty();
    }

    /** Bounds: a device cannot flood the portal through this channel. */
    @Test
    void theAnswerIsBounded() {
        StringBuilder many = new StringBuilder();
        for (int i = 0; i < 40; i++) {
            many.append(i == 0 ? "" : ",")
                    .append("{\"id\":\"o").append(i).append("\",\"ok\":false}");
        }
        String longMessage = "x".repeat(5000);

        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(TENANT, SITE, DEVICE, REQ,
                many.toString(), ",\"message\":\"" + longMessage + "\"")));

        ProbeResult res = get(f);
        assertThat(res.results()).hasSizeLessThanOrEqualTo(8);
        assertThat(res.message()).hasSizeLessThanOrEqualTo(400);
    }

    /** A register word outside 16 bit is not a register word - report none. */
    @Test
    void nonsenseRegisterWordsAreOmittedRatherThanShown() {
        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(
                "{\"id\":\"a\",\"ok\":true,\"raw\":1,\"value\":1,\"registers\":[70000]}")));

        ProbeResult.OpResult line = get(f).results().get(0);
        assertThat(line.ok()).isTrue();
        assertThat(line.registers()).isNull();
    }
}
