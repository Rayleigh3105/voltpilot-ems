package com.voltpilot.api.forecast;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * Die Präzedenz des Prognose-Schalters, rein und Docker-frei (das
 * {@code Tagesprotokoll}/{@code RolloutStates}-Muster).
 *
 * <p>Sie ist der Vertrag, den Migration, api und Optimierer wortgleich tragen -
 * hier ist er ein Test statt einer Behauptung.
 */
class ForecastModelsTest {

    @Test
    void withoutAnyConfigurationTheBaselinePlans() {
        // Die Rückwärts-Sicherheit: keine Wahl, keine Umgebung -> wie ausgeliefert.
        assertThat(ForecastModels.resolve(ForecastModels.KIND_LOAD, null, null))
                .isEqualTo(ForecastModels.LOAD_PERSISTENCE);
        assertThat(ForecastModels.resolve(ForecastModels.KIND_PV, null, null))
                .isEqualTo(ForecastModels.PV_PHYSICAL);
    }

    @Test
    void theEnvironmentIsTheDefaultAndThePortalChoiceBeatsIt() {
        assertThat(ForecastModels.resolve(ForecastModels.KIND_LOAD, null, "load-xgb"))
                .isEqualTo(ForecastModels.LOAD_XGB);
        // Ein späterer Env-Edit darf die bewusste Portal-Entscheidung nicht
        // stillschweigend zurücknehmen - deshalb gewinnt die Zeile.
        assertThat(ForecastModels.resolve(
                        ForecastModels.KIND_LOAD, "load-xgb", "load-persistence"))
                .isEqualTo(ForecastModels.LOAD_XGB);
    }

    @Test
    void anUnusableValueIsDiscardedNeverAdopted() {
        // Unbekannte Id (Tippfehler) und art-fremde Id fallen BEIDE auf das
        // Basismodell zurück: ein Modell ohne gespeicherte Prognosezeilen ließe
        // den Optimierer still auf seine Persistenz-Baseline zurückfallen,
        // während das Portal weiter „live" anzeigt.
        assertThat(ForecastModels.resolve(ForecastModels.KIND_LOAD, "load_xgb", null))
                .isEqualTo(ForecastModels.LOAD_PERSISTENCE);
        assertThat(ForecastModels.resolve(ForecastModels.KIND_LOAD, "pv-physical", null))
                .isEqualTo(ForecastModels.LOAD_PERSISTENCE);
        assertThat(ForecastModels.resolve(ForecastModels.KIND_LOAD, "", "  "))
                .isEqualTo(ForecastModels.LOAD_PERSISTENCE);
        // Eine kaputte Wahl NEBEN einer gültigen Umgebung: die Umgebung greift.
        assertThat(ForecastModels.resolve(ForecastModels.KIND_LOAD, "pv-physical", "load-xgb"))
                .isEqualTo(ForecastModels.LOAD_XGB);
    }

    /**
     * Die VOLLE Präzedenz der Migration V20260826000000 (Captain-Auftrag
     * 19.08.2026): <b>Anlagen-Wahl &gt; Plattform-Vorgabe &gt; Umgebung &gt;
     * Basismodell</b>. Sie ist das Abnahmekriterium des ganzen Umbaus - nur
     * DIESE Anlage plant mit dem Kandidaten.
     */
    @Test
    void theSiteChoiceBeatsThePlatformDefaultWhichBeatsTheEnvironment() {
        // Anlage gewinnt über Plattform UND Umgebung.
        assertThat(ForecastModels.resolve(
                        ForecastModels.KIND_LOAD, "load-xgb", "load-persistence", "load-persistence"))
                .isEqualTo(ForecastModels.LOAD_XGB);
        // Ohne Anlagen-Wahl gilt die Plattform-Vorgabe ...
        assertThat(ForecastModels.resolve(
                        ForecastModels.KIND_LOAD, null, "load-xgb", "load-persistence"))
                .isEqualTo(ForecastModels.LOAD_XGB);
        // ... ohne beide die Umgebung ...
        assertThat(ForecastModels.resolve(ForecastModels.KIND_LOAD, null, null, "load-xgb"))
                .isEqualTo(ForecastModels.LOAD_XGB);
        // ... und ohne alles das Basismodell (die Rückwärts-Sicherheit).
        assertThat(ForecastModels.resolve(ForecastModels.KIND_LOAD, null, null, null))
                .isEqualTo(ForecastModels.LOAD_PERSISTENCE);
    }

    @Test
    void anUnusableSiteChoiceFallsThroughToTheNextStageNeverToTheBaseline() {
        // Eine von Hand eingetragene, art-fremde Anlagen-Zeile darf die
        // Plattform-Vorgabe nicht mit ins Nichts reißen.
        assertThat(ForecastModels.resolve(
                        ForecastModels.KIND_LOAD, "pv-physical", "load-xgb", null))
                .isEqualTo(ForecastModels.LOAD_XGB);
        assertThat(ForecastModels.resolve(
                        ForecastModels.KIND_LOAD, "load_xgb", null, "load-xgb"))
                .isEqualTo(ForecastModels.LOAD_XGB);
        // Die alte Drei-Argument-Form ist die Zwei-Stufen-Auflösung - sie bleibt
        // gültig, damit der plattformweite Schalter unverändert weiterläuft.
        assertThat(ForecastModels.resolve(ForecastModels.KIND_PV, "pv-residual-xgb", null))
                .isEqualTo(ForecastModels.PV_RESIDUAL_XGB);
    }

    @Test
    void theVocabularyIsTheOneSharedWithTheForecastRegistry() {
        assertThat(ForecastModels.kinds()).containsExactly("load", "pv");
        assertThat(ForecastModels.modelsOf(ForecastModels.KIND_LOAD))
                .containsExactly("load-persistence", "load-xgb");
        assertThat(ForecastModels.modelsOf(ForecastModels.KIND_PV))
                .containsExactly("pv-physical", "pv-residual-xgb");
        assertThat(ForecastModels.kindOf("pv-residual-xgb")).isEqualTo("pv");
        assertThat(ForecastModels.kindOf("nichts-davon")).isNull();
        assertThat(ForecastModels.isKind("waerme")).isFalse();
        assertThat(ForecastModels.known()).hasSize(4);
    }
}
