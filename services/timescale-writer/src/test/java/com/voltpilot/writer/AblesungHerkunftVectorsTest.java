package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.*;
import com.fasterxml.jackson.databind.*;
import java.nio.file.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.*;
import org.junit.jupiter.api.*;

class AblesungHerkunftVectorsTest {
    @TestFactory
    List<DynamicTest> dieAblesungsherkunft() throws Exception {
        ObjectMapper json=new ObjectMapper();
        JsonNode root=json.readTree(Files.readString(Path.of("../../docs/contracts/v2/messwert-herkunft-vectors.json")));
        List<DynamicTest> out=new ArrayList<>();
        for (JsonNode c:root.path("ablesungen").path("cases")) out.add(DynamicTest.dynamicTest(c.path("name").asText(),()->{
            JsonNode i=c.path("input");
            Map<String,String> u=i.path("urheber").isNull()?null:json.convertValue(i.path("urheber"),
                    new com.fasterxml.jackson.core.type.TypeReference<Map<String,String>>(){});
            java.util.function.Supplier<Map<String,Object>> run=()->MesswertHerkunft.ablesung(
                    i.path("kundenbereich").asText(),i.path("messstelle").asText(),i.path("groesse").asText(),
                    Instant.parse(i.path("messzeit").asText()),Instant.parse(i.path("eingangszeit").asText()),
                    new BigDecimal(i.path("stand").asText()),i.path("einheit").asText(),i.path("woher").asText(),u);
            if (c.path("grund").isNull()) assertThat(json.readTree(json.writeValueAsString(run.get())))
                    .isEqualTo(c.path("expected"));
            else assertThatThrownBy(run::get).isInstanceOf(IllegalArgumentException.class).hasMessage(c.path("grund").asText());
        }));
        return out;
    }
}
