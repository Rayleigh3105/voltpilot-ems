package com.voltpilot.api.history;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import com.voltpilot.api.repo.EntityHistoryRepository.Bucket;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Die Zählerregel je Eimer (Unterverteilungen, Konzept vp-unterzaehler-anzeige C2) - ohne Docker:
 * geprüft wird die Rechnung, nicht die Abfrage. Die Zahlen sind die Größenordnung von Schramms
 * „UV Halle“ (Zähler 70 802 kWh, rund 11 kW).
 */
class GeraeteEnergieTest {

    private static final Duration STUNDE = Duration.ofHours(1);
    /** 02.11.2026 00:00 Europe/Berlin (MEZ, UTC+1). */
    private static final Instant MO = Instant.parse("2026-11-01T23:00:00Z");

    /** Ein Stunden-Eimer eines monotonen Zählers: Stand am Anfang und am Ende. */
    private static Bucket stunde(int h, double von, double bis) {
        return new Bucket(MO.plus(Duration.ofHours(h)), (von + bis) / 2, von, bis, bis, 720);
    }

    @Test
    void derZuwachsZaehltUeberDieEimergrenzeUndJeBerlinerTag() {
        List<Bucket> reihe = new ArrayList<>();
        double stand = 70_802.0;
        for (int h = 0; h < 48; h++) {
            // Die erste Lesung einer Stunde liegt 5 s nach ihrem Beginn: 11 kW × 5 s fehlen im Eimer
            // selbst, der Zuwachs über die Grenze holt sie zurück.
            double anfang = h == 0 ? stand : stand + 0.015;
            stand += 11.0;
            reihe.add(stunde(h, anfang, stand));
        }
        GeraeteEnergie.Ergebnis e = GeraeteEnergie.berechne(Map.of(GeraeteEnergie.ZAEHLER, reihe), STUNDE,
                HistoryRange.MONTH);

        assertThat(e.quelle()).isEqualTo(GeraeteEnergie.QUELLE_ZAEHLER);
        assertThat(e.eimer()).extracting(GeraeteEnergie.Eimer::start)
                .containsExactly(MO, MO.plus(Duration.ofDays(1)));
        assertThat(e.eimer().get(0).kwh()).isCloseTo(24 * 11.0, within(1e-6));
        assertThat(e.eimer().get(1).kwh()).isCloseTo(24 * 11.0, within(1e-6));
        assertThat(e.summeKwh()).isCloseTo(48 * 11.0, within(1e-6));
        assertThat(e.zaehlerFaellt()).isFalse();
    }

    @Test
    void einFallenderZaehlerGibtFuerDenEimerUndDenZeitraumKeineZahl() {
        List<Bucket> reihe = new ArrayList<>(List.of(stunde(0, 950, 951), stunde(1, 951, 952)));
        // Tausch: der neue Zähler beginnt bei 5.
        reihe.add(stunde(2, 5, 6));
        reihe.add(stunde(3, 6, 7));
        GeraeteEnergie.Ergebnis e = GeraeteEnergie.berechne(Map.of(GeraeteEnergie.ZAEHLER, reihe), STUNDE,
                HistoryRange.WEEK);

        assertThat(e.zaehlerFaellt()).isTrue();
        assertThat(e.summeKwh()).as("945 kWh wären erfunden").isNull();
        assertThat(e.eimer()).extracting(GeraeteEnergie.Eimer::kwh).containsExactly(1.0, 1.0, null, 1.0);
    }

    @Test
    void einRueckgangInnerhalbEinesEimersIstEbensoEinFallen() {
        Bucket zurueck = new Bucket(MO, 900.0, 5.0, 950.0, 5.0, 720);
        GeraeteEnergie.Ergebnis e = GeraeteEnergie.berechne(Map.of(GeraeteEnergie.ZAEHLER, List.of(zurueck)),
                STUNDE, HistoryRange.WEEK);
        assertThat(e.zaehlerFaellt()).isTrue();
        assertThat(e.eimer()).extracting(GeraeteEnergie.Eimer::kwh).containsOnlyNulls();
    }

    @Test
    void nachEinerLueckeZaehltNurDerEimerSelbst() {
        // Die Box war zwei Stunden weg: was dort verbraucht wurde, gehört keiner Säule.
        GeraeteEnergie.Ergebnis e = GeraeteEnergie.berechne(Map.of(GeraeteEnergie.ZAEHLER,
                List.of(stunde(0, 100, 110), stunde(3, 140, 150))), STUNDE, HistoryRange.WEEK);
        assertThat(e.eimer()).extracting(GeraeteEnergie.Eimer::kwh).containsExactly(10.0, 10.0);
        assertThat(e.summeKwh()).isEqualTo(20.0);
    }

    @Test
    void ohneZaehlerZaehltDieLeistungMalDauer() {
        Bucket viertel = new Bucket(MO, 2.0, 1.5, 2.5, 2.0, 180);
        Bucket naechste = new Bucket(MO.plus(Duration.ofMinutes(15)), 4.0, 3.5, 4.5, 4.0, 180);
        GeraeteEnergie.Ergebnis e = GeraeteEnergie.berechne(Map.of(GeraeteEnergie.LEISTUNG,
                List.of(viertel, naechste)), Duration.ofMinutes(15), HistoryRange.DAY);
        assertThat(e.quelle()).isEqualTo(GeraeteEnergie.QUELLE_LEISTUNG);
        assertThat(e.eimer()).extracting(GeraeteEnergie.Eimer::kwh).containsExactly(0.5, 1.0);
        assertThat(e.summeKwh()).isEqualTo(1.5);
    }

    @Test
    void derZaehlerGewinntUeberDieLeistung() {
        GeraeteEnergie.Ergebnis e = GeraeteEnergie.berechne(Map.of(
                GeraeteEnergie.ZAEHLER, List.of(stunde(0, 10, 12)),
                GeraeteEnergie.LEISTUNG, List.of(new Bucket(MO, 99.0, 99.0, 99.0, 99.0, 1))), STUNDE,
                HistoryRange.WEEK);
        assertThat(e.quelle()).isEqualTo(GeraeteEnergie.QUELLE_ZAEHLER);
        assertThat(e.summeKwh()).isEqualTo(2.0);
    }

    @Test
    void ohneReiheGibtEsKeineZahlUndKeineNull() {
        GeraeteEnergie.Ergebnis e = GeraeteEnergie.berechne(Map.of(), STUNDE, HistoryRange.YEAR);
        assertThat(e.quelle()).isNull();
        assertThat(e.eimer()).isEmpty();
        assertThat(e.summeKwh()).isNull();
    }

    @Test
    void derBerlinerTagHaeltAuchUeberDieZeitumstellung() {
        // 25.10.2026: MESZ → MEZ, der Tag hat 25 Stunden (22:00Z am 24. bis 23:00Z am 25.).
        Instant tag = Instant.parse("2026-10-24T22:00:00Z");
        assertThat(GeraeteEnergie.grobBeginn(tag.plus(Duration.ofHours(24)), HistoryRange.MONTH)).isEqualTo(tag);
        assertThat(GeraeteEnergie.grobBeginn(tag.plus(Duration.ofHours(25)), HistoryRange.MONTH))
                .isEqualTo(Instant.parse("2026-10-25T23:00:00Z"));
    }
}
