package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.EreignisVokabular.Urheber;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import java.util.stream.Collectors;
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
 * {@code V20260915061500} (UEMS AP-11 IP-8): das Ereignis {@code kennzahl_neu_gebildet} — ADDITIV über die EINE
 * Vokabular-Funktion, die Bezugs-Funktion und den Art-CHECK, ohne Tabelle, Spalte oder Zeile.
 *
 * <ul>
 *   <li>Bestandsschutz über den gemeinsamen Vergleich ({@link Bestandsschutz}): Ereignisse und Messstellen bleiben
 *       Zeichen für Zeichen;</li>
 *   <li>die Funktion kennt das Wort in der Reihenfolge der Java-Zwillinge, mit Urheber, Zeitform, Bezug und Pflicht;
 *       der Art-CHECK nennt es;</li>
 *   <li>der Bezug kennt {@code kennzahl} als sechsten Schlüssel — als Text, nur an diesem Wort, ohne Messstelle und
 *       Messkanal; die Nutzlast verlangt Auslöser und Version;</li>
 *   <li>die Zeile der Kaskade ({@code kennungen} nur die Kennzahl, {@code nutzlast} Auslöser und Version, ohne
 *       Messstelle) nimmt die Datenbank von der BYPASSRLS-Rolle an; der Schreibweg legt die Kennzahl in die
 *       Kennungen und verwirft die Meldung eines Menschen und eine Version 1;</li>
 *   <li>die Datei schreibt das Vokabular von {@code V20260915050100} Zeichen für Zeichen fort und läuft ein zweites
 *       Mal ohne Änderung ({@code out-of-order}).</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsKennzahlNeuGebildetMigrationTest {

    private static final String DIESE = "20260915061500";
    private static final Path MIGRATIONEN = Path.of("src", "main", "resources", "db", "migration");
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();
    /** Oktober 2026 in Europe/Berlin: [01.10. 00:00, 01.11. 00:00) — über die Umstellung auf die Winterzeit (K7). */
    private static final String VON = "2026-09-30T22:00:00Z";
    private static final String BIS = "2026-10-31T23:00:00Z";
    private static final String INSERT = "INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, "
            + "von, bis, kennungen, nutzlast) VALUES ('" + VON + "', ?, ?, 'kennzahl_neu_gebildet', ?, '" + VON + "', '"
            + BIS + "', ?::jsonb, ?::jsonb)";
    private static final String KENNUNGEN = "{\"kennzahl\": \"KZ-0001\"}";
    private static final String NUTZLAST = "{\"ausloeser\": \"K-2026-0007\", \"version\": 2}";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static JdbcTemplate admin;
    private static UUID tenant;
    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        tenant = root.queryForObject("INSERT INTO tenant (name) VALUES ('Kunststoffwerk Ahrenberg GmbH') RETURNING id",
                UUID.class);
        root.update("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, einheit, "
                + "wertart) VALUES (?, 'MS-12', 'Montage Linie M1', 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                + "'Zählerstand')", tenant);
        // Der Bestand, den diese Migration berührt: das Vokabular (das bisher jüngste Wort der Cloud) und der Bezug.
        ObjectNode bilanz = JSON.createObjectNode()
                .put("ereignis_id", UUID.randomUUID().toString())
                .put("art", "bilanz_neu_berechnet")
                .put("von", "2026-10-17T22:00:00Z")
                .put("bis", "2026-10-18T22:00:00Z")
                .put("messstelle", "MS-12")
                .put("ausloeser", "K-2026-0007");
        assertThat(als(() -> new MessreiheEreignisRepository(app).anhaengen(tenant, null, Urheber.CLOUD, bilanz, null,
                null)).ausgang()).isEqualTo(MessreiheEreignisRepository.Ausgang.ANGEHAENGT);
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
        for (String tabelle : List.of("messreihe_ereignis", "messstelle")) {
            assertThat(fingerVorher.get(tabelle)).as("es gibt Bestand in " + tabelle).isNotEqualTo(Bestandsschutz.LEER);
        }
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
    }

    @Test
    void derBestandsvergleichBeisst() {
        Bestandsschutz.mutationsprobe(root, List.of(), "tenant", "UPDATE tenant SET name = name || '!'");
    }

    // ================================================================== Vokabular

    @Test
    void dasVokabularKenntDieNeubildungInDerReihenfolgeDerZwillinge() {
        assertThat(root.queryForList("SELECT art FROM messreihe_ereignis_vokabular()", String.class))
                // Hinter bilanz_neu_berechnet angehängt — additiv, die Reihenfolge bleibt; ein späteres Wort darf folgen.
                .containsSubsequence("bilanz_neu_berechnet", "kennzahl_neu_gebildet")
                .containsExactlyElementsOf(Arrays.stream(EreignisVokabular.Art.values())
                        .map(EreignisVokabular.Art::code).toList());
        Map<String, Object> v = root.queryForMap("SELECT array_to_string(urheber, ',') AS u, zeitform AS z, grenzen AS g, "
                + "offen_erlaubt AS o, array_to_string(bezug_pflicht, ',') AS bp, array_to_string(bezug_erlaubt, ',') AS be, "
                + "array_to_string(pflicht, ',') AS p, array_to_string(felder, ',') AS f, "
                + "array_to_string(fortschreibbar, ',') AS fs, bestand AS b "
                + "FROM messreihe_ereignis_vokabular() WHERE art = 'kennzahl_neu_gebildet'");
        assertThat(v).containsEntry("u", "cloud").containsEntry("z", "zeitraum").containsEntry("g", "halboffen")
                .containsEntry("o", false).containsEntry("bp", "kennzahl").containsEntry("be", "")
                .containsEntry("p", "ausloeser,version").containsEntry("f", "").containsEntry("fs", "")
                .containsEntry("b", false);
    }

    @Test
    void derArtCheckKenntDasWort() {
        assertThat(root.queryForObject("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                + "WHERE conname = 'messreihe_ereignis_art_chk' AND conrelid = 'messreihe_ereignis'::regclass",
                String.class)).contains("'bilanz_neu_berechnet'", "'kennzahl_neu_gebildet'");
    }

    @Test
    void derBezugKenntDieKennzahlAlsSechstenSchluessel() {
        assertThat(bezug("kennzahl_neu_gebildet", KENNUNGEN, null)).as("die Kennzahl").isTrue();
        assertThat(bezug("kennzahl_neu_gebildet", "{}", null)).as("ohne Kennzahl").isFalse();
        assertThat(bezug("kennzahl_neu_gebildet", "{\"kennzahl\": 1}", null)).as("Kennung ist Text").isFalse();
        assertThat(bezug("kennzahl_neu_gebildet", "{\"kennzahl\": \"KZ-0001\", \"messstelle\": \"MS-12\"}", null))
                .as("keine Messstelle daneben").isFalse();
        assertThat(bezug("kennzahl_neu_gebildet", KENNUNGEN, "Wirkenergie Bezug")).as("kein Messkanal").isFalse();
        assertThat(bezug("kennzahl_neu_gebildet", "{\"kennzahl\": \"KZ-0001\", \"fremd\": \"X-1\"}", null))
                .as("kein unbekannter Schlüssel").isFalse();
        assertThat(bezug("bilanz_neu_berechnet", "{\"messstelle\": \"MS-12\", \"kennzahl\": \"KZ-0001\"}", null))
                .as("an einer anderen Art ist die Kennzahl kein Bezug").isFalse();
        // Die bisherigen Wörter urteilen wie vorher.
        assertThat(bezug("bilanz_neu_berechnet", "{\"messstelle\": \"MS-12\"}", null)).isTrue();
        assertThat(bezug("correction", "{\"bezugsgroesse\": \"BZ-6\"}", null)).isTrue();

        assertThat(nutzlast(NUTZLAST)).as("Auslöser und Version").isTrue();
        assertThat(nutzlast("{\"ausloeser\": \"K-2026-0007\"}")).as("ohne Version").isFalse();
        assertThat(nutzlast("{\"version\": 2}")).as("ohne Auslöser").isFalse();
        assertThat(nutzlast("{\"ausloeser\": \"K-2026-0007\", \"version\": 2, \"messstelle\": \"MS-12\"}"))
                .as("kein fremdes Nutzfeld").isFalse();
    }

    // ================================================================== die Zeile der Kaskade

    @Test
    void dieZeileDerKaskadeNimmtDieDatenbankVonDerBypassRolleAn() {
        UUID id = UUID.randomUUID();
        assertThat(admin.update(INSERT, tenant, id, "cloud", KENNUNGEN, NUTZLAST)).isEqualTo(1);
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE ereignis_id = ? "
                + "AND kennungen = '" + KENNUNGEN + "'::jsonb AND nutzlast = '" + NUTZLAST + "'::jsonb "
                + "AND messstelle_id IS NULL AND zeit = von AND bis = '" + BIS + "'::timestamptz", Long.class, id))
                .as("die Zeile wie geschrieben").isEqualTo(1L);

        assertThat(psql(() -> root.update(INSERT, tenant, UUID.randomUUID(), "kunde", KENNUNGEN, NUTZLAST))
                .getSQLState()).as("nur die Cloud").isEqualTo("23514");
        assertThat(psql(() -> root.update(INSERT, tenant, UUID.randomUUID(), "cloud",
                "{\"kennzahl\": \"KZ-0001\", \"messstelle\": \"MS-12\"}", NUTZLAST)).getSQLState())
                .as("kein Bezug an einer Messstelle").isEqualTo("23514");
        assertThat(psql(() -> root.update(INSERT, tenant, UUID.randomUUID(), "cloud", KENNUNGEN,
                "{\"ausloeser\": \"K-2026-0007\"}")).getSQLState()).as("ohne Version").isEqualTo("23514");
    }

    @Test
    void derSchreibwegLegtDieKennzahlInDieKennungen() {
        ObjectNode e = meldung();
        assertThat(als(() -> new MessreiheEreignisRepository(app).anhaengen(tenant, null, Urheber.CLOUD, e, null, null))
                .ausgang()).isEqualTo(MessreiheEreignisRepository.Ausgang.ANGEHAENGT);
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE ereignis_id = ? "
                + "AND kennungen = '" + KENNUNGEN + "'::jsonb AND nutzlast = '" + NUTZLAST + "'::jsonb "
                + "AND messstelle_id IS NULL", Long.class, UUID.fromString(e.get("ereignis_id").asText())))
                .as("der Bezug in kennungen, Auslöser und Version in nutzlast").isEqualTo(1L);
        assertThat(als(() -> new MessreiheEreignisRepository(app).anhaengen(tenant, null, Urheber.KUNDE, meldung(), null,
                null)).ausgang()).as("ein Mensch meldet die Neubildung nie")
                .isEqualTo(MessreiheEreignisRepository.Ausgang.VERWORFEN);
        ObjectNode ersteVersion = meldung().put("version", 1);
        assertThat(als(() -> new MessreiheEreignisRepository(app).anhaengen(tenant, null, Urheber.CLOUD, ersteVersion,
                null, null)).ausgang()).as("Version 1 ist keine Neubildung")
                .isEqualTo(MessreiheEreignisRepository.Ausgang.VERWORFEN);
    }

    // ================================================================== die Datei

    /** Das Vokabular von V20260915050100 Zeichen für Zeichen, dahinter EINE Zeile; keine Tabelle, Spalte, Zeile. */
    @Test
    void dieDateiSchreibtDasVokabularFortUndLegtNichtsAn() throws Exception {
        String alt = Files.readString(MIGRATIONEN.resolve("V20260915050100__uems_bericht_ereignisse.sql"));
        String neu = Files.readString(MIGRATIONEN.resolve("V" + DIESE + "__uems_kennzahl_neu_gebildet.sql"));
        String vokabular = "CREATE OR REPLACE FUNCTION messreihe_ereignis_vokabular()";
        String altesVokabular = alt.substring(alt.indexOf(vokabular), alt.indexOf("\n$$;", alt.indexOf(vokabular)));
        assertThat(neu).as("der Stand von V20260915050100, dahinter EINE Zeile").contains(altesVokabular
                + ",\n    ('kennzahl_neu_gebildet', ARRAY['cloud']::text[], 'zeitraum', 'halboffen', false,");
        String kommentar = "COMMENT ON FUNCTION messreihe_ereignis_vokabular() IS";
        String alterKommentar = alt.substring(alt.indexOf(kommentar),
                alt.indexOf("nr/format.", alt.indexOf(kommentar)));
        assertThat(neu).as("der Kommentar wächst nur").contains(alterKommentar + "nr/format; seit AP-11 IP-8");
        String bezug = "CREATE OR REPLACE FUNCTION messreihe_ereignis_bezug_erlaubt(";
        String alterBezug = alt.substring(alt.indexOf(bezug), alt.indexOf("\n$$;", alt.indexOf(bezug)));
        assertThat(neu).as("der Bezug wächst nur um den Schlüssel kennzahl")
                .contains(alterBezug.replace("'bericht')", "'bericht', 'kennzahl')"));
        String anweisungen = neu.lines().filter(z -> !z.stripLeading().startsWith("--"))
                .collect(Collectors.joining("\n")).toUpperCase(Locale.ROOT);
        assertThat(anweisungen).doesNotContain("CREATE TABLE", "ADD COLUMN", "INSERT INTO", "UPDATE ", "DELETE FROM",
                "DROP TABLE", "DROP FUNCTION");
    }

    /**
     * {@code out-of-order: true}: dieselbe Datei ein zweites Mal auf dem neuesten Stand ändert keine Zeile. Zurückgerollt:
     * ihr {@code CREATE OR REPLACE} setzte sonst die Vokabular-Funktion und den Art-CHECK auf ihren Stand zurück (ohne
     * spätere Arten) — und die übrigen Tests dieser Klasse sähen je nach Reihenfolge ein altes Vokabular.
     */
    @Test
    void dieMigrationLaeuftAuchEinZweitesMal() throws Exception {
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());
        String sql = Files.readString(MIGRATIONEN.resolve("V" + DIESE + "__uems_kennzahl_neu_gebildet.sql"))
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
                .put("art", "kennzahl_neu_gebildet")
                .put("von", VON)
                .put("bis", BIS)
                .put("kennzahl", "KZ-0001")
                .put("ausloeser", "K-2026-0007")
                .put("version", 2);
    }

    private static boolean bezug(String art, String kennungen, String messkanal) {
        return root.queryForObject("SELECT messreihe_ereignis_bezug_erlaubt(?, ?::jsonb, ?)", Boolean.class, art,
                kennungen, messkanal);
    }

    private static boolean nutzlast(String nutzlast) {
        return root.queryForObject("SELECT messreihe_ereignis_nutzlast_erlaubt('kennzahl_neu_gebildet', ?::jsonb)",
                Boolean.class, nutzlast);
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
