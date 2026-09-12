package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.MessstelleDto;
import com.voltpilot.api.web.dto.MessstelleQuelleDto;
import com.voltpilot.api.web.dto.ZaehlerwechselDto;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Rein, ohne Docker: die Messstellen-Schnittstelle sagt in drei Dateien DASSELBE — der
 * Messstellen-Vertrag ({@code messstelle.schema.json}), die Java-Form ({@link MessstelleDto})
 * und {@code docs/contracts/openapi.yaml}. Dazu die Akteur-Regel an ihrer EINEN Stelle.
 */
class MessstelleSchnittstelleVertragTest {

    private static final Path CONTRACTS = Path.of("..", "..", "docs", "contracts");
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final List<String> NUR_SCHNITTSTELLE = List.of("id", "fehlt", "angehalten_ab", "archiviert_am");

    private static Map<String, Object> schemas;
    private static Map<String, Object> pfade;
    private static JsonNode vertrag;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lade() throws IOException {
        try (InputStream in = Files.newInputStream(CONTRACTS.resolve("openapi.yaml"))) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
            pfade = (Map<String, Object>) openapi.get("paths");
        }
        vertrag = MAPPER.readTree(CONTRACTS.resolve("v2").resolve("messstelle.schema.json").toFile());
    }

    @Test
    void dieFehlerCodesSindDieDesVertragsUndDieDerSchnittstelle() {
        List<String> openapi = liste(schema("MessstelleFehler"), "properties", "code", "enum");
        assertThat(openapi).containsExactlyElementsOf(MessstelleAbgelehnt.CODES);
        // Die Codes des Vertrags stehen vollzählig und vorn — in der Reihenfolge seiner Fehlertabelle.
        assertThat(MessstelleAbgelehnt.CODES.subList(0, MessstelleRegeln.Fehler.values().length))
                .containsExactlyElementsOf(Arrays.stream(MessstelleRegeln.Fehler.values())
                        .map(MessstelleRegeln.Fehler::code).toList());
        List<String> vertragsCodes = StreamSupport.stream(vertrag.at("/$defs/fehlerCode/enum").spliterator(), false)
                .map(JsonNode::asText).toList();
        assertThat(MessstelleAbgelehnt.CODES).containsAll(vertragsCodes);
        // Kein Code der Schnittstelle überdeckt einen des Vertrags.
        for (MessstelleAbgelehnt.Schnittstelle s : MessstelleAbgelehnt.Schnittstelle.values()) {
            assertThat(vertragsCodes).doesNotContain(s.code());
        }
    }

    @Test
    void dieAntwortIstDieMessstelleDesVertragsPlusVierFelderDerSchnittstelle() {
        Set<String> soll = new LinkedHashSet<>();
        vertrag.at("/$defs/messstelle/required").forEach(n -> soll.add(n.asText()));
        soll.addAll(NUR_SCHNITTSTELLE);

        Set<String> dto = new LinkedHashSet<>();
        PropertyNamingStrategies.SnakeCaseStrategy snake = new PropertyNamingStrategies.SnakeCaseStrategy();
        Arrays.stream(MessstelleDto.Messstelle.class.getRecordComponents())
                .forEach(c -> dto.add(snake.translate(c.getName())));
        assertThat(dto).containsExactlyInAnyOrderElementsOf(soll);

        Map<String, Object> messstelle = schema("Messstelle");
        assertThat(liste(messstelle, "required")).containsExactlyInAnyOrderElementsOf(soll);
        assertThat(map(messstelle, "properties").keySet()).containsExactlyInAnyOrderElementsOf(soll);

        Set<String> neben = new LinkedHashSet<>();
        vertrag.at("/$defs/nebengroesse/required").forEach(n -> neben.add(n.asText()));
        Set<String> nebenDto = new LinkedHashSet<>();
        Arrays.stream(MessstelleDto.Nebengroesse.class.getRecordComponents())
                .forEach(c -> nebenDto.add(snake.translate(c.getName())));
        assertThat(nebenDto).containsExactlyInAnyOrderElementsOf(neben);
    }

    @Test
    void dieAnfragenTragenGenauDieFelderDerOpenApi() {
        assertThat(map(schema("MessstelleAnlegen"), "properties").keySet()).containsExactlyInAnyOrderElementsOf(
                Arrays.stream(MessstelleDto.Anlegen.class.getRecordComponents()).map(c -> c.getName()).toList());
        assertThat(map(schema("MessstelleBearbeiten"), "properties").keySet()).containsExactlyInAnyOrderElementsOf(
                Arrays.stream(MessstelleDto.Bearbeiten.class.getRecordComponents()).map(c -> c.getName()).toList());
        assertThat(map(schema("MessstelleUebergang"), "properties").keySet()).containsExactlyInAnyOrderElementsOf(
                Arrays.stream(MessstelleDto.Uebergang.class.getRecordComponents()).map(c -> c.getName()).toList());
        // Der Größen-Katalog der OpenAPI benutzt dieselben Wörter wie der Vertrag.
        Map<String, Object> groesse = map(schema("MessGroesse"), "properties");
        for (String[] feld : new String[][] {{"groesse", "groesseName"}, {"richtung", "richtung"},
                {"einheit", "einheit"}, {"wertart", "wertart"}}) {
            List<String> woerter = StreamSupport.stream(vertrag.at("/$defs/" + feld[1] + "/enum").spliterator(), false)
                    .map(JsonNode::asText).toList();
            assertThat(liste(map(groesse, feld[0]), "enum")).as(feld[0]).containsExactlyElementsOf(woerter);
        }
    }

    /**
     * Die Zuordnungen (IP-7): die Einträge von {@code orte} und {@code elektrische_stellung} sind
     * die {@code $defs/ortZuordnung} und {@code $defs/stellungZuordnung} des Vertrags (dieselben
     * Felder in Java und OpenAPI, das Stellungs-Vokabular das von {@link MessstelleRegeln}); die
     * Anfragen der beiden Routen und der Stand am Tag tragen genau die Felder der OpenAPI.
     */
    @Test
    void dieZuordnungenSindDieFormenDesVertragsUndDerOpenApi() {
        PropertyNamingStrategies.SnakeCaseStrategy snake = new PropertyNamingStrategies.SnakeCaseStrategy();
        Map<String, Class<?>> vertragsFormen = Map.of(
                "ortZuordnung", MessstelleDto.OrtZuordnung.class,
                "stellungZuordnung", MessstelleDto.StellungZuordnung.class);
        Map<String, String> openapiFormen = Map.of(
                "ortZuordnung", "MessstelleOrtZuordnung", "stellungZuordnung", "MessstelleStellungZuordnung");
        for (Map.Entry<String, Class<?>> f : vertragsFormen.entrySet()) {
            Set<String> soll = new LinkedHashSet<>();
            vertrag.at("/$defs/" + f.getKey() + "/required").forEach(n -> soll.add(n.asText()));
            List<String> dto = Arrays.stream(f.getValue().getRecordComponents())
                    .map(c -> snake.translate(c.getName())).toList();
            assertThat(dto).as(f.getKey()).containsExactlyInAnyOrderElementsOf(soll);
            Map<String, Object> o = schema(openapiFormen.get(f.getKey()));
            assertThat(liste(o, "required")).as(f.getKey()).containsExactlyInAnyOrderElementsOf(soll);
            assertThat(map(o, "properties").keySet()).as(f.getKey()).containsExactlyInAnyOrderElementsOf(soll);
        }
        List<String> stellungen = StreamSupport.stream(vertrag.at("/$defs/stellung/enum").spliterator(), false)
                .map(JsonNode::asText).toList();
        assertThat(stellungen).containsExactlyElementsOf(MessstelleRegeln.STELLUNGEN);
        assertThat(liste(map(map(schema("MessstelleStellungZuordnung"), "properties"), "stellung"), "enum"))
                .containsExactlyElementsOf(stellungen);
        assertThat(liste(map(map(schema("MessstelleStellungAendern"), "properties"), "stellung"), "enum"))
                .containsExactlyElementsOf(stellungen);
        List<String> ortArten = StreamSupport.stream(vertrag.at("/$defs/ortArt/enum").spliterator(), false)
                .map(JsonNode::asText).toList();
        assertThat(liste(map(map(schema("MessstelleOrtZuordnung"), "properties"), "ort_art"), "enum"))
                .containsExactlyElementsOf(ortArten);

        Map<String, Class<?>> formen = Map.of("MessstelleOrtAendern", MessstelleDto.OrtAendern.class,
                "MessstelleStellungAendern", MessstelleDto.StellungAendern.class,
                "MessstelleStandortAm", MessstelleDto.StandortAm.class);
        for (Map.Entry<String, Class<?>> f : formen.entrySet()) {
            assertThat(map(schema(f.getKey()), "properties").keySet()).as(f.getKey())
                    .containsExactlyInAnyOrderElementsOf(Arrays.stream(f.getValue().getRecordComponents())
                            .map(c -> snake.translate(c.getName())).toList());
        }
        // Der Grund des Stands am Tag ist das Vokabular des Ortsbaums (Verortung).
        assertThat(liste(map(map(schema("MessstelleStandortAm"), "properties"), "grund"), "enum"))
                .containsExactlyElementsOf(Arrays.stream(OrtsbaumAbleitung.VerortungGrund.values())
                        .map(g -> g.name().toLowerCase(java.util.Locale.ROOT)).toList());
    }

    /**
     * Die Quellenbindung (IP-13): die Anfragen tragen genau die Felder der OpenAPI, und die Quellen
     * einer Messstelle haben genau die Felder von {@code $defs/quellenbindung} bzw.
     * {@code $defs/vergleichsbindung} des Vertrags.
     */
    @Test
    void dieQuellenbindungTraegtDieFelderDerOpenApiUndDesVertrags() {
        PropertyNamingStrategies.SnakeCaseStrategy snake = new PropertyNamingStrategies.SnakeCaseStrategy();
        for (Object[] paar : new Object[][] {{"MessstelleQuelleBinden", MessstelleQuelleDto.Binden.class},
                {"MessstelleQuelleBeenden", MessstelleQuelleDto.Beenden.class},
                {"MessstelleQuellenbindung", MessstelleDto.Quellenbindung.class},
                {"MessstelleVergleichsbindung", MessstelleDto.Vergleichsbindung.class}}) {
            assertThat(map(schema((String) paar[0]), "properties").keySet()).as((String) paar[0])
                    .containsExactlyInAnyOrderElementsOf(Arrays.stream(((Class<?>) paar[1]).getRecordComponents())
                            .map(c -> snake.translate(c.getName())).toList());
        }
        for (String[] paar : new String[][] {{"quellenbindung", "MessstelleQuellenbindung"},
                {"vergleichsbindung", "MessstelleVergleichsbindung"}}) {
            Set<String> soll = new LinkedHashSet<>();
            vertrag.at("/$defs/" + paar[0] + "/required").forEach(n -> soll.add(n.asText()));
            assertThat(liste(schema(paar[1]), "required")).as(paar[1]).containsExactlyInAnyOrderElementsOf(soll);
        }
    }

    /**
     * Der Zählerwechsel (IP-17): Anfrage und Antwort tragen in Java und OpenAPI genau dieselben
     * Felder, und BEIDE Einstiege — {@code POST …/messstellen/{id}/quellen/wechsel} und
     * {@code POST /api/v1/geraete/{id}/austausch} — schicken und bekommen dieselbe Form. Genau das
     * heißt „ein Vorgang, zwei Einstiege".
     */
    @Test
    void derZaehlerwechselTraegtDieFelderDerOpenApiUndIstAnBeidenEinstiegenDerselbe() {
        PropertyNamingStrategies.SnakeCaseStrategy snake = new PropertyNamingStrategies.SnakeCaseStrategy();
        for (Object[] paar : new Object[][] {{"Zaehlerwechsel", ZaehlerwechselDto.Wechsel.class},
                {"ZaehlerwechselNeuesGeraet", ZaehlerwechselDto.NeuesGeraet.class},
                {"ZaehlerwechselVerbindung", ZaehlerwechselDto.Verbindung.class},
                {"ZaehlerwechselEinbau", ZaehlerwechselDto.Einbau.class},
                {"ZaehlerwechselGeraet", ZaehlerwechselDto.GeraetWechsel.class},
                {"ZaehlerwechselBindung", ZaehlerwechselDto.Bindung.class},
                {"ZaehlerwechselEinstellung", ZaehlerwechselDto.Einstellung.class},
                {"ZaehlerwechselVorgang", ZaehlerwechselDto.Vorgang.class}}) {
            assertThat(map(schema((String) paar[0]), "properties").keySet()).as((String) paar[0])
                    .containsExactlyInAnyOrderElementsOf(Arrays.stream(((Class<?>) paar[1]).getRecordComponents())
                            .map(c -> snake.translate(c.getName())).toList());
        }
        String anfrage = "#/components/schemas/Zaehlerwechsel";
        String antwort = "#/components/schemas/ZaehlerwechselVorgang";
        for (String pfad : List.of("/api/v1/messstellen/{id}/quellen/wechsel", "/api/v1/geraete/{id}/austausch")) {
            Map<String, Object> post = map(map(pfade, pfad), "post");
            assertThat(ref(map(map(map(map(post, "requestBody"), "content"), "application/json"), "schema")))
                    .as(pfad + " Anfrage").isEqualTo(anfrage);
            Map<String, Object> erfolg = map(map(post, "responses"), "201");
            assertThat(ref(map(map(map(erfolg, "content"), "application/json"), "schema")))
                    .as(pfad + " Antwort").isEqualTo(antwort);
            assertThat(map(post, "responses").keySet()).as(pfad + " Status")
                    .containsExactlyInAnyOrder("201", "400", "401", "404", "409", "422");
        }
    }

    /**
     * Das Register (IP-4): jede seiner Formen trägt in Java und OpenAPI genau dieselben Felder, und
     * {@code quelle.stand} sagt dort dieselben drei Wörter wie {@link MessstelleRegisterService}.
     */
    @Test
    void dasRegisterTraegtGenauDieFelderDerOpenApi() {
        PropertyNamingStrategies.SnakeCaseStrategy snake = new PropertyNamingStrategies.SnakeCaseStrategy();
        for (Object[] paar : new Object[][] {{"MessstelleListe", MessstelleDto.Liste.class},
                {"MessstelleRegisterZeile", MessstelleDto.RegisterZeile.class},
                {"MessstelleRegisterOrt", MessstelleDto.RegisterOrt.class},
                {"MessstelleRegisterStellung", MessstelleDto.RegisterStellung.class},
                {"MessstelleRegisterQuelle", MessstelleDto.RegisterQuelle.class},
                {"MessstelleRegisterBindung", MessstelleDto.RegisterBindung.class},
                {"MessstelleRegisterGeraet", MessstelleDto.RegisterGeraet.class},
                {"MessstelleRegisterBeobachtung", MessstelleDto.RegisterBeobachtung.class},
                {"MessstelleRegisterWert", MessstelleDto.RegisterWert.class},
                {"MessstelleRegisterNebengroesse", MessstelleDto.RegisterNebengroesse.class},
                {"MessstelleRegisterAggregat", MessstelleDto.RegisterAggregat.class},
                {"MessstelleRegisterAbdeckung", MessstelleDto.RegisterAbdeckung.class},
                {"MessstelleRegisterStandortAbdeckung", MessstelleDto.RegisterStandortAbdeckung.class}}) {
            List<String> felder = Arrays.stream(((Class<?>) paar[1]).getRecordComponents())
                    .map(c -> snake.translate(c.getName())).toList();
            assertThat(map(schema((String) paar[0]), "properties").keySet()).as((String) paar[0])
                    .containsExactlyInAnyOrderElementsOf(felder);
            assertThat(liste(schema((String) paar[0]), "required")).as((String) paar[0])
                    .containsExactlyInAnyOrderElementsOf(felder);
        }
        assertThat(liste(map(map(schema("MessstelleRegisterQuelle"), "properties"), "stand"), "enum"))
                .containsExactly(MessstelleRegisterService.GEBUNDEN, MessstelleRegisterService.BERECHNET,
                        MessstelleRegisterService.KEINE_DATENQUELLE);
        // Der Grund der Verortung und der Lebenszyklus sind dieselben Vokabulare wie anderswo.
        assertThat(liste(map(map(schema("MessstelleRegisterOrt"), "properties"), "grund"), "enum"))
                .containsExactlyElementsOf(liste(map(map(schema("MessstelleStandortAm"), "properties"), "grund"),
                        "enum"));
        assertThat(liste(map(map(schema("MessstelleRegisterZeile"), "properties"), "lebenszyklus"), "enum"))
                .containsExactlyElementsOf(MessstelleRegeln.LEBENSZYKLUS);
        // Die Beobachtung (IP-15) sagt genau die vier Wörter des Zustandsvertrags, in seiner Reihenfolge.
        assertThat(liste(map(map(schema("MessstelleRegisterBeobachtung"), "properties"), "zustand"), "enum"))
                .containsExactlyElementsOf(Arrays.stream(ZustandAbleitung.LiefertDaten.values())
                        .map(ZustandAbleitung.LiefertDaten::code).toList());
        // Die Filter der Route sind die des Berichts (§6.1) — in derselben Reihenfolge.
        assertThat(parameter("/api/v1/messstellen"))
                .containsExactly("standort", "ort", "anlage", "zustand", "ohneQuelle", "stichtag");
    }

    /** AP-03 E12: jeder heutige Kundenbenutzer ist Kundenadministrator; der Plattform-Admin ist VoltPilot. */
    @Test
    void derUrheberKommtAusDerEinenStelle() {
        ProtokollAkteur kunde = ProtokollAkteur.fuer("sub-jonas", "Jonas Wendlinger", false);
        assertThat(kunde).isEqualTo(new ProtokollAkteur("sub-jonas", "Jonas Wendlinger",
                RechteAbleitung.Rolle.KUNDENADMINISTRATOR.code(), "kunde"));
        ProtokollAkteur betrieb = ProtokollAkteur.fuer("sub-admin", "  admin ", true);
        assertThat(betrieb).isEqualTo(new ProtokollAkteur("sub-admin", "admin",
                RechteAbleitung.Rolle.VOLTPILOT_BETRIEB.code(), "voltpilot"));
        // Ohne Anzeigenamen trägt der Eintrag das Subject — nie einen leeren Namen.
        assertThat(ProtokollAkteur.fuer("sub-ohne-namen", " ", false).name()).isEqualTo("sub-ohne-namen");
        assertThat(ProtokollAkteur.aus(null)).isEmpty();
    }

    @SuppressWarnings("unchecked")
    private static List<String> parameter(String pfad) {
        Map<String, Object> route = (Map<String, Object>) ((Map<String, Object>) pfade.get(pfad)).get("get");
        return ((List<Map<String, Object>>) route.get("parameters")).stream()
                .map(p -> String.valueOf(p.get("name"))).toList();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> schema(String name) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(name);
        assertThat(s).as("components.schemas." + name).isNotNull();
        return s;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Map<String, Object> m, String key) {
        return (Map<String, Object>) m.get(key);
    }

    /** Der {@code $ref} eines Schemas — auch, wenn er in einem {@code allOf} steckt. */
    @SuppressWarnings("unchecked")
    private static String ref(Map<String, Object> schema) {
        if (schema.get("$ref") != null) {
            return String.valueOf(schema.get("$ref"));
        }
        List<Object> allOf = (List<Object>) schema.get("allOf");
        return allOf == null ? null : String.valueOf(((Map<String, Object>) allOf.get(0)).get("$ref"));
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
