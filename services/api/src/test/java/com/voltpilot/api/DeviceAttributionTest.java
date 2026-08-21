package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.command.DeviceAttribution;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Die EINE Attributions-Regel „welche Komponenten gehören zu diesem Gerät?" -
 * rein, ohne Docker (Konzept {@code vp-geraeteseite-rev-b8} §5).
 *
 * <p>Sie ist der SERVER-Zwilling von {@code komponenten.ts plantModel} Regel
 * 1 + 2. Genau ihr Auseinanderlaufen war der belegte Befund: auf der Deye-Seite
 * stand oben „⚡ VoltPilot steuert den Speicher" und darunter „VoltPilot sendet
 * an dieses Gerät keine Befehle."
 */
class DeviceAttributionTest {

    private static final UUID BOX = UUID.fromString("00000000-0000-0000-0000-0000000000b0");
    private static final UUID FREMD = UUID.fromString("00000000-0000-0000-0000-0000000000b1");

    /** Eine Komponenten-Zeile, auf das reduziert, worauf die Regel schaut. */
    private static EntityRow row(String id, UUID deviceId, String pin) {
        return new EntityRow(UUID.fromString("00000000-0000-0000-0000-0000000000" + id), "storage",
                "Zeile " + id, null, null, null, null, null, null, deviceId, false, null, null,
                null, pin, null, null, null, 1, null);
    }

    @Test
    @DisplayName("Der primäre Wechselrichter erbt die KOMPONIERTEN Zeilen der Box")
    void derPrimaereWechselrichterErbtDasKomponierte() {
        EntityRow speicher = row("01", BOX, null);
        EntityRow netz = row("02", BOX, null);
        EntityRow fronius = row("03", BOX, "src-fronius-1");

        List<EntityRow> own = DeviceAttribution.componentsOf(
                List.of(speicher, netz, fronius), "inverter", BOX, true);

        // Der belegte Fall: der Speicher gehört dem Wechselrichter, über den er
        // gesteuert wird - sonst behauptet die Seite „nur gelesen".
        assertThat(own).containsExactly(speicher, netz);
    }

    @Test
    @DisplayName("Ein Gerät, das NICHT der primäre Wechselrichter ist, erbt nichts")
    void werNichtPrimaerIstErbtNichts() {
        EntityRow speicher = row("01", BOX, null);
        EntityRow fronius = row("03", BOX, "src-fronius-1");

        List<EntityRow> own = DeviceAttribution.componentsOf(
                List.of(speicher, fronius), "src-fronius-1", BOX, false);

        // Eine komponierte Zeile einem beliebigen Gerät zuzuschreiben wäre die
        // erfundene Zuordnung, gegen die dieses Modell gebaut ist.
        assertThat(own).containsExactly(fronius);
    }

    @Test
    @DisplayName("Der Pin gewinnt: eine gepinnte Zeile gehört NUR ihrem Gerät")
    void derPinGewinnt() {
        EntityRow fremdGepinnt = row("04", BOX, "src-zaehler");

        assertThat(DeviceAttribution.componentsOf(List.of(fremdGepinnt), "inverter", BOX, true))
                .isEmpty();
        assertThat(DeviceAttribution.componentsOf(List.of(fremdGepinnt), "src-zaehler", BOX, false))
                .containsExactly(fremdGepinnt);
    }

    @Test
    @DisplayName("Eine Zeile an einer FREMDEN Box wird nie geerbt")
    void eineFremdeZeileWirdNieGeerbt() {
        EntityRow fremd = row("05", FREMD, null);
        assertThat(DeviceAttribution.componentsOf(List.of(fremd), "inverter", BOX, true)).isEmpty();
    }

    @Test
    @DisplayName("Ohne Geräte-Bindung gehört eine Zeile keinem Gerät - sie wird nie geraten")
    void ohneGeraeteBindungWirdNichtsGeraten() {
        EntityRow ohneGeraet = row("06", null, null);
        assertThat(DeviceAttribution.componentsOf(List.of(ohneGeraet), "inverter", BOX, true))
                .isEmpty();
        assertThat(DeviceAttribution.componentsOf(List.of(ohneGeraet), "inverter", null, true))
                .isEmpty();
    }

    @Test
    @DisplayName("Gepinnt UND komponiert stehen nebeneinander, jede Zeile genau einmal")
    void gepinntUndKomponiertStehenNebeneinander() {
        EntityRow eigenerPin = row("07", BOX, "inverter");
        EntityRow komponiert = row("08", BOX, null);

        List<EntityRow> own = DeviceAttribution.componentsOf(
                List.of(eigenerPin, komponiert), "inverter", BOX, true);

        assertThat(own).containsExactly(eigenerPin, komponiert);
    }
}
