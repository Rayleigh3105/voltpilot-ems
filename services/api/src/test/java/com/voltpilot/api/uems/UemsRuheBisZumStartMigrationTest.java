package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.repo.DeviceOverrideRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import java.util.stream.Stream;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * {@code V20260914193000} (UEMS AP-01 IP-4, Regel R0): {@code device_override.ends_at} darf für die
 * Ruhe der Funktion leer sein. <b>Eine Lockerung, kein Umbau</b> — bewiesen wird:
 *
 * <ul>
 *   <li>jede Tabelle bleibt zeichengleich, auch {@code device_override} mit Handeingriffen (die neue
 *       Spalte ist in jeder Bestandszeile leer);
 *   <li>jede Zeile von {@code override-vectors.json} Block {@code zeilen} wird von der Tabelle genau
 *       so angenommen oder mit genau DEM CHECK abgelehnt, den {@link RuheRegel#zeileAbgelehnt} nennt
 *       — insbesondere braucht eine Pause OHNE Herkunft „funktion“ weiter ihr Ende;
 *   <li>ein zweiter Lauf ändert nichts;
 *   <li>der Schreib- und Lesepfad ({@link DeviceOverrideRepository}): die Ruhe liest als lebendig, kein
 *       Handweg verkürzt oder hebt sie auf, kein Ablauf-Filter räumt sie weg, die Erneuerung findet
 *       sie, und der Mandantenzaun hält.
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsRuheBisZumStartMigrationTest {

    private static final String DIESE = "20260914193000";
    private static final String DATEI = "db/migration/V20260914193000__uems_ruhe_bis_zum_start.sql";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final Instant JETZT = Instant.now().truncatedTo(ChronoUnit.SECONDS);

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static JdbcTemplate admin;
    private static UUID tenantA;
    private static UUID tenantB;
    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;
    private static List<Map<String, Object>> eingriffeVorher;
    private static List<Map<String, Object>> eingriffeNachMigration;

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        tenantA = root.queryForObject("INSERT INTO tenant (name) VALUES ('Kunststoffwerk Ahrenberg GmbH') "
                + "RETURNING id", UUID.class);
        tenantB = root.queryForObject("INSERT INTO tenant (name) VALUES ('Kundenbereich B') RETURNING id",
                UUID.class);
        UUID halle1 = anlage(tenantA, "Werk Ahrenberg – Halle 1");
        UUID halle2 = anlage(tenantA, "Werk Ahrenberg – Halle 2");
        UUID fremd = anlage(tenantB, "Werk B");
        // Der Bestand von Steuerung Stufe 4: eine laufende Pause von Hand, ein Speicher-Eingriff, eine
        // abgelaufene Pause (noch nicht weggeräumt) in einem anderen Kundenbereich.
        eingriff(tenantA, halle1, "pause", null, JETZT.plusSeconds(3600), JETZT.minusSeconds(60));
        eingriff(tenantA, halle2, "speicher_halten", UUID.randomUUID(), JETZT.plusSeconds(7200), null);
        eingriff(tenantB, fremd, "pause", null, JETZT.minusSeconds(600), JETZT.minusSeconds(4000));
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());
        eingriffeVorher = eingriffe();

        flyway().target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        eingriffeNachMigration = eingriffe();
        flyway().load().migrate();

        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ============================================================ Bestandsschutz

    @Test
    void jedeTabelleBleibtZeichengleichAuchDieHandeingriffe() {
        assertThat(fingerVorher.get("device_override")).as("Bestand in device_override").isNotEqualTo(Bestandsschutz.LEER);
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
        assertThat(eingriffeNachMigration).hasSize(3);
        for (int i = 0; i < eingriffeVorher.size(); i++) {
            Map<String, Object> nachher = new java.util.LinkedHashMap<>(eingriffeNachMigration.get(i));
            assertThat(nachher.remove("herkunft")).as("die neue Spalte ist im Bestand leer").isNull();
            assertThat(nachher).isEqualTo(eingriffeVorher.get(i));
        }
    }

    @Test
    void derBestandsvergleichBeisst() {
        Bestandsschutz.mutationsprobe(root, List.of(), "device_override",
                "UPDATE device_override SET herkunft = 'funktion', ends_at = NULL WHERE kind = 'pause'");
    }

    @Test
    void einZweiterLaufAendertNichts() throws IOException {
        try (InputStream in = getClass().getClassLoader().getResourceAsStream(DATEI)) {
            assertThat(in).as(DATEI).isNotNull();
            String sql = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            List<Map<String, Object>> vorher = eingriffe();
            List<String> checksVorher = checks();
            root.execute(sql);
            assertThat(eingriffe()).isEqualTo(vorher);
            assertThat(checks()).isEqualTo(checksVorher);
        }
    }

    // ============================================================ die Vektoren gegen die Tabelle

    /**
     * Jede Zeile des Vertrags gegen die ECHTE Tabelle: angenommen genau dann, wenn zulässig, und
     * abgelehnt mit genau dem CHECK, den der Vertrag und {@link RuheRegel} nennen.
     */
    @TestFactory
    Stream<DynamicTest> jedeZeileDerVektorenGegenDieTabelle() throws Exception {
        JsonNode faelle = RuheRegelVectorsTest.vektoren().path("zeilen");
        List<DynamicTest> tests = new ArrayList<>();
        faelle.forEach(f -> tests.add(DynamicTest.dynamicTest(f.path("name").asText(), () -> {
            JsonNode in = f.path("input");
            JsonNode erwartet = f.path("expected");
            UUID site = anlage(tenantA, "Vektor " + f.path("name").asText());
            Instant ende = RuheRegelVectorsTest.zeit(in.path("ends_at"));
            String sql = "INSERT INTO device_override (tenant_id, site_id, kind, entity_id, ends_at, herkunft) "
                    + "VALUES (?, ?, ?, ?, ?, ?)";
            Object[] args = {tenantA, site, in.path("kind").asText(),
                    in.path("mit_komponente").asBoolean() ? UUID.randomUUID() : null,
                    ende == null ? null : Timestamp.from(ende), RuheRegelVectorsTest.text(in.path("herkunft"))};
            if (erwartet.path("zulaessig").asBoolean()) {
                assertThat(root.update(sql, args)).isEqualTo(1);
            } else {
                assertThatThrownBy(() -> root.update(sql, args))
                        .isInstanceOf(DataIntegrityViolationException.class)
                        .hasMessageContaining("\"" + erwartet.path("constraint").asText() + "\"");
            }
            assertThat(RuheRegel.zeileAbgelehnt(in.path("kind").asText(), RuheRegelVectorsTest.text(in.path("herkunft")),
                    ende).map(RuheRegel.Ablehnung::constraint).orElse(null))
                    .as("die reine Regel nennt denselben CHECK").isEqualTo(RuheRegelVectorsTest.text(erwartet.path("constraint")));
            root.update("DELETE FROM device_override WHERE site_id = ?", site);
        })));
        return tests.stream();
    }

    // ============================================================ Schreib- und Lesepfad

    @Test
    void dieRuheLiestAlsLebendigUndKeinHandwegVerkuerztOderHebtSieAuf() {
        UUID site = anlage(tenantA, "Werk Ahrenberg – Halle 3");
        DeviceOverrideRepository repo = new DeviceOverrideRepository(app);

        assertThat(als(tenantA, () -> repo.putRuhe(site, "J. Wendlinger"))).isTrue();
        DeviceOverrideRepository.Row ruhe = als(tenantA, () -> repo.activePause(site)).orElseThrow();
        assertThat(ruhe.ausFunktion()).isTrue();
        assertThat(ruhe.endsAt()).as("bis auf Widerruf").isNull();
        assertThat(ruhe.isPause()).isTrue();
        Map<String, Object> zeile = zeile(site);

        assertThat(als(tenantA, () -> repo.putPause(site, JETZT.plusSeconds(900), "hand")))
                .as("eine Pause von Hand verkürzt die Ruhe nie").isFalse();
        assertThat(als(tenantA, () -> repo.clearPause(site))).as("„fortsetzen“ hebt sie nicht auf").isZero();
        assertThat(als(tenantA, () -> repo.putRuhe(site, "jemand anderes"))).as("zweimal setzen ändert nichts")
                .isFalse();
        assertThat(zeile(site)).isEqualTo(zeile);

        repo.purgeExpired(admin);
        assertThat(zeile(site)).as("kein Ablauf-Filter räumt sie weg").isEqualTo(zeile);
        assertThat(repo.dueForRenewal(admin, JETZT.plusSeconds(86_400)))
                .as("sie ist kein Wunsch, der neu ausgesendet wird").noneMatch(r -> r.siteId().equals(site));
        assertThat(repo.ruheZuErneuern(admin, JETZT)).as("nie gesendet → fällig")
                .anyMatch(r -> r.siteId().equals(site) && r.tenantId().equals(tenantA));
        repo.markRenewed(admin, ruhe.id());
        assertThat(repo.ruheZuErneuern(admin, Instant.now())).as("frisch gesendet → nicht fällig")
                .noneMatch(r -> r.siteId().equals(site));
        assertThat(repo.ruheZuErneuern(admin, Instant.now().plus(RuheRegel.ERNEUERN_NACH).plusSeconds(60)))
                .as("nach drei Stunden wieder fällig").anyMatch(r -> r.siteId().equals(site));

        assertThat(als(tenantA, () -> repo.clearRuhe(site))).isEqualTo(1);
        assertThat(als(tenantA, () -> repo.activePause(site))).isEmpty();
    }

    @Test
    void eineHandpauseWirdZurRuheUndStartenLaesstEineHandpauseStehen() {
        UUID site = anlage(tenantA, "Werk Ahrenberg – Halle 4");
        DeviceOverrideRepository repo = new DeviceOverrideRepository(app);

        assertThat(als(tenantA, () -> repo.putPause(site, JETZT.plusSeconds(3600), "hand"))).isTrue();
        assertThat(als(tenantA, () -> repo.clearRuhe(site))).as("„Steuerung starten“ hebt keine Handpause auf")
                .isZero();
        assertThat(als(tenantA, () -> repo.activePause(site)).orElseThrow().ausFunktion()).isFalse();

        assertThat(als(tenantA, () -> repo.putRuhe(site, "J. Wendlinger"))).as("die Ruhe ersetzt die Handpause")
                .isTrue();
        DeviceOverrideRepository.Row ruhe = als(tenantA, () -> repo.activePause(site)).orElseThrow();
        assertThat(ruhe.ausFunktion()).isTrue();
        assertThat(ruhe.endsAt()).isNull();
        assertThat(ruhe.renewedAt()).as("der nächste Takt sendet sie").isNull();
        assertThat(root.queryForObject("SELECT count(*) FROM device_override WHERE site_id = ?", Long.class, site))
                .as("weiter höchstens EINE Pause je Anlage").isEqualTo(1);
        assertThat(als(tenantA, () -> repo.clearRuhe(site))).isEqualTo(1);
    }

    @Test
    void derMandantenzaunHaelt() {
        UUID site = anlage(tenantA, "Werk Ahrenberg – Halle 5");
        DeviceOverrideRepository repo = new DeviceOverrideRepository(app);
        assertThat(als(tenantA, () -> repo.putRuhe(site, "J. Wendlinger"))).isTrue();

        assertThat(als(tenantB, () -> repo.active(site))).as("ein fremder Kundenbereich sieht sie nicht").isEmpty();
        assertThat(als(tenantB, () -> repo.clearRuhe(site))).as("und hebt sie nicht auf").isZero();
        assertThat(als(tenantA, () -> repo.activePause(site))).isPresent();
        assertThat(als(tenantA, () -> repo.clearRuhe(site))).isEqualTo(1);
    }

    // ============================================================ Gerüst

    private static UUID anlage(UUID tenant, String name) {
        return root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, ?) RETURNING id", UUID.class,
                tenant, name);
    }

    private static void eingriff(UUID tenant, UUID site, String kind, UUID entity, Instant ende, Instant erneuert) {
        root.update("INSERT INTO device_override (tenant_id, site_id, kind, entity_id, ends_at, renewed_at, "
                + "created_by) VALUES (?, ?, ?, ?, ?, ?, 'demo')", tenant, site, kind, entity, Timestamp.from(ende),
                erneuert == null ? null : Timestamp.from(erneuert));
    }

    /** Jede Zeile von device_override mit allen Spalten, nach Kennung. */
    private static List<Map<String, Object>> eingriffe() {
        return root.queryForList("SELECT * FROM device_override ORDER BY id");
    }

    private static Map<String, Object> zeile(UUID site) {
        return root.queryForMap("SELECT * FROM device_override WHERE site_id = ?", site);
    }

    private static List<String> checks() {
        return root.queryForList("SELECT conname || ' ' || pg_get_constraintdef(oid) FROM pg_constraint "
                + "WHERE conrelid = 'device_override'::regclass ORDER BY conname", String.class);
    }

    private static <T> T als(UUID tenant, Supplier<T> arbeit) {
        TenantContext.set(tenant);
        try {
            return arbeit.get();
        } finally {
            TenantContext.clear();
        }
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
