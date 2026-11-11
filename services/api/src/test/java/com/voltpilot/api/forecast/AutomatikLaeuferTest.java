package com.voltpilot.api.forecast;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.ForecastRueckblickRepository.ModellVergleich;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die Entscheidungsregel der Verbrauchs-Automatik (S5, Bericht R.4), rein und
 * Docker-frei (das {@code ForecastModelsTest}/{@code RolloutStates}-Muster) -
 * {@link AutomatikLaeufer#entscheide} ist der Vertrag, den der Läufer nur
 * noch ausführt.
 */
class AutomatikLaeuferTest {

    private static final String BASIS = "load-persistence";
    private static final int MINDESTTAGE = 28;
    private static final double SCHWELLE = 0.9;

    private static ModellVergleich of(String model, double meanMaeKw, double meanTagesfehlerKwh, int tage) {
        return new ModellVergleich(model, meanMaeKw, meanTagesfehlerKwh, tage);
    }

    @Test
    void einKandidatMitMindestens10ProzentKleinerenFehlerUndNichtGroesseremTagesfehlerUebernimmt() {
        List<ModellVergleich> vergleich = List.of(
                of(BASIS, 1.0, 10.0, MINDESTTAGE),
                of("load-xgb", 0.89, 9.5, MINDESTTAGE)); // 11 % kleiner, Tag nicht größer
        assertThat(AutomatikLaeufer.entscheide(vergleich, BASIS, BASIS, MINDESTTAGE, SCHWELLE))
                .isEqualTo("load-xgb");
    }

    @Test
    void wenigerAlsZehnProzentKleinerBleibtBeimBasismodell() {
        List<ModellVergleich> vergleich = List.of(
                of(BASIS, 1.0, 10.0, MINDESTTAGE),
                of("load-xgb", 0.95, 9.5, MINDESTTAGE)); // nur 5 % kleiner
        assertThat(AutomatikLaeufer.entscheide(vergleich, BASIS, BASIS, MINDESTTAGE, SCHWELLE)).isNull();
    }

    @Test
    void einGroessererTagesfehlerVerhindertDieUebernahmeTrotzKleineremViertelstundenfehler() {
        List<ModellVergleich> vergleich = List.of(
                of(BASIS, 1.0, 10.0, MINDESTTAGE),
                of("load-xgb", 0.5, 15.0, MINDESTTAGE)); // viel genauer je Viertelstunde, aber am Tag schlechter
        assertThat(AutomatikLaeufer.entscheide(vergleich, BASIS, BASIS, MINDESTTAGE, SCHWELLE)).isNull();
    }

    @Test
    void erfuellenMehrereKandidatenDieSchwelleGewinntDerKleinsteFehler() {
        List<ModellVergleich> vergleich = List.of(
                of(BASIS, 1.0, 10.0, MINDESTTAGE),
                of("load-xgb", 0.7, 9.0, MINDESTTAGE),
                of("load-profile", 0.6, 9.0, MINDESTTAGE));
        assertThat(AutomatikLaeufer.entscheide(vergleich, BASIS, BASIS, MINDESTTAGE, SCHWELLE))
                .isEqualTo("load-profile");
    }

    @Test
    void wenigerAlsDieMindesttageAmBasismodellVerhindertJedeEntscheidung() {
        List<ModellVergleich> vergleich = List.of(
                of(BASIS, 1.0, 10.0, MINDESTTAGE - 1),
                of("load-xgb", 0.1, 1.0, MINDESTTAGE));
        assertThat(AutomatikLaeufer.entscheide(vergleich, BASIS, BASIS, MINDESTTAGE, SCHWELLE)).isNull();
    }

    @Test
    void einKandidatMitZuWenigTagenZaehltNicht() {
        List<ModellVergleich> vergleich = List.of(
                of(BASIS, 1.0, 10.0, MINDESTTAGE),
                of("load-xgb", 0.1, 1.0, MINDESTTAGE - 1));
        assertThat(AutomatikLaeufer.entscheide(vergleich, BASIS, BASIS, MINDESTTAGE, SCHWELLE)).isNull();
    }

    @Test
    void ohneBasismodellInDerTabelleGibtEsKeineEntscheidung() {
        List<ModellVergleich> vergleich = List.of(of("load-xgb", 0.1, 1.0, MINDESTTAGE));
        assertThat(AutomatikLaeufer.entscheide(vergleich, BASIS, BASIS, MINDESTTAGE, SCHWELLE)).isNull();
    }

    @Test
    void einBereitsAktiverGewinnerLoestKeineErneuteUebernahmeAus() {
        List<ModellVergleich> vergleich = List.of(
                of(BASIS, 1.0, 10.0, MINDESTTAGE),
                of("load-xgb", 0.5, 9.0, MINDESTTAGE));
        // "load-xgb" ist bereits aktiv - derselbe Gewinner bedeutet "nichts zu tun".
        assertThat(AutomatikLaeufer.entscheide(vergleich, BASIS, "load-xgb", MINDESTTAGE, SCHWELLE)).isNull();
    }

    @Test
    void liegtDerZuvorUebernommeneKandidatNichtMehrVornGiltWiederDasBasismodellOhneEigenenRueckwegCode() {
        // "load-xgb" ist aktiv, liegt heute aber nicht mehr 10 % unter der Basis.
        List<ModellVergleich> vergleich = List.of(
                of(BASIS, 1.0, 10.0, MINDESTTAGE),
                of("load-xgb", 0.95, 9.5, MINDESTTAGE));
        assertThat(AutomatikLaeufer.entscheide(vergleich, BASIS, "load-xgb", MINDESTTAGE, SCHWELLE))
                .isEqualTo(BASIS);
    }
}
