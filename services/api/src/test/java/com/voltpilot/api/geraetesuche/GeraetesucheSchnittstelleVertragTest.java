package com.voltpilot.api.geraetesuche;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Rein, ohne Docker: die vier Routen der Gerätesuche in {@code docs/contracts/openapi.yaml} sagen dasselbe wie der
 * Vertrag - Recht {@code geraet.einrichten} (DP-4 A), die Antworten 202/409/429, die Wörter der Antwort aus
 * {@code geraetesuche-vectors.json} und kein Feld für eine MAC oder einen Hostnamen (DP-3 A). API- und Portal-Paket
 * bauen gegen diese Form.
 */
class GeraetesucheSchnittstelleVertragTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static JsonNode paths;
    private static JsonNode schemas;
    private static JsonNode stand;

    @BeforeAll
    static void lade() throws Exception {
        try (InputStream in = Files.newInputStream(Path.of("..", "..", "docs", "contracts", "openapi.yaml"))) {
            Map<String, Object> openapi = new Yaml().load(in);
            JsonNode wurzel = JSON.valueToTree(openapi);
            paths = wurzel.path("paths");
            schemas = wurzel.path("components").path("schemas");
        }
        stand = JSON.readTree(Files.readString(
                Path.of("..", "..", "docs", "contracts", "v2", "mqtt-geraetesuche-stand.schema.json")));
    }

    private static List<String> woerter(JsonNode enumListe) {
        List<String> out = new ArrayList<>();
        enumListe.forEach(x -> {
            if (!x.isNull()) {
                out.add(x.asText());
            }
        });
        return out;
    }

    @Test
    void vierRoutenMitDemRechtGeraetEinrichten() {
        JsonNode basis = paths.path("/api/v1/sites/{siteId}/geraetesuche");
        JsonNode eine = paths.path("/api/v1/sites/{siteId}/geraetesuche/{suchId}");
        for (JsonNode op : List.of(basis.path("post"), basis.path("get"), eine.path("get"), eine.path("delete"))) {
            assertThat(op.isMissingNode()).isFalse();
            assertThat(woerter(op.path("tags"))).containsExactly("geraetesuche");
            assertThat(op.path("description").asText()).contains("`geraet.einrichten`");
        }
        JsonNode post = basis.path("post");
        assertThat(post.at("/requestBody/content/application~1json/schema/required").toString())
                .isEqualTo("[\"deviceId\"]");
        assertThat(post.at("/requestBody/content/application~1json/schema/additionalProperties").asBoolean(true))
                .isFalse();
        assertThat(post.path("parameters").toString()).contains("#/components/parameters/AnfrageKennung");
        assertThat(post.path("responses").fieldNames()).toIterable().contains("202", "409", "429");
        assertThat(post.at("/responses/202/content/application~1json/schema/$ref").asText())
                .isEqualTo("#/components/schemas/Geraetesuche");
        assertThat(eine.at("/delete/responses/202/content/application~1json/schema/$ref").asText())
                .isEqualTo("#/components/schemas/Geraetesuche");
        String beschreibung = post.path("description").asText();
        GeraetesucheVertrag.FEHLER_409.forEach(c -> assertThat(beschreibung).contains("`" + c + "`"));
        GeraetesucheVertrag.FEHLER_429.forEach(c -> assertThat(beschreibung).contains("`" + c + "`"));
        assertThat(woerter(schemas.at("/GeraetesucheFehler/properties/code/enum")))
                .containsAll(GeraetesucheVertrag.FEHLER_409).containsAll(GeraetesucheVertrag.FEHLER_429);
    }

    @Test
    void dieWoerterDerAntwortSindDieDesVertrags() {
        JsonNode suche = schemas.path("Geraetesuche").path("properties");
        assertThat(woerter(suche.path("zustand").path("enum"))).isEqualTo(GeraetesucheVertrag.ZUSTAENDE_API);
        List<String> gruende = new ArrayList<>();
        GeraetesucheVertrag.GRUENDE.values().forEach(gruende::addAll);
        assertThat(woerter(suche.path("grund").path("enum"))).isEqualTo(gruende);
        assertThat(woerter(suche.path("schritt").path("enum"))).isEqualTo(GeraetesucheVertrag.SCHRITTE);
        assertThat(woerter(suche.at("/erkenner/items/enum"))).isEqualTo(GeraetesucheVertrag.ERKENNER);
        assertThat(suche.at("/gestartetVon/$ref").asText()).isEqualTo("#/components/schemas/ProtokollUrheber");
        assertThat(woerter(schemas.at("/GeraetesucheGruppe/properties/gruppe/enum")))
                .isEqualTo(GeraetesucheVertrag.GRUPPEN);
        assertThat(schemas.at("/GeraetesucheVerlaufEintrag/properties/zaehler/properties").fieldNames()).toIterable()
                .containsExactlyElementsOf(GeraetesucheVertrag.GRUPPEN);
        JsonNode fund = schemas.path("GeraetesucheFund").path("properties");
        List<String> fundErkenner = new ArrayList<>(GeraetesucheVertrag.ERKENNER);
        fundErkenner.removeAll(GeraetesucheVertrag.WEGE);
        assertThat(woerter(fund.path("erkenner").path("enum"))).isEqualTo(fundErkenner);
        assertThat(woerter(fund.path("art").path("enum"))).isEqualTo(GeraetesucheVertrag.ARTEN);
        assertThat(woerter(fund.path("anbindung").path("enum"))).isEqualTo(GeraetesucheVertrag.ANBINDUNGEN);
        assertThat(woerter(fund.path("erkennung").path("enum"))).isEqualTo(GeraetesucheVertrag.ERKENNUNGEN);
        assertThat(woerter(fund.path("hindernis").path("enum"))).isEqualTo(GeraetesucheVertrag.HINDERNISSE);
        assertThat(woerter(fund.path("abgleich").path("enum"))).isEqualTo(GeraetesucheVertrag.ABGLEICH);
        assertThat(woerter(schemas.at("/GeraetesucheNetz/properties/rolle/enum")))
                .isEqualTo(GeraetesucheVertrag.ROLLEN);
        // Der Fund des Portals trägt jedes Feld des Fundes der Box (camelCase), dazu den Abgleich.
        PropertyNamingStrategies.SnakeCaseStrategy snake = new PropertyNamingStrategies.SnakeCaseStrategy();
        List<String> apiFelder = new ArrayList<>();
        fund.fieldNames().forEachRemaining(f -> apiFelder.add(snake.translate(f)));
        stand.at("/$defs/fund/properties").fieldNames()
                .forEachRemaining(f -> assertThat(apiFelder).as(f).contains(f));
        List<String> weitere = new ArrayList<>();
        schemas.at("/GeraetesucheWeitere/properties").fieldNames()
                .forEachRemaining(f -> weitere.add(snake.translate(f)));
        assertThat(weitere).isEqualTo(GeraetesucheVertrag.WEITERE_ARTEN);
    }

    @Test
    void jedesFeldIstImmerDaUndKeinsTraegtEineMac() {
        Pattern verboten = Pattern.compile("(?i)(^|_)(mac|hostname|host_name)($|_)|mac[A-Z]|hostName");
        int n = 0;
        for (var it = schemas.fieldNames(); it.hasNext();) {
            String name = it.next();
            if (!name.startsWith("Geraetesuche")) {
                continue;
            }
            JsonNode s = schemas.path(name);
            if (s.has("properties")) {
                List<String> felder = new ArrayList<>();
                s.path("properties").fieldNames().forEachRemaining(felder::add);
                // Die Fakten einer Ablehnung tragen nur die Gründe, zu denen sie gehören.
                if (!"GeraetesucheFehler".equals(name)) {
                    assertThat(woerter(s.path("required"))).as(name).containsExactlyInAnyOrderElementsOf(felder);
                }
                felder.forEach(f -> assertThat(verboten.matcher(f).find()).as(name + "." + f).isFalse());
            }
            n++;
        }
        assertThat(n).isEqualTo(9);
        assertThat(Objects.requireNonNull(schemas.at("/GeraetesucheFund/properties/komponente/required")).toString())
                .isEqualTo("[\"id\",\"name\"]");
    }
}
