package com.voltpilot.api.provisioning;

import java.util.regex.Pattern;

/**
 * Topic layout + ref validation of the zero-touch provisioning handshake
 * (docs/contracts/mqtt-provisioning.schema.json). The ref pattern keeps refs
 * MQTT-topic-safe (no '/', '+', '#'), so interpolating them into topics is safe.
 */
public final class ProvisioningTopics {

    /** Mirrors $defs/ref in the provisioning contract. */
    public static final Pattern REF = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");

    private ProvisioningTopics() {
    }

    public static boolean isValidRef(String ref) {
        return ref != null && REF.matcher(ref).matches();
    }

    public static String configTopic(String ref) {
        return "provision/" + ref + "/config";
    }

    public static String helloTopic(String ref) {
        return "provision/" + ref + "/hello";
    }

    /**
     * The retained dispatch-plan topic of a claimed device
     * (docs/contracts/mqtt-schedule.schema.json). Needed here for the unclaim
     * cleanup: clearing the retained schedule lets the physical device fall
     * back to its watchdog default.
     */
    public static String scheduleTopic(java.util.UUID tenantId, java.util.UUID siteId,
            java.util.UUID deviceId) {
        return "ems/" + tenantId + "/" + siteId + "/" + deviceId + "/schedule";
    }

    /** The additive v2 plan has its own retained slot; clearing v1 never clears it. */
    public static String planV2Topic(java.util.UUID tenantId, java.util.UUID siteId,
            java.util.UUID deviceId) {
        return "ems/" + tenantId + "/" + siteId + "/" + deviceId + "/v2/plan";
    }

    /**
     * The ad-hoc Cloud -> Edge command topic of a claimed device (down-only in
     * the broker ACL, like schedule/config). Used for the retained
     * {@code purge_data} command (docs/contracts/mqtt-data-purge.schema.json).
     */
    public static String commandTopic(java.util.UUID tenantId, java.util.UUID siteId,
            java.util.UUID deviceId) {
        return "ems/" + tenantId + "/" + siteId + "/" + deviceId + "/command";
    }
}
