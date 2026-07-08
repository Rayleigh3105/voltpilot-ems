package com.voltpilot.api.enrollment;

import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;

/**
 * Makes a freshly written (or removed) per-device broker ACL grant take effect
 * on EMQX <em>immediately</em>, instead of waiting for the deploy-time reload or
 * the ops cron ({@code tools/pki/reload-broker-authz.sh}). That gap has bitten
 * twice: a just-claimed device is refused by the broker until an authz reload
 * runs, because EMQX's file authorizer compiles {@code acl.conf} once at source
 * init and does not re-read it on its own (verified on 5.8.3 - see the reload
 * script's header and docs/security-mqtt.md).
 *
 * <p><strong>Mechanism (verified live on EMQX 5.8.3).</strong> The api container
 * cannot run {@code emqx eval} (no docker access), so it reaches the broker over
 * its REST management API v5 - the HTTP equivalent of the script's
 * {@code emqx_authz:update({replace, file}, ...)}: {@code PUT
 * /authorization/sources/file} with {@code {type:file, enable:true, rules:<the
 * current acl.conf content>}} re-initialises the file authorizer, recompiling
 * the rules so the new grant is enforced within seconds. The REST file source is
 * modelled by content ({@code rules}), not a path - it rejects a {@code path}
 * field - so we read the same {@code acl.conf} that {@link AclGrantWriter} just
 * wrote and hand its bytes over. A side effect is that EMQX repoints the running
 * source at its own {@code data/authz/acl.conf} copy; this is harmless here
 * because (a) the mounted {@code acl.conf} stays the single source of truth (the
 * api and the shell tools only ever write it, and we re-read it on every
 * reload), and (b) the {@code EMQX_AUTHORIZATION__SOURCES} env pin resets the
 * path back to the mounted file on the next broker restart (also verified).
 *
 * <p><strong>Non-fatal &amp; coalesced.</strong> A reload failure must never fail
 * an issuance or an unclaim - the deploy/cron reload remains the backstop, so
 * every path here swallows errors with a warning. Reloads run on a single
 * background thread and are coalesced over a short debounce window, so a burst of
 * grant changes collapses into one REST call that picks up the latest file
 * content.
 *
 * <p><strong>Feature-flagged.</strong> The bean only exists when
 * {@code voltpilot.enrollment.broker-authz-reload.enabled=true} <em>and</em> an
 * {@code api-url} is configured; dev, tests and non-enrollment deployments never
 * need EMQX. Auth is either an EMQX API key (Basic, preferred - stateless) or
 * the dashboard user/password (a cached login token, reusing the credentials the
 * prod compose already ships).
 */
