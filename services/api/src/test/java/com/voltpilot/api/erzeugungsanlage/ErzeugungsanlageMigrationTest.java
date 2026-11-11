package com.voltpilot.api.erzeugungsanlage;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.FluentConfiguration;
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
 * Die Migration {@code V20261112043000} (Messkonzepte S1): vier neue Tabellen und EA 1 aus dem Bestand.
 *
 * <ul>
 *   <li>Anlage, PV-Aggregat und eigener Satz bleiben Zeichen für Zeichen, wie sie waren - nur Anzeige;</li>
 *   <li>jede Anlage mit einem PV-Aggregat, das etwas trägt, bekommt EA 1 (folgt der Anlage) mit ihrer ersten Fassung
 *       aus PV-Summe und eigenem Satz und genau einem Protokolleintrag; Speicher allein, ein leeres Aggregat und
 *       eine Registerangabe in falscher Form ändern daran nichts bzw. werden nicht übernommen;</li>
 *   <li>Zaun (Mandant), Rechte (nichts löschen, Nummer nie ändern) und Offboarding.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
class ErzeugungsanlageMigrationTest {

    private static final String DIESE = "20261112043000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final String UNIT = "SEE912345678901";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static UUID tenantA;
    private static UUID tenantB;
    private static UUID mitRegister;
    private static UUID ohneDatum;
    private static UUID nurSpeicher;
    private static UUID falscheForm;
    private static UUID leer;
    private static UUID fremd;
    private static String siteVorher;
    private static String assetVorher;

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        tenantA = root.queryForObject("INSERT INTO tenant (name) VALUES ('Hof Brandl') RETURNING id", UUID.class);
        tenantB = root.queryForObject("INSERT INTO tenant (name) VALUES ('Kundenbereich B') RETURNING id", UUID.class);

        mitRegister = site(tenantA, "Hof Brandl - Wohnhaus");
        root.update("INSERT INTO asset (tenant_id, site_id, type, pv_capacity_kwp, commissioned_on, registry, "
                + "registry_unit_id, registry_fetched_at) VALUES (?, ?, 'pv', 9.8, '2023-06-15', 'mastr', ?, "
                + "'2026-10-01T08:00:00Z')", tenantA, mitRegister, UNIT);

        ohneDatum = site(tenantA, "Hof Brandl - Scheune");
        root.update("INSERT INTO asset (tenant_id, site_id, type, pv_capacity_kwp) VALUES (?, ?, 'pv', 30)",
                tenantA, ohneDatum);
        root.update("UPDATE site SET einspeiseverguetung_ct_kwh = 43.01, inbetriebnahme_ab_solarspitzengesetz = false "
                + "WHERE id = ?", ohneDatum);

        nurSpeicher = site(tenantA, "nur Speicher");
        root.update("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, max_discharge_kw) "
                + "VALUES (?, ?, 'battery', 10, 5, 5)", tenantA, nurSpeicher);

        falscheForm = site(tenantA, "Register in falscher Form");
        root.update("INSERT INTO asset (tenant_id, site_id, type, pv_capacity_kwp, registry, registry_unit_id) "
                + "VALUES (?, ?, 'pv', 5, 'mastr', 'XYZ-1')", tenantA, falscheForm);

        leer = site(tenantA, "leeres Aggregat");
        root.update("INSERT INTO asset (tenant_id, site_id, type) VALUES (?, ?, 'pv')", tenantA, leer);

        fremd = site(tenantB, "fremde Anlage");
        root.update("INSERT INTO asset (tenant_id, site_id, type, pv_capacity_kwp, commissioned_on) "
                + "VALUES (?, ?, 'pv', 12, '2014-08-01')", tenantB, fremd);

        siteVorher = finger("site");
        assetVorher = finger("asset");
        flyway().target(DIESE).load().migrate();
        flyway().load().migrate();
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    @Test
    void anlageUndPvAggregatBleibenZeichengleich() {
        assertThat(finger("site")).isEqualTo(siteVorher);
        assertThat(finger("asset")).isEqualTo(assetVorher);
    }

