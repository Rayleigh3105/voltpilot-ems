package com.voltpilot.writer;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import org.testcontainers.containers.PostgreSQLContainer;

/**
 * Runs the REAL migration of {@code messreihe_ereignis} (services/api, V20260911260000) on a
 * writer test database that {@code writer-schema.sql} prepared - so the writer is tested against
 * exactly the table, CHECKs, trigger, grants and RLS Flyway builds, never against a copy.
 * Placeholders replaced the way the api tests configure Flyway.
 *
 * <p>Then the migration that widens the vocabulary by {@code counter_overflow} and adds the
 * declaration {@code messreihe_zaehler_deklaration()} the overflow detection reads (UEMS AP-08
 * IP-4, V20260912220000) - it rewrites the whole vocabulary function, so the writer sees the
 * CURRENT vocabulary, not the one of the first migration.
 */
final class EreignisTabelleImTest {

    /** The working directory of the writer tests is services/timescale-writer. */
    static final Path MIGRATION = Path.of("..", "api", "src", "main", "resources", "db", "migration",
            "V20260911260000__uems_messreihe_ereignis.sql");
    static final Path UEBERLAUF = MIGRATION.resolveSibling("V20260912220000__uems_zaehler_ueberlauf.sql");

    private EreignisTabelleImTest() {}

    /** Creates the table and the tenants the test writes events for (FK RESTRICT to tenant). */
    static void anlegen(PostgreSQLContainer<?> db, String... tenants) throws Exception {
        try (Connection c = DriverManager.getConnection(db.getJdbcUrl(), db.getUsername(),
                db.getPassword()); Statement st = c.createStatement()) {
            for (Path migration : new Path[] {MIGRATION, UEBERLAUF}) {
                st.execute(Files.readString(migration)
                        .replace("${appDbUser}", "voltpilot_app")
                        .replace("${adminDbUser}", "voltpilot_admin"));
            }
            for (String t : tenants) {
                st.execute("INSERT INTO tenant (id) VALUES ('" + t + "') ON CONFLICT DO NOTHING");
            }
        }
    }
}
