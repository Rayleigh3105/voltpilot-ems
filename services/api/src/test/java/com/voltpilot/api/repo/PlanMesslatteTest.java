package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeMap;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.Test;

/**
 * Der Planwert der Steuerung gegen DENSELBEN Vergleichsspeicher (M2): rein,
 * mit handgerechneten Zahlen. Die Live-Probe (28./29.09.2026, Planwert =
 * Tageszahl bei eingetretenem Fahrplan) steht in {@code SteuerungTageszahlTest}
 * gegen den Block {@code band_und_plan} von {@code steuerung-tag-vectors.json}.
 *
 * <p>Batterie: 10 kWh, 5/5 kW, Wirkungsgrad 100 %, Band 0-100 % - damit jede
 * Zahl im Kopf nachrechenbar ist. Bezug 0,25 €/kWh, Einspeisung 0,08 €/kWh.
 */
class PlanMesslatteTest {

    private static final Offset<Double> EPS = Offset.offset(1e-9);
    private static final Instant T0 = Instant.parse("2026-09-28T22:00:00Z");
    private static final Duration SLOT = Duration.ofMinutes(15);
    private static final StandardSpeicher.Batterie BATTERIE = StandardSpeicher.batterie(
            BigDecimal.TEN, BigDecimal.valueOf(5), BigDecimal.valueOf(5),
            BigDecimal.valueOf(100), BigDecimal.ZERO, BigDecimal.valueOf(100), null, null);

    private static Instant t(int slot) {
        return T0.plus(SLOT.multipliedBy(slot));
    }

    /** Ein Verlauf mit Ständen (kWh) ab den angegebenen Slot-Grenzen. */
    private static PlanMesslatte.Vergleich vergleich(double... staende) {
        TreeMap<Instant, Double> s = new TreeMap<>();
        for (int i = 0; i < staende.length; i++) {
            s.put(t(i), staende[i]);
        }
        TreeMap<Instant, StandardSpeicher.Batterie> b = new TreeMap<>();
        b.put(T0, BATTERIE);
        return new PlanMesslatte.Vergleich(s, b);
    }

    /** Ein Nacht-Slot: 4 kW Last, keine PV; Plan bezieht alles (echter Speicher leer). */
    private static PlanMesslatte.Slot nacht(int slot) {
        return new PlanMesslatte.Slot(t(slot), BigDecimal.ZERO, BigDecimal.valueOf(4),
                new BigDecimal("0.25"), new BigDecimal("0.25"), true);
    }

