package com.voltpilot.api.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/** Der Satz der Route {@code PUT …/einspeiseverguetung}: was als Angabe gilt und was nicht. */
class SiteEinspeiseverguetungSatzTest {

    @Test
    void nullSetztZurueckUndZahlenWerdenAufDreiStellenGespeichert() {
        assertThat(SiteEinspeiseverguetungController.satz(null)).isNull();
        assertThat(SiteEinspeiseverguetungController.satz(8.2)).isEqualByComparingTo("8.200");
        assertThat(SiteEinspeiseverguetungController.satz(8.2).scale()).isEqualTo(3);
        assertThat(SiteEinspeiseverguetungController.satz(12)).isEqualByComparingTo("12");
        assertThat(SiteEinspeiseverguetungController.satz(7.12345)).isEqualByComparingTo("7.123");
    }

    @Test
    void einDeutschesKommaUndRandwerteSindErlaubt() {
        assertThat(SiteEinspeiseverguetungController.satz("8,2")).isEqualByComparingTo("8.2");
        assertThat(SiteEinspeiseverguetungController.satz(" 7.94 ")).isEqualByComparingTo("7.94");
        // 0 ist eine Angabe („ich bekomme nichts“), keine fehlende.
        assertThat(SiteEinspeiseverguetungController.satz(0)).isEqualByComparingTo("0");
        assertThat(SiteEinspeiseverguetungController.satz(100)).isEqualByComparingTo("100");
    }

    @Test
    void dieAntwortZuParagraph51aIstJaOderNein() {
        assertThat(SiteEinspeiseverguetungController.abSolarspitzengesetz(true)).isTrue();
        assertThat(SiteEinspeiseverguetungController.abSolarspitzengesetz(false)).isFalse();
        for (Object falsch : new Object[] {null, "true", 1, "ja"}) {
            assertThatThrownBy(() -> SiteEinspeiseverguetungController.abSolarspitzengesetz(falsch))
                    .as(String.valueOf(falsch))
                    .isInstanceOfSatisfying(ResponseStatusException.class, e -> {
                        assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
                        assertThat(e.getReason()).contains("vor oder ab dem 25.02.2025");
                    });
        }
    }

    @Test
    void negativUeberHundertUndKeineZahlSind400MitDeutschemGrund() {
        for (Object falsch : new Object[] {-0.1, 100.001, "abc", "", "8.2.1", true}) {
            assertThatThrownBy(() -> SiteEinspeiseverguetungController.satz(falsch))
                    .as(String.valueOf(falsch))
                    .isInstanceOfSatisfying(ResponseStatusException.class, e -> {
                        assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
                        assertThat(e.getReason()).contains("ct/kWh zwischen 0 und 100");
                    });
        }
    }
}
