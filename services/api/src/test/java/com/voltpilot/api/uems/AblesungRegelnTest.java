package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die Sätze der Ablesungen (AP-09 Z6/F17) als Kennzeichen des Ergebnis-Vertrags (ergebnis-zustand 1.13): was
 * {@link AblesungRegeln} spricht, erkennt {@link ErgebnisZustand} - und ein Jahr, dem Monate fehlen, sagt es. Bis 1.12
 * war „Ablesezeitraum“ ein vorgesehenes Wort, und keine Fläche sprach einen Monat oder ein Jahr aus Ablesungen. Rein.
 */
class AblesungRegelnTest {

    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");

    private static String monatsSatz(String von, String bis) {
        return "Ablesezeitraum " + von + " – " + bis + " (Zuordnung durch den Kunden)";
    }

    @Test
    void derAblesezeitraumIstEinKennzeichenDesVertrags() {
        // B8 (bezugsdaten-vectors.json): MS-21 Gas, 01.10. 07:15 MESZ bis 02.11. 07:40 MEZ, 48 211 → 49 451 m³.
        AblesungRegeln.Zeitraum z = AblesungRegeln.zeitraum(Instant.parse("2026-10-01T05:15:00Z"),
                new BigDecimal("48211"), Instant.parse("2026-11-02T06:40:00Z"), new BigDecimal("49451"), "m³", BERLIN);
        assertThat(z.menge()).isEqualByComparingTo("1240");
        assertThat(z.zustand()).isEqualTo(ErgebnisZustand.VOLLSTAENDIG);
        assertThat(z.kennzeichen()).isEqualTo(monatsSatz("01.10. 07:15", "02.11. 07:40"));

        ErgebnisZustand.Erkannt e = ErgebnisZustand.erkenne(z.kennzeichen());
        assertThat(e).isNotNull();
        assertThat(e.muster().schluessel()).isEqualTo("ablesezeitraum");
        assertThat(e.muster().rang()).isEqualTo(60);
        assertThat(e.muster().fehlbestand()).isFalse();
        assertThat(ErgebnisZustand.vorgesehen(z.kennzeichen())).isFalse();
        assertThat(ErgebnisZustand.VORGESEHEN).extracting(ErgebnisZustand.Vorgesehen::wort)
                .doesNotContain("Ablesezeitraum");

        ErgebnisZustand.Ergebnis oktober = new ErgebnisZustand.Ergebnis(z.menge(), "m³", "monat", z.zustand(), null,
                List.of(z.kennzeichen()));
        assertThat(ErgebnisZustand.pruefe(oktober)).isEmpty();
        assertThat(ErgebnisZustand.satz(oktober))
                .isEqualTo("1.240,0 m³ · vollständig · " + monatsSatz("01.10. 07:15", "02.11. 07:40"));
    }

    @Test
    void dieDoppelteStundeTraegtIhrenZusatz() {
        // 25.10.2026: 02:30 gibt es zweimal - die zweite (MEZ) ist 01:30 UTC (E10, wie jede Uhrzeit in einem Kennzeichen).
        AblesungRegeln.Zeitraum z = AblesungRegeln.zeitraum(Instant.parse("2026-10-25T01:30:00Z"), new BigDecimal("10"),
                Instant.parse("2026-11-02T06:40:00Z"), new BigDecimal("20"), "kWh", BERLIN);
        assertThat(z.kennzeichen()).isEqualTo(monatsSatz("25.10. 02:30 MEZ", "02.11. 07:40"));
        assertThat(ErgebnisZustand.erkenne(z.kennzeichen()).werte())
                .containsEntry("von", "25.10. 02:30 MEZ").containsEntry("bis", "02.11. 07:40");
    }

    @Test
    void ohneMonatszuordnungSagtDerMonatWarum() {
        ErgebnisZustand.Ergebnis november = new ErgebnisZustand.Ergebnis(null, "kWh", "monat",
                ErgebnisZustand.KEINE_WERTE, null, List.of(ErgebnisZustand.ABLESEZEITRAUM_OHNE_MONAT));
        assertThat(ErgebnisZustand.pruefe(november)).isEmpty();
        assertThat(ErgebnisZustand.satz(november)).isEqualTo("— · keine Werte · Ablesezeitraum ohne Monatszuordnung");
    }

