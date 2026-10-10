package com.voltpilot.api.unterstuetzung;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.uems.RechteAbleitung.AenderungsArt;
import com.voltpilot.api.unterstuetzung.UnterstuetzungAbgelehnt.Ablehnung;
import com.voltpilot.api.unterstuetzung.UnterstuetzungRepository.Anlass;
import com.voltpilot.api.web.dto.UnterstuetzungDto;
import java.io.InputStream;
import java.lang.reflect.RecordComponent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Die Unterstützungs-Schnittstelle (UEMS AP-03 IP-8) sagt in Java, in {@code docs/contracts/openapi.yaml}, in
 * der Migration und im Portal dasselbe: jedes Feld jeder Form, jede Route, der geschlossene Satz der
 * Ablehnungen und das Anlass-Vokabular. Rein — ohne Spring, ohne Datenbank.
 */
class UnterstuetzungSchnittstelleVertragTest {

    private static final Path WURZEL = Path.of("..", "..");
    private static final Path OPENAPI = WURZEL.resolve(Path.of("docs", "contracts", "openapi.yaml"));
    private static final Path API_TS = WURZEL.resolve(Path.of("frontend", "portal", "src", "api.ts"));
    private static final Path MIGRATION = Path.of("src", "main", "resources", "db", "migration",
            "V20260916070000__uems_unterstuetzung.sql");
    private static final PropertyNamingStrategies.SnakeCaseStrategy SNAKE =
            new PropertyNamingStrategies.SnakeCaseStrategy();

    private static final Map<Class<?>, String> FORMEN = formen();

    private static Map<String, Object> schemas;
    private static Map<String, Object> pfade;

