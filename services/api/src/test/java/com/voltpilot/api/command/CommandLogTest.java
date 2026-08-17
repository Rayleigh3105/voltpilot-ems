package com.voltpilot.api.command;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.command.CommandLog.Event;
import com.voltpilot.api.command.CommandLog.Observation;
import com.voltpilot.api.command.CommandLog.OpenPeriod;
import com.voltpilot.api.command.CommandLog.Plan;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Die REINEN Regeln des Kommando-Verlaufs - Docker-frei, wie
 * {@code RuleEventsTest} / {@code FleetPflegeTest}. Sie prüfen genau die fünf
 * Ehrlichkeitsregeln aus {@link CommandLog} und die drei Urteils-Ableitungen;
 * die Datenbank-Seite lebt in {@code CommandHistoryApiTest}.
 */
class CommandLogTest {

    private static final Instant T0 = Instant.parse("2026-08-18T10:00:00Z");
    private static final UUID ENTITY = UUID.fromString("11111111-1111-1111-1111-111111111111");

    // -- Regel 1: die erste Beobachtung ---------------------------------------

    @Test
    void dieErsteBeobachtungOeffnetEinePeriodeUndMeldetKeinenUebergang() {
        Plan plan = CommandLog.decide(null, obs("plan", "-4.30", CommandLog.VERDICT_BESTAETIGT), T0);

        assertThat(plan.openNew()).isTrue();
        assertThat(plan.extend()).isFalse();
        assertThat(plan.closeAt()).isNull();
        // Es gibt kein Vorher - ein „Freigabe erteilt" wäre hier erfunden.
        assertThat(plan.events()).isEmpty();
    }

    // -- Der Schlüssel --------------------------------------------------------

    @Test
    void gleicherSchluesselSchreibtDieLaufendePeriodeFort() {
        OpenPeriod open = open("plan", "-4.30", CommandLog.VERDICT_BESTAETIGT, T0);

        Plan plan = CommandLog.decide(open,
                obs("plan", "-4.30", CommandLog.VERDICT_BESTAETIGT), T0.plusSeconds(15));

        assertThat(plan.extend()).isTrue();
        assertThat(plan.openNew()).isFalse();
        assertThat(plan.closeAt()).isNull();
        assertThat(plan.events()).isEmpty();
    }

    @Test
    void derNachgefuehrteWertIstKeinSchluesselMitglied() {
        // Die Nachführung folgt sekündlich dem gemessenen Haus. Stünde sie im
        // Schlüssel, zerfiele jede Viertelstunde in Dutzende Perioden - das
        // Roh-Log durch die Hintertür (§4.2 ⚠).
        OpenPeriod open = open("follow", "-4.30", CommandLog.VERDICT_BESTAETIGT, T0);
        Observation now = new Observation(CommandLog.STREAM_BATTERIE, ENTITY, "follow", "remote",
                CommandLog.WHY_FAHRPLAN, "-4.30", -7.087, CommandLog.VERDICT_BESTAETIGT,
                true, true, false, null);

        assertThat(CommandLog.sameKey(open, now)).isTrue();
        assertThat(CommandLog.decide(open, now, T0.plusSeconds(15)).extend()).isTrue();
    }

    @Test
    void einNeuerPlanSollwertSchliesstDiePeriodeUndOeffnetDieNaechste() {
        OpenPeriod open = open("plan", "-4.30", CommandLog.VERDICT_BESTAETIGT, T0);
        Instant at = T0.plusSeconds(15);

        Plan plan = CommandLog.decide(open,
                obs("plan", "6.60", CommandLog.VERDICT_BESTAETIGT), at);

        assertThat(plan.closeAt()).isEqualTo(at);
        assertThat(plan.openNew()).isTrue();
        assertThat(plan.extend()).isFalse();
    }

    @Test
    void einKippendesRuecklesUrteilIstEinNeuerAbschnitt() {
        OpenPeriod open = open("plan", "-4.30", CommandLog.VERDICT_BESTAETIGT, T0);

        Plan plan = CommandLog.decide(open,
                obs("plan", "-4.30", CommandLog.VERDICT_ABWEICHEND), T0.plusSeconds(15));

        assertThat(plan.openNew()).isTrue();
        assertThat(plan.closeAt()).isEqualTo(T0.plusSeconds(15));
    }

    // -- Regel 2 + 3: die Lücke ----------------------------------------------

