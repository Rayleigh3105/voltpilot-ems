package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.voltpilot.api.mispel.MispelWegRegeln.Eingang;
import com.voltpilot.api.web.dto.MispelWegDto;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * MiSpeL MP-55 rein: die Vektoren {@code docs/contracts/v2/mispel-weg-vectors.json} gegen {@link MispelWegRegeln} und die
 * Antwort der Route ({@link MispelWegDto}). Je Fall wird die erwartete Antwort als Teilmenge verglichen (Stationen über
 * {@code nr}); dazu Wortlaut und Reihenfolge der drei Stationsfolgen und die geschlossenen Vokabulare.
 */
class MispelWegRegelnTest {

    static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2", "mispel-weg-vectors.json");
    static final List<String> DEMO = List.of("Werk Talheim", "Kühlhaus Seebach", "Autohaus Brenner", "Haus Kröger",
            "Haus Sommer", "Haus Albers");

    static final ObjectMapper LESER = new ObjectMapper().registerModule(new JavaTimeModule())
            .setPropertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE)
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
    static final ObjectMapper SCHREIBER = new ObjectMapper().registerModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);

    private static final UUID ANLAGE = UUID.fromString("00000000-0000-4000-8000-0000000000aa");

    static JsonNode vektoren() throws IOException {
        return LESER.readTree(VEKTOREN.toFile());
    }

    /** Die Antwort der Route für den Eingang eines Falls, als JSON wie über die Leitung. */
    static JsonNode antwort(JsonNode eingang) throws IOException {
        Eingang e = LESER.treeToValue(eingang, Eingang.class);
        return SCHREIBER.valueToTree(MispelWegDto.aus(ANLAGE, e.heute(), MispelWegRegeln.strecken(e)));
    }

    @TestFactory
    List<DynamicTest> jederFall() throws IOException {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode fall : vektoren().path("faelle")) {
            tests.add(DynamicTest.dynamicTest(fall.path("name").asText(), () -> {
                JsonNode ist = antwort(fall.path("eingang"));
                teilmenge(fall.path("erwartet"), ist, fall.path("name").asText());
                assertThat(ist.path("heute").asText()).isEqualTo(fall.path("eingang").path("heute").asText());
            }));
        }
        return tests;
    }

    @Test
    void dieSechsDemoAnlagenHabenJeEinenFall() throws IOException {
        List<String> namen = new ArrayList<>();
        vektoren().path("faelle").forEach(f -> namen.add(f.path("name").asText()));
        assertThat(namen).containsAll(DEMO);
    }

    /** Jede ausgegebene Station trägt Nummer, Schlüssel, Titel, Wer und Erklärung ihrer Stationsfolge, in Reihenfolge. */
    @Test
    void wortlautUndReihenfolgeDerStationsfolgen() throws IOException {
        JsonNode v = vektoren();
        Set<String> gesehen = new HashSet<>();
        for (JsonNode fall : v.path("faelle")) {
            for (JsonNode strecke : antwort(fall.path("eingang")).path("strecken")) {
                String art = strecke.path("art").asText();
                gesehen.add(art);
                JsonNode folge = v.path("stationsfolgen").path(art);
                assertThat(folge.isMissingNode()).as(art).isFalse();
                assertThat(strecke.path("titel").asText()).as(art).isEqualTo(folge.path("titel").asText());
                assertThat(strecke.path("stationen").size()).as(art).isEqualTo(folge.path("stationen").size());
                assertThat(strecke.path("gesamt").asInt()).isEqualTo(folge.path("stationen").size());
                for (int i = 0; i < folge.path("stationen").size(); i++) {
                    JsonNode soll = folge.path("stationen").get(i);
                    JsonNode ist = strecke.path("stationen").get(i);
                    for (String feld : List.of("nr", "schluessel", "titel", "wer", "erklaerung")) {
                        assertThat(ist.path(feld)).as(fall.path("name").asText() + " " + art + " " + feld)
                                .isEqualTo(soll.path(feld));
                    }
                }
            }
        }
        assertThat(gesehen).containsExactlyInAnyOrder(MispelWegRegeln.ABGRENZUNG, MispelWegRegeln.PAUSCHAL,
                MispelWegRegeln.LADEPUNKT);
        assertThat(v.path("stationsfolgen").path("abgrenzung").path("stationen").size()).isEqualTo(8);
        assertThat(v.path("stationsfolgen").path("pauschal").path("stationen").size()).isEqualTo(8);
        assertThat(v.path("stationsfolgen").path("ladepunkt").path("stationen").size()).isEqualTo(6);
    }

    /** Geschlossene Vokabulare, höchstens ein „jetzt“ je Strecke, „n von m erledigt“ stimmt mit den Stationen. */
    @Test
    void vokabulareUndZaehlung() throws IOException {
        JsonNode v = vektoren();
        assertThat(texte(v.path("zustaende"))).isEqualTo(MispelWegRegeln.ZUSTAENDE);
        assertThat(texte(v.path("wer"))).isEqualTo(MispelWegRegeln.WER);
        assertThat(texte(v.path("ziele"))).isEqualTo(MispelWegRegeln.ZIELE);
        for (JsonNode fall : v.path("faelle")) {
            JsonNode ist = antwort(fall.path("eingang"));
            for (JsonNode strecke : ist.path("strecken")) {
                int erledigt = 0;
                int jetzt = 0;
                for (JsonNode s : strecke.path("stationen")) {
                    assertThat(MispelWegRegeln.ZUSTAENDE).contains(s.path("zustand").asText());
                    assertThat(MispelWegRegeln.WER).contains(s.path("wer").asText());
                    assertThat(s.path("stand").asText()).isNotBlank();
                    if (!s.path("tuer").isNull()) {
                        assertThat(MispelWegRegeln.ZIELE).contains(s.path("tuer").path("ziel").asText());
                        assertThat(s.path("tuer").path("beschriftung").asText()).isNotBlank();
                    }
                    erledigt += "erledigt".equals(s.path("zustand").asText()) ? 1 : 0;
                    jetzt += "jetzt".equals(s.path("zustand").asText()) ? 1 : 0;
                }
                assertThat(jetzt).as(fall.path("name").asText()).isLessThanOrEqualTo(1);
                assertThat(strecke.path("erledigt").asInt()).isEqualTo(erledigt);
                assertThat(strecke.path("satz").asText()).startsWith(erledigt + " von " + strecke.path("gesamt").asInt()
                        + " erledigt");
            }
            if (ist.path("strecken").size() > 0) {
                assertThat(ist.path("satz")).isEqualTo(ist.path("strecken").get(0).path("satz"));
            }
        }
    }

    // ------------------------------------------------------------------ Teilmenge

    /** {@code soll} ist in {@code ist} enthalten; Listen von Stationen werden über {@code nr} gepaart, sonst je Stelle. */
    static void teilmenge(JsonNode soll, JsonNode ist, String pfad) {
        if (soll.isObject()) {
            assertThat(ist.isObject()).as(pfad).isTrue();
            Iterator<Map.Entry<String, JsonNode>> felder = soll.fields();
            while (felder.hasNext()) {
                Map.Entry<String, JsonNode> f = felder.next();
                assertThat(ist.has(f.getKey())).as(pfad + "." + f.getKey()).isTrue();
                teilmenge(f.getValue(), ist.get(f.getKey()), pfad + "." + f.getKey());
            }
        } else if (soll.isArray()) {
            assertThat(ist.isArray()).as(pfad).isTrue();
            boolean nachNr = soll.size() > 0;
            for (JsonNode x : soll) {
                nachNr &= x.isObject() && x.has("nr");
            }
            if (!nachNr) {
                assertThat(ist.size()).as(pfad + " Länge").isEqualTo(soll.size());
            }
            for (int i = 0; i < soll.size(); i++) {
                JsonNode s = soll.get(i);
                JsonNode gegen = nachNr ? finde(ist, s.path("nr").asInt()) : ist.get(i);
                assertThat(gegen).as(pfad + "[" + (nachNr ? "nr " + s.path("nr").asInt() : i) + "]").isNotNull();
                teilmenge(s, gegen, pfad + "[" + (nachNr ? "nr=" + s.path("nr").asInt() : i) + "]");
            }
        } else if (soll.isNumber()) {
            assertThat(ist.isNumber()).as(pfad).isTrue();
            assertThat(ist.decimalValue()).as(pfad).isEqualByComparingTo(soll.decimalValue());
        } else {
            assertThat(ist).as(pfad).isEqualTo(soll);
        }
    }

    private static JsonNode finde(JsonNode liste, int nr) {
        for (JsonNode x : liste) {
            if (x.path("nr").asInt() == nr) {
                return x;
            }
        }
        return null;
    }

    private static List<String> texte(JsonNode liste) {
        List<String> out = new ArrayList<>();
        liste.forEach(x -> out.add(x.asText()));
        return out;
    }
}
