package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.components.SelfBuildDefinition;
import com.voltpilot.api.components.UserDefinedBatteryDefinition;
import com.voltpilot.api.templates.ComponentTemplateDefinition;
import com.voltpilot.api.uems.BestandAnschluss.Anschluss;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * Vom Transport einer Bestands-Komponente zum Weg einer Datenquelle (Vertrag
 * {@code data-source-assignment.md} §8): jede Zeile der Tabelle, die Ports des Katalogs, und was
 * NICHT übersetzt wird. Rein; läuft immer.
 */
class BestandAnschlussTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void modbusUndSunspecLesenHostPortUndGeraeteId() {
        // Ahrenberg DQ-1: der Wechselrichter K-1 über den Modbus-Treiber (Referenz: modbus_tcp).
        assertThat(BestandAnschluss.aus("modbus_tcp", "{\"ip\":\"192.168.10.21\",\"port\":502,\"unit_id\":1,"
                + "\"interval_s\":10}")).isEqualTo(new Anschluss("modbus_tcp", "192.168.10.21:502", 1, 10));
        assertThat(BestandAnschluss.aus("sunspec_tcp", "{\"ip\":\"192.168.0.31\",\"unit_id\":\"2\"}"))
                .as("ohne interval_s der Verbindung: nicht erhoben").isEqualTo(new Anschluss("sunspec_modbus",
                        "192.168.0.31:502", 2, null));
        assertThat(BestandAnschluss.aus("fronius_sunspec", "{\"ip\":\" 192.168.0.31 \",\"port\":\"1502\"}"))
                .as("ohne unit_id: die Vorgabe des Treibers").isEqualTo(new Anschluss("sunspec_modbus",
                        "192.168.0.31:1502", 1, null));
        // KACO NH3 über seinen eigenen Ethernet-Port — Modbus TCP, keine Abbildung auf etwas anderes.
        assertThat(BestandAnschluss.aus("kaco_modbus", "{\"ip\":\"192.168.0.35\",\"port\":502,\"unit_id\":1}"))
                .isEqualTo(new Anschluss("modbus_tcp", "192.168.0.35:502", 1, null));
        // Der Selbstbau trägt seinen Weg verschachtelt.
        assertThat(BestandAnschluss.aus("modbus_baukasten", "{\"schema_version\":\"1.0\",\"transport\":"
                + "{\"host\":\"192.168.20.10\",\"port\":502,\"unit_id\":3},\"channels\":[]}"))
                .isEqualTo(new Anschluss("modbus_tcp", "192.168.20.10:502", 3, null));
    }

    @Test
    void einFehlenderPortUndEineFehlendeGeraeteIdSindDieDesTreibers() {
        assertThat(BestandAnschluss.aus("kostal_modbus", "{\"ip\":\"10.0.0.5\"}"))
                .isEqualTo(new Anschluss("modbus_tcp", "10.0.0.5:1502", 71, null));
        // Eine 0 liest der Treiber der Box wie „fehlt“ — der Selbstbau nimmt sie ernst.
        assertThat(BestandAnschluss.aus("modbus_tcp", "{\"ip\":\"10.0.0.6\",\"unit_id\":0}").geraeteId())
                .isEqualTo(1);
        assertThat(BestandAnschluss.aus("modbus_baukasten", "{\"transport\":{\"host\":\"10.0.0.7\",\"unit_id\":0}}")
                .geraeteId()).isZero();
        assertThat(BestandAnschluss.aus("kaco_http", "{\"ip\":\"192.168.0.30\"}").adresse())
                .isEqualTo("http://192.168.0.30:8484");
    }

    /** Der Standard-Port der Tabelle ist die Vorgabe der Vorlage im Katalog — sonst läse die Box woanders. */
    @Test
    void dieStandardPortsSindDieDesKatalogs() throws Exception {
        Map<String, Integer> katalog = new HashMap<>();
        try (InputStream in = getClass().getResourceAsStream("/componenttemplates/builtin.json")) {
            for (JsonNode t : JSON.readTree(in).path("templates")) {
                for (JsonNode f : t.path("transport_schema")) {
                    if ("port".equals(f.path("key").asText())) {
                        katalog.putIfAbsent(t.path("communication").asText(), f.path("default").asInt());
                    }
                }
            }
        }
        BestandAnschluss.TRANSPORTE.forEach((wort, t) -> {
            if (katalog.containsKey(wort)) {
                assertThat(t.standardPort()).as(wort).isEqualTo(katalog.get(wort));
            }
        });
        assertThat(katalog).containsKeys("modbus_tcp", "kostal_modbus", "sunspec_tcp", "fronius_sunspec",
                "solarman_v5", "kaco_http", "fronius_solar_api", "goe_http_api", "shelly_http");
    }

    @Test
    void httpNimmtHttpsNurWoDerTreiberEsNimmt() {
        assertThat(BestandAnschluss.aus("goe_http_api", "{\"ip\":\"192.168.0.50\",\"port\":80}"))
                .isEqualTo(new Anschluss("http", "http://192.168.0.50:80", null, null));
        assertThat(BestandAnschluss.aus("kaco_http", "{\"ip\":\"stick.local\",\"port\":443,\"insecure_tls\":true}")
                .adresse()).isEqualTo("https://stick.local:443");
        assertThat(BestandAnschluss.aus("fronius_solar_api", "{\"ip\":\"192.168.0.40\",\"scheme\":\"https\"}")
                .adresse()).isEqualTo("https://192.168.0.40:80");
        assertThat(BestandAnschluss.aus("http_local", "{\"transport\":\"http_local\",\"endpoint\":{\"host\":"
                + "\"192.168.30.20\",\"path\":\"api/bms\",\"tls\":false},\"auth_secret\":\"x\"}").adresse())
                .isEqualTo("http://192.168.30.20:80/api/bms");
    }

    @Test
    void mqttHatEineAdresseNurMitGenauEinemThema() {
        assertThat(BestandAnschluss.aus("mqtt_local", "{\"broker\":{\"host\":\"127.0.0.1\",\"port\":1883},"
                + "\"mappings\":[{\"channel\":\"soc\",\"topic\":\"bms/1/state\"},{\"channel\":\"power\","
                + "\"topic\":\"bms/1/state\"}]}")).isEqualTo(new Anschluss("mqtt", "bms/1/state", null, null));
        assertThat(BestandAnschluss.aus("mqtt_local", "{\"mappings\":[{\"topic\":\"bms/1/soc\"},"
                + "{\"topic\":\"bms/1/power\"}]}").adresse()).as("kein gemeinsamer Filter").isNull();
    }

    /** Deye über seinen Datenlogger: Host, Port, Logger-Seriennummer, Slave-ID — wie der Treiber sie braucht. */
    @Test
    void derSolarmanDatenloggerHatSeinEigenesWort() {
        assertThat(BestandAnschluss.aus("solarman_v5", "{\"ip\":\"192.168.0.28\",\"port\":8899,\"serial\":"
                + "\"2985159064\",\"mb_slave_id\":1,\"power_scale\":10,\"interval_s\":10}"))
                .isEqualTo(new Anschluss("solarman_v5", "192.168.0.28:8899/2985159064", 1, 10));
        assertThat(BestandAnschluss.aus("solarman_v5", "{\"ip\":\"192.168.0.29\",\"serial\":\"2985159065\"}"))
                .as("Port und Slave-ID fehlen: die Vorgaben des Treibers").isEqualTo(new Anschluss("solarman_v5",
                        "192.168.0.29:8899/2985159065", 1, null));
        // Ohne Seriennummer liest der Treiber den Datenlogger nicht — also keine Adresse, nie eine halbe.
        assertThat(BestandAnschluss.aus("solarman_v5", "{\"ip\":\"192.168.0.28\",\"port\":8899}").adresse())
                .isNull();
    }

    @Test
    void einUnbekanntesWortGehtAlsSeinWortWeiter() {
        // Die Rückwand: ein Wort, das keine Vorlage und kein Treiber trägt, wird von der Regel verworfen.
        assertThat(BestandAnschluss.aus("opc_ua", "{\"ip\":\"192.168.10.40\",\"port\":4840}"))
                .isEqualTo(new Anschluss("opc_ua", null, null, null));
    }

    @Test
    void ohneTransportOderOhneLesbareFelderKeineAdresse() {
        assertThat(BestandAnschluss.aus(null, null)).isEqualTo(new Anschluss(null, null, null, null));
        assertThat(BestandAnschluss.aus(" ", "{\"interval_s\":30}")).isEqualTo(new Anschluss(null, null, null, 30));
        assertThat(BestandAnschluss.aus("modbus_tcp", "{}").adresse()).isNull();
        assertThat(BestandAnschluss.aus("modbus_tcp", "kein json").adresse()).isNull();
        assertThat(BestandAnschluss.aus("modbus_tcp", "{\"ip\":\"nicht gültig!\"}").adresse()).isNull();
        assertThat(BestandAnschluss.aus("modbus_tcp", "{\"ip\":\"10.0.0.1\",\"unit_id\":\"x\"}").geraeteId())
                .isNull();
    }

    @Test
    void ocppIstDieStationsKennung() {
        assertThat(BestandAnschluss.ocpp("AHR-LP-01")).isEqualTo(new Anschluss("ocpp", "AHR-LP-01", null, null));
        assertThat(BestandAnschluss.ocpp(" ")).isEqualTo(new Anschluss("ocpp", null, null, null));
    }

    /**
     * Die Tabelle ist VOLLSTÄNDIG (AP-06 Soll-Regel 8, Konzept vom Captain am 10.09.2026 abgenommen: JEDE vorhandene
     * Komponente wird genau einer Datenquelle zugeordnet): jedes Transport-Wort, das eine
     * Bestandsanlage tragen kann, steht darin — und nur solche. Die Quellen der Wörter: die
     * Vorlagen des Katalogs ({@code builtin.json}), die Anbindungs-Arten des Admin-Werkzeugs
     * ({@code ComponentTemplateDefinition.COMMUNICATIONS}), Selbstbau und Batterie-Anschluss, und
     * die Treiber der Box selbst ({@code edge-app/core/internal/inverter} und
     * {@code componentapply}). Kein real vorkommendes Wort fällt auf {@code protokoll_unbekannt}.
     */
    @Test
    void dieTabelleKenntJedesTransportWortDesBestands() throws Exception {
        Set<String> real = new TreeSet<>();
        try (InputStream in = getClass().getResourceAsStream("/componenttemplates/builtin.json")) {
            JSON.readTree(in).path("templates").forEach(t -> real.add(t.path("communication").asText()));
        }
        real.addAll(ComponentTemplateDefinition.COMMUNICATIONS);
        real.add(SelfBuildDefinition.COMMUNICATION);
        real.add(UserDefinedBatteryDefinition.COMMUNICATION);
        real.add(UserDefinedBatteryDefinition.COMMUNICATION_HTTP);
        Set<String> box = treiberDerBox();
        assertThat(box).as("die Treiber der Box sind gelesen").contains("solarman_v5", "modbus_baukasten");
        real.addAll(box);

        assertThat(BestandAnschluss.TRANSPORTE.keySet()).containsExactlyInAnyOrderElementsOf(real);
        for (String wort : real) {
            String protokoll = BestandAnschluss.aus(wort, "{}").protokoll();
            assertThat(DatenquelleRegeln.Protokoll.vonCode(protokoll)).as(wort + " → " + protokoll).isPresent();
        }
    }

    /** Die Transport-Wörter, die die Box kennt: ihre Treiber-Konstanten, gelesen aus dem Go-Quelltext. */
    private static Set<String> treiberDerBox() throws Exception {
        Path edge = Path.of("..", "..", "edge-app", "core", "internal");
        Set<String> woerter = new TreeSet<>();
        String inverter = Files.readString(edge.resolve("inverter").resolve("inverter.go"));
        String block = inverter.substring(inverter.indexOf("// Communication methods."));
        block = block.substring(0, block.indexOf("\n)\n"));
        Matcher m = Pattern.compile("(?m)^\\s*Comm[A-Za-z0-9]+\\s*=\\s*\"([a-z0-9_]+)\"").matcher(block);
        while (m.find()) {
            woerter.add(m.group(1));
        }
        String apply = Files.readString(edge.resolve("componentapply").resolve("componentapply.go"));
        Matcher a = Pattern.compile("(?m)^const Communication[A-Za-z]*\\s*=\\s*\"([a-z0-9_]+)\"").matcher(apply);
        while (a.find()) {
            woerter.add(a.group(1));
        }
        return woerter;
    }

    @Test
    void jedesProtokollDerTabelleStehtImVokabular() {
        BestandAnschluss.TRANSPORTE.forEach((wort, t) -> assertThat(DatenquelleRegeln.Protokoll.vonCode(t.protokoll()))
                .as(wort).isPresent());
    }
}
