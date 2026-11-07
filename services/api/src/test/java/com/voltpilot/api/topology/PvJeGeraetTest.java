package com.voltpilot.api.topology;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.web.dto.RollenDto;
import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Die Je-Gerät-Regel der Anlagen-PV (Schramm „Zuhause“, 07.11.2026). Fiktive Kennungen; die Zahlen sind die des
 * Abends, an dem die Zuordnung „PIKO allein maßgeblich“ die Übersicht auf 0,001 kW drückte, während die Box mit den
 * drei KACO 0,131 kW maß.
 */
class PvJeGeraetTest {

    private static final UUID PIKO = UUID.fromString("00000000-0000-0000-0000-00000000a001");
    private static final UUID KACO_1 = UUID.fromString("00000000-0000-0000-0000-00000000a002");
    private static final UUID KACO_2 = UUID.fromString("00000000-0000-0000-0000-00000000a003");

    private static RollenDto.KanonischerWert pv(Double wert, UUID... geraete) {
        List<RollenDto.GeraetBeitrag> b = java.util.Arrays.stream(geraete)
                .map(id -> new RollenDto.GeraetBeitrag(id, "Gerät", "messkanal", wert, wert != null, wert == null ? "veraltet" : null))
                .toList();
        return new RollenDto.KanonischerWert("pv", true, wert, "kW", wert == null, b, null);
    }

    private static final Map<UUID, Double> ROH = Map.of(PIKO, 0.001, KACO_1, 0.07, KACO_2, 0.06);

    @Test
    void ohneZuordnungBleibtDieZahlDerBox() {
        BigDecimal box = new BigDecimal("0.131");
        assertThat(PvJeGeraet.anlagenPv(box, null, ROH)).isSameAs(box);
        assertThat(PvJeGeraet.anlagenPv(box, new RollenDto.KanonischerWert("pv", false, null, "kW", false, List.of(), null), ROH))
                .isSameAs(box);
    }

    @Test
    void dieZuordnungAmEigenenKanalDesPikoAendertDieAnlagenzahlNicht() {
        // Vorher: die Übersicht zeigte 0,001 (nur der PIKO). Jetzt: die Box-PV mit allen drei Erzeugern.
        assertThat(PvJeGeraet.anlagenPv(new BigDecimal("0.131"), pv(0.001, PIKO), ROH)).isEqualByComparingTo("0.131");
    }

    @Test
    void einSummenwertErsetztGenauSeineGeraeteUndZaehltEinmal() {
        // Ein Summenwert über beide KACO (0,15 kW, beiden Geräten zugeordnet) ersetzt deren 0,13 kW - einmal.
        assertThat(PvJeGeraet.anlagenPv(new BigDecimal("0.131"), pv(0.15, KACO_1, KACO_2, KACO_1), ROH))
                .isEqualByComparingTo("0.151");
    }

    @Test
    void eineStummeZuordnungBleibtUnbekanntNieDieRohzahlNie0() {
        assertThat(PvJeGeraet.anlagenPv(new BigDecimal("0.131"), pv(null, PIKO), ROH)).isNull();
    }

    @Test
    void einZugeordnetesGeraetAusserhalbDesPvKnotensBleibtDieGanzeSonne() {
        // Ein Zähler als Erzeugung misst meist dieselbe PV wie die Wechselrichter: nie zur Box-Zahl addieren.
        UUID zaehler = UUID.fromString("00000000-0000-0000-0000-00000000a009");
        assertThat(PvJeGeraet.anlagenPv(new BigDecimal("0.131"), pv(0.4, zaehler), ROH)).isEqualByComparingTo("0.4");
    }

    @Test
    void einZugeordneterErzeugerOhneBekanntenRohwertLaesstDieZuordnungDieGanzeSonneBleiben() {
        // Ein Hybrid ohne eigene Reihe: seine PV IST die Box-Zahl, sein Anteil lässt sich nicht herausrechnen.
        UUID hybrid = UUID.fromString("00000000-0000-0000-0000-00000000a010");
        Map<UUID, Double> roh = new java.util.HashMap<>(ROH);
        roh.put(hybrid, null);
        assertThat(PvJeGeraet.anlagenPv(new BigDecimal("12.4"), pv(14.4, hybrid), roh)).isEqualByComparingTo("14.4");
    }

    @Test
    void ohneBoxPvTraegtDieZuordnungAllein() {
        assertThat(PvJeGeraet.anlagenPv(null, pv(0.4, PIKO), ROH)).isEqualByComparingTo("0.4");
    }

    @Test
    void verschiedeneZeitbasenErgebenNieEineNegativeSonne() {
        assertThat(PvJeGeraet.anlagenPv(new BigDecimal("0.05"), pv(0.0, KACO_1), Map.of(KACO_1, 0.2)))
                .isEqualByComparingTo("0");
    }
}
