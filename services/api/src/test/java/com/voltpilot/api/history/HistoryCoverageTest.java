package com.voltpilot.api.history;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.HistoryRepository;
import com.voltpilot.api.web.dto.HistoryCoverageDto;
import java.time.Instant;
import java.time.LocalDate;
import org.junit.jupiter.api.Test;

/**
 * Die Abdeckungs-Rechnung (F4/P7) als reiner Unit-Test - kein Spring, keine DB,
 * läuft also immer. Sie beantwortet die Frage, die die Historie bisher
 * verschwiegen hat: „wie viel des Zeitraums ist wirklich gemessen, und ab wann
 * gibt es überhaupt Daten?"
 */
class HistoryCoverageTest {

    private static final Instant JUL_1 = Instant.parse("2026-06-30T22:00:00Z"); // Berlin 01.07.
    private static final HistoryRange.Window JULI =
            HistoryRange.MONTH.window(LocalDate.parse("2026-07-15"));

    private static HistoryRepository.CoverageRow row(String siteFirst, String siteLast,
            long measured, String firstIn, String lastIn, int innerGaps) {
        return new HistoryRepository.CoverageRow(
                siteFirst == null ? null : Instant.parse(siteFirst),
                siteLast == null ? null : Instant.parse(siteLast),
                measured,
                firstIn == null ? null : Instant.parse(firstIn),
                lastIn == null ? null : Instant.parse(lastIn),
                innerGaps);
    }

    @Test
    void ohneEineEinzigeGemesseneViertelstundeWirdKeineAbdeckungBehauptet() {
        assertThat(HistoryService.coverage(null, JULI, Instant.parse("2026-07-15T10:00:00Z")))
                .isNull();
        assertThat(HistoryService.coverage(row(null, null, 0, null, null, 0), JULI,
                Instant.parse("2026-07-15T10:00:00Z")))
                .isNull();
    }

    @Test
    void einVollstaendigGemessenerVergangenerMonatHatKeineLuecke() {
        // Ganzer Juli gemessen, „jetzt" liegt im August -> das Fenster endet vor
        // jetzt, also sind alle Viertelstunden des Monats erwartet.
        long quarters = 31 * 96;
        HistoryCoverageDto c = HistoryService.coverage(
                row("2026-01-01T00:00:00Z", "2026-08-01T00:00:00Z", quarters,
                        "2026-06-30T22:00:00Z", "2026-07-31T21:45:00Z", 0),
                JULI, Instant.parse("2026-08-05T10:00:00Z"));

        assertThat(c).isNotNull();
        assertThat(c.expectedFrom()).isEqualTo(JUL_1);
        assertThat(c.expectedTo()).isEqualTo(JULI.to());
        assertThat(c.expectedBuckets()).isEqualTo(quarters);
        assertThat(c.measuredBuckets()).isEqualTo(quarters);
        assertThat(c.gaps()).isZero();
        assertThat(c.resolutionMinutes()).isEqualTo(15);
    }

