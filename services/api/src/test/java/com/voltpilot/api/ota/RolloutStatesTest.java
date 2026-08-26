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

    /** Dasselbe, aber mit dem maschinenlesbaren Sperr-Namen. */
    private static RolloutStates.Reported blocked(String current, String state, String verdict,
            String reason, String blocker) {
        return new RolloutStates.Reported(current, current, TARGET, state, verdict, reason,
                blocker, NOW, NOW);
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
    }

    @Test
    @DisplayName("das Pruefurteil trennt wartet von gilt-hier-nicht von kaputt")
    void theVerdictSeparatesPendingFromPolicyFromBroken() {
        // „geprüft und in Ordnung, aber das Anwenden ist beaufsichtigt" ist der
        // Zustand, in dem der ADMIN der fehlende Akteur ist - er hat seit dem
        // UX-Umbau ein eigenes Wort und liegt nie wieder im Fortschritts-Ton.
        // Seit der Vereinfachung vom 26.08.2026 ist „geprüft und in Ordnung"
        // schlicht UNTERWEGS: es wartet niemand mehr auf einen Menschen.
        RolloutStates.Verdict pending = RolloutStates.derive(TARGET,
                reported("edge-2026.07.2", "deferred", "ok", "verifiziert", NOW), NOW);
        assertThat(pending.state()).isEqualTo(RolloutStates.AUSSTEHEND);
        assertThat(RolloutStates.isConfirmed(pending.state())).isFalse();

        RolloutStates.Verdict policy = RolloutStates.derive(TARGET,
                reported("edge-2026.07.2", "deferred", "deferred", "Boden nicht erreicht", NOW),
                NOW);
        assertThat(policy.state()).isEqualTo(RolloutStates.ZURUECKGESTELLT);
        assertThat(policy.reason()).isEqualTo("Boden nicht erreicht");
        // Eine Politik-Entscheidung ist KEIN Vorfall - sie hält keinen Rollout an.

        RolloutStates.Verdict broken = RolloutStates.derive(TARGET,
                reported("edge-2026.07.2", "failed", "rejected", "Signatur ungueltig", NOW), NOW);
        assertThat(broken.state()).isEqualTo(RolloutStates.FEHLGESCHLAGEN);
    }

    /**
     * Der Canary-Soak vom 04.08.2026: das Gerät durfte nicht anwenden (steuernde
     * Anlage ohne belegte Neutral-Zeit) und meldete das - stumm blieb es bis
     * dahin auf der Edge. Sobald der Grund im Herzschlag steht, muss die
     * Spalte „Grund" der Flotten-Matrix ihn ZEIGEN und nicht durch eine eigene
     * Formulierung ersetzen: die Anlage weiß, warum sie nicht anwendet, das
     * Portal nicht.
     *
     * <p>Seit dem UX-Umbau trägt die Zeile zusätzlich den ZUSTAND {@code
     * blockiert} - vorher landete genau dieser Fall im Fortschritts-Ton
     * „ausstehend", und ein stehender Blocker sah aus wie etwas, das gleich
     * weitergeht (Reibung R4).
     */
    @Test
    @DisplayName("der Sperr-Grund des Geräts überlebt bis in die Grund-Spalte")
    void aDeviceSideBlockerReasonSurvivesIntoTheRow() {
        String blocked = RolloutStates.BLOCKED_PREFIX + "Diese Anlage steuert. Für die Familie "
                + "'hybrid_3p' ist die Neutral-Zeit des Wechselrichters NICHT verifiziert. "
                + "Es wird deshalb nicht autonom angewandt (am Prüfstand belegen und in "
                + "VP_OTA_NEUTRAL_VERIFIED eintragen).";
        RolloutStates.Verdict v = RolloutStates.derive(TARGET,
                blocked("edge-2026.07.2", "deferred", "ok", blocked, "neutralzeit"), NOW);
        assertThat(v.state()).isEqualTo(RolloutStates.BLOCKIERT);
        assertThat(v.reason()).isEqualTo(blocked);
        // Eine Sperre ist kein Vorfall und zählt nicht als bestätigt.
        assertThat(RolloutStates.isConfirmed(v.state())).isFalse();
    }

    /**
     * Die HEUTIGE Flotte fährt Stände, die den maschinenlesbaren Namen noch
     * nicht senden - und für sie wäre „wartet auf Anwendung" die falscheste
     * aller Aussagen (dort wartet niemand auf den Admin). Der gepinnte
     * Satzanfang {@code otaapply.BlockedPrefix} trägt den Übergang.
     */
    @Test
    @DisplayName("ein älterer Stand ohne Blocker-Namen wird am gepinnten Satzanfang erkannt")
    void theBlockedPrefixCarriesOlderBuilds() {
        RolloutStates.Verdict v = RolloutStates.derive(TARGET,
                reported("edge-2026.07.2", "deferred", "ok",
                        RolloutStates.BLOCKED_PREFIX + "Der Kern meldet seinen Zustand nicht.",
                        NOW), NOW);
        assertThat(v.state()).isEqualTo(RolloutStates.BLOCKIERT);

        // Und ein Grund, der NICHT so beginnt, wird nicht zur Sperre umgedeutet:
        // aus einem freundlichen Satz wird nie ein Befund.
        assertThat(RolloutStates.derive(TARGET,
                reported("edge-2026.07.2", "deferred", "ok",
                        "Release ist verifiziert.", NOW),
                NOW).state()).isEqualTo(RolloutStates.AUSSTEHEND);
    }

    /**
     * Der Sperr-Name gilt auch dort, wo das Gerät gar keinen Grund mitschickt -
     * dann formuliert diese Klasse einen, statt die Zeile ohne Grund zu lassen
     * (die Regel „jede nicht-grüne Zeile trägt ihren Grund").
     */
    @Test
    @DisplayName("eine Sperre ohne Grund bekommt trotzdem einen Satz")
    void aBlockerWithoutAReasonStillCarriesOne() {
        RolloutStates.Verdict v = RolloutStates.derive(TARGET,
                blocked("edge-2026.07.2", "deferred", "ok", null, "platte"), NOW);
        assertThat(v.state()).isEqualTo(RolloutStates.BLOCKIERT);
        assertThat(v.reason()).isNotBlank();
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
