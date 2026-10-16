package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.DeviceDataSourceStatusRepository;
import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.versand.BenachrichtigungAusgang;
import com.voltpilot.api.zugriff.ZugriffRepository;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Alerting Scheibe 1 (vp-alerting-konzept-m1 §7 "Testcontainers-IT je Leserart und für den
 * Mandanten- UND Standort-Zaun") auf der echten Datenbank: {@code zustand}- und {@code ereignis}-
 * Leser gegen echte Zeilen, der Läufer über mehrere Takte (Aussaat, Ausgelöst, wieder normal ohne
 * "Gesehen" - Entscheid 3B), und der Mandanten-/Standort-Zaun auf {@code ueberwachung}/{@code alarm}.
 */
@Testcontainers(disabledWithoutDocker = true)
class UeberwachungSiteScopeIT {

    private static final String APP = "voltpilot_app";
    private static final String ADMIN = "voltpilot_admin";
    private static final String PW = "ueberwachung_it_pw";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate app;
    private static JdbcTemplate adminJdbc;

    @BeforeAll
    static void migrate() {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP, "appDbPassword", PW, "adminDbUser", ADMIN,
                        "adminDbPassword", PW))
                .load()
                .migrate();
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP, PW)));
        adminJdbc = new JdbcTemplate(ds(ADMIN, PW));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // =========================================================== Aufbau: zwei Kundenbereiche

    private record Welt(UUID tenant, UUID unternehmen, UUID st1, UUID st2, UUID anlage1, UUID anlage2,
            UUID box1, UUID box2) {}

    private static Welt welt(String name) {
        UUID tenant = UUID.randomUUID();
        UUID unternehmen = UUID.randomUUID();
        UUID st1 = UUID.randomUUID();
        UUID st2 = UUID.randomUUID();
        UUID anlage1 = UUID.randomUUID();
        UUID anlage2 = UUID.randomUUID();
        UUID box1 = UUID.randomUUID();
        UUID box2 = UUID.randomUUID();
        adminJdbc.update("INSERT INTO tenant (id, name) VALUES (?, ?)", tenant, name);
        adminJdbc.update("INSERT INTO unternehmen (id, tenant_id, name) VALUES (?, ?, ?)", unternehmen, tenant, name);
        adminJdbc.update("INSERT INTO standort (id, tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv')", st1, tenant, unternehmen);
        adminJdbc.update("INSERT INTO standort (id, tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, ?, 'Werk Lindach', 'ST-2', 'Europe/Berlin', 'aktiv')", st2, tenant, unternehmen);
        adminJdbc.update("INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, 'Halle 1', 'DE-LU')",
                anlage1, tenant);
        adminJdbc.update("INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, 'Halle 2', 'DE-LU')",
                anlage2, tenant);
        adminJdbc.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, '2026-01-01')", tenant, anlage1, st1);
        adminJdbc.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, '2026-01-01')", tenant, anlage2, st2);
        adminJdbc.update("INSERT INTO device (id, tenant_id, site_id, external_ref, kind, status) "
                + "VALUES (?, ?, ?, ?, 'inverter', 'claimed')", box1, tenant, anlage1, "ref-" + box1);
        adminJdbc.update("INSERT INTO device (id, tenant_id, site_id, external_ref, kind, status) "
                + "VALUES (?, ?, ?, ?, 'inverter', 'claimed')", box2, tenant, anlage2, "ref-" + box2);
        return new Welt(tenant, unternehmen, st1, st2, anlage1, anlage2, box1, box2);
    }

    private static void herzschlag(UUID device, Instant zeitpunkt) {
        adminJdbc.update("UPDATE device SET device_status_seen_at = ? WHERE id = ?", Timestamp.from(zeitpunkt),
                device);
    }

    // =========================================================== zustand-Leser (§6.3)

    @Test
    void zustandLeserLiestDenHerzschlagEchtUndUnbekanntIstKeineNull() {
        Welt w = welt("Zustand-Leser GmbH");
        Instant jetzt = Instant.now();
        herzschlag(w.box1(), jetzt.minusSeconds(10));
        DeviceRepository geraete = new DeviceRepository(app);
        DeviceDataSourceStatusRepository quellen = new DeviceDataSourceStatusRepository(app);
        ZustandWerteLeser leser = new ZustandWerteLeser(geraete, quellen);
        WerteKatalog katalog = new WerteKatalog();

        TenantContext.set(w.tenant());
        try {
            WerteLeser.Lesung frisch = leser.lese(katalog.eintrag("box.erreichbar"),
                    WerteLeser.Bezug.anlage(w.anlage1()), jetzt);
            assertThat(frisch.bekannt()).isTrue();
            assertThat(frisch.zustandswort()).isEqualTo(ZustandWerteLeser.ERREICHBAR);

            herzschlag(w.box1(), jetzt.minus(20, ChronoUnit.MINUTES));
            WerteLeser.Lesung still = leser.lese(katalog.eintrag("box.erreichbar"),
                    WerteLeser.Bezug.anlage(w.anlage1()), jetzt);
            assertThat(still.zustandswort()).isEqualTo(ZustandWerteLeser.NICHT_ERREICHBAR);

            // Anlage 2 hat noch nie einen Herzschlag gehabt: unbekannt, NIE "nicht_erreichbar".
            WerteLeser.Lesung unbekannt = leser.lese(katalog.eintrag("box.erreichbar"),
                    WerteLeser.Bezug.anlage(w.anlage2()), jetzt);
            assertThat(unbekannt.bekannt()).isFalse();
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void zustandLeserLiestDenDatenquellenStatus() {
        Welt w = welt("Datenquelle-Leser GmbH");
        UUID datenquelle = UUID.randomUUID();
        adminJdbc.update("INSERT INTO data_source (id, tenant_id, site_id, kennzeichen, name, protokoll, adresse) "
                        + "VALUES (?, ?, ?, 'DQ-1', 'Wechselrichter', 'mqtt', 'mqtt://box')",
                datenquelle, w.tenant(), w.anlage1());
        Instant jetzt = Instant.now();
        adminJdbc.update("INSERT INTO device_data_source_status (device_id, data_source_id, tenant_id, site_id, "
                        + "health, since_at, read_at, reported_at) VALUES (?, ?, ?, ?, 'stale', ?, ?, ?)",
                w.box1(), datenquelle, w.tenant(), w.anlage1(), Timestamp.from(jetzt.minusSeconds(3600)),
                Timestamp.from(jetzt.minusSeconds(3600)), Timestamp.from(jetzt));

        DeviceRepository geraete = new DeviceRepository(app);
        DeviceDataSourceStatusRepository quellen = new DeviceDataSourceStatusRepository(app);
        ZustandWerteLeser leser = new ZustandWerteLeser(geraete, quellen);
        WerteKatalog katalog = new WerteKatalog();

        TenantContext.set(w.tenant());
        try {
            WerteLeser.Lesung l = leser.lese(katalog.eintrag("datenquelle.liefert_daten"),
                    WerteLeser.Bezug.anlage(w.anlage1()), jetzt);
            assertThat(l.bekannt()).isTrue();
            assertThat(l.zustandswort()).isEqualTo("stale");

            WerteLeser.Lesung ohne = leser.lese(katalog.eintrag("datenquelle.liefert_daten"),
                    WerteLeser.Bezug.anlage(w.anlage2()), jetzt);
            assertThat(ohne.bekannt()).isFalse();
        } finally {
            TenantContext.clear();
        }
    }

    // =========================================================== ereignis-Leser (§6.3)

    @Test
    void ereignisLeserLiestDasJuengsteBoxEreignisImRueckschauFenster() {
        Welt w = welt("Ereignis-Leser GmbH");
        Instant jetzt = Instant.now();
        TenantContext.set(w.tenant());
        try {
            ereignis(w.tenant(), w.anlage1(), w.box1(), "box_restart", jetzt.minusSeconds(600));
            ereignis(w.tenant(), w.anlage1(), w.box1(), "box_restart", jetzt.minus(3, ChronoUnit.DAYS));

            EreignisWerteLeser leser = new EreignisWerteLeser(app, new DeviceRepository(app));
            WerteKatalog katalog = new WerteKatalog();
            WerteLeser.Lesung l = leser.lese(katalog.eintrag("box.neustarts"), WerteLeser.Bezug.anlage(w.anlage1()),
                    jetzt);
            assertThat(l.bekannt()).isTrue();
            assertThat(l.zustandswort()).isEqualTo("box_restart");
            // Der Drei-Tage-alte Neustart liegt außerhalb der Rückschau - keine zweite Box: unbekannt.
            WerteLeser.Lesung keins = leser.lese(katalog.eintrag("box.neustarts"),
                    WerteLeser.Bezug.anlage(w.anlage2()), jetzt);
            assertThat(keins.bekannt()).isFalse();
        } finally {
            TenantContext.clear();
        }
    }

    private static void ereignis(UUID tenant, UUID site, UUID device, String art, Instant zeit) {
        app.update("INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, site_id, "
                        + "kennungen, device_id) VALUES (?, ?, ?, ?, 'box', ?, jsonb_build_object('box', ?), ?)",
                Timestamp.from(zeit), tenant, UUID.randomUUID(), art, site, device.toString(), device);
    }

    // =========================================================== der Läufer über mehrere Takte (§6.5, 3B)

    private static final class Einreihung implements BenachrichtigungAusgang {
        final List<String> empfaenger = new ArrayList<>();

        @Override
        public void email(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr, String betreff,
                String inhalt, java.time.Instant naechsterVersuch) {
            empfaenger.add(empfaengerSub + ":" + anlass);
        }

        @Override
        public void webpush(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr,
                String betreff, String inhalt, java.time.Instant naechsterVersuch, String schwere) {
            empfaenger.add(empfaengerSub + ":" + anlass);
        }

        @Override
        public void webhook(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr,
                String betreff, String inhalt, java.time.Instant naechsterVersuch, String schwere) {
            empfaenger.add(empfaengerSub + ":" + anlass);
        }

        @Override
        public void telegram(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr,
                String betreff, String inhalt, java.time.Instant naechsterVersuch, String schwere) {
            empfaenger.add(empfaengerSub + ":" + anlass);
        }
    }

    @Test
    void derLaufSaetAbWerkLoestAusUndSchliesstOhneGesehenEntscheid3B() {
        Welt w = welt("Läufer GmbH");
        String ka = "KA-" + UUID.randomUUID();
        benutzerMitRolle(w.tenant(), ka, "kundenadministrator", null);
        Instant t0 = Instant.now().minusSeconds(3600);
        herzschlag(w.box1(), t0);

        UeberwachungRepository repo = new UeberwachungRepository(app);
        WerteKatalog katalog = new WerteKatalog();
        ZustandWerteLeser zustandLeser = new ZustandWerteLeser(new DeviceRepository(app),
                new DeviceDataSourceStatusRepository(app));
        ZugriffRepository zugriffe = new ZugriffRepository(app);
        // Dieser Lauf übt nur den zustand-Leser (box.erreichbar) aus - die Scheibe-2-Leser bleiben Mocks.
        UeberwachungsService dienst = new UeberwachungsService(repo, katalog, zustandLeser,
                org.mockito.Mockito.mock(EreignisWerteLeser.class), org.mockito.Mockito.mock(AnlagenflussWerteLeser.class),
                org.mockito.Mockito.mock(MessreiheWerteLeser.class), org.mockito.Mockito.mock(MengeWerteLeser.class),
                org.mockito.Mockito.mock(GeldWerteLeser.class), zugriffe,
                org.mockito.Mockito.mock(com.voltpilot.api.repo.PriceRepository.class),
                org.mockito.Mockito.mock(com.voltpilot.api.repo.PeakShavingRepository.class));
        Einreihung einreihung = new Einreihung();
        dienst.setAusgang(einreihung);

        TenantContext.set(w.tenant());
        try {
            // T0: beide Boxen leben, Aussaat sät "box.erreichbar" ab Werk (Entscheid 2A) für beide Anlagen,
            // nichts ausgelöst (Anlage 2 wartet noch auf ihren ersten Herzschlag - unbekannt, nie ausgelöst).
            dienst.lauf(t0);
            assertThat(app.queryForObject("SELECT count(*) FROM ueberwachung WHERE wertart = 'box.erreichbar' "
                    + "AND herkunft = 'ab_werk'", Integer.class)).isEqualTo(2);

            // T1 = t0 + 400 s: die Herzschlag-Toleranz (300 s) ist überschritten -> "ausstehend", die
            // Dauer (900 s) läuft erst ab JETZT (periodische Auswertung, wie jeder Takt - §9).
            Instant t1 = t0.plusSeconds(400);
            dienst.lauf(t1);
            assertThat(app.queryForObject("SELECT count(*) FROM alarm WHERE zustand <> 'erledigt'", Integer.class))
                    .isEqualTo(0);

            // T1b = t1 + 901 s: die Box schweigt immer noch seit t0 -> Dauer erreicht -> ausgelöst.
            Instant t1b = t1.plusSeconds(901);
            dienst.lauf(t1b);
            assertThat(app.queryForObject("SELECT count(*) FROM alarm WHERE zustand <> 'erledigt'", Integer.class))
                    .isEqualTo(1);
            assertThat(einreihung.empfaenger).anyMatch(e -> e.startsWith(ka + ":ausgeloest"));

            // T2: die Box meldet sich wieder (frischer Herzschlag) -> erholend -> nach 5 Min wieder normal.
            Instant t2 = t1b.plusSeconds(60);
            herzschlag(w.box1(), t2);
            dienst.lauf(t2);
            // Die Box bleibt während der Erholdauer am Leben (sonst würde sie nach 300 s erneut als
            // "nicht erreichbar" gelesen - die Herzschlag-Toleranz ist dieselbe Dauer wie die Erholdauer).
            Instant t3 = t2.plusSeconds(301);
            herzschlag(w.box1(), t3);
            dienst.lauf(t3);

            // 3B: KEINE Quittierungspflicht - der Alarm ist erledigt, ohne dass irgendjemand "Gesehen" hat.
            assertThat(app.queryForObject("SELECT count(*) FROM alarm WHERE zustand = 'erledigt' "
                    + "AND gesehen_von IS NULL", Integer.class)).isEqualTo(1);
            assertThat(einreihung.empfaenger).anyMatch(e -> e.startsWith(ka + ":wieder_normal"));
        } finally {
            TenantContext.clear();
        }
    }

    /** benutzer/zugriff sind nur über die Laufzeitrolle schreibbar (RLS); die Admin-Rolle hat kein INSERT. */
    private static void benutzerMitRolle(UUID tenant, String sub, String rolle, UUID standort) {
        TenantContext.set(tenant);
        try {
            app.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) "
                    + "VALUES (?, ?, 'benutzer', ?, 'aktiv')", tenant, sub, sub);
            app.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                    + "VALUES (?, ?, ?, ?, now() - interval '1 day', 'Europe/Berlin')", tenant, sub, rolle, standort);
        } finally {
            TenantContext.clear();
        }
    }

    // =========================================================== Scheibe 2: komponente-Bezug, freie Schwelle (§6.4)

    @Test
    void einUeberBedingungAufEinerKomponenteLoestUeberDenVollenLaufAus() {
        Welt w = welt("Scheibe-2-Komponente GmbH");
        UUID komponente = UUID.randomUUID();
        Instant jetzt = Instant.now();
        adminJdbc.update("INSERT INTO measurement_point (id, tenant_id, site_id, role, label) "
                + "VALUES (?, ?, ?, 'pv-generation', 'Vorlauf')", komponente, w.tenant(), w.anlage1());
        TenantContext.set(w.tenant());
        try {
            app.update("INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, entity_id, "
                    + "channel, value) VALUES (?, ?, ?, ?, ?, ?, 'vorlauf_c', 61.0)",
                    Timestamp.from(jetzt), Timestamp.from(jetzt), w.tenant(), w.anlage1(), w.box1(),
                    komponente.toString());
            UUID regel = UUID.randomUUID();
            app.update("INSERT INTO ueberwachung (id, tenant_id, standort_id, wertart, bezug, bedingung, schwere, "
                    + "empfaenger, herkunft, angelegt_von) VALUES (?, ?, ?, 'geraet.messwert', "
                    + "jsonb_build_object('komponente', ?::text, 'kanal', 'vorlauf_c'), "
                    + "'{\"art\":\"ueber\",\"schwelle\":55,\"rueckkehr\":50,\"dauer_s\":0,\"erholen_s\":0}'::jsonb, "
                    + "'warnung', '[{\"person\":\"sub-dora\"}]'::jsonb, 'eigen', 'sub-dora')",
                    regel, w.tenant(), w.st1(), komponente);

            UeberwachungRepository repo = new UeberwachungRepository(app);
            // Die ab-Werk-Aussaat (box.erreichbar, datenquelle.liefert_daten) läuft in JEDEM Takt mit -
            // ihre Leser müssen "unbekannt" statt null liefern, sonst NPE in der Auswertung dieser Regeln.
            ZustandWerteLeser zustandMock = org.mockito.Mockito.mock(ZustandWerteLeser.class);
            EreignisWerteLeser ereignisMock = org.mockito.Mockito.mock(EreignisWerteLeser.class);
            AnlagenflussWerteLeser anlagenflussMock = org.mockito.Mockito.mock(AnlagenflussWerteLeser.class);
            org.mockito.Mockito.when(zustandMock.lese(org.mockito.ArgumentMatchers.any(),
                    org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any()))
                    .thenReturn(WerteLeser.Lesung.unbekannt());
            org.mockito.Mockito.when(ereignisMock.lese(org.mockito.ArgumentMatchers.any(),
                    org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any()))
                    .thenReturn(WerteLeser.Lesung.unbekannt());
            org.mockito.Mockito.when(anlagenflussMock.lese(org.mockito.ArgumentMatchers.any(),
                    org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any()))
                    .thenReturn(WerteLeser.Lesung.unbekannt());
            UeberwachungsService dienst = new UeberwachungsService(repo, new WerteKatalog(), zustandMock,
                    ereignisMock, anlagenflussMock,
                    new MessreiheWerteLeser(new com.voltpilot.api.topology.TopologyRepository(app), repo),
                    org.mockito.Mockito.mock(MengeWerteLeser.class), org.mockito.Mockito.mock(GeldWerteLeser.class),
                    new ZugriffRepository(app), org.mockito.Mockito.mock(com.voltpilot.api.repo.PriceRepository.class),
                    org.mockito.Mockito.mock(com.voltpilot.api.repo.PeakShavingRepository.class));
            Einreihung einreihung = new Einreihung();
            dienst.setAusgang(einreihung);

            dienst.lauf(jetzt); // normal -> ausstehend (61 > 55)
            dienst.lauf(jetzt); // dauer_s = 0: sofort ausgelöst

            List<Map<String, Object>> alarme = app.queryForList(
                    "SELECT standort_id, wertart FROM alarm WHERE ueberwachung_id = ?", regel);
            assertThat(alarme).hasSize(1);
            assertThat(alarme.get(0).get("standort_id")).isEqualTo(w.st1());
            assertThat(einreihung.empfaenger).anyMatch(e -> e.startsWith("sub-dora:ausgeloest"));
        } finally {
            TenantContext.clear();
        }
    }

    /**
     * Der 30-Tage-Probelauf über den vollen Lauf (§6.4, §6.8 Entwurf 1): während
     * {@code probelauf_bis} in der Zukunft liegt, wertet der Läufer ganz normal aus (Alarm-Zeile,
     * Verlauf) - aber versendet nichts; "jetzt scharf schalten" beendet den Probelauf, und derselbe
     * Zustandsübergang versendet danach wie jede andere Regel.
     */
    @Test
    void eineRegelImProbelaufWertetAberVersendetNichtBisZumScharfSchalten() {
        Welt w = welt("Probelauf GmbH");
        UUID komponente = UUID.randomUUID();
        Instant jetzt = Instant.now();
        adminJdbc.update("INSERT INTO measurement_point (id, tenant_id, site_id, role, label) "
                + "VALUES (?, ?, ?, 'pv-generation', 'Vorlauf')", komponente, w.tenant(), w.anlage1());
        TenantContext.set(w.tenant());
        try {
            app.update("INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, entity_id, "
                    + "channel, value) VALUES (?, ?, ?, ?, ?, ?, 'vorlauf_c', 61.0)",
                    Timestamp.from(jetzt), Timestamp.from(jetzt), w.tenant(), w.anlage1(), w.box1(),
                    komponente.toString());
            UUID regel = UUID.randomUUID();
            app.update("INSERT INTO ueberwachung (id, tenant_id, standort_id, wertart, bezug, bedingung, schwere, "
                    + "empfaenger, herkunft, angelegt_von, probelauf_bis) VALUES (?, ?, ?, 'geraet.messwert', "
                    + "jsonb_build_object('komponente', ?::text, 'kanal', 'vorlauf_c'), "
                    + "'{\"art\":\"ueber\",\"schwelle\":55,\"rueckkehr\":50,\"dauer_s\":0,\"erholen_s\":0}'::jsonb, "
                    + "'warnung', '[{\"person\":\"sub-dora\"}]'::jsonb, 'eigen', 'sub-dora', ?)",
                    regel, w.tenant(), w.st1(), komponente, Timestamp.from(jetzt.plusSeconds(10 * 24 * 3600)));

            UeberwachungRepository repo = new UeberwachungRepository(app);
            ZustandWerteLeser zustandMock = org.mockito.Mockito.mock(ZustandWerteLeser.class);
            EreignisWerteLeser ereignisMock = org.mockito.Mockito.mock(EreignisWerteLeser.class);
            AnlagenflussWerteLeser anlagenflussMock = org.mockito.Mockito.mock(AnlagenflussWerteLeser.class);
            org.mockito.Mockito.when(zustandMock.lese(org.mockito.ArgumentMatchers.any(),
                    org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any()))
                    .thenReturn(WerteLeser.Lesung.unbekannt());
            org.mockito.Mockito.when(ereignisMock.lese(org.mockito.ArgumentMatchers.any(),
                    org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any()))
                    .thenReturn(WerteLeser.Lesung.unbekannt());
            org.mockito.Mockito.when(anlagenflussMock.lese(org.mockito.ArgumentMatchers.any(),
                    org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any()))
                    .thenReturn(WerteLeser.Lesung.unbekannt());
            UeberwachungsService dienst = new UeberwachungsService(repo, new WerteKatalog(), zustandMock,
                    ereignisMock, anlagenflussMock,
                    new MessreiheWerteLeser(new com.voltpilot.api.topology.TopologyRepository(app), repo),
                    org.mockito.Mockito.mock(MengeWerteLeser.class), org.mockito.Mockito.mock(GeldWerteLeser.class),
                    new ZugriffRepository(app), org.mockito.Mockito.mock(com.voltpilot.api.repo.PriceRepository.class),
                    org.mockito.Mockito.mock(com.voltpilot.api.repo.PeakShavingRepository.class));
            Einreihung einreihung = new Einreihung();
            dienst.setAusgang(einreihung);

            dienst.lauf(jetzt); // normal -> ausstehend (61 > 55)
            dienst.lauf(jetzt); // dauer_s = 0: sofort ausgelöst, aber im Probelauf

            Map<String, Object> alarmZeile = app.queryForMap(
                    "SELECT probelauf FROM alarm WHERE ueberwachung_id = ?", regel);
            assertThat(alarmZeile.get("probelauf")).isEqualTo(true);
            assertThat(einreihung.empfaenger).as("kein Versand während des Probelaufs").isEmpty();

            // "Jetzt scharf schalten" (per Tipper statt nach 30 Tagen).
            assertThat(repo.scharfSchalten(regel)).isTrue();
            assertThat(repo.scharfSchalten(regel)).as("kein zweites Mal - der Probelauf ist schon vorbei")
                    .isFalse();

            // Ein neuer Zyklus derselben Regel: den ersten (Probelauf-)Alarm schließen (sonst verletzt
            // ein zweiter offener Alarm derselben Regel/Bezug uq_alarm_offen), zurück auf normal, dann
            // erneut ausgelöst - jetzt scharf.
            app.update("UPDATE alarm SET zustand = 'erledigt', erledigt_am = now(), erledigt_durch = 'wert' "
                    + "WHERE ueberwachung_id = ?", regel);
            app.update("UPDATE ueberwachung_instanz SET zustand = 'normal', offener_alarm = NULL "
                    + "WHERE ueberwachung_id = ?", regel);
            Instant t2 = jetzt.plusSeconds(60);
            dienst.lauf(t2);
            dienst.lauf(t2);

            assertThat(einreihung.empfaenger).as("nach dem Scharfschalten versendet derselbe Übergang")
                    .anyMatch(e -> e.startsWith("sub-dora:ausgeloest"));
        } finally {
            TenantContext.clear();
        }
    }

    // =========================================================== Mandanten- und Standort-Zaun (§6.6)

    @Test
    void mandantenZaunEineMeldungAusDemAnderenKundenbereichIstUnsichtbar() {
        Welt a = welt("Mandant A GmbH");
        Welt b = welt("Mandant B GmbH");
        UUID alarmA = alarmEinfuegen(a.tenant(), a.anlage1(), a.st1());
        alarmEinfuegen(b.tenant(), b.anlage1(), b.st1());

        TenantContext.set(a.tenant());
        try {
            List<UUID> sichtbar = app.queryForList("SELECT id FROM alarm", UUID.class);
            assertThat(sichtbar).containsExactly(alarmA);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void standortZaunEineMeldungAusSt2IstFuerEinenLeserVonSt1WederInDerListeNochImAusgang() {
        Welt w = welt("Standort-Zaun GmbH");
        UUID alarmSt1 = alarmEinfuegen(w.tenant(), w.anlage1(), w.st1());
        UUID alarmSt2 = alarmEinfuegen(w.tenant(), w.anlage2(), w.st2());

        // Weder in der Liste: ein Leser, der nur ST-1 sieht, findet die Meldung aus ST-2 nicht.
        List<UUID> gesehenVonSt1 = eng(w.tenant(), List.of(w.st1()), jdbc -> jdbc.queryForList("SELECT id FROM alarm",
                UUID.class));
        assertThat(gesehenVonSt1).containsExactly(alarmSt1);

        // Noch im Ausgang: die Sicht-Prüfung des Zustellers verweigert denselben Alarm derselben Person.
        String sub = "BE-" + UUID.randomUUID();
        benutzerMitRolle(w.tenant(), sub, "bearbeiter", w.st1());
        UeberwachungSichtPruefungImpl pruefung = new UeberwachungSichtPruefungImpl(new UeberwachungRepository(app),
                new WerteKatalog(), new ZugriffRepository(app));
        TenantContext.set(w.tenant());
        try {
            assertThat(pruefung.sichtbar(alarmSt1, sub, Instant.now())).isTrue();
            assertThat(pruefung.sichtbar(alarmSt2, sub, Instant.now())).isFalse();
        } finally {
            TenantContext.clear();
        }
    }

    /** ueberwachung/alarm sind nur über die Laufzeitrolle schreibbar (RLS); die Admin-Rolle hat kein INSERT. */
    private static UUID alarmEinfuegen(UUID tenant, UUID anlage, UUID standort) {
        TenantContext.set(tenant);
        try {
            UUID ueberwachung = UUID.randomUUID();
            app.update("INSERT INTO ueberwachung (id, tenant_id, standort_id, wertart, bezug, bedingung, "
                    + "schwere, empfaenger, herkunft, angelegt_von) VALUES (?, ?, ?, 'box.erreichbar', "
                    + "jsonb_build_object('anlage', ?::text), '{\"art\":\"zustand\"}'::jsonb, 'warnung', '[]'::jsonb, "
                    + "'ab_werk', 'system')", ueberwachung, tenant, standort, anlage);
            UUID alarm = UUID.randomUUID();
            String kennzeichen = "AL-TEST-" + alarm;
            app.update("INSERT INTO alarm (id, tenant_id, standort_id, kennzeichen, ueberwachung_id, fassung, "
                    + "bezug_kennung, wertart, schwere, ausgeloest_am) VALUES (?, ?, ?, ?, ?, 1, ?, 'box.erreichbar', "
                    + "'warnung', now())", alarm, tenant, standort, kennzeichen, ueberwachung, "anlage:" + anlage);
            return alarm;
        } finally {
            TenantContext.clear();
        }
    }

    private static <T> T eng(UUID tenant, List<UUID> standorte, Function<JdbcTemplate, T> arbeit) {
        try (Connection c = ds(APP, PW).getConnection()) {
            setTenant(c, tenant);
            try (PreparedStatement ps = c.prepareStatement(
                    "SELECT set_config('app.zugriff', ?, false), set_config('app.standort_ids', ?, false)")) {
                ps.setString(1, standorte == null ? "unternehmen" : "standorte");
                ps.setString(2, standorte == null ? null
                        : "{" + String.join(",", standorte.stream().map(UUID::toString).toList()) + "}");
                ps.execute();
            }
            return arbeit.apply(new JdbcTemplate(new SingleConnectionDataSource(c, true)));
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    private static void setTenant(Connection c, UUID tenant) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement("SELECT set_config('app.tenant_id', ?, false)")) {
            ps.setString(1, tenant.toString());
            ps.execute();
        }
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
