package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Broker;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Hysteresis;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Mapping;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Protection;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.ProtectionDirection;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Result;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.SocDerivation;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.SocParams;
import com.voltpilot.api.entities.EntityTypeCatalog;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Die Regeln des SCHUTZ-/GRENZBAUSTEINS (P5c, Konzept
 * {@code vp-deye-diybms-luecke-l5} §3.2b „OPTIONAL - Schutz-/Grenzbaustein"
 * und §3.3) - ohne Docker und ohne Spring.
 *
 * <p>Die Treppen und Schwellen kommen aus den GETEILTEN Vektoren, nicht aus
 * einer Kopie in diesem Test: dieselbe Datei fährt der JavaScript-Zwilling
 * durch die echte Rechnung und der Go-Zwilling durch die echte Wächter-Kappe.
 *
 * <p><b>Der Kern, der hier bewiesen wird:</b> ein Schutz, der nichts prüft,
 * wird abgelehnt; ein Kanal hat genau EINEN Autor; eine Treppe ohne Ladestand
 * und ein Riegel ohne Zellspannung werden benannt abgelehnt statt still
 * gespeichert; und der generierte Flow trägt am ENDE der Kette den
 * Schutz-Knoten - ohne jeden Schreibpfad.
 */
class UserDefinedBatteryProtectionTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final EntityTypeCatalog CATALOG = new EntityTypeCatalog(MAPPER);
    private static final JsonNode VECTORS = readVectors();

    private static JsonNode readVectors() {
        Path p = Path.of("../../docs/contracts/v2/limit-protection-vectors.json");
        try {
            return MAPPER.readTree(Files.readString(p));
        } catch (IOException e) {
            throw new IllegalStateException("limit-protection-vectors.json nicht lesbar: " + p, e);
        }
    }

    private static Map<String, String> allowed() {
        EntityTypeCatalog.EntityType type =
                CATALOG.find(UserDefinedBatteryDefinition.ENTITY_TYPE);
        Map<String, String> out = new LinkedHashMap<>();
        for (JsonNode m : type.defaultMeasure()) {
            out.put(m.path("channel").asText(), m.path("unit").asText(""));
        }
        return out;
    }

    private static Broker lan() {
        return new Broker("192.168.40.20", 1883);
    }

    /** Die zwei Zellspannungs-Zuordnungen des Kundenfalls. */
    private static List<Mapping> cells() {
        List<Mapping> out = new ArrayList<>();
        out.add(new Mapping("cell_min_mv", "emon/diybms/+/+", "voltage", "min", "number",
                1000.0, 0.0, null, 300, null, null));
        out.add(new Mapping("cell_max_mv", "emon/diybms/+/+", "voltage", "max", "number",
                1000.0, 0.0, null, 300, null, null));
        return out;
    }

    /** Die Kennlinien-Ableitung, die dem Schutz seinen Ladestand liefert. */
    private static SocDerivation ocv() {
        JsonNode curves = curveVectors();
        return new SocDerivation(UserDefinedBatteryDefinition.SOC_OCV_CURVE, true,
                UserDefinedBatteryDefinition.SOC_INPUT_DEFAULTS,
                new SocParams(pairs(curves.path("curve_charge")),
                        pairs(curves.path("curve_discharge")), 176, true, 0.1, null, null, null,
                        null, null, null),
                null, UserDefinedBatteryDefinition.DEFAULT_HOLD_S);
    }

    private static JsonNode curveVectors() {
        try {
            return MAPPER.readTree(Files.readString(
                    Path.of("../../docs/contracts/v2/soc-derivation-vectors.json")))
                    .path("vorlage");
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private static List<double[]> pairs(JsonNode raw) {
        List<double[]> out = new ArrayList<>();
        for (JsonNode p : raw) {
            out.add(new double[] {p.get(0).asDouble(), p.get(1).asDouble()});
        }
        return out;
    }

    /** Der Schutz des Kundenflows, VERBATIM aus den geteilten Vektoren. */
    private static Protection kundenSchutz() {
        JsonNode v = VECTORS.path("vorlage");
        return new Protection(direction(v.path("charge")), direction(v.path("discharge")),
                hysteresis(v.path("hysteresis")), Map.of(),
                v.path("round_a").asDouble(), UserDefinedBatteryDefinition.DEFAULT_HOLD_S, null);
    }

    private static ProtectionDirection direction(JsonNode node) {
        return new ProtectionDirection(pairs(node.path("steps")), node.path("max_a").asDouble());
    }

    private static Hysteresis hysteresis(JsonNode h) {
        return new Hysteresis(h.path("charge_stop_v").asDouble(),
                h.path("charge_resume_v").asDouble(), h.path("discharge_stop_v").asDouble(),
                h.path("discharge_resume_v").asDouble());
    }

    private static Result validate(List<Mapping> mappings, SocDerivation soc, Protection prot) {
        return UserDefinedBatteryDefinition.validate(
                UserDefinedBatteryDefinition.TRANSPORT_MQTT, lan(), null, null, mappings, null,
                soc, allowed(), null, prot);
    }

    // -- Der Kundenfall ------------------------------------------------------

    /**
     * Der Fall, für den es P5c gibt: Zellspannungen per MQTT, Ladestand aus der
     * Kennlinie, und daraus die Grenzen und Freigaben - die vier Kanäle stehen
     * danach als Fähigkeiten der Batterie da, obwohl sie NIEMAND sendet.
     */
    @Test
    void derKundenschutzErgibtVierKanaele() {
        Result def = validate(cells(), ocv(), kundenSchutz());
        assertThat(def.errors()).isEmpty();
        assertThat(def.protection()).isNotNull();
        assertThat(def.protection().channels()).containsExactly(
                UserDefinedBatteryDefinition.CHARGE_LIMIT_CHANNEL,
                UserDefinedBatteryDefinition.DISCHARGE_LIMIT_CHANNEL,
                UserDefinedBatteryDefinition.CHARGE_ALLOWED_CHANNEL,
                UserDefinedBatteryDefinition.DISCHARGE_ALLOWED_CHANNEL);
        // Sie sind Kanäle der Batterie: sonst könnte die Speiser-Bindung (P6)
        // genau das nicht einspeisen, wofür es diesen Baustein gibt.
        assertThat(def.channels()).contains(
                UserDefinedBatteryDefinition.CHARGE_LIMIT_CHANNEL,
                UserDefinedBatteryDefinition.DISCHARGE_ALLOWED_CHANNEL);
        // Die Eingänge sind VOLLSTÄNDIG gefüllt - danach rät niemand mehr.
        assertThat(def.protection().inputs()).containsEntry("soc", "soc_pct")
                .containsEntry("cell_min", "cell_min_mv").containsEntry("cell_max", "cell_max_mv");
    }

    /** Die Treppe ist Stufe für Stufe die des Belegs, aufsteigend sortiert. */
    @Test
    void dieTreppeIstStufeFuerStufeDerBeleg() {
        Result def = validate(cells(), ocv(), kundenSchutz());
        JsonNode want = VECTORS.path("vorlage").path("charge").path("steps");
        List<double[]> got = def.protection().charge().steps();
        assertThat(got).hasSize(want.size());
        for (int i = 0; i < want.size(); i++) {
            assertThat(got.get(i)[0]).isEqualTo(want.get(i).get(0).asDouble());
            assertThat(got.get(i)[1]).isEqualTo(want.get(i).get(1).asDouble());
        }
        assertThat(def.protection().charge().maxA()).isEqualTo(40.0);
    }

    // -- Die Ablehnungen -----------------------------------------------------

    /** Ein Schutz ohne Treppe UND ohne Riegel prüft nichts. */
    @Test
    void einSchutzOhneTreppeUndOhneRiegelWirdAbgelehnt() {
        Result def = validate(cells(), ocv(), new Protection(null, null, null, Map.of(), 1.0,
                900, null));
        assertThat(def.ok()).isFalse();
        assertThat(String.join(" ", def.errors())).contains("prüft nichts");
    }

    /**
     * ⚠ Ein Kanal hat genau EINEN Autor. Wer {@code charge_limit_a} schon aus
     * seinem BMS liest, bekommt ihn nicht zusätzlich gerechnet - zwei Schreiber
     * auf einem Kanal ergäben eine Historie, in der die Zustellreihenfolge
     * entscheidet, welche Grenze galt.
     */
    @Test
    void einKanalHatGenauEinenAutor() {
        List<Mapping> mappings = cells();
        mappings.add(new Mapping("charge_limit_a", "emon/diybms/status", "cl", "last", "number",
                1.0, 0.0, null, 300, null, null));
        Result def = validate(mappings, ocv(), kundenSchutz());
        assertThat(def.ok()).isFalse();
        assertThat(String.join(" ", def.errors()))
                .contains("charge_limit_a").contains("eine Quelle");
    }

    /**
     * Eine Treppe ohne Ladestand rechnet nie etwas aus - sie anzunehmen hiesse,
     * eine Grenze zu versprechen, die ausbleibt.
     */
    @Test
    void eineTreppeOhneLadestandWirdAbgelehnt() {
        // Keine Ableitung, kein zugeordnetes soc_pct - nur Zellspannungen.
        Protection nurTreppe = new Protection(kundenSchutz().charge(), null, null, Map.of(),
                1.0, 900, null);
        Result def = validate(cells(), null, nurTreppe);
        assertThat(def.ok()).isFalse();
        assertThat(String.join(" ", def.errors())).contains("braucht einen Ladestand");
    }

    /**
     * Der RIEGEL dagegen braucht KEINEN Ladestand - ein Hartstopp steht auf der
     * Zellspannung allein. Das ist die halbe Begründung dafür, dass der Schutz
     * ein eigener Baustein ist.
     */
    @Test
    void einRiegelBrauchtKeinenLadestand() {
        Protection nurRiegel = new Protection(null, null, kundenSchutz().hysteresis(), Map.of(),
                1.0, 900, null);
        Result def = validate(cells(), null, nurRiegel);
        assertThat(def.errors()).isEmpty();
        assertThat(def.protection().channels()).containsExactly(
                UserDefinedBatteryDefinition.CHARGE_LIMIT_CHANNEL,
                UserDefinedBatteryDefinition.DISCHARGE_LIMIT_CHANNEL,
                UserDefinedBatteryDefinition.CHARGE_ALLOWED_CHANNEL,
                UserDefinedBatteryDefinition.DISCHARGE_ALLOWED_CHANNEL);
    }

    /** Ein Riegel ohne seine Zellspannung könnte nie auslösen. */
    @Test
    void einRiegelOhneZellspannungWirdAbgelehnt() {
        List<Mapping> nurSoc = new ArrayList<>();
        nurSoc.add(new Mapping("soc_pct", "emon/pack", "soc", "last", "number", 1.0, 0.0, null,
                300, null, null));
        Result def = validate(nurSoc, null, new Protection(null, null,
                new Hysteresis(4.06, 4.0, null, null), Map.of(), 1.0, 900, null));
        assertThat(def.ok()).isFalse();
        assertThat(String.join(" ", def.errors())).contains("höchste Zellspannung");
    }

    /**
     * Eine Freigabe ÜBER der Abschaltung wäre keine Hysterese, sondern ein
     * Riegel, der sich im Moment des Zuschiebens selbst wieder öffnet.
     */
    @Test
    void eineVerkehrteHystereseWirdAbgelehnt() {
        Result verkehrtLaden = validate(cells(), ocv(), new Protection(null, null,
                new Hysteresis(4.0, 4.06, null, null), Map.of(), 1.0, 900, null));
        assertThat(verkehrtLaden.ok()).isFalse();
        assertThat(String.join(" ", verkehrtLaden.errors())).contains("UNTER");

        Result verkehrtEntladen = validate(cells(), ocv(), new Protection(null, null,
                new Hysteresis(null, null, 3.5, 3.4), Map.of(), 1.0, 900, null));
        assertThat(verkehrtEntladen.ok()).isFalse();
        assertThat(String.join(" ", verkehrtEntladen.errors())).contains("ÜBER");
    }

    /** Eine halbe Hysterese ist keine: beide Spannungen oder keine. */
    @Test
    void eineHalbeHystereseWirdAbgelehnt() {
        Result def = validate(cells(), ocv(), new Protection(null, null,
                new Hysteresis(4.06, null, null, null), Map.of(), 1.0, 900, null));
        assertThat(def.ok()).isFalse();
        assertThat(String.join(" ", def.errors())).contains("BEIDE Spannungen");
    }

    /** Eine doppelte Schwelle wäre zweideutig. */
    @Test
    void eineDoppelteSchwelleWirdAbgelehnt() {
        Result def = validate(cells(), ocv(), new Protection(
                new ProtectionDirection(List.of(new double[] {5, 270}, new double[] {5, 22}), 40),
                null, null, Map.of(), 1.0, 900, null));
        assertThat(def.ok()).isFalse();
        assertThat(String.join(" ", def.errors())).contains("steht zweimal");
    }

    /** Eine Treppe ohne Geräte-Maximum ist nur die halbe Aussage. */
    @Test
    void eineTreppeOhneGeraeteMaximumWirdAbgelehnt() {
        Result def = validate(cells(), ocv(), new Protection(
                new ProtectionDirection(List.of(new double[] {5, 270}), Double.NaN),
                null, null, Map.of(), 1.0, 900, null));
        assertThat(def.ok()).isFalse();
        assertThat(String.join(" ", def.errors())).contains("Geräte-Maximum");
    }

    /** Ohne Schutz-Block bleibt alles, wie es vor P5c war. */
    @Test
    void ohneSchutzBlockAendertSichNichts() {
        Result def = validate(cells(), ocv(), null);
        assertThat(def.errors()).isEmpty();
        assertThat(def.protection()).isNull();
        assertThat(def.channels()).doesNotContain(
                UserDefinedBatteryDefinition.CHARGE_LIMIT_CHANNEL);
    }

    // -- Der generierte Flow -------------------------------------------------

    /**
     * Der Schutz-Knoten hängt am ENDE der Kette (hinter dem SoC-Ableiter, weil
     * seine Treppe den abgeleiteten Ladestand braucht) und trägt KEINEN
     * Schreibpfad: das Dokument enthält nur Grenzen, Schwellen und Kanäle.
     */
    @Test
    void derGenerierteFlowHaengtDenSchutzAnsEndeDerKette() {
        Result def = validate(cells(), ocv(), kundenSchutz());
        UUID entity = UUID.fromString("8c4d0e32-9f50-4b67-ad18-1234567890bc");
        JsonNode doc = new UserDefinedBatteryFlowCompiler(MAPPER).compile(
                UUID.randomUUID(), UUID.randomUUID(), entity, 1, "DIYBMS 176s", def);

        List<String> types = new ArrayList<>();
        for (JsonNode n : doc.path("nodes")) {
            types.add(n.path("type").asText());
        }
        assertThat(types).containsExactly("vp.mqtt.read", "vp.soc.derive", "vp.bms.limit");

        List<String> edges = new ArrayList<>();
        for (JsonNode e : doc.path("edges")) {
            edges.add(e.path("from").path("node").asText() + "->" + e.path("to").path("node")
                    .asText());
        }
        assertThat(edges).containsExactly("mqtt->soc", "soc->limit");

        JsonNode limit = doc.path("nodes").get(2).path("parameters");
        assertThat(limit.path("charge").path("max_a").asDouble()).isEqualTo(40.0);
        assertThat(limit.path("hysteresis").path("charge_stop_v").asDouble()).isEqualTo(4.06);
        assertThat(limit.path("hysteresis").path("discharge_resume_v").asDouble()).isEqualTo(3.5);
        assertThat(limit.path("round_a").asDouble()).isEqualTo(1.0);
        assertThat(limit.path("hold_s").asInt()).isEqualTo(900);
        // ⚠ NICHTS im Dokument schreibt: kein Register, keine Adresse, kein
        // Kommando. Der Schutz stellt Grenzen BEREIT, mehr nicht.
        assertThat(doc.toString()).doesNotContain("register").doesNotContain("command")
                .doesNotContain("actuate");
    }

    /**
     * Determinismus: dieselbe Definition ergibt ein BYTE-GLEICHES Dokument -
     * sonst erzeugte jedes Speichern einen neuen {@code content_hash} und die
     * Box rollte grundlos neu aus.
     */
    @Test
    void derGenerierteFlowIstDeterministisch() {
        Result def = validate(cells(), ocv(), kundenSchutz());
        UUID entity = UUID.fromString("8c4d0e32-9f50-4b67-ad18-1234567890bc");
        UUID site = UUID.fromString("00000000-0000-0000-0000-000000000002");
        UUID tenant = UUID.fromString("00000000-0000-0000-0000-000000000001");
        UserDefinedBatteryFlowCompiler compiler = new UserDefinedBatteryFlowCompiler(MAPPER);
        assertThat(compiler.compile(site, tenant, entity, 1, "DIYBMS", def).toString())
                .isEqualTo(compiler.compile(site, tenant, entity, 1, "DIYBMS", def).toString());
    }

    /**
     * Ohne SoC-Ableitung hängt der Schutz DIREKT am Lese-Knoten - der Riegel
     * braucht keinen Ladestand, und die Kette bleibt linear.
     */
    @Test
    void ohneAbleitungHaengtDerSchutzAmLeseKnoten() {
        Protection nurRiegel = new Protection(null, null, kundenSchutz().hysteresis(), Map.of(),
                1.0, 900, null);
        Result def = validate(cells(), null, nurRiegel);
        JsonNode doc = new UserDefinedBatteryFlowCompiler(MAPPER).compile(
                UUID.randomUUID(), UUID.randomUUID(),
                UUID.fromString("8c4d0e32-9f50-4b67-ad18-1234567890bc"), 1, "DIYBMS", def);
        assertThat(doc.path("edges").get(0).path("from").path("node").asText()).isEqualTo("mqtt");
        assertThat(doc.path("edges").get(0).path("to").path("node").asText()).isEqualTo("limit");
    }
}
