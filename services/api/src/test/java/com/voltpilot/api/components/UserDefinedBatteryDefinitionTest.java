package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Broker;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Mapping;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.NormalizedMapping;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Result;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.SocDerivation;
import com.voltpilot.api.entities.EntityTypeCatalog;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Die Regeln des BMS-unabhängigen Batterie-Anschlusses, ohne Docker und ohne
 * Spring (P5 Ebene 1, Konzept {@code vp-deye-diybms-luecke-l5} §3.2b).
 *
 * <p>Die erlaubten Ziel-Kanäle kommen aus dem ECHTEN Typkatalog - nicht aus
 * einer Liste in diesem Test. Genau darum geht es: der Katalog ist die eine
 * Wahrheit, und wer ihm einen Kanal wegnimmt, sieht es hier.
 */
class UserDefinedBatteryDefinitionTest {

    private static final EntityTypeCatalog CATALOG = new EntityTypeCatalog(new ObjectMapper());

    /** Kanal → Einheit, wörtlich aus {@code entitytypes/catalog.json}. */
    private static Map<String, String> allowed() {
        EntityTypeCatalog.EntityType type =
                CATALOG.find(UserDefinedBatteryDefinition.ENTITY_TYPE);
        assertThat(type).as("der Typ user-defined-battery muss im Katalog stehen").isNotNull();
        Map<String, String> out = new LinkedHashMap<>();
        for (JsonNode m : type.defaultMeasure()) {
            out.put(m.path("channel").asText(), m.path("unit").asText(""));
        }
        return out;
    }

    private static Broker lan() {
        return new Broker("192.168.40.20", 1883);
    }

    /** Die zwei Zuordnungen des Kundenfalls: EIN Filter, zwei Aggregate. */
    private static List<Mapping> diybmsCells() {
        List<Mapping> out = new ArrayList<>();
        out.add(new Mapping("cell_min_mv", "emon/diybms/+/+", "voltage", "min", "number",
                1000.0, 0.0, null, 300, null, null));
        out.add(new Mapping("cell_max_mv", "emon/diybms/+/+", "voltage", "max", "number",
                1000.0, 0.0, null, 300, null, null));
        return out;
    }

    private static Result validate(List<Mapping> mappings) {
        return UserDefinedBatteryDefinition.validate(lan(), mappings, null, null, allowed());
    }

    // -- Der Kundenfall ------------------------------------------------------

    /**
     * ⚠ Der Grund für dieses ganze Paket: das DIYBMS des Kunden veröffentlicht
     * 11 Bänke × 16 Zellen EINZELN. Ohne ein Aggregat über einen Topic-FILTER
     * hätte der reale Fall nicht abgebildet werden können.
     */
    @Test
    void derDiybmsZellspannungsfallErgibtMinUndMax() {
        Result def = validate(diybmsCells());
        assertThat(def.errors()).isEmpty();
        assertThat(def.channels()).containsExactly("cell_min_mv", "cell_max_mv");

        NormalizedMapping min = def.mappings().get(0);
        assertThat(min.topic()).isEqualTo("emon/diybms/+/+");
        assertThat(min.path()).isEqualTo("voltage");
        assertThat(min.aggregate()).isEqualTo("min");
        assertThat(min.scale()).isEqualTo(1000.0);
        // Die Einheit kommt aus dem Katalog, nicht aus der Anfrage: der Kunde
        // ordnet einen KANAL zu, er erfindet keine Einheit.
        assertThat(min.unit()).isEqualTo("mV");
        assertThat(def.mappings().get(1).aggregate()).isEqualTo("max");
        // Ohne Angabe gilt der Vorgabe-Takt.
        assertThat(def.publishIntervalS())
                .isEqualTo(UserDefinedBatteryDefinition.DEFAULT_PUBLISH_INTERVAL_S);
    }

    // -- Geschlossenes Kanal-Vokabular --------------------------------------

    @Test
    void einZielAusserhalbDerStandardKanaeleWirdVerworfen() {
        Result def = validate(List.of(new Mapping("zellspannung_klein", "emon/#", "v", "min",
                "number", 1.0, 0.0, null, null, null, null)));
        assertThat(def.ok()).isFalse();
        // Die Ablehnung NENNT die möglichen Kanäle - sie ist ein Weg, keine Wand.
        assertThat(def.errors().get(0)).contains("cell_min_mv").contains("soc_pct");
    }

