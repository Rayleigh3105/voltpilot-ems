package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * DIE INVARIANTE von E7 a–c (UEMS AP-08 IP-13): <b>eine geschätzte Verteilung verändert den gemessenen
 * Gesamtbetrag nie</b>. Über eine Zählerstand-Lücke ist der Zuwachs gemessen; {@link VerbrauchRegeln#verteilen}
 * legt nur fest, WANN er anfiel — die Summe der GESPEICHERTEN Anteile ist danach EXAKT der Zuwachs, nicht
 * ungefähr. Geprüft an vielen Lückenlängen, fünf Profilformen (a gleichmäßig, b/c nach Profil) und Zuwächsen,
 * deren Anteile unendliche Brüche sind: der Rest aus dem Abschneiden auf {@link VerbrauchRegeln#ERSATZWERT_STELLEN}
 * Stellen steht in der LETZTEN Viertelstunde, und nirgends sonst. Der Python-Zwilling prüft dasselbe
 * ({@code test_invariante_summe_gleich_gemessenem_zuwachs}). Rein; läuft immer.
 */
class ErsatzwertInvarianteTest {

    private static final List<Integer> LAENGEN = List.of(1, 2, 3, 7, 38, 40, 78, 96, 100, 2976);
    private static final List<String> ZUWAECHSE =
            List.of("1872.0", "100", "1", "0.001", "337.6", "1000000", "0", "2.000000001", "418537600");

    static Stream<Arguments> faelle() {
        List<Arguments> out = new ArrayList<>();
        for (int n : LAENGEN) {
            for (String z : ZUWAECHSE) {
                for (Map.Entry<String, List<BigDecimal>> p : profile(n).entrySet()) {
                    out.add(Arguments.of(n, new BigDecimal(z), p.getKey(), p.getValue()));
                }
            }
        }
        return out.stream();
    }

    private static Map<String, List<BigDecimal>> profile(int n) {
        Map<String, List<BigDecimal>> out = new LinkedHashMap<>();
        out.put("gleichmaessig", Collections.nCopies(n, BigDecimal.ONE));
        List<BigDecimal> steigend = new ArrayList<>();
        List<BigDecimal> mitNullen = new ArrayList<>();
        List<BigDecimal> unregelmaessig = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            steigend.add(BigDecimal.valueOf(i + 1));
            mitNullen.add(i % 2 == 0 ? BigDecimal.valueOf(3) : BigDecimal.ZERO);
            unregelmaessig.add(new BigDecimal("0.37").multiply(BigDecimal.valueOf(i % 7 + 1)));
        }
        out.put("steigend", steigend);
        out.put("mit_nullen", mitNullen);
        List<BigDecimal> letzteNull = new ArrayList<>(Collections.nCopies(Math.max(n - 1, 0), BigDecimal.valueOf(5)));
        letzteNull.add(n > 1 ? BigDecimal.ZERO : BigDecimal.valueOf(5));
        out.put("letzte_null", letzteNull);
        out.put("unregelmaessig", unregelmaessig);
        return out;
    }

    @ParameterizedTest(name = "{0} Viertelstunden, Zuwachs {1}, Profil {2}")
    @MethodSource("faelle")
    void summeDerGespeichertenAnteileIstExaktDerGemesseneZuwachs(int n, BigDecimal zuwachs, String profil,
            List<BigDecimal> gewichte) {
        List<BigDecimal> anteile = VerbrauchRegeln.verteilen(zuwachs, gewichte);
        assertThat(anteile).hasSize(n);
        BigDecimal summe = anteile.stream().reduce(BigDecimal.ZERO, BigDecimal::add);
        assertThat(summe).as("Summe = Zuwachs (%s)", profil).usingComparator(BigDecimal::compareTo).isEqualTo(zuwachs);
        assertThat(anteile).as("kein negativer Anteil").allMatch(a -> a.signum() >= 0);

        BigDecimal stelle = BigDecimal.ONE.movePointLeft(VerbrauchRegeln.ERSATZWERT_STELLEN);
        BigDecimal gewichtSumme = gewichte.stream().reduce(BigDecimal.ZERO, BigDecimal::add);
        MathContext genau = new MathContext(60, RoundingMode.HALF_EVEN);
        for (int i = 0; i + 1 < n; i++) {
            BigDecimal exakt = zuwachs.multiply(gewichte.get(i)).divide(gewichtSumme, genau);
            BigDecimal a = anteile.get(i);
            assertThat(a.stripTrailingZeros().scale()).as("höchstens %d Stellen", VerbrauchRegeln.ERSATZWERT_STELLEN)
                    .isLessThanOrEqualTo(VerbrauchRegeln.ERSATZWERT_STELLEN);
            assertThat(exakt.subtract(a)).as("abgeschnitten, nie aufgerundet").satisfies(
                    d -> assertThat(d.signum()).isGreaterThanOrEqualTo(0),
                    d -> assertThat(d.compareTo(stelle)).isLessThan(0));
        }
        // Der Rest aus dem Abschneiden steht in der LETZTEN Viertelstunde und ist kleiner als n × 10⁻⁹.
        BigDecimal rest = anteile.get(n - 1)
                .subtract(zuwachs.multiply(gewichte.get(n - 1)).divide(gewichtSumme, genau));
        assertThat(rest.signum()).as("Rest nie negativ").isGreaterThanOrEqualTo(0);
        assertThat(rest.compareTo(stelle.multiply(BigDecimal.valueOf(n)))).as("Rest < n × 10⁻⁹").isLessThan(0);
    }

    /** 100 kWh über drei Viertelstunden: 33,333333333 + 33,333333333 + 33,333333334 — und die Gegenprobe. */
    @Test
    void derRundungsrestHatEineBenannteStelle() {
        assertThat(VerbrauchRegeln.verteilen(BigDecimal.valueOf(100), Collections.nCopies(3, BigDecimal.ONE)))
                .usingElementComparator(BigDecimal::compareTo)
                .containsExactly(new BigDecimal("33.333333333"), new BigDecimal("33.333333333"),
                        new BigDecimal("33.333333334"));
        BigDecimal gerundet = BigDecimal.valueOf(100).divide(BigDecimal.valueOf(3), 9, RoundingMode.HALF_UP);
        assertThat(gerundet.multiply(BigDecimal.valueOf(3)))
                .as("Gegenprobe: jeden Anteil zu runden verlöre den Rest")
                .isNotEqualByComparingTo(BigDecimal.valueOf(100));
    }

    /** F11: 1 872,0 kWh auf 78 Viertelstunden sind 78 × 24,0 — ohne jeden Rest. */
    @Test
    void f11GehtOhneRestAuf() {
        List<BigDecimal> anteile = VerbrauchRegeln.verteilen(new BigDecimal("1872.0"),
                Collections.nCopies(78, BigDecimal.ONE));
        assertThat(anteile).allMatch(a -> a.compareTo(new BigDecimal("24")) == 0);
    }
}
