package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Auth;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Broker;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Endpoint;
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

    // -- Der ZWEITE Lesetyp: HTTP/JSON (P5-HTTP) -----------------------------

    private static final UUID HTTP_ENTITY =
            UUID.fromString("9d5e1f34-2a6b-4c78-8e90-fedcba987654");

    /** Der Vorlagen-Fall „DIYBMS v4 - /ha". */
    private static Result diybmsHttp() {
        List<Mapping> mappings = new ArrayList<>();
        mappings.add(new Mapping("soc_pct", null, "soc", "last", "number", 1.0, 0.0, null, null,
                null, null));
        mappings.add(new Mapping("cell_min_mv", null, "lowcellv", "last", "number", 1.0, 0.0,
                null, null, null, null));
        mappings.add(new Mapping("temp_max_c", null, "modules.*.exttemp", "max", "number", 1.0,
                0.0, -40.0, null, null, null));
        Result def = UserDefinedBatteryDefinition.validate(
                UserDefinedBatteryDefinition.TRANSPORT_HTTP, null,
                new Endpoint("192.168.40.21", 80, "/ha", false, 5000),
                new Auth(UserDefinedBatteryDefinition.AUTH_HEADER, "ApiKey", null, "geheim-123"),
                mappings, 15, null, allowed(), null);
        assertThat(def.errors()).isEmpty();
        return def;
    }

    /**
     * ⚠ DIE Kernregel dieses Lesetyps: das Flow-Dokument ist über
     * {@code GET /sites/{siteId}/flows/{flowId}/versions/{v}} für jeden
     * Portal-Benutzer des Mandanten lesbar. Ein Kennwort darin wäre ein
     * Kennwort im Browser - es reist deshalb NUR im Registry-Push.
     */
    @Test
    void dasFlowDokumentTraegtDieAnmeldeArtAberNIEDasGeheimnis() {
        ObjectNode doc = compiler.compile(SITE, TENANT, HTTP_ENTITY, 1, "DIYBMS v4",
                diybmsHttp());
        JsonNode auth = doc.path("nodes").get(0).path("parameters").path("auth");
        assertThat(auth.path("mode").asText()).isEqualTo("header");
        assertThat(auth.path("header").asText()).isEqualTo("ApiKey");
        assertThat(auth.has("secret")).isFalse();
        assertThat(doc.toString()).doesNotContain("geheim-123");
        assertThat(doc.toString()).doesNotContain(UserDefinedBatteryDefinition.SECRET_FIELD);
    }

    @Test
    void derHttpLesetypBautSeinenEigenenKnotenUndSeineEigeneHerkunft() {
        ObjectNode doc = compiler.compile(SITE, TENANT, HTTP_ENTITY, 1, "DIYBMS v4",
                diybmsHttp());
        assertThat(doc.path("origin").path("kind").asText())
                .isEqualTo(UserDefinedBatteryFlowCompiler.ORIGIN_KIND_HTTP);
        JsonNode node = doc.path("nodes").get(0);
        assertThat(node.path("id").asText()).isEqualTo("http");
        assertThat(node.path("type").asText()).isEqualTo("vp.http.read");
        JsonNode p = node.path("parameters");
        assertThat(p.path("host").asText()).isEqualTo("192.168.40.21");
        assertThat(p.path("port").asInt()).isEqualTo(80);
        assertThat(p.path("path").asText()).isEqualTo("/ha");
        assertThat(p.path("tls").asBoolean()).isFalse();
        assertThat(p.path("timeout_ms").asInt()).isEqualTo(5000);
        // Weder Topic noch Haltbarkeit - dieser Lesetyp hat beides nicht.
        JsonNode mapping = p.path("mappings").get(0);
        assertThat(mapping.has("topic")).isFalse();
        assertThat(mapping.has("stale_s")).isFalse();
        assertThat(mapping.path("path").asText()).isEqualTo("soc");
        // EIN Batterie, EIN Flow: die Flow-Id hängt an der Komponente, nicht am
        // Transport - ein Wechsel der Anschlussart ersetzt den Flow, statt
        // einen zweiten daneben zu stellen.
        assertThat(doc.path("flow_id").asText())
                .isEqualTo(UserDefinedBatteryFlowCompiler.generatedFlowId(HTTP_ENTITY).toString());
    }

    /** Byte-Gleichheit: sonst rollte jeder Speichervorgang grundlos neu aus. */
    @Test
    void derHttpLesetypIstDeterministisch() {
        assertThat(compiler.compile(SITE, TENANT, HTTP_ENTITY, 1, "DIYBMS v4", diybmsHttp())
                .toString())
                .isEqualTo(compiler.compile(SITE, TENANT, HTTP_ENTITY, 1, "DIYBMS v4",
                        diybmsHttp()).toString());
    }

    /**
     * Der VERTRAG des HTTP-Lesetyps: dieselbe Prüfung wie oben, gegen sein
     * eigenes Beispiel - und der Beweis, dass der SoC-Ableiter dahinter
     * unverändert derselbe Baustein ist.
     */
    @Test
    void dasGebauteHttpDokumentHatDieFormSeinesVertragsBeispiels() throws Exception {
        JsonNode fixture = MAPPER.readTree(Files.readString(Path.of("..", "..", "docs",
                "contracts", "v2", "examples", "flow-graph.valid.http-battery.json")));
        List<Mapping> mappings = new ArrayList<>();
        mappings.add(new Mapping("soc_pct", null, "soc", "last", "number", 1.0, 0.0, null, null,
                null, null));
        Result def = UserDefinedBatteryDefinition.validate(
                UserDefinedBatteryDefinition.TRANSPORT_HTTP, null,
                new Endpoint("192.168.40.21", 80, "/ha", false, 5000),
                new Auth(UserDefinedBatteryDefinition.AUTH_HEADER, "ApiKey", null, "geheim"),
                mappings, 15,
                new SocDerivation(UserDefinedBatteryDefinition.SOC_DIRECT, true,
                        UserDefinedBatteryDefinition.SOC_INPUT_DEFAULTS,
                        new SocParams(null, null, null, true, 0.1, null, null, null, null, null,
                                null),
                        null, 900),
                allowed(), null);
        assertThat(def.errors()).isEmpty();
        ObjectNode built = compiler.compile(SITE, TENANT, HTTP_ENTITY, 1, "DIYBMS v4", def);

        assertThat(names(fixture)).containsSubsequence(names(built).toArray(new String[0]));
        assertThat(names(built.path("origin"))).isEqualTo(names(fixture.path("origin")));
        assertThat(names(built.path("nodes").get(0)))
                .isEqualTo(names(fixture.path("nodes").get(0)));
        assertThat(names(built.path("nodes").get(0).path("parameters")))
                .isEqualTo(names(fixture.path("nodes").get(0).path("parameters")));
        assertThat(names(built.path("nodes").get(0).path("parameters").path("auth")))
                .isEqualTo(names(fixture.path("nodes").get(0).path("parameters").path("auth")));
        assertThat(names(built.path("nodes").get(0).path("parameters").path("mappings").get(0)))
                .isEqualTo(names(fixture.path("nodes").get(0).path("parameters")
                        .path("mappings").get(0)));
        // Der SoC-Ableiter dahinter ist WORT FÜR WORT derselbe Baustein.
        assertThat(names(built.path("nodes").get(1)))
                .isEqualTo(names(fixture.path("nodes").get(1)));
        assertThat(names(built.path("edges").get(0)))
                .isEqualTo(names(fixture.path("edges").get(0)));
        assertThat(built.path("edges").get(0).path("from").path("node").asText())
                .isEqualTo("http");
        assertThat(fixture.path("origin").path("kind").asText())
                .isEqualTo(UserDefinedBatteryFlowCompiler.ORIGIN_KIND_HTTP);
    }

    private static List<String> names(JsonNode node) {
        List<String> out = new ArrayList<>();
        node.fieldNames().forEachRemaining(out::add);
        return out;
    }
}
