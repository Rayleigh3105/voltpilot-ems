package com.voltpilot.api.components;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Auth;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Broker;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Endpoint;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Hysteresis;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.NormalizedMapping;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Protection;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.ProtectionDirection;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Result;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.SocDerivation;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.SocParams;
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
 * <p><b>Seit P5b hängt ein ZWEITER Knoten dahinter</b> (Ebene 2): der
 * SoC-Ableiter {@code vp.soc.derive}. Er hängt an einer KANTE aus dem
 * Lese-Knoten, NICHT am Takt - und das ist die ganze Begründung für die Kante:
 * der Auslöser trifft nur die Quelle, und der Ableiter rechnet auf dem, was sie
 * gerade gesendet hat. Hinge er selbst am Takt, rechnete er auf dem Stand des
 * VORIGEN Taktes, und die Reihenfolge zweier gleichzeitig gefeuerter Knoten ist
 * nichts, worauf man einen Ladestand baut. Ohne Ableitung entsteht der Knoten
 * gar nicht - eine Batterie ohne Ladestand ist ein legitimer Zustand.
 *
 * <p><b>Die Herkunft ist load-bearing:</b> sie ist es, die flowc den
 * generated-only Baustein überhaupt erlaubt - {@code mqtt-device} den
 * {@code vp.mqtt.read}, {@code http-device} den {@code vp.http.read}. Ein
 * Kundendokument mit einem der beiden wird abgelehnt; die api ist ihr einziger
 * Autor, und die Zuordnungs-Fläche ist der Batterie-Assistent, nicht der
 * Flow-Editor.
 *
 * <p><b>Seit P5-HTTP baut derselbe Compiler BEIDE Ebene-1-Lesetypen</b>, und
 * zwar bewusst als EIN Compiler: der Takt, die Kante und der SoC-Ableiter
 * dahinter sind Wort für Wort dieselben - nur der Lese-Knoten wechselt. Zwei
 * Compiler hätten zwei Wahrheiten über die Kante ergeben, an der der Ladestand
 * hängt.
 */
@Component
public class UserDefinedBatteryFlowCompiler {

    /** Der Katalog-Baustein, aus dem eine selbst angebundene Batterie liest. */
    private static final String READ_NODE = "vp.mqtt.read";
    private static final String READ_NODE_VERSION = "1.0.0";

    /** Derselbe Baustein für den ZWEITEN Ebene-1-Lesetyp (P5-HTTP). */
    private static final String HTTP_READ_NODE = "vp.http.read";
    private static final String HTTP_READ_NODE_VERSION = "1.0.0";

    /** Der Katalog-Baustein, der aus diesen Rohwerten den Ladestand ableitet. */
    private static final String SOC_NODE = "vp.soc.derive";
    private static final String SOC_NODE_VERSION = "1.0.0";

    /** Der Katalog-Baustein, der daraus die zulässigen Grenzen ableitet (P5c). */
    private static final String LIMIT_NODE = "vp.bms.limit";
    private static final String LIMIT_NODE_VERSION = "1.0.0";

    /** Die Herkunfts-Art dieses generierten Flows (flow-graph.schema.json). */
    public static final String ORIGIN_KIND = "mqtt-device";

    /**
     * Die Herkunfts-Art des HTTP-Lesetyps - eine EIGENE, obwohl es dieselbe
     * Batterie und derselbe Assistent ist.
     *
     * <p>Der Grund ist keine Ordnungsliebe: ein Ebene-1-Lesetyp, der unter der
     * Herkunft seines Geschwisters gälte, würde ein gefälschtes
     * {@code mqtt-device}-Dokument eine HTTP-Abfrage aufsperren lassen. Der
     * Ableiter {@code vp.soc.derive} gehört dagegen BEIDEN - er rechnet auf den
     * Standard-Kanälen und kennt den Transport gar nicht.
     */
    public static final String ORIGIN_KIND_HTTP = "http-device";

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
     * Baut das Flow-Dokument des MQTT-Lesetyps.
     *
     * @param entityId die Batterie, deren Messkanäle die Ziele sind
     * @param version die Definitions-Fassung; sie IST die Flow-Version
     */
    public ObjectNode compile(UUID siteId, UUID tenantId, UUID entityId, int version, String label,
            Broker broker, List<NormalizedMapping> mappings, int publishIntervalS,
            SocDerivation soc) {
        return compile(siteId, tenantId, entityId, version, label,
                UserDefinedBatteryDefinition.TRANSPORT_MQTT, broker, null, null, mappings,
                publishIntervalS, soc, null);
    }

