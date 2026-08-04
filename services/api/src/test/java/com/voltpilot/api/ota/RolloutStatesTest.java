package com.voltpilot.api.ota;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Die Ehrlichkeitsregeln der Zustandsableitung (Scout §7) - rein, ohne Docker,
 * läuft in jedem Lauf mit. Was hier festgenagelt wird, sind nicht Details der
 * Anzeige, sondern die Aussagen, die eine Oberfläche über eine Kundenanlage
 * machen DARF.
 */
class RolloutStatesTest {

    private static final Instant NOW = Instant.parse("2026-08-05T12:00:00Z");
    private static final String TARGET = "edge-2026.08.0";

    private static RolloutStates.Reported reported(String current, String state, String verdict,
            String reason, Instant reportedAt) {
        return new RolloutStates.Reported(current, current, TARGET, state, verdict, reason,
                reportedAt, reportedAt);
    }

    @Test
    @DisplayName("ein Gerät ohne Meldung ist UNBEKANNT - nie veraltet")
    void unknownIsNeverOutdated() {
        RolloutStates.Verdict v = RolloutStates.derive(TARGET, null, NOW);
        assertThat(v.state()).isEqualTo(RolloutStates.UNBEKANNT);
        assertThat(v.reason()).isNotBlank();
        // Und auch eine leere Meldung bleibt unbekannt statt „nicht aktuell".
        assertThat(RolloutStates.derive(TARGET,
                new RolloutStates.Reported(null, null, null, null, null, null, null, null), NOW)
                .state()).isEqualTo(RolloutStates.UNBEKANNT);
    }

    @Test
    @DisplayName("ein stilles Gerät holt nach - es ist NICHT fehlgeschlagen")
    void offlineIsNeverFailure() {
        RolloutStates.Verdict v = RolloutStates.derive(TARGET,
                reported("edge-2026.07.2", "deferred", "ok", null, NOW.minus(Duration.ofHours(2))),
                NOW);
        assertThat(v.state()).isEqualTo(RolloutStates.OFFLINE_HOLT_NACH);
        // Der Grund muss sagen, dass die Zuweisung wartet - sonst liest sich
        // „offline" wie ein verlorener Rollout.
        assertThat(v.reason()).contains("Broker");
    }

    @Test
    @DisplayName("ein stilles Gerät, das den Soll-Stand FÄHRT, ist bestätigt")
    void silentButOnTargetIsConfirmed() {
        RolloutStates.Verdict v = RolloutStates.derive(TARGET,
                reported(TARGET, "succeeded", "ok", null, NOW.minus(Duration.ofHours(6))), NOW);
        assertThat(v.state()).isEqualTo(RolloutStates.BESTAETIGT);
    }

    @Test
    @DisplayName("im Update verstummt ist ein EIGENER Zustand, nicht offline")
    void silentWhileApplyingIsItsOwnState() {
        // Frisch im Anwenden: das ist normal.
        assertThat(RolloutStates.derive(TARGET,
                reported("edge-2026.07.2", "applying", "ok", null, NOW.minus(Duration.ofMinutes(2))),
                NOW).state()).isEqualTo(RolloutStates.WENDET_AN);

        // Lange still, NACHDEM es den Beginn gemeldet hat - genau der Fall, für
        // den `applying` durabel vor dem Stoppen berichtet wird.
        RolloutStates.Verdict v = RolloutStates.derive(TARGET,
                reported("edge-2026.07.2", "applying", "ok", null, NOW.minus(Duration.ofMinutes(45))),
                NOW);
        assertThat(v.state()).isEqualTo(RolloutStates.IM_UPDATE_VERSTUMMT);
        assertThat(v.reason()).isNotBlank();
        assertThat(RolloutStates.haltsRollout(v.state())).isTrue();
    }

    @Test
    @DisplayName("ein Endzustand des Geräts überlebt sein Verstummen")
    void reportedFailureSurvivesSilence() {
        RolloutStates.Verdict failed = RolloutStates.derive(TARGET,
                reported("edge-2026.07.2", "failed", "ok", "Pull fehlgeschlagen",
                        NOW.minus(Duration.ofHours(3))), NOW);
        assertThat(failed.state()).isEqualTo(RolloutStates.FEHLGESCHLAGEN);
        assertThat(failed.reason()).isEqualTo("Pull fehlgeschlagen");

        RolloutStates.Verdict rolled = RolloutStates.derive(TARGET,
                reported("edge-2026.07.2", "rolled_back", "ok", null, NOW), NOW);
        assertThat(rolled.state()).isEqualTo(RolloutStates.ZURUECKGEROLLT);
        assertThat(rolled.reason()).isNotBlank();
        assertThat(RolloutStates.haltsRollout(rolled.state())).isTrue();
    }

