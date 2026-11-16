package com.voltpilot.api.werkstatt;

import com.voltpilot.api.werkstatt.FreigabeRepository.Abbild;

/**
 * Das OpenWrt-Abbild, das die Werkstatt auf eine Mango (GL.iNet GL-MT300N-V2)
 * spielt - fest im Code (Entscheid des Captains 16.11.2026, A): Es ändert sich
 * selten, und eine neue Fassung soll durch eine Prüfung gehen, nicht durch ein
 * Formular.
 *
 * <p><b>Heben</b> geht per PR: Fassung, Datei und Quelle hier ändern, die
 * Prüfsumme aus der offiziellen {@code sha256sums} der Fassung
 * ({@code <quelle>sha256sums}) abschreiben und gegenprüfen, dann
 * {@code WerkstattOpenWrtTest}. Ab der nächsten Box gilt die neue Fassung; ein
 * laufender Lauf bleibt bei seiner.
 *
 * <p>25.12.5: Prüfsumme am 16.11.2026 aus
 * https://downloads.openwrt.org/releases/25.12.5/targets/ramips/mt76x8/sha256sums
 * gelesen und gegengeprüft.
 */
public final class WerkstattOpenWrt {

    public static final Abbild MANGO = new Abbild(
            "25.12.5",
            "openwrt-25.12.5-ramips-mt76x8-glinet_gl-mt300n-v2-squashfs-sysupgrade.bin",
            "056235c21f55288544ca459bc0a61023d084ce788ca5508d49c235dc66a7686c",
            "https://downloads.openwrt.org/releases/25.12.5/targets/ramips/mt76x8/");

    private WerkstattOpenWrt() {
    }
}
