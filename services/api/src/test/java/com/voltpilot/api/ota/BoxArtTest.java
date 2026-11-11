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
        assertThat(BoxArt.sperrgrund(BoxArt.DOCKER, BoxArt.DOCKER, true)).isNull();
        assertThat(BoxArt.sperrgrund(BoxArt.LIGHT, BoxArt.LIGHT, true)).isNull();
        assertThat(BoxArt.sperrgrund(null, BoxArt.DOCKER, false))
                .as("eine Box, die sich noch nie gemeldet hat, holt Docker wie bisher ab")
                .isNull();
        assertThat(BoxArt.sperrgrund(BoxArt.DOCKER, BoxArt.DOCKER, false))
                .as("Stufe 1 ist eine Edge-Light-Regel; die Docker-Box hat ihren eigenen Crossover")
                .isNull();

        // Passt nicht - mit dem Satz, den auch das Portal zeigt.
        assertThat(BoxArt.sperrgrund(BoxArt.LIGHT, BoxArt.DOCKER, true))
                .isEqualTo("Release für die Docker-Box – diese Box ist eine Edge Light.");
        assertThat(BoxArt.sperrgrund(BoxArt.DOCKER, BoxArt.LIGHT, true))
                .isEqualTo("Release für Edge Light – diese Box ist eine Docker-Box.");
        assertThat(BoxArt.sperrgrund(null, BoxArt.LIGHT, true)).isEqualTo(
                "Release für Edge Light – die Box-Art dieses Geräts ist unbekannt. Ein "
                        + "Edge-Light-Release geht nur an eine Box, die sich als Edge Light "
                        + "gemeldet hat.");
    }

    @Test
    @DisplayName("S0: eine Edge-Light-Box mit Stufe 1 bekommt kein Edge-Light-Release")
    void stufe1Sperre() {
        assertThat(BoxArt.sperrgrund(BoxArt.LIGHT, BoxArt.LIGHT, false)).isEqualTo(
                "Release für Edge Light – diese Box hat Stufe 1 und nimmt keine Updates aus dem "
                        + "Portal an (kein geprüftes Vertrauens-Set). Einmal über den Wartungstunnel "
                        + "nachrüsten, danach kommt jede Fassung über das Portal.");
        // Ein Docker-Release bleibt eine Frage der Bauart, nicht der Stufe.
        assertThat(BoxArt.sperrgrund(BoxArt.LIGHT, BoxArt.DOCKER, false))
                .isEqualTo(BoxArt.GRUND_DOCKER_AUF_LIGHT);
    }

    @Test
    @DisplayName("G8: ein Loader, der nur die Flash-Fassung startet, ist Stufe 1 - auch mit gekreuztem Vertrauen")
    void stufe1AmLoader() {
        assertThat(BoxArt.sperrgrund(BoxArt.LIGHT, BoxArt.LIGHT, true, "flash"))
                .isEqualTo("Release für Edge Light – diese Box hat Stufe 1: ihr Loader startet immer die "
                        + "Fassung aus dem Flash und kennt keine Updates. Einmal über den Wartungstunnel "
                        + "nachrüsten, danach kommt jede Fassung über das Portal.");
        assertThat(BoxArt.sperrgrund(BoxArt.LIGHT, BoxArt.LIGHT, true, "update")).isNull();
        assertThat(BoxArt.sperrgrund(BoxArt.LIGHT, BoxArt.LIGHT, true, null))
                .as("nicht gemeldet (ältere Box): das Vertrauen entscheidet").isNull();
        assertThat(BoxArt.sperrgrund(BoxArt.LIGHT, BoxArt.LIGHT, false, "update"))
                .isEqualTo(BoxArt.GRUND_LIGHT_STUFE_1);
        assertThat(BoxArt.sperrgrund(BoxArt.DOCKER, BoxArt.DOCKER, true, "flash"))
                .as("der Loader ist eine Edge-Light-Angabe").isNull();
        assertThat(BoxArt.stufe1(BoxArt.LIGHT, true, "flash")).isTrue();
        assertThat(BoxArt.stufe1(BoxArt.LIGHT, true, "update")).isFalse();
        assertThat(BoxArt.stufe1(BoxArt.LIGHT, true, null)).isFalse();
        assertThat(BoxArt.stufe1(BoxArt.LIGHT, false, null)).isTrue();
        assertThat(BoxArt.stufe1(BoxArt.DOCKER, false, "flash")).isFalse();
    }

    @Test
    @DisplayName("Vertrauen gekreuzt = Wurzel UND geprüftes Vertrauens-Set gemeldet (Zwilling von crossoverState)")
    void vertrauenGekreuzt() {
        assertThat(BoxArt.vertrauenGekreuzt("root-2026-a", "rel-2026-a,rel-2026-b")).isTrue();
        assertThat(BoxArt.vertrauenGekreuzt("root-2026-a", "")).as("Stufe 1: kein Vertrauens-Set").isFalse();
        assertThat(BoxArt.vertrauenGekreuzt("root-2026-a", null)).isFalse();
        assertThat(BoxArt.vertrauenGekreuzt("", "rel-2026-a")).as("ohne Wurzel").isFalse();
        assertThat(BoxArt.vertrauenGekreuzt(null, null)).as("nicht gemeldet").isFalse();
        assertThat(BoxArt.vertrauenGekreuzt(" , ", "rel-2026-a")).isFalse();
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
