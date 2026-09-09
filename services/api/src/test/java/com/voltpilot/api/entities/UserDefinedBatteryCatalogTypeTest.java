package com.voltpilot.api.entities;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.components.ComponentDefaults;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die selbst angebundene Batterie als KATALOGTYP (P5 Ebene 1, Konzept
 * {@code vp-deye-diybms-luecke-l5} §3.2b): ein DIYBMS, ein Seplos, ein JK oder
 * ein ESP am Shunt ist kein „Batteriespeicher (Hybrid)" - und ihn aufzunehmen
 * ist Katalog-DATEN, keine Schema-Freigabe und keine Migration.
 *
 * <p>Rein: der Test lädt nur die ausgelieferte Ressource, läuft also ohne
 * Docker.
 */
class UserDefinedBatteryCatalogTypeTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private final EntityTypeCatalog catalog = new EntityTypeCatalog(MAPPER);

    @Test
    void dieStandardKanaeleSindDieZielabbildungDerEbene1() {
        EntityTypeCatalog.EntityType t = catalog.find("user-defined-battery");
        assertThat(t).as("der Typ user-defined-battery muss es geben").isNotNull();
        assertThat(t.category()).isEqualTo("storage");
        assertThat(t.composed())
                .as("sie ist ein echtes Gerät, nie aus Stammdaten komponiert").isFalse();

        // ⚠ Genau diese elf Kanäle sind die geschlossene Ziel-Abbildung aus
        // §3.2b. Wer hier einen wegnimmt, nimmt ihn dem ganzen Anschluss weg -
        // UserDefinedBatteryDefinition liest diese Liste, statt eine zweite zu
        // führen.
        assertThat(measureChannels(t)).containsExactly("soc_pct", "voltage_v", "current_a",
                "power_kw", "cell_min_mv", "cell_max_mv", "temp_max_c", "charge_allowed",
                "discharge_allowed", "charge_limit_a", "discharge_limit_a");

        // Die Einheiten reisen mit - der Ladestand ist %, eine Zellspannung mV.
        assertThat(unitOf(t, "soc_pct")).isEqualTo("%");
        assertThat(unitOf(t, "cell_min_mv")).isEqualTo("mV");
        assertThat(unitOf(t, "temp_max_c")).isEqualTo("°C");
        // Ein Wahrheitswert hat keine Einheit - eine erfundene wäre schlimmer
        // als keine (er reist als 0/1).
        assertThat(unitOf(t, "charge_allowed")).isEmpty();
    }

    /**
     * ⚠ Diese Stufe LIEST. Die BMS-Grenzen als Wächter-Eingabe (P5c) und die
     * Speiser-Bindung an den Hybrid-Speicherknoten (P6) sind eigene Pakete;
     * ein steuerbarer Typ hier hätte die Trennung nie gehabt.
     */
    @Test
    void sieIstNurLesendUndFaelltImAusfallAufMessOnly() {
        EntityTypeCatalog.EntityType t = catalog.find("user-defined-battery");
        assertThat(t.controllable()).isFalse();
        assertThat(t.defaultActuate()).isEmpty();
        assertThat(t.defaultFailsafe()).isEqualTo("measure-only");
    }

    /**
     * Der Anlege-Weg liest seine Fähigkeiten seit dem 09.09.2026 aus dem
     * Typkatalog ({@link ComponentDefaults}) - eine über den Assistenten
     * entstandene Batterie trägt also dieselben Kanäle wie eine über den
     * Batterie-Anschluss entstandene.
     */
    @Test
    void derAnlegeWegBekommtDieKanaeleAusDemKatalog() {
        String caps = ComponentDefaults.capabilities(MAPPER, catalog, "user-defined-battery",
                "speicher");
        assertThat(caps).contains("cell_min_mv").contains("soc_pct").contains("mV");
    }

    /** Additiv: kein bestehender Typ hat sich verändert. */
    @Test
    void esIstADDITIV_derHybridSpeicherBleibtUnberuehrt() {
        EntityTypeCatalog.EntityType hybrid = catalog.find("battery-hybrid");
        assertThat(measureChannels(hybrid))
                .containsExactly("soc_pct", "battery_power_kw", "pv_power_kw");
        assertThat(hybrid.composed()).isTrue();
        assertThat(catalog.find("modbus-generic")).isNotNull();
    }

    private static List<String> measureChannels(EntityTypeCatalog.EntityType t) {
        List<String> out = new ArrayList<>();
        for (JsonNode m : t.defaultMeasure()) {
            out.add(m.path("channel").asText());
        }
        return out;
    }

    private static String unitOf(EntityTypeCatalog.EntityType t, String channel) {
        for (JsonNode m : t.defaultMeasure()) {
            if (channel.equals(m.path("channel").asText())) {
                return m.path("unit").asText("");
            }
        }
        throw new AssertionError("channel " + channel + " missing");
    }
}
