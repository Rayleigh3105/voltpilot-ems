package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * Die Regeln des eigenen Modbus-Geräts mit Schreibwerten (K3) entscheiden wie
 * der Zwilling auf der Box: dieselben Ablehnungs-Codes, dieselben Registerwerte
 * ({@code docs/contracts/v2/modbus-geraet-vectors.json}).
 */
class ModbusGeraetDefinitionVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path VEKTOREN = Path.of("../../docs/contracts/v2/modbus-geraet-vectors.json");
    private static final Path WOERTER = Path.of("../../docs/contracts/v2/steuerlogik-woerter.json");
    private static final Pattern TEIL = Pattern.compile("^([a-z_]+)(?:\\[(\\d+)])?$");

    private static JsonNode vektoren() throws Exception {
        JsonNode v = MAPPER.readTree(VEKTOREN.toFile());
        assertThat(v.path("schema_version").asText()).isEqualTo("1.0");
        return v;
    }

    /** Ändert einen Wert entlang eines Pfads wie „controls.values[1].min“. */
    private static void setze(ObjectNode baum, String pfad, JsonNode wert) {
        String[] teile = pfad.split("\\.");
        JsonNode knoten = baum;
        for (int i = 0; i < teile.length; i++) {
            Matcher m = TEIL.matcher(teile[i]);
            assertThat(m.matches()).as(pfad).isTrue();
            boolean letzter = i == teile.length - 1;
            if (m.group(2) == null) {
                if (letzter) {
                    ((ObjectNode) knoten).set(m.group(1), wert);
                    return;
                }
                knoten = knoten.path(m.group(1));
                continue;
            }
            ArrayNode liste = (ArrayNode) knoten.path(m.group(1));
            int n = Integer.parseInt(m.group(2));
            if (letzter) {
                liste.set(n, wert);
                return;
            }
            knoten = liste.get(n);
        }
    }

    @Test
    void definitionenWieDieBox() throws Exception {
        JsonNode v = vektoren();
        int faelle = 0;
        for (JsonNode f : v.path("definitionen")) {
            ObjectNode def = v.path("geraete").path(f.path("geraet").asText()).deepCopy();
            var it = f.path("aendere").fields();
            while (it.hasNext()) {
                var e = it.next();
                setze(def, e.getKey(), e.getValue());
            }
            var ergebnis = ModbusGeraetDefinition.pruefe(def, MAPPER);
            List<String> codes = new ArrayList<>(ergebnis.fehler().stream()
                    .map(ModbusGeraetDefinition.Fehler::code).sorted().toList());
            List<String> soll = new ArrayList<>();
            f.path("fehler").forEach(x -> soll.add(x.asText()));
            soll.sort(String::compareTo);
            assertThat(codes).as(f.path("name").asText() + " " + ergebnis.fehler()).isEqualTo(soll);
            // Jeder Code hat einen deutschen Satz, keinen Code-Text.
            ergebnis.fehler().forEach(x -> assertThat(x.text()).isNotEqualTo(x.code()).endsWith("."));
            faelle++;
        }
        assertThat(faelle).isGreaterThanOrEqualTo(24);
    }

    @Test
    void registerwerteWieDieBox() throws Exception {
        JsonNode v = vektoren();
        for (JsonNode f : v.path("roh")) {
            JsonNode def = v.path("geraete").path(f.path("geraet").asText());
            JsonNode c = ModbusGeraetDefinition.control(def, f.path("slug").asText());
            assertThat(ModbusGeraetDefinition.roh(c, f.path("wert"))).as(f.toString())
                    .isEqualTo(f.path("roh").asInt());
        }
    }

    @Test
    void signaleUndBetriebsartenWieDieWortliste() throws Exception {
        JsonNode w = MAPPER.readTree(WOERTER.toFile());
        List<String> signale = new ArrayList<>();
        w.path("signal").forEach(x -> signale.add(x.asText()));
        assertThat(ModbusGeraetDefinition.SIGNALS).containsExactlyInAnyOrderElementsOf(signale);
        List<String> modes = new ArrayList<>();
        w.path("betriebsart").forEach(x -> modes.add(x.asText()));
        assertThat(ModbusGeraetDefinition.MODES).containsExactlyElementsOf(modes);
    }

    @Test
    void faehigkeitenErstNachDerFreigabe() throws Exception {
        JsonNode def = vektoren().path("geraete").path("klima");
        ObjectNode vorher = ModbusGeraetDefinition.faehigkeiten(def, false, MAPPER);
        assertThat(vorher.has("actuate")).isFalse();
        assertThat(vorher.path("measure")).hasSize(3);
        assertThat(ModbusGeraetDefinition.schutz(def, false, MAPPER).path("failsafe").path("behavior").asText())
                .isEqualTo("measure-only");

        ObjectNode caps = ModbusGeraetDefinition.faehigkeiten(def, true, MAPPER);
        assertThat(caps.toString()).isEqualTo("{\"measure\":["
                + "{\"channel\":\"raum\",\"unit\":\"°C\",\"label\":\"Raumtemperatur\"},"
                + "{\"channel\":\"stoerung\",\"unit\":\"\",\"label\":\"Störung\"},"
                + "{\"channel\":\"verdichter\",\"unit\":\"\",\"label\":\"Verdichter läuft\"}],"
                + "\"actuate\":[{\"command\":\"on_off\",\"rest\":false},"
                + "{\"command\":\"setpoint_c\",\"min\":16.0,\"max\":30.0,\"step\":0.5,\"rest\":24},"
                + "{\"command\":\"mode\",\"modes\":[\"cool\",\"heat\",\"fan_only\"],\"rest\":\"cool\"}]}");
        ObjectNode guards = ModbusGeraetDefinition.schutz(def, true, MAPPER);
        assertThat(guards.toString()).isEqualTo("{\"limits\":{\"min_change_interval_s\":120,"
                + "\"min_on_seconds\":300,\"min_off_seconds\":180},\"failsafe\":{\"behavior\":\"rest\"}}");
    }

    @Test
    void testwertWirdNichtGeklemmt() throws Exception {
        JsonNode soll = ModbusGeraetDefinition.control(vektoren().path("geraete").path("klima"), "soll");
        assertThat(ModbusGeraetDefinition.testwertFehler(soll, MAPPER.valueToTree(31))).contains("zwischen");
        assertThat(ModbusGeraetDefinition.testwertFehler(soll, MAPPER.valueToTree(21.5))).isNull();
        assertThat(ModbusGeraetDefinition.rohRuhe(soll)).isEqualTo(240);
    }
}
