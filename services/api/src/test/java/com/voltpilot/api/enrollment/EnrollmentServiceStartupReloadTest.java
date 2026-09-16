package com.voltpilot.api.enrollment;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.voltpilot.api.enrollment.EnrollmentDeviceLookup.DeviceIdentity;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.ObjectProvider;

/**
 * Wiring proof for the 2026-07-08 definitive ACL self-heal fix, covering both
 * incident layers with a mocked broker + mocked DB (the real-EMQX proof is
 * {@link AclSelfHealBrokerE2eTest}):
 *
 * <ol>
 *   <li><strong>Regenerate from the DB source of truth.</strong> The captain's
 *   device {@code cdba2ee8}'s grant was ENTIRELY ABSENT from the live acl.conf (a
 *   prior buggy rebuild dropped it), so reorder-and-reload could not help - you
 *   cannot reload a grant that is not in the file.
 *   {@link EnrollmentService#selfHealBrokerAclOnStartup()} now rebuilds the grant
 *   region from {@link EnrollmentDeviceLookup#allEnrolledDeviceIdentities()},
 *   restoring the dropped grant.</li>
 *   <li><strong>Always reload.</strong> The earlier gap: the reload fired only
 *   when the file changed, so a long-running EMQX holding STALE rules over an
 *   already-canonical file was never reconciled. The reload now runs on every
 *   boot.</li>
 * </ol>
 */
class EnrollmentServiceStartupReloadTest {

