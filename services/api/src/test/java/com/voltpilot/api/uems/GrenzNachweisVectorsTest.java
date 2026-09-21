package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * Der Grenz-Nachweis (UEMS AP-15 IP-31) gegen {@code docs/contracts/v2/netzanschluss-grenznachweis-vectors.json} —
 * rein, ohne Spring und ohne Docker. Die Datei ist die eine Wahrheit; {@link GrenzNachweisRegel} wird aufgerufen,
 * nie nachgebaut.
 */
class GrenzNachweisVectorsTest {

    private static final Path VECTORS = Path.of("..", "..", "docs", "contracts", "v2",
            "netzanschluss-grenznachweis-vectors.json");

    private static JsonNode vektoren() throws Exception {
        return new ObjectMapper().readTree(Files.readString(VECTORS));
    }

    static Stream<Arguments> faelle() throws Exception {
        List<Arguments> out = new ArrayList<>();
        for (JsonNode f : vektoren().path("faelle")) {
            out.add(Arguments.of(f.path("id").asText(), f));
        }
        return out.stream();
    }

    @Test
    void derLaeuferIstVerdrahtet() throws Exception {
        assertThat(vektoren().path("faelle").size()).isGreaterThanOrEqualTo(12);
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("faelle")
    void fall(String id, JsonNode f) {
        String why = id + " (" + f.path("warum").asText() + ")";
        List<GrenzNachweisRegel.Viertelstunde> vs = new ArrayList<>();
        Instant t = Instant.parse(f.path("eingang").path("ab").asText());
        for (JsonNode z : f.path("eingang").path("reihe")) {
            vs.add(new GrenzNachweisRegel.Viertelstunde(t, t.plusSeconds(900), bd(z.get(0)), z.get(1).asBoolean(),
                    z.get(2).isNull() ? null : z.get(2).asText(), bd(z.get(3))));
            t = t.plusSeconds(900);
        }
        GrenzNachweisRegel.Urteil ist = GrenzNachweisRegel.nachweis(vs);
        JsonNode soll = f.path("ergebnis");
        assertThat(ist.grenzeGeprueft()).as(why + " · geprüft").isEqualTo(soll.path("grenze_geprueft").asBoolean());
        assertThat(ist.grund()).as(why + " · Grund").isEqualTo(text(soll.path("grund")));
        assertThat(ist.urteil()).as(why + " · Urteil").isEqualTo(text(soll.path("urteil")));
        JsonNode v = soll.path("viertelstunden");
        assertThat(List.of(ist.erwartet(), ist.belegt(), ist.unvollstaendig(), ist.fehlend())).as(why + " · Viertelstunden")
                .isEqualTo(List.of(v.path("erwartet").asInt(), v.path("belegt").asInt(), v.path("unvollstaendig").asInt(),
                        v.path("fehlend").asInt()));
        assertThat(ist.belegtProzent()).as(why + " · belegt %")
                .isEqualTo(soll.path("belegt_prozent").isNull() ? null : soll.path("belegt_prozent").asInt());
        JsonNode h = soll.path("hoechstes_mittel");
        if (h.isNull()) {
            assertThat(ist.hoechstes()).as(why + " · höchstes Mittel").isNull();
        } else {
            assertThat(ist.hoechstes()).as(why + " · höchstes Mittel").isNotNull();
            assertThat(ist.hoechstes().von()).as(why + " · höchstes von").isEqualTo(Instant.parse(h.path("von").asText()));
            assertThat(ist.hoechstes().bis()).as(why + " · höchstes bis").isEqualTo(Instant.parse(h.path("bis").asText()));
            assertThat(ist.hoechstes().mittelKw()).as(why + " · höchstes kW").isEqualByComparingTo(bd(h.path("mittel_kw")));
            assertThat(ist.hoechstes().grenzeKw()).as(why + " · Grenze").isEqualByComparingTo(bd(h.path("grenze_kw")));
            assertThat(ist.hoechstes().abstandKw()).as(why + " · Abstand").isEqualByComparingTo(bd(h.path("abstand_kw")));
        }
        assertThat(ist.viertelstundenDarueber()).as(why + " · darüber")
                .isEqualTo(soll.path("darueber").path("viertelstunden").asInt());
        assertThat(ist.minutenDarueber()).as(why + " · Minuten darüber")
                .isEqualTo(soll.path("darueber").path("minuten").asLong());
        JsonNode u = soll.path("unterbrechungen");
        assertThat(ist.unterbrechungen()).as(why + " · Unterbrechungen").hasSize(u.size());
        for (int i = 0; i < u.size(); i++) {
            GrenzNachweisRegel.Unterbrechung x = ist.unterbrechungen().get(i);
            JsonNode s = u.get(i);
            assertThat(x.von()).as(why + " · Unterbrechung " + i + " von").isEqualTo(Instant.parse(s.path("von").asText()));
            assertThat(x.bis()).as(why + " · Unterbrechung " + i + " bis").isEqualTo(Instant.parse(s.path("bis").asText()));
            assertThat(x.minuten()).as(why + " · Unterbrechung " + i + " Minuten").isEqualTo(s.path("minuten").asLong());
            assertThat(x.hoechstwertKw()).as(why + " · Unterbrechung " + i + " Höchstwert")
                    .isEqualByComparingTo(bd(s.path("hoechstwert_kw")));
            assertThat(x.grenzeKw()).as(why + " · Unterbrechung " + i + " Grenze")
                    .isEqualByComparingTo(bd(s.path("grenze_kw")));
        }
    }

    @Test
    void kilowattstundenJeViertelstundeSindViermalSovielKilowatt() {
        Instant a = Instant.parse("2026-09-01T00:00:00Z");
        assertThat(GrenzNachweisRegel.mittelAusMenge(new BigDecimal("25"), a, a.plusSeconds(900)))
                .isEqualByComparingTo("100").hasToString("100");
        assertThat(GrenzNachweisRegel.mittelAusMenge(new BigDecimal("12.345"), a, a.plusSeconds(900)))
                .isEqualByComparingTo("49.38");
        assertThat(GrenzNachweisRegel.mittelAusMenge(null, a, a.plusSeconds(900))).as("unbekannt ist keine Null").isNull();
    }

    private static BigDecimal bd(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : new BigDecimal(n.asText());
    }

    private static String text(JsonNode n) {
        return n.isNull() || n.isMissingNode() ? null : n.asText();
    }
}
