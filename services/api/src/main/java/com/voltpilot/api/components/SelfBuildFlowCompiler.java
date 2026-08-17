package com.voltpilot.api.components;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.components.SelfBuildDefinition.NormalizedChannel;
import com.voltpilot.api.components.SelfBuildDefinition.Transport;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Der Compiler der Selbstbau-Tür: aus EINER Geräte-Definition wird EIN
 * generierter Lese-Flow (Einheitsmodell Stufe 3, Konzept
 * vp-modbus-baukasten-k6 §2.2, Vertrags-Entscheid D-21).
 *
 * <p><b>Er erfindet keinen Baustein.</b> Je Kanal entsteht genau ein
 * {@code vp.modbus.read} - der Katalog-Knoten, den es seit MB-M1 gibt, mit
 * seinem optionalen {@code {entity_id, channel}}-Mapping. Damit hängt die ganze
 * Kette dahinter unverändert: gepufferter v2-Uplink mit Original-Zeitstempel →
 * {@code telemetry_v2} → Rollups → Historie → Messwerte-Explorer. Es gibt keine
 * zweite Ingest-Mechanik und keinen zweiten Ausrollweg.
 *
 * <p><b>Die Herkunft ist der einzige Unterschied zu einem Kunden-Flow.</b> Sie
 * schaltet hier NICHTS frei (ein Lese-Flow trägt nur freie Bausteine) - sie
 * sagt, dass die Plattform diesen Flow besitzt: das Portal öffnet den
 * Geräte-Assistenten statt des Flow-Editors, und die Fassung, aus der der
 * Leseplan entstand, steht daneben. Die Fassung IST die Flow-Version, also
 * bringt ein Rollback der Definition automatisch ihren eigenen Leseplan zurück.
 *
 * <p><b>Determinismus ist tragend</b> (die Golden-Artefakt-Regel): dieselbe
 * Definition ergibt ein BYTE-GLEICHES Dokument - feste Feldreihenfolge, die
 * Flow-Id aus der Komponenten-Id abgeleitet, keine Uhr und kein Zufall.
 * Andernfalls erzeugte jeder Speichervorgang einen neuen {@code content_hash}
 * und die Box würde grundlos neu ausrollen.
 */
@Component
public class SelfBuildFlowCompiler {

    /** Der Katalog-Baustein, aus dem ein Selbstbau-Gerät liest. */
    private static final String READ_NODE = "vp.modbus.read";
    private static final String READ_NODE_VERSION = "1.0.0";
    private static final String SWITCH_NODE = "vp.modbus.switch";

    private final ObjectMapper mapper;

