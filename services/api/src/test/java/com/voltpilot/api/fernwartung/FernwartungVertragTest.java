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
 * Migrationen (geschlossene Wörter der CHECKs), die Java-Formen und
 * {@code docs/contracts/openapi.yaml}.
 *
 * <p>Die Wortlisten gelten in ihrer JÜNGSTEN Fassung: V20261008213500 hat die
 * CHECKs aus V20261007163700 erweitert (Zustand {@code geloescht}, Aktion
 * {@code techniker_geloescht}).
 */
class FernwartungVertragTest {

    private static final Path OPENAPI = Path.of("..", "..", "docs", "contracts", "openapi.yaml");
    private static final String ANLAGE = "/db/migration/V20261007163700__fernwartung.sql";
    private static final String MIGRATION = "/db/migration/V20261008213500__fernwartung_zugang_loeschen.sql";

    private static Map<String, Object> schemas;
    private static Map<String, Object> paths;
    private static String anlage;
    private static String migration;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lade() throws IOException {
        try (InputStream in = Files.newInputStream(OPENAPI)) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
            paths = (Map<String, Object>) openapi.get("paths");
        }
        anlage = lies(ANLAGE);
        migration = lies(MIGRATION);
    }

    private static String lies(String pfad) throws IOException {
        try (InputStream in = FernwartungVertragTest.class.getResourceAsStream(pfad)) {
            return new String(Objects.requireNonNull(in, pfad).readAllBytes(), StandardCharsets.UTF_8);
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
                "/api/v1/admin/fernwartung/techniker/{id}",
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
        List<String> ausMigration = woerter(migration, "aktion IN");
        Map<String, Object> aktion = map(map(schema("FernwartungProtokollEintrag"), "properties"), "aktion");
        assertThat(aktion.get("enum")).asList().containsExactlyInAnyOrderElementsOf(ausMigration);
        // Erweitert, nichts weggenommen: jeder ältere Protokolleintrag bleibt gültig.
        assertThat(ausMigration).containsAll(woerter(anlage, "aktion IN")).contains("techniker_geloescht");
    }

    /**
     * Löschen ist die eine DELETE-Route des Baums, und der Zustand
     * {@code geloescht} verlässt die API nie: die Listen lassen gelöschte
     * Zugänge weg, also kennt der Vertrag für einen Zugang weiter nur
     * {@code aktiv} und {@code gesperrt} - die Datenbank einen dritten.
     */
    @Test
    void geloeschtIstEinZustandDerDatenbankUndKeinerDesVertrags() {
        assertThat(map(paths, "/api/v1/admin/fernwartung/techniker/{id}")).containsOnlyKeys("delete");
        Map<String, Object> antworten = map(map(map(paths, "/api/v1/admin/fernwartung/techniker/{id}"),
                "delete"), "responses");
        assertThat(antworten).containsKeys("204", "401", "403", "404", "409");

        assertThat(woerter(migration, "status IN")).containsExactly("aktiv", "gesperrt", "geloescht");
        for (String form : List.of("FernwartungTechniker", "FernwartungBox")) {
            assertThat(map(map(schema(form), "properties"), "status").get("enum")).as(form).asList()
                    .containsExactly("aktiv", "gesperrt");
        }
        // Ein Zustand, kein DELETE: die Migration vergibt kein neues Recht.
        assertThat(migration).doesNotContainIgnoringCase("GRANT ");
    }

    /** Die Wörter der ersten {@code <spalte> IN (...)}-Liste einer Migration. */
    private static List<String> woerter(String sql, String anfang) {
        Matcher m = Pattern.compile(Pattern.quote(anfang) + " \\(([^)]*)\\)", Pattern.DOTALL).matcher(sql);
        assertThat(m.find()).as(anfang).isTrue();
        return Pattern.compile("'([a-z_]+)'").matcher(m.group(1)).results().map(r -> r.group(1)).toList();
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
