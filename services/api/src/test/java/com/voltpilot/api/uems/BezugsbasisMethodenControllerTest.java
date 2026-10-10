package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.web.BezugsbasisMethodenController;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.yaml.snakeyaml.Yaml;

/**
 * Der Methoden-Katalog der Bezugsbasis (UEMS AP-17 IP-5, §4.5, E4 = A): drei byte-gleiche Kopien — Vertrag,
 * API-Ressource, Portal —, die Route liefert die Ressource Byte für Byte, die Datei erfüllt ihr Schema, trägt die vier
 * Methoden und die Startwerte aus §4.5/G6, und OpenAPI nennt dieselben Felder. Rein — ohne Spring-Kontext, ohne
 * Datenbank.
 */
class BezugsbasisMethodenControllerTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
    private static final Path CONTRACTS = Path.of("..", "..", "docs", "contracts");
    private static final Path VERTRAG = CONTRACTS.resolve(Path.of("v2", "bezugsbasis-methoden.json"));
    private static final Path SCHEMA = CONTRACTS.resolve(Path.of("v2", "bezugsbasis-methoden.schema.json"));
    private static final Path API = Path.of("src", "main", "resources", "bezugsbasis", "bezugsbasis-methoden.json");
    private static final Path PORTAL =
            Path.of("..", "..", "frontend", "portal", "src", "bezugsbasis", "bezugsbasis-methoden.json");

    /** §4.5, in seiner Reihenfolge (E4 = A: vier Methoden, höchstens zwei Einflussgrößen). */
    private static final List<String> VIER =
            List.of("verhaeltnis", "regression_eine_variable", "regression_zwei_variablen", "gradtage");

    @Test
    void dieApiRessourceIstDerVertragByteFuerByte() throws Exception {
        assertThat(Files.readAllBytes(API)).as("beide zusammen ändern").isEqualTo(Files.readAllBytes(VERTRAG));
    }

    @Test
    void diePortalKopieIstByteGleich() throws Exception {
        assertThat(Files.readAllBytes(PORTAL)).as("die Portal-Kopie ist byte-gleich — alle drei zusammen ändern")
                .isEqualTo(Files.readAllBytes(API));
    }

    @Test
    void dieRouteLiefertDieRessourceByteFuerByte() throws Exception {
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new BezugsbasisMethodenController()).build();
        MvcResult r = mvc.perform(get("/api/v1/bezugsbasis-methoden")).andExpect(status().isOk()).andReturn();
        assertThat(MediaType.parseMediaType(r.getResponse().getContentType()).isCompatibleWith(MediaType.APPLICATION_JSON))
                .isTrue();
        assertThat(r.getResponse().getContentAsByteArray()).isEqualTo(Files.readAllBytes(API));
    }

    @Test
    void derKatalogErfuelltSeinSchema() throws Exception {
        assertThat(UemsSchemaLaeufer.verstoesse(lies(VERTRAG), lies(SCHEMA))).isEmpty();
    }

    /** Der Wächter beißt: jede dieser Verletzungen fällt dem Schema auf. */
    @Test
    void dasSchemaBeisst() throws Exception {
        List<Consumer<ObjectNode>> verletzungen = List.of(
                m -> m.remove("grenze"),
                m -> m.put("kennung", "modell"),
                m -> m.put("variablen_anzahl", 3),
                m -> m.put("mindest_perioden_startwert", 0),
                m -> m.put("farbe", "blau"));
        for (Consumer<ObjectNode> verletze : verletzungen) {
            ObjectNode datei = (ObjectNode) lies(VERTRAG);
            verletze.accept((ObjectNode) datei.get("methoden").get(1));
            assertThat(UemsSchemaLaeufer.verstoesse(datei, lies(SCHEMA))).isNotEmpty();
        }
        ObjectNode datei = (ObjectNode) lies(VERTRAG);
        ((ObjectNode) datei.get("parameter")).put("abhaengigkeit_r_startwert", 1.5);
        assertThat(UemsSchemaLaeufer.verstoesse(datei, lies(SCHEMA))).isNotEmpty();
    }

    /**
     * Die vier Methoden aus §4.5 mit ihren Kundenwörtern (§5.8), der Zahl ihrer Variablen und dem Mindestumfang: das
     * Verhältnis rechnet ab einem Monat und ist ab zwölf belastbar, jedes Modell braucht zwölf Monate (G1).
     */
    @Test
    void esSindDieVierMethodenAusParagraf45() throws Exception {
        JsonNode methoden = lies(VERTRAG).path("methoden");
        List<String> kennungen = new ArrayList<>();
        methoden.forEach(m -> kennungen.add(m.path("kennung").asText()));
        assertThat(kennungen).isEqualTo(VIER);
        assertThat(werte(methoden, "kundenwort")).containsExactly("Verhältnis", "Modell mit einer Einflussgröße",
                "Modell mit zwei Einflussgrößen", "Wetterbereinigung über Gradtage");
        assertThat(werte(methoden, "variablen_anzahl")).containsExactly("1", "1", "2", "1");
        assertThat(werte(methoden, "mindest_perioden_startwert")).containsExactly("1", "12", "12", "12");
        assertThat(werte(methoden, "belastbar_ab_monaten_startwert")).containsExactly("12", "12", "12", "12");
        for (JsonNode m : methoden) {
            assertThat(m.path("kennzeichen").asText()).as(m.path("kennung").asText())
                    .contains("bereinigt um").contains("Bezugsbasis BB-…, Fassung n");
        }
    }

    /** G6: 12 Monate, ± 10 %, 0,9, 2 %, 12 Monate Wiedervorlage — Startwerte ohne Norm-Herleitung. */
    @Test
    void dieStartwerteSindDieAusG6() throws Exception {
        JsonNode p = lies(VERTRAG).path("parameter");
        assertThat(p.path("mindest_monate_referenzperiode").asInt()).isEqualTo(12);
        assertThat(p.path("spannweite_prozent_startwert").asDouble()).isEqualTo(10.0);
        assertThat(p.path("abhaengigkeit_r_startwert").asDouble()).isEqualTo(0.9);
        assertThat(p.path("toleranz_prozent_startwert").asDouble()).isEqualTo(2.0);
        assertThat(p.path("wiedervorlage_monate_startwert").asInt()).isEqualTo(12);
        for (JsonNode m : lies(VERTRAG).path("methoden")) {
            assertThat(m.path("belastbar_ab_monaten_startwert").asInt()).as(m.path("kennung").asText())
                    .isEqualTo(p.path("mindest_monate_referenzperiode").asInt());
        }
    }

    /** OpenAPI nennt genau eine GET-Route und dieselben Felder wie das Schema. */
    @Test
    @SuppressWarnings("unchecked")
    void openApiNenntDieRouteUndDieFelderDesSchemas() throws Exception {
        Map<String, Object> openapi;
        try (InputStream in = Files.newInputStream(CONTRACTS.resolve("openapi.yaml"))) {
            openapi = new Yaml().load(in);
        }
        Map<String, Object> pfade = (Map<String, Object>) openapi.get("paths");
        Map<String, Object> schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
        assertThat(((Map<String, Object>) pfade.get("/api/v1/bezugsbasis-methoden")).keySet()).containsExactly("get");
        JsonNode schema = lies(SCHEMA);
        assertThat(eigenschaften(schemas, "BezugsbasisMethoden")).isEqualTo(felder(schema.path("properties")));
        assertThat(eigenschaften(schemas, "BezugsbasisMethode")).isEqualTo(felder(schema.at("/$defs/methode/properties")));
        assertThat(eigenschaften(schemas, "BezugsbasisMethodenParameter"))
                .isEqualTo(felder(schema.at("/$defs/parameter/properties")));
        Map<String, Object> kennung = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) schemas
                .get("BezugsbasisMethode")).get("properties")).get("kennung");
        assertThat((List<String>) kennung.get("enum")).isEqualTo(VIER);
    }

    private static JsonNode lies(Path p) throws Exception {
        return MAPPER.readTree(Files.readString(p));
    }

    private static List<String> werte(JsonNode liste, String feld) {
        List<String> aus = new ArrayList<>();
        liste.forEach(x -> aus.add(x.path(feld).asText()));
        return aus;
    }

    @SuppressWarnings("unchecked")
    private static List<String> eigenschaften(Map<String, Object> schemas, String name) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(name);
        assertThat(s).as(name).isNotNull();
        return new ArrayList<>(((Map<String, Object>) s.get("properties")).keySet());
    }

    private static List<String> felder(JsonNode n) {
        List<String> aus = new ArrayList<>();
        n.fieldNames().forEachRemaining(aus::add);
        return aus;
    }
}