    private static final UUID TENANT = UUID.fromString("f82379ed-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("3c88a87b-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("cdba2ee8-0000-0000-0000-000000000003");

    @TempDir
    Path dir;

    @Test
    void regeneratesADroppedGrantFromTheDbSourceOfTruthThenReloads() throws Exception {
        // The live-VM shape: structure intact, the device grant ENTIRELY ABSENT.
        Path acl = writeAclWithoutDeviceGrant();
        BrokerAuthzReloader reloader = mockReloader(true);

        newService(acl, reloader, List.of(new DeviceIdentity(TENANT, SITE, DEVICE)))
                .selfHealBrokerAclOnStartup();

        // The dropped grant is RESTORED from truth (present + above the deny)...
        String content = Files.readString(acl);
        assertThat(content).as("dropped grant regenerated from the DB")
                .contains("%%<<device " + DEVICE + " ");
        assertThat(grantIsAboveDefaultDeny(acl, DEVICE)).as("restored grant is reachable").isTrue();
        // ...and EMQX is reloaded so the running broker enforces it.
        verify(reloader, times(1)).reloadNowBlocking(anyInt(), any());
    }

    @Test
    void alwaysReloadsWhenTheFileIsAlreadyCanonicalAndComplete() throws Exception {
        // File already contains the DB device's grant, correctly placed -> no
        // rewrite, but the running broker may still be stale -> reload REGARDLESS.
        Path acl = writeAclWithDeviceGrant();
        String before = Files.readString(acl);
        BrokerAuthzReloader reloader = mockReloader(true);

        newService(acl, reloader, List.of(new DeviceIdentity(TENANT, SITE, DEVICE)))
                .selfHealBrokerAclOnStartup();

        assertThat(Files.readString(acl)).as("canonical+complete file left byte-unchanged")
                .isEqualTo(before);
        verify(reloader, times(1)).reloadNowBlocking(anyInt(), any());
    }

    @Test
    void fixesAMisorderedGrantAndReloads() throws Exception {
        Path acl = writeAclWithGrantBelowDeny();
        BrokerAuthzReloader reloader = mockReloader(true);

        newService(acl, reloader, List.of(new DeviceIdentity(TENANT, SITE, DEVICE)))
                .selfHealBrokerAclOnStartup();

        assertThat(grantIsAboveDefaultDeny(acl, DEVICE)).as("misordered grant moved up").isTrue();
        verify(reloader, times(1)).reloadNowBlocking(anyInt(), any());
    }

    @Test
    void fallsBackToCanonicalizeAndStillReloadsWhenTheDbIsUnreachable() throws Exception {
        Path acl = writeAclWithGrantBelowDeny();
        BrokerAuthzReloader reloader = mockReloader(true);
        EnrollmentDeviceLookup devices = mock(EnrollmentDeviceLookup.class);
        when(devices.allEnrolledDeviceIdentities()).thenThrow(new RuntimeException("db down"));

        newService(acl, reloader, devices).selfHealBrokerAclOnStartup();

        // No restore possible, but ordering is still fixed and the broker reloaded.
        assertThat(grantIsAboveDefaultDeny(acl, DEVICE)).as("ordering still fixed").isTrue();
        verify(reloader, times(1)).reloadNowBlocking(anyInt(), any());
    }

    @Test
    void doesNotReloadWhenTheFileHasNoRegionAnchors() throws Exception {
        Path acl = dir.resolve("acl.conf");
        Files.writeString(acl, "{allow, all}.\n", StandardCharsets.UTF_8);
        BrokerAuthzReloader reloader = mock(BrokerAuthzReloader.class);

        newService(acl, reloader, List.of(new DeviceIdentity(TENANT, SITE, DEVICE)))
                .selfHealBrokerAclOnStartup();

        verifyNoInteractions(reloader);
    }

    @Test
    void neverCrashesTheBootWhenTheBrokerRejectsTheReload() throws Exception {
        Path acl = writeAclWithDeviceGrant();
        BrokerAuthzReloader reloader = mockReloader(false); // broker unreachable

        newService(acl, reloader, List.of(new DeviceIdentity(TENANT, SITE, DEVICE)))
                .selfHealBrokerAclOnStartup();

        verify(reloader, times(1)).reloadNowBlocking(anyInt(), any());
    }

    @Test
    void doesNotThrowWhenNoReloaderIsConfigured() throws Exception {
        Path acl = writeAclWithDeviceGrant();
        newService(acl, null, List.of(new DeviceIdentity(TENANT, SITE, DEVICE)))
                .selfHealBrokerAclOnStartup();
        // No exception; the actionable log is the only effect.
    }

    @Test
    void successionRemovesGrantAndRequiresConfirmedBrokerReload() throws Exception {
        Path acl = writeAclWithDeviceGrant();
        BrokerAuthzReloader reloader = mockReloader(true);
        EnrollmentService service = newService(acl, reloader, List.of());
        assertThat(service.blockSucceededDevice("test-ref", DEVICE)).isTrue();
        assertThat(Files.readString(acl)).doesNotContain(DEVICE.toString());
        verify(reloader).reloadNowBlocking(1, java.time.Duration.ZERO);
    }

    @Test
    void successionRemainsPendingWithoutConfirmedReload() throws Exception {
        Path acl = writeAclWithDeviceGrant();
        assertThat(newService(acl, mockReloader(false), List.of())
                .blockSucceededDevice("test-ref", DEVICE)).isFalse();
        assertThat(Files.readString(acl)).doesNotContain(DEVICE.toString());
        assertThat(newService(acl, null, List.of()).blockSucceededDevice("test-ref", DEVICE)).isFalse();
    }

    // --- helpers -----------------------------------------------------------

    private EnrollmentService newService(Path acl, BrokerAuthzReloader reloader,
            List<DeviceIdentity> enrolled) {
        EnrollmentDeviceLookup devices = mock(EnrollmentDeviceLookup.class);
        when(devices.allEnrolledDeviceIdentities()).thenReturn(enrolled);
        return newService(acl, reloader, devices);
    }

    private EnrollmentService newService(Path acl, BrokerAuthzReloader reloader,
            EnrollmentDeviceLookup devices) {
        EnrollmentProperties props = new EnrollmentProperties(true, dir.resolve("ca").toString(),
                acl.toString(), "mqtt.example", 8883, 825, 20_480);
        return new EnrollmentService(props, mock(EnrollmentRepository.class), devices,
                providerOf(reloader));
    }

    private static BrokerAuthzReloader mockReloader(boolean accepted) {
        BrokerAuthzReloader reloader = mock(BrokerAuthzReloader.class);
        when(reloader.reloadNowBlocking(anyInt(), any())).thenReturn(accepted);
        return reloader;
    }

    /** A minimal {@link ObjectProvider} exposing only the {@code getIfAvailable()} the self-heal uses. */
    private static ObjectProvider<BrokerAuthzReloader> providerOf(BrokerAuthzReloader instance) {
        @SuppressWarnings("unchecked")
        ObjectProvider<BrokerAuthzReloader> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(instance);
        return provider;
    }

    private Path writeAclWithDeviceGrant() throws Exception {
        Path acl = dir.resolve("acl.conf");
        Files.writeString(acl, preamble() + grantBlock(DEVICE) + endAndTail(), StandardCharsets.UTF_8);
        // Sanity: this shape must be already-canonical for the device.
        assertThat(new AclGrantWriter(acl).regenerateGrants(
                List.of(new AclGrantWriter.DeviceGrant(TENANT, SITE, DEVICE))).changed())
                .as("fixture must already be canonical+complete").isFalse();
        return acl;
    }

    private Path writeAclWithoutDeviceGrant() throws Exception {
        Path acl = dir.resolve("acl.conf");
        Files.writeString(acl, preamble() + endAndTail(), StandardCharsets.UTF_8);
        return acl;
    }

    private Path writeAclWithGrantBelowDeny() throws Exception {
        Path acl = dir.resolve("acl.conf");
        // The captain's original incident: grant BELOW the default-deny +
        // duplicated tail -> unreachable.
        Files.writeString(acl, preamble() + endAndTail() + grantBlock(DEVICE)
                + "%%<<END GENERATED DEVICE GRANTS>>\n" + tail(), StandardCharsets.UTF_8);
        return acl;
    }

    private static String preamble() {
        return "{allow, {username, \"vp-internal\"}, all, [\"#\"]}.\n"
                + "%% --- Per-device grants (GENERATED - do not hand-edit). ---\n"
                + "%%<<BEGIN GENERATED DEVICE GRANTS>>\n";
    }

    private static String endAndTail() {
        return "%%<<END GENERATED DEVICE GRANTS>>\n" + tail();
    }

    private static String tail() {
        return "%% --- Default-deny for devices. ---\n"
                + "{deny, {username, {re, \"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}"
                + "-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$\"}}, all, [\"#\"]}.\n"
                + "{deny, all, subscribe, [\"$SYS/#\"]}.\n"
                + "{allow, all}.\n";
    }

    private static String grantBlock(UUID device) {
        String base = "ems/" + TENANT + "/" + SITE + "/" + device;
        return "%%<<device " + device + " tenant " + TENANT + " site " + SITE + ">>\n"
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

    /** True when the device's last {@code allow} rule sits above the first default-deny line. */
    private static boolean grantIsAboveDefaultDeny(Path acl, UUID device) throws Exception {
        List<String> lines = Files.readAllLines(acl);
        int deny = -1;
        int lastAllow = -1;
        for (int i = 0; i < lines.size(); i++) {
            String l = lines.get(i);
            if (deny < 0 && l.trim().startsWith("{deny, {username, {re,")) {
                deny = i;
            }
            if (l.contains("{allow, {username, \"" + device + "\"}")) {
                lastAllow = i;
            }
        }
        return lastAllow >= 0 && deny >= 0 && lastAllow < deny;
    }
}