    @Test
    void einKanalHatGenauEINEQuelle() {
        List<Mapping> two = new ArrayList<>(diybmsCells());
        two.add(new Mapping("cell_min_mv", "andere/quelle", "v", "min", "number",
                1.0, 0.0, null, null, null, null));
        assertThat(validate(two).errors())
                .anyMatch(e -> e.contains("schon zugeordnet"));
    }

    @Test
    void derKatalogIstDieEineWahrheitUeberDieStandardKanaele() {
        // Alle elf Standard-Kanäle des Konzepts §3.2b sind zuordenbar - und
        // zwar genau die elf, ohne dass dieser Test eine zweite Liste führt.
        assertThat(allowed().keySet()).containsExactly("soc_pct", "voltage_v", "current_a",
                "power_kw", "cell_min_mv", "cell_max_mv", "temp_max_c", "charge_allowed",
                "discharge_allowed", "charge_limit_a", "discharge_limit_a");
    }

    // -- LAN-only ------------------------------------------------------------

    @Test
    void einBrokerAusserhalbDesHeimnetzesWirdAbgelehnt() {
        Result def = UserDefinedBatteryDefinition.validate(new Broker("mqtt.example.com", 1883),
                diybmsCells(), null, null, allowed());
        assertThat(def.errors()).contains(SelfBuildDefinition.HOST_NOT_PRIVATE);

        // ⚠ Es ist DIESELBE Regel wie im Modbus-Baukasten und auf der Box -
        // benutzt, nicht kopiert.
        assertThat(UserDefinedBatteryDefinition.validate(new Broker("10.0.0.5", null),
                diybmsCells(), null, null, allowed()).errors()).isEmpty();
        assertThat(UserDefinedBatteryDefinition.validate(new Broker("8.8.8.8", null),
                diybmsCells(), null, null, allowed()).errors())
                .contains(SelfBuildDefinition.HOST_NOT_PRIVATE);
    }

    // -- Topic-Filter und Wertepfad -----------------------------------------

    @Test
    void derTopicFilterFolgtDenMqttRegeln() {
        assertThat(UserDefinedBatteryDefinition.isValidTopicFilter("emon/diybms/+/+")).isTrue();
        assertThat(UserDefinedBatteryDefinition.isValidTopicFilter("emon/diybms/#")).isTrue();
        assertThat(UserDefinedBatteryDefinition.isValidTopicFilter("emon/pack")).isTrue();
        // „#" nur als LETZTE Ebene, „+" nur als GANZE Ebene.
        assertThat(UserDefinedBatteryDefinition.isValidTopicFilter("emon/#/x")).isFalse();
        assertThat(UserDefinedBatteryDefinition.isValidTopicFilter("emon/di+bms")).isFalse();
        assertThat(UserDefinedBatteryDefinition.isValidTopicFilter("emon/ diybms")).isFalse();
        assertThat(UserDefinedBatteryDefinition.isValidTopicFilter("")).isFalse();
    }

    @Test
    void einWertepfadGehtNieUeberProto() {
        assertThat(UserDefinedBatteryDefinition.isValidValuePath("voltage")).isTrue();
        assertThat(UserDefinedBatteryDefinition.isValidValuePath("bms.soc")).isTrue();
        // Leer heißt „die Nachricht IST der Wert" - der häufigste MQTT-Fall.
        assertThat(UserDefinedBatteryDefinition.isValidValuePath("")).isTrue();
        assertThat(UserDefinedBatteryDefinition.isValidValuePath("__proto__")).isFalse();
        assertThat(UserDefinedBatteryDefinition.isValidValuePath("a.constructor.b")).isFalse();
        assertThat(UserDefinedBatteryDefinition.isValidValuePath("a b")).isFalse();
    }

    // -- Ehrlichkeit ---------------------------------------------------------

    @Test
    void eineSkalierungVonNullWuerdeJedeMessungLoeschen() {
        assertThat(validate(List.of(new Mapping("voltage_v", "emon/pack", "v", "last", "number",
                0.0, 0.0, null, null, null, null))).errors())
                .anyMatch(e -> e.contains("ungleich 0"));
    }

    @Test
    void einJaNeinWertKenntKeineSkalierung() {
        // Sonst könnte „an" 1000 bedeuten - und 0/1 IST die Aussage.
        assertThat(validate(List.of(new Mapping("charge_allowed", "emon/status", "charge",
                "last", "bool", 1000.0, 0.0, null, null, null, null))).errors())
                .anyMatch(e -> e.contains("keine Skalierung"));
        assertThat(validate(List.of(new Mapping("charge_allowed", "emon/status", "charge",
                "last", "bool", null, null, null, null, List.of("frei"), List.of("gesperrt"))))
                .errors()).isEmpty();
    }

