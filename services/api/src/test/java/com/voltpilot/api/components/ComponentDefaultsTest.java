package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.web.dto.ComponentTemplateDto;
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

    /**
     * Unterverteilungen (Konzept vp-unterzaehler-anzeige C1): ein Zähler auf der Verbraucher-Seite ist
     * ein {@code sub-meter} - nie „Steuerbare Last" - mit Leistung, Zählerständen und Phasen.
     */
    @Test
    void einZaehlerAufDerVerbraucherSeiteIstEinUnterzaehlerMitZaehlerkanaelen() throws Exception {
        assertThat(ComponentService.entityTypeFor(ComponentService.ROLE_CONSUMER, vorlage("meter")))
                .isEqualTo(ComponentDefaults.TYPE_SUB_METER);
        assertThat(ComponentService.entityTypeFor(ComponentService.ROLE_CONSUMER, vorlage("switch")))
                .as("ein anderer Verbraucher bleibt beim Rollen-Typ").isEqualTo("generic-load");
        assertThat(ComponentService.entityTypeFor(ComponentService.ROLE_NETZ, vorlage("meter")))
                .as("am Netzanschluss bleibt derselbe Zähler der Netz-Zähler").isEqualTo("grid-meter");

        EntityTypeCatalog.EntityType typ = catalog.find(ComponentDefaults.TYPE_SUB_METER);
        assertThat(typ.category()).isEqualTo("consumer");
        assertThat(typ.controllable()).as("ein Zähler wird nie geschaltet").isFalse();
        JsonNode caps = parse(ComponentDefaults.capabilities(mapper, catalog, ComponentDefaults.TYPE_SUB_METER,
                ComponentService.ROLE_CONSUMER));
        assertThat(channels(caps)).containsExactly("power_kw", "energy_kwh", "energy_export_kwh",
                "power_l1_kw", "power_l2_kw", "power_l3_kw");
        assertThat(unitOf(caps, "energy_kwh")).isEqualTo("kWh");
        assertThat(unitOf(caps, "power_l1_kw")).isEqualTo("kW");
    }

    @Test
    void einNetzZaehlerUeberEinenZaehlerTraegtDessenKanaeleUndVerliertSieBeimGeraetewechsel() throws Exception {
        String nurLeistung = "{\"measure\":[{\"unit\":\"kW\",\"channel\":\"power_kw\"}]}";
        String mitZaehler = ComponentDefaults.netzZaehlerAbgleich(mapper, catalog, nurLeistung, "shelly_em_http");
        assertThat(channels(parse(mitZaehler))).containsExactly("power_kw", "energy_kwh", "energy_export_kwh",
                "power_l1_kw", "power_l2_kw", "power_l3_kw");
        assertThat(ComponentDefaults.netzZaehlerAbgleich(mapper, catalog, mitZaehler, "shelly_em_http"))
                .as("schon angeglichen: nichts zu schreiben").isNull();
        assertThat(ComponentDefaults.netzZaehlerAbgleich(mapper, catalog, nurLeistung, "sunspec_tcp"))
                .as("ein anderes Gerät: power_kw bleibt allein").isNull();
        // Ein anderer Zähler am Netzanschluss: genau die Zählerkanäle gehen, ein gepflegter Kanal bleibt.
        String gepflegt = mitZaehler.replace("]}", ",{\"unit\":\"V\",\"channel\":\"voltage_l1_v\"}]}");
        assertThat(channels(parse(ComponentDefaults.netzZaehlerAbgleich(mapper, catalog, gepflegt, "sunspec_tcp"))))
                .containsExactly("power_kw", "voltage_l1_v");
        assertThat(channels(parse(ComponentDefaults.netzZaehlerAbgleich(mapper, catalog, null, "shelly_em_http"))))
                .as("eine Zeile ohne Fähigkeiten bekommt Leistung und Zählerkanäle").hasSize(6);
    }

    private static ComponentTemplateDto vorlage(String deviceType) {
        return new ComponentTemplateDto("builtin:x:y", "builtin", 1, "x", "X", "y", "Y", null, deviceType, null,
                "fam", "Fam", "comm", "Comm", null, null, null, java.math.BigDecimal.ONE, 0, "builtin", null, null,
                null, null);
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
