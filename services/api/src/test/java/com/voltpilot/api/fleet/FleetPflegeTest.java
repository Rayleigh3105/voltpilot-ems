package com.voltpilot.api.fleet;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.AdminFleetRepository.ExportCeiling;
import com.voltpilot.api.repo.AdminFleetRepository.ForecastRow;
import com.voltpilot.api.repo.AdminFleetRepository.PvPeak;
import com.voltpilot.api.uems.GrenzeAufloesung;
import com.voltpilot.api.web.dto.AdminFleetDto.FleetFeedInDto;
import com.voltpilot.api.web.dto.AdminFleetDto.FleetForecastDto;
import com.voltpilot.api.web.dto.AdminFleetDto.FleetKwpDto;
import com.voltpilot.api.web.dto.AdminFleetDto.PflegeFlagDto;
import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Die PFLEGE-Regeln des Flotten-Pulses (B4-Vollausbau) - reine Funktionen,
 * deshalb ohne Docker und immer im Gate.
 *
 * <p>Geprüft wird vor allem die EHRLICHKEIT: was nicht gemessen ist, wird nicht
 * behauptet, und jede Lücke nennt ihren Grund.
 */
class FleetPflegeTest {

    private static final UUID A = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
    private static final UUID B = UUID.fromString("00000000-0000-0000-0000-0000000000b1");
    private static final UUID C = UUID.fromString("00000000-0000-0000-0000-0000000000c1");
    private static final UUID D = UUID.fromString("00000000-0000-0000-0000-0000000000d1");

    // ---- kWp-Plausibilität ---------------------------------------------------

    @Test
    void aMeasuredPeakFarAboveTheNameplateIsAScalingError() {
        // Der reale Präzedenzfall: ein Register-Faktor 10 macht aus 3 MW "30 MW".
        FleetKwpDto v = FleetPflege.kwp(new BigDecimal("30"), new PvPeak(new BigDecimal("420"), 2000));
        assertThat(v.verdict()).isEqualTo("zu_hoch");
        assertThat(v.reason()).contains("420,0 kW").contains("30,0 kWp").contains("Skalierungsfehler");
        assertThat(FleetPflege.flags("dynamisch", false, v, null, List.of()))
                .extracting(PflegeFlagDto::code).containsExactly("kwp-unplausibel");
    }

    @Test
    void aPeakJustBelowTheToleranceIsFine() {
        // 1,2x Nennleistung liegt unter der 1,25er Grenze - kein Urteil.
        FleetKwpDto v = FleetPflege.kwp(new BigDecimal("30"), new PvPeak(new BigDecimal("36"), 2000));
        assertThat(v.verdict()).isEqualTo("ok");
        assertThat(FleetPflege.flags("fest", false, v, null, List.of())).isEmpty();
    }

    @Test
    void aPeakFarBelowTheNameplateAsksWhetherAProducerIsMissing() {
        FleetKwpDto v = FleetPflege.kwp(new BigDecimal("100"), new PvPeak(new BigDecimal("20"), 2000));
        assertThat(v.verdict()).isEqualTo("zu_niedrig");
        assertThat(v.reason()).contains("nur 20,0 kW").contains("100,0 kWp").contains("Erzeuger");
    }

    @Test
    void noPvAtAllDespiteAMaintainedNameplateIsItsOwnSentence() {
        FleetKwpDto v = FleetPflege.kwp(new BigDecimal("40"), new PvPeak(BigDecimal.ZERO, 2000));
        assertThat(v.verdict()).isEqualTo("zu_niedrig");
        assertThat(v.reason()).isEqualTo("Keine PV-Leistung gemessen, obwohl 40,0 kWp gepflegt sind.");
    }

    @Test
    void withoutANameplateNothingIsJudgedAndTheGapNamesItsReason() {
        FleetKwpDto v = FleetPflege.kwp(null, new PvPeak(new BigDecimal("99"), 5000));
        assertThat(v.verdict()).isEqualTo("unbekannt");
        assertThat(v.reason()).contains("Keine PV-Nennleistung gepflegt");
        assertThat(FleetPflege.flags("dynamisch", false, v, null, List.of())).isEmpty();

        FleetKwpDto zero = FleetPflege.kwp(BigDecimal.ZERO, new PvPeak(new BigDecimal("99"), 5000));
        assertThat(zero.verdict()).isEqualTo("unbekannt");
    }

