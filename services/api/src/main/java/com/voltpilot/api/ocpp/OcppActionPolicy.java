package com.voltpilot.api.ocpp;

import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.uems.RechteAbleitung.OcppStufe;
import com.voltpilot.api.web.dto.OcppDto;
import com.voltpilot.api.zugriff.RechtPruefung;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Component;

/**
 * D4 server-side policy for the command gateway. The UI map is only an
 * explanation, never authority.
 *
 * <p><b>AP-03 IP-7 (E13):</b> the level comes from the ZUWEISUNG at the site's Standort
 * ({@link RechtPruefung#ocppStufe}): CUSTOMER = Unterstützer „Einrichten und Bedienen", SITE_ADMIN =
 * Kundenadministrator and Bedienberechtigt, PLATFORM = VoltPilot. The realm roles {@code operator},
 * {@code admin}, {@code site-admin} carry no meaning there. Without an access context (OIDC off, token without
 * account kind) and at the platform tenant switch, the realm-role mapping below stays exactly as it was.
 */
@Component
public class OcppActionPolicy {
    private static final String[] CUSTOMER = {"RemoteStartTransaction", "RemoteStopTransaction",
            "UnlockConnector"};
    private static final String[] SITE_ADMIN = {"ReserveNow", "CancelReservation",
            "SetChargingProfile", "ClearChargingProfile", "GetCompositeSchedule",
            "ChangeAvailability", "SoftReset", "GetConfiguration", "ChangeConfiguration",
            "ClearCache", "GetLocalListVersion", "SendLocalList", "TriggerMessage"};
    private static final String[] PLATFORM = {"HardReset", "GetDiagnostics", "UpdateFirmware",
            "DataTransfer"};

    public static final java.util.Set<String> ACTIONS = java.util.Set.of(
            "RemoteStartTransaction", "RemoteStopTransaction", "UnlockConnector", "SoftReset",
            "HardReset", "ChangeAvailability", "TriggerMessage", "GetConfiguration",
            "ChangeConfiguration", "ClearCache", "GetDiagnostics", "UpdateFirmware", "ReserveNow",
            "CancelReservation", "GetLocalListVersion", "SendLocalList", "SetChargingProfile",
            "ClearChargingProfile", "GetCompositeSchedule", "DataTransfer");

    private final ObjectProvider<RechtPruefung> pruefung;

    /** Realm roles only — for slices without a database. */
    public OcppActionPolicy() {
        this.pruefung = null;
    }

    @Autowired
    public OcppActionPolicy(ObjectProvider<RechtPruefung> pruefung) {
        this.pruefung = pruefung;
    }

    /** The levels of the caller at ONE site: from the Zuweisung (E13), without access context from the realm roles. */
    public OcppDto.ActionPermissions permissions(Authentication auth, UUID siteId) {
        RechtPruefung p = pruefung == null ? null : pruefung.getIfAvailable();
        Optional<OcppStufe> stufe = p == null ? Optional.empty() : p.ocppStufe(siteId);
        return stufe.map(OcppActionPolicy::permissions).orElseGet(() -> permissions(auth));
    }

    public boolean allowed(Authentication auth, UUID siteId, String action) {
        return Boolean.TRUE.equals(permissions(auth, siteId).actions().get(action));
    }

    /** The action map of one level; KEINE allows nothing. */
    public static OcppDto.ActionPermissions permissions(OcppStufe stufe) {
        boolean platform = stufe == OcppStufe.PLATFORM;
        boolean siteAdmin = platform || stufe == OcppStufe.SITE_ADMIN;
        boolean customer = siteAdmin || stufe == OcppStufe.CUSTOMER;
        return map(customer, siteAdmin, platform);
    }

    /** The realm-role mapping — only where no access context exists (see class comment). */
    public OcppDto.ActionPermissions permissions(Authentication auth) {
        boolean platform = has(auth, "ROLE_platform-admin");
        // ROLE_admin is the installed legacy tenant-admin role. Keep it as an
        // alias so existing realms/users gain exactly the D4 site-admin level
        // without a flag day; new assignments use the explicit site-admin.
        boolean siteAdmin = platform || has(auth, "ROLE_site-admin") || has(auth, "ROLE_admin");
        // AP-03 IP-3: new customer accounts carry no realm role; a customer account (valid
        // tenant_id, neither partner nor platform) keeps exactly the level operator has.
        boolean customer = siteAdmin || has(auth, "ROLE_operator")
                || has(auth, KeycloakRealmRoleConverter.KONTO_BENUTZER);
        return map(customer, siteAdmin, platform);
    }

    public boolean allowed(Authentication auth, String action) {
        return Boolean.TRUE.equals(permissions(auth).actions().get(action));
    }

    private static OcppDto.ActionPermissions map(boolean customer, boolean siteAdmin, boolean platform) {
        Map<String, Boolean> out = new LinkedHashMap<>();
        put(out, CUSTOMER, customer);
        put(out, SITE_ADMIN, siteAdmin);
        put(out, PLATFORM, platform);
        out.put("SetChargingProfile", false);
        out.put("ClearChargingProfile", false);
        return new OcppDto.ActionPermissions(out);
    }

    private static boolean has(Authentication auth, String authority) {
        return auth != null && auth.getAuthorities().stream().anyMatch(a -> authority.equals(a.getAuthority()));
    }

    private static void put(Map<String, Boolean> target, String[] actions, boolean value) {
        for (String action : actions) target.put(action, value);
    }
}
