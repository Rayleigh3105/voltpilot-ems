package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.SteuerungsverbundRepository.MitgliedZeile;
import com.voltpilot.api.uems.SteuerungsverbundRepository.RegelStand;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Ablehnung;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Rolle;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Stufe;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * AP-15 IP-4: das Verbund-Objekt in der Datenbank (V20260921140000). Die Box einer anderen Anlage scheitert an der
 * Datenbank (roher INSERT → Fremdschlüssel) UND an der Regel ({@link SteuerungsverbundRegelnVectorsTest},
 * {@code box_nicht_in_anlage}); zwei führende Boxen scheitern an der Exklusion; V-1 aus der Referenzdatei 1.5 lässt
 * sich über das Repository unter der App-Rolle und RLS anlegen, und die Regel urteilt über den gespeicherten Stand.
 */
@Testcontainers(disabledWithoutDocker = true)
class SteuerungsverbundMigrationTest {
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final ProtokollAkteur BETRIEB =
            new ProtokollAkteur(null, "VoltPilot Betrieb", "voltpilot_betrieb", "voltpilot");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static SteuerungsverbundRepository repository;
    private static JsonNode v1;
    private static UUID tenant, an1, an2, na1;
    private static final Map<String, UUID> BOX = new HashMap<>();
    private static final Map<String, UUID> DQ = new HashMap<>();

