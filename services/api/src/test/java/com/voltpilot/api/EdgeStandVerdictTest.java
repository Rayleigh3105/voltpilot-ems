package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.ota.BoxArt;
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
 * REGISTER, und ohne Register wird gar nichts bewertet. Dazu (Geräte &amp;
 * Updates S0): gemessen wird an der EIGENEN Linie.
 */
class EdgeStandVerdictTest {

    private static final String DOCKER = BoxArt.DOCKER;
    private static final String LIGHT = BoxArt.LIGHT;

    private static final List<RegisterEntry> REGISTER = List.of(
            new RegisterEntry("edge-2026.08.11", 42),
            new RegisterEntry("edge-2026.08.10", 41));

    /**
     * Der Stand vom 05.11.2026: das jüngste Release ist ein Edge-Light-Release,
     * das letzte Docker-Release ist älter (neueste zuerst).
     */
    private static final List<RegisterEntry> GEMISCHT = List.of(
            new RegisterEntry("edge-light-2026.11.4", 60, LIGHT),
            new RegisterEntry("edge-light-2026.11.3", 59, LIGHT),
            new RegisterEntry("edge-2026.10.7", 58, DOCKER),
            new RegisterEntry("edge-2026.10.5", 57, DOCKER));

    @Test
    @DisplayName("Der neueste Stand ist aktuell")
    void derNeuesteStandIstAktuell() {
        var v = EdgeStandVerdict.of("edge-2026.08.11", DOCKER, REGISTER);
        assertThat(v.newestRelease()).isEqualTo("edge-2026.08.11");
        assertThat(v.upToDate()).isTrue();
        assertThat(v.linie()).isEqualTo(DOCKER);
    }

    @Test
    @DisplayName("Ein älterer Registereintrag ist veraltet - und nennt den Soll")
    void einAeltererEintragIstVeraltet() {
        var v = EdgeStandVerdict.of("edge-2026.08.10", DOCKER, REGISTER);
        assertThat(v.newestRelease()).isEqualTo("edge-2026.08.11");
        assertThat(v.upToDate()).isFalse();
    }

    @Test
    @DisplayName("⚠ Die Zuordnung ist die PRÄFIX-Regel: <tag>-<kurzsha> zählt")
    void diePraefixRegelGilt() {
        // Ein Tag-Lauf stempelt `<tag>-<kurzsha>`, im Register steht der nackte
        // Tag - eine strikte Gleichheit läse jedes angewandte Tag-Release als
        // „nicht registriert".
        assertThat(EdgeStandVerdict.of("edge-2026.08.11-9b37439a02c1", DOCKER, REGISTER).upToDate())
                .isTrue();
        assertThat(EdgeStandVerdict.of("edge-2026.08.10-aaaaaaaaaaaa", DOCKER, REGISTER).upToDate())
                .isFalse();
    }

    @Test
    @DisplayName("Nichts gemeldet, Linie bekannt: der Soll steht, das Urteil NICHT")
    void nichtsGemeldetIstNichtVeraltet() {
        for (String stand : new String[] {null, "", "   "}) {
            var v = EdgeStandVerdict.of(stand, DOCKER, REGISTER);
            assertThat(v.newestRelease()).isEqualTo("edge-2026.08.11");
            assertThat(v.upToDate()).as("unbekannt ist NIE veraltet").isNull();
        }
    }

    @Test
    @DisplayName("Nichts gemeldet und Linie unbekannt: kein Maßstab")
    void nichtsGemeldetOhneLinie() {
        assertThat(EdgeStandVerdict.of(null, null, GEMISCHT)).isEqualTo(EdgeStandVerdict.UNKNOWN);
    }

    @Test
    @DisplayName("Ein nicht registrierter Stand ist eine Lücke im REGISTER, keine Alters-Aussage")
    void nichtRegistriertIstKeineAltersAussage() {
        // Der Normalfall einer Bestandsbox: eine nackte Commit-SHA.
        var v = EdgeStandVerdict.of("665d59b8c0de", DOCKER, REGISTER);
        assertThat(v.newestRelease()).isEqualTo("edge-2026.08.11");
        assertThat(v.upToDate()).isNull();
    }

