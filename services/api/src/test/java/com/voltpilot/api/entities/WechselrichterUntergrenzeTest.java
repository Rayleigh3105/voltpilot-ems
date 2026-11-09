package com.voltpilot.api.entities;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.entities.WechselrichterUntergrenze.Ergebnis;
import com.voltpilot.api.entities.WechselrichterUntergrenze.Lesung;
import com.voltpilot.api.entities.WechselrichterUntergrenze.Stand;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Die Regeln der am Wechselrichter gelesenen Entladegrenze, ohne Datenbank. */
class WechselrichterUntergrenzeTest {

    private static final Instant JETZT = Instant.parse("2026-11-09T06:50:00Z");

    private static Lesung lesung(int minutenAlt, String pct) {
        return lesung(minutenAlt, pct, "good");
    }

    private static Lesung lesung(int minutenAlt, String pct, String qualitaet) {
        return new Lesung(JETZT.minus(Duration.ofMinutes(minutenAlt)), pct == null ? null : new BigDecimal(pct),
                qualitaet);
    }

    @Test
    void dasGroessereGilt() {
        // Ohne Lesung genau der VoltPilot-Wert bzw. die Vorgabe - wie vorher.
        assertThat(WechselrichterUntergrenze.wirksamPct(null, null, null, 5)).isEqualTo(5.0);
        assertThat(WechselrichterUntergrenze.wirksamPct(new BigDecimal("12.5"), null, null, 5)).isEqualTo(12.5);
        // Pilotanlage: VoltPilot nichts eingestellt, Deye 15 %.
        assertThat(WechselrichterUntergrenze.wirksamPct(null, new BigDecimal("15"), null, 5)).isEqualTo(15.0);
        // Ein höherer VoltPilot-Wert bleibt als Reserve.
        assertThat(WechselrichterUntergrenze.wirksamPct(new BigDecimal("20"), new BigDecimal("15"), null, 5))
                .isEqualTo(20.0);
        // Eine Lesung an oder über der Obergrenze zählt nicht.
        assertThat(WechselrichterUntergrenze.wirksamPct(null, new BigDecimal("90"), new BigDecimal("90"), 5))
                .isEqualTo(5.0);
    }

    @Test
    void dieAnzeigeNenntDenWechselrichterAuchBeiGleichstand() {
        assertThat(WechselrichterUntergrenze.vomWechselrichter(null, new BigDecimal("15"), null, 5)).isTrue();
        assertThat(WechselrichterUntergrenze.vomWechselrichter(new BigDecimal("15"), new BigDecimal("15"), null, 5))
                .isTrue();
        assertThat(WechselrichterUntergrenze.vomWechselrichter(new BigDecimal("20"), new BigDecimal("15"), null, 5))
                .isFalse();
        assertThat(WechselrichterUntergrenze.vomWechselrichter(null, null, null, 5)).isFalse();
    }

    @Test
    void ersteLesungWirdUebernommen() {
        Ergebnis e = WechselrichterUntergrenze.abgleichen(null, List.of(lesung(3, "15")), null, JETZT);
        assertThat(e.wertGeaendert()).isTrue();
        assertThat(e.vorher()).isNull();
        assertThat(e.stand().socMinPct()).isEqualByComparingTo("15");
        assertThat(e.stand().seit()).isEqualTo(JETZT.minus(Duration.ofMinutes(3)));
        assertThat(e.verworfen()).isNull();
    }

    @Test
    void einGeaenderterWertGiltInBeideRichtungen() {
        Stand bisher = new Stand(new BigDecimal("15.00"), JETZT.minus(Duration.ofMinutes(10)),
                JETZT.minus(Duration.ofDays(1)));
        Ergebnis hoch = WechselrichterUntergrenze.abgleichen(bisher, List.of(lesung(2, "20")), null, JETZT);
        assertThat(hoch.wertGeaendert()).isTrue();
        assertThat(hoch.vorher()).isEqualByComparingTo("15");
        assertThat(hoch.stand().socMinPct()).isEqualByComparingTo("20");
        Ergebnis runter = WechselrichterUntergrenze.abgleichen(hoch.stand(), List.of(lesung(1, "10")), null, JETZT);
        assertThat(runter.wertGeaendert()).isTrue();
        assertThat(runter.stand().socMinPct()).isEqualByComparingTo("10");
    }

