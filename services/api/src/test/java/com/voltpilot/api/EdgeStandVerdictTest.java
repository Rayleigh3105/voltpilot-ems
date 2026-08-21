package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.ota.EdgeStandVerdict;
import com.voltpilot.api.repo.EdgeVersionRepository.RegisterEntry;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Das Kunden-Urteil über den Software-Stand - rein, ohne Docker (Geräteseiten
 * Stufe 1 R2a).
 *
 * <p>Die drei Ehrlichkeitsregeln der OTA-Stufe 0 gelten hier wörtlich weiter:
 * unbekannt ist nie veraltet, ein nicht registrierter Stand ist eine Lücke im
 * REGISTER, und ohne Register wird gar nichts bewertet.
 */
class EdgeStandVerdictTest {

    private static final List<RegisterEntry> REGISTER = List.of(
            new RegisterEntry("edge-2026.08.11", 42),
            new RegisterEntry("edge-2026.08.10", 41));

    @Test
    @DisplayName("Der neueste Stand ist aktuell")
    void derNeuesteStandIstAktuell() {
        var v = EdgeStandVerdict.of("edge-2026.08.11", REGISTER);
        assertThat(v.newestRelease()).isEqualTo("edge-2026.08.11");
        assertThat(v.upToDate()).isTrue();
    }

    @Test
    @DisplayName("Ein älterer Registereintrag ist veraltet - und nennt den Soll")
    void einAeltererEintragIstVeraltet() {
        var v = EdgeStandVerdict.of("edge-2026.08.10", REGISTER);
        assertThat(v.newestRelease()).isEqualTo("edge-2026.08.11");
        assertThat(v.upToDate()).isFalse();
    }

    @Test
    @DisplayName("⚠ Die Zuordnung ist die PRÄFIX-Regel: <tag>-<kurzsha> zählt")
    void diePraefixRegelGilt() {
        // Ein Tag-Lauf stempelt `<tag>-<kurzsha>`, im Register steht der nackte
        // Tag - eine strikte Gleichheit läse jedes angewandte Tag-Release als
        // „nicht registriert".
        assertThat(EdgeStandVerdict.of("edge-2026.08.11-9b37439a02c1", REGISTER).upToDate())
                .isTrue();
        assertThat(EdgeStandVerdict.of("edge-2026.08.10-aaaaaaaaaaaa", REGISTER).upToDate())
                .isFalse();
    }

    @Test
    @DisplayName("Nichts gemeldet: der Soll steht, das Urteil NICHT")
    void nichtsGemeldetIstNichtVeraltet() {
        for (String stand : new String[] {null, "", "   "}) {
            var v = EdgeStandVerdict.of(stand, REGISTER);
            assertThat(v.newestRelease()).isEqualTo("edge-2026.08.11");
            assertThat(v.upToDate()).as("unbekannt ist NIE veraltet").isNull();
        }
    }

    @Test
    @DisplayName("Ein nicht registrierter Stand ist eine Lücke im REGISTER, keine Alters-Aussage")
    void nichtRegistriertIstKeineAltersAussage() {
        // Der Normalfall einer Bestandsbox: eine nackte Commit-SHA.
        var v = EdgeStandVerdict.of("665d59b8c0de", REGISTER);
        assertThat(v.newestRelease()).isEqualTo("edge-2026.08.11");
        assertThat(v.upToDate()).isNull();
    }

    @Test
    @DisplayName("Ohne Register wird GAR NICHTS behauptet")
    void ohneRegisterKeinMassstab() {
        assertThat(EdgeStandVerdict.of("edge-2026.08.11", List.of()))
                .isEqualTo(EdgeStandVerdict.UNKNOWN);
        assertThat(EdgeStandVerdict.of("edge-2026.08.11", null))
                .isEqualTo(EdgeStandVerdict.UNKNOWN);
    }
}
