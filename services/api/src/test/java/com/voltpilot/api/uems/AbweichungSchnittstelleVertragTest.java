package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.AbweichungController;
import com.voltpilot.api.web.AuffaelligkeitController;
import com.voltpilot.api.web.dto.AbweichungDto;
import com.voltpilot.api.zugriff.Recht;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.lang.reflect.RecordComponent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.web.bind.annotation.GetMapping;
import org.yaml.snakeyaml.Yaml;

/**
 * Die Routen von Auffälligkeit und Abweichung (UEMS AP-18 IP-16): DTO und OpenAPI laufen nicht auseinander, die Wörter
 * sind die des Vertrags {@code verbesserung.md} (Vokabulare von {@link VerbesserungRegeln}), Lese-Routen tragen kein
 * {@link Recht}, und die Ursache ist immer die Aussage einer Person (U1/U2). Rein — kein Spring, keine Datenbank.
 */
class AbweichungSchnittstelleVertragTest {

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

    private static List<String> felder(Class<? extends Record> form) {
        return Arrays.stream(form.getRecordComponents()).map(RecordComponent::getName)
                .map(AbweichungSchnittstelleVertragTest::snake).toList();
    }

    @SuppressWarnings("unchecked")
    private static List<Object> aufzaehlung(Map<String, Object> s, String feld) {
        return ((List<Object>) ((Map<String, Object>) ((Map<String, Object>) s.get("properties")).get(feld)).get("enum"))
                .stream().filter(x -> x != null).toList();
    }

    @Test
    @SuppressWarnings("unchecked")
    void dieFormenSindDieDesDto() throws Exception {
        Map<String, Class<? extends Record>> formen = Map.of("Abweichung", AbweichungDto.Abweichung.class,
                "AbweichungEintrag", AbweichungDto.Eintrag.class, "AbweichungListe", AbweichungDto.Liste.class,
                "AbweichungAbschluss", AbweichungDto.Abschluss.class, "AbweichungAussage", AbweichungDto.Aussage.class,
                "AbweichungVerweis", AbweichungDto.Verweis.class, "Auffaelligkeit", AbweichungDto.Vermerk.class,
                "AuffaelligkeitListe", AbweichungDto.Vermerke.class, "AuffaelligkeitBeantwortet",
                AbweichungDto.Beantwortet.class);
        for (var f : formen.entrySet()) {
            Map<String, Object> s = schema(f.getKey());
            assertThat(s).as(f.getKey()).isNotNull();
            List<String> dto = felder(f.getValue());
            assertThat(((Map<String, Object>) s.get("properties")).keySet()).as(f.getKey())
                    .containsExactlyElementsOf(dto);
            assertThat((List<String>) s.get("required")).as(f.getKey() + " required").containsExactlyElementsOf(dto);
        }
        Map<String, Object> frist = (Map<String, Object>) ((Map<String, Object>) schema("Abweichung").get("properties"))
                .get("frist");
        assertThat(((Map<String, Object>) frist.get("properties")).keySet())
                .containsExactlyElementsOf(felder(AbweichungDto.FristStand.class));
    }

