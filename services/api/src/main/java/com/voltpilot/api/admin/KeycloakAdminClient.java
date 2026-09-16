package com.voltpilot.api.admin;

import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.net.URI;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;

/**
 * Thin client over the Keycloak Admin REST API for provisioning customer users.
 *
 * <p>Authenticates as the {@code voltpilot-api} service account
 * (client_credentials) and caches the short-lived admin token. All customer user
 * records it creates carry the {@code tenant_id} attribute, so the very same
 * OIDC + RLS spine that isolates the seeded demo tenants also isolates every
 * admin-provisioned customer.
 *
 * <p><b>UEMS AP-03 IP-3.</b> A customer account gets NO realm role any more - what it
 * may do is its Zuweisung in the API (E11); {@code operator} stays only on existing
 * accounts. A partner account ({@link #createPartnerUser}) carries the realm role
 * {@code partner} and never a {@code tenant_id}. The access token itself is unchanged.
 */
@Component
public class KeycloakAdminClient {

    private static final Logger log = LoggerFactory.getLogger(KeycloakAdminClient.class);

    private final KeycloakAdminProperties props;
    private final RestClient http;

    // Cached service-account token (refreshed ~30s before expiry).
    private String cachedToken;
    private Instant cachedTokenExpiry = Instant.EPOCH;

    public KeycloakAdminClient(KeycloakAdminProperties props) {
        this.props = props;
        this.http = RestClient.builder().baseUrl(props.getBaseUrl()).build();
    }

    /** A provisioned/queried Keycloak user, projected to what the portal needs. */
    public record KeycloakUser(String id, String username, String email, String firstName,
            String lastName, boolean enabled, String tenantId) {
    }

    /**
     * Raised when Keycloak rejects an operation (mapped to HTTP status by the
     * controller). The message is always a FIXED string - controllers pass it
     * as a {@code ResponseStatusException} reason, which can surface in HTTP
     * responses (e.g. under {@code server.error.include-message: always}), so
     * raw upstream Keycloak error bodies must never end up in it; they go to
     * the server log only (see {@link #upstreamError}).
     */
    public static class KeycloakAdminException extends RuntimeException {
        private final int status;

        public KeycloakAdminException(int status, String message) {
            super(message);
            this.status = status;
        }

        public int status() {
            return status;
        }
    }

    // ---- provisioning --------------------------------------------------------

    /**
     * Create a customer user in the tenant and set the password. Returns the
     * projected user. Throws with status 409 if the username/email already exists.
     *
     * <p>No realm role (AP-03 IP-3): the account is a customer account through its
     * {@code tenant_id} alone ({@code KONTO_benutzer} in {@code KeycloakRealmRoleConverter}).
     */
    public KeycloakUser createCustomerUser(UUID tenantId, String username, String email,
            String firstName, String lastName, String password, boolean temporaryPassword) {
        Map<String, Object> body = userBody(username, email, firstName, lastName, password,
                temporaryPassword);
        body.put("attributes", Map.of("tenant_id", List.of(tenantId.toString())));
        String userId = create(body);
        try {
            KeycloakUser user = getUser(userId);
            log.info("Provisioned customer user '{}' ({}) in tenant {}", username, userId, tenantId);
            return user;
        } catch (RuntimeException ex) {
            // All-or-nothing: a created user the caller never hears about would strand
            // the email - every retry hits 409 and only manual Keycloak surgery recovers
            // it. Roll the creation back so the caller can simply retry.
            bestEffortDeleteUser(userId);
            throw ex;
        }
    }

