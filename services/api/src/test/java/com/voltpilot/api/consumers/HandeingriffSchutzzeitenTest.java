package com.voltpilot.api.consumers;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die EINE Einordnung (vp-schalten-3s, Captain-Entscheid C): einfache Lasten schalten von Hand sofort, empfindliche
 * Geräte und alles Unbekannte behalten die Mindestzeiten - geprüft gegen den ganzen Verbraucher-Katalog, damit ein
 * neuer Typ bewusst eingeordnet wird.
 */
class HandeingriffSchutzzeitenTest {

    @Test
    void einfacheLastenSchaltenVonHandSofort() {
        assertThat(HandeingriffSchutzzeiten.sofort("heating-rod")).isTrue();
        assertThat(HandeingriffSchutzzeiten.sofort("generic-load")).isTrue();
    }

    @Test
    void empfindlicheGeraeteUndUnbekanntesBehaltenDieMindestzeiten() {
        for (String t : List.of("heat-pump-sgready", "pump", "wallbox", "ev-charger", "modbus-device", "modbus-load",
                "io-module", "klimaanlage-der-zukunft", "")) {
            assertThat(HandeingriffSchutzzeiten.sofort(t)).as(t).isFalse();
        }
        assertThat(HandeingriffSchutzzeiten.sofort(null)).isFalse();
    }

    /** Jeder Verbrauchertyp des Katalogs steht hier mit seiner Antwort - ein neuer Typ macht den Test rot. */
    @Test
    void jederVerbrauchertypDesKatalogsIstEingeordnet() throws Exception {
        JsonNode katalog = new ObjectMapper().readTree(
                Path.of("src/main/resources/entitytypes/catalog.json").toFile());
        List<String> verbraucher = new ArrayList<>();
        JsonNode typen = katalog.isArray() ? katalog : katalog.path("types");
        typen.forEach(t -> {
            if ("consumer".equals(t.path("category").asText())) {
                verbraucher.add(t.path("type").asText());
            }
        });
        assertThat(verbraucher).containsExactlyInAnyOrder("house-load", "wallbox", "ev-charger", "heating-rod",
                "heat-pump-sgready", "pump", "generic-load", "sub-meter", "io-module", "modbus-device",
                "modbus-load");
        assertThat(verbraucher.stream().filter(HandeingriffSchutzzeiten::sofort).toList())
                .containsExactlyInAnyOrder("heating-rod", "generic-load");
    }
}
