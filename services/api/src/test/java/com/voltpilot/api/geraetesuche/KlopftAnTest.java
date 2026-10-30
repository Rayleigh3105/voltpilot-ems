package com.voltpilot.api.geraetesuche;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.UemsSchemaLaeufer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/** OCPP „klopft an“ gegen {@code docs/contracts/ocpp-klopft-an-vectors.json} und das Schema des Feldes. */
class KlopftAnTest {

    private static final Path VERTRAG = Path.of("..", "..", "docs", "contracts");
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void dieApiLiestTolerantUndUnbekanntBleibtUnbekannt() throws Exception {
        JsonNode v = JSON.readTree(Files.readString(VERTRAG.resolve("ocpp-klopft-an-vectors.json")));
        JsonNode schema = JSON.readTree(Files.readString(VERTRAG.resolve("ocpp-klopft-an.schema.json")));
        assertThat(v.at("/grenzen/max_eintraege").asInt()).isEqualTo(KlopftAn.MAX_EINTRAEGE);
        assertThat(v.at("/grenzen/max_versuche").asInt()).isEqualTo(KlopftAn.MAX_VERSUCHE);
        List<String> box = new ArrayList<>();
        v.path("box_adressen").forEach(a -> box.add(a.asText()));
        for (JsonNode c : v.path("lesen")) {
            String name = c.path("name").asText();
            List<KlopftAn.Eintrag> gelesen = KlopftAn.lesen(c.path("block"), box);
            if (c.path("erwartet").isNull()) {
                assertThat(gelesen).as(name).isNull();
            } else {
                List<String> ist = gelesen.stream().map(e -> e.chargePointId() + "@" + e.ip()).toList();
                List<String> soll = new ArrayList<>();
                c.path("erwartet").forEach(e -> soll.add(e.path("id").asText() + "@" + e.path("ip").textValue()));
                assertThat(ist).as(name).isEqualTo(soll);
            }
            JsonNode feld = c.path("block").path("rejected");
            if (!feld.isMissingNode()) {
                assertThat(UemsSchemaLaeufer.verstoesse(feld, schema).isEmpty()).as(name)
                        .isEqualTo(!c.path("schema_lehnt_ab").asBoolean(false));
            }
        }
    }
}
