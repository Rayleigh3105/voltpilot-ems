package com.voltpilot.api.ota;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Das Bake-Kriterium (D4): 24 h gesund UND ≥1 echter Steuerzyklus. Rein,
 * Docker-frei - die Frage „darf die nächste Welle?" ist eine Behauptung über
 * eine Kundenanlage und wird hier festgenagelt.
 */
class BakeGateTest {

    private static final Instant NOW = Instant.parse("2026-08-05T12:00:00Z");
    private static final UUID DEV = UUID.fromString("00000000-0000-0000-0000-000000000003");

    @Test
    @DisplayName("24 h + bestätigter Steuerzyklus geben frei")
    void bothCriteriaMet() {
        Instant since = NOW.minus(Duration.ofHours(26));
        BakeGate.DeviceBake b = BakeGate.device(DEV, RolloutStates.BESTAETIGT, since,
                true, true, NOW.minus(Duration.ofHours(1)), NOW);
        assertThat(b.cycle()).isEqualTo(BakeGate.Cycle.ERFUELLT);
        assertThat(b.remaining()).isZero();
        assertThat(b.reason()).isNull();
        assertThat(BakeGate.wave(List.of(b)).passed()).isTrue();
    }

    @Test
    @DisplayName("vor Ablauf der 24 h ist gesperrt - und der GRUND nennt die Restzeit")
    void tooEarlyIsBlockedWithARemainingTime() {
        BakeGate.DeviceBake b = BakeGate.device(DEV, RolloutStates.BESTAETIGT,
                NOW.minus(Duration.ofHours(3)), true, true, NOW.minus(Duration.ofMinutes(5)), NOW);
        assertThat(b.remaining()).isEqualTo(Duration.ofHours(21));
        assertThat(b.reason()).contains("21 Std.");
        BakeGate.WaveBake w = BakeGate.wave(List.of(b));
        assertThat(w.passed()).isFalse();
        // Ein deaktivierter Knopf ohne Begründung ist eine Sackgasse.
        assertThat(w.reason()).contains("21 Std.");
    }

    @Test
    @DisplayName("ohne Steuerpfad ist der Zyklus NICHT PRUEFBAR - und das wird gesagt")
    void withoutAControlPathTheCycleIsNotCheckable() {
        // Die heutigen Bestandsboxen sind read-only. Ein zweiwertiges Kriterium
        // hätte hier nur zwei Auswege: die Welle nie freigeben (das Feature
        // wäre tot) oder den Zyklus behaupten (eine erfundene Aussage).
        BakeGate.DeviceBake b = BakeGate.device(DEV, RolloutStates.BESTAETIGT,
                NOW.minus(Duration.ofHours(30)), false, null, null, NOW);
        assertThat(b.cycle()).isEqualTo(BakeGate.Cycle.NICHT_PRUEFBAR);
        assertThat(BakeGate.wave(List.of(b)).passed()).isTrue();

        // Aber die Restzeit gilt trotzdem: „nicht prüfbar" hebelt die 24 h nicht aus.
        BakeGate.DeviceBake early = BakeGate.device(DEV, RolloutStates.BESTAETIGT,
                NOW.minus(Duration.ofHours(1)), false, null, null, NOW);
        assertThat(BakeGate.wave(List.of(early)).passed()).isFalse();
    }

    @Test
    @DisplayName("ein Gerät MIT Steuerpfad muss den Beleg wirklich liefern")
    void aControllingDeviceMustReallyProveIt() {
        Instant since = NOW.minus(Duration.ofHours(30));
        // Zertifiziert, aber der letzte Steuerzyklus liegt VOR der Bestätigung
        // des neuen Stands - er belegt also nichts über den neuen Stand.
        BakeGate.DeviceBake stale = BakeGate.device(DEV, RolloutStates.BESTAETIGT, since,
                true, true, since.minus(Duration.ofHours(2)), NOW);
        assertThat(stale.cycle()).isEqualTo(BakeGate.Cycle.OFFEN);
        assertThat(BakeGate.wave(List.of(stale)).passed()).isFalse();

        // Zertifiziert, aber der Rückleseabgleich hat NICHT gepasst.
        BakeGate.DeviceBake mismatch = BakeGate.device(DEV, RolloutStates.BESTAETIGT, since,
                true, false, NOW.minus(Duration.ofMinutes(5)), NOW);
        assertThat(mismatch.cycle()).isEqualTo(BakeGate.Cycle.OFFEN);
    }

    @Test
    @DisplayName("ein Gerät, das noch nicht bestätigt hat, hält die Welle")
    void anUnconfirmedDeviceBlocksTheWave() {
        BakeGate.DeviceBake b = BakeGate.device(DEV, RolloutStates.AUSSTEHEND,
                NOW.minus(Duration.ofDays(3)), true, true, NOW, NOW);
        assertThat(b.confirmed()).isFalse();
        assertThat(BakeGate.wave(List.of(b)).passed()).isFalse();
    }

    @Test
    @DisplayName("ein einziges offenes Gerät hält die Welle - und wird gezählt")
    void oneOpenDeviceBlocksAndTheReasonCounts() {
        BakeGate.DeviceBake ok = BakeGate.device(
                UUID.fromString("00000000-0000-0000-0000-00000000000a"),
                RolloutStates.BESTAETIGT, NOW.minus(Duration.ofHours(30)), false, null, null, NOW);
        BakeGate.DeviceBake open1 = BakeGate.device(DEV, RolloutStates.AUSSTEHEND, NOW, true,
                false, null, NOW);
        BakeGate.DeviceBake open2 = BakeGate.device(
                UUID.fromString("00000000-0000-0000-0000-00000000000b"),
                RolloutStates.AUSSTEHEND, NOW, true, false, null, NOW);
        BakeGate.WaveBake w = BakeGate.wave(List.of(ok, open1, open2));
        assertThat(w.passed()).isFalse();
        assertThat(w.reason()).contains("und 1 weitere");
    }

    @Test
    @DisplayName("eine leere Welle ist frei - es gibt nichts zu beweisen")
    void anEmptyWavePasses() {
        assertThat(BakeGate.wave(List.of()).passed()).isTrue();
        assertThat(BakeGate.wave(null).passed()).isTrue();
    }
}
