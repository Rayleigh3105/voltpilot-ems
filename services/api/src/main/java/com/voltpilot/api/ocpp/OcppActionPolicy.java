package com.voltpilot.api.ocpp;

import com.voltpilot.api.web.dto.OcppDto;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Component;

/**
 * D4 as a server-side policy, before a command gateway exists. The dependent
 * PR must ask this policy; the UI map is only an explanation, never authority.
 */
@Component
public class OcppActionPolicy {
    private static final String[] CUSTOMER = {"RemoteStartTransaction", "RemoteStopTransaction",
            "UnlockConnector", "ReserveNow", "CancelReservation", "SetChargingProfile",
            "ClearChargingProfile", "GetCompositeSchedule"};
    private static final String[] SITE_ADMIN = {"ChangeAvailability", "SoftReset", "GetConfiguration",
            "ChangeConfiguration", "ClearCache", "GetLocalListVersion", "SendLocalList",
            "TriggerMessage"};
    private static final String[] PLATFORM = {"HardReset", "GetDiagnostics", "UpdateFirmware",
            "DataTransfer"};

    public OcppDto.ActionPermissions permissions(Authentication auth) {
        boolean platform = has(auth, "ROLE_platform-admin");
        // ROLE_admin is the installed legacy tenant-admin role. Keep it as an
        // alias so existing realms/users gain exactly the D4 site-admin level
        // without a flag day; new assignments use the explicit site-admin.
        boolean siteAdmin = platform || has(auth, "ROLE_site-admin") || has(auth, "ROLE_admin");
        boolean customer = siteAdmin || has(auth, "ROLE_operator");
        Map<String, Boolean> out = new LinkedHashMap<>();
        put(out, CUSTOMER, customer);
        put(out, SITE_ADMIN, siteAdmin);
        put(out, PLATFORM, platform);
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
