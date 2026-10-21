package com.voltpilot.api.erzeuger;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.web.dto.AnlagensteuerungDto;
import java.math.BigDecimal;
import java.time.Instant;
import org.junit.jupiter.api.Test;

/** Rein, ohne Docker: der Vergleich Ist gegen Soll des Programmstands (UEMS EZ-16). */
class ProgrammstandTest {

    private static final Instant GELESEN = Instant.parse("2026-10-21T12:00:00Z");

    @Test
    void gleichOderNeuerIstAktuellAelterWarnt() {
        Programmstand.Vergleich gleich = Programmstand.vergleiche(new BigDecimal("2610"), GELESEN, 2610);
        assertThat(gleich.zustand()).isEqualTo(Programmstand.AKTUELL);
        assertThat(gleich.istText()).isEqualTo("26.10");
        assertThat(gleich.warnen()).isFalse();

        assertThat(Programmstand.vergleiche(new BigDecimal("2701"), GELESEN, 2610).zustand())
                .as("ein neuerer Stand ist nicht alt").isEqualTo(Programmstand.AKTUELL);

        Programmstand.Vergleich alt = Programmstand.vergleiche(new BigDecimal("2605"), GELESEN, 2610);
        assertThat(alt.zustand()).isEqualTo(Programmstand.AELTER);
        assertThat(alt.istText()).isEqualTo("26.05");
        assertThat(alt.sollText()).isEqualTo("26.10");
        assertThat(alt.gemessenAm()).isEqualTo(GELESEN);
        assertThat(alt.warnen()).isTrue();
        // Jahreswechsel: JJMM wächst monoton.
        assertThat(Programmstand.vergleiche(new BigDecimal("2612"), GELESEN, 2701).zustand())
                .isEqualTo(Programmstand.AELTER);
    }

    @Test
    void ohneSollDerFassungGiltDieBibliothek() {
        Programmstand.Vergleich v = Programmstand.vergleiche(new BigDecimal(Programmstand.BIBLIOTHEK), GELESEN, null);
        assertThat(v.soll()).isEqualTo(Programmstand.BIBLIOTHEK);
        assertThat(v.sollAusFassung()).isFalse();
        assertThat(v.zustand()).isEqualTo(Programmstand.AKTUELL);
        assertThat(Programmstand.vergleiche(new BigDecimal("2605"), GELESEN, 2605).sollAusFassung()).isTrue();
    }

    @Test
    void keinOderUngueltigerWertIstUnbekanntNieNull() {
        for (BigDecimal roh : new BigDecimal[] {null, new BigDecimal("65535"), new BigDecimal("0"),
                new BigDecimal("2613"), new BigDecimal("2600"), new BigDecimal("2610.5"), new BigDecimal("-2610"),
                new BigDecimal("12000")}) {
            Programmstand.Vergleich v = Programmstand.vergleiche(roh, GELESEN, 2610);
            assertThat(v.zustand()).as("roh %s", roh).isEqualTo(Programmstand.UNBEKANNT);
            assertThat(v.ist()).isNull();
            assertThat(v.gemessenAm()).as("kein Datenalter ohne Wert").isNull();
            assertThat(v.warnen()).isFalse();
        }
        assertThat(Programmstand.vergleiche(new BigDecimal("2610.0"), GELESEN, 2610).zustand())
                .isEqualTo(Programmstand.AKTUELL);
    }

    @Test
    void dieFormDerRouteNenntDieQuelleDesSolls() {
        AnlagensteuerungDto.Programmstand dto = AnlagensteuerungService.programmstand(
                Programmstand.vergleiche(new BigDecimal("2605"), GELESEN, null));
        assertThat(dto.sollQuelle()).isEqualTo("bibliothek");
        assertThat(dto.warnen()).isTrue();
        assertThat(dto.gemessenAm()).isNotNull();
        assertThat(AnlagensteuerungService.programmstand(Programmstand.vergleiche(null, GELESEN, 2605)).gemessenAm())
                .isNull();
    }
}
