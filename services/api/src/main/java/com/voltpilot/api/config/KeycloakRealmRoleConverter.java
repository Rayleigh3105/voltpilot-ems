package com.voltpilot.api.config;

import com.voltpilot.api.uems.RechteAbleitung;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.core.convert.converter.Converter;
import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

/**
 * Maps a Keycloak access token's realm roles onto Spring Security authorities so
 * method security ({@code @PreAuthorize("hasRole('platform-admin')")}) works.
 *
 * <p>Keycloak places realm roles under the {@code realm_access.roles} claim.
 * Each role {@code r} becomes an authority {@code ROLE_r}, which is the prefix
 * {@code hasRole(...)} expects. This is intentionally the ONLY thing that turns
 * a token into an authority - tenant scoping stays in {@code TenantFilter}/RLS,
 * role-based platform authorization lives here. The two are orthogonal:
 * customers (tenant-scoped) never gain {@code platform-admin};
 * the platform admin carries no {@code tenant_id} and sees no customer rows via
 * RLS, only the explicit cross-tenant admin API.
 *
 * <p><b>Kontoart (UEMS AP-03 IP-3).</b> Additiv zu den {@code ROLE_*} leitet der Konverter aus
 * dem unveränderten Token genau EINE Kontoart ab ({@code rechte-vectors.json → vokabular.konto})
 * und legt sie als {@code KONTO_<code>} ab:
 * <ul>
 *   <li>{@code KONTO_plattform} — Realm-Rolle {@code platform-admin} (geht vor);</li>
 *   <li>{@code KONTO_partner} — Realm-Rolle {@code partner}, ein Konto OHNE Kundenbereich: auch ein
 *       (fehlkonfiguriertes) {@code tenant_id} macht es nie zum Kundenkonto;</li>
 *   <li>{@code KONTO_benutzer} — sonst ein gültiges {@code tenant_id} (UUID): das Kundenkonto,
 *       gleich ob es die Altbestand-Rolle {@code operator} trägt oder — wie jedes seit IP-3 neu
 *       angelegte — gar keine Realm-Rolle;</li>
 *   <li>keine — etwa das Servicekonto {@code edge-release-publisher}.</li>
 * </ul>
 * Die Realm-Rollen bleiben für heutige Konten zeichengleich; neu ist nur die eine abgeleitete
 * Authority. Welche Rechte ein Kundenkonto hat, entscheidet ab IP-4 die Zuweisung, nie das Token.
 */
public final class KeycloakRealmRoleConverter
        implements Converter<Jwt, AbstractAuthenticationToken> {

    /** Realm-Rolle der Plattform (VoltPilot-Betrieb). */
    public static final String PLATFORM_ADMIN_ROLE = "platform-admin";
    /** Realm-Rolle eines Partner-Kontos (Installateur, AP-03 E7) — nie mit {@code tenant_id}. */
    public static final String PARTNER_ROLE = "partner";
    /** Präfix der abgeleiteten Kontoart. */
    public static final String KONTO_PREFIX = "KONTO_";
    /** Authority eines Kundenkontos: gültiges {@code tenant_id}, weder Partner noch Plattform. */
    public static final String KONTO_BENUTZER = KONTO_PREFIX + RechteAbleitung.Konto.BENUTZER.code();

    private static final String TENANT_CLAIM = "tenant_id";

    @Override
    public AbstractAuthenticationToken convert(Jwt jwt) {
        Collection<GrantedAuthority> authorities = new ArrayList<>();
        Set<String> roles = new LinkedHashSet<>();
        Object realmAccess = jwt.getClaim("realm_access");
        if (realmAccess instanceof Map<?, ?> map && map.get("roles") instanceof List<?> list) {
            for (Object role : list) {
                if (role != null) {
                    authorities.add(new SimpleGrantedAuthority("ROLE_" + role));
                    roles.add(role.toString());
                }
            }
        }
        konto(jwt, roles).ifPresent(konto ->
                authorities.add(new SimpleGrantedAuthority(KONTO_PREFIX + konto.code())));
        return new JwtAuthenticationToken(jwt, authorities);
    }

    /**
     * Die Kontoart des Tokens — allein aus Realm-Rollen und {@code tenant_id}, nie aus einem
     * Header oder Request-Body. Leer, wenn das Token keines der drei Konten ist.
     */
    static Optional<RechteAbleitung.Konto> konto(Jwt jwt, Set<String> roles) {
        if (roles.contains(PLATFORM_ADMIN_ROLE)) {
            return Optional.of(RechteAbleitung.Konto.PLATTFORM);
        }
        if (roles.contains(PARTNER_ROLE)) {
            return Optional.of(RechteAbleitung.Konto.PARTNER);
        }
        return gueltigerTenant(jwt.getClaimAsString(TENANT_CLAIM))
                ? Optional.of(RechteAbleitung.Konto.BENUTZER)
                : Optional.empty();
    }

    private static boolean gueltigerTenant(String raw) {
        if (raw == null || raw.isBlank()) {
            return false;
        }
        try {
            UUID.fromString(raw.trim());
            return true;
        } catch (IllegalArgumentException ex) {
            return false;
        }
    }
}
