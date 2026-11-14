package com.voltpilot.api.abrechnung;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.abrechnung.AbrechnungRegel.Ergebnis;
import com.voltpilot.api.abrechnung.AbrechnungRegel.Spanne;
import com.voltpilot.api.abrechnung.AbrechnungRegel.Stand;
import com.voltpilot.api.history.Zeitraum;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Paket R2 (Abrechnung prüfen): Zähler oder Summe, Lückentage, Messbeginn, fallender Zähler. Rein.
 * Die Mengen der Labor-Abrechnung (vp-privatkunde-bedienkonzept §3.4): Bezug 5.154 kWh, Einspeisung 3.040 kWh.
 */
class AbrechnungRegelTest {

    private static final Zeitraum JAHR = new Zeitraum(d("2025-11-01"), d("2026-10-31"));

    @Test
    void zaehlerstandAmVortagUndAmLetztenTag() {
        Map<LocalDate, Stand> staende = zaehler(JAHR, 12_455.0, 5_154.0 / 365);
        Ergebnis e = AbrechnungRegel.berechne(JAHR, staende, tageswerte(JAHR, "14.12"), d("2024-01-01"));
        assertThat(e.herkunft()).isEqualTo(AbrechnungRegel.HERKUNFT_ZAEHLER);
        assertThat(e.standVon()).isEqualByComparingTo("12455.000");
        assertThat(e.standBis()).isEqualByComparingTo("17609.000");
        assertThat(e.mengeKwh()).isEqualByComparingTo("5154.000");
        assertThat(e.luecken()).isEmpty();
        assertThat(e.zaehlerFaellt()).isFalse();
    }

    @Test
    void zaehlerZaehltUeberLueckenHinweg() {
        Map<LocalDate, Stand> staende = zaehler(JAHR, 12_455.0, 5_154.0 / 365);
        Map<LocalDate, BigDecimal> tage = tageswerte(JAHR, "14.12");
        for (LocalDate t = d("2026-02-12"); !t.isAfter(d("2026-02-14")); t = t.plusDays(1)) {
            staende.remove(t);
            tage.remove(t);
        }
        Ergebnis e = AbrechnungRegel.berechne(JAHR, staende, tage, d("2024-01-01"));
        assertThat(e.herkunft()).isEqualTo(AbrechnungRegel.HERKUNFT_ZAEHLER);
        assertThat(e.mengeKwh()).isEqualByComparingTo("5154.000");
        assertThat(e.luecken()).isEmpty();
    }

    @Test
    void ohneZaehlerDieSummeUndDieLueckentage() {
        Map<LocalDate, BigDecimal> tage = tageswerte(JAHR, "10");
        tage.remove(d("2026-02-12"));
        tage.remove(d("2026-02-13"));
        tage.remove(d("2026-02-14"));
        Ergebnis e = AbrechnungRegel.berechne(JAHR, Map.of(), tage, d("2024-01-01"));
        assertThat(e.herkunft()).isEqualTo(AbrechnungRegel.HERKUNFT_SUMME);
        assertThat(e.mengeKwh()).isEqualByComparingTo("3620.000"); // 362 Tage × 10
        assertThat(e.luecken()).containsExactly(new Spanne(d("2026-02-12"), d("2026-02-14")));
        assertThat(e.fehlendeTage()).isEqualTo(3);
        assertThat(e.standVon()).isNull();
    }

    @Test
    void messbeginnImZeitraumIstKeineLuecke() {
        // Schramm: gemessen seit dem 07.11.2026, der Zeitraum beginnt am 01.11.
        Zeitraum nov = new Zeitraum(d("2026-11-01"), d("2026-11-13"));
        Map<LocalDate, Stand> staende = new HashMap<>();
        double stand = 42_612.0;
        for (LocalDate t = d("2026-11-07"); !t.isAfter(nov.bis()); t = t.plusDays(1)) {
            staende.put(t, new Stand(stand, stand + 150));
            stand += 150;
        }
        Ergebnis e = AbrechnungRegel.berechne(nov, staende, Map.of(), d("2026-11-07"));
        assertThat(e.herkunft()).isEqualTo(AbrechnungRegel.HERKUNFT_ZAEHLER);
        assertThat(e.standVon()).isEqualByComparingTo("42612.000"); // erster Stand des ersten Tages
        assertThat(e.mengeKwh()).isEqualByComparingTo("1050.000"); // 7 Tage
        assertThat(e.luecken()).isEmpty();
    }

