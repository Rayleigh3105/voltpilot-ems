package com.voltpilot.api.grundlast;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import com.voltpilot.api.grundlast.GrundlastRegel.Nacht;
import com.voltpilot.api.grundlast.GrundlastRegel.RestGrund;
import com.voltpilot.api.grundlast.GrundlastRegel.Status;
import com.voltpilot.api.grundlast.GrundlastRegel.Teil;
import com.voltpilot.api.grundlast.GrundlastRegel.TeilEingabe;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.TreeMap;
import java.util.function.IntToDoubleFunction;
import org.junit.jupiter.api.Test;

/** Die Rechenregel der Grundlast, rein (Bedienkonzept Privatkunde §5.4, Bauplan G1). */
class GrundlastRegelTest {

    private static final Instant SPAETER = Instant.parse("2030-01-01T00:00:00Z");

    /** Füllt die Nacht eines Datums: Watt je Viertelstunde-Index (0 = Mitternacht). */
    private static void fuelle(NavigableMap<Instant, Double> m, LocalDate d, IntToDoubleFunction wattJeIndex) {
        Instant t = GrundlastRegel.nachtBeginn(d);
        int i = 0;
        while (t.isBefore(GrundlastRegel.nachtEnde(d))) {
            double w = wattJeIndex.applyAsDouble(i);
            if (!Double.isNaN(w)) {
                m.put(t, w / 4000.0);
            }
            t = t.plus(Duration.ofMinutes(15));
            i++;
        }
    }

    @Test
    void taktendeWaermepumpeZaehltNichtMitNurDieNiedrigsteViertelstunde() {
        LocalDate d = LocalDate.of(2026, 1, 14);
        NavigableMap<Instant, Double> m = new TreeMap<>();
        // Sockel 220 W, die Wärmepumpe läuft jede zweite Viertelstunde mit 2 kW.
        fuelle(m, d, i -> i % 2 == 0 ? 2220 : 220);
        Nacht n = GrundlastRegel.nacht(d, m, null, SPAETER);
        assertThat(n.status()).isEqualTo(Status.GEWERTET);
        assertThat(n.w()).isCloseTo(220, within(1e-6));
        assertThat(n.erwartet()).isEqualTo(20);
        assertThat(n.tiefste()).isEqualTo(GrundlastRegel.nachtBeginn(d).plus(Duration.ofMinutes(15)));
    }

    @Test
    void achtzehnVonZwanzigZaehlenSiebzehnNicht() {
        LocalDate d = LocalDate.of(2026, 6, 3);
        NavigableMap<Instant, Double> m = new TreeMap<>();
        fuelle(m, d, i -> i < 2 ? Double.NaN : 300);
        assertThat(GrundlastRegel.nacht(d, m, Instant.EPOCH, SPAETER).status()).isEqualTo(Status.GEWERTET);
        m.clear();
        fuelle(m, d, i -> i < 3 ? Double.NaN : 300);
        Nacht luecke = GrundlastRegel.nacht(d, m, Instant.EPOCH, SPAETER);
        assertThat(luecke.status()).isEqualTo(Status.LUECKE);
        assertThat(luecke.w()).isNull();
        assertThat(luecke.gemessen()).isEqualTo(17);
    }

    @Test
    void eineNachtVorDerErstenMessungIstKeineLuecke() {
        LocalDate d = LocalDate.of(2026, 11, 2);
        NavigableMap<Instant, Double> m = new TreeMap<>();
        Instant beginn = GrundlastRegel.nachtBeginn(d.plusDays(2));
        assertThat(GrundlastRegel.nacht(d, m, beginn, SPAETER).status()).isEqualTo(Status.VORHER);
        assertThat(GrundlastRegel.nacht(d, m, null, SPAETER).status()).isEqualTo(Status.VORHER);
        // Messbeginn mitten in der Nacht: das ist eine Lücke (die Nacht hat Messwerte, aber zu wenige).
        Instant mitten = GrundlastRegel.nachtBeginn(d).plus(Duration.ofHours(3));
        assertThat(GrundlastRegel.nacht(d, m, mitten, SPAETER).status()).isEqualTo(Status.LUECKE);
    }

    @Test
    void eineNachtIstBisEineHalbeStundeNachFuenfUhrOffen() {
        LocalDate d = LocalDate.of(2026, 11, 14);
        NavigableMap<Instant, Double> m = new TreeMap<>();
        fuelle(m, d, i -> 250);
        Instant ende = GrundlastRegel.nachtEnde(d);
        assertThat(GrundlastRegel.nacht(d, m, Instant.EPOCH, ende.plus(Duration.ofMinutes(29))).status())
                .isEqualTo(Status.OFFEN);
        assertThat(GrundlastRegel.nacht(d, m, Instant.EPOCH, ende.plus(Duration.ofMinutes(30))).status())
                .isEqualTo(Status.GEWERTET);
    }