    @Test
    void ea1KommtAusDemPvAggregatMitRegisterUndFolgtDerAnlage() {
        Map<String, Object> ea = root.queryForMap("SELECT * FROM erzeugungsanlage WHERE site_id = ?", mitRegister);
        assertThat(ea.get("nummer")).isEqualTo(1);
        assertThat(ea.get("art")).isEqualTo("pv");
        assertThat(ea.get("name")).isNull();
        assertThat(ea.get("inbetriebnahme").toString()).isEqualTo("2023-06-15");
        assertThat(ea.get("inbetriebnahme_ab_solarspitzengesetz")).isNull();
        assertThat(ea.get("registry")).isEqualTo("mastr");
        assertThat(ea.get("registry_unit_id")).isEqualTo(UNIT);
        assertThat(ea.get("registry_fetched_at")).isNotNull();
        assertThat(ea.get("folgt_anlage")).isEqualTo(true);
        Map<String, Object> f = root.queryForMap("SELECT * FROM erzeugungsanlage_fassung WHERE erzeugungsanlage_id = ?",
                ea.get("id"));
        assertThat(f.get("gueltig_ab")).isNull();
        assertThat((BigDecimal) f.get("leistung_kwp")).isEqualByComparingTo("9.8");
        assertThat(f.get("einspeiseart")).isNull();
        assertThat(f.get("satz_angegeben_ct_kwh")).isNull();
        assertThat(f.get("herkunft")).isEqualTo("bestand");
        assertThat(root.queryForList("SELECT art FROM erzeugungsanlage_aenderung WHERE erzeugungsanlage_id = ?",
                String.class, ea.get("id"))).containsExactly("angelegt");
    }

    @Test
    void ohneDatumZaehltDieAntwortZu51aUndDerEigeneSatzGehtInDieFassung() {
        Map<String, Object> ea = root.queryForMap("SELECT * FROM erzeugungsanlage WHERE site_id = ?", ohneDatum);
        assertThat(ea.get("inbetriebnahme")).isNull();
        assertThat(ea.get("inbetriebnahme_ab_solarspitzengesetz")).isEqualTo(false);
        assertThat(ea.get("registry_unit_id")).isNull();
        Map<String, Object> f = root.queryForMap("SELECT * FROM erzeugungsanlage_fassung WHERE erzeugungsanlage_id = ?",
                ea.get("id"));
        assertThat((BigDecimal) f.get("leistung_kwp")).isEqualByComparingTo("30");
        assertThat((BigDecimal) f.get("satz_angegeben_ct_kwh")).isEqualByComparingTo("43.01");
    }

    @Test
    void speicherAlleinUndLeeresAggregatBekommenKeineEaEineFalscheRegisterformKeineEinheit() {
        assertThat(anzahl("SELECT count(*) FROM erzeugungsanlage WHERE site_id = ?", nurSpeicher)).isZero();
        assertThat(anzahl("SELECT count(*) FROM erzeugungsanlage WHERE site_id = ?", leer)).isZero();
        Map<String, Object> ea = root.queryForMap("SELECT * FROM erzeugungsanlage WHERE site_id = ?", falscheForm);
        assertThat(ea.get("registry")).isNull();
        assertThat(ea.get("registry_unit_id")).isNull();
        // Je Anlage genau eine EA 1, je EA 1 genau eine Fassung und ein Eintrag.
        assertThat(anzahl("SELECT count(*) FROM erzeugungsanlage WHERE tenant_id = ?", tenantA)).isEqualTo(3);
        assertThat(anzahl("SELECT count(*) FROM erzeugungsanlage_fassung WHERE tenant_id = ?", tenantA)).isEqualTo(3);
        assertThat(anzahl("SELECT count(*) FROM erzeugungsanlage_aenderung WHERE tenant_id = ?", tenantA)).isEqualTo(3);
    }

