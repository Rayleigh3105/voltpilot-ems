package com.voltpilot.api.ota;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Die Box-Art-Regel - rein, ohne Docker. Festgenagelt wird, was die API über
 * die Bauart einer Kundenbox behauptet und welche Zuweisung sie deshalb
 * ablehnt. Die Sätze sind wortgleich mit {@code releaseSperre} im Portal
 * ({@code adminEdgeUpdates.test.ts}).
 */
class BoxArtTest {

    private static final String DOCKER_MANIFEST = """
            {"schema_version":"1.0","release":"edge-2026.10.0","release_seq":40,
             "compat":{"backends":["compose"]}}
            """;
    private static final String LIGHT_MANIFEST = """
            {"schema_version":"1.0","release":"edge-2026.10.1","release_seq":41,
             "compat":{"backends":["light"]}}
            """;

    @Test
    @DisplayName("Box meldet Backend light → Edge Light, auch ohne Stempel")
    void reportedLightBackendIsEdgeLight() {
        assertThat(BoxArt.ofDevice("light", (String) null)).isEqualTo(BoxArt.LIGHT);
        assertThat(BoxArt.ofDevice("light", "edge-2026.09.10-a18b472eab90"))
                .as("das gemeldete Backend gewinnt").isEqualTo(BoxArt.LIGHT);
    }

    @Test
    @DisplayName("Übergang: compose + Stempel edge-light-… → Edge Light")
    void edgeLightStampWinsOverReportedCompose() {
        // Genau die Pilot-Box heute: der Core trägt compose fest ein.
        assertThat(BoxArt.ofDevice("compose", "edge-light-g2d2bca1b6", null))
                .isEqualTo(BoxArt.LIGHT);
        assertThat(BoxArt.ofDevice("compose", "edge-light-dev")).isEqualTo(BoxArt.LIGHT);
        // Der künftige Release-Stempel der eigenen Linie (E7).
        assertThat(BoxArt.ofDevice("compose", null, "edge-light-2026.10.1-3bf8c038a1b2"))
                .isEqualTo(BoxArt.LIGHT);
        // Ohne update-Block, nur mit Version.
        assertThat(BoxArt.ofDevice(null, " edge-light-g2d2bca1b6 ")).isEqualTo(BoxArt.LIGHT);
    }

    @Test
    @DisplayName("Docker-Backend oder Docker-Stempel → Docker-Box")
    void dockerBackendsAndStampsAreDockerBoxes() {
        assertThat(BoxArt.ofDevice("compose", "edge-2026.09.10-a18b472eab90"))
                .isEqualTo(BoxArt.DOCKER);
        assertThat(BoxArt.ofDevice("quadlet", (String) null)).isEqualTo(BoxArt.DOCKER);
        assertThat(BoxArt.ofDevice("mender", (String) null)).isEqualTo(BoxArt.DOCKER);
        // Ein älterer Docker-Kern meldet nur die Version, keinen update-Block.
        assertThat(BoxArt.ofDevice(null, "665d59b8c2e1")).isEqualTo(BoxArt.DOCKER);
        // „edge-" allein ist noch nicht „edge-light-".
        assertThat(BoxArt.ofDevice("compose", "edge-2026.10.1")).isEqualTo(BoxArt.DOCKER);
    }

    @Test
    @DisplayName("ohne Meldung oder mit fremdem Backend ist die Box-Art UNBEKANNT - nie still Docker")
    void unknownStaysUnknown() {
        assertThat(BoxArt.ofDevice(null, null, null)).isNull();
        assertThat(BoxArt.ofDevice("", " ")).isNull();
        assertThat(BoxArt.ofDevice("ostree", "edge-2026.10.1")).isNull();
    }

