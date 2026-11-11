package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.optimizer.SteuerungVorsprungLaeufer;
import com.voltpilot.api.optimizer.SteuerungVorsprungRepository;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Der Vorsprung mit Bestand für das Vorsprung-Budget (NS-2 A,
 * {@link SteuerungVorsprung}): rein und Docker-frei, aus bewerteten Tagen wie
 * sie der Walk liefert. Gegen echte Eimer: {@code SteuerungTageszahlTest}
 * (Fälle {@code mit_bestand}).
 */
class SteuerungVorsprungTest {

    private static final LocalDate D = LocalDate.parse("2026-10-13");
    private static final Instant BIS = Instant.parse("2026-10-13T10:15:00Z");

    /** Ein bewerteter Tag mit {@code mitBestandEur} (null = Lücke) und Vorsprung am Ende. */
    private static SteuerungMitBestand.Bewertet tag(LocalDate tag, String mitBestand,
            String vorsprungEnde, Instant messungBis) {
        return new SteuerungMitBestand.Bewertet(tag, mitBestand == null ? null : new BigDecimal(mitBestand),
                BigDecimal.ZERO, vorsprungEnde == null ? null : new BigDecimal(vorsprungEnde),
                new BigDecimal("25.00"), new BigDecimal("23.98"), BigDecimal.ZERO,
                mitBestand == null ? null : new BigDecimal(mitBestand), List.of(), messungBis);
    }

    private static Map<LocalDate, SteuerungMitBestand.Bewertet> tage(SteuerungMitBestand.Bewertet... t) {
        Map<LocalDate, SteuerungMitBestand.Bewertet> m = new HashMap<>();
        Arrays.stream(t).forEach(b -> m.put(b.tag(), b));
        return m;
    }

    /** Wie {@link EarningsRepository#vorsprungStaende}: Fenster abgeschlossen, also D-6..D. */
    private static SteuerungVorsprung.Stand stand(Map<LocalDate, SteuerungMitBestand.Bewertet> t,
            LocalDate tag, Double kapazitaet) {
        return SteuerungVorsprung.stand(SteuerungMitBestand.zeitraum(t, tag, false, true), tag, kapazitaet);
    }

    private static List<BigDecimal> eur(String... werte) {
        return Arrays.stream(werte).map(w -> w == null ? null : new BigDecimal(w)).toList();
    }

    @Test
    void derStandTraegtMonatSiebenTageUndDenVorsprungAmLetztenEimer() {
        Map<LocalDate, SteuerungMitBestand.Bewertet> t = tage(
                tag(D.withDayOfMonth(1), "5.00", "0.000", null),
                tag(D.minusDays(7), "-1.00", "1.000", null),   // 06.10.: im Monat, nicht im Fenster
                tag(D.minusDays(6), "0.50", "1.500", null),
                tag(D.minusDays(2), "-0.25", "0.500", null),
                tag(D.minusDays(1), "1.10", "-2.000", null),
                tag(D, "-0.40", "-4.500", BIS));
        SteuerungVorsprung.Stand s = stand(t, D, 59.7);
        assertThat(s.tag()).isEqualTo(D);
        assertThat(s.messungBis()).isEqualTo(BIS);
        assertThat(s.bewertungCtKwh()).isEqualByComparingTo("23.98");
        assertThat(s.vorsprungKwh()).isEqualByComparingTo("-4.500");
        assertThat(s.kapazitaetKwh()).isEqualByComparingTo("59.700");
        assertThat(s.monatMitBestandEur()).isEqualByComparingTo("4.95");
        // 7 Tage = D-6..D, der laufende Tag eingeschlossen (das Fenster der Kachel von morgen)
        assertThat(s.siebenTageMitBestandEur()).isEqualByComparingTo("0.95");
        // die 6 abgeschlossenen Tage, ältester zuerst; ungemessene zählen 0
        assertThat(s.tageMitBestandEur()).usingElementComparator(BigDecimal::compareTo)
                .containsExactlyElementsOf(eur("0.50", "0", "0", "0", "-0.25", "1.10"));
    }

    @Test
    void ueberDieMonatsgrenzeBehaeltJederTagDenWertSeinesMonats() {
        LocalDate okt2 = LocalDate.parse("2026-10-02");
        Map<LocalDate, SteuerungMitBestand.Bewertet> t = tage(
                tag(LocalDate.parse("2026-09-29"), "-0.15", "-1.250", null),
                tag(LocalDate.parse("2026-09-30"), "-0.15", "-2.500", null),
                tag(LocalDate.parse("2026-10-01"), "-0.01", "1.250", null),
                tag(okt2, "-0.01", "2.250", BIS));
        SteuerungVorsprung.Stand s = stand(t, okt2, 10.0);
        assertThat(s.monatMitBestandEur()).isEqualByComparingTo("-0.02");
        assertThat(s.siebenTageMitBestandEur()).isEqualByComparingTo("-0.32");
        assertThat(s.tageMitBestandEur()).usingElementComparator(BigDecimal::compareTo)
                .containsExactlyElementsOf(eur("0", "0", "0", "-0.15", "-0.15", "-0.01"));
        assertThat(s.vorsprungKwh()).isEqualByComparingTo("2.250");
    }

