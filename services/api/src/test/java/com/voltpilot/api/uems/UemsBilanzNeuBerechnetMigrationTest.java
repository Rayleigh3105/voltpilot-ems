package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.EreignisVokabular.Urheber;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.postgresql.util.PSQLException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * {@code V20260914140000} (UEMS AP-10 IP-11): das Ereignis {@code bilanz_neu_berechnet} — ADDITIV über die EINE
 * Vokabular-Funktion und den Art-CHECK, ohne Tabelle, Spalte oder Zeile.
 *
 * <ul>
 *   <li>Bestandsschutz über den gemeinsamen Vergleich ({@link Bestandsschutz}): Ereignisse, Verteilung und
 *       Kostenstelle bleiben Zeichen für Zeichen;</li>
 *   <li>die Funktion kennt das Wort in der Reihenfolge der Java-Zwillinge, mit Urheber, Zeitform, Bezug und Pflicht;</li>
 *   <li>der Schreibweg nimmt die Meldung der Cloud an und löst die Messstelle auf; die Datenbank lehnt einen Bezug an
 *       einer Reihe und ein fremdes Nutzfeld ab;</li>
 *   <li>die Migration läuft ein zweites Mal ohne Änderung ({@code out-of-order}).</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsBilanzNeuBerechnetMigrationTest {

    private static final String DIESE = "20260914140000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static UUID tenant;
    private static UUID ms22;
    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        tenant = root.queryForObject("INSERT INTO tenant (name) VALUES ('Kunststoffwerk Ahrenberg GmbH') RETURNING id",
                UUID.class);
        UUID unternehmen = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, "
                + "'Kunststoffwerk Ahrenberg GmbH', 'Europe/Berlin') RETURNING id", UUID.class, tenant);
        ms22 = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, "
                + "einheit, wertart) VALUES (?, 'MS-22', 'Lindach nicht zugeordnet', 'berechnet', 'Strom', 'Wirkenergie', "
                + "'Bezug', 'kWh', 'Intervallmenge') RETURNING id", UUID.class, tenant);
        UUID ms17 = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-17', 'Lagerhalle Lindach gesamt', 'gemessen', 'Strom', "
                + "'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, tenant);
        UUID k4300 = root.queryForObject("INSERT INTO kostenstelle (tenant_id, unternehmen_id, kennzeichen, name, "
                + "gueltig_ab) VALUES (?, ?, '4300', 'Logistik', DATE '2026-10-01') RETURNING id", UUID.class, tenant,
                unternehmen);
        // Der Bestand, den diese Migration berührt: das Vokabular (eine Meldung jeder Art-Familie) und die Verteilung.
        root.update("INSERT INTO messstelle_verteilung (tenant_id, messstelle_id, kostenstelle_id, anteil_prozent, "
                + "gueltig_ab, created_by) VALUES (?, ?, ?, 100, DATE '2026-10-15', 'test')", tenant, ms17, k4300);
        ObjectNode verteilung = JSON.createObjectNode()
                .put("ereignis_id", UUID.randomUUID().toString())
                .put("art", "verteilung_geaendert")
                .put("zeitpunkt", "2026-10-14T22:00:00Z")
                .put("messstelle", "MS-17")
                .put("eingetragen_am", "2026-10-15T08:00:00Z");
        assertThat(als(() -> new MessreiheEreignisRepository(app).anhaengen(tenant, null, Urheber.KUNDE, verteilung,
                null, null)).ausgang()).isEqualTo(MessreiheEreignisRepository.Ausgang.ANGEHAENGT);
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());

        flyway().target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        flyway().load().migrate();
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ================================================================== Bestandsschutz

    @Test
    void dieMigrationLaesstDenBestandZeichengleich() {
        for (String tabelle : List.of("messreihe_ereignis", "messstelle_verteilung", "kostenstelle", "messstelle")) {
            assertThat(fingerVorher.get(tabelle)).as("es gibt Bestand in " + tabelle).isNotEqualTo(Bestandsschutz.LEER);
        }
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
    }

    @Test
    void derBestandsvergleichBeisst() {
        Bestandsschutz.mutationsprobe(root, List.of(), "messstelle_verteilung",
                "UPDATE messstelle_verteilung SET created_by = created_by || '!'");
    }

    // ================================================================== Vokabular

    @Test
    void dasVokabularKenntDieNeuberechnungInDerReihenfolgeDerZwillinge() {
        assertThat(root.queryForList("SELECT art FROM messreihe_ereignis_vokabular()", String.class))
                // Additiv: spätere Arten kommen HINTER sie (AP-12 IP-4: die vier Berichts-Ereignisse) — geprüft wird die
                // Reihenfolge, nicht das Ende der Liste.
                .containsSubsequence("verteilung_geaendert", "bilanz_neu_berechnet")
                .containsExactlyElementsOf(Arrays.stream(EreignisVokabular.Art.values())
                        .map(EreignisVokabular.Art::code).toList());
        Map<String, Object> v = root.queryForMap("SELECT array_to_string(urheber, ',') AS u, zeitform AS z, grenzen AS g, "
                + "offen_erlaubt AS o, array_to_string(bezug_pflicht, ',') AS bp, array_to_string(bezug_erlaubt, ',') AS be, "
                + "array_to_string(pflicht, ',') AS p, array_to_string(felder, ',') AS f "
                + "FROM messreihe_ereignis_vokabular() WHERE art = 'bilanz_neu_berechnet'");
        assertThat(v).containsEntry("u", "cloud").containsEntry("z", "zeitraum").containsEntry("g", "halboffen")
                .containsEntry("o", false).containsEntry("bp", "messstelle").containsEntry("be", "")
                .containsEntry("p", "ausloeser").containsEntry("f", "");
    }

    @Test
    void derSchreibwegNimmtDieMeldungDerCloudAnUndDieDatenbankHaeltDenBezug() {
        ObjectNode e = meldung();
        assertThat(als(() -> new MessreiheEreignisRepository(app).anhaengen(tenant, null, Urheber.CLOUD, e, null, null))
                .ausgang()).isEqualTo(MessreiheEreignisRepository.Ausgang.ANGEHAENGT);
        assertThat(root.queryForObject("SELECT messstelle_id FROM messreihe_ereignis WHERE ereignis_id = ?", UUID.class,
                UUID.fromString(e.get("ereignis_id").asText()))).as("MS-22 aufgelöst").isEqualTo(ms22);
        assertThat(als(() -> new MessreiheEreignisRepository(app).anhaengen(tenant, null, Urheber.KUNDE, meldung(), null,
                null)).ausgang()).as("ein Mensch meldet die Rechnung nie")
                .isEqualTo(MessreiheEreignisRepository.Ausgang.VERWORFEN);

        String insert = "INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, von, bis, kennungen, "
                + "nutzlast) VALUES ('2026-10-17T22:00:00Z', ?, ?, 'bilanz_neu_berechnet', 'cloud', "
                + "'2026-10-17T22:00:00Z', '2026-10-18T22:00:00Z', ?::jsonb, ?::jsonb)";
        assertThat(psql(() -> root.update(insert, tenant, UUID.randomUUID(),
                "{\"messstelle\": \"MS-22\", \"komponente\": \"K-8.1\"}", "{\"ausloeser\": \"K-2026-0011\"}"))
                .getSQLState()).as("kein Bezug an einer Reihe").isEqualTo("23514");
        assertThat(psql(() -> root.update(insert, tenant, UUID.randomUUID(), "{\"messstelle\": \"MS-22\"}",
                "{\"ausloeser\": \"K-2026-0011\", \"korrektur\": \"K-2026-0011\"}")).getSQLState())
                .as("kein fremdes Nutzfeld").isEqualTo("23514");
    }

    /**
     * {@code out-of-order: true}: dieselbe Datei ein zweites Mal auf dem neuesten Stand ändert keine Zeile. Zurückgerollt:
     * ihr {@code CREATE OR REPLACE} setzte sonst die Vokabular-Funktion und den Art-CHECK auf ihren Stand zurück (ohne
     * die späteren Arten, AP-12 IP-4) — und die übrigen Tests dieser Klasse sähen je nach Reihenfolge ein altes Vokabular.
     */
    @Test
    void dieMigrationLaeuftAuchEinZweitesMal() throws Exception {
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());
        String sql = Files.readString(Path.of("src", "main", "resources", "db", "migration",
                "V" + DIESE + "__uems_bilanz_neu_berechnet.sql"))
                .replace("${appDbUser}", APP_USER).replace("${adminDbUser}", ADMIN_USER);
        new TransactionTemplate(new DataSourceTransactionManager(root.getDataSource())).executeWithoutResult(status -> {
            status.setRollbackOnly();
            root.execute(sql);
            assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of()))).isEmpty();
        });
    }

    // ================================================================== Hilfen

    private static ObjectNode meldung() {
        return JSON.createObjectNode()
                .put("ereignis_id", UUID.randomUUID().toString())
                .put("art", "bilanz_neu_berechnet")
                .put("von", "2026-10-17T22:00:00Z")
                .put("bis", "2026-10-18T22:00:00Z")
                .put("messstelle", "MS-22")
                .put("ausloeser", "K-2026-0011");
    }

    private static <T> T als(Supplier<T> arbeit) {
        TenantContext.set(tenant);
        try {
            return arbeit.get();
        } finally {
            TenantContext.clear();
        }
    }

    private static PSQLException psql(Runnable arbeit) {
        Throwable t = null;
        try {
            arbeit.run();
        } catch (Throwable e) {
            t = e;
        }
        assertThat(t).as("die Datenbank muss ablehnen").isNotNull();
        for (Throwable c = t; c != null; c = c.getCause()) {
            if (c instanceof PSQLException p) {
                return p;
            }
        }
        throw new AssertionError("keine PSQLException: " + t);
    }

    private static String letzteFassungVorDieser() {
        MigrationVersion diese = MigrationVersion.fromVersion(DIESE);
        return Arrays.stream(flyway().load().info().all())
                .map(MigrationInfo::getVersion)
                .filter(v -> v != null && v.compareTo(diese) < 0)
                .max(Comparator.naturalOrder())
                .orElseThrow()
                .getVersion();
    }

    private static FluentConfiguration flyway() {
        return Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW));
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