    @Test
    @DisplayName("Ohne Register wird GAR NICHTS behauptet")
    void ohneRegisterKeinMassstab() {
        assertThat(EdgeStandVerdict.of("edge-2026.08.11", DOCKER, List.of()))
                .isEqualTo(EdgeStandVerdict.UNKNOWN);
        assertThat(EdgeStandVerdict.of("edge-2026.08.11", DOCKER, null))
                .isEqualTo(EdgeStandVerdict.UNKNOWN);
    }

    @Test
    @DisplayName("S0: eine Docker-Box auf dem neuesten Docker-Release ist aktuell, auch wenn Edge Light jünger ist")
    void dockerBoxWirdAnDerDockerLinieGemessen() {
        // Der Fehler vom 04.11.: „Ein neuerer Stand ist verfügbar: edge-light-2026.11.4".
        var v = EdgeStandVerdict.of("edge-2026.10.7-c39b18d9c2a4", DOCKER, GEMISCHT);
        assertThat(v.newestRelease()).isEqualTo("edge-2026.10.7");
        assertThat(v.upToDate()).isTrue();
        var alt = EdgeStandVerdict.of("edge-2026.10.5", DOCKER, GEMISCHT);
        assertThat(alt.newestRelease()).isEqualTo("edge-2026.10.7");
        assertThat(alt.upToDate()).isFalse();
    }

    @Test
    @DisplayName("S0: eine Edge-Light-Box wird nur an Edge-Light-Releases gemessen")
    void lightBoxWirdAnDerLightLinieGemessen() {
        var v = EdgeStandVerdict.of("edge-light-2026.11.3", LIGHT, GEMISCHT);
        assertThat(v.newestRelease()).isEqualTo("edge-light-2026.11.4");
        assertThat(v.upToDate()).isFalse();
        assertThat(v.linie()).isEqualTo(LIGHT);
        // Kommt später ein Docker-Release, trifft es die Edge-Light-Box nicht.
        var spaeter = new java.util.ArrayList<RegisterEntry>();
        spaeter.add(new RegisterEntry("edge-2026.11.0", 61, DOCKER));
        spaeter.addAll(GEMISCHT);
        var w = EdgeStandVerdict.of("edge-light-2026.11.4", LIGHT, spaeter);
        assertThat(w.newestRelease()).isEqualTo("edge-light-2026.11.4");
        assertThat(w.upToDate()).isTrue();
    }

    @Test
    @DisplayName("S0: eine Fassung von Hand (nicht im Register) bleibt eine Lücke, nie veraltet")
    void lightFassungVonHand() {
        // Pilot Dirolf: edge-light-g2ccd99197 steht in keinem Release.
        var v = EdgeStandVerdict.of("edge-light-g2ccd99197", LIGHT, GEMISCHT);
        assertThat(v.newestRelease()).isEqualTo("edge-light-2026.11.4");
        assertThat(v.upToDate()).isNull();
    }

    @Test
    @DisplayName("S0: hat die Linie noch kein Release, gibt es keinen Maßstab - nie das der anderen Linie")
    void linieOhneRelease() {
        var v = EdgeStandVerdict.of("edge-light-2026.10.0", LIGHT, REGISTER);
        assertThat(v.newestRelease()).isNull();
        assertThat(v.upToDate()).isNull();
        assertThat(v.linie()).isEqualTo(LIGHT);
    }

    @Test
    @DisplayName("S0: Box-Art unbekannt - die Linie kommt aus dem Release, das der Stempel trägt")
    void linieAusDemGemeldetenRelease() {
        var v = EdgeStandVerdict.of("edge-2026.10.5-aaaaaaaaaaaa", null, GEMISCHT);
        assertThat(v.linie()).isEqualTo(DOCKER);
        assertThat(v.newestRelease()).isEqualTo("edge-2026.10.7");
        assertThat(v.upToDate()).isFalse();
        // Weder Box-Art noch registrierter Stempel: keine Linie, kein Maßstab.
        assertThat(EdgeStandVerdict.of("665d59b8c0de", null, GEMISCHT))
                .isEqualTo(EdgeStandVerdict.UNKNOWN);
    }

    @Test
    @DisplayName("Ohne Manifest bestimmt der Name die Linie (edge-light-… = Edge Light)")
    void registerEintragOhneManifest() {
        assertThat(new RegisterEntry("edge-light-2026.11.4", 1).boxArt()).isEqualTo(LIGHT);
        assertThat(new RegisterEntry("edge-2026.10.7", 1).boxArt()).isEqualTo(DOCKER);
    }
}
