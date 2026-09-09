package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Broker;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Mapping;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Result;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.SocDerivation;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.SocParams;
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
                def.mappings(), def.publishIntervalS(), def.socDerivation());
    }

    /** Die Kundenkurven aus den geteilten Vektoren - gelesen, nie kopiert. */
    private static List<double[]> curve(String field) throws Exception {
        JsonNode node = MAPPER.readTree(Files.readString(Path.of("..", "..", "docs", "contracts",
                "v2", "soc-derivation-vectors.json"))).path("vorlage").path(field);
        List<double[]> out = new ArrayList<>();
        for (JsonNode p : node) {
            out.add(new double[] {p.get(0).asDouble(), p.get(1).asDouble()});
        }
        return out;
    }

    /** Der Kundenfall MIT Ableitung: Zellspannungen -> Kennlinie. */
    private static Result diybmsMitKennlinie() throws Exception {
        List<Mapping> mappings = new ArrayList<>();
        mappings.add(new Mapping("cell_min_mv", "emon/diybms/+/+", "voltage", "min", "number",
                1000.0, 0.0, null, 300, null, null));
        mappings.add(new Mapping("cell_max_mv", "emon/diybms/+/+", "voltage", "max", "number",
                1000.0, 0.0, null, 300, null, null));
        SocParams params = new SocParams(curve("curve_charge"), curve("curve_discharge"), 176,
                true, 0.1, null, null, null, 25.0, null, null);
        Result def = UserDefinedBatteryDefinition.validate(new Broker("192.168.40.20", 1883),
                mappings, 15,
                new SocDerivation("ocv_curve", true, Map.of(), params, "diybms-176s-nmc",
                        UserDefinedBatteryDefinition.DEFAULT_HOLD_S),
                allowed());
        assertThat(def.errors()).isEmpty();
        return def;
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
        assertThat(doc.path("edges")).isEmpty();
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
                diybms().mappings(), 15, null);
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
                diybms().mappings(), 30, null);
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
                15, null).path("nodes").get(0).path("parameters").path("mappings").get(0);
        assertThat(m.path("sentinel").asDouble()).isEqualTo(-40.0);
    }

    /**
     * ⚠ P5b: der SoC-Ableiter hängt an einer KANTE hinter dem Lese-Knoten,
     * NICHT am Takt. Der Auslöser trifft nur die Quelle, und der Ableiter
     * rechnet auf dem, was sie gerade gesendet hat - hinge er selbst am Takt,
     * rechnete er auf dem Stand des VORIGEN Taktes.
     */
    @Test
    void dieAbleitungHaengtAnEinerKanteHinterDemLeseKnoten() throws Exception {
        ObjectNode doc = compile(diybmsMitKennlinie());
        assertThat(doc.path("nodes")).hasSize(2);
        JsonNode soc = doc.path("nodes").get(1);
        assertThat(soc.path("id").asText()).isEqualTo("soc");
        assertThat(soc.path("type").asText()).isEqualTo("vp.soc.derive");
        assertThat(doc.path("edges")).hasSize(1);
        assertThat(doc.path("edges").get(0).path("from").path("node").asText()).isEqualTo("mqtt");
        assertThat(doc.path("edges").get(0).path("to").path("node").asText()).isEqualTo("soc");

        // Jede Vorgabe steht AUSGESCHRIEBEN im Dokument - danach rät die Box
        // an keiner Vorgabe mehr herum.
        JsonNode p = soc.path("parameters");
        assertThat(p.path("method").asText()).isEqualTo("ocv_curve");
        assertThat(p.path("prefer_direct").asBoolean()).isTrue();
        assertThat(p.path("hold_s").asInt())
                .isEqualTo(UserDefinedBatteryDefinition.DEFAULT_HOLD_S);
        assertThat(p.path("inputs").path("cell_min").asText()).isEqualTo("cell_min_mv");
        assertThat(p.path("inputs")).hasSize(6);
        assertThat(p.path("params").path("curve_charge")).hasSize(21);
        assertThat(p.path("params").path("curve_discharge")).hasSize(21);
        assertThat(p.path("params").path("conservative_min").asBoolean()).isTrue();
        assertThat(p.path("params").path("cells_in_series").asInt()).isEqualTo(176);
    }

    /**
     * Der ausgelieferte Kurven-Punkt ist BYTE-genau der aus dem Beleg: 3,393 V
     * liegt zwischen 3,37 V/5 % und 3,42 V/10 % der Entladekurve, und daraus
     * rechnet die Box die 7,3 %, die der Kunde in Home Assistant sieht.
     */
    @Test
    void dieKundenkurveReistUNVERAENDERTInDenFlow() throws Exception {
        JsonNode charge = compile(diybmsMitKennlinie()).path("nodes").get(1).path("parameters")
                .path("params").path("curve_charge");
        assertThat(charge.get(0).get(0).asDouble()).isEqualTo(3.26);
        assertThat(charge.get(0).get(1).asDouble()).isEqualTo(0.0);
        assertThat(charge.get(20).get(0).asDouble()).isEqualTo(4.18);
        assertThat(charge.get(20).get(1).asDouble()).isEqualTo(100.0);
    }

    @Test
    void ohneAbleitungEntstehtDerKnotenGarNicht() {
        // Eine Batterie ohne Ladestand ist ein legitimer Zustand - dann gibt es
        // auch keinen Ableiter, der nichts zu rechnen hätte.
        ObjectNode doc = compile(diybms());
        assertThat(doc.path("nodes")).hasSize(1);
        assertThat(doc.path("edges")).isEmpty();
    }

    @Test
    void auchMitAbleitungIstDasDokumentByteGleich() throws Exception {
        assertThat(compile(diybmsMitKennlinie()).toString())
                .isEqualTo(compile(diybmsMitKennlinie()).toString());
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
        ObjectNode built = compile(diybmsMitKennlinie());

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
        // Der ZWEITE Knoten (P5b) Feld für Feld - und seine Kante.
        assertThat(names(built.path("nodes").get(1)))
                .isEqualTo(names(fixture.path("nodes").get(1)));
        assertThat(names(built.path("nodes").get(1).path("parameters")))
                .isEqualTo(names(fixture.path("nodes").get(1).path("parameters")));
        assertThat(names(built.path("edges").get(0)))
                .isEqualTo(names(fixture.path("edges").get(0)));
        assertThat(fixture.path("origin").path("kind").asText())
                .isEqualTo(UserDefinedBatteryFlowCompiler.ORIGIN_KIND);
    }

    private static List<String> names(JsonNode node) {
        List<String> out = new ArrayList<>();
        node.fieldNames().forEachRemaining(out::add);
        return out;
    }
}
