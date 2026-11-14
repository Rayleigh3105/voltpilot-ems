package com.voltpilot.api.anlagencheck;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import com.voltpilot.api.anlagencheck.SpeicherBilanzRegel.Bilanz;
import com.voltpilot.api.anlagencheck.SpeicherBilanzRegel.Tag;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die Speicher-Bilanz gegen die Labor-Zahlen des Bedienkonzepts (§3.3): 13.10.–12.11.2026, 141,2 kWh hinein,
 * 119,3 kWh heraus, Ladestand 8 % → 94 % bei 10 kWh: roh 84 %, mit Ausgleich 90,6 %.
 */
class SpeicherBilanzRegelTest {

    private static final LocalDate HEUTE = LocalDate.of(2026, 11, 13);

    /** 30 Tage bis gestern, gleich verteilt, Ladestand am Vortag 8 %, am Ende 94 %. */
    private static List<Tag> labor() {
        List<Tag> tage = new ArrayList<>();
        LocalDate bis = HEUTE.minusDays(1);
        LocalDate von = bis.minusDays(29);
        tage.add(new Tag(von.minusDays(1), 4.0, 3.5, 8.0));
        for (LocalDate d = von; !d.isAfter(bis); d = d.plusDays(1)) {
            tage.add(new Tag(d, 141.2 / 30, 119.3 / 30, d.equals(bis) ? 94.0 : 50.0));
        }
        return tage;
    }

    @Test
    void ladestandAusgleichGibtDieLaborzahl() {
        Bilanz b = SpeicherBilanzRegel.bilanz(labor(), 10.0, HEUTE, 0);
        assertThat(b.zustand()).isEqualTo(SpeicherBilanzRegel.Zustand.NORMAL);
        assertThat(b.von()).isEqualTo(LocalDate.of(2026, 10, 14));
        assertThat(b.bis()).isEqualTo(LocalDate.of(2026, 11, 12));
        assertThat(b.hineinKwh()).isCloseTo(141.2, within(1e-9));
        assertThat(b.herausKwh()).isCloseTo(119.3, within(1e-9));
        assertThat(b.ausgleichKwh()).isCloseTo(8.6, within(1e-9));
        assertThat(b.wirkungsgrad()).isCloseTo(0.906, within(0.0005));
        assertThat(b.herausKwh() / b.hineinKwh()).as("roh, ohne Ausgleich").isCloseTo(0.845, within(0.001));
        assertThat(b.verlustKwh()).isCloseTo(141.2 - 119.3 - 8.6, within(1e-9));
        assertThat(b.vollzyklen()).isCloseTo(11.93, within(0.001));
    }

    @Test
    void seitBeginnZaehltAuchWasVorDemLesefensterLag() {
        Bilanz b = SpeicherBilanzRegel.bilanz(labor(), 10.0, HEUTE, 4000.0);
        assertThat(b.vollzyklenSeitBeginn()).isCloseTo((4000 + 119.3 + 3.5) / 10, within(1e-9));
    }

    @Test
    void untenFuenfVollzyklenIstEsZuWenig() {
        List<Tag> tage = new ArrayList<>();
        for (int i = 0; i <= 30; i++) {
            tage.add(new Tag(HEUTE.minusDays(31 - i), 1.5, 1.3, 50.0));
        }
        Bilanz b = SpeicherBilanzRegel.bilanz(tage, 10.0, HEUTE, 0);
        assertThat(b.zustand()).isEqualTo(SpeicherBilanzRegel.Zustand.WENIG);
        assertThat(b.wirkungsgrad()).as("keine Zahl, die nichts trägt").isNull();
        assertThat(b.vollzyklen()).isCloseTo(3.9, within(1e-9));
    }

    @Test
    void ohneKapazitaet90TageOhneVollzyklenUndOhneAusgleich() {
        List<Tag> tage = new ArrayList<>();
        for (int i = 0; i <= 90; i++) {
            tage.add(new Tag(HEUTE.minusDays(91 - i), 5.0, 4.5, i == 90 ? 100.0 : 0.0));
        }
        Bilanz b = SpeicherBilanzRegel.bilanz(tage, null, HEUTE, 0);
        assertThat(b.fensterTage()).isEqualTo(90);
        assertThat(b.vollzyklen()).isNull();
        assertThat(b.ausgleichKwh()).isNull();
        assertThat(b.wirkungsgrad()).isCloseTo(0.9, within(1e-9));
    }

    @Test
    void vergleichGegenDieEigenenZwoelfMonate() {
        List<Tag> tage = new ArrayList<>();
        LocalDate start = LocalDate.of(2025, 10, 1);
        for (LocalDate d = start; d.isBefore(HEUTE); d = d.plusDays(1)) {
            boolean jetzt = !d.isBefore(HEUTE.minusDays(31));
            // Monate: 91 % (heraus/hinein), die letzten 30 Tage 80 %.
            tage.add(new Tag(d, 10.0, jetzt ? 8.0 : 9.1, 50.0));
        }
        Bilanz b = SpeicherBilanzRegel.bilanz(tage, 10.0, HEUTE, 0);
        assertThat(b.vergleichMonate()).isGreaterThanOrEqualTo(3);
        assertThat(b.vergleichMin()).isCloseTo(0.8, within(0.06)); // Oktober 2026 enthält schon Tage zu 80 %
        assertThat(b.vergleichMax()).isCloseTo(0.91, within(1e-9));
        assertThat(b.satz()).isNotNull();

        List<Tag> gleich = tage.stream().map(t -> new Tag(t.tag(), 10.0, 9.1, 50.0)).toList();
        Bilanz u = SpeicherBilanzRegel.bilanz(gleich, 10.0, HEUTE, 0);
        assertThat(u.satz()).isEqualTo(SpeicherBilanzRegel.Satz.UNAUFFAELLIG);

        List<Tag> schlecht = new ArrayList<>();
        for (Tag t : gleich) {
            boolean jetzt = !t.tag().isBefore(HEUTE.minusDays(31));
            boolean letzterMonat = t.tag().getMonthValue() == 10 && t.tag().getYear() == 2026;
            schlecht.add(new Tag(t.tag(), 10.0, jetzt && !letzterMonat ? 8.0 : 9.1, 50.0));
        }
        Bilanz n = SpeicherBilanzRegel.bilanz(schlecht, 10.0, HEUTE, 0);
        assertThat(n.satz()).isEqualTo(SpeicherBilanzRegel.Satz.NIEDRIGER);
    }

    @Test
    void ohneDatenKeineZahl() {
        Bilanz b = SpeicherBilanzRegel.bilanz(List.of(), 10.0, HEUTE, 0);
        assertThat(b.zustand()).isEqualTo(SpeicherBilanzRegel.Zustand.OHNE_DATEN);
        assertThat(b.wirkungsgrad()).isNull();
    }
}