    @Test
    void zeitumstellungGibtSechzehnOderVierundzwanzigViertelstunden() {
        LocalDate maerz = LocalDate.of(2026, 3, 29);
        LocalDate oktober = LocalDate.of(2026, 10, 25);
        assertThat(GrundlastRegel.erwarteteViertelstunden(maerz)).isEqualTo(16);
        assertThat(GrundlastRegel.erwarteteViertelstunden(oktober)).isEqualTo(24);
        assertThat(GrundlastRegel.erwarteteViertelstunden(LocalDate.of(2026, 3, 28))).isEqualTo(20);

        NavigableMap<Instant, Double> m = new TreeMap<>();
        fuelle(m, maerz, i -> 400 - i);
        Nacht n = GrundlastRegel.nacht(maerz, m, Instant.EPOCH, SPAETER);
        assertThat(n.status()).isEqualTo(Status.GEWERTET);
        assertThat(n.gemessen()).isEqualTo(16);
        assertThat(n.w()).isCloseTo(385, within(1e-6));

        // Oktober: 22 von 24 reichen, 21 nicht.
        fuelle(m, oktober, i -> i < 2 ? Double.NaN : 500);
        assertThat(GrundlastRegel.nacht(oktober, m, Instant.EPOCH, SPAETER).status()).isEqualTo(Status.GEWERTET);
        m.remove(GrundlastRegel.nachtBeginn(oktober).plus(Duration.ofMinutes(45)));
        assertThat(GrundlastRegel.nacht(oktober, m, Instant.EPOCH, SPAETER).status()).isEqualTo(Status.LUECKE);
    }

    @Test
    void typischeNachtErstAbDreiGewertetenNaechten() {
        LocalDate mo = LocalDate.of(2026, 11, 2);
        NavigableMap<Instant, Double> m = new TreeMap<>();
        fuelle(m, mo.plusDays(5), i -> 240);
        fuelle(m, mo.plusDays(6), i -> 260);
        Instant beginn = GrundlastRegel.nachtBeginn(mo.plusDays(5));
        List<Nacht> woche = GrundlastRegel.naechte(mo, mo.plusDays(7), m, beginn, SPAETER);
        assertThat(woche).extracting(Nacht::status).containsExactly(Status.VORHER, Status.VORHER, Status.VORHER,
                Status.VORHER, Status.VORHER, Status.GEWERTET, Status.GEWERTET);
        assertThat(GrundlastRegel.typisch(woche, 3)).isNull();

        fuelle(m, mo.plusDays(4), i -> 300);
        woche = GrundlastRegel.naechte(mo, mo.plusDays(7), m, GrundlastRegel.nachtBeginn(mo.plusDays(4)), SPAETER);
        assertThat(GrundlastRegel.typisch(woche, 3)).isCloseTo(260, within(1e-6));
    }

    @Test
    void medianEinerGeradenZahlIstDasMittelDerBeidenMittleren() {
        assertThat(GrundlastRegel.median(List.of(400.0, 200.0, 300.0, 100.0))).isEqualTo(250.0);
        assertThat(GrundlastRegel.median(List.of())).isNull();
    }

    @Test
    void jahrGibtJeMonatEinenWertAbSiebenNaechten() {
        NavigableMap<Instant, Double> m = new TreeMap<>();
        LocalDate jan = LocalDate.of(2026, 1, 1);
        for (int i = 0; i < 31; i++) {
            fuelle(m, jan.plusDays(i), x -> 300);
        }
        LocalDate feb = LocalDate.of(2026, 2, 1);
        for (int i = 0; i < 6; i++) {
            fuelle(m, feb.plusDays(i), x -> 250);
        }
        List<Nacht> naechte = GrundlastRegel.naechte(jan, LocalDate.of(2026, 3, 1), m, Instant.EPOCH, SPAETER);
        List<GrundlastRegel.Monat> monate = GrundlastRegel.monate(naechte);
        assertThat(monate).extracting(GrundlastRegel.Monat::monat)
                .containsExactly(YearMonth.of(2026, 1), YearMonth.of(2026, 2));
        assertThat(monate.get(0).w()).isCloseTo(300, within(1e-6));
        assertThat(monate.get(0).gewertet()).isEqualTo(31);
        assertThat(monate.get(1).w()).isNull();
        assertThat(monate.get(1).gewertet()).isEqualTo(6);
    }

