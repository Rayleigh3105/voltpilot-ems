package com.voltpilot.api.admin;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Connection settings for the Keycloak Admin REST API, used by the platform
 * admin API to provision customer users.
 *
 * <p>The API authenticates to Keycloak as a <b>service account</b>
 * (client_credentials) - the {@code voltpilot-api} confidential client, whose
 * service account is granted the {@code realm-management} roles
 * ({@code manage-users}/{@code view-users}/{@code query-users}) in the realm
 * import. The secret comes from configuration/env only, never hard-coded.
 *
 * <p>{@code baseUrl} is the compose-internal Keycloak URL (e.g.
 * {@code http://keycloak:8080}) so admin calls do not need to resolve the
 * browser-facing {@code localhost:8081} - the same split as the issuer/JWKS fix.
 */
@ConfigurationProperties("voltpilot.keycloak.admin")
public class KeycloakAdminProperties {

    /** Base Keycloak URL reachable from the API (no realm suffix). */
    private String baseUrl = "http://keycloak:8080";
    /** Realm the users live in. */
    private String realm = "voltpilot";
    /** Confidential client whose service account holds realm-management roles. */
    private String clientId = "voltpilot-api";
    /** Client secret (env/config only). */
    private String clientSecret = "voltpilot-api-dev-secret";
    /** Realm role assigned to every provisioned customer (Portal-User). */
    private String customerRole = "operator";

    public String getBaseUrl() {
        return baseUrl;
    }

    public void setBaseUrl(String baseUrl) {
        this.baseUrl = baseUrl;
    }

    public String getRealm() {
        return realm;
    }

    public void setRealm(String realm) {
        this.realm = realm;
    }

    public String getClientId() {
        return clientId;
    }

    public void setClientId(String clientId) {
        this.clientId = clientId;
    }

    public String getClientSecret() {
        return clientSecret;
    }

    public void setClientSecret(String clientSecret) {
        this.clientSecret = clientSecret;
    }

    public String getCustomerRole() {
        return customerRole;
    }

    public void setCustomerRole(String customerRole) {
        this.customerRole = customerRole;
    }
}
