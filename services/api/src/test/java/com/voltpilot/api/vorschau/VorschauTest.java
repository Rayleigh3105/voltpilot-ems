package com.voltpilot.api.vorschau;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Die REINEN Regeln der Kunden-Vorschau (Steuerung Stufe 7) - ohne Docker. */
class VorschauTest {

    private static Map<String, Object> antwort(Double basis, Double variante, Integer slots) {
        Map<String, Object> doc = new LinkedHashMap<>();
        Map<String, Object> b = new LinkedHashMap<>();
        Map<String, Object> v = new LinkedHashMap<>();
        if (basis != null) b.put("netSavingsEur", basis);
        if (variante != null) v.put("netSavingsEur", variante);
        doc.put("baseline", b);
        doc.put("variant", v);
        if (slots != null) doc.put("horizonSlots", slots);
        return doc;
    }

    @Test
    @DisplayName("Das Vorzeichen zeigt aus KUNDENSICHT: negativ heisst, es kostet")
    void vorzeichen() {
        // Der Fahrplan bringt 4,20 €; unter der Entscheidung nur noch 3,30 €.
        Vorschau.Ergebnis e = Vorschau.ausAntwort(antwort(4.20, 3.30, 96));
        assertThat(e.deltaEur()).isEqualByComparingTo("-0.90");
        assertThat(e.basisEur()).isEqualByComparingTo("4.20");
        assertThat(e.varianteEur()).isEqualByComparingTo("3.30");
        assertThat(e.horizonSlots()).isEqualTo(96);
        assertThat(e.grund()).isNull();

        // Und umgekehrt: eine Entscheidung, die BRINGT, ist positiv.
        assertThat(Vorschau.ausAntwort(antwort(3.30, 4.20, 96)).deltaEur())
                .isEqualByComparingTo("0.90");
    }

    @Test
    @DisplayName("Sie ist IMMER eine Näherung - es gibt keinen exakten Zweig")
    void immerNaeherung() {
        for (Map<String, Object> a : java.util.List.of(
                antwort(4.2, 3.3, 96), antwort(null, 3.3, 96), antwort(1.0, 1.0, 96))) {
            assertThat(Vorschau.ausAntwort(a).naeherung()).isTrue();
        }
    }

    @Test
    @DisplayName("Ohne BEIDE Läufe gibt es keine Zahl - nie eine 0")
    void ohneBeideLaeufe() {
        for (Map<String, Object> a : java.util.List.of(
                antwort(null, 3.3, 96), antwort(4.2, null, 96), antwort(null, null, 96))) {
            Vorschau.Ergebnis e = Vorschau.ausAntwort(a);
            assertThat(e.deltaEur()).isNull();
            assertThat(e.grund()).isEqualTo(Vorschau.KEINE_ZAHL);
        }
        // Auch eine leere/kaputte Antwort behauptet nichts.
        assertThat(Vorschau.ausAntwort(Map.of()).deltaEur()).isNull();
        assertThat(Vorschau.ausAntwort(null).deltaEur()).isNull();
    }

    @Test
    @DisplayName("„berechnet, macht nichts aus\" ist ein ANDERER Grund als „nicht berechenbar\"")
    void unterDerSchwelle() {
        Vorschau.Ergebnis e = Vorschau.ausAntwort(antwort(4.2000, 4.2100, 96));
        assertThat(e.deltaEur()).isNull();
        assertThat(e.grund()).isEqualTo(Vorschau.KEIN_UNTERSCHIED);
        // Die zwei Gründe dürfen sich nie decken - sonst liest sich eine
        // Auskunft wie ein Fehlen.
        assertThat(Vorschau.KEIN_UNTERSCHIED).isNotEqualTo(Vorschau.KEINE_ZAHL);
        // Knapp DARÜBER wird sie wieder genannt.
        assertThat(Vorschau.ausAntwort(antwort(4.20, 4.17, 96)).deltaEur())
                .isEqualByComparingTo("-0.03");
    }

    @Test
    @DisplayName("Die Knöpfe tragen NUR, was der Kunde wirklich gewählt hat")
    void knoepfe() {
        assertThat(Vorschau.knoepfe(null, null, null, null, null)).isEmpty();
        assertThat(Vorschau.knoepfe(false, null, null, null, null)).isEmpty();
        assertThat(Vorschau.knoepfe(true, null, null, null, null))
                .containsExactly(Map.entry("socFloorNow", true));
        assertThat(Vorschau.knoepfe(null, 8, null, null, null))
                .containsExactly(Map.entry("forcedChargeSlots", 8));
        Map<String, Object> mitFenster =
                Vorschau.knoepfe(null, null, 4, 12, new BigDecimal("11.0"));
        assertThat(mitFenster).containsOnlyKeys("consumerLoadShift");
        @SuppressWarnings("unchecked")
        Map<String, Object> fenster = (Map<String, Object>) mitFenster.get("consumerLoadShift");
        assertThat(fenster)
                .containsEntry("fromSlot", 4)
                .containsEntry("slots", 12)
                .containsEntry("kw", new BigDecimal("11.0"));
    }

    @Test
    @DisplayName("⚠ Die ADMIN-Regler stehen strukturell nicht im Rumpf")
    void keineAdminRegler() {
        // Jede Kombination der Kunden-Knöpfe - nirgends taucht ein Admin-Regler
        // auf. Das ist der Beweis, dass die Vorschau-Tür keine Einstellungs-Tür
        // ist: sie kann sie gar nicht tragen.
        Map<String, Object> alle = Vorschau.knoepfe(true, 8, 4, 12, new BigDecimal("11"));
        assertThat(alle.keySet()).containsExactlyInAnyOrder(
                "socFloorNow", "forcedChargeSlots", "consumerLoadShift");
        for (String verboten : java.util.List.of("wearCostCtPerKwh", "socMinPct", "socMaxPct",
                "backupReserveSocPct", "netzladenErlaubt")) {
            assertThat(alle).doesNotContainKey(verboten);
        }
    }
}