    private static List<AblesungRegeln.Summe> monate(int anzahl, int ersterMonat) {
        List<AblesungRegeln.Summe> out = new ArrayList<>();
        for (int m = ersterMonat; m < ersterMonat + anzahl; m++) {
            String von = String.format("01.%02d. 00:00", m);
            String bis = String.format("01.%02d. 00:00", m == 12 ? 1 : m + 1);
            out.add(new AblesungRegeln.Summe(new BigDecimal("1000"), ErgebnisZustand.VOLLSTAENDIG,
                    List.of(monatsSatz(von, bis))));
        }
        return out;
    }

    private static ErgebnisZustand.Ergebnis alsErgebnis(AblesungRegeln.Summe jahr) {
        return new ErgebnisZustand.Ergebnis(jahr.menge(), "kWh", "jahr", jahr.zustand(), null, jahr.kennzeichen());
    }

    @Test
    void einVollesJahrIstVollstaendigUndNenntJedenAblesezeitraum() {
        AblesungRegeln.Summe jahr = AblesungRegeln.jahr(monate(12, 1));
        assertThat(jahr.menge()).isEqualByComparingTo("12000");
        assertThat(jahr.zustand()).isEqualTo(ErgebnisZustand.VOLLSTAENDIG);
        assertThat(jahr.kennzeichen()).hasSize(12).first().isEqualTo(monatsSatz("01.01. 00:00", "01.02. 00:00"));
        assertThat(ErgebnisZustand.pruefe(alsErgebnis(jahr))).isEmpty();
    }

    @Test
    void einJahrMitFehlendenMonatenSagtZuerstWasFehlt() {
        // MS-20 im Jahr 2024: abgelesen erst seit 01.10. - drei Monate mit Zahl, neun fehlen.
        AblesungRegeln.Summe jahr = AblesungRegeln.jahr(monate(3, 10));
        assertThat(jahr.menge()).isEqualByComparingTo("3000");
        assertThat(jahr.zustand()).isEqualTo(ErgebnisZustand.UNVOLLSTAENDIG);
        assertThat(jahr.kennzeichen()).containsExactly(
                "9 von 12 Intervallmengen fehlen — Menge ist die Summe der gemessenen",
                monatsSatz("01.10. 00:00", "01.11. 00:00"),
                monatsSatz("01.11. 00:00", "01.12. 00:00"),
                monatsSatz("01.12. 00:00", "01.01. 00:00"));
        assertThat(ErgebnisZustand.pruefe(alsErgebnis(jahr))).isEmpty();

        // Ein Monat fehlt: die Einzahl des Satzes.
        AblesungRegeln.Summe elf = AblesungRegeln.jahr(monate(11, 1));
        assertThat(elf.kennzeichen().get(0))
                .isEqualTo("1 von 12 Intervallmengen fehlt — Menge ist die Summe der gemessenen");
        assertThat(ErgebnisZustand.pruefe(alsErgebnis(elf))).isEmpty();

        // So stand das Jahr bis 1.12 da: unvollständig ohne Grund - der Vertrag spricht es nicht.
        List<String> ohneGrund = jahr.kennzeichen().subList(1, jahr.kennzeichen().size());
        assertThat(ErgebnisZustand.pruefe(new ErgebnisZustand.Ergebnis(jahr.menge(), "kWh", "jahr",
                ErgebnisZustand.UNVOLLSTAENDIG, null, ohneGrund))).containsExactly("unvollstaendig_ohne_grund");
    }

    @Test
    void einJahrOhneMonatMitZahlHatKeineWerte() {
        AblesungRegeln.Summe jahr = AblesungRegeln.jahr(List.of());
        assertThat(jahr.menge()).isNull();
        assertThat(jahr.zustand()).isEqualTo(ErgebnisZustand.KEINE_WERTE);
        assertThat(jahr.kennzeichen()).isEmpty();
        assertThat(ErgebnisZustand.pruefe(alsErgebnis(jahr))).isEmpty();
        assertThatThrownBy(() -> AblesungRegeln.jahr(List.of(new AblesungRegeln.Summe(null,
                ErgebnisZustand.KEINE_WERTE, List.of())))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> AblesungRegeln.jahr(monate(13, 1))).isInstanceOf(IllegalArgumentException.class);
    }
}