    /**
     * Create a partner account (installer, AP-03 E7): realm role {@code partner}, NO
     * {@code tenant_id} attribute - it reaches a customer area only through a granted
     * Unterstützung (AP-03 IP-4/IP-8), never through its token. Throws with status 409
     * if the username/email already exists; if the realm lacks the role (a live realm
     * not yet updated, see {@code infra/prod/keycloak/README.md}) the account is rolled
     * back and the 404 "Realm role 'partner' not found" propagates.
     */
    public KeycloakUser createPartnerUser(String username, String email, String firstName,
            String lastName, String password, boolean temporaryPassword) {
        String userId = create(userBody(username, email, firstName, lastName, password,
                temporaryPassword));
        try {
            assignRealmRole(userId, KeycloakRealmRoleConverter.PARTNER_ROLE);
            KeycloakUser user = getUser(userId);
            log.info("Provisioned partner user '{}' ({})", username, userId);
            return user;
        } catch (RuntimeException ex) {
            // All-or-nothing: without its role the login would be an account of no kind.
            bestEffortDeleteUser(userId);
            throw ex;
        }
    }

    private static Map<String, Object> userBody(String username, String email, String firstName,
            String lastName, String password, boolean temporaryPassword) {
        Map<String, Object> body = new java.util.HashMap<>();
        body.put("username", username);
        body.put("enabled", true);
        body.put("emailVerified", true);
        if (email != null && !email.isBlank()) {
            body.put("email", email);
        }
        if (firstName != null && !firstName.isBlank()) {
            body.put("firstName", firstName);
        }
        if (lastName != null && !lastName.isBlank()) {
            body.put("lastName", lastName);
        }
        if (password != null && !password.isBlank()) {
            body.put("credentials", List.of(Map.of(
                    "type", "password",
                    "value", password,
                    "temporary", temporaryPassword)));
        }
        return body;
    }

