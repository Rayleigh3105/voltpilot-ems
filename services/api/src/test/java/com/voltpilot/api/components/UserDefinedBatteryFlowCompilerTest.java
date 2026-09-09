package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Broker;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Mapping;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Result;
import com.voltpilot.api.entities.EntityTypeCatalog;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Der generierte Lese-Flow einer selbst angebundenen Batterie (P5 Ebene 1),
 * ohne Docker und ohne Spring.
 *
 * <p>Das Vertrags-Beispiel {@code flow-graph.valid.mqtt-battery.json} ist der
 * ausführbare Vertrag: was dieser Compiler baut, muss dieselbe FORM haben, die
 * flowc kompiliert und die Box ausführt (die E1a-Fixture-Disziplin - das
 * Verschieben der Beispiel-Datei bricht diesen Test absichtlich).
 */
class UserDefinedBatteryFlowCompilerTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final EntityTypeCatalog CATALOG = new EntityTypeCatalog(MAPPER);
    private final UserDefinedBatteryFlowCompiler compiler =
            new UserDefinedBatteryFlowCompiler(MAPPER);

    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID ENTITY = UUID.fromString("7b3c9d21-8e4f-4a56-9c07-0123456789ab");

    private static Map<String, String> allowed() {
        Map<String, String> out = new LinkedHashMap<>();
        for (JsonNode m : CATALOG.find(UserDefinedBatteryDefinition.ENTITY_TYPE).defaultMeasure()) {
            out.put(m.path("channel").asText(), m.path("unit").asText(""));
        }
        return out;
    }

    private static Result diybms() {
        List<Mapping> mappings = new ArrayList<>();
        mappings.add(new Mapping("cell_min_mv", "emon/diybms/+/+", "voltage", "min", "number",
                1000.0, 0.0, null, 300, null, null));
        mappings.add(new Mapping("cell_max_mv", "emon/diybms/+/+", "voltage", "max", "number",
                1000.0, 0.0, null, 300, null, null));
        mappings.add(new Mapping("charge_allowed", "emon/diybms/status", "charge_allowed", "last",
                "bool", null, null, null, 300, null, null));
        Result def = UserDefinedBatteryDefinition.validate(
                new Broker("192.168.40.20", 1883), mappings, 15, null, allowed());
        assertThat(def.errors()).isEmpty();
        return def;
    }

    private ObjectNode compile(Result def) {
        return compiler.compile(SITE, TENANT, ENTITY, 1, "DIYBMS 176s", def.broker(),
                def.mappings(), def.publishIntervalS());
    }

    /**
     * ⚠ EIN Knoten je Gerät, nicht einer je Kanal. Der Modbus-Baukasten baut
     * je Kanal einen Knoten, weil jede Lesung ein eigener Registerzugriff ist;
     * hier hingen zwei Knoten an ZWEI Verbindungen zum selben Broker - die
     * Kollision, die dieses Produkt schon einmal einen Lesezyklus gekostet hat.
     */
    @Test
    void einGeraetErgibtGenauEINENKnotenMitAllenZuordnungen() {
        ObjectNode doc = compile(diybms());
        assertThat(doc.path("nodes")).hasSize(1);
        JsonNode node = doc.path("nodes").get(0);
        assertThat(node.path("type").asText()).isEqualTo("vp.mqtt.read");
        assertThat(node.path("parameters").path("mappings")).hasSize(3);
        assertThat(node.path("parameters").path("host").asText()).isEqualTo("192.168.40.20");
        assertThat(node.path("parameters").path("entity_id").asText())
                .isEqualTo(ENTITY.toString());
    }

    /**
     * Die Herkunft ist load-bearing: sie ist es, die flowc den generated-only
     * Baustein überhaupt erlaubt. Und die Fassung IST die Flow-Version - ein
     * Rollback der Definition bringt automatisch ihren eigenen Leseplan zurück.
     */
    @Test
    void dieHerkunftIstMqttDeviceUndDieFassungIstDieFlowVersion() {
        ObjectNode doc = compiler.compile(SITE, TENANT, ENTITY, 7, "DIYBMS", diybms().broker(),
                diybms().mappings(), 15);
        assertThat(doc.path("origin").path("kind").asText()).isEqualTo("mqtt-device");
        assertThat(doc.path("origin").path("point_id").asText()).isEqualTo(ENTITY.toString());
        assertThat(doc.path("origin").path("definition_version").asInt()).isEqualTo(7);
        assertThat(doc.path("flow_version").asInt()).isEqualTo(7);
    }

    /**
     * Determinismus ist tragend (die Golden-Artefakt-Regel): sonst erzeugte
     * jeder Speichervorgang einen neuen {@code content_hash} und die Box würde
     * grundlos neu ausrollen.
     */
    @Test
    void dieselbeDefinitionErgibtEinByteGleichesDokument() {
        assertThat(compile(diybms()).toString()).isEqualTo(compile(diybms()).toString());
        assertThat(UserDefinedBatteryFlowCompiler.generatedFlowId(ENTITY))
                .isEqualTo(UserDefinedBatteryFlowCompiler.generatedFlowId(ENTITY))
                .isNotEqualTo(SelfBuildFlowCompiler.generatedFlowId(ENTITY));
    }

    /** Der Takt IST der Sendeabstand - es gibt keinen zweiten Kadenz-Begriff. */
    @Test
    void derAusloeserTraegtDenSendeabstand() {
        ObjectNode doc = compiler.compile(SITE, TENANT, ENTITY, 1, "x", diybms().broker(),
                diybms().mappings(), 30);
        assertThat(doc.path("triggers")).hasSize(1);
        assertThat(doc.path("triggers").get(0).path("every_s").asInt()).isEqualTo(30);
    }

    /**
     * Ein Sentinel wird nur geschrieben, wenn es einen gibt: ein Feld mit einem
     * erfundenen „nicht gemessen"-Wert würde echte Messungen verschlucken.
     */
    @Test
    void einSentinelReistNurWennEsIhnGibt() {
        JsonNode ohne = compile(diybms()).path("nodes").get(0).path("parameters")
                .path("mappings").get(0);
        assertThat(ohne.has("sentinel")).isFalse();

        Result mit = UserDefinedBatteryDefinition.validate(new Broker("192.168.40.20", null),
                List.of(new Mapping("temp_max_c", "emon/diybms/+/+", "external_temp", "max",
                        "number", 1.0, 0.0, -40.0, 300, null, null)),
                15, null, allowed());
        assertThat(mit.errors()).isEmpty();
        JsonNode m = compiler.compile(SITE, TENANT, ENTITY, 1, "x", mit.broker(), mit.mappings(),
                15).path("nodes").get(0).path("parameters").path("mappings").get(0);
        assertThat(m.path("sentinel").asDouble()).isEqualTo(-40.0);
    }

    /**
     * Der VERTRAG: das gebaute Dokument hat dieselbe Form wie das
     * Beispiel-Artefakt, das flowc kompiliert und die Box ausführt. Ein
     * Parameter, den nur eine der beiden Seiten kennt, fällt hier auf.
     */
    @Test
    void dasGebauteDokumentHatDieFormDesVertragsBeispiels() throws Exception {
        JsonNode fixture = MAPPER.readTree(Files.readString(Path.of("..", "..", "docs",
                "contracts", "v2", "examples", "flow-graph.valid.mqtt-battery.json")));
        ObjectNode built = compile(diybms());

        // Das Beispiel traegt zusaetzlich die reinen DOKUMENTATIONS-Felder
        // `description` und `lifecycle` (wie die modbus-device-Fixture); alles,
        // was der Compiler baut, muss es aber in DERSELBEN Reihenfolge fuehren.
        assertThat(names(fixture)).containsSubsequence(names(built).toArray(new String[0]));
        assertThat(names(built.path("origin"))).isEqualTo(names(fixture.path("origin")));
        assertThat(names(built.path("nodes").get(0)))
                .isEqualTo(names(fixture.path("nodes").get(0)));
        assertThat(names(built.path("nodes").get(0).path("parameters")))
                .isEqualTo(names(fixture.path("nodes").get(0).path("parameters")));
        // Die Zuordnungs-Felder: gebaut vs. Vertrag, Feld für Feld.
        assertThat(names(built.path("nodes").get(0).path("parameters").path("mappings").get(0)))
                .isEqualTo(names(fixture.path("nodes").get(0).path("parameters")
                        .path("mappings").get(0)));
        assertThat(fixture.path("origin").path("kind").asText())
                .isEqualTo(UserDefinedBatteryFlowCompiler.ORIGIN_KIND);
    }

    private static List<String> names(JsonNode node) {
        List<String> out = new ArrayList<>();
        node.fieldNames().forEachRemaining(out::add);
        return out;
    }
}