    @Test
    void eineLueckeSchliesstAmLetztenBelegtenZeitpunktUndWirdBenannt() {
        OpenPeriod open = open("plan", "-4.30", CommandLog.VERDICT_BESTAETIGT, T0);
        Instant at = T0.plus(java.time.Duration.ofHours(2));

        Plan plan = CommandLog.decide(open,
                obs("plan", "-4.30", CommandLog.VERDICT_BESTAETIGT), at);

        // NICHT bis „jetzt" weiterbehauptet: geschlossen wird dort, wo der
        // letzte Herzschlag stand.
        assertThat(plan.closeAt()).isEqualTo(T0);
        assertThat(plan.openNew()).isTrue();
        assertThat(plan.events()).singleElement()
                .extracting(Event::eventKind).isEqualTo(CommandLog.EVENT_LUECKE);
        assertThat(plan.events().get(0).startedAt()).isEqualTo(T0);
        assertThat(plan.events().get(0).endedAt()).isEqualTo(at);
    }

    @Test
    void ueberEineLueckeHinwegWirdKeinWechselBehauptet() {
        // Die Freigabe steht nach zwei Stunden Stille anders - aber WANN sie
        // sich änderte, hat niemand gesehen. Die Lücken-Zeile sagt genau das.
        OpenPeriod open = new OpenPeriod(1, CommandLog.STREAM_BATTERIE, ENTITY, T0, T0, "plan",
                "remote", CommandLog.WHY_FAHRPLAN, "-4.30", CommandLog.VERDICT_BESTAETIGT,
                true, true, false);
        Observation now = new Observation(CommandLog.STREAM_BATTERIE, ENTITY, "plan", "remote",
                CommandLog.WHY_FAHRPLAN, "-4.30", -4.3, CommandLog.VERDICT_BESTAETIGT,
                false, false, false, null);

        Plan plan = CommandLog.decide(open, now, T0.plus(java.time.Duration.ofHours(2)));

        assertThat(plan.events()).extracting(Event::eventKind)
                .containsExactly(CommandLog.EVENT_LUECKE);
    }

    @Test
    void einVerzoegerterHerzschlagIstKeineLuecke() {
        // 15-s-Takt, gelegentlich verpasst: Normalbetrieb, kein Ereignis.
        assertThat(CommandLog.isGap(T0, T0.plusSeconds(90))).isFalse();
        assertThat(CommandLog.isGap(T0, T0.plus(CommandLog.GAP_AFTER).plusSeconds(1))).isTrue();
    }

    // -- Die Punkt-Ereignisse -------------------------------------------------

    @Test
    void notAusUndFreigabeWerdenAlsPunktEreignisseFestgehalten() {
        OpenPeriod open = new OpenPeriod(1, CommandLog.STREAM_BATTERIE, ENTITY, T0, T0, "plan",
                "remote", CommandLog.WHY_FAHRPLAN, "-4.30", CommandLog.VERDICT_BESTAETIGT,
                true, true, false);
        Instant at = T0.plusSeconds(15);
        Observation now = new Observation(CommandLog.STREAM_BATTERIE, ENTITY, "plan", "remote",
                CommandLog.WHY_FAHRPLAN, "-4.30", -4.3, CommandLog.VERDICT_BESTAETIGT,
                false, false, false, null);

        Plan plan = CommandLog.decide(open, now, at);

        assertThat(plan.events()).extracting(Event::eventKind)
                .containsExactly(CommandLog.EVENT_NOTAUS_EIN, CommandLog.EVENT_FREIGABE_WIDERRUFEN);
        // Der Schlüssel ist mitgekippt, also beginnt zugleich ein neuer Abschnitt.
        assertThat(plan.closeAt()).isEqualTo(at);
    }

    @Test
    void ausUnbekanntWirdNieEinUebergang() {
        OpenPeriod open = new OpenPeriod(1, CommandLog.STREAM_VERBRAUCHER, ENTITY, T0, T0, null,
                null, null, null, CommandLog.VERDICT_BESTAETIGT, null, null, null);
        Observation now = new Observation(CommandLog.STREAM_VERBRAUCHER, ENTITY, null, null, null,
                null, null, CommandLog.VERDICT_BESTAETIGT, true, true, false, null);

        assertThat(CommandLog.gateEvents(open, now, T0.plusSeconds(15))).isEmpty();
    }

    // -- Die Urteile ----------------------------------------------------------

