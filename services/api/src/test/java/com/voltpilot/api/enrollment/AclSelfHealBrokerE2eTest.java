package com.voltpilot.api.enrollment;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.UUID;
import org.eclipse.paho.client.mqttv3.IMqttToken;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.images.builder.Transferable;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * The MISSING LINK for the 2026-07-08 ACL self-heal (PR #100 + this hardening):
 * an END-TO-END proof against a REAL EMQX 5.8.3 that
 * {@code AclGrantWriter.normalizeInPlace()} + {@code BrokerAuthzReloader}
 * (exactly the two steps {@link EnrollmentService#selfHealBrokerAclOnStartup()}
 * runs on boot) actually restore a broker-DENIED device to ALLOWED - file
 * normalize -&gt; EMQX re-read over REST -&gt; the device's SUBSCRIBE is permitted.
 *
 * <p>Prior tests only asserted the acl.conf TEXT after a heal; twice a "fix"
 * passed those and still failed in prod because the running EMQX kept its old
 * compiled rules (a plain {@code emqx ctl conf reload} does NOT re-read the
 * file - only the {@code emqx_authz:update({replace, file}, ...)} that the REST
 * {@code PUT /authorization/sources/file} triggers does). This test reproduces
 * the captain's exact incident shape and proves the whole chain on a live broker.
 *
 * <p><strong>Reproduction fidelity.</strong> EMQX boots with a CORRUPTED
 * acl.conf in the incident shape: the seed device's grant sits correctly inside
 * the generated region (so sim/demo kept working), but the captain's device
 * grant was written BELOW the UUID default-deny (unreachable -&gt; denied -&gt;
 * kicked -&gt; reconnect loop) and the whole template tail is DUPLICATED. We then
 * run the api's self-heal path and re-check the broker's authorization decision
 * with a real MQTT SUBSCRIBE.
 *
 * <p>The broker matches authorization on the MQTT username; on the prod mTLS
 * 8883 listener that username IS the cert CN (device_id, via
 * {@code peer_cert_as_username=cn}). Here we drive the SAME file authorizer over
 * plaintext 1883 with the username set to the device_id - identical authz
 * decision, no mTLS scaffolding needed. {@code deny_action=ignore} makes a
 * denied SUBSCRIBE return SUBACK 0x80 (128) deterministically instead of the
 * connection drop the prod {@code deny_action=disconnect} turns it into (that
 * drop is exactly the "kicked off the broker / reconnect loop" the captain saw).
 */
@Testcontainers(disabledWithoutDocker = true)
class AclSelfHealBrokerE2eTest {

    // The captain's live incident identities (2026-07-08), padded to full UUIDs.
    private static final String TENANT = "f82379ed-0000-0000-0000-000000000001";
    private static final String SITE = "3c88a87b-0000-0000-0000-000000000002";
    private static final String BROKEN_DEVICE = "cdba2ee8-0000-0000-0000-000000000003";
    // The dev-seed device whose grant sat correctly in-region (sim/demo worked).
    private static final String SEED_TENANT = "00000000-0000-0000-0000-000000000001";
    private static final String SEED_SITE = "00000000-0000-0000-0000-000000000002";
    private static final String SEED_DEVICE = "00000000-0000-0000-0000-000000000009";

    private static final String DASH_USER = "admin";
    private static final String DASH_PASS = "public12345";
    private static final String ACL_PATH_IN_BROKER = "/opt/emqx/etc/vp-acl.conf";

    private static final int DENIED = 128; // SUBACK 0x80

    @Container
    static final GenericContainer<?> EMQX = new GenericContainer<>(DockerImageName.parse("emqx/emqx:5.8.3"))
            .withExposedPorts(1883, 18083)
            // Boot with the CORRUPTED acl.conf so EMQX compiles the broken,
            // device-denying rules exactly as it did on the captain's VM.
            .withCopyToContainer(Transferable.of(corruptedAcl().getBytes(StandardCharsets.UTF_8)),
                    ACL_PATH_IN_BROKER)
            .withEnv("EMQX_AUTHORIZATION__SOURCES",
                    "[{type = file, enable = true, path = \"" + ACL_PATH_IN_BROKER + "\"}]")
            .withEnv("EMQX_AUTHORIZATION__NO_MATCH", "deny")
            // Return SUBACK 0x80 on a denied subscribe (deterministic to assert);
            // prod uses `disconnect`, which turns the same denial into the kick.
            .withEnv("EMQX_AUTHORIZATION__DENY_ACTION", "ignore")
            .withEnv("EMQX_DASHBOARD__DEFAULT_USERNAME", DASH_USER)
            .withEnv("EMQX_DASHBOARD__DEFAULT_PASSWORD", DASH_PASS)
            .waitingFor(Wait.forLogMessage(".*is running now.*", 1)
                    .withStartupTimeout(Duration.ofMinutes(2)));

    @TempDir
    Path dir;

    @Test
    void selfHealPlusReloadFlipsABrokerDeniedDeviceToAllowedOnARunningEmqx() throws Exception {
        String broker = "tcp://" + EMQX.getHost() + ":" + EMQX.getMappedPort(1883);
        String restUrl = "http://" + EMQX.getHost() + ":" + EMQX.getMappedPort(18083) + "/api/v5";
        String brokenScheduleTopic = "ems/" + TENANT + "/" + SITE + "/" + BROKEN_DEVICE + "/schedule";
        String seedScheduleTopic =
                "ems/" + SEED_TENANT + "/" + SEED_SITE + "/" + SEED_DEVICE + "/schedule";

        // --- (a) BEFORE: the incident is real on a live broker ----------------
        // The captain's device is DENIED subscribing to its own schedule topic
        // (grant below the default-deny), while the in-region seed device is fine.
        assertThat(subscribeGrantedQos(broker, BROKEN_DEVICE, brokenScheduleTopic))
                .as("captain's device denied before self-heal (grant below the default-deny)")
                .isEqualTo(DENIED);
        assertThat(subscribeGrantedQos(broker, SEED_DEVICE, seedScheduleTopic))
                .as("in-region seed device allowed before self-heal (sim/demo kept working)")
                .isEqualTo(1);

        // --- (b) the api's self-heal path, byte-for-byte the @PostConstruct -----
        // Write the SAME corrupted file the api would find on its rw mount, then
        // run exactly what EnrollmentService.selfHealBrokerAclOnStartup() runs:
        //   1. AclGrantWriter.normalizeInPlace()  (fix the file on disk)
        //   2. BrokerAuthzReloader.reloadNowBlocking(...) (force EMQX to re-read)
        Path aclFile = dir.resolve("acl.conf");
        Files.writeString(aclFile, corruptedAcl(), StandardCharsets.UTF_8);

        AclGrantWriter.NormalizeResult heal = new AclGrantWriter(aclFile).normalizeInPlace();
        assertThat(heal.healed()).as("the corrupted file was actually healed").isTrue();
        assertThat(heal.grantsMovedAboveDeny())
                .as("the below-the-deny grant was moved into the region").isGreaterThanOrEqualTo(1);

        BrokerAuthzReloader reloader = new BrokerAuthzReloader(aclFile.toString(), restUrl, "", "",
                DASH_USER, DASH_PASS, Duration.ofSeconds(5), Duration.ofMillis(0));
        try {
            boolean reloaded = reloader.reloadNowBlocking(5, Duration.ofMillis(500));
            assertThat(reloaded).as("EMQX accepted the authz reload over REST").isTrue();
        } finally {
            reloader.close();
        }

        // --- (c) AFTER: the running broker re-read the healed file -------------
        // The captain's device is now ALLOWED to subscribe to its schedule topic,
        // WITHOUT a re-claim and WITHOUT restarting EMQX - purely the deploy-time
        // file heal + REST reload. This is the end-to-end proof.
        assertThat(subscribeGrantedQosWithRetry(broker, BROKEN_DEVICE, brokenScheduleTopic, 1))
                .as("captain's device allowed after self-heal + reload (no re-claim, no restart)")
                .isEqualTo(1);
        assertThat(subscribeGrantedQos(broker, SEED_DEVICE, seedScheduleTopic))
                .as("seed device still allowed after normalization").isEqualTo(1);
    }

    /**
     * Connect presenting {@code username} as its identity and SUBSCRIBE to
     * {@code topic}, returning the SUBACK granted QoS (128 == denied). Mirrors
     * how EMQX authorizes a real mTLS device (username := cert CN := device_id).
     */
    private int subscribeGrantedQos(String broker, String username, String topic) throws Exception {
        MqttClient client = new MqttClient(broker, "probe-" + UUID.randomUUID(), new MemoryPersistence());
        MqttConnectOptions opts = new MqttConnectOptions();
        opts.setCleanSession(true);
        opts.setUserName(username);
        opts.setConnectionTimeout(10);
        client.connect(opts);
        try {
            IMqttToken token = client.subscribeWithResponse(topic, 1);
            int[] granted = token.getGrantedQos();
            return granted == null || granted.length == 0 ? -1 : granted[0];
        } finally {
            try {
                client.disconnect();
            } catch (Exception ignore) {
                // best-effort teardown
            }
            client.close();
        }
    }

    /** Re-probe until the authz decision reaches {@code expected} (EMQX recompiles fast). */
    private int subscribeGrantedQosWithRetry(String broker, String username, String topic,
            int expected) throws Exception {
        int last = -1;
        for (int i = 0; i < 20; i++) {
            last = subscribeGrantedQos(broker, username, topic);
            if (last == expected) {
                return last;
            }
            Thread.sleep(300);
        }
        return last;
    }

    /**
     * The captain's exact prod-down shape (2026-07-08): the seed grant correctly
     * in-region, the captain's device grant written BELOW the default-deny +
     * {@code {allow, all}} (unreachable), and the whole template tail DUPLICATED.
     */
    private static String corruptedAcl() {
        return ""
                + "{allow, {username, \"vp-internal\"}, all, [\"#\"]}.\n"
                + "%% --- Per-device grants (GENERATED - do not hand-edit). ---\n"
                + "%%<<BEGIN GENERATED DEVICE GRANTS>>\n"
                + grantBlock(SEED_TENANT, SEED_SITE, SEED_DEVICE)
                + "%%<<END GENERATED DEVICE GRANTS>>\n"
                + tail()
                + grantBlock(TENANT, SITE, BROKEN_DEVICE) // <-- unreachable: below the deny
                + "%%<<END GENERATED DEVICE GRANTS>>\n"
                + tail();                                  // <-- duplicated template tail
    }

    private static String tail() {
        return "%% --- Default-deny for devices. ---\n"
                + "{deny, {username, {re, \"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}"
                + "-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$\"}}, all, [\"#\"]}.\n"
                + "{deny, all, subscribe, [\"$SYS/#\"]}.\n"
                + "{allow, all}.\n";
    }

    /** The exact block shape AclGrantWriter/voltpilot-ca.sh emit, so it parses as a device grant. */
    private static String grantBlock(String tenant, String site, String device) {
        String base = "ems/" + tenant + "/" + site + "/" + device;
        return "%%<<device " + device + " tenant " + tenant + " site " + site + ">>\n"
                + "{allow, {username, \"" + device + "\"}, publish,   [\"" + base + "/telemetry\", \""
                + base + "/status\"]}.\n"
                + "{allow, {username, \"" + device + "\"}, subscribe, [\"" + base + "/schedule\", \""
                + base + "/command\", \"" + base + "/config\"]}.\n"
                + "{deny, {username, \"" + device + "\"}, publish,   [\"" + base
                + "/v2/measurement-config\"]}.\n"
                + "{deny, {username, \"" + device + "\"}, subscribe, [\"" + base
                + "/v2/measurement-config-status\", \"" + base + "/v2/measurement-samples\"]}.\n"
                + "{allow, {username, \"" + device + "\"}, publish,   [\"" + base + "/v2/#\"]}.\n"
                + "{allow, {username, \"" + device + "\"}, subscribe, [\"" + base + "/v2/#\"]}.\n"
                + "%%<<end device " + device + ">>\n";
    }
}
