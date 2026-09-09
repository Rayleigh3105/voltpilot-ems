package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die KURVEN-VORLAGE der SoC-Ableitung (P5b Ebene 2), ohne Docker und ohne
 * Spring.
 *
 * <p><b>Was dieser Test wirklich bewacht:</b> die Vorlage, die das Portal
 * anbietet, muss Punkt für Punkt dieselbe Tabelle sein, die die Box rechnet.
 * Die eine Wahrheit sind die geteilten Vektoren
 * ({@code docs/contracts/v2/soc-derivation-vectors.json}) - sie tragen die
 * Zahlen VERBATIM aus dem Home-Assistant-/Node-RED-Flow des Kunden
 * (09.09.2026). Der JavaScript-Zwilling
 * ({@code vp-palette/test/soc_derive_spec.js}) fährt dieselbe Datei durch die
 * echte Rechnung; hier wird bewiesen, dass die AUSGELIEFERTE Vorlage nicht
 * davon abgedriftet ist. Ohne diesen Test könnte ein Tippfehler in einer
 * Stützstelle einen Ladestand um Dutzende Prozentpunkte verschieben, ohne dass
 * irgendetwas rot würde.
 */
class SocCurveTemplateTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final SocCurveTemplateCatalog CATALOG = new SocCurveTemplateCatalog(MAPPER);

    private static JsonNode vectors() throws Exception {
        return MAPPER.readTree(Files.readString(Path.of("..", "..", "docs", "contracts", "v2",
                "soc-derivation-vectors.json")));
    }

    @Test
    void dieAusgelieferteVorlageIstPunktFuerPunktDerBeleg() throws Exception {
        JsonNode expected = vectors().path("vorlage");
        SocCurveTemplateCatalog.Template t = CATALOG.find(expected.path("id").asText());
        assertThat(t).as("die Vorlage des Belegs muss im Katalog stehen").isNotNull();

        assertCurve(t.curveCharge(), expected.path("curve_charge"), "curve_charge");
        assertCurve(t.curveDischarge(), expected.path("curve_discharge"), "curve_discharge");
        assertThat(t.cellsInSeries()).isEqualTo(expected.path("cells_in_series").asInt());
        assertThat(t.refTempC()).isEqualTo(expected.path("ref_temp_c").asDouble());
    }

    /**
     * ⚠ CHEMIE. Der Pack des Kunden ist NMC/NCA (Zellfenster 3,26-4,18 V).
     * Dieselbe Spannung bedeutet an einer LiFePO4-Zelle einen völlig anderen
     * Ladestand - eine falsch zugeordnete Vorlage ist deshalb kein
     * Schönheitsfehler, sondern ein falscher Ladestand mit Nachkommastellen.
     * Die Vorlage muss ihre Chemie und ihr Fenster darum sichtbar nennen.
     */
    @Test
    void jedeVorlageNenntIhreChemieUndIhrZellfenster() {
        for (SocCurveTemplateCatalog.Template t : CATALOG.all()) {
            assertThat(t.chemistry()).as(t.id() + " nennt seine Chemie").isNotBlank();
            assertThat(t.cellMinV()).as(t.id() + " nennt seine untere Zellspannung").isNotNull();
            assertThat(t.cellMaxV()).as(t.id() + " nennt seine obere Zellspannung").isNotNull();
            assertThat(t.source()).as(t.id() + " nennt, WOHER die Tabelle stammt").isNotBlank();
            // Das genannte Fenster muss die Tabelle auch decken - sonst
            // beschriebe es eine andere Kurve als die ausgelieferte.
            assertThat(t.curveCharge().get(0)[0]).isEqualTo(t.cellMinV());
            assertThat(t.curveCharge().get(t.curveCharge().size() - 1)[0]).isEqualTo(t.cellMaxV());
        }
    }

    /**
     * Eine Vorlage, die die Regel ihrer eigenen Fläche nicht besteht, wäre eine
     * Falle mit Gütesiegel: der Katalog schickt jede Tabelle beim Start durch
     * EXAKT dieselbe Prüfung wie eine selbst eingetippte Kurve. Dieser Test
     * hält fest, dass er das wirklich tut.
     */
    @Test
    void jedeVorlageBestehtDieRegelIhrerEigenenFlaeche() {
        for (SocCurveTemplateCatalog.Template t : CATALOG.all()) {
            List<String> errors = new java.util.ArrayList<>();
            assertThat(UserDefinedBatteryDefinition.checkCurve(t.curveCharge(), "Ladekurve",
                    errors)).isNotNull();
            if (t.curveDischarge() != null) {
                assertThat(UserDefinedBatteryDefinition.checkCurve(t.curveDischarge(),
                        "Entladekurve", errors)).isNotNull();
            }
            assertThat(errors).as(t.id()).isEmpty();
        }
    }

    /** Ein unbekannter Name wird nie geraten - er ist schlicht nicht da. */
    @Test
    void einUnbekannterNameErgibtKeineVorlage() {
        assertThat(CATALOG.find("gibt-es-nicht")).isNull();
        assertThat(CATALOG.find(null)).isNull();
    }

    private static void assertCurve(List<double[]> actual, JsonNode expected, String what) {
        assertThat(actual).as(what + ": Zahl der Stützpunkte").hasSize(expected.size());
        for (int i = 0; i < expected.size(); i++) {
            assertThat(actual.get(i)[0]).as(what + " Punkt " + i + " Spannung")
                    .isEqualTo(expected.get(i).get(0).asDouble());
            assertThat(actual.get(i)[1]).as(what + " Punkt " + i + " Ladestand")
                    .isEqualTo(expected.get(i).get(1).asDouble());
        }
    }
}
