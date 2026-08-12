package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.components.SelfBuildDefinition.Channel;
import com.voltpilot.api.components.SelfBuildDefinition.NormalizedChannel;
import com.voltpilot.api.components.SelfBuildDefinition.Result;
import com.voltpilot.api.components.SelfBuildDefinition.Transport;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die Regeln der Selbstbau-Tür, ohne Docker und ohne Spring
 * (Einheitsmodell Stufe 3).
 */
class SelfBuildDefinitionTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static Transport lan() {
        return new Transport("192.168.1.50", 502, 1);
    }

    private static Channel temp() {
        return new Channel("Wassertemperatur Speicher oben", "°C", "holding", 100, "s16", "big",
                0.1, 0.0, 10);
    }

    // -- LAN-only -----------------------------------------------------------

    /**
     * ⚠ Der Beweis, dass Portal und Box DIESELBE Regel sprechen: die Vektoren
     * kommen aus der GETEILTEN Datei, die auch der Go-Zwilling liest. Eine
     * eigene Liste hier wäre eine zweite Wahrheit, die lautlos auseinanderläuft.
     */
    @Test
    void theLanRuleIsTheSharedVectorFileAndNothingElse() throws Exception {
        JsonNode vectors = MAPPER.readTree(Files.readString(
                Path.of("..", "..", "docs", "contracts", "lan-host-vectors.json")));

        assertThat(vectors.path("private")).isNotEmpty();
        assertThat(vectors.path("public")).isNotEmpty();

        for (JsonNode v : vectors.path("private")) {
            String host = v.path("host").asText();
            assertThat(SelfBuildDefinition.isPrivateHost(host))
                    .as("privat: %s (%s)", host, v.path("why").asText())
                    .isTrue();
        }
        for (JsonNode v : vectors.path("public")) {
            String host = v.path("host").asText();
            assertThat(SelfBuildDefinition.isPrivateHost(host))
                    .as("NICHT privat: %s (%s)", host, v.path("why").asText())
                    .isFalse();
        }
    }

    @Test
    void aPublicHostIsRefusedByNameAndTheRefusalNamesTheWayOut() {
        Result r = SelfBuildDefinition.validate(new Transport("8.8.8.8", 502, 1), List.of(temp()));

        assertThat(r.ok()).isFalse();
        assertThat(r.errors()).contains(SelfBuildDefinition.HOST_NOT_PRIVATE);
        // Der Satz nennt den WEG, nicht nur die Ablehnung.
        assertThat(SelfBuildDefinition.HOST_NOT_PRIVATE).contains("IP-Adresse");
    }

    /**
     * Ein DNS-Name wird auf diesem Pfad nie aufgelöst: die Frage lautet „ist
     * diese ZEICHENKETTE nachweisbar privat", nicht „worauf zeigt sie gerade".
     * Ein Auflöser im Request-Thread wäre zusätzlich ein Netzzugriff mit
     * fremdem Timeout.
     */
    @Test
    void aNameIsJudgedByItsFormNeverByResolvingIt() {
        long started = System.nanoTime();
        assertThat(SelfBuildDefinition.isPrivateHost("nicht-existent.invalid")).isFalse();
        assertThat(SelfBuildDefinition.isPrivateHost("localhost")).isFalse();
        long ms = (System.nanoTime() - started) / 1_000_000;
        assertThat(ms).as("kein DNS auf dem Validierungspfad").isLessThan(200);
    }

    // -- Poll-Budget --------------------------------------------------------

    @Test
    void thePollBudgetBoundsChannelCountAndReadInterval() {
        List<Channel> many = new ArrayList<>();
        for (int i = 0; i <= SelfBuildDefinition.MAX_CHANNELS; i++) {
            many.add(new Channel("Wert " + i, "kW", "holding", 100 + i, "u16", "big", 1.0, 0.0, 10));
        }
        Result tooMany = SelfBuildDefinition.validate(lan(), many);
        assertThat(tooMany.ok()).isFalse();
        assertThat(tooMany.errors()).anyMatch(e -> e.contains("Höchstens 16 Messwerte"));

        Result tooFast = SelfBuildDefinition.validate(lan(), List.of(
                new Channel("Schnell", "kW", "holding", 100, "u16", "big", 1.0, 0.0, 1)));
        assertThat(tooFast.ok()).isFalse();
        assertThat(tooFast.errors()).anyMatch(e -> e.contains("mindestens 5 Sekunden"));

        // Genau an der Grenze ist erlaubt - eine Grenze, die ihre eigene Zahl
        // ablehnt, wäre eine andere Grenze.
        assertThat(SelfBuildDefinition.validate(lan(), List.of(
                new Channel("Genau", "kW", "holding", 100, "u16", "big", 1.0, 0.0, 5))).ok())
                .isTrue();
    }

    @Test
    void theReadLoadIsPrecomputedAndWarnsOnlyWhenItIsWorthIt() {
        Result calm = SelfBuildDefinition.validate(lan(), List.of(temp()));
        String calmNote = SelfBuildDefinition.readLoadNote(calm.channels());
        assertThat(calmNote).contains("1 Messwert").contains("0,1");
        assertThat(calmNote).doesNotContain("Abstand erhöhen");

        List<Channel> busy = new ArrayList<>();
        for (int i = 0; i < 12; i++) {
            busy.add(new Channel("Wert " + i, "kW", "holding", 200 + i, "u16", "big", 1.0, 0.0, 5));
        }
        Result loaded = SelfBuildDefinition.validate(lan(), busy);
        assertThat(loaded.ok()).isTrue();
        assertThat(SelfBuildDefinition.readLoadNote(loaded.channels()))
                .contains("2,4").contains("Abstand erhöhen");

        assertThat(SelfBuildDefinition.readLoadNote(List.of())).isNull();
    }

    // -- Kanal-Form ---------------------------------------------------------

    @Test
    void theChannelKeyIsDerivedFromThePlainNameNeverTyped() {
        assertThat(SelfBuildDefinition.slug("Wassertemperatur Speicher oben", Set()))
                .isEqualTo("wassertemperatur_speicher_oben");
        assertThat(SelfBuildDefinition.slug("Außentemperatur (Nord)", Set()))
                .isEqualTo("aussentemperatur_nord");
        assertThat(SelfBuildDefinition.slug("Zähler Süd — Bezug", Set()))
                .isEqualTo("zaehler_sued_bezug");
        // Eine Kennung beginnt mit einem Buchstaben (das offene Kanal-Vokabular
        // der Registry: ^[a-z][a-z0-9_]{0,63}$).
        assertThat(SelfBuildDefinition.slug("3-Phasen-Strom", Set())).startsWith("m_");
        assertThat(SelfBuildDefinition.slug("!!!", Set())).isNull();
        assertThat(SelfBuildDefinition.slug("", Set())).isNull();
    }

    @Test
    void twoChannelsMayShareAPlainNameButNeverTheSameKey() {
        Result r = SelfBuildDefinition.validate(lan(), List.of(
                new Channel("Temperatur", "°C", "holding", 100, "s16", "big", 0.1, 0.0, 10),
                new Channel("Temperatur", "°C", "holding", 101, "s16", "big", 0.1, 0.0, 10)));

        assertThat(r.ok()).isTrue();
        assertThat(r.channels()).extracting(NormalizedChannel::slug)
                .containsExactly("temperatur", "temperatur_2");
    }

    @Test
    void twoChannelsOnTheSameRegisterAreRefusedByName() {
        Result r = SelfBuildDefinition.validate(lan(), List.of(
                new Channel("Leistung", "kW", "holding", 100, "u16", "big", 1.0, 0.0, 10),
                new Channel("Leistung nochmal", "kW", "holding", 100, "u16", "big", 1.0, 0.0, 10)));

        assertThat(r.ok()).isFalse();
        assertThat(r.errors()).anyMatch(e -> e.contains("dasselbe Register"));
    }

    @Test
    void everyChannelFieldIsBoundedAndTheDefaultsAreFilledIn() {
        Result r = SelfBuildDefinition.validate(lan(), List.of(
                new Channel("Leistung", "kW", null, 7, null, null, null, null, null)));

        assertThat(r.ok()).isTrue();
        NormalizedChannel c = r.channels().get(0);
        assertThat(c.registerKind()).isEqualTo("holding");
        assertThat(c.dataType()).isEqualTo("u16");
        assertThat(c.wordOrder()).isEqualTo("big");
        assertThat(c.scale()).isEqualTo(1.0);
        assertThat(c.offset()).isEqualTo(0.0);
        assertThat(c.minReadIntervalS()).isEqualTo(SelfBuildDefinition.DEFAULT_INTERVAL_S);

        assertThat(bad(new Channel("X", "kW", "coil", 1, "u16", "big", 1.0, 0.0, 10)))
                .anyMatch(e -> e.contains("Holding-Register"));
        assertThat(bad(new Channel("X", "kW", "holding", 70000, "u16", "big", 1.0, 0.0, 10)))
                .anyMatch(e -> e.contains("Registeradresse"));
        assertThat(bad(new Channel("X", "kW", "holding", 1, "u48", "big", 1.0, 0.0, 10)))
                .anyMatch(e -> e.contains("Datentyp"));
        assertThat(bad(new Channel("X", "Bananen", "holding", 1, "u16", "big", 1.0, 0.0, 10)))
                .anyMatch(e -> e.contains("Einheit"));
        // Skalierung 0 macht aus jedem Messwert eine 0 - das ist keine
        // Skalierung, sondern ein stiller Datenverlust.
        assertThat(bad(new Channel("X", "kW", "holding", 1, "u16", "big", 0.0, 0.0, 10)))
                .anyMatch(e -> e.contains("Skalierung"));
        assertThat(bad(new Channel("  ", "kW", "holding", 1, "u16", "big", 1.0, 0.0, 10)))
                .anyMatch(e -> e.contains("Namen vergeben"));
    }

    /** Ohne Messwert liest das Gerät nichts - das ist kein Gerät, sondern eine Adresse. */
    @Test
    void aDeviceWithoutAnyChannelIsRefused() {
        Result r = SelfBuildDefinition.validate(lan(), List.of());
        assertThat(r.ok()).isFalse();
        assertThat(r.errors()).anyMatch(e -> e.contains("mindestens einen Messwert"));
    }

    /** Alle Mängel auf einmal - ein Formular soll nicht drei Runden brauchen. */
    @Test
    void everyProblemIsReportedAtOnce() {
        Result r = SelfBuildDefinition.validate(new Transport("8.8.8.8", 70000, 999), List.of(
                new Channel("", "kW", "holding", 1, "u16", "big", 1.0, 0.0, 10),
                new Channel("Gut", "Bananen", "holding", 2, "u16", "big", 1.0, 0.0, 10)));

        assertThat(r.errors()).hasSizeGreaterThanOrEqualTo(4);
    }

    // -- Plausibilität ist ein HINWEIS, keine Sperre -------------------------

    @Test
    void aScalingMistakeIsPointedAtButNeverBlocks() {
        assertThat(SelfBuildDefinition.hint("%", 1270.0)).contains("Skalierung");
        assertThat(SelfBuildDefinition.hint("°C", 615.0)).contains("Zehntelgrad");
        assertThat(SelfBuildDefinition.hint("kW", 30000.0)).contains("Watt");
        assertThat(SelfBuildDefinition.hint("V", 2300.0)).contains("Zehntelvolt");

        // Plausible Werte bekommen KEINEN Hinweis - ein Hinweis, der immer
        // kommt, wird nicht gelesen.
        assertThat(SelfBuildDefinition.hint("%", 61.5)).isNull();
        assertThat(SelfBuildDefinition.hint("°C", 61.5)).isNull();
        assertThat(SelfBuildDefinition.hint("kW", 30.0)).isNull();
        assertThat(SelfBuildDefinition.hint("", 999999.0)).isNull();
        assertThat(SelfBuildDefinition.hint("%", null)).isNull();

        // Und er SPERRT nichts: dieselbe Definition validiert sauber.
        assertThat(SelfBuildDefinition.validate(lan(), List.of(
                new Channel("Ladestand", "%", "holding", 100, "u16", "big", 1.0, 0.0, 10))).ok())
                .isTrue();
    }

    private static java.util.Set<String> Set() {
        return new LinkedHashSet<>();
    }

    private static List<String> bad(Channel c) {
        Result r = SelfBuildDefinition.validate(lan(), List.of(c));
        assertThat(r.ok()).isFalse();
        return r.errors();
    }
}