    @Test
    void schweigenIstNieEineAbweichung() {
        // Die Edge NENNT die abweichenden Register erst, wenn die Abweichung
        // entprellt ist - ohne sie bleibt es beim ehrlichen „unbestaetigt"
        // (die PR-280-Lehre).
        assertThat(CommandLog.batteryVerdict(true, null)).isEqualTo(CommandLog.VERDICT_BESTAETIGT);
        assertThat(CommandLog.batteryVerdict(false, null))
                .isEqualTo(CommandLog.VERDICT_UNBESTAETIGT);
        assertThat(CommandLog.batteryVerdict(false, "  "))
                .isEqualTo(CommandLog.VERDICT_UNBESTAETIGT);
        assertThat(CommandLog.batteryVerdict(false, "battery_power"))
                .isEqualTo(CommandLog.VERDICT_ABWEICHEND);
    }

    @Test
    void v1BehauptetNiemalsKeineAntwortOderPrueft() {
        // Aus 15-Sekunden-Momentaufnahmen lassen sich die beiden nicht trennen;
        // die Wörter gehören dem Präzisions-Uplink.
        assertThat(CommandLog.V1_VERDICTS)
                .doesNotContain(CommandLog.VERDICT_KEINE_ANTWORT, CommandLog.VERDICT_PRUEFT);
        assertThat(CommandLog.V1_VERDICTS).contains(CommandLog.batteryVerdict(false, "x"),
                CommandLog.batteryVerdict(true, null), CommandLog.batteryVerdict(false, null));
    }

    @Test
    void nichtsAngewandtIstKeinWiderspruch() {
        assertThat(CommandLog.curtailVerdict(null, false)).isNull();
        assertThat(CommandLog.curtailVerdict(null, true))
                .isEqualTo(CommandLog.VERDICT_UNBESTAETIGT);
        assertThat(CommandLog.curtailVerdict(Boolean.FALSE, true))
                .isEqualTo(CommandLog.VERDICT_ABWEICHEND);
        assertThat(CommandLog.curtailVerdict(Boolean.TRUE, true))
                .isEqualTo(CommandLog.VERDICT_BESTAETIGT);
    }

    @Test
    void einNichtGemeldetesVerbraucherUrteilBleibtEineLuecke() {
        assertThat(CommandLog.consumerVerdict(null)).isNull();
        assertThat(CommandLog.consumerVerdict(Boolean.TRUE))
                .isEqualTo(CommandLog.VERDICT_BESTAETIGT);
        assertThat(CommandLog.consumerVerdict(Boolean.FALSE))
                .isEqualTo(CommandLog.VERDICT_UNBESTAETIGT);
    }

    // -- Die Plan-Referenz ----------------------------------------------------

    @Test
    void diePlanReferenzIstDerSollwertVorDerKorrektur() {
        assertThat(CommandLog.planRef("follow", -7.087, -4.302)).isEqualTo("-4.30");
        // Ohne gemeldete Korrektur IST der kommandierte Wert der Plan-Wert.
        assertThat(CommandLog.planRef("plan", -4.302, null)).isEqualTo("-4.30");
        // Rauschen unterhalb der Rundung erzeugt keinen neuen Abschnitt.
        assertThat(CommandLog.planRef("plan", -4.3024, null))
                .isEqualTo(CommandLog.planRef("plan", -4.3018, null));
    }

    @Test
    void dieSicherungHatKeinePlanReferenz() {
        // Ihr Wert folgt PV minus Last und ändert sich laufend - im Schlüssel
        // entstünde je Messung eine Periode.
        assertThat(CommandLog.planRef("fallback", -3.2, null)).isNull();
        assertThat(CommandLog.planRef(null, null, null)).isNull();
    }

    @Test
    void derBerlinerTagesbeginnTraegtDenDeckel() {
        Instant at = Instant.parse("2026-08-18T21:30:00Z"); // 23:30 Berliner Sommerzeit
        assertThat(CommandLog.berlinDayStart(at)).isEqualTo(Instant.parse("2026-08-17T22:00:00Z"));
    }

    // -- Hilfen ---------------------------------------------------------------

    private static Observation obs(String mode, String planRef, String verdict) {
        return new Observation(CommandLog.STREAM_BATTERIE, ENTITY, mode, "remote",
                CommandLog.WHY_FAHRPLAN, planRef, -4.3, verdict, true, true, false, null);
    }

    private static OpenPeriod open(String mode, String planRef, String verdict, Instant lastSeen) {
        return new OpenPeriod(1, CommandLog.STREAM_BATTERIE, ENTITY, T0, lastSeen, mode, "remote",
                CommandLog.WHY_FAHRPLAN, planRef, verdict, true, true, false);
    }
}
