package com.voltpilot.api.kundenbereich;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.TenantRepository;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die EINE Regel „keine Daten" eines Kundenbereichs ({@link KundeDatenBestand},
 * vp-kunde-sofort-loeschen) gegen echtes TimescaleDB - nach dem Muster von
 * {@code BoxEndgueltigLoeschenMigrationTest}:
 *
 * <ul>
 *   <li><b>Vollständig:</b> jede Tabelle mit {@code tenant_id} im TATSÄCHLICHEN Schema ist GENAU
 *       EINER Klasse zugeordnet, und jede eingeordnete Tabelle existiert - eine neue Tabelle ohne
 *       Eintrag fällt hier auf, BEVOR sie zur Lücke wird; im Zweifel gehört sie in die
 *       Aufzeichnungen („hat Daten").</li>
 *   <li><b>Die Abfrage läuft gegen das echte Schema:</b> ein leerer Kunde ist datenfrei; eine
 *       Telemetrie-Zeile macht ihn zu „messwerte", ein gemeldeter Herzschlag zu „herzschlag" -
 *       ohne den Nachbarn anzufassen.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
class KundeDatenBestandMigrationTest {

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
    private static KundeDatenBestandRepository bestand;

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
        bestand = new KundeDatenBestandRepository(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW)));
    }

    /**
     * Jede Tabelle mit {@code tenant_id} ist GENAU EINER Klasse zugeordnet - derselbe Katalog, über
     * den der Löschzug löscht und der Löschnachweis zählt ({@code TenantRepository.KATALOG_MIT_MANDANT}).
     * Beide Richtungen: nichts Uneingeordnetes, nichts Eingeordnetes ohne Tabelle, nichts doppelt.
     */
    @Test
    void jedeTabelleMitTenantIdIstGenauEinmalEingeordnet() {
        List<String> tabellen = root.queryForList(TenantRepository.KATALOG_MIT_MANDANT, String.class);
        assertThat(tabellen).isNotEmpty();

        List<String> unbekannt = tabellen.stream()
                .filter(t -> !KundeDatenBestand.alleEingeordneten().contains(t))
                .toList();
        assertThat(unbekannt)
                .as("Tabellen mit tenant_id ohne Einordnung in KundeDatenBestand (im Zweifel: AUFZEICHNUNGEN)")
                .isEmpty();

        List<String> verwaist = KundeDatenBestand.alleEingeordneten().stream()
                .filter(t -> !tabellen.contains(t))
                .toList();
        assertThat(verwaist).as("eingeordnete Tabellen, die es im Schema nicht (mehr) gibt").isEmpty();

        List<String> doppelt = KundeDatenBestand.AUFZEICHNUNGEN.values().stream()
                .flatMap(List::stream)
                .filter(KundeDatenBestand.BESTAND_UNBEDENKLICH::containsKey)
                .toList();
        assertThat(doppelt).as("eine Tabelle gehört GENAU einer Klasse").isEmpty();
        long aufzeichnungen = KundeDatenBestand.AUFZEICHNUNGEN.values().stream().mapToLong(List::size).sum();
        assertThat(aufzeichnungen + KundeDatenBestand.BESTAND_UNBEDENKLICH.size())
                .as("keine Tabelle doppelt innerhalb der Aufzeichnungen")
                .isEqualTo(KundeDatenBestand.alleEingeordneten().size());
    }

    @Test
    void dieAbfrageErkenntDatenfreiHerzschlagUndMesswerte() {
        UUID leer = kunde("Datenfrei");
        UUID nachbar = kunde("Nachbar");
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Zuhause') RETURNING id",
                UUID.class, leer);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status)"
                + " VALUES (?, ?, 'kdb-probe-1', 'claimed') RETURNING id", UUID.class, leer, site);
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand)"
                + " VALUES (?, 'kdb-person-1', 'benutzer', 'K. F. Wüstholz', 'aktiv')", leer);
        UUID nachbarSite = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Werk') RETURNING id",
                UUID.class, nachbar);
        UUID nachbarBox = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status)"
                + " VALUES (?, ?, 'kdb-probe-2', 'claimed') RETURNING id", UUID.class, nachbar, nachbarSite);
        root.update("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw)"
                + " VALUES (now(), ?, ?, ?, 1.0)", nachbar, nachbarSite, nachbarBox);

        KundeDatenBestandRepository.Zeile datenfrei = bestand.fuerKunde(leer).orElseThrow();
        assertThat(datenfrei.sofortLoeschbar()).as("Anlage, Box und Person sind keine Daten").isTrue();
        assertThat(datenfrei.datenarten()).isEmpty();
        assertThat(bestand.fuerKunde(nachbar).orElseThrow().datenarten()).containsExactly("messwerte");

        root.update("UPDATE device SET device_status_seen_at = now() WHERE id = ?", box);
        assertThat(bestand.fuerKunde(leer).orElseThrow().datenarten()).containsExactly("herzschlag");
        root.update("UPDATE device SET device_status_seen_at = NULL WHERE id = ?", box);
        root.update("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw)"
                + " VALUES (now(), ?, ?, ?, 2.0)", leer, site, box);
        assertThat(bestand.fuerKunde(leer).orElseThrow().datenarten()).containsExactly("messwerte");

        KundeDatenBestandRepository.Folgen folgen = bestand.folgen(leer);
        assertThat(folgen.anlagen()).isEqualTo(1);
        assertThat(folgen.boxen()).containsExactly("kdb-probe-1");
        assertThat(folgen.personen()).isEqualTo(1);
    }

    private static UUID kunde(String name) {
        return root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                name + " " + UUID.randomUUID().toString().substring(0, 8));
    }

    private static PGSimpleDataSource ds(String user, String pw) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(pw);
        return ds;
    }
}
