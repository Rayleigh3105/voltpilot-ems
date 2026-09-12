package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** Die reinen Regeln der Speicherklasse Viertelstundenwerte (UEMS AP-07 IP-12). */
class ViertelstundeRegelnTest {

    @Test
    void dasRasterSchneidetAufDieViertelstundeInUtc() {
        assertThat(ViertelstundeRegeln.beginn(Instant.parse("2026-11-18T10:39:17Z")))
                .isEqualTo(Instant.parse("2026-11-18T10:30:00Z"));
        assertThat(ViertelstundeRegeln.beginn(Instant.parse("2026-11-18T10:45:00Z")))
                .isEqualTo(Instant.parse("2026-11-18T10:45:00Z"));
        // Auch vor der Epoche (floorDiv, nicht Division mit Abschneiden Richtung null).
        assertThat(ViertelstundeRegeln.beginn(Instant.parse("1969-12-31T23:52:00Z")))
                .isEqualTo(Instant.parse("1969-12-31T23:45:00Z"));
    }

    /** E5, wörtlich: 7 Tage nach dem INTERVALLENDE — nicht nach dem Beginn. */
    @Test
    void endgueltigIstSiebenTageNachDemIntervallende() {
        assertThat(ViertelstundeRegeln.endgueltigAb(Instant.parse("2026-11-18T10:30:00Z")))
                .isEqualTo(Instant.parse("2026-11-25T10:45:00Z"));
    }

    @Test
    void dieBrueckeZuDenRegelwoertenVonAp08() {
        assertThat(ViertelstundeRegeln.regelWort("counter")).isEqualTo("zaehlerstand");
        assertThat(ViertelstundeRegeln.regelWort("gauge")).isEqualTo("momentanwert");
        // Zustands-, Bitfeld- und Textreihen haben keine Regel — und bekommen keine geraten.
        assertThat(ViertelstundeRegeln.regelWort("state")).isNull();
        assertThat(ViertelstundeRegeln.regelWort("bitfield")).isNull();
        assertThat(ViertelstundeRegeln.regelWort("text")).isNull();
        assertThat(ViertelstundeRegeln.regelWort(null)).isNull();
        assertThat(ViertelstundeRegeln.rechenbar("counter")).isTrue();
        assertThat(ViertelstundeRegeln.rechenbar("state")).isFalse();
    }

    @Test
    void ankerNennenErstenZweitenUndZaehlenDenRest() {
        UUID a = UUID.randomUUID();
        UUID b = UUID.randomUUID();
        UUID c = UUID.randomUUID();
        assertThat(ViertelstundeRegeln.anker(List.<UUID>of())).isEqualTo(ViertelstundeRegeln.Anker.keiner());
        assertThat(ViertelstundeRegeln.anker(List.of(a, a, a)))
                .isEqualTo(new ViertelstundeRegeln.Anker<>(a, null, 0));
        assertThat(ViertelstundeRegeln.anker(List.of(a, a, b, b)))
                .isEqualTo(new ViertelstundeRegeln.Anker<>(a, b, 0));
        // Ein dritter Anker wird GEZÄHLT, nicht verschwiegen.
        assertThat(ViertelstundeRegeln.anker(List.of(a, b, c)))
                .isEqualTo(new ViertelstundeRegeln.Anker<>(a, b, 1));
        // Ein Wert ohne Anker ist kein Wechsel.
        assertThat(ViertelstundeRegeln.anker(Arrays.asList(null, a, null, b)))
                .isEqualTo(new ViertelstundeRegeln.Anker<>(a, b, 0));
    }

    @Test
    void dieZustellartIstGemischtSobaldBeidesVorkommt() {
        assertThat(ViertelstundeRegeln.zustellart(List.of("direkt", "direkt"))).isEqualTo("direkt");
        assertThat(ViertelstundeRegeln.zustellart(List.of("nachgeliefert"))).isEqualTo("nachgeliefert");
        assertThat(ViertelstundeRegeln.zustellart(List.of("direkt", "nachgeliefert"))).isEqualTo("gemischt");
        // Kein Wert trägt eine Zustellart: `null` heißt „nicht nachgeschlagen", nie „direkt".
        assertThat(ViertelstundeRegeln.zustellart(List.of())).isNull();
    }

    // ------------------------------------------------------------------ AP-08 IP-2

    /**
     * Die Kennzeichen reisen als ARRAY — Wortlaut UND Reihenfolge sind Vertrag. Sie werden
     * durchgereicht, nicht umformuliert; Anführungszeichen und Gedankenstriche überleben.
     */
    @Test
    void dieKennzeichenBehaltenWortlautUndReihenfolge() {
        assertThat(ViertelstundeRegeln.kennzeichenJson(List.of())).isEqualTo("[]");
        assertThat(ViertelstundeRegeln.kennzeichenJson(null)).isEqualTo("[]");
        assertThat(ViertelstundeRegeln.kennzeichenJson(List.of(
                "Anfang nicht gemessen (kein Stand an der Periodengrenze)",
                "Rücksetzung 09:12 ohne Endstand — bis zu 1 Kadenz nicht gezählt")))
                .isEqualTo("[\"Anfang nicht gemessen (kein Stand an der Periodengrenze)\","
                        + "\"Rücksetzung 09:12 ohne Endstand — bis zu 1 Kadenz nicht gezählt\"]");
        assertThat(ViertelstundeRegeln.kennzeichenJson(List.of("Wert \"roh\" \\ ab\nzu")))
                .isEqualTo("[\"Wert \\\"roh\\\" \\\\ ab\\nzu\"]");
    }

    /**
     * Z8 — der Faktor der Fassung wirkt beim ERFASSEN, nicht in der Cloud
     * ({@code quelle-einstellung.md} §3). Eine Verdopplung wäre der Fehler; darum steht die 1
     * benannt an EINER Stelle.
     */
    @Test
    void derFaktorDerFassungIstEinsUndStehtAnEinerStelle() {
        assertThat(ViertelstundeRegeln.FAKTOR_DER_FASSUNG)
                .isEqualByComparingTo(java.math.BigDecimal.ONE);
    }
}
