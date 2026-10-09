package com.voltpilot.api.chargers;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.verbraucher.SteuerartProjektion;
import com.voltpilot.api.verbraucher.SteuerartSatz;
import com.voltpilot.api.web.dto.ChargingConfigDto;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * „Sonne + Speicher" (06.10.2026): die geschlossenen Vokabulare der API gegen
 * die GEMEINSAMEN Vertragsvektoren - per PFAD gelesen, dieselbe Datei, die
 * Optimierer, Box und Portal lesen.
 */
class SonneSpeicherVertragTest {

    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2",
            "sonne-speicher-vectors.json");

    private final ObjectMapper json = new ObjectMapper();

    private JsonNode vektoren() throws Exception {
        return json.readTree(Files.readString(VEKTOREN));
    }

    private static Set<String> woerter(JsonNode array) {
        Set<String> out = new HashSet<>();
        array.forEach(n -> out.add(n.asText()));
        return out;
    }

    @Test
    void derUeberschussModusIstDasGemeinsameVokabular() throws Exception {
        assertThat(SteuerartProjektion.MODI).isEqualTo(woerter(vektoren().get("ueberschuss_modus")));
        assertThat(SteuerartSatz.OPTION_SONNE_SPEICHER).isEqualTo(vektoren().get("option_id").asText());
        assertThat(SteuerartProjektion.POLICY_NUR_SONNE)
                .isEqualTo(vektoren().get("lane").get("source").asText());
    }

    @Test
    void dieStufenDerBoxUndDieGruendeDerCloudSindDasGemeinsameVokabular() throws Exception {
        JsonNode v = vektoren();
        Set<String> erwartet = woerter(v.get("box_modes"));
        // „aus" ist die Abwesenheit der Quelle und wird nie gemeldet.
        erwartet.remove("aus");
        erwartet.addAll(woerter(v.get("cloud_reasons")));
        assertThat(ChargerStatusListener.RELEASE_MODES).isEqualTo(erwartet);
    }

    @Test
    void dieReserveVorgabeIstDieDesOptimierers() throws Exception {
        JsonNode r = vektoren().get("reserve_kwh");
        assertThat(ChargingConfigDto.STORAGE_RELEASE_RESERVE_STANDARD_KWH)
                .isEqualTo(r.get("standard").asDouble());
        assertThat(ChargingConfigService.MAX_STORAGE_RELEASE_RESERVE_KWH)
                .isEqualTo(r.get("max").asDouble());
    }

    /** Die Box bekommt das Flag nur neben `nur_sonne` - per PFAD gegen die Fixture. */
    @Test
    void dasDokumentEntsprichtDerSonneSpeicherFixture() throws Exception {
        Path fixture = Path.of("..", "..", "docs", "contracts", "examples",
                "mqtt-charging-config.valid.sonne-speicher.json");
        JsonNode expected = json.readTree(Files.readString(fixture));
        var carport = new ChargingConfigDto.AllowedChargePointDto("wallbox-carport", null, null,
                null, "nur_sonne", null, null, null, null, null, Boolean.TRUE);
        var garage = new ChargingConfigDto.AllowedChargePointDto("wallbox-garage", null, null,
                null, "nur_sonne", null, null, null, null, null, Boolean.FALSE);
        JsonNode actual = json.readTree(new String(ChargingConfigPublisher.document(
                java.util.UUID.fromString("00000000-0000-0000-0000-000000000001"),
                java.util.UUID.fromString("00000000-0000-0000-0000-000000000002"),
                java.util.UUID.fromString("00000000-0000-0000-0000-000000000003"),
                35.0, null, "nur_sonne", "speicher_vor_auto", java.util.List.of(carport, garage),
                null, null, null, null, null, java.time.Instant.parse("2026-10-06T10:15:00Z")),
                java.nio.charset.StandardCharsets.UTF_8));
        assertThat(actual).isEqualTo(expected);
        // Neben einer anderen Bahn ist das Flag keine Aussage - es reist nicht.
        var falsch = new ChargingConfigDto.AllowedChargePointDto("x", null, null, null,
                "sonne_zuerst", null, null, null, null, null, Boolean.TRUE);
        JsonNode d = json.readTree(new String(ChargingConfigPublisher.document(
                java.util.UUID.randomUUID(), java.util.UUID.randomUUID(),
                java.util.UUID.randomUUID(), null, null, null, null, java.util.List.of(falsch),
                null, null, null, null, null, java.time.Instant.parse("2026-10-06T10:15:00Z")),
                java.nio.charset.StandardCharsets.UTF_8));
        assertThat(d.get("charge_points").get(0).has("storage_release")).isFalse();
    }
}
