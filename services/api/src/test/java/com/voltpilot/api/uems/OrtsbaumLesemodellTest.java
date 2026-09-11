package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.OrtsbaumLesemodell.Bereich;
import com.voltpilot.api.uems.OrtsbaumLesemodell.Gebaeude;
import com.voltpilot.api.uems.OrtsbaumLesemodell.OrtsbaumAmStichtag;
import com.voltpilot.api.uems.StandortLesemodell.Zeilen;
import java.io.IOException;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Das Ortsbaum-Lesemodell (UEMS AP-02 IP-5) gegen den Ortsbaum-Vertrag — ohne Datenbank:
 * dieselben Zeilen wie {@link StandortLesemodellTest}, und für JEDEN „Stand am“-Fall der
 * Vektor-Datei muss der Baum JEDES Standorts genau das sagen, was die Datei erwartet —
 * welche Gebäude an ihm hängen, welche Bereiche an welchem Gebäude oder direkt am Standort,
 * welche Fläche mit welcher Quelle, die Summe der Gebäude und wem die Fläche fehlt. Ein
 * Standort, den es am Stichtag nicht gab, hat keinen Baum.
 *
 * <p>Die HTTP-Hälfte (Schreibrouten, Protokoll, 404) beweist {@code OrtApiTest}.
 */
class OrtsbaumLesemodellTest {

    @TestFactory
    Stream<DynamicTest> jederStandAmFallDerVektorDateiGiltFuerDenBaumJedesStandorts() throws IOException {
        return StreamSupport.stream(StandortLesemodellTest.vektoren().path("cases").spliterator(), false)
                .filter(c -> "stand_am".equals(c.path("familie").asText())
                        && "baum".equals(c.path("ableitung").asText()))
                .map(c -> DynamicTest.dynamicTest(c.path("name").asText(), () -> pruefeFall(c)));
    }

    private static void pruefeFall(JsonNode fall) throws IOException {
        JsonNode szenario = StandortLesemodellTest.szenario(fall.path("input").path("szenario").asText());
        LocalDate stichtag = LocalDate.parse(fall.path("input").path("stichtag").asText());
        Zeilen z = StandortLesemodellTest.zeilen(szenario, Map.of());
        Map<String, String> art = new LinkedHashMap<>();
        szenario.path("orte").forEach(o -> art.put(o.path("kennzeichen").asText(), o.path("art").asText()));
        Map<String, JsonNode> erwartet = new LinkedHashMap<>();
        fall.path("expected").path("orte").forEach(o -> erwartet.put(o.path("kennzeichen").asText(), o));

        for (Map.Entry<String, String> st : art.entrySet()) {
            if (!"standort".equals(st.getValue())) {
                continue;
            }
            String kz = st.getKey();
            OrtsbaumAmStichtag baum = OrtsbaumLesemodell.ortsbaum(z, StandortLesemodellTest.id(kz), stichtag)
                    .orElseThrow();
            assertThat(baum.stichtag()).isEqualTo(stichtag);
            JsonNode s = erwartet.get(kz);
            if (s == null) {
                // Am Stichtag nicht im Baum: kein Gebäude, kein „direkt am Standort“, keine Summe.
                assertThat(baum.standort().bestand()).as("%s", kz).isNotEqualTo("vorhanden");
                assertThat(baum.gebaeude()).isEmpty();
                assertThat(baum.direktAmStandort()).isNull();
                assertThat(baum.summeGebaeudeM2()).isNull();
                continue;
            }
            assertThat(baum.summeGebaeudeM2()).as("Summe %s", kz).isEqualTo(zahl(s.path("summe_gebaeude_m2")));
            assertThat(baum.gebaeudeOhneFlaeche()).as("ohne Fläche %s", kz)
                    .containsExactlyElementsOf(ids(s.path("gebaeude_ohne_flaeche")));
            assertThat(baum.standort().flaecheM2()).isEqualTo(zahl(s.path("flaeche_m2")));

            List<String> gebaeude = kinder(erwartet, art, kz, "gebaeude");
            assertThat(baum.gebaeude()).extracting(Gebaeude::kurzzeichen).as("Gebäude %s", kz)
                    .containsExactlyElementsOf(gebaeude);
            for (Gebaeude g : baum.gebaeude()) {
                JsonNode e = erwartet.get(g.kurzzeichen());
                assertThat(g.flaecheM2()).as("Fläche %s", g.kurzzeichen()).isEqualTo(zahl(e.path("flaeche_m2")));
                assertThat(g.flaecheQuelle()).isEqualTo(text(e.path("flaeche_quelle")));
                assertThat(g.messstellenZahl()).isNull();
                assertThat(g.bereiche()).extracting(Bereich::kurzzeichen).as("Bereiche %s", g.kurzzeichen())
                        .containsExactlyElementsOf(kinder(erwartet, art, g.kurzzeichen(), "bereich"));
                for (Bereich b : g.bereiche()) {
                    assertThat(b.flaecheM2()).isEqualTo(zahl(erwartet.get(b.kurzzeichen()).path("flaeche_m2")));
                    assertThat(b.messstellenZahl()).isNull();
                }
            }
            assertThat(baum.direktAmStandort().bereiche()).extracting(Bereich::kurzzeichen)
                    .as("direkt am Standort %s", kz)
                    .containsExactlyElementsOf(kinder(erwartet, art, kz, "bereich"));
            assertThat(baum.direktAmStandort().messstellenZahl()).isNull();
        }
    }

