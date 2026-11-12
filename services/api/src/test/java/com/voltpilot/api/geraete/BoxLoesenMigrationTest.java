package com.voltpilot.api.geraete;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.geraete.BoxLoesenRegel.BoxBefund;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
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
 * „Vom Kunden lösen" (L1, V20261110090000) gegen echtes TimescaleDB: die Tabelle und ihr
 * Mandantenzaun, {@code DeviceRepository#loesen} löscht die Zeile ganz und macht die Kennung frei,
 * die DB-Rückversicherung (ON DELETE RESTRICT, V20260913150000) lehnt ab, wenn doch Messwerte da
 * sind, {@code BoxLoesenRepository#hinweiseJeAnlage} (B3) und die Vollständigkeit der Einordnung
 * jeder Tabelle mit {@code device_id} ({@link #jedeTabelleMitDeviceIdIstEingeordnet}).
 */
@Testcontainers(disabledWithoutDocker = true)
class BoxLoesenMigrationTest {

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
    private static JdbcTemplate app;
    private static JdbcTemplate admin;

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
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    private record Werk(UUID tenant, UUID site, UUID box, String ref) {
    }

    // ============================================================ Tabelle, Zaun, Rechte

    @Test
    void dieTabelleHatIhrenMandantenzaunUndIhreRechte() {
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'box_loesen_protokoll'", Boolean.class)).isTrue();
        assertThat(root.queryForObject("SELECT has_table_privilege(?, 'box_loesen_protokoll', 'INSERT')",
                Boolean.class, APP_USER)).isTrue();
        assertThat(root.queryForObject("SELECT has_table_privilege(?, 'box_loesen_protokoll', 'DELETE')",
                Boolean.class, APP_USER)).as("append-only für die App-Rolle").isFalse();
        assertThat(root.queryForObject("SELECT has_table_privilege(?, 'box_loesen_protokoll', 'DELETE')",
                Boolean.class, ADMIN_USER)).as("Offboarding räumt über die Admin-Rolle ab").isTrue();
        assertThat(root.queryForObject("SELECT has_column_privilege(?, 'device', 'verbunden_von_name', 'UPDATE')",
                Boolean.class, APP_USER)).isTrue();
    }

    @Test
    void einAnderesMandantSiehtDasProtokollNicht() {
        Werk a = werk("Kunststoffwerk Ahrenberg GmbH", "VP-BOX-LOESEN-A");
        Werk b = werk("Kundenbereich B", "VP-BOX-LOESEN-B");
        protokollEintrag(a, "falsche_kennung", null);
        assertThat(als(a.tenant(), () -> app.queryForObject(
                "SELECT count(*) FROM box_loesen_protokoll WHERE device_id = ?", Long.class, a.box())))
                .isOne();
        assertThat(als(b.tenant(), () -> app.queryForObject(
                "SELECT count(*) FROM box_loesen_protokoll WHERE device_id = ?", Long.class, a.box())))
                .as("Mandantenzaun").isZero();
        assertThat(admin.queryForObject("SELECT count(*) FROM box_loesen_protokoll WHERE device_id = ?",
                Long.class, a.box())).as("Admin liest über jeden Mandanten").isOne();
    }

    // ============================================================ DeviceRepository.loesen

    @Test
    void loesenLoeschtDieZeileGanzUndMachtDieKennungFrei() {
        Werk w = werk("Löschen", "VP-BOX-LOESEN-GANZ");
        DeviceRepository devices = new DeviceRepository(app);
        assertThat(als(w.tenant(), () -> devices.loesen(w.box()))).isTrue();
        assertThat(root.queryForObject("SELECT count(*) FROM device WHERE id = ?", Long.class, w.box()))
                .as("keine Zeile bleibt - anders als ausbauen").isZero();
        // Die Kennung ist sofort wieder anmeldbar, wie vor dem Verbinden.
        UUID neu = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, ?, 'claimed') RETURNING id", UUID.class, w.tenant(), w.site(), w.ref());
        assertThat(neu).isNotEqualTo(w.box());
    }

    @Test
    void loesenUeberEinenFremdenMandantenTrifftNichts() {
        Werk a = werk("Fremdzugriff A", "VP-BOX-LOESEN-FREMD-A");
        Werk b = werk("Fremdzugriff B", "VP-BOX-LOESEN-FREMD-B");
        DeviceRepository devices = new DeviceRepository(app);
        assertThat(als(b.tenant(), () -> devices.loesen(a.box()))).as("RLS verbirgt die fremde Box").isFalse();
        assertThat(root.queryForObject("SELECT count(*) FROM device WHERE id = ?", Long.class, a.box())).isOne();
    }

    /**
     * {@code telemetry}/{@code telemetry_v2} tragen BEWUSST keinen Fremdschlüssel auf {@code device}
     * (V20260913150000-Kommentar) - ihre Rückversicherung ist die ANWENDUNG
     * ({@code BoxLoesenRegel.messwertAm}, der Dienst löscht nie, wenn sie etwas finden).
     * {@code device_measurement_sample} dagegen trägt {@code ON DELETE RESTRICT}: genau DAS ist die
     * DB-Rückversicherung, die {@link BoxLoesenRegel} selbst nicht braucht, um richtig zu sein.
     */
    @Test
    void dieDbRueckversicherungLehntAbWennDochZusatzMesswerteDaSind() {
        Werk w = werk("Rückversicherung", "VP-BOX-LOESEN-RESTRICT");
        root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, "
                + "point_key, raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, "
                + "aggregation_kind, gap, dropped_samples) VALUES (now(), now(), ?, ?, ?, 'sunspec.model_203.w', "
                + "1000, 100.0, 'good', '2026.09.11.1', 1, 'counter', false, 0)", w.tenant(), w.site(), w.box());
        DeviceRepository devices = new DeviceRepository(app);
        PSQLException p = psql(() -> als(w.tenant(), () -> devices.loesen(w.box())));
        assertThat(p.getSQLState()).isEqualTo("23503");
        assertThat(root.queryForObject("SELECT count(*) FROM device WHERE id = ?", Long.class, w.box()))
                .as("nichts geändert").isOne();
    }

    @Test
    void telemetryHatKeinenFremdschluesselDieAnwendungMussSieSelbstPruefen() {
        Werk w = werk("Telemetrie ohne FK", "VP-BOX-LOESEN-TELEMETRY-FK");
        root.update("INSERT INTO telemetry (time, tenant_id, site_id, device_id, pv_power_kw) "
                + "VALUES (now(), ?, ?, ?, 1.5)", w.tenant(), w.site(), w.box());
        DeviceRepository devices = new DeviceRepository(app);
        // Die DB allein ließe das Löschen durch - genau deshalb prüft BoxLoesenRegel.messwertAm
        // telemetry/telemetry_v2 SELBST, bevor BoxLoesenService devices.loesen() überhaupt ruft.
        assertThat(als(w.tenant(), () -> devices.loesen(w.box()))).isTrue();
        BoxLoesenRepository repo = new BoxLoesenRepository(app, new ObjectMapper());
        Werk w2 = werk("Telemetrie blockiert die Regel", "VP-BOX-LOESEN-TELEMETRY-REGEL");
        root.update("INSERT INTO telemetry (time, tenant_id, site_id, device_id, pv_power_kw) "
                + "VALUES (now(), ?, ?, ?, 1.5)", w2.tenant(), w2.site(), w2.box());
        BoxBefund befund = als(w2.tenant(), () -> repo.befundUnterSperre(w2.box()));
        assertThat(BoxLoesenRegel.gruende(befund, true)).containsExactly("messwerte");
    }

    // ============================================================ BoxLoesenRepository

    @Test
    void befundUnterSperreMeldetAktivFalseWennDieBoxWeistIst() {
        BoxLoesenRepository repo = new BoxLoesenRepository(app, new ObjectMapper());
        Werk w = werk("Befund", "VP-BOX-LOESEN-BEFUND");
        BoxBefund vorher = als(w.tenant(), () -> repo.befundUnterSperre(w.box()));
        assertThat(vorher.aktiv()).isTrue();
        assertThat(vorher.herzschlagAm()).isNull();
        root.update("DELETE FROM device WHERE id = ?", w.box());
        BoxBefund nachher = als(w.tenant(), () -> repo.befundUnterSperre(w.box()));
        assertThat(nachher.aktiv()).isFalse();
        assertThat(BoxLoesenRegel.gruende(nachher, true)).containsExactly("verbund");
    }

    @Test
    void hinweiseJeAnlageZeigenNurOhneAktiveBoxUndInnerhalbVonVierzehnTagen() {
        BoxLoesenRepository repo = new BoxLoesenRepository(app, new ObjectMapper());
        Werk frisch = werk("Hinweis frisch", "VP-BOX-LOESEN-HINWEIS-A");
        Werk alt = werk("Hinweis alt", "VP-BOX-LOESEN-HINWEIS-B");
        Werk wiederVerbunden = werk("Hinweis erledigt", "VP-BOX-LOESEN-HINWEIS-C");
        root.update("DELETE FROM device WHERE id = ?", frisch.box());
        protokollZeile(frisch, "falsche_kennung", null, Instant.now().minus(java.time.Duration.ofDays(2)));
        root.update("DELETE FROM device WHERE id = ?", alt.box());
        protokollZeile(alt, "fremder_kunde", null, Instant.now().minus(java.time.Duration.ofDays(20)));
        root.update("DELETE FROM device WHERE id = ?", wiederVerbunden.box());
        protokollZeile(wiederVerbunden, "doppelt_verbunden", null, Instant.now().minus(java.time.Duration.ofDays(1)));
        root.update("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, 'claimed')",
                wiederVerbunden.tenant(), wiederVerbunden.site(), "VP-BOX-LOESEN-HINWEIS-C-NEU");

        Map<UUID, BoxLoesenRepository.Hinweis> hinweise = als(frisch.tenant(), repo::hinweiseJeAnlage);
        assertThat(hinweise).containsKey(frisch.site());
        assertThat(hinweise.get(frisch.site()).anlass()).isEqualTo("falsche_kennung");

        assertThat(als(alt.tenant(), repo::hinweiseJeAnlage)).as("älter als 14 Tage").doesNotContainKey(alt.site());
        assertThat(als(wiederVerbunden.tenant(), repo::hinweiseJeAnlage))
                .as("wieder eine Box verbunden").doesNotContainKey(wiederVerbunden.site());
    }

    // ============================================================ Vollständigkeit (Tabellen-Inventar)

    /**
     * Jede Tabelle mit einer Spalte {@code device_id} im TATSÄCHLICHEN Schema ist entweder durch
     * {@code ON DELETE RESTRICT} auf {@code device} geschützt (die DB lehnt {@code DeviceRepository
     * #loesen} selbst ab, wenn sie eine Zeile trägt) oder ausdrücklich als Cloud-Zustand/Topologie
     * eingeordnet ({@link #CLOUD_ZUSTAND_ODER_TOPOLOGIE}, mit Grund). Eine neue Tabelle mit
     * {@code device_id} ohne eine der beiden fällt hier auf - BEVOR sie zur Lücke wird.
     */
    private static final String SPIEGEL = "Cloud-Spiegel einer Meldung der Box - ohne jede Meldung "
            + "(kein Herzschlag, geprüft von BoxLoesenRegel) keine Zeile; nie der Erst-Nachweis selbst.";
    private static final String ABSICHT = "Server-/Cloud-authored Absicht oder Auftrag AN die Box (Plan, "
            + "Zuweisung, Suche) - entsteht ohne jede Rückmeldung der Box, wird mit ihr hinfällig.";
    private static final String VERDICHTUNG = "Verdichtung/Ableitung, laut V20260913150000 bewusst ohne "
            + "Verweis auf Löschbares - kein Rohwert, neu berechenbar.";

    private static final Map<String, String> CLOUD_ZUSTAND_ODER_TOPOLOGIE = Map.ofEntries(
            Map.entry("measurement_point", "Topologie: ON DELETE SET NULL, DeviceRepository.ausDerTopologieLoesen"),
            Map.entry("asset", "Topologie: ON DELETE SET NULL, DeviceRepository.ausDerTopologieLoesen"),
            Map.entry("entity_registry_state", "Topologie: ON DELETE SET NULL, ausDerTopologieLoesen"),
            Map.entry("data_source_assignment", "Zuständigkeit: BoxLoesenRegel.hatZustaendigkeiten blockiert vorher"),
            Map.entry("device_measurement_selection", "Einstellung, kein Wert: ON DELETE CASCADE von device"),
            Map.entry("device_measurement_selection_event", "Historie der Einstellung, FK auf die Auswahl"),
            Map.entry("device_edge_version", "Software-Meldung: BoxLoesenRegel.meldungAm blockiert vorher"),
            Map.entry("device_update_status", "Software-Meldung: BoxLoesenRegel.meldungAm blockiert vorher"),
            Map.entry("box_update_verlauf", "OTA-Verlauf der Box, kein Messwert - Cloud-Zustand"),
            // Eigenes Protokoll - entsteht GENAU beim Löschen, kein FK (lebt per Definition darüber hinaus).
            Map.entry("box_loesen_protokoll", "Das eigene Audit-Protokoll von L1 selbst, kein device_id-FK."),
            Map.entry("box_endgueltig_geloescht_protokoll", "Audit-Protokoll des vierten Löschwegs "
                    + "(vp-box-endgueltig-loeschen), kein device_id-FK - nur AUSGEBAUTE Boxen, "
                    + "die Lösen (ausgebaut_am IS NULL) nie trifft."),
            Map.entry("box_ausbauen_protokoll", "Audit-Protokoll von Box ausbauen ohne Mandantensprung "
                    + "(vp-admin-box-ausbauen), kein device_id-FK - die Box bleibt (ausgebaut), Lösen "
                    + "(ausgebaut_am IS NULL) trifft sie danach nie mehr."),
            // v1/v2-Telemetrie tragen BEWUSST keinen Fremdschlüssel (V20260913150000) - die ANWENDUNG ist
            // hier die Rückversicherung, nicht die Datenbank: BoxLoesenRegel.messwertAm prüft beide direkt.
            Map.entry("telemetry", "Kein FK (V20260913150000) - BoxLoesenRegel.messwertAm prüft sie direkt."),
            Map.entry("telemetry_v2", "Kein FK (V20260913150000) - BoxLoesenRegel.messwertAm prüft sie direkt."),
            // Cloud-Spiegel einer Box-Meldung (SPIEGEL): ohne Herzschlag nie geschrieben.
            Map.entry("consumer_runtime_status", SPIEGEL), Map.entry("device_battery_control", SPIEGEL),
            Map.entry("device_charge_connector", SPIEGEL), Map.entry("device_charge_point", SPIEGEL),
            Map.entry("device_charging_budget", SPIEGEL), Map.entry("device_command_log", SPIEGEL),
            Map.entry("device_control_activation", SPIEGEL), Map.entry("device_control_status", SPIEGEL),
            Map.entry("device_curtailment_status", SPIEGEL), Map.entry("device_curtailment_unit", SPIEGEL),
            Map.entry("device_data_source_status", SPIEGEL), Map.entry("device_source_status", SPIEGEL),
            Map.entry("entity_observed_state", SPIEGEL), Map.entry("flow_device_ack", SPIEGEL),
            Map.entry("flow_node_status", SPIEGEL), Map.entry("wechselrichter_untergrenze", SPIEGEL),
            Map.entry("steuerungsverbund_mitglied", SPIEGEL), Map.entry("steuerungsverbund_geraet", SPIEGEL),
            Map.entry("steuerungsverbund_anteil_verlust", SPIEGEL),
            Map.entry("steuerungsverbund_sprungprobe", SPIEGEL),
            Map.entry("data_source_box_receipt", SPIEGEL), Map.entry("device_component_apply", SPIEGEL),
            // OCPP: jede dieser Zeilen setzt eine laufende Ladesäulen-Sitzung voraus, also Meldungen der
            // Box - derselbe Grund wie SPIEGEL, hier einzeln benannt (Report Abschnitt 3.1 "OCPP ocpp_*").
            Map.entry("ocpp_station", SPIEGEL), Map.entry("ocpp_connector_state", SPIEGEL),
            Map.entry("ocpp_protocol_event", SPIEGEL), Map.entry("ocpp_connector_status_event", SPIEGEL),
            Map.entry("ocpp_authorization_event", SPIEGEL), Map.entry("ocpp_transaction", SPIEGEL),
            Map.entry("ocpp_meter_sample", SPIEGEL), Map.entry("ocpp_station_status_event", SPIEGEL),
            Map.entry("ocpp_configuration_key", SPIEGEL), Map.entry("ocpp_configuration_unknown_key", SPIEGEL),
            Map.entry("ocpp_station_capability", SPIEGEL), Map.entry("ocpp_action", SPIEGEL),
            Map.entry("ocpp_action_intent", ABSICHT), Map.entry("ocpp_action_audit", SPIEGEL),
            // MiSpeL MP-38: der signierte Zählerstand kommt als Journal-Ereignis einer laufenden Ladesäulen-Sitzung.
            Map.entry("ladepunkt_signierter_messwert", SPIEGEL),
            // Cloud-/Server-authored Absicht AN die Box (ABSICHT): entsteht ohne jede Rückmeldung.
            Map.entry("schedule", ABSICHT), Map.entry("rollout_device", ABSICHT),
            Map.entry("rollout_event", ABSICHT), Map.entry("device_update_target", ABSICHT),
            Map.entry("register_write_event", ABSICHT), Map.entry("plan_zustellung", ABSICHT),
            Map.entry("move_provisioning_operation", ABSICHT), Map.entry("geraetesuche", ABSICHT),
            Map.entry("geraetesuche_protokoll", ABSICHT), Map.entry("data_source_aenderung", ABSICHT),
            // Administrativ, nicht Box-Daten; device_site_assignment ohnehin ON DELETE CASCADE von device.
            Map.entry("device_site_assignment", "Verschiebe-Historie, ON DELETE CASCADE von device - Snapshot, "
                    + "kein Messwert."),
            // Enrollment überlebt eine Lösung ABSICHTLICH (derselbe Schlüssel bei erneutem Verbinden derselben
            // Referenz; BoxLoesenRegel prüft schluesselAbgeholtAm selbst darüber, blockiert aber nicht die DB).
            Map.entry("device_enrollment", "Überlebt absichtlich (Schlüssel-Historie der Referenz); "
                    + "BoxLoesenRegel.schluesselAbgeholtAm liest sie, blockiert aber nur auf dem Kunden-Weg."),
            // Verdichtungen/Ableitungen, laut Migrationskommentar bewusst ohne Verweis auf Löschbares.
            Map.entry("device_measurement_rollup_5m", VERDICHTUNG),
            Map.entry("device_measurement_rollup_15m", VERDICHTUNG),
            Map.entry("messreihe_ereignis", VERDICHTUNG), Map.entry("messreihe_luecke_stand", VERDICHTUNG));

    @Test
    void jedeTabelleMitDeviceIdIstEingeordnet() {
        List<String> tabellen = root.queryForList(
                "SELECT DISTINCT table_name FROM information_schema.columns "
                        + "WHERE table_schema = 'public' AND column_name = 'device_id' ORDER BY 1",
                String.class);
        assertThat(tabellen).as("Tabellen mit device_id im Schema").isNotEmpty();

        Set<String> restrict = Set.copyOf(root.queryForList(
                "SELECT DISTINCT conrelid::regclass::text FROM pg_constraint "
                        + "WHERE contype = 'f' AND confrelid = 'device'::regclass AND confdeltype = 'r'",
                String.class));

        List<String> unbekannt = tabellen.stream()
                .filter(t -> !restrict.contains(t) && !CLOUD_ZUSTAND_ODER_TOPOLOGIE.containsKey(t))
                .toList();
        assertThat(unbekannt).as("Tabellen mit device_id, weder RESTRICT-geschützt noch eingeordnet").isEmpty();
    }

    // ============================================================ Gerüst

    private static Werk werk(String name, String ref) {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Zuhause') RETURNING id",
                UUID.class, t);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, ?, 'claimed') RETURNING id", UUID.class, t, site, ref);
        return new Werk(t, site, box, ref);
    }

    private static void protokollEintrag(Werk w, String anlass, String anlassText) {
        protokollZeile(w, anlass, anlassText, Instant.now());
    }

    private static void protokollZeile(Werk w, String anlass, String anlassText, Instant geloestAm) {
        root.update("INSERT INTO box_loesen_protokoll (tenant_id, site_id, site_name, device_id, external_ref, "
                        + "verbunden_am, geloest_am, geloest_von_name, geloest_art, anlass, anlass_text, befund) "
                        + "VALUES (?, ?, 'Zuhause', ?, ?, now(), ?, 'Moritz V.', 'plattform', ?, ?, '{}'::jsonb)",
                w.tenant(), w.site(), w.box(), w.ref(), Timestamp.from(geloestAm), anlass, anlassText);
    }

    private static <T> T als(UUID tenant, Supplier<T> arbeit) {
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
            if (c instanceof PSQLException pe) {
                return pe;
            }
        }
        throw new AssertionError("keine PSQLException in " + t, t);
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
