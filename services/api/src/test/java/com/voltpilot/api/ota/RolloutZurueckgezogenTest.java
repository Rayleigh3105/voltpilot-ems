package com.voltpilot.api.ota;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.RolloutRepository;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Eine zurückgezogene oder abgelöste Anfrage hält eine Verteilung nicht mehr
 * offen (Geräte &amp; Updates G2, Nebenbefund 4 des Konzepts) - rein.
 */
class RolloutZurueckgezogenTest {

    private static final Instant NOW = Instant.parse("2026-11-05T10:00:00Z");
    private static final UUID LAUF = UUID.randomUUID();
    private static final UUID BOX = UUID.randomUUID();
    private static final RolloutRepository.RolloutRow ROLLOUT = new RolloutRepository.RolloutRow(
            LAUF, 59, "edge-2026.11.0", "active", "sub-admin", NOW.minus(Duration.ofHours(1)), NOW);

    private static RolloutRepository.FleetDeviceRow box(String laeuft) {
        return new RolloutRepository.FleetDeviceRow(BOX, "edge-bsp0002", "Ahrenberg Lager", UUID.randomUUID(),
                "Lager", UUID.randomUUID(), "Ahrenberg GmbH", laeuft, "compose", laeuft, "edge-2026.11.0",
                "idle", "ok", null, null, NOW, NOW, null, null, null, "root-2026-a", "rel-2026-a", null,
                null, null, null, null, null, null);
    }

    private static RolloutRepository.TargetRow ziel(UUID lauf, String release) {
        return new RolloutRepository.TargetRow(BOX, UUID.randomUUID(), UUID.randomUUID(), "Lager",
                "Ahrenberg GmbH", "edge-bsp0002", 59, release, lauf, "sub-admin", NOW, NOW, null, null);
    }

    @Test
    @DisplayName("die Anfrage gilt noch: der Zustand kommt wie bisher aus der Meldung")
    void giltNoch() {
        assertThat(RolloutService.rolloutDeviceVerdict(ROLLOUT, box("edge-2026.10.7"),
                ziel(LAUF, "edge-2026.11.0"), NOW).state()).isEqualTo(RolloutStates.AUSSTEHEND);
    }

    @Test
    @DisplayName("zurückgezogen: keine Anfrage mehr - die Zeile heißt so und hält nichts offen")
    void zurueckgezogen() {
        var v = RolloutService.rolloutDeviceVerdict(ROLLOUT, box("edge-2026.10.7"), null, NOW);
        assertThat(v.state()).isEqualTo(RolloutStates.ZURUECKGEZOGEN);
        assertThat(v.reason()).isEqualTo("Die Anfrage wurde zurückgezogen.");
    }

    @Test
    @DisplayName("abgelöst: eine neuere Anfrage (Lauf oder Einzelgerät) ersetzt die dieses Laufs")
    void abgeloest() {
        var v = RolloutService.rolloutDeviceVerdict(ROLLOUT, box("edge-2026.10.7"),
                ziel(null, "edge-2026.11.1"), NOW);
        assertThat(v.state()).isEqualTo(RolloutStates.ZURUECKGEZOGEN);
        assertThat(v.reason()).contains("edge-2026.11.1");
    }

    @Test
    @DisplayName("schon bestätigt bleibt bestätigt, auch wenn die Anfrage danach zurückgezogen wurde")
    void bestaetigtBleibt() {
        assertThat(RolloutService.rolloutDeviceVerdict(ROLLOUT, box("edge-2026.11.0-c39b18d9c2a4"),
                null, NOW).state()).isEqualTo(RolloutStates.BESTAETIGT);
    }
}