    @Test
    void withoutEnoughMeasurementsNothingIsJudgedEither() {
        FleetKwpDto none = FleetPflege.kwp(new BigDecimal("30"), null);
        assertThat(none.verdict()).isEqualTo("unbekannt");
        assertThat(none.reason()).contains("0 Viertelstunden");

        // Eine frische Anlage mit einem halben Tag Daten: noch kein Urteil,
        // obwohl die Spitze rechnerisch "zu niedrig" wäre.
        FleetKwpDto fresh = FleetPflege.kwp(new BigDecimal("30"), new PvPeak(BigDecimal.ONE, 40));
        assertThat(fresh.verdict()).isEqualTo("unbekannt");
        assertThat(fresh.reason()).contains("40 Viertelstunden");
        assertThat(FleetPflege.flags("dynamisch", false, fresh, null, List.of())).isEmpty();
    }

    // ---- Einspeisegrenze-Plausibilität ---------------------------------------

    @Test
    void thePilstingFeedInDriftFires() {
        // Der reale Präzedenzfall: Grenze mit 75 gepflegt, gemessen klebt die
        // Anlage an ~30 kW - vermutlich Summe der Wechselrichter-Nennleistungen
        // statt der Netzanschluss-Grenze.
        FleetFeedInDto v = FleetPflege.feedIn(new BigDecimal("75"),
                new ExportCeiling(new BigDecimal("30"), 20, 18));
        assertThat(v.verdict()).isEqualTo("zu_hoch");
        assertThat(v.reason()).contains("30,0 kW").contains("75,0 kW")
                .contains("18 Tagen").contains("zu hoch");
        assertThat(FleetPflege.flags("dynamisch", false, null, v, List.of()))
                .extracting(PflegeFlagDto::code).containsExactly("einspeisegrenze-unplausibel");
    }

    @Test
    void aPlausiblyMaintainedLimitStaysSilentAtTheSameMeasurement() {
        // Dieselbe gemessene 30-kW-Decke, aber die Grenze ist korrekt mit 30
        // gepflegt: die Anlage klebt genau an ihrer Grenze, nichts zu melden.
        FleetFeedInDto v = FleetPflege.feedIn(new BigDecimal("30"),
                new ExportCeiling(new BigDecimal("30"), 20, 18));
        assertThat(v.verdict()).isEqualTo("ok");
        assertThat(FleetPflege.flags("fest", false, null, v, List.of())).isEmpty();
    }

    @Test
    void aSiteThatSimplyNeverReachesItsLimitDoesNotFire() {
        // Kleine PV: die Anlage erreicht ihre 30-kW-Grenze nie und die
        // Tages-Maxima klebn nicht an einer stabilen Decke (nur 2 Tage nahe der
        // Decke). Kein Fehlalarm, obwohl die Decke rechnerisch weit unter der
        // Grenze liegt.
        FleetFeedInDto v = FleetPflege.feedIn(new BigDecimal("30"),
                new ExportCeiling(new BigDecimal("6"), 20, 2));
        assertThat(v.verdict()).isEqualTo("ok");
        assertThat(FleetPflege.flags("fest", false, null, v, List.of())).isEmpty();
    }

    @Test
    void weakWeeksWithTooFewExportDaysAreNotJudged() {
        // Nur 3 Tage überhaupt mit Einspeisung (Winter, schwache Wochen): darunter
        // wird nicht geurteilt, auch wenn diese wenigen an derselben Decke klebn.
        FleetFeedInDto v = FleetPflege.feedIn(new BigDecimal("75"),
                new ExportCeiling(new BigDecimal("30"), 3, 3));
        assertThat(v.verdict()).isEqualTo("unbekannt");
        assertThat(v.reason()).contains("3").contains("Export-Tage");
        assertThat(FleetPflege.flags("dynamisch", false, null, v, List.of())).isEmpty();
    }

    @Test
    void aLimitThatIsRepeatedlyExceededIsNotHeld() {
        // Richtung 2: die robuste Decke (45 kW) liegt deutlich über der gepflegten
        // Grenze (30 kW) - die Grenze wird nicht gehalten oder ist zu niedrig.
        FleetFeedInDto v = FleetPflege.feedIn(new BigDecimal("30"),
                new ExportCeiling(new BigDecimal("45"), 20, 12));
        assertThat(v.verdict()).isEqualTo("nicht_gehalten");
        assertThat(v.reason()).contains("45,0 kW").contains("30,0 kW").contains("nicht gehalten");
        assertThat(FleetPflege.flags("fest", false, null, v, List.of()))
                .extracting(PflegeFlagDto::code).containsExactly("einspeisegrenze-unplausibel");
    }

    @Test
    void justBelowTheLimitButNotDeeplyStaysSilent() {
        // Klebt an 29 kW bei einer 30-kW-Grenze: unter der Grenze, aber NICHT
        // deutlich (29 > 30 * 0,7 = 21). Korrekt gepflegt, kein Hinweis.
        FleetFeedInDto v = FleetPflege.feedIn(new BigDecimal("30"),
                new ExportCeiling(new BigDecimal("29"), 20, 18));
        assertThat(v.verdict()).isEqualTo("ok");
        assertThat(FleetPflege.flags("fest", false, null, v, List.of())).isEmpty();
    }

