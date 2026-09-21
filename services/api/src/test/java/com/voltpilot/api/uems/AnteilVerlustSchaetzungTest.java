package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die reine Regel der Schätzung des Anteils-Verlusts (Folgepaket zu AP-15 IP-22, E1 = A, R2), ohne Datenbank: die
 * Box-Summe {@code gebunden_s} auf die Viertelstunden mit der höchsten verfügbaren Erzeugung gelegt, je Viertelstunde
 * verfügbar minus gemessen.
 */
class AnteilVerlustSchaetzungTest {

    private static final Instant SECHS_UHR = Instant.parse("2026-06-17T04:00:00Z");

    /**
     * R2 aus der Referenzdatei: Halbsinus 06:00–20:00 mit 57 kW Spitze, Werte zur Viertelstunden-Mitte; die Box hält
     * 30 kW. Wo die verfügbare PV darüber liegt, misst sie 30 kW, sonst die volle PV.
     */
    static List<AnteilVerlustSchaetzung.Viertelstunde> r2(double spitzeKw, double kappeKw) {
        List<AnteilVerlustSchaetzung.Viertelstunde> vs = new ArrayList<>();
        for (int i = 0; i < 56; i++) {
            double p = spitzeKw * Math.sin(Math.PI * ((i + 0.5) * 0.25) / 14.0);
            vs.add(new AnteilVerlustSchaetzung.Viertelstunde(SECHS_UHR.plusSeconds(900L * i), p, Math.min(p, kappeKw)));
        }
        return vs;
    }

    @Test
    void r2NeunStundenGebundenErgebenDie160KilowattstundenDerReferenz() {
        BigDecimal kwh = AnteilVerlustSchaetzung.schaetzen(r2(57.0, 30.0), 9 * 3600).orElseThrow();
        // Referenz 160,2 kWh; die Regel trifft sie auf 0,011 kWh (160,211) — die Referenz ist gerundet.
        assertThat(kwh).isEqualByComparingTo("160.211");
    }

    @Test
    void dieBoxZaehlt91StundenDieZehnMinutenMehrLiegenInEinerViertelstundeOhneVerlust() {
        // Die Box zählt 9,1 h (Rampe der Regelung); die zusätzlichen 6 Minuten fallen auf die 37. Viertelstunde, in
        // der die verfügbare PV unter der Kappe liegt — sie trägt nichts bei.
        BigDecimal kwh = AnteilVerlustSchaetzung.schaetzen(r2(57.0, 30.0), 32_760).orElseThrow();
        assertThat(kwh).isEqualByComparingTo("160.211");
    }

    @Test
    void wenigerGebundeneZeitNimmtDieHoechstenViertelstundenZuerst() {
        BigDecimal voll = AnteilVerlustSchaetzung.schaetzen(r2(57.0, 30.0), 9 * 3600).orElseThrow();
        BigDecimal eineStunde = AnteilVerlustSchaetzung.schaetzen(r2(57.0, 30.0), 3600).orElseThrow();
        // die vier Viertelstunden um 13:00 tragen je ≈ 27 kW × 0,25 h
        assertThat(eineStunde.doubleValue()).isBetween(26.5, 27.0);
        assertThat(eineStunde).isLessThan(voll);
    }

    @Test
    void nichtGebundenIstEineEchteNullOhnePrognoseGibtEsKeinenWert() {
        assertThat(AnteilVerlustSchaetzung.schaetzen(r2(57.0, 30.0), 0)).contains(new BigDecimal("0.000"));
        assertThat(AnteilVerlustSchaetzung.schaetzen(List.of(), 9 * 3600)).isEmpty();
    }

    @Test
    void eineViertelstundeOhneMessungZaehltNichtsUnbekanntIstKeineNull() {
        List<AnteilVerlustSchaetzung.Viertelstunde> vs = new ArrayList<>(r2(57.0, 30.0));
        AnteilVerlustSchaetzung.Viertelstunde mittag = vs.get(28);
        vs.set(28, new AnteilVerlustSchaetzung.Viertelstunde(mittag.beginn(), mittag.verfuegbarKw(), null));
        BigDecimal kwh = AnteilVerlustSchaetzung.schaetzen(vs, 9 * 3600).orElseThrow();
        assertThat(kwh.doubleValue()).isBetween(160.211 - 27.0 * 0.25, 160.211 - 26.5 * 0.25);
    }

    @Test
    void mehrGemessenAlsVerfuegbarWirdNieNegativ() {
        List<AnteilVerlustSchaetzung.Viertelstunde> vs = List.of(
                new AnteilVerlustSchaetzung.Viertelstunde(SECHS_UHR, 20.0, 25.0));
        assertThat(AnteilVerlustSchaetzung.schaetzen(vs, 900)).contains(new BigDecimal("0.000"));
    }
}
