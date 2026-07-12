package com.voltpilot.api.web;

import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakAdminException;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.web.dto.RegistrationRequest;
import com.voltpilot.api.web.dto.RegistrationResponse;
import com.voltpilot.api.web.dto.TenantDto;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.util.Locale;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Public self-service registration: a new customer creates their own tenant and
 * login in one request - no operator involved. This is the front door of the
 * onboarding journey (register, create a site, claim the edge device).
 *
 * <p>The tenant row is created through the BYPASSRLS admin datasource (there is
 * no caller tenant yet), then the user is provisioned in Keycloak with the
 * {@code tenant_id} attribute + customer role - exactly like admin-provisioned
 * customers, so the same OIDC + RLS spine isolates them. If provisioning the
 * login fails for ANY reason (Keycloak refuses, e.g. the email is already
 * registered, or is unreachable), the just-created tenant is deleted again so
 * no orphan accumulates.
 *
 * <p>The endpoint is deliberately unauthenticated (see SecurityConfig) and can
 * be disabled for closed platforms via {@code voltpilot.registration.enabled}.
 * Anonymous volume is bounded by {@link RegistrationRateLimiter} (429 before
 * any work happens); email verification/captcha remain known future work.
 */
@RestController
@RequestMapping("/api/v1/registration")
@ConditionalOnProperty(name = "voltpilot.registration.enabled", havingValue = "true", matchIfMissing = true)
public class RegistrationController {

    private static final Logger log = LoggerFactory.getLogger(RegistrationController.class);

    /** Self-registered customers are private/small-business accounts. */
    private static final String SELF_SERVICE_SEGMENT = "B2C";

    private final TenantRepository tenants;
    private final KeycloakAdminClient keycloak;
    private final RegistrationRateLimiter rateLimiter;

    public RegistrationController(TenantRepository tenants, KeycloakAdminClient keycloak,
            RegistrationRateLimiter rateLimiter) {
        this.tenants = tenants;
        this.keycloak = keycloak;
        this.rateLimiter = rateLimiter;
    }

    @PostMapping
    public ResponseEntity<RegistrationResponse> register(@Valid @RequestBody RegistrationRequest request,
            HttpServletRequest httpRequest) {
        if (!rateLimiter.tryAcquire(rateLimiter.clientKey(httpRequest))) {
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                    "Too many registration attempts, please try again later");
        }
        String email = request.email().trim().toLowerCase(Locale.ROOT);
        TenantDto tenant = tenants.create(request.name().trim(), SELF_SERVICE_SEGMENT);
        KeycloakUser user;
        try {
            // The email is the login username; the account is enabled immediately.
            user = keycloak.createCustomerUser(tenant.id(), email, email,
                    null, null, request.password(), false);
        } catch (RuntimeException ex) {
            // Compensate: never leave a tenant without its login behind. This
            // covers transport failures (Keycloak unreachable, timeouts) too,
            // not only Keycloak's own refusals.
            try {
                tenants.deleteById(tenant.id());
            } catch (RuntimeException cleanupEx) {
                log.warn("Failed to delete tenant {} while compensating a registration failure",
                        tenant.id(), cleanupEx);
            }
            if (ex instanceof KeycloakAdminException kex) {
                // Keycloak refused: pass a real 4xx/5xx through (409 = email taken).
                // An out-of-range/unknown status is an upstream outage -> 503.
                // The reason is a FIXED string on this PUBLIC endpoint - upstream
                // detail (already reduced to a fixed message by
                // KeycloakAdminClient, raw body in its log) stays server-side.
                log.warn("Registration for tenant {} refused by the identity provider "
                        + "(status {}): {}", tenant.id(), kex.status(), kex.getMessage());
                HttpStatusCode status = HttpStatusCode.valueOf(
                        kex.status() >= 400 && kex.status() < 600 ? kex.status() : 503);
                throw new ResponseStatusException(status,
                        kex.status() == 409 ? "An account with this email already exists"
                                : "Die Registrierung ist zurzeit nicht möglich. "
                                        + "Bitte versuchen Sie es später erneut.");
            }
            // Transport failure (Keycloak unreachable/timeout): a temporary
            // outage, not a bad gateway response -> 503 so the portal shows the
            // "try again in a few minutes" outage copy rather than a transient
            // "gleich noch einmal" hint (m7).
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Registration is temporarily unavailable, please try again later", ex);
        }
        log.info("Self-registered tenant '{}' ({}) with user '{}'", tenant.name(), tenant.id(),
                user.username());
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(new RegistrationResponse(tenant.id(), tenant.name(), user.username()));
    }
}