    private static List<PlanMesslatte.Slot> naechte(int n) {
        List<PlanMesslatte.Slot> slots = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            slots.add(nacht(i));
        }
        return slots;
    }

    /**
     * Der Kern von M2: nach einem Abendverkauf ist der echte Speicher leer,
     * der Vergleichsspeicher hat noch 8 kWh. Der Plan kauft vier Viertelstunden
     * je 1 kWh zu 0,25 €, der sture Speicher deckt sie aus seinem Vorrat - der
     * Planwert ist −1,00 € wie die gemessene Zahl, nicht 0 wie bisher (der
     * sture Speicher des Optimierers startete am leeren echten Stand).
     */
    @Test
    void derUebertragDesVortagsStehtImPlanwert() {
        BigDecimal eur = PlanMesslatte.steuerungEur(vergleich(8, 7, 6, 5), naechte(4),
                t(0), t(4));
        assertThat(eur.doubleValue()).isCloseTo(-1.0, EPS);
    }

    /**
     * Ohne gemessenen Eimer vor {@code t} (laufende Viertelstunde, Zukunft,
     * Messlücke) läuft der sture Speicher über die Prognose weiter und wird
     * leer - 1,5 kWh decken 1 + 0,5 kWh, danach kauft auch er. Ein alter
     * gemessener Stand wird nicht noch einmal entladen.
     */
    @Test
    void ohneMesswertLaeuftDerVergleichsspeicherUeberDiePrognoseWeiter() {
        BigDecimal eur = PlanMesslatte.steuerungEur(vergleich(8, 1.5), naechte(5), t(0), t(5));
        // Slot 0 ab 8 kWh, Slot 1 ab gemessenen 1,5 kWh, danach fortgeschrieben:
        // 1,5 → 0,5 → 0 → 0 → 0. stur = 0 + 0 + 0,125 + 0,25 + 0,25; Plan = 5 × 0,25.
        assertThat(eur.doubleValue()).isCloseTo(0.625 - 1.25, EPS);
    }

    /** Ein jüngerer gemessener Stand löst die Fortschreibung wieder ab. */
    @Test
    void einJuengererMesswertLoestDieFortschreibungAb() {
        PlanMesslatte.Vergleich v = vergleich(1);
        v.staende().put(t(3), 9.0);
        BigDecimal eur = PlanMesslatte.steuerungEur(v, naechte(4), t(0), t(4));
        // Slot 0 deckt 1 kWh aus 1 kWh, Slot 1 und 2 kauft auch der sture
        // Speicher, Slot 3 startet am gemessenen Stand 9 kWh und deckt wieder.
        assertThat(eur.doubleValue()).isCloseTo(-0.5, EPS);
    }

    /**
     * Die Fortschreibung hängt nicht am Fenster: die Slots werden ab dem
     * jüngsten gemessenen Stand vor {@code from} gelesen, und ein Tag sagt
     * dasselbe wie das Fenster, das ihn enthält.
     */
    @Test
    void slotsVorDemFensterSchreibenNurFort() {
        PlanMesslatte.Vergleich v = vergleich(2);
        assertThat(PlanMesslatte.leseBeginn(v, t(2))).isEqualTo(t(0));
        assertThat(PlanMesslatte.leseBeginn(null, t(2))).isEqualTo(t(2));
        BigDecimal eur = PlanMesslatte.steuerungEur(v, naechte(4), t(2), t(4));
        // 2 kWh decken Slot 0 und 1 (außerhalb), Slot 2 und 3 kauft auch der sture Speicher.
        assertThat(eur.doubleValue()).isCloseTo(0.0, EPS);
        BigDecimal ganz = PlanMesslatte.steuerungEur(v, naechte(4), t(0), t(4));
        BigDecimal vorn = PlanMesslatte.steuerungEur(v, naechte(4), t(0), t(2));
        assertThat(ganz.doubleValue()).isCloseTo(vorn.doubleValue() + eur.doubleValue(), EPS);
    }

    /**
     * Bewertet wird mit der Baseline des Slots: 2 kWh Überschuss zu 0,08 €
     * (Baseline −0,16 €), der sture Speicher lädt 1,25 kWh (5 kW-Grenze), es
     * bleiben 0,75 kWh Einspeisung = −0,06 €. Der Plan speist alles ein.
     */
    @Test
    void ueberschussWirdMitDerBaselineDesSlotsBewertet() {
        PlanMesslatte.Slot sonne = new PlanMesslatte.Slot(t(0), BigDecimal.valueOf(8),
                BigDecimal.ZERO, new BigDecimal("-0.16"), new BigDecimal("-0.16"), true);
        BigDecimal eur = PlanMesslatte.steuerungEur(vergleich(0), List.of(sonne), t(0), t(1));
        assertThat(eur.doubleValue()).isCloseTo(-0.06 + 0.16, EPS);
        assertThat(PlanMesslatte.sturKostenEur(0.3, 0.0,
                new StandardSpeicher.Schritt(0, 0, 1))).isCloseTo(0.3, EPS);
    }

    /** Die Null-Regel: nie eine Teil-Summe. */
    @Test
    void ohneMesslatteOhnePrognoseOderOhneVergleichGibtEsKeinenPlanwert() {
        List<PlanMesslatte.Slot> ohneMesslatte = new ArrayList<>(naechte(2));
        ohneMesslatte.set(1, new PlanMesslatte.Slot(t(1), BigDecimal.ZERO, BigDecimal.ONE,
                BigDecimal.ONE, BigDecimal.ONE, false));
        assertThat(PlanMesslatte.steuerungEur(vergleich(8), ohneMesslatte, t(0), t(2)))
                .isNull();
        // Derselbe Slot VOR dem Fenster zählt nicht und kostet den Planwert nicht.
        assertThat(PlanMesslatte.steuerungEur(vergleich(8), ohneMesslatte, t(0), t(1)))
                .isNotNull();

        List<PlanMesslatte.Slot> ohnePrognose = List.of(new PlanMesslatte.Slot(t(0), null,
                BigDecimal.ONE, BigDecimal.ONE, BigDecimal.ONE, true));
        assertThat(PlanMesslatte.steuerungEur(vergleich(8), ohnePrognose, t(0), t(1)))
                .isNull();

        assertThat(PlanMesslatte.steuerungEur(null, naechte(1), t(0), t(1))).isNull();
        assertThat(PlanMesslatte.steuerungEur(vergleich(8), List.of(), t(0), t(1)))
                .isNull();
    }
}
