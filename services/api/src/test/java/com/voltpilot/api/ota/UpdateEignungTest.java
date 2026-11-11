package com.voltpilot.api.ota;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Die Eignung je Box und Release, rein (Geräte &amp; Updates G1, Verteil-Dialog). */
class UpdateEignungTest {

    private static final UpdateEignung.Release DOCKER_110 =
            new UpdateEignung.Release("edge-2026.11.0", 59, BoxArt.DOCKER, false);
    private static final UpdateEignung.Release LIGHT_114 =
            new UpdateEignung.Release("edge-light-2026.11.4", 60, BoxArt.LIGHT, false);

    private static UpdateEignung.Box docker(String laeuft, Long istSeq, boolean offline) {
        return new UpdateEignung.Box(BoxArt.DOCKER, true, laeuft,
                istSeq == null ? null : laeuft, istSeq, offline, false);
    }

    @Test
    @DisplayName("bereit, wartet (offline), aktuell")
    void bereitWartetAktuell() {
        assertThat(UpdateEignung.of(DOCKER_110, docker("edge-2026.10.7", 58L, false)))
                .isEqualTo(new UpdateEignung.Urteil(UpdateEignung.BEREIT, null));
        var wartet = UpdateEignung.of(DOCKER_110, docker("edge-2026.10.7", 58L, true));
        assertThat(wartet.gruppe()).isEqualTo(UpdateEignung.WARTET);
        assertThat(wartet.grund()).contains("sobald sie sich meldet");
        assertThat(UpdateEignung.of(DOCKER_110, docker("edge-2026.11.0-c39b18d9c2a4", 59L, false))
                .gruppe()).isEqualTo(UpdateEignung.AKTUELL);
    }

    @Test
    @DisplayName("kann nicht: Stufe 1, andere Box-Art und unbekannte Box-Art bei Edge Light - mit den Sätzen der Sperre")
    void kannNichtBauart() {
        var zuhause = new UpdateEignung.Box(BoxArt.LIGHT, false, "edge-light-2026.11.0",
                "edge-light-2026.11.0", 56L, false, false);
        assertThat(UpdateEignung.of(LIGHT_114, zuhause))
                .isEqualTo(new UpdateEignung.Urteil(UpdateEignung.KANN_NICHT, BoxArt.GRUND_LIGHT_STUFE_1));
        var gate = new UpdateEignung.Box(BoxArt.LIGHT, true, "edge-light-2026.11.3",
                "edge-light-2026.11.3", 57L, false, false);
        assertThat(UpdateEignung.of(LIGHT_114, gate).gruppe()).isEqualTo(UpdateEignung.BEREIT);
        var unbekannt = new UpdateEignung.Box(null, false, null, null, null, true, false);
        assertThat(UpdateEignung.of(LIGHT_114, unbekannt))
                .isEqualTo(new UpdateEignung.Urteil(UpdateEignung.KANN_NICHT, BoxArt.GRUND_LIGHT_AUF_UNBEKANNT));
        assertThat(UpdateEignung.of(DOCKER_110, unbekannt).gruppe())
                .as("ein Docker-Release holt eine Box unbekannter Art retained ab").isEqualTo(UpdateEignung.WARTET);
    }

    @Test
    @DisplayName("G8: ein Loader, der nur die Flash-Fassung startet, kann nicht - auch mit Vertrauens-Set")
    void loaderFlash() {
        var dirolf = new UpdateEignung.Box(BoxArt.LIGHT, true, "edge-light-2026.11.3",
                "edge-light-2026.11.3", 57L, false, false, "flash");
        assertThat(UpdateEignung.of(LIGHT_114, dirolf))
                .isEqualTo(new UpdateEignung.Urteil(UpdateEignung.KANN_NICHT, BoxArt.GRUND_LIGHT_STUFE_1_LOADER));
        var nachgeruestet = new UpdateEignung.Box(BoxArt.LIGHT, true, "edge-light-2026.11.3",
                "edge-light-2026.11.3", 57L, false, false, "update");
        assertThat(UpdateEignung.of(LIGHT_114, nachgeruestet).gruppe()).isEqualTo(UpdateEignung.BEREIT);
    }

    @Test
    @DisplayName("kann nicht: eine neuere Fassung läuft schon und das Release erlaubt keinen Rückschritt")
    void rueckschritt() {
        var neuer = docker("edge-2026.11.0", 59L, false);
        var aelter = new UpdateEignung.Release("edge-2026.10.7", 58, BoxArt.DOCKER, false);
        var u = UpdateEignung.of(aelter, neuer);
        assertThat(u.gruppe()).isEqualTo(UpdateEignung.KANN_NICHT);
        assertThat(u.grund()).isEqualTo("Läuft schon edge-2026.11.0 (neuer). Eine ältere Fassung lehnt die Box ab.");
        var erlaubt = new UpdateEignung.Release("edge-2026.10.7", 58, BoxArt.DOCKER, true);
        assertThat(UpdateEignung.of(erlaubt, neuer).gruppe()).isEqualTo(UpdateEignung.BEREIT);
        // Ein nicht registrierter Stand ist keine Alters-Aussage: kein Rückschritt-Urteil.
        assertThat(UpdateEignung.of(aelter, docker("665d59b8c0de", null, false)).gruppe())
                .isEqualTo(UpdateEignung.BEREIT);
    }

    @Test
    @DisplayName("kann nicht: Kundenbereich beendet - vor allem anderen")
    void beendet() {
        var b = new UpdateEignung.Box(BoxArt.DOCKER, true, "edge-2026.10.7", "edge-2026.10.7", 58L, true, true);
        assertThat(UpdateEignung.of(DOCKER_110, b))
                .isEqualTo(new UpdateEignung.Urteil(UpdateEignung.KANN_NICHT, UpdateEignung.GRUND_BEENDET));
    }

    @Test
    @DisplayName("allow_downgrade kommt aus dem signierten Manifest; unlesbar heißt nein")
    void erlaubtRueckschritt() {
        assertThat(UpdateEignung.erlaubtRueckschritt("{\"allow_downgrade\": true}")).isTrue();
        assertThat(UpdateEignung.erlaubtRueckschritt("{\"allow_downgrade\": false}")).isFalse();
        assertThat(UpdateEignung.erlaubtRueckschritt("{\"release\":\"edge-2026.10.7\"}")).isFalse();
        assertThat(UpdateEignung.erlaubtRueckschritt("{kaputt")).isFalse();
        assertThat(UpdateEignung.erlaubtRueckschritt(null)).isFalse();
    }
}
