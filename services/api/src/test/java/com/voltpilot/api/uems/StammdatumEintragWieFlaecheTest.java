package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.BezugsdatenRegeln.Intervall;
import com.voltpilot.api.uems.OrtsbaumAbleitung.FlaechenIntervall;
import java.math.BigDecimal;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import org.junit.jupiter.api.Test;

/**
 * AP-09 §4.3 S4 (IP-6): ein Stammdatum, das AP-09 selbst hält (Mitarbeitende, E15), folgt „byte-genau
 * dem Flächen-Muster“. Dieser Test hält die beiden Mechaniken aneinander: jede Prüfung
 * {@code stammdatum_eintrag} der Vektor-Datei wird ZUSÄTZLICH als Fläche eines Gebäudes durch
 * {@link OrtsbaumAbleitung#flaecheEintrag} (AP-02) geschickt — beide müssen danach dieselben wirksamen
 * Intervalle haben. Rein, ohne Datenbank.
 */
class StammdatumEintragWieFlaecheTest {

    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2", "bezugsdaten-vectors.json");

    private record Stueck(LocalDate ab, LocalDate bis, BigDecimal wert) {}

    @Test
    void jederEintragErgibtDieselbenIntervalleWieDieFlaecheDerOrtsstruktur() throws Exception {
        JsonNode wurzel = new ObjectMapper().readTree(VEKTOREN.toFile());
        int geprueft = 0;
        for (JsonNode fall : wurzel.path("cases")) {
            for (JsonNode p : fall.path("pruefungen")) {
                if (!"stammdatum_eintrag".equals(p.path("regel").asText())) {
                    continue;
                }
                String why = fall.path("id").asText() + " · " + p.path("name").asText();
                JsonNode ein = p.path("eingang");
                List<Intervall> wirksame = new ArrayList<>();
                ein.path("intervalle").forEach(i -> wirksame.add(new Intervall(new BigDecimal(i.path("betrag").asText()),
                        LocalDate.parse(i.path("gueltig_ab").asText()), tag(i.path("gueltig_bis")), null)));
                LocalDate ab = LocalDate.parse(ein.path("gueltig_ab").asText());
                BigDecimal wert = new BigDecimal(ein.path("wert").asText());

                BezugsdatenRegeln.StammdatumEintrag stamm = BezugsdatenRegeln.stammdatumEintrag(wirksame, ab, wert);
                List<Stueck> nachStammdatum = new ArrayList<>();
                for (Intervall i : wirksame) {
                    boolean ersetzt = stamm.beendet() != null && i.gueltigAb().equals(stamm.beendet().gueltigAb())
                            || stamm.aufgehoben() != null && i.gueltigAb().equals(stamm.aufgehoben().gueltigAb());
                    if (!ersetzt) {
                        nachStammdatum.add(new Stueck(i.gueltigAb(), i.gueltigBis(), i.betrag()));
                    }
                }
                if (stamm.beendet() != null) {
                    nachStammdatum.add(new Stueck(stamm.beendet().gueltigAb(), stamm.beendet().gueltigBis(), stamm.beendet().betrag()));
                }
                if (stamm.neu() != null) {
                    nachStammdatum.add(new Stueck(stamm.neu().gueltigAb(), stamm.neu().gueltigBis(), stamm.neu().betrag()));
                }

                OrtsbaumAbleitung.Ort halle = new OrtsbaumAbleitung.Ort("G-2", OrtsbaumAbleitung.OrtArt.GEBAEUDE, "Halle 2",
                        null, List.of(new OrtsbaumAbleitung.Intervall(LocalDate.of(2026, 1, 1), null, "ST-1")),
                        wirksame.stream().map(i -> new FlaechenIntervall(i.gueltigAb(), i.gueltigBis(),
                                i.betrag().intValueExact())).toList());
                OrtsbaumAbleitung.Ortsbaum baum = new OrtsbaumAbleitung.Ortsbaum(null, List.of(halle), List.of(), List.of());
                OrtsbaumAbleitung.FlaecheErgebnis flaeche = OrtsbaumAbleitung.flaecheEintrag(baum,
                        new OrtsbaumAbleitung.FlaecheAntrag("G-2", ab, wert.intValueExact(), LocalDate.of(2027, 1, 15)));

                if (stamm.unveraendert()) {
                    assertThat(flaeche.grund()).as(why + " · die Fläche kennt denselben Wert als „gleiche Fläche“")
                            .isEqualTo(OrtsbaumAbleitung.FlaecheGrund.GLEICHE_FLAECHE);
                } else {
                    assertThat(flaeche.erlaubt()).as(why + " · " + flaeche.text()).isTrue();
                    assertThat(flaeche.korrektur()).as(why + " · Korrektur").isEqualTo(stamm.korrektur());
                    List<Stueck> nachFlaeche = flaeche.flaechen().stream()
                            .map(f -> new Stueck(f.ab(), f.bis(), BigDecimal.valueOf(f.m2())))
                            .toList();
                    assertThat(sortiert(nachStammdatum)).as(why).isEqualTo(sortiert(nachFlaeche));
                }
                geprueft++;
            }
        }
        assertThat(geprueft).as("Prüfungen stammdatum_eintrag").isGreaterThanOrEqualTo(5);
    }

    private static List<String> sortiert(List<Stueck> stuecke) {
        return stuecke.stream()
                .map(s -> s.ab() + "…" + Objects.toString(s.bis(), "offen") + "=" + s.wert().stripTrailingZeros().toPlainString())
                .sorted()
                .toList();
    }

    private static LocalDate tag(JsonNode n) {
        return n.isNull() || n.isMissingNode() ? null : LocalDate.parse(n.asText());
    }
}
