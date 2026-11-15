package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.PeakShavingRepository;
import com.voltpilot.api.repo.PriceRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.DeviceDataSourceStatusRepository;
import com.voltpilot.api.uems.EnergiezielService;
import com.voltpilot.api.uems.KennzahlService;
import com.voltpilot.api.uems.MessstelleRepository;
import com.voltpilot.api.versand.BenachrichtigungAusgang;
import com.voltpilot.api.zugriff.ZugriffRepository;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
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
 * Die Aussaat der Regeln ab Werk auf der echten Datenbank (Lasttest vp-lasttest, Befund B3, Rang 6): der Takt sät
 * nur, was fehlt. Jede Säe-Anweisung prallt mit {@code ON CONFLICT DO NOTHING} an {@code uq_ueberwachung_ab_werk}
 * ab; der Vorfilter liest denselben Schlüssel einmal je Kundenbereich und lässt die Anweisungen weg, die nichts
 * geändert hätten. Belegt wird: dasselbe Ergebnis wie vorher (auch das Neu-Säen einer gelöschten Regel), weniger
 * Anweisungen je Takt, die 30-Tage-Preisstatistik einmal je Zone statt je Anlage, und der Vorfilter sieht nur den
 * eigenen Kundenbereich (RLS).
 */
@Testcontainers(disabledWithoutDocker = true)
class UeberwachungAussaatIT {

    private static final String APP = "voltpilot_app";
    private static final String ADMIN = "voltpilot_admin";
    private static final String PW = "ueberwachung_aussaat_it_pw";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static final AtomicInteger ANWEISUNGEN = new AtomicInteger();
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
        app = new JdbcTemplate(new TenantAwareDataSource(zaehlend(ds(APP, PW))));
        adminJdbc = new JdbcTemplate(ds(ADMIN, PW));
        // 30 Tage Börsenpreise je Viertelstunde für die Zone der Testanlagen (die Preisreihe hat kein RLS).
        adminJdbc.update("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) "
                + "SELECT g, 'DE-LU', 'PT15M', 80 + 40 * sin(extract(epoch FROM g) / 86400.0), 'EUR', 'it' "
                + "FROM generate_series(now() - interval '29 days', now(), interval '15 minutes') g "
                + "ON CONFLICT DO NOTHING");
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    /**
     * Zählt jede Anweisung, die über eine Verbindung dieser Datenquelle geht - auch die Sitzungs-Stempel der
     * Mandantentrennung ({@code set_config}), denn auch sie sind Rundreisen zur Datenbank.
     */
    static DataSource zaehlend(DataSource ziel) {
        return new org.springframework.jdbc.datasource.DelegatingDataSource(ziel) {
            @Override
            public java.sql.Connection getConnection() throws java.sql.SQLException {
                java.sql.Connection c = super.getConnection();
                return (java.sql.Connection) java.lang.reflect.Proxy.newProxyInstance(
                        java.sql.Connection.class.getClassLoader(), new Class<?>[] {java.sql.Connection.class},
                        (proxy, methode, argumente) -> {
                            String name = methode.getName();
                            if (name.equals("prepareStatement") || name.equals("createStatement")
                                    || name.equals("prepareCall")) {
                                ANWEISUNGEN.incrementAndGet();
                            }
                            try {
                                return methode.invoke(c, argumente);
                            } catch (java.lang.reflect.InvocationTargetException e) {
                                throw e.getCause();
                            }
                        });
            }
        };
    }

    private record Kunde(UUID tenant, List<UUID> anlagen) {}

