package com.voltpilot.api.consumers;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.ConsumerRuntimeStatusRepository.Row;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.stream.Stream;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * Was ein Herzschlag über einen offenen Handeingriff sagt (vp-schalten-3s) - gegen die gemeinsamen Vektoren
 * {@code docs/contracts/v2/schaltspur-abgleich-vectors.json}, die auch der Portal-Zwilling {@code spurUrteil} besteht.
 * Der Status wird wie im Zuhörer gelesen ({@link HeizstabStufe#stufe}).
 */
class SchaltSpurAbgleichTest {

    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2",
            "schaltspur-abgleich-vectors.json");

    static Stream<Arguments> vektoren() throws Exception {
        JsonNode doc = new ObjectMapper().readTree(VEKTOREN.toFile());
        List<Arguments> out = new ArrayList<>();
        doc.get("vectors").forEach(v -> out.add(Arguments.of(v.get("name").asText(), v)));
        assertThat(out).hasSizeGreaterThan(10);
        return out.stream();
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("vektoren")
    void vektor(String name, JsonNode v) {
        JsonNode w = v.get("wunsch");
        List<Integer> ausgaenge = null;
        if (w.hasNonNull("ausgaenge")) {
            ausgaenge = new ArrayList<>();
            for (JsonNode a : w.get("ausgaenge")) {
                ausgaenge.add(a.asInt());
            }
        }
        var wunsch = new SchaltSpurAbgleich.Wunsch(w.get("art").asText(),
                w.hasNonNull("kommando") ? w.get("kommando").asText() : null,
                w.hasNonNull("wert") ? w.get("wert").decimalValue() : null, ausgaenge);
        JsonNode s = v.get("status");
        Row row = new Row(UUID.randomUUID(), s.get("state").asText(),
                s.hasNonNull("reason_code") ? s.get("reason_code").asText() : null, null,
                s.hasNonNull("confirmed") ? s.get("confirmed").asBoolean() : null, null, null,
                HeizstabStufe.stufe(s), null, null);

        assertThat(SchaltSpurAbgleich.urteil(wunsch, row).name().toLowerCase()).as(name)
                .isEqualTo(v.get("urteil").asText());
    }
}