    @BeforeAll
    static void setUp() throws Exception {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration").baselineOnMigrate(true).baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW))
                .load().migrate();
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        repository = new SteuerungsverbundRepository(app);
        v1 = new ObjectMapper().readTree(Files.readString(Path.of("../../docs/contracts/v2/uems-referenzunternehmen.json")))
                .get("gemeinsame_steuerungen").get(0);

        tenant = root.queryForObject("INSERT INTO tenant (name) VALUES ('Kunststoffwerk Ahrenberg') RETURNING id", UUID.class);
        UUID unternehmen = root.queryForObject("INSERT INTO unternehmen (tenant_id, name) VALUES (?, 'Ahrenberg') RETURNING id",
                UUID.class, tenant);
        UUID standort = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id",
                UUID.class, tenant, unternehmen);
        an1 = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Halle 1') RETURNING id", UUID.class, tenant);
        an2 = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Halle 2') RETURNING id", UUID.class, tenant);
        na1 = root.queryForObject("INSERT INTO netzanschluss (tenant_id, standort_id, kennzeichen, name, messung) "
                + "VALUES (?, ?, 'NA-1', 'Netzanschluss Halle 1', 'RLM') RETURNING id", UUID.class, tenant, standort);
        root.update("INSERT INTO anlage_netzanschluss (tenant_id, site_id, netzanschluss_id, gueltig_ab) "
                + "VALUES (?, ?, ?, '2026-01-01')", tenant, an1, na1);
        for (String e : List.of("E-1", "E-4", "E-4′")) {
            BOX.put(e, box(an1, "VP-" + e));
        }
        BOX.put("E-2′", box(an2, "VP-E-2′"));
        DQ.put("DQ-2", quelle(an1, "DQ-2", "192.168.10.30"));
        DQ.put("DQ-10", quelle(an1, "DQ-10", "192.168.40.30"));
        DQ.put("DQ-4", quelle(an2, "DQ-4", "192.168.20.30"));
        zuweisen("DQ-2", "E-1", "2026-01-01T00:00:00Z", null);
        zuweisen("DQ-10", "E-4", "2027-05-03T00:00:00+02:00", "2027-10-12T00:00:00+02:00");
        zuweisen("DQ-10", "E-4′", "2027-10-12T00:00:00+02:00", null);
        zuweisen("DQ-4", "E-2′", "2026-01-01T00:00:00Z", null);
    }

    @AfterEach
    void clear() {
        TenantContext.clear();
    }

    /** V-1 aus der Referenzdatei 1.5: Mitglieder mit ihren Zeiträumen, Stufen S0 → S2 → S3, jede mit Protokoll. */
    @Test
    void v1AusDerReferenzdateiLaesstSichAnlegen() {
        TenantContext.set(tenant);
        UUID verbund = repository.einrichten(tenant, an1, "betrieb");
        repository.protokoll(tenant, verbund, an1, "eingerichtet", null, "{\"stufe\":\"erklaert\"}",
                Instant.parse("2027-05-02T22:00:00Z"), false, null, BETRIEB);
        for (JsonNode m : v1.get("mitglieder")) {
            Instant ab = OffsetDateTime.parse(m.get("gueltig_ab").asText()).toInstant();
            Instant bis = m.get("gueltig_bis").isNull() ? null : OffsetDateTime.parse(m.get("gueltig_bis").asText()).toInstant();
            repository.mitgliedAufnehmen(tenant, verbund, BOX.get(m.get("box").asText()),
                    SteuerungsverbundRepository.rolle(m.get("rolle").asText()), DQ.get(m.get("messpunkt").asText()), ab, bis,
                    "betrieb");
            repository.protokoll(tenant, verbund, an1, "mitglied", null,
                    "{\"box\":\"" + m.get("box").asText() + "\"}", ab, false, null, BETRIEB);
        }
        for (JsonNode s : v1.get("stufen")) {
            Stufe stufe = SteuerungsverbundRepository.stufe(s.get("code").asText());
            assertThat(repository.stufeSetzen(verbund, stufe)).isTrue();
            if (stufe == Stufe.ANTEILE_AKTIV) {
                assertThat(repository.epocheErhoehen(verbund)).contains(1L);
            }
        }
        var zeile = repository.derAnlage(an1).orElseThrow();
        assertThat(zeile.stufe()).isEqualTo(Stufe.ANTEILE_AKTIV);
        assertThat(zeile.epoche()).isEqualTo(1L);
        assertThat(repository.mitgliederGeschichte(verbund)).hasSize(3);

        // 24.05.2027: E-1 führt an DQ-2, E-4 steuert an DQ-10 mit — die Regel urteilt über den gespeicherten Stand.
        Instant s3 = Instant.parse("2027-05-24T08:00:00Z");
        List<MitgliedZeile> mai = repository.mitglieder(verbund, s3);
        assertThat(mai).extracting(MitgliedZeile::deviceId).containsExactly(BOX.get("E-1"), BOX.get("E-4"));
        RegelStand stand = repository.regelStand(an1, s3, LocalDate.of(2027, 5, 24)).orElseThrow();
        assertThat(stand.verbund().netzanschluesse()).containsExactly(na1.toString());
        assertThat(SteuerungsverbundRegeln.pruefen(stand.verbund(), stand.quellen(), null).befunde()).isEmpty();
        // Nach dem Box-Tausch (R17) steht E-4′ an DQ-10.
        Instant tausch = Instant.parse("2027-10-12T08:00:00Z");
        RegelStand oktober = repository.regelStand(an1, tausch, LocalDate.of(2027, 10, 12)).orElseThrow();
        assertThat(oktober.verbund().mitglieder()).extracting(SteuerungsverbundRegeln.Mitglied::box)
                .containsExactly(BOX.get("E-1").toString(), BOX.get("E-4′").toString());
        assertThat(SteuerungsverbundRegeln.pruefen(oktober.verbund(), oktober.quellen(), null).zulaessig()).isTrue();
        // T6/R21: die Box von Halle 2 liest eine Quelle — und ist kein Mitglied.
        assertThat(SteuerungsverbundRegeln.istMitglied(oktober.verbund(), BOX.get("E-2′").toString())).isFalse();

        // G5: gesendet/quittiert steigen nur; quittiert nie über das Gesendete hinaus.
        UUID e1 = mai.get(0).id();
        assertThat(repository.quittiert(e1, 1, 1, s3)).isFalse();
        assertThat(repository.gesendet(e1, 1, 7, s3)).isTrue();
        assertThat(repository.gesendet(e1, 1, 6, s3)).isFalse();
        assertThat(repository.quittiert(e1, 1, 8, s3)).isFalse();
        assertThat(repository.quittiert(e1, 1, 7, s3)).isTrue();
        assertThat(repository.quittiert(e1, 1, 7, s3)).isFalse();
        assertThat(repository.protokollDerAnlage(an1)).hasSize(4);

        // Zwei führende Boxen im selben Zeitraum: die Exklusion (eigene Box, eigener Messpunkt — nur sie greift).
        UUID e5 = box(an1, "VP-E-5");
        UUID dq8 = quelle(an1, "DQ-8", "192.168.10.40");
        assertThatThrownBy(() -> repository.mitgliedAufnehmen(tenant, verbund, e5, Rolle.FUEHRT,
                dq8, Instant.parse("2028-01-01T00:00:00Z"), null, "betrieb"))
                .isInstanceOf(DataAccessException.class).hasMessageContaining("steuerungsverbund_mitglied_eine_fuehrt");
        // Die Box von Halle 2 über das Repository: der zusammengesetzte Fremdschlüssel.
        assertThatThrownBy(() -> repository.mitgliedAufnehmen(tenant, verbund, BOX.get("E-2′"), Rolle.STEUERT_MIT, null,
                Instant.parse("2028-01-01T00:00:00Z"), null, "betrieb"))
                .isInstanceOf(DataAccessException.class).hasMessageContaining("steuerungsverbund_mitglied_box_fk");
    }

    /** Die Box einer anderen Anlage kann die Datenbank nicht aufnehmen — auch nicht mit „passender“ Anlage im Mitglied. */
    @Test
    void boxEinerAnderenAnlageScheitertAnDerDatenbank() {
        Welt w = welt("Halle 3");
        UUID verbund = verbundFuer(w.site());
        UUID halle2 = box(an2, "VP-HALLE2-FREMD"); // Heimat AN-2, nirgends Mitglied
        assertThat(sqlState(() -> root.update("INSERT INTO steuerungsverbund_mitglied (tenant_id, steuerungsverbund_id, "
                + "site_id, device_id, rolle, gueltig_ab) VALUES (?, ?, ?, ?, 'steuert_mit', '2028-01-01T00:00:00Z')",
                tenant, verbund, w.site(), halle2))).isEqualTo("23503:steuerungsverbund_mitglied_box_fk");
        // Die Anlage der Box eingetragen: dann passt sie nicht zum Verbund.
        assertThat(sqlState(() -> root.update("INSERT INTO steuerungsverbund_mitglied (tenant_id, steuerungsverbund_id, "
                + "site_id, device_id, rolle, gueltig_ab) VALUES (?, ?, ?, ?, 'steuert_mit', '2028-01-01T00:00:00Z')",
                tenant, verbund, an2, halle2))).isEqualTo("23503:steuerungsverbund_mitglied_verbund_fk");
        // Ein Messpunkt einer anderen Anlage.
        assertThat(sqlState(() -> root.update("INSERT INTO steuerungsverbund_mitglied (tenant_id, steuerungsverbund_id, "
                + "site_id, device_id, rolle, data_source_id, gueltig_ab) "
                + "VALUES (?, ?, ?, ?, 'steuert_mit', ?, '2028-01-01T00:00:00Z')",
                tenant, verbund, w.site(), w.b1(), quelle(an2, "DQ-H2X", "192.168.20.99"))))
                .isEqualTo("23503:steuerungsverbund_mitglied_messpunkt_fk");
        // Und die Regel sagt dasselbe mit ihrem Wort.
        var regel = SteuerungsverbundRegeln.pruefen(new SteuerungsverbundRegeln.Verbund(an1.toString(),
                List.of(na1.toString()), List.of(
                        new SteuerungsverbundRegeln.Mitglied("E-1", an1.toString(), Rolle.FUEHRT, "DQ-2"),
                        new SteuerungsverbundRegeln.Mitglied("E-2′", an2.toString(), Rolle.STEUERT_MIT, null))),
                List.of(new SteuerungsverbundRegeln.Datenquelle("DQ-2", an1.toString(), "E-1")), null);
        assertThat(regel.ablehnung()).isEqualTo(Ablehnung.BOX_NICHT_IN_ANLAGE);
    }

    /** Genau eine führt, `liest` ist kein Mitglied, je Anlage höchstens ein Verbund, kein Doppel-Lesen. */
    @Test
    void strukturRegelnDerDatenbank() {
        Welt w = welt("Halle 4");
        UUID an4 = w.site();
        UUID verbund = verbundFuer(an4);
        String einfuegen = "INSERT INTO steuerungsverbund_mitglied (tenant_id, steuerungsverbund_id, site_id, device_id, "
                + "rolle, data_source_id, gueltig_ab, gueltig_bis) VALUES (?, ?, ?, ?, ?, ?, ?::timestamptz, ?::timestamptz)";
        root.update(einfuegen, tenant, verbund, an4, w.b1(), "fuehrt", w.q1(), "2030-01-01T00:00:00Z", null);
        assertThat(sqlState(() -> root.update(einfuegen, tenant, verbund, an4, w.b2(), "fuehrt", w.q2(),
                "2030-06-01T00:00:00Z", null))).isEqualTo("23P01:steuerungsverbund_mitglied_eine_fuehrt");
        assertThat(sqlState(() -> root.update(einfuegen, tenant, verbund, an4, w.b2(), "liest", null,
                "2030-06-01T00:00:00Z", null))).isEqualTo("23514:steuerungsverbund_mitglied_rolle_chk");
        assertThat(sqlState(() -> root.update(einfuegen, tenant, verbund, an4, w.b2(), "steuert_mit", w.q1(),
                "2030-06-01T00:00:00Z", null))).isEqualTo("23P01:steuerungsverbund_mitglied_messpunkt_einmal");
        assertThat(sqlState(() -> root.update(einfuegen, tenant, verbund, an4, w.b1(), "steuert_mit", null,
                "2030-06-01T00:00:00Z", null))).isEqualTo("23P01:steuerungsverbund_mitglied_box_einmal");
        assertThat(sqlState(() -> root.update(einfuegen, tenant, verbund, an4, w.b2(), "fuehrt", null,
                "2031-06-01T00:00:00Z", null))).isEqualTo("23514:steuerungsverbund_mitglied_fuehrt_misst_chk");
        assertThat(sqlState(() -> root.update("INSERT INTO steuerungsverbund (tenant_id, site_id) VALUES (?, ?)",
                tenant, an4))).isEqualTo("23505:steuerungsverbund_je_anlage_einer");
        // Nacheinander führen zwei Boxen: halboffen, kein Überlapp.
        UUID zweiter = verbundFuer(an2);
        UUID e2 = BOX.get("E-2′");
        root.update(einfuegen, tenant, zweiter, an2, e2, "fuehrt", DQ.get("DQ-4"), "2030-01-01T00:00:00Z",
                "2030-02-01T00:00:00Z");
        UUID e2b = box(an2, "VP-E-2-nachfolger");
        root.update(einfuegen, tenant, zweiter, an2, e2b, "steuert_mit", null, "2030-01-01T00:00:00Z", null);
        assertThat(root.update("UPDATE steuerungsverbund_mitglied SET gueltig_bis = '2030-02-01T00:00:00Z' "
                + "WHERE device_id = ?", e2b)).isEqualTo(1);
        root.update(einfuegen, tenant, zweiter, an2, e2b, "fuehrt", DQ.get("DQ-4"), "2030-02-01T00:00:00Z", null);
    }

    /** RLS mit FORCE, enge Rechte, kein Löschen für die App-Rolle; das Offboarding räumt alle drei Tabellen ab. */
    @Test
    void mandantenzaunRechteUndOffboarding() {
        for (String t : List.of("steuerungsverbund", "steuerungsverbund_mitglied", "steuerungsverbund_aenderung")) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = ?",
                    Boolean.class, t)).as(t).isTrue();
            assertThat(root.queryForObject("SELECT has_table_privilege(?, ?, 'DELETE')", Boolean.class, APP_USER, t))
                    .as(t).isFalse();
            assertThat(root.queryForObject("SELECT has_table_privilege(?, ?, 'DELETE')", Boolean.class, ADMIN_USER, t))
                    .as(t).isTrue();
        }
        assertThat(root.queryForObject("SELECT has_column_privilege(?, 'steuerungsverbund_mitglied', 'device_id', 'UPDATE')",
                Boolean.class, APP_USER)).isFalse();

        UUID fremd = root.queryForObject("INSERT INTO tenant (name) VALUES ('Fremd') RETURNING id", UUID.class);
        UUID fremdeAnlage = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Fremd') RETURNING id",
                UUID.class, fremd);
        UUID fremderVerbund = root.queryForObject("INSERT INTO steuerungsverbund (tenant_id, site_id) VALUES (?, ?) "
                + "RETURNING id", UUID.class, fremd, fremdeAnlage);
        UUID fremdeBox = box(fremd, fremdeAnlage, "VP-FREMD");
        UUID fremdeQuelle = quelle(fremd, fremdeAnlage, "DQ-1", "10.0.0.1");
        root.update("INSERT INTO steuerungsverbund_mitglied (tenant_id, steuerungsverbund_id, site_id, device_id, rolle, "
                + "data_source_id, gueltig_ab) VALUES (?, ?, ?, ?, 'fuehrt', ?, '2030-01-01T00:00:00Z')",
                fremd, fremderVerbund, fremdeAnlage, fremdeBox, fremdeQuelle);
        root.update("INSERT INTO steuerungsverbund_aenderung (tenant_id, steuerungsverbund_id, site_id, art, gilt_ab, "
                + "rueckwirkend, actor_name, actor_art) VALUES (?, ?, ?, 'eingerichtet', now(), false, 'Betrieb', 'voltpilot')",
                fremd, fremderVerbund, fremdeAnlage);

        TenantContext.set(tenant);
        assertThat(repository.derAnlage(fremdeAnlage)).isEmpty();
        assertThat(repository.mitgliederGeschichte(fremderVerbund)).isEmpty();
        assertThat(repository.protokollDerAnlage(fremdeAnlage)).isEmpty();
        TenantContext.clear();

        new TenantRepository(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW))).offboard(fremd);
        for (String t : List.of("steuerungsverbund", "steuerungsverbund_mitglied", "steuerungsverbund_aenderung")) {
            assertThat(root.queryForObject("SELECT count(*) FROM " + t + " WHERE tenant_id = ?", Integer.class, fremd))
                    .as(t).isZero();
        }
    }

    private static UUID verbundFuer(UUID site) {
        List<UUID> da = root.queryForList("SELECT id FROM steuerungsverbund WHERE site_id = ?", UUID.class, site);
        return da.isEmpty()
                ? root.queryForObject("INSERT INTO steuerungsverbund (tenant_id, site_id) VALUES (?, ?) RETURNING id",
                        UUID.class, tenant, site)
                : da.get(0);
    }

    private static String sqlState(Runnable r) {
        try {
            r.run();
        } catch (DataAccessException e) {
            Throwable c = e;
            while (c != null && !(c instanceof org.postgresql.util.PSQLException)) {
                c = c.getCause();
            }
            if (c instanceof org.postgresql.util.PSQLException p && p.getServerErrorMessage() != null) {
                return p.getSQLState() + ":" + p.getServerErrorMessage().getConstraint();
            }
            throw e;
        }
        return "kein Fehler";
    }

    private static UUID box(UUID site, String ref) {
        return box(tenant, site, ref);
    }

    private static UUID box(UUID t, UUID site, String ref) {
        return root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, site, ref);
    }

    private static UUID quelle(UUID site, String kennzeichen, String adresse) {
        return quelle(tenant, site, kennzeichen, adresse);
    }

    private static UUID quelle(UUID t, UUID site, String kennzeichen, String adresse) {
        return root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, adresse, "
                + "geraete_ids, kadenz_s) VALUES (?, ?, ?, 'modbus_tcp', ?, '{1}', 10) RETURNING id",
                UUID.class, t, site, kennzeichen, adresse);
    }

    private static void zuweisen(String dq, String box, String ab, String bis) {
        root.update("INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, protokoll, adresse, "
                + "effective_from, effective_to) SELECT tenant_id, id, ?, protokoll, adresse, ?::timestamptz, "
                + "?::timestamptz FROM data_source WHERE id = ?", BOX.get(box), ab, bis, DQ.get(dq));
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource dataSource = new PGSimpleDataSource();
        dataSource.setUrl(POSTGRES.getJdbcUrl());
        dataSource.setUser(user);
        dataSource.setPassword(password);
        return dataSource;
    }

    /** Eine eigene Anlage mit zwei Boxen und zwei Datenquellen — kein Test teilt Mitglieder mit einem anderen. */
    private record Welt(UUID site, UUID b1, UUID b2, UUID q1, UUID q2) {}

    private static int zaehler;

    private static Welt welt(String name) {
        int n = ++zaehler;
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, ?) RETURNING id", UUID.class,
                tenant, name);
        return new Welt(site, box(site, "VP-W" + n + "-1"), box(site, "VP-W" + n + "-2"),
                quelle(site, "DQ-W" + n + "A", "10.9." + n + ".1"), quelle(site, "DQ-W" + n + "B", "10.9." + n + ".2"));
    }
}
