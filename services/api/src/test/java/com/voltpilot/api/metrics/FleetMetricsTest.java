package com.voltpilot.api.metrics;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.metrics.FleetMetrics.DataState;
import com.voltpilot.api.metrics.FleetMetrics.PlanState;
import com.voltpilot.api.metrics.FleetMetrics.SiteSnapshot;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Die Regeln aus {@link FleetMetrics} für sich - ohne Spring, ohne Micrometer,
 * ohne Datenbank. {@code FleetMetricsScrapeTest} prüft, dass sie am Draht
 * ankommen; hier stehen die Grenzfälle, die dort nicht sichtbar wären.
 */
class FleetMetricsTest {

    private static final UUID SITE = UUID.randomUUID();
    private static final UUID TENANT = UUID.randomUUID();
    private static final Instant NOW = Instant.parse("2026-08-07T09:07:30Z");

    private static SiteSnapshot evaluate(Instant lastPlan, boolean everPlanned, Instant telemetry) {
        return FleetMetrics.evaluate(SITE, TENANT, lastPlan, everPlanned, telemetry);
    }

    @Test
    void aSiteThatNeverPlannedIsNeverAndCarriesNoTimestampToBuildAnAgeFrom() {
        SiteSnapshot s = evaluate(null, false, null);

        assertThat(s.planState()).isEqualTo(PlanState.NEVER);
        assertThat(s.telemetryState()).isEqualTo(DataState.NEVER);
        // Kein Zeitstempel - so kann kein Aufrufer versehentlich ein Alter bilden.
        assertThat(s.lastPlanAt()).isNull();
        assertThat(s.lastTelemetryAt()).isNull();
    }

    @Test
    void havingPlannedOnceIsWhatSeparatesOlderThanWindowFromNever() {
        // Genau dieselbe Fensterabfrage (kein Lauf drin) - der EINZIGE Unterschied
        // ist, ob die Anlage ueberhaupt je geplant wurde. Ohne diese zweite
        // Auskunft waeren beide Lagen ununterscheidbar, und Teil 2 muesste
        // entweder jede frische Anlage alarmieren oder jede tote verschweigen.
        assertThat(evaluate(null, true, null).planState())
                .isEqualTo(PlanState.OLDER_THAN_WINDOW);
        assertThat(evaluate(null, false, null).planState())
                .isEqualTo(PlanState.NEVER);
    }

    @Test
    void olderThanWindowStillCarriesNoAgeBecauseTheWindowCannotNameOne() {
        SiteSnapshot s = evaluate(null, true, null);

        // "Aelter als das Fenster" ist ein Alarm, aber kein bezifferbares Alter -
        // und eine ausgedachte Zahl waere schlimmer als gar keine.
        assertThat(s.lastPlanAt()).isNull();
    }

    @Test
    void aRunExactlyAtTheWindowEdgeIsStillKnown() {
        // Die Untergrenze der Abfrage ist >= now - 7d, ein Lauf GENAU dort kommt
        // also noch zurueck und muss dann auch als known gelten - sonst faende die
        // Ableitung ein Alter vor, das sie selbst fuer unbekannt erklaert.
        Instant edge = NOW.minus(FleetMetrics.PLAN_LOOKBACK);
        SiteSnapshot s = evaluate(edge, true, null);

        assertThat(s.planState()).isEqualTo(PlanState.KNOWN);
        assertThat(FleetMetrics.ageSeconds(s.lastPlanAt(), NOW))
                .isEqualTo(FleetMetrics.PLAN_LOOKBACK.getSeconds());
    }

    @Test
    void theWindowIsSevenDaysBecauseThatIsWhatTheQueryAsksFor() {
        // Die Konstante ist der Vertrag zwischen Abfrage, Metrik und Alarm-Regel;
        // sie wird zusaetzlich als voltpilot_site_plan_lookback_seconds exponiert.
        assertThat(FleetMetrics.PLAN_LOOKBACK).isEqualTo(Duration.ofDays(7));
        assertThat(FleetMetrics.PLAN_LOOKBACK.getSeconds()).isEqualTo(604800);
    }

    @Test
    void aTimestampInTheFutureReadsAsJustNowInsteadOfANegativeAge() {
        // Uhren-Versatz zwischen Optimierer-Host und api - ein negatives "Alter"
        // waere eine Zahl, mit der keine Alarm-Regel rechnet.
        assertThat(FleetMetrics.ageSeconds(NOW.plus(Duration.ofMinutes(5)), NOW)).isZero();
    }

    @Test
    void ageIsPlainSecondsSinceTheTimestamp() {
        assertThat(FleetMetrics.ageSeconds(NOW.minus(Duration.ofHours(17)), NOW))
                .isEqualTo(61200.0);
    }

    @Test
    void telemetryHasNoWindowSoItOnlyEverKnowsOrNever() {
        assertThat(evaluate(null, false, NOW.minus(Duration.ofDays(90))).telemetryState())
                .isEqualTo(DataState.KNOWN);
        // Eine 90 Tage alte Messung ist bekannt und uralt - genau die Aussage, die
        // "seit 90 Tagen verstummt" alarmierbar macht.
        assertThat(evaluate(null, false, NOW.minus(Duration.ofDays(90))).lastTelemetryAt())
                .isNotNull();
    }

