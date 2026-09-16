package com.voltpilot.api.enrollment;

import com.voltpilot.api.enrollment.EnrollmentDeviceLookup.DeviceIdentity;
import com.voltpilot.api.enrollment.EnrollmentRepository.Enrollment;
import jakarta.annotation.PostConstruct;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.bouncycastle.pkcs.PKCS10CertificationRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;

/**
 * First-boot device enrollment over HTTPS (the mTLS half of "kinderleicht"
 * onboarding): a fresh device knows only its reference and the portal URL,
 * uploads a CSR, and polls for its certificate; the moment the customer claims
 * the reference in the portal, the poll answers with a client certificate
 * signed by the device CA - identity enforced from the claim, never from the
 * CSR - plus the broker connection params. No manual cert copying.
 *
 * <p>The issued certificate stays retrievable for device retries: the private
 * key is the secret and it never left the device, so re-serving the (public)
 * certificate is harmless. Re-keying or decommissioning goes through the
 * existing revocation tooling ({@code tools/pki/voltpilot-ca.sh revoke}), which
 * keeps working over api-issued certificates because issuance records into the
 * same CA database (see {@link DeviceCertificateAuthority}).
 *
 * <p>Enabled only where the CA material is wired in
 * ({@code voltpilot.enrollment.enabled} + {@code ca-dir}, see
 * docker-compose.prod.yml); every issuance is audit-logged.
 */
@Service
@ConditionalOnProperty(name = "voltpilot.enrollment.enabled", havingValue = "true")
public class EnrollmentService {

    private static final Logger log = LoggerFactory.getLogger(EnrollmentService.class);

    private final EnrollmentProperties properties;
    private final EnrollmentRepository enrollments;
    private final EnrollmentDeviceLookup devices;
    private final DeviceCertificateAuthority ca;
    private final AclGrantWriter aclWriter; // null = grant writing not configured
    // Empty unless broker-authz-reload is enabled + configured; when present it
    // pushes the freshly written ACL to EMQX so grants apply within seconds.
    private final ObjectProvider<BrokerAuthzReloader> authzReloader;

    // Per-ref lock stripes serialize the claim->sign->store sequence: without
    // this, two concurrent certificate polls for a just-claimed ref both see
    // issued==false and both call ca.issue(), burning a serial and orphaning a
    // cert in the CA database (the DB store-guard lets only one win). Striped so
    // the map can't grow unboundedly; false-sharing across refs is harmless.
    private static final int LOCK_STRIPES = 64;
    private final Object[] refLocks = new Object[LOCK_STRIPES];

    // Startup self-heal reload: EMQX has usually been running across the api
    // redeploy (that is the whole problem - it keeps its old compiled rules), so
    // the first attempt normally succeeds; the retries only cover a brief broker
    // blip during a rolling deploy. Bounded so a genuinely unreachable broker
    // does not stall the boot for long before the actionable ERROR is logged.
    private static final int STARTUP_RELOAD_ATTEMPTS = 3;
    private static final Duration STARTUP_RELOAD_RETRY_DELAY = Duration.ofSeconds(2);

    public EnrollmentService(EnrollmentProperties properties, EnrollmentRepository enrollments,
            EnrollmentDeviceLookup devices, ObjectProvider<BrokerAuthzReloader> authzReloader) {
        if (properties.caDir() == null || properties.caDir().isBlank()) {
            throw new IllegalStateException("voltpilot.enrollment.enabled=true requires "
                    + "voltpilot.enrollment.ca-dir (the device-CA working directory)");
        }
        this.properties = properties;
        this.enrollments = enrollments;
        this.devices = devices;
        this.authzReloader = authzReloader;
        for (int i = 0; i < LOCK_STRIPES; i++) {
            refLocks[i] = new Object();
        }
        this.ca = new DeviceCertificateAuthority(Path.of(properties.caDir()),
                properties.certDays(), Clock.systemUTC());
        this.aclWriter = properties.aclFile() == null || properties.aclFile().isBlank()
                ? null : new AclGrantWriter(Path.of(properties.aclFile()));
        if (this.aclWriter == null) {
            log.warn("Enrollment is enabled without voltpilot.enrollment.acl-file - "
                    + "broker ACL grants must be managed out of band");
        }
    }

