package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Die Regel der Spannungs-Eckpunkte - rein, ohne Docker.
 *
 * <p>Sie ist der Zwilling von {@code inverter.SocFromVoltage.validate} (Box)
 * und der defensiven Prüfung im Decoder; die Vektoren hier und dort müssen
 * dieselben Urteile ergeben.
 */
class SocFromVoltageBoundsTest {

    private static Map<String, Object> conn(Object empty, Object full) {
        Map<String, Object> pair = new LinkedHashMap<>();
        if (empty != null) {
            pair.put("v_empty", empty);
        }
        if (full != null) {
            pair.put("v_full", full);
        }
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("ip", "192.168.0.28");
        c.put("soc_from_voltage", pair);
        return c;
    }

    @Test
    @DisplayName("Ohne Eckpunkte gibt es nichts zu beanstanden - der Normalfall jeder Anlage")
    void absentIsFine() {
        assertThat(SocFromVoltageBounds.refusal(null)).isNull();
        assertThat(SocFromVoltageBounds.refusal(Map.of())).isNull();
        assertThat(SocFromVoltageBounds.refusal(Map.of("ip", "192.168.0.28"))).isNull();
    }

    @Test
    @DisplayName("Beide echten Bauarten passieren DIESELBE Regel - LV wie HV")
    void bothRealClassesPass() {
        assertThat(SocFromVoltageBounds.refusal(conn(48, 56))).isNull();
        assertThat(SocFromVoltageBounds.refusal(conn(600, 700))).isNull();
        assertThat(SocFromVoltageBounds.refusal(conn(40.0, 60.0))).isNull();
        assertThat(SocFromVoltageBounds.refusal(conn(100, 1000))).isNull();
        // Ein Formularfeld liefert Text; ein deutsches Komma ist keine Ablehnung.
        assertThat(SocFromVoltageBounds.refusal(conn("48,0", "56,4"))).isNull();
    }

    @Test
    @DisplayName("Eine halbe Angabe wird ABGELEHNT - aus einer allein lässt sich nichts schätzen")
    void halfAPairIsRefused() {
        assertThat(SocFromVoltageBounds.refusal(conn(48, null)))
                .contains("0 %").contains("100 %");
        assertThat(SocFromVoltageBounds.refusal(conn(null, 56))).isNotNull();
        assertThat(SocFromVoltageBounds.refusal(conn(null, null))).isNotNull();
        assertThat(SocFromVoltageBounds.refusal(conn("keine Zahl", 56))).isNotNull();
    }

    @Test
    @DisplayName("Was gar keine Batterie sein kann, wird beim NAMEN genannt")
    void impossibleValuesAreNamed() {
        // Millivolt statt Volt - die Einheiten-Verwechslung.
        assertThat(SocFromVoltageBounds.refusal(conn(48000, 56000))).contains("Volt");
        // Ein Prozentwert statt einer Spannung.
        assertThat(SocFromVoltageBounds.refusal(conn(0, 100))).contains("Volt");
        assertThat(SocFromVoltageBounds.refusal(conn(-5, 56))).contains("Volt");
        assertThat(SocFromVoltageBounds.refusal(conn(48, 4000))).contains("Volt");
    }

    @Test
    @DisplayName("Verdreht oder ohne Abstand: aus so einem Paar wird keine Kurve")
    void invertedOrDegenerateSpanIsRefused() {
        assertThat(SocFromVoltageBounds.refusal(conn(700, 600))).contains("über");
        assertThat(SocFromVoltageBounds.refusal(conn(600, 600))).contains("über");
        // Ein Abstand unterhalb der Mindestspanne ist eine Stufenfunktion.
        assertThat(SocFromVoltageBounds.refusal(conn(600, 600.2))).contains("über");
        // Genau die Mindestspanne ist noch in Ordnung.
        assertThat(SocFromVoltageBounds.refusal(
                conn(600, 600 + SocFromVoltageBounds.MIN_SPAN))).isNull();
    }

    @Test
    @DisplayName("Ein Eintrag, der gar kein Paar IST, wird nicht durchgewinkt")
    void aNonObjectEntryIsRefused() {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("soc_from_voltage", "48-56");
        assertThat(SocFromVoltageBounds.refusal(c)).isNotNull();
        Map<String, Object> c2 = new LinkedHashMap<>();
        c2.put("soc_from_voltage", 48);
        assertThat(SocFromVoltageBounds.refusal(c2)).isNotNull();
    }
}