    @Test
    void aNonExportingSiteHasNoCeilingToClingTo() {
        // Klebt rechnerisch an ~0 kW unter einer 75-kW-Grenze: die Anlage
        // exportiert praktisch nicht, es gibt keine Decke - kein "zu_hoch".
        FleetFeedInDto v = FleetPflege.feedIn(new BigDecimal("75"),
                new ExportCeiling(new BigDecimal("0.3"), 20, 20));
        assertThat(v.verdict()).isEqualTo("ok");
        assertThat(FleetPflege.flags("dynamisch", false, null, v, List.of())).isEmpty();
    }

    @Test
    void withoutAMaintainedLimitNothingIsJudgedAndTheGapNamesItsReason() {
        FleetFeedInDto v = FleetPflege.feedIn(null, new ExportCeiling(new BigDecimal("30"), 20, 18));
        assertThat(v.verdict()).isEqualTo("unbekannt");
        assertThat(v.reason()).contains("Keine Einspeisegrenze gepflegt");
        assertThat(FleetPflege.flags("dynamisch", false, null, v, List.of())).isEmpty();

        FleetFeedInDto zero = FleetPflege.feedIn(BigDecimal.ZERO,
                new ExportCeiling(new BigDecimal("30"), 20, 18));
        assertThat(zero.verdict()).isEqualTo("unbekannt");
    }

    @Test
    void withoutAnyMeasurementNothingIsJudgedEither() {
        FleetFeedInDto v = FleetPflege.feedIn(new BigDecimal("75"), null);
        assertThat(v.verdict()).isEqualTo("unbekannt");
        assertThat(v.reason()).contains("0").contains("Export-Tage");
        assertThat(FleetPflege.flags("dynamisch", false, null, v, List.of())).isEmpty();
    }

    @Test
    void aLimitFromTheGrenzblattNamesItsSource() {
        FleetFeedInDto v = FleetPflege.feedIn(new BigDecimal("80"),
                GrenzeAufloesung.QUELLE_NETZANSCHLUSS,
                new ExportCeiling(new BigDecimal("30"), 20, 18));
        assertThat(v.verdict()).isEqualTo("zu_hoch");
        assertThat(v.reason()).contains("Einspeisegrenze aus dem Grenzblatt").contains("80,0 kW");
    }

    // ---- Prognose-Ausreißer --------------------------------------------------

    @Test
    void anOutlierIsMeasuredAgainstTheFleetMedianOfItsOwnKind() {
        // Vier Anlagen, Lastprognose: 10 / 12 / 14 / 60 % -> Median 13 %,
        // Schwelle max(25, 13*1,5=19,5) = 25 -> nur die 60%-Anlage ist Ausreißer.
        Map<UUID, List<FleetForecastDto>> checks = FleetPflege.forecastChecks(List.of(
                new ForecastRow(A, "load", 10, 14),
                new ForecastRow(B, "load", 12, 14),
                new ForecastRow(C, "load", 14, 14),
                new ForecastRow(D, "load", 60, 14)));

        assertThat(checks.get(D)).singleElement()
                .satisfies(f -> {
                    assertThat(f.outlier()).isTrue();
                    assertThat(f.fleetMedianPct()).isEqualTo(13.0);
                    assertThat(f.reason()).contains("60 %").contains("Verbrauch").contains("13 %");
                });
        assertThat(checks.get(A)).allSatisfy(f -> assertThat(f.outlier()).isFalse());
        assertThat(FleetPflege.flags("fest", false, null, null, checks.get(D)))
                .extracting(PflegeFlagDto::code).containsExactly("prognose-ausreisser-load");
    }

    @Test
    void aGoodFleetDoesNotTurnAHealthySiteIntoAnOutlier() {
        // Median 8 %, 1,5x waere 12 % - ohne den Boden waere die 13%-Anlage
        // markiert, obwohl sie voellig gesund ist (Alarm-Muedigkeit).
        Map<UUID, List<FleetForecastDto>> checks = FleetPflege.forecastChecks(List.of(
                new ForecastRow(A, "pv", 7, 14),
                new ForecastRow(B, "pv", 8, 14),
                new ForecastRow(C, "pv", 9, 14),
                new ForecastRow(D, "pv", 13, 14)));
        assertThat(checks.get(D)).singleElement()
                .satisfies(f -> assertThat(f.outlier()).isFalse());
    }

