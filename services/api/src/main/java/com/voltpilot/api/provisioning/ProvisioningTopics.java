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
}
