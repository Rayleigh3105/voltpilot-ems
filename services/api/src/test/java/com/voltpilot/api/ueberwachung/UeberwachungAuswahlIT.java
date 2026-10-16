package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.optimizer.OptimizerProperties;
import com.voltpilot.api.repo.EarningsRepository;
import com.voltpilot.api.repo.PeakShavingRepository;
import com.voltpilot.api.repo.PriceRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.versand.VersandRepository;
import com.voltpilot.api.versand.Zusteller;
import com.voltpilot.api.zugriff.ZugriffRepository;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Alerting Scheibe 4 (Konzept vp-alerting-konzept-m1 §7 "Testcontainers-IT ... für Auswahl-Instanzen
 * (neuer Bezug sofort überwacht; Meldung je Bezug), Bündelung, Unterdrückung unter der Box, und den
 * Mandanten- UND Standort-Zaun") gegen echte Zeilen und den echten {@link UeberwachungsService}/
 * {@link Zusteller} - kein Mock der Auswertung oder des Versands.
 */
@Testcontainers(disabledWithoutDocker = true)
class UeberwachungAuswahlIT {

    private static final String APP = "voltpilot_app";
    private static final String ADMIN = "voltpilot_admin";
    private static final String PW = "auswahl_it_pw";

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

    private static DataSource ds(String user, String pw) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(pw);
        return ds;
    }

    private record Welt(UUID tenant, UUID st1, UUID st2, UUID anlage1, UUID anlage2, UUID anlage3) {}

    private static Welt welt(String name) {
        UUID tenant = UUID.randomUUID();
        UUID unternehmen = UUID.randomUUID();
        UUID st1 = UUID.randomUUID();
        UUID st2 = UUID.randomUUID();
        UUID anlage1 = UUID.randomUUID();
        UUID anlage2 = UUID.randomUUID();
        UUID anlage3 = UUID.randomUUID();
        adminJdbc.update("INSERT INTO tenant (id, name) VALUES (?, ?)", tenant, name);
        adminJdbc.update("INSERT INTO unternehmen (id, tenant_id, name) VALUES (?, ?, ?)", unternehmen, tenant, name);
        adminJdbc.update("INSERT INTO standort (id, tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv')", st1, tenant, unternehmen);
        adminJdbc.update("INSERT INTO standort (id, tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, ?, 'Werk Lindach', 'ST-2', 'Europe/Berlin', 'aktiv')", st2, tenant, unternehmen);
        anlage(tenant, anlage1, "Halle 1", st1);
        anlage(tenant, anlage2, "Halle 2", st1);
        anlage(tenant, anlage3, "Halle 3", st2);
        return new Welt(tenant, st1, st2, anlage1, anlage2, anlage3);
    }

    private static void anlage(UUID tenant, UUID anlageId, String name, UUID standortId) {
        adminJdbc.update("INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, ?, 'DE-LU')", anlageId,
                tenant, name);
        adminJdbc.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, '2026-01-01')", tenant, anlageId, standortId);
        UUID box = UUID.randomUUID();
        // Herzschlag weit in der Vergangenheit, nicht NULL - eine Box, die NIE gemeldet hat, ist
        // UNBEKANNT (Befund 1, ZustandWerteLeser.boxErreichbar), nicht "nicht erreichbar".
        adminJdbc.update("INSERT INTO device (id, tenant_id, site_id, external_ref, kind, status, "
                + "device_status_seen_at) VALUES (?, ?, ?, ?, 'inverter', 'claimed', ?)", box, tenant, anlageId,
                "ref-" + box, Timestamp.from(Instant.now().minusSeconds(3600)));
    }

    /** Über die RLS-Verbindung ({@code app}), nicht {@code adminJdbc} - die Admin-Rolle hat auf
     * {@code ueberwachung} nur SELECT/DELETE (Migration V20261015130000); der Aufrufer muss
     * {@code TenantContext.set(tenant)} schon gesetzt haben. */
    private static UUID auswahlRegel(UUID tenant, UUID standortFuerZaun, String bezugJson, String empfaengerSub) {
        UUID id = UUID.randomUUID();
        app.update("""
                INSERT INTO ueberwachung (id, tenant_id, standort_id, name, wertart, bezug, bedingung, schwere,
                       empfaenger, herkunft, aktiv, angelegt_von)
                VALUES (?, ?, ?, 'Box meldet sich nicht (Auswahl)', 'box.erreichbar', ?::jsonb,
                       '{"art":"zustand","ziel":["nicht_erreichbar"],"dauer_s":0,"erholen_s":300}'::jsonb,
                       'warnung', ?::jsonb, 'eigen', true, 'test')
                """, id, tenant, standortFuerZaun, bezugJson, "[{\"person\":\"" + empfaengerSub + "\"}]");
        return id;
    }

    private static UeberwachungsService dienst() {
        UeberwachungRepository repo = new UeberwachungRepository(app);
        WerteKatalog katalog = new WerteKatalog();
        ZustandWerteLeser zustandLeser = new ZustandWerteLeser(new com.voltpilot.api.repo.DeviceRepository(app),
                new com.voltpilot.api.uems.DeviceDataSourceStatusRepository(app));
        MessreiheWerteLeser messreiheLeser = new MessreiheWerteLeser(
                new com.voltpilot.api.topology.TopologyRepository(app), repo);
        EarningsRepository earnings = new EarningsRepository(app, new OptimizerProperties(4.0, 0.3, null, null, false));
        PeakShavingRepository peaks = new PeakShavingRepository(app);
        ZugriffRepository zugriffe = new ZugriffRepository(app);
        UeberwachungsService dienst = new UeberwachungsService(repo, katalog, zustandLeser,
                Mockito.mock(EreignisWerteLeser.class), Mockito.mock(AnlagenflussWerteLeser.class), messreiheLeser,
                new MengeWerteLeser(earnings, peaks, app), new GeldWerteLeser(earnings, app),
                Mockito.mock(KennzahlWerteLeser.class), Mockito.mock(ZaehlungWerteLeser.class), zugriffe,
                Mockito.mock(PriceRepository.class), peaks, Mockito.mock(com.voltpilot.api.uems.MessstelleRepository.class),
                Mockito.mock(com.voltpilot.api.uems.KennzahlService.class),
                Mockito.mock(com.voltpilot.api.uems.EnergiezielService.class));
        VersandRepository versand = new VersandRepository(app, adminJdbc);
        dienst.setAusgang(versand);
        return dienst;
    }

    @Test
    void eineStandortbeschraenkteAuswahlTrifftNurIhreAnlagenUndNeueKommenSofortDazu() {
        Welt w = welt("Auswahl GmbH");
        String ka = "sub-" + UUID.randomUUID();
        UeberwachungsService dienst = dienst();

        TenantContext.set(w.tenant());
        try {
            UUID regelId = auswahlRegel(w.tenant(), w.st1(),
                    "{\"standort\":\"" + w.st1() + "\",\"alle\":\"anlage\"}", ka);
            Instant t0 = Instant.now();
            dienst.lauf(t0); // normal -> ausstehend für anlage1 und anlage2 (anlage3 ist ST-2, nicht betroffen)
            dienst.lauf(t0); // ausstehend -> aktiv (Dauer 0)

            assertThat(app.queryForObject("SELECT count(*) FROM alarm WHERE ueberwachung_id = ? AND zustand <> 'erledigt'",
                    Integer.class, regelId)).isEqualTo(2);
            assertThat(app.queryForList("SELECT bezug_kennung FROM alarm WHERE ueberwachung_id = ?", String.class,
                    regelId)).containsExactlyInAnyOrder("anlage:" + w.anlage1(), "anlage:" + w.anlage2());

            // Eine neue Anlage DESSELBEN Standorts ist OHNE Regeländerung sofort mit überwacht (§6.4).
            UUID anlage4 = UUID.randomUUID();
            anlage(w.tenant(), anlage4, "Halle 4", w.st1());
            Instant t1 = t0.plusSeconds(5);
            dienst.lauf(t1);
            dienst.lauf(t1);

            assertThat(app.queryForObject("SELECT count(*) FROM alarm WHERE ueberwachung_id = ? AND zustand <> 'erledigt'",
                    Integer.class, regelId)).isEqualTo(3);
            assertThat(app.queryForObject("SELECT count(*) FROM alarm WHERE ueberwachung_id = ? AND bezug_kennung = ?",
                    Integer.class, regelId, "anlage:" + anlage4)).isEqualTo(1);

            // Standort-Zaun (§6.6): keine Zeile für die Anlage des anderen Standorts (ST-2).
            assertThat(app.queryForObject("SELECT count(*) FROM alarm WHERE ueberwachung_id = ? AND bezug_kennung = ?",
                    Integer.class, regelId, "anlage:" + w.anlage3())).isEqualTo(0);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void zweiGleichzeitigAusgeloesteBezuegeDerselbenAuswahlBekommenDenselbenBuendelSchluesselUndEineNachricht() {
        Welt w = welt("Buendel GmbH");
        String ka = "sub-" + UUID.randomUUID();
        UeberwachungsService dienst = dienst();

        TenantContext.set(w.tenant());
        try {
            auswahlRegel(w.tenant(), null, "{\"alle\":\"anlage\"}", ka);
            Instant t0 = Instant.now();
            dienst.lauf(t0);
            dienst.lauf(t0);

            List<String> schluessel = app.queryForList(
                    "SELECT DISTINCT buendel_schluessel FROM benachrichtigung WHERE quelle = 'alarm' "
                            + "AND anlass = 'ausgeloest'", String.class);
            assertThat(schluessel).hasSize(1);
            assertThat(schluessel.get(0)).isNotNull();

            long zeilen = app.queryForObject("SELECT count(*) FROM benachrichtigung WHERE quelle = 'alarm' "
                    + "AND anlass = 'ausgeloest' AND weg = 'email'", Long.class);
            // Diese Welt hat drei Anlagen (anlage1/2 an ST-1, anlage3 an ST-2); die Auswahl ist
            // unternehmensweit ("alle":"anlage", kein Standort) - je Anlage eine Zeile im Ausgang,
            // aber EIN gemeinsamer Bündel-Schlüssel.
            assertThat(zeilen).isEqualTo(3);

            // Der Versand ist auf das Ende des 30-s-Bündelfensters verzögert (§6.4 Nr. 6) - nicht
            // sofort fällig, damit ein zweiter, fast gleichzeitiger Auslöser noch dazukommt. Wie der
            // Zusteller mehrere Zeilen desselben Schlüssels zu EINER Nachricht zusammenfasst (nur aus
            // den für den Empfänger sichtbaren), prüft ZustellerTest rein, ohne Datenbank.
            long nochNichtFaellig = app.queryForObject("SELECT count(*) FROM benachrichtigung "
                    + "WHERE quelle = 'alarm' AND anlass = 'ausgeloest' AND weg = 'email' AND naechster_versuch > ?",
                    Long.class, Timestamp.from(t0.plusSeconds(1)));
            assertThat(nochNichtFaellig).isEqualTo(3);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void eineAbhaengigeMeldungWirdNichtVersendetWennDieBoxDerselbenAnlageNichtMeldet() {
        Welt w = welt("Abhaengig GmbH");
        String ka = "sub-" + UUID.randomUUID();
        UeberwachungsService dienst = dienst();

        TenantContext.set(w.tenant());
        try {
            UUID boxRegel = auswahlRegel(w.tenant(), null, "{\"anlage\":\"" + w.anlage1() + "\"}", ka);
            UUID komponente = UUID.randomUUID();
            app.update("INSERT INTO measurement_point (id, tenant_id, site_id, role, label) "
                    + "VALUES (?, ?, ?, 'pv-generation', 'Testkanal')", komponente, w.tenant(), w.anlage1());
            UUID deviceRegel = UUID.randomUUID();
            app.update("""
                    INSERT INTO ueberwachung (id, tenant_id, name, wertart, bezug, bedingung, schwere, empfaenger,
                           herkunft, aktiv, angelegt_von)
                    VALUES (?, ?, 'PV ohne Daten', 'geraet.messwert', ?::jsonb,
                           '{"art":"keine_daten","dauer_s":0,"erholen_s":300}'::jsonb, 'warnung', ?::jsonb, 'eigen',
                           true, 'test')
                    """, deviceRegel, w.tenant(),
                    "{\"komponente\":\"" + komponente + "\",\"kanal\":\"leistung_kw\"}",
                    "[{\"person\":\"" + ka + "\"}]");
            Instant t0 = Instant.now();
            dienst.lauf(t0); // beide Regeln: normal -> ausstehend (keine Herzschlag, keine Messwerte)
            dienst.lauf(t0); // ausstehend -> aktiv

            Integer boxAlarmCount = app.queryForObject(
                    "SELECT count(*) FROM alarm WHERE ueberwachung_id = ? AND zustand <> 'erledigt'", Integer.class,
                    boxRegel);
            assertThat(boxAlarmCount).isEqualTo(1);
            UUID boxAlarmId = app.queryForObject("SELECT id FROM alarm WHERE ueberwachung_id = ?", UUID.class,
                    boxRegel);

            UUID deviceAlarmId = app.queryForObject("SELECT id FROM alarm WHERE ueberwachung_id = ?", UUID.class,
                    deviceRegel);
            UUID unterdrueckDurch = app.queryForObject(
                    "SELECT unterdrueckt_durch FROM alarm WHERE ueberwachung_id = ?", UUID.class, deviceRegel);
            assertThat(unterdrueckDurch).isEqualTo(boxAlarmId);
            long versandZeilenFuerAbhaengigen = app.queryForObject(
                    "SELECT count(*) FROM benachrichtigung WHERE quelle_id = ?", Long.class, deviceAlarmId);
            assertThat(versandZeilenFuerAbhaengigen).isEqualTo(0); // keine eigene Nachricht

            long versandZeilenFuerBox = app.queryForObject(
                    "SELECT count(*) FROM benachrichtigung WHERE quelle_id = ?", Long.class, boxAlarmId);
            assertThat(versandZeilenFuerBox).isGreaterThan(0); // die Box selbst meldet ganz normal
        } finally {
            TenantContext.clear();
        }
    }
}
