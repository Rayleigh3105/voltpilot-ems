package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.web.MassnahmeController;
import com.voltpilot.api.web.dto.MassnahmeDto;
import com.voltpilot.api.zugriff.Recht;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.lang.reflect.RecordComponent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.web.bind.annotation.GetMapping;
import org.yaml.snakeyaml.Yaml;

/**
 * Die Maßnahme-Routen (UEMS AP-18 IP-10): DTO und OpenAPI laufen nicht auseinander, die Wörter sind die des Vertrags
 * {@code verbesserung.md} (Vokabulare von {@link VerbesserungRegeln}), Lese-Routen tragen kein {@link Recht}. Rein —
 * kein Spring, keine Datenbank.
 */
class MassnahmeSchnittstelleVertragTest {

    @SuppressWarnings("unchecked")
    private static Map<String, Object> api() throws Exception {
        try (InputStream in = Files.newInputStream(Path.of("..", "..", "docs", "contracts", "openapi.yaml"))) {
            return new Yaml().load(in);
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> schema(String name) throws Exception {
        return (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) api().get("components"))
                .get("schemas")).get(name);
    }

    private static String snake(String name) {
        return name.replaceAll("([a-z0-9])([A-Z])", "$1_$2").toLowerCase();
    }

    @SuppressWarnings("unchecked")
    private static List<Object> aufzaehlung(Map<String, Object> s, String feld) {
        return ((List<Object>) ((Map<String, Object>) ((Map<String, Object>) s.get("properties")).get(feld)).get("enum"))
                .stream().filter(x -> x != null).toList();
    }

    @Test
    @SuppressWarnings("unchecked")
    void dieFormenSindDieDesDto() throws Exception {
        Map<String, Class<? extends Record>> formen = Map.ofEntries(
                Map.entry("Massnahme", MassnahmeDto.Massnahme.class),
                Map.entry("MassnahmeEintrag", MassnahmeDto.Eintrag.class),
                Map.entry("MassnahmeListe", MassnahmeDto.Liste.class),
                Map.entry("MassnahmeMessgrundlage", MassnahmeDto.Messgrundlage.class),
                Map.entry("MassnahmeVerweis", MassnahmeDto.Verweis.class),
                Map.entry("MassnahmeWirkung", MassnahmeDto.Wirkung.class),
                Map.entry("MassnahmeWirkungMonat", MassnahmeDto.WirkungMonat.class),
                Map.entry("MassnahmeWirkungAusschluss", MassnahmeDto.WirkungAusschluss.class),
                Map.entry("MassnahmeWirkungSumme", MassnahmeDto.WirkungSumme.class),
                Map.entry("MassnahmeBewertung", MassnahmeDto.Bewertung.class),
                Map.entry("MassnahmeBewertungen", MassnahmeDto.Bewertungen.class));
        for (var f : formen.entrySet()) {
            Map<String, Object> s = schema(f.getKey());
            assertThat(s).as(f.getKey()).isNotNull();
            List<String> dto = Arrays.stream(f.getValue().getRecordComponents()).map(RecordComponent::getName)
                    .map(MassnahmeSchnittstelleVertragTest::snake).toList();
            assertThat(((Map<String, Object>) s.get("properties")).keySet()).as(f.getKey())
                    .containsExactlyElementsOf(dto);
            assertThat((List<String>) s.get("required")).as(f.getKey() + " required").containsExactlyElementsOf(dto);
        }
    }