    @Test
    void withoutEnoughEvaluatedSitesThereIsNoYardstickAndNothingIsClaimed() {
        // Zwei Anlagen: "der Median" waere nur die jeweils andere Anlage.
        Map<UUID, List<FleetForecastDto>> checks = FleetPflege.forecastChecks(List.of(
                new ForecastRow(A, "load", 5, 14),
                new ForecastRow(B, "load", 90, 14)));
        assertThat(checks.get(B)).singleElement().satisfies(f -> {
            assertThat(f.outlier()).isFalse();
            assertThat(f.fleetMedianPct()).isNull();
            assertThat(f.reason()).contains("Zu wenige bewertete Anlagen");
        });
        assertThat(FleetPflege.flags("fest", false, null, null, checks.get(B))).isEmpty();
    }

    @Test
    void aSiteWithTooFewEvaluatedDaysCountsNeitherAsOutlierNorForTheMedian() {
        // C hat einen einzigen (schlechten) Tag: er darf weder den Median
        // verzerren noch selbst als Ausreissser gelten.
        Map<UUID, List<FleetForecastDto>> checks = FleetPflege.forecastChecks(List.of(
                new ForecastRow(A, "load", 10, 14),
                new ForecastRow(B, "load", 12, 14),
                new ForecastRow(D, "load", 14, 14),
                new ForecastRow(C, "load", 300, 1)));
        assertThat(checks.get(C)).singleElement().satisfies(f -> {
            assertThat(f.outlier()).isFalse();
            assertThat(f.reason()).contains("Erst 1 bewertete Tage");
        });
        assertThat(checks.get(A).get(0).fleetMedianPct()).isEqualTo(12.0);
    }

    @Test
    void loadAndPvAreNeverAveragedTogether() {
        // Verbrauch und PV sind verschiedene Groessen: je Art ein eigener
        // Massstab (hier: dieselbe Anlage ist bei PV Ausreisser, bei Last nicht).
        Map<UUID, List<FleetForecastDto>> checks = FleetPflege.forecastChecks(List.of(
                new ForecastRow(A, "load", 10, 14), new ForecastRow(A, "pv", 80, 14),
                new ForecastRow(B, "load", 11, 14), new ForecastRow(B, "pv", 12, 14),
                new ForecastRow(C, "load", 12, 14), new ForecastRow(C, "pv", 14, 14)));
        assertThat(checks.get(A)).extracting(FleetForecastDto::kind).containsExactly("load", "pv");
        assertThat(checks.get(A).get(0).outlier()).isFalse();
        assertThat(checks.get(A).get(1).outlier()).isTrue();
        assertThat(FleetPflege.flags("fest", false, null, null, checks.get(A)))
                .extracting(PflegeFlagDto::code).containsExactly("prognose-ausreisser-pv");
    }

    @Test
    void anEmptyFleetYieldsNoChecks() {
        assertThat(FleetPflege.forecastChecks(List.of())).isEmpty();
    }

    // ---- die zwei Existenz-Checks + die Reihenfolge --------------------------

    @Test
    void theTwoExistenceChecksAreExactlyTheStufe1Rules() {
        assertThat(FleetPflege.flags("ohne", false, null, null, List.of()))
                .extracting(PflegeFlagDto::label).containsExactly("Stromtarif fehlt");
        assertThat(FleetPflege.flags("dynamisch", true, null, null, List.of()))
                .extracting(PflegeFlagDto::label).containsExactly("Speicher ohne Gerät");
        assertThat(FleetPflege.flags("fest", false, null, null, List.of())).isEmpty();
        assertThat(FleetPflege.flags(null, false, null, null, null)).isEmpty();
    }

    @Test
    void allFiveFlagsComeInAFixedOrder() {
        FleetKwpDto kwp = FleetPflege.kwp(new BigDecimal("30"),
                new PvPeak(new BigDecimal("420"), 2000));
        // Pilsting: klebt an 15 Tagen bei 30 kW, Grenze mit 75 gepflegt.
        FleetFeedInDto feedIn = FleetPflege.feedIn(new BigDecimal("75"),
                new ExportCeiling(new BigDecimal("30"), 20, 15));
        List<FleetForecastDto> forecast = List.of(
                new FleetForecastDto("pv", 80, 14, 12.0, true, "Ø Abweichung 80 %."));
        assertThat(FleetPflege.flags("ohne", true, kwp, feedIn, forecast))
                .extracting(PflegeFlagDto::code)
                .containsExactly("tarif-fehlt", "speicher-ohne-geraet", "kwp-unplausibel",
                        "einspeisegrenze-unplausibel", "prognose-ausreisser-pv");
    }

    @Test
    void medianTakesTheMiddleOfAnEvenCount() {
        assertThat(FleetPflege.median(List.of(1.0, 3.0))).isEqualTo(2.0);
        assertThat(FleetPflege.median(List.of(5.0, 1.0, 3.0))).isEqualTo(3.0);
    }
}