    @Test
    @DisplayName("ein Release ist Docker, bis Manifest oder Name es als light kennzeichnen")
    void releaseIsDockerUnlessMarkedLight() {
        assertThat(BoxArt.ofRelease("edge-2026.10.0", DOCKER_MANIFEST)).isEqualTo(BoxArt.DOCKER);
        assertThat(BoxArt.ofRelease("edge-2026.07.2", null))
                .as("Stufe-0-Eintrag ohne Manifest").isEqualTo(BoxArt.DOCKER);
        assertThat(BoxArt.ofRelease("edge-2026.10.0", "{nicht json"))
                .as("unlesbare Bytes kennzeichnen nichts").isEqualTo(BoxArt.DOCKER);
        assertThat(BoxArt.ofRelease("edge-2026.10.0", "{\"compat\":{}}")).isEqualTo(BoxArt.DOCKER);

        assertThat(BoxArt.ofRelease("edge-2026.10.1", LIGHT_MANIFEST)).isEqualTo(BoxArt.LIGHT);
        assertThat(BoxArt.ofRelease("edge-light-2026.10.1", null))
                .as("eigene Release-Linie (E7)").isEqualTo(BoxArt.LIGHT);
        assertThat(BoxArt.ofRelease("edge-2026.10.2",
                "{\"compat\":{\"backends\":[\"compose\",\"light\"]}}"))
                .as("ein gemischtes Manifest darf nie an eine heutige Docker-Box")
                .isEqualTo(BoxArt.LIGHT);
    }

    @Test
    @DisplayName("Zuweisung: gesperrt wird nur, was belegt nicht passt - Edge Light verlangt den Beleg")
    void assignmentRule() {
        // Passt.
        assertThat(BoxArt.sperrgrund(BoxArt.DOCKER, BoxArt.DOCKER)).isNull();
        assertThat(BoxArt.sperrgrund(BoxArt.LIGHT, BoxArt.LIGHT)).isNull();
        assertThat(BoxArt.sperrgrund(null, BoxArt.DOCKER))
                .as("eine Box, die sich noch nie gemeldet hat, holt Docker wie bisher ab")
                .isNull();

        // Passt nicht - mit dem Satz, den auch das Portal zeigt.
        assertThat(BoxArt.sperrgrund(BoxArt.LIGHT, BoxArt.DOCKER)).isEqualTo(
                "Release für die Docker-Box – diese Box ist eine Edge Light. Updates von Hand "
                        + "(Edge Light, Stufe 1): Aktualisierung über den Wartungstunnel.");
        assertThat(BoxArt.sperrgrund(BoxArt.DOCKER, BoxArt.LIGHT))
                .isEqualTo("Release für Edge Light – diese Box ist eine Docker-Box.");
        assertThat(BoxArt.sperrgrund(null, BoxArt.LIGHT)).isEqualTo(
                "Release für Edge Light – die Box-Art dieses Geräts ist unbekannt. Ein "
                        + "Edge-Light-Release geht nur an eine Box, die sich als Edge Light "
                        + "gemeldet hat.");
    }

    @Test
    @DisplayName("der 409 eines Auftrags nennt die abzuwählenden Geräte je Grund")
    void rolloutConflictNamesTheDevices() {
        String one = RolloutService.boxArtConflict("edge-2026.10.0",
                Map.of(BoxArt.GRUND_DOCKER_AUF_LIGHT, List.of("Mango (Hof Linde)")));
        assertThat(one).startsWith("Release 'edge-2026.10.0' passt nicht zu einem der gewählten "
                + "Geräte - es wurde nichts zugewiesen.");
        assertThat(one).contains("Mango (Hof Linde): " + BoxArt.GRUND_DOCKER_AUF_LIGHT);

        String many = RolloutService.boxArtConflict("edge-2026.10.0",
                Map.of(BoxArt.GRUND_DOCKER_AUF_LIGHT, List.of("A (1)", "B (2)", "C (3)", "D (4)")));
        assertThat(many).contains("passt nicht zu 4 der gewählten Geräte");
        assertThat(many).contains("A (1), B (2), C (3) und 1 weitere: ");
        assertThat(many).doesNotContain("D (4)");
    }
}
