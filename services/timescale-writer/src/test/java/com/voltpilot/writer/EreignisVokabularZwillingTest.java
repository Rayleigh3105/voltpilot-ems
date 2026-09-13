package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.writer.EreignisVokabular.Art;
import com.voltpilot.writer.EreignisVokabular.Grund;
import com.voltpilot.writer.EreignisVokabular.Urheber;
import com.voltpilot.writer.EreignisVokabular.Urteil;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * The writer twin of the event vocabulary ({@link EreignisVokabular}, a copy of the api class)
 * judges EVERY case of {@code docs/contracts/v2/events-vocabulary-vectors.json} exactly as the
 * file says - the same file the api class ({@code EreignisVokabularVectorsTest}) and the TS twin
 * are held to. Plus: its vocabulary is the file's, and the two sources it inlines (the time
 * thresholds of the provenance contract, the nine error classes of the data source contract)
 * are the numbers and words of their files. Pure; no Docker.
 */
class EreignisVokabularZwillingTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");

    private static JsonNode lies(String datei) throws Exception {
        return MAPPER.readTree(Files.readString(V2.resolve(datei)));
    }

    private static List<String> texte(JsonNode liste) {
        List<String> out = new ArrayList<>();
        liste.forEach(n -> out.add(n.isObject() ? n.path("code").asText() : n.asText()));
        return out;
    }

    @TestFactory
    List<DynamicTest> jederFallUrteiltWieDieVektorDatei() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : lies("events-vocabulary-vectors.json").path("cases")) {
            tests.add(DynamicTest.dynamicTest(c.path("name").asText(), () -> {
                JsonNode in = c.path("input");
                Urheber u = Urheber.vonCode(in.path("urheber").asText());
                Urteil urteil = switch (c.path("pruefung").asText()) {
                    case "umschlag" -> EreignisVokabular.pruefeUmschlag(in.path("topic").asText(),
                            in.path("umschlag"));
                    case "ereignis" -> EreignisVokabular.pruefe(in.path("ereignis"), u);
                    default -> EreignisVokabular.pruefeFortschreibung(in.path("alt"), in.path("neu"), u);
                };
                JsonNode soll = c.path("expected");
                assertThat(urteil.angenommen()).as(c.path("name").asText() + " " + urteil)
                        .isEqualTo("angenommen".equals(soll.path("urteil").asText()));
                assertThat(urteil.grund() == null ? null : urteil.grund().code())
                        .as(c.path("name").asText() + " " + urteil.hinweis())
                        .isEqualTo(soll.path("grund").isNull() ? null : soll.path("grund").asText());
            }));
        }
        return tests;
    }

    @Test
    void dasVokabularIstDasDerVektorDatei() throws Exception {
        JsonNode w = lies("events-vocabulary-vectors.json").path("vokabular");
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
        assertThat(texte(w.path("einheit_zuwachs"))).containsExactlyElementsOf(EreignisVokabular.EINHEITEN_ZUWACHS);
        Map<String, String> erkannt = new LinkedHashMap<>();
        w.path("erkannt_aus").forEach(e -> erkannt.put(e.path("code").asText(), e.path("urheber").asText()));
        Map<String, String> twin = new LinkedHashMap<>();
        EreignisVokabular.ERKANNT_AUS.forEach((k, u) -> twin.put(k, u.code()));
        assertThat(erkannt).containsExactlyEntriesOf(twin);
        // Additiv (AP-07 IP-9): wer dasselbe ZUSÄTZLICH feststellen darf — Vektor-Datei `auch_urheber`.
        Map<String, String> auch = new LinkedHashMap<>();
        w.path("erkannt_aus").forEach(e -> {
            if (e.has("auch_urheber")) {
                auch.put(e.path("code").asText(), String.join(",", texte(e.path("auch_urheber"))));
            }
        });
        Map<String, String> auchKlasse = new LinkedHashMap<>();
        EreignisVokabular.ERKANNT_AUS_AUCH.forEach((k, us) -> auchKlasse.put(k,
                String.join(",", us.stream().map(u -> u.code()).toList())));
        assertThat(auch).isEqualTo(auchKlasse);
        Map<String, String> felder = new LinkedHashMap<>();
        w.path("felder").fields().forEachRemaining(f -> felder.put(f.getKey(), f.getValue().path("typ").asText()));
        Map<String, String> twinFelder = new LinkedHashMap<>();
        EreignisVokabular.FELDER.forEach((k, t) -> twinFelder.put(k, t.name().toLowerCase(Locale.ROOT)));
        assertThat(felder).containsExactlyEntriesOf(twinFelder);

        List<String> codes = new ArrayList<>();
        for (JsonNode a : w.path("arten")) {
            String code = a.path("art").asText();
            codes.add(code);
            Art art = Art.vonCode(code);
            assertThat(art).as(code).isNotNull();
            assertThat(new LinkedHashSet<>(texte(a.path("urheber")))).as(code)
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
            assertThat(a.path("mqtt").isNull()).as(code).isEqualTo(!art.boxMeldet());
            if (art.boxMeldet()) {
                assertThat(texte(a.path("mqtt").path("pflicht"))).as(code).isEqualTo(art.mqttPflicht());
                assertThat(texte(a.path("mqtt").path("felder"))).as(code).isEqualTo(art.mqttFelder());
            }
        }
        assertThat(codes).containsExactlyElementsOf(Stream.of(Art.values()).map(Art::code).toList());
    }

    /** The inlined sources: thresholds of messwert-herkunft, error classes of data-source. */
    @Test
    void dieEingebettetenQuellenSindDieIhrerDateien() throws Exception {
        JsonNode r = lies("events-vocabulary-vectors.json").path("regeln");
        assertThat(r.path("zukunft_hoechstens_s").asLong()).isEqualTo(EreignisVokabular.ZUKUNFT_HOECHSTENS_S);
        assertThat(r.path("vergangenheit_hoechstens_s").asLong())
                .isEqualTo(EreignisVokabular.VERGANGENHEIT_HOECHSTENS_S);
        assertThat(r.path("zeitsprung_ab_s").asLong()).isEqualTo(EreignisVokabular.ZEITSPRUNG_AB_S);
        assertThat(r.path("unassigned_reader_hoechstens_je_s").asLong())
                .isEqualTo(EreignisVokabular.UNASSIGNED_READER_HOECHSTENS_JE_S);
        assertThat(r.path("viertelstunde_s").asLong()).isEqualTo(EreignisVokabular.VIERTELSTUNDE_S);
        assertThat(r.path("ereignisse_je_umschlag_hoechstens").asInt())
                .isEqualTo(EreignisVokabular.EREIGNISSE_JE_UMSCHLAG_HOECHSTENS);

        String herkunft = lies("messwert-herkunft-vectors.json").toString();
        for (Map.Entry<String, Long> zahl : Map.of(
                "zukunft_hoechstens_s", EreignisVokabular.ZUKUNFT_HOECHSTENS_S,
                "vergangenheit_hoechstens_s", EreignisVokabular.VERGANGENHEIT_HOECHSTENS_S,
                "zeitsprung_ab_s", EreignisVokabular.ZEITSPRUNG_AB_S,
                "unassigned_reader_hoechstens_je_s",
                EreignisVokabular.UNASSIGNED_READER_HOECHSTENS_JE_S).entrySet()) {
            assertThat(herkunft).as("messwert-herkunft-vectors.json: " + zahl.getKey())
                    .contains("\"" + zahl.getKey() + "\":" + zahl.getValue());
        }

        assertThat(texte(lies("events-vocabulary-vectors.json").path("fehlerklassen_einordnung")))
                .containsExactlyElementsOf(EreignisVokabular.FEHLERKLASSEN);
        List<String> quelle = new ArrayList<>();
        lies("data-source-vectors.json").path("fehlerklassen")
                .forEach(f -> quelle.add(f.isObject() ? f.path("code").asText() : f.asText()));
        assertThat(quelle).containsExactlyInAnyOrderElementsOf(EreignisVokabular.FEHLERKLASSEN);
        assertThat(EreignisVokabular.FEHLERKLASSEN).contains(EreignisVokabular.BOX_MELDET_SICH_NICHT);
    }
}
