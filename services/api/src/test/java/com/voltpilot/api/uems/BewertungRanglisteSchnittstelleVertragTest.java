package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.BewertungRanglisteDto;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

class BewertungRanglisteSchnittstelleVertragTest {
    @Test @SuppressWarnings("unchecked")
    void openapiBeschreibtDieGebauteLeserouteUndAlleDtoFelder() throws Exception {
        Map<String,Object> api;
        try(var in=Files.newInputStream(Path.of("../../docs/contracts/openapi.yaml"))) { api=new Yaml().load(in); }
        var paths=(Map<String,Object>)api.get("paths");
        var route=(Map<String,Object>)paths.get("/api/v1/unternehmen/bewertung/rangliste");
        assertThat(route.keySet()).containsExactly("get");
        assertThat(((Map<String,Object>)route.get("get")).get("description").toString())
                .contains("energieeinsatz.ansehen","teilansicht","unvollständig");
        var schemas=(Map<String,Object>)((Map<String,Object>)api.get("components")).get("schemas");
        var dtos=Map.of("BewertungRangliste",BewertungRanglisteDto.Rangliste.class,
                "BewertungRanglisteNenner",BewertungRanglisteDto.Nenner.class,
                "BewertungRanglisteAnlage",BewertungRanglisteDto.Anlage.class,
                "BewertungRanglisteEinsatz",BewertungRanglisteDto.Einsatz.class,
                "BewertungRanglisteMessstelle",BewertungRanglisteDto.Messstelle.class);
        var mapper=new ObjectMapper();
        for(var dto:dtos.entrySet()) {
            var props=(Map<String,Object>)((Map<String,Object>)schemas.get(dto.getKey())).get("properties");
            var namen=mapper.getSerializationConfig().introspect(mapper.constructType(dto.getValue())).findProperties().stream().map(p->p.getName()).toList();
            assertThat(props.keySet()).as(dto.getKey()).containsExactlyInAnyOrderElementsOf(namen);
            assertThat(props.keySet()).doesNotContain("kriterien","einstufung","vorschlag");
        }
    }
}
