package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Broker;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Mapping;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.NormalizedMapping;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Result;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.SocAnchor;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.SocDerivation;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.SocParams;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.SocRecalibrate;
import com.voltpilot.api.entities.EntityTypeCatalog;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
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

    /**
     * Die GETEILTEN Vektoren der SoC-Ableitung - gelesen, nie abgeschrieben.
     * Dieselbe Datei fährt der JavaScript-Zwilling
     * ({@code vp-palette/test/soc_derive_spec.js}) durch die echte Rechnung.
     */
    private static final JsonNode VECTORS = readVectors();

    private static JsonNode readVectors() {
        Path p = Path.of("../../docs/contracts/v2/soc-derivation-vectors.json");
        try {
            return new ObjectMapper().readTree(Files.readString(p));
        } catch (IOException e) {
            throw new IllegalStateException("soc-derivation-vectors.json nicht lesbar: " + p, e);
        }
    }

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
        // Der zwölfte Katalog-Kanal soc_source_code ist ausdrücklich KEINE
        // Zuordnung: er entsteht in der Ebene 2 und wird nie gemessen
        // (dieHerkunftDesLadestandsLaesstSichNichtZuordnen).
        assertThat(allowed().keySet()).containsExactly("soc_pct", "voltage_v", "current_a",
                "power_kw", "cell_min_mv", "cell_max_mv", "temp_max_c", "charge_allowed",
                "discharge_allowed", "charge_limit_a", "discharge_limit_a",
                UserDefinedBatteryDefinition.SOC_SOURCE_CHANNEL);
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

    // -- Die SoC-Ableitung (P5b Ebene 2) ------------------------------------

    /** Die Kundenkurven aus den geteilten Vektoren - gelesen, nie kopiert. */
    private static List<double[]> curve(String field) {
        JsonNode node = VECTORS.path("vorlage").path(field);
        assertThat(node.isArray()).as(field + " muss in den Vektoren stehen").isTrue();
        List<double[]> out = new ArrayList<>();
        for (JsonNode p : node) {
            out.add(new double[] {p.get(0).asDouble(), p.get(1).asDouble()});
        }
        return out;
    }

    private static SocParams kennlinie() {
        return new SocParams(curve("curve_charge"), curve("curve_discharge"), 176, true, 0.1,
                null, null, null, 25.0, null, null);
    }

    private static SocDerivation derivation(String method, SocParams params) {
        return new SocDerivation(method, true, Map.of(), params, null,
                UserDefinedBatteryDefinition.DEFAULT_HOLD_S);
    }

    private static Result validateSoc(List<Mapping> mappings, SocDerivation soc) {
        return UserDefinedBatteryDefinition.validate(lan(), mappings, null, soc, allowed());
    }

    @Test
    void ohneAngabeEntstehtEineAbleitungNurWennEsEinenLadestandGibt() {
        // Keine SoC-Quelle: KEINE Ableitung. Eine Batterie ohne Ladestand ist
        // ein legitimer Zustand (der Optimierer plant sie dann nicht, P7).
        assertThat(validate(diybmsCells()).socDerivation()).isNull();

        SocDerivation soc = validate(withSoc()).socDerivation();
        assertThat(soc).isNotNull();
        assertThat(soc.method()).isEqualTo(UserDefinedBatteryDefinition.SOC_DIRECT);
        assertThat(soc.preferDirect()).isTrue();
        // Die Eingänge sind danach VOLLSTÄNDIG - niemand rät mehr an einer
        // Vorgabe herum.
        assertThat(soc.inputs()).containsEntry("soc", "soc_pct")
                .containsEntry("cell_min", "cell_min_mv").hasSize(6);
    }

    @Test
    void einUebernommenerLadestandBrauchtSeinenEingang() {
        assertThat(validateSoc(diybmsCells(), derivation("direct", null)).errors())
                .anyMatch(e -> e.contains("soc_pct"));
    }

    /**
     * ⚠ Der Kern von P5b: die Kennlinie rechnet auf ZELLSPANNUNGEN. Sie ohne
     * eine solche zu konfigurieren wäre ein Ladestand ohne Eingang - genau die
     * Erfindung, gegen die dieses ganze Paket gebaut ist.
     */
    @Test
    void dieKennlinieBrauchtEineSpannungUndIhreStuetzpunkte() {
        // Mit Zellspannungen und Kurve: gültig.
        Result ok = validateSoc(diybmsCells(), derivation("ocv_curve", kennlinie()));
        assertThat(ok.errors()).isEmpty();
        assertThat(ok.socDerivation().params().curveCharge()).hasSize(21);
        assertThat(ok.socDerivation().params().curveDischarge()).hasSize(21);
        assertThat(ok.socDerivation().params().conservativeMin()).isTrue();

        // Ohne Stützpunkte: eine Kennlinie, die nichts rechnet.
        assertThat(validateSoc(diybmsCells(), derivation("ocv_curve",
                new SocParams(null, null, null, true, 0.1, null, null, null, null, null, null)))
                .errors()).anyMatch(e -> e.contains("Ladekurve"));

        // Ohne Spannung: nur ein Temperaturfühler ergibt keinen Ladestand.
        List<Mapping> nurTemperatur = List.of(new Mapping("temp_max_c", "emon/pack", "t", "max",
                "number", 1.0, 0.0, null, null, null, null));
        assertThat(validateSoc(nurTemperatur, derivation("ocv_curve", kennlinie())).errors())
                .anyMatch(e -> e.contains("Zellspannung"));
    }

    /**
     * Die vereinfachte Variante aus §3.2b: Packspannung + Zellzahl in Reihe.
     * Sie sieht die Spreizung nicht und ist deshalb nie die erste Wahl - aber
     * sie ist ein echter Eingang, also ist sie erlaubt.
     */
    @Test
    void diePackspannungMitZellzahlIstEinGueltigerEingang() {
        List<Mapping> pack = List.of(new Mapping("voltage_v", "emon/pack", "voltage", "last",
                "number", 1.0, 0.0, null, null, null, null));
        assertThat(validateSoc(pack, derivation("ocv_curve", kennlinie())).errors()).isEmpty();

        // OHNE die Zellzahl fehlt der Umrechnungsschritt - und geraten wird er
        // nicht.
        SocParams ohneZellzahl = new SocParams(curve("curve_charge"), null, null, true, 0.1,
                null, null, null, null, null, null);
        assertThat(validateSoc(pack, derivation("ocv_curve", ohneZellzahl)).errors())
                .anyMatch(e -> e.contains("Zellzahl"));
    }

    /**
     * ⚠ Eine Kennlinie, die bei STEIGENDER Spannung fällt, beschreibt keine
     * Lithium-Zelle - sie ist ein Tippfehler, der stillschweigend einen
     * falschen Ladestand ausgerechnet hätte.
     */
    @Test
    void eineKennlinieSteigt() {
        List<String> errors = new ArrayList<>();
        assertThat(UserDefinedBatteryDefinition.checkCurve(
                List.of(new double[] {3.3, 60}, new double[] {3.9, 10}), "Ladekurve", errors))
                .isNull();
        assertThat(errors).anyMatch(e -> e.contains("Kennlinie steigt"));

        errors.clear();
        UserDefinedBatteryDefinition.checkCurve(List.of(new double[] {3.3, 0}), "Ladekurve",
                errors);
        assertThat(errors).anyMatch(e -> e.contains("Stützpunkte"));

        errors.clear();
        UserDefinedBatteryDefinition.checkCurve(
                List.of(new double[] {9.9, 0}, new double[] {10.1, 100}), "Ladekurve", errors);
        assertThat(errors).anyMatch(e -> e.contains("Zellspannung"));

        errors.clear();
        UserDefinedBatteryDefinition.checkCurve(
                List.of(new double[] {3.3, 0}, new double[] {3.3, 50}), "Ladekurve", errors);
        assertThat(errors).anyMatch(e -> e.contains("zweimal"));
    }

    /**
     * ⚠ Die Ladungszählung braucht drei Dinge, und keines davon lässt sich
     * raten: eine Leistung, eine Kapazität und einen ANKER. Eine Zählung, die
     * bei einem geratenen Startwert beginnt, ist eine Behauptung mit
     * Nachkommastellen.
     */
    @Test
    void dieLadungszaehlungBrauchtLeistungKapazitaetUndAnker() {
        List<Mapping> mitLeistung = new ArrayList<>(diybmsCells());
        mitLeistung.add(new Mapping("power_kw", "emon/pack", "power", "last", "number",
                1.0, 0.0, null, null, null, null));

        SocParams voll = new SocParams(null, null, null, true, 0.1, 40.0, 95.0, null, null,
                new SocAnchor(50.0, "2026-09-09T10:00:00Z"), null);
        assertThat(validateSoc(mitLeistung, derivation("coulomb", voll)).errors()).isEmpty();

        // Ohne Kapazität zählt niemand.
        SocParams ohneKapazitaet = new SocParams(null, null, null, true, 0.1, null, null, null,
                null, new SocAnchor(50.0, null), null);
        assertThat(validateSoc(mitLeistung, derivation("coulomb", ohneKapazitaet)).errors())
                .anyMatch(e -> e.contains("Kapazität"));

        // Ohne Anker und ohne gemessenen Ladestand: kein Startpunkt.
        SocParams ohneAnker = new SocParams(null, null, null, true, 0.1, 40.0, null, null, null,
                null, null);
        assertThat(validateSoc(mitLeistung, derivation("coulomb", ohneAnker)).errors())
                .anyMatch(e -> e.contains("Startwert"));

        // Ein zugeordneter gemessener Ladestand IST der beste Anker.
        List<Mapping> mitSoc = new ArrayList<>(mitLeistung);
        mitSoc.add(new Mapping("soc_pct", "emon/pack", "soc", "last", "number",
                1.0, 0.0, null, null, null, null));
        assertThat(validateSoc(mitSoc, derivation("coulomb", ohneAnker)).errors()).isEmpty();

        // Ohne Leistung UND ohne Strom: nichts zu zählen.
        assertThat(validateSoc(diybmsCells(), derivation("coulomb", voll)).errors())
                .anyMatch(e -> e.contains("Leistung"));
    }

    @Test
    void einHalberRekalibrierPunktIstKeiner() {
        List<Mapping> mitLeistung = new ArrayList<>(diybmsCells());
        mitLeistung.add(new Mapping("power_kw", "emon/pack", "power", "last", "number",
                1.0, 0.0, null, null, null, null));
        SocParams halb = new SocParams(null, null, null, true, 0.1, 40.0, null, null, null,
                new SocAnchor(50.0, null), new SocRecalibrate(4060.0, null, null, null));
        assertThat(validateSoc(mitLeistung, derivation("coulomb", halb)).errors())
                .anyMatch(e -> e.contains("VOLL-Endpunkt"));

        SocParams verdreht = new SocParams(null, null, null, true, 0.1, 40.0, null, null, null,
                new SocAnchor(50.0, null),
                new SocRecalibrate(3400.0, 95.0, 4060.0, 5.0));
        assertThat(validateSoc(mitLeistung, derivation("coulomb", verdreht)).errors())
                .anyMatch(e -> e.contains("LEER-Endpunkt muss unter"));
    }

    @Test
    void eineUnbekannteMethodeWirdNieGeraten() {
        assertThat(validateSoc(withSoc(), derivation("raten", null)).errors())
                .anyMatch(e -> e.contains("kennen wir nicht"));
    }

    @Test
    void einEingangZeigtNurAufEinenBatterieMesswert() {
        SocDerivation soc = new SocDerivation("direct", true, Map.of("soc", "erfunden_pct"),
                null, null, UserDefinedBatteryDefinition.DEFAULT_HOLD_S);
        assertThat(validateSoc(withSoc(), soc).errors())
                .anyMatch(e -> e.contains("kein Batterie-Messwert"));
    }

    /**
     * ⚠ Die HERKUNFT des Ladestands entsteht bei der Ableitung - kein BMS der
     * Welt veröffentlicht sie. Sie zuzuordnen hieße, eine Rechnung als Messung
     * auszugeben.
     */
    @Test
    void dieHerkunftDesLadestandsLaesstSichNichtZuordnen() {
        List<Mapping> mitHerkunft = new ArrayList<>(diybmsCells());
        mitHerkunft.add(new Mapping("soc_source_code", "emon/pack", "src", "last", "number",
                1.0, 0.0, null, null, null, null));
        assertThat(validate(mitHerkunft).errors())
                .anyMatch(e -> e.contains("nicht zuordnen"));
    }

    private static List<Mapping> withSoc() {
        List<Mapping> out = new ArrayList<>(diybmsCells());
        out.add(new Mapping("soc_pct", "emon/pack", "soc", "last", "number",
                1.0, 0.0, null, null, null, null));
        return out;
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