    /**
     * Baut das Flow-Dokument einer geprüften Definition - für BEIDE Lesetypen.
     *
     * <p>Der bequeme Weg: die {@link Result} weiß selbst, welcher Transport
     * gilt, und beide Hälften bleiben dadurch garantiert konsistent.
     */
    public ObjectNode compile(UUID siteId, UUID tenantId, UUID entityId, int version, String label,
            Result def) {
        return compile(siteId, tenantId, entityId, version, label, def.transport(), def.broker(),
                def.endpoint(), def.authOrNone(), def.mappings(), def.publishIntervalS(),
                def.socDerivation(), def.protection());
    }

    /**
     * Baut das Flow-Dokument, Transport für Transport.
     *
     * <p><b>Was sich unterscheidet, ist genau EIN Knoten.</b> Der Takt, die
     * Kante zum SoC-Ableiter und der Ableiter selbst sind identisch - der
     * Ladestand (P5b) und die Speiser-Bindung (P6) kennen den Transport gar
     * nicht, und genau deshalb gibt es hier keinen Sonderpfad, sondern einen
     * zweiten Lese-Knoten.
     *
     * <p>⚠ Beim HTTP-Lesetyp reist die ART der Anmeldung mit, der WERT nie:
     * dieses Dokument ist über {@code GET
     * /sites/{siteId}/flows/{flowId}/versions/{v}} für jeden Portal-Benutzer des
     * Mandanten lesbar. Das Geheimnis erreicht die Box über den Registry-Push
     * ({@code driver.connection.auth_secret}).
     */
    public ObjectNode compile(UUID siteId, UUID tenantId, UUID entityId, int version, String label,
            String transport, Broker broker, Endpoint endpoint, Auth auth,
            List<NormalizedMapping> mappings, int publishIntervalS, SocDerivation soc,
            Protection protection) {
        boolean http = UserDefinedBatteryDefinition.TRANSPORT_HTTP.equals(transport);
        String readId = http ? "http" : "mqtt";
        ObjectNode doc = mapper.createObjectNode();
        doc.put("schema_version", "1.0");
        doc.put("flow_id", generatedFlowId(entityId).toString());
        doc.put("flow_version", version);
        doc.put("name", flowName(label));
        doc.put("runtime", "edge");
        doc.put("site_id", siteId.toString());
        doc.put("tenant_id", tenantId.toString());

        ObjectNode origin = doc.putObject("origin");
        origin.put("kind", http ? ORIGIN_KIND_HTTP : ORIGIN_KIND);
        origin.put("point_id", entityId.toString());
        origin.put("definition_version", version);

        ObjectNode node = doc.putArray("nodes").addObject();
        node.put("id", readId);
        node.put("type", http ? HTTP_READ_NODE : READ_NODE);
        node.put("type_version", http ? HTTP_READ_NODE_VERSION : READ_NODE_VERSION);
        node.put("label", label == null || label.isBlank() ? "Batterie" : label.trim());
        ObjectNode p = node.putObject("parameters");
        if (http) {
            p.put("host", endpoint.host().trim());
            p.put("port", endpoint.effectivePort());
            p.put("path", endpoint.effectivePath());
            p.put("tls", endpoint.secure());
            p.put("timeout_ms", endpoint.effectiveTimeoutMs());
            p.put("entity_id", entityId.toString());
            ObjectNode a = p.putObject("auth");
            Auth used = auth == null ? UserDefinedBatteryDefinition.NO_AUTH : auth;
            a.put("mode", used.effectiveMode());
            if (UserDefinedBatteryDefinition.AUTH_HEADER.equals(used.effectiveMode())) {
                a.put("header", used.header());
            }
            if (UserDefinedBatteryDefinition.AUTH_BASIC.equals(used.effectiveMode())) {
                // Der Benutzername ist KEIN Geheimnis - das Kennwort reist
                // ausdrücklich nicht hier, sondern im Registry-Push.
                a.put("username", used.username());
            }
        } else {
            p.put("host", broker.host().trim());
            p.put("port", broker.effectivePort());
            p.put("entity_id", entityId.toString());
        }
        ArrayNode list = p.putArray("mappings");
        for (NormalizedMapping m : mappings) {
            ObjectNode n = list.addObject();
            n.put("channel", m.channel());
            if (!http) {
                n.put("topic", m.topic());
            }
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
            // Eine Haltbarkeit gibt es nur beim MQTT-Lesetyp: eine HTTP-Antwort
            // ist EIN Zeitpunkt, und ein stale_s wäre dort die stille Erlaubnis,
            // einen alten Messwert mit frischem Zeitstempel zu senden.
            if (!http) {
                n.put("stale_s", m.staleS());
            }
            if (!m.trueValues().isEmpty()) {
                ArrayNode t = n.putArray("true_values");
                m.trueValues().forEach(t::add);
            }
            if (!m.falseValues().isEmpty()) {
                ArrayNode f = n.putArray("false_values");
                m.falseValues().forEach(f::add);
            }
        }

        ArrayNode edges = doc.putArray("edges");
        String tail = readId;
        if (soc != null) {
            appendSocNode(doc, entityId, soc);
            ObjectNode edge = edges.addObject();
            edge.put("id", readId + "-soc");
            edge.putObject("from").put("node", readId).put("port", "value");
            edge.putObject("to").put("node", "soc").put("port", "channels");
            tail = "soc";
        }
        // Der SCHUTZ-/GRENZBAUSTEIN (P5c) hängt am ENDE derselben KETTE, nie am
        // Takt: seine Treppe braucht den ABGELEITETEN Ladestand, und jede Stufe
        // reicht weiter, was sie weiß. Gibt es keine Ableitung, hängt er direkt
        // am Lese-Knoten - der Riegel steht auf der Zellspannung allein und
        // braucht gar keinen Ladestand.
        if (protection != null) {
            appendLimitNode(doc, entityId, protection);
            ObjectNode edge = edges.addObject();
            edge.put("id", tail + "-limit");
            edge.putObject("from").put("node", tail).put("port", "value");
            edge.putObject("to").put("node", "limit").put("port", "channels");
        }

        ObjectNode trigger = doc.putArray("triggers").addObject();
        trigger.put("id", "takt");
        trigger.put("kind", "interval");
        // Der Takt IST der Sendeabstand: das Abo läuft dauernd und füllt den
        // Puffer, veröffentlicht wird im Takt. Ein zweiter Kadenz-Begriff im
        // Knoten wäre eine Vorgabe, die der Takt jederzeit widerlegen könnte.
        trigger.put("every_s", publishIntervalS);
        return doc;
    }

