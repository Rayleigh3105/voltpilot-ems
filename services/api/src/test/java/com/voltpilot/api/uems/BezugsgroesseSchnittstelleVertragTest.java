package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.BezugsgroesseDto;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Die Bezugsgrößen-Schnittstelle (UEMS AP-09 IP-5) sagt an drei Stellen dasselbe: im Vertrag
 * ({@code bezugsdaten-vectors.json → verwalten}), in Java ({@link BezugsgroesseRegeln},
 * {@link BezugsgroesseAbgelehnt}, {@link BezugsgroesseDto}) und in {@code docs/contracts/openapi.yaml}.
 * Rein — ohne Spring, ohne Datenbank.
 */
class BezugsgroesseSchnittstelleVertragTest {

    private static final Path CONTRACTS = Path.of("..", "..", "docs", "contracts");
    private static Map<String, Object> schemas;
    private static Map<String, Object> pfade;
    private static JsonNode vertrag;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lies() throws Exception {
        try (InputStream in = Files.newInputStream(CONTRACTS.resolve("openapi.yaml"))) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
            pfade = (Map<String, Object>) openapi.get("paths");
        }
        vertrag = new ObjectMapper().readTree(CONTRACTS.resolve("v2").resolve("bezugsdaten-vectors.json").toFile());
    }

    /** Der geschlossene Satz: Vertrag = Java = OpenAPI, in derselben Reihenfolge. */
    @Test
    void derSatzDerAblehnungenIstUeberallDerselbe() {
        List<String> imVertrag = vertrag.path("verwalten").path("ablehnungen").findValuesAsText("code");
        assertThat(BezugsgroesseAbgelehnt.CODES).containsExactlyElementsOf(imVertrag);
        assertThat(liste(eigenschaft("BezugsgroesseFehler", "code"), "enum")).containsExactlyElementsOf(imVertrag);
        assertThat(liste(eigenschaft("BezugsgroesseFehler", "felder"), "items", "enum"))
                .containsExactlyElementsOf(BezugsgroesseRegeln.FEST_NACH_ERSTEM_WERT);
    }

    /** Die Wörter der Anfrage sind die Vokabulare des Vertrags; die Lesarten die des Blocks `verwalten`. */
    @Test
    void dieWoerterDerAnfrageSindDieDesVertrags() {
        JsonNode vok = vertrag.path("vokabulare");
        assertThat(liste(eigenschaft("BezugsgroesseAnfrage", "wertart"), "enum")).containsExactlyElementsOf(texte(vok.path("wertart")));
        assertThat(liste(eigenschaft("BezugsgroesseAnfrage", "geltung_art"), "enum"))
                .containsExactlyElementsOf(texte(vok.path("geltung_art")));
        assertThat(liste(eigenschaft("BezugsgroesseAnfrage", "periode_art"), "enum"))
                .containsExactlyElementsOf(texte(vok.path("periode_art")));
        assertThat(liste(eigenschaft("Bezugsgroesse", "geltung_art"), "enum"))
                .containsExactlyElementsOf(BezugsgroesseRegeln.GELTUNG_WAEHLBAR);
        assertThat(liste(eigenschaft("BezugsgroesseFassung", "vorgang"), "enum")).containsExactlyElementsOf(texte(vok.path("vorgang")));
        assertThat(liste(eigenschaft("BezugsgroesseFassung", "status"), "enum")).containsExactlyElementsOf(texte(vok.path("status")));
        assertThat(liste(eigenschaft("BezugsgroesseWerte", "fassungen"), "enum"))
                .containsExactlyElementsOf(texte(vertrag.path("verwalten").path("lesarten")));
        assertThat(texte(vok.path("herkunft_art"))).containsAll(liste(eigenschaft("BezugsgroesseHerkunft", "art"), "enum"));
    }

    /** Jede Form der Antwort und der Anfrage hat in OpenAPI genau die Felder des DTO (snake_case). */
    @Test
    void dieFormenSindZeichengleich() {
        Map<String, Class<? extends Record>> formen = Map.ofEntries(
                Map.entry("BezugsgroesseAnfrage", BezugsgroesseDto.Anfrage.class),
                Map.entry("Bezugsgroesse", BezugsgroesseDto.Bezugsgroesse.class),
                Map.entry("BezugsgroesseListe", BezugsgroesseDto.Liste.class),
                Map.entry("BezugsgroessePerson", BezugsgroesseDto.Person.class),
                Map.entry("BezugsgroesseHerkunft", BezugsgroesseDto.Herkunft.class),
                Map.entry("BezugsgroesseFassung", BezugsgroesseDto.Fassung.class),
                Map.entry("BezugsgroesseWert", BezugsgroesseDto.Wert.class),
                Map.entry("BezugsgroesseWerte", BezugsgroesseDto.Werte.class),
                Map.entry("Bezugsflaeche", BezugsgroesseDto.Bezugsflaeche.class),
                Map.entry("BezugsgroesseStichtagwert", BezugsgroesseDto.Stichtagwert.class),
                Map.entry("BezugsflaecheWerte", BezugsgroesseDto.BezugsflaecheWerte.class),
                Map.entry("Bezugsflaechen", BezugsgroesseDto.Bezugsflaechen.class),
                Map.entry("BezugsgroesseStammdatumAnfrage", BezugsgroesseDto.StammdatumAnfrage.class),
                Map.entry("BezugsgroesseStammdatumIntervall", BezugsgroesseDto.StammdatumIntervall.class),
                Map.entry("BezugsgroesseStammdatum", BezugsgroesseDto.Stammdatum.class),
                Map.entry("BezugsgroesseWertAnfrage", BezugsgroesseDto.WertAnfrage.class),
                Map.entry("BezugsgroesseBerichtigungAnfrage", BezugsgroesseDto.BerichtigungAnfrage.class),
                Map.entry("BezugsgroesseHinweis", BezugsgroesseDto.Hinweis.class),
                Map.entry("BezugsgroesseVorschlag", BezugsgroesseDto.Vorschlag.class),
                Map.entry("BezugsgroesseEingabe", BezugsgroesseDto.Eingabe.class));
        formen.forEach((schema, dto) -> {
            List<String> felder = new ArrayList<>();
            Arrays.stream(dto.getRecordComponents()).forEach(c -> felder.add(
                    PropertyNamingStrategies.SnakeCaseStrategy.INSTANCE.translate(c.getName())));
            assertThat(eigenschaften(schema)).as(schema).containsExactlyElementsOf(felder);
        });
    }

    /**
     * AP-09 IP-6 (E17): eine gelesene Bezugsfläche ist nicht schreibbar — die Route kennt nur GET, die Form sagt
     * {@code schreibbar: false}, und die Herkunft ist die Ortsstruktur. Die Einheit der Fläche kommt aus dem
     * Vokabular (Größe {@code flaeche}).
     */
    @Test
    @SuppressWarnings("unchecked")
    void dieBezugsflaecheHatKeinenSchreibweg() {
        Map<String, Object> pfad = (Map<String, Object>) pfade.get("/api/v1/bezugsflaechen");
        assertThat(pfad.keySet()).containsExactly("get");
        assertThat(liste(eigenschaft("Bezugsflaeche", "schreibbar"), "enum")).containsExactly("false");
        assertThat(liste(eigenschaft("Bezugsflaeche", "herkunft_art"), "enum")).containsExactly("stammdatum_ap02");
        assertThat(liste(eigenschaft("Bezugsflaeche", "einheit"), "enum"))
                .containsExactlyElementsOf(texte(vertrag.path("einheiten").path("flaeche")));
        assertThat(((Map<String, Object>) pfade.get("/api/v1/bezugsgroessen/{id}/stammdatum")).keySet())
                .containsExactlyInAnyOrder("parameters", "get", "put");
    }

    /** AP-09 IP-7: die Urteile und Hinweise der Eingabe sind die des Vertrags, und beide Schreibwege stehen in OpenAPI. */
    @Test
    @SuppressWarnings("unchecked")
    void dieEingabeIstDieDesVertrags() {
        assertThat(liste(eigenschaft("BezugsgroesseEingabe", "urteil"), "enum"))
                .containsExactlyInAnyOrderElementsOf(BezugsgroesseRegeln.EINGABE_SAETZE.keySet());
        assertThat(BezugsdatenRegeln.HINWEIS_BEFUNDE).containsAll(liste(eigenschaft("BezugsgroesseHinweis", "code"), "enum"));
        assertThat(((Map<String, Object>) pfade.get("/api/v1/bezugsgroessen/{id}/werte")).keySet())
                .containsExactlyInAnyOrder("parameters", "get", "post");
        assertThat(((Map<String, Object>) pfade.get("/api/v1/bezugsgroessen/{id}/werte/{periode}/berichtigung")).keySet())
                .containsExactlyInAnyOrder("parameters", "post");
    }

    @SuppressWarnings("unchecked")
    private static List<String> eigenschaften(String schema) {
        return new ArrayList<>(((Map<String, Object>) ((Map<String, Object>) schemas.get(schema)).get("properties")).keySet());
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> eigenschaft(String schema, String feld) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(schema);
        assertThat(s).as(schema).isNotNull();
        return (Map<String, Object>) ((Map<String, Object>) s.get("properties")).get(feld);
    }

    @SuppressWarnings("unchecked")
    private static List<String> liste(Map<String, Object> knoten, String... pfad) {
        Object o = knoten;
        for (String schritt : pfad) {
            o = ((Map<String, Object>) o).get(schritt);
        }
        return ((List<Object>) o).stream().map(String::valueOf).toList();
    }

    private static List<String> texte(JsonNode array) {
        List<String> aus = new ArrayList<>();
        array.forEach(x -> aus.add(x.asText()));
        return aus;
    }
}
