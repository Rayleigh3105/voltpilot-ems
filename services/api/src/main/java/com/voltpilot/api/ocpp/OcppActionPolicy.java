package com.voltpilot.api.ocpp;

import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.web.dto.OcppDto;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Component;

/**
 * D4 server-side policy for the command gateway. The UI map is only an
 * explanation, never authority.
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

    public OcppDto.ActionPermissions permissions(Authentication auth) {
        boolean platform = has(auth, "ROLE_platform-admin");
        // ROLE_admin is the installed legacy tenant-admin role. Keep it as an
        // alias so existing realms/users gain exactly the D4 site-admin level
        // without a flag day; new assignments use the explicit site-admin.
        boolean siteAdmin = platform || has(auth, "ROLE_site-admin") || has(auth, "ROLE_admin");
        // AP-03 IP-3: new customer accounts carry no realm role; a customer account (valid
        // tenant_id, neither partner nor platform) keeps exactly the level operator has. IP-7
        // moves all three levels onto the Zuweisung (E13).
        boolean customer = siteAdmin || has(auth, "ROLE_operator")
                || has(auth, KeycloakRealmRoleConverter.KONTO_BENUTZER);
        Map<String, Boolean> out = new LinkedHashMap<>();
        put(out, CUSTOMER, customer);
        put(out, SITE_ADMIN, siteAdmin);
        put(out, PLATFORM, platform);
        out.put("SetChargingProfile", false);
        out.put("ClearChargingProfile", false);
        return new OcppDto.ActionPermissions(out);
    }

    public boolean allowed(Authentication auth, String action) {
        return Boolean.TRUE.equals(permissions(auth).actions().get(action));
    }

    private static boolean has(Authentication auth, String authority) {
        return auth != null && auth.getAuthorities().stream().anyMatch(a -> authority.equals(a.getAuthority()));
    }

    private static void put(Map<String, Boolean> target, String[] actions, boolean value) {
        for (String action : actions) target.put(action, value);
    }
}
