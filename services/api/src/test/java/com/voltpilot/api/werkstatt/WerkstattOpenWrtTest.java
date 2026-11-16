package com.voltpilot.api.werkstatt;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.werkstatt.FreigabeRepository.Abbild;
import org.junit.jupiter.api.Test;

/**
 * Das OpenWrt-Abbild der Werkstatt steht fest im Code ({@link WerkstattOpenWrt}).
 * Wer es per PR hebt, ändert Fassung, Datei, Quelle und Prüfsumme zusammen - und
 * dieser Test sagt, ob die vier zueinander passen und die Form haben, die der
 * Werkstatt-Dienst und die Tabelle verlangen. Die Prüfsumme selbst kommt aus der
 * offiziellen sha256sums der Fassung; die kann nur der Mensch im PR gegenprüfen.
 */
class WerkstattOpenWrtTest {

    private final Abbild abbild = WerkstattOpenWrt.MANGO;

    @Test
    void fassungDateiUndQuellePassenZueinander() {
        String f = abbild.fassung();
        assertThat(f).matches("^[0-9]{2}\\.[0-9]{2}\\.[0-9]+$");
        assertThat(abbild.datei())
                .isEqualTo("openwrt-" + f + "-ramips-mt76x8-glinet_gl-mt300n-v2-squashfs-sysupgrade.bin");
        assertThat(abbild.quelle())
                .isEqualTo("https://downloads.openwrt.org/releases/" + f + "/targets/ramips/mt76x8/");
    }

    @Test
    void diePruefsummeHatDieFormDerTabelle() {
        assertThat(abbild.sha256()).matches("^[0-9a-f]{64}$");
    }
}
