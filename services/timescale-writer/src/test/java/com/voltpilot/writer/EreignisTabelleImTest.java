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
 */
final class EreignisTabelleImTest {

    /** The working directory of the writer tests is services/timescale-writer. */
    static final Path MIGRATION = Path.of("..", "api", "src", "main", "resources", "db", "migration",
            "V20260911260000__uems_messreihe_ereignis.sql");

    private EreignisTabelleImTest() {}

    /** Creates the table and the tenants the test writes events for (FK RESTRICT to tenant). */
    static void anlegen(PostgreSQLContainer<?> db, String... tenants) throws Exception {
        String sql = Files.readString(MIGRATION)
                .replace("${appDbUser}", "voltpilot_app")
                .replace("${adminDbUser}", "voltpilot_admin");
        try (Connection c = DriverManager.getConnection(db.getJdbcUrl(), db.getUsername(),
                db.getPassword()); Statement st = c.createStatement()) {
            st.execute(sql);
            for (String t : tenants) {
                st.execute("INSERT INTO tenant (id) VALUES ('" + t + "') ON CONFLICT DO NOTHING");
            }
        }
    }
}
