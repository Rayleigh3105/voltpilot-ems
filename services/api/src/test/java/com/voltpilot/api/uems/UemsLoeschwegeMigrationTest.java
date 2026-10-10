package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.sql.Timestamp;
import java.time.Duration;
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
import org.postgresql.util.PSQLException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Migration {@code V20260913150000__uems_loeschwege.sql} (UEMS AP-07 IP-11, E8, AP-06 E7): die
 * Verweise der Messwert-Tabellen auf Box und Anlage lehnen ein Löschen ab, statt durchzuschlagen;
 * die Box wird ausgebaut statt gelöscht; die Aufkleber-Kennung ist nur unter den nicht ausgebauten
 * Boxen eindeutig; das Entfernen einer Anlage räumt ihre Messwerte nur OHNE Belege ab — die Prüfung
 * steht in der Datenbank.
 *
 * <p>Der Bestand (zwei Kundenbereiche mit Box, Komponente, Auswahl samt Historie, Rohwerten,
 * Ereignis und letztem Stand) wird VOR der Migration geschrieben; {@link Bestandsschutz} beweist,
 * dass sie keine Zeile anfasst.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsLoeschwegeMigrationTest {

    private static final String DIESE = "20260913150000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final String KATALOG = "2026.09.11.1";
    private static final String KANAL = "sunspec.model_203.totwhimp";

    /** Die Verweise, deren Lösch-Regel die Migration von CASCADE auf RESTRICT stellt. */
    private static final List<String> RESTRICT = List.of(
            "device_measurement_sample_device_tenant_fk", "device_measurement_sample_site_tenant_fk",
            "device_measurement_event_device_tenant_fk", "device_measurement_event_site_tenant_fk",
            "device_measurement_point_state_device_tenant_fk", "device_measurement_point_state_site_tenant_fk",
            "device_measurement_selection_event_device_tenant_fk",
            "device_measurement_selection_event_site_tenant_fk", "device_measurement_selection_device_fk");

    /** AP-09: neuer Quellenverweis der komponentenlosen Ablesung, keine Änderung eines Bestands-FK. */
    private static final String ABLESUNG_QUELLE_FK = "device_measurement_sample_ablesung_quelle_fk";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static JdbcTemplate admin;
    private static Werk a;
    private static Werk b;
    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;

    /** Ein Kundenbereich mit einer Anlage, einer Box und einer Komponente, deren Kanal die Box liest. */
    private record Werk(UUID tenant, UUID site, UUID box, UUID komponente, String ref) {}

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        a = werk("Kunststoffwerk Ahrenberg GmbH", "VP-BOX-2026-0482");
        b = werk("Kundenbereich B", "VP-BOX-2026-0503");
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

    // ============================================================ Bestandsschutz

    @Test
    void dieMigrationLaesstDenBestandZeichengleich() {
        for (String tabelle : List.of("device", "measurement_point", "device_measurement_sample",
                "device_measurement_event", "device_measurement_point_state", "device_measurement_selection",
                "device_measurement_selection_event")) {
            assertThat(fingerVorher.get(tabelle)).as("Bestand in " + tabelle).isNotEqualTo(Bestandsschutz.LEER);
        }
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
        assertThat(root.queryForObject("SELECT count(*) FROM device WHERE tenant_id IN (?, ?) AND "
                + "(ausgebaut_am IS NOT NULL OR status = 'ausgebaut')", Long.class, a.tenant(), b.tenant()))
                .as("keine Box des Bestands ist ausgebaut").isZero();
    }

    @Test
    void derBestandsvergleichBeisst() {
        Bestandsschutz.mutationsprobe(root, List.of(), "device", "UPDATE device SET name = 'Probe'");
    }

    // ============================================================ RESTRICT statt CASCADE

    @Test
    void dieVerweiseDerMesswerteLehnenDasLoeschenAb() {
        List<Map<String, Object>> regeln = root.queryForList("SELECT conname, confdeltype, confupdtype, convalidated "
                + "FROM pg_constraint WHERE contype = 'f' AND conrelid IN ('device_measurement_sample'::regclass, "
                + "'device_measurement_event'::regclass, 'device_measurement_point_state'::regclass, "
                + "'device_measurement_selection'::regclass, 'device_measurement_selection_event'::regclass)");
        assertThat(regeln).extracting(r -> r.get("conname")).containsAll(RESTRICT).contains(ABLESUNG_QUELLE_FK);
        for (Map<String, Object> r : regeln) {
            String erwartet = RESTRICT.contains((String) r.get("conname"))
                    || ABLESUNG_QUELLE_FK.equals(r.get("conname")) ? "r" : "c";
            assertThat(String.valueOf(r.get("confdeltype"))).as(r.get("conname") + " beim Löschen").isEqualTo(erwartet);
        }
        assertThat(regeln).filteredOn(r -> "device_measurement_selection_device_fk".equals(r.get("conname")))
                .extracting(r -> String.valueOf(r.get("confupdtype"))).containsExactly("c");
        assertThat(regeln).filteredOn(r -> "device_measurement_selection_entity_fk".equals(r.get("conname")))
                .extracting(r -> String.valueOf(r.get("confdeltype"))).as("die Auswahl geht mit der Komponente")
                .containsExactly("c");
    }

    @Test
    void einLoeschenDerBoxOderAnlageSchlaegtNichtMehrAufDieMesswerteDurch() {
        Werk w = werk("Durchschlag", "VP-BOX-DURCH");
        long vorher = messwerte(w);
        psql(() -> root.update("DELETE FROM device WHERE id = ?", w.box()), "23503");
        psql(() -> alsTue(w.tenant(), () -> app.update("DELETE FROM device WHERE id = ?", w.box())), "23503");
        psql(() -> root.update("DELETE FROM site WHERE id = ?", w.site()), "23503");
        psql(() -> alsTue(w.tenant(), () -> app.update("DELETE FROM site WHERE id = ?", w.site())), "23503");
        assertThat(messwerte(w)).isEqualTo(vorher).isEqualTo(6);
        assertThat(root.queryForObject("SELECT count(*) FROM device WHERE id = ?", Long.class, w.box())).isOne();
        // Das Löschen einer Komponente nimmt keinen Messwert mit — nur ihre Auswahl (Einstellung).
        assertThat(als(w.tenant(), () -> app.update("DELETE FROM measurement_point WHERE id = ?", w.komponente())))
                .isOne();
        assertThat(messwerte(w)).isEqualTo(vorher - 1);
        assertThat(root.queryForObject("SELECT count(*) FROM device_measurement_sample WHERE entity_id = ?",
                Long.class, w.komponente())).isOne();
    }

    /** Die Rechte an den Tabellen ändert die Migration nicht; neu sind nur die zwei engen Funktionen. */
    @Test
    void dieFunktionenSindNurFuerIhreRolleAusfuehrbar() {
        for (String tabelle : List.of("device_measurement_selection", "device_measurement_selection_event")) {
            assertThat(root.queryForObject("SELECT has_table_privilege(?, ?, 'DELETE')", Boolean.class, APP_USER,
                    tabelle)).as(tabelle).isFalse();
        }
        assertThat(root.queryForObject("SELECT has_function_privilege(?, 'uems_messwerte_der_anlage_entfernen(uuid)', "
                + "'EXECUTE')", Boolean.class, APP_USER)).isTrue();
        assertThat(root.queryForObject("SELECT has_function_privilege(?, 'uems_messwerte_der_anlage_entfernen(uuid)', "
                + "'EXECUTE')", Boolean.class, ADMIN_USER)).isFalse();
        assertThat(root.queryForObject("SELECT has_function_privilege(?, 'uems_messwerte_des_kundenbereichs_entfernen(uuid)', "
                + "'EXECUTE')", Boolean.class, APP_USER)).isFalse();
        assertThat(root.queryForObject("SELECT has_function_privilege(?, 'uems_messwerte_des_kundenbereichs_entfernen(uuid)', "
                + "'EXECUTE')", Boolean.class, ADMIN_USER)).isTrue();
    }

    // ============================================================ Die ausgebaute Box

    @Test
    void ausbauenBehaeltZeileUndWerteUndIstEndgueltig() {
        Werk w = werk("Ausbau", "VP-BOX-AUSBAU");
        long vorher = messwerte(w);
        DeviceRepository boxen = new DeviceRepository(app);
        assertThat(als(b.tenant(), () -> boxen.ausbauen(w.box()))).as("Mandantenzaun").isFalse();
        assertThat(als(w.tenant(), () -> boxen.ausbauen(w.box()))).isTrue();
        assertThat(als(w.tenant(), () -> boxen.ausbauen(w.box()))).as("schon ausgebaut").isFalse();
        Map<String, Object> zeile = root.queryForMap("SELECT status, ausgebaut_am, external_ref, site_id FROM device "
                + "WHERE id = ?", w.box());
        assertThat(zeile.get("status")).isEqualTo("ausgebaut");
        assertThat(zeile.get("ausgebaut_am")).isNotNull();
        assertThat(zeile.get("external_ref")).isEqualTo(w.ref());
        assertThat(messwerte(w)).isEqualTo(vorher);
        assertThat(als(w.tenant(), () -> boxen.findById(w.box()))).as("keine Route erreicht sie").isEmpty();
        assertThat(als(w.tenant(), () -> boxen.findAll())).extracting(d -> d.id()).doesNotContain(w.box());
        assertThat(als(w.tenant(), () -> boxen.countForSite(w.site()))).isZero();

        abgelehnt("device_ausgebaut_endgueltig", () -> root.update("UPDATE device SET status = 'claimed', "
                + "ausgebaut_am = NULL WHERE id = ?", w.box()));
        abgelehnt("device_ausgebaut_endgueltig", () -> root.update("UPDATE device SET external_ref = 'X' WHERE id = ?",
                w.box()));
        abgelehnt("device_ausgebaut_endgueltig", () -> root.update("UPDATE device SET site_id = ? WHERE id = ?",
                a.site(), w.box()));
        assertThat(root.update("UPDATE device SET name = 'Box Halle 2 (alt)' WHERE id = ?", w.box()))
                .as("keine Herkunft, weiter schreibbar").isOne();
        abgelehnt("device_ausgebaut_chk", () -> root.update("UPDATE device SET status = 'ausgebaut' WHERE id = ?",
                a.box()));
        abgelehnt("device_ausgebaut_chk", () -> root.update("UPDATE device SET ausgebaut_am = now() WHERE id = ?",
                a.box()));
    }

    @Test
    void dieAufkleberKennungIstNachDemAusbauWiederAnmeldbar() {
        Werk w = werk("Wieder anmelden", "VP-BOX-WIEDER");
        alsTue(w.tenant(), () -> new DeviceRepository(app).ausbauen(w.box()));
        UUID neu = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, "
                + "'claimed') RETURNING id", UUID.class, w.tenant(), w.site(), w.ref());
        assertThat(neu).isNotEqualTo(w.box());
        abgelehnt("uq_device_external_ref", () -> root.update("INSERT INTO device (tenant_id, site_id, external_ref, "
                + "status) VALUES (?, ?, ?, 'claimed')", b.tenant(), b.site(), w.ref()));
        assertThat(als(w.tenant(), () -> new DeviceRepository(app).findByExternalRef(w.ref())))
                .get().extracting(d -> d.id()).isEqualTo(neu);
    }

    @Test
    void eineAusgebauteBoxBekommtKeineNeueZustaendigkeit() {
        Werk w = werk("Zuständigkeit", "VP-BOX-ZUST");
        UUID dq = root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, adresse, "
                + "kadenz_s) VALUES (?, ?, 'DQ-4', 'modbus_tcp', '192.168.20.31:502', 60) RETURNING id", UUID.class,
                w.tenant(), w.site());
        alsTue(w.tenant(), () -> new DeviceRepository(app).ausbauen(w.box()));
        abgelehnt("data_source_assignment_box_ausgebaut", () -> alsTue(w.tenant(), () -> app.update(
                "INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, protokoll, adresse, "
                        + "effective_from) VALUES (?, ?, ?, 'modbus_tcp', '192.168.20.31:502', now())",
                w.tenant(), dq, w.box())));
    }

    // ============================================================ Belege und das Entfernen der Anlage

    @Test
    void eineAnlageOhneBelegeRaeumtIhreMesswerteAbUndLaesstSichEntfernen() {
        Werk w = werk("Ungebunden", "VP-BOX-UNGEBUNDEN");
        alsTue(w.tenant(), () -> new DeviceRepository(app).ausbauen(w.box()));
        assertThat(als(w.tenant(), () -> app.queryForList("SELECT id FROM uems_messreihen_belege(?, NULL)",
                w.site()))).isEmpty();
        // Ein fremder Kundenbereich trifft nichts.
        assertThat(als(b.tenant(), () -> app.queryForObject("SELECT uems_messwerte_der_anlage_entfernen(?)",
                Long.class, w.site()))).isZero();
        assertThat(messwerte(w)).isEqualTo(6);

        assertThat(als(w.tenant(), () -> app.queryForObject("SELECT uems_messwerte_der_anlage_entfernen(?)",
                Long.class, w.site()))).isEqualTo(6);
        assertThat(als(w.tenant(), () -> app.update("DELETE FROM site WHERE id = ?", w.site()))).isOne();
        assertThat(messwerte(w)).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM device WHERE id = ?", Long.class, w.box()))
                .as("die ausgebaute Box geht mit ihrer Anlage").isZero();
        assertThat(messwerte(a)).as("der Nachbar bleibt").isEqualTo(6);
    }

    @Test
    void eineAnlageMitBelegenLehntAbUndSchreibtNichts() {
        Werk w = werk("Gebunden", "VP-BOX-GEBUNDEN");
        UUID ms10 = messstelle(w, "MS-10", "Netzbezug Halle 2", "gemessen");
        UUID ms15 = messstelle(w, "MS-15", "Halle 2 nicht zugeordnet", "berechnet");
        // MS-10: die Bindung lebt nur noch im Protokoll (ihre Zeile ging mit einer Komponente);
        // MS-15: ein Messkanal-Term einer berechneten Messstelle — beides sind Belege.
        protokollGebunden(w, ms10, w.komponente(), KANAL);
        root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, position, eingang_art, entity_id, "
                + "point_key, vorzeichen, faktor) VALUES (?, ?, 1, 'messkanal', ?, ?, '+', 1)", w.tenant(), ms15,
                w.komponente(), KANAL);
        long vorher = messwerte(w);

        assertThat(als(w.tenant(), () -> app.queryForList("SELECT kennzeichen FROM uems_messreihen_belege(?, NULL)",
                String.class, w.site()))).containsExactly("MS-10", "MS-15");
        assertThat(als(w.tenant(), () -> app.queryForList("SELECT kennzeichen FROM uems_messreihen_belege(NULL, ?)",
                String.class, w.box()))).containsExactly("MS-10", "MS-15");
        assertThat(als(b.tenant(), () -> app.queryForList("SELECT kennzeichen FROM uems_messreihen_belege(?, NULL)",
                String.class, w.site()))).as("Mandantenzaun").isEmpty();

        abgelehnt("messstellen_belege", () -> alsTue(w.tenant(), () -> app.queryForObject(
                "SELECT uems_messwerte_der_anlage_entfernen(?)", Long.class, w.site())));
        assertThat(messwerte(w)).isEqualTo(vorher);
    }

    // ============================================================ Live-Fläche: der Lücken-Melder

    /**
     * Die eingeschaltete Auswahl einer ausgebauten Box ist keine Erwartung mehr: für ihre Reihe
     * öffnet der Melder keine Lücke, und eine schon offene endet mit dem Ausbau — die Box eines
     * Nachbarn, die weiter schweigt, behält ihre Lücke (die Probe beißt).
     */
    @Test
    void derLueckenMelderErwartetKeineReiheEinerAusgebautenBoxMehr() {
        LueckenMelder melder = new LueckenMelder(admin, new MeasurementCatalog(new ObjectMapper()), 50, 40, 20_000);
        Instant jetzt = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        Werk bleibt = lueckenWerk("Lücke bleibt", "VP-BOX-LUECKE-A", jetzt);
        Werk endet = lueckenWerk("Lücke endet", "VP-BOX-LUECKE-B", jetzt);
        Werk nie = lueckenWerk("Keine Lücke", "VP-BOX-LUECKE-C", jetzt);
        alsTue(nie.tenant(), () -> new DeviceRepository(app).ausbauen(nie.box()));

        melder.lauf(jetzt);
        assertThat(reihenLuecken(bleibt)).as("die Probe: eine offene Lücke").containsExactly((Instant) null);
        assertThat(reihenLuecken(endet)).containsExactly((Instant) null);
        assertThat(reihenLuecken(nie)).as("ausgebaut vor dem Lauf: keine Erwartung, keine Lücke").isEmpty();

        alsTue(endet.tenant(), () -> new DeviceRepository(app).ausbauen(endet.box()));
        Instant ausbau = root.queryForObject("SELECT ausgebaut_am FROM device WHERE id = ?", Timestamp.class,
                endet.box()).toInstant();
        melder.lauf(jetzt.plus(Duration.ofHours(2)));
        assertThat(reihenLuecken(bleibt)).containsExactly((Instant) null);
        assertThat(reihenLuecken(endet)).as("die Lücke endet mit dem Ausbau (Ereignis-Zeiten sekundengenau)")
                .containsExactly(ausbau.truncatedTo(ChronoUnit.SECONDS));
        assertThat(reihenLuecken(nie)).isEmpty();
        assertThat(root.queryForObject("SELECT count(*) FROM device_measurement_selection WHERE device_id = ? AND enabled",
                Long.class, endet.box())).as("die Auswahl bleibt gespeichert").isOne();
    }

    // ============================================================ Offboarding

    @Test
    void dasOffboardingRaeumtDieMesswerteWeiterAb() throws Exception {
        Werk w = werk("Offboarding", "VP-BOX-OFFBOARD");
        // Eine ausgebaute Box mit Werten und ihre Nachfolgerin mit derselben Aufkleber-Kennung.
        alsTue(w.tenant(), () -> new DeviceRepository(app).ausbauen(w.box()));
        box(w.tenant(), w.site(), w.ref());
        assertThat(messwerte(w)).isEqualTo(6);
        new TenantRepository(admin).offboard(w.tenant());
        assertThat(root.queryForObject("SELECT count(*) FROM tenant WHERE id = ?", Long.class, w.tenant())).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM device WHERE tenant_id = ?", Long.class, w.tenant()))
                .isZero();
        assertThat(messwerte(w)).isZero();
        assertThat(messwerte(a)).as("der Nachbar bleibt").isEqualTo(6);
    }

    // ============================================================ Gerüst

    private static Werk werk(String name, String ref) {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Halle 2') RETURNING id",
                UUID.class, t);
        UUID box = box(t, site, ref);
        UUID k = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, device_id, role, label, "
                + "entity_type) VALUES (?, ?, ?, 'grid-meter', 'Zähler EK-1', 'grid-meter') RETURNING id", UUID.class,
                t, site, box);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), ?, 'test', "
                + "'pending_edge', 'energy_counter', 'fifteen_minute')", t, site, box, k, KANAL, KATALOG);
        root.update("INSERT INTO device_measurement_selection_event (tenant_id, site_id, device_id, point_key, "
                + "desired_revision, idempotency_key, requested_enabled, requested_cadence_s, enabled_at, "
                + "catalog_version, actor, apply_status, retention_class, raw_retention_days, long_term_strategy) "
                + "VALUES (?, ?, ?, ?, 1, ?, true, 60, now(), ?, 'test', 'pending_edge', 'energy_counter', 90, "
                + "'fifteen_minute')", t, site, box, KANAL, UUID.randomUUID(), KATALOG);
        Instant jetzt = Instant.parse("2026-11-03T13:00:00Z");
        for (int i = 0; i < 2; i++) {
            root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, "
                    + "point_key, raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, "
                    + "aggregation_kind, gap, dropped_samples, entity_id) VALUES (?, now(), ?, ?, ?, ?, 10005, 1000.5, "
                    + "'good', ?, ?, 'counter', false, 0, ?)", Timestamp.from(jetzt.plusSeconds(60L * i)),
                    t, site, box, KANAL, KATALOG, 70000 + i, i == 0 ? k : null);
        }
        root.update("INSERT INTO device_measurement_event (occurred_at, tenant_id, site_id, device_id, point_key, "
                + "event_kind, catalog_version, edge_sequence) VALUES (?, ?, ?, ?, ?, 'state_change', ?, 1)",
                Timestamp.from(jetzt), t, site, box, KANAL, KATALOG);
        root.update("INSERT INTO device_measurement_point_state (tenant_id, site_id, device_id, point_key, "
                + "first_read_at, last_read_at, edge_sequence, raw_numeric, quality, catalog_version) VALUES (?, ?, ?, "
                + "?, now(), now(), 70001, 10005, 'good', ?)", t, site, box, KANAL, KATALOG);
        return new Werk(t, site, box, k, ref);
    }

    /** Eine Box, deren Reihe bis vor zehn Minuten jede Minute einen Wert hatte — und dann schweigt. */
    private static Werk lueckenWerk(String name, String ref, Instant jetzt) {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Halle 2') RETURNING id",
                UUID.class, t);
        UUID box = box(t, site, ref);
        UUID k = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, device_id, role, label, "
                + "entity_type) VALUES (?, ?, ?, 'grid-meter', 'Zähler EK-1', 'grid-meter') RETURNING id", UUID.class,
                t, site, box);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, 'energy_kwh_luecke', true, 60, 1, "
                + "'2024-03-12T00:00:00Z', ?, 'test', 'pending_edge', 'live_power', 'fifteen_minute')", t, site, box, k,
                KATALOG);
        for (int i = 20; i >= 10; i--) {
            Instant zeit = jetzt.minus(Duration.ofMinutes(i));
            root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, "
                    + "point_key, raw_numeric, quality, catalog_version, edge_sequence, aggregation_kind, entity_id, "
                    + "applied_revision, value_kind, role, delivery, delay_s) VALUES (?, ?, ?, ?, ?, 'energy_kwh_luecke', "
                    + "?, 'good', ?, ?, 'counter', ?, 1, 'counter', 'fuehrend', 'direkt', 30)", Timestamp.from(zeit),
                    Timestamp.from(zeit.plusSeconds(30)), t, site, box, 1000 + i, KATALOG, 90000 + i, k);
        }
        return new Werk(t, site, box, k, ref);
    }

    /** Das Ende ({@code null} = offen) jeder Reihen-Lücke der Komponente, im jüngsten Stand. */
    private static List<Instant> reihenLuecken(Werk w) {
        return root.query("SELECT DISTINCT ON (ereignis_id) bis FROM messreihe_ereignis WHERE tenant_id = ? AND "
                + "entity_id = ? AND art = 'data_gap' ORDER BY ereignis_id, eingang DESC, (bis IS NULL)",
                (rs, i) -> rs.getTimestamp(1) == null ? null : rs.getTimestamp(1).toInstant(), w.tenant(), w.komponente());
    }

    private static UUID box(UUID tenant, UUID site, String ref) {
        return root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, "
                + "'claimed') RETURNING id", UUID.class, tenant, site, ref);
    }

    /** Alle Zeilen der Messwert-Strecke eines Kundenbereichs (Rohwerte, Ereignis, Stand, Auswahl, Auswahl-Historie). */
    private static long messwerte(Werk w) {
        return root.queryForObject("SELECT (SELECT count(*) FROM device_measurement_sample WHERE tenant_id = ?) "
                + "+ (SELECT count(*) FROM device_measurement_event WHERE tenant_id = ?) "
                + "+ (SELECT count(*) FROM device_measurement_point_state WHERE tenant_id = ?) "
                + "+ (SELECT count(*) FROM device_measurement_selection WHERE tenant_id = ?) "
                + "+ (SELECT count(*) FROM device_measurement_selection_event WHERE tenant_id = ?)", Long.class,
                w.tenant(), w.tenant(), w.tenant(), w.tenant(), w.tenant());
    }

    private static UUID messstelle(Werk w, String kennzeichen, String name, String art) {
        return root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, ?, 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                + "'Zählerstand') RETURNING id", UUID.class, w.tenant(), kennzeichen, name, art);
    }

    private static void protokollGebunden(Werk w, UUID messstelle, UUID komponente, String kanal) {
        root.update("INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, art, neu, gilt_ab, rueckwirkend, "
                + "actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, 'quelle_gebunden', "
                + "jsonb_build_object('komponente', ?::text, 'kanal', ?::text), '2026-10-01T00:00:00+02:00', false, "
                + "'sub-ines', 'Ines Kaltenbach', 'kundenadministrator', 'kunde')", w.tenant(), messstelle,
                komponente.toString(), kanal);
    }

    private static <T> T als(UUID tenant, Supplier<T> arbeit) {
        TenantContext.set(tenant);
        try {
            return arbeit.get();
        } finally {
            TenantContext.clear();
        }
    }

    private static void alsTue(UUID tenant, Runnable arbeit) {
        als(tenant, () -> {
            arbeit.run();
            return null;
        });
    }

    private static PSQLException psql(Runnable arbeit, String erwartet) {
        Throwable t = null;
        try {
            arbeit.run();
        } catch (Throwable e) {
            t = e;
        }
        assertThat(t).as("die Datenbank muss ablehnen (" + erwartet + ")").isNotNull();
        PSQLException p = null;
        for (Throwable c = t; c != null; c = c.getCause()) {
            if (c instanceof PSQLException pe) {
                p = pe;
            }
        }
        assertThat((Object) p).as("eine PSQLException: " + t).isNotNull();
        if (erwartet.length() == 5 && Character.isDigit(erwartet.charAt(0))) {
            assertThat(p.getSQLState()).as(p.getMessage()).isEqualTo(erwartet);
        }
        return p;
    }

    private static void abgelehnt(String constraint, Runnable arbeit) {
        PSQLException p = psql(arbeit, constraint);
        assertThat(p.getServerErrorMessage().getConstraint()).as(p.getMessage()).isEqualTo(constraint);
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
