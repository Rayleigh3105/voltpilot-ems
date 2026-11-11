package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.ruhezeit.RuhezeitRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.versand.BenachrichtigungAusgang;
import com.voltpilot.api.versand.VersandRepository;
import com.voltpilot.api.versand.ZustellwegRepository;
import com.voltpilot.api.zugriff.ZugriffRepository;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
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
 * Alerting Scheibe 3: {@link ErinnerungsService} (§6.5 - 1 Stunde, dann alle 4 Stunden, höchstens
 * dreimal, endet bei "Gesehen") und {@link TagesZusammenfassungService} (§6.4 Nr. 6 - "nur wenn es
 * etwas gibt, nie leer", Dedup je Person und Tag) gegen echte Zeilen.
 */
@Testcontainers(disabledWithoutDocker = true)
class ErinnerungUndZusammenfassungIT {

    private static final String APP = "voltpilot_app";
    private static final String ADMIN = "voltpilot_admin";
    private static final String PW = "erinnerung_it_pw";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate app;
    private static JdbcTemplate adminJdbc;
    private static UeberwachungRepository repo;
    private static ZustellwegRepository zustellwege;
    private static RuhezeitRepository ruhezeitRepo;
    private static VersandRepository versandRepo;

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
        repo = new UeberwachungRepository(app);
        zustellwege = new ZustellwegRepository(app, adminJdbc);
        ruhezeitRepo = new RuhezeitRepository(app, adminJdbc);
        versandRepo = new VersandRepository(app, adminJdbc);
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    private record Welt(UUID tenant, UUID standort, UUID anlage) {}

    private static Welt welt(String name) {
        UUID tenant = UUID.randomUUID();
        UUID unternehmen = UUID.randomUUID();
        UUID standort = UUID.randomUUID();
        UUID anlage = UUID.randomUUID();
        adminJdbc.update("INSERT INTO tenant (id, name) VALUES (?, ?)", tenant, name);
        adminJdbc.update("INSERT INTO unternehmen (id, tenant_id, name) VALUES (?, ?, ?)", unternehmen, tenant, name);
        adminJdbc.update("INSERT INTO standort (id, tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv')", standort, tenant,
                unternehmen);
        adminJdbc.update("INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, 'Halle 1', 'DE-LU')",
                anlage, tenant);
        return new Welt(tenant, standort, anlage);
    }

    private static UUID regelAnlegen(Welt w, String schwere) {
        UUID regel = UUID.randomUUID();
        app.update("INSERT INTO ueberwachung (id, tenant_id, standort_id, wertart, bezug, bedingung, schwere, "
                + "empfaenger, herkunft, angelegt_von) VALUES (?, ?, ?, 'anlage.netz.leistung', "
                + "jsonb_build_object('anlage', ?::text), '{\"art\":\"ueber\",\"schwelle\":120}'::jsonb, ?, "
                + "'[{\"person\":\"sub-jonas\"}]'::jsonb, 'eigen', 'sub-jonas')",
                regel, w.tenant(), w.standort(), w.anlage(), schwere);
        return regel;
    }

    private static UUID alarmAnlegen(Welt w, UUID regel, String schwere, Instant ausgeloestAm) {
        UUID alarm = UUID.randomUUID();
        app.update("INSERT INTO alarm (id, tenant_id, standort_id, kennzeichen, ueberwachung_id, fassung, "
                + "bezug_kennung, wertart, schwere, ausgeloest_am, zustand) "
                + "VALUES (?, ?, ?, ?, ?, 1, ?, 'anlage.netz.leistung', ?, ?, 'aktiv')",
                alarm, w.tenant(), w.standort(), "AL-TEST-" + alarm.toString().substring(0, 8), regel,
                "anlage:" + w.anlage(), schwere, Timestamp.from(ausgeloestAm));
        return alarm;
    }

    private static final class Einreihung implements BenachrichtigungAusgang {
        final List<String> anlaesse = new ArrayList<>();

        @Override
        public void email(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr, String betreff,
                String inhalt, Instant naechsterVersuch) {
            anlaesse.add(empfaengerSub + ":" + anlass + ":" + nr);
        }

        @Override
        public void webpush(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr,
                String betreff, String inhalt, Instant naechsterVersuch, String schwere) {
            anlaesse.add(empfaengerSub + ":" + anlass + ":" + nr + ":push");
        }

        @Override
        public void webhook(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr,
                String betreff, String inhalt, Instant naechsterVersuch, String schwere) {
            anlaesse.add(empfaengerSub + ":" + anlass + ":" + nr + ":webhook");
        }

        @Override
        public void telegram(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr,
                String betreff, String inhalt, Instant naechsterVersuch, String schwere) {
            anlaesse.add(empfaengerSub + ":" + anlass + ":" + nr + ":telegram");
        }
    }

    // =========================================================== Erinnern (§6.5)

    @Test
    void ersteErinnerungNachEinerStundeDanachAlleVierStundenHoechstensDreimal() {
        Welt w = welt("Erinnern Takt");
        TenantContext.set(w.tenant());
        try {
            UUID regel = regelAnlegen(w, "dringend");
            Instant ausgeloest = Instant.now().minusSeconds(3700); // > 1 h
            UUID alarm = alarmAnlegen(w, regel, "dringend", ausgeloest);

            ErinnerungsService dienst = new ErinnerungsService(repo, new ZugriffRepository(app));
            Einreihung einreihung = new Einreihung();
            dienst.setAusgang(einreihung);

            int n1 = dienst.lauf(Instant.now());
            assertThat(n1).isEqualTo(1);
            assertThat(einreihung.anlaesse).anyMatch(a -> a.equals("sub-jonas:erinnerung:1"));
            assertThat(repo.alarm(alarm).orElseThrow().erinnerungenGesendet()).isEqualTo(1);

            // Sofort nochmal: die 4-Stunden-Schwelle ist noch nicht erreicht.
            einreihung.anlaesse.clear();
            int n2 = dienst.lauf(Instant.now());
            assertThat(n2).isEqualTo(0);

            // 4 Stunden und 1 Sekunde seit der ersten Erinnerung: die zweite ist fällig.
            app.update("UPDATE alarm SET letzte_erinnerung_am = ? WHERE id = ?",
                    Timestamp.from(Instant.now().minusSeconds(4 * 3600 + 1)), alarm);
            int n3 = dienst.lauf(Instant.now());
            assertThat(n3).isEqualTo(1);
            assertThat(repo.alarm(alarm).orElseThrow().erinnerungenGesendet()).isEqualTo(2);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void erinnerungEndetSobaldGesehenWurde() {
        Welt w = welt("Erinnern endet bei Gesehen");
        TenantContext.set(w.tenant());
        try {
            UUID regel = regelAnlegen(w, "dringend");
            UUID alarm = alarmAnlegen(w, regel, "dringend", Instant.now().minusSeconds(3700));
            app.update("UPDATE alarm SET gesehen_von = 'sub-jonas', gesehen_am = now() WHERE id = ?", alarm);

            ErinnerungsService dienst = new ErinnerungsService(repo, new ZugriffRepository(app));
            Einreihung einreihung = new Einreihung();
            dienst.setAusgang(einreihung);

            assertThat(dienst.lauf(Instant.now())).isEqualTo(0);
            assertThat(einreihung.anlaesse).isEmpty();
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void warnungErinnertNieVonSelbst() {
        Welt w = welt("Warnung erinnert nicht");
        TenantContext.set(w.tenant());
        try {
            UUID regel = regelAnlegen(w, "warnung");
            alarmAnlegen(w, regel, "warnung", Instant.now().minusSeconds(3700));

            ErinnerungsService dienst = new ErinnerungsService(repo, new ZugriffRepository(app));
            Einreihung einreihung = new Einreihung();
            dienst.setAusgang(einreihung);

            assertThat(dienst.lauf(Instant.now())).isEqualTo(0);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void hoechstensDreiErinnerungen() {
        Welt w = welt("Erinnern Obergrenze");
        TenantContext.set(w.tenant());
        try {
            UUID regel = regelAnlegen(w, "dringend");
            UUID alarm = alarmAnlegen(w, regel, "dringend", Instant.now().minusSeconds(3700));
            app.update("UPDATE alarm SET erinnerungen_gesendet = 3 WHERE id = ?", alarm);

            ErinnerungsService dienst = new ErinnerungsService(repo, new ZugriffRepository(app));
            dienst.setAusgang(new Einreihung());

            assertThat(dienst.lauf(Instant.now())).isEqualTo(0);
        } finally {
            TenantContext.clear();
        }
    }

    // =========================================================== Tages-Zusammenfassung (§6.4 Nr. 6)

    @Test
    void zusammenfassungWirdNurEinmalProTagVersandtUndNieLeer() {
        Welt w = welt("Zusammenfassung");
        TenantContext.set(w.tenant());
        try {
            app.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) "
                    + "VALUES (?, 'sub-ines', 'benutzer', 'Ines', 'aktiv')", w.tenant());
            String token = UUID.randomUUID().toString();
            app.update("INSERT INTO zustellweg (tenant_id, benutzer_sub, weg, ziel, bestaetigung_token, "
                    + "bestaetigung_ablauf, zusammenfassung_aktiv, zusammenfassung_uhrzeit) "
                    + "VALUES (?, 'sub-ines', 'email', 'ines@example.test', ?, now() + interval '1 day', true, ?)",
                    w.tenant(), token, LocalTime.now(java.time.ZoneId.of("Europe/Berlin")).minusMinutes(1));
            zustellwege.bestaetigen(token, Instant.now());

            UUID regel = regelAnlegen(w, "warnung");
            alarmAnlegen(w, regel, "warnung", Instant.now());

            TagesZusammenfassungService dienst = new TagesZusammenfassungService(repo, zustellwege, ruhezeitRepo,
                    versandRepo);
            Einreihung einreihung = new Einreihung();
            dienst.setAusgang(einreihung);

            int erster = dienst.lauf(Instant.now());
            assertThat(erster).isEqualTo(1);
            assertThat(einreihung.anlaesse).anyMatch(a -> a.startsWith("sub-ines:zusammenfassung"));

            einreihung.anlaesse.clear();
            int zweiter = dienst.lauf(Instant.now());
            assertThat(zweiter).isEqualTo(0); // Dedup: heute schon geschickt
            assertThat(einreihung.anlaesse).isEmpty();
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void ohneAktiveOderHeutigeMeldungenBleibtDieZusammenfassungAus() {
        Welt w = welt("Zusammenfassung leer");
        TenantContext.set(w.tenant());
        try {
            app.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) "
                    + "VALUES (?, 'sub-dora', 'benutzer', 'Dora', 'aktiv')", w.tenant());
            String token = UUID.randomUUID().toString();
            app.update("INSERT INTO zustellweg (tenant_id, benutzer_sub, weg, ziel, bestaetigung_token, "
                    + "bestaetigung_ablauf, zusammenfassung_aktiv, zusammenfassung_uhrzeit) "
                    + "VALUES (?, 'sub-dora', 'email', 'dora@example.test', ?, now() + interval '1 day', true, ?)",
                    w.tenant(), token, LocalTime.now(java.time.ZoneId.of("Europe/Berlin")).minusMinutes(1));
            zustellwege.bestaetigen(token, Instant.now());

            TagesZusammenfassungService dienst = new TagesZusammenfassungService(repo, zustellwege, ruhezeitRepo,
                    versandRepo);
            Einreihung einreihung = new Einreihung();
            dienst.setAusgang(einreihung);

            assertThat(dienst.lauf(Instant.now())).isEqualTo(0);
            assertThat(einreihung.anlaesse).isEmpty();
        } finally {
            TenantContext.clear();
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
