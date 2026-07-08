package com.voltpilot.api.enrollment;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
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
 * End-to-end proof against REAL EMQX 5.8.3 of the 2026-07-08 DEFINITIVE ACL
 * self-heal (the residual outage: the captain's device stayed offline after
 * deploying #100/#101). Two live brokers, each proving one half of
 * {@link EnrollmentService#selfHealBrokerAclOnStartup()}:
 *
 * <ol>
 *   <li><strong>Regenerate a MISSING grant from the DB source of truth.</strong>
 *   The grant for device {@code cdba2ee8} was ENTIRELY ABSENT from the live
 *   acl.conf (a prior buggy rebuild dropped it) - so it could not be reordered or
 *   reloaded, only regenerated from what the api knows. Boot EMQX with the grant
 *   missing (device DENIED), run {@code regenerateGrants(truth)} +
 *   {@code reloadNowBlocking} (the two steps the boot runs), and the running
 *   broker ALLOWS the device.</li>
 *   <li><strong>ALWAYS reload, even when the file did not change.</strong> The
 *   residual bug: the reload fired only when the file changed, so a long-running
 *   EMQX holding STALE compiled rules over an already-canonical file was never
 *   reconciled. Boot EMQX STALE (device denied) while the api's on-disk file is
 *   ALREADY canonical+complete; {@code regenerateGrants} reports UNCHANGED yet the
 *   unconditional reload still flips the device to ALLOWED.</li>
 * </ol>
 *
 * <p>Uses TWO independent containers so neither test depends on the other's
 * broker state. Authorization is matched on the MQTT username (the cert CN =
 * device_id on the prod 8883 listener); driven here over 1883 with the username
 * set to the device_id - identical authz decision. {@code deny_action=ignore}
 * makes a denied SUBSCRIBE return SUBACK 0x80 deterministically.
 */
@Testcontainers(disabledWithoutDocker = true)
class AclRegenerateReloadBrokerE2eTest {

    private static final String TENANT = "f82379ed-0000-0000-0000-000000000001";
    private static final String SITE = "3c88a87b-0000-0000-0000-000000000002";
    private static final String BROKEN_DEVICE = "cdba2ee8-0000-0000-0000-000000000003";
    private static final String SEED_TENANT = "00000000-0000-0000-0000-000000000001";
    private static final String SEED_SITE = "00000000-0000-0000-0000-000000000002";
    private static final String SEED_DEVICE = "00000000-0000-0000-0000-000000000009";

    private static final String DASH_USER = "admin";
    private static final String DASH_PASS = "public12345";
    private static final String ACL_PATH_IN_BROKER = "/opt/emqx/etc/vp-acl.conf";
    private static final int DENIED = 128; // SUBACK 0x80

    /** Boots with cdba2ee8's grant MISSING -> the device is denied until regenerated. */
    @Container
    static final GenericContainer<?> BROKER_MISSING = emqxBootedWith(aclMissingBrokenGrant());

    /** Boots STALE (grant missing) too; the api's on-disk file will be canonical+complete. */
    @Container
    static final GenericContainer<?> BROKER_STALE = emqxBootedWith(aclMissingBrokenGrant());

    @TempDir
    Path dir;

    @Test
    void regenerateFromTruthRestoresAMissingGrantAndTheRunningBrokerAllowsTheDevice()
            throws Exception {
        String broker = "tcp://" + BROKER_MISSING.getHost() + ":" + BROKER_MISSING.getMappedPort(1883);
        String restUrl = restUrl(BROKER_MISSING);

        // --- (a) BEFORE: the grant is absent -> the device is denied -----------
        assertThat(subscribeGrantedQos(broker, BROKEN_DEVICE, scheduleTopic(TENANT, SITE, BROKEN_DEVICE)))
                .as("device denied - its grant is entirely missing from the ACL").isEqualTo(DENIED);
        assertThat(subscribeGrantedQos(broker, SEED_DEVICE, scheduleTopic(SEED_TENANT, SEED_SITE, SEED_DEVICE)))
                .as("seed device allowed (its grant is present)").isEqualTo(1);

        // --- (b) regenerate from the DB source of truth + reload ---------------
        // The api's on-disk file mirrors the broker's: cdba2ee8 missing. Boot
        // regenerates it from what the api KNOWS (the enrolled-device list), then
        // reloads. This is the fix a reorder-only heal could never do.
        Path aclFile = dir.resolve("acl.conf");
        Files.writeString(aclFile, aclMissingBrokenGrant(), StandardCharsets.UTF_8);

        AclGrantWriter.RegenerateResult r = new AclGrantWriter(aclFile).regenerateGrants(truth());
        assertThat(r.changed()).as("the missing grant was regenerated into the file").isTrue();
        assertThat(r.restoredFromTruth()).as("cdba2ee8 restored from truth").isGreaterThanOrEqualTo(1);
        assertThat(Files.readString(aclFile)).contains("%%<<device " + BROKEN_DEVICE + " ");

        reload(aclFile, restUrl);

        // --- (c) AFTER: the running broker now allows the device ---------------
        assertThat(subscribeGrantedQosWithRetry(broker, BROKEN_DEVICE,
                scheduleTopic(TENANT, SITE, BROKEN_DEVICE), 1))
                .as("device allowed after regenerate+reload (no re-claim, no restart)").isEqualTo(1);
        assertThat(subscribeGrantedQos(broker, SEED_DEVICE, scheduleTopic(SEED_TENANT, SEED_SITE, SEED_DEVICE)))
                .as("seed device still allowed").isEqualTo(1);
    }

    @Test
    void alwaysReloadReconcilesAStaleBrokerEvenWhenTheOnDiskFileIsAlreadyCanonical()
            throws Exception {
        String broker = "tcp://" + BROKER_STALE.getHost() + ":" + BROKER_STALE.getMappedPort(1883);
        String restUrl = restUrl(BROKER_STALE);

        // --- (a) BEFORE: broker STALE (booted without the grant) -> denied ------
        assertThat(subscribeGrantedQos(broker, BROKEN_DEVICE, scheduleTopic(TENANT, SITE, BROKEN_DEVICE)))
                .as("device denied - the RUNNING broker holds stale rules without the grant")
                .isEqualTo(DENIED);

        // --- (b) the api's file is ALREADY canonical+complete ------------------
        // (an earlier boot fixed the file, but the long-running broker never
        // re-read it). Regenerate reports UNCHANGED - the file is NOT rewritten...
        Path aclFile = dir.resolve("acl.conf");
        Files.writeString(aclFile, aclWithBrokenGrant(), StandardCharsets.UTF_8);
        String before = Files.readString(aclFile);

        AclGrantWriter.RegenerateResult r = new AclGrantWriter(aclFile).regenerateGrants(truth());
        assertThat(r.changed()).as("already canonical+complete -> no file change").isFalse();
        assertThat(Files.readString(aclFile)).as("file byte-unchanged").isEqualTo(before);

        // ...yet the reload still runs (this is the residual-bug fix) and flips
        // the stale broker to enforce the file it already had on disk.
        reload(aclFile, restUrl);

        // --- (c) AFTER: the running broker re-read the canonical file ----------
        assertThat(subscribeGrantedQosWithRetry(broker, BROKEN_DEVICE,
                scheduleTopic(TENANT, SITE, BROKEN_DEVICE), 1))
                .as("device allowed after the unconditional reload of an unchanged file").isEqualTo(1);
    }

    // --- broker steps ------------------------------------------------------

    private void reload(Path aclFile, String restUrl) throws Exception {
        BrokerAuthzReloader reloader = new BrokerAuthzReloader(aclFile.toString(), restUrl, "", "",
                DASH_USER, DASH_PASS, Duration.ofSeconds(5), Duration.ofMillis(0));
        try {
            assertThat(reloader.reloadNowBlocking(5, Duration.ofMillis(500)))
                    .as("EMQX accepted the authz reload over REST").isTrue();
        } finally {
            reloader.close();
        }
    }

    private static List<AclGrantWriter.DeviceGrant> truth() {
        return List.of(
                new AclGrantWriter.DeviceGrant(UUID.fromString(SEED_TENANT),
                        UUID.fromString(SEED_SITE), UUID.fromString(SEED_DEVICE)),
                new AclGrantWriter.DeviceGrant(UUID.fromString(TENANT),
                        UUID.fromString(SITE), UUID.fromString(BROKEN_DEVICE)));
    }

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

    // --- fixtures ----------------------------------------------------------

    private static GenericContainer<?> emqxBootedWith(String acl) {
        return new GenericContainer<>(DockerImageName.parse("emqx/emqx:5.8.3"))
                .withExposedPorts(1883, 18083)
                .withCopyToContainer(Transferable.of(acl.getBytes(StandardCharsets.UTF_8)),
                        ACL_PATH_IN_BROKER)
                .withEnv("EMQX_AUTHORIZATION__SOURCES",
                        "[{type = file, enable = true, path = \"" + ACL_PATH_IN_BROKER + "\"}]")
                .withEnv("EMQX_AUTHORIZATION__NO_MATCH", "deny")
                .withEnv("EMQX_AUTHORIZATION__DENY_ACTION", "ignore")
                .withEnv("EMQX_DASHBOARD__DEFAULT_USERNAME", DASH_USER)
                .withEnv("EMQX_DASHBOARD__DEFAULT_PASSWORD", DASH_PASS)
                .waitingFor(Wait.forLogMessage(".*is running now.*", 1)
                        .withStartupTimeout(Duration.ofMinutes(2)));
    }

    private static String restUrl(GenericContainer<?> c) {
        return "http://" + c.getHost() + ":" + c.getMappedPort(18083) + "/api/v5";
    }

    private static String scheduleTopic(String tenant, String site, String device) {
        return "ems/" + tenant + "/" + site + "/" + device + "/schedule";
    }

    /** Canonical ACL with the seed grant only - cdba2ee8's grant is ABSENT (denied). */
    private static String aclMissingBrokenGrant() {
        return "{allow, {username, \"vp-internal\"}, all, [\"#\"]}.\n"
                + "%%<<BEGIN GENERATED DEVICE GRANTS>>\n"
                + grantBlock(SEED_TENANT, SEED_SITE, SEED_DEVICE)
                + "%%<<END GENERATED DEVICE GRANTS>>\n"
                + tail();
    }

    /** Canonical+complete ACL: BOTH the seed and cdba2ee8 grants, correctly placed. */
    private static String aclWithBrokenGrant() {
        return "{allow, {username, \"vp-internal\"}, all, [\"#\"]}.\n"
                + "%%<<BEGIN GENERATED DEVICE GRANTS>>\n"
                + grantBlock(SEED_TENANT, SEED_SITE, SEED_DEVICE)
                + grantBlock(TENANT, SITE, BROKEN_DEVICE)
                + "%%<<END GENERATED DEVICE GRANTS>>\n"
                + tail();
    }

    private static String tail() {
        return "%% --- Default-deny for devices. ---\n"
                + "{deny, {username, {re, \"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}"
                + "-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$\"}}, all, [\"#\"]}.\n"
                + "{deny, all, subscribe, [\"$SYS/#\"]}.\n"
                + "{allow, all}.\n";
    }

    private static String grantBlock(String tenant, String site, String device) {
        String base = "ems/" + tenant + "/" + site + "/" + device;
        return "%%<<device " + device + " tenant " + tenant + " site " + site + ">>\n"
                + "{allow, {username, \"" + device + "\"}, publish,   [\"" + base + "/telemetry\", \""
                + base + "/status\"]}.\n"
                + "{allow, {username, \"" + device + "\"}, subscribe, [\"" + base + "/schedule\", \""
                + base + "/command\", \"" + base + "/config\"]}.\n"
                + "%%<<end device " + device + ">>\n";
    }
}
