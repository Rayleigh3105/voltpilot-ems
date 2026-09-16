package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

class SummenwertKontextVectorsTest {
    record Fall(String name, Set<String> erlaubt, List<String> gelesen, String grund) {}
    @Test void gemeinsameGeraeteUndAnlagenVektoren() throws Exception {
        var json = new ObjectMapper();
        var faelle = json.readValue(Path.of("../../docs/contracts/v2/summenwert-kontext-vectors.json").toFile(), Fall[].class);
        for (var f : faelle) assertThat(SummenwertKontextRegeln.grund(f.erlaubt(), f.gelesen()))
                .as(f.name()).isEqualTo(f.grund());
    }
}
