package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.VerbrauchRegeln.Ereignis;
import com.voltpilot.api.uems.VerbrauchRegeln.Rohwert;
import com.voltpilot.api.uems.VerbrauchRegeln.Teilperiode;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Die ZUSAMMENSETZUNG aus Teilperioden (UEMS AP-08 IP-5, P7/§4.5) gegen die Vektor-Datei — der
 * Lockstep: eine gröbere Periode aus ihren gespeicherten Viertelstunden (und über Tage) ergibt
 * GENAU das, was die Rohwert-Regel über dieselbe Periode ergibt.
 *
 * <p>Geprüft wird jede Erwartung jedes Zählerstand-Falls, deren Periode mindestens zwei
 * Viertelstunden lang ist und im Raster liegt — gegen die Erwartung der DATEI, nicht gegen die
 * eigene Rohwert-Rechnung. Eine Viertelstunde ohne einen einzigen Rohwert bekommt dabei, wie in
 * der Datenbank (IP-12), gar keine Teilperiode.
 *
 * <p>Der Python-Zwilling fährt denselben Lockstep ({@code test_verbrauch.py}).
 */
class VerbrauchTeilperiodenTest {

    private static final Duration VIERTELSTUNDE = Duration.ofMinutes(15);
    private static final ZoneId ORT = ZoneId.of("Europe/Berlin");
    private static final ReihenKontext KWH_BERLIN = new ReihenKontext("kWh", ORT);

