package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * Der Box-Weg des Ereignis-Vertrags in der Datenannahme (UEMS AP-07 IP-5) — rein, kein Docker. Der
 * Laufzeit-Prüfer {@link BoxEventsValidator} ist der Zwilling von {@code services/api
 * .../uems/EreignisVokabular.pruefeUmschlag}; beide fahren DIESELBEN Umschlag-Fälle von
 * {@code events-vocabulary-vectors.json}, und die Tabellen des Prüfers sind die {@code vokabular}-
 * Tabellen dieser Datei. Jedes gebildete {@code events.raw} besteht den Schema-Läufer.
 */
class BoxEventsValidatorTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path V2 = Path.of("../../docs/contracts/v2");
    private static final Path EXAMPLES = V2.resolve("examples");

    private final BoxEventsValidator validator = new BoxEventsValidator(MAPPER, Messzeitregel.E13);

    private static JsonNode read(Path p) throws Exception {
        return MAPPER.readTree(Files.readString(p));
    }

    private static String topic(JsonNode umschlag) {
        return "ems/" + umschlag.path("tenant_id").asText() + "/" + umschlag.path("site_id").asText()
                + "/" + umschlag.path("device_id").asText() + "/v2/events";
    }

    /** Die Eingangszeit einer pünktlichen Box: 6 s nach observed_at. */
    private static Instant puenktlich(JsonNode umschlag) {
        return Instant.parse(umschlag.path("observed_at").asText()).plusSeconds(6);
    }

    @Test
    void jederUmschlagFallDerVektorDateiWirdGenauSoBeurteilt() throws Exception {
        JsonNode mqtt = read(V2.resolve("mqtt-events-2.1.schema.json"));
        List<String> abweichungen = new ArrayList<>();
        int gesehen = 0;
        for (JsonNode c : read(V2.resolve("events-vocabulary-vectors.json")).path("cases")) {
            if (!"umschlag".equals(c.path("pruefung").asText())) {
                continue;
            }
            gesehen++;
            JsonNode u = c.path("input").path("umschlag");
            String t = c.path("input").has("topic") ? c.path("input").path("topic").asText() : topic(u);
            String urteil;
            String grund = null;
            try {
                Annahme<List<EventsRawEvent>> a = validator.annehmen(t, u.toString(), puenktlich(u));
                urteil = "angenommen";
                assertThat(a.weiter()).as(c.path("name").asText()).hasSize(u.path("events").size());
                assertThat(ContractSchemaRunner.violations(u, mqtt))
                        .as("angenommen ⇒ schema-gültig: " + c.path("name").asText()).isEmpty();
            } catch (UmschlagAbgewiesen e) {
                urteil = "verworfen";
                grund = e.grund().code();
            }
            JsonNode soll = c.path("expected");
            if (!urteil.equals(soll.path("urteil").asText())
                    || (grund != null && !grund.equals(soll.path("grund").asText()))) {
                abweichungen.add(c.path("name").asText() + ": " + urteil + " " + grund);
            }
        }
        assertThat(gesehen).as("Umschlag-Fälle").isGreaterThanOrEqualTo(12);
        assertThat(abweichungen).isEmpty();
    }

    @Test
    void dieBeispieleWerdenWieBeschriftetAngenommen() throws Exception {
        List<Path> dateien;
        try (Stream<Path> alle = Files.list(EXAMPLES)) {
            dateien = alle.filter(p -> p.getFileName().toString().startsWith("mqtt-events-2.1.")).sorted().toList();
        }
        assertThat(dateien).hasSizeGreaterThanOrEqualTo(3);
        for (Path p : dateien) {
            JsonNode u = read(p);
            boolean soll = p.getFileName().toString().contains(".valid.");
            if (soll) {
                assertThat(validator.annehmen(topic(u), Files.readString(p), puenktlich(u)).weiter())
                        .as(p.getFileName().toString()).hasSize(u.path("events").size());
            } else {
                assertThatThrownBy(() -> validator.annehmen(topic(u), Files.readString(p), puenktlich(u)))
                        .as(p.getFileName().toString()).isInstanceOf(UmschlagAbgewiesen.class);
            }
        }
    }

    /** Je Eintrag EIN events.raw, Urheber box, Umschlag-Felder gesetzt, box aus dem Topic — schema-gültig. */
    @Test
    void jederEintragWirdEinVertragsgemaessesEventsRaw() throws Exception {
        JsonNode raw = read(V2.resolve("events-raw.event.schema.json"));
        Path datei = EXAMPLES.resolve("mqtt-events-2.1.valid.restart.json");
        JsonNode u = read(datei);
        Instant eingang = Instant.parse("2027-02-01T07:01:31.482Z");
        Annahme<List<EventsRawEvent>> a = validator.annehmen(topic(u), Files.readString(datei), eingang);
        assertThat(a.ablehnungen()).isEmpty();
        assertThat(a.weiter()).hasSize(2);
        for (int i = 0; i < 2; i++) {
            JsonNode e = MAPPER.valueToTree(a.weiter().get(i));
            assertThat(ContractSchemaRunner.violations(e, raw)).as(e.toString()).isEmpty();
            assertThat(e.path("urheber").asText()).isEqualTo("box");
            assertThat(e.path("tenant_id").asText()).isEqualTo(u.path("tenant_id").asText());
            assertThat(e.path("site_id").asText()).isEqualTo(u.path("site_id").asText());
            assertThat(e.path("device_id").asText()).isEqualTo(u.path("device_id").asText());
            assertThat(e.path("source_topic").asText()).isEqualTo(topic(u));
            assertThat(e.path("sequence").asLong()).isEqualTo(212L);
            assertThat(e.path("observed_at").asText()).isEqualTo("2027-02-01T07:01:30Z");
            assertThat(e.path("ingested_at").asText()).isEqualTo("2027-02-01T07:01:31Z");
            assertThat(e.path("ereignis").path("box").asText()).isEqualTo(u.path("device_id").asText());
            assertThat(e.path("ereignis").path("ereignis_id"))
                    .isEqualTo(u.path("events").get(i).path("ereignis_id"));
            assertThat(a.weiter().get(i).kafkaKey())
                    .isEqualTo(u.path("tenant_id").asText() + ":" + u.path("site_id").asText());
        }
    }

    /** E13 gilt für observed_at wie für eine Messzeit: geht die Uhr vor, wird KEIN Ereignis angenommen. */
    @Test
    void gehtDieUhrDerBoxVorWirdKeinEreignisAngenommen() throws Exception {
        Path datei = EXAMPLES.resolve("mqtt-events-2.1.valid.restart.json");
        JsonNode u = read(datei);
        Annahme<List<EventsRawEvent>> a = validator.annehmen(topic(u), Files.readString(datei),
                Instant.parse("2027-02-01T06:47:30Z"));
        assertThat(a.weiter()).isEmpty();
        assertThat(a.ablehnungen()).containsExactly(
                new Ablehnungen.Ablehnung(Ereignisart.CLOCK_AHEAD, null, 2, 840L));
        assertThat(a.absender().strom()).isEqualTo("events");
        assertThat(a.absender().sequenz()).isEqualTo(212L);
    }

    // --------------------------------------------- die Tabellen sind die der Vektor-Datei

    @Test
    void dieTabellenDesPruefersSindDasVokabular() throws Exception {
        JsonNode v = read(V2.resolve("events-vocabulary-vectors.json")).path("vokabular");
        Set<String> arten = new HashSet<>();
        Map<String, JsonNode> mqtt = new HashMap<>();
        for (JsonNode a : v.path("arten")) {
            arten.add(a.path("art").asText());
            if (a.path("mqtt").isObject()) {
                mqtt.put(a.path("art").asText(), a.path("mqtt"));
            }
        }
        assertThat(BoxEventsValidator.ARTEN).isEqualTo(arten);
        assertThat(BoxEventsValidator.BOX_ARTEN.keySet()).isEqualTo(mqtt.keySet());
        Set<String> boxFelder = new HashSet<>();
        mqtt.forEach((art, m) -> {
            BoxEventsValidator.BoxArt b = BoxEventsValidator.BOX_ARTEN.get(art);
            assertThat(b.pflicht()).as(art).isEqualTo(texte(m.path("pflicht")));
            assertThat(b.felder()).as(art).isEqualTo(texte(m.path("felder")));
            boxFelder.addAll(b.felder());
        });
        assertThat(BoxEventsValidator.FELDER.keySet()).isEqualTo(boxFelder);
        BoxEventsValidator.FELDER.forEach((feld, typ) -> assertThat(typ.name().toLowerCase())
                .as(feld).isEqualTo(v.path("felder").path(feld).path("typ").asText()));
        assertThat(BoxEventsValidator.ERKANNT_AUS).isEqualTo(codes(v.path("erkannt_aus")));
        assertThat(codes(v.path("erkannt_aus")).stream().filter(c -> {
            for (JsonNode e : v.path("erkannt_aus")) {
                if (e.path("code").asText().equals(c)) {
                    return "box".equals(e.path("urheber").asText());
                }
            }
            return false;
        }).toList()).containsExactly(BoxEventsValidator.ERKANNT_AUS_BOX);
    }

    /** Das Grund-Wort ist geschlossen: dieselben neun Wörter in Vektor-Datei, events.raw-Schema und {@link Grund}. */
    @Test
    void dieGruendeSindDasGeschlosseneVokabular() throws Exception {
        Set<String> gruende = new HashSet<>();
        for (Grund g : Grund.values()) {
            gruende.add(g.code());
        }
        JsonNode v = read(V2.resolve("events-vocabulary-vectors.json")).path("vokabular");
        assertThat(gruende).isEqualTo(codes(v.path("grund")));
        JsonNode raw = read(V2.resolve("events-raw.event.schema.json"));
        assertThat(gruende).isEqualTo(texte(raw.path("$defs").path("grund").path("enum")));
        Set<String> arten = new HashSet<>();
        for (Ereignisart a : Ereignisart.values()) {
            arten.add(a.code());
            JsonNode def = raw.path("$defs").path("art_" + a.code());
            assertThat(def.path("properties").path("art").path("const").asText()).isEqualTo(a.code());
            if (a.sekundenFeld() != null) {
                assertThat(texte(def.path("required"))).contains(a.sekundenFeld());
            }
        }
        assertThat(texte(raw.path("$defs").path("strom").path("enum")))
                .contains(MeasurementSamplesValidator.STROM, TelemetryV2Validator.STROM, BoxEventsValidator.STROM);
    }

    private static Set<String> texte(JsonNode array) {
        Set<String> out = new HashSet<>();
        array.forEach(n -> out.add(n.asText()));
        return out;
    }

    private static Set<String> codes(JsonNode array) {
        Set<String> out = new HashSet<>();
        array.forEach(n -> out.add(n.path("code").asText()));
        return out;
    }
}
