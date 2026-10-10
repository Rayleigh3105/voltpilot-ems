package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * UEMS AP-07 IP-18b Teil 1b, sperrarm ({@code V20260922236500}): die zwei Box-Schlüssel entstehen
 * Chunk für Chunk, je in einer eigenen Transaktion, und der alte fällt erst danach.
 *
 * <p>Der Bestand liegt über drei Tage, also drei Chunks. Davor steht der Zustand, den ein Abbruch
 * mitten im Bau hinterlässt (die api vom Kubelet beendet, kein Eintrag in der Flyway-Historie):
 * die Wurzel trägt den ersten Schlüssel, ein Chunk ist fertig, einer hat einen INVALID-Rest, einer
 * ist unberührt. In diesem Übergang schreibt der Writer-Weg ({@code ON CONFLICT DO NOTHING} ohne
 * Ziel) in jeden Chunk und weist dieselbe Zeile ab. Dann läuft die Migration zu Ende, und ein
 * zweiter Lauf auf dem fertigen Stand ändert nichts. Am Ende ist nichts von einem Index zu
 * unterscheiden, den Timescale selbst gebaut hätte.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsBoxSchluesselBauenMigrationTest {

    private static final String VOR = "20260922236000";
    private static final String DIESE = "20260922236500";
    private static final String BOX = "uq_device_measurement_sample_box";
    private static final String KOMPONENTE = "uq_device_measurement_sample_box_komponente";
    private static final String ALT = "uq_device_measurement_sample_idempotency";
    private static final List<Instant> TAGE = List.of(Instant.parse("2027-01-16T08:00:00Z"),
            Instant.parse("2027-01-17T08:00:00Z"), Instant.parse("2027-01-18T08:00:00Z"));
    private static final UUID KB = UUID.fromString("4e0e0000-0000-0000-0000-00000000b518");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static UUID site;
    private static UUID device;
    private static List<String> chunks;
    private static final List<Integer> ERSTER_WERT_IM_UEBERGANG = new ArrayList<>();
    private static final List<Integer> DUBLETTE_IM_UEBERGANG = new ArrayList<>();
    private static List<String> endstand;
    private static List<String> endstandNachZweitemLauf;

    @BeforeAll
    static void abbruchUebergangUndZweiLaeufe() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(VOR).load().migrate();
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH')", KB);
        site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-2') RETURNING id",
                UUID.class, KB);
        device = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, 'VP-BOX-HALLE-2', 'claimed') RETURNING id", UUID.class, KB, site);
        for (Instant tag : TAGE) {
            for (int i = 0; i < 10; i++) {
                assertThat(schreibe(tag.plusSeconds(60L * i), i, null)).isEqualTo(1);
            }
        }
        chunks = root.queryForList("SELECT c.table_name FROM _timescaledb_catalog.chunk c "
                + "JOIN _timescaledb_catalog.hypertable h ON h.id = c.hypertable_id "
                + "WHERE h.table_name = 'device_measurement_sample' ORDER BY c.id", String.class);
        assertThat(chunks).hasSize(3);

        // Der Abbruch: Wurzel mit dem ersten Schlüssel, Chunk 1 fertig, Chunk 2 INVALID, Chunk 3 nichts.
        root.execute("CREATE UNIQUE INDEX " + BOX + " ON ONLY device_measurement_sample "
                + "(device_id, point_key, time, edge_sequence) WHERE edge_entity_id IS NULL");
        root.execute("CREATE UNIQUE INDEX " + chunks.get(0) + "_" + BOX + " ON _timescaledb_internal."
                + chunks.get(0) + " (device_id, point_key, time, edge_sequence) WHERE edge_entity_id IS NULL");
        root.update("INSERT INTO _timescaledb_catalog.chunk_index (chunk_id, index_name, hypertable_id, "
                + "hypertable_index_name) SELECT id, table_name || '_' || ?, hypertable_id, ? "
                + "FROM _timescaledb_catalog.chunk WHERE table_name = ?", BOX, BOX, chunks.get(0));
        // So hinterlässt ein abgebrochenes CREATE INDEX CONCURRENTLY seinen Index: da, aber INVALID.
        root.execute("CREATE UNIQUE INDEX " + chunks.get(1) + "_" + BOX + " ON _timescaledb_internal."
                + chunks.get(1) + " (device_id, point_key, time, edge_sequence) WHERE edge_entity_id IS NULL");
        root.update("UPDATE pg_index SET indisvalid = false WHERE indexrelid = ?::regclass",
                "_timescaledb_internal." + chunks.get(1) + "_" + BOX);
        assertThat(ungueltig()).containsExactly(chunks.get(1) + "_" + BOX);

        // Der Übergang: der Writer-Weg schreibt in jeden Chunk, dieselbe Zeile weist er ab.
        for (Instant tag : TAGE) {
            ERSTER_WERT_IM_UEBERGANG.add(schreibe(tag.plusSeconds(3600), 500, null));
            DUBLETTE_IM_UEBERGANG.add(schreibe(tag.plusSeconds(3600), 500, null));
        }

        flyway().target(DIESE).load().migrate();
        endstand = stand();

        root.update("DELETE FROM flyway_schema_history WHERE version = ?", DIESE);
        flyway().target(DIESE).load().migrate();
        endstandNachZweitemLauf = stand();
    }

    @Test
    void nachDemAbbruchTraegtJederChunkBeideSchluesselUndKeinerDenAlten() {
        for (String chunk : chunks) {
            assertThat(root.queryForList("SELECT hypertable_index_name FROM _timescaledb_catalog.chunk_index ci "
                            + "JOIN _timescaledb_catalog.chunk c ON c.id = ci.chunk_id WHERE c.table_name = ? "
                            + "AND hypertable_index_name IN (?, ?, ?) ORDER BY 1",
                    String.class, chunk, BOX, KOMPONENTE, ALT))
                    .as("Timescale-Katalog von %s", chunk)
                    .containsExactly(BOX, KOMPONENTE);
            assertThat(indexe("_timescaledb_internal", chunk).values())
                    .anySatisfy(d -> assertThat(d).contains("UNIQUE",
                            "(device_id, point_key, \"time\", edge_sequence) WHERE (edge_entity_id IS NULL)"))
                    .anySatisfy(d -> assertThat(d).contains("UNIQUE",
                            "(device_id, point_key, edge_entity_id, \"time\", edge_sequence) "
                                    + "WHERE (edge_entity_id IS NOT NULL)"))
                    .noneSatisfy(d -> assertThat(d).contains(ALT));
        }
        assertThat(indexe("public", "device_measurement_sample")).containsKeys(BOX, KOMPONENTE)
                .doesNotContainKey(ALT);
        assertThat(root.queryForObject("SELECT count(*) FROM pg_class WHERE relname LIKE ?",
                Long.class, "%" + ALT + "%")).isZero();
        assertThat(ungueltig()).as("kein INVALID-Rest").isEmpty();
        assertThat(root.queryForObject("SELECT count(*) FROM pg_proc WHERE proname LIKE 'uems_box_schluessel_%'",
                Long.class)).as("die Hilfsprozeduren sind wieder weg").isZero();
    }

    @Test
    void imUebergangSchreibtDerWriterWegInJedenChunkUndWeistDieDubletteAb() {
        assertThat(ERSTER_WERT_IM_UEBERGANG).containsExactly(1, 1, 1);
        assertThat(DUBLETTE_IM_UEBERGANG).containsExactly(0, 0, 0);
    }

    @Test
    void einZweiterLaufAufDemFertigenStandAendertNichts() {
        assertThat(endstandNachZweitemLauf).isEqualTo(endstand);
        assertThat(root.queryForObject("SELECT bool_and(success) FROM flyway_schema_history "
                + "WHERE version = ?", Boolean.class, DIESE)).isTrue();
    }

    /**
     * Wie von Timescale gebaut: ON CONFLICT mit Ziel findet in jedem Chunk seinen Index (ohne den
     * Katalog-Eintrag: "could not find arbiter index"), der geteilte Punkt liegt je Komponente,
     * und ein neuer Chunk bekommt beide Schlüssel ohne den alten.
     */
    @Test
    void nachDemUmbauGiltDerSchluesselInJedemChunkWieVonTimescaleGebaut() {
        for (Instant tag : TAGE) {
            assertThat(root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, "
                            + "site_id, device_id, point_key, raw_numeric, quality, catalog_version, "
                            + "edge_sequence, aggregation_kind) VALUES (?, ?, ?, ?, ?, 'p', 1, 'good', "
                            + "'2026.09.11.1', 0, 'gauge') ON CONFLICT (device_id, point_key, time, "
                            + "edge_sequence) WHERE edge_entity_id IS NULL DO NOTHING",
                    Timestamp.from(tag), Timestamp.from(tag), KB, site, device))
                    .as("Bestandswert %s mit Ziel", tag).isZero();
            assertThat(schreibe(tag, 0, null)).isZero();
            UUID k7 = UUID.fromString("4e0e0000-0000-0000-0000-00000000b0f7");
            UUID k8 = UUID.fromString("4e0e0000-0000-0000-0000-00000000b0f8");
            assertThat(schreibe(tag, 0, k7) + schreibe(tag, 0, k8)).as("geteilter Punkt %s", tag).isEqualTo(2);
            assertThat(schreibe(tag, 0, k7)).isZero();
        }
        Instant neuerTag = Instant.parse("2027-01-20T08:00:00Z");
        assertThat(schreibe(neuerTag, 1, null)).isEqualTo(1);
        assertThat(root.queryForList("SELECT hypertable_index_name FROM _timescaledb_catalog.chunk_index ci "
                        + "JOIN _timescaledb_catalog.chunk c ON c.id = ci.chunk_id "
                        + "WHERE c.table_name NOT IN (?, ?, ?) "
                        + "AND hypertable_index_name IN (?, ?, ?) ORDER BY 1",
                String.class, chunks.get(0), chunks.get(1), chunks.get(2), BOX, KOMPONENTE, ALT))
                .as("ein neuer Chunk").containsExactly(BOX, KOMPONENTE);
    }

    // ---- Werkzeug --------------------------------------------------------------------------

    /** Der Writer-Weg: ON CONFLICT DO NOTHING ohne Ziel (MeasurementWriteRepository#schreiben). */
    private static int schreibe(Instant t, long sequenz, UUID genannt) {
        return root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, "
                        + "site_id, device_id, point_key, raw_numeric, quality, catalog_version, "
                        + "edge_sequence, aggregation_kind, edge_entity_id) VALUES (?, ?, ?, ?, ?, 'p', 1, "
                        + "'good', '2026.09.11.1', ?, 'gauge', ?) ON CONFLICT DO NOTHING",
                Timestamp.from(t), Timestamp.from(t.plusSeconds(5)), KB, site, device, sequenz, genannt);
    }

    private static List<String> ungueltig() {
        return root.queryForList("SELECT k.relname FROM pg_index x JOIN pg_class k ON k.oid = x.indexrelid "
                + "WHERE NOT x.indisvalid ORDER BY 1", String.class);
    }

    private static Map<String, String> indexe(String schema, String tabelle) {
        Map<String, String> indexe = new java.util.TreeMap<>();
        root.query("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = ? AND tablename = ?",
                rs -> { indexe.put(rs.getString(1), rs.getString(2)); }, schema, tabelle);
        return indexe;
    }

    /** Indexe der Hypertable und ihrer Chunks samt Timescale-Katalog, als vergleichbare Zeilen. */
    private static List<String> stand() {
        List<String> zeilen = new ArrayList<>(root.queryForList("SELECT tablename || ' ' || indexdef "
                + "FROM pg_indexes WHERE tablename = 'device_measurement_sample' OR tablename = ANY (?::text[]) "
                + "ORDER BY 1", String.class, "{" + String.join(",", chunks) + "}"));
        zeilen.addAll(root.queryForList("SELECT chunk_id || ' ' || index_name || ' ' || hypertable_index_name "
                + "FROM _timescaledb_catalog.chunk_index ORDER BY 1", String.class));
        return zeilen;
    }

    private static FluentConfiguration flyway() {
        return Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of(
                        "appDbUser", "voltpilot_app", "appDbPassword", "voltpilot_app_test_pw",
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "voltpilot_admin_test_pw"));
    }
}
