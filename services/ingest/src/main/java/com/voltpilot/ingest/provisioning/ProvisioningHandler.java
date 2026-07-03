package com.voltpilot.ingest.provisioning;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Locale;
import java.util.Optional;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The zero-touch provisioning resolver (cloud side of
 * docs/contracts/mqtt-provisioning.schema.json). For each device hello on
 * {@code provision/{ref}/hello} it looks the ref up among claimed devices and,
 * when found, publishes the identity RETAINED to {@code provision/{ref}/config}.
 *
 * <p>Semantics (mirrored in the contract's {@code x-semantics}):
 * <ul>
 *   <li><b>Unclaimed ref:</b> no answer - the device keeps retrying hello.</li>
 *   <li><b>Claim-later:</b> the portal api additionally publishes the retained
 *       config at claim time, so a waiting device converges without a retry;
 *       this resolver is the guarantee when that publish was missed.</li>
 *   <li><b>Re-provision:</b> the config is retained, so a restarted device gets
 *       its identity on subscribe; a fresh hello also re-publishes it.</li>
 * </ul>
 *
 * <p>Like telemetry ingest, malformed input is logged and skipped - a bad hello
 * can never crash the stream. Errors (e.g. DB down) are logged too; the device's
 * retry makes the handshake self-healing.
 */
public class ProvisioningHandler {

    /** Mirrors $defs/ref in the provisioning contract (MQTT-topic-safe refs). */
    static final Pattern REF = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
    private static final Pattern HELLO_TOPIC = Pattern.compile("^provision/([^/]+)/hello$");
    private static final String SCHEMA_VERSION = "1.0";

    private static final Logger log = LoggerFactory.getLogger(ProvisioningHandler.class);

    private final DeviceDirectory directory;
    private final RetainedConfigPublisher publisher;
    private final ObjectMapper mapper;

    public ProvisioningHandler(DeviceDirectory directory, RetainedConfigPublisher publisher,
            ObjectMapper mapper) {
        this.directory = directory;
        this.publisher = publisher;
        this.mapper = mapper;
    }

    /** Sink for the retained {@code provision/{ref}/config} publish. */
    @FunctionalInterface
    public interface RetainedConfigPublisher {
        void publishRetained(String topic, String payload) throws Exception;
    }

    /** Handle one hello message; never throws. */
    public void onHello(String topic, String payload) {
        var topicMatch = HELLO_TOPIC.matcher(topic);
        if (!topicMatch.matches()) {
            log.warn("Ignoring message on unexpected provisioning topic '{}'", topic);
            return;
        }
        String ref = topicMatch.group(1);
        if (!REF.matcher(ref).matches()) {
            log.warn("Ignoring hello with non-contract ref '{}'", ref);
            return;
        }
        if (!payloadValid(ref, payload)) {
            return;
        }

        // Look the ref up in its canonical form so a device that hello's under a
        // different case than the claim stored still resolves (a lowercase VP-
        // hello vs the uppercase-stored row - otherwise it stays silently
        // unprovisioned). The reply is still published on the ORIGINAL topic the
        // device subscribed to (MQTT topics are case-sensitive).
        final Optional<DeviceDirectory.DeviceIdentity> identity;
        try {
            identity = directory.findByRef(canonicalRef(ref));
        } catch (Exception e) {
            log.warn("Provisioning lookup for ref '{}' failed (device will retry): {}", ref, e.getMessage());
            return;
        }
        if (identity.isEmpty()) {
            // Normal pre-onboarding state: the ref simply is not claimed yet.
            log.debug("Hello for unclaimed ref '{}' - no answer", ref);
            return;
        }

        DeviceDirectory.DeviceIdentity id = identity.get();
        String config = configPayload(ref, id);
        try {
            publisher.publishRetained("provision/" + ref + "/config", config);
            log.info("Provisioned ref '{}' -> device {} (retained config published)", ref, id.deviceId());
        } catch (Exception e) {
            log.warn("Failed to publish provisioning config for ref '{}' (device will retry): {}",
                    ref, e.getMessage());
        }
    }

    private boolean payloadValid(String topicRef, String payload) {
        final JsonNode root;
        try {
            root = mapper.readTree(payload);
        } catch (Exception e) {
            log.warn("Ignoring non-JSON hello for ref '{}': {}", topicRef, e.getMessage());
            return false;
        }
        if (root == null || !root.isObject()) {
            log.warn("Ignoring non-object hello for ref '{}'", topicRef);
            return false;
        }
        String version = root.path("schema_version").asText(null);
        if (!SCHEMA_VERSION.equals(version)) {
            log.warn("Ignoring hello for ref '{}' with schema_version={}", topicRef, version);
            return false;
        }
        String payloadRef = root.path("ref").asText(null);
        if (!topicRef.equals(payloadRef)) {
            // Same rule as telemetry: the topic identity is authoritative and the
            // payload must agree - a device may not hello under another's topic.
            log.warn("Ignoring hello whose payload ref '{}' does not match topic ref '{}'",
                    payloadRef, topicRef);
            return false;
        }
        return true;
    }

    /**
     * Canonicalize a ref for the device lookup exactly as the claim path does
     * (DeviceController.canonicalExternalRef in services/api): sticker IDs are
     * stored uppercase and self-generated edge refs lowercase. Kept in lockstep
     * with that method - the two must agree or a hello silently misses its row.
     */
    static String canonicalRef(String ref) {
        if (ref.regionMatches(true, 0, "VP-", 0, 3)) {
            return ref.toUpperCase(Locale.ROOT);
        }
        if (ref.regionMatches(true, 0, "edge-", 0, 5)) {
            return ref.toLowerCase(Locale.ROOT);
        }
        return ref;
    }

    static String configPayload(String ref, DeviceDirectory.DeviceIdentity id) {
        // Shape per docs/contracts/mqtt-provisioning.schema.json ($defs/config).
        return "{\"schema_version\":\"1.0\",\"ref\":\"" + ref + "\",\"tenant_id\":\"" + id.tenantId()
                + "\",\"site_id\":\"" + id.siteId() + "\",\"device_id\":\"" + id.deviceId() + "\"}";
    }
}
