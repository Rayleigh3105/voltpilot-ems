package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Die Kundensätze des Vergleichs (AP-17 IP-19, {@code bezugsbasis.md} §10/§16) aus den Ergebnissen der Regeln — rein,
 * mit den Fassungen der Vektordatei (BB-0001 wörtlich aus der Referenzdatei 1.8). Der Leser selbst läuft im
 * {@code BezugsbasisVergleichApiTest} (Testcontainers).
 */
class BezugsbasisVergleichSatzTest {

    private static final BezugsbasisRegeln.Spannweite SPANNWEITE =
            new BezugsbasisRegeln.Spannweite("254000", "341000", "228600", "375100");
    private static final List<BezugsbasisRegeln.Variable> PRODUKTION =
            List.of(new BezugsbasisRegeln.Variable("Produktionsmenge", "kg", "produktionsmenge"));
    private static final BezugsbasisRegeln.Fassung MODELL = new BezugsbasisRegeln.Fassung("BB-0001", 2,
            "regression_eine_variable", 12, "0.2685", new BezugsbasisRegeln.Koeffizienten("10523", "0.2343", null), "0.8",
            "2.0", List.of(SPANNWEITE), PRODUKTION);
    private static final BezugsbasisRegeln.Fassung VORLAEUFIG = new BezugsbasisRegeln.Fassung("BB-0001", 1,
            "verhaeltnis", 1, "0.2837", null, null, "2.0", null, PRODUKTION);

    private final List<String> saetze = new ArrayList<>();

    private static BezugsbasisRegeln.Wert wert(String w) {
        return new BezugsbasisRegeln.Wert(w, "vollstaendig", List.of());
    }

    private String monat(String schluessel, BezugsbasisRegeln.Fassung f, String gemessen, String x) {
        Map<String, Object> e = BezugsbasisRegeln.vergleich(
                new BezugsbasisRegeln.VergleichEingang(f, false, true, wert(gemessen), List.of(wert(x))));
        String satz = BezugsbasisVergleichSatz.monat(e, new BezugsbasisVergleichSatz.Monat(
                KennzahlRegeln.periodeText("monat", schluessel), "kWh",
                new BezugsbasisVergleichSatz.Variable("Produktionsmenge", x, "kg", "254000", "341000"), "BB-0001", null,
                null, null, null));
        saetze.add(satz);
        return satz;
    }

    @Test
    void r2DezemberSchlechterJanuarBesserFebruarImRahmen() {
        assertThat(monat("2027-12", MODELL, "78000", "250000")).isEqualTo("Dezember 2027: 78 000 kWh gemessen, "
                + "69 098 kWh erwartet bei 250 000 kg — 12,9 % mehr als die Bezugsbasis erwarten lässt: schlechter.");
        assertThat(monat("2028-01", MODELL, "78000", "300000")).isEqualTo(
                "Januar 2028: 78 000 kWh gemessen, 80 813 kWh erwartet bei 300 000 kg — 3,5 % weniger: besser.");
        assertThat(monat("2028-02", MODELL, "81500", "305000")).isEqualTo("Februar 2028: 81 500 kWh gemessen, "
                + "81 985 kWh erwartet bei 305 000 kg — 0,6 % weniger: im Rahmen (± 2 %).");
        keineUrsacheKeinNormwort();
    }

    @Test
    void r2RohTraegtNieEinUrteil() {
        Map<String, Object> roh = BezugsbasisRegeln.roh("78000", "85500");
        assertThat(roh).containsEntry("urteil", "ohne_urteil").containsEntry("delta_prozent", "-8.8")
                .containsEntry("richtung", "weniger");
    }

    @Test
    void r6VorlaeufigNenntEsImSatz() {
        assertThat(monat("2027-03", VORLAEUFIG, "88265", "331000")).isEqualTo("März 2027: 88 265 kWh gemessen, "
                + "93 905 kWh erwartet bei 331 000 kg — 6,0 % weniger: besser. Die Bezugsbasis ist vorläufig "
                + "(1 von 12 Monaten).");
    }

    @Test
    void g3MaerzAusserhalbDerSpannweite() {
        assertThat(monat("2028-03", MODELL, "100000", "390000")).isEqualTo("Modell nicht anwendbar: Produktionsmenge "
                + "im März 2028 (390 000 kg) liegt außerhalb der Bezugsbasis (254 000–341 000 kg).");
    }