    @Test
    void derMandantenzaunHaelt() {
        TenantContext.set(tenantB);
        assertThat(app.queryForList("SELECT site_id FROM erzeugungsanlage", UUID.class)).containsExactly(fremd);
        assertThat(app.queryForObject("SELECT count(*) FROM erzeugungsanlage_fassung", Integer.class)).isEqualTo(1);
        TenantContext.clear();
        assertThat(app.queryForObject("SELECT count(*) FROM erzeugungsanlage", Integer.class)).isZero();
    }

    @Test
    void dieAppRolleLoeschtNichtsUndAendertKeineNummer() {
        TenantContext.set(tenantA);
        assertThatThrownBy(() -> app.update("DELETE FROM erzeugungsanlage WHERE site_id = ?", mitRegister))
                .hasStackTraceContaining("permission denied");
        assertThatThrownBy(() -> app.update("DELETE FROM erzeugungsanlage_fassung"))
                .hasStackTraceContaining("permission denied");
        assertThatThrownBy(() -> app.update("UPDATE erzeugungsanlage SET nummer = 7 WHERE site_id = ?", mitRegister))
                .hasStackTraceContaining("permission denied");
        assertThatThrownBy(() -> app.update("UPDATE erzeugungsanlage_fassung SET leistung_kwp = 1"))
                .hasStackTraceContaining("permission denied");
        // Eine zweite wirksame Fassung am selben Tag - auch die erste („von der Inbetriebnahme an“) - gibt es nicht.
        UUID ea = app.queryForObject("SELECT id FROM erzeugungsanlage WHERE site_id = ?", UUID.class, mitRegister);
        assertThatThrownBy(() -> app.update("INSERT INTO erzeugungsanlage_fassung (tenant_id, erzeugungsanlage_id, "
                + "gueltig_ab, herkunft) VALUES (?, ?, NULL, 'angegeben')", tenantA, ea))
                .hasStackTraceContaining("erzeugungsanlage_fassung_eine_je_tag");
    }

    @Test
    void dasOffboardingRaeumtAlleVierTabellen() {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES ('Abbau') RETURNING id", UUID.class);
        UUID s = site(t, "Abbau");
        UUID ea = root.queryForObject("INSERT INTO erzeugungsanlage (tenant_id, site_id, nummer) VALUES (?, ?, 1) "
                + "RETURNING id", UUID.class, t, s);
        root.update("INSERT INTO erzeugungsanlage_fassung (tenant_id, erzeugungsanlage_id, herkunft) "
                + "VALUES (?, ?, 'angegeben')", t, ea);
        UUID mp = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label) "
                + "VALUES (?, ?, 'pv-generation', 'WR Garage') RETURNING id", UUID.class, t, s);
        root.update("INSERT INTO erzeugungsanlage_komponente (tenant_id, erzeugungsanlage_id, komponente_id, "
                + "gueltig_ab) VALUES (?, ?, ?, ?)", t, ea, mp, LocalDate.of(2026, 1, 1));
        root.update("INSERT INTO erzeugungsanlage_aenderung (tenant_id, site_id, erzeugungsanlage_id, art, "
                + "actor_name, actor_art) VALUES (?, ?, ?, 'angelegt', 'VoltPilot', 'voltpilot')", t, s, ea);
        new TenantRepository(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW))).offboard(t);
        for (String tabelle : List.of("erzeugungsanlage", "erzeugungsanlage_fassung", "erzeugungsanlage_komponente",
                "erzeugungsanlage_aenderung", "site", "tenant")) {
            String spalte = tabelle.equals("tenant") ? "id" : "tenant_id";
            assertThat(anzahl("SELECT count(*) FROM " + tabelle + " WHERE " + spalte + " = ?", t)).as(tabelle).isZero();
        }
    }

    // ------------------------------------------------------------------------------------------ Hilfen

    private static UUID site(UUID tenant, String name) {
        return root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, ?) RETURNING id", UUID.class,
                tenant, name);
    }

    private static String finger(String tabelle) {
        return root.queryForObject("SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), '')) FROM " + tabelle
                + " t", String.class);
    }

    private static int anzahl(String sql, Object... args) {
        Integer n = root.queryForObject(sql, Integer.class, args);
        return n == null ? 0 : n;
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
