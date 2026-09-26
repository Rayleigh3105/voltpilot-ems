package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die geschlossene Grund-Liste eines Minus-Tages ({@link SteuerungGrund}) gegen
 * {@code docs/contracts/steuerung-tag-vectors.json}, Block {@code grund}: die
 * Schwellen und die Rangfolge stehen in der Datei, die Klasse schreibt sie nicht
 * für sich allein fest (das {@code BezugsdatenVectorsTest}-Muster), und jeder
 * Fall - die echten Tage der Referenzanlage und die Kanten jeder Schwelle -
 * liefert genau die Kennungen, die dort stehen. Rein, ohne Docker.
 */
class SteuerungGrundTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path VECTORS =
            Path.of("..", "..", "docs", "contracts", "steuerung-tag-vectors.json");

    private static JsonNode grund() throws Exception {
        return MAPPER.readTree(Files.readString(VECTORS)).path("grund");
    }

    @Test
    void dieSchwellenUndDieRangfolgeStehenInDerDatei() throws Exception {
        JsonNode g = grund();
        List<String> rangfolge = new ArrayList<>();
        g.path("rangfolge").forEach(n -> rangfolge.add(n.asText()));
        assertThat(rangfolge).containsExactlyElementsOf(SteuerungGrund.RANGFOLGE);
        assertThat(g.path("hoechstens").asInt()).isEqualTo(SteuerungGrund.HOECHSTENS);
        JsonNode s = g.path("schwellen");
        assertThat(s.path("gestern_verkauft_ab_kwh").decimalValue())
                .isEqualByComparingTo(SteuerungGrund.GESTERN_VERKAUFT_AB_KWH);
        assertThat(s.path("haelt_energie_ab_kwh").decimalValue())
                .isEqualByComparingTo(SteuerungGrund.HAELT_ENERGIE_AB_KWH);
        assertThat(s.path("so_geplant_unter_eur").decimalValue())
                .isEqualByComparingTo(SteuerungGrund.SO_GEPLANT_UNTER_EUR);
        assertThat(s.path("wenig_sonne_unter_anteil").decimalValue())
                .isEqualByComparingTo(SteuerungGrund.WENIG_SONNE_UNTER_ANTEIL);
        assertThat(s.path("anders_als_geplant_plan_ab_eur").decimalValue())
                .isEqualByComparingTo(SteuerungGrund.ANDERS_ALS_GEPLANT_PLAN_AB_EUR);
        assertThat(s.path("anders_als_geplant_unter_eur").decimalValue())
                .isEqualByComparingTo(SteuerungGrund.ANDERS_ALS_GEPLANT_UNTER_EUR);
    }

    @Test
    void jederFallLiefertGenauSeineGruende() throws Exception {
        JsonNode faelle = grund().path("faelle");
        assertThat(faelle).isNotEmpty();
        for (JsonNode fall : faelle) {
            JsonNode e = fall.path("eingaben");
            SteuerungGrund.Eingaben eingaben = new SteuerungGrund.Eingaben(
                    dec(e, "steuerungEur"), dec(e, "vergleichSocStartKwh"),
                    dec(e, "echtSocStartKwh"), dec(e, "speicherVorsprungKwh"),
                    dec(e, "steuerungGeplantEur"), dec(e, "pvKwh"), dec(e, "loadKwh"));
            List<String> erwartet = new ArrayList<>();
            fall.path("gruende").forEach(n -> erwartet.add(n.asText()));
            assertThat(SteuerungGrund.of(eingaben))
                    .as(fall.path("name").asText())
                    .containsExactlyElementsOf(erwartet);
        }
    }

    @Test
    void jederGrundIstEinWortDerGeschlossenenListe() throws Exception {
        for (JsonNode fall : grund().path("faelle")) {
            fall.path("gruende").forEach(n -> assertThat(SteuerungGrund.RANGFOLGE)
                    .as(fall.path("name").asText()).contains(n.asText()));
        }
    }

    @Test
    void ohneEinordnungGibtEsKeineListe() {
        // null = nicht berechnet (kein Tag, keine Dreiteilung) - nicht dasselbe
        // wie [] = berechnet, kein Grund.
        assertThat(SteuerungGrund.fuer(new BigDecimal("-3"), null, null)).isNull();
        assertThat(SteuerungGrund.fuer(null, null, null)).isNull();
    }

    private static BigDecimal dec(JsonNode node, String key) {
        JsonNode v = node.path(key);
        return v.isNull() || v.isMissingNode() ? null : v.decimalValue();
    }
}
