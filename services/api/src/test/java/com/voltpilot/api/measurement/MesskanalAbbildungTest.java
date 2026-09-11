package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.uems.MessstelleRegeln;
import com.voltpilot.api.web.dto.MesskanalDto;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Die Abbildung Katalogwörter → Vertragswörter ist die Tabelle im Katalog-README — hier
 * zeichengleich festgehalten (Zwilling: {@code catalog/measurement-points/tests/test_semantics.py}).
 * Dazu der Beweis, dass ein Messkanal genau die Fakten trägt, die {@code MessstelleRegeln.passung}
 * braucht: die Kanäle von K-3 (Netzzähler Halle 1) gegen die Messstellen MS-01 und MS-02 des
 * Referenzunternehmens.
 */
class MesskanalAbbildungTest {

    private static final Path REPO = Path.of("..", "..");
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private final MeasurementCatalog catalog = new MeasurementCatalog(MAPPER);

    /** Die Zeilen der README-Tabelle: Feld → (Katalogwort → Vertragswort oder null für „—“). */
    private static Map<String, Map<String, String>> tabelle() throws IOException {
        Map<String, Map<String, String>> out = new LinkedHashMap<>();
        for (String zeile : Files.readAllLines(REPO.resolve("catalog/measurement-points/README.md"))) {
            String[] z = zeile.strip().replaceAll("^\\||\\|$", "").split("\\|", -1);
            if (z.length != 4) {
                continue;
            }
            String feld = z[0].strip().replace("`", "");
            if (!feld.equals("quantity") && !feld.equals("direction")) {
                continue;
            }
            String vertrag = z[2].strip();
            Map<String, String> woerter = out.computeIfAbsent(feld, f -> new LinkedHashMap<>());
            assertThat(woerter.put(z[1].strip().replace("`", ""), vertrag.equals("—") ? null : vertrag))
                    .as("doppeltes Katalogwort in der Tabelle").isNull();
        }
        return out;
    }

    private static Map<String, String> nurAbgebildete(Map<String, String> woerter) {
        Map<String, String> out = new LinkedHashMap<>();
        woerter.forEach((k, v) -> {
            if (v != null) {
                out.put(k, v);
            }
        });
        return out;
    }

    private static JsonNode lies(String pfad) throws IOException {
        return MAPPER.readTree(REPO.resolve(pfad).toFile());
    }

    private static List<String> texte(JsonNode liste) {
        return StreamSupport.stream(liste.spliterator(), false).map(JsonNode::asText).toList();
    }

    @Test
    void dieKonstantenSindDieTabelleImKatalogReadme() throws IOException {
        Map<String, Map<String, String>> t = tabelle();
        assertThat(nurAbgebildete(t.get("quantity"))).isEqualTo(MesskanalAbbildung.GROESSE);
        assertThat(nurAbgebildete(t.get("direction"))).isEqualTo(MesskanalAbbildung.RICHTUNG);
        // Eindeutig: kein Vertragswort doppelt.
        assertThat(new HashSet<>(MesskanalAbbildung.GROESSE.values())).hasSize(MesskanalAbbildung.GROESSE.size());
        assertThat(new HashSet<>(MesskanalAbbildung.RICHTUNG.values())).hasSize(MesskanalAbbildung.RICHTUNG.size());
    }

    @Test
    void jedesWortImPaketiertenKatalogStehtInDerTabelleUndJedesVertragswortKenntDerVertrag() throws IOException {
        Map<String, Map<String, String>> t = tabelle();
        Set<String> quantities = new HashSet<>();
        Set<String> directions = new HashSet<>();
        JsonNode paket;
        try (var in = getClass().getClassLoader().getResourceAsStream(
                "measurementcatalog/measurement-point-catalog-" + catalog.inhaltsstand() + ".json")) {
            paket = MAPPER.readTree(in);
        }
        for (JsonNode p : paket.get("points")) {
            if (!p.get("quantity").isNull()) {
                quantities.add(p.get("quantity").asText());
            }
            if (!p.get("direction").isNull()) {
                directions.add(p.get("direction").asText());
            }
        }
        assertThat(t.get("quantity").keySet()).containsAll(quantities);
        assertThat(t.get("direction").keySet()).containsAll(directions);

        JsonNode schema = lies("docs/contracts/v2/messstelle.schema.json");
        assertThat(MessstelleRegeln.KANAL_EINHEITEN.keySet())
                .containsExactlyInAnyOrderElementsOf(MesskanalAbbildung.GROESSE.values());
        assertThat(texte(schema.at("/$defs/richtung/enum")))
                .containsExactlyInAnyOrderElementsOf(MesskanalAbbildung.RICHTUNG.values());
        assertThat(texte(lies("docs/contracts/v2/messwert-herkunft.schema.json").at("/$defs/wertart/enum")))
                .containsExactlyInAnyOrderElementsOf(MesskanalAbbildung.WERTARTEN);
        assertThat(MesskanalAbbildung.wertart("event")).isNull();
        assertThat(MesskanalAbbildung.wertart("none")).isNull();
        assertThat(MesskanalAbbildung.groesse("voltage")).isNull();
        assertThat(MesskanalAbbildung.richtung("import_export")).isNull();
    }

