package com.voltpilot.api.ota;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Die neueste zuweisbare Fassung einer Linie - die eine Regel für jeden „immer die neueste"-Weg, rein. */
class NeuesteFassungTest {

    private static NeuesteFassung.Release light(long seq, String version, boolean signiert, String nichtZuweisbar) {
        return new NeuesteFassung.Release(seq, version, BoxArt.LIGHT, signiert, nichtZuweisbar);
    }

    private static final NeuesteFassung.Release DOCKER =
            new NeuesteFassung.Release(70, "edge-2026.11.3", BoxArt.DOCKER, true, null);

    @Test
    @DisplayName("höchste release_seq der eigenen Linie, nur signierte; die Reihenfolge des Registers zählt nicht")
    void hoechsteSignierteDerLinie() {
        var register = List.of(light(65, "edge-light-2026.11.13", true, null), DOCKER,
                light(61, "edge-light-2026.11.10", true, null), light(66, "edge-light-2026.11.14", false, null));
        var urteil = NeuesteFassung.of(register, BoxArt.LIGHT);
        assertThat(urteil.release().version()).as("unsigniert zählt nicht (N4)").isEqualTo("edge-light-2026.11.13");
        assertThat(urteil.zuweisbar()).isTrue();
        assertThat(NeuesteFassung.of(register, BoxArt.DOCKER).release()).isEqualTo(DOCKER);
    }

    @Test
    @DisplayName("die neueste lädt noch hoch: sie bleibt die neueste, mit Grund - nie die vorige")
    void nochNichtZuweisbar() {
        var register = List.of(light(65, "edge-light-2026.11.13", true, null),
                light(66, "edge-light-2026.11.14", true, "Programme fehlen"));
        var urteil = NeuesteFassung.of(register, BoxArt.LIGHT);
        assertThat(urteil).isEqualTo(new NeuesteFassung.Urteil(register.get(1), "Programme fehlen"));
        assertThat(urteil.zuweisbar()).isFalse();
    }

    @Test
    @DisplayName("keine signierte Fassung der Linie, unbekannte Linie: keine, mit Grund")
    void keine() {
        assertThat(NeuesteFassung.of(List.of(DOCKER, light(66, "edge-light-2026.11.14", false, null)), BoxArt.LIGHT))
                .isEqualTo(new NeuesteFassung.Urteil(null, NeuesteFassung.GRUND_KEINE_FASSUNG));
        assertThat(NeuesteFassung.of(List.of(DOCKER), null).zuweisbar()).isFalse();
    }
}
