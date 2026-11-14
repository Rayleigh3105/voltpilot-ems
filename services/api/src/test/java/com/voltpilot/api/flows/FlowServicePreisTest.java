package com.voltpilot.api.flows;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.FlowRepository.FlowVersionRow;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * {@code preisBausteinAktiv}: ob das AKTIVE Artefakt Preis-Bedingungen
 * ausführt - flowc kompiliert die Preis-Wächter-Kette seit compiler_version
 * 1.1.0. Das Portal nimmt einer Preis-Regel den „wird auf der Box noch nicht
 * ausgeführt"-Hinweis nur, wenn Feed UND Artefakt es belegen; nicht belegbar
 * heißt nie „führt aus".
 */
class FlowServicePreisTest {

    private final ObjectMapper mapper = new ObjectMapper();

    private static FlowVersionRow aktiv(String artifactJson) {
        return new FlowVersionRow(UUID.randomUUID(), 1, UUID.randomUUID(), "Regel", "edge",
                "active", "{}", null, artifactJson, null, null, null, null);
    }

    private Boolean wert(String artifactJson) {
        return FlowService.preisBausteinAktiv(aktiv(artifactJson), mapper);
    }

    @Test
    void aktivesArtefaktAbEinsEinsNullFuehrtPreisAus() {
        assertThat(wert("{\"compiler_version\":\"1.1.0\"}")).isTrue();
        assertThat(wert("{\"compiler_version\":\"1.2.3\"}")).isTrue();
        assertThat(wert("{\"compiler_version\":\"2.0.0\"}")).isTrue();
    }

    @Test
    void aeltereUndUnbelegbareArtefakteFuehrenNichtAus() {
        assertThat(wert("{\"compiler_version\":\"1.0.0\"}")).isFalse();
        assertThat(wert("{\"compiler_version\":\"0.9.9\"}")).isFalse();
        assertThat(wert("{}")).isFalse();
        assertThat(wert("kein json")).isFalse();
        assertThat(wert(null)).isFalse();
    }

    @Test
    void ohneAktiveVersionGibtEsKeineAussage() {
        assertThat(FlowService.preisBausteinAktiv(null, mapper)).isNull();
    }
}
