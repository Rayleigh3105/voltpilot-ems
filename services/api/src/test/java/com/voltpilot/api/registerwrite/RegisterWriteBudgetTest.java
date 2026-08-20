package com.voltpilot.api.registerwrite;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.InputStream;
import java.time.Duration;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;
import org.yaml.snakeyaml.Yaml;

/**
 * DIE ZEITFENSTER-INVARIANTE des Register-Schreibens - der Wächter über der
 * Ursache des Produktionsvorfalls vom 20.08.2026.
 *
 * <p>Die Box bindet EINEN Bus-Rundlauf an
 * {@link RegisterWriteService#BOX_ROUND_TRIP} (30 s,
 * {@code installerWriteTimeout} in
 * {@code edge-app/core/internal/agent/installerwrite.go}) - so lange DARF ein
 * Lesen dauern, weil der Node-RED-Knoten hinter der EINEN Warteschlange je
 * (Host, Port) erst den laufenden Poll abwarten muss. Die Vorschau der Cloud
 * wartete aber nur 20 s. Auf jeder Anlage, deren Wechselrichter-Bus gerade
 * belegt war, gab die api damit auf, BEVOR das Gerät antworten konnte: gemessen
 * antwortete die Box korrekt nach 22 s mit dem echten Ist-Wert, die api hatte
 * die Korrelation da längst vergessen, und die Oberfläche behauptete „die Anlage
 * hat nicht rechtzeitig gemeldet".
 *
 * <p><b>Ein zu kleines Budget ist nicht „etwas ungeduldig", sondern ein Feature,
 * das auf einer belegten Anlage NIE funktioniert</b> - und weil es nur auf
 * langsamen echten Anlagen auftritt, fällt es in keinem Testlauf mit einer
 * schnellen Attrappe auf. Deshalb dieser Wächter an der AUSGELIEFERTEN Datei.
 */
class RegisterWriteBudgetTest {

    @Test
    @DisplayName("beide Vorgaben liegen über der Geräte-Schranke - sonst kann eine belegte Anlage nie antworten")
    @SuppressWarnings("unchecked")
    void theShippedBudgetsExceedTheBoxOwnRoundTripBound() throws Exception {
        Map<String, Object> yml;
        try (InputStream in = getClass().getResourceAsStream("/application.yml")) {
            assertThat(in).as("application.yml auf dem Klassenpfad").isNotNull();
            yml = (Map<String, Object>) new Yaml().loadAll(in).iterator().next();
        }
        Duration read = defaultOf(at(yml, "voltpilot", "register-write", "read-timeout"));
        Duration write = defaultOf(at(yml, "voltpilot", "register-write", "write-timeout"));

        assertThat(read)
                .as("die Vorschau muss der Box mehr Zeit geben, als die Box sich selbst gibt")
                .isGreaterThan(RegisterWriteService.BOX_ROUND_TRIP);
        assertThat(write)
                .as("der Schreibvorgang liest, schreibt, lässt setzen und liest erneut - "
                        + "in DERSELBEN Runde der Box")
                .isGreaterThan(RegisterWriteService.BOX_ROUND_TRIP);
        // Und der Not-Aus bleibt AN ausgeliefert (die gitops-Falle).
        assertThat(at(yml, "voltpilot", "register-write", "enabled"))
                .isEqualTo("${VOLTPILOT_REGISTER_WRITE_ENABLED:true}");
    }

    /** Aus {@code ${VAR:PT40S}} die ausgelieferte Vorgabe. */
    private static Duration defaultOf(Object placeholder) {
        String raw = String.valueOf(placeholder);
        assertThat(raw).as("Platzhalter mit Vorgabe").matches("\\$\\{[A-Z_]+:PT.+}");
        return Duration.parse(raw.substring(raw.indexOf(':') + 1, raw.length() - 1));
    }

    @SuppressWarnings("unchecked")
    private static Object at(Map<String, Object> yml, String... path) {
        Object node = yml;
        for (String key : path) {
            node = ((Map<String, Object>) node).get(key);
        }
        return node;
    }
}
