package com.voltpilot.api.chargers;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/**
 * „Box hat übernommen" (Konzept k1 Regel 4): der Vergleich von Wahl und Echo -
 * gegen den Abschnitt {@code vergleich} des Vertrags
 * {@code docs/contracts/ladepunkt-quelle-echo-vectors.json}, aus dem Box und
 * Portal ihre Hälfte prüfen. Rein, ohne Docker.
 */
class QuellenEchoTest {

    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts",
            "ladepunkt-quelle-echo-vectors.json");

    @Test
    void jederFallDesVertrags() throws Exception {
        JsonNode v = new ObjectMapper().readTree(Files.readString(VEKTOREN));
        JsonNode faelle = v.get("vergleich");
        assertThat(faelle.size()).isGreaterThan(5);
        for (JsonNode f : faelle) {
            QuellenEcho.Wunsch wunsch = f.get("wunsch").isNull() ? null
                    : new QuellenEcho.Wunsch(f.get("wunsch").path("source").asText(null),
                            f.get("wunsch").hasNonNull("min_kw") ? f.get("wunsch").get("min_kw").asDouble() : null,
                            f.get("wunsch").path("storage_release").asBoolean(false));
            // Das Echo geht durch den echten Parser des Herzschlags: ein unbekanntes Wort wird verworfen.
            QuellenEcho.Echo echo = f.get("echo").isNull() ? null : ChargerStatusListener.quelleEcho(f.get("echo"));
            Boolean soll = f.get("uebernommen").isNull() ? null : f.get("uebernommen").asBoolean();
            assertThat(QuellenEcho.uebernommen(wunsch, echo)).as(f.get("name").asText()).isEqualTo(soll);
        }
    }

    @Test
    void derHerzschlagDerBoxIstLesbar() throws Exception {
        // Was die Box schreibt (Abschnitt `box`), liest der Parser vollständig zurück.
        JsonNode v = new ObjectMapper().readTree(Files.readString(VEKTOREN));
        for (JsonNode f : v.get("box")) {
            JsonNode hb = f.get("heartbeat");
            QuellenEcho.Echo echo = ChargerStatusListener.quelleEcho(hb);
            assertThat(echo).as(f.get("name").asText()).isNotNull();
            assertThat(echo.source()).isEqualTo(hb.get("source").asText());
            assertThat(echo.storageRelease()).isEqualTo(hb.get("storage_release").asBoolean());
            assertThat(echo.minKw()).isEqualTo(hb.hasNonNull("min_kw") ? hb.get("min_kw").asDouble() : null);
        }
    }
}