    @Test
    void erwartetWirdErstAbDerErstenMessung_einJahrIstNichtLueckenhaftWeilEsDieAnlageNochNichtGab() {
        // Der Befund aus dem Konzept: „Jahr 2026" zeigt Balken ab dem 19.06. -
        // und sagt es nicht. Erwartet ist genau die Zeit AB der ersten Messung.
        HistoryRange.Window jahr = HistoryRange.YEAR.window(LocalDate.parse("2026-07-15"));
        Instant erstesDatum = Instant.parse("2026-06-19T00:00:00Z");
        Instant jetzt = Instant.parse("2026-07-30T12:07:00Z");
        // durchgehend gemessen bis kurz vor jetzt
        long gemessen = 100_000; // absichtlich zu groß -> wird auf erwartet gedeckelt

        HistoryCoverageDto c = HistoryService.coverage(
                row("2026-06-19T00:00:00Z", "2026-07-30T11:45:00Z", gemessen,
                        "2026-06-19T00:00:00Z", "2026-07-30T11:45:00Z", 0),
                jahr, jetzt);

        assertThat(c.firstDataAt()).isEqualTo(erstesDatum);
        assertThat(c.expectedFrom()).isEqualTo(erstesDatum);
        // Ende = auf die Viertelstunde abgerundetes (jetzt - Rollup-Toleranz).
        assertThat(c.expectedTo()).isEqualTo(Instant.parse("2026-07-30T11:45:00Z"));
        assertThat(c.expectedBuckets()).isEqualTo(
                java.time.Duration.between(erstesDatum, Instant.parse("2026-07-30T11:45:00Z"))
                        .toMinutes() / 15);
        // Nie über 100 %: die Rollup-Toleranz darf das Fenster nicht überzählen.
        assertThat(c.measuredBuckets()).isEqualTo(c.expectedBuckets());
        assertThat(c.gaps()).isZero();
    }

    @Test
    void dieLaufendeViertelstundeIstKeineLuecke() {
        // Laufender Monat, letzter Messwert 11:45, jetzt 12:07 -> erwartet endet
        // bei 11:45, also gibt es KEINE Schwanz-Lücke.
        HistoryCoverageDto c = HistoryService.coverage(
                row("2026-07-01T00:00:00Z", "2026-07-30T11:45:00Z", 500,
                        "2026-06-30T22:00:00Z", "2026-07-30T11:45:00Z", 0),
                JULI, Instant.parse("2026-07-30T12:07:00Z"));
        assertThat(c.expectedTo()).isEqualTo(Instant.parse("2026-07-30T11:45:00Z"));
        assertThat(c.gaps()).isZero();
    }

    @Test
    void randLueckenZaehlenMit_vorneWieHinten() {
        // Daten gibt es seit Januar; im Juli beginnt die Messreihe aber erst am
        // 3. und endet am 20. -> je eine Lücke vorne und hinten, plus zwei innere.
        HistoryCoverageDto c = HistoryService.coverage(
                row("2026-01-01T00:00:00Z", "2026-07-20T00:00:00Z", 1500,
                        "2026-07-02T22:00:00Z", "2026-07-19T22:00:00Z", 2),
                JULI, Instant.parse("2026-08-05T10:00:00Z"));
        assertThat(c.gaps()).isEqualTo(4);
        assertThat(c.measuredBuckets()).isEqualTo(1500);
        assertThat(c.expectedBuckets()).isEqualTo(31 * 96);
    }

    @Test
    void einZeitraumOhneEineEinzigeMessungIstGenauEineLuecke() {
        HistoryCoverageDto c = HistoryService.coverage(
                row("2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z", 0, null, null, 0),
                JULI, Instant.parse("2026-08-05T10:00:00Z"));
        assertThat(c.measuredBuckets()).isZero();
        assertThat(c.gaps()).isEqualTo(1);
        assertThat(c.expectedBuckets()).isEqualTo(31 * 96);
    }

    @Test
    void einZukuenftigerZeitraumErwartetNichtsUndBehauptetKeineLuecke() {
        HistoryRange.Window naechstesJahr = HistoryRange.YEAR.window(LocalDate.parse("2027-03-01"));
        HistoryCoverageDto c = HistoryService.coverage(
                row("2026-01-01T00:00:00Z", "2026-07-30T00:00:00Z", 0, null, null, 0),
                naechstesJahr, Instant.parse("2026-07-30T12:07:00Z"));
        assertThat(c.expectedBuckets()).isZero();
        assertThat(c.measuredBuckets()).isZero();
        assertThat(c.gaps()).isZero();
        // Die Herkunftsangabe bleibt trotzdem stehen.
        assertThat(c.firstDataAt()).isEqualTo(Instant.parse("2026-01-01T00:00:00Z"));
    }
}
