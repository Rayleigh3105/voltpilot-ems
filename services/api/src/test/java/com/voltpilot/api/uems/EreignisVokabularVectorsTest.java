package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.EreignisVokabular.Art;
import com.voltpilot.api.uems.EreignisVokabular.Grund;
import com.voltpilot.api.uems.EreignisVokabular.Urheber;
import com.voltpilot.api.uems.EreignisVokabular.Urteil;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der EREIGNIS-VERTRAG (UEMS AP-07 IP-3, Entscheid E11): die EINE Vektor-Datei
 * {@code docs/contracts/v2/events-vocabulary-vectors.json} hält ihr Schema, ihr Vokabular ist
 * das von {@link EreignisVokabular}, beide Draht-Schemas ({@code mqtt-events-2.1.schema.json},
 * {@code events-raw.event.schema.json}) sind aus GENAU diesem Vokabular gebaut, und jeder Fall
 * bekommt dasselbe Schema-Urteil und dasselbe Prüf-Urteil, das dort steht.
 *
 * <p>Konsistenz über die Paketgrenze: jede Ereignisart und jeder Ablehnungsgrund, den der
 * Herkunftsvertrag ({@code messwert-herkunft-vectors.json}) benutzt, steht im Vokabular — mit
 * denselben Feldnamen —, die Fehlerklassen sind die von {@code data-source-vectors.json}, und
 * die Arten, die der Writer HEUTE in {@code device_measurement_event} schreibt, heißen gleich.
 * Kein Wort steht zweimal in anderer Schreibweise.
 *
 * <p>Die Fälle spielen im Referenzunternehmen Ahrenberg: jede Box, Datenquelle, Komponente,
 * Messstelle und jeder Einbau wird gegen {@code uems-referenzunternehmen.json} geprüft, samt
 * Betrieb, Zuständigkeit und führender Quelle zum Zeitpunkt. Den Kundensatz prüft der
 * TS-Zwilling ({@code frontend/portal/src/uemsEreignis.test.ts}).
 *
 * <p>Rein; läuft immer (kein Docker, keine DB, keine Uhr).
 */
class EreignisVokabularVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
    private static final Path REPO = Path.of("..", "..");
    private static final Path V2 = REPO.resolve("docs/contracts/v2");
    private static final Path VECTORS = V2.resolve("events-vocabulary-vectors.json");
    private static final Path SCHEMA = V2.resolve("events-vocabulary.schema.json");
    private static final Path MQTT = V2.resolve("mqtt-events-2.1.schema.json");
    private static final Path RAW = V2.resolve("events-raw.event.schema.json");
    private static final Path REFERENZ = V2.resolve("uems-referenzunternehmen.json");
    private static final Path HERKUNFT = V2.resolve("messwert-herkunft-vectors.json");
    private static final Path DATENQUELLE = V2.resolve("data-source-vectors.json");
    private static final Path BEISPIELE = V2.resolve("examples");

    private static JsonNode lies(Path p) throws Exception {
        return MAPPER.readTree(Files.readString(p));
    }

    private static List<String> texte(JsonNode liste) {
        List<String> out = new ArrayList<>();
        liste.forEach(n -> out.add(n.isObject() ? n.path("code").asText() : n.asText()));
        return out;
    }

    // ---------------------------------------------------------------- Form

    @Test
    void dieDateiHaeltIhrSchema() throws Exception {
        assertThat(UemsSchemaLaeufer.verstoesse(lies(VECTORS), lies(SCHEMA)))
                .as("Schema-Verstöße")
                .isEmpty();
    }

    @Test
    void dieBeispielweltIstDasReferenzunternehmen() throws Exception {
        JsonNode v = lies(VECTORS);
        assertThat(v.path("referenzunternehmen").asText()).isEqualTo("./uems-referenzunternehmen.json");
        JsonNode ref = lies(REFERENZ);
        JsonNode k = v.path("kennungen");
        assertThat(feldnamen(k.path("kundenbereich")))
                .containsExactly(ref.path("unternehmen").path("kundenbereich").asText());
        assertThat(feldnamen(k.path("boxen"))).containsExactlyInAnyOrderElementsOf(
                kennzeichen(ref.path("boxen")));
        assertThat(feldnamen(k.path("anlagen"))).containsExactlyInAnyOrderElementsOf(
                kennzeichen(ref.path("anlagen")));
        Set<String> uuids = new HashSet<>();
        Stream.of("kundenbereich", "anlagen", "boxen")
                .forEach(t -> k.path(t).forEach(u -> assertThat(uuids.add(u.asText())).isTrue()));
    }

    @Test
    void jederFallNameIstEindeutigUndJedeErfindungNenntIhreAnnahme() throws Exception {
        List<String> namen = new ArrayList<>();
        for (JsonNode c : lies(VECTORS).path("cases")) {
            namen.add(c.path("name").asText());
            if (c.has("erfunden")) {
                assertThat(c.path("annahme").isTextual()).as(c.path("name").asText()).isTrue();
            }
            boolean angenommen = "angenommen".equals(c.path("expected").path("urteil").asText());
            assertThat(c.path("expected").path("grund").isNull()).as(c.path("name").asText())
                    .isEqualTo(angenommen);
            int ereignisse = "umschlag".equals(c.path("pruefung").asText())
                    ? c.path("input").path("umschlag").path("events").size() : 1;
            assertThat(c.path("expected").path("saetze").size()).as(c.path("name").asText())
                    .isEqualTo(angenommen ? ereignisse : 0);
        }
        assertThat(namen).doesNotHaveDuplicates();
    }

    // -------------------------------------------------- Vokabular ⟷ Klasse

    @Test
    void dasVokabularStimmtMitDerPruefung() throws Exception {
        JsonNode w = lies(VECTORS).path("vokabular");
        assertThat(texte(w.path("urheber")))
                .containsExactlyElementsOf(Stream.of(Urheber.values()).map(Urheber::code).toList());
        assertThat(texte(w.path("grund")))
                .containsExactlyElementsOf(Stream.of(Grund.values()).map(Grund::code).toList());
        assertThat(texte(w.path("strom"))).containsExactlyElementsOf(EreignisVokabular.STROM);
        assertThat(texte(w.path("anlass_geraetegrenze")))
                .containsExactlyElementsOf(EreignisVokabular.ANLASS_GERAETEGRENZE);
        assertThat(texte(w.path("anlass_uebergabe")))
                .containsExactlyElementsOf(EreignisVokabular.ANLASS_UEBERGABE);
        assertThat(texte(w.path("qualitaet"))).containsExactlyElementsOf(EreignisVokabular.QUALITAET);
        Map<String, String> erkannt = new LinkedHashMap<>();
        w.path("erkannt_aus").forEach(e -> erkannt.put(e.path("code").asText(), e.path("urheber").asText()));
        Map<String, String> javaErkannt = new LinkedHashMap<>();
        EreignisVokabular.ERKANNT_AUS.forEach((k, u) -> javaErkannt.put(k, u.code()));
        assertThat(erkannt).containsExactlyEntriesOf(javaErkannt);
        w.path("grund").forEach(g -> assertThat(g.path("von").asText())
                .as(g.path("code").asText())
                .isEqualTo(Grund.HERKUNFT_UNVOLLSTAENDIG.code().equals(g.path("code").asText())
                        ? "writer" : "datenannahme"));

        Map<String, String> felder = new LinkedHashMap<>();
        w.path("felder").fields().forEachRemaining(f ->
                felder.put(f.getKey(), f.getValue().path("typ").asText()));
        Map<String, String> javaFelder = new LinkedHashMap<>();
        EreignisVokabular.FELDER.forEach((k, t) -> javaFelder.put(k, t.name().toLowerCase(Locale.ROOT)));
        assertThat(felder).containsExactlyEntriesOf(javaFelder);

        List<String> codes = new ArrayList<>();
        for (JsonNode a : w.path("arten")) {
            String code = a.path("art").asText();
            codes.add(code);
            Art art = Art.vonCode(code);
            assertThat(art).as(code).isNotNull();
            assertThat(new LinkedHashSet<>(texte(a.path("urheber")))).as(code + " urheber")
                    .isEqualTo(new LinkedHashSet<>(art.urheber().stream().map(Urheber::code).toList()));
            JsonNode z = a.path("zeit");
            assertThat(z.path("form").asText()).as(code).isEqualTo(art.zeitform().name().toLowerCase(Locale.ROOT));
            assertThat(z.path("grenzen").isNull() ? null : z.path("grenzen").asText()).as(code)
                    .isEqualTo(art.grenzen() == null ? null : art.grenzen().name().toLowerCase(Locale.ROOT));
            assertThat(z.path("offen_erlaubt").asBoolean()).as(code).isEqualTo(art.offenErlaubt());
            assertThat(z.path("achse").asText()).as(code).isEqualTo(art.achse().name().toLowerCase(Locale.ROOT));
            assertThat(texte(a.path("bezug_pflicht"))).as(code).isEqualTo(art.bezugPflicht());
            assertThat(texte(a.path("bezug_erlaubt"))).as(code).isEqualTo(art.bezugErlaubt());
            assertThat(texte(a.path("pflicht"))).as(code).isEqualTo(art.pflicht());
            assertThat(texte(a.path("felder"))).as(code).isEqualTo(art.felder());
            assertThat(texte(a.path("fortschreibbar"))).as(code).isEqualTo(art.fortschreibbar());
            assertThat(a.path("mqtt").isNull()).as(code + " mqtt").isEqualTo(!art.boxMeldet());
            assertThat(art.boxMeldet()).as(code).isEqualTo(art.urheber().contains(Urheber.BOX));
            if (art.boxMeldet()) {
                assertThat(texte(a.path("mqtt").path("pflicht"))).as(code).isEqualTo(art.mqttPflicht());
                assertThat(texte(a.path("mqtt").path("felder"))).as(code).isEqualTo(art.mqttFelder());
            }
            assertThat(a.path("nie_geloescht").asBoolean()).as(code + " nie gelöscht").isTrue();
            // Jedes Feld der Art hat einen Typ; nur Zeiträume schreiben ein Ende fort.
            art.erlaubteFelder(Urheber.WRITER).forEach(f ->
                    assertThat(EreignisVokabular.FELDER).as(code + "." + f).containsKey(f));
            if (!art.fortschreibbar().isEmpty()) {
                assertThat(art.offenErlaubt()).as(code).isTrue();
                assertThat(art.fortschreibbar()).as(code).contains("bis");
            }
        }
        assertThat(codes).containsExactlyElementsOf(Stream.of(Art.values()).map(Art::code).toList());
    }

    @Test
    void dieRegelZahlenStimmenMitDerPruefungUndDemHerkunftsvertrag() throws Exception {
        JsonNode r = lies(VECTORS).path("regeln");
        assertThat(r.path("zukunft_hoechstens_s").asLong()).isEqualTo(MesswertHerkunft.ZUKUNFT_HOECHSTENS_S);
        assertThat(r.path("vergangenheit_hoechstens_s").asLong())
                .isEqualTo(MesswertHerkunft.VERGANGENHEIT_HOECHSTENS_S);
        assertThat(r.path("zeitsprung_ab_s").asLong()).isEqualTo(MesswertHerkunft.ZEITSPRUNG_AB_S);
        assertThat(r.path("unassigned_reader_hoechstens_je_s").asLong())
                .isEqualTo(MesswertHerkunft.UNASSIGNED_READER_HOECHSTENS_JE_S);
        assertThat(r.path("viertelstunde_s").asLong()).isEqualTo(EreignisVokabular.VIERTELSTUNDE_S);
        assertThat(r.path("ereignisse_je_umschlag_hoechstens").asInt())
                .isEqualTo(EreignisVokabular.EREIGNISSE_JE_UMSCHLAG_HOECHSTENS);
        JsonNode h = lies(HERKUNFT).path("regeln");
        for (String k : List.of("zukunft_hoechstens_s", "vergangenheit_hoechstens_s",
                "zeitsprung_ab_s", "unassigned_reader_hoechstens_je_s")) {
            assertThat(r.path(k)).as(k).isEqualTo(h.path(k));
        }
    }

    // ---------------------------------------------- Schemas ⟷ Vokabular

    @Test
    void dieDrahtSchemasSindAusGenauDiesemVokabularGebaut() throws Exception {
        JsonNode raw = lies(RAW);
        JsonNode mqtt = lies(MQTT);
        List<String> rawZweige = new ArrayList<>();
        raw.path("$defs").path("ereignis").path("anyOf")
                .forEach(z -> rawZweige.add(z.path("$ref").asText().replace("#/$defs/art_", "")));
        assertThat(rawZweige).containsExactlyElementsOf(Stream.of(Art.values()).map(Art::code).toList());
        List<String> boxZweige = new ArrayList<>();
        mqtt.path("$defs").path("box_ereignis").path("anyOf")
                .forEach(z -> boxZweige.add(z.path("$ref").asText().replace("#/$defs/box_", "")));
        assertThat(boxZweige).containsExactlyElementsOf(
                Stream.of(Art.values()).filter(Art::boxMeldet).map(Art::code).toList());

        for (Art art : Art.values()) {
            JsonNode z = raw.path("$defs").path("art_" + art.code());
            assertThat(texte(z.path("required"))).as(art.code()).isEqualTo(art.pflichtFelder());
            assertThat(feldnamen(z.path("properties"))).as(art.code())
                    .containsExactlyElementsOf(art.erlaubteFelder(Urheber.WRITER));
            assertThat(z.path("properties").path("art").path("const").asText()).isEqualTo(art.code());
            assertThat(z.path("additionalProperties").asBoolean(true)).as(art.code()).isFalse();
            if (art.zeitform() == EreignisVokabular.Zeitform.ZEITRAUM) {
                assertThat(z.path("properties").path("bis").path("$ref").asText()).as(art.code())
                        .isEqualTo(art.offenErlaubt() ? "#/$defs/zeit_utc_oder_leer" : "#/$defs/zeit_utc");
            }
            if (art.boxMeldet()) {
                JsonNode b = mqtt.path("$defs").path("box_" + art.code());
                assertThat(texte(b.path("required"))).as(art.code()).isEqualTo(art.mqttPflicht());
                assertThat(feldnamen(b.path("properties"))).as(art.code())
                        .containsExactlyElementsOf(art.mqttFelder());
                assertThat(b.path("properties").has("box")).as("box kommt aus dem Topic").isFalse();
                if (b.path("properties").has("bis")) {
                    assertThat(b.path("properties").path("bis").path("$ref").asText())
                            .as("eine Box meldet nie offen").isEqualTo("#/$defs/zeit_utc");
                }
            }
        }
        JsonNode rd = raw.path("$defs");
        assertThat(texte(rd.path("urheber").path("enum")))
                .containsExactlyElementsOf(Stream.of(Urheber.values()).map(Urheber::code).toList());
        assertThat(texte(rd.path("grund").path("enum")))
                .containsExactlyElementsOf(Stream.of(Grund.values()).map(Grund::code).toList());
        assertThat(texte(rd.path("strom").path("enum"))).containsExactlyElementsOf(EreignisVokabular.STROM);
        assertThat(texte(rd.path("erkannt_aus").path("enum")))
                .containsExactlyElementsOf(EreignisVokabular.ERKANNT_AUS.keySet());
        assertThat(texte(rd.path("fehlerklasse").path("enum")))
                .containsExactlyElementsOf(EreignisVokabular.FEHLERKLASSEN);
        assertThat(texte(rd.path("anlass_geraetegrenze").path("enum")))
                .containsExactlyElementsOf(EreignisVokabular.ANLASS_GERAETEGRENZE);
        assertThat(texte(rd.path("anlass_uebergabe").path("enum")))
                .containsExactlyElementsOf(EreignisVokabular.ANLASS_UEBERGABE);
        assertThat(texte(rd.path("qualitaet").path("enum"))).containsExactlyElementsOf(EreignisVokabular.QUALITAET);
        JsonNode umschlag = mqtt.path("properties");
        assertThat(umschlag.path("schema_version").path("const").asText())
                .isEqualTo(EreignisVokabular.FASSUNG_UMSCHLAG);
        assertThat(umschlag.path("events").path("maxItems").asInt())
                .isEqualTo(EreignisVokabular.EREIGNISSE_JE_UMSCHLAG_HOECHSTENS);
        assertThat(mqtt.path("x-topic").asText()).startsWith("ems/{tenant_id}/{site_id}/{device_id}/v2/events");
        assertThat(raw.path("x-kafka").path("topic").asText()).isEqualTo("events.raw");
    }

    // ------------------------------------------------------ die Vektor-Fälle

    /** Jeder Fall: dasselbe Schema-Urteil und dasselbe Prüf-Urteil samt Grund. */
    @TestFactory
    List<DynamicTest> jederFall() throws Exception {
        JsonNode mqtt = lies(MQTT);
        JsonNode ereignisSchema = teilSchema(lies(RAW), "#/$defs/ereignis");
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : lies(VECTORS).path("cases")) {
            tests.add(DynamicTest.dynamicTest(c.path("name").asText(), () -> {
                JsonNode in = c.path("input");
                JsonNode soll = c.path("expected");
                String pruefung = c.path("pruefung").asText();
                List<String> verstoesse;
                Urteil urteil;
                switch (pruefung) {
                    case "umschlag" -> {
                        verstoesse = UemsSchemaLaeufer.verstoesse(in.path("umschlag"), mqtt);
                        if (in.path("umschlag").path("events").size()
                                > EreignisVokabular.EREIGNISSE_JE_UMSCHLAG_HOECHSTENS) {
                            verstoesse = List.of("maxItems");
                        }
                        urteil = EreignisVokabular.pruefeUmschlag(in.path("topic").asText(), in.path("umschlag"));
                    }
                    case "ereignis" -> {
                        verstoesse = UemsSchemaLaeufer.verstoesse(in.path("ereignis"), ereignisSchema);
                        urteil = EreignisVokabular.pruefe(in.path("ereignis"),
                                Urheber.vonCode(in.path("urheber").asText()));
                    }
                    default -> {
                        verstoesse = UemsSchemaLaeufer.verstoesse(in.path("neu"), ereignisSchema);
                        urteil = EreignisVokabular.pruefeFortschreibung(in.path("alt"), in.path("neu"),
                                Urheber.vonCode(in.path("urheber").asText()));
                    }
                }
                assertThat(verstoesse.isEmpty()).as(c.path("name").asText() + " Schema " + verstoesse)
                        .isEqualTo(soll.path("schema").asBoolean());
                assertThat(urteil.angenommen() ? "angenommen" : "verworfen")
                        .as(c.path("why").asText() + " — " + urteil.hinweis())
                        .isEqualTo(soll.path("urteil").asText());
                assertThat(urteil.grund() == null ? null : urteil.grund().code())
                        .as(c.path("name").asText() + " — " + urteil.hinweis())
                        .isEqualTo(soll.path("grund").isNull() ? null : soll.path("grund").asText());
            }));
        }
        return tests;
    }

    /** Jede Art hat mindestens einen angenommenen Fall, jeder Prüf-Grund mindestens einen verworfenen. */
    @Test
    void dieFaelleDeckenJedeArtUndJedenGrund() throws Exception {
        Set<String> gesehen = new HashSet<>();
        Set<String> gruende = new HashSet<>();
        for (JsonNode c : lies(VECTORS).path("cases")) {
            if ("angenommen".equals(c.path("expected").path("urteil").asText())) {
                ereignisse(c, Map.of()).forEach(e -> gesehen.add(e.path("art").asText()));
            } else {
                gruende.add(c.path("expected").path("grund").asText());
            }
        }
        assertThat(gesehen).containsExactlyInAnyOrderElementsOf(Stream.of(Art.values()).map(Art::code).toList());
        assertThat(gruende).containsExactlyInAnyOrderElementsOf(Stream.of(Grund.values())
                .filter(g -> g != Grund.HERKUNFT_UNVOLLSTAENDIG).map(Grund::code).toList());
    }

    // ------------------------------------------------ Beispiele (examples/)

    @Test
    void dieBeispieleHaltenIhreSchemasUndDiePruefung() throws Exception {
        JsonNode raw = lies(RAW);
        JsonNode mqtt = lies(MQTT);
        int gueltig = 0;
        int ungueltig = 0;
        try (Stream<Path> dateien = Files.list(BEISPIELE)) {
            for (Path p : dateien.sorted().toList()) {
                String name = p.getFileName().toString();
                boolean istRaw = name.startsWith("events-raw.");
                boolean istMqtt = name.startsWith("mqtt-events-2.1.");
                if (!istRaw && !istMqtt) {
                    continue;
                }
                boolean soll = name.contains(".valid.");
                JsonNode d = lies(p);
                List<String> v = UemsSchemaLaeufer.verstoesse(d, istRaw ? raw : mqtt);
                assertThat(v.isEmpty()).as(name + " " + v).isEqualTo(soll);
                if (soll && istRaw) {
                    Urheber u = Urheber.vonCode(d.path("urheber").asText());
                    assertThat(EreignisVokabular.pruefe(d.path("ereignis"), u).angenommen()).as(name).isTrue();
                }
                if (soll && istMqtt) {
                    String topic = "ems/" + d.path("tenant_id").asText() + "/" + d.path("site_id").asText()
                            + "/" + d.path("device_id").asText() + "/v2/events";
                    assertThat(EreignisVokabular.pruefeUmschlag(topic, d).angenommen()).as(name).isTrue();
                }
                if (soll) {
                    gueltig++;
                } else {
                    ungueltig++;
                }
            }
        }
        assertThat(gueltig).as("≥ 2 gültige Beispiele je Schema").isGreaterThanOrEqualTo(4);
        assertThat(ungueltig).as("≥ 1 ungültiges Beispiel je Schema").isGreaterThanOrEqualTo(2);
    }

    // ------------------------------------------- Konsistenz über die Pakete

    /**
     * Jede Art und jeder Ablehnungsgrund des Herkunftsvertrags steht im Vokabular, jedes seiner
     * Ereignis-Felder ist ein Feld dieser Art — der Herkunftsvertrag trägt einen Ausschnitt, dieser
     * Vertrag bleibt additiv dazu.
     */
    @Test
    void derHerkunftsvertragSprichtDiesesVokabular() throws Exception {
        JsonNode h = lies(HERKUNFT);
        Set<String> codes = new HashSet<>(Stream.of(Art.values()).map(Art::code).toList());
        Set<String> gruende = new HashSet<>(Stream.of(Grund.values()).map(Grund::code).toList());
        assertThat(codes).containsAll(texte(h.path("vokabular").path("ereignis")));
        for (String g : texte(h.path("vokabular").path("grund"))) {
            assertThat(codes.contains(g) || gruende.contains(g)).as("Urteil-Grund " + g).isTrue();
        }
        int gesehen = 0;
        for (JsonNode c : h.path("cases")) {
            for (JsonNode e : c.path("expected").path("ereignisse")) {
                Art art = Art.vonCode(e.path("art").asText());
                assertThat(art).as(e.toString()).isNotNull();
                Set<String> felder = new HashSet<>();
                art.urheber().forEach(u -> felder.addAll(art.erlaubteFelder(u)));
                e.fieldNames().forEachRemaining(f ->
                        assertThat(felder).as(art.code() + " aus " + c.path("name").asText()).contains(f));
                if (e.has("grund")) {
                    assertThat(gruende).contains(e.path("grund").asText());
                }
                gesehen++;
            }
        }
        assertThat(gesehen).isPositive();
    }

    /** Die Fehlerklassen sind die von data-source-vectors.json — und je Klasse ist entschieden, ob Zustand oder Ereignis. */
    @Test
    void dieFehlerklassenSindDieDerDatenquelle() throws Exception {
        JsonNode v = lies(VECTORS);
        List<String> dq = texte(lies(DATENQUELLE).path("fehlerklassen"));
        assertThat(EreignisVokabular.FEHLERKLASSEN).containsExactlyElementsOf(dq);
        List<String> eingeordnet = new ArrayList<>();
        for (JsonNode e : v.path("fehlerklassen_einordnung")) {
            eingeordnet.add(e.path("code").asText());
            boolean zustandAllein = "zustand".equals(e.path("einordnung").asText());
            assertThat(e.path("ereignis").isNull()).as(e.toString()).isEqualTo(zustandAllein);
            if (!zustandAllein) {
                assertThat(Art.vonCode(e.path("ereignis").asText())).as(e.toString()).isNotNull();
            }
        }
        assertThat(eingeordnet).containsExactlyElementsOf(dq);
        // Die Fehlerklasse, die zugleich Ereignis ist, heißt als Ereignis wörtlich gleich.
        assertThat(Art.vonCode("layout_changed")).isNotNull();
    }

    /**
     * Kein Wort steht zweimal in anderer Schreibweise: jedes Wort in den Herkunfts- und
     * Datenquellen-Vektoren, das nach Kleinschreibung ohne „_“ und „-“ wie eine Art oder ein Grund
     * aussieht, IST diese Art bzw. dieser Grund.
     */
    @Test
    void keinWortStehtZweimalInAndererSchreibweise() throws Exception {
        Map<String, String> normal = new HashMap<>();
        for (String w : Stream.concat(Stream.of(Art.values()).map(Art::code),
                Stream.of(Grund.values()).map(Grund::code)).toList()) {
            assertThat(normal.put(norm(w), w)).as("doppelt im Vokabular: " + w).isNull();
        }
        Pattern wort = Pattern.compile("[A-Za-z][A-Za-z0-9_-]{3,}");
        List<String> fehler = new ArrayList<>();
        for (Path p : List.of(HERKUNFT, DATENQUELLE, VECTORS)) {
            Matcher m = wort.matcher(Files.readString(p));
            while (m.find()) {
                String w = m.group();
                String treffer = normal.get(norm(w));
                if (treffer != null && !treffer.equals(w)) {
                    fehler.add(p.getFileName() + ": „" + w + "“ statt „" + treffer + "“");
                }
            }
        }
        assertThat(fehler).isEmpty();
    }

    private static String norm(String w) {
        return w.toLowerCase(Locale.ROOT).replace("_", "").replace("-", "");
    }

    /** Die Arten, die der Writer heute schreibt, heißen im Vokabular gleich. */
    @Test
    void derBestandDesWritersHeisstGleich() throws Exception {
        JsonNode b = lies(VECTORS).path("bestand");
        String sql = Files.readString(REPO.resolve(b.path("datei").asText()));
        Matcher m = Pattern.compile("event_kind\\s+TEXT\\s+NOT NULL\\s+CHECK \\(event_kind IN\\s*\\(([^)]*)\\)\\)")
                .matcher(sql);
        assertThat(m.find()).as("CHECK auf event_kind in " + b.path("datei").asText()).isTrue();
        List<String> heute = new ArrayList<>();
        for (String t : m.group(1).split(",")) {
            heute.add(t.trim().replace("'", ""));
        }
        assertThat(texte(b.path("arten"))).containsExactlyElementsOf(heute);
        List<String> mitBestand = new ArrayList<>();
        lies(VECTORS).path("vokabular").path("arten").forEach(a -> {
            if (a.path("bestand").asBoolean()) {
                mitBestand.add(a.path("art").asText());
            }
        });
        assertThat(mitBestand).containsExactlyInAnyOrderElementsOf(heute);
    }

    // ------------------------------------------------ Referenzunternehmen

    /**
     * Jede Tatsache eines Falls steht so im Referenzunternehmen: jedes Kennzeichen existiert (außer
     * dem, was der Fall als erfunden nennt); für angenommene Fälle ist die Box zum Zeitpunkt in
     * Betrieb und für ihre Datenquelle zuständig (bzw. — bei {@code unassigned_reader} — gerade
     * nicht), die Komponente hängt an der genannten Datenquelle, die Messstelle führt die Reihe,
     * und eine Gerätegrenze trennt genau die Einbauten der Referenz samt ihren Ständen.
     */
    @TestFactory
    List<DynamicTest> jederFallStehtImReferenzunternehmen() throws Exception {
        JsonNode v = lies(VECTORS);
        Referenz ref = new Referenz(lies(REFERENZ));
        Map<String, String> boxVonUuid = new HashMap<>();
        v.path("kennungen").path("boxen").fields()
                .forEachRemaining(f -> boxVonUuid.put(f.getValue().asText(), f.getKey()));
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : v.path("cases")) {
            tests.add(DynamicTest.dynamicTest(c.path("name").asText(), () -> {
                List<String> fehler = new ArrayList<>();
                Set<String> erfunden = new HashSet<>(texte(c.path("erfunden")));
                boolean angenommen = "angenommen".equals(c.path("expected").path("urteil").asText());
                if ("umschlag".equals(c.path("pruefung").asText()) && angenommen) {
                    pruefeUmschlagGegenReferenz(c.path("input").path("umschlag"), v.path("kennungen"),
                            boxVonUuid, ref, fehler);
                }
                for (JsonNode e : ereignisse(c, boxVonUuid)) {
                    ref.existenz(e, erfunden, fehler);
                    if (angenommen) {
                        ref.zustand(e, fehler);
                    }
                }
                assertThat(fehler).as(c.path("name").asText()).isEmpty();
            }));
        }
        return tests;
    }

    private static void pruefeUmschlagGegenReferenz(JsonNode u, JsonNode kennungen,
            Map<String, String> boxVonUuid, Referenz ref, List<String> fehler) {
        String box = boxVonUuid.get(u.path("device_id").asText());
        if (box == null) {
            fehler.add("device_id ist keine Box der Kennungen");
            return;
        }
        if (!kennungen.path("kundenbereich").elements().next().asText().equals(u.path("tenant_id").asText())) {
            fehler.add("tenant_id ist nicht der Kundenbereich Ahrenberg");
        }
        String heimat = ref.boxen.get(box).path("heimat_anlage").asText();
        if (!kennungen.path("anlagen").path(heimat).asText().equals(u.path("site_id").asText())) {
            fehler.add("site_id ist nicht die Heimat-Anlage " + heimat + " von " + box);
        }
        ref.inBetrieb(box, Instant.parse(u.path("observed_at").asText()), fehler);
    }

    /** Die Ereignisse eines Falls; im Umschlag bekommt jedes {@code box} = Kennzeichen der Box. */
    private static List<JsonNode> ereignisse(JsonNode c, Map<String, String> boxVonUuid) {
        JsonNode in = c.path("input");
        List<JsonNode> out = new ArrayList<>();
        switch (c.path("pruefung").asText()) {
            case "ereignis" -> out.add(in.path("ereignis"));
            case "fortschreibung" -> {
                out.add(in.path("alt"));
                out.add(in.path("neu"));
            }
            default -> {
                String box = boxVonUuid.get(in.path("umschlag").path("device_id").asText());
                for (JsonNode e : in.path("umschlag").path("events")) {
                    ObjectNode k = e.deepCopy();
                    if (box != null) {
                        k.put("box", box);
                    }
                    out.add(k);
                }
            }
        }
        return out;
    }

    /** Die Referenzdatei, nach Kennzeichen erschlossen. */
    private static final class Referenz {
        final Map<String, JsonNode> boxen = new HashMap<>();
        final Map<String, JsonNode> datenquellen = new HashMap<>();
        final Map<String, JsonNode> komponenten = new HashMap<>();
        final Map<String, JsonNode> geraete = new HashMap<>();
        final Map<String, JsonNode> messstellen = new HashMap<>();
        final List<JsonNode> zustaendig = new ArrayList<>();

        Referenz(JsonNode ref) {
            ref.path("boxen").forEach(b -> boxen.put(b.path("kennzeichen").asText(), b));
            ref.path("datenquellen").forEach(d -> datenquellen.put(d.path("kennzeichen").asText(), d));
            ref.path("komponenten").forEach(k -> komponenten.put(k.path("kennzeichen").asText(), k));
            ref.path("geraete").forEach(g -> geraete.put(g.path("kennzeichen").asText(), g));
            ref.path("messstellen").forEach(m -> messstellen.put(m.path("kennzeichen").asText(), m));
            ref.path("zuordnungen").forEach(z -> {
                if ("datenquelle_box".equals(z.path("art").asText())) {
                    zustaendig.add(z);
                }
            });
        }

        void existenz(JsonNode e, Set<String> erfunden, List<String> fehler) {
            for (String f : List.of("box", "box_alt", "box_neu", "zustaendige_box")) {
                gibt(e, f, boxen, erfunden, fehler);
            }
            gibt(e, "datenquelle", datenquellen, erfunden, fehler);
            gibt(e, "komponente", komponenten, erfunden, fehler);
            gibt(e, "messstelle", messstellen, erfunden, fehler);
            JsonNode k = komponenten.get(e.path("komponente").asText());
            if (k == null) {
                return;
            }
            JsonNode geraet = geraete.get(k.path("geraet").asText());
            for (String f : List.of("einbau_alt", "einbau_neu")) {
                String einbau = e.path(f).asText(null);
                if (einbau != null && !erfunden.contains(einbau) && einbau(geraet, einbau) == null) {
                    fehler.add(f + " " + einbau + " ist kein Einbau von " + k.path("geraet").asText());
                }
            }
            String kanal = e.path("messkanal").asText(null);
            if (kanal != null && !erfunden.contains(kanal) && !kanalBekannt(k, kanal)) {
                fehler.add("Messkanal „" + kanal + "“ nennt die Referenz für " + k.path("kennzeichen").asText() + " nicht");
            }
        }

        private boolean kanalBekannt(JsonNode k, String kanal) {
            if (k.path("kanaele").asText().contains(kanal)) {
                return true;
            }
            for (JsonNode m : messstellen.values()) {
                for (JsonNode q : m.path("fuehrende_quelle")) {
                    if (q.path("komponente").asText().equals(k.path("kennzeichen").asText())
                            && q.path("kanal").asText().equals(kanal)) {
                        return true;
                    }
                }
            }
            return false;
        }

        private static void gibt(JsonNode e, String feld, Map<String, JsonNode> tabelle,
                Set<String> erfunden, List<String> fehler) {
            String k = e.path(feld).asText(null);
            if (k != null && !erfunden.contains(k) && !tabelle.containsKey(k)) {
                fehler.add(feld + " " + k + " steht nicht in der Referenz");
            }
        }

        void zustand(JsonNode e, List<String> fehler) {
            String art = e.path("art").asText();
            Instant t = Instant.parse(e.has("messzeit") ? e.path("messzeit").asText()
                    : e.has("zeitpunkt") ? e.path("zeitpunkt").asText() : e.path("von").asText());
            String box = e.path("box").asText(null);
            if (box != null) {
                inBetrieb(box, t, fehler);
            }
            String quelle = e.path("datenquelle").asText(null);
            JsonNode k = komponenten.get(e.path("komponente").asText());
            if (k != null) {
                String kQuelle = geraete.get(k.path("geraet").asText()).path("datenquelle").asText();
                if (quelle != null && !quelle.equals(kQuelle)) {
                    fehler.add(k.path("kennzeichen").asText() + " hängt an " + kQuelle + ", nicht an " + quelle);
                }
                quelle = kQuelle;
            }
            if ("handover".equals(art)) {
                gleich(fehler, "zuständig vor der Übergabe", e.path("box_alt").asText(),
                        zustaendigeBox(quelle, t.minusSeconds(60)));
                gleich(fehler, "zuständig ab der Übergabe", e.path("box_neu").asText(), zustaendigeBox(quelle, t));
                inBetrieb(e.path("box_neu").asText(), t, fehler);
            } else if (box != null && quelle != null) {
                String z = zustaendigeBox(quelle, t);
                if ("unassigned_reader".equals(art)) {
                    if (box.equals(z)) {
                        fehler.add(box + " war zur Messzeit zuständig");
                    }
                    if (e.has("zustaendige_box")) {
                        gleich(fehler, "zuständige Box", e.path("zustaendige_box").asText(), z);
                    }
                } else {
                    gleich(fehler, "zuständige Box für " + quelle, box, z);
                }
            }
            String ms = e.path("messstelle").asText(null);
            if (ms != null) {
                JsonNode q = fuehrend(ms, t);
                if (q == null) {
                    fehler.add(ms + " hat zum Zeitpunkt keine führende Quelle");
                    return;
                }
                gleich(fehler, ms + " Komponente", e.path("komponente").asText(), q.path("komponente").asText());
                gleich(fehler, ms + " Messkanal", e.path("messkanal").asText(), q.path("kanal").asText());
                if ("device_boundary".equals(art)) {
                    gleich(fehler, "Einbau ab der Grenze", e.path("einbau_neu").asText(), q.path("einbau").asText());
                    JsonNode vorher = fuehrend(ms, t.minusSeconds(60));
                    gleich(fehler, "Einbau vor der Grenze", e.path("einbau_alt").asText(),
                            vorher == null ? null : vorher.path("einbau").asText());
                }
            }
            if ("device_boundary".equals(art) && k != null) {
                JsonNode geraet = geraete.get(k.path("geraet").asText());
                stand(fehler, "Endstand", e.path("endstand"), einbau(geraet, e.path("einbau_alt").asText()), "endstand_kwh");
                stand(fehler, "Anfangsstand", e.path("anfangsstand"),
                        einbau(geraet, e.path("einbau_neu").asText()), "anfangsstand_kwh");
            }
        }

        void inBetrieb(String box, Instant t, List<String> fehler) {
            JsonNode b = boxen.get(box);
            if (b == null) {
                return;
            }
            Instant ab = zeit(b.path("in_betrieb_ab").asText());
            Instant aus = b.path("ausgebaut_am").isNull() ? null : zeit(b.path("ausgebaut_am").asText());
            if (t.isBefore(ab) || (aus != null && !t.isBefore(aus))) {
                fehler.add(box + " ist am " + t + " nicht in Betrieb");
            }
        }

        String zustaendigeBox(String quelle, Instant t) {
            for (JsonNode z : zustaendig) {
                if (z.path("von").asText().equals(quelle) && gilt(z, t)) {
                    return z.path("nach").asText();
                }
            }
            return null;
        }

        JsonNode fuehrend(String messstelle, Instant t) {
            for (JsonNode q : messstellen.get(messstelle).path("fuehrende_quelle")) {
                if (gilt(q, t)) {
                    return q;
                }
            }
            return null;
        }

        private static JsonNode einbau(JsonNode geraet, String kennzeichen) {
            if (geraet == null) {
                return null;
            }
            for (JsonNode e : geraet.path("einbauten")) {
                if (e.path("kennzeichen").asText().equals(kennzeichen)) {
                    return e;
                }
            }
            return null;
        }

        private static void stand(List<String> fehler, String was, JsonNode ist, JsonNode einbau, String feld) {
            if (einbau == null || einbau.path(feld).isNull() || ist.isMissingNode()) {
                return;
            }
            if (ist.decimalValue().compareTo(einbau.path(feld).decimalValue()) != 0) {
                fehler.add(was + " " + ist + " ≠ Referenz " + einbau.path(feld));
            }
        }

        private static boolean gilt(JsonNode z, Instant t) {
            Instant ab = zeit(z.path("gueltig_ab").asText());
            Instant bis = z.path("gueltig_bis").isNull() ? null : zeit(z.path("gueltig_bis").asText());
            return !t.isBefore(ab) && (bis == null || t.isBefore(bis));
        }

        private static void gleich(List<String> fehler, String was, String ist, String referenz) {
            if (ist == null ? referenz != null : !ist.equals(referenz)) {
                fehler.add(was + ": Fall „" + ist + "“, Referenz „" + referenz + "“");
            }
        }
    }

    // ---------------------------------------------------------------- Hilfen

    private static Instant zeit(String s) {
        return OffsetDateTime.parse(s).toInstant();
    }

    private static List<String> feldnamen(JsonNode o) {
        List<String> out = new ArrayList<>();
        o.fieldNames().forEachRemaining(out::add);
        return out;
    }

    private static List<String> kennzeichen(JsonNode liste) {
        List<String> out = new ArrayList<>();
        liste.forEach(n -> out.add(n.path("kennzeichen").asText()));
        return out;
    }

    /** Ein Schema, das auf einen Teil der Wurzel verweist ({@code $defs} bleiben erreichbar). */
    private static JsonNode teilSchema(JsonNode wurzel, String ref) {
        ObjectNode s = MAPPER.createObjectNode();
        s.set("$defs", wurzel.path("$defs"));
        s.put("$ref", ref);
        return s;
    }
}
