package com.voltpilot.api.components;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Broker;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.NormalizedMapping;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Der Compiler des BMS-unabhängigen Batterie-Anschlusses: aus EINER
 * Anschluss-Definition wird EIN generierter Lese-Flow (P5 Ebene 1, Konzept
 * {@code vp-deye-diybms-luecke-l5} §3.2b).
 *
 * <p>Er ist der Zwilling von {@link SelfBuildFlowCompiler} und folgt seiner
 * Disziplin Punkt für Punkt - mit EINEM Unterschied, der die ganze Stufe
 * ausmacht:
 *
 * <p><b>EIN Knoten je Gerät, nicht einer je Kanal.</b> Der Modbus-Baukasten
 * baut je Kanal ein {@code vp.modbus.read}, weil jede Lesung ein eigener
 * Registerzugriff ist. Hier ist es umgekehrt: alle Zuordnungen leben an EINER
 * Broker-Verbindung, und zwei Zuordnungen auf demselben Topic-Filter
 * ({@code min} und {@code max} über {@code emon/diybms/+/+}) teilen sich EIN
 * Abo. Ein Knoten je Kanal wäre eine zweite Verbindung zum selben Broker -
 * genau die Kollision, die dieses Produkt schon einmal einen Lesezyklus
 * gekostet hat.
 *
 * <p><b>Determinismus ist tragend</b> (die Golden-Artefakt-Regel): dieselbe
 * Definition ergibt ein BYTE-GLEICHES Dokument - feste Feldreihenfolge, die
 * Flow-Id aus der Komponenten-Id abgeleitet, keine Uhr und kein Zufall.
 * Andernfalls erzeugte jeder Speichervorgang einen neuen {@code content_hash}
 * und die Box würde grundlos neu ausrollen.
 *
 * <p><b>Die Herkunft {@code mqtt-device} ist load-bearing:</b> sie ist es, die
 * flowc den generated-only Baustein {@code vp.mqtt.read} überhaupt erlaubt.
 * Ein Kundendokument mit diesem Baustein wird abgelehnt - die api ist sein
 * einziger Autor, solange es die Zuordnungs-Fläche mit Live-Vorschau (P5d)
 * noch nicht gibt.
 */
@Component
public class UserDefinedBatteryFlowCompiler {

    /** Der Katalog-Baustein, aus dem eine selbst angebundene Batterie liest. */
    private static final String READ_NODE = "vp.mqtt.read";
    private static final String READ_NODE_VERSION = "1.0.0";

    /** Die Herkunfts-Art dieses generierten Flows (flow-graph.schema.json). */
    public static final String ORIGIN_KIND = "mqtt-device";

    private final ObjectMapper mapper;

    public UserDefinedBatteryFlowCompiler(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    /**
     * Die feste Flow-Id EINER selbst angebundenen Batterie.
     *
     * <p>Abgeleitet statt gewürfelt, damit jede weitere Fassung DENSELBEN Flow
     * ersetzt ({@code upsertGenerated}) statt einen zweiten anzulegen.
     */
    public static UUID generatedFlowId(UUID entityId) {
        return UUID.nameUUIDFromBytes(
                ("vp-mqtt-battery:" + entityId).getBytes(StandardCharsets.UTF_8));
    }

    /**
     * Baut das Flow-Dokument.
     *
     * @param entityId die Batterie, deren Messkanäle die Ziele sind
     * @param version die Definitions-Fassung; sie IST die Flow-Version
     */
    public ObjectNode compile(UUID siteId, UUID tenantId, UUID entityId, int version, String label,
            Broker broker, List<NormalizedMapping> mappings, int publishIntervalS) {
        ObjectNode doc = mapper.createObjectNode();
        doc.put("schema_version", "1.0");
        doc.put("flow_id", generatedFlowId(entityId).toString());
        doc.put("flow_version", version);
        doc.put("name", flowName(label));
        doc.put("runtime", "edge");
        doc.put("site_id", siteId.toString());
        doc.put("tenant_id", tenantId.toString());

        ObjectNode origin = doc.putObject("origin");
        origin.put("kind", ORIGIN_KIND);
        origin.put("point_id", entityId.toString());
        origin.put("definition_version", version);

        ObjectNode node = doc.putArray("nodes").addObject();
        node.put("id", "mqtt");
        node.put("type", READ_NODE);
        node.put("type_version", READ_NODE_VERSION);
        node.put("label", label == null || label.isBlank() ? "Batterie" : label.trim());
        ObjectNode p = node.putObject("parameters");
        p.put("host", broker.host().trim());
        p.put("port", broker.effectivePort());
        p.put("entity_id", entityId.toString());
        ArrayNode list = p.putArray("mappings");
        for (NormalizedMapping m : mappings) {
            ObjectNode n = list.addObject();
            n.put("channel", m.channel());
            n.put("topic", m.topic());
            n.put("path", m.path());
            n.put("aggregate", m.aggregate());
            n.put("value_type", m.valueType());
            n.put("scale", m.scale());
            n.put("offset", m.offset());
            // Ein Sentinel wird nur geschrieben, wenn es einen gibt: ein Feld
            // mit einem erfundenen „nicht gemessen"-Wert würde echte Messungen
            // verschlucken.
            if (m.sentinel() != null) {
                n.put("sentinel", m.sentinel());
            }
            n.put("stale_s", m.staleS());
            if (!m.trueValues().isEmpty()) {
                ArrayNode t = n.putArray("true_values");
                m.trueValues().forEach(t::add);
            }
            if (!m.falseValues().isEmpty()) {
                ArrayNode f = n.putArray("false_values");
                m.falseValues().forEach(f::add);
            }
        }

        doc.putArray("edges");
        ObjectNode trigger = doc.putArray("triggers").addObject();
        trigger.put("id", "takt");
        trigger.put("kind", "interval");
        // Der Takt IST der Sendeabstand: das Abo läuft dauernd und füllt den
        // Puffer, veröffentlicht wird im Takt. Ein zweiter Kadenz-Begriff im
        // Knoten wäre eine Vorgabe, die der Takt jederzeit widerlegen könnte.
        trigger.put("every_s", publishIntervalS);
        return doc;
    }

    /** Der Name, unter dem der Flow in der Geräte-Liste erscheint. */
    public static String flowName(String label) {
        String l = label == null ? "" : label.trim();
        return "Batterie: " + (l.isEmpty() ? "Selbst angebundene Batterie" : l);
    }
}
