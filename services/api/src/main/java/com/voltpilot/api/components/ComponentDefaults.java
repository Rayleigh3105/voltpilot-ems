package com.voltpilot.api.components;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.entities.EntityTypeCatalog;
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
 * <p><b>⚠ Die Messkanäle kommen aus dem TYPKATALOG, nie aus einem Rollen-Default.</b>
 * Bis 09.09.2026 schrieb diese Klasse für JEDE Rolle außer Erzeuger genau
 * {@code power_kw}. Ein über den Assistenten entstandener Wechselrichter
 * ({@code battery-hybrid}) verlor damit {@code soc_pct},
 * {@code battery_power_kw} und {@code pv_power_kw} - im Energiefluss-Schaltbild
 * fehlte der PV-Knoten ganz und der Speicher-Knoten blieb leer („Cockpit zeigt
 * kein PV", Scout {@code data/vp-deye-diybms-luecke-l5} §2.2/§3.1). Dieselbe
 * Anlage aus dem v1→v2-Bootstrap trug die drei Kanäle, weil
 * {@code EntityRegistryService.batteryCapabilities} sie aus dem Speicher-Asset
 * komponiert. Der Katalog ({@code entitytypes/catalog.json},
 * {@code default_measure}) ist die EINE Wahrheit - beide Entstehungswege lesen
 * jetzt dieselbe Quelle.
 *
 * <p><b>Nur-lesend, immer.</b> Es gibt hier bewusst kein {@code actuate} und
 * keinen freigebenden Failsafe - „Steuern freigeben" ist der getrennte Schritt
 * einer späteren Stufe, und eine Komponente, die schon beim Anlegen schreiben
 * dürfte, hätte diese Trennung nie gehabt. Das {@code default_actuate} des
 * Katalogs wird deshalb bewusst NICHT übernommen.
 */
public final class ComponentDefaults {

    private ComponentDefaults() {
    }

    /**
     * Die Messkanäle, die eine Komponente dieses Entitätstyps liefert - wörtlich
     * die {@code default_measure}-Liste des Typkatalogs (samt Einheit: der
     * Ladestand ist {@code %}, nicht {@code kW}).
     *
     * <p>Die Rolle ist nur noch der RÜCKFALL für einen Typ, den der Katalog gar
     * nicht kennt: eine Komponente ohne jede Fähigkeit wäre auf jeder Fläche
     * unsichtbar, und das wäre eine schlechtere Antwort als der alte Default.
     * Kennt der Katalog den Typ und nennt er KEINEN Kanal (etwa der
     * Selbstbau-Typ {@code modbus-generic}), bleibt die Liste leer - sie zu
     * füllen hieße, eine Messung zu behaupten, die es nicht gibt.
     */
    public static String capabilities(ObjectMapper mapper, EntityTypeCatalog catalog,
            String entityType, String role) {
        ObjectNode caps = mapper.createObjectNode();
        ArrayNode measure = caps.putArray("measure");
        EntityTypeCatalog.EntityType type = catalog == null ? null : catalog.find(entityType);
        if (type == null) {
            measure.add(measure(mapper,
                    ComponentService.ROLE_ERZEUGER.equals(role) ? "pv_power_kw" : "power_kw"));
        } else if (type.defaultMeasure() != null && type.defaultMeasure().isArray()) {
            for (JsonNode m : type.defaultMeasure()) {
                measure.add(m.deepCopy());
            }
        }
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