    /**
     * Der SoC-Ableiter als zweiter Knoten desselben Flows.
     *
     * <p>Er ist VOLLSTÄNDIG ausgeschrieben - jede Vorgabe steht im Artefakt.
     * Danach rät auf der Box niemand mehr an einer Vorgabe herum, und eine
     * geänderte Vorgabe wäre sonst eine stille Verhaltensänderung auf jeder
     * schon ausgerollten Batterie.
     */
    private void appendSocNode(ObjectNode doc, UUID entityId, SocDerivation soc) {
        ObjectNode node = ((ArrayNode) doc.get("nodes")).addObject();
        node.put("id", "soc");
        node.put("type", SOC_NODE);
        node.put("type_version", SOC_NODE_VERSION);
        node.put("label", "Ladestand");
        ObjectNode p = node.putObject("parameters");
        p.put("entity_id", entityId.toString());
        p.put("method", soc.method());
        p.put("prefer_direct", soc.preferDirect());
        p.put("hold_s", soc.holdS());
        ObjectNode inputs = p.putObject("inputs");
        // Feste Feldreihenfolge (TreeMap): dieselbe Definition muss ein
        // BYTE-GLEICHES Dokument ergeben, sonst rollt die Box grundlos neu aus.
        new java.util.TreeMap<>(soc.inputs()).forEach(inputs::put);
        ObjectNode params = p.putObject("params");
        SocParams sp = soc.params();
        putCurve(params, "curve_charge", sp.curveCharge());
        putCurve(params, "curve_discharge", sp.curveDischarge());
        if (sp.cellsInSeries() != null) {
            params.put("cells_in_series", sp.cellsInSeries());
        }
        params.put("conservative_min", sp.conservativeMin());
        params.put("round_pct", sp.roundPct());
        if (sp.capacityKwh() != null) {
            params.put("capacity_kwh", sp.capacityKwh());
        }
        if (sp.efficiencyPct() != null) {
            params.put("efficiency_pct", sp.efficiencyPct());
        }
        if (sp.nominalVoltageV() != null) {
            params.put("nominal_voltage_v", sp.nominalVoltageV());
        }
        if (sp.anchor() != null) {
            ObjectNode anchor = params.putObject("anchor");
            anchor.put("soc_pct", sp.anchor().socPct());
            if (sp.anchor().at() != null && !sp.anchor().at().isBlank()) {
                anchor.put("at", sp.anchor().at().trim());
            }
        }
        if (sp.recalibrate() != null) {
            ObjectNode r = params.putObject("recalibrate");
            if (sp.recalibrate().fullCellMv() != null) {
                r.put("full_cell_mv", sp.recalibrate().fullCellMv());
                r.put("full_soc_pct", sp.recalibrate().fullSocPct());
            }
            if (sp.recalibrate().emptyCellMv() != null) {
                r.put("empty_cell_mv", sp.recalibrate().emptyCellMv());
                r.put("empty_soc_pct", sp.recalibrate().emptySocPct());
            }
        }
    }

