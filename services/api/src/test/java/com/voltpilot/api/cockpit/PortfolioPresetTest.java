package com.voltpilot.api.cockpit;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die MEHRHEITS-Regel des Portfolio-Presets (Anwendungs-Programm Stufe 4) — rein,
 * ohne Docker. Sie ist der einzige Ort, an dem aus N Anlagen-Profilen eines für
 * die Kunden-Fläche wird.
 */
class PortfolioPresetTest {

    @Test
    void eineFlotteOhneGesetztesProfilHatKEINS() {
        // Der Zustand JEDER Bestandsanlage - und damit der Beweis, dass die
        // Kunden-Fläche ohne neue Datensätze auf dem VoltPilot-Standard steht.
        assertThat(PortfolioPreset.mehrheitsProfil(List.of())).isNull();
        assertThat(PortfolioPreset.mehrheitsProfil(Arrays.asList(null, null, null))).isNull();
        assertThat(PortfolioPreset.mehrheitsProfil(null)).isNull();
    }

    @Test
    void dasHaeufigsteGesetzteProfilGewinnt() {
        assertThat(PortfolioPreset.mehrheitsProfil(List.of("gewerbe", "gewerbe", "privat")))
                .isEqualTo("gewerbe");
        assertThat(PortfolioPreset.mehrheitsProfil(List.of("privat", "privat", "privat")))
                .isEqualTo("privat");
    }

    @Test
    void anlagenOHNEProfilSindKeineStimme() {
        // Eine einzige gesetzte Anlage neben zwei ungesetzten entscheidet - sie
        // ist die einzige Aussage, die jemand getroffen hat.
        assertThat(PortfolioPreset.mehrheitsProfil(Arrays.asList(null, "privat", null)))
                .isEqualTo("privat");
    }

    @Test
    void einGleichstandErgibtKEIN_Profil() {
        // Eine halb private, halb gewerbliche Flotte hat keine Mehrheit; eine
        // geratene wäre eine Behauptung über die Zielgruppe des Kunden.
        assertThat(PortfolioPreset.mehrheitsProfil(List.of("privat", "gewerbe"))).isNull();
        assertThat(PortfolioPreset.mehrheitsProfil(List.of("privat", "gewerbe", "gewerbe",
                "privat"))).isNull();
    }

    @Test
    void leerraumUndLeerstringZaehlenWieUngesetzt() {
        assertThat(PortfolioPreset.mehrheitsProfil(Arrays.asList("", "  ", "gewerbe")))
                .isEqualTo("gewerbe");
        assertThat(PortfolioPreset.mehrheitsProfil(List.of(" privat ", "privat")))
                .isEqualTo("privat");
    }
}
