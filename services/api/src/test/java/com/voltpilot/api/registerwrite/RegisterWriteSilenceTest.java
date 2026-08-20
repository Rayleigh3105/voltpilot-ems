package com.voltpilot.api.registerwrite;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import org.junit.jupiter.api.Test;

/**
 * Die DREI unterscheidbaren Fälle des Schweigens (Produktionsvorfall
 * 20.08.2026, Auftrag 3). Rein, ohne Uhr, ohne Container.
 *
 * <p>Vorher trug jeder Ausgang denselben Satz - und der beschuldigte in zwei von
 * drei Fällen die Anlage, obwohl entweder die Cloud nicht senden konnte oder das
 * Gerät sehr wohl geantwortet hatte, nur zu spät.
 */
class RegisterWriteSilenceTest {

    private static final Instant NOW = Instant.parse("2026-08-20T07:30:00Z");
    private static final Duration BUDGET = Duration.ofSeconds(40);

    @Test
    void aDeviceThatNeverReportedIsNamedAsSuchAndTheAnlageIsNotBlamed() {
        String msg = RegisterWriteSilence.message(false, null, NOW, BUDGET, Optional.empty());
        assertThat(msg).contains("noch nie bei VoltPilot gemeldet");
        assertThat(msg).doesNotContain("verbunden");
    }

    @Test
    void aStaleDeviceIsNamedWithHowLongItHasBeenSilent() {
        String msg = RegisterWriteSilence.message(false, NOW.minusSeconds(20 * 60), NOW, BUDGET,
                Optional.empty());
        assertThat(msg).contains("meldet sich seit 20 Minuten nicht mehr");
        assertThat(msg).contains("sehr wahrscheinlich nicht empfangen");
    }

    /**
     * ⚠ Der Fall, der den Vorfall ausgelöst hat: das Gerät ANTWORTET, nur zu
     * spät. „Erneut versuchen" hilft hier wirklich - bei einem stummen Gerät
     * nicht, und deshalb dürfen die zwei nie denselben Satz tragen.
     */
    @Test
    void aLiveDeviceThatAnsweredLateBeforeSaysExactlyThat() {
        Optional<RegisterWriteRegistry.LateAnswer> late = Optional.of(
                new RegisterWriteRegistry.LateAnswer("abc", Duration.ofSeconds(6), NOW));
        String msg = RegisterWriteSilence.message(false, NOW.minusSeconds(12), NOW, BUDGET, late);
        assertThat(msg).contains("langsamer");
        assertThat(msg).contains("6 Sekunden zu spät");
        assertThat(msg).contains("40 Sekunden");
    }

    /**
     * ⚠ Eine verspätete Antwort SCHLÄGT die Telemetrie-Frische: sie kommt aus
     * genau diesem Pfad, während {@code lastSeenAt} eine andere Kette misst. Ein
     * Gerät, das nachweislich geantwortet hat, darf nie „meldet sich nicht"
     * heißen.
     */
    @Test
    void aLateAnswerOutranksAStaleTelemetryClock() {
        Optional<RegisterWriteRegistry.LateAnswer> late = Optional.of(
                new RegisterWriteRegistry.LateAnswer("abc", Duration.ofSeconds(6), NOW));
        assertThat(RegisterWriteSilence.message(false, null, NOW, BUDGET, late))
                .contains("zu spät").doesNotContain("noch nie");
        assertThat(RegisterWriteSilence.message(false, NOW.minusSeconds(3600), NOW, BUDGET, late))
                .contains("zu spät").doesNotContain("meldet sich seit");
    }

    @Test
    void aLiveDeviceWithoutAnyLateAnswerIsSaidToBeConnectedButSilent() {
        String msg = RegisterWriteSilence.message(false, NOW.minusSeconds(12), NOW, BUDGET,
                Optional.empty());
        assertThat(msg).contains("Das Gerät ist verbunden");
        assertThat(msg).contains("40 Sekunden");
        assertThat(msg).doesNotContain("zu spät");
    }

    /**
     * Beim echten Schreibvorgang bleibt der Zustand UNBEKANNT - Schweigen ist
     * nie „nicht geschrieben" (die PR-280-Lehre). Der Zusatz hängt am MODUS, nie
     * am Grund, also trägt ihn jeder der vier Fälle.
     */
    @Test
    void everyWriteCaseKeepsTheUnknownStateWarning() {
        for (Instant seen : new Instant[] {null, NOW.minusSeconds(20 * 60), NOW.minusSeconds(5)}) {
            assertThat(RegisterWriteSilence.message(true, seen, NOW, BUDGET, Optional.empty()))
                    .contains("Zustand ist unbekannt")
                    .contains("erneut lesen");
            assertThat(RegisterWriteSilence.message(false, seen, NOW, BUDGET, Optional.empty()))
                    .doesNotContain("Zustand ist unbekannt");
        }
    }

    /** Der Publish-Fall sagt AUSDRÜCKLICH, dass es nicht an der Anlage liegt. */
    @Test
    void theCloudSideFailureNeverBlamesThePlant() {
        assertThat(RegisterWriteSilence.NOT_PUBLISHED)
                .contains("liegt an VoltPilot")
                .contains("nichts gelesen und nichts geschrieben");
    }

    @Test
    void durationsAreSpokenWithoutDecimals() {
        assertThat(RegisterWriteSilence.seconds(Duration.ofSeconds(1))).isEqualTo("1 Sekunde");
        assertThat(RegisterWriteSilence.seconds(Duration.ofSeconds(40))).isEqualTo("40 Sekunden");
        assertThat(RegisterWriteSilence.seconds(Duration.ofSeconds(130))).isEqualTo("2 Minuten");
        assertThat(RegisterWriteSilence.seconds(Duration.ofHours(3))).isEqualTo("3 Stunden");
        assertThat(RegisterWriteSilence.seconds(Duration.ofSeconds(-5))).isEqualTo("0 Sekunden");
        // ⚠ Erreichbar: eine Quittung, die Sekundenbruchteile nach dem Aufgeben
        // eintrifft. „0 Sekunden zu spät" sagt nichts.
        assertThat(RegisterWriteSilence.seconds(Duration.ofMillis(300)))
                .isEqualTo("weniger als eine Sekunde");
    }
}