    /** POST the user representation; returns the new Keycloak user id. */
    private String create(Map<String, Object> body) {
        ResponseEntity<Void> res;
        try {
            res = admin().post().uri("/admin/realms/{realm}/users", props.getRealm())
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body)
                    .retrieve()
                    .toBodilessEntity();
        } catch (RestClientResponseException ex) {
            if (ex.getStatusCode().value() == 409) {
                throw new KeycloakAdminException(409, "A user with that username or email already exists");
            }
            throw upstreamError("user creation", ex);
        }
        return extractId(res.getHeaders().getLocation());
    }

    /**
     * Compensating delete for a partially provisioned user. Best-effort: if
     * this fails too the original error still propagates, we just could not
     * clean up.
     */
    private void bestEffortDeleteUser(String userId) {
        try {
            admin().delete().uri("/admin/realms/{realm}/users/{id}", props.getRealm(), userId)
                    .retrieve()
                    .toBodilessEntity();
        } catch (RuntimeException cleanupEx) {
            log.warn("Could not roll back partially provisioned user {}: {}", userId,
                    cleanupEx.getMessage());
        }
    }

    /** Assign a realm role to a user (idempotent from Keycloak's side). */
    public void assignRealmRole(String userId, String roleName) {
        Map<String, Object> role;
        try {
            role = admin().get().uri("/admin/realms/{realm}/roles/{role}", props.getRealm(), roleName)
                    .retrieve()
                    .body(new org.springframework.core.ParameterizedTypeReference<Map<String, Object>>() {});
        } catch (RestClientResponseException ex) {
            throw new KeycloakAdminException(ex.getStatusCode().value(),
                    "Realm role '" + roleName + "' not found in Keycloak");
        }
        try {
            admin().post().uri("/admin/realms/{realm}/users/{id}/role-mappings/realm",
                            props.getRealm(), userId)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(List.of(Map.of("id", role.get("id"), "name", role.get("name"))))
                    .retrieve()
                    .toBodilessEntity();
        } catch (RestClientResponseException ex) {
            throw upstreamError("role assignment", ex);
        }
    }

    // ---- queries -------------------------------------------------------------

    /**
     * Wie viele Konten eine Abfrage je Kundenbereich höchstens holt. Meldet Keycloak so viele, kann die Liste
     * abgeschnitten sein — {@code ZugriffBestandLaeufer} setzt dann KEINEN Stichtag (UEMS AP-03, Befund E12).
     */
    public static final int MAX_KONTEN_JE_KUNDENBEREICH = 1000;

    /** All users carrying the given {@code tenant_id} attribute. */
    public List<KeycloakUser> listUsersForTenant(UUID tenantId) {
        List<Map<String, Object>> users;
        try {
            users = admin().get()
                    .uri(uriBuilder -> uriBuilder.path("/admin/realms/{realm}/users")
                            .queryParam("q", "tenant_id:" + tenantId)
                            .queryParam("briefRepresentation", false)
                            .queryParam("max", MAX_KONTEN_JE_KUNDENBEREICH)
                            .build(props.getRealm()))
                    .retrieve()
                    .body(new org.springframework.core.ParameterizedTypeReference<List<Map<String, Object>>>() {});
        } catch (RestClientResponseException ex) {
            throw upstreamError("user listing", ex);
        }
        List<KeycloakUser> result = new ArrayList<>();
        if (users != null) {
            String want = tenantId.toString();
            for (Map<String, Object> u : users) {
                // The `q` attribute filter can be fuzzy; keep only exact tenant matches.
                if (want.equals(tenantOf(u))) {
                    result.add(project(u));
                }
            }
        }
        return result;
    }

    /** Fetch a single user by id. */
    public KeycloakUser getUser(String userId) {
        try {
            Map<String, Object> u = admin().get()
                    .uri("/admin/realms/{realm}/users/{id}", props.getRealm(), userId)
                    .retrieve()
                    .body(new org.springframework.core.ParameterizedTypeReference<Map<String, Object>>() {});
            return project(u);
        } catch (RestClientResponseException ex) {
            throw new KeycloakAdminException(ex.getStatusCode().value(),
                    "User not found: " + userId);
        }
    }

    /**
     * Set a new password for a user (the support lever - without SMTP there is
     * no self-service reset, so this is how a customer who forgot their password
     * gets back in). {@code temporary} forces a password change on the next
     * login. Also lifts any brute-force lockout so the new password works
     * immediately instead of being refused until the escalating wait expires.
     */
    public void resetPassword(String userId, String password, boolean temporary) {
        try {
            admin().put().uri("/admin/realms/{realm}/users/{id}/reset-password",
                            props.getRealm(), userId)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(Map.of("type", "password", "value", password, "temporary", temporary))
                    .retrieve()
                    .toBodilessEntity();
        } catch (RestClientResponseException ex) {
            throw upstreamError("password reset", ex);
        }
        clearBruteForceLockout(userId);
        log.info("Reset password for user {} (temporary={})", userId, temporary);
    }

    /**
     * Lift a temporary brute-force lockout. Best-effort: a failure here only
     * means the lock expires on its own, so it must never fail the reset that
     * triggered it.
     */
    public void clearBruteForceLockout(String userId) {
        try {
            admin().delete().uri("/admin/realms/{realm}/attack-detection/brute-force/users/{id}",
                            props.getRealm(), userId)
                    .retrieve()
                    .toBodilessEntity();
        } catch (RuntimeException ex) {
            log.warn("Could not clear brute-force lockout for user {}: {}", userId, ex.getMessage());
        }
    }

    /**
     * Update a user's profile (email/name). The username is the login identity
     * and stays untouched; sending only the changed fields keeps Keycloak's
     * other attributes (incl. {@code tenant_id}) as they are.
     */
    public KeycloakUser updateProfile(String userId, String email, String firstName,
            String lastName) {
        Map<String, Object> body = new java.util.HashMap<>();
        body.put("email", email == null || email.isBlank() ? null : email.trim());
        body.put("firstName", firstName == null || firstName.isBlank() ? null : firstName.trim());
        body.put("lastName", lastName == null || lastName.isBlank() ? null : lastName.trim());
        try {
            admin().put().uri("/admin/realms/{realm}/users/{id}", props.getRealm(), userId)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body)
                    .retrieve()
                    .toBodilessEntity();
        } catch (RestClientResponseException ex) {
            if (ex.getStatusCode().value() == 409) {
                throw new KeycloakAdminException(409, "A user with that email already exists");
            }
            throw upstreamError("user update", ex);
        }
        return getUser(userId);
    }

    /** Permanently delete a user (their login stops working immediately). */
    public void deleteUser(String userId) {
        try {
            admin().delete().uri("/admin/realms/{realm}/users/{id}", props.getRealm(), userId)
                    .retrieve()
                    .toBodilessEntity();
        } catch (RestClientResponseException ex) {
            throw upstreamError("user deletion", ex);
        }
        log.info("Deleted user {}", userId);
    }

    /** Enable/disable a user (disabling blocks their logins immediately). */
    public KeycloakUser setEnabled(String userId, boolean enabled) {
        try {
            admin().put().uri("/admin/realms/{realm}/users/{id}", props.getRealm(), userId)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(Map.of("enabled", enabled))
                    .retrieve()
                    .toBodilessEntity();
        } catch (RestClientResponseException ex) {
            throw upstreamError("user update", ex);
        }
        return getUser(userId);
    }

    // ---- internals -----------------------------------------------------------

    /**
     * Maps an upstream Keycloak error to a {@link KeycloakAdminException} with a
     * FIXED message. The raw response body is kept in the server log only - it
     * must never travel in the exception message, which controllers use as the
     * customer-visible {@code ResponseStatusException} reason (latent leak once
     * someone flips {@code server.error.include-message: always}).
     */
    private static KeycloakAdminException upstreamError(String operation,
            RestClientResponseException ex) {
        log.warn("Keycloak {} failed with status {}: {}", operation,
                ex.getStatusCode().value(), ex.getResponseBodyAsString());
        return new KeycloakAdminException(ex.getStatusCode().value(),
                "Keycloak " + operation + " failed");
    }

    @SuppressWarnings("unchecked")
    private String tenantOf(Map<String, Object> user) {
        Object attrs = user.get("attributes");
        if (attrs instanceof Map<?, ?> m && m.get("tenant_id") instanceof List<?> vals && !vals.isEmpty()) {
            return String.valueOf(vals.get(0));
        }
        return null;
    }

    private KeycloakUser project(Map<String, Object> u) {
        return new KeycloakUser(
                String.valueOf(u.get("id")),
                (String) u.get("username"),
                (String) u.get("email"),
                (String) u.get("firstName"),
                (String) u.get("lastName"),
                !Boolean.FALSE.equals(u.get("enabled")),
                tenantOf(u));
    }

    private static String extractId(URI location) {
        if (location == null) {
            throw new KeycloakAdminException(502, "Keycloak did not return a Location for the new user");
        }
        String path = location.getPath();
        return path.substring(path.lastIndexOf('/') + 1);
    }

    /** A RestClient request spec pre-loaded with a valid admin bearer token. */
    private RestClient admin() {
        String token = accessToken();
        return http.mutate()
                .defaultHeaders(h -> h.setBearerAuth(token))
                .build();
    }

    private synchronized String accessToken() {
        if (cachedToken != null && Instant.now().isBefore(cachedTokenExpiry)) {
            return cachedToken;
        }
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "client_credentials");
        form.add("client_id", props.getClientId());
        form.add("client_secret", props.getClientSecret());

        Map<String, Object> token;
        try {
            token = http.post()
                    .uri("/realms/{realm}/protocol/openid-connect/token", props.getRealm())
                    .header(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_FORM_URLENCODED_VALUE)
                    .body(form)
                    .retrieve()
                    .body(new org.springframework.core.ParameterizedTypeReference<Map<String, Object>>() {});
        } catch (RestClientResponseException ex) {
            log.warn("Keycloak admin token request failed with status {}: {}",
                    ex.getStatusCode().value(), ex.getResponseBodyAsString());
            throw new KeycloakAdminException(ex.getStatusCode().value(),
                    "Could not obtain Keycloak admin token (check the service-account roles)");
        }
        if (token == null || token.get("access_token") == null) {
            throw new KeycloakAdminException(502, "Keycloak returned no admin access_token");
        }
        cachedToken = (String) token.get("access_token");
        long expiresIn = token.get("expires_in") instanceof Number n ? n.longValue() : 60L;
        cachedTokenExpiry = Instant.now().plusSeconds(Math.max(10, expiresIn - 30));
        return cachedToken;
    }
}
