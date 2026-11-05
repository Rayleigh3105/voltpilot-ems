package com.voltpilot.api.ota;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Der Linien-Stand je Box, rein (Geräte &amp; Updates G1): jede Box in genau einer Gruppe. */
class LinienStandTest {

    @Test
    @DisplayName("Stufe 1 überdeckt alles - auch eine abgelehnte Anfrage (Zuhause, 05.11.)")
    void stufe1UeberdecktAlles() {
        assertThat(LinienStand.of(BoxArt.LIGHT, true, RolloutStates.FEHLGESCHLAGEN, false, false))
                .isEqualTo(LinienStand.HAND);
        assertThat(LinienStand.of(BoxArt.LIGHT, true, RolloutStates.AKTUELL, true, true))
                .isEqualTo(LinienStand.HAND);
        assertThat(LinienStand.of(BoxArt.DOCKER, true, RolloutStates.AKTUELL, false, true))
                .as("Stufe 1 ist eine Edge-Light-Regel").isEqualTo(LinienStand.AKTUELL);
    }

    @Test
    @DisplayName("ein gemeldeter Fehlschlag gilt vor offline")
    void fehlerVorOffline() {
        for (String z : new String[] {RolloutStates.FEHLGESCHLAGEN, RolloutStates.ZURUECKGEROLLT,
                RolloutStates.IM_UPDATE_VERSTUMMT}) {
            assertThat(LinienStand.of(BoxArt.DOCKER, false, z, true, false)).isEqualTo(LinienStand.FEHLER);
        }
    }

    @Test
    @DisplayName("eine stumme Box ist offline - auch wenn sie zuletzt das neueste Release meldete")
    void offlineVorAktuell() {
        assertThat(LinienStand.of(BoxArt.DOCKER, false, RolloutStates.BESTAETIGT, true, true))
                .isEqualTo(LinienStand.OFFLINE);
        assertThat(LinienStand.of(BoxArt.DOCKER, false, RolloutStates.OFFLINE_HOLT_NACH, true, false))
                .isEqualTo(LinienStand.OFFLINE);
    }

    @Test
    @DisplayName("unterwegs, gehalten, aktuell, älter, unbekannt")
    void dieUebrigen() {
        for (String z : new String[] {RolloutStates.AUSSTEHEND, RolloutStates.LAEDT,
                RolloutStates.WENDET_AN, RolloutStates.SELBSTTEST}) {
            assertThat(LinienStand.of(BoxArt.DOCKER, false, z, false, false)).isEqualTo(LinienStand.LAEUFT);
        }
        assertThat(LinienStand.of(BoxArt.DOCKER, false, RolloutStates.BLOCKIERT, false, false))
                .isEqualTo(LinienStand.GEHALTEN);
        assertThat(LinienStand.of(BoxArt.DOCKER, false, RolloutStates.ZURUECKGESTELLT, false, false))
                .isEqualTo(LinienStand.GEHALTEN);
        assertThat(LinienStand.of(BoxArt.DOCKER, false, RolloutStates.AKTUELL, false, true))
                .isEqualTo(LinienStand.AKTUELL);
        assertThat(LinienStand.of(BoxArt.DOCKER, false, RolloutStates.AKTUELL, false, false))
                .isEqualTo(LinienStand.AELTER);
        assertThat(LinienStand.of(BoxArt.DOCKER, false, RolloutStates.AKTUELL, false, null))
                .as("nicht registriert ist nie älter").isEqualTo(LinienStand.UNBEKANNT);
        assertThat(LinienStand.of(null, false, RolloutStates.UNBEKANNT, false, null))
                .isEqualTo(LinienStand.UNBEKANNT);
    }

    @Test
    @DisplayName("der Balken kennt jede Gruppe genau einmal")
    void reihenfolge() {
        assertThat(LinienStand.REIHENFOLGE).doesNotHaveDuplicates().hasSize(8)
                .contains(LinienStand.HAND, LinienStand.FEHLER, LinienStand.OFFLINE, LinienStand.LAEUFT,
                        LinienStand.GEHALTEN, LinienStand.AKTUELL, LinienStand.AELTER,
                        LinienStand.UNBEKANNT);
    }
}
