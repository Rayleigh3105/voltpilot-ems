package com.voltpilot.api.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.StandortLesemodell.StandortBezug;
import com.voltpilot.api.web.dto.SiteDetailDto;
import com.voltpilot.api.web.dto.SiteDto;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.http.converter.json.Jackson2ObjectMapperBuilder;

/**
 * {@code GET /api/v1/sites/{siteId}} ist die {@code Site}-Zeile der Liste —
 * FLACH, in derselben Reihenfolge, zeichengleich — plus additiv am Ende
 * {@code standort} (UEMS AP-02 IP-3). Bewiesen an Jacksons eigener Serialisierung,
 * weil {@code @JsonUnwrapped} an einem Record sonst leise ein verschachteltes
 * {@code site}-Objekt ergäbe.
 */
class SiteDetailDtoJsonTest {

    /** Wie Spring Boot ihn baut: Tage als ISO-Text, nie als Zahlen-Feld. */
    private static final ObjectMapper JSON = Jackson2ObjectMapperBuilder.json()
            .featuresToDisable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS).build();

    private static final SiteDto SITE = new SiteDto(UUID.fromString(
            "00000000-0000-0000-0000-000000000002"), "Werk Ahrenberg – Halle 1", "DE-LU",
            new BigDecimal("48.250000"), new BigDecimal("11.430000"), "eigenverbrauch", null,
            null, "ohne", null, false, null, null, "jahr", null, null, "gewerbe");

    @Test
    void ohneStandortIstEsDieListenZeilePlusStandortNull() throws Exception {
        JsonNode detail = JSON.readTree(JSON.writeValueAsString(new SiteDetailDto(SITE, null)));
        JsonNode liste = JSON.readTree(JSON.writeValueAsString(SITE));

        assertThat(feldnamen(detail)).containsExactlyElementsOf(mitStandort(feldnamen(liste)));
        assertThat(detail.path("standort").isNull()).isTrue();
        ObjectNode ohne = detail.deepCopy();
        ohne.remove("standort");
        assertThat(JSON.writeValueAsString(ohne)).isEqualTo(JSON.writeValueAsString(liste));
    }

    @Test
    void mitStandortTraegtEsGenauDieVierFelder() throws Exception {
        StandortBezug bezug = new StandortBezug(UUID.fromString(
                "3f3e1c6e-0000-0000-0000-000000000001"), "Werk Ahrenberg", "ST-1",
                LocalDate.of(2024, 3, 12));
        JsonNode detail = JSON.readTree(JSON.writeValueAsString(new SiteDetailDto(SITE, bezug)));

        assertThat(feldnamen(detail.path("standort")))
                .containsExactly("id", "name", "kurzzeichen", "gueltigAb");
        assertThat(detail.path("standort").path("gueltigAb").asText()).isEqualTo("2024-03-12");
        assertThat(detail.path("standort").path("kurzzeichen").asText()).isEqualTo("ST-1");
        assertThat(detail.has("site")).as("flach, nie verschachtelt").isFalse();
    }

    private static List<String> feldnamen(JsonNode n) {
        List<String> out = new ArrayList<>();
        n.fieldNames().forEachRemaining(out::add);
        return out;
    }

    private static List<String> mitStandort(List<String> felder) {
        List<String> out = new ArrayList<>(felder);
        out.add("standort");
        return out;
    }
}
