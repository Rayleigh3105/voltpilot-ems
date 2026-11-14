package com.voltpilot.api.steuerlogik;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.stream.Stream;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * Der Leser des Herzschlag-Blocks {@code logik} entscheidet jeden Vektor wie der Vertrag
 * ({@code docs/contracts/v2/steuerlogik-rueckmeldung-vectors.json}); der erste Fall ist der Block, den die Box im
 * Beispiel der Wärmepumpe tatsächlich schreibt (gepinnt von {@code logiklauf_test.go}).
 */
class SteuerlogikRueckmeldungVectorsTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path VEKTOREN = Path.of("../../docs/contracts/v2/steuerlogik-rueckmeldung-vectors.json");

    static Stream<Arguments> faelle() throws Exception {
        List<Arguments> out = new ArrayList<>();
        for (JsonNode fall : JSON.readTree(Files.readString(VEKTOREN)).path("faelle")) {
            out.add(Arguments.of(fall.path("name").asText(), fall));
        }
        assertThat(out).hasSizeGreaterThan(5);
        return out.stream();
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("faelle")
    void wieDerVertrag(String name, JsonNode fall) throws Exception {
        UUID box = UUID.randomUUID();
        SteuerlogikRueckmeldung.Gelesen g = SteuerlogikRueckmeldung.lies(fall.path("block"), box, JSON);
        assertThat(g.laeufe()).as("Läufe").hasSize(fall.path("laeufe").asInt());
        assertThat(g.wechsel()).as("Protokollzeilen").hasSize(fall.path("wechsel").asInt());
        if (fall.has("geraete")) {
            JsonNode sauber = JSON.readTree(g.laeufe().get(0).rueckmeldungJson());
            List<String> geraete = new ArrayList<>();
            sauber.path("geraete").fieldNames().forEachRemaining(geraete::add);
            List<String> soll = new ArrayList<>();
            fall.path("geraete").forEach(n -> soll.add(n.asText()));
            assertThat(geraete).as("Geräte").containsExactlyElementsOf(soll);
            assertThat(sauber.has("wechsel")).as("das Protokoll geht in die eigene Tabelle").isFalse();
        }
        if (fall.has("unbekannt")) {
            JsonNode sauber = JSON.readTree(g.laeufe().get(0).rueckmeldungJson());
            List<String> unbekannt = new ArrayList<>();
            sauber.path("unbekannt").forEach(n -> unbekannt.add(n.asText()));
            List<String> soll = new ArrayList<>();
            fall.path("unbekannt").forEach(n -> soll.add(n.asText()));
            assertThat(unbekannt).as("unbekannte Eingänge").containsExactlyElementsOf(soll);
        }
        if (fall.has("zustand")) {
            JsonNode sauber = JSON.readTree(g.laeufe().get(0).rueckmeldungJson());
            assertThat(sauber.path("zustand").asText()).as("Zustand").isEqualTo(fall.path("zustand").asText());
            assertThat(g.laeufe().get(0).zustand()).isEqualTo(fall.path("zustand").asText());
            if (fall.has("halt")) {
                if (fall.path("halt").isNull()) {
                    assertThat(sauber.has("halt")).as("ein Halt ohne gültigen Code fällt weg").isFalse();
                } else {
                    assertThat(sauber.path("halt").path("code").asText()).isEqualTo(fall.path("halt").asText());
                }
            }
            JsonNode geraet = sauber.path("geraete").elements().next();
            fall.path("geraet_felder").forEach(f -> assertThat(geraet.has(f.asText())).as("Gerät hat " + f).isTrue());
            fall.path("ohne_geraet_felder").forEach(f -> assertThat(geraet.has(f.asText())).as("Gerät ohne " + f)
                    .isFalse());
            assertThat(sauber.path("stellwerte").path("werte")).as("Stellwerte").hasSize(fall.path("stellwerte").asInt());
            assertThat(sauber.path("warum")).as("Warum-Gruppen").hasSize(fall.path("warum").asInt());
            assertThat(sauber.path("meldungen")).as("Meldungen").hasSize(fall.path("meldungen").asInt());
        }
        for (var w : g.wechsel()) {
            assertThat(w.deviceId()).isEqualTo(box);
            assertThat(w.laufSeit()).as("der Lauf ist der Schlüssel des Protokolls").isNotNull();
        }
    }
}