    @Test
    void kwhAmTagUndAnteil() {
        assertThat(GrundlastRegel.kwhAmTag(640.0)).isCloseTo(15.36, within(1e-9));
        assertThat(GrundlastRegel.kwhAmTag(null)).isNull();
        // 640 W über 7 Tage (672 Viertelstunden) = 107,52 kWh von 208,6 kWh ≈ die Hälfte.
        assertThat(GrundlastRegel.anteil(640.0, 672, 208.6)).isCloseTo(0.5154, within(1e-4));
        assertThat(GrundlastRegel.anteil(640.0, 0, 208.6)).isNull();
        assertThat(GrundlastRegel.anteil(640.0, 672, 0.0)).isNull();
        assertThat(GrundlastRegel.anteil(null, 672, 208.6)).isNull();
    }

    @Test
    void stufeNenntDenTagAbDemDieGrundlastDeutlichAndersLiegt() {
        NavigableMap<Instant, Double> m = new TreeMap<>();
        LocalDate okt = LocalDate.of(2026, 10, 1);
        for (int i = 0; i < 31; i++) {
            double w = i < 16 ? 220 + (i % 3) * 5 : 280 + (i % 3) * 5;
            fuelle(m, okt.plusDays(i), x -> w);
        }
        List<Nacht> naechte = GrundlastRegel.naechte(okt, okt.plusDays(31), m, Instant.EPOCH, SPAETER);
        GrundlastRegel.Stufe s = GrundlastRegel.stufe(naechte);
        assertThat(s).isNotNull();
        assertThat(s.seit()).isEqualTo(LocalDate.of(2026, 10, 17));
        assertThat(s.vorherW()).isCloseTo(225, within(1e-6));
        assertThat(s.nachherW()).isCloseTo(285, within(1e-6));

        // Schwankung ohne Stufe: nichts.
        m.clear();
        for (int i = 0; i < 31; i++) {
            double w = 220 + (i % 4) * 10;
            fuelle(m, okt.plusDays(i), x -> w);
        }
        assertThat(GrundlastRegel.stufe(GrundlastRegel.naechte(okt, okt.plusDays(31), m, Instant.EPOCH, SPAETER)))
                .isNull();
    }

    @Test
    void aufteilungNimmtDieTeileInDenViertelstundenDerNachtwerte() {
        NavigableMap<Instant, Double> haus = new TreeMap<>();
        Map<Instant, Double> halle = new HashMap<>();
        Map<Instant, Double> keller = new HashMap<>();
        LocalDate mo = LocalDate.of(2026, 8, 31);
        List<LocalDate> tage = new ArrayList<>();
        for (int i = 0; i < 7; i++) {
            LocalDate d = mo.plusDays(i);
            tage.add(d);
            // Tiefste Viertelstunde ist die fünfte (Index 4): 640 W; Halle dort 560 W, Keller 30 W.
            fuelle(haus, d, x -> x == 4 ? 640 : 900);
            Instant tief = GrundlastRegel.nachtBeginn(d).plus(Duration.ofMinutes(60));
            halle.put(tief, 0.56);
            keller.put(tief, 0.03);
            // Andere Viertelstunden zählen nicht.
            halle.put(GrundlastRegel.nachtBeginn(d), 0.8);
        }
        List<Nacht> naechte = GrundlastRegel.naechte(mo, mo.plusDays(7), haus, Instant.EPOCH, SPAETER);
        List<Teil> teile = GrundlastRegel.teile(naechte, List.of(
                new TeilEingabe("halle", "UV Halle", "Unterzähler", true, halle),
                new TeilEingabe("keller", "UV Keller", "Unterzähler", true, keller)));
        assertThat(teile).extracting(Teil::w).containsExactly(560.0, 30.0);
        GrundlastRegel.Rest rest = GrundlastRegel.rest(GrundlastRegel.typisch(naechte, 3), teile);
        assertThat(rest.w()).isCloseTo(50, within(1e-6));
        assertThat(rest.grund()).isNull();
    }

    @Test
    void restOhneZahlWennEinTeilFehltOderDieTeileMehrMessen() {
        List<Teil> mitLuecke = List.of(new Teil("a", "A", "Unterzähler", true, 100.0),
                new Teil("b", "B", "Unterzähler", true, null));
        assertThat(GrundlastRegel.rest(300.0, mitLuecke).grund()).isEqualTo(RestGrund.TEIL_OHNE_WERT);

        List<Teil> zuViel = List.of(new Teil("a", "A", "Unterzähler", true, 520.0));
        assertThat(GrundlastRegel.rest(300.0, zuViel).grund()).isEqualTo(RestGrund.TEILE_MEHR_ALS_HAUS);

        // Innerhalb der Toleranz: Rest 0, nicht negativ.
        List<Teil> knapp = List.of(new Teil("a", "A", "Unterzähler", true, 450.0));
        assertThat(GrundlastRegel.rest(300.0, knapp).w()).isEqualTo(0.0);

        assertThat(GrundlastRegel.rest(null, knapp)).isNull();
        assertThat(GrundlastRegel.rest(300.0, List.of())).isNull();
    }
}
