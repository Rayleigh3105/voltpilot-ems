package com.voltpilot.api.anlagencheck;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.anlagencheck.AnlagenCheckRegel.EinheitUrteil;
import com.voltpilot.api.anlagencheck.AnlagenCheckRegel.Modus;
import com.voltpilot.api.anlagencheck.AnlagenCheckRegel.Reihe;
import com.voltpilot.api.anlagencheck.AnlagenCheckRegel.TagWert;
import com.voltpilot.api.anlagencheck.AnlagenCheckRegel.Urteil;
import java.io.InputStream;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

/** Die Regel „fällt ab" gegen ihre Vektoren ({@code anlagencheck/regel-vektoren.json}) und die Tagesbildung. */
class AnlagenCheckRegelTest {

    static Stream<JsonNode> faelle() throws Exception {
        try (InputStream in = AnlagenCheckRegelTest.class.getResourceAsStream("/anlagencheck/regel-vektoren.json")) {
            JsonNode root = new ObjectMapper().readTree(in);
            List<JsonNode> out = new ArrayList<>();
            root.get("faelle").forEach(out::add);
            return out.stream();
        }
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("faelle")
    void vektor(JsonNode fall) {
        LocalDate bis = LocalDate.parse(fall.get("bis").asText());
        List<Reihe> reihen = new ArrayList<>();
        for (JsonNode r : fall.get("reihen")) {
            JsonNode tage = r.get("tage");
            List<TagWert> werte = new ArrayList<>();
            for (int i = 0; i < tage.size(); i++) {
                JsonNode t = tage.get(i);
                LocalDate d = bis.minusDays(tage.size() - 1L - i);
                werte.add(new TagWert(d, zahl(t.get(0)), zahl(t.get(1)), t.get(2).asBoolean()));
            }
            reihen.add(new Reihe(r.get("id").asText(), r.get("id").asText(), r.get("kwp").asDouble(), werte));
        }
        Set<LocalDate> abgeregelt = new HashSet<>();
        fall.get("abgeregelt").forEach(d -> abgeregelt.add(LocalDate.parse(d.asText())));

        Urteil u = AnlagenCheckRegel.rollend(reihen, Modus.valueOf(fall.get("modus").asText()), abgeregelt, bis);

        JsonNode soll = fall.get("erwartet");
        String name = fall.get("name").asText();
        assertThat(u.gesamt().name()).as(name).isEqualTo(soll.get("gesamt").asText());
        assertThat(u.fensterTage()).as(name + " Fenster").isEqualTo(soll.get("fensterTage").asInt());
        assertThat(u.sonnenTage()).as(name + " Sonnentage").isEqualTo(soll.get("sonnenTage").asInt());
        if (soll.has("abgeregelteTage")) {
            assertThat(u.abgeregelteTage()).as(name).isEqualTo(soll.get("abgeregelteTage").asInt());
        }
        for (EinheitUrteil e : u.einheiten()) {
            JsonNode s = soll.get("einheiten").get(e.id());
            assertThat(e.zustand().name()).as(name + " " + e.id()).isEqualTo(s.get(0).asText());
            if (s.get(1).isNull()) {
                assertThat(e.verhaeltnis()).as(name + " " + e.id()).isNull();
            } else {
                assertThat(e.verhaeltnis()).as(name + " " + e.id()).isCloseTo(s.get(1).asDouble(), within(0.0006));
            }
            assertThat(e.wenigerSeit()).as(name + " seit").isEqualTo(datum(s.get(2)));
            assertThat(e.keineWerteSeit()).as(name + " keine Werte seit").isEqualTo(datum(s.get(3)));
        }
    }

    private static Double zahl(JsonNode n) {
        return n == null || n.isNull() ? null : n.asDouble();
    }

    private static LocalDate datum(JsonNode n) {
        return n == null || n.isNull() ? null : LocalDate.parse(n.asText());
    }

    @Test
    void nachtsFehlendIstNullTagsueberEineLuecke() {
        List<Double> stunden = new ArrayList<>();
        List<Boolean> tag = new ArrayList<>();
        for (int h = 0; h < 24; h++) {
            boolean hell = h >= 7 && h < 19; // 12 Tagstunden
            tag.add(hell);
            stunden.add(hell ? 2.0 : null); // der Wechselrichter schläft nachts
        }
        TagWert voll = AnlagenCheckRegel.tagAusStunden(LocalDate.of(2026, 6, 1), stunden, tag, 30.0);
        assertThat(voll.gemessenKwh()).isEqualTo(24.0);
        assertThat(voll.luecke()).isFalse();

        stunden.set(12, null); // eine von 12 Tagstunden: unter einem Zehntel
        assertThat(AnlagenCheckRegel.tagAusStunden(LocalDate.of(2026, 6, 1), stunden, tag, 30.0).luecke()).isFalse();
        stunden.set(13, null); // zwei von 12: mehr als ein Zehntel
        assertThat(AnlagenCheckRegel.tagAusStunden(LocalDate.of(2026, 6, 1), stunden, tag, 30.0).luecke()).isTrue();

        List<Double> leer = new ArrayList<>();
        stunden.forEach(s -> leer.add(null));
        assertThat(AnlagenCheckRegel.tagAusStunden(LocalDate.of(2026, 6, 1), leer, tag, 30.0).gemessenKwh())
                .as("ohne einen einzigen Wert keine Zahl, nie 0").isNull();
    }

    @Test
    void zweiGeraeteEinerEinheitSummierenUndEinSchweigendesMachtDieLuecke() {
        LocalDate d = LocalDate.of(2026, 6, 21);
        List<Instant> h = AnlagenCheckService.stundenDesTages(d);
        Map<Instant, Double> a = new java.util.HashMap<>();
        Map<Instant, Double> b = new java.util.HashMap<>();
        for (Instant s : h) {
            a.put(s, 1.0);
            b.put(s, 0.5);
        }
        TagWert t = AnlagenCheckService.tagWert(d, List.of("a", "b"), Map.of("a", a, "b", b), 20.0, 48.6, 12.7);
        assertThat(t.gemessenKwh()).isEqualTo(36.0);
        assertThat(t.luecke()).isFalse();
        TagWert ohneB = AnlagenCheckService.tagWert(d, List.of("a", "b"), Map.of("a", a), 20.0, 48.6, 12.7);
        assertThat(ohneB.gemessenKwh()).isEqualTo(24.0);
        assertThat(ohneB.luecke()).as("ein Gerät der Einheit schweigt").isTrue();
    }

    @Test
    void zeitumstellungHat23Und25Stunden() {
        assertThat(AnlagenCheckService.stundenDesTages(LocalDate.of(2026, 3, 29))).hasSize(23);
        assertThat(AnlagenCheckService.stundenDesTages(LocalDate.of(2026, 10, 25))).hasSize(25);
    }

    @Test
    void sonnenstandMittagsImSommerHochNachtsUnterDemHorizont() {
        // Pilsting (48,7° N, 12,6° O): Sommermittag ~64°, Mitternacht deutlich darunter.
        double mittag = SonnenStand.hoehe(48.7, 12.6, Instant.parse("2026-06-21T11:10:00Z"));
        assertThat(mittag).isCloseTo(64.5, within(1.0));
        assertThat(SonnenStand.hoehe(48.7, 12.6, Instant.parse("2026-06-21T23:00:00Z"))).isNegative();
        assertThat(SonnenStand.hoehe(48.7, 12.6, Instant.parse("2026-12-21T11:00:00Z"))).isCloseTo(17.9, within(1.0));
    }

    @Test
    void medianUndAbstand() {
        assertThat(AnlagenCheckRegel.median(List.of(1.0, 0.9, 0.95))).isEqualTo(0.95);
        assertThat(AnlagenCheckRegel.median(List.of(1.0, 0.9))).isCloseTo(0.95, within(1e-9));
        assertThat(AnlagenCheckRegel.weniger(0.79, List.of(0.94), Modus.EINHEITEN)).isTrue();
        assertThat(AnlagenCheckRegel.weniger(0.79, List.of(0.93), Modus.EINHEITEN)).isFalse();
        assertThat(AnlagenCheckRegel.weniger(0.69, List.of(), Modus.EINHEITEN)).isTrue();
    }
}
