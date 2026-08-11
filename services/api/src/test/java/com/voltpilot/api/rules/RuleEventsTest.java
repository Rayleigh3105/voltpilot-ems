package com.voltpilot.api.rules;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.ConsumerRuntimeStatusRepository.Row;
import com.voltpilot.api.repo.FlowStatusRepository.Ack;
import java.time.Instant;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Die reinen Regeln des Regel-Protokolls (Stufe 5b) - laufen IMMER, ohne
 * Docker. Sie nageln vor allem die vier Ehrlichkeitsregeln fest: die erste
 * Beobachtung ist kein Ereignis, Verschweigen ist kein Stopp, ein wechselnder
 * Grund ist kein Schaltvorgang, und der Tageszähler wird nur behauptet, wenn
 * der Speicher den Tag wirklich gesehen hat.
 */
class RuleEventsTest {

    private static final UUID WALLBOX = UUID.fromString("11111111-1111-1111-1111-111111111111");
    private static final UUID HEIZSTAB = UUID.fromString("22222222-2222-2222-2222-222222222222");
    private static final UUID FLOW = UUID.fromString("33333333-3333-3333-3333-333333333333");

    private static Row row(UUID id, String state, String reason, Double kw) {
        return new Row(id, state, reason, kw, null, null, null);
    }

    private static Ack ack(int version, String state, String detail) {
        return new Ack(FLOW, version, "hash", state, detail, Instant.EPOCH);
    }

    @Test
    @DisplayName("ein Lauf-Beginn ist „gestartet\", sein Ende „gestoppt\"")
    void switchEdges() {
        List<RuleEvents.Event> start = RuleEvents.deriveConsumerEvents(
                List.of(row(WALLBOX, "waiting", "price_below_threshold", null)),
                List.of(row(WALLBOX, "running_optimized", null, 7.4)));
        assertThat(start).singleElement().satisfies(e -> {
            assertThat(e.kind()).isEqualTo(RuleEvents.GESTARTET);
            assertThat(e.entityId()).isEqualTo(WALLBOX);
            assertThat(e.previousState()).isEqualTo("waiting");
            assertThat(e.state()).isEqualTo("running_optimized");
            assertThat(e.actualKw()).isEqualTo(7.4);
        });

        List<RuleEvents.Event> stop = RuleEvents.deriveConsumerEvents(
                List.of(row(WALLBOX, "running_forced", null, 7.4)),
                List.of(row(WALLBOX, "fulfilled", null, null)));
        assertThat(stop).singleElement()
                .extracting(RuleEvents.Event::kind).isEqualTo(RuleEvents.GESTOPPT);
        assertThat(RuleEvents.istSchaltvorgang(RuleEvents.GESTARTET)).isTrue();
        assertThat(RuleEvents.istSchaltvorgang(RuleEvents.GESTOPPT)).isTrue();
        assertThat(RuleEvents.istSchaltvorgang(RuleEvents.ZUSTAND)).isFalse();
    }

    @Test
    @DisplayName("ein Wechsel zwischen zwei Nicht-Lauf-Zuständen ist KEIN Schaltvorgang")
    void nonSwitchTransitionIsRecordedButNotCounted() {
        List<RuleEvents.Event> events = RuleEvents.deriveConsumerEvents(
                List.of(row(WALLBOX, "waiting", "guard_min_off", null)),
                List.of(row(WALLBOX, "clamped", "guard_rated_power", 11.0)));
        assertThat(events).singleElement()
                .extracting(RuleEvents.Event::kind).isEqualTo(RuleEvents.ZUSTAND);
    }

    @Test
    @DisplayName("die ERSTE Beobachtung einer Komponente ist kein Ereignis")
    void firstObservationNeverFires() {
        assertThat(RuleEvents.deriveConsumerEvents(List.of(),
                List.of(row(WALLBOX, "running_optimized", null, 7.4)))).isEmpty();
        assertThat(RuleEvents.deriveConsumerEvents(null,
                List.of(row(WALLBOX, "waiting", null, null)))).isEmpty();
    }

    @Test
    @DisplayName("eine verschwundene Komponente erzeugt KEIN „gestoppt\" - Schweigen ist eine Lücke")
    void vanishedEntityIsNotAStop() {
        assertThat(RuleEvents.deriveConsumerEvents(
                List.of(row(WALLBOX, "running_optimized", null, 7.4)), List.of())).isEmpty();
    }

    @Test
    @DisplayName("ein wechselnder GRUND bei gleichem Zustand ist kein Ereignis")
    void reasonChangeAloneIsNoEvent() {
        assertThat(RuleEvents.deriveConsumerEvents(
                List.of(row(WALLBOX, "waiting", "guard_min_off", null)),
                List.of(row(WALLBOX, "waiting", "price_below_threshold", null)))).isEmpty();
    }

