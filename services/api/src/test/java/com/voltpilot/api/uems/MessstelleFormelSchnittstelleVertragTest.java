package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.MessstelleFormelDto;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Rein, ohne Docker: die Formel-Schnittstelle mit ihren Fassungen (UEMS AP-10 IP-3) sagt in drei
 * Dateien DASSELBE — die Java-Form ({@link MessstelleFormelDto}), {@code docs/contracts/openapi.yaml}
 * und die Typen des Portals ({@code frontend/portal/src/api.ts}).
 *
 * <p>⚠ Die Falle aus PR #689: {@code request()} im Portal wandelt nichts um. Ein Feld, das dort
 * camelCase hieße, wäre still {@code undefined} — darum steht jedes Feld hier snake_case in allen drei.
 */
class MessstelleFormelSchnittstelleVertragTest {

    private static final Path CONTRACTS = Path.of("..", "..", "docs", "contracts");
    private static final Path API_TS = Path.of("..", "..", "frontend", "portal", "src", "api.ts");
    private static final PropertyNamingStrategies.SnakeCaseStrategy SNAKE = new PropertyNamingStrategies.SnakeCaseStrategy();

    private static Map<String, Object> schemas;
    private static Map<String, Object> pfade;
    private static String apiTs;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lade() throws IOException {
        try (InputStream in = Files.newInputStream(CONTRACTS.resolve("openapi.yaml"))) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
            pfade = (Map<String, Object>) openapi.get("paths");
        }
        apiTs = Files.readString(API_TS);
    }

    @Test
    void dieFormelTraegtDieFelderVonVorIp3UndNurFassungAmDazu() {
        List<String> dto = felder(MessstelleFormelDto.Formel.class);
        assertThat(dto).containsExactly("messstelle_id", "schema_version", "hauptgroesse", "terme",
                "formel_vorhanden", "eingaenge_eingerichtet", "fassung_am");
        assertThat(map(schema("MessstelleFormel"), "properties").keySet()).containsExactlyElementsOf(dto);
        // Pflicht sind genau die Felder von vor IP-3 — fassung_am gibt es nur mit `am`.
        assertThat(liste(schema("MessstelleFormel"), "required")).containsExactlyElementsOf(dto.subList(0, 6));
        assertThat(interfaceFelder("MessstelleFormel")).containsExactly("messstelle_id", "schema_version",
                "hauptgroesse", "terme", "formel_vorhanden", "eingaenge_eingerichtet", "fassung_am?");

        assertThat(map(schema("MessstelleFormelTerm"), "properties").keySet())
                .containsExactlyElementsOf(felder(MessstelleFormelDto.Term.class));
        assertThat(interfaceFelder("MessstelleFormelTerm")).containsExactlyElementsOf(felder(MessstelleFormelDto.Term.class));
    }

    @Test
    void dieFassungIstInAllenDreiDateienDieselbe() {
        List<String> dto = felder(MessstelleFormelDto.Fassung.class);
        assertThat(map(schema("MessstelleFormelFassung"), "properties").keySet()).containsExactlyElementsOf(dto);
        assertThat(liste(schema("MessstelleFormelFassung"), "required")).containsExactlyElementsOf(dto);
        assertThat(interfaceFelder("MessstelleFormelFassung")).containsExactlyElementsOf(dto);

        Map<String, Object> fassungAm = map(map(schema("MessstelleFormel"), "properties"), "fassung_am");
        assertThat(map(fassungAm, "properties").keySet())
                .containsExactlyElementsOf(felder(MessstelleFormelDto.FassungAm.class));
    }

    @Test
    void dieAnfrageIstSnakeCaseUndStreng() {
        List<String> dto = felder(MessstelleFormelDto.FassungEintragen.class);
        assertThat(dto).containsExactly("gueltig_ab", "formel_typ", "terme", "begruendung");
        Map<String, Object> schema = schema("MessstelleFormelFassungEintragen");
        assertThat(map(schema, "properties").keySet()).containsExactlyElementsOf(dto);
        assertThat(schema.get("additionalProperties")).isEqualTo(false);
        assertThat(interfaceFelder("MessstelleFormelFassungEintragen"))
                .containsExactly("gueltig_ab", "formel_typ?", "terme", "begruendung?");
        // Die Term-Eingabe der Fassung ist die des Anlegens.
        assertThat(felder(MessstelleFormelDto.TermEingabe.class)).containsExactly("eingang_art", "entity_id",
                "point_key", "quell_messstelle_id", "vorzeichen", "faktor");
    }

    @Test
    void dieFehlerCodesSindDieDerRegelUndDieRoutenStehenInDerOpenApi() {
        List<String> codes = new ArrayList<>();
        codes.add("anfrage_ungueltig");
        Arrays.stream(MessstelleFormelRegeln.Fehler.values()).forEach(f -> codes.add(f.code()));
        Arrays.stream(MessstelleFormelRegeln.FassungFehler.values()).forEach(f -> codes.add(f.code()));
        assertThat(liste(schema("MessstelleFormelFehler"), "properties", "code", "enum"))
                .containsExactlyElementsOf(codes);

        assertThat(pfade).containsKey("/api/v1/messstellen/{id}/formel");
        assertThat(pfade).containsKey("/api/v1/messstellen/{id}/formel/fassungen");
        assertThat(String.valueOf(pfade.get("/api/v1/messstellen/{id}/formel/fassungen"))).contains("messstelle.formel");
        assertThat(String.valueOf(pfade.get("/api/v1/messstellen/{id}/formel"))).contains("messstelle.ansehen");
        // Der Aufruf des Portals ohne Tag bleibt derselbe.
        assertThat(apiTs).contains("request<MessstelleFormel>(`/api/v1/messstellen/${id}/formel${am ? `?am=${am}` : ''}`)");
    }

    // ------------------------------------------------------------------ Gerüst

    private static List<String> felder(Class<? extends Record> typ) {
        return Arrays.stream(typ.getRecordComponents()).map(c -> SNAKE.translate(c.getName())).toList();
    }

    /** Die Feldnamen eines {@code export interface X { … }} in api.ts, optionale mit „?“. */
    private static List<String> interfaceFelder(String name) {
        Matcher kopf = Pattern.compile("export interface " + name + " \\{\\n").matcher(apiTs);
        assertThat(kopf.find()).as("interface " + name + " in api.ts").isTrue();
        int ende = apiTs.indexOf("\n}\n", kopf.end());
        List<String> out = new ArrayList<>();
        Matcher feld = Pattern.compile("(?m)^  ([a-z_]+\\??):").matcher(apiTs.substring(kopf.end(), ende));
        while (feld.find()) {
            out.add(feld.group(1));
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> schema(String name) {
        return (Map<String, Object>) schemas.get(name);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Map<String, Object> m, String key) {
        return (Map<String, Object>) m.get(key);
    }

    @SuppressWarnings("unchecked")
    private static List<String> liste(Map<String, Object> m, String... pfad) {
        Object o = m;
        for (String p : pfad) {
            o = ((Map<String, Object>) o).get(p);
        }
        return ((List<Object>) o).stream().map(String::valueOf).toList();
    }
}
