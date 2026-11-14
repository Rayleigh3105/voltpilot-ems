package com.voltpilot.api.history;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.web.dto.HistoryBucketDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Paket R1 (Abrechnung prüfen): freier Zeitraum in ganzen Berliner Tagen - Grenzen, Eimer-Wahl,
 * Zeitumstellung, Schaltjahr und das Zusammenfassen zu Monaten. Rein, ohne Spring/DB.
 */
class ZeitraumTest {

    private static final LocalDate HEUTE = LocalDate.parse("2026-11-14");

    @Test
    void beideTageGehoerenDazu() {
        Zeitraum z = new Zeitraum(LocalDate.parse("2025-11-01"), LocalDate.parse("2026-10-31"));
        assertThat(z.tage()).isEqualTo(365);
        // 01.11.2025 00:00 MEZ bis 01.11.2026 00:00 MEZ
        assertThat(z.window().from()).isEqualTo(Instant.parse("2025-10-31T23:00:00Z"));
        assertThat(z.window().to()).isEqualTo(Instant.parse("2026-10-31T23:00:00Z"));
    }

    @Test
    void einTagIstEinZeitraum() {
        Zeitraum z = new Zeitraum(HEUTE.minusDays(1), HEUTE.minusDays(1));
        assertThat(z.tage()).isEqualTo(1);
        assertThat(z.jeMonat()).isFalse();
    }

    @Test
    void zeitumstellungVerschiebtNurDieUhrzeitNichtDenTag() {
        // 29.03.2026 hat 23 Stunden, 25.10.2026 hat 25: die Grenzen bleiben Berliner Mitternacht.
        Zeitraum z = new Zeitraum(LocalDate.parse("2026-03-29"), LocalDate.parse("2026-10-25"));
        assertThat(z.window().from()).isEqualTo(Instant.parse("2026-03-28T23:00:00Z"));
        assertThat(z.window().to()).isEqualTo(Instant.parse("2026-10-25T23:00:00Z"));
    }

    @Test
    void schaltjahrZaehltDen29Februar() {
        Zeitraum z = new Zeitraum(LocalDate.parse("2028-02-01"), LocalDate.parse("2028-02-29"));
        assertThat(z.tage()).isEqualTo(29);
    }

    @Test
    void bis92TageJeTagDarueberJeMonat() {
        LocalDate von = LocalDate.parse("2026-01-01");
        assertThat(new Zeitraum(von, von.plusDays(91)).jeMonat()).isFalse();
        assertThat(new Zeitraum(von, von.plusDays(92)).jeMonat()).isTrue();
        assertThat(new Zeitraum(von, von.plusDays(91)).ereignisRaster()).isEqualTo(HistoryRange.MONTH);
        assertThat(new Zeitraum(von, von.plusDays(92)).ereignisRaster()).isEqualTo(HistoryRange.YEAR);
    }

    @Test
    void grenzenWerdenGeprueft() {
        assertThat(Zeitraum.pruefe(LocalDate.parse("2026-01-01"), HEUTE, HEUTE)).isNull();
        assertThat(Zeitraum.pruefe(LocalDate.parse("2026-01-01"), null, HEUTE)).isNotNull();
        assertThat(Zeitraum.pruefe(HEUTE, HEUTE.minusDays(1), HEUTE)).isEqualTo("to liegt vor from");
        assertThat(Zeitraum.pruefe(HEUTE, HEUTE.plusDays(1), HEUTE)).isEqualTo("to liegt in der Zukunft");
        assertThat(Zeitraum.pruefe(HEUTE.minusDays(Zeitraum.MAX_TAGE - 1), HEUTE, HEUTE)).isNull();
        assertThat(Zeitraum.pruefe(HEUTE.minusDays(Zeitraum.MAX_TAGE), HEUTE, HEUTE)).contains("länger");
    }

    @Test
    void monatsEimerSummierenUndBeginnenAmZeitraum() {
        Zeitraum z = new Zeitraum(LocalDate.parse("2025-11-15"), LocalDate.parse("2026-02-28"));
        List<HistoryBucketDto> tage = new ArrayList<>();
        for (LocalDate d = z.von(); !d.isAfter(z.bis()); d = d.plusDays(1)) {
            boolean luecke = d.equals(LocalDate.parse("2026-01-10"));
            tage.add(tag(d, luecke ? null : new BigDecimal("2.000"), new BigDecimal("1.500"),
                    d.getDayOfMonth() == 1 ? new BigDecimal("10") : new BigDecimal("50")));
        }
        List<HistoryBucketDto> monate = z.monatsEimer(tage);
        assertThat(monate).hasSize(4);
        // November beginnt am 15. (Beginn des Zeitraums), die anderen am Monatsersten.
        assertThat(monate.get(0).start()).isEqualTo(Instant.parse("2025-11-14T23:00:00Z"));
        assertThat(monate.get(1).start()).isEqualTo(Instant.parse("2025-11-30T23:00:00Z"));
        assertThat(monate.get(0).gridImportKwh()).isEqualByComparingTo("32.000"); // 16 Tage
        // Ein fehlender Tag fehlt in der Summe - er wird keine 0 und macht den Monat nicht leer.
        assertThat(monate.get(2).gridImportKwh()).isEqualByComparingTo("60.000"); // 31 - 1 Tage
        assertThat(monate.get(2).gridExportKwh()).isEqualByComparingTo("46.500");
        assertThat(monate.get(2).socMinPct()).isEqualByComparingTo("10");
        assertThat(monate.get(2).priceEurMwh()).isNull();
        // Summe aller Monate = Summe aller Tage.
        BigDecimal summeMonate = monate.stream().map(HistoryBucketDto::gridImportKwh)
                .reduce(BigDecimal.ZERO, BigDecimal::add);
        BigDecimal summeTage = tage.stream().map(HistoryBucketDto::gridImportKwh)
                .filter(v -> v != null).reduce(BigDecimal.ZERO, BigDecimal::add);
        assertThat(summeMonate).isEqualByComparingTo(summeTage);
    }

    @Test
    void ohneKanalBleibtDieMonatssummeLeer() {
        Zeitraum z = new Zeitraum(LocalDate.parse("2026-01-01"), LocalDate.parse("2026-04-30"));
        List<HistoryBucketDto> tage = List.of(tag(LocalDate.parse("2026-01-05"), null, null, null));
        HistoryBucketDto januar = z.monatsEimer(tage).get(0);
        assertThat(januar.gridImportKwh()).isNull();
        assertThat(januar.socLastPct()).isNull();
    }

    private static HistoryBucketDto tag(LocalDate d, BigDecimal bezug, BigDecimal einspeisung, BigDecimal soc) {
        return new HistoryBucketDto(d.atStartOfDay(HistoryRange.ZONE).toInstant(),
                null, null, bezug, einspeisung, null, null, soc, soc, soc, null, null);
    }
}