    @Test
    @DisplayName("mehrere Komponenten werden unabhängig voneinander bewertet")
    void entitiesAreIndependent() {
        List<RuleEvents.Event> events = RuleEvents.deriveConsumerEvents(
                List.of(row(WALLBOX, "waiting", null, null),
                        row(HEIZSTAB, "running_optimized", null, 3.0)),
                List.of(row(WALLBOX, "running_optimized", null, 7.4),
                        row(HEIZSTAB, "running_optimized", null, 3.1)));
        assertThat(events).singleElement().satisfies(e -> {
            assertThat(e.entityId()).isEqualTo(WALLBOX);
            assertThat(e.kind()).isEqualTo(RuleEvents.GESTARTET);
        });
    }

    @Test
    @DisplayName("ein neuer bzw. neu versionierter Ack ist „ausgerollt\", ein Fehler ein Problem")
    void ackEvents() {
        assertThat(RuleEvents.deriveAckEvents(List.of(), List.of(ack(3, "active", null))))
                .singleElement().satisfies(e -> {
                    assertThat(e.kind()).isEqualTo(RuleEvents.AUSGEROLLT);
                    assertThat(e.flowId()).isEqualTo(FLOW);
                    assertThat(e.entityId()).isNull();
                    assertThat(e.detail()).isEqualTo("v3");
                });

        assertThat(RuleEvents.deriveAckEvents(List.of(ack(2, "active", null)),
                List.of(ack(3, "active", null))))
                .singleElement().satisfies(e -> {
                    assertThat(e.kind()).isEqualTo(RuleEvents.AUSGEROLLT);
                    assertThat(e.detail()).isEqualTo("v2 → v3");
                });

        assertThat(RuleEvents.deriveAckEvents(List.of(ack(3, "active", null)),
                List.of(ack(3, "error", "Knoten unbekannt"))))
                .singleElement().satisfies(e -> {
                    assertThat(e.kind()).isEqualTo(RuleEvents.GERAET_PROBLEM);
                    assertThat(e.detail()).isEqualTo("v3 · Knoten unbekannt");
                });
    }

    @Test
    @DisplayName("ein unveränderter Ack erzeugt nichts, ein verschwundener auch nicht")
    void unchangedAckIsSilent() {
        assertThat(RuleEvents.deriveAckEvents(List.of(ack(3, "active", null)),
                List.of(ack(3, "active", null)))).isEmpty();
        assertThat(RuleEvents.deriveAckEvents(List.of(ack(3, "active", null)), List.of())).isEmpty();
    }

    @Test
    @DisplayName("der Tagesbeginn ist BERLINER Mitternacht, auch am Sommerzeit-Wechsel")
    void berlinDayStart() {
        // 30.03.2025 ist der Umstellungstag (02:00 -> 03:00 MEZ->MESZ).
        Instant vormittags = ZonedDateTime.parse("2025-03-30T10:15:00+02:00[Europe/Berlin]")
                .toInstant();
        assertThat(RuleEvents.berlinDayStart(vormittags))
                .isEqualTo(ZonedDateTime.parse("2025-03-30T00:00:00+01:00[Europe/Berlin]")
                        .toInstant());

        // 23:30 Berliner Zeit im Sommer ist UTC schon der nächste Tag - der
        // Zähler darf davon nicht springen.
        Instant spaet = ZonedDateTime.parse("2025-07-15T23:30:00+02:00[Europe/Berlin]").toInstant();
        assertThat(RuleEvents.berlinDayStart(spaet))
                .isEqualTo(ZonedDateTime.parse("2025-07-15T00:00:00+02:00[Europe/Berlin]")
                        .toInstant());
    }

    @Test
    @DisplayName("der Tageszähler ist nur belastbar, wenn der Speicher den Tag ganz gesehen hat")
    void counterOnlyWhenTheDayWasWatched() {
        Instant jetzt = ZonedDateTime.parse("2025-07-15T14:05:00+02:00[Europe/Berlin]").toInstant();
        Instant heuteFrueh = ZonedDateTime.parse("2025-07-15T09:00:00+02:00[Europe/Berlin]")
                .toInstant();
        Instant gestern = ZonedDateTime.parse("2025-07-14T09:00:00+02:00[Europe/Berlin]")
                .toInstant();

        assertThat(RuleEvents.tageszaehlerBelastbar(gestern, jetzt)).isTrue();
        assertThat(RuleEvents.tageszaehlerBelastbar(heuteFrueh, jetzt)).isFalse();
        assertThat(RuleEvents.tageszaehlerBelastbar(null, jetzt)).isFalse();
        // Genau auf der Tagesgrenze zählt der Tag als vollständig gesehen.
        assertThat(RuleEvents.tageszaehlerBelastbar(RuleEvents.berlinDayStart(jetzt), jetzt))
                .isTrue();
    }
}
