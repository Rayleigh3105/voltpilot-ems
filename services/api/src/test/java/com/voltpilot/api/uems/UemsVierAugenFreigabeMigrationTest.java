package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.MessreiheKorrekturRepository.Korrektur;
import java.nio.file.Files;
import java.nio.file.Path;
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
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * {@code V20260914201500} (UEMS AP-08 IP-15, E8): die Einstellung je Unternehmen und die Einstellung an der Freigabe —
 * zwei Spalten, keine Zeile.
 *
 * <ul>
 *   <li>Bestandsschutz über den gemeinsamen Vergleich ({@link Bestandsschutz}): Unternehmen und Korrekturen (auch eine
 *       Freigabe von vor IP-15 ohne Begründung) bleiben Zeichen für Zeichen — und die Vorgabe ist AUS (NULL);</li>
 *   <li>die Datenbank hält fest: eine Freigabe unter Vier-Augen an stammt nie vom Ersteller, die Einstellung steht nur
 *       an einer Fortschreibung mit Begründung, die System-Rolle schreibt sie nie;</li>
 *   <li>die Migration läuft ein zweites Mal ohne Änderung ({@code out-of-order}).</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsVierAugenFreigabeMigrationTest {

    private static final String DIESE = "20260914201500";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final ProtokollAkteur INES = new ProtokollAkteur("kc-ines-kaltenbach", "Ines Kaltenbach",
            "energiemanager", "kunde");
    private static final ProtokollAkteur JONAS = new ProtokollAkteur("kc-jonas-wendlinger", "Jonas Wendlinger",
            "kundenadministrator", "kunde");
    private static final String REIHEN =
            "[{\"entity_id\": \"6f1c2b1e-8d2a-4c7e-9a51-3b8e2f0c1d10\", \"messkanal\": \"energy_import_kwh\"}]";

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
        tenant = root.queryForObject("INSERT INTO tenant (name) VALUES ('Kunststoffwerk Ahrenberg GmbH') RETURNING id",
                UUID.class);
        root.update("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH', "
                + "'Europe/Berlin')", tenant);
        // Der Bestand: ein Vorschlag, und einer, der VOR IP-15 ohne Begründung freigegeben wurde.
        vorschlag("K-2026-0001", INES);
        root.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, actor_sub, actor_name, "
                + "actor_rolle, actor_art) VALUES (?, 'K-2026-0001', 2, 'freigegeben', ?, ?, ?, ?)",
                tenant, JONAS.sub(), JONAS.name(), JONAS.rolle(), JONAS.art());
        vorschlag("K-2026-0002", INES);
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());

        flyway().target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        flyway().load().migrate();
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ================================================================== Bestandsschutz

    @Test
    void dieMigrationLaesstDenBestandZeichengleichUndDieVorgabeIstAus() {
        for (String tabelle : List.of("unternehmen", "messreihe_korrektur")) {
            assertThat(fingerVorher.get(tabelle)).as("es gibt Bestand in " + tabelle).isNotEqualTo(Bestandsschutz.LEER);
        }
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
        assertThat(root.queryForObject("SELECT vieraugen_freigabe FROM unternehmen WHERE tenant_id = ?", Boolean.class,
                tenant)).as("nie eingestellt = Vorgabe aus").isNull();
        assertThat(root.queryForList("SELECT freigabe_vieraugen FROM messreihe_korrektur WHERE tenant_id = ? "
                + "AND kennung IN ('K-2026-0001', 'K-2026-0002')", Boolean.class, tenant))
                .as("keine Freigabe von vor IP-15 bekommt eine Einstellung").containsOnlyNulls();
    }

    /** Hätte die Migration die Vorgabe als Wert geschrieben (NOT NULL DEFAULT false), wäre das eine Abweichung. */
    @Test
    void derBestandsvergleichBeisst() {
        Bestandsschutz.mutationsprobe(root, List.of(), "unternehmen", "UPDATE unternehmen SET vieraugen_freigabe = false");
    }

    // ================================================================== Die Datenbank hält fest

    @Test
    void beiVierAugenAnGibtNieDerErstellerFrei() {
        vorschlag("K-2026-0010", INES);
        PSQLException p = psql(() -> alsTue(() -> app.update(freigabe(), tenant, "K-2026-0010", "Selbst geprüft und frei",
                INES.sub(), INES.name(), INES.rolle(), INES.art(), true)));
        assertThat(p.getServerErrorMessage().getConstraint()).as(p.getMessage())
                .isEqualTo("messreihe_korrektur_zweite_person");
        // Unter „aus“ darf die Erstellerin — dieselbe Zeile mit false geht durch.
        assertThat(alsTue(() -> app.update(freigabe(), tenant, "K-2026-0010", "Selbst geprüft und frei",
                INES.sub(), INES.name(), INES.rolle(), INES.art(), false))).isEqualTo(1);

        vorschlag("K-2026-0011", INES);
        Korrektur frei = als(() -> new MessreiheKorrekturRepository(app).freigeben(tenant, "K-2026-0011",
                "Zweite Person hat die Vorschau geprüft", JONAS, true));
        assertThat(frei.status()).isEqualTo("freigegeben");
        assertThat(frei.ersteller()).isEqualTo(INES);
        assertThat(frei.freigeber()).contains(JONAS);
        assertThat(root.queryForObject("SELECT freigabe_vieraugen FROM messreihe_korrektur WHERE tenant_id = ? "
                + "AND kennung = 'K-2026-0011' AND fassung = 2", Boolean.class, tenant)).isTrue();
    }

    @Test
    void dieEinstellungStehtNurAnEinerFortschreibungMitBegruendung() {
        vorschlag("K-2026-0020", INES);
        PSQLException ohne = psql(() -> alsTue(() -> app.update(freigabe(), tenant, "K-2026-0020", null,
                JONAS.sub(), JONAS.name(), JONAS.rolle(), JONAS.art(), false)));
        assertThat(ohne.getServerErrorMessage().getConstraint()).as(ohne.getMessage())
                .isEqualTo("messreihe_korrektur_vieraugen_chk");
        PSQLException anlage = psql(() -> alsTue(() -> app.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, "
                + "fassung, status, art, reihen, von, bis, begruendung, vorschau, actor_sub, actor_name, actor_rolle, "
                + "actor_art, freigabe_vieraugen) VALUES (?, 'K-2026-0021', 1, 'vorschlag', 'umklassifizierung', ?::jsonb, "
                + "'2026-11-03T13:00:00Z', '2026-11-03T16:45:00Z', 'Richtung war vertauscht', '[{}]', ?, ?, ?, ?, true)",
                tenant, REIHEN, INES.sub(), INES.name(), INES.rolle(), INES.art())));
        assertThat(anlage.getServerErrorMessage().getConstraint()).as(anlage.getMessage())
                .isEqualTo("messreihe_korrektur_vieraugen_chk");
    }

    @Test
    void dieSystemRolleSchreibtDieEinstellungNie() {
        vorschlag("K-2026-0030", INES);
        assertThat(psql(() -> admin.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, "
                + "actor_name, actor_art, freigabe_vieraugen) VALUES (?, 'K-2026-0030', 2, 'freigegeben', 'VoltPilot', "
                + "'voltpilot', false)", tenant)).getSQLState()).isEqualTo("42501");
        assertThat(root.queryForObject("SELECT has_column_privilege(?, 'messreihe_korrektur', 'freigabe_vieraugen', "
                + "'INSERT')", Boolean.class, APP_USER)).isTrue();
        assertThat(root.queryForObject("SELECT has_column_privilege(?, 'messreihe_korrektur', 'freigabe_vieraugen', "
                + "'UPDATE')", Boolean.class, APP_USER)).as("append-only").isFalse();
    }

    /** {@code out-of-order: true}: dieselbe Datei ein zweites Mal auf dem neuesten Stand ändert nichts. */
    @Test
    void dieMigrationLaeuftAuchEinZweitesMal() throws Exception {
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());
        String sql = Files.readString(Path.of("src", "main", "resources", "db", "migration",
                "V" + DIESE + "__uems_vieraugen_freigabe.sql"))
                .replace("${appDbUser}", APP_USER).replace("${adminDbUser}", ADMIN_USER);
        root.execute(sql);
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of()))).isEmpty();
    }

    // ================================================================== Hilfen

    private static void vorschlag(String kennung, ProtokollAkteur wer) {
        root.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, art, reihen, von, bis, "
                + "begruendung, vorschau, actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, 1, 'vorschlag', "
                + "'umklassifizierung', ?::jsonb, '2026-11-03T13:00:00Z', '2026-11-03T16:45:00Z', "
                + "'Richtung der Messstelle war vertauscht', '[{}]', ?, ?, ?, ?)",
                tenant, kennung, REIHEN, wer.sub(), wer.name(), wer.rolle(), wer.art());
    }

    private static String freigabe() {
        return "INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, grund, actor_sub, actor_name, "
                + "actor_rolle, actor_art, freigabe_vieraugen) VALUES (?, ?, 2, 'freigegeben', ?, ?, ?, ?, ?, ?)";
    }

    private static <T> T als(Supplier<T> arbeit) {
        TenantContext.set(tenant);
        try {
            return arbeit.get();
        } finally {
            TenantContext.clear();
        }
    }

    private static int alsTue(Supplier<Integer> arbeit) {
        return als(arbeit);
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
