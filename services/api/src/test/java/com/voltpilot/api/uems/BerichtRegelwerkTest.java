package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Map;
import java.util.Properties;
import org.junit.jupiter.api.Test;

/**
 * Das Regelwerk-Verzeichnis (UEMS AP-12 IP-5, RW1): jede Fassung ist die {@code schema_version} ihrer Vektor-Datei, die
 * Software nennt Version und Build-Kennung, und {@code spring-boot:build-info} legt die Datei an, aus der Spring die
 * Version liest. Rein — ohne Spring, ohne Datenbank.
 */
class BerichtRegelwerkTest {

    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void jedeFassungIstDieSchemaVersionIhrerVektorDatei() throws Exception {
        assertThat(BerichtRegelwerk.VERTRAEGE.keySet()).as("RW1: die sechs Verträge in ihrer Reihenfolge")
                .containsExactly("verbrauch", "ergebnis-zustand", "bilanz", "bilanzwert-herkunft", "kennzahl", "bericht");
        for (Map.Entry<String, String> e : BerichtRegelwerk.VERTRAEGE.entrySet()) {
            Path datei = V2.resolve(e.getKey() + "-vectors.json");
            assertThat(JSON.readTree(Files.readString(datei)).path("schema_version").asText())
                    .as(datei + " — eine neue schema_version gehört auch hierher").isEqualTo(e.getValue());
        }
    }

    @Test
    void dieSoftwareNenntVersionUndBuildKennung_ohneKennungDieBuildZeit() {
        Instant gebaut = Instant.parse("2026-11-10T06:12:00Z");
        assertThat(BerichtRegelwerk.software("0.1.0", gebaut, "0f18bad9"))
                .isEqualTo("voltpilot-api 0.1.0 (0f18bad9)");
        assertThat(BerichtRegelwerk.software("0.1.0", gebaut, " ")).isEqualTo("voltpilot-api 0.1.0 (gebaut 2026-11-10T06:12:00Z)");
        assertThat(BerichtRegelwerk.software(null, null, null)).isEqualTo("voltpilot-api (Build-Kennung unbekannt)");
        assertThat(BerichtRegelwerk.heute("0.1.0", gebaut, "0f18bad9").vertraege())
                .containsExactlyEntriesOf(BerichtRegelwerk.VERTRAEGE);
    }

    @Test
    void buildInfoLiegtImKlassenpfad_eingerichtetImPom() throws Exception {
        try (var in = BerichtRegelwerkTest.class.getResourceAsStream("/META-INF/build-info.properties")) {
            assertThat(in).as("spring-boot:build-info (pom.xml) — ohne die Datei nennt der Abzug keine Version").isNotNull();
            Properties p = new Properties();
            p.load(in);
            assertThat(p.getProperty("build.artifact")).isEqualTo(BerichtRegelwerk.ARTEFAKT);
            assertThat(p.getProperty("build.version")).isNotBlank();
        }
    }
}
