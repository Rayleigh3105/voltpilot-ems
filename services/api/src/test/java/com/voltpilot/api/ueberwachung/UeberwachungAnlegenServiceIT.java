package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.web.dto.UeberwachungDto;
import com.voltpilot.api.zugriff.RechtFehlt;
import com.voltpilot.api.zugriff.ZugriffRepository;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
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
import javax.sql.DataSource;

/**
 * "Vom Wert zur fertigen Regel: drei Taps" (Alerting Scheibe 2, Konzept §6.8) gegen echte Zeilen:
 * {@link UeberwachungAnlegenService} legt eine {@code eigen}-Überwachung an, und die Rechte-Prüfung
 * (Entscheid 5A, §6.6: {@code ueberwachung.eigene} vs. {@code ueberwachung.verwalten}) hält.
 */
@Testcontainers(disabledWithoutDocker = true)
class UeberwachungAnlegenServiceIT {

    private static final String APP = "voltpilot_app";
    private static final String ADMIN = "voltpilot_admin";
    private static final String PW = "anlegen_it_pw";
    private static final ObjectMapper JSON = new ObjectMapper();

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

    private record Welt(UUID tenant, UUID unternehmen, UUID st1, UUID anlage1) {}

    private static Welt welt(String name) {
        UUID tenant = UUID.randomUUID();
        UUID unternehmen = UUID.randomUUID();
        UUID st1 = UUID.randomUUID();
        UUID anlage1 = UUID.randomUUID();
        adminJdbc.update("INSERT INTO tenant (id, name) VALUES (?, ?)", tenant, name);
        adminJdbc.update("INSERT INTO unternehmen (id, tenant_id, name) VALUES (?, ?, ?)", unternehmen, tenant, name);
        adminJdbc.update("INSERT INTO standort (id, tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv')", st1, tenant, unternehmen);
        adminJdbc.update("INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, 'Halle 1', 'DE-LU')",
                anlage1, tenant);
        adminJdbc.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, '2026-01-01')", tenant, anlage1, st1);
        return new Welt(tenant, unternehmen, st1, anlage1);
    }

    /** benutzer/zugriff sind nur über die Laufzeitrolle schreibbar (RLS); die Admin-Rolle hat kein INSERT. */
    private static Benutzer benutzerMitRolle(UUID tenant, String sub, String rolle, UUID standort) {
        TenantContext.set(tenant);
        try {
            app.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) "
                    + "VALUES (?, ?, 'benutzer', ?, 'aktiv')", tenant, sub, sub);
            app.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                    + "VALUES (?, ?, ?, ?, now() - interval '1 day', 'Europe/Berlin')", tenant, sub, rolle, standort);
            ZugriffRepository zugriffe = new ZugriffRepository(app);
            ZugriffRepository.BenutzerSpiegel spiegel = zugriffe.spiegel(sub).orElseThrow();
            return new Benutzer(sub, spiegel.anzeigename(), spiegel.konto(), spiegel.zustand(),
                    zugriffe.wirksam(sub, Instant.now()).stream().map(ZugriffRepository.Zeile::alsZuweisung).toList());
        } finally {
            TenantContext.clear();
        }
    }

    private static UeberwachungAnlegenService dienst() {
        // Diese Fälle legen nur anlage-Bezüge an - Kennzahl/Energieziel (Scheibe 5) bleiben Mocks,
        // ihr eigener Standort-Pfad hat eine eigene IT (siehe KennzahlZaehlungWerteLeserIT).
        return new UeberwachungAnlegenService(new UeberwachungRepository(app), new WerteKatalog(),
                new ZugriffRepository(app), new com.voltpilot.api.uems.KennzahlRepository(app),
                org.mockito.Mockito.mock(com.voltpilot.api.uems.KennzahlService.class),
                org.mockito.Mockito.mock(com.voltpilot.api.uems.EnergiezielService.class));
    }

    private static JsonNode json(String text) {
        try {
            return JSON.readTree(text);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @Test
    void einLeserLegtEineEigeneUeberwachungAnMitRechtEigeneAmEigenenStandort() {
        Welt w = welt("Anlegen GmbH");
        Benutzer leser = benutzerMitRolle(w.tenant(), "sub-leser", "leser", w.st1());
        TenantContext.set(w.tenant());
        try {
            UeberwachungDto.Anlegen anfrage = new UeberwachungDto.Anlegen("box.erreichbar",
                    new UeberwachungDto.BezugEintrag(w.anlage1().toString(), null, null),
                    json("{\"art\":\"zustand\",\"ziel\":[\"nicht_erreichbar\"]}"), "warnung", null,
                    "Meine Box-Überwachung");

            UeberwachungDto neu = dienst().anlegen(anfrage, leser, Instant.now());

            assertThat(neu.herkunft()).isEqualTo("eigen");
            Map<String, Object> zeile = app.queryForMap(
                    "SELECT angelegt_von, empfaenger::text AS empfaenger, bedingung::text AS bedingung, "
                            + "standort_id FROM ueberwachung WHERE id = ?::uuid", neu.id());
            assertThat(zeile.get("angelegt_von")).isEqualTo("sub-leser");
            assertThat((String) zeile.get("empfaenger")).contains("sub-leser");
            // Vorgaben nach §9 wurden serverseitig ergänzt (die Anfrage nannte keine dauer_s/erholen_s).
            JsonNode bedingung = json((String) zeile.get("bedingung"));
            assertThat(bedingung.path("dauer_s").asInt()).isEqualTo(300);
            assertThat(bedingung.path("erholen_s").asInt()).isEqualTo(300);
            assertThat(zeile.get("standort_id")).isEqualTo(w.st1());
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void inUeberwachungUmwandelnLegtEineRegelMitHerkunftSteuerungAn() {
        Welt w = welt("Umwandeln GmbH");
        Benutzer leser = benutzerMitRolle(w.tenant(), "sub-leser-umwandeln", "leser", w.st1());
        TenantContext.set(w.tenant());
        try {
            UeberwachungDto.Anlegen anfrage = new UeberwachungDto.Anlegen("box.erreichbar",
                    new UeberwachungDto.BezugEintrag(w.anlage1().toString(), null, null),
                    json("{\"art\":\"zustand\",\"ziel\":[\"nicht_erreichbar\"]}"), "warnung", null,
                    "Umgewandelte Regel", "steuerung");

            UeberwachungDto neu = dienst().anlegen(anfrage, leser, Instant.now());

            assertThat(neu.herkunft()).isEqualTo("steuerung");
            String herkunft = app.queryForObject("SELECT herkunft FROM ueberwachung WHERE id = ?::uuid",
                    String.class, neu.id());
            assertThat(herkunft).isEqualTo("steuerung");
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void abWerkOderVorschlagAlsHerkunftWirdVomClientAbgelehnt() {
        Welt w = welt("Umwandeln-Ablehnung GmbH");
        Benutzer leser = benutzerMitRolle(w.tenant(), "sub-leser-umwandeln2", "leser", w.st1());
        TenantContext.set(w.tenant());
        try {
            UeberwachungDto.Anlegen anfrage = new UeberwachungDto.Anlegen("box.erreichbar",
                    new UeberwachungDto.BezugEintrag(w.anlage1().toString(), null, null),
                    json("{\"art\":\"zustand\",\"ziel\":[\"nicht_erreichbar\"]}"), "warnung", null, null, "ab_werk");

            assertThatThrownBy(() -> dienst().anlegen(anfrage, leser, Instant.now()))
                    .isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void einLeserOhneVerwaltenDarfNiemandAnderenAlsEmpfaengerEintragen() {
        Welt w = welt("Anlegen-Ablehnung GmbH");
        Benutzer leser = benutzerMitRolle(w.tenant(), "sub-leser2", "leser", w.st1());
        TenantContext.set(w.tenant());
        try {
            UeberwachungDto.Anlegen anfrage = new UeberwachungDto.Anlegen("box.erreichbar",
                    new UeberwachungDto.BezugEintrag(w.anlage1().toString(), null, null),
                    json("{\"art\":\"zustand\",\"ziel\":[\"nicht_erreichbar\"]}"), "warnung",
                    List.of(new UeberwachungDto.EmpfaengerEintrag(null, "energiemanager")), null);

            assertThatThrownBy(() -> dienst().anlegen(anfrage, leser, Instant.now()))
                    .isInstanceOf(RechtFehlt.class);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void eineBedingungsartAusserhalbDesKatalogsWirdAbgelehnt() {
        Welt w = welt("Anlegen-Validierung GmbH");
        Benutzer leser = benutzerMitRolle(w.tenant(), "sub-leser3", "leser", w.st1());
        TenantContext.set(w.tenant());
        try {
            UeberwachungDto.Anlegen anfrage = new UeberwachungDto.Anlegen("box.erreichbar",
                    new UeberwachungDto.BezugEintrag(w.anlage1().toString(), null, null),
                    json("{\"art\":\"ueber\",\"schwelle\":5}"), "warnung", null, null);

            assertThatThrownBy(() -> dienst().anlegen(anfrage, leser, Instant.now()))
                    .isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        } finally {
            TenantContext.clear();
        }
    }

    /**
     * Alerting Scheibe 5 (§6.3): eine Messstelle hat keine Anlage - der Standort kommt über
     * {@code messstelle_ort} direkt, nicht über {@code anlage_standort}. Dieselbe Rechte-Prüfung
     * ({@code ueberwachung.eigene}) wie bei einem Anlage-Bezug, nur ein anderer Standort-Pfad.
     */
    @Test
    void einLeserLegtEineEigeneUeberwachungAufEineMessstelleAnMitDemStandortDerMessstelle() {
        Welt w = welt("Messstelle-Anlegen GmbH");
        UUID messstelle = adminJdbc.queryForObject(
                "INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, "
                        + "einheit, wertart) VALUES (?, 'MS-0001', 'Halle 1 Verbrauch', 'gemessen', 'Strom', "
                        + "'Wirkenergie', 'Bezug', 'kWh', 'Intervallmenge') RETURNING id", UUID.class, w.tenant());
        adminJdbc.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, NULL, ?, '2020-01-01')", w.tenant(), messstelle, w.st1());
        Benutzer leser = benutzerMitRolle(w.tenant(), "sub-leser-ms", "leser", w.st1());
        TenantContext.set(w.tenant());
        try {
            UeberwachungDto.Anlegen anfrage = new UeberwachungDto.Anlegen("messstelle.beobachtung",
                    UeberwachungDto.BezugEintrag.messstelle(messstelle.toString()),
                    json("{\"art\":\"zustand\",\"ziel\":[\"liefert_nicht_seit\"]}"), "warnung", null,
                    "Meine Messstellen-Überwachung");

            UeberwachungDto neu = dienst().anlegen(anfrage, leser, Instant.now());

            assertThat(neu.herkunft()).isEqualTo("eigen");
            Map<String, Object> zeile = app.queryForMap(
                    "SELECT standort_id, bezug::text AS bezug FROM ueberwachung WHERE id = ?::uuid", neu.id());
            assertThat(zeile.get("standort_id")).isEqualTo(w.st1());
            assertThat((String) zeile.get("bezug")).contains(messstelle.toString());
        } finally {
            TenantContext.clear();
        }
    }

    // --------------------------------------------------------------------- Löschen (Abnahme-Befund)

    /** ueberwachung/alarm/alarm_verlauf sind nur über die Laufzeitrolle schreibbar (RLS). */
    private static UUID offenenAlarmEinfuegen(UUID tenant, UUID standort, UUID ueberwachungId, UUID anlage) {
        TenantContext.set(tenant);
        try {
            UUID alarm = UUID.randomUUID();
            app.update("INSERT INTO alarm (id, tenant_id, standort_id, kennzeichen, ueberwachung_id, fassung, "
                    + "bezug_kennung, wertart, schwere, ausgeloest_am) VALUES (?, ?, ?, ?, ?, 1, ?, 'box.erreichbar', "
                    + "'warnung', now())", alarm, tenant, standort, "AL-TEST-" + alarm, ueberwachungId,
                    "anlage:" + anlage);
            return alarm;
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void loeschenSchliesstOffeneAlarmeUndBehaeltDenVerlauf() {
        Welt w = welt("Löschen GmbH");
        Benutzer leser = benutzerMitRolle(w.tenant(), "sub-loeschen", "leser", w.st1());
        TenantContext.set(w.tenant());
        UUID regelId;
        UUID alarm;
        try {
            UeberwachungDto.Anlegen anfrage = new UeberwachungDto.Anlegen("box.erreichbar",
                    new UeberwachungDto.BezugEintrag(w.anlage1().toString(), null, null),
                    json("{\"art\":\"zustand\",\"ziel\":[\"nicht_erreichbar\"]}"), "warnung", null,
                    "Meine Box-Überwachung");
            regelId = UUID.fromString(dienst().anlegen(anfrage, leser, Instant.now()).id());
        } finally {
            TenantContext.clear();
        }
        alarm = offenenAlarmEinfuegen(w.tenant(), w.st1(), regelId, w.anlage1());

        TenantContext.set(w.tenant());
        try {
            dienst().loeschen(regelId, leser, Instant.now());

            Map<String, Object> regel = app.queryForMap(
                    "SELECT geloescht_am, geloescht_von FROM ueberwachung WHERE id = ?::uuid", regelId);
            assertThat(regel.get("geloescht_am")).isNotNull();
            assertThat(regel.get("geloescht_von")).isEqualTo("sub-loeschen");

            Map<String, Object> alarmZeile = app.queryForMap(
                    "SELECT zustand, erledigt_am, erledigt_durch FROM alarm WHERE id = ?::uuid", alarm);
            assertThat(alarmZeile.get("zustand")).isEqualTo("erledigt");
            assertThat(alarmZeile.get("erledigt_am")).isNotNull();
            assertThat(alarmZeile.get("erledigt_durch")).isEqualTo("regel_geloescht");

            List<String> verlaufArten = app.queryForList(
                    "SELECT art FROM alarm_verlauf WHERE alarm_id = ?::uuid ORDER BY zeitpunkt", String.class, alarm);
            assertThat(verlaufArten).containsExactly("geloescht", "erledigt");

            UeberwachungRepository repo = new UeberwachungRepository(app);
            assertThat(repo.einzelneRegel(regelId)).isEmpty();
            assertThat(repo.aktive().stream().map(UeberwachungRepository.UeberwachungZeile::id)).doesNotContain(regelId);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void abWerkRegelLaesstSichUeberDieseRouteNichtLoeschen() {
        Welt w = welt("Ab-Werk-Löschung GmbH");
        Benutzer leser = benutzerMitRolle(w.tenant(), "sub-abwerk", "leser", w.st1());
        TenantContext.set(w.tenant());
        try {
            UUID regel = UUID.randomUUID();
            app.update("INSERT INTO ueberwachung (id, tenant_id, standort_id, wertart, bezug, bedingung, "
                    + "schwere, empfaenger, herkunft, angelegt_von) VALUES (?, ?, ?, 'box.erreichbar', "
                    + "jsonb_build_object('anlage', ?::text), '{\"art\":\"zustand\"}'::jsonb, 'warnung', '[]'::jsonb, "
                    + "'ab_werk', 'system')", regel, w.tenant(), w.st1(), w.anlage1());

            assertThatThrownBy(() -> dienst().loeschen(regel, leser, Instant.now()))
                    .isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void einLeserOhneVerwaltenDarfEineFremdeRegelNichtLoeschen() {
        Welt w = welt("Löschen-Ablehnung GmbH");
        Benutzer anlegende = benutzerMitRolle(w.tenant(), "sub-loeschen-anleger", "leser", w.st1());
        Benutzer fremder = benutzerMitRolle(w.tenant(), "sub-loeschen-fremd", "leser", w.st1());
        TenantContext.set(w.tenant());
        try {
            UeberwachungDto.Anlegen anfrage = new UeberwachungDto.Anlegen("box.erreichbar",
                    new UeberwachungDto.BezugEintrag(w.anlage1().toString(), null, null),
                    json("{\"art\":\"zustand\",\"ziel\":[\"nicht_erreichbar\"]}"), "warnung", null,
                    "Fremde Überwachung");
            UUID regel = UUID.fromString(dienst().anlegen(anfrage, anlegende, Instant.now()).id());

            assertThatThrownBy(() -> dienst().loeschen(regel, fremder, Instant.now()))
                    .isInstanceOf(RechtFehlt.class);
        } finally {
            TenantContext.clear();
        }
    }

    /** Mandanten-Zaun (RLS): eine Regel aus einem anderen Kundenbereich bleibt unsichtbar, auch beim Löschen. */
    @Test
    void eineRegelEinesAnderenMandantenIstBeimLoeschenNichtSichtbar() {
        Welt a = welt("Löschen Mandant A GmbH");
        Welt b = welt("Löschen Mandant B GmbH");
        Benutzer leserA = benutzerMitRolle(a.tenant(), "sub-loeschen-a", "leser", a.st1());
        Benutzer leserB = benutzerMitRolle(b.tenant(), "sub-loeschen-b", "leser", b.st1());
        TenantContext.set(a.tenant());
        UUID regel;
        try {
            UeberwachungDto.Anlegen anfrage = new UeberwachungDto.Anlegen("box.erreichbar",
                    new UeberwachungDto.BezugEintrag(a.anlage1().toString(), null, null),
                    json("{\"art\":\"zustand\",\"ziel\":[\"nicht_erreichbar\"]}"), "warnung", null,
                    "Mandant-A-Überwachung");
            regel = UUID.fromString(dienst().anlegen(anfrage, leserA, Instant.now()).id());
        } finally {
            TenantContext.clear();
        }

        TenantContext.set(b.tenant());
        try {
            assertThatThrownBy(() -> dienst().loeschen(regel, leserB, Instant.now()))
                    .isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
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
