package com.voltpilot.api.versand;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
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
 * Einstellungen Scheibe 2 (Konzept-Bericht §4.12): die neuen {@link ZustellwegRepository}-Methoden
 * gegen eine echte Datenbank - E-Mail an/aus/entfernen (B12, braucht das neue DELETE-Grant der
 * Migration {@code V20261019120000}), Geräte-Endpunkt und Umbenennen, Team-Kanal bearbeiten, der
 * wiederverwendete offene Telegram-Versuch (B10) und das Löschen aller Wege einer Person (B13).
 * Testcontainers, Docker nötig.
 */
@Testcontainers(disabledWithoutDocker = true)
class ZustellwegRepositoryScheibe2IT {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate adminJdbc;
    private static ZustellwegRepository zustellwege;
    private static UUID tenant;

    @BeforeAll
    static void aufbauen() {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW, "adminDbUser", ADMIN_USER,
                        "adminDbPassword", ADMIN_PW))
                .load().migrate();
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        JdbcTemplate appJdbc = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        adminJdbc = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        zustellwege = new ZustellwegRepository(appJdbc, adminJdbc);
        tenant = root.queryForObject("INSERT INTO tenant (name) VALUES ('Scheibe2-Test') RETURNING id", UUID.class);
    }

    @AfterEach
    void aufraeumen() {
        adminJdbc.update("DELETE FROM zustellweg WHERE tenant_id = ?", tenant);
        adminJdbc.update("DELETE FROM push_abo WHERE tenant_id = ?", tenant);
        adminJdbc.update("DELETE FROM webhook_ziel WHERE tenant_id = ?", tenant);
        adminJdbc.update("DELETE FROM telegram_ziel WHERE tenant_id = ?", tenant);
        TenantContext.clear();
    }

    // --------------------------------------------------------------------- E-Mail: B12

    @Test
    void emailAktivSetzenSchaltetAbUndWiederAnOhneDieAdresseZuVerlieren() {
        TenantContext.set(tenant);
        zustellwege.anlegenOderErneuern("sub-b12", "b12@example.test", "tok-b12", Instant.now().plusSeconds(3600));

        assertThat(zustellwege.emailAktivSetzen("sub-b12", false)).isTrue();
        assertThat(zustellwege.eigener("sub-b12")).get().extracting(ZustellwegRepository.Zustellweg::aktiv)
                .isEqualTo(false);
        assertThat(zustellwege.eigener("sub-b12")).get().extracting(ZustellwegRepository.Zustellweg::ziel)
                .isEqualTo("b12@example.test");

        assertThat(zustellwege.emailAktivSetzen("sub-b12", true)).isTrue();
        assertThat(zustellwege.eigener("sub-b12")).get().extracting(ZustellwegRepository.Zustellweg::aktiv)
                .isEqualTo(true);
    }

    @Test
    void emailAktivSetzenOhneZeileAendertNichts() {
        TenantContext.set(tenant);
        assertThat(zustellwege.emailAktivSetzen("sub-ohne-weg", false)).isFalse();
    }

    @Test
    void emailEntfernenLoeschtDieZeileVollstaendig() {
        TenantContext.set(tenant);
        zustellwege.anlegenOderErneuern("sub-entfernen", "weg@example.test", "tok-weg",
                Instant.now().plusSeconds(3600));
        assertThat(zustellwege.eigener("sub-entfernen")).isPresent();

        assertThat(zustellwege.emailEntfernen("sub-entfernen")).isTrue();

        assertThat(zustellwege.eigener("sub-entfernen")).isEmpty();
        assertThat(zustellwege.emailEntfernen("sub-entfernen")).as("ein zweites Entfernen ändert nichts mehr")
                .isFalse();
    }

    // --------------------------------------------------------------------- Push: Endpunkt, Umbenennen

    @Test
    void pushAboEigeneTraegtDenEndpunktFuerDieGeraeteErkennung() {
        TenantContext.set(tenant);
        UUID id = zustellwege.pushAboAnlegen("sub-push", "https://push.example/geraet-a", "p", "a", "Erstes Gerät",
                "UA");

        var abos = zustellwege.pushAboEigene("sub-push");

        assertThat(abos).hasSize(1);
        assertThat(abos.get(0).endpoint()).isEqualTo("https://push.example/geraet-a");
        assertThat(abos.get(0).id()).isEqualTo(id);
    }

    @Test
    void pushAboNameSetzenBenennenUmNurDasEigeneGeraet() {
        TenantContext.set(tenant);
        UUID eigenes = zustellwege.pushAboAnlegen("sub-a", "https://push.example/a", "p", "a", "Altes Gerät", "UA");
        UUID fremdes = zustellwege.pushAboAnlegen("sub-b", "https://push.example/b", "p", "a", "Fremdes Gerät", "UA");

        assertThat(zustellwege.pushAboNameSetzen(eigenes, "sub-a", "iPhone von Ines")).isTrue();
        assertThat(zustellwege.pushAboNameSetzen(fremdes, "sub-a", "Übernommen")).as("fremdes Gerät bleibt unberührt")
                .isFalse();

        assertThat(zustellwege.pushAboEigene("sub-a").get(0).geraet()).isEqualTo("iPhone von Ines");
        assertThat(zustellwege.pushAboEigene("sub-b").get(0).geraet()).isEqualTo("Fremdes Gerät");
    }

    @Test
    void pushAboFuerProbeFindetNurDasEigeneGeraetMitSchluesseln() {
        TenantContext.set(tenant);
        UUID eigenes = zustellwege.pushAboAnlegen("sub-a", "https://push.example/probe", "p256dh-wert", "auth-wert",
                "Gerät", "UA");
        UUID fremdes = zustellwege.pushAboAnlegen("sub-b", "https://push.example/fremd", "p", "a", "Fremd", "UA");

        Optional<com.voltpilot.api.versand.webpush.WebPushAdapter.Abo> abo = zustellwege.pushAboFuerProbe(eigenes,
                "sub-a");
        assertThat(abo).isPresent();
        assertThat(abo.get().endpoint()).isEqualTo("https://push.example/probe");
        assertThat(abo.get().p256dh()).isEqualTo("p256dh-wert");

        assertThat(zustellwege.pushAboFuerProbe(fremdes, "sub-a")).as("ein fremdes Gerät liefert keine Probe")
                .isEmpty();
    }

    // --------------------------------------------------------------------- Webhook: bearbeiten, Probe

    @Test
    void webhookZielBearbeitenAendertAdresseUndNameDesEigenenZiels() {
        TenantContext.set(tenant);
        var neu = zustellwege.webhookZielAnlegen("sub-kanal", "https://alt.example/hook", "geheim-1", "Alt");
        UUID fremdesKanal = zustellwege.webhookZielAnlegen("sub-andere", "https://fremd.example/hook", "geheim-2",
                "Fremd");

        assertThat(zustellwege.webhookZielBearbeiten(neu, "sub-kanal", "https://neu.example/hook", "Neu")).isTrue();
        assertThat(zustellwege.webhookZielBearbeiten(fremdesKanal, "sub-kanal", "https://uebernommen.example/hook",
                "Übernommen")).as("ein fremder Kanal bleibt unberührt").isFalse();

        var eigen = zustellwege.webhookZieleEigene("sub-kanal").get(0);
        assertThat(eigen.url()).isEqualTo("https://neu.example/hook");
        assertThat(eigen.name()).isEqualTo("Neu");
        assertThat(zustellwege.webhookZieleEigene("sub-andere").get(0).url()).isEqualTo("https://fremd.example/hook");
    }

    @Test
    void webhookZielMitGeheimnisEigenLiefertDasGeheimnisNurDemEigentuemer() {
        TenantContext.set(tenant);
        var ziel = zustellwege.webhookZielAnlegen("sub-kanal", "https://alt.example/hook", "geheim-echt", "Kanal");

        var gefunden = zustellwege.webhookZielMitGeheimnisEigen(ziel, "sub-kanal");
        assertThat(gefunden).isPresent();
        assertThat(gefunden.get().geheimnis()).isEqualTo("geheim-echt");

        assertThat(zustellwege.webhookZielMitGeheimnisEigen(ziel, "sub-fremd")).isEmpty();
    }

    // --------------------------------------------------------------------- Telegram: B10

    @Test
    void einZweiterVerbindungsVersuchErneuertDenErstenStattEineZweiteOffeneZeileAnzulegen() {
        TenantContext.set(tenant);
        UUID ersterVersuch = zustellwege.telegramVerbindungAnfordern("sub-tg", "tok-1",
                Instant.now().plusSeconds(900));

        Optional<UUID> offen = zustellwege.telegramOffenerVersuch("sub-tg");
        assertThat(offen).contains(ersterVersuch);

        zustellwege.telegramVersuchErneuern(offen.get(), "tok-2", Instant.now().plusSeconds(900));

        assertThat(zustellwege.telegramZieleEigene("sub-tg")).as("immer noch nur EINE offene Zeile").hasSize(1);
        assertThat(zustellwege.telegramOffenerVersuch("sub-tg")).contains(ersterVersuch);
    }

    @Test
    void telegramOffenerVersuchIstLeerNachDerBestaetigung() {
        TenantContext.set(tenant);
        zustellwege.telegramVerbindungAnfordern("sub-tg2", "tok-bestaetigen", Instant.now().plusSeconds(900));
        TenantContext.clear(); // die Bot-Antwort hat keine Anmeldung

        assertThat(zustellwege.telegramVerbindungBestaetigen("tok-bestaetigen", "chat-99", Instant.now()))
                .isPresent();

        TenantContext.set(tenant);
        assertThat(zustellwege.telegramOffenerVersuch("sub-tg2")).as("ein bestätigter Versuch ist nicht mehr offen")
                .isEmpty();
    }

    @Test
    void telegramZielMitChatEigenBrauchtEineBestaetigteEigeneVerbindung() {
        TenantContext.set(tenant);
        UUID id = zustellwege.telegramVerbindungAnfordern("sub-tg3", "tok-unbestaetigt",
                Instant.now().plusSeconds(900));
        assertThat(zustellwege.telegramZielMitChatEigen(id, "sub-tg3")).as("noch kein chat_id").isEmpty();

        TenantContext.clear();
        zustellwege.telegramVerbindungBestaetigen("tok-unbestaetigt", "chat-123", Instant.now());

        TenantContext.set(tenant);
        var ziel = zustellwege.telegramZielMitChatEigen(id, "sub-tg3");
        assertThat(ziel).isPresent();
        assertThat(ziel.get().chatId()).isEqualTo("chat-123");
        assertThat(zustellwege.telegramZielMitChatEigen(id, "sub-fremd")).isEmpty();
    }

    // --------------------------------------------------------------------- B13: alle Wege löschen

    @Test
    void wegeEinerPersonLoeschenEntferntAlleVierArtenNurFuerDieseePerson() {
        TenantContext.set(tenant);
        zustellwege.anlegenOderErneuern("sub-entfernt", "weg@example.test", "tok", Instant.now().plusSeconds(3600));
        zustellwege.pushAboAnlegen("sub-entfernt", "https://push.example/entfernt", "p", "a", "Gerät", "UA");
        zustellwege.webhookZielAnlegen("sub-entfernt", "https://kanal.example/hook", "geheim", "Kanal");
        zustellwege.telegramVerbindungAnfordern("sub-entfernt", "tok-tg", Instant.now().plusSeconds(900));
        // eine andere Person im selben Kundenbereich bleibt unberührt
        zustellwege.anlegenOderErneuern("sub-bleibt", "bleibt@example.test", "tok-2", Instant.now().plusSeconds(3600));

        zustellwege.wegeEinerPersonLoeschen("sub-entfernt");

        assertThat(zustellwege.eigener("sub-entfernt")).isEmpty();
        assertThat(zustellwege.pushAboEigene("sub-entfernt")).isEmpty();
        assertThat(zustellwege.webhookZieleEigene("sub-entfernt")).isEmpty();
        assertThat(zustellwege.telegramZieleEigene("sub-entfernt")).isEmpty();
        assertThat(zustellwege.eigener("sub-bleibt")).isPresent();
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