    public SelfBuildFlowCompiler(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    /**
     * Die feste Flow-Id EINES Selbstbau-Geräts.
     *
     * <p>Abgeleitet statt gewürfelt, damit jede weitere Fassung DENSELBEN Flow
     * ersetzt ({@code upsertGenerated}) statt einen zweiten anzulegen - sonst
     * sammelte eine Anlage mit jeder Bearbeitung einen weiteren, nie
     * abgeräumten Flow an.
     */
    public static UUID generatedFlowId(UUID entityId) {
        return UUID.nameUUIDFromBytes(
                ("vp-modbus-device:" + entityId).getBytes(StandardCharsets.UTF_8));
    }

    /**
     * Baut das Flow-Dokument.
     *
     * @param entityId die Komponente, deren Messkanäle die Ziele sind
     * @param version die Definitions-Fassung; sie IST die Flow-Version
     */
    public ObjectNode compile(UUID siteId, UUID tenantId, UUID entityId, int version, String label,
            Transport transport, List<NormalizedChannel> channels) {
        return compile(siteId, tenantId, entityId, version, label, transport, channels, null);
    }

    /**
     * Baut das Flow-Dokument, seit Einheitsmodell Stufe 4 optional MIT dem
     * freigegebenen Schalter.
     *
     * <p>⚠ Der Schalter kommt in DENSELBEN Flow wie die Lese-Knoten, nicht in
     * einen zweiten: zwei Flows auf einem Gerät wären zwei TCP-Pfade dorthin,
     * und genau das ist die Kollision, an der schon einmal ein ganzer
     * Lesezyklus gestorben ist. Die {@code origin} bleibt unverändert
     * {@code modbus-device} - sie ist es, die flowc den generated-only
     * Schalt-Baustein überhaupt erlaubt.
     *
     * @param released die freigegebene Schalt-Definition, oder {@code null}
     *     solange nichts freigegeben ist - dann entsteht KEIN Schalt-Knoten,
     *     und das Gerät ist auf der Box strukturell ein Sensor.
     */
    public ObjectNode compile(UUID siteId, UUID tenantId, UUID entityId, int version, String label,
            Transport transport, List<NormalizedChannel> channels,
            SwitchDefinition.NormalizedSwitch released) {
        ObjectNode doc = mapper.createObjectNode();
        doc.put("schema_version", "1.0");
        doc.put("flow_id", generatedFlowId(entityId).toString());
        doc.put("flow_version", version);
        doc.put("name", flowName(label));
        doc.put("runtime", "edge");
        doc.put("site_id", siteId.toString());
        doc.put("tenant_id", tenantId.toString());

        ObjectNode origin = doc.putObject("origin");
        origin.put("kind", "modbus-device");
        origin.put("point_id", entityId.toString());
        origin.put("definition_version", version);

        var nodes = doc.putArray("nodes");
        int i = 0;
        for (NormalizedChannel c : channels) {
            i++;
            ObjectNode node = nodes.addObject();
            // Die Knoten-Id ist positionsfrei ableitbar und stabil, solange die
            // Kanal-Reihenfolge stabil ist - sie ist es, weil die Definition
            // die Liste in ihrer gespeicherten Reihenfolge liefert.
            node.put("id", "ch" + i);
            node.put("type", READ_NODE);
            node.put("type_version", READ_NODE_VERSION);
            node.put("label", c.label());
            ObjectNode p = node.putObject("parameters");
            p.put("host", transport.host().trim());
            p.put("port", transport.effectivePort());
            p.put("unit_id", transport.effectiveUnitId());
            p.put("register_kind", c.registerKind());
            p.put("address", c.address());
            p.put("data_type", c.dataType());
            p.put("word_order", c.wordOrder());
            p.put("scale", c.scale());
            p.put("offset", c.offset());
            p.put("min_read_interval_s", c.minReadIntervalS());
            // Das Mapping ist der ganze Zweck: ohne es liefe der Flow, ohne
            // dass irgendwo ein Messwert entsteht.
            p.put("entity_id", entityId.toString());
            p.put("channel", c.slug());
        }

        // Ein Lese-Flow hat keine Verdrahtung: jeder Kanal steht für sich, und
        // der Auslöser wird von flowc an JEDEN auslösbaren Knoten gehängt.
        if (released != null) {
            ObjectNode node = nodes.addObject();
            node.put("id", "schalter");
            node.put("type", SWITCH_NODE);
            node.put("type_version", READ_NODE_VERSION);
            node.put("label", "Schalten");
            ObjectNode p = node.putObject("parameters");
            p.put("entity_id", entityId.toString());
            p.put("kind", released.kind());
            p.put("host", transport.host().trim());
            p.put("port", transport.effectivePort());
            p.put("unit_id", transport.effectiveUnitId());
            p.put("fc", released.writeFc());
            p.put("address", released.address());
            if (SwitchDefinition.KIND_ON_OFF.equals(released.kind())) {
                p.put("on_value", released.onValue());
                p.put("off_value", released.offValue());
            } else {
                p.put("min_value", released.minValue());
                p.put("max_value", released.maxValue());
                p.put("safe_value", released.safeValue());
                p.put("scale", released.scale());
                p.put("offset", released.offset());
            }
            if (released.readbackAddress() != null) {
                p.put("readback_address", released.readbackAddress());
            }
            if (released.watchdogAddress() != null) {
                p.put("watchdog_address", released.watchdogAddress());
                p.put("watchdog_value", released.watchdogValue());
            }
            ObjectNode claim = node.putArray("claims").addObject();
            claim.put("entity_id", entityId.toString());
            claim.putArray("commands").add(SwitchDefinition.KIND_SETPOINT.equals(released.kind())
                    ? "setpoint_kw" : "on_off");
        }
        doc.putArray("edges");

        ObjectNode trigger = doc.putArray("triggers").addObject();
        trigger.put("id", "takt");
        trigger.put("kind", "interval");
        // Der Takt ist der SCHNELLSTE Kanal-Wunsch; die langsameren bremsen
        // sich selbst über ihr eigenes min_read_interval_s. Ein Takt je Kanal
        // wäre die Alternative - aber flowc verdrahtet jeden Auslöser mit
        // JEDEM auslösbaren Knoten, sie würden sich also gegenseitig antreiben.
        trigger.put("every_s", triggerInterval(channels));
        return doc;
    }

    /** Der Name, unter dem der Flow in der Geräte-Liste erscheint. */
    public static String flowName(String label) {
        String l = label == null ? "" : label.trim();
        return "Gerät: " + (l.isEmpty() ? "Eigenes Modbus-Gerät" : l);
    }

    private static int triggerInterval(List<NormalizedChannel> channels) {
        return channels.stream().mapToInt(NormalizedChannel::minReadIntervalS)
                .min().orElse(SelfBuildDefinition.DEFAULT_INTERVAL_S);
    }
}
