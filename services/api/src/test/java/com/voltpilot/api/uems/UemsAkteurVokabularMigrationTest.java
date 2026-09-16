package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.voltpilot.api.repo.CommandLogRepository;
import com.voltpilot.api.repo.ConsumerOverrideRepository;
import com.voltpilot.api.repo.DeviceOverrideRepository;
import com.voltpilot.api.repo.RegisterWriteEventRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
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
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * UEMS AP-03 IP-7, {@code V20260916010000}: EIN Akteur-Vokabular in Register-Journal, Handeingriff,
 * Befehls-Verlauf und Änderungsprotokoll.
 *
 * <p>Der Bestand entsteht auf der Fassung DAVOR — mit den Spalten, die es dort gab ({@code akteur_sub}
 * im Ortsprotokoll, {@code created_by} an den Handeingriffen, gar nichts im Befehls-Verlauf). Geprüft wird:
 * <ol>
 *   <li>jede Tabelle außer dem Ortsprotokoll bleibt zeichengleich — die neuen Spalten sind leer;</li>
 *   <li>das Ortsprotokoll behält jede Zeile und bekommt NUR die Art dazu; die Rolle bleibt leer, weil sie
 *       nicht festgehalten wurde (nie geraten);</li>
 *   <li>die alten Einträge bleiben über den Lesecode von HEUTE lesbar;</li>
 *   <li>das Vokabular wird an der Datenbankgrenze erzwungen.</li>
 * </ol>
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsAkteurVokabularMigrationTest {

    private static final String DIESE = "20260916010000";
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
    private static UUID tenant;
    private static UUID site;
    private static UUID device;
    private static UUID verbraucher;
    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;
    private static List<Map<String, Object>> ortVorher;
    private static List<Map<String, Object>> ortNachher;

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();

        tenant = root.queryForObject("INSERT INTO tenant (name) VALUES ('Kunststoffwerk Ahrenberg GmbH') "
                + "RETURNING id", UUID.class);
        site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Halle 1') RETURNING id",
                UUID.class, tenant);
        device = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, "
                + "'ahr-box-1') RETURNING id", UUID.class, tenant, site);
        verbraucher = UUID.randomUUID();

        // 1. Änderungsprotokoll: VoltPilot ohne Person, die Plattform am Umschalter, eine Kundenbenutzerin.
        ortAenderung(null, "VoltPilot");
        ortAenderung("kc-admin", "VoltPilot (admin)");
        ortAenderung("kc-demo", "demo");
        // 2. Register-Journal: ein Vorgang über das Portal und eine Meldung vom Wartungszugang der Box.
        registerZeile("rw-portal", "portal", "kunde", "kc-demo", "demo", "operator");
        registerZeile("rw-box", "geraet", "geraet", "wartungszugang", null, "wartungszugang");
        // 3. Handeingriffe: die Pause der Anlage, ein Verbraucher-Eingriff und ihr Journal.
        root.update("INSERT INTO device_override (tenant_id, site_id, kind, entity_id, ends_at, created_by) "
                + "VALUES (?, ?, 'pause', NULL, ?, 'kc-demo')", tenant, site,
                Timestamp.from(JETZT.plusSeconds(3600)));
        root.update("INSERT INTO consumer_override (entity_id, tenant_id, site_id, kind, target_command, ends_at, "
                + "created_by) VALUES (?, ?, ?, 'start', 'on_off', ?, 'kc-demo')", verbraucher, tenant, site,
                Timestamp.from(JETZT.plusSeconds(3600)));
        root.update("INSERT INTO consumer_audit_event (tenant_id, site_id, entity_id, event_type, actor, detail) "
                + "VALUES (?, ?, NULL, 'automation_paused', 'kc-demo', 'bis morgen')", tenant, site);
        // 4. Befehls-Verlauf: ein abgeleitetes Ereignis (es kannte nie einen Urheber).
        root.update("INSERT INTO device_command_log (tenant_id, site_id, device_id, stream, kind, event_kind, "
                + "started_at, ended_at, last_seen_at, source) VALUES (?, ?, ?, 'ladepunkt', 'ereignis', "
                + "'voll_laden_erteilt', ?, ?, ?, 'cloud_abgeleitet')", tenant, site, device,
                Timestamp.from(JETZT), Timestamp.from(JETZT), Timestamp.from(JETZT));

        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());
        ortVorher = root.queryForList("SELECT id, objekt_art, objekt_id, art, gilt_ab, rueckwirkend, akteur_sub, "
                + "akteur_name FROM ort_aenderung ORDER BY id");

        flyway().target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        ortNachher = root.queryForList("SELECT id, objekt_art, objekt_id, art, gilt_ab, rueckwirkend, actor_sub, "
                + "actor_name, actor_rolle, actor_art FROM ort_aenderung ORDER BY id");

        flyway().load().migrate();
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ============================================================ Bestandsschutz

    @Test
    void jedeTabelleAusserDemOrtsprotokollBleibtZeichengleich() {
        List<String> abweichungen = Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration);
        assertThat(abweichungen).as("nur das Ortsprotokoll ändert sich (Spaltennamen + Art)")
                .allMatch(a -> a.startsWith("ort_aenderung"));
        assertThat(fingerVorher.get("device_override")).isNotEqualTo(Bestandsschutz.LEER);
        assertThat(fingerVorher.get("register_write_event")).isNotEqualTo(Bestandsschutz.LEER);
        assertThat(fingerVorher.get("device_command_log")).isNotEqualTo(Bestandsschutz.LEER);
    }

    @Test
    void dieNeuenSpaltenDerAnderenJournaleSindImBestandLeer() {
        for (String tabelle : List.of("register_write_event", "device_override", "consumer_override",
                "consumer_audit_event", "device_command_log")) {
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE actor_rolle IS NOT NULL "
                    + "OR actor_art IS NOT NULL", Long.class)).as(tabelle).isZero();
        }
        // Der Bestand des Register-Journals behält seine bisherige Herkunft.
        assertThat(root.queryForMap("SELECT origin, actor_name, actor_role FROM register_write_event "
                + "WHERE request_id = 'rw-portal' AND event = 'angefordert'"))
                .containsEntry("origin", "kunde").containsEntry("actor_name", "demo")
                .containsEntry("actor_role", "operator");
    }

    @Test
    void dasOrtsprotokollBehaeltJedeZeileUndBekommtNurDieArt() {
        assertThat(ortNachher).hasSameSizeAs(ortVorher);
        for (int i = 0; i < ortVorher.size(); i++) {
            Map<String, Object> vorher = ortVorher.get(i);
            Map<String, Object> nachher = ortNachher.get(i);
            assertThat(nachher.get("actor_sub")).isEqualTo(vorher.get("akteur_sub"));
            assertThat(nachher.get("actor_name")).isEqualTo(vorher.get("akteur_name"));
            assertThat(nachher.get("art")).isEqualTo(vorher.get("art"));
            assertThat(nachher.get("gilt_ab")).isEqualTo(vorher.get("gilt_ab"));
            assertThat(nachher.get("actor_rolle")).as("die Rolle wurde nicht festgehalten — nie geraten").isNull();
        }
        // Die Art steht nur dort, wo die Zeile sie sagt — für die Kundenbenutzerin wird keine erfunden.
        assertThat(ortNachher.stream().map(z -> z.get("actor_name") + " → " + z.get("actor_art")).toList())
                .containsExactly("VoltPilot → voltpilot", "VoltPilot (admin) → voltpilot", "demo → null");
    }

    // ============================================================ Der Lesecode von heute

    @Test
    void derLesecodeVonHeuteLiestDenAltenBestand() {
        List<OrtAenderungRepository.Eintrag> eintraege = als(tenant,
                () -> new OrtAenderungRepository(app).fuerObjekt("standort", objektDesProtokolls()));
        assertThat(eintraege).hasSize(3);
        assertThat(eintraege).allSatisfy(e -> assertThat(e.actorRolle()).isNull());
        assertThat(eintraege.stream().map(OrtAenderungRepository.Eintrag::actorArt).distinct().toList())
                .containsExactlyInAnyOrder("voltpilot", null);

        List<RegisterWriteEventRepository.Entry> register = als(tenant,
                () -> new RegisterWriteEventRepository(app).recent(site, device, 10));
        assertThat(register).isNotEmpty();
        assertThat(register).allSatisfy(e -> {
            assertThat(e.actorArt()).isNull();
            assertThat(e.actorRolle()).isNull();
        });
        assertThat(register.stream().map(RegisterWriteEventRepository.Entry::actorName).toList())
                .contains("demo");

        List<CommandLogRepository.Row> verlauf = als(tenant, () -> new CommandLogRepository(app).entries(site, null,
                device, JETZT.minusSeconds(3600), JETZT.plusSeconds(3600), 50));
        assertThat(verlauf).isNotEmpty();
        assertThat(verlauf).allSatisfy(r -> assertThat(r.actorArt()).isNull());

        assertThat(als(tenant, () -> new DeviceOverrideRepository(app).activePause(site))).isPresent()
                .hasValueSatisfying(r -> {
                    assertThat(r.createdBy()).isEqualTo("kc-demo");
                    assertThat(r.actorArt()).isNull();
                });
        assertThat(als(tenant, () -> new ConsumerOverrideRepository(app).active(site, verbraucher))).isPresent();
    }

    // ============================================================ Das Vokabular an der Grenze

    @Test
    void dasVokabularWirdAnDerDatenbankgrenzeErzwungen() {
        assertThatThrownBy(() -> ortAenderungMitArt("kc-demo", "demo", "erfunden"))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("ort_aenderung_actor_art_chk");
        assertThatThrownBy(() -> ortAenderungMitArt(null, "demo", "kunde"))
                .as("ohne Subject nur VoltPilot")
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("ort_aenderung_actor_voltpilot_chk");
        assertThatThrownBy(() -> root.update("INSERT INTO consumer_audit_event (tenant_id, site_id, entity_id, "
                + "event_type, actor, actor_sub, actor_art) VALUES (?, ?, NULL, 'automation_paused', 'kc-demo', "
                + "'kc-demo', 'kunde')", tenant, site))
                .as("eine Art ohne Namen ist kein Urheber")
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("consumer_audit_event_actor_chk");
        assertThatThrownBy(() -> root.update("INSERT INTO device_command_log (tenant_id, site_id, device_id, stream, "
                + "kind, started_at, last_seen_at, source, actor_sub, actor_name, actor_art) VALUES (?, ?, ?, "
                + "'batterie', 'periode', ?, ?, 'cloud_abgeleitet', 'kc-demo', 'demo', 'kunde')", tenant, site,
                device, Timestamp.from(JETZT), Timestamp.from(JETZT)))
                .as("eine Periode ist nie ein Handeingriff")
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("device_command_log_actor_chk");
    }

    // ============================================================ Vorrichtung

    private static UUID objektDesProtokolls() {
        return root.queryForObject("SELECT objekt_id FROM ort_aenderung ORDER BY id LIMIT 1", UUID.class);
    }

    private static void ortAenderung(String sub, String name) {
        root.update("INSERT INTO ort_aenderung (tenant_id, objekt_art, objekt_id, art, neu, gilt_ab, rueckwirkend, "
                + "akteur_sub, akteur_name) VALUES (?, 'standort', ?, 'angelegt', ?::jsonb, DATE '2026-11-16', "
                + "false, ?, ?)", tenant, protokollObjekt(), "{\"name\": \"Werk Ahrenberg\"}", sub, name);
    }

    private static void ortAenderungMitArt(String sub, String name, String art) {
        root.update("INSERT INTO ort_aenderung (tenant_id, objekt_art, objekt_id, art, neu, gilt_ab, rueckwirkend, "
                + "actor_sub, actor_name, actor_art) VALUES (?, 'standort', ?, 'angelegt', ?::jsonb, "
                + "DATE '2026-11-16', false, ?, ?, ?)", tenant, protokollObjekt(), "{\"name\": \"Werk\"}", sub, name,
                art);
    }

    /** EIN Objekt für alle Zeilen des Protokolls — der Lesecode fragt nach genau ihm. */
    private static UUID protokollObjekt() {
        if (PROTOKOLL_OBJEKT[0] == null) {
            PROTOKOLL_OBJEKT[0] = UUID.randomUUID();
        }
        return PROTOKOLL_OBJEKT[0];
    }

    private static final UUID[] PROTOKOLL_OBJEKT = new UUID[1];

    private static void registerZeile(String requestId, String source, String origin, String actorSub,
            String actorName, String actorRole) {
        root.update("INSERT INTO register_write_event (request_id, event, source, tenant_id, site_id, device_id, "
                + "device_ref, lane, target_label, register_kind, address, address_input, origin, actor_sub, "
                + "actor_name, actor_role, via_tenant_switcher, requested_at) VALUES (?, 'angefordert', ?, ?, ?, ?, "
                + "'ahr-box-1', 'primaer', 'Halle 1 · Register 40001', 'holding', 40001, '40001', ?, ?, ?, ?, false, "
                + "?)", requestId, source, tenant, site, device, origin, actorSub, actorName, actorRole,
                Timestamp.from(JETZT));
    }

    private static <T> T als(UUID mandant, Supplier<T> arbeit) {
        TenantContext.set(mandant);
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
