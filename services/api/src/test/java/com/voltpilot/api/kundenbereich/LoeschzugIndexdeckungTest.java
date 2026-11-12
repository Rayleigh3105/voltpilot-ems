package com.voltpilot.api.kundenbereich;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Index-Deckung des Löschwegs (Befund vp-kunde-loeschen-504, Produktion 12.11.2026): der Löschzug
 * zählt jede Katalog-Tabelle mit {@code tenant_id} zweimal ({@code count(*) … WHERE tenant_id}),
 * die Datenauskunft des Dialogs fragt jede mit EXISTS, der letzte Schritt löscht über den Katalog -
 * und die RI-Prüfung sucht je gelöschter Elternzeile über die Fremdschlüssel-Spalten der Kinder.
 * Ohne Index ist jeder dieser Zugriffe ein Seq-Scan über die Zeilen ALLER Mandanten; in Produktion
 * machte das (zusammen mit der Sperre eines laufenden Verdichtungs-Jobs) aus dem Löschzug eines
 * fast leeren Kunden ~60 s, und der Ingress (60-s-Grenze) antwortete 504.
 *
 * <p>Rotprobe: vor V20261112150000/V20261112151000 standen hier 129 Katalog-Tabellen ohne
 * tenant_id-Index (12 davon Hypertables, darunter telemetry_v2 und device_measurement_sample)
 * und 13 ungedeckte Fremdschlüssel. Eine NEUE Tabelle mit {@code tenant_id} ohne Index macht
 * diesen Test wieder rot - der Index gehört in ihre Migration.
 */
@Testcontainers(disabledWithoutDocker = true)
class LoeschzugIndexdeckungTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;

    @BeforeAll
    static void migrieren() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW))
                .load().migrate();
    }

    /**
     * Jede Tabelle des Löschzug-Katalogs (jede mit {@code tenant_id}) trägt einen Index, der mit
     * {@code tenant_id} beginnt - vollständig, nicht partiell (ein Teil-Index trägt die Zählung
     * {@code WHERE tenant_id = ?} nicht; so fiel device_measurement_sample durch, dessen einziger
     * tenant_id-führender Index ein Teil-Index ist).
     */
    @Test
    void jedeKatalogTabelleTraegtEinenTenantIndex() {
        List<String> ohne = root.queryForList("""
                WITH katalog AS (
                  SELECT c.oid, c.relname
                  FROM pg_class c
                  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
                  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
                  WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
                ), gedeckt AS (
                  SELECT DISTINCT i.indrelid FROM pg_index i
                  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
                  WHERE a.attname = 'tenant_id' AND i.indpred IS NULL
                )
                SELECT k.relname FROM katalog k
                WHERE k.oid NOT IN (SELECT indrelid FROM gedeckt) ORDER BY 1
                """, String.class);
        assertThat(ohne)
                .as("Katalog-Tabellen ohne tenant_id-führenden Index - der Index gehört in die Migration der Tabelle")
                .isEmpty();
    }

    /**
     * Jeder Fremdschlüssel, dessen Elterntabelle im Löschzug Zeilen verliert ({@code tenant} oder
     * eine Tabelle mit {@code tenant_id}), ist auf der Kindseite index-gestützt: mindestens ein
     * Index beginnt mit einer der Fremdschlüssel-Spalten. Sonst ist die RI-Prüfung
     * (CASCADE/RESTRICT/SET NULL) je gelöschter Elternzeile ein Seq-Scan über das ganze Kind.
     */
    @Test
    void jederFremdschluesselAufLoeschbareElternIstIndexGestuetzt() {
        List<String> ohne = root.queryForList("""
                SELECT conrelid::regclass || ' -> ' || confrelid::regclass || ' (' ||
                       (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                          FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) || ')'
                FROM pg_constraint c
                WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
                  AND (c.confrelid = 'tenant'::regclass OR EXISTS (
                        SELECT 1 FROM pg_attribute pa
                        WHERE pa.attrelid = c.confrelid AND pa.attname = 'tenant_id' AND NOT pa.attisdropped))
                  AND NOT EXISTS (
                        SELECT 1 FROM pg_index i
                        WHERE i.indrelid = c.conrelid AND i.indkey[0] = ANY (c.conkey) AND i.indpred IS NULL)
                ORDER BY 1
                """, String.class);
        assertThat(ohne)
                .as("Fremdschlüssel ohne Index auf der Kindseite - die RI-Prüfung des Löschzugs scannt sonst voll")
                .isEmpty();
    }

    private static PGSimpleDataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