    /**
     * Nudge the broker to re-read the ACL file after a grant write/removal so the
     * change is enforced immediately (no-op unless broker-authz-reload is
     * configured). Always non-fatal - the cron/deploy reload is the backstop.
     */
    private void requestBrokerAuthzReload() {
        authzReloader.ifAvailable(BrokerAuthzReloader::requestReload);
    }

    /**
     * Self-heal the broker ACL on api startup, so a DEPLOY alone repairs an
     * already-corrupted acl.conf - no manual edit, no device re-claim (the
     * 2026-07-08 prod-down incident: a claimed device's grant sat BELOW the
     * default-deny with the template tail duplicated, so the device was refused
     * and kicked off the broker). A plain container redeploy triggers no grant
     * write, so the repair must happen here.
     *
     * <p>Runs unconditionally on boot and never crashes it: an unrecognized file
     * / IO error is reported as {@code SKIPPED} (WARN), never thrown.
     *
     * <p><strong>Regenerate from the DB source of truth, not the file</strong>
     * (2026-07-08 definitive fix - the captain's device {@code cdba2ee8} stayed
     * offline after #100/#101 because its grant was ENTIRELY ABSENT from the live
     * acl.conf: a prior buggy rebuild had DROPPED it, and you cannot reorder or
     * reload a grant that is not there). So the self-heal REBUILDS the
     * generated-grant region from what the api KNOWS - every claimed + enrolled
     * device ({@link EnrollmentDeviceLookup#allEnrolledDeviceIdentities()}) gets a
     * correct in-region grant - which RESTORES a dropped grant, FIXES a misordered
     * one, and canonicalizes the file (single region above a single default-deny
     * tail). Grants not in the DB list (e.g. shell-provisioned via
     * {@code tools/pki}) are preserved. If the DB is unreachable at boot we fall
     * back to a pure canonicalize (no restore) so ordering is still fixed and the
     * reload still fires - never crashing the boot.
     *
     * <p><strong>The reload ALWAYS runs</strong> (regardless of whether the file
     * changed). EMQX compiles {@code acl.conf} ONCE at source init and does NOT
     * re-read it on its own (a plain {@code emqx ctl conf reload} does NOT re-read
     * the file - verified on 5.8.3), so a broker up across earlier deploys can
     * still enforce STALE compiled rules even when the on-disk file is already
     * correct. We therefore reconcile EMQX's live ruleset with the current file on
     * EVERY boot; the reload is idempotent and cheap. If the broker does not
     * accept it we log a loud, actionable ERROR naming the manual fallback
     * ({@code reload-broker-authz.sh} / {@code docker restart emqx}) rather than
     * silently leaving the device denied. Only a {@code SKIPPED} regenerate (a
     * file we do not own / cannot read / no region anchors) short-circuits the
     * reload.
     */
    @PostConstruct
    void selfHealBrokerAclOnStartup() {
        if (aclWriter == null) {
            log.warn("Broker ACL self-heal disabled: voltpilot.enrollment.acl-file is not set - "
                    + "device grants must be managed out of band");
            return;
        }
        // State the resolved path (item 3): a wrong mount is the fastest way to
        // "heal succeeded but the device is still denied", and a single log line
        // makes it obvious in the deploy logs. EMQX must read the SAME host file
        // via its directory mount (docker-compose.prod.yml: infra/mqtt/acl).
        Path resolved = Path.of(properties.aclFile()).toAbsolutePath();
        log.info("Broker ACL grant file resolves to {} (exists={}, writable={}); EMQX must read "
                + "the SAME file via its acl/ DIRECTORY mount (see docker-compose.prod.yml)",
                resolved, Files.exists(resolved), Files.isWritable(resolved));

        // The authoritative grant set: every claimed + enrolled device MUST have a
        // grant. Deriving it from the DB (not the possibly-broken file) is what
        // lets a DROPPED grant be restored, not just reordered.
        List<AclGrantWriter.DeviceGrant> authoritative;
        try {
            authoritative = devices.allEnrolledDeviceIdentities().stream()
                    .map(d -> new AclGrantWriter.DeviceGrant(d.tenantId(), d.siteId(), d.deviceId()))
                    .toList();
            log.info("Broker ACL regeneration: {} claimed+enrolled device grant(s) are the source "
                    + "of truth", authoritative.size());
        } catch (RuntimeException e) {
            // DB unreachable at boot: still canonicalize + reload (fixes ordering,
            // reconciles a stale broker), but a grant DROPPED from the file cannot
            // be restored until the DB is reachable and the api restarts.
            log.error("Could not load enrolled devices from the DB for ACL regeneration ({}); "
                    + "falling back to canonicalize-only. A grant DROPPED from the file will NOT "
                    + "be restored on this boot - restart the api once the DB is reachable.",
                    e.toString());
            authoritative = List.of();
        }

        AclGrantWriter.RegenerateResult result = aclWriter.regenerateGrants(authoritative);
        if (result.skipped()) {
            log.warn("Broker ACL regeneration skipped for {}: {} (managing grants out of band); "
                    + "NOT reloading EMQX for a file we do not own", resolved, result.detail());
            return;
        }
        if (result.changed()) {
            log.warn("Regenerated broker ACL at {} from the DB source of truth: (re)wrote {} of {} "
                    + "enrolled device grant(s) [restores any DROPPED grant], moved {} grant "
                    + "block(s) that sat BELOW the default-deny into the generated region, and "
                    + "collapsed {} duplicate tail(s). The file is now correct.", resolved,
                    result.restoredFromTruth(), result.authoritative(),
                    result.grantsMovedAboveDeny(), result.tailCopies());
        } else {
            log.info("Broker ACL at {} already canonical and complete ({} enrolled device grant(s) "
                    + "present) - no file change needed.", resolved, result.authoritative());
        }

        // ALWAYS reload, changed or not: the file being correct does NOT mean the
        // running broker is, so reconcile EMQX's compiled rules with the current
        // file on every boot. This is the fix for the residual 2026-07-08 outage
        // where the file was already canonical (an earlier attempt fixed it) but
        // the long-running EMQX never re-read it -> device stayed denied -> no
        // reload fired because the self-heal saw "nothing to change".
        reconcileBrokerAuthzOnStartup(resolved, result.changed());
    }

