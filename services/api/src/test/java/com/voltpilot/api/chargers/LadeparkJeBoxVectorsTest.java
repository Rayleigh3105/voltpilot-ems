package com.voltpilot.api.chargers;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.ChargingConfigDto.AllowedChargePointDto;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Die Vektoren des Ladepark-Dokuments je Box (UEMS AP-15 IP-16, {@code docs/contracts/v2/ladepark-je-box-vectors.json}):
 * der Ausschnitt der Rangliste je Box in unveränderter Reihenfolge. Rein, ohne Datenbank; einziger Leser der Datei.
 */
class LadeparkJeBoxVectorsTest {

    private static final Path VECTORS = Path.of("../../docs/contracts/v2/ladepark-je-box-vectors.json");
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    void jedeBoxBekommtIhrenAusschnittInDerReihenfolgeDerAnlage() throws Exception {
        JsonNode faelle = MAPPER.readTree(Files.readString(VECTORS)).path("ausschnitt");
        assertThat(faelle).hasSize(3);
        for (JsonNode f : faelle) {
            List<AllowedChargePointDto> anlage = new ArrayList<>();
            f.path("saeulen").forEach(s -> anlage.add(saeule(s)));
            List<String> vorrang = new ArrayList<>();
            f.path("vorrang").forEach(v -> vorrang.add(v.asText()));
            Set<String> gemeldet = new HashSet<>();
            f.path("boxen").forEach(b -> b.path("gemeldet").forEach(g -> gemeldet.add(g.asText())));
            for (Map.Entry<String, JsonNode> box : felder(f.path("boxen")).entrySet()) {
                boolean fuehrt = box.getValue().path("fuehrt").asBoolean();
                Set<String> eigene = new HashSet<>();
                box.getValue().path("gemeldet").forEach(g -> eigene.add(g.asText()));
                JsonNode soll = f.path("erwartet").path(box.getKey());
                String wo = f.path("fall").asText() + " / " + box.getKey();

                List<String> istSaeulen = LadeparkAusschnitt.saeulen(anlage, fuehrt, eigene, gemeldet).stream()
                        .map(c -> c.chargePointId() + "#" + c.rank()).toList();
                List<String> sollSaeulen = new ArrayList<>();
                soll.path("saeulen").forEach(s -> sollSaeulen.add(s.path("id").asText() + "#"
                        + (s.hasNonNull("rank") ? s.path("rank").asInt() : null)));
                assertThat(istSaeulen).as(wo + " Säulen mit Rang der Anlage").isEqualTo(sollSaeulen);

                List<String> sollVorrang = new ArrayList<>();
                soll.path("vorrang").forEach(v -> sollVorrang.add(v.asText()));
                assertThat(LadeparkAusschnitt.vorrang(vorrang, fuehrt, eigene, gemeldet)).as(wo + " Vorrang")
                        .isEqualTo(sollVorrang);
            }
        }
    }

    @Test
    void ohneAussageDerAnlageSagtAuchDerAusschnittNichts() {
        assertThat(LadeparkAusschnitt.vorrang(null, true, Set.of(), Set.of())).isNull();
        assertThat(LadeparkAusschnitt.saeulen(null, true, Set.of(), Set.of())).isNull();
        assertThat(LadeparkAusschnitt.wallboxen(null, true, Set.of(), Set.of())).isNull();
    }

    private static AllowedChargePointDto saeule(JsonNode s) {
        return new AllowedChargePointDto(s.path("id").asText(), null, null, null, null, null, null,
                s.hasNonNull("rank") ? s.path("rank").asInt() : null, null, null);
    }

    private static Map<String, JsonNode> felder(JsonNode n) {
        Map<String, JsonNode> m = new LinkedHashMap<>();
        n.fields().forEachRemaining(e -> m.put(e.getKey(), e.getValue()));
        return m;
    }
}