    @Test
    void gleicherWertFrischtNurDenLesezeitpunkt() {
        Stand bisher = new Stand(new BigDecimal("15.00"), JETZT.minus(Duration.ofMinutes(10)),
                JETZT.minus(Duration.ofDays(1)));
        Ergebnis e = WechselrichterUntergrenze.abgleichen(bisher, List.of(lesung(1, "15")), null, JETZT);
        assertThat(e.wertGeaendert()).isFalse();
        assertThat(e.stand().seit()).isEqualTo(bisher.seit());
        assertThat(e.stand().gelesenAm()).isEqualTo(JETZT.minus(Duration.ofMinutes(1)));
        assertThat(e.stand().socMinPct()).isEqualTo(bisher.socMinPct());
    }

    @Test
    void eineUnplausibleLesungWirdNichtUebernommenDerLetzteWertBleibt() {
        Stand bisher = new Stand(new BigDecimal("15"), JETZT.minus(Duration.ofMinutes(6)),
                JETZT.minus(Duration.ofDays(1)));
        for (Lesung kaputt : List.of(lesung(1, "120"), lesung(1, "-1"), lesung(1, "95"), lesung(1, null),
                lesung(1, "20", "invalid"))) {
            Ergebnis e = WechselrichterUntergrenze.abgleichen(bisher, List.of(kaputt), null, JETZT);
            assertThat(e.stand()).as(kaputt.toString()).isEqualTo(bisher);
            assertThat(e.wertGeaendert()).isFalse();
            assertThat(e.verworfen()).isEqualTo("unplausibel");
        }
        // Unter einer gesetzten Obergrenze von 80 % ist 85 % unplausibel.
        Ergebnis ueber = WechselrichterUntergrenze.abgleichen(bisher, List.of(lesung(1, "85")),
                new BigDecimal("80"), JETZT);
        assertThat(ueber.stand()).isEqualTo(bisher);
    }

    @Test
    void hinterEinerUnplausiblenLesungZaehltDieVorigePlausible() {
        Ergebnis e = WechselrichterUntergrenze.abgleichen(null, List.of(lesung(1, "250"), lesung(6, "15")), null,
                JETZT);
        assertThat(e.stand().socMinPct()).isEqualByComparingTo("15");
        assertThat(e.verworfen()).isEqualTo("unplausibel");
    }

    @Test
    void eineVeralteteLesungWirdNichtUebernommenUndNieAufFuenfZurueckgesetzt() {
        Stand bisher = new Stand(new BigDecimal("15"), JETZT.minus(Duration.ofHours(3)),
                JETZT.minus(Duration.ofDays(1)));
        Ergebnis e = WechselrichterUntergrenze.abgleichen(bisher, List.of(lesung(61, "25")), null, JETZT);
        assertThat(e.stand()).isEqualTo(bisher);
        assertThat(e.wertGeaendert()).isFalse();
        assertThat(e.verworfen()).isEqualTo("veraltet");
        assertThat(WechselrichterUntergrenze.aktuell(bisher, JETZT)).isFalse();
        // Ohne bisherigen Stand: nichts übernommen - keine Zeile, alles wie vorher.
        assertThat(WechselrichterUntergrenze.abgleichen(null, List.of(lesung(61, "25")), null, JETZT).stand())
                .isNull();
    }

    @Test
    void ohneLesungBleibtAlles() {
        Stand bisher = new Stand(new BigDecimal("15"), JETZT.minus(Duration.ofMinutes(30)), JETZT);
        Ergebnis e = WechselrichterUntergrenze.abgleichen(bisher, List.of(), null, JETZT);
        assertThat(e.stand()).isEqualTo(bisher);
        assertThat(e.juengste()).isNull();
        assertThat(WechselrichterUntergrenze.aktuell(bisher, JETZT)).isTrue();
    }
}
