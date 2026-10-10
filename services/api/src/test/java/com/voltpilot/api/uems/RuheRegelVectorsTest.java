package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.RuheRegel.Ablehnung;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der Java-Zwilling der Ruhe bis zum Start (UEMS AP-01 IP-4, Regel R0) gegen
 * {@code docs/contracts/v2/override-vectors.json} — dieselbe Datei, die der Go-Core
 * ({@code internal/entities/ruhe_vectors_test.go}) für die Box liest. Hier jeder Block; die
 * CHECKs der Tabelle prüft {@code UemsRuheBisZumStartMigrationTest} gegen {@code zeilen}, den
 * wirklich zusammengesetzten Push {@code EntityRegistryRuhePushTest} gegen {@code push}.
 */
class RuheRegelVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path VECTORS = Path.of("..", "..", "docs", "contracts", "v2", "override-vectors.json");

    static JsonNode vektoren() throws Exception {
        return MAPPER.readTree(Files.readString(VECTORS));
    }

    static Instant zeit(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : Instant.parse(n.asText());
    }

    static String text(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : n.asText();
    }

    private static Stream<DynamicTest> faelle(String block, java.util.function.Consumer<JsonNode> pruefung)
            throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        JsonNode faelle = vektoren().path(block);
        assertThat(faelle.size()).as("Block " + block + " ist nicht leer").isPositive();
        faelle.forEach(f -> tests.add(DynamicTest.dynamicTest(block + ": " + f.path("name").asText(),
                () -> pruefung.accept(f))));
        return tests.stream();
    }

    @TestFactory
    Stream<DynamicTest> zeilen() throws Exception {
        return faelle("zeilen", f -> {
            JsonNode in = f.path("input");
            JsonNode erwartet = f.path("expected");
            var ablehnung = RuheRegel.zeileAbgelehnt(in.path("kind").asText(), text(in.path("herkunft")),
                    zeit(in.path("ends_at")));
            assertThat(ablehnung.isEmpty()).as("zulässig").isEqualTo(erwartet.path("zulaessig").asBoolean());
            assertThat(ablehnung.map(Ablehnung::code).orElse(null)).isEqualTo(text(erwartet.path("grund")));
            assertThat(ablehnung.map(Ablehnung::constraint).orElse(null))
                    .isEqualTo(text(erwartet.path("constraint")));
        });
    }

    @TestFactory
    Stream<DynamicTest> push() throws Exception {
        return faelle("push", f -> {
            JsonNode pause = f.path("input").path("pause");
            JsonNode felder = f.path("expected").path("felder");
            if (pause.isNull()) {
                assertThat(felder.size()).as("ohne Pause kein Feld").isZero();
                return;
            }
            RuheRegel.PushFelder ist = RuheRegel.push(zeit(pause.path("ends_at")), zeit(f.path("input").path("jetzt")));
            assertThat(ist.ende()).isEqualTo(zeit(felder.path(RuheRegel.FELD_ENDE)));
            assertThat(ist.bisAufWiderruf()).isEqualTo(felder.path(RuheRegel.FELD_WIDERRUF).asBoolean(false));
            assertThat(felder.has(RuheRegel.FELD_WIDERRUF)).as("das Feld fehlt ganz, wenn es nicht true ist")
                    .isEqualTo(ist.bisAufWiderruf());
        });
    }

    @TestFactory
    Stream<DynamicTest> box() throws Exception {
        return faelle("box", f -> {
            JsonNode felder = f.path("input").path("felder");
            assertThat(RuheRegel.ruht(zeit(felder.path(RuheRegel.FELD_ENDE)),
                    felder.path(RuheRegel.FELD_WIDERRUF).asBoolean(false), zeit(f.path("input").path("jetzt"))))
                    .isEqualTo(f.path("expected").path("ruht").asBoolean());
        });
    }

    @TestFactory
    Stream<DynamicTest> boxAlt() throws Exception {
        return faelle("box_alt", f -> {
            JsonNode felder = f.path("input").path("felder");
            assertThat(RuheRegel.ruhtAeltereBox(zeit(felder.path(RuheRegel.FELD_ENDE)),
                    zeit(f.path("input").path("jetzt"))))
                    .isEqualTo(f.path("expected").path("ruht").asBoolean());
        });
    }

    @TestFactory
    Stream<DynamicTest> erneuerung() throws Exception {
        return faelle("erneuerung", f -> assertThat(RuheRegel.erneuernFaellig(
                zeit(f.path("input").path("zuletzt_gesendet")), zeit(f.path("input").path("jetzt"))))
                .isEqualTo(f.path("expected").path("faellig").asBoolean()));
    }

    /**
     * Jeder Push der Datei ist ein gültiger Registry-Push nach {@code edge-entity.schema.json}
     * ({@code additionalProperties: false}) — ein neues Feld, das der Vertrag nicht kennt, fiele hier auf.
     */
    @TestFactory
    Stream<DynamicTest> jederPushHaeltDasRegistrySchema() throws Exception {
        JsonNode schema = MAPPER.readTree(Files.readString(VECTORS.resolveSibling("edge-entity.schema.json")));
        var wurzel = MAPPER.createObjectNode();
        wurzel.put("$ref", "#/$defs/registry_push");
        wurzel.set("$defs", schema.path("$defs"));
        return faelle("push", f -> {
            var push = MAPPER.createObjectNode();
            push.put("schema_version", "1.0");
            push.put("tenant_id", "00000000-0000-0000-0000-000000000001");
            push.put("site_id", "00000000-0000-0000-0000-000000000002");
            push.put("device_id", "00000000-0000-0000-0000-000000000003");
            push.put("revision", f.path("input").path("jetzt").asText());
            push.put("published_at", f.path("input").path("jetzt").asText());
            push.setAll((com.fasterxml.jackson.databind.node.ObjectNode) f.path("expected").path("felder"));
            push.putArray("entities");
            assertThat(UemsSchemaLaeufer.verstoesse(push, wurzel)).isEmpty();
        });
    }

    @Test
    void dasSchemaLehntEinUnbekanntesPausenFeldAb() throws Exception {
        JsonNode schema = MAPPER.readTree(Files.readString(VECTORS.resolveSibling("edge-entity.schema.json")));
        var wurzel = MAPPER.createObjectNode();
        wurzel.put("$ref", "#/$defs/registry_push");
        wurzel.set("$defs", schema.path("$defs"));
        var push = MAPPER.createObjectNode();
        push.put("schema_version", "1.0");
        push.put("tenant_id", "00000000-0000-0000-0000-000000000001");
        push.put("site_id", "00000000-0000-0000-0000-000000000002");
        push.put("device_id", "00000000-0000-0000-0000-000000000003");
        push.put("revision", "r");
        push.put("published_at", "2026-12-01T08:00:00Z");
        push.putArray("entities");
        push.put("automation_paused_forever", true);
        assertThat(UemsSchemaLaeufer.verstoesse(push, wurzel)).as("der Läufer beißt").isNotEmpty();
        push.remove("automation_paused_forever");
        push.put(RuheRegel.FELD_WIDERRUF, false);
        assertThat(UemsSchemaLaeufer.verstoesse(push, wurzel)).as("nur true wird gesendet").isNotEmpty();
    }

    /** Die Zahlen der Datei SIND die Zahlen des Codes — und das rollierende Ende überdauert einen Takt. */
    @Test
    void dieKonstantenSindDieDesCodes() throws Exception {
        JsonNode k = vektoren().path("konstanten");
        assertThat(Duration.ofSeconds(k.path("ende_fuer_aeltere_box_s").asLong())).isEqualTo(RuheRegel.ENDE_FUER_AELTERE_BOX);
        assertThat(Duration.ofSeconds(k.path("erneuern_nach_s").asLong())).isEqualTo(RuheRegel.ERNEUERN_NACH);
        assertThat(RuheRegel.ENDE_FUER_AELTERE_BOX)
                .isGreaterThan(RuheRegel.ERNEUERN_NACH.plusSeconds(k.path("takt_s").asLong()));
    }

    /** Jede Ablehnung ist gepinnt, jeder Name ist eindeutig, jeder Fall sagt, warum er da ist. */
    @Test
    void jedeAblehnungIstGepinnt() throws Exception {
        JsonNode root = vektoren();
        Set<String> gruende = new LinkedHashSet<>();
        root.path("zeilen").forEach(f -> {
            if (!f.path("expected").path("grund").isNull()) {
                gruende.add(f.path("expected").path("grund").asText());
            }
        });
        assertThat(gruende).containsExactlyInAnyOrder(
                Stream.of(Ablehnung.values()).map(Ablehnung::code).toArray(String[]::new));
        Set<String> namen = new LinkedHashSet<>();
        for (String block : List.of("zeilen", "push", "box", "box_alt", "erneuerung")) {
            root.path(block).forEach(f -> {
                assertThat(namen.add(f.path("name").asText())).as("Name eindeutig: " + f.path("name")).isTrue();
                assertThat(f.path("why").asText()).as("why: " + f.path("name")).isNotBlank();
            });
        }
    }
}
