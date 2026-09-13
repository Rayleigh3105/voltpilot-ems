package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.CommandLogRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
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
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * {@code V20260913200000}: die offenen Perioden des Befehlsverlaufs einer Box, die nicht mehr am
 * Betrieb teilnimmt, werden BEENDET — und beim Ausbau selbst ab jetzt ebenso
 * ({@link CommandLogRepository#beimAusbauBeenden}). Ein bestehender Mangel (Nr. 19 der Liste aus
 * AP-07 IP-11): {@code device_command_log} hat keinen Fremdschlüssel auf die Box, und eine offene
 * Periode schließt nur der nächste Herzschlag derselben Box — nach dem Abmelden kommt keiner mehr.
 *
 * <p>Bewiesen wird: der Bestand jeder anderen Tabelle ist zeichengleich; im Befehlsverlauf ändert
 * sich GENAU {@code ended_at} der offenen Perioden einer ausgebauten oder gelöschten Box, auf ihren
 * letzten Beleg — keine Zeile fehlt, keine andere Spalte und keine andere Zeile ändert sich; ein
 * zweiter Lauf ändert nichts; der Schreibweg beim Ausbau hält den Mandantenzaun.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsBefehlsverlaufAusbauMigrationTest {

    private static final String DIESE = "20260913200000";
    private static final String DATEI = "db/migration/V20260913200000__uems_befehlsverlauf_ausgebaute_box.sql";
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
    private static Werk a;
    private static Werk b;
    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;
    private static Map<Long, Map<String, Object>> verlaufVorher;
    private static Map<Long, Map<String, Object>> verlaufNachMigration;

    /** Ein Kundenbereich mit einer laufenden Box, einer ausgebauten und einer vor IP-11 gelöschten. */
    private record Werk(UUID tenant, UUID site, UUID aktiv, UUID ausgebaut, UUID geloescht, Map<String, Long> perioden) {}

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        a = werk("Kunststoffwerk Ahrenberg GmbH", "VP-BOX-2026-0482");
        b = werk("Kundenbereich B", "VP-BOX-2026-0503");
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of("device_command_log"));
        verlaufVorher = verlauf();

        flyway().target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of("device_command_log"));
        verlaufNachMigration = verlauf();
        flyway().load().migrate();

        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ============================================================ Bestandsschutz

    @Test
    void jedeAndereTabelleBleibtZeichengleich() {
        for (String tabelle : List.of("device", "site", "tenant")) {
            assertThat(fingerVorher.get(tabelle)).as("Bestand in " + tabelle).isNotEqualTo(Bestandsschutz.LEER);
        }
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
    }

    @Test
    void imBefehlsverlaufEndenGenauDieOffenenPeriodenOhneAktiveBoxAnIhremLetztenBeleg() {
        assertThat(verlaufNachMigration.keySet()).as("keine Zeile fehlt, keine kommt hinzu")
                .isEqualTo(verlaufVorher.keySet());
        Set<Long> beendet = Set.of(a.perioden().get("ausgebaut_offen"), a.perioden().get("ausgebaut_offen_verbraucher"),
                a.perioden().get("geloescht_offen"), b.perioden().get("ausgebaut_offen"),
                b.perioden().get("ausgebaut_offen_verbraucher"), b.perioden().get("geloescht_offen"));
        verlaufVorher.forEach((id, vorher) -> {
            Map<String, Object> nachher = verlaufNachMigration.get(id);
            if (beendet.contains(id)) {
                assertThat(vorher.get("ended_at")).as("vorher offen: " + id).isNull();
                assertThat(nachher.get("ended_at")).as("beendet am letzten Beleg: " + id)
                        .isEqualTo(vorher.get("last_seen_at"));
                Map<String, Object> ohneEnde = new LinkedHashMap<>(nachher);
                ohneEnde.put("ended_at", null);
                assertThat(ohneEnde).as("sonst unverändert: " + id).isEqualTo(vorher);
            } else {
                assertThat(nachher).as("unverändert: " + id).isEqualTo(vorher);
            }
        });
        assertThat(verlaufNachMigration.get(a.perioden().get("aktiv_offen")).get("ended_at"))
                .as("die laufende Box läuft weiter").isNull();
    }

    @Test
    void derBestandsvergleichBeisst() {
        Bestandsschutz.mutationsprobe(root, List.of(), "device_command_log",
                "UPDATE device_command_log SET ended_at = last_seen_at WHERE ended_at IS NULL");
    }

    @Test
    void einZweiterLaufAendertNichts() throws IOException {
        try (InputStream in = getClass().getClassLoader().getResourceAsStream(DATEI)) {
            assertThat(in).as(DATEI).isNotNull();
            String sql = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            Map<Long, Map<String, Object>> vorher = verlauf();
            assertThat(root.update(sql)).isZero();
            assertThat(verlauf()).isEqualTo(vorher);
        }
    }

    // ============================================================ der Schreibweg beim Ausbau

    @Test
    void derAusbauBeendetDieOffenenPeriodenSeinerBoxUndHaeltDenZaun() {
        long waechter = periode(a, a.aktiv(), "waechter", null, JETZT.minusSeconds(900), null, JETZT.minusSeconds(45));
        long fremd = periode(b, b.aktiv(), "waechter", null, JETZT.minusSeconds(900), null, JETZT.minusSeconds(45));

        assertThat(als(b.tenant(), () -> new CommandLogRepository(app).beimAusbauBeenden(a.aktiv())))
                .as("Mandantenzaun").isZero();
        assertThat(ende(waechter)).isNull();

        assertThat(als(a.tenant(), () -> new CommandLogRepository(app).beimAusbauBeenden(a.aktiv())))
                .as("batterie + waechter").isEqualTo(2);
        assertThat(ende(waechter)).isEqualTo(JETZT.minusSeconds(45));
        assertThat(ende(a.perioden().get("aktiv_offen"))).isEqualTo(JETZT.minusSeconds(120));
        assertThat(ende(a.perioden().get("aktiv_zu"))).as("eine beendete Periode behält ihr Ende")
                .isEqualTo(JETZT.minusSeconds(2400));
        assertThat(ende(fremd)).as("die Box eines anderen Kundenbereichs läuft weiter").isNull();
        assertThat(root.queryForObject("SELECT count(*) FROM device_command_log WHERE device_id = ?", Long.class,
                a.aktiv())).as("nichts gelöscht").isEqualTo(3);
        assertThat(als(a.tenant(), () -> new CommandLogRepository(app).beimAusbauBeenden(a.aktiv()))).isZero();
    }

    // ============================================================ Gerüst

    private static Werk werk(String name, String ref) {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Werk') RETURNING id",
                UUID.class, t);
        UUID aktiv = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, ?, 'claimed') RETURNING id", UUID.class, t, site, ref);
        UUID ausgebaut = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status, ausgebaut_am) "
                + "VALUES (?, ?, ?, 'ausgebaut', ?) RETURNING id", UUID.class, t, site, ref,
                Timestamp.from(JETZT.minusSeconds(3600)));
        UUID geloescht = UUID.randomUUID();
        Map<String, Long> p = new LinkedHashMap<>();
        Werk w = new Werk(t, site, aktiv, ausgebaut, geloescht, p);
        p.put("aktiv_offen", periode(w, aktiv, "batterie", null, JETZT.minusSeconds(1800), null, JETZT.minusSeconds(120)));
        p.put("aktiv_zu", periode(w, aktiv, "abregelung", null, JETZT.minusSeconds(3000), JETZT.minusSeconds(2400),
                JETZT.minusSeconds(2400)));
        p.put("ausgebaut_offen", periode(w, ausgebaut, "batterie", null, JETZT.minusSeconds(7200), null,
                JETZT.minusSeconds(3700)));
        p.put("ausgebaut_offen_verbraucher", periode(w, ausgebaut, "verbraucher", UUID.randomUUID(),
                JETZT.minusSeconds(7000), null, JETZT.minusSeconds(3650)));
        p.put("ausgebaut_zu", periode(w, ausgebaut, "abregelung", null, JETZT.minusSeconds(9000),
                JETZT.minusSeconds(8000), JETZT.minusSeconds(8000)));
        p.put("ausgebaut_ereignis", root.queryForObject("INSERT INTO device_command_log (tenant_id, site_id, device_id, "
                + "stream, kind, event_kind, started_at, ended_at, last_seen_at, source) VALUES (?, ?, ?, 'batterie', "
                + "'ereignis', 'gestoppt', ?, ?, ?, 'cloud_abgeleitet') RETURNING id", Long.class, t, site, ausgebaut,
                Timestamp.from(JETZT.minusSeconds(3700)), Timestamp.from(JETZT.minusSeconds(3700)),
                Timestamp.from(JETZT.minusSeconds(3700))));
        p.put("geloescht_offen", periode(w, geloescht, "batterie", null, JETZT.minusSeconds(86_400), null,
                JETZT.minusSeconds(80_000)));
        return w;
    }

    private static long periode(Werk w, UUID box, String strom, UUID komponente, Instant beginn, Instant ende,
            Instant zuletzt) {
        return root.queryForObject("INSERT INTO device_command_log (tenant_id, site_id, device_id, entity_id, stream, "
                + "kind, started_at, ended_at, last_seen_at, mode, commanded_kw_first, source) VALUES (?, ?, ?, ?, ?, "
                + "'periode', ?, ?, ?, 'halten', -4.0, 'cloud_abgeleitet') RETURNING id", Long.class, w.tenant(), w.site(),
                box, komponente, strom, Timestamp.from(beginn), ende == null ? null : Timestamp.from(ende),
                Timestamp.from(zuletzt));
    }

    /** Jede Zeile des Befehlsverlaufs mit allen Spalten, nach Kennung. */
    private static Map<Long, Map<String, Object>> verlauf() {
        Map<Long, Map<String, Object>> aus = new LinkedHashMap<>();
        root.queryForList("SELECT * FROM device_command_log ORDER BY id").forEach(z -> {
            Map<String, Object> zeile = new LinkedHashMap<>(z);
            aus.put(((Number) zeile.get("id")).longValue(), zeile);
        });
        return aus;
    }

    private static Instant ende(long periode) {
        Timestamp t = root.queryForObject("SELECT ended_at FROM device_command_log WHERE id = ?", Timestamp.class,
                periode);
        return t == null ? null : t.toInstant();
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
