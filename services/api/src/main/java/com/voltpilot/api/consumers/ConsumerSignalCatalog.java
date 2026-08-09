package com.voltpilot.api.consumers;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * The server-side catalog of condition signals a consumer policy may reference
 * (docs/verbrauchssteuerung.md §5.3/§10: "Signalnamen kommen aus einem
 * serverseitigem Katalog"). It is the ONE truth the {@link ConsumerPolicyValidator}
 * validates against and the {@code consumer-options} endpoint serves to the
 * portal question tree - so the wizard offers exactly the signals the validator
 * accepts. Its TS twin is {@code frontend/portal/src/consumers/signals.ts}; both
 * sides are pinned by the shared vectors (consumer-policy-vectors.json).
 *
 * <p>Signal CLASS is load-bearing (D1, "die Cloud bepreist, der Edge begrenzt"):
 * CLOUD signals (day-ahead price / full import price) are compiled to concrete
 * UTC windows and therefore carry NO hysteresis and NO {@code max_age_s}; LOCAL
 * signals (SoC, PV-surplus, grid-flow, device availability) are evaluated at the
 * edge and MAY carry both. A stale local value is {@code unknown}, never 0.
 */
@Component
public class ConsumerSignalCatalog {

    /** cloud = compiled to windows (no hysteresis); local = evaluated at the edge. */
    public record Signal(String name, String label, String signalClass, String valueType) {}

    public static final String CLASS_CLOUD = "cloud";
    public static final String CLASS_LOCAL = "local";
    public static final String VALUE_NUMBER = "number";
    public static final String VALUE_BOOLEAN = "boolean";

    private static final Map<String, Signal> SIGNALS = new LinkedHashMap<>();

    static {
        add("market.spot_price_ct_kwh", "Börsenpreis (ct/kWh)", CLASS_CLOUD, VALUE_NUMBER);
        add("market.import_price_ct_kwh", "Mein Bezugspreis (ct/kWh)", CLASS_CLOUD, VALUE_NUMBER);
        add("storage.soc_pct", "Speicher-Ladestand (%)", CLASS_LOCAL, VALUE_NUMBER);
        add("site.pv_surplus_kw", "PV-Überschuss (kW)", CLASS_LOCAL, VALUE_NUMBER);
        add("site.grid_power_kw", "Netzbezug/-einspeisung (kW)", CLASS_LOCAL, VALUE_NUMBER);
        add("consumer.vehicle_connected", "Fahrzeug verbunden", CLASS_LOCAL, VALUE_BOOLEAN);
        add("consumer.available", "Gerät verfügbar", CLASS_LOCAL, VALUE_BOOLEAN);
    }

    private static void add(String name, String label, String signalClass, String valueType) {
        SIGNALS.put(name, new Signal(name, label, signalClass, valueType));
    }

    /** The signal, or null when unknown (rejected by the validator). */
    public Signal find(String name) {
        return name == null ? null : SIGNALS.get(name);
    }

    /** Whether this signal is compiled in the cloud (no hysteresis / no max_age). */
    public boolean isCloud(String name) {
        Signal s = find(name);
        return s != null && CLASS_CLOUD.equals(s.signalClass());
    }

    /** All signals in declaration order (served to the portal question tree). */
    public List<Signal> all() {
        return List.copyOf(SIGNALS.values());
    }
}
