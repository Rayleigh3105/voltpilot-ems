package com.voltpilot.api.suggestions;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Die REINEN Regeln des Vorschlags-Gedächtnisses (Steuerung Stufe 6) - ohne
 * Docker, ohne Spring, ohne Uhr.
 */
class VorschlaegeTest {

    private static final Instant NOW = Instant.parse("2026-08-25T10:00:00Z");

    @Test
    @DisplayName("„Später\" vertagt kurz, „Ablehnen\" sieben Tage")
    void fristen() {
        assertThat(Vorschlaege.stummBis(Vorschlaege.SPAETER, NOW))
                .isEqualTo(NOW.plus(Duration.ofDays(1)));
        assertThat(Vorschlaege.stummBis(Vorschlaege.ABGELEHNT, NOW))
                .isEqualTo(NOW.plus(Duration.ofDays(7)));
    }

    @Test
    @DisplayName("Die Frist gehört dem Server - ein unbekanntes Wort bekommt gar keine")
    void unbekanntesWort() {
        assertThat(Vorschlaege.bekannt("spaeter")).isTrue();
        assertThat(Vorschlaege.bekannt("abgelehnt")).isTrue();
        assertThat(Vorschlaege.bekannt("nie_wieder")).isFalse();
        assertThat(Vorschlaege.bekannt(null)).isFalse();
        assertThatThrownBy(() -> Vorschlaege.stummBis("nie_wieder", NOW))
                .isInstanceOf(Vorschlaege.Abgelehnt.class)
                .hasMessageContaining("Unbekannte Auswahl");
    }

    @Test
    @DisplayName("Ein Schlüssel wird geprüft, nie zurechtgebogen")
    void schluesselForm() {
        assertThat(Vorschlaege.pruefeSchluessel("ueberschuss:9f3c-4a"))
                .isEqualTo("ueberschuss:9f3c-4a");
        // Führende/abschliessende Leerzeichen sind Tipp-Rauschen, kein Inhalt.
        assertThat(Vorschlaege.pruefeSchluessel("  preis:abc  ")).isEqualTo("preis:abc");
        // Alles Übrige wird ABGELEHNT: ein still verändertes Wort träfe beim
        // nächsten Lesen einen anderen Vorschlag als den weggeklickten.
        for (String krumm : new String[] {"", "  ", "Überschuss:1", "preis abc", "a/b",
                "-fuehrend", "x".repeat(129)}) {
            assertThatThrownBy(() -> Vorschlaege.pruefeSchluessel(krumm))
                    .as("Schlüssel „%s\"", krumm)
                    .isInstanceOf(Vorschlaege.Abgelehnt.class);
        }
        assertThatThrownBy(() -> Vorschlaege.pruefeSchluessel(null))
                .isInstanceOf(Vorschlaege.Abgelehnt.class);
    }

    @Test
    @DisplayName("Eine abgelaufene Haltung ist KEINE Aussage mehr")
    void abgelaufen() {
        assertThat(Vorschlaege.gilt(NOW.plusSeconds(1), NOW)).isTrue();
        assertThat(Vorschlaege.gilt(NOW, NOW)).isFalse();
        assertThat(Vorschlaege.gilt(NOW.minusSeconds(1), NOW)).isFalse();
        assertThat(Vorschlaege.gilt(null, NOW)).isFalse();
    }
}