    @Test
    @SuppressWarnings("unchecked")
    void dieAntwortHatDieFormAusDerOpenApi() throws IOException {
        Map<String, Object> schemas;
        try (InputStream in = Files.newInputStream(REPO.resolve("docs/contracts/openapi.yaml"))) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
        }
        PropertyNamingStrategies.SnakeCaseStrategy snake = new PropertyNamingStrategies.SnakeCaseStrategy();
        for (var form : List.of(Map.entry("MesskanalListe", MesskanalDto.Liste.class),
                Map.entry("Messkanal", MesskanalDto.Messkanal.class),
                Map.entry("MesskanalGeraet", MesskanalDto.GeraetEinbau.class))) {
            Map<String, Object> schema = (Map<String, Object>) schemas.get(form.getKey());
            List<String> dto = Arrays.stream(form.getValue().getRecordComponents())
                    .map(c -> snake.translate(c.getName())).toList();
            assertThat(((Map<String, Object>) schema.get("properties")).keySet())
                    .as(form.getKey()).containsExactlyInAnyOrderElementsOf(dto);
            assertThat((List<String>) schema.get("required")).as(form.getKey())
                    .containsExactlyInAnyOrderElementsOf(dto);
        }
        Map<String, Object> kanal = (Map<String, Object>) ((Map<String, Object>) schemas.get("Messkanal"))
                .get("properties");
        assertThat(enumOhneNull(kanal, "groesse")).containsExactlyInAnyOrderElementsOf(MesskanalAbbildung.GROESSE.values());
        assertThat(enumOhneNull(kanal, "richtung")).containsExactlyInAnyOrderElementsOf(MesskanalAbbildung.RICHTUNG.values());
        assertThat(enumOhneNull(kanal, "wertart")).containsExactlyInAnyOrderElementsOf(MesskanalAbbildung.WERTARTEN);

