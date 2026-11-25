package com.voltpilot.api.direktvermarktung;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.direktvermarktung.DirektvermarktungStandBlock.Block;
import com.voltpilot.api.repo.DirektvermarktungRepository.Stand;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import org.junit.jupiter.api.Test;

/**
 * Die geteilten Vektoren der Zustellung ({@code docs/contracts/v2/direktvermarktung-zustellung-vectors.json})
 * pinnen den Herzschlag-Block über drei Sprachen: hier die Java-Lesung (Block → Spiegel-Zeile
 * {@code direktvermarktung_stand}) und die Zustand-Nachführung aus der Lage. Der Go-Zwilling ist
 * {@code edge-app/core/internal/cloud/direktvermarktung_test.go}.
 */
class DirektvermarktungStandBlockTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void jederVektorBlockLiestSichInGenauDieSpiegelZeile() throws Exception {
        JsonNode vectors = JSON.readTree(Files.readString(
                Path.of("../../docs/contracts/v2/direktvermarktung-zustellung-vectors.json")));
        assertThat(vectors.path("bloecke").size()).isGreaterThanOrEqualTo(4);
        for (JsonNode fall : vectors.path("bloecke")) {
            String name = fall.path("name").asText();
            Block block = DirektvermarktungStandBlock.lies(fall.get("block"));
            assertThat(block).as(name).isNotNull();
            JsonNode want = fall.get("stand");
            Stand stand = block.stand();
            assertThat(stand.tunnelObenSeit()).as("%s tunnel_oben_seit", name)
                    .isEqualTo(zeit(want, "tunnel_oben_seit"));
            assertThat(stand.handshakeAm()).as("%s handshake_am", name).isEqualTo(zeit(want, "handshake_am"));
            assertThat(stand.gegenstelle()).as("%s gegenstelle", name).isEqualTo(text(want, "gegenstelle"));
            assertThat(stand.letzteAbfrageAm()).as("%s letzte_abfrage_am", name)
                    .isEqualTo(zeit(want, "letzte_abfrage_am"));
            assertThat(stand.abfragenJeMinute()).as("%s abfragen_je_minute", name)
                    .isEqualTo(want.get("abfragen_je_minute").isNull() ? null
                            : want.get("abfragen_je_minute").doubleValue());
            assertThat(stand.letzteSchreibungAm()).as("%s letzte_schreibung_am", name)
                    .isEqualTo(zeit(want, "letzte_schreibung_am"));
            assertThat(stand.vorgabePct()).as("%s vorgabe_pct", name).isEqualTo(ganz(want, "vorgabe_pct"));
            assertThat(stand.lebenszeichenAm()).as("%s lebenszeichen_am", name)
                    .isEqualTo(zeit(want, "lebenszeichen_am"));
            assertThat(stand.einspeisungW()).as("%s einspeisung_w", name).isEqualTo(ganz(want, "einspeisung_w"));
            assertThat(stand.erzeugungW()).as("%s erzeugung_w", name).isEqualTo(ganz(want, "erzeugung_w"));
            assertThat(stand.netzbetreiberPct()).as("%s netzbetreiber_pct", name)
                    .isEqualTo(ganz(want, "netzbetreiber_pct"));
            assertThat(stand.referenzW()).as("%s referenz_w", name).isEqualTo(ganz(want, "referenz_w"));

            JsonNode zustand = fall.get("zustand");
            assertThat(DirektvermarktungStandBlock.zustandAusLage(block.lage())).as("%s zustand", name)
                    .isEqualTo(zustand.isNull() ? null : zustand.asText());
        }
    }

    @Test
    void dieZustandsTabelleDerVektorenIstGenauDieAbbildung() throws Exception {
        JsonNode vectors = JSON.readTree(Files.readString(
                Path.of("../../docs/contracts/v2/direktvermarktung-zustellung-vectors.json")));
        JsonNode tabelle = vectors.path("zustand_aus_lage");
        assertThat(tabelle.isObject()).isTrue();
        tabelle.fields().forEachRemaining(e -> {
            String want = e.getValue().isNull() ? null : e.getValue().asText();
            assertThat(DirektvermarktungStandBlock.zustandAusLage(e.getKey()))
                    .as("zustand_aus_lage[%s]", e.getKey()).isEqualTo(want);
        });
    }

    @Test
    void ohneBlockBleibtAllesStehen() {
        assertThat(DirektvermarktungStandBlock.lies(null)).isNull();
        assertThat(DirektvermarktungStandBlock.lies(JSON.getNodeFactory().nullNode())).isNull();
        assertThat(DirektvermarktungStandBlock.lies(JSON.getNodeFactory().textNode("x"))).isNull();
    }

    private static Instant zeit(JsonNode n, String feld) {
        JsonNode v = n.get(feld);
        return v == null || v.isNull() ? null : Instant.parse(v.asText());
    }

    private static String text(JsonNode n, String feld) {
        JsonNode v = n.get(feld);
        return v == null || v.isNull() ? null : v.asText();
    }

    private static Integer ganz(JsonNode n, String feld) {
        JsonNode v = n.get(feld);
        return v == null || v.isNull() ? null : v.intValue();
    }
}