    @Test
    @DisplayName("das Pruefurteil trennt wartet von gilt-hier-nicht von kaputt")
    void theVerdictSeparatesPendingFromPolicyFromBroken() {
        RolloutStates.Verdict pending = RolloutStates.derive(TARGET,
                reported("edge-2026.07.2", "deferred", "ok", "verifiziert - beaufsichtigt", NOW),
                NOW);
        assertThat(pending.state()).isEqualTo(RolloutStates.AUSSTEHEND);

        RolloutStates.Verdict policy = RolloutStates.derive(TARGET,
                reported("edge-2026.07.2", "deferred", "deferred", "Boden nicht erreicht", NOW),
                NOW);
        assertThat(policy.state()).isEqualTo(RolloutStates.ZURUECKGESTELLT);
        assertThat(policy.reason()).isEqualTo("Boden nicht erreicht");
        // Eine Politik-Entscheidung ist KEIN Vorfall - sie hält keinen Rollout an.
        assertThat(RolloutStates.haltsRollout(policy.state())).isFalse();

        RolloutStates.Verdict broken = RolloutStates.derive(TARGET,
                reported("edge-2026.07.2", "failed", "rejected", "Signatur ungueltig", NOW), NOW);
        assertThat(broken.state()).isEqualTo(RolloutStates.FEHLGESCHLAGEN);
        assertThat(RolloutStates.haltsRollout(broken.state())).isTrue();
    }

    /**
     * Der Canary-Soak vom 04.08.2026: das Gerät durfte nicht anwenden (steuernde
     * Anlage ohne belegte Neutral-Zeit) und meldete das - stumm blieb es bis
     * dahin auf der Edge. Sobald der Grund im Herzschlag steht, muss die
     * Spalte „Grund" der Flotten-Matrix ihn ZEIGEN und nicht durch eine eigene
     * Formulierung ersetzen: die Anlage weiß, warum sie nicht anwendet, das
     * Portal nicht.
     */
    @Test
    @DisplayName("der Sperr-Grund des Geräts überlebt bis in die Grund-Spalte")
    void aDeviceSideBlockerReasonSurvivesIntoTheRow() {
        String blocked = "Autonomie blockiert: Diese Anlage steuert. Für die Familie "
                + "'hybrid_3p' ist die Neutral-Zeit des Wechselrichters NICHT verifiziert. "
                + "Es wird deshalb nicht autonom angewandt (am Prüfstand belegen und in "
                + "VP_OTA_NEUTRAL_VERIFIED eintragen).";
        RolloutStates.Verdict v = RolloutStates.derive(TARGET,
                reported("edge-2026.07.2", "deferred", "ok", blocked, NOW), NOW);
        assertThat(v.state()).isEqualTo(RolloutStates.AUSSTEHEND);
        assertThat(v.reason()).isEqualTo(blocked);
    }

    @Test
    @DisplayName("ohne Zuweisung wird kein Fortschritt behauptet")
    void withoutATargetNothingIsClaimed() {
        RolloutStates.Verdict v = RolloutStates.derive(null,
                reported("edge-2026.07.2", "idle", null, null, NOW), NOW);
        assertThat(v.state()).isEqualTo(RolloutStates.AKTUELL);
        assertThat(v.reason()).isNull();
    }

    @Test
    @DisplayName("der Stempel-Vergleich ist der Zwilling der Geräte-Regel")
    void theStampComparisonMirrorsTheDevice() {
        // edge-images stempelt bei Tag-Builds `<tag>-<kurzsha>`.
        assertThat(RolloutStates.releaseIsRunning(TARGET, TARGET)).isTrue();
        assertThat(RolloutStates.releaseIsRunning(TARGET, TARGET + "-3bf8c038")).isTrue();
        // Eine nackte SHA gehört zu KEINEM Release - das ist die ehrliche
        // Antwort, nicht ein geratenes „ist wohl aktuell".
        assertThat(RolloutStates.releaseIsRunning(TARGET, "3bf8c038a1b2")).isFalse();
        // Und ein Präfix-Treffer ohne Trenner zählt NICHT (edge-2026.08.01 ist
        // ein anderes Release als edge-2026.08.0).
        assertThat(RolloutStates.releaseIsRunning(TARGET, TARGET + "1")).isFalse();
        assertThat(RolloutStates.releaseIsRunning(TARGET, null)).isFalse();
        assertThat(RolloutStates.releaseIsRunning(null, TARGET)).isFalse();
    }
}