@Component
@ConditionalOnProperty(name = "voltpilot.enrollment.broker-authz-reload.enabled", havingValue = "true")
public class BrokerAuthzReloader implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(BrokerAuthzReloader.class);

    /** Seam over the EMQX REST call, so the coalescing/non-fatal logic is unit-testable. */
    interface FileSourceUpdater {
        /** Push {@code rules} as the file authorization source; throws on failure. */
        void putRules(String rules) throws Exception;
    }

    private final Path aclFile;
    private final FileSourceUpdater updater;
    private final long debounceMillis;
    private final ScheduledExecutorService scheduler;
    private final AtomicBoolean scheduled = new AtomicBoolean(false);

    @Autowired
    public BrokerAuthzReloader(
            @Value("${voltpilot.enrollment.acl-file:}") String aclFile,
            @Value("${voltpilot.enrollment.broker-authz-reload.api-url:}") String apiUrl,
            @Value("${voltpilot.enrollment.broker-authz-reload.api-key:}") String apiKey,
            @Value("${voltpilot.enrollment.broker-authz-reload.api-secret:}") String apiSecret,
            @Value("${voltpilot.enrollment.broker-authz-reload.username:}") String username,
            @Value("${voltpilot.enrollment.broker-authz-reload.password:}") String password,
            @Value("${voltpilot.enrollment.broker-authz-reload.timeout:PT5S}") Duration timeout,
            @Value("${voltpilot.enrollment.broker-authz-reload.debounce:PT0.3S}") Duration debounce) {
        if (aclFile == null || aclFile.isBlank()) {
            throw new IllegalStateException("voltpilot.enrollment.broker-authz-reload.enabled=true "
                    + "requires voltpilot.enrollment.acl-file (the grant file to reload)");
        }
        if (apiUrl == null || apiUrl.isBlank()) {
            throw new IllegalStateException("voltpilot.enrollment.broker-authz-reload.enabled=true "
                    + "requires voltpilot.enrollment.broker-authz-reload.api-url (the EMQX REST base, "
                    + "e.g. http://emqx:18083/api/v5)");
        }
        this.aclFile = Path.of(aclFile);
        this.debounceMillis = Math.max(0, debounce.toMillis());
        this.scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "broker-authz-reload");
            t.setDaemon(true);
            return t;
        });
        this.updater = new EmqxFileSourceUpdater(apiUrl, apiKey, apiSecret, username, password, timeout);
        log.info("Broker authz auto-reload enabled -> EMQX REST {} (auth: {})", apiUrl,
                apiKey != null && !apiKey.isBlank() ? "api-key" : "dashboard-login");
    }

    /** Test seam: inject a fake updater and a deterministic (no-thread) debounce. */
    BrokerAuthzReloader(Path aclFile, FileSourceUpdater updater, long debounceMillis,
            ScheduledExecutorService scheduler) {
        this.aclFile = aclFile;
        this.updater = updater;
        this.debounceMillis = debounceMillis;
        this.scheduler = scheduler;
    }

    /**
     * Ask for a reload after a grant write/removal. Returns immediately: the
     * actual REST call runs on the background thread and is coalesced with any
     * other requests in the debounce window (the run re-reads the file, so it
     * always reflects the latest grants). Never throws.
     */
    public void requestReload() {
        try {
            if (scheduled.compareAndSet(false, true)) {
                scheduler.schedule(this::runCoalesced, debounceMillis, TimeUnit.MILLISECONDS);
            }
        } catch (RuntimeException e) {
            // e.g. executor already shut down during teardown - never fatal.
            log.warn("Could not schedule broker authz reload: {}", e.getMessage());
        }
    }

    private void runCoalesced() {
        // Clear BEFORE reading the file so a grant change racing in during the
        // REST call schedules a fresh run rather than being lost.
        scheduled.set(false);
        reloadNow();
    }

    /**
     * Synchronous reload with bounded retries, for the STARTUP self-heal path
     * where the caller must KNOW whether EMQX actually re-read the healed file
     * so it can log a loud, actionable ERROR if not (a healed acl.conf that the
     * broker never re-reads still leaves the device denied). Retries a brief
     * broker blip during a rolling deploy; never throws, never crashes the boot.
     * Returns true once EMQX accepted the push, false after exhausting attempts.
     */
    public boolean reloadNowBlocking(int attempts, Duration between) {
        int tries = Math.max(1, attempts);
        long sleepMillis = between == null ? 0 : Math.max(0, between.toMillis());
        for (int i = 1; i <= tries; i++) {
            if (reloadNow()) {
                return true;
            }
            if (i < tries && sleepMillis > 0) {
                try {
                    Thread.sleep(sleepMillis);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return false;
                }
            }
        }
        return false;
    }

    /**
     * Read the current ACL file and push it to EMQX. Best-effort: any failure is
     * logged and swallowed - the cron/deploy reload is the backstop, and an
     * issuance/unclaim must never fail because the broker was briefly
     * unreachable. Returns true when the broker accepted the push (so the
     * startup self-heal can distinguish "EMQX re-read the healed file" from
     * "still denied, operator action needed").
     */
    boolean reloadNow() {
        String rules;
        try {
            rules = Files.readString(aclFile, StandardCharsets.UTF_8);
        } catch (Exception e) {
            log.warn("Broker authz reload skipped - cannot read {}: {}", aclFile, e.getMessage());
            return false;
        }
        try {
            updater.putRules(rules);
            log.info("Broker authz reloaded via EMQX REST - grant changes are now in effect");
            return true;
        } catch (Exception e) {
            log.warn("Broker authz reload failed ({}); the deploy/cron reload "
                    + "(tools/pki/reload-broker-authz.sh) remains the backstop", e.toString());
            return false;
        }
    }

    @Override
    @PreDestroy
    public void close() {
        scheduler.shutdownNow();
    }

    /**
     * Default {@link FileSourceUpdater}: {@code PUT /authorization/sources/file}
     * on the EMQX REST management API. Authenticates with an API key (HTTP Basic,
     * stateless) when configured, otherwise logs in with the dashboard
     * user/password and caches the bearer token (re-logging in on a 401).
     */
    private static final class EmqxFileSourceUpdater implements FileSourceUpdater {

        private final RestClient http;
        private final String basicAuth; // non-null => API-key Basic auth
        private final String username;
        private final String password;

        private String cachedToken;
        private Instant cachedTokenExpiry = Instant.EPOCH;

        EmqxFileSourceUpdater(String apiUrl, String apiKey, String apiSecret, String username,
                String password, Duration timeout) {
            SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
            int millis = (int) Math.max(1000, timeout.toMillis());
            factory.setConnectTimeout(millis);
            factory.setReadTimeout(millis);
            this.http = RestClient.builder()
                    .baseUrl(stripTrailingSlash(apiUrl))
                    .requestFactory(factory)
                    .build();
            if (apiKey != null && !apiKey.isBlank()) {
                String raw = apiKey + ":" + (apiSecret == null ? "" : apiSecret);
                this.basicAuth = "Basic " + java.util.Base64.getEncoder()
                        .encodeToString(raw.getBytes(StandardCharsets.UTF_8));
                this.username = null;
                this.password = null;
            } else if (username != null && !username.isBlank()) {
                this.basicAuth = null;
                this.username = username;
                this.password = password;
            } else {
                throw new IllegalStateException("voltpilot.enrollment.broker-authz-reload needs "
                        + "either api-key/api-secret or username/password to authenticate to EMQX");
            }
        }

        @Override
        public void putRules(String rules) {
            Map<String, Object> body = Map.of("type", "file", "enable", true, "rules", rules);
            try {
                put(body, authHeader());
            } catch (RestClientResponseException ex) {
                if (ex.getStatusCode().value() == 401 && basicAuth == null) {
                    // Token likely expired - re-login once and retry.
                    cachedToken = null;
                    put(body, authHeader());
                    return;
                }
                throw new IllegalStateException("EMQX authz reload returned "
                        + ex.getStatusCode().value() + ": " + ex.getResponseBodyAsString(), ex);
            }
        }

        private void put(Map<String, Object> body, String authorization) {
            http.put()
                    .uri("/authorization/sources/file")
                    .header(HttpHeaders.AUTHORIZATION, authorization)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body)
                    .retrieve()
                    .toBodilessEntity();
        }

        private String authHeader() {
            if (basicAuth != null) {
                return basicAuth;
            }
            return "Bearer " + accessToken();
        }

        private synchronized String accessToken() {
            if (cachedToken != null && Instant.now().isBefore(cachedTokenExpiry)) {
                return cachedToken;
            }
            Map<String, Object> token = http.post()
                    .uri("/login")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(Map.of("username", username, "password", password))
                    .retrieve()
                    .body(new org.springframework.core.ParameterizedTypeReference<Map<String, Object>>() {});
            if (token == null || token.get("token") == null) {
                throw new IllegalStateException("EMQX dashboard login returned no token");
            }
            cachedToken = String.valueOf(token.get("token"));
            // EMQX dashboard tokens live ~60 min; refresh well before that.
            cachedTokenExpiry = Instant.now().plus(Duration.ofMinutes(45));
            return cachedToken;
        }

        private static String stripTrailingSlash(String s) {
            return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
        }
    }
}
