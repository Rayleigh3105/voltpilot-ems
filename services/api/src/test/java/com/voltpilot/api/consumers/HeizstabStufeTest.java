package com.voltpilot.api.consumers;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.steuerlogik.SteuerwegGeraete;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * Der Befund des Reglers, wenn seine Übersetzung im Kern den Stab führt (Steuerlogik Stufe 6, dritter Teil): die Karte
 * des Stabs behält ihren Grund. Die Titel der Lage sind ein Zwilling des Bausteins.
 */
class HeizstabStufeTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path BAUSTEIN = Path.of(
            "../../docs/contracts/v2/steuerlogik/zusammenfuehren/heizstab-regler.block.yaml");

    @Test
    void jederTitelDesBausteinsHatSeinenCode() throws Exception {
        Set<String> titel = new LinkedHashSet<>();
        Matcher m = Pattern.compile("(?m)^\\s+title: (.+)$").matcher(Files.readString(BAUSTEIN));
        while (m.find()) titel.add(m.group(1).trim());
        assertThat(titel).isNotEmpty();
        assertThat(HeizstabStufe.TITEL_CODES.keySet()).containsExactlyInAnyOrderElementsOf(titel);
        assertThat(HeizstabStufe.REGLER_CODES).containsAll(HeizstabStufe.TITEL_CODES.values());
    }

    @Test
    void derBefundKommtAusDemScharfenLauf() throws Exception {
        UUID stab = UUID.fromString("33333333-3333-4333-8333-333333333333");
        String logik = SteuerwegGeraete.logikIdHeizstab(stab).toString();
        JsonNode h = JSON.readTree("""
                {"logik":{"laeufe":[{"flow_id":"%s","zustand":"scharf",
                 "lage":{"titel":"Haltezeit","art":"waiting","satz":"Überschuss da, aber die Haltezeit nach dem letzten Wechsel läuft noch. Höhere Stufe frühestens in 1 min 30 s."},
                 "geraete":{"heizstab":{"wunsch":{"stufe":2}}}}]}}
                """.formatted(logik));
        JsonNode r = JSON.readTree(HeizstabStufe.reglerAusLogik(h, stab));
        assertThat(r.path("code").asText()).isEqualTo("haltezeit");
        assertThat(r.path("ausgaenge").asInt()).isEqualTo(2);
        assertThat(r.path("grund").asText()).startsWith("Überschuss da, aber die Haltezeit");
        // Ein mitlaufender Lauf schaltet nicht: dann führt der Regler, und sein eigener Block gilt.
        JsonNode mit = JSON.readTree(h.toString().replace("\"scharf\"", "\"mitlaufend\""));
        assertThat(HeizstabStufe.reglerAusLogik(mit, stab)).isNull();
        assertThat(HeizstabStufe.reglerAusLogik(h, UUID.randomUUID())).isNull();
    }
}
