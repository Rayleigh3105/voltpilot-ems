package com.voltpilot.api.fernwartung;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.web.AdminFernwartungController;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Rein, ohne Docker: die Fernwartung sagt in drei Dateien dasselbe - die
 * Migration (geschlossene Wörter der CHECKs), die Java-Formen und
 * {@code docs/contracts/openapi.yaml}.
 */
class FernwartungVertragTest {

    private static final Path OPENAPI = Path.of("..", "..", "docs", "contracts", "openapi.yaml");
    private static final String MIGRATION = "/db/migration/V20261007163700__fernwartung.sql";

    private static Map<String, Object> schemas;
    private static Map<String, Object> paths;
    private static String migration;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lade() throws IOException {
        try (InputStream in = Files.newInputStream(OPENAPI)) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
            paths = (Map<String, Object>) openapi.get("paths");
        }
        try (InputStream in = FernwartungVertragTest.class.getResourceAsStream(MIGRATION)) {
            migration = new String(Objects.requireNonNull(in, MIGRATION).readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    @Test
    void jedeRouteStehtImVertrag() {
        assertThat(paths).containsKeys(
                "/api/v1/admin/fernwartung",
                "/api/v1/admin/fernwartung/boxen",
                "/api/v1/admin/fernwartung/boxen/{ref}",
                "/api/v1/admin/fernwartung/boxen/{ref}/schluessel",
                "/api/v1/admin/fernwartung/boxen/{ref}/sperren",
                "/api/v1/admin/fernwartung/boxen/{ref}/entsperren",
                "/api/v1/admin/fernwartung/techniker",
                "/api/v1/admin/fernwartung/techniker/{id}/sperren",
                "/api/v1/admin/fernwartung/techniker/{id}/entsperren",
                "/api/v1/admin/fernwartung/fenster",
                "/api/v1/admin/fernwartung/fenster/{id}/schliessen",
                "/api/v1/admin/fernwartung/protokoll",
                "/api/v1/fernwartung/soll");
    }

    @Test
    void dieFormenSindDieDerJavaSeite() {
        for (Object[] paar : new Object[][] {
                {"FernwartungBox", AdminFernwartungController.BoxDto.class},
                {"FernwartungTechniker", AdminFernwartungController.TechnikerDto.class},
                {"FernwartungFenster", AdminFernwartungController.FensterDto.class},
                {"FernwartungServer", AdminFernwartungController.ServerDto.class},
                {"FernwartungUebersicht", AdminFernwartungController.UebersichtDto.class},
                {"FernwartungProtokollEintrag", AdminFernwartungController.ProtokollDto.class},
                {"FernwartungSchluesselAntwort", AdminFernwartungController.SchluesselAntwortDto.class},
                {"FernwartungSoll", FernwartungService.Soll.class}}) {
            assertThat(map(schema((String) paar[0]), "properties").keySet()).as((String) paar[0])
                    .containsExactlyInAnyOrderElementsOf(komponenten((Class<?>) paar[1]));
        }
        Map<String, Object> soll = map(schema("FernwartungSoll"), "properties");
        assertThat(map(map(soll, "peers"), "items").get("required"))
                .asList().containsExactlyInAnyOrderElementsOf(komponenten(FernwartungService.SollPeer.class));
        assertThat(map(map(soll, "fenster"), "items").get("required"))
                .asList().containsExactlyInAnyOrderElementsOf(komponenten(FernwartungService.SollFenster.class));
    }

    @Test
    void dieProtokollAktionenSindInMigrationUndVertragDieselben() {
        Matcher m = Pattern.compile("aktion IN \\(([^)]*)\\)", Pattern.DOTALL).matcher(migration);
        assertThat(m.find()).isTrue();
        List<String> ausMigration = Pattern.compile("'([a-z_]+)'").matcher(m.group(1)).results()
                .map(r -> r.group(1)).toList();
        Map<String, Object> aktion = map(map(schema("FernwartungProtokollEintrag"), "properties"), "aktion");
        assertThat(aktion.get("enum")).asList().containsExactlyInAnyOrderElementsOf(ausMigration);
    }

    private static List<String> komponenten(Class<?> record) {
        return Arrays.stream(record.getRecordComponents()).map(c -> c.getName()).toList();
    }

    private static Map<String, Object> schema(String name) {
        return map(schemas, name);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Map<String, Object> m, String key) {
        Object v = m.get(key);
        assertThat(v).as(key).isInstanceOf(Map.class);
        return (Map<String, Object>) v;
    }
}