    /**
     * Force the running EMQX to re-read the (now canonical) ACL file on startup,
     * whether or not the file was just healed. Bounded retries cover a brief
     * broker blip during a rolling deploy; never throws, never crashes the boot.
     * A failure (broker unreachable / reload disabled) is a loud, actionable log
     * - the cron/deploy reload stays the backstop.
     */
    private void reconcileBrokerAuthzOnStartup(Path resolved, boolean fileChanged) {
        String context = fileChanged ? "after regenerating grants"
                : "reconciling the already-canonical file";
        BrokerAuthzReloader reloader = authzReloader.getIfAvailable();
        if (reloader == null) {
            // Without the reloader we cannot reconcile a stale broker. A changed
            // file with no reloader is the worse case (grants definitely changed),
            // so ERROR there; an already-canonical file is usually fine, so WARN.
            String shared = "EMQX compiles acl.conf ONCE at source init and does NOT re-read it on "
                    + "its own, so a long-running broker may still enforce STALE rules. ACTION IF "
                    + "A DEVICE IS DENIED: run tools/pki/reload-broker-authz.sh on the broker host, "
                    + "or `docker restart emqx`.";
            if (fileChanged) {
                log.error("Broker ACL was regenerated at {} but the api CANNOT reload EMQX "
                        + "automatically "
                        + "(voltpilot.enrollment.broker-authz-reload is disabled). {} Until then "
                        + "affected device(s) stay DENIED.", resolved, shared);
            } else {
                log.warn("Broker ACL at {} is canonical but the api CANNOT reload EMQX automatically "
                        + "(voltpilot.enrollment.broker-authz-reload is disabled), so a broker "
                        + "holding stale rules is NOT reconciled on this boot. {}", resolved, shared);
            }
            return;
        }
        boolean reloaded = reloader.reloadNowBlocking(STARTUP_RELOAD_ATTEMPTS,
                STARTUP_RELOAD_RETRY_DELAY);
        if (reloaded) {
            log.info("Broker authz reloaded on startup ({}) - EMQX re-read {}; any affected "
                    + "device(s) reconnect within seconds, no re-claim needed.", context, resolved);
        } else {
            log.error("Broker authz reload FAILED on startup ({}) after {} attempts. EMQX keeps its "
                    + "OLD compiled rules until it re-reads {}, so a device may remain DENIED and "
                    + "stuck in a reconnect loop. ACTION REQUIRED: run "
                    + "tools/pki/reload-broker-authz.sh on the broker host, or `docker restart "
                    + "emqx` (a plain `emqx ctl conf reload` does NOT re-read acl.conf). Verify "
                    + "voltpilot.enrollment.broker-authz-reload.api-url + credentials and that this "
                    + "api can reach EMQX.", context, STARTUP_RELOAD_ATTEMPTS, resolved);
        }
    }

