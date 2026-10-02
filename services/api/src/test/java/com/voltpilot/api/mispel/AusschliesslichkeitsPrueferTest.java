package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.mispel.AusschliesslichkeitsPruefer.Ergebnis;
import com.voltpilot.api.mispel.AusschliesslichkeitsPruefer.Monat;
import com.voltpilot.api.mispel.AusschliesslichkeitsPruefer.Viertelstunde;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * MiSpeL MP-2: der Ausschließlichkeits-Prüfer rechnet (1)¼, (2)¼, (3)–(6), (9)–(11) wie Anlage 1. Prüfnachweis ist
 * die Beispielrechnung 1 der BNetzA (A1 S. 15: 100 kWh Speicherverbrauch, 130 kWh Netzbezug, 50 kWh PV → 100 kWh
 * Netzstrom im Speicher) — gelesen aus dem Fall {@code bnetza-beispielrechnungen-speichervorrang} der MP-4-Vektoren
 * ({@code docs/contracts/v2/mispel-abgrenzung-vectors.json}),
 * nicht abgeschrieben. Dazu jeder Fall der Vektor-Datei mit Speicherzähler Z2 (A1, A5, A5-Variante): dieselben
 * Formeln, dieselben Zahlen. Rein: ohne Spring, ohne DB.
 */
class AusschliesslichkeitsPrueferTest {

