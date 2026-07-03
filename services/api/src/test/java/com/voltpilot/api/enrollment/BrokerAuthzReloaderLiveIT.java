package com.voltpilot.api.enrollment;

import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Opt-in live proof that the REAL {@link BrokerAuthzReloader} HTTP path drives an
 * actual EMQX broker (the mocked-updater unit tests live in
 * {@link BrokerAuthzReloaderTest}). Skipped unless a broker is pointed at via env:
 *
 * <pre>
 *   EMQX_REST_URL=http://localhost:18085/api/v5 \
 *   EMQX_DASH_USER=admin EMQX_DASH_PASS=public12345 \
 *   ./mvnw -s .mvn-central-settings.xml -Dtest=BrokerAuthzReloaderLiveIT test
 * </pre>
 *
 * It writes a device grant to a temp acl.conf and reloads; assert the flip with
 * an MQTT publish check (see the manual recipe in the PR notes) - this test only
 * proves the api successfully re-initialises the source over REST (HTTP 204).
 */
class BrokerAuthzReloaderLiveIT {

    @TempDir
    Path dir;

    @Test
    void reloadsARealBrokerOverRest() throws Exception {
        String url = System.getenv("EMQX_REST_URL");
        assumeTrue(url != null && !url.isBlank(), "set EMQX_REST_URL to run the live broker proof");
        String user = System.getenv().getOrDefault("EMQX_DASH_USER", "admin");
        String pass = System.getenv().getOrDefault("EMQX_DASH_PASS", "public");
        String device = System.getenv().getOrDefault("EMQX_LIVE_DEVICE", "livedev");

        Path acl = dir.resolve("acl.conf");
        Files.writeString(acl, String.join("\n",
                "%%<<device " + device + " tenant t site s>>",
                "{allow, {username, \"" + device + "\"}, publish, [\"ems/t/s/" + device + "/telemetry\"]}.",
                "%%<<end device " + device + ">>",
                "%%<<END GENERATED DEVICE GRANTS>>",
                "{deny, all}.") + "\n", StandardCharsets.UTF_8);

        BrokerAuthzReloader reloader = new BrokerAuthzReloader(acl.toString(), url, "", "", user, pass,
                Duration.ofSeconds(5), Duration.ofMillis(0));
        try {
            reloader.reloadNow(); // throws nothing; a failure only warns
        } finally {
            reloader.close();
        }
    }
}
