package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Rolle;
import com.voltpilot.api.uems.SteuerungsverbundZweischritt.Schritt;
import com.voltpilot.api.uems.SteuerungsverbundZweischritt.Tabelle;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Die Reserve der anderen steuerbaren Verbraucher (UEMS AP-15 Folge von IP-19, V3) gegen den Abschnitt
 * {@code reserve_verbraucher} von {@code verbund-anteile-mqtt-vectors.json}: die Ableitung je Box
 * ({@link SteuerungsverbundAbleitung#reserveVerbraucher}) und das Feld auf dem Draht
 * ({@link VerbundAnteileDokument#nutzlast}) — die Box liest dieselben Fälle (Go,
 * {@code lastmgmt/reserve_verbraucher_vectors_test.go}). Rein, ohne DB.
 */
class VerbundAnteileReserveVectorsTest {

    private static final Path VECTORS = Path.of("..", "..", "docs", "contracts", "v2",
            "verbund-anteile-mqtt-vectors.json");
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    void ableitungJeBoxWieDieVektoren() throws Exception {
        JsonNode v = MAPPER.readTree(Files.readString(VECTORS));
        List<SteuerungsverbundAbleitung.Mitglied> mitglieder = List.of(
                new SteuerungsverbundAbleitung.Mitglied(v.path("kennungen").path("E-1").asText(), Rolle.FUEHRT),
                new SteuerungsverbundAbleitung.Mitglied(v.path("kennungen").path("E-4").asText(), Rolle.STEUERT_MIT));
        int n = 0;
        for (JsonNode f : v.path("reserve_verbraucher").path("ableitung")) {
            List<SteuerungsverbundAbleitung.Geraet> geraete = new ArrayList<>();
            List<String> zurReserve = new ArrayList<>();
            for (JsonNode g : f.path("geraete")) {
                String komponente = g.path("komponente").isNull() ? null : g.path("komponente").asText();
                geraete.add(new SteuerungsverbundAbleitung.Geraet(g.path("box").asText(), komponente,
                        richtung(g.path("richtung").asText()), g.path("nenn_kw").decimalValue(),
                        g.path("schreibfreigabe").asBoolean(), null));
                if (komponente != null && SteuerungsverbundAbleitung.zaehltZurReserve(
                        g.path("typ").isNull() ? null : g.path("typ").asText(), g.path("im_ladepark").asBoolean())) {
                    zurReserve.add(komponente);
                }
            }
            Map<String, BigDecimal> ist = SteuerungsverbundAbleitung.reserveVerbraucher(mitglieder, geraete,
                    zurReserve);
            Map<String, BigDecimal> erwartet = new TreeMap<>();
            f.path("erwartet").fields().forEachRemaining(e -> erwartet.put(e.getKey(), e.getValue().decimalValue()));
            assertThat(new TreeMap<>(ist)).as(f.path("name").asText()).isEqualTo(erwartet);
            n++;
        }
        assertThat(n).isEqualTo(4);
    }

    @Test
    void dasFeldAufDemDrahtWieDieBoxEsLiest() throws Exception {
        JsonNode v = MAPPER.readTree(Files.readString(VECTORS));
        UUID t = UUID.fromString(v.path("kennungen").path("tenant").asText());
        UUID s = UUID.fromString(v.path("kennungen").path("site").asText());
        int n = 0;
        for (JsonNode f : v.path("reserve_verbraucher").path("draht")) {
            if (!f.path("erwartet").path("gelesen").asBoolean()) {
                continue; // die Cloud schreibt nie eine negative Reserve (Summe von Nennleistungen > 0)
            }
            BigDecimal reserve = f.path("reserve_bezug").isNull() ? null : f.path("reserve_bezug").decimalValue();
            UUID box = UUID.fromString(f.path("box").asText());
            JsonNode draht = MAPPER.readTree(VerbundAnteileDokument.nutzlast(MAPPER, t, s, box,
                    rolle(f.path("rolle").asText()), 1, 1, Schritt.ZIEL, r3(v), reserve,
                    Instant.parse("2027-10-20T09:00:00Z")));
            JsonNode erwartet = f.path("erwartet").path("reserve_bezug");
            if (erwartet.isNull()) {
                assertThat(draht.has("reserve_verbraucher")).as(f.path("name").asText()).isFalse();
            } else {
                assertThat(draht.path("reserve_verbraucher").path("bezug").asText()).as(f.path("name").asText())
                        .isEqualTo(erwartet.asText());
            }
            assertThat(draht.path("schema_version").asText()).as("additiv").isEqualTo("1.0");
            // die Box prüft das Dokument wie ohne das Feld
            assertThat(VerbundAnteileDokument.lesen(MAPPER, VerbundAnteileDokument.topic(t, s, box),
                    MAPPER.writeValueAsBytes(draht))).isNotNull();
            n++;
        }
        assertThat(n).isEqualTo(4);
    }

    private static Grenzart richtung(String code) {
        return java.util.Arrays.stream(Grenzart.values()).filter(g -> g.code().equals(code)).findFirst().orElseThrow();
    }

    private static Rolle rolle(String code) {
        return java.util.Arrays.stream(Rolle.values()).filter(r -> r.code().equals(code)).findFirst().orElseThrow();
    }

    /** R1/R3: einspeisung 40/60 von 100, bezug 0/77 von 77. */
    private static Tabelle r3(JsonNode v) {
        String e1 = v.path("kennungen").path("E-1").asText();
        String e4 = v.path("kennungen").path("E-4").asText();
        Map<Grenzart, Map<String, BigDecimal>> a = new EnumMap<>(Grenzart.class);
        a.put(Grenzart.EINSPEISUNG, new TreeMap<>(Map.of(e1, new BigDecimal("40.0"), e4, new BigDecimal("60.0"))));
        a.put(Grenzart.BEZUG, new TreeMap<>(Map.of(e1, new BigDecimal("0.0"), e4, new BigDecimal("77.0"))));
        Map<Grenzart, BigDecimal> verteilbar = new EnumMap<>(Grenzart.class);
        verteilbar.put(Grenzart.EINSPEISUNG, new BigDecimal("100.0"));
        verteilbar.put(Grenzart.BEZUG, new BigDecimal("77.0"));
        return new Tabelle(a, verteilbar);
    }
}
