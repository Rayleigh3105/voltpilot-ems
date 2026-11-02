package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.voltpilot.api.mispel.AusschliesslichkeitsPruefer.Ergebnis;
import com.voltpilot.api.mispel.AusschliesslichkeitsPruefer.Monat;
import com.voltpilot.api.mispel.AusschliesslichkeitsPruefer.Viertelstunde;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.YearMonth;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * MiSpeL MP-2: der Ausschließlichkeits-Prüfer rechnet (1)¼, (2)¼, (3)–(6), (9)–(11) wie Anlage 1. Prüfnachweis ist
 * die Beispielrechnung 1 der BNetzA (A1 S. 15: 100 kWh Speicherverbrauch, 130 kWh Netzbezug, 50 kWh PV → 100 kWh
 * Netzstrom im Speicher) und die Beispielrechnung 2 (A1 S. 16: 100 kWh Speichererzeugung, 80 kWh Netzeinspeisung →
 * 80 kWh aus dem Speicher). Rein: ohne Spring, ohne DB.
 */
class AusschliesslichkeitsPrueferTest {

    /** Weit hinter jedem Testjahr: alle Monate vollständig im Stand. */
    private static final Instant SPAETER = Instant.parse("2100-01-01T00:00:00Z");

    private static BigDecimal kwh(String s) {
        return new BigDecimal(s);
    }

    private static Viertelstunde qh(String beginn, String z1nb, String z1ne, String z2v, String z2e) {
        return new Viertelstunde(OffsetDateTime.parse(beginn).toInstant(), z1nb == null ? null : kwh(z1nb),
                z1ne == null ? null : kwh(z1ne), z2v == null ? null : kwh(z2v), z2e == null ? null : kwh(z2e));
    }

    private static Monat monat(Ergebnis e, String monat) {
        return e.monate().stream().filter(m -> m.monat().equals(YearMonth.parse(monat))).findFirst().orElseThrow();
    }

    private static void gleich(BigDecimal ist, BigDecimal soll, String was) {
        assertThat(ist.compareTo(soll)).as("%s: %s statt %s", was, ist, soll).isZero();
    }

    /** Prüfnachweis MP-2: Beispielrechnung 1, A1 S. 15 (Abb. 1), und Beispielrechnung 2, A1 S. 16 (Abb. 2). */
    @Test
    void beispielrechnungenDerBnetzaSpeichervorrang() {
        // Beispielrechnung 1: 130 kWh Netzbezug, 100 kWh Speicherverbrauch (die 50 kWh PV misst in A1 kein Zähler).
        Viertelstunde br1 = qh("2027-03-10T12:00:00+01:00", "130", "0", "100", "0");
        // Beispielrechnung 2: 100 kWh Speichererzeugung, 80 kWh Netzeinspeisung.
        Viertelstunde br2 = qh("2027-03-10T19:00:00+01:00", "0", "80", "0", "100");
        gleich(br1.formel1(), kwh("100"), "(1)¼ Beispielrechnung 1");
        gleich(br1.formel2(), kwh("0"), "(2)¼ Beispielrechnung 1");
        gleich(br2.formel1(), kwh("0"), "(1)¼ Beispielrechnung 2");
        gleich(br2.formel2(), kwh("80"), "(2)¼ Beispielrechnung 2");

        Ergebnis e = AusschliesslichkeitsPruefer.pruefe(2027, List.of(br1, br2), SPAETER);
        Monat maerz = monat(e, "2027-03");
        gleich(maerz.formeln().get("(3)"), kwh("130"), "(3)");
        gleich(maerz.formeln().get("(4)"), kwh("80"), "(4)");
        gleich(maerz.formeln().get("(5)"), kwh("100"), "(5)");
        gleich(maerz.formeln().get("(6)"), kwh("100"), "(6)");
        gleich(maerz.formeln().get("(9)"), kwh("100"), "(9)");
        gleich(maerz.formeln().get("(10)"), kwh("0"), "(10) = (5) – (9)");
        gleich(maerz.formeln().get("(11)"), kwh("80"), "(11)");
        assertThat(maerz.viertelstundenNetzstromImSpeicher()).isEqualTo(1);
        assertThat(maerz.viertelstundenSpeicherEinspeisung()).isEqualTo(1);
        assertThat(e.jahr().netzstromImSpeicher()).isTrue();
        assertThat(e.jahr().monateMitNetzstromImSpeicher()).isEqualTo(1);
        gleich(e.jahr().formeln().get("(9)"), kwh("100"), "(9) im Jahr");
    }

    /** Monate nach gesetzlicher Zeit: die erste Stunde des Monats gehört nicht in den Vormonat (Regel zeit). */
    @Test
    void monatsgrenzeInGesetzlicherZeit() {
        Ergebnis e = AusschliesslichkeitsPruefer.pruefe(2026, List.of(
                qh("2026-09-30T23:45:00+02:00", "2", "0", "1", "0"),
                qh("2026-10-01T00:00:00+02:00", "3", "0", "5", "0")), SPAETER);
        gleich(monat(e, "2026-09").formeln().get("(9)"), kwh("1"), "September");
        gleich(monat(e, "2026-10").formeln().get("(9)"), kwh("3"), "Oktober");
        assertThat(e.monate()).hasSize(12);
    }

