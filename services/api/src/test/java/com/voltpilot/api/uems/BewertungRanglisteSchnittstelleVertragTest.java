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
                .contains("energieeinsatz.ansehen","teilansicht","unvollständig","Urteil und Vorschlag","niemals eine Einstufung");
        var schemas=(Map<String,Object>)((Map<String,Object>)api.get("components")).get("schemas");
        var dtos=Map.ofEntries(
                Map.entry("BewertungRangliste",BewertungRanglisteDto.Rangliste.class),
                Map.entry("BewertungRanglisteNenner",BewertungRanglisteDto.Nenner.class),
                Map.entry("BewertungRanglisteAnlage",BewertungRanglisteDto.Anlage.class),
                Map.entry("BewertungRanglisteEinsatz",BewertungRanglisteDto.Einsatz.class),
                Map.entry("BewertungKriterienGrundlage",BewertungRanglisteDto.KriterienGrundlage.class),
                Map.entry("BewertungStandUrteil",BewertungRanglisteDto.StandUrteil.class),
                Map.entry("BewertungEinsatzUrteil",BewertungRanglisteDto.Urteil.class),
                Map.entry("BewertungHerkunftEntwurf",BewertungRanglisteDto.HerkunftEntwurf.class),
                Map.entry("BewertungHerkunftEingang",BewertungRanglisteDto.HerkunftEingang.class),
                Map.entry("BewertungHerkunftNenner",BewertungRanglisteDto.HerkunftNenner.class),
                Map.entry("BewertungBilanzwert",BewertungRanglisteDto.Bilanzwert.class),
                Map.entry("BewertungBilanzEingang",BewertungRanglisteDto.BilanzEingang.class),
                Map.entry("BewertungRanglisteMessstelle",BewertungRanglisteDto.Messstelle.class),
                Map.entry("ProzessSummeHinweis",com.voltpilot.api.web.dto.ProzessMessstellenDto.Hinweis.class));
        var mapper=new ObjectMapper();
        for(var dto:dtos.entrySet()) {
            var props=(Map<String,Object>)((Map<String,Object>)schemas.get(dto.getKey())).get("properties");
            var namen=mapper.getSerializationConfig().introspect(mapper.constructType(dto.getValue())).findProperties().stream().map(p->p.getName()).toList();
            assertThat(props.keySet()).as(dto.getKey()).containsExactlyInAnyOrderElementsOf(namen);
            assertThat(props.keySet()).doesNotContain("einstufung");
        }
    }
}
