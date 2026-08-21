package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import java.math.BigDecimal;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Die reinen Regeln des Bestandskontos (Diagnose {@code vp-tagesbild-minus-f3}
 * §6.1) - Docker-frei, wie {@link MeasuredSlots} / {@code Tagesprotokoll}.
 *
 * <p>Die Zahlen des 21.08.2026 (Pilsting/Herzogau) sind der Anker: Ladestand
 * 24 % → 92 % an einem 65-kWh-Speicher, λ 18,9 ct/kWh ⇒ ≈ 44,2 kWh ⇒ ≈ +8,35 €.
 * Mit dieser Gutschrift dreht die Anzeige von −4,69 € auf ≈ +3,7 €.
 */
class SpeicherBankTest {

    private static final BigDecimal CAPACITY = new BigDecimal("65.00");
    private static final BigDecimal LAMBDA = new BigDecimal("18.9000");

    private static BigDecimal bd(String v) {
        return new BigDecimal(v);
    }

    @Test
    @DisplayName("Der 21.08.: 24 % → 92 % an 65 kWh sind ≈ 44 kWh und ≈ +8,35 €")
    void derLiveFallVomEinundzwanzigstenAugust() {
        SpeicherBank.Bestand b =
                SpeicherBank.of(bd("92.00"), bd("24.00"), CAPACITY, LAMBDA, null);

        assertThat(b.deltaKwh().doubleValue()).isCloseTo(44.2, within(0.001));
        assertThat(b.wertCtKwh()).isEqualByComparingTo(LAMBDA);
        assertThat(b.wertEur().doubleValue()).isCloseTo(8.3538, within(0.0005));
        assertThat(b.basis()).isEqualTo(SpeicherBank.BASIS_PLAN);

        // Der ganze Zweck: die Tageszahl dreht vom Minus ins Plus.
        double angezeigt = -4.69 + b.wertEur().doubleValue();
        assertThat(angezeigt).isCloseTo(3.66, within(0.02));
    }

    @Test
    @DisplayName("Ein NEGATIVES Delta ist die Auflösung der Bank - und wird gezeigt")
    void dieBankDesVortagsWirdVerbraucht() {
        SpeicherBank.Bestand b =
                SpeicherBank.of(bd("10.00"), bd("60.00"), CAPACITY, LAMBDA, null);

        assertThat(b.deltaKwh().doubleValue()).isCloseTo(-32.5, within(0.001));
        assertThat(b.wertEur().doubleValue()).isCloseTo(-6.1425, within(0.0005));
        assertThat(b.basis()).isEqualTo(SpeicherBank.BASIS_PLAN);
    }

    @Test
    @DisplayName("Ein leerer Speicher am Tagesende bankt nichts - 0 ist hier eine MESSUNG")
    void tagesendeMitLeeremSpeicher() {
        SpeicherBank.Bestand b =
                SpeicherBank.of(bd("5.00"), bd("5.00"), CAPACITY, LAMBDA, null);

        assertThat(b.deltaKwh()).isEqualByComparingTo(BigDecimal.ZERO);
        assertThat(b.wertEur()).isEqualByComparingTo(BigDecimal.ZERO);
        // Eine gemessene Null ist eine Aussage - sie darf nicht als "unbekannt"
        // aus der Antwort fallen; die Fläche entscheidet über ihr Totband.
        assertThat(b.basis()).isEqualTo(SpeicherBank.BASIS_PLAN);
    }

    @Test
    @DisplayName("Ohne λ trägt der Terminalwert - und sagt es (FK2-Rückfall)")
    void ohneLambdaGiltDerTerminalwert() {
        SpeicherBank.Bestand b =
                SpeicherBank.of(bd("92.00"), bd("24.00"), CAPACITY, null, bd("0.155000"));

        assertThat(b.wertCtKwh().doubleValue()).isCloseTo(15.5, within(1e-9));
        assertThat(b.wertEur().doubleValue()).isCloseTo(6.851, within(0.001));
        assertThat(b.basis()).isEqualTo(SpeicherBank.BASIS_TERMINAL);
    }

    @Test
    @DisplayName("λ schlägt den Terminalwert - es ist der Wert IM Slot")
    void lambdaSchlaegtDenTerminalwert() {
        SpeicherBank.Bestand b =
                SpeicherBank.of(bd("92.00"), bd("24.00"), CAPACITY, LAMBDA, bd("0.155000"));

        assertThat(b.wertCtKwh()).isEqualByComparingTo(LAMBDA);
        assertThat(b.basis()).isEqualTo(SpeicherBank.BASIS_PLAN);
    }

    @Test
    @DisplayName("Ohne jede Bewertung bleiben die gemessenen kWh - und der Euro ist NULL")
    void ohneBewertungNurDieKwh() {
        SpeicherBank.Bestand b =
                SpeicherBank.of(bd("92.00"), bd("24.00"), CAPACITY, null, null);

        assertThat(b.deltaKwh().doubleValue()).isCloseTo(44.2, within(0.001));
        assertThat(b.wertCtKwh()).isNull();
        assertThat(b.wertEur()).isNull();
        assertThat(b.basis()).isNull();
    }

    @Test
    @DisplayName("Ein fehlender Ladestand behauptet NICHTS - nie eine erfundene 0")
    void ohneLadestandKeineBehauptung() {
        assertThat(SpeicherBank.of(null, bd("24.00"), CAPACITY, LAMBDA, null).deltaKwh()).isNull();
        assertThat(SpeicherBank.of(bd("92.00"), null, CAPACITY, LAMBDA, null).deltaKwh()).isNull();
        assertThat(SpeicherBank.of(bd("92.00"), bd("24.00"), null, LAMBDA, null).deltaKwh())
                .isNull();
        assertThat(SpeicherBank.of(bd("92.00"), bd("24.00"), BigDecimal.ZERO, LAMBDA, null)
                .deltaKwh()).isNull();
        // Ohne Delta gibt es auch keinen Euro - aber die Bewertung selbst darf
        // ehrlich mitreisen (sie ist gemessen, nur ihr Bezug fehlt).
        SpeicherBank.Bestand ohne = SpeicherBank.of(null, null, CAPACITY, LAMBDA, null);
        assertThat(ohne.wertEur()).isNull();
        assertThat(ohne.wertCtKwh()).isEqualByComparingTo(LAMBDA);
    }

    @Test
    @DisplayName("NONE ist vier ehrliche Nullen")
    void noneIstLeer() {
        assertThat(SpeicherBank.Bestand.NONE.deltaKwh()).isNull();
        assertThat(SpeicherBank.Bestand.NONE.wertCtKwh()).isNull();
        assertThat(SpeicherBank.Bestand.NONE.wertEur()).isNull();
        assertThat(SpeicherBank.Bestand.NONE.basis()).isNull();
    }
}
