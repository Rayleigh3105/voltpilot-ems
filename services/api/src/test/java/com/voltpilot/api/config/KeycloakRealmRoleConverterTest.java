package com.voltpilot.api.config;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.uems.RechteAbleitung;
import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.oauth2.jwt.Jwt;

/**
 * Unit test (no Docker/Spring) for the realm-role -> authority mapping that lets
 * {@code @PreAuthorize("hasRole('platform-admin')")} gate the admin API, and for the derived
 * Kontoart of UEMS AP-03 IP-3 (partner without tenant_id -> no customer context).
 */
class KeycloakRealmRoleConverterTest {

    private static final String TENANT = "00000000-0000-0000-0000-000000000001";
    /** What Keycloak puts on every account through {@code default-roles-voltpilot}. */
    private static final List<String> DEFAULTS =
            List.of("default-roles-voltpilot", "offline_access", "uma_authorization");

    private final KeycloakRealmRoleConverter converter = new KeycloakRealmRoleConverter();

    private static Jwt jwtWith(Map<String, Object> claims) {
        return new Jwt("token", Instant.now(), Instant.now().plusSeconds(300),
                Map.of("alg", "none"), claims);
    }

    private Set<String> authorities(Map<String, Object> claims) {
        AbstractAuthenticationToken token = converter.convert(jwtWith(claims));
        return AuthorityUtils.authorityListToSet(token.getAuthorities());
    }

    private static Map<String, Object> realm(List<String> roles) {
        return Map.of("roles", roles);
    }

    private static List<String> mitDefaults(String... roles) {
        return Stream.concat(Stream.of(roles), DEFAULTS.stream()).toList();
    }

    @Test
    void mapsRealmRolesToPrefixedAuthorities() {
        AbstractAuthenticationToken token = converter.convert(
                jwtWith(Map.of("realm_access", Map.of("roles", List.of("platform-admin", "offline_access")))));

        assertThat(AuthorityUtils.authorityListToSet(token.getAuthorities()))
                .contains("ROLE_platform-admin", "ROLE_offline_access");
    }

    @Test
    void tokenWithoutRealmAccessHasNoRoleAuthorities() {
        // No ROLE_* at all. The one derived authority is the customer account kind
        // (AP-03 IP-3): a valid tenant_id without partner/platform role.
        assertThat(authorities(Map.of("tenant_id", TENANT)))
                .noneMatch(a -> a.startsWith("ROLE_"))
                .containsExactly(KeycloakRealmRoleConverter.KONTO_BENUTZER);
    }

    @Test
    void operatorDoesNotGainAdminAuthority() {
        AbstractAuthenticationToken token = converter.convert(
                jwtWith(Map.of("realm_access", Map.of("roles", List.of("operator")))));

        assertThat(AuthorityUtils.authorityListToSet(token.getAuthorities()))
                .containsExactly("ROLE_operator")
                .doesNotContain("ROLE_platform-admin");
    }

    // ---- AP-03 IP-3: das Partner-Konto ---------------------------------------------------

    @Test
    void partnerOhneTenantIdBekommtKeinenKundenkontext() {
        Set<String> partner = authorities(Map.of("sub", "partner-brunner",
                "preferred_username", "partner-brunner", "realm_access", realm(mitDefaults("partner"))));

        assertThat(partner)
                .contains("ROLE_partner", "KONTO_partner")
                .doesNotContain(KeycloakRealmRoleConverter.KONTO_BENUTZER, "KONTO_plattform",
                        "ROLE_operator", "ROLE_platform-admin");
    }

    @Test
    void partnerMitFehlkonfiguriertemTenantIdBleibtOhneKundenkontext() {
        Set<String> partner = authorities(Map.of("sub", "partner-brunner", "tenant_id", TENANT,
                "realm_access", realm(mitDefaults("partner"))));

        assertThat(partner)
                .contains("KONTO_partner")
                .doesNotContain(KeycloakRealmRoleConverter.KONTO_BENUTZER);
    }

