package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.VerbrauchRegeln.Ergebnis;
import com.voltpilot.api.uems.VerbrauchRegeln.Rohwert;
import com.voltpilot.api.uems.VerbrauchRegeln.Werteteil;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Momentanwert und Intervallmenge aus Teilperioden (UEMS AP-08 IP-3, §4.5) gegen die Vektor-Datei —
 * der Lockstep: eine gröbere Periode aus ihren gespeicherten Viertelstunden ergibt GENAU die
 * Erwartung der Datei.
 *
 * <p>Geprüft wird jede Momentanwert- und Intervallmengen-Erwartung, deren Periode mindestens zwei
 * Viertelstunden lang ist und im Raster liegt: F2 (halbe Stunde) und F24 (halbe Stunde, Stunde).
 * Eine Viertelstunde ohne Rohwert bekommt, wie in der Datenbank, keine Teilperiode. Der
 * Python-Zwilling fährt denselben Lockstep ({@code test_verbrauch.py}).
 */
class VerbrauchWerteteileTest {

    private static final Duration VIERTELSTUNDE = Duration.ofMinutes(15);

    @TestFactory
    List<DynamicTest> ausViertelstunden() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        Set<String> faelle = new TreeSet<>();
        for (JsonNode fall : VerbrauchVectorsTest.lies(VerbrauchVectorsTest.VECTORS).path("cases")) {
            for (JsonNode erwartung : fall.path("expected")) {
                JsonNode reihe = VerbrauchVectorsTest.reihe(fall, erwartung);
                String wertart = reihe.path("wertart").asText();
                Instant von = VerbrauchRegeln.zeit(erwartung.path("von").asText());
                Instant bis = VerbrauchRegeln.zeit(erwartung.path("bis").asText());
                if (!Set.of("momentanwert", "intervallmenge").contains(wertart)
                        || Duration.between(von, bis).compareTo(VIERTELSTUNDE.multipliedBy(2)) < 0
                        || !imRaster(von) || !imRaster(bis)) {
                    continue;
                }
                String name = fall.path("name").asText() + " :: " + erwartung.path("name").asText();
                faelle.add(name);
                tests.add(DynamicTest.dynamicTest(name + " (aus Viertelstunden)", () -> pruefe(fall, erwartung)));
            }
        }
        // Die Abnahme von IP-3 muss darunter sein — sonst prüfte dieser Test am Paket vorbei.
        assertThat(faelle).anyMatch(n -> n.startsWith("f2-") && n.contains("Halbe Stunde"))
                .anyMatch(n -> n.startsWith("f24-") && n.contains("Halbe Stunde 10:30–11:00"))
                .anyMatch(n -> n.startsWith("f24-") && n.contains("Stunde 10:00–11:00"));
        return tests;
    }

    private static void pruefe(JsonNode fall, JsonNode erwartung) {
        JsonNode reihe = VerbrauchVectorsTest.reihe(fall, erwartung);
        String why = fall.path("why").asText();
        Instant von = VerbrauchRegeln.zeit(erwartung.path("von").asText());
        Instant bis = VerbrauchRegeln.zeit(erwartung.path("bis").asText());
        Duration kadenz = Duration.ofSeconds(reihe.path("kadenz_s").asLong());
        boolean intervall = "intervallmenge".equals(reihe.path("wertart").asText());
        boolean integrieren = reihe.path("integrieren").asBoolean(false);

        List<Werteteil> teile = werteteile(reihe, von, bis);
        Ergebnis ist = intervall
                ? VerbrauchRegeln.intervallmengeAusTeilperioden(teile, von, bis, kadenz).teil().ergebnis()
                : VerbrauchRegeln.momentanwertAusTeilperioden(teile, von, bis, kadenz, integrieren).teil().ergebnis();

        VerbrauchVectorsTest.zahl(why + " · menge", erwartung.path("menge"), ist.menge());
        VerbrauchVectorsTest.zahl(why + " · mittel", erwartung.path("mittel"), ist.mittel());
        VerbrauchVectorsTest.zahl(why + " · min", erwartung.path("min"), ist.min());
        VerbrauchVectorsTest.zahl(why + " · max", erwartung.path("max"), ist.max());
        VerbrauchVectorsTest.zahl(why + " · energie_kwh", erwartung.path("energie_kwh"), ist.energieKwh());
        assertThat(ist.zustand()).as(why + " · zustand").isEqualTo(erwartung.path("zustand").asText());
        assertThat(ist.erhalten()).as(why + " · erhalten").isEqualTo(erwartung.path("erhalten").asInt());
        assertThat(ist.erwartet()).as(why + " · erwartet").isEqualTo(erwartung.path("erwartet").asInt());
        assertThat(ist.abdeckungProzent()).as(why + " · abdeckung_prozent")
                .isEqualTo(erwartung.path("abdeckung_prozent").asInt());
        List<String> soll = new ArrayList<>();
        erwartung.path("kennzeichen").forEach(k -> soll.add(k.asText()));
        assertThat(ist.kennzeichen()).as(why + " · kennzeichen").isEqualTo(soll);
    }

    /**
     * Die Viertelstunden als {@link Werteteil} — wie in der Datenbank nur die mit Rohwert, eine Stunde
     * davor und danach (die Nachbarn der Lücke und des Haltens), jede mit den Rohwerten bis zwei
     * Kadenzen über ihre Grenzen hinaus.
     */
    private static List<Werteteil> werteteile(JsonNode reihe, Instant von, Instant bis) {
        List<Rohwert> werte = VerbrauchVectorsTest.rohwerte(reihe);
        Duration kadenz = Duration.ofSeconds(reihe.path("kadenz_s").asLong());
        Duration reichweite = kadenz.multipliedBy(VerbrauchRegeln.HALTEN_FAKTOR);
        boolean intervall = "intervallmenge".equals(reihe.path("wertart").asText());
        List<Werteteil> teile = new ArrayList<>();
        for (Instant q = von.minus(Duration.ofHours(1)); q.isBefore(bis.plus(Duration.ofHours(1)));
                q = q.plus(VIERTELSTUNDE)) {
            Instant qVon = q;
            Instant qBis = q.plus(VIERTELSTUNDE);
            List<Rohwert> fenster = werte.stream()
                    .filter(r -> r.zeit().isAfter(qVon.minus(reichweite)) && !r.zeit().isAfter(qBis.plus(reichweite)))
                    .toList();
            if (intervall) {
                if (fenster.stream().anyMatch(r -> r.zeit().isAfter(qVon) && !r.zeit().isAfter(qBis))) {
                    teile.add(VerbrauchRegeln.intervallmengeTeil(fenster, qVon, qBis, kadenz,
                            VerbrauchVectorsTest.dezimal(reihe.path("faktor"), BigDecimal.ONE)));
                }
            } else if (fenster.stream().anyMatch(r -> !r.zeit().isBefore(qVon) && r.zeit().isBefore(qBis))) {
                teile.add(VerbrauchRegeln.momentanwertTeil(fenster, qVon, qBis, kadenz,
                        reihe.path("integrieren").asBoolean(false)));
            }
        }
        return teile;
    }

    // ------------------------------------------------------------------ Die Kernaussagen

    /** Die Zusammensetzung steht als Regel IN der Datei — additiv, beide Zwillinge lesen sie. */
    @Test
    void dieRegelStehtInDerDatei() throws Exception {
        JsonNode datei = VerbrauchVectorsTest.lies(VerbrauchVectorsTest.VECTORS);
        assertThat(datei.path("regeln").path("werte_teilperioden").asText())
                .contains("nie Mittel von Mitteln").contains("nie Mittel × Länge");
        List<String> vokabular = new ArrayList<>();
        datei.path("kennzeichen").forEach(k -> vokabular.add(k.asText()));
        assertThat(vokabular).contains(VerbrauchRegeln.AUS_LEISTUNG_INTEGRIERT_WORT);
        assertThat(VerbrauchRegeln.AUS_LEISTUNG_INTEGRIERT).startsWith(VerbrauchRegeln.AUS_LEISTUNG_INTEGRIERT_WORT);
    }

    /**
     * F24: die ungerundeten Energien der vier Viertelstunden sind zusammen die der Stunde — weil jeder
     * Wert bis zum nächsten guten Wert hält, auch hinter der Grenze (M4). Vor IP-3 hielt der letzte
     * Wert einer Periode nur eine Kadenz: die Viertelstunde 10:15 hätte 18,444 statt 18,667 kWh.
     */
    @Test
    void dieViertelstundenEnergienErgebenDieDerStunde() throws Exception {
        JsonNode reihe = fall("f24-").path("input").path("reihe");
        Instant von = VerbrauchRegeln.zeit("2026-10-20T10:00:00+02:00");
        Instant bis = VerbrauchRegeln.zeit("2026-10-20T11:00:00+02:00");
        List<Werteteil> innen = werteteile(reihe, von, bis).stream()
                .filter(t -> !t.teil().von().isBefore(von) && !t.teil().bis().isAfter(bis))
                .toList();
        assertThat(innen).hasSize(4);
        BigDecimal summe = innen.stream().map(Werteteil::energie).reduce(BigDecimal.ZERO, BigDecimal::add);
        BigDecimal stunde = VerbrauchRegeln.integriere(VerbrauchVectorsTest.rohwerte(reihe), von, bis,
                Duration.ofSeconds(10));
        // Gleich bis auf die 28. Stelle des Rechen-Kontexts (jeder Teil teilt für sich durch 3600).
        assertThat(summe.subtract(stunde).abs()).isLessThan(new BigDecimal("1e-20"));
        assertThat(innen.get(1).teil().ergebnis().energieKwh()).isEqualByComparingTo("18.667");
    }

    /**
     * Zwei Viertelstunden mit dem wahren Mittel 10,05 und 10,04: gerundet 10,1 und 10,0 — deren Mittel
     * 10,05 ergäbe 10,1. Die halbe Stunde hat 10,045, also 10,0. Gerechnet wird aus den Summen.
     */
    @Test
    void einMittelVonMittelnWaereFalsch() {
        Instant von = VerbrauchRegeln.zeit("2026-10-20T10:00:00+00:00");
        Duration kadenz = Duration.ofSeconds(450);
        List<Rohwert> roh = List.of(
                new Rohwert(von, new BigDecimal("10.00")),
                new Rohwert(von.plus(kadenz), new BigDecimal("10.10")),
                new Rohwert(von.plus(VIERTELSTUNDE), new BigDecimal("10.00")),
                new Rohwert(von.plus(VIERTELSTUNDE).plus(kadenz), new BigDecimal("10.08")));
        List<Werteteil> teile = List.of(
                VerbrauchRegeln.momentanwertTeil(roh, von, von.plus(VIERTELSTUNDE), kadenz, false),
                VerbrauchRegeln.momentanwertTeil(roh, von.plus(VIERTELSTUNDE), von.plus(VIERTELSTUNDE.multipliedBy(2)),
                        kadenz, false));
        assertThat(teile.get(0).teil().ergebnis().mittel()).isEqualByComparingTo("10.1");
        assertThat(teile.get(1).teil().ergebnis().mittel()).isEqualByComparingTo("10.0");
        Werteteil halb = VerbrauchRegeln.momentanwertAusTeilperioden(teile, von, von.plus(VIERTELSTUNDE.multipliedBy(2)),
                kadenz, false);
        assertThat(halb.teil().ergebnis().mittel()).isEqualByComparingTo("10.0")
                .isEqualByComparingTo(VerbrauchRegeln.momentanwerte(roh, von, von.plus(VIERTELSTUNDE.multipliedBy(2)),
                        kadenz, false).mittel());
    }

    /** Ein Teil von vor IP-3 trägt keine Summe: er zählt mit Mittel × erhalten, wie der Tageslauf vorher. */
    @Test
    void einTeilOhneSummeZaehltMitSeinemMittel() {
        Instant von = VerbrauchRegeln.zeit("2026-10-20T10:00:00+00:00");
        Duration kadenz = Duration.ofSeconds(450);
        List<Rohwert> roh = List.of(new Rohwert(von, new BigDecimal("10.00")),
                new Rohwert(von.plus(kadenz), new BigDecimal("10.10")));
        Werteteil mit = VerbrauchRegeln.momentanwertTeil(roh, von, von.plus(VIERTELSTUNDE), kadenz, false);
        Werteteil alt = new Werteteil(mit.teil(), null, null, mit.gemessenS(), mit.lueckeInnen());
        Werteteil stunde = VerbrauchRegeln.momentanwertAusTeilperioden(List.of(alt), von, von.plus(Duration.ofHours(1)),
                kadenz, false);
        assertThat(stunde.summe()).isEqualByComparingTo("20.2");
        assertThat(stunde.teil().ergebnis().mittel()).isEqualByComparingTo("10.1");
    }

    /**
     * Die Summe 28-stelliger Teil-Energien trägt Rechenrauschen: genau auf der Rundungsgrenze (F3:
     * 24,1125 kWh) darf eine Summe 24,11249…9 nicht auf 24,112 kippen. Echte Energien (Wert × Sekunden
     * ÷ 3 600) haben nie eine Neunerkette, das Entfernen des Rauschens ist darum exakt.
     */
    @Test
    void rechenrauschenKipptKeineRundungsgrenze() {
        assertThat(VerbrauchRegeln.rundeEnergie(new BigDecimal("24.11249999999999999999999999")))
                .isEqualByComparingTo("24.113");
        assertThat(VerbrauchRegeln.rundeEnergie(new BigDecimal("24.11250000000000000000000001")))
                .isEqualByComparingTo("24.113");
        assertThat(VerbrauchRegeln.rundeEnergie(new BigDecimal("24.11244444444444444444444444")))
                .isEqualByComparingTo("24.112");
    }

    /** Ohne einen guten Wert gibt es keine Energie — nie 0, nie Mittel × Länge, kein Kennzeichen. */
    @Test
    void ohneEinenGutenWertGibtEsKeineEnergie() {
        Instant von = VerbrauchRegeln.zeit("2026-10-20T10:00:00+00:00");
        Duration kadenz = Duration.ofSeconds(10);
        List<Rohwert> schlecht = new ArrayList<>();
        for (int i = 0; i < 90; i++) {
            schlecht.add(new Rohwert(von.plusSeconds(10L * i), new BigDecimal(96), false));
        }
        Werteteil teil = VerbrauchRegeln.momentanwertTeil(schlecht, von, von.plus(VIERTELSTUNDE), kadenz, true);
        assertThat(teil.energie()).isNull();
        assertThat(teil.teil().ergebnis().zustand()).isEqualTo(VerbrauchRegeln.KEINE_WERTE);
        Werteteil stunde = VerbrauchRegeln.momentanwertAusTeilperioden(List.of(teil), von,
                von.plus(Duration.ofHours(1)), kadenz, true);
        assertThat(stunde.energie()).isNull();
        assertThat(stunde.teil().ergebnis().energieKwh()).isNull();
        assertThat(stunde.teil().ergebnis().kennzeichen()).isEmpty();
        assertThat(stunde.teil().ergebnis().erwartet()).isEqualTo(360);
    }

    /** Wer integriert haben will, muss jede Teil-Energie mitbringen — eine zu kleine Summe wäre eine Behauptung. */
    @Test
    void integrierenVerlangtDieEnergieJedesTeils() {
        Instant von = VerbrauchRegeln.zeit("2026-10-20T10:00:00+00:00");
        Duration kadenz = Duration.ofSeconds(10);
        List<Rohwert> roh = new ArrayList<>();
        for (int i = 0; i < 90; i++) {
            roh.add(new Rohwert(von.plusSeconds(10L * i), new BigDecimal(96)));
        }
        Werteteil ohne = VerbrauchRegeln.momentanwertTeil(roh, von, von.plus(VIERTELSTUNDE), kadenz, false);
        assertThatThrownBy(() -> VerbrauchRegeln.momentanwertAusTeilperioden(List.of(ohne), von,
                von.plus(Duration.ofHours(1)), kadenz, true))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Energie");
    }

    private static JsonNode fall(String praefix) throws Exception {
        for (JsonNode fall : VerbrauchVectorsTest.lies(VerbrauchVectorsTest.VECTORS).path("cases")) {
            if (fall.path("name").asText().startsWith(praefix)) {
                return fall;
            }
        }
        throw new IllegalStateException("kein Fall " + praefix);
    }

    private static boolean imRaster(Instant t) {
        return t.getEpochSecond() % VIERTELSTUNDE.toSeconds() == 0;
    }
}
