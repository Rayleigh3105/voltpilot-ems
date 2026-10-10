package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/** Entire production arrival order, without Git/network access during the test. */
@Testcontainers
class UemsProduktionsreihenfolgeMigrationTest {
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw")
            .withCommand("postgres", "-c", "timescaledb.max_background_workers=0");

    @TempDir
    Path mainMigrations;

    @Test
    void mainDannUemsBewahrtRollenereignisseUndErreichtDenFrischenStand() throws IOException {
        List<String> main = mainSatz();
        for (String name : main) {
            try (var input = getClass().getResourceAsStream("/db/migration/" + name)) {
                assertThat(input).as("main migration %s must still be packaged", name).isNotNull();
                Files.copy(input, mainMigrations.resolve(name));
            }
        }

        JdbcTemplate frisch = db("voltpilot");
        Instant beginn = Instant.now();
        Flyway alle = flyway("voltpilot").load();
        alle.migrate();
        rollenereignisse(frisch, "actor");

        frisch.execute("CREATE DATABASE produktionsreihenfolge");
        JdbcTemplate produktion = db("produktionsreihenfolge");
        Flyway bestand = flyway("produktionsreihenfolge")
                .locations("filesystem:" + mainMigrations.toAbsolutePath()).load();
        bestand.migrate();
        assertThat(Arrays.stream(bestand.info().applied()).map(MigrationInfo::getScript).toList())
                .as("exactly the committed main set, not a version ceiling")
                .containsExactlyInAnyOrderElementsOf(main);
        assertThat(produktion.queryForObject("SELECT count(*) FROM information_schema.columns "
                + "WHERE table_schema = 'public' AND table_name = 'messstelle_formel_term' "
                + "AND column_name = 'gilt_als_erzeugung'", Integer.class)).isEqualTo(1);
        rollenereignisse(produktion, "akteur");

        Flyway nachzug = flyway("produktionsreihenfolge").outOfOrder(true).load();
        assertThat(Arrays.stream(nachzug.info().pending()).map(m -> m.getVersion().getVersion()).toList())
                .as("both formula changes arrive AFTER gilt_als_erzeugung")
                .contains("20260912210000", "20260913143000", "20260916150000");
        nachzug.migrate();
        assertThat(nachzug.info().pending()).isEmpty();
        assertThat(Arrays.stream(nachzug.info().applied()).map(MigrationInfo::getScript).toList())
                .containsExactlyInAnyOrderElementsOf(
                        Arrays.stream(alle.info().applied()).map(MigrationInfo::getScript).toList());

        assertThat(schema(produktion)).as("tables, columns, defaults, nullability and all constraints")
                .isEqualTo(schema(frisch));
        assertThat(inhalte(produktion, beginn))
                .as("all public table contents, including both pre-existing role events")
                .isEqualTo(inhalte(frisch, beginn));
        assertThat(produktion.queryForList("SELECT art FROM ort_aenderung ORDER BY id", String.class))
                .containsExactly("rolle_gesetzt", "rolle_entzogen");
    }

    private static Map<String, Object> inhalte(JdbcTemplate db, Instant beginn) {
        Map<String, Object> finger = new LinkedHashMap<>(Bestandsschutz.fingerabdruck(db, List.of()));
        // These four seed timestamps use DEFAULT now(): independent installations cannot match
        // byte-for-byte. Check their migration-time range and compare EVERY other field/row.
        Map.of("inverter_control_certification", "created_at",
                "messreihe_viertelstunde_lauf", "geaendert_am",
                "messreihe_tag_lauf", "geaendert_am",
                "messreihe_luecke_lauf", "geaendert_am").forEach((table, column) -> {
                    assertThat(db.queryForObject("SELECT count(*) FROM " + table + " WHERE " + column
                            + " IS NULL OR " + column + " NOT BETWEEN ? AND now()", Integer.class,
                            Timestamp.from(beginn))).as("%s.%s: migration timestamp", table, column).isZero();
                    finger.put(table, db.queryForList("SELECT (to_jsonb(t) - '" + column
                            + "')::text FROM " + table + " t ORDER BY 1", String.class));
                });
        return finger;
    }

    private List<String> mainSatz() throws IOException {
        try (var input = getClass().getResourceAsStream("/migration/main-migrations.txt")) {
            assertThat(input).isNotNull();
            List<String> main = new String(input.readAllBytes(), StandardCharsets.UTF_8).lines()
                    .filter(line -> !line.isBlank() && !line.startsWith("#")).toList();
            assertThat(main).isNotEmpty().doesNotHaveDuplicates();
            assertThat(main).allMatch(name -> name.matches("V[0-9]+__[^/]+\\.sql"));
            return main;
        }
    }

    private static void rollenereignisse(JdbcTemplate db, String actorPrefix) {
        // The journal deliberately has no FK to live objects, so no unrelated tenant seed is needed.
        for (String art : List.of("rolle_gesetzt", "rolle_entzogen")) {
            db.update("INSERT INTO ort_aenderung (tenant_id, objekt_art, objekt_id, art, gilt_ab, "
                    + "rueckwirkend, " + actorPrefix + "_sub, " + actorPrefix + "_name, created_at) "
                    + "VALUES ('00000000-0000-0000-0000-000000000001', 'anlage', "
                    + "'00000000-0000-0000-0000-000000000002', ?, DATE '2026-09-16', false, "
                    + "'kc-bestand', 'Bestandsnutzer', TIMESTAMPTZ '2026-09-16 12:00:00+00')", art);
        }
    }

    private static Map<String, List<Map<String, Object>>> schema(JdbcTemplate db) {
        // Attribute positions may differ by arrival order; compare names and definitions instead.
        // pg_get_constraintdef includes CHECKs, FKs (including delete rules), uniqueness and PKs.
        return Map.of(
                "columns", db.queryForList("""
                        SELECT c.table_name, c.column_name, c.udt_name, c.is_nullable,
                               c.column_default, c.character_maximum_length,
                               c.numeric_precision, c.numeric_scale
                        FROM information_schema.columns c
                        JOIN information_schema.tables t USING (table_schema, table_name)
                        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
                          AND c.table_name <> 'flyway_schema_history'
                        ORDER BY c.table_name, c.column_name
                        """),
                "constraints", db.queryForList("""
                        SELECT t.relname AS table_name, c.conname, c.contype,
                               pg_get_constraintdef(c.oid) AS definition, c.convalidated
                        FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
                        JOIN pg_namespace n ON n.oid = t.relnamespace
                        WHERE n.nspname = 'public' AND t.relname <> 'flyway_schema_history'
                        ORDER BY t.relname, c.conname
                        """));
    }

    private static FluentConfiguration flyway(String database) {
        return Flyway.configure().dataSource(dataSource(database))
                .locations("classpath:db/migration")
                .placeholders(Map.of("appDbUser", "voltpilot_app", "appDbPassword", "voltpilot_app_test_pw",
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "voltpilot_admin_test_pw"));
    }

    private static JdbcTemplate db(String database) {
        return new JdbcTemplate(dataSource(database));
    }

    private static PGSimpleDataSource dataSource(String database) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl().replace("/voltpilot", "/" + database));
        ds.setUser(POSTGRES.getUsername());
        ds.setPassword(POSTGRES.getPassword());
        return ds;
    }
}
