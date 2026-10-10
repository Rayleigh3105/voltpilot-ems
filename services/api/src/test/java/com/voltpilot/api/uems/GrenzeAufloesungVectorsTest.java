package com.voltpilot.api.uems;

import static com.voltpilot.api.uems.BilanzVectorsTest.bd;
import static com.voltpilot.api.uems.BilanzVectorsTest.lies;
import static com.voltpilot.api.uems.BilanzVectorsTest.str;
import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Der Java-Zwilling der Grenzen am Netzanschluss (UEMS AP-15 IP-3) gegen
 * {@code docs/contracts/v2/netzanschluss-grenze-vectors.json} — dieselbe Datei fährt der Python-Zwilling
 * ({@code services/optimization/tests/test_grenze_aufloesung.py}). Rein, kein Docker.
 */
class GrenzeAufloesungVectorsTest {

    private static final Path VECTORS =
            Path.of("..", "..", "docs", "contracts", "v2", "netzanschluss-grenze-vectors.json");

    @Test
    void jederAufloesungsfallGiltImJavaZwilling() throws Exception {
        JsonNode faelle = lies(VECTORS).get("aufloesen");
        assertThat(faelle.size()).isGreaterThanOrEqualTo(10);
        for (JsonNode f : faelle) {
            List<GrenzeAufloesung.Fassung> fassungen = new ArrayList<>();
            for (JsonNode x : f.get("fassungen")) {
                fassungen.add(new GrenzeAufloesung.Fassung(LocalDate.parse(x.get("gueltig_ab").asText()),
                        bd(x.get("einspeisegrenze_kw")), bd(x.get("bezugsgrenze_kw")),
                        x.path("einspeisegrenze_keine").asBoolean(false)));
            }
            GrenzeAufloesung.Grenzen anlage = new GrenzeAufloesung.Grenzen(bd(f.at("/anlage/einspeisung_kw")),
                    bd(f.at("/anlage/bezug_kw")));
            GrenzeAufloesung.Wirksam w = GrenzeAufloesung.aufloesen(anlage, f.get("gebunden").asBoolean(), fassungen,
                    LocalDate.parse(f.get("tag").asText()));
            JsonNode e = f.get("erwartet");
            String fall = f.get("name").asText();
            assertGleich(fall + " / Einspeisung", w.einspeisungKw(), bd(e.get("einspeisung_kw")));
            assertGleich(fall + " / Bezug", w.bezugKw(), bd(e.get("bezug_kw")));
            assertThat(w.quelleEinspeisung()).as(fall + " / Quelle Einspeisung").isEqualTo(str(e.get("quelle_einspeisung")));
            assertThat(w.einspeisungKeine()).as(fall + " / ausdrücklich keine")
                    .isEqualTo(e.path("einspeisung_keine").asBoolean(false));
            assertThat(w.quelleBezug()).as(fall + " / Quelle Bezug").isEqualTo(str(e.get("quelle_bezug")));
        }
    }

    @Test
    void jederPlausibilitaetsfallGiltImJavaZwilling() throws Exception {
        for (JsonNode f : lies(VECTORS).get("plausibel")) {
            assertThat(GrenzeAufloesung.plausibel(bd(f.get("einspeisegrenze_kw")), bd(f.get("bezugsgrenze_kw")),
                    bd(f.get("vereinbart_kw")), bd(f.get("anschluss_kva"))))
                    .as(f.get("name").asText())
                    .isEqualTo(str(f.get("erwartet")));
        }
    }

    /** Byte-Gleichheit beginnt hier: gewinnt die Anlage, kommt DASSELBE Objekt zurück, nicht nur ein gleicher Wert. */
    @Test
    void ohneFassungKommtDerWertDerAnlageAlsDasselbeObjektZurueck() {
        BigDecimal einspeisung = new BigDecimal("70.000");
        BigDecimal bezug = new BigDecimal("250");
        GrenzeAufloesung.Wirksam w = GrenzeAufloesung.aufloesen(new GrenzeAufloesung.Grenzen(einspeisung, bezug), true,
                List.of(), LocalDate.of(2027, 6, 13));
        assertThat(w.einspeisungKw()).isSameAs(einspeisung);
        assertThat(w.bezugKw()).isSameAs(bezug);
        GrenzeAufloesung.Wirksam ungebunden = GrenzeAufloesung.aufloesen(
                new GrenzeAufloesung.Grenzen(einspeisung, bezug), false,
                List.of(new GrenzeAufloesung.Fassung(LocalDate.of(2027, 1, 1), BigDecimal.ONE, BigDecimal.ONE)),
                LocalDate.of(2027, 6, 13));
        assertThat(ungebunden.einspeisungKw()).isSameAs(einspeisung);
        assertThat(ungebunden.bezugKw()).isSameAs(bezug);
    }

    @Test
    void derFassungstagIstDerTagDesStandortsMitBerlinNurAlsRueckfall() {
        Instant jetzt = Instant.parse("2026-09-21T22:30:00Z");
        assertThat(GrenzeAufloesung.tagAm(jetzt, "Europe/Lisbon")).isEqualTo(LocalDate.of(2026, 9, 21));
        assertThat(GrenzeAufloesung.tagAm(jetzt, null)).isEqualTo(LocalDate.of(2026, 9, 22));
    }

    private static void assertGleich(String fall, BigDecimal ist, BigDecimal soll) {
        if (soll == null) {
            assertThat(ist).as(fall).isNull();
        } else {
            assertThat(ist).as(fall).isNotNull();
            assertThat(ist.compareTo(soll)).as(fall + ": " + ist + " statt " + soll).isZero();
        }
    }
}
