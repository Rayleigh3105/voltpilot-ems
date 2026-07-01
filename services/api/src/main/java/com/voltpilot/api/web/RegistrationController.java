package com.voltpilot.api.web;

import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakAdminException;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.web.dto.RegistrationRequest;
import com.voltpilot.api.web.dto.RegistrationResponse;
import com.voltpilot.api.web.dto.TenantDto;
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
 * customers, so the same OIDC + RLS spine isolates them. If Keycloak refuses
 * (e.g. the email is already registered), the just-created tenant is deleted
 * again so no orphan accumulates.
 *
 * <p>The endpoint is deliberately unauthenticated (see SecurityConfig) and can
 * be disabled for closed platforms via {@code voltpilot.registration.enabled}.
 * Abuse hardening (email verification, rate limiting/captcha) is known future
 * work; until then the toggle is the off-switch.
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

    public RegistrationController(TenantRepository tenants, KeycloakAdminClient keycloak) {
        this.tenants = tenants;
        this.keycloak = keycloak;
    }

    @PostMapping
    public ResponseEntity<RegistrationResponse> register(@Valid @RequestBody RegistrationRequest request) {
        String email = request.email().trim().toLowerCase(Locale.ROOT);
        TenantDto tenant = tenants.create(request.name().trim(), SELF_SERVICE_SEGMENT);
        KeycloakUser user;
        try {
            // The email is the login username; the account is enabled immediately.
            user = keycloak.createCustomerUser(tenant.id(), email, email,
                    null, null, request.password(), false);
        } catch (KeycloakAdminException ex) {
            // Compensate: never leave a tenant without its login behind.
            tenants.deleteById(tenant.id());
            HttpStatusCode status = HttpStatusCode.valueOf(
                    ex.status() >= 400 && ex.status() < 600 ? ex.status() : 502);
            throw new ResponseStatusException(status,
                    ex.status() == 409 ? "An account with this email already exists" : ex.getMessage());
        }
        log.info("Self-registered tenant '{}' ({}) with user '{}'", tenant.name(), tenant.id(),
                user.username());
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(new RegistrationResponse(tenant.id(), tenant.name(), user.username()));
    }
}
