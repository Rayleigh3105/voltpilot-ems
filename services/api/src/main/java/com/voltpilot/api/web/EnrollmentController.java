package com.voltpilot.api.web;

import com.voltpilot.api.enrollment.Csrs;
import com.voltpilot.api.enrollment.EnrollmentRepository;
import com.voltpilot.api.enrollment.EnrollmentService;
import com.voltpilot.api.enrollment.InvalidCsrException;
import com.voltpilot.api.provisioning.ProvisioningTopics;
import com.voltpilot.api.repo.ProvisionedDeviceRepository;
import com.voltpilot.api.web.dto.EnrollmentCertificateDto;
import com.voltpilot.api.web.dto.EnrollmentCsrRequest;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * First-boot device enrollment over HTTPS - the public (UNAUTHENTICATED,
 * rate-limited) endpoints a fresh edge device talks to, knowing only its
 * printed reference and the portal URL:
 *
 * <ol>
 *   <li>{@code POST /api/v1/enrollment/{ref}/csr} - upload the device-generated
 *       CSR (the private key never leaves the device). Idempotent per ref:
 *       re-POSTing replaces the pending CSR until a certificate is issued.</li>
 *   <li>{@code GET /api/v1/enrollment/{ref}/certificate} - poll for the
 *       certificate. 404 (body {@code status=pending}) until the customer
 *       claims the ref in the portal; then the CA-signed client certificate,
 *       the CA and the broker params. Polling etiquette (documented in the
 *       OpenAPI contract): start at ~10 s, back off to &gt;= 60 s.</li>
 * </ol>
 *
 * <p>Anti-abuse: both endpoints share the {@link EnrollmentRateLimiter} budget
 * (per client address + global, 429 before any work); the CSR is size-capped
 * and validated (parse, self-signature, key policy) before it is stored; and a
 * pending ref answers exactly like an unknown one, so polling cannot enumerate
 * which refs exist. Sticker refs ({@code VP-}) must pass the provisioned-device
 * registry gate exactly like the claim endpoint (422 otherwise).
 */
@RestController
@RequestMapping("/api/v1/enrollment")
@ConditionalOnProperty(name = "voltpilot.enrollment.enabled", havingValue = "true")
public class EnrollmentController {

    private static final Logger log = LoggerFactory.getLogger(EnrollmentController.class);

    /** Identical body for unknown ref, unclaimed ref and stale post-unclaim state. */
    private static final Map<String, String> PENDING = Map.of(
            "status", "pending",
            "message", "Noch kein Zertifikat verfügbar. Bitte beanspruchen Sie die "
                    + "Geräte-Referenz im Portal und fragen Sie danach erneut an.");

    private final EnrollmentService enrollment;
    private final EnrollmentRepository enrollments;
    private final ProvisionedDeviceRepository provisioned;
    private final EnrollmentRateLimiter rateLimiter;

    public EnrollmentController(EnrollmentService enrollment, EnrollmentRepository enrollments,
            ProvisionedDeviceRepository provisioned, EnrollmentRateLimiter rateLimiter) {
        this.enrollment = enrollment;
        this.enrollments = enrollments;
        this.provisioned = provisioned;
        this.rateLimiter = rateLimiter;
    }

    @PostMapping("/{ref}/csr")
    public ResponseEntity<Map<String, String>> submitCsr(@PathVariable String ref,
            @Valid @RequestBody EnrollmentCsrRequest request, HttpServletRequest httpRequest) {
        rateLimit(httpRequest);
        String canonicalRef = canonicalRef(ref);
        Csrs.parseAndValidate(request.csrPem());
        // Sticker refs pass the same manufacturing-registry gate as the claim
        // endpoint: a typo'd ID fails fast instead of enrolling a ghost.
        if (canonicalRef.startsWith(DeviceController.STICKER_PREFIX)
                && provisioned.findKind(canonicalRef).isEmpty()) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Diese Geräte-Referenz ist uns nicht bekannt. Bitte prüfen Sie die "
                            + "Referenz auf dem Geräte-Aufkleber.");
        }
        if (!enrollments.upsertCsr(canonicalRef, request.csrPem(), request.deviceInfo())) {
            // A certificate exists for this ref - the enrolled key is fixed.
            // Re-keying (device re-flashed, key lost) goes through the operator:
            // revoke via tools/pki/voltpilot-ca.sh, unclaim + re-claim in the portal.
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Für diese Geräte-Referenz wurde bereits ein Zertifikat ausgestellt. "
                            + "Für einen neuen Schlüssel wenden Sie sich an den Support.");
        }
        log.info("Stored enrollment CSR for ref '{}'", canonicalRef);
        return ResponseEntity.accepted().body(Map.of("status", "pending", "ref", canonicalRef));
    }

    @GetMapping("/{ref}/certificate")
    public ResponseEntity<?> certificate(@PathVariable String ref, HttpServletRequest httpRequest) {
        rateLimit(httpRequest);
        String canonicalRef = canonicalRef(ref);
        return enrollment.certificateFor(canonicalRef)
                .<ResponseEntity<?>>map(issued -> ResponseEntity.ok(new EnrollmentCertificateDto(
                        issued.deviceCertPem(), issued.caPem(), issued.mqttHost(),
                        issued.mqttPort(), issued.tenantId(), issued.siteId(), issued.deviceId())))
                .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND).body(PENDING));
    }

    private void rateLimit(HttpServletRequest request) {
        if (!rateLimiter.tryAcquire(rateLimiter.clientKey(request))) {
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                    "Zu viele Anfragen. Bitte versuchen Sie es später erneut.");
        }
    }

    private static String canonicalRef(String ref) {
        String canonical = DeviceController.canonicalExternalRef(ref);
        if (!ProvisioningTopics.isValidRef(canonical)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Ungültige Geräte-Referenz.");
        }
        return canonical;
    }

    @ExceptionHandler(InvalidCsrException.class)
    ResponseEntity<Map<String, String>> invalidCsr(InvalidCsrException e) {
        return ResponseEntity.badRequest().body(Map.of("status", "error", "message", e.getMessage()));
    }

    /** CA/signing trouble (misconfigured CA dir, unwritable ACL file, ...). */
    @ExceptionHandler(IllegalStateException.class)
    ResponseEntity<Map<String, String>> issuanceFailed(IllegalStateException e) {
        log.error("Enrollment issuance failed: {}", e.getMessage(), e);
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of(
                "status", "error",
                "message", "Die Zertifikatsausstellung ist derzeit nicht möglich. "
                        + "Bitte versuchen Sie es später erneut."));
    }
}