    private static final ObjectMapper MAPPER = new ObjectMapper()
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS);
    /** Weit hinter jedem Vektor-Jahr: alle Monate vollständig im Stand. */
    private static final Instant SPAETER = Instant.parse("2100-01-01T00:00:00Z");
    private static final List<String> FORMELN = List.of("(3)", "(4)", "(5)", "(6)", "(9)", "(10)", "(11)");

    private static JsonNode vektoren() throws Exception {
        return MAPPER.readTree(Files.readString(MispelAbgrenzungVectorsTest.VECTORS));
    }

    private static BigDecimal kwh(String s) {
        return new BigDecimal(s);
    }

    private static Viertelstunde qh(String beginn, String z1nb, String z1ne, String z2v, String z2e) {
        return new Viertelstunde(OffsetDateTime.parse(beginn).toInstant(), z1nb == null ? null : kwh(z1nb),
                z1ne == null ? null : kwh(z1ne), z2v == null ? null : kwh(z2v), z2e == null ? null : kwh(z2e));
    }

    private static List<Viertelstunde> viertelstunden(JsonNode fall) {
        List<Viertelstunde> out = new ArrayList<>();
        for (JsonNode v : fall.get("viertelstunden")) {
            out.add(new Viertelstunde(OffsetDateTime.parse(v.get("beginn").asText()).toInstant(),
                    v.get("Z1NB¼").decimalValue(), v.get("Z1NE¼").decimalValue(), v.get("Z2V¼").decimalValue(),
                    v.get("Z2E¼").decimalValue()));
        }
        return out;
    }

    private static Monat monat(Ergebnis e, String monat) {
        return e.monate().stream().filter(m -> m.monat().equals(YearMonth.parse(monat))).findFirst().orElseThrow();
    }

    private static void gleich(BigDecimal ist, BigDecimal soll, String was) {
        assertThat(ist.compareTo(soll)).as("%s: %s statt %s", was, ist, soll).isZero();
    }

    /** Pruefnachweis MP-2: Beispielrechnung 1, A1 S. 15 (Abb. 1), und Beispielrechnung 2, A1 S. 16 (Abb. 2). */
    @Test
    void beispielrechnungenDerBnetzaSpeichervorrang() throws Exception {
        JsonNode fall = null;
        for (JsonNode f : vektoren().get("faelle")) {
            if (f.get("name").asText().equals("bnetza-beispielrechnungen-speichervorrang")) {
                fall = f;
            }
        }
        assertThat(fall).as("Fall der MP-4-Vektoren").isNotNull();
        List<Viertelstunde> qh = viertelstunden(fall);

        // Beispielrechnung 1: 130 kWh Netzbezug, 100 kWh Speicherverbrauch (die 50 kWh PV misst in A1 kein Zähler).
        Viertelstunde br1 = qh.get(0);
        gleich(br1.z1nb(), kwh("130"), "Z1NB¼");
        gleich(br1.z2v(), kwh("100"), "Z2V¼");
        gleich(br1.formel1(), kwh("100"), "(1)¼ Beispielrechnung 1");
        // Beispielrechnung 2: 100 kWh Speichererzeugung, 80 kWh Netzeinspeisung → 80 kWh aus dem Speicher.
        gleich(qh.get(1).formel2(), kwh("80"), "(2)¼ Beispielrechnung 2");

        Ergebnis e = AusschliesslichkeitsPruefer.pruefe(2027, qh, SPAETER);
        Monat maerz = monat(e, "2027-03");
        gleich(maerz.formeln().get("(9)"), kwh("100"), "(9)");
        gleich(maerz.formeln().get("(11)"), kwh("80"), "(11)");
        assertThat(maerz.viertelstundenNetzstromImSpeicher()).isEqualTo(1);
        assertThat(maerz.viertelstundenSpeicherEinspeisung()).isEqualTo(1);
        assertThat(e.jahr().netzstromImSpeicher()).isTrue();
        assertThat(e.jahr().monateMitNetzstromImSpeicher()).isEqualTo(1);
        gleich(e.jahr().formeln().get("(9)"), kwh("100"), "(9) im Jahr");
    }

    /** Jeder Vektor-Fall mit Speicherzähler: (3)–(6), (9)–(11) je Monat wie erwartet, je Viertelstunde (1)¼, (2)¼. */
    @TestFactory
    List<DynamicTest> jederVektorFallMitSpeicherzaehler() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode fall : vektoren().get("faelle")) {
            JsonNode erste = fall.get("viertelstunden").get(0);
            if (!erste.has("Z2V¼")) {
                continue; // A10, A11: nur Z1, kein Speicherzähler
            }
            tests.add(DynamicTest.dynamicTest(fall.get("name").asText(), () -> {
                List<Viertelstunde> qh = viertelstunden(fall);
                JsonNode erwartetQh = fall.get("erwartet").get("viertelstunden");
                for (int i = 0; i < qh.size(); i++) {
                    gleich(qh.get(i).formel1(), erwartetQh.get(i).get("(1)¼").decimalValue(), "(1)¼ #" + i);
                    gleich(qh.get(i).formel2(), erwartetQh.get(i).get("(2)¼").decimalValue(), "(2)¼ #" + i);
                }
                Map<String, Monat> monate = new TreeMap<>();
                List<Integer> jahre = new ArrayList<>();
                fall.get("erwartet").get("jahre").fieldNames().forEachRemaining(j -> jahre.add(Integer.valueOf(j)));
                for (int jahr : jahre) {
                    AusschliesslichkeitsPruefer.pruefe(jahr, qh, SPAETER).monate()
                            .forEach(m -> monate.put(m.monat().toString(), m));
                }
                // Rumpfmonate (A5) teilen einen Kalendermonat; der Prüfer summiert den ganzen Monat.
                Map<String, Map<String, BigDecimal>> soll = new TreeMap<>();
                fall.get("erwartet").get("monate").fields().forEachRemaining(m -> {
                    String kalendermonat = m.getKey().substring(0, 7);
                    Map<String, BigDecimal> s = soll.computeIfAbsent(kalendermonat, k -> new HashMap<>());
                    for (String f : FORMELN) {
                        s.merge(f, m.getValue().get(f).decimalValue(), BigDecimal::add);
                    }
                });
                assertThat(soll).isNotEmpty();
                soll.forEach((m, formeln) -> formeln.forEach((f, wert) ->
                        gleich(monate.get(m).formeln().get(f), wert, m + " " + f)));
            }));
        }
        assertThat(tests).as("A1-, A5- und A5-Variante-Fälle").hasSizeGreaterThanOrEqualTo(9);
        return tests;
    }

    /** Monate nach gesetzlicher Zeit: die erste Stunde des Monats gehört nicht in den Vormonat (Regel zeit). */
    @Test
    void monatsgrenzeInGesetzlicherZeit() {
        Ergebnis e = AusschliesslichkeitsPruefer.pruefe(2026, List.of(
                qh("2026-09-30T23:45:00+02:00", "2", "0", "1", "0"),
                qh("2026-10-01T00:00:00+02:00", "3", "0", "5", "0")), SPAETER);
        gleich(monat(e, "2026-09").formeln().get("(9)"), kwh("1"), "September");
        gleich(monat(e, "2026-10").formeln().get("(9)"), kwh("3"), "Oktober");
        assertThat(e.monate()).hasSize(12);
    }

    /** Soll-Viertelstunden: März 2026 hat eine Stunde weniger (2 972), Oktober eine mehr (2 980); das Jahr 35 040. */
    @Test
    void sollViertelstundenMitZeitumstellung() {
        Ergebnis e = AusschliesslichkeitsPruefer.pruefe(2026, List.of(), SPAETER);
        assertThat(monat(e, "2026-03").viertelstundenSoll()).isEqualTo(31 * 96 - 4);
        assertThat(monat(e, "2026-10").viertelstundenSoll()).isEqualTo(31 * 96 + 4);
        assertThat(e.jahr().viertelstundenSoll()).isEqualTo(365 * 96);
        assertThat(e.jahr().luecken()).isEqualTo(365 * 96);
        assertThat(e.jahr().netzstromImSpeicher()).isFalse();
    }

    /** Unbekannt ist keine Null: fehlt ein Zählerwert, ist die Viertelstunde eine Lücke und in keiner Summe. */
    @Test
    void fehlenderWertIstLueckeNichtNull() {
        Ergebnis e = AusschliesslichkeitsPruefer.pruefe(2026, List.of(
                qh("2026-05-04T12:00:00+02:00", "4", "0", null, "0"),
                qh("2026-05-04T12:15:00+02:00", "1", "0", "2", "0")), SPAETER);
        Monat mai = monat(e, "2026-05");
        assertThat(mai.viertelstundenMitWerten()).isEqualTo(1);
        assertThat(mai.luecken()).isEqualTo(31 * 96 - 1);
        gleich(mai.formeln().get("(3)"), kwh("1"), "(3) ohne Lücke");
        gleich(mai.formeln().get("(9)"), kwh("1"), "(9)");
        gleich(mai.formeln().get("(10)"), kwh("1"), "(10) = (5) – (9)");
    }

    /** Der Stand schneidet: nur Monate, die vorher begonnen haben, und nur Viertelstunden davor. */
    @Test
    void standSchneidetDasLaufendeJahr() {
        Instant stand = OffsetDateTime.parse("2026-03-02T00:00:00+01:00").toInstant();
        Ergebnis e = AusschliesslichkeitsPruefer.pruefe(2026, List.of(
                qh("2026-03-01T23:45:00+01:00", "1", "0", "1", "0"),
                qh("2026-03-02T00:00:00+01:00", "9", "0", "9", "0")), stand);
        assertThat(e.monate()).extracting(Monat::monat)
                .containsExactly(YearMonth.of(2026, 1), YearMonth.of(2026, 2), YearMonth.of(2026, 3));
        assertThat(monat(e, "2026-03").viertelstundenSoll()).isEqualTo(96);
        gleich(e.jahr().formeln().get("(9)"), kwh("1"), "(9) bis zum Stand");
    }

    /** Toleranzstaffel: strenge Zählung ab 0, Schwellen nur zur Einordnung. */
    @Test
    void toleranzStaffelZaehltNurUeberDerSchwelle() {
        Ergebnis e = AusschliesslichkeitsPruefer.pruefe(2026, List.of(
                qh("2026-06-01T12:00:00+02:00", "0.005", "0", "3", "0"),
                qh("2026-06-01T12:15:00+02:00", "0.05", "0", "3", "0"),
                qh("2026-06-01T12:30:00+02:00", "0.5", "0", "3", "0"),
                qh("2026-06-01T12:45:00+02:00", "2", "0", "3", "0"),
                qh("2026-06-01T13:00:00+02:00", "7", "0", "0", "0")), SPAETER);
        Monat juni = monat(e, "2026-06");
        assertThat(juni.viertelstundenNetzstromImSpeicher()).isEqualTo(4);
        gleich(juni.formeln().get("(9)"), kwh("2.555"), "(9) streng");
        assertThat(juni.toleranzStaffel()).extracting(s -> s.viertelstunden()).containsExactly(3, 2, 1);
        gleich(juni.toleranzStaffel().get(0).kwh(), kwh("2.55"), "über 0,01 kWh");
        gleich(juni.toleranzStaffel().get(2).kwh(), kwh("2"), "über 1 kWh");
        assertThat(e.jahr().toleranzStaffel()).isEqualTo(juni.toleranzStaffel());
    }

    /** Laden nur ohne Netzbezug und Einspeisen bei Netzbezug: kein Netzstrom im Speicher, aber Speicher-Einspeisung. */
    @Test
    void reinerEeSpeicherHatKeinenNetzstrom() {
        Ergebnis e = AusschliesslichkeitsPruefer.pruefe(2026, List.of(
                qh("2026-07-01T12:00:00+02:00", "0", "4", "3", "0"),
                qh("2026-07-01T20:00:00+02:00", "0", "2", "0", "2.5")), SPAETER);
        assertThat(e.jahr().netzstromImSpeicher()).isFalse();
        assertThat(e.jahr().viertelstundenNetzstromImSpeicher()).isZero();
        gleich(e.jahr().formeln().get("(11)"), kwh("2"), "(11)");
        assertThat(e.jahr().viertelstundenSpeicherEinspeisung()).isEqualTo(1);
    }

    @Test
    void negativerZaehlerwertIstEinFehler() {
        assertThatThrownBy(() -> qh("2026-07-01T12:00:00+02:00", "-1", "0", "0", "0"))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