        // Das Gerät (IP-10) hat die Form von `geraet_einbau` des Herkunftsvertrags — plus `id`.
        Set<String> geraet = new HashSet<>(((Map<String, Object>) ((Map<String, Object>) schemas
                .get("MesskanalGeraet")).get("properties")).keySet());
        assertThat(geraet.remove("id")).isTrue();
        JsonNode einbau = lies("docs/contracts/v2/messwert-herkunft.schema.json")
                .at("/$defs/herkunft/properties/geraet_einbau");
        assertThat(geraet).containsExactlyInAnyOrderElementsOf(texte(einbau.get("required")));
        assertThat(einbau.get("properties").fieldNames()).toIterable()
                .containsExactlyInAnyOrderElementsOf(geraet);
    }

    @SuppressWarnings("unchecked")
    private static List<Object> enumOhneNull(Map<String, Object> properties, String feld) {
        return ((List<Object>) ((Map<String, Object>) properties.get(feld)).get("enum")).stream()
                .filter(Objects::nonNull).toList();
    }

    /** Die Fakten eines Katalog-Kanals, wie das Read-Model sie liefert. */
    private record Kanal(String groesse, String richtung, String einheit, String wertart) {}

    private Kanal kanal(String pointKey) {
        MeasurementCatalog.Point p = catalog.resolve(pointKey);
        MeasurementCatalog.Semantik s = catalog.semantik(pointKey);
        return new Kanal(MesskanalAbbildung.groesse(s.quantity()), MesskanalAbbildung.richtung(s.direction()),
                p.unit(), MesskanalAbbildung.wertart(p.aggregationKind()));
    }

    private static MessstelleRegeln.Groesse groesse(JsonNode g) {
        return new MessstelleRegeln.Groesse(g.get("groesse").asText(), g.get("richtung").asText(),
                g.get("einheit").asText(), g.get("wertart").asText());
    }

    private static JsonNode messstelle(JsonNode referenz, String kennzeichen) {
        for (JsonNode ms : referenz.get("messstellen")) {
            if (ms.get("kennzeichen").asText().equals(kennzeichen)) {
                return ms;
            }
        }
        throw new AssertionError("keine Messstelle " + kennzeichen);
    }

    private static MessstelleRegeln.Passung passung(JsonNode ms, MessstelleRegeln.Groesse ziel, Kanal k) {
        return MessstelleRegeln.passung(ms.get("medium").asText(), ziel, k.groesse(), k.richtung(),
                k.einheit(), k.wertart());
    }

    @Test
    void dieKanaeleVonK3PassenAufIhreMessstellenDerReferenz() throws IOException {
        JsonNode referenz = lies("docs/contracts/v2/uems-referenzunternehmen.json");
        JsonNode ms01 = messstelle(referenz, "MS-01");
        JsonNode ms02 = messstelle(referenz, "MS-02");
        assertThat(ms01.at("/fuehrende_quelle/0/komponente").asText()).isEqualTo("K-3");
        assertThat(ms02.at("/fuehrende_quelle/0/komponente").asText()).isEqualTo("K-3");

        Kanal bezug = kanal("sunspec.model_203.totwhimp");
        Kanal abgabe = kanal("sunspec.model_203.totwhexp");
        assertThat(bezug).isEqualTo(new Kanal("Wirkenergie", "Bezug", "Wh", "counter"));
        assertThat(abgabe).isEqualTo(new Kanal("Wirkenergie", "Abgabe", "Wh", "counter"));
        assertThat(bezug.wertart()).isEqualTo(ms01.at("/fuehrende_quelle/0/kanal_wertart").asText());

        MessstelleRegeln.Passung p01 = passung(ms01, groesse(ms01.get("hauptgroesse")), bezug);
        assertThat(p01.fehler()).isNull();
        assertThat(p01.herleitung()).isEqualTo("zaehlerstand");
        MessstelleRegeln.Passung p02 = passung(ms02, groesse(ms02.get("hauptgroesse")), abgabe);
        assertThat(p02.fehler()).isNull();
        assertThat(p02.herleitung()).isEqualTo("zaehlerstand");
        // Bezug ist nicht Abgabe (Regel 7).
        assertThat(passung(ms01, groesse(ms01.get("hauptgroesse")), abgabe).grund()).isEqualTo("richtung");
    }

    /**
     * ⚠ Befund für IP-13: die Referenz speist die Nebengröße „Wirkleistung · Bezug“ von MS-01 aus
     * der Wirkleistung von K-3. Ein Zweirichtungszähler liefert aber EINEN Vorzeichen-Wert
     * ({@code import_export}, im Vertrag ohne Gegenstück, weil Bezug und Abgabe zwei Messstellen
     * sind) — ohne eine Vorzeichen-Aufteilung passt er ehrlich nicht.
     */
    @Test
    void dieVorzeichenLeistungDesZaehlersSpeistKeineBezugsleistungOhneAufteilung() throws IOException {
        JsonNode ms01 = messstelle(lies("docs/contracts/v2/uems-referenzunternehmen.json"), "MS-01");
        JsonNode neben = ms01.at("/nebengroessen/0");
        assertThat(neben.at("/fuehrende_quelle/0/kanal").asText()).isEqualTo("Wirkleistung");

        Kanal leistung = kanal("sunspec.model_203.w");
        assertThat(leistung).isEqualTo(new Kanal("Wirkleistung", null, "W", "gauge"));
        MessstelleRegeln.Passung p = passung(ms01, groesse(neben), leistung);
        assertThat(p.fehler()).isEqualTo(MessstelleRegeln.Fehler.QUELLE_PASST_NICHT);
        assertThat(p.grund()).isEqualTo("richtung");
    }
}