    /** What the device receives once its ref is claimed. */
    public record IssuedEnrollment(String deviceCertPem, String caPem, String mqttHost,
            int mqttPort, UUID tenantId, UUID siteId, UUID deviceId) {
    }

    /**
     * The certificate for a ref, issuing it now when the ref has both a pending
     * CSR and a claim. Empty means "not available (yet)" - deliberately the same
     * answer for an unknown ref, an unclaimed ref and a stale post-unclaim state,
     * so polling reveals nothing about which refs exist (no enumeration).
     */
    public Optional<IssuedEnrollment> certificateFor(String externalRef) {
        synchronized (refLocks[Math.floorMod(externalRef.hashCode(), LOCK_STRIPES)]) {
            return certificateForLocked(externalRef);
        }
    }

    private Optional<IssuedEnrollment> certificateForLocked(String externalRef) {
        Optional<Enrollment> found = enrollments.find(externalRef);
        if (found.isEmpty()) {
            return Optional.empty();
        }
        Enrollment enrollment = found.get();
        Optional<DeviceIdentity> claimed = devices.findByRef(externalRef);
        if (claimed.isEmpty()) {
            // Unclaimed (or unclaimed-again): even an already-issued certificate
            // is not handed out without a live claim behind it.
            return Optional.empty();
        }
        DeviceIdentity device = claimed.get();
        if (enrollment.issued() && device.deviceId().equals(enrollment.deviceId())) {
            return Optional.of(response(enrollment.certPem(), device));
        }
        return Optional.of(issueGuarded(externalRef, device));
    }

    /**
     * Serialize signing per ref so concurrent polls cannot double-sign. Inside
     * the lock the enrollment is re-loaded and the issued-state re-checked: a
     * poll that lost the race sees the cert already issued and serves it without
     * signing again (no burned serial, no orphaned cert).
     */
    private IssuedEnrollment issueGuarded(String externalRef, DeviceIdentity device) {
        synchronized (refLocks[Math.floorMod(externalRef.hashCode(), LOCK_STRIPES)]) {
            Enrollment enrollment = enrollments.find(externalRef).orElseThrow();
            if (enrollment.issued() && device.deviceId().equals(enrollment.deviceId())) {
                return response(enrollment.certPem(), device);
            }
            return issue(enrollment, device);
        }
    }