    /** Soll-Viertelstunden: März 2026 hat eine Stunde weniger (2 972), Oktober eine mehr (2 980); das Jahr 35 040. */
    @Test
    void sollViertelstundenMitZeitumstellung() {
        Ergebnis e = AusschliesslichkeitsPruefer.pruefe(2026, List.of(), SPAETER);
        assertThat(monat(e, "2026-03").viertelstundenSoll()).isEqualTo(31 * 96 - 4);
        assertThat(monat(e, "2026-10").viertelstundenSoll()).isEqualTo(31 * 96 + 4);
        assertThat(e.jahr().viertelstundenSoll()).isEqualTo(365 * 96);
        assertThat(e.jahr().luecken()).isEqualTo(365 * 96);
        assertThat(e.jahr().netzstromImSpeicher()).isFalse();
    }

    /** Unbekannt ist keine Null: fehlt ein Zählerwert, ist die Viertelstunde eine Lücke und in keiner Summe. */
    @Test
    void fehlenderWertIstLueckeNichtNull() {
        Ergebnis e = AusschliesslichkeitsPruefer.pruefe(2026, List.of(
                qh("2026-05-04T12:00:00+02:00", "4", "0", null, "0"),
                qh("2026-05-04T12:15:00+02:00", "1", "0", "2", "0")), SPAETER);
        Monat mai = monat(e, "2026-05");
        assertThat(mai.viertelstundenMitWerten()).isEqualTo(1);
        assertThat(mai.luecken()).isEqualTo(31 * 96 - 1);
        gleich(mai.formeln().get("(3)"), kwh("1"), "(3) ohne Lücke");
        gleich(mai.formeln().get("(9)"), kwh("1"), "(9)");
        gleich(mai.formeln().get("(10)"), kwh("1"), "(10) = (5) – (9)");
    }

    /** Der Stand schneidet: nur Monate, die vorher begonnen haben, und nur Viertelstunden davor. */
    @Test
    void standSchneidetDasLaufendeJahr() {
        Instant stand = OffsetDateTime.parse("2026-03-02T00:00:00+01:00").toInstant();
        Ergebnis e = AusschliesslichkeitsPruefer.pruefe(2026, List.of(
                qh("2026-03-01T23:45:00+01:00", "1", "0", "1", "0"),
                qh("2026-03-02T00:00:00+01:00", "9", "0", "9", "0")), stand);
        assertThat(e.monate()).extracting(Monat::monat)
                .containsExactly(YearMonth.of(2026, 1), YearMonth.of(2026, 2), YearMonth.of(2026, 3));
        assertThat(monat(e, "2026-03").viertelstundenSoll()).isEqualTo(96);
        gleich(e.jahr().formeln().get("(9)"), kwh("1"), "(9) bis zum Stand");
    }

    /** Toleranzstaffel: strenge Zählung ab 0, Schwellen nur zur Einordnung. */
    @Test
    void toleranzStaffelZaehltNurUeberDerSchwelle() {
        Ergebnis e = AusschliesslichkeitsPruefer.pruefe(2026, List.of(
                qh("2026-06-01T12:00:00+02:00", "0.005", "0", "3", "0"),
                qh("2026-06-01T12:15:00+02:00", "0.05", "0", "3", "0"),
                qh("2026-06-01T12:30:00+02:00", "0.5", "0", "3", "0"),
                qh("2026-06-01T12:45:00+02:00", "2", "0", "3", "0"),
                qh("2026-06-01T13:00:00+02:00", "7", "0", "0", "0")), SPAETER);
        Monat juni = monat(e, "2026-06");
        assertThat(juni.viertelstundenNetzstromImSpeicher()).isEqualTo(4);
        gleich(juni.formeln().get("(9)"), kwh("2.555"), "(9) streng");
        assertThat(juni.toleranzStaffel()).extracting(s -> s.viertelstunden()).containsExactly(3, 2, 1);
        gleich(juni.toleranzStaffel().get(0).kwh(), kwh("2.55"), "über 0,01 kWh");
        gleich(juni.toleranzStaffel().get(2).kwh(), kwh("2"), "über 1 kWh");
        assertThat(e.jahr().toleranzStaffel()).isEqualTo(juni.toleranzStaffel());
    }

    /** Laden nur ohne Netzbezug und Einspeisen bei Netzbezug: kein Netzstrom im Speicher, aber Speicher-Einspeisung. */
    @Test
    void reinerEeSpeicherHatKeinenNetzstrom() {
        Ergebnis e = AusschliesslichkeitsPruefer.pruefe(2026, List.of(
                qh("2026-07-01T12:00:00+02:00", "0", "4", "3", "0"),
                qh("2026-07-01T20:00:00+02:00", "0", "2", "0", "2.5")), SPAETER);
        assertThat(e.jahr().netzstromImSpeicher()).isFalse();
        assertThat(e.jahr().viertelstundenNetzstromImSpeicher()).isZero();
        gleich(e.jahr().formeln().get("(11)"), kwh("2"), "(11)");
        assertThat(e.jahr().viertelstundenSpeicherEinspeisung()).isEqualTo(1);
    }

    @Test
    void negativerZaehlerwertIstEinFehler() {
        assertThatThrownBy(() -> qh("2026-07-01T12:00:00+02:00", "-1", "0", "0", "0"))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