    /**
     * Der SCHUTZ-/GRENZBAUSTEIN als letzter Knoten desselben Flows (P5c).
     *
     * <p>Wie beim SoC-Ableiter steht jede Vorgabe AUSGESCHRIEBEN im Artefakt:
     * danach rät auf der Box niemand mehr an einer Vorgabe herum, und eine
     * geänderte Vorgabe wäre sonst eine stille Verhaltensänderung auf jeder
     * schon ausgerollten Batterie - bei einer SCHUTZgrenze die schlechteste
     * Sorte Überraschung.
     *
     * <p>⚠ Der Knoten trägt KEINEN Schreibpfad: er veröffentlicht Grenzen und
     * Freigaben als Telemetrie, mehr nicht. Geräte-Stromgrenzen zu schreiben
     * bleibt einem zertifizierten Steuerpfad vorbehalten.
     */
    private void appendLimitNode(ObjectNode doc, UUID entityId, Protection p) {
        ObjectNode node = ((ArrayNode) doc.get("nodes")).addObject();
        node.put("id", "limit");
        node.put("type", LIMIT_NODE);
        node.put("type_version", LIMIT_NODE_VERSION);
        node.put("label", "Schutzgrenzen");
        ObjectNode par = node.putObject("parameters");
        par.put("entity_id", entityId.toString());
        ObjectNode inputs = par.putObject("inputs");
        // Feste Feldreihenfolge (TreeMap) - dieselbe Definition muss ein
        // BYTE-GLEICHES Dokument ergeben, sonst rollt die Box grundlos neu aus.
        new java.util.TreeMap<>(p.inputs()).forEach(inputs::put);
        putDirection(par, "charge", p.charge());
        putDirection(par, "discharge", p.discharge());
        ObjectNode h = par.putObject("hysteresis");
        Hysteresis hy = p.hysteresis();
        if (hy != null && hy.chargeStopV() != null) {
            h.put("charge_stop_v", hy.chargeStopV());
            h.put("charge_resume_v", hy.chargeResumeV());
        }
        if (hy != null && hy.dischargeStopV() != null) {
            h.put("discharge_stop_v", hy.dischargeStopV());
            h.put("discharge_resume_v", hy.dischargeResumeV());
        }
        par.put("round_a", p.roundA());
        par.put("hold_s", p.holdS());
    }

    /** Eine Strom-Treppe samt Geräte-Maximum - nur, wenn es sie gibt. */
    private static void putDirection(ObjectNode parent, String field, ProtectionDirection dir) {
        if (dir == null) {
            return;
        }
        ObjectNode out = parent.putObject(field);
        ArrayNode steps = out.putArray("steps");
        for (double[] step : dir.steps()) {
            ArrayNode pair = steps.addArray();
            pair.add(step[0]);
            pair.add(step[1]);
        }
        out.put("max_a", dir.maxA());
    }

    /** Eine Kennlinie als Liste von Paaren - nur, wenn es sie gibt. */
    private static void putCurve(ObjectNode params, String field, List<double[]> curve) {
        if (curve == null || curve.isEmpty()) {
            return;
        }
        ArrayNode out = params.putArray(field);
        for (double[] point : curve) {
            ArrayNode pair = out.addArray();
            pair.add(point[0]);
            pair.add(point[1]);
        }
    }

    /** Der Name, unter dem der Flow in der Geräte-Liste erscheint. */
    public static String flowName(String label) {
        String l = label == null ? "" : label.trim();
        return "Batterie: " + (l.isEmpty() ? "Selbst angebundene Batterie" : l);
    }
}