    // --- Preis-Abdeckung: die Groesse, an der der Vorfall haengt -------------

    private static List<Instant> slots(Instant first, int count) {
        List<Instant> out = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            out.add(first.plus(FleetMetrics.SLOT.multipliedBy(i)));
        }
        return out;
    }

    @Test
    void coverageCountsFromTheSlotInProgressNotTheNextOne() {
        // 09:07:30 liegt IM Slot 09:00 - der Plan muss einen Slot enthalten, der
        // jetzt abdeckt (domain.horizon_slot_starts). Zaehlte man ab 09:15,
        // meldete die Metrik eine Abdeckung, die dem Optimierer fehlt.
        assertThat(FleetMetrics.floorToSlot(NOW)).isEqualTo(Instant.parse("2026-08-07T09:00:00Z"));

        List<Instant> ab0900 = slots(Instant.parse("2026-08-07T09:00:00Z"), 4);
        assertThat(FleetMetrics.contiguousPricedSlots(NOW, ab0900)).isEqualTo(4);
    }

    @Test
    void aMissingCurrentSlotIsZeroEvenWithPlentyOfPricesLater() {
        // Der Optimierer bricht beim ERSTEN fehlenden Slot ab. Faengt die
        // Preisreihe erst spaeter an, hat er 0 - egal wie voll es danach ist.
        List<Instant> spaeter = slots(Instant.parse("2026-08-07T12:00:00Z"), 48);

        assertThat(FleetMetrics.contiguousPricedSlots(NOW, spaeter)).isZero();
    }

    @Test
    void aGapTruncatesTheCountInsteadOfBeingCountedOver() {
        // DAS ist der Grund, warum hier nicht count(*) steht: 3 zusammenhaengende
        // Slots, dann eine Luecke, dann noch 40. Ein Zaehler meldete 43 und der
        // Optimierer uebersprang die Anlage trotzdem - die Metrik haette den
        // Vorfall dann nicht gesehen.
        List<Instant> mitLuecke = new ArrayList<>(slots(Instant.parse("2026-08-07T09:00:00Z"), 3));
        mitLuecke.addAll(slots(Instant.parse("2026-08-07T10:00:00Z"), 40));

        assertThat(mitLuecke).hasSize(43);
        assertThat(FleetMetrics.contiguousPricedSlots(NOW, mitLuecke)).isEqualTo(3);
    }

    @Test
    void coverageSaturatesAtTheHorizonInsteadOfGrowingWithTheTable() {
        // Der Optimierer fragt je Lauf 24 h an; alles darueber beantwortet keine
        // Frage mehr, kostet aber Zeilen.
        List<Instant> zweiTage = slots(FleetMetrics.floorToSlot(NOW), 192);

        assertThat(FleetMetrics.contiguousPricedSlots(NOW, zweiTage))
                .isEqualTo(FleetMetrics.HORIZON_SLOTS)
                .isEqualTo(96);
    }

    @Test
    void noPricesAtAllIsZeroAndThatIsAMeasuredFactNotAGuess() {
        // Die 0 ist hier ehrlich: wir wissen, dass die Flotte in dieser Zone
        // bepreist, und wir wissen, dass kein Slot abgedeckt ist. Genau diese 0
        // stand am 06./07.08.2026 im Optimierer-Protokoll.
        assertThat(FleetMetrics.contiguousPricedSlots(NOW, List.of())).isZero();
    }

    @Test
    void theOptimizerThresholdIsDocumentedSoTheRuleCanNameIt() {
        // Der Optimierer plant erst ab 4 h Abdeckung (inputs.MIN_HORIZON_SLOTS).
        assertThat(FleetMetrics.OPTIMIZER_MIN_SLOTS).isEqualTo(16);
    }

    @Test
    void slotFlooringMatchesTheQuarterHourGridEverythingElseUses() {
        // Epoch-ausgerichtet wie time_bucket('15 minutes', ...) und wie
        // domain.floor_to_slot - laufen die drei auseinander, zaehlt die Metrik
        // Slots, die es in der Preistabelle so nicht gibt.
        assertThat(FleetMetrics.floorToSlot(Instant.parse("2026-08-07T09:00:00Z")))
                .isEqualTo(Instant.parse("2026-08-07T09:00:00Z"));
        assertThat(FleetMetrics.floorToSlot(Instant.parse("2026-08-07T09:14:59.999Z")))
                .isEqualTo(Instant.parse("2026-08-07T09:00:00Z"));
        assertThat(FleetMetrics.floorToSlot(Instant.parse("2026-08-07T09:15:00Z")))
                .isEqualTo(Instant.parse("2026-08-07T09:15:00Z"));
        // Auch vor der Epoche sauber (Math.floorDiv, nicht Ganzzahl-Division).
        assertThat(FleetMetrics.floorToSlot(Instant.parse("1969-12-31T23:52:00Z")))
                .isEqualTo(Instant.parse("1969-12-31T23:45:00Z"));
    }
}