    @Test
    void eineLueckeLeertDieSummeDieSieTraegtFehlendeDatenHeisstKeinBudget() {
        // Lücke im Fenster: 7 Tage leer, der Tag selbst null; der Monat ebenso.
        Map<LocalDate, SteuerungMitBestand.Bewertet> imFenster = tage(
                tag(D.minusDays(3), null, null, null),
                tag(D, "0.10", "0.000", BIS));
        SteuerungVorsprung.Stand a = stand(imFenster, D, 60.0);
        assertThat(a.siebenTageMitBestandEur()).isNull();
        assertThat(a.monatMitBestandEur()).isNull();
        assertThat(a.tageMitBestandEur()).containsExactlyElementsOf(
                eur("0.00", "0.00", "0.00", null, "0.00", "0.00"));
        // Lücke nur im Monat, vor dem Fenster: die 7 Tage tragen weiter.
        Map<LocalDate, SteuerungMitBestand.Bewertet> imMonat = tage(
                tag(D.minusDays(9), null, null, null),
                tag(D, "0.10", "0.000", BIS));
        SteuerungVorsprung.Stand b = stand(imMonat, D, 60.0);
        assertThat(b.monatMitBestandEur()).isNull();
        assertThat(b.siebenTageMitBestandEur()).isEqualByComparingTo("0.10");
    }

    @Test
    void ohneEimerHeuteOhneLadestandOhneKapazitaetGibtEsKeinenStand() {
        Map<LocalDate, SteuerungMitBestand.Bewertet> nurGestern = tage(tag(D.minusDays(1), "1.00", "1.000", BIS));
        assertThat(stand(nurGestern, D, 60.0)).isNull();
        assertThat(stand(nurGestern, D.minusDays(1), 60.0)).isNotNull();
        Map<LocalDate, SteuerungMitBestand.Bewertet> ohneLadestand = tage(tag(D, "1.00", null, BIS));
        assertThat(stand(ohneLadestand, D, 60.0)).isNull();
        Map<LocalDate, SteuerungMitBestand.Bewertet> gut = tage(tag(D, "1.00", "1.000", BIS));
        assertThat(stand(gut, D, null)).isNull();
        assertThat(stand(gut, D, 0.0)).isNull();
        assertThat(SteuerungVorsprung.stand(null, D, 60.0)).isNull();
    }

    @Test
    void inDerErstenStundeNachMitternachtGiltDerVortagDanachNicht() {
        EarningsRepository earnings = mock(EarningsRepository.class);
        SteuerungVorsprung.Stand heute = stand(tage(tag(D, "1.00", "1.000", BIS)), D, 60.0);
        SteuerungVorsprung.Stand gestern =
                stand(tage(tag(D.minusDays(1), "2.00", "2.000", BIS)), D.minusDays(1), 60.0);
        UUID a = UUID.randomUUID();
        UUID b = UUID.randomUUID();
        when(earnings.vorsprungStaende(D)).thenReturn(Map.of(a, heute));
        when(earnings.vorsprungStaende(D.minusDays(1))).thenReturn(Map.of(a, gestern, b, gestern));

        // 13.10. 00:30 Berlin (MESZ): b hat heute noch keinen Eimer - der Vortag gilt.
        Map<UUID, SteuerungVorsprung.Stand> frueh =
                SteuerungVorsprungLaeufer.staende(earnings, Instant.parse("2026-10-12T22:30:00Z"));
        assertThat(frueh).containsEntry(a, heute).containsEntry(b, gestern).hasSize(2);

        // 01:30: kein Vortag mehr - b hat keinen Stand, also kein Budget.
        EarningsRepository spaeter = mock(EarningsRepository.class);
        when(spaeter.vorsprungStaende(D)).thenReturn(Map.of(a, heute));
        assertThat(SteuerungVorsprungLaeufer.staende(spaeter, Instant.parse("2026-10-12T23:30:00Z")))
                .containsOnlyKeys(a);
        verify(spaeter, never()).vorsprungStaende(D.minusDays(1));
    }

    /**
     * Vorgabe AN steht in {@code application.yml} ({@code matchIfMissing}); hier
     * nur mit ausdrücklichem Wert prüfbar, weil surefire den Schalter als
     * Systemeigenschaft auf {@code false} setzt.
     */
    @Test
    void derLaeuferLaesstSichAbschalten() {
        ApplicationContextRunner runner = new ApplicationContextRunner()
                .withBean("adminJdbcTemplate", JdbcTemplate.class, () -> mock(JdbcTemplate.class))
                .withBean(EarningsRepository.class, () -> mock(EarningsRepository.class))
                .withBean(SteuerungVorsprungRepository.class, () -> mock(SteuerungVorsprungRepository.class))
                .withUserConfiguration(SteuerungVorsprungLaeufer.class);
        runner.withPropertyValues("voltpilot.steuerung-vorsprung.enabled=true")
                .run(context -> assertThat(context).hasSingleBean(SteuerungVorsprungLaeufer.class));
        runner.withPropertyValues("voltpilot.steuerung-vorsprung.enabled=false")
                .run(context -> assertThat(context).doesNotHaveBean(SteuerungVorsprungLaeufer.class));
    }

    @Test
    void einKundenbereichMitFehlerLaesstDieAnderenWeiterlaufen() {
        JdbcTemplate admin = mock(JdbcTemplate.class);
        UUID kaputt = UUID.randomUUID();
        UUID gut = UUID.randomUUID();
        when(admin.queryForList(any(String.class), eq(UUID.class))).thenReturn(List.of(kaputt, gut));
        EarningsRepository earnings = mock(EarningsRepository.class);
        when(earnings.vorsprungStaende(any())).thenReturn(Map.of());
        SteuerungVorsprungRepository repo = mock(SteuerungVorsprungRepository.class);
        when(repo.schreibe(any(), any(), any())).thenAnswer(inv -> {
            if (kaputt.equals(inv.getArgument(0))) {
                throw new IllegalStateException("Datenbank weg");
            }
            return 3;
        });
        int geschrieben = new SteuerungVorsprungLaeufer(admin, earnings, repo)
                .lauf(Instant.parse("2026-10-13T10:00:00Z"));
        assertThat(geschrieben).isEqualTo(3);
    }
}
