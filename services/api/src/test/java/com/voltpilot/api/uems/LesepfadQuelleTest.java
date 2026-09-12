package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.measurement.SpeicherklasseHistorie;
import com.voltpilot.api.uems.LesepfadQuelle.Quelle;
import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.Test;

/**
 * Die QUELLENWAHL des Lesepfads als reine Regel (UEMS AP-07 IP-14) — ohne Datenbank, damit die
 * Entscheidung „Rohwerte oder Speicherklasse" für sich prüfbar ist.
 */
class LesepfadQuelleTest {

    private static final Instant JETZT = Instant.parse("2027-01-19T10:00:00Z");
    private static final Instant GRENZE = LesepfadQuelle.rohGrenze(JETZT, 90);

    @Test
    void dieGrenzeIstNeunzigTageVorHeute() {
        assertThat(GRENZE).isEqualTo(Instant.parse("2026-10-21T10:00:00Z"));
    }

    @Test
    void einZeitraumInnerhalbDerFristGehtNichtInDenRueckfall() {
        assertThat(LesepfadQuelle.jenseitsDerFrist(Instant.parse("2026-12-01T00:00:00Z"), GRENZE))
                .isFalse();
        // Genau auf der Grenze ist noch INNERHALB: der Rohwert von da ist noch da.
        assertThat(LesepfadQuelle.jenseitsDerFrist(GRENZE, GRENZE)).isFalse();
    }

    @Test
    void einZeitraumJenseitsDerFristGehtInDenRueckfall() {
        // Der Fall A7: Rohwert MS-06 am 20.10.2026, gefragt am 19.01.2027.
        assertThat(LesepfadQuelle.jenseitsDerFrist(Instant.parse("2026-10-20T00:00:00Z"), GRENZE))
                .isTrue();
    }

    @Test
    void einZeitraumDerDieGrenzeUEBERSCHREITETGehtGANZInDenRueckfall() {
        // Der interessante Fall: er beginnt davor und endet danach. Eine Antwort, EINE Quelle —
        // zwei Quellen in einer Kurve hätten zwei Bedeutungen von „Wert" und „Lücke".
        assertThat(LesepfadQuelle.jenseitsDerFrist(Instant.parse("2026-10-01T00:00:00Z"), GRENZE))
                .isTrue();
    }

    @Test
    void bisNeunzigTageTraegtDieViertelstundeDarueberDerTag() {
        assertThat(LesepfadQuelle.speicherklasse(Duration.ofDays(1), 90))
                .isEqualTo(Quelle.VIERTELSTUNDE);
        assertThat(LesepfadQuelle.speicherklasse(Duration.ofDays(90), 90))
                .isEqualTo(Quelle.VIERTELSTUNDE);
        assertThat(LesepfadQuelle.speicherklasse(Duration.ofDays(91), 90)).isEqualTo(Quelle.TAG);
        assertThat(LesepfadQuelle.speicherklasse(Duration.ofDays(366), 90)).isEqualTo(Quelle.TAG);
    }

    @Test
    void dasRasterIstNieFeinerAlsDieViertelstundeUndNieUeberDerZeilenbremse() {
        int bremse = SpeicherklasseHistorie.HOECHSTENS_ZEILEN;
        assertThat(LesepfadQuelle.raster(Duration.ofDays(1), 900, bremse)).isEqualTo(900);
        assertThat(LesepfadQuelle.raster(Duration.ofHours(1), 900, bremse)).isEqualTo(900);
        // 90 Tage sind 8 640 Viertelstunden — das Raster wächst, bis die Bremse nicht greift.
        int weit = LesepfadQuelle.raster(Duration.ofDays(90), 900, bremse);
        assertThat(weit).isEqualTo(3600);
        assertThat(Duration.ofDays(90).getSeconds() / weit).isLessThanOrEqualTo(bremse);
        // … und es bleibt ein Vielfaches der Viertelstunde.
        assertThat(weit % 900).isZero();
    }

    @Test
    void dieErklaerungNenntDieQuelleUndDieNeunzigTage() {
        assertThat(LesepfadQuelle.erklaerung(Quelle.VIERTELSTUNDE, GRENZE))
                .contains("Viertelstundenwerte").contains("90 Tage");
        assertThat(LesepfadQuelle.erklaerung(Quelle.TAG, GRENZE))
                .contains("Tageswerte").contains("90 Tage");
        assertThat(LesepfadQuelle.erklaerung(Quelle.ROH, GRENZE)).contains("Rohwerte");
    }

    @Test
    void dieWorteDerQuelleSindDasVokabularDerAntwort() {
        assertThat(Quelle.ROH.wort()).isEqualTo("roh");
        assertThat(Quelle.ROLLUP_5M.wort()).isEqualTo("rollup_5m");
        assertThat(Quelle.ROLLUP_15M.wort()).isEqualTo("rollup_15m");
        assertThat(Quelle.VIERTELSTUNDE.wort()).isEqualTo("viertelstunde");
        assertThat(Quelle.TAG.wort()).isEqualTo("tag");
    }

    @Test
    void abdeckungWirdNieAufHundertGerundet() {
        assertThat(SpeicherklasseHistorie.abdeckung(15, 15)).isEqualTo(100);
        assertThat(SpeicherklasseHistorie.abdeckung(16, 15)).isEqualTo(100);
        assertThat(SpeicherklasseHistorie.abdeckung(14, 15)).isEqualTo(93);
        // 1 439 von 1 440 sind 99,93 % — und werden 99, nie 100.
        assertThat(SpeicherklasseHistorie.abdeckung(1439, 1440)).isEqualTo(99);
        assertThat(SpeicherklasseHistorie.abdeckung(0, 15)).isZero();
        assertThat(SpeicherklasseHistorie.abdeckung(null, 15)).isNull();
        assertThat(SpeicherklasseHistorie.abdeckung(5, null)).isNull();
        assertThat(SpeicherklasseHistorie.abdeckung(5, 0)).isNull();
    }
}
