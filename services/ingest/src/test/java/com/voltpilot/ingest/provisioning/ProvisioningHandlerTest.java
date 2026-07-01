package com.voltpilot.ingest.provisioning;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Unit tests (no broker, no DB, always run) for the provisioning resolver:
 * claimed ref -> retained config with the contract shape; unclaimed ref -> no
 * answer; malformed/mismatched hellos are dropped without ever throwing.
 */
class ProvisioningHandlerTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");

    private final ObjectMapper mapper = new ObjectMapper();
    private final List<Map.Entry<String, String>> published = new ArrayList<>();

    private ProvisioningHandler handler(Map<String, DeviceDirectory.DeviceIdentity> claimed) {
        DeviceDirectory directory = ref -> Optional.ofNullable(claimed.get(ref));
        return new ProvisioningHandler(directory,
                (topic, payload) -> published.add(Map.entry(topic, payload)), mapper);
    }

    private static String hello(String ref) {
        return "{\"schema_version\":\"1.0\",\"ref\":\"" + ref + "\"}";
    }

    @Test
    void claimedRefGetsContractShapedConfig() throws Exception {
        var handler = handler(Map.of("edge-42",
                new DeviceDirectory.DeviceIdentity(TENANT, SITE, DEVICE)));

        handler.onHello("provision/edge-42/hello", hello("edge-42"));

        assertThat(published).hasSize(1);
        assertThat(published.get(0).getKey()).isEqualTo("provision/edge-42/config");
        JsonNode config = mapper.readTree(published.get(0).getValue());
        assertThat(config.get("schema_version").asText()).isEqualTo("1.0");
        assertThat(config.get("ref").asText()).isEqualTo("edge-42");
        assertThat(config.get("tenant_id").asText()).isEqualTo(TENANT.toString());
        assertThat(config.get("site_id").asText()).isEqualTo(SITE.toString());
        assertThat(config.get("device_id").asText()).isEqualTo(DEVICE.toString());
        // additionalProperties: false in the contract - exactly these five keys.
        assertThat(config.size()).isEqualTo(5);
    }

    @Test
    void unclaimedRefGetsNoAnswer() {
        handler(Map.of()).onHello("provision/never-claimed/hello", hello("never-claimed"));
        assertThat(published).isEmpty();
    }

    @Test
    void payloadRefMustMatchTopicRef() {
        var handler = handler(Map.of("edge-42",
                new DeviceDirectory.DeviceIdentity(TENANT, SITE, DEVICE)));
        handler.onHello("provision/edge-42/hello", hello("someone-else"));
        assertThat(published).isEmpty();
    }

    @Test
    void malformedHellosAreDroppedNotThrown() {
        var handler = handler(Map.of("edge-42",
                new DeviceDirectory.DeviceIdentity(TENANT, SITE, DEVICE)));
        handler.onHello("provision/edge-42/hello", "not json at all");
        handler.onHello("provision/edge-42/hello", "[1,2,3]");
        handler.onHello("provision/edge-42/hello",
                "{\"schema_version\":\"9.9\",\"ref\":\"edge-42\"}");
        handler.onHello("ems/some/other/topic/hello", hello("edge-42"));
        assertThat(published).isEmpty();
    }

    @Test
    void refsWithTopicMetacharactersAreRejected() {
        var handler = handler(Map.of());
        handler.onHello("provision/bad+ref/hello", hello("bad+ref"));
        handler.onHello("provision/#/hello", hello("#"));
        assertThat(published).isEmpty();
    }

    @Test
    void directoryFailureIsSwallowedSoTheDeviceCanRetry() {
        DeviceDirectory failing = ref -> {
            throw new IllegalStateException("db down");
        };
        var handler = new ProvisioningHandler(failing,
                (topic, payload) -> published.add(Map.entry(topic, payload)), mapper);
        handler.onHello("provision/edge-42/hello", hello("edge-42"));
        assertThat(published).isEmpty();
    }
}