    /** Ein Privatkunde mit {@code n} Anlagen, je einer angenommenen Box, alle am selben Standort, Zone DE-LU. */
    private static Kunde kunde(String name, int n) {
        UUID tenant = UUID.randomUUID();
        UUID unternehmen = UUID.randomUUID();
        UUID standort = UUID.randomUUID();
        adminJdbc.update("INSERT INTO tenant (id, name, betriebsart) VALUES (?, ?, 'endkunde')", tenant, name);
        adminJdbc.update("INSERT INTO unternehmen (id, tenant_id, name) VALUES (?, ?, ?)", unternehmen, tenant, name);
        adminJdbc.update("INSERT INTO standort (id, tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, ?, 'Zuhause', 'ST-1', 'Europe/Berlin', 'aktiv')", standort, tenant, unternehmen);
        List<UUID> anlagen = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            UUID anlage = UUID.randomUUID();
            UUID box = UUID.randomUUID();
            adminJdbc.update("INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, ?, 'DE-LU')",
                    anlage, tenant, "Anlage " + i);
            adminJdbc.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                    + "VALUES (?, ?, ?, '2026-01-01')", tenant, anlage, standort);
            adminJdbc.update("INSERT INTO device (id, tenant_id, site_id, external_ref, kind, status, "
                    + "device_status_seen_at) VALUES (?, ?, ?, ?, 'inverter', 'claimed', ?)",
                    box, tenant, anlage, "ref-" + box, Timestamp.from(Instant.now()));
            anlagen.add(anlage);
        }
        return new Kunde(tenant, anlagen);
    }

    private record Aufbau(UeberwachungsService dienst, UeberwachungRepository repo, PriceRepository preise) {}

    /** Die Leser, die dieser Test nicht ausübt, lesen „unbekannt“ (der Preis-Hinweis liest über den Anlagenfluss). */
    private static final org.mockito.stubbing.Answer<Object> UNBEKANNT = aufruf ->
            aufruf.getMethod().getReturnType() == WerteLeser.Lesung.class
                    ? WerteLeser.Lesung.unbekannt()
                    : org.mockito.Mockito.RETURNS_DEFAULTS.answer(aufruf);

    private static Aufbau aufbau() {
        UeberwachungRepository repo = spy(new UeberwachungRepository(app));
        PriceRepository preise = spy(new PriceRepository(app));
        UeberwachungsService dienst = new UeberwachungsService(repo, new WerteKatalog(),
                new ZustandWerteLeser(new DeviceRepository(app), new DeviceDataSourceStatusRepository(app)),
                mock(EreignisWerteLeser.class, UNBEKANNT), mock(AnlagenflussWerteLeser.class, UNBEKANNT),
                mock(MessreiheWerteLeser.class, UNBEKANNT), mock(MengeWerteLeser.class, UNBEKANNT),
                mock(GeldWerteLeser.class, UNBEKANNT), mock(KennzahlWerteLeser.class, UNBEKANNT),
                mock(ZaehlungWerteLeser.class, UNBEKANNT), mock(LadepunktWerteLeser.class, UNBEKANNT),
                new ZugriffRepository(app),
                preise, mock(PeakShavingRepository.class), mock(MessstelleRepository.class),
                mock(KennzahlService.class), mock(EnergiezielService.class));
        dienst.setAusgang(BenachrichtigungAusgang.STUMM);
        return new Aufbau(dienst, repo, preise);
    }

    private static int abWerk(String wertart) {
        return app.queryForObject("SELECT count(*) FROM ueberwachung WHERE herkunft = 'ab_werk' AND wertart = ?",
                Integer.class, wertart);
    }

    @Test
    void derZweiteTaktSaetNichtsMehrUndBrauchtDafuerKeineAnweisungJeAnlage() {
        Kunde k = kunde("Aussaat GmbH", 5);
        Aufbau a = aufbau();
        Instant t0 = Instant.now().truncatedTo(ChronoUnit.SECONDS);

        TenantContext.set(k.tenant());
        ANWEISUNGEN.set(0);
        UeberwachungsService.Lauf erster = a.dienst().lauf(t0);
        int ersterTakt = ANWEISUNGEN.get();
        assertThat(erster.gesaet()).as("box.erreichbar und Preis-Hinweis je Anlage").isEqualTo(10);
        assertThat(abWerk("box.erreichbar")).isEqualTo(5);
        assertThat(abWerk("anlage.preis.jetzt")).isEqualTo(5);
        // Die Preisstatistik je Zone einmal, nicht je Anlage.
        verify(a.preise(), times(1)).summarize(anyString(), any(), any());

        clearInvocations(a.repo(), a.preise());
        ANWEISUNGEN.set(0);
        UeberwachungsService.Lauf zweiter = a.dienst().lauf(t0.plusSeconds(15));
        int zweiterTakt = ANWEISUNGEN.get();
        assertThat(zweiter.gesaet()).as("alles schon gesät").isZero();
        verify(a.repo(), never()).seedAbWerk(any(), any(), any());
        verify(a.repo(), never()).seedAbWerkPreis(any(), any(), any(), org.mockito.ArgumentMatchers.anyDouble(),
                org.mockito.ArgumentMatchers.anyDouble());
        verify(a.repo(), never()).standortHeute(any());
        verify(a.repo(), never()).biddingZone(any());
        verify(a.preise(), never()).summarize(anyString(), any(), any());
        assertThat(abWerk("box.erreichbar")).isEqualTo(5);
        assertThat(abWerk("anlage.preis.jetzt")).isEqualTo(5);
        System.out.printf("Ueberwachung je Takt, 5 Anlagen: erster Takt %d Anweisungen, zweiter Takt %d%n",
                ersterTakt, zweiterTakt);
        assertThat(zweiterTakt).isLessThan(ersterTakt);
    }

    @Test
    void eineGeloeschteRegelAbWerkWirdWieBisherImNaechstenTaktNeuGesaet() {
        Kunde k = kunde("Neu-Saat GmbH", 3);
        Aufbau a = aufbau();
        Instant t0 = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        TenantContext.set(k.tenant());
        a.dienst().lauf(t0);
        assertThat(abWerk("box.erreichbar")).isEqualTo(3);

        UUID weg = k.anlagen().get(1);
        adminJdbc.update("DELETE FROM ueberwachung WHERE tenant_id = ? AND herkunft = 'ab_werk' "
                + "AND wertart = 'box.erreichbar' AND bezug ->> 'anlage' = ?", k.tenant(), weg.toString());
        assertThat(abWerk("box.erreichbar")).isEqualTo(2);

        UeberwachungsService.Lauf l = a.dienst().lauf(t0.plusSeconds(15));
        assertThat(l.gesaet()).isEqualTo(1);
        assertThat(app.queryForList("SELECT bezug ->> 'anlage' FROM ueberwachung WHERE herkunft = 'ab_werk' "
                + "AND wertart = 'box.erreichbar'", String.class))
                .containsExactlyInAnyOrderElementsOf(k.anlagen().stream().map(UUID::toString).toList());
    }

    @Test
    void eineNeueAnlageWirdImNaechstenTaktGesaetDieAlteNicht() {
        Kunde k = kunde("Zuwachs GmbH", 2);
        Aufbau a = aufbau();
        Instant t0 = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        TenantContext.set(k.tenant());
        a.dienst().lauf(t0);

        UUID standort = app.queryForObject("SELECT standort_id FROM anlage_standort WHERE site_id = ?", UUID.class,
                k.anlagen().get(0));
        UUID neu = UUID.randomUUID();
        adminJdbc.update("INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, 'Neu', 'DE-LU')", neu,
                k.tenant());
        adminJdbc.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, '2026-01-01')", k.tenant(), neu, standort);
        adminJdbc.update("INSERT INTO device (id, tenant_id, site_id, external_ref, kind, status) "
                + "VALUES (?, ?, ?, ?, 'inverter', 'claimed')", UUID.randomUUID(), k.tenant(), neu, "ref-" + neu);

        clearInvocations(a.repo());
        UeberwachungsService.Lauf l = a.dienst().lauf(t0.plusSeconds(15));
        assertThat(l.gesaet()).as("box.erreichbar und Preis-Hinweis der neuen Anlage").isEqualTo(2);
        verify(a.repo(), times(2)).standortHeute(neu);
        verify(a.repo(), never()).standortHeute(k.anlagen().get(0));
        assertThat(app.queryForObject("SELECT standort_id FROM ueberwachung WHERE herkunft = 'ab_werk' "
                + "AND wertart = 'box.erreichbar' AND bezug ->> 'anlage' = ?", UUID.class, neu.toString()))
                .isEqualTo(standort);
    }

    /**
     * Der Vorfilter liest unter RLS: die schon gesäten Regeln eines anderen Kundenbereichs halten die Aussaat hier
     * nicht auf, und der Preis-Mittelwert (Preisreihe ohne Mandant) wird über Kundenbereiche hinweg geteilt.
     */
    @Test
    void derVorfilterSiehtNurDenEigenenKundenbereichUndDasPreismittelGiltFuerAlle() {
        Kunde eins = kunde("Eins GmbH", 2);
        Kunde zwei = kunde("Zwei GmbH", 2);
        Aufbau a = aufbau();
        Instant t0 = Instant.now().truncatedTo(ChronoUnit.SECONDS);

        TenantContext.set(eins.tenant());
        assertThat(a.dienst().lauf(t0).gesaet()).isEqualTo(4);
        TenantContext.set(zwei.tenant());
        assertThat(a.repo().abWerkGesaet()).as("RLS: nichts vom Kundenbereich eins").isEmpty();
        assertThat(a.dienst().lauf(t0.plusSeconds(1)).gesaet()).isEqualTo(4);
        verify(a.preise(), times(1)).summarize(anyString(), any(), any());

        TenantContext.clear();
        assertThat(adminJdbc.queryForObject("SELECT count(*) FROM ueberwachung WHERE herkunft = 'ab_werk' "
                + "AND tenant_id IN (?, ?)", Integer.class, eins.tenant(), zwei.tenant())).isEqualTo(8);
    }

    /**
     * „Box erreichbar“ liest je Anlage nur noch deren angenommene Boxen (vorher alle Geräte des Kundenbereichs je
     * Anlage). Dasselbe Ergebnis wie der Filter über {@code findAll()}: fremde Anlage, nicht angenommene und
     * ausgebaute Boxen zählen nicht; die älteste angenommene Box entscheidet.
     */
    @Test
    void boxErreichbarLiestNurDieBoxenDerAnlageMitDemselbenErgebnis() {
        Kunde k = kunde("Erreichbar GmbH", 2);
        UUID eins = k.anlagen().get(0);
        UUID zwei = k.anlagen().get(1);
        Instant jetzt = Instant.now();
        // Anlage zwei: Box seit 20 min still; dazu auf Anlage eins eine ausgebaute und eine nicht angenommene Box,
        // beide ebenso still - sie dürfen Anlage eins nicht auf „nicht erreichbar“ ziehen.
        adminJdbc.update("UPDATE device SET device_status_seen_at = ? WHERE site_id = ?",
                Timestamp.from(jetzt.minus(20, ChronoUnit.MINUTES)), zwei);
        adminJdbc.update("INSERT INTO device (id, tenant_id, site_id, external_ref, kind, status, device_status_seen_at, "
                + "ausgebaut_am) VALUES (?, ?, ?, ?, 'inverter', 'ausgebaut', ?, now())", UUID.randomUUID(), k.tenant(),
                eins, "ref-ausgebaut-" + eins, Timestamp.from(jetzt.minus(2, ChronoUnit.HOURS)));
        adminJdbc.update("INSERT INTO device (id, tenant_id, site_id, external_ref, kind, status, device_status_seen_at) "
                + "VALUES (?, ?, ?, ?, 'inverter', 'unclaimed', ?)", UUID.randomUUID(), k.tenant(), eins,
                "ref-frei-" + eins, Timestamp.from(jetzt.minus(2, ChronoUnit.HOURS)));

        DeviceRepository geraete = new DeviceRepository(app);
        ZustandWerteLeser leser = new ZustandWerteLeser(geraete, new DeviceDataSourceStatusRepository(app));
        WerteKatalog.Eintrag box = new WerteKatalog().eintrag("box.erreichbar");
        TenantContext.set(k.tenant());
        ANWEISUNGEN.set(0);
        assertThat(leser.lese(box, WerteLeser.Bezug.anlage(eins), jetzt).zustandswort())
                .isEqualTo(ZustandWerteLeser.ERREICHBAR);
        assertThat(ANWEISUNGEN).as("eine Abfrage je Anlage (plus die Sitzungs-Stempel)").hasValueLessThanOrEqualTo(3);
        assertThat(leser.lese(box, WerteLeser.Bezug.anlage(zwei), jetzt).zustandswort())
                .isEqualTo(ZustandWerteLeser.NICHT_ERREICHBAR);

        // Dieselben Zeilen wie der alte Weg über findAll(), gefiltert auf Anlage und „angenommen“.
        for (UUID anlage : k.anlagen()) {
            assertThat(geraete.findClaimedForSite(anlage)).containsExactlyElementsOf(geraete.findAll().stream()
                    .filter(d -> anlage.equals(d.siteId()) && "claimed".equals(d.status())).toList());
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
