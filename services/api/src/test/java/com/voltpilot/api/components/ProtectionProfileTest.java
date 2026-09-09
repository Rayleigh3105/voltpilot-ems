package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die SCHUTZ-VORLAGE des Grenzbausteins (P5c), ohne Docker und ohne Spring.
 *
 * <p><b>Was dieser Test wirklich bewacht:</b> die Vorlage, die das Portal
 * anbietet, muss Stufe für Stufe dieselbe Treppe sein, die die Box rechnet -
 * und die vier Zellspannungs-Schwellen müssen auf das Millivolt dieselben sein.
 * Die eine Wahrheit sind die geteilten Vektoren
 * ({@code docs/contracts/v2/limit-protection-vectors.json}) mit den Zahlen
 * VERBATIM aus dem Node-RED-Flow des Kunden (09.09.2026). Der
 * JavaScript-Zwilling ({@code vp-palette/test/limit_guard_spec.js}) fährt
 * dieselbe Datei durch die echte Rechnung, der Go-Zwilling
 * ({@code guards/bmslimit_test.go}) durch die echte Wächter-Kappe; hier wird
 * bewiesen, dass die AUSGELIEFERTE Vorlage nicht davon abgedriftet ist.
 *
 * <p>Ohne diesen Test könnte ein Tippfehler in einer Schwelle einen Hartstopp
 * um 100 mV verschieben - und ein Hartstopp an der falschen Spannung ist genau
 * das, wogegen es diesen Baustein gibt.
 */
class ProtectionProfileTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final ProtectionProfileCatalog CATALOG = new ProtectionProfileCatalog(MAPPER);

    private static JsonNode vectors() throws Exception {
        return MAPPER.readTree(Files.readString(Path.of("..", "..", "docs", "contracts", "v2",
                "limit-protection-vectors.json")));
    }

    @Test
    void dieAusgelieferteVorlageIstStufeFuerStufeDerBeleg() throws Exception {
        JsonNode expected = vectors().path("vorlage");
        ProtectionProfileCatalog.Profile p = CATALOG.find(expected.path("id").asText());
        assertThat(p).as("die Vorlage des Belegs muss im Katalog stehen").isNotNull();

        assertSteps(p.charge().steps(), expected.path("charge").path("steps"), "charge");
        assertSteps(p.discharge().steps(), expected.path("discharge").path("steps"), "discharge");
        assertThat(p.charge().maxA()).isEqualTo(expected.path("charge").path("max_a").asDouble());
        assertThat(p.discharge().maxA())
                .isEqualTo(expected.path("discharge").path("max_a").asDouble());

        JsonNode h = expected.path("hysteresis");
        assertThat(p.hysteresis().chargeStopV()).isEqualTo(h.path("charge_stop_v").asDouble());
        assertThat(p.hysteresis().chargeResumeV()).isEqualTo(h.path("charge_resume_v").asDouble());
        assertThat(p.hysteresis().dischargeStopV())
                .isEqualTo(h.path("discharge_stop_v").asDouble());
        assertThat(p.hysteresis().dischargeResumeV())
                .isEqualTo(h.path("discharge_resume_v").asDouble());
        assertThat(p.roundA()).isEqualTo(expected.path("round_a").asDouble());
        assertThat(p.cellsInSeries()).isEqualTo(expected.path("cells_in_series").asInt());
    }

    /**
     * ⚠ CHEMIE. Der Pack des Kunden ist NMC/NCA. An einer LiFePO4-Zelle wären
     * 3,40 V kein Entlade-Ende, sondern die Mitte der Kennlinie - eine falsch
     * zugeordnete Vorlage schaltet also entweder gar nicht oder viel zu früh
     * ab. Jede Vorlage muss ihre Chemie und ihre Herkunft deshalb sichtbar
     * nennen.
     */
    @Test
    void jedeVorlageNenntIhreChemieUndIhreHerkunft() {
        for (ProtectionProfileCatalog.Profile p : CATALOG.all()) {
            assertThat(p.chemistry()).as(p.id() + " nennt seine Chemie").isNotBlank();
            assertThat(p.source()).as(p.id() + " nennt seine Herkunft").isNotBlank();
            assertThat(p.label()).as(p.id() + " hat eine Bezeichnung").isNotBlank();
        }
    }

    /**
     * Eine Vorlage besteht die Prüfung ihrer eigenen Fläche - sonst wäre sie
     * eine Falle mit Gütesiegel. (Der Katalog prüft beim Laden; dass er das
     * WIRKLICH tut, zeigt dieser Test, indem er dieselbe Prüfung noch einmal
     * über die geladenen Werte fährt.)
     */
    @Test
    void jedeVorlageBestehtDieRegelIhrerEigenenFlaeche() {
        for (ProtectionProfileCatalog.Profile p : CATALOG.all()) {
            List<String> errors = new java.util.ArrayList<>();
            UserDefinedBatteryDefinition.checkDirection(p.charge(), "Ladegrenze", errors);
            UserDefinedBatteryDefinition.checkDirection(p.discharge(), "Entladegrenze", errors);
            UserDefinedBatteryDefinition.checkHysteresis(p.hysteresis(), errors);
            assertThat(errors).as(p.id() + " muss die eigene Prüfung bestehen").isEmpty();
        }
    }

    private static void assertSteps(List<double[]> got, JsonNode want, String what) {
        assertThat(got).as(what + " hat die Zahl der Stufen des Belegs").hasSize(want.size());
        for (int i = 0; i < want.size(); i++) {
            assertThat(got.get(i)[0]).as(what + " Stufe " + i + " Ladestand")
                    .isEqualTo(want.get(i).get(0).asDouble());
            assertThat(got.get(i)[1]).as(what + " Stufe " + i + " Strom")
                    .isEqualTo(want.get(i).get(1).asDouble());
        }
    }
}