    @Test
    void r11ZeitraumSummeDurchSumme() {
        List<BezugsbasisRegeln.Monat> monate = List.of(
                new BezugsbasisRegeln.Monat(true, wert("85500"), List.of(wert("320000"))),
                new BezugsbasisRegeln.Monat(true, wert("78000"), List.of(wert("250000"))),
                new BezugsbasisRegeln.Monat(true, wert("78000"), List.of(wert("300000"))),
                new BezugsbasisRegeln.Monat(true, wert("81500"), List.of(wert("305000"))));
        Map<String, Object> e = BezugsbasisRegeln.zeitraum(new BezugsbasisRegeln.ZeitraumEingang(MODELL, false, 4, monate));
        assertThat(e).containsEntry("delta_prozent", "1.8").containsEntry("urteil", "im_rahmen");
        String satz = BezugsbasisVergleichSatz.zeitraum(e, "November 2027", "Februar 2028", "kWh", 4);
        saetze.add(satz);
        assertThat(satz).isEqualTo("November 2027 bis Februar 2028: 323 000 kWh gemessen, 317 395 kWh erwartet — "
                + "1,8 %: im Rahmen der Bezugsbasis (Summe über vier Monate).");
        keineUrsacheKeinNormwort();
    }

    @Test
    void r5BeendetUndR10OhneBasis() {
        Map<String, Object> beendet = BezugsbasisRegeln.vergleich(
                new BezugsbasisRegeln.VergleichEingang(null, true, true, wert("40000"), List.of()));
        assertThat(BezugsbasisVergleichSatz.monat(beendet, new BezugsbasisVergleichSatz.Monat("Januar 2027", "kWh", null,
                "BB-0003", LocalDate.of(2026, 12, 31), "Anbau Halle 2", 2, LocalDate.of(2027, 3, 1))))
                .isEqualTo("Nicht bewertbar: Bezugsbasis beendet am 31.12.2026 (Anbau Halle 2). "
                        + "Fassung 2 gilt seit 01.03.2027.");
        Map<String, Object> fehlt = BezugsbasisRegeln.vergleich(
                new BezugsbasisRegeln.VergleichEingang(null, false, true, wert("40000"), List.of()));
        assertThat(fehlt).containsEntry("grund", "basis_fehlt");
        assertThat(BezugsbasisVergleichSatz.monat(fehlt, new BezugsbasisVergleichSatz.Monat("Januar 2027", "kWh", null,
                null, null, null, null, null))).isEqualTo(BezugsbasisVergleichSatz.LEER);
    }

    /** G2 (IP-13): die fehlende Variable steht im Satz, ohne Koordinaten mit dem Satz des Wetter-Archivs (§5.8). */
    @Test
    void g2VariableFehltMitKoordinatenSatz() {
        BezugsbasisRegeln.Fassung gradtage = new BezugsbasisRegeln.Fassung("BB-0003", 1, "gradtage", 12, "4.2465",
                new BezugsbasisRegeln.Koeffizienten("119", "3.8", null), "4.6", "2.0", null,
                List.of(new BezugsbasisRegeln.Variable("Gradtagzahl Lindach", "Kd", "gradtagzahl")));
        Map<String, Object> e = BezugsbasisRegeln.vergleich(new BezugsbasisRegeln.VergleichEingang(gradtage, false, true,
                wert("1200"), List.of(new BezugsbasisRegeln.Wert(null, null, List.of()))));
        assertThat(e).containsEntry("urteil", "nicht_anwendbar").containsEntry("grund", "variable_fehlt")
                .containsEntry("erwartet", null);
        String satz = BezugsbasisVergleichSatz.monat(e, new BezugsbasisVergleichSatz.Monat("Januar 2026", "kWh",
                new BezugsbasisVergleichSatz.Variable("Gradtagzahl Lindach", null, "Kd", null, null), "BB-0003", null,
                null, null, null, WetterArchivRegeln.koordinatenFehlen("Lindach")));
        saetze.add(satz);
        assertThat(satz).isEqualTo("Januar 2026: nicht bewertbar — Gradtagzahl Lindach hat keinen Wert. Für den Standort "
                + "Lindach kann VoltPilot kein Wetter beziehen: die Koordinaten fehlen. Eine Wetterbereinigung über Gradtage "
                + "ist hier erst möglich, wenn der Standort Koordinaten hat.");
        keineUrsacheKeinNormwort();
    }

    /** U6 und SP2: kein Satz nennt eine Ursache oder ein Norm-Wort. */
    private void keineUrsacheKeinNormwort() {
        for (String s : saetze) {
            for (String verboten : List.of("Leckage", "Maßnahme", "wirkt", "EnPI", "EnB", "Baseline", "Normalisierung",
                    "KPI", "automatisch bewertet")) {
                assertThat(s).doesNotContain(verboten);
            }
        }
    }
}
