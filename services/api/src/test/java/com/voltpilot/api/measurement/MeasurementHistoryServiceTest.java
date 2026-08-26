package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class MeasurementHistoryServiceTest {

    @Test
    void csvNeutralizesEverySpreadsheetFormulaPrefix() {
        var service = new MeasurementHistoryService(null, null, null);
        var meta = new MeasurementHistoryService.Meta("point", "Label", "Source", null,
                "text", "known", "v", "decoded", true, Instant.EPOCH,
                Instant.EPOCH.plusSeconds(60), 300, "Letzter Wert.", UUID.randomUUID(), null);
        List<MeasurementHistoryService.Datum> rows = List.of(
                datum("=SUM(A1:A2)"), datum("+1"), datum("-1"), datum("@cmd"),
                datum("\tformula"), datum("\rformula"), datum("harmlos"));
        String csv = new String(service.csv(new MeasurementHistoryService.History(
                meta, rows, List.of())), StandardCharsets.UTF_8);
        for (String dangerous : List.of("=SUM(A1:A2)", "+1", "-1", "@cmd",
                "\tformula", "\rformula")) {
            assertThat(csv).contains("\"'" + dangerous.replace("\"", "\"\"") + "\"");
        }
        assertThat(csv).contains("\"harmlos\"").doesNotContain("\"'harmlos\"");
    }

    private static MeasurementHistoryService.Datum datum(String text) {
        return new MeasurementHistoryService.Datum(Instant.EPOCH, null, null, null,
                text, 1, false);
    }
}