    @TestFactory
    List<DynamicTest> ausViertelstunden() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        Set<String> faelle = new TreeSet<>();
        for (JsonNode fall : VerbrauchVectorsTest.lies(VerbrauchVectorsTest.VECTORS).path("cases")) {
            for (JsonNode erwartung : fall.path("expected")) {
                JsonNode reihe = VerbrauchVectorsTest.reihe(fall, erwartung);
                Instant von = VerbrauchRegeln.zeit(erwartung.path("von").asText());
                Instant bis = VerbrauchRegeln.zeit(erwartung.path("bis").asText());
                if (!"zaehlerstand".equals(reihe.path("wertart").asText())
                        || Duration.between(von, bis).compareTo(VIERTELSTUNDE.multipliedBy(2)) < 0
                        || !imRaster(von) || !imRaster(bis)) {
                    continue;
                }
                String name = fall.path("name").asText() + " :: " + erwartung.path("name").asText();
                faelle.add(name);
                tests.add(DynamicTest.dynamicTest(name + " (aus Viertelstunden)",
                        () -> pruefe(fall, erwartung, false)));
                if (Duration.between(von, bis).toHours() >= 46 && mitternacht(von) && mitternacht(bis)) {
                    tests.add(DynamicTest.dynamicTest(name + " (aus Tagen aus Viertelstunden)",
                            () -> pruefe(fall, erwartung, true)));
                }
            }
        }
        // Die Abnahme von IP-5 muss darunter sein — sonst prüfte dieser Test am Paket vorbei.
        assertThat(faelle).anyMatch(n -> n.startsWith("f8-") && n.contains("Tag 03.11.2026"))
                .anyMatch(n -> n.startsWith("f13-") && n.contains("Tag 25.10.2026"))
                .anyMatch(n -> n.startsWith("f14-") && n.contains("Tag 28.03.2027"))
                .anyMatch(n -> n.startsWith("f16-") && n.contains("Monat Oktober 2026"))
                .anyMatch(n -> n.startsWith("f20-") && n.contains("Zeitraum 20.–21.10.2026"));
        return tests;
    }

    private static void pruefe(JsonNode fall, JsonNode erwartung, boolean ueberTage) {
        JsonNode reihe = VerbrauchVectorsTest.reihe(fall, erwartung);
        String why = fall.path("why").asText();
        Instant von = VerbrauchRegeln.zeit(erwartung.path("von").asText());
        Instant bis = VerbrauchRegeln.zeit(erwartung.path("bis").asText());
        Duration kadenz = Duration.ofSeconds(reihe.path("kadenz_s").asLong());
        List<Rohwert> werte = VerbrauchVectorsTest.rohwerte(reihe);
        List<Ereignis> ereignisse = new ArrayList<>(VerbrauchVectorsTest.ereignisse(reihe.path("ereignisse")));
        ereignisse.addAll(VerbrauchVectorsTest.ereignisse(erwartung.path("ereignisse_zusatz")));
        BigDecimal faktor = VerbrauchVectorsTest.dezimal(reihe.path("faktor"), BigDecimal.ONE);
        BigDecimal modul = VerbrauchVectorsTest.dezimal(reihe.path("wertebereich_modul"), null);
        BigDecimal hoechst = VerbrauchVectorsTest.dezimal(reihe.path("hoechstzuwachs_je_kadenz"), null);
        ReihenKontext kontext = VerbrauchVectorsTest.kontext(reihe);

        // Die Viertelstunden, wie die Datenbank sie trägt: eine Zeile nur mit mindestens einem
        // Rohwert — einen Tag davor und eine Viertelstunde danach (die Nachbarn der Grenzen).
        Instant ab = ueberTage ? von.minus(Duration.ofDays(2)) : von.minus(Duration.ofDays(1));
        Instant ende = ueberTage ? bis.plus(Duration.ofDays(1)) : bis.plus(VIERTELSTUNDE);
        List<Teilperiode> viertelstunden = new ArrayList<>();
        for (Instant q = ab; q.isBefore(ende); q = q.plus(VIERTELSTUNDE)) {
            Instant qBis = q.plus(VIERTELSTUNDE);
            List<Rohwert> fenster = fenster(werte, q.minus(kadenz), qBis);
            Instant qq = q;
            if (fenster.stream().noneMatch(r -> !r.zeit().isBefore(qq) && r.zeit().isBefore(qBis))) {
                continue;
            }
            viertelstunden.add(VerbrauchRegeln.teilperiode(kontext, fenster, q, qBis, kadenz, ereignisse, faktor,
                    modul, hoechst));
        }

        List<Teilperiode> teile = viertelstunden;
        if (ueberTage) {
            teile = new ArrayList<>();
            for (LocalDate tag = LocalDate.ofInstant(ab, ORT); tag.atStartOfDay(ORT).toInstant().isBefore(ende);
                    tag = tag.plusDays(1)) {
                Instant tVon = tag.atStartOfDay(ORT).toInstant();
                Instant tBis = tag.plusDays(1).atStartOfDay(ORT).toInstant();
                List<Teilperiode> fuerTag = viertelstunden.stream()
                        .filter(v -> v.bis().isAfter(tVon.minus(Duration.ofDays(1))) && !v.von().isAfter(tBis))
                        .toList();
                if (fuerTag.stream().noneMatch(v -> !v.von().isBefore(tVon) && v.bis().compareTo(tBis) <= 0)) {
                    continue;
                }
                teile.add(VerbrauchRegeln.zaehlerstandAusTeilperioden(kontext, fuerTag, tVon, tBis, kadenz,
                        ereignisse, faktor, modul, hoechst));
            }
        }

        Teilperiode ist = VerbrauchRegeln.zaehlerstandAusTeilperioden(kontext, teile, von, bis, kadenz, ereignisse,
                faktor, modul, hoechst);
        VerbrauchVectorsTest.zahl(why + " · menge", erwartung.path("menge"), ist.ergebnis().menge());
        if (erwartung.has("zustand")) {
            assertThat(ist.ergebnis().zustand()).as(why + " · zustand").isEqualTo(erwartung.path("zustand").asText());
        }
        if (erwartung.has("erhalten")) {
            assertThat(ist.ergebnis().erhalten()).as(why + " · erhalten").isEqualTo(erwartung.path("erhalten").asInt());
        }
        if (erwartung.has("erwartet")) {
            assertThat(ist.ergebnis().erwartet()).as(why + " · erwartet").isEqualTo(erwartung.path("erwartet").asInt());
        }
        if (erwartung.has("abdeckung_prozent")) {
            JsonNode soll = erwartung.path("abdeckung_prozent");
            assertThat(ist.ergebnis().abdeckungProzent()).as(why + " · abdeckung_prozent")
                    .isEqualTo(soll.isNull() ? null : soll.asInt());
        }
        if (erwartung.has("kennzeichen")) {
            List<String> soll = new ArrayList<>();
            erwartung.path("kennzeichen").forEach(k -> soll.add(k.asText()));
            assertThat(ist.ergebnis().kennzeichen()).as(why + " · kennzeichen").isEqualTo(soll);
        }
    }

    // ------------------------------------------------------------------ Die Kernaussage

    /** Die Zusammensetzung steht als Regel IN der Datei — additiv, beide Zwillinge lesen sie. */
    @Test
    void dieRegelStehtInDerDatei() throws Exception {
        assertThat(VerbrauchVectorsTest.lies(VerbrauchVectorsTest.VECTORS).path("regeln").path("teilperioden").asText())
                .contains("Kettenende − Kettenanfang").contains("nie Summe der Teilmengen");
    }

    /**
     * F16: 31 Oktobertage, jeder für sich gerundet — ihre SUMME ist 55 100,013 kWh und damit
     * falsch, obwohl kein Wert fehlt. Aus den Periodenständen ergibt sich 55 100,000.
     */
    @Test
    void dieSummeDerTageIstNichtDieMonatsmenge() throws Exception {
        JsonNode fall = fall("f16-");
        JsonNode reihe = fall.path("input").path("reihe");
        List<Rohwert> werte = VerbrauchVectorsTest.rohwerte(reihe);
        Duration kadenz = Duration.ofSeconds(60);
        List<Teilperiode> tage = new ArrayList<>();
        BigDecimal summe = BigDecimal.ZERO;
        for (LocalDate tag = LocalDate.of(2026, 10, 1); tag.isBefore(LocalDate.of(2026, 11, 1)); tag = tag.plusDays(1)) {
            Instant tVon = tag.atStartOfDay(ORT).toInstant();
            Instant tBis = tag.plusDays(1).atStartOfDay(ORT).toInstant();
            Teilperiode t = VerbrauchRegeln.teilperiode(KWH_BERLIN, fenster(werte, tVon.minus(kadenz), tBis), tVon,
                    tBis, kadenz, List.of(), BigDecimal.ONE, null, null);
            tage.add(t);
            summe = summe.add(t.ergebnis().menge());
        }
        Teilperiode monat = VerbrauchRegeln.zaehlerstandAusTeilperioden(KWH_BERLIN, tage,
                VerbrauchRegeln.zeit("2026-10-01T00:00:00+02:00"), VerbrauchRegeln.zeit("2026-11-01T00:00:00+01:00"),
                kadenz, List.of(), BigDecimal.ONE, null, null);
        assertThat(summe).isEqualByComparingTo("55100.013");
        assertThat(monat.ergebnis().menge()).isEqualByComparingTo("55100.000");
        assertThat(monat.standEnde().wert().subtract(monat.standAnfang().wert())
                        .setScale(VerbrauchRegeln.NACHKOMMASTELLEN, java.math.RoundingMode.HALF_UP))
                .as("die Monatsmenge IST die Differenz der Periodenstände").isEqualByComparingTo("55100.000");
    }

    /** Eine Teilperiode, die über die Grenze ragt, ist ein Fehler des Aufrufers — nie still gekappt. */
    @Test
    void eineUeberstehendeTeilperiodeWirdAbgewiesen() {
        Instant von = Instant.parse("2026-10-20T00:00:00Z");
        Teilperiode schief = VerbrauchRegeln.teilperiode(KWH_BERLIN,
                List.of(new Rohwert(von, BigDecimal.ONE)), von.minusSeconds(60), von.plusSeconds(840),
                Duration.ofSeconds(60), List.of(), BigDecimal.ONE, null, null);
        assertThatThrownBy(() -> VerbrauchRegeln.zaehlerstandAusTeilperioden(KWH_BERLIN, List.of(schief), von,
                von.plus(Duration.ofHours(1)), Duration.ofSeconds(60), List.of(), BigDecimal.ONE, null, null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("ragt");
    }

    // ------------------------------------------------------------------------ Hilfen

    private static JsonNode fall(String praefix) throws Exception {
        for (JsonNode fall : VerbrauchVectorsTest.lies(VerbrauchVectorsTest.VECTORS).path("cases")) {
            if (fall.path("name").asText().startsWith(praefix)) {
                return fall;
            }
        }
        throw new AssertionError("kein Fall " + praefix);
    }

    /** Die Rohwerte in {@code [von, bis]} — genug für Stand(von), die Werte und Stand(bis). */
    private static List<Rohwert> fenster(List<Rohwert> werte, Instant von, Instant bis) {
        int lo = 0;
        int hi = werte.size();
        while (lo < hi) {
            int mid = (lo + hi) >>> 1;
            if (werte.get(mid).zeit().isBefore(von)) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        List<Rohwert> aus = new ArrayList<>();
        for (int i = lo; i < werte.size() && !werte.get(i).zeit().isAfter(bis); i++) {
            aus.add(werte.get(i));
        }
        return aus;
    }

    private static boolean imRaster(Instant t) {
        return t.getEpochSecond() % VIERTELSTUNDE.toSeconds() == 0;
    }

    private static boolean mitternacht(Instant t) {
        return t.atZone(ORT).toLocalTime().toSecondOfDay() == 0;
    }
}