    @Test
    void dieKontoKennungenSindDasVokabularDesRechteVertrags() {
        // rechte-vectors.json -> vokabular.konto; the OCPP gates name KONTO_benutzer literally.
        assertThat(KeycloakRealmRoleConverter.KONTO_BENUTZER).isEqualTo("KONTO_benutzer");
        assertThat(Stream.of(RechteAbleitung.Konto.values()).map(RechteAbleitung.Konto::code))
                .containsExactly("benutzer", "partner", "plattform");
    }

    // ---- Bestand: jedes heutige Konto behält seine Authorities zeichengleich --------------

    /**
     * Die heutigen Token-Formen (Realm-Import dev + prod, Admin-Anlage, Registrierung vor IP-3,
     * Servicekonto) mit der Kontoart, die IP-3 zusätzlich ableitet.
     */
    static Stream<Arguments> heutigeKonten() {
        return Stream.of(
                Arguments.of("demo/demo2 (operator)",
                        Map.of("tenant_id", TENANT, "realm_access", realm(mitDefaults("operator"))),
                        "KONTO_benutzer"),
                Arguments.of("Kundenkonto aus Admin-Konsole/Registrierung vor IP-3 (operator)",
                        Map.of("tenant_id", "10000000-0000-0000-0000-000000000001",
                                "realm_access", realm(mitDefaults("operator"))),
                        "KONTO_benutzer"),
                Arguments.of("Kundenkonto ab IP-3 (keine Realm-Rolle)",
                        Map.of("tenant_id", TENANT, "realm_access", realm(DEFAULTS)),
                        "KONTO_benutzer"),
                Arguments.of("Alt-Rolle admin mit tenant_id",
                        Map.of("tenant_id", TENANT, "realm_access", realm(mitDefaults("admin", "operator"))),
                        "KONTO_benutzer"),
                Arguments.of("site-admin mit tenant_id",
                        Map.of("tenant_id", TENANT, "realm_access", realm(mitDefaults("site-admin"))),
                        "KONTO_benutzer"),
                Arguments.of("Plattform-Admin (admin/admin)",
                        Map.of("realm_access", realm(mitDefaults("platform-admin"))),
                        "KONTO_plattform"),
                Arguments.of("Plattform-Admin mit tenant_id (Claim zählt nicht)",
                        Map.of("tenant_id", TENANT, "realm_access", realm(mitDefaults("platform-admin"))),
                        "KONTO_plattform"),
                Arguments.of("Servicekonto edge-release-publisher",
                        Map.of("realm_access", realm(List.of("edge-release-publisher"))),
                        null),
                Arguments.of("operator mit kaputtem tenant_id",
                        Map.of("tenant_id", "kein-uuid", "realm_access", realm(mitDefaults("operator"))),
                        null));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("heutigeKonten")
    void heutigeKontenBehaltenIhreRollenUndBekommenGenauEineKontoart(String konto,
            Map<String, Object> claims, String erwarteteKontoart) {
        Set<String> jetzt = authorities(claims);

        Set<String> rollen = jetzt.stream().filter(a -> !a.startsWith(KeycloakRealmRoleConverter.KONTO_PREFIX))
                .collect(Collectors.toCollection(LinkedHashSet::new));
        assertThat(rollen).as("ROLE_* zeichengleich zur Abbildung vor IP-3").isEqualTo(abbildungVorIp3(claims));

        Set<String> kontoarten = jetzt.stream().filter(a -> a.startsWith(KeycloakRealmRoleConverter.KONTO_PREFIX))
                .collect(Collectors.toSet());
        assertThat(kontoarten).as(konto)
                .isEqualTo(erwarteteKontoart == null ? Set.of() : Set.of(erwarteteKontoart));
    }

    /** Die Abbildung, wie sie vor AP-03 IP-3 im Konverter stand — wörtlich. */
    @SuppressWarnings("unchecked")
    private static Set<String> abbildungVorIp3(Map<String, Object> claims) {
        Set<String> out = new LinkedHashSet<>();
        Object realmAccess = claims.get("realm_access");
        if (realmAccess instanceof Map<?, ?> map && map.get("roles") instanceof List<?> roles) {
            for (Object role : roles) {
                if (role != null) {
                    out.add("ROLE_" + role);
                }
            }
        }
        return out;
    }
}
