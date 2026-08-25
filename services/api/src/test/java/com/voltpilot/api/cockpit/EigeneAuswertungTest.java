package com.voltpilot.api.cockpit;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.cockpit.EigeneAuswertung.CustomBaustein;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der Vertrag der EHRLICHKEITSREGEL (Anwendungs-Programm Stufe 5):
 * {@link EigeneAuswertung} fällt für JEDEN Fall der EINEN geteilten Vektor-Datei
 * ({@code docs/contracts/v2/eigene-auswertung-vectors.json}) dasselbe Urteil wie
 * der TS-Zwilling ({@code frontend/portal/src/eigeneAuswertung.test.ts} fährt
 * dieselbe Datei).
 *
 * <p>Rein; läuft immer (kein Docker, keine DB, keine Uhr). Die Reise über die
 * echten Routen steht in {@code CockpitLayoutApiTest}.
 */
class EigeneAuswertungTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt
    // zwei Ebenen darüber.
    private static final Path VECTORS =
            Path.of("..", "..", "docs", "contracts", "v2", "eigene-auswertung-vectors.json");

    private static JsonNode vectors() throws Exception {
        return MAPPER.readTree(Files.readString(VECTORS));
    }

    @TestFactory
    List<DynamicTest> dieKanalartKommtAusDemNamen() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode v : vectors().path("kanalart")) {
            String channel = v.path("channel").asText();
            String erwartet = v.path("kanalart").asText();
            tests.add(DynamicTest.dynamicTest(channel + " -> " + erwartet,
                    () -> assertThat(EigeneAuswertung.kanalart(channel)).isEqualTo(erwartet)));
        }
        assertThat(tests).isNotEmpty();
        return tests;
    }

    @TestFactory
    List<DynamicTest> jedeKombinationAusDenVektoren() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode v : vectors().path("erlaubt")) {
            String name = v.path("name").asText();
            String channel = v.path("channel").asText();
            for (String agg : EigeneAuswertung.AGGREGATE) {
                boolean erwartet = v.path(agg).asBoolean();
                tests.add(DynamicTest.dynamicTest(name + " · " + agg, () -> {
                    assertThat(EigeneAuswertung.erlaubt(channel, agg)).isEqualTo(erwartet);
                    // Und die Umkehrung: genau dann gibt es einen GRUND, wenn es
                    // nicht erlaubt ist — nie einen Grund ohne Ablehnung und nie
                    // eine Ablehnung ohne Grund.
                    assertThat(EigeneAuswertung.grund(channel, agg, null) == null)
                            .isEqualTo(erwartet);
                }));
            }
        }
        assertThat(tests).isNotEmpty();
        return tests;
    }

    @Test
    void dieVektorDateiFuehrtDasVokabularDieserKlasse() throws Exception {
        JsonNode v = vectors();
        assertThat(strings(v.path("aggregate"))).isEqualTo(EigeneAuswertung.AGGREGATE);
        assertThat(strings(v.path("darstellung"))).isEqualTo(EigeneAuswertung.DARSTELLUNGEN);
        assertThat(strings(v.path("kanalarten"))).containsExactlyInAnyOrder(
                EigeneAuswertung.ART_ENERGIE, EigeneAuswertung.ART_LEISTUNG,
                EigeneAuswertung.ART_ANTEIL, EigeneAuswertung.ART_MESSWERT);
    }

    @Test
    void dieGruendeDerVektorDateiSindDieGruendeDieserKlasse() throws Exception {
        JsonNode g = vectors().path("gruende");
        assertThat(EigeneAuswertung.grund("pv_power_kw", "tagessumme", "PV-Leistung"))
                .isEqualTo(g.path("tagessumme_leistung").asText());
        assertThat(EigeneAuswertung.grund("soc_pct", "tagessumme", "Ladestand"))
                .isEqualTo(g.path("tagessumme_anteil").asText());
        assertThat(EigeneAuswertung.grund("temperature_c", "tagessumme", "Temperatur"))
                .isEqualTo(g.path("tagessumme_messwert").asText());
        assertThat(EigeneAuswertung.grund("energy_kwh", "tagesmax", "Energie"))
                .isEqualTo(g.path("tagesmax_energie").asText());
        assertThat(EigeneAuswertung.grund("energy_kwh", "tagesmittel", "Energie"))
                .isEqualTo(g.path("tagesmittel_energie").asText());
    }

    @Test
    void jetztIstAufJedemKanalEhrlich() {
        // Der jüngste gemeldete Wert ist genau das, was das Gerät gemeldet hat —
        // darüber gibt es auf keinem Kanal etwas zu streiten.
        for (String channel : List.of("energy_kwh", "pv_power_kw", "soc_pct", "temperature_c",
                "was_auch_immer")) {
            assertThat(EigeneAuswertung.erlaubt(channel, EigeneAuswertung.AGG_JETZT))
                    .as(channel).isTrue();
            assertThat(EigeneAuswertung.erlaubteAggregate(channel)).as(channel)
                    .contains(EigeneAuswertung.AGG_JETZT);
        }
    }

    @Test
    void einEnergieKanalKenntNurStandUndZuwachs() {
        assertThat(EigeneAuswertung.erlaubteAggregate("energy_kwh"))
                .containsExactly("jetzt", "tagessumme");
    }

    @Test
    void jederAndereKanalKenntAllesAusserDerSumme() {
        for (String channel : List.of("pv_power_kw", "soc_pct", "temperature_c", "kesselfuellung")) {
            assertThat(EigeneAuswertung.erlaubteAggregate(channel)).as(channel)
                    .containsExactly("jetzt", "tagesmax", "tagesmittel");
        }
    }

    @Test
    void einUnbekanntesAggregatIstNieErlaubt() {
        assertThat(EigeneAuswertung.erlaubt("pv_power_kw", "tagesmedian")).isFalse();
        assertThat(EigeneAuswertung.erlaubt("pv_power_kw", null)).isFalse();
        assertThat(EigeneAuswertung.erlaubteAggregate("pv_power_kw"))
                .doesNotContain("tagesmedian");
    }

    // --- Form -------------------------------------------------------------

    private static CustomBaustein gut() {
        return new CustomBaustein("eigen:a1b2c3", "Wärmepumpe jetzt", "kachel",
                "11111111-1111-1111-1111-111111111111", "power_kw", "jetzt");
    }

    @Test
    void eineVollstaendigeDefinitionGehtDurch() {
        assertThat(EigeneAuswertung.pruefeForm(gut())).isNull();
    }

    @Test
    void jedeFormAblehnungNenntIhrenGrundAufDeutsch() {
        record Fall(CustomBaustein b, String enthaelt) {}
        List<Fall> faelle = List.of(
                new Fall(null, "keine eigene Auswertung"),
                new Fall(new CustomBaustein("kacheln", "T", "kachel", "e", "power_kw", "jetzt"),
                        "beginnt mit"),
                new Fall(new CustomBaustein("eigen:", "T", "kachel", "e", "power_kw", "jetzt"),
                        "kein gültiger Schlüssel"),
                new Fall(new CustomBaustein("eigen:A-B", "T", "kachel", "e", "power_kw", "jetzt"),
                        "kein gültiger Schlüssel"),
                new Fall(new CustomBaustein("eigen:a1", "  ", "kachel", "e", "power_kw", "jetzt"),
                        "Überschrift"),
                new Fall(new CustomBaustein("eigen:a1", "x".repeat(61), "kachel", "e", "power_kw",
                        "jetzt"), "länger als"),
                new Fall(new CustomBaustein("eigen:a1", "T", "torte", "e", "power_kw", "jetzt"),
                        "Unbekannte Darstellung"),
                new Fall(new CustomBaustein("eigen:a1", "T", "kachel", "", "power_kw", "jetzt"),
                        "Komponente"),
                new Fall(new CustomBaustein("eigen:a1", "T", "kachel", "e", "", "jetzt"),
                        "Messwert"),
                new Fall(new CustomBaustein("eigen:a1", "T", "kachel", "e", "power_kw", "median"),
                        "Unbekannte Kennzahl"));
        for (Fall f : faelle) {
            String grund = EigeneAuswertung.pruefeForm(f.b());
            assertThat(grund).as(String.valueOf(f.enthaelt())).isNotNull();
            assertThat(grund).contains(f.enthaelt());
        }
    }

    @Test
    void einDoppelterSchluesselWirdBenannt() {
        CustomBaustein a = gut();
        assertThat(EigeneAuswertung.ersterDoppelter(List.of(a, a))).isEqualTo("eigen:a1b2c3");
        assertThat(EigeneAuswertung.ersterDoppelter(List.of(a))).isNull();
        assertThat(EigeneAuswertung.ersterDoppelter(List.of())).isNull();
    }

    @Test
    void nurEinEigenPraefixIstEineEigeneAuswertung() {
        assertThat(EigeneAuswertung.istEigen("eigen:a")).isTrue();
        assertThat(EigeneAuswertung.istEigen("kacheln")).isFalse();
        assertThat(EigeneAuswertung.istEigen(null)).isFalse();
    }

    private static List<String> strings(JsonNode array) {
        List<String> out = new ArrayList<>();
        for (JsonNode n : array) {
            out.add(n.asText());
        }
        return out;
    }
}
