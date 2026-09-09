package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityTypeCatalog;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die Anlege-Vorgaben lesen ihre Messkanäle aus dem TYPKATALOG.
 *
 * <p>Der behobene Befund (Scout {@code data/vp-deye-diybms-luecke-l5} §2.2, P1):
 * ein harter Rollen-Default schrieb für jede Rolle außer Erzeuger genau
 * {@code power_kw}. Ein über den Assistenten entstandener Wechselrichter
 * ({@code battery-hybrid}) verlor damit {@code soc_pct},
 * {@code battery_power_kw} und {@code pv_power_kw} - und ohne
 * {@code pv_power_kw} leitet der {@code TopologyDeriver} gar keinen PV-Knoten
 * ab: das Cockpit „zeigte kein PV".
 *
 * <p>Bewusst ohne Docker: geprüft wird die ABLEITUNG aus dem echten
 * {@code entitytypes/catalog.json}, nicht die Zustellung.
 */
class ComponentDefaultsTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private final EntityTypeCatalog catalog = new EntityTypeCatalog(mapper);

    @Test
    void derWechselrichterBekommtDieDreiKanaeleSeinesTypsMitIhrenEinheiten() throws Exception {
        JsonNode caps = parse(ComponentDefaults.capabilities(mapper, catalog, "battery-hybrid",
                ComponentService.ROLE_INVERTER));

        assertThat(channels(caps))
                .as("ohne pv_power_kw hat das Schaltbild keinen PV-Knoten")
                .containsExactly("soc_pct", "battery_power_kw", "pv_power_kw");
        // Der Ladestand ist ein PROZENTWERT - der alte Rollen-Default kannte nur kW.
        assertThat(unitOf(caps, "soc_pct")).isEqualTo("%");
        assertThat(unitOf(caps, "battery_power_kw")).isEqualTo("kW");
        assertThat(unitOf(caps, "pv_power_kw")).isEqualTo("kW");
    }

    @Test
    void erzeugerNetzUndVerbraucherBleibenUnveraendert() throws Exception {
        assertThat(channels(parse(ComponentDefaults.capabilities(mapper, catalog, "producer",
                ComponentService.ROLE_ERZEUGER)))).containsExactly("pv_power_kw");
        assertThat(channels(parse(ComponentDefaults.capabilities(mapper, catalog, "grid-meter",
                ComponentService.ROLE_NETZ)))).containsExactly("power_kw");
        assertThat(channels(parse(ComponentDefaults.capabilities(mapper, catalog, "generic-load",
                ComponentService.ROLE_CONSUMER)))).containsExactly("power_kw");
        assertThat(channels(parse(ComponentDefaults.capabilities(mapper, catalog, "house-load",
                ComponentService.ROLE_CONSUMER)))).containsExactly("power_kw");
    }

    /**
     * „Steuern freigeben" bleibt der getrennte Schritt: das
     * {@code default_actuate} des Katalogs wird NICHT übernommen, auch nicht für
     * einen Typ, der es trägt.
     */
    @Test
    void keinAnlegeWegBringtEineSchreibFaehigkeitMit() throws Exception {
        for (String type : List.of("battery-hybrid", "producer", "generic-load")) {
            JsonNode caps = parse(ComponentDefaults.capabilities(mapper, catalog, type,
                    ComponentService.ROLE_CONSUMER));
            assertThat(caps.has("actuate")).as(type).isFalse();
        }
    }

    /**
     * Ein Typ, den der Katalog gar nicht kennt, fällt auf den alten
     * Rollen-Default zurück: eine Komponente ganz ohne Fähigkeit wäre auf jeder
     * Fläche unsichtbar.
     */
    @Test
    void einUnbekannterTypFaelltAufDenRollenDefaultZurueck() throws Exception {
        assertThat(channels(parse(ComponentDefaults.capabilities(mapper, catalog, "gibt-es-nicht",
                ComponentService.ROLE_ERZEUGER)))).containsExactly("pv_power_kw");
        assertThat(channels(parse(ComponentDefaults.capabilities(mapper, catalog, null,
                ComponentService.ROLE_CONSUMER)))).containsExactly("power_kw");
    }

    /**
     * Kennt der Katalog den Typ und nennt er KEINEN Messkanal, bleibt die Liste
     * leer - einen zu erfinden hieße, eine Messung zu behaupten, die es nicht
     * gibt (Hausregel „Ehrlichkeit der Zahlen").
     */
    @Test
    void einTypOhneKatalogKanalBehauptetKeinen() throws Exception {
        assertThat(channels(parse(ComponentDefaults.capabilities(mapper, catalog,
                "modbus-generic", ComponentService.ROLE_CONSUMER)))).isEmpty();
    }

    private JsonNode parse(String json) throws Exception {
        return mapper.readTree(json);
    }

    private static List<String> channels(JsonNode caps) {
        List<String> out = new ArrayList<>();
        for (JsonNode m : caps.path("measure")) {
            out.add(m.path("channel").asText());
        }
        return out;
    }

    private static String unitOf(JsonNode caps, String channel) {
        for (JsonNode m : caps.path("measure")) {
            if (channel.equals(m.path("channel").asText())) {
                return m.path("unit").asText();
            }
        }
        return null;
    }
}
