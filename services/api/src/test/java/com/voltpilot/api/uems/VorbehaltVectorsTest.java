package com.voltpilot.api.uems;

import static com.voltpilot.api.uems.BilanzVectorsTest.bd;
import static com.voltpilot.api.uems.BilanzVectorsTest.lies;
import static com.voltpilot.api.uems.BilanzVectorsTest.str;
import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die Vektoren des Vorbehalts aus Messwerten (UEMS AP-15 IP-13, B4/W10/R23) gegen die reine Regel
 * {@link VorbehaltRegel}: 430 kW → 473 kW, 450 kW → 495 kW selbsttätig, die Lücke verändert nichts, unter 30
 * Messtagen gilt der erklärte Wert weiter.
 */
class VorbehaltVectorsTest {

    private static final Path VECTORS = Path.of("..", "..", "docs", "contracts", "v2", "vorbehalt-vectors.json");

    @Test
    void jederFallWieImVektor() throws Exception {
        JsonNode faelle = lies(VECTORS).path("faelle");
        assertThat(faelle.size()).isGreaterThanOrEqualTo(12);
        for (JsonNode f : faelle) {
            String fall = f.path("fall").asText();
            List<VorbehaltRegel.Tag> tage = new ArrayList<>();
            for (JsonNode t : f.path("tage")) {
                LocalDate von = LocalDate.parse(t.has("tag") ? t.path("tag").asText() : t.path("von").asText());
                LocalDate bis = t.has("tag") ? von : LocalDate.parse(t.path("bis").asText());
                for (LocalDate d = von; !d.isAfter(bis); d = d.plusDays(1)) {
                    tage.add(new VorbehaltRegel.Tag(d, bd(t.path("hoechstes_kw")), null));
                }
            }
            VorbehaltRegel.Urteil u = VorbehaltRegel.pruefen(bd(f.path("alt_kw")), tage,
                    LocalDate.parse(f.path("heute").asText()));
            JsonNode e = f.path("erwartet");
            assertThat(u.aktion().code()).as(fall).isEqualTo(e.path("aktion").asText());
            assertThat(u.grund() == null ? null : u.grund().code()).as(fall).isEqualTo(str(e.path("grund")));
            if (e.path("neu_kw").isNull()) {
                assertThat(u.neuKw()).as(fall).isNull();
            } else {
                assertThat(u.neuKw().toPlainString()).as(fall + " (Skala 0,1 kW)").isEqualTo(e.path("neu_kw").asText());
            }
            if (e.path("hoechstwert_kw").isNull()) {
                assertThat(u.hoechstwertKw()).as(fall).isNull();
            } else {
                assertThat(u.hoechstwertKw()).as(fall).isEqualByComparingTo(bd(e.path("hoechstwert_kw")));
            }
            assertThat(u.messtage()).as(fall).isEqualTo(e.path("messtage").asInt());
            if (e.has("zeitraum_von")) {
                assertThat(u.zeitraumVon()).as(fall).isEqualTo(LocalDate.parse(e.path("zeitraum_von").asText()));
                assertThat(u.zeitraumBis()).as(fall).isEqualTo(LocalDate.parse(e.path("zeitraum_bis").asText()));
            }
        }
    }

    @Test
    void dieKonstantenSindDieDesVertrags() throws Exception {
        JsonNode v = lies(VECTORS);
        assertThat(v.path("fassung").asText()).isEqualTo(VorbehaltRegel.FASSUNG);
        assertThat(bd(v.path("zuschlag"))).isEqualByComparingTo(VorbehaltRegel.ZUSCHLAG);
        assertThat(v.path("mindest_messtage").asInt()).isEqualTo(VorbehaltRegel.MINDEST_MESSTAGE);
        assertThat(v.path("zeitraum").asText()).startsWith("heute minus " + VorbehaltRegel.MONATE + " Monate");
    }
}