    /**
     * Issue (or re-issue after an unclaim-and-re-claim) the certificate for a
     * claimed ref. The stored CSR was validated on upload; it is re-validated
     * here anyway - it is about to be signed.
     */
    private IssuedEnrollment issue(Enrollment enrollment, DeviceIdentity device) {
        PKCS10CertificationRequest csr = Csrs.parseAndValidate(enrollment.csrPem());
        // Grant before signing: a certificate without broker access is useless,
        // and the grant write is idempotent - a failed signing retries both.
        if (aclWriter != null) {
            aclWriter.writeGrant(device.tenantId(), device.siteId(), device.deviceId());
            // The grant is on disk; make EMQX enforce it now instead of at the
            // next deploy/cron reload (closes the "claimed-but-refused" window).
            requestBrokerAuthzReload();
        }
        DeviceCertificateAuthority.IssuedCertificate issued =
                ca.issue(csr, device.tenantId(), device.siteId(), device.deviceId());
        boolean stored = enrollments.storeCertificate(enrollment.externalRef(),
                device.deviceId(), issued.certPem(), issued.serialHex());
        if (!stored) {
            // A concurrent poll won the race for the same device; serve its cert.
            Enrollment winner = enrollments.find(enrollment.externalRef()).orElseThrow();
            log.info("Concurrent enrollment issuance for ref '{}' - serving serial {}",
                    enrollment.externalRef(), winner.certSerial());
            return response(winner.certPem(), device);
        }
        // The audit trail: every certificate this platform signs leaves a line.
        log.info("Issued device certificate serial={} ref='{}' device={} tenant={} site={}",
                issued.serialHex(), enrollment.externalRef(), device.deviceId(),
                device.tenantId(), device.siteId());
        return response(issued.certPem(), device);
    }

    private IssuedEnrollment response(String certPem, DeviceIdentity device) {
        return new IssuedEnrollment(certPem, ca.caPem(), properties.mqttHost(),
                properties.mqttPort(), device.tenantId(), device.siteId(), device.deviceId());
    }

    /**
     * Unclaim hook: drop the device's broker ACL grant so the old certificate
     * loses all topic access at the next authz reload (default-deny). CRL
     * revocation stays the operator-run cryptographic backstop. Best-effort
     * like the retained-MQTT cleanup - unclaiming must never fail on this.
     */
    public void onDeviceUnclaimed(UUID deviceId) {
        if (aclWriter == null) {
            return;
        }
        try {
            aclWriter.removeGrant(deviceId);
            // Push the removal to EMQX now so the old certificate loses topic
            // access within seconds (default-deny), not at the next reload.
            requestBrokerAuthzReload();
            log.info("Removed broker ACL grant for unclaimed device {} (CRL revocation via "
                    + "tools/pki/voltpilot-ca.sh remains the cryptographic kill switch)", deviceId);
        } catch (RuntimeException e) {
            log.warn("Could not remove broker ACL grant for unclaimed device {}: {}",
                    deviceId, e.getMessage());
        }
    }

    /** Box-Tausch: erst nach bestätigtem ACL-Entzug darf der Nachfolger seine Quellen erhalten.
     * Verwendet denselben Grant-Schreiber und Broker-Reload wie Unclaim; keine neue PKI.
     * Ein Ausfall bleibt als Zustellauftrag erhalten. CRL bleibt der Betreiberweg.
     */
    public boolean blockSucceededDevice(String externalRef, UUID deviceId) {
        // Eine bereits laufende Ausstellung darf den entzogenen Grant nicht nachträglich
        // wieder anlegen. Nach dem Commit sieht jeder neue Poll die Box als ausgebaut.
        synchronized (refLocks[Math.floorMod(externalRef.hashCode(), LOCK_STRIPES)]) {
            return blockSucceededDeviceLocked(deviceId);
        }
    }

    private boolean blockSucceededDeviceLocked(UUID deviceId) {
        BrokerAuthzReloader reloader = authzReloader.getIfAvailable();
        if (aclWriter == null || reloader == null) return false;
        try {
            aclWriter.removeGrant(deviceId);
            return reloader.reloadNowBlocking(1, Duration.ZERO);
        } catch (RuntimeException e) {
            log.warn("Box succession ACL removal failed for {}: {}", deviceId, e.getMessage());
            return false;
        }
    }
}
