package com.voltpilot.api.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.topology.TopologyService.EntityTopologyDto;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Kunden-Alarmierung P0: im Formular „Neue Überwachung“ stand „2b103e53-9902-4c52-bb79-488299a011e8 · Ladestand“ -
 * ein Gerät ohne vergebenen Namen erschien mit seiner Kennung. Jetzt mit der Geräteart, mehrere derselben Art
 * durchnummeriert.
 */
class WerteGeraeteNamenTest {

    private static EntityTopologyDto geraet(String id, String typeLabel, String label) {
        return new EntityTopologyDto(UUID.fromString(id), "battery", typeLabel, label, null, null, null, List.of());
    }

    @Test
    void einGeraetOhneNamenHeisstNachSeinerArtNieNachDerKennung() {
        EntityTopologyDto speicher = geraet("2b103e53-9902-4c52-bb79-488299a011e8", "Speicher", null);
        Map<UUID, String> namen = WerteController.geraeteNamen(List.of(speicher));
        assertThat(namen.get(speicher.id())).isEqualTo("Speicher");
    }

    @Test
    void derVergebeneNameGehtVorUndMehrereUnbenannteDerselbenArtWerdenStabilNummeriert() {
        EntityTopologyDto b = geraet("00000000-0000-0000-0000-00000000000b", "Speicher", " ");
        EntityTopologyDto a = geraet("00000000-0000-0000-0000-00000000000a", "Speicher", null);
        EntityTopologyDto benannt = geraet("00000000-0000-0000-0000-00000000000c", "Speicher", "Keller-Speicher");
        EntityTopologyDto ohneArt = geraet("00000000-0000-0000-0000-00000000000d", null, null);

        Map<UUID, String> namen = WerteController.geraeteNamen(List.of(b, benannt, a, ohneArt));

        assertThat(namen.get(a.id())).isEqualTo("Speicher 1");
        assertThat(namen.get(b.id())).isEqualTo("Speicher 2");
        assertThat(namen.get(benannt.id())).isEqualTo("Keller-Speicher");
        assertThat(namen.get(ohneArt.id())).isEqualTo("Gerät");
        assertThat(namen.values()).noneMatch(n -> n.matches(".*[0-9a-f]{8}-[0-9a-f]{4}.*"));
    }
}
