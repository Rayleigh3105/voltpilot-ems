package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.web.EnergiezielController;
import com.voltpilot.api.web.dto.EnergiezielDto;
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
 * Die Energieziel-Routen (UEMS AP-18 IP-6): DTO und OpenAPI laufen nicht auseinander, die Wörter sind die des
 * Vertrags {@code verbesserung.md} (Vokabulare von {@link VerbesserungRegeln}), Lese-Routen tragen kein {@link Recht}.
 * Rein — kein Spring, keine Datenbank.
 */
class EnergiezielSchnittstelleVertragTest {

    @SuppressWarnings("unchecked")
    private static Map<String, Object> schema(String name) throws Exception {
        try (InputStream in = Files.newInputStream(Path.of("..", "..", "docs", "contracts", "openapi.yaml"))) {
            Map<String, Object> api = new Yaml().load(in);
            return (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) api.get("components"))
                    .get("schemas")).get(name);
        }
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
        Map<String, Class<? extends Record>> formen = Map.of("Energieziel", EnergiezielDto.Energieziel.class,
                "EnergiezielEintrag", EnergiezielDto.Eintrag.class, "EnergiezielListe", EnergiezielDto.Liste.class,
                "EnergiezielStand", EnergiezielDto.Stand.class, "EnergiezielFrist", EnergiezielDto.Frist.class,
                "EnergiezielBewertung", EnergiezielDto.Bewertung.class, "EnergiezielAnstoss",
                EnergiezielDto.Anstoss.class);
        for (var f : formen.entrySet()) {
            Map<String, Object> s = schema(f.getKey());
            assertThat(s).as(f.getKey()).isNotNull();
            List<String> dto = Arrays.stream(f.getValue().getRecordComponents()).map(RecordComponent::getName)
                    .map(EnergiezielSchnittstelleVertragTest::snake).toList();
            assertThat(((Map<String, Object>) s.get("properties")).keySet()).as(f.getKey())
                    .containsExactlyElementsOf(dto);
            assertThat((List<String>) s.get("required")).as(f.getKey() + " required").containsExactlyElementsOf(dto);
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void dieWoerterSindDieDesVertrags() throws Exception {
        Map<String, Object> ziel = schema("Energieziel");
        assertThat(aufzaehlung(ziel, "zustand")).isEqualTo(VerbesserungRegeln.VOKABULARE.get("energieziel_zustand"));
        assertThat(aufzaehlung(ziel, "ergebnis")).isEqualTo(VerbesserungRegeln.VOKABULARE.get("energieziel_ergebnis"));
        assertThat(aufzaehlung(schema("EnergiezielStand"), "vorschlag"))
                .isEqualTo(VerbesserungRegeln.VOKABULARE.get("zielstand_vorschlag"));
        // IP-7: Bewertung, Frist und Anstoß sprechen die Wörter des Vertrags.
        Map<String, Object> bewertung = schema("EnergiezielBewertung");
        assertThat(aufzaehlung(bewertung, "ergebnis")).isEqualTo(VerbesserungRegeln.VOKABULARE.get("energieziel_ergebnis"));
        assertThat(aufzaehlung(bewertung, "vorschlag")).isEqualTo(VerbesserungRegeln.VOKABULARE.get("zielstand_vorschlag"));
        assertThat(aufzaehlung(bewertung, "status")).containsExactly("beantragt", "bewertet", "abgelehnt");
        assertThat(VerbesserungRegeln.VOKABULARE.get("frist_faellig"))
                .containsAll(aufzaehlung(schema("EnergiezielFrist"), "faellig").stream().map(String::valueOf).toList());
        Map<String, Object> anstoss = schema("EnergiezielAnstoss");
        assertThat(aufzaehlung(anstoss, "art")).isEqualTo(VerbesserungRegeln.VOKABULARE.get("anstoss_art"));
        assertThat(aufzaehlung(anstoss, "zustand")).isEqualTo(VerbesserungRegeln.VOKABULARE.get("anstoss_zustand"));
        assertThat(aufzaehlung(anstoss, "antwort")).isEqualTo(VerbesserungRegeln.VOKABULARE.get("anstoss_antwort"));
        Map<String, Object> ng = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) schema(
                "EnergiezielStand").get("properties")).get("nicht_gezaehlt")).get("items");
        // Der Ziel-Stand nennt die Gründe der Bezugsbasis und „unvollständig“, nie die der Wirkung (Umsetzung).
        List<Object> gruende = aufzaehlung(ng, "grund");
        assertThat(VerbesserungRegeln.VOKABULARE.get("wirkung_grund")).containsAll(gruende.stream().map(String::valueOf)
                .toList());
        assertThat(gruende).doesNotContain("umsetzungsmonat", "basis_nach_umsetzung");
    }

    @Test
    void leseRoutenTragenKeinRecht() {
        for (Method m : EnergiezielController.class.getDeclaredMethods()) {
            if (m.isAnnotationPresent(GetMapping.class)) {
                assertThat(m.isAnnotationPresent(Recht.class)).as(m.getName()).isFalse();
            }
        }
    }
}