    /** Die Körper der Schreibrouten sind die Formen des DTO — kein Feld mehr, keins weniger. */
    @Test
    @SuppressWarnings("unchecked")
    void dieKoerperSindDieDesDto() throws Exception {
        Map<String, Object> pfade = (Map<String, Object>) api().get("paths");
        Map<String, Class<? extends Record>> koerper = Map.of(
                "/api/v1/kennzahlen/{id}/auffaelligkeiten/{aid}/antwort post", AbweichungDto.Antwort.class,
                "/api/v1/abweichungen post", AbweichungDto.Anlegen.class,
                "/api/v1/abweichungen/{id}/eintraege post", AbweichungDto.NeuerEintrag.class,
                "/api/v1/abweichungen/{id}/frist put", AbweichungDto.Frist.class,
                "/api/v1/abweichungen/{id}/verantwortlicher put", AbweichungDto.Verantwortlicher.class,
                "/api/v1/abweichungen/{id}/abschliessen post", AbweichungDto.Abschliessen.class);
        for (var k : koerper.entrySet()) {
            String[] pm = k.getKey().split(" ");
            Map<String, Object> op = (Map<String, Object>) ((Map<String, Object>) pfade.get(pm[0])).get(pm[1]);
            assertThat(op).as(k.getKey()).isNotNull();
            Map<String, Object> s = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) ((Map<String,
                    Object>) op.get("requestBody")).get("content")).get("application/json")).get("schema");
            assertThat(((Map<String, Object>) s.get("properties")).keySet()).as(k.getKey())
                    .containsExactlyInAnyOrderElementsOf(felder(k.getValue()));
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void dieWoerterSindDieDesVertrags() throws Exception {
        Map<String, List<String>> v = VerbesserungRegeln.VOKABULARE;
        Map<String, Object> a = schema("Abweichung");
        assertThat(aufzaehlung(a, "zustand")).isEqualTo(v.get("abweichung_zustand"));
        Map<String, Object> p = (Map<String, Object>) a.get("properties");
        assertThat(aufzaehlung((Map<String, Object>) p.get("herkunft"), "art")).isEqualTo(List.of("auffaelligkeit",
                "von_hand"));
        assertThat(aufzaehlung(schema("AbweichungAbschluss"), "ergebnis")).isEqualTo(v.get("abweichung_ergebnis"));
        assertThat(aufzaehlung(schema("Auffaelligkeit"), "zustand")).isEqualTo(v.get("auffaelligkeit_zustand"));
        assertThat(aufzaehlung(schema("Auffaelligkeit"), "antwort")).isEqualTo(v.get("auffaelligkeit_antwort"));
        assertThat(aufzaehlung(schema("AbweichungEintrag"), "art")).containsAll(v.get("abweichung_eintrag_art"))
                .hasSize(6);
        Map<String, Object> pfade = (Map<String, Object>) api().get("paths");
        Map<String, Object> eintrag = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) ((Map<String,
                Object>) ((Map<String, Object>) ((Map<String, Object>) pfade.get("/api/v1/abweichungen/{id}/eintraege"))
                .get("post")).get("requestBody")).get("content")).get("application/json")).get("schema");
        assertThat(aufzaehlung(eintrag, "art")).isEqualTo(v.get("abweichung_eintrag_art"));
    }

    /** Die Routen und ihre Methoden — KennzahlSchnittstelleVertragTest lässt {@code …/auffaelligkeiten} hierher. */
    @Test
    @SuppressWarnings("unchecked")
    void dieRoutenStehenInOpenApi() throws Exception {
        Map<String, Object> pfade = (Map<String, Object>) api().get("paths");
        Map<String, List<String>> erwartet = Map.of(
                "/api/v1/kennzahlen/{id}/auffaelligkeiten", List.of("parameters", "get"),
                "/api/v1/kennzahlen/{id}/auffaelligkeiten/{aid}/antwort", List.of("parameters", "post"),
                "/api/v1/abweichungen", List.of("get", "post"),
                "/api/v1/abweichungen/{id}", List.of("parameters", "get"),
                "/api/v1/abweichungen/{id}/eintraege", List.of("parameters", "post"),
                "/api/v1/abweichungen/{id}/frist", List.of("parameters", "put"),
                "/api/v1/abweichungen/{id}/verantwortlicher", List.of("parameters", "put"),
                "/api/v1/abweichungen/{id}/abschliessen", List.of("parameters", "post"));
        erwartet.forEach((pfad, methoden) -> assertThat(((Map<String, Object>) pfade.get(pfad)).keySet()).as(pfad)
                .containsExactlyInAnyOrderElementsOf(methoden));
        assertThat(pfade.keySet().stream().filter(p -> p.startsWith("/api/v1/abweichungen")
                || p.startsWith("/api/v1/kennzahlen/{id}/auffaelligkeiten")).toList())
                .containsExactlyInAnyOrderElementsOf(erwartet.keySet());
    }

    @Test
    void leseRoutenTragenKeinRecht() {
        for (Class<?> c : List.of(AbweichungController.class, AuffaelligkeitController.class)) {
            for (Method m : c.getDeclaredMethods()) {
                if (m.isAnnotationPresent(GetMapping.class)) {
                    assertThat(m.isAnnotationPresent(Recht.class)).as(c.getSimpleName() + "#" + m.getName()).isFalse();
                }
            }
        }
    }

    /** U1/U2 und §5.9: die Ursache steht immer mit „Aussage von …“ — ohne Beleg „keine Messung“. */
    @Test
    void dieUrsacheIstEineAussage() {
        AbweichungDto.Aussage ohne = AbweichungService.aussage("Die Werkzeugheizungen der Maschinen 3 bis 6 liefen vom "
                + "23.12. bis 02.01. durch — keine Abschaltung in der Betriebspause programmiert.", null, "Murat Demirci",
                LocalDate.of(2028, 1, 14), null);
        assertThat(ohne.kennzeichen()).isEqualTo("Aussage von Murat Demirci, 14.01.2028 — keine Messung");
        assertThat(ohne.satz()).isEqualTo("Ursache — Aussage von Murat Demirci, 14.01.2028 (keine Messung): ‚Die "
                + "Werkzeugheizungen der Maschinen 3 bis 6 liefen vom 23.12. bis 02.01. durch — keine Abschaltung in der "
                + "Betriebspause programmiert.‘");
        AbweichungDto.Aussage mit = AbweichungService.aussage("Der Anfangsstand des neuen Zählers wurde erst "
                + "nachgetragen.", null, "Jonas Wendlinger", LocalDate.of(2026, 11, 18),
                "Zählerwechsel Z-5a → Z-5b am 18.11.2026");
        assertThat(mit.satz()).isEqualTo("Ursache — Aussage von Jonas Wendlinger, 18.11.2026 (mit Beleg: Zählerwechsel "
                + "Z-5a → Z-5b am 18.11.2026): ‚Der Anfangsstand des neuen Zählers wurde erst nachgetragen.‘");
        assertThat(mit.kennzeichen()).startsWith("Aussage von Jonas Wendlinger, 18.11.2026 — mit Beleg ");
    }

    /** R8: der Vorbehalt „vorläufig“ steht im Anlass und wird geerbt, nicht neu gebildet. */
    @Test
    void derVorbehaltWirdGeerbt() throws Exception {
        ObjectMapper m = new ObjectMapper();
        assertThat(AbweichungService.vorbehalte(m.readTree("{\"kennzeichen\": [\"Bezugsbasis vorläufig (1 von 12 "
                + "Monaten)\", \"bereinigt um Bezugsfläche\"], \"vergleich\": [{\"bereinigt\": {\"kennzeichen\": "
                + "[\"Bezugsbasis vorläufig (1 von 12 Monaten)\"]}}]}"))).containsExactly(
                        "Bezugsbasis vorläufig (1 von 12 Monaten)");
        assertThat(AbweichungService.vorbehalte(m.readTree("{\"kennzeichen\": [\"Streuung ± 0,8 %\"]}"))).isEmpty();
    }
}
