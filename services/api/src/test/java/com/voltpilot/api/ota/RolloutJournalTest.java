package com.voltpilot.api.ota;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.RolloutRepository;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Der dokumentarische gitops-Spiegel (OTA Stufe 4, Entscheid D2) - rein und
 * Docker-frei wie {@link RolloutStatesTest} und {@link BakeGateTest}.
 *
 * <p>Was diese Tests schützen, ist die BRAUCHBARKEIT der Papier-Spur: sie muss
 * deterministisch sein (sonst erzeugt jeder Cron-Lauf einen Commit und der
 * Spiegel wird zu Lärm), sie darf einen Automatismus nie wie einen Menschen
 * aussehen lassen, und ein Freitext-Grund darf die Tabelle nicht sprengen - er
 * ist Beweismittel.
 */
class RolloutJournalTest {

    private static final UUID ROLLOUT = UUID.fromString("11111111-2222-3333-4444-555555555555");
    private static final UUID DEVICE = UUID.fromString("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

    private static RolloutRepository.EventRow ev(long id, String at, String actor, String event,
            String detail) {
        return new RolloutRepository.EventRow(id, Instant.parse(at), actor, event, ROLLOUT,
                DEVICE, detail);
    }

    @Test
    void theJournalRendersChronologicallyGroupedByBerlinDay() {
        String md = RolloutJournal.render(List.of(
                // Absichtlich NEUESTE ZUERST übergeben - so liefert es das Repository.
                ev(3, "2026-08-04T07:15:00Z", "admin", "wave_released", "Welle 2: 2 Geräte"),
                ev(2, "2026-08-03T12:00:00Z", "system", "device_state", "bestaetigt"),
                ev(1, "2026-08-03T11:00:00Z", "admin", "rollout_created", "edge-2026.08.0")),
                Map.of(DEVICE, "Pilsting-Edge (Pilsting)"));

        assertThat(md).contains("## 03.08.2026").contains("## 04.08.2026");
        // Vorwärts gelesen: der ältere Tag steht oben.
        assertThat(md.indexOf("## 03.08.2026")).isLessThan(md.indexOf("## 04.08.2026"));
        // 11:00Z ist 13:00 Berliner Zeit - der Betreiber liest die Zeit, in der
        // er gehandelt hat.
        assertThat(md).contains("| 13:00:00 |");
        assertThat(md).contains("Rollout gestartet").contains("Welle freigegeben");
        assertThat(md).contains("Pilsting-Edge (Pilsting)");
    }

    /**
     * Derselbe Zustand ergibt dieselben Bytes - sonst erzeugte jeder
     * Spiegel-Lauf einen Commit, und die Git-Historie wäre wertlos.
     */
    @Test
    void theOutputIsDeterministicSoARepeatedMirrorRunCommitsNothing() {
        List<RolloutRepository.EventRow> events = List.of(
                ev(1, "2026-08-03T11:00:00Z", "admin", "rollout_created", "edge-2026.08.0"));
        assertThat(RolloutJournal.render(events, Map.of(DEVICE, "A")))
                .isEqualTo(RolloutJournal.render(events, Map.of(DEVICE, "A")));
        // Und kein „erzeugt am"-Kopf, der genau das kaputtmachen würde.
        assertThat(RolloutJournal.render(events, Map.of())).doesNotContain("erzeugt am");
    }

    /** Der Wächter wird als solcher benannt - sonst ist das Journal wertlos. */
    @Test
    void theWatcherIsNamedAsAutomaticNeverAsAPerson() {
        String md = RolloutJournal.render(List.of(
                ev(1, "2026-08-03T11:00:00Z", RolloutService.SYSTEM_ACTOR, "rollout_auto_halted",
                        "fehlgeschlagen: Selbsttest nicht bestanden")),
                Map.of());

        assertThat(md).contains("automatisch");
        assertThat(md).doesNotContain("| system |");
        assertThat(md).contains("Rollout AUTOMATISCH angehalten");
        assertThat(md).contains("Selbsttest nicht bestanden");
    }

    /**
     * Ein Pipe im Freitext würde die Tabelle sprengen. Er wird ESCAPED, nicht
     * entfernt: der Grund eines Auto-Halts ist Beweismittel und wird nicht
     * gekürzt.
     */
    @Test
    void aPipeInAReasonIsEscapedNotDropped() {
        String md = RolloutJournal.render(List.of(
                ev(1, "2026-08-03T11:00:00Z", "admin", "rollout_halted", "a | b\nc")), Map.of());

        assertThat(md).contains("a \\| b c");
    }

    /** Ein Ereignis, das dieser Stand nicht kennt, steht ROH da - nie geraten. */
    /**
     * Der Spiegel ist eine Papier-Spur: ein Ereignis, das der Dienst SCHREIBT,
     * darf dort nicht als roher Schlüssel stehen. Der Wächter liest die
     * Ereignis-Namen aus dem Dienst selbst, damit ein künftiges Ereignis nicht
     * still unbeschriftet bleibt.
     */
    @Test
    void everyEventTheServiceWritesHasAGermanLabel() throws Exception {
        String src = java.nio.file.Files.readString(java.nio.file.Path.of(
                "src/main/java/com/voltpilot/api/ota/RolloutService.java"));
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("appendEvent\\([^,]+,\\s*\"([a-z_]+)\"").matcher(src);
        java.util.List<String> written = new java.util.ArrayList<>();
        while (m.find()) {
            written.add(m.group(1));
        }
        assertThat(written).as("der Wächter findet die Ereignis-Namen nicht mehr")
                .isNotEmpty();
        for (String event : written) {
            String md = RolloutJournal.render(
                    List.of(ev(1, "2026-08-05T09:00:00Z", "admin", event, null)), Map.of());
            assertThat(md).as("unbeschriftetes Ereignis: " + event)
                    .doesNotContain("| " + event + " |");
        }
    }

    @Test
    void anUnknownEventIsShownVerbatim() {
        String md = RolloutJournal.render(List.of(
                ev(1, "2026-08-03T11:00:00Z", "admin", "irgendwas_neues", null)), Map.of());

        assertThat(md).contains("irgendwas_neues");
        // Und der fehlende Freitext wird zu einem Strich, nie zu einer Behauptung.
        assertThat(md).contains("| — |");
    }

    /** Ein Gerät ohne bekannten Namen steht mit seiner Id da, nie mit einem erfundenen. */
    @Test
    void anUnlabelledDeviceKeepsItsId() {
        String md = RolloutJournal.render(List.of(
                ev(1, "2026-08-03T11:00:00Z", "admin", "target_assigned", "edge-2026.08.0")),
                Map.of());

        assertThat(md).contains(DEVICE.toString());
    }

    @Test
    void anEmptyJournalSaysSoInsteadOfRenderingAnEmptyTable() {
        String md = RolloutJournal.render(List.of(), Map.of());
        assertThat(md).contains("Bisher kein Ereignis");
        assertThat(md).doesNotContain("|---|");
    }

    /** Die Datei sagt selbst, dass sie NICHT die Autorität ist (D2). */
    @Test
    void theHeaderNamesTheAuthorityAndDeniesItsOwn() {
        String md = RolloutJournal.render(List.of(), Map.of());
        assertThat(md).contains("Die Autorität ist die Portal-DB, nicht diese Datei");
    }
}
