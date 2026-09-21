package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/** Die Vektoren {@code docs/contracts/v2/sprungprobe-vectors.json} gegen {@link SprungprobeRegel} (AP-15 IP-21). */
class SprungprobeRegelTest {

    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2", "sprungprobe-vectors.json");

    private static JsonNode vektoren() throws Exception {
        return new ObjectMapper().readTree(Files.readString(VEKTOREN));
    }

    static Stream<Arguments> auswertung() throws Exception {
        List<Arguments> faelle = new ArrayList<>();
        vektoren().path("auswertung").forEach(v -> faelle.add(Arguments.of(v.path("name").asText(), v)));
        return faelle.stream();
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("auswertung")
    void auswertung(String name, JsonNode v) {
        List<SprungprobeRegel.Sprung> spruenge = new ArrayList<>();
        v.path("spruenge").forEach(s -> spruenge.add(new SprungprobeRegel.Sprung(zahl(s.path("eigene_kw")),
                zahl(s.path("netz_vorher_kw")), zahl(s.path("netz_waehrend_kw")))));
        SprungprobeRegel.Ergebnis e = SprungprobeRegel.auswerten(SprungprobeRegel.Art.aus(v.path("art").asText()),
                v.path("abgebrochen").asBoolean(), text(v.path("abbruch_grund")), spruenge);
        JsonNode soll = v.path("erwartet");
        assertThat(e.urteil()).isEqualTo(soll.path("urteil").asText());
        assertThat(e.grund()).isEqualTo(text(soll.path("grund")));
        for (int i = 0; i < e.messungen().size(); i++) {
            assertThat(vergleich(e.messungen().get(i).gesehenKw())).as("gesehen " + i)
                    .isEqualTo(vergleich(zahl(soll.path("gesehen_kw").get(i))));
            assertThat(vergleich(e.messungen().get(i).toleranzKw())).as("toleranz " + i)
                    .isEqualTo(vergleich(zahl(soll.path("toleranz_kw").get(i))));
        }
        assertThat(e.messungen()).hasSize(soll.path("gesehen_kw").size());
        if (e.grund() != null) {
            List<String> vokabular = switch (e.urteil()) {
                case SprungprobeRegel.NICHT_BESTANDEN -> SprungprobeRegel.GRUENDE_NICHT_BESTANDEN;
                case SprungprobeRegel.NICHT_AUSWERTBAR -> SprungprobeRegel.GRUENDE_NICHT_AUSWERTBAR;
                default -> SprungprobeRegel.GRUENDE_ABGEBROCHEN;
            };
            assertThat(vokabular).contains(e.grund());
        }
    }

    @Test
    void entwertenBeimAendern() throws Exception {
        for (JsonNode v : vektoren().path("entwerten_beim_aendern")) {
            Set<String> signal = new HashSet<>();
            v.path("signal_geaendert").forEach(s -> signal.add(s.asText()));
            assertThat(new ArrayList<>(SprungprobeRegel.betroffenBeimAendern(eintraege(v.path("vorher")),
                    eintraege(v.path("nachher")), signal))).as(v.path("name").asText())
                    .containsExactlyElementsOf(woerter(v.path("erwartet")));
        }
    }

    @Test
    void entwertenBeimWechsel() throws Exception {
        JsonNode alle = vektoren();
        List<SprungprobeRegel.Eintrag> mitglieder = eintraege(alle.path("mitglieder_beim_wechsel"));
        for (JsonNode v : alle.path("entwerten_beim_wechsel")) {
            assertThat(new ArrayList<>(SprungprobeRegel.betroffenBeimWechsel(mitglieder, v.path("quelle").asText(),
                    v.path("steuerquelle").asBoolean(), text(v.path("bisher")), text(v.path("kuenftig")))))
                    .as(v.path("name").asText()).containsExactlyElementsOf(woerter(v.path("erwartet")));
        }
    }

    @Test
    void obergrenzenSindBenannt() {
        assertThat(SprungprobeRegel.MAX_SPRUNG_KW).isEqualByComparingTo("50");
        assertThat(SprungprobeRegel.DAUER_S).isEqualTo(60);
        assertThat(SprungprobeRegel.WIEDERHOLUNGEN).isEqualTo(2);
        assertThat(SprungprobeRegel.toleranz(new BigDecimal("30"))).isEqualByComparingTo("3");
        assertThat(SprungprobeRegel.toleranz(new BigDecimal("-8"))).isEqualByComparingTo("2");
    }

    private static List<SprungprobeRegel.Eintrag> eintraege(JsonNode n) {
        List<SprungprobeRegel.Eintrag> l = new ArrayList<>();
        n.forEach(e -> l.add(new SprungprobeRegel.Eintrag(e.path("box").asText(), e.path("rolle").asText(),
                text(e.path("messpunkt")))));
        return l;
    }

    private static List<String> woerter(JsonNode n) {
        List<String> l = new ArrayList<>();
        n.forEach(e -> l.add(e.asText()));
        return l;
    }

    private static BigDecimal zahl(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : n.decimalValue();
    }

    private static String text(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : n.asText();
    }

    private static String vergleich(BigDecimal d) {
        return d == null ? null : d.stripTrailingZeros().toPlainString();
    }
}
