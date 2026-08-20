package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Die NAMENS-REGEL, rein geprüft: ein vom Menschen vergebener Name wird nie von
 * einem abgeleiteten überschrieben (Live-Fall Herzogau, 20.08.2026).
 */
class ComponentLabelsTest {

    @Test
    @DisplayName("Der GETIPPTE Name gewinnt immer")
    void theTypedNameAlwaysWins() {
        assertThat(ComponentLabels.toWrite("Dach Süd", "Dach Süd-West", "Fronius Eco 27.0-3-S"))
                .isEqualTo("Dach Süd-West");
        assertThat(ComponentLabels.toWrite(null, "  Dach Süd  ", "Fronius Eco 27.0-3-S"))
                .as("und er wird getrimmt").isEqualTo("Dach Süd");
    }

    @Test
    @DisplayName("Ein ABGELEITETER Name FÜLLT nur - er ersetzt nie")
    void aDerivedNameOnlyFillsAndNeverReplaces() {
        assertThat(ComponentLabels.toWrite("Fronius Anlage WR1", null, "Fronius 1"))
                .as("der Kundenname bleibt - null heißt: nichts ändern").isNull();
        assertThat(ComponentLabels.toWrite("Fronius Anlage WR1", "  ", "Fronius 1"))
                .as("ein leer gelassenes Feld ist keine Eingabe").isNull();
        assertThat(ComponentLabels.toWrite(null, null, "Fronius 1"))
                .as("eine namenlose Zeile darf er füllen").isEqualTo("Fronius 1");
        assertThat(ComponentLabels.toWrite("   ", null, "Fronius 1"))
                .as("ein leerer gespeicherter Name ist keiner").isEqualTo("Fronius 1");
    }

    @Test
    @DisplayName("Ohne jede Quelle wird kein Name erfunden")
    void noNameIsInventedWithoutASource() {
        assertThat(ComponentLabels.toWrite(null, null, null)).isNull();
        assertThat(ComponentLabels.toWrite(null, "", "  ")).isNull();
    }
}
