package com.voltpilot.api.components;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.math.BigDecimal;

/**
 * Die Fähigkeiten + Schutz-Konfiguration, mit der eine ÜBER DEN ANLEGE-WEG
 * entstandene Komponente startet (Einheitsmodell Stufe 1).
 *
 * <p>Sie liegt in einer eigenen Klasse, seit die Bestands-Übernahme (Stufe 2)
 * derselbe zweite Schreiber ist: eine übernommene Komponente muss zeichengleich
 * so entstehen wie eine im Portal angelegte, sonst hätte dieselbe Anlage je nach
 * Entstehungsweg zwei verschiedene Fähigkeiten-Blöcke.
 *
 * <p><b>Nur-lesend, immer.</b> Es gibt hier bewusst kein {@code actuate} und
 * keinen freigebenden Failsafe - „Steuern freigeben" ist der getrennte Schritt
 * einer späteren Stufe, und eine Komponente, die schon beim Anlegen schreiben
 * dürfte, hätte diese Trennung nie gehabt.
 */
public final class ComponentDefaults {

    private ComponentDefaults() {
    }

    /** Die Messkanäle, die eine Komponente dieser Rolle liefert. */
    public static String capabilities(ObjectMapper mapper, String role) {
        String channel = ComponentService.ROLE_ERZEUGER.equals(role) ? "pv_power_kw" : "power_kw";
        ObjectNode caps = mapper.createObjectNode();
        caps.set("measure", mapper.createArrayNode().add(measure(mapper, channel)));
        return write(mapper, caps);
    }

    /**
     * Die Schutz-Konfiguration. Ein Erzeuger bekommt seine Nennleistung als
     * Obergrenze (sie weitet zugleich die physikalische Plausibilitäts-Hülle der
     * Box), alles andere ist reine Messung.
     */
    public static String guards(ObjectMapper mapper, String role, BigDecimal capacityKwp) {
        ObjectNode guards = mapper.createObjectNode();
        ObjectNode limits = guards.putObject("limits");
        if (ComponentService.ROLE_ERZEUGER.equals(role) && capacityKwp != null) {
            limits.put("max_generation_kw", capacityKwp.doubleValue());
        }
        guards.putObject("failsafe").put("behavior",
                ComponentService.ROLE_ERZEUGER.equals(role) ? "release" : "measure-only");
        return write(mapper, guards);
    }

    private static JsonNode measure(ObjectMapper mapper, String channel) {
        return mapper.createObjectNode().put("channel", channel).put("unit", "kW");
    }

    private static String write(ObjectMapper mapper, Object value) {
        try {
            return mapper.writeValueAsString(value);
        } catch (Exception e) {
            throw new IllegalStateException("cannot serialize component defaults", e);
        }
    }
}