    private static Map<Class<?>, String> formen() {
        Map<Class<?>, String> m = new LinkedHashMap<>();
        m.put(UnterstuetzungDto.Unterstuetzung.class, "Unterstuetzung");
        m.put(UnterstuetzungDto.Anfrage.class, "UnterstuetzungAnfrage");
        m.put(UnterstuetzungDto.Hinweis.class, "UnterstuetzungHinweis");
        m.put(UnterstuetzungDto.Person.class, "UnterstuetzungPerson");
        return m;
    }

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lies() throws Exception {
        try (InputStream in = Files.newInputStream(OPENAPI)) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
            pfade = (Map<String, Object>) openapi.get("paths");
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void jedesFeldJederAntwortStehtInJavaUndOpenApiUndIstPflicht() {
        FORMEN.forEach((typ, name) -> {
            Map<String, Object> schema = (Map<String, Object>) schemas.get(name);
            assertThat(schema).as(name).isNotNull();
            Set<String> java = Arrays.stream(typ.getRecordComponents()).map(RecordComponent::getName)
                    .map(SNAKE::translate).collect(Collectors.toCollection(TreeSet::new));
            Set<String> yaml = new TreeSet<>(((Map<String, Object>) schema.get("properties")).keySet());
            assertThat(yaml).as(name).isEqualTo(java);
            assertThat(new TreeSet<>((List<String>) schema.get("required"))).as(name + " required").isEqualTo(java);
        });
    }

    /** Die Körper sind bewusst NICHT durchweg Pflicht (Vorgaben) — aber sie kennen dieselben Felder. */
    @Test
    @SuppressWarnings("unchecked")
    void jedesFeldJedesKoerpersStehtInJavaUndOpenApi() {
        Map<Class<?>, String> koerper = new LinkedHashMap<>();
        koerper.put(UnterstuetzungDto.Gewaehren.class, "UnterstuetzungGewaehren");
        koerper.put(UnterstuetzungDto.Verlaengern.class, "UnterstuetzungVerlaengern");
        koerper.put(UnterstuetzungDto.Beenden.class, "UnterstuetzungBeenden");
        koerper.put(UnterstuetzungDto.PlattformAntrag.class, "UnterstuetzungPlattformAntrag");
        koerper.forEach((typ, name) -> {
            Map<String, Object> schema = (Map<String, Object>) schemas.get(name);
            assertThat(schema).as(name).isNotNull();
            Set<String> java = Arrays.stream(typ.getRecordComponents()).map(RecordComponent::getName)
                    .map(SNAKE::translate).collect(Collectors.toCollection(TreeSet::new));
            assertThat(new TreeSet<>(((Map<String, Object>) schema.get("properties")).keySet())).as(name)
                    .isEqualTo(java);
        });
    }

    @Test
    void jedeRouteDesPaketsStehtInOpenApi() {
        assertThat(pfade).containsKeys(
                "/api/v1/unterstuetzung",
                "/api/v1/unterstuetzung/{id}",
                "/api/v1/unterstuetzung/anfragen",
                "/api/v1/unterstuetzung/anfragen/{id}/ablehnen",
                "/api/v1/unterstuetzung/hinweise",
                "/api/v1/unterstuetzung/hinweise/{id}/gelesen",
                "/api/v1/admin/tenants/{tenantId}/unterstuetzung/anfrage",
                "/api/v1/admin/tenants/{tenantId}/unterstuetzung/notfall");
    }

    /** Der geschlossene Satz: Java, OpenAPI und das Portal kennen dieselben Codes. */
    @Test
    @SuppressWarnings("unchecked")
    void derSatzDerAblehnungenIstDerselbe() throws Exception {
        Map<String, Object> code = (Map<String, Object>) ((Map<String, Object>)
                ((Map<String, Object>) schemas.get("UnterstuetzungFehler")).get("properties")).get("code");
        assertThat((List<String>) code.get("enum")).containsExactlyElementsOf(UnterstuetzungAbgelehnt.CODES);

        String ts = Files.readString(API_TS);
        for (String c : UnterstuetzungAbgelehnt.CODES) {
            assertThat(ts).as("api.ts kennt " + c).contains("'" + c + "'");
        }
        // Drei Wörter gehören dem Rechte-Vertrag, nicht dieser Schnittstelle - sie werden nie neu erfunden.
        assertThat(UnterstuetzungAbgelehnt.CODES).contains(RechteAbleitung.Grund.STANDORT_FEHLT.code(),
                RechteAbleitung.Grund.HOECHSTENS_12_MONATE.code(), RechteAbleitung.Grund.GRUND_FEHLT.code());
    }

    /** Das Anlass-Vokabular: Java, OpenAPI, Portal und der CHECK der Migration. */
    @Test
    @SuppressWarnings("unchecked")
    void dasAnlassVokabularIstDasselbe() throws Exception {
        List<String> java = Arrays.stream(Anlass.values()).map(Anlass::code).toList();
        Map<String, Object> anlass = (Map<String, Object>) ((Map<String, Object>)
                ((Map<String, Object>) schemas.get("UnterstuetzungHinweis")).get("properties")).get("anlass");
        assertThat((List<String>) anlass.get("enum")).containsExactlyElementsOf(java);

        String sql = Files.readString(MIGRATION);
        String erwartet = java.stream().map(w -> "'" + w + "'").collect(Collectors.joining(", "));
        assertThat(sql).as("unterstuetzung_hinweis_anlass_chk").contains("anlass IN (" + erwartet + ")");

        String ts = Files.readString(API_TS);
        for (String w : java) {
            assertThat(ts).as("api.ts kennt den Anlass " + w).contains("| '" + w + "'");
        }
    }

    /**
     * Die zwei Protokollwörter, die dieses Paket dem Rechte-Vertrag hinzufügt, stehen in allen vier Sprachen:
     * Java-Enum, Vektor-Datei, Schema und die Vokabular-Funktion der Migration.
     */
    @Test
    void dieZweiNeuenProtokollwoerterStehenUeberall() throws Exception {
        assertThat(Arrays.stream(AenderungsArt.values()).map(AenderungsArt::code))
                .containsExactly("zuweisen", "entziehen", "sperren", "entfernen", "verlaengern", "ablaufen",
                        "erste_anmeldung", "startpasswort_neu");
        String vektoren = Files.readString(WURZEL.resolve(Path.of("docs", "contracts", "v2", "rechte-vectors.json")));
        String schema = Files.readString(WURZEL.resolve(Path.of("docs", "contracts", "v2", "rechte.schema.json")));
        String sql = Files.readString(MIGRATION);
        for (String wort : List.of("verlaengern", "ablaufen")) {
            assertThat(vektoren).as("rechte-vectors.json kennt " + wort).contains("\"" + wort + "\"");
            assertThat(schema).as("rechte.schema.json kennt " + wort).contains("\"" + wort + "\"");
            assertThat(sql).as("zugriff_vokabular() kennt " + wort).contains("'aenderung', ");
            assertThat(sql).as("zugriff_vokabular() kennt " + wort).contains("'" + wort + "'");
        }
        // Und der CHECK, der „zuweisen und entziehen nennen ihre Zuweisung" hält, nennt sie auch.
        assertThat(sql).contains("aktion NOT IN ('zuweisen', 'entziehen', 'verlaengern', 'ablaufen')");
    }
}