    @Test
    void einFremderOderUnbekannterStandortHatKeinenBaum() throws IOException {
        Zeilen z = StandortLesemodellTest.zeilen(StandortLesemodellTest.szenario("ahrenberg"), Map.of());
        assertThat(OrtsbaumLesemodell.ortsbaum(z, UUID.randomUUID(), LocalDate.of(2027, 3, 15))).isEmpty();
    }

    @Test
    void gueltigAbUndBisSindDasIntervallAmStichtag() throws IOException {
        // Halle 2 hängt bis 28.02.2027 an Werk Ahrenberg, ab 01.03.2027 an Werk Ahrenberg Nord.
        Zeilen z = StandortLesemodellTest.zeilen(StandortLesemodellTest.szenario("ahrenberg"), Map.of());
        Gebaeude feb = OrtsbaumLesemodell.ortsbaum(z, StandortLesemodellTest.id("ST-1"),
                LocalDate.of(2027, 2, 15)).orElseThrow().gebaeude().get(1);
        assertThat(feb.kurzzeichen()).isEqualTo("G-2");
        assertThat(feb.gueltigAb()).isEqualTo(LocalDate.of(2026, 10, 1));
        assertThat(feb.gueltigBis()).isEqualTo(LocalDate.of(2027, 2, 28));
        Gebaeude mrz = OrtsbaumLesemodell.ortsbaum(z, StandortLesemodellTest.id("ST-3"),
                LocalDate.of(2027, 3, 15)).orElseThrow().gebaeude().get(0);
        assertThat(mrz.kurzzeichen()).isEqualTo("G-2");
        assertThat(mrz.gueltigAb()).isEqualTo(LocalDate.of(2027, 3, 1));
        assertThat(mrz.gueltigBis()).isNull();
        // E11: die Bereiche ziehen mit.
        assertThat(mrz.bereiche()).extracting(Bereich::kurzzeichen).containsExactly("B-3", "B-4", "B-5");
    }

    /** Die Kinder eines Knotens am Stichtag, in der Reihenfolge des Szenarios (des Anlegens). */
    private static List<String> kinder(Map<String, JsonNode> erwartet, Map<String, String> art, String eltern,
            String kindArt) {
        List<String> out = new ArrayList<>();
        for (Map.Entry<String, String> a : art.entrySet()) {
            JsonNode e = erwartet.get(a.getKey());
            if (e != null && kindArt.equals(a.getValue()) && eltern.equals(e.path("eltern").asText())) {
                out.add(a.getKey());
            }
        }
        return out;
    }

    private static List<UUID> ids(JsonNode kennzeichen) {
        List<UUID> out = new ArrayList<>();
        kennzeichen.forEach(k -> out.add(StandortLesemodellTest.id(k.asText())));
        return out;
    }

    private static Integer zahl(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : n.asInt();
    }

    private static String text(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : n.asText();
    }
}