    /**
     * ⚠ Die SUMME von Freigaben ist keine Freigabe, und ein Mittel von 0,5
     * wäre eine Zahl, die kein Gerät je gemeldet hat - gerundet würde daraus
     * ein „ja", das niemand gegeben hat. Erlaubt sind nur das konservative
     * UND (min), das ODER (max) und die einzelne Quelle (last).
     */
    @Test
    void einJaNeinWertLaesstSichNichtMittelnOderSummieren() {
        for (String bad : List.of("avg", "sum", "count")) {
            assertThat(validate(List.of(new Mapping("charge_allowed", "emon/status", "charge",
                    bad, "bool", null, null, null, null, null, null))).errors())
                    .as(bad).anyMatch(e -> e.contains("zusammenfassen"));
        }
        for (String good : List.of("last", "min", "max")) {
            assertThat(validate(List.of(new Mapping("charge_allowed", "emon/+/status", "charge",
                    good, "bool", null, null, null, null, null, null))).errors())
                    .as(good).isEmpty();
        }
    }

    @Test
    void eineBatterieOhneZuordnungLiestNichts() {
        assertThat(validate(List.of()).errors())
                .anyMatch(e -> e.contains("mindestens ein Feld"));
    }

    @Test
    void einUnbekanntesAggregatWirdNieGeraten() {
        assertThat(validate(List.of(new Mapping("voltage_v", "emon/pack", "v", "median", "number",
                1.0, 0.0, null, null, null, null))).errors())
                .anyMatch(e -> e.contains("Zusammenfassung"));
    }

    // -- Der Andockpunkt für P5b --------------------------------------------

    @Test
    void ohneAngabeEntstehtEineAbleitungNurWennEsEinenLadestandGibt() {
        // Keine SoC-Quelle: KEINE Ableitung. Eine Batterie ohne Ladestand ist
        // ein legitimer Zustand (der Optimierer plant sie dann nicht, P7).
        assertThat(validate(diybmsCells()).socDerivation()).isNull();

        List<Mapping> withSoc = new ArrayList<>(diybmsCells());
        withSoc.add(new Mapping("soc_pct", "emon/pack", "soc", "last", "number",
                1.0, 0.0, null, null, null, null));
        SocDerivation soc = validate(withSoc).socDerivation();
        assertThat(soc).isNotNull();
        assertThat(soc.method()).isEqualTo(UserDefinedBatteryDefinition.SOC_DIRECT);
    }

    @Test
    void einUebernommenerLadestandBrauchtSeinenEingang() {
        Result def = UserDefinedBatteryDefinition.validate(lan(), diybmsCells(), null,
                new SocDerivation("direct"), allowed());
        assertThat(def.errors()).anyMatch(e -> e.contains("soc_pct"));
    }

    /**
     * ⚠ Die rechnenden Methoden aus Ebene 2 werden BENANNT abgelehnt, nicht
     * still gespeichert: eine gespeicherte Methode, die niemand ausführt, wäre
     * eine Zusage ohne Werk - und der Ladestand, den sie verspricht, stünde
     * nirgends.
     */
    @Test
    void dieKennlinieUndDieLadungszaehlungWerdenBenanntAbgelehnt() {
        assertThat(UserDefinedBatteryDefinition.validate(lan(), diybmsCells(), null,
                new SocDerivation(UserDefinedBatteryDefinition.SOC_OCV_CURVE), allowed()).errors())
                .anyMatch(e -> e.contains("Spannungskennlinie"));
        assertThat(UserDefinedBatteryDefinition.validate(lan(), diybmsCells(), null,
                new SocDerivation(UserDefinedBatteryDefinition.SOC_COULOMB), allowed()).errors())
                .anyMatch(e -> e.contains("Ladungszählung"));
    }

    // -- Schranken -----------------------------------------------------------

    @Test
    void schrankenGeltenFuerTaktUndHaltbarkeit() {
        assertThat(UserDefinedBatteryDefinition.validate(lan(), diybmsCells(), 1, null, allowed())
                .errors()).anyMatch(e -> e.contains("Sende-Abstand"));
        assertThat(validate(List.of(new Mapping("voltage_v", "emon/pack", "v", "last", "number",
                1.0, 0.0, null, 1, null, null))).errors())
                .anyMatch(e -> e.contains("Haltbarkeit"));
    }
}