    @Test
    void zaehlerFaelltDannDieSummeMitAnsage() {
        Map<LocalDate, Stand> staende = zaehler(JAHR, 12_455.0, 14.0);
        staende.put(d("2026-05-10"), new Stand(5.0, 19.0)); // Zählertausch
        Ergebnis e = AbrechnungRegel.berechne(JAHR, staende, tageswerte(JAHR, "14"), d("2024-01-01"));
        assertThat(e.herkunft()).isEqualTo(AbrechnungRegel.HERKUNFT_SUMME);
        assertThat(e.zaehlerFaellt()).isTrue();
        assertThat(e.mengeKwh()).isEqualByComparingTo("5110.000");
        assertThat(e.standVon()).isNull();
    }

    @Test
    void spaeterZaehlerVerliertGegenVollstaendigeSumme() {
        // Der Zähler kam erst am 01.06.2026 dazu; die Summe belegt das ganze Jahr.
        Map<LocalDate, Stand> staende = new HashMap<>();
        double stand = 100.0;
        for (LocalDate t = d("2026-06-01"); !t.isAfter(JAHR.bis()); t = t.plusDays(1)) {
            staende.put(t, new Stand(stand, stand + 14));
            stand += 14;
        }
        Ergebnis e = AbrechnungRegel.berechne(JAHR, staende, tageswerte(JAHR, "14"), d("2024-01-01"));
        assertThat(e.herkunft()).isEqualTo(AbrechnungRegel.HERKUNFT_SUMME);
        assertThat(e.zaehlerFaellt()).isFalse();
        assertThat(e.luecken()).isEmpty();
    }

    @Test
    void fehlenDieLetztenTageNenntDerZaehlerSie() {
        Map<LocalDate, Stand> staende = zaehler(JAHR, 1_000.0, 10.0);
        Map<LocalDate, BigDecimal> tage = tageswerte(JAHR, "10");
        for (LocalDate t = d("2026-10-29"); !t.isAfter(JAHR.bis()); t = t.plusDays(1)) {
            staende.remove(t);
            tage.remove(t);
        }
        Ergebnis e = AbrechnungRegel.berechne(JAHR, staende, tage, d("2024-01-01"));
        assertThat(e.herkunft()).isEqualTo(AbrechnungRegel.HERKUNFT_ZAEHLER);
        assertThat(e.mengeKwh()).isEqualByComparingTo("3620.000");
        assertThat(e.luecken()).containsExactly(new Spanne(d("2026-10-29"), d("2026-10-31")));
    }

    @Test
    void nieGemessenGibtKeineMengeUndKeineLuecke() {
        Ergebnis e = AbrechnungRegel.berechne(JAHR, Map.of(), Map.of(), null);
        assertThat(e.mengeKwh()).isNull();
        assertThat(e.herkunft()).isNull();
        assertThat(e.luecken()).isEmpty();
    }

    @Test
    void nurDerVortagIstKeinZaehler() {
        Map<LocalDate, Stand> staende = Map.of(JAHR.von().minusDays(1), new Stand(1.0, 2.0));
        Ergebnis e = AbrechnungRegel.berechne(JAHR, staende, tageswerte(JAHR, "1"), d("2024-01-01"));
        assertThat(e.herkunft()).isEqualTo(AbrechnungRegel.HERKUNFT_SUMME);
    }

    /** Ein Zähler, der je Tag {@code jeTag} weiterzählt, mit Stand {@code start} am Ende des Vortags. */
    private static Map<LocalDate, Stand> zaehler(Zeitraum z, double start, double jeTag) {
        Map<LocalDate, Stand> m = new HashMap<>();
        m.put(z.von().minusDays(1), new Stand(start - jeTag, start));
        double stand = start;
        for (LocalDate t = z.von(); !t.isAfter(z.bis()); t = t.plusDays(1)) {
            m.put(t, new Stand(stand, stand + jeTag));
            stand += jeTag;
        }
        return m;
    }

    private static Map<LocalDate, BigDecimal> tageswerte(Zeitraum z, String jeTag) {
        Map<LocalDate, BigDecimal> m = new HashMap<>();
        for (LocalDate t = z.von(); !t.isAfter(z.bis()); t = t.plusDays(1)) {
            m.put(t, new BigDecimal(jeTag));
        }
        return m;
    }

    private static LocalDate d(String s) {
        return LocalDate.parse(s);
    }
}