    /** Die Körper der Schreibrouten sind die Formen des DTO — kein Feld mehr, keins weniger. */
    @Test
    @SuppressWarnings("unchecked")
    void dieKoerperSindDieDesDto() throws Exception {
        Map<String, Object> pfade = (Map<String, Object>) api().get("paths");
        Map<String, Class<? extends Record>> koerper = Map.of(
                "/api/v1/massnahmen post", MassnahmeDto.Anlegen.class,
                "/api/v1/massnahmen/{id} put", MassnahmeDto.Aendern.class,
                "/api/v1/massnahmen/{id}/verantwortlicher put", MassnahmeDto.Verantwortlicher.class,
                "/api/v1/massnahmen/{id}/umgesetzt post", MassnahmeDto.Umgesetzt.class,
                "/api/v1/massnahmen/{id}/verwerfen post", MassnahmeDto.Verwerfen.class,
                "/api/v1/massnahmen/{id}/eintraege post", MassnahmeDto.NeuerEintrag.class,
                "/api/v1/massnahmen/{id}/bewertungen post", MassnahmeDto.Bewerten.class,
                "/api/v1/massnahmen/{id}/bewertungen/beantragen post", MassnahmeDto.Bewerten.class,
                "/api/v1/massnahmen/{id}/bewertungen/freigeben post", MassnahmeDto.Entscheid.class,
                "/api/v1/massnahmen/{id}/bewertungen/ablehnen post", MassnahmeDto.Entscheid.class);
        for (var k : koerper.entrySet()) {
            String[] pm = k.getKey().split(" ");
            Map<String, Object> op = (Map<String, Object>) ((Map<String, Object>) pfade.get(pm[0])).get(pm[1]);
            assertThat(op).as(k.getKey()).isNotNull();
            Map<String, Object> s = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) ((Map<String,
                    Object>) op.get("requestBody")).get("content")).get("application/json")).get("schema");
            List<String> dto = Arrays.stream(k.getValue().getRecordComponents()).map(RecordComponent::getName)
                    .map(MassnahmeSchnittstelleVertragTest::snake).toList();
            assertThat(((Map<String, Object>) s.get("properties")).keySet()).as(k.getKey())
                    .containsExactlyInAnyOrderElementsOf(dto);
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void dieWoerterSindDieDesVertrags() throws Exception {
        Map<String, Object> m = schema("Massnahme");
        assertThat(aufzaehlung(m, "zustand")).isEqualTo(VerbesserungRegeln.VOKABULARE.get("massnahme_zustand"));
        Map<String, Object> herkunft = (Map<String, Object>) ((Map<String, Object>) m.get("properties")).get("herkunft");
        assertThat(aufzaehlung(herkunft, "art")).isEqualTo(VerbesserungRegeln.VOKABULARE.get("massnahme_herkunft"));
        Map<String, Object> frist = (Map<String, Object>) ((Map<String, Object>) m.get("properties")).get("frist");
        assertThat(VerbesserungRegeln.VOKABULARE.get("frist_faellig")).containsAll(aufzaehlung(frist, "faellig")
                .stream().map(String::valueOf).toList());
        assertThat(MassnahmeService.OHNE_KENNZEICHEN).isEqualTo("ohne Messgrundlage — Wirkung nicht messbar");
    }

    /** IP-11: die Gründe eines nicht gezählten Monats sind genau {@code wirkung_grund}; {@code monate} 12 … 36. */
    @Test
    @SuppressWarnings("unchecked")
    void dieWirkungSprichtDieWoerterDesVertrags() throws Exception {
        List<String> grund = VerbesserungRegeln.VOKABULARE.get("wirkung_grund");
        assertThat(aufzaehlung(schema("MassnahmeWirkungAusschluss"), "grund")).isEqualTo(grund);
        assertThat(aufzaehlung(schema("MassnahmeWirkungMonat"), "grund")).isEqualTo(grund);
        assertThat(aufzaehlung(schema("MassnahmeWirkung"), "grund")).containsExactly("ohne_messgrundlage",
                "nicht_umgesetzt");
        Map<String, Object> op = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) api().get("paths"))
                .get("/api/v1/massnahmen/{id}/wirkung")).get("get");
        Map<String, Object> monate = ((List<Map<String, Object>>) op.get("parameters")).get(0);
        assertThat(monate.get("name")).isEqualTo("monate");
        Map<String, Object> s = (Map<String, Object>) monate.get("schema");
        assertThat(s.get("minimum")).isEqualTo(VerbesserungRegeln.STARTWERTE.nachher_monate());
        assertThat(s.get("default")).isEqualTo(VerbesserungRegeln.STARTWERTE.nachher_monate());
        assertThat(s.get("maximum")).isEqualTo(VerbesserungRegeln.STARTWERTE.nachher_monate_hoechstens());
    }

    /** IP-12: das Ergebnis eines Stands ist genau {@code wirkung_ergebnis}; der Status die Wörter der Tabelle (IP-9). */
    @Test
    @SuppressWarnings("unchecked")
    void dieBewertungSprichtDieWoerterDesVertrags() throws Exception {
        Map<String, Object> s = schema("MassnahmeBewertung");
        assertThat(aufzaehlung(s, "ergebnis")).isEqualTo(VerbesserungRegeln.VOKABULARE.get("wirkung_ergebnis"));
        assertThat(aufzaehlung(s, "status")).containsExactly("beantragt", "bewertet", "abgelehnt");
        Map<String, Object> op = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) api().get("paths"))
                .get("/api/v1/massnahmen/{id}/bewertungen")).get("post");
        Map<String, Object> body = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) ((Map<String,
                Object>) op.get("requestBody")).get("content")).get("application/json")).get("schema");
        assertThat(aufzaehlung(body, "ergebnis")).isEqualTo(VerbesserungRegeln.VOKABULARE.get("wirkung_ergebnis"));
    }

    @Test
    void leseRoutenTragenKeinRecht() {
        for (Method m : MassnahmeController.class.getDeclaredMethods()) {
            if (m.isAnnotationPresent(GetMapping.class)) {
                assertThat(m.isAnnotationPresent(Recht.class)).as(m.getName()).isFalse();
            }
        }
    }
}
