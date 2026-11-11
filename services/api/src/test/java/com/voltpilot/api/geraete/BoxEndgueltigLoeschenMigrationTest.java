package com.voltpilot.api.geraete;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BerichtRegeln;
import com.voltpilot.api.uems.BerichtsBelege;
import com.voltpilot.api.uems.MessreihenBelege;
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
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.web.server.ResponseStatusException;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * „Endgültig löschen" einer ausgebauten Box (vp-box-endgueltig-loeschen, V20261111190000) gegen
 * echtes TimescaleDB: die EINE Regel „keine Daten" aus {@link BoxDatenBestand} mit einem Test JE
 * DATENART, der Glückspfad (Zeile weg, Protokoll da, Kennung wieder anmeldbar, Werkstatt/Fernwartung/
 * Zertifikats-Historie unberührt), die Ablehnungen (Daten, nicht ausgebaut, fremder Mandant), die
 * Idempotenz über das Protokoll, die DB-Rückversicherung (ON DELETE RESTRICT) und die
 * Vollständigkeit der Einordnung jeder Tabelle mit {@code device_id}
 * ({@link #jedeTabelleMitDeviceIdIstEingeordnet}).
 */
@Testcontainers(disabledWithoutDocker = true)
class BoxEndgueltigLoeschenMigrationTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final String KANAL = "sunspec.model_203.totwhimp";
    private static final String KATALOG = "2026.09.11.1";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static JdbcTemplate admin;
    private static BoxEndgueltigLoeschenService service;
    private static AdminBoxEndgueltigRepository adminRepo;
    private static DeviceRepository devices;

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
        TenantAwareDataSource appDs = new TenantAwareDataSource(ds(APP_USER, APP_PW));
        app = new JdbcTemplate(appDs);
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        devices = new DeviceRepository(app);
        adminRepo = new AdminBoxEndgueltigRepository(admin);
        service = new BoxEndgueltigLoeschenService(adminRepo,
                new BoxEndgueltigRepository(app, new ObjectMapper()), devices,
                new MessreihenBelege(app), new BerichtsBelege(app),
                new DataSourceTransactionManager(appDs));
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
                + "WHERE relname = 'box_endgueltig_geloescht_protokoll'", Boolean.class)).isTrue();
        assertThat(root.queryForObject(
                "SELECT has_table_privilege(?, 'box_endgueltig_geloescht_protokoll', 'INSERT')",
                Boolean.class, APP_USER)).isTrue();
        assertThat(root.queryForObject(
                "SELECT has_table_privilege(?, 'box_endgueltig_geloescht_protokoll', 'DELETE')",
                Boolean.class, APP_USER)).as("append-only für die App-Rolle").isFalse();
        assertThat(root.queryForObject(
                "SELECT has_table_privilege(?, 'box_endgueltig_geloescht_protokoll', 'DELETE')",
                Boolean.class, ADMIN_USER)).as("Offboarding räumt über die Admin-Rolle ab").isTrue();
    }

    // ============================================================ Die Regel, je Datenart ein Test

    @Test
    void eineAusgebauteBoxOhneAllesIstLoeschbar() {
        Werk w = ausgebaut("Ohne alles", "VP-ENDG-LEER");
        // EIN Befund über die komplette Abfrage: jede EXISTS-Klausel läuft gegen das echte Schema.
        BoxEndgueltigLoeschenService.Befund b = service.befund(w.ref());
        assertThat(b.loeschbar()).isTrue();
        assertThat(b.daten()).isEmpty();
        assertThat(b.zeile().deviceId()).isEqualTo(w.box());
    }

    @Test
    void datenartHerzschlag() {
        Werk w = ausgebaut("Herzschlag", "VP-ENDG-HERZ");
        root.update("UPDATE device SET device_status_seen_at = now() WHERE id = ?", w.box());
        assertThat(service.befund(w.ref()).daten()).containsExactly("herzschlag");
        Werk lan = ausgebaut("LAN", "VP-ENDG-LAN");
        root.update("UPDATE device SET lan_host = '192.168.1.40', lan_seen_at = now(), lan_source = 'erreicht' "
                + "WHERE id = ?", lan.box());
        assertThat(service.befund(lan.ref()).daten()).as("auch eine gemeldete LAN-Adresse ist ein Herzschlag")
                .containsExactly("herzschlag");
    }

    @Test
    void datenartMesswerte() {
        Werk w = ausgebaut("Messwerte", "VP-ENDG-MESSWERT");
        root.update("INSERT INTO telemetry (time, tenant_id, site_id, device_id, pv_power_kw) "
                + "VALUES (now(), ?, ?, ?, 1.5)", w.tenant(), w.site(), w.box());
        assertThat(service.befund(w.ref()).daten()).containsExactly("messwerte");
    }

    @Test
    void datenartMessauswahl() {
        Werk w = ausgebaut("Messauswahl", "VP-ENDG-AUSWAHL");
        UUID komponente = komponente(w);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, "
                + "point_key, enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, "
                + "apply_status, retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, "
                + "now(), ?, 'test', 'pending_edge', 'energy_counter', 'fifteen_minute')",
                w.tenant(), w.site(), w.box(), komponente, KANAL, KATALOG);
        assertThat(service.befund(w.ref()).daten()).containsExactly("messauswahl");
    }

    @Test
    void datenartMeldungen() {
        Werk w = ausgebaut("Meldungen", "VP-ENDG-MELDUNG");
        root.update("INSERT INTO device_edge_version (device_id, tenant_id, site_id, core_version, "
                + "palette_version, reported_at) VALUES (?, ?, ?, '1.4.0', '0.3.0', now())",
                w.box(), w.tenant(), w.site());
        assertThat(service.befund(w.ref()).daten()).containsExactly("meldungen");
    }

    @Test
    void datenartBefehle() {
        Werk w = ausgebaut("Befehle", "VP-ENDG-BEFEHL");
        root.update("INSERT INTO device_command_log (tenant_id, site_id, device_id, stream, kind, "
                + "started_at, ended_at, last_seen_at, mode, commanded_kw_first, source) VALUES "
                + "(?, ?, ?, 'batterie', 'periode', now(), now(), now(), 'plan', 1.0, 'cloud_abgeleitet')",
                w.tenant(), w.site(), w.box());
        assertThat(service.befund(w.ref()).daten()).containsExactly("befehle");
    }

    @Test
    void datenartOcpp() {
        Werk w = ausgebaut("OCPP", "VP-ENDG-OCPP");
        root.update("INSERT INTO ocpp_station (device_id, charge_point_id, tenant_id, site_id, updated_at) "
                + "VALUES (?, 'CP-ENDG-1', ?, ?, now())", w.box(), w.tenant(), w.site());
        assertThat(service.befund(w.ref()).daten()).containsExactly("ocpp");
    }

    @Test
    void datenartRueckmeldungen() {
        Werk w = ausgebaut("Rückmeldungen", "VP-ENDG-RUECK");
        root.update("INSERT INTO device_control_status (device_id, tenant_id, site_id, commanded_kw, "
                + "confirmed_kw, all_match, control_enabled, certified, checked_at) VALUES "
                + "(?, ?, ?, -4.3, -4.3, TRUE, TRUE, TRUE, now())", w.box(), w.tenant(), w.site());
        assertThat(service.befund(w.ref()).daten()).containsExactly("rueckmeldungen");
    }

    @Test
    void datenartFreigaben() {
        Werk w = ausgebaut("Freigaben", "VP-ENDG-FREIGABE");
        root.update("INSERT INTO device_control_activation (device_id, activated_by) VALUES (?, 'test')",
                w.box());
        assertThat(service.befund(w.ref()).daten()).containsExactly("freigaben");
    }

    @Test
    void datenartKomponenten() {
        Werk w = ausgebaut("Komponenten", "VP-ENDG-KOMP");
        root.update("INSERT INTO entity_observed_state (device_id, entity_id, tenant_id, site_id) "
                + "VALUES (?, 'wr-1', ?, ?)", w.box(), w.tenant(), w.site());
        assertThat(service.befund(w.ref()).daten()).containsExactly("komponenten");
    }

    @Test
    void datenartMessstellenBelege() {
        Werk w = ausgebaut("Belege", "VP-ENDG-BELEG");
        UUID messstelle = messstelleMitTermAufKomponenteDerBox(w, "MS-ENDG-1");
        assertThat(messstelle).isNotNull();
        assertThat(service.befund(w.ref()).daten()).containsExactly("messstellen_belege");
    }

    @Test
    void datenartBerichtsstaende() {
        Werk w = ausgebaut("Berichts-Belege", "VP-ENDG-BERICHT");
        UUID messstelle = messstelleMitTermAufKomponenteDerBox(w, "MS-ENDG-2");
        UUID unternehmen = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) "
                + "VALUES (?, 'Endgültig GmbH', 'Europe/Berlin') RETURNING id", UUID.class, w.tenant());
        UUID bericht = root.queryForObject("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, "
                + "geltung_art, unternehmen_id, zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_name) "
                + "VALUES (?, 'BR-2027-9001', 'monatsbericht_unternehmen', 1, 'unternehmen', ?, 'monat', "
                + "'2027-06', 'Europe/Berlin', 'Test') RETURNING id", UUID.class, w.tenant(), unternehmen);
        String abzug = "{\"bericht\":\"BR-2027-9001\"}";
        root.update("INSERT INTO bericht_stand (tenant_id, bericht_id, nr, abzug, pruefsumme, datenstand, "
                + "freigegeben_am, freigeber_sub, freigeber_name, freigeber_rolle, darstellung, regelwerk, "
                + "vorlage_fassung) VALUES (?, ?, 1, ?, ?, now(), now(), 'kc-test', 'Test', 'energiemanager', "
                + "'{}'::jsonb, '{}'::jsonb, 1)", w.tenant(), bericht, abzug, BerichtRegeln.pruefsumme(abzug));
        root.update("INSERT INTO bericht_quelle (tenant_id, bericht_id, stand_nr, art, kennzeichen, objekt_id, "
                + "bezug, erster_tag, letzter_tag, version, fassung, name_zum_datenstand) VALUES (?, ?, 1, "
                + "'messstelle', 'MS-ENDG-2', ?, 'unmittelbar', '2027-06-01', '2027-06-30', 1, NULL, 'Beleg')",
                w.tenant(), bericht, messstelle);
        assertThat(service.befund(w.ref()).daten())
                .containsExactly("messstellen_belege", "berichtsstaende");
    }

    // ============================================================ Glückspfad und Ablehnungen

    @Test
    void loeschenEntferntDieZeileSchreibtDasProtokollUndLaesstDieProtokolleDerKennungStehen() {
        Werk w = ausgebaut("Glückspfad", "VP-ENDG-GLUECK");
        // Werkstatt, Fernwartung und Zertifikats-Historie adressieren die KENNUNG - sie müssen bleiben.
        root.update("INSERT INTO werkstatt_box (edge_ref, angelegt_von, geaendert_von) VALUES (?, 'w', 'w')",
                w.ref());
        root.update("INSERT INTO fernwartung_zugang (id, art, edge_ref, public_key, tunnel_adresse, status, "
                + "angelegt_von, geaendert_von) VALUES (gen_random_uuid(), 'box', ?, "
                + "'jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM=', '10.10.16.77/32', 'aktiv', 'a', 'a')", w.ref());
        root.update("INSERT INTO device_enrollment (external_ref, csr_pem, device_id, cert_pem, cert_serial, "
                + "issued_at) VALUES (?, 'csr', ?, 'cert', 'serial-endg', now())", w.ref(), w.box());

        BoxEndgueltigLoeschenService.Ergebnis e = service.loeschen(w.ref(), w.box(),
                com.voltpilot.api.uems.ProtokollAkteur.fuer("kc-admin", "Moritz V.", true));
        assertThat(e.bereitsGeloescht()).isFalse();
        assertThat(root.queryForObject("SELECT count(*) FROM device WHERE id = ?", Long.class, w.box()))
                .as("die Zeile ist weg").isZero();

        Map<String, Object> p = root.queryForMap("SELECT * FROM box_endgueltig_geloescht_protokoll "
                + "WHERE device_id = ?", w.box());
        assertThat(p.get("external_ref")).isEqualTo(w.ref());
        assertThat(p.get("tenant_name")).isEqualTo("Glückspfad");
        assertThat(p.get("site_name")).isEqualTo("Zuhause");
        assertThat(p.get("geloescht_von_name")).isEqualTo("Moritz V.");
        assertThat(p.get("ausgebaut_am")).isNotNull();

        assertThat(root.queryForObject("SELECT count(*) FROM werkstatt_box WHERE edge_ref = ?", Long.class,
                w.ref())).as("Werkstatt bleibt").isOne();
        assertThat(root.queryForObject("SELECT count(*) FROM fernwartung_zugang WHERE edge_ref = ?", Long.class,
                w.ref())).as("Fernwartung bleibt").isOne();
        assertThat(root.queryForObject("SELECT count(*) FROM device_enrollment WHERE external_ref = ?",
                Long.class, w.ref())).as("Zertifikats-Historie bleibt").isOne();

        // Die Kennung ist wieder anmeldbar, wie nach dem Ausbau.
        UUID neu = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, ?, 'claimed') RETURNING id", UUID.class, w.tenant(), w.site(), w.ref());
        assertThat(neu).isNotEqualTo(w.box());
    }

    @Test
    void loeschenIstIdempotentUeberDasProtokoll() {
        Werk w = ausgebaut("Idempotenz", "VP-ENDG-IDEM");
        BoxEndgueltigLoeschenService.Ergebnis erster = service.loeschen(w.ref(), w.box(), null);
        BoxEndgueltigLoeschenService.Ergebnis zweiter = service.loeschen(w.ref(), w.box(), null);
        assertThat(zweiter.bereitsGeloescht()).isTrue();
        assertThat(zweiter.geloeschtAm()).isEqualTo(erster.geloeschtAm());
        assertThat(root.queryForObject("SELECT count(*) FROM box_endgueltig_geloescht_protokoll "
                + "WHERE device_id = ?", Long.class, w.box())).isOne();
    }

    @Test
    void eineNichtAusgebauteBoxWirdNieGeloescht() {
        Werk w = werk("Nicht ausgebaut", "VP-ENDG-AKTIV");
        assertThatThrownBy(() -> service.loeschen(w.ref(), w.box(), null))
                .isInstanceOf(BoxEndgueltigAbgelehnt.class)
                .satisfies(t -> assertThat(((BoxEndgueltigAbgelehnt) t).koerper())
                        .containsEntry("code", "nicht_ausgebaut"));
        assertThat(root.queryForObject("SELECT count(*) FROM device WHERE id = ?", Long.class, w.box())).isOne();
        // Auch der Befund kennt sie nicht: er zeigt nur ausgebaute Boxen.
        assertThatThrownBy(() -> service.befund(w.ref())).isInstanceOf(ResponseStatusException.class);
    }

    @Test
    void eineBoxMitDatenWirdMitDerListeAbgelehntUndNichtsAendertSich() {
        Werk w = ausgebaut("Mit Daten", "VP-ENDG-DATEN");
        root.update("INSERT INTO telemetry (time, tenant_id, site_id, device_id, pv_power_kw) "
                + "VALUES (now(), ?, ?, ?, 2.0)", w.tenant(), w.site(), w.box());
        assertThatThrownBy(() -> service.loeschen(w.ref(), w.box(), null))
                .isInstanceOf(BoxEndgueltigAbgelehnt.class)
                .satisfies(t -> {
                    Map<String, Object> k = ((BoxEndgueltigAbgelehnt) t).koerper();
                    assertThat(k).containsEntry("code", "box_hat_daten");
                    assertThat(k.get("daten")).isEqualTo(List.of("messwerte"));
                });
        assertThat(root.queryForObject("SELECT count(*) FROM device WHERE id = ?", Long.class, w.box())).isOne();
        assertThat(root.queryForObject("SELECT count(*) FROM box_endgueltig_geloescht_protokoll "
                + "WHERE device_id = ?", Long.class, w.box())).isZero();
    }

    @Test
    void dieDbRueckversicherungLehntAbWennDochEineRestrictZeileDaIst() {
        Werk w = ausgebaut("Rückversicherung", "VP-ENDG-RESTRICT");
        root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, "
                + "point_key, raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, "
                + "aggregation_kind, gap, dropped_samples) VALUES (now(), now(), ?, ?, ?, ?, 1000, 100.0, "
                + "'good', ?, 1, 'counter', false, 0)", w.tenant(), w.site(), w.box(), KANAL, KATALOG);
        // Direkt am Repository vorbei an der Anwendungs-Regel: die Datenbank selbst lehnt ab (23503).
        PSQLException p = psql(() -> als(w.tenant(), () -> devices.endgueltigLoeschen(w.box())));
        assertThat(p.getSQLState()).isEqualTo("23503");
        assertThat(root.queryForObject("SELECT count(*) FROM device WHERE id = ?", Long.class, w.box()))
                .as("nichts geändert").isOne();
    }

    @Test
    void endgueltigLoeschenUeberEinenFremdenMandantenTrifftNichts() {
        Werk a = ausgebaut("Fremd A", "VP-ENDG-FREMD-A");
        Werk b = ausgebaut("Fremd B", "VP-ENDG-FREMD-B");
        assertThat(als(b.tenant(), () -> devices.endgueltigLoeschen(a.box())))
                .as("RLS verbirgt die fremde Box").isFalse();
        assertThat(root.queryForObject("SELECT count(*) FROM device WHERE id = ?", Long.class, a.box())).isOne();
    }

    @Test
    void endgueltigLoeschenLoeschtNieEineNichtAusgebauteZeile() {
        Werk w = werk("Repo-Zaun", "VP-ENDG-REPO-AKTIV");
        assertThat(als(w.tenant(), () -> devices.endgueltigLoeschen(w.box())))
                .as("nur status = 'ausgebaut'").isFalse();
        assertThat(root.queryForObject("SELECT count(*) FROM device WHERE id = ?", Long.class, w.box())).isOne();
    }

    @Test
    void mehrereAusgebauteZeilenDerselbenKennungDerBefundZeigtDieJuengsteDerPostTrifftGenauEine() {
        // Der Ausbau-Zeitpunkt ist final (Trigger device_ausgebaut_endgueltig) - also gleich mit Datum.
        Werk alt = werk("Zwei Zeilen", "VP-ENDG-ZWEI");
        root.update("UPDATE device SET status = 'ausgebaut', ausgebaut_am = now() - interval '10 days' "
                + "WHERE id = ?", alt.box());
        UUID neu = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status, "
                + "ausgebaut_am) VALUES (?, ?, ?, 'ausgebaut', now()) RETURNING id", UUID.class,
                alt.tenant(), alt.site(), alt.ref());
        assertThat(service.befund(alt.ref()).zeile().deviceId()).as("die jüngste ausgebaute").isEqualTo(neu);
        BoxEndgueltigLoeschenService.Ergebnis e = service.loeschen(alt.ref(), alt.box(), null);
        assertThat(e.deviceId()).isEqualTo(alt.box());
        assertThat(root.queryForObject("SELECT count(*) FROM device WHERE id = ?", Long.class, neu))
                .as("die andere Zeile bleibt").isOne();
    }

    // ============================================================ Vollständigkeit (Tabellen-Inventar)

    /**
     * Jede Tabelle mit einer Spalte {@code device_id} im TATSÄCHLICHEN Schema ist in
     * {@link BoxDatenBestand} GENAU EINER Klasse zugeordnet - und die Klasse passt zum tatsächlichen
     * Fremdschlüssel: eine „unbedenkliche Kaskade" ist wirklich CASCADE/SET NULL, ein „bleibt ohne
     * FK" hat wirklich keinen, und jede RESTRICT-Tabelle blockiert über eine Datenart (sonst liefe
     * eine datenfreie Box in ein nacktes 23503). Eine neue Tabelle ohne Eintrag fällt hier auf -
     * BEVOR sie zur Lücke wird; im Zweifel gehört sie in die Aufzeichnungen („hat Daten").
     */
    @Test
    void jedeTabelleMitDeviceIdIstEingeordnet() {
        List<String> tabellen = root.queryForList(
                "SELECT DISTINCT table_name FROM information_schema.columns "
                        + "WHERE table_schema = 'public' AND column_name = 'device_id' ORDER BY 1",
                String.class);
        assertThat(tabellen).isNotEmpty();

        Map<String, String> fkDeltype = new java.util.TreeMap<>();
        root.query("SELECT conrelid::regclass::text AS tabelle, confdeltype FROM pg_constraint "
                + "WHERE contype = 'f' AND confrelid = 'device'::regclass", rs -> {
            fkDeltype.merge(rs.getString("tabelle"), rs.getString("confdeltype"),
                    (a, b) -> a.contains(b) ? a : a + b);
        });

        Set<String> blockierend = new java.util.TreeSet<>();
        BoxDatenBestand.AUFZEICHNUNGEN.values().forEach(blockierend::addAll);

        List<String> unbekannt = tabellen.stream()
                .filter(t -> !BoxDatenBestand.alleEingeordneten().contains(t))
                .toList();
        assertThat(unbekannt)
                .as("Tabellen mit device_id ohne Einordnung in BoxDatenBestand (im Zweifel: AUFZEICHNUNGEN)")
                .isEmpty();

        List<String> verstoesse = new java.util.ArrayList<>();
        for (String t : tabellen) {
            String deltype = fkDeltype.get(t);
            if (deltype != null && deltype.contains("r") && !blockierend.contains(t)) {
                verstoesse.add("RESTRICT-Tabelle " + t + " muss über eine Datenart blockieren");
            }
            if (BoxDatenBestand.KASKADE_UNBEDENKLICH.containsKey(t)
                    && (deltype == null || !deltype.chars().allMatch(c -> c == 'c' || c == 'n'))) {
                verstoesse.add("unbedenkliche Kaskade " + t + " braucht CASCADE/SET NULL, hat '" + deltype + "'");
            }
            if (BoxDatenBestand.BLEIBT_OHNE_FK.containsKey(t) && deltype != null) {
                verstoesse.add("'bleibt' gilt nur ohne FK auf device: " + t + " trägt '" + deltype + "'");
            }
        }
        assertThat(verstoesse).as("Einordnung passt nicht zum tatsächlichen Schema").isEmpty();
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

    private static Werk ausgebaut(String name, String ref) {
        Werk w = werk(name, ref);
        root.update("UPDATE device SET status = 'ausgebaut', ausgebaut_am = now() WHERE id = ?", w.box());
        return w;
    }

    /** Eine Komponente (measurement_point) DIESER Box - der Anker für Auswahl und Belege. */
    private static UUID komponente(Werk w) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, device_id) "
                + "VALUES (?, ?, 'pv-generation', 'Prüf-Komponente', ?) RETURNING id",
                UUID.class, w.tenant(), w.site(), w.box());
    }

    /** Eine berechnete Messstelle, deren Formel-Term einen Kanal einer Komponente der Box liest (= Beleg). */
    private static UUID messstelleMitTermAufKomponenteDerBox(Werk w, String kennzeichen) {
        UUID komponente = komponente(w);
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, "
                + "groesse, richtung, einheit, wertart) VALUES (?, ?, ?, 'berechnet', 'Strom', 'Wirkenergie', "
                + "'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, w.tenant(), kennzeichen,
                "Zähler " + kennzeichen);
        root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, position, eingang_art, "
                + "entity_id, point_key, vorzeichen, faktor) VALUES (?, ?, 0, 'messkanal', ?, ?, '+', 1)",
                w.tenant(), ms, komponente, KANAL);
        return ms;
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
