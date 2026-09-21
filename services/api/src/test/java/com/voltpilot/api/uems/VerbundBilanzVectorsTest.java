package com.voltpilot.api.uems;

import static com.voltpilot.api.uems.BilanzVectorsTest.bd;
import static com.voltpilot.api.uems.BilanzVectorsTest.lies;
import static com.voltpilot.api.uems.BilanzVectorsTest.str;
import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die Vektoren der Verbund-Bilanz (UEMS AP-15 IP-12) gegen die reine Regel {@link VerbundBilanzRegel}: je Viertelstunde
 * Zustand, Ungeregeltes und Toleranz, je Tag Zustand, Grund und Zählung (B5: unbekannt ist keine Null).
 */
class VerbundBilanzVectorsTest {

    private static final Path VECTORS = Path.of("..", "..", "docs", "contracts", "v2", "verbund-bilanz-vectors.json");
    private static final Instant T0 = Instant.parse("2027-06-12T22:00:00Z");

    @Test
    void jedeViertelstundeWieImVektor() throws Exception {
        JsonNode faelle = lies(VECTORS).path("viertelstunden");
        assertThat(faelle.size()).isGreaterThanOrEqualTo(8);
        for (JsonNode f : faelle) {
            VerbundBilanzRegel.UrteilViertelstunde u = VerbundBilanzRegel.viertelstunde(
                    new VerbundBilanzRegel.Viertelstunde(T0, bd(f.path("netzpunkt_kw")), boxen(f.path("box_kw"))));
            JsonNode e = f.path("erwartet");
            String fall = f.path("fall").asText();
            assertThat(u.zustand()).as(fall).isEqualTo(e.path("zustand").asText());
            if (e.has("ungeregelt_kw")) {
                assertThat(u.ungeregeltKw()).as(fall).isEqualByComparingTo(bd(e.path("ungeregelt_kw")));
                assertThat(u.toleranzKw()).as(fall).isEqualByComparingTo(bd(e.path("toleranz_kw")));
            } else {
                assertThat(u.ungeregeltKw()).as(fall).isNull();
            }
        }
    }

    @Test
    void jederTagWieImVektor() throws Exception {
        for (JsonNode f : lies(VECTORS).path("tage")) {
            List<VerbundBilanzRegel.Viertelstunde> vs = new ArrayList<>();
            Instant von = T0;
            for (JsonNode m : f.path("muster")) {
                for (int i = 0; i < m.path("anzahl").asInt(); i++) {
                    vs.add(new VerbundBilanzRegel.Viertelstunde(von, bd(m.path("netzpunkt_kw")),
                            boxen(m.path("box_kw"))));
                    von = von.plus(Duration.ofMinutes(15));
                }
            }
            String fest = str(f.path("grund_fest"));
            VerbundBilanzRegel.Grund grund = fest == null ? null : Arrays.stream(VerbundBilanzRegel.Grund.values())
                    .filter(g -> g.code().equals(fest)).findFirst().orElseThrow();
            VerbundBilanzRegel.Urteil u = VerbundBilanzRegel.tag(f.path("erwartet_viertelstunden").asInt(), vs, grund);
            JsonNode e = f.path("erwartet");
            String fall = f.path("fall").asText();
            assertThat(u.zustand()).as(fall).isEqualTo(e.path("zustand").asText());
            assertThat(u.grund()).as(fall).isEqualTo(str(e.path("grund")));
            assertThat(u.plausibel()).as(fall).isEqualTo(e.path("plausibel").asInt());
            assertThat(u.unplausibel()).as(fall).isEqualTo(e.path("unplausibel").asInt());
            assertThat(u.unbekannt()).as(fall).isEqualTo(e.path("unbekannt").asInt());
            assertThat(u.erwartet()).as(fall).isEqualTo(f.path("erwartet_viertelstunden").asInt());
            if (e.has("geringstes_ungeregelt_kw")) {
                assertThat(u.geringstes().ungeregeltKw()).as(fall)
                        .isEqualByComparingTo(bd(e.path("geringstes_ungeregelt_kw")));
            }
            if (e.has("hoechstes_ungeregelt_kw")) {
                assertThat(u.hoechstes().ungeregeltKw()).as(fall)
                        .isEqualByComparingTo(bd(e.path("hoechstes_ungeregelt_kw")));
            }
        }
    }

    @Test
    void dieKonstantenSindDieDesVertrags() throws Exception {
        JsonNode v = lies(VECTORS);
        assertThat(v.path("fassung").asText()).isEqualTo(VerbundBilanzRegel.FASSUNG);
        assertThat(v.path("toleranz").asText()).contains("2 kW").contains("5 %");
        assertThat(VerbundBilanzRegel.TOLERANZ_MIN_KW).isEqualByComparingTo("2");
        assertThat(VerbundBilanzRegel.TOLERANZ_ANTEIL).isEqualByComparingTo("0.05");
        assertThat(v.path("tag").asText()).startsWith("unplausibel ab " + VerbundBilanzRegel.MINDESTENS_UNPLAUSIBEL);
        assertThat(VerbundBilanzRegel.ZUSTAENDE).containsExactly("plausibel", "unplausibel", "unbekannt");
    }

    private static List<BigDecimal> boxen(JsonNode n) {
        List<BigDecimal> out = new ArrayList<>();
        n.forEach(x -> out.add(bd(x)));
        return out;
    }
}
