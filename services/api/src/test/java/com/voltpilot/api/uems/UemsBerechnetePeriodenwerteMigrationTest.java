package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.postgresql.util.PSQLException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Migration {@code V20260914100300} (UEMS AP-10 IP-10, E6 = A): die Spur {@code berechnet} in der vorhandenen
 * Speicherklasse und die Eingänge eines berechneten Werts.
 *
 * <ul>
 *   <li>Bestandsschutz über den gemeinsamen Vergleich ({@link Bestandsschutz}) — die Spur-Spalten sind in jeder
 *       Bestandszeile NULL, die neuen Tabellen leer;</li>
 *   <li>eine gemessene Zeile hält ihre alte Zusage (Reihe, Zählung, Kadenz — nie NULL), eine berechnete hat keine
 *       Reihe und keine Rohwert-Zählung;</li>
 *   <li>je Messstelle und Periode genau EINE berechnete Zeile;</li>
 *   <li>Zaun (RLS + FORCE), Rechte (die App liest nur) und Offboarding.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsBerechnetePeriodenwerteMigrationTest {

    private static final String DIESE = "20260914100300";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final Instant VIERTEL = Instant.parse("2026-10-18T10:00:00Z");
    private static final LocalDate TAG = LocalDate.parse("2026-10-18");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;
    private static UUID bestand;

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        // Der Bestand der drei Klassen, die diese Migration anfasst: je eine gemessene Zeile.
        bestand = root.queryForObject("INSERT INTO tenant (name) VALUES ('Kunststoffwerk Ahrenberg GmbH') RETURNING id",
                UUID.class);
        gemesseneZeilen(bestand, UUID.randomUUID());
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());

        flyway().target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        flyway().load().migrate();
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ================================================================== Bestandsschutz

    @Test
    void dieMigrationLaesstDenBestandZeichengleich() {
        for (String tabelle : List.of("messreihe_viertelstunde", "messreihe_tag", "messreihe_periode")) {
            assertThat(fingerVorher.get(tabelle)).as("es gibt Bestand in " + tabelle).isNotEqualTo(Bestandsschutz.LEER);
        }
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
        for (String tabelle : List.of("bilanzwert_eingang", "messreihe_berechnet_stand")) {
            assertThat(fingerNachMigration.get(tabelle)).as(tabelle + " entsteht leer").isEqualTo(Bestandsschutz.LEER);
        }
        for (String tabelle : List.of("messreihe_viertelstunde", "messreihe_tag", "messreihe_periode")) {
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ? AND "
                    + "(messstelle_id IS NOT NULL OR formel_fassung_id IS NOT NULL OR formel_typ IS NOT NULL)", Long.class,
                    bestand)).as("keine Bestandszeile wird berechnet: " + tabelle).isZero();
        }
    }

    @Test
    void derBestandsvergleichBeisst() {
        Bestandsschutz.mutationsprobe(root, List.of(), "tenant", "UPDATE tenant SET name = name || '!'");
    }

    // ============================================================ die Spur

    /** Eine gemessene Zeile hält ihre alte Zusage: Reihe, Zählung und Kadenz sind nie NULL. */
    @Test
    void eineGemesseneZeileBehaeltReiheZaehlungUndKadenz() {
        UUID t = mandant("Kundenbereich Reihe");
        assertThat(constraint(() -> root.update("INSERT INTO messreihe_viertelstunde (intervall_beginn, tenant_id, "
                + "entity_id, messkanal, erwartet, kadenz_s, kadenz_herkunft, endgueltig_ab) VALUES (?, ?, ?, 'k', 15, 60, "
                + "'vorgabe', ?)", ts(VIERTEL), t, UUID.randomUUID(), ts(frist(VIERTEL)))))
                .as("ohne erhalten").isEqualTo("messreihe_viertelstunde_spur_chk");
        assertThat(constraint(() -> root.update("INSERT INTO messreihe_viertelstunde (intervall_beginn, tenant_id, "
                + "messkanal, erhalten, erwartet, kadenz_s, kadenz_herkunft, endgueltig_ab) VALUES (?, ?, 'k', 15, 15, 60, "
                + "'vorgabe', ?)", ts(VIERTEL), t, ts(frist(VIERTEL)))))
                .as("ohne Reihe und ohne Messstelle").isEqualTo("messreihe_viertelstunde_spur_chk");
        assertThat(constraint(() -> root.update("INSERT INTO messreihe_tag (tag, tenant_id, entity_id, messkanal, zeitzone, "
                + "zeitzone_herkunft, beginn, ende, stunden, slots_erwartet, slots_vorhanden, erhalten, erwartet, "
                + "endgueltig_ab) VALUES (?, ?, ?, 'k', 'Europe/Berlin', 'vorgabe', ?, ?, 24, 96, 96, 1440, 1440, ?)",
                TAG, t, UUID.randomUUID(), ts(beginn()), ts(ende()), ts(frist(ende())))))
                .as("ohne slots_endgueltig").isEqualTo("messreihe_tag_spur_chk");
    }

    /** Eine berechnete Zeile hat keine Reihe und keine Rohwert-Zählung — und je Messstelle und Periode genau eine. */
    @Test
    void eineBerechneteZeileHatKeineReiheUndGibtEsJePeriodeEinmal() {
        UUID t = mandant("Kundenbereich Spur");
        UUID ms = UUID.randomUUID();
        UUID fassung = UUID.randomUUID();
        berechneteZeilen(t, ms, fassung);
        assertThat(constraint(() -> root.update("INSERT INTO messreihe_viertelstunde (intervall_beginn, tenant_id, "
                + "messstelle_id, formel_fassung_id, formel_typ, endgueltig_ab) VALUES (?, ?, ?, ?, 'rest', ?)",
                ts(VIERTEL), t, ms, fassung, ts(frist(VIERTEL))))).as("der Index der Chunk-Tabelle trägt seinen Namen").endsWith("uq_messreihe_viertelstunde_berechnet");
        assertThat(constraint(() -> root.update("INSERT INTO messreihe_tag (tag, tenant_id, messstelle_id, "
                + "formel_fassung_id, formel_typ, zeitzone, zeitzone_herkunft, beginn, ende, stunden, endgueltig_ab) "
                + "VALUES (?, ?, ?, ?, 'rest', 'Europe/Berlin', 'vorgabe', ?, ?, 24, ?)", TAG, t, ms, fassung, ts(beginn()),
                ts(ende()), ts(frist(ende()))))).as("der Index der Chunk-Tabelle trägt seinen Namen").endsWith("uq_messreihe_tag_berechnet");
        assertThat(constraint(() -> root.update("INSERT INTO messreihe_periode (tag, art, tenant_id, messstelle_id, "
                + "formel_fassung_id, formel_typ, zeitzone, zeitzone_herkunft, beginn, ende, stunden, endgueltig_ab) "
                + "VALUES ('2026-10-01', 'monat', ?, ?, ?, 'rest', 'Europe/Berlin', 'vorgabe', '2026-09-30T22:00:00Z', "
                + "'2026-10-31T23:00:00Z', 745, '2026-11-07T23:00:00Z')", t, ms, fassung)))
                .as("der Index der Chunk-Tabelle trägt seinen Namen").endsWith("uq_messreihe_periode_berechnet");
        // Mit Reihe, mit Zählung oder mit einem unbekannten Typ ist sie keine berechnete Zeile.
        assertThat(constraint(() -> root.update("INSERT INTO messreihe_viertelstunde (intervall_beginn, tenant_id, "
                + "messstelle_id, formel_fassung_id, formel_typ, entity_id, messkanal, endgueltig_ab) VALUES (?, ?, ?, ?, "
                + "'rest', ?, 'k', ?)", ts(VIERTEL.plusSeconds(900)), t, UUID.randomUUID(), fassung, UUID.randomUUID(),
                ts(frist(VIERTEL.plusSeconds(900)))))).isEqualTo("messreihe_viertelstunde_spur_chk");
        assertThat(constraint(() -> root.update("INSERT INTO messreihe_viertelstunde (intervall_beginn, tenant_id, "
                + "messstelle_id, formel_fassung_id, formel_typ, erhalten, erwartet, endgueltig_ab) VALUES (?, ?, ?, ?, "
                + "'rest', 0, 0, ?)", ts(VIERTEL.plusSeconds(900)), t, UUID.randomUUID(), fassung,
                ts(frist(VIERTEL.plusSeconds(900)))))).as("eine 0 wäre eine Behauptung")
                .isEqualTo("messreihe_viertelstunde_spur_chk");
        assertThat(constraint(() -> root.update("INSERT INTO messreihe_tag (tag, tenant_id, messstelle_id, "
                + "formel_fassung_id, formel_typ, zeitzone, zeitzone_herkunft, beginn, ende, stunden, endgueltig_ab) "
                + "VALUES (?, ?, ?, ?, 'mittelwert', 'Europe/Berlin', 'vorgabe', ?, ?, 24, ?)", TAG, t, UUID.randomUUID(),
                fassung, ts(beginn()), ts(ende()), ts(frist(ende()))))).isEqualTo("messreihe_tag_spur_chk");
        // Ein Eingang ist eine Messstelle ODER ein Messkanal, nie beides und nie keins.
        assertThat(constraint(() -> root.update("INSERT INTO bilanzwert_eingang (periode_beginn, tenant_id, messstelle_id, "
                + "periode, position, eingang_messstelle_id, eingang_kennzeichen, entity_id, messkanal, berechnet_am) "
                + "VALUES (?, ?, ?, 'tag', 0, ?, 'MS-16', ?, 'k', now())", ts(beginn()), t, ms, UUID.randomUUID(),
                UUID.randomUUID()))).isEqualTo("bilanzwert_eingang_form_chk");
    }

    // ============================================================ Zaun, Rechte, Offboarding

    @Test
    void derZaunStehtDieAppLiestNurUndOffboardingRaeumtAb() {
        UUID t = mandant("Kundenbereich Zaun");
        UUID fremd = mandant("Kundenbereich fremd");
        berechneteZeilen(t, UUID.randomUUID(), UUID.randomUUID());
        root.update("INSERT INTO messreihe_berechnet_stand (tenant_id, messstelle_id, nachgeholt_ab, fertig) "
                + "VALUES (?, ?, ?, true)", t, UUID.randomUUID(), TAG);

        for (String tabelle : List.of("bilanzwert_eingang", "messreihe_berechnet_stand")) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = ?",
                    Boolean.class, tabelle)).as(tabelle).isTrue();
        }
        assertThat(als(t, () -> app.queryForObject("SELECT count(*) FROM bilanzwert_eingang", Long.class))).isEqualTo(1);
        assertThat(als(fremd, () -> app.queryForObject("SELECT count(*) FROM bilanzwert_eingang", Long.class))).isZero();
        assertThat(als(fremd, () -> app.queryForObject("SELECT count(*) FROM messreihe_tag WHERE messstelle_id IS NOT NULL",
                Long.class))).isZero();
        assertThat(psql(() -> als(t, () -> app.update("DELETE FROM bilanzwert_eingang"))).getSQLState())
                .as("die App liest nur").isEqualTo("42501");
        assertThat(psql(() -> als(t, () -> app.queryForObject("SELECT count(*) FROM messreihe_berechnet_stand",
                Long.class))).getSQLState()).as("der Laufzustand gehört dem Lauf").isEqualTo("42501");

        new TenantRepository(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW))).offboard(t);
        for (String tabelle : List.of("bilanzwert_eingang", "messreihe_berechnet_stand", "messreihe_viertelstunde",
                "messreihe_tag", "messreihe_periode")) {
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?", Long.class, t))
                    .as(tabelle).isZero();
        }
    }

    // ================================================================ Gerüst

    private static UUID mandant(String name) {
        return root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
    }

    private static void gemesseneZeilen(UUID t, UUID entity) {
        root.update("INSERT INTO messreihe_viertelstunde (intervall_beginn, tenant_id, entity_id, messkanal, erhalten, "
                + "erwartet, kadenz_s, kadenz_herkunft, endgueltig_ab, wertart, menge, menge_zustand) VALUES (?, ?, ?, "
                + "'sunspec.model_203.totwhimp', 15, 15, 60, 'auswahl', ?, 'counter', 25, 'vollständig')", ts(VIERTEL), t,
                entity, ts(frist(VIERTEL)));
        root.update("INSERT INTO messreihe_tag (tag, tenant_id, entity_id, messkanal, zeitzone, zeitzone_herkunft, beginn, "
                + "ende, stunden, slots_erwartet, slots_vorhanden, slots_endgueltig, erhalten, erwartet, endgueltig_ab, "
                + "wertart, zustand) VALUES (?, ?, ?, 'sunspec.model_203.totwhimp', 'Europe/Berlin', 'vorgabe', ?, ?, 24, 96, "
                + "96, 96, 1440, 1440, ?, 'counter', 'endgueltig')", TAG, t, entity, ts(beginn()), ts(ende()),
                ts(frist(ende())));
        root.update("INSERT INTO messreihe_periode (tag, art, tenant_id, entity_id, messkanal, zeitzone, zeitzone_herkunft, "
                + "beginn, ende, stunden, teile_erwartet, teile_vorhanden, teile_endgueltig, erhalten, erwartet, "
                + "endgueltig_ab, wertart) VALUES ('2026-10-01', 'monat', ?, ?, 'sunspec.model_203.totwhimp', "
                + "'Europe/Berlin', 'vorgabe', '2026-09-30T22:00:00Z', '2026-10-31T23:00:00Z', 745, 31, 1, 0, 1440, 44640, "
                + "'2026-11-07T23:00:00Z', 'counter')", t, entity);
    }

    private static void berechneteZeilen(UUID t, UUID ms, UUID fassung) {
        root.update("INSERT INTO messreihe_viertelstunde (intervall_beginn, tenant_id, messstelle_id, formel_fassung_id, "
                + "formel_typ, menge, menge_zustand, kennzeichen, abdeckung_prozent, endgueltig_ab) VALUES (?, ?, ?, ?, "
                + "'rest', 2.5, 'vollständig', '[\"berechnet (Differenz)\", \"nicht zugeordnet\"]', 100, ?)", ts(VIERTEL), t,
                ms, fassung, ts(frist(VIERTEL)));
        root.update("INSERT INTO messreihe_tag (tag, tenant_id, messstelle_id, formel_fassung_id, formel_typ, zeitzone, "
                + "zeitzone_herkunft, beginn, ende, stunden, menge, menge_zustand, endgueltig_ab) VALUES (?, ?, ?, ?, "
                + "'rest', 'Europe/Berlin', 'vorgabe', ?, ?, 24, 10, 'vollständig', ?)", TAG, t, ms, fassung, ts(beginn()),
                ts(ende()), ts(frist(ende())));
        root.update("INSERT INTO messreihe_periode (tag, art, tenant_id, messstelle_id, formel_fassung_id, formel_typ, "
                + "zeitzone, zeitzone_herkunft, beginn, ende, stunden, menge, menge_zustand, endgueltig_ab) VALUES "
                + "('2026-10-01', 'monat', ?, ?, ?, 'rest', 'Europe/Berlin', 'vorgabe', '2026-09-30T22:00:00Z', "
                + "'2026-10-31T23:00:00Z', 745, 1200, 'vollständig', '2026-11-07T23:00:00Z')", t, ms, fassung);
        root.update("INSERT INTO bilanzwert_eingang (periode_beginn, tenant_id, messstelle_id, periode, position, "
                + "eingang_messstelle_id, eingang_kennzeichen, rolle, anteil, menge, menge_zustand, fassung, "
                + "abdeckung_prozent, eingang_version, berechnet_am) VALUES (?, ?, ?, 'tag', 0, ?, 'MS-16', 'zufluss', "
                + "'gesamt', 100, 'vollständig', 'endgueltig', 100, 1, now())", ts(beginn()), t, ms, UUID.randomUUID());
    }

    private static Instant beginn() {
        return TagRegeln.beginn(TAG, TagRegeln.zone(TagRegeln.VORGABE_ZONE));
    }

    private static Instant ende() {
        return TagRegeln.ende(TAG, TagRegeln.zone(TagRegeln.VORGABE_ZONE));
    }

    /** Die Frist (E5): Viertelstunde = Beginn + 15 min + 7 Tage; Tag = Ende + 7 Tage. */
    private static Instant frist(Instant t) {
        return t.equals(VIERTEL) || t.equals(VIERTEL.plusSeconds(900))
                ? ViertelstundeRegeln.endgueltigAb(t) : TagRegeln.endgueltigAb(t);
    }

    private static Timestamp ts(Instant t) {
        return Timestamp.from(t);
    }

    private static String constraint(Runnable arbeit) {
        return psql(arbeit).getServerErrorMessage().getConstraint();
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
        } catch (RuntimeException e) {
            t = e;
        }
        PSQLException p = null;
        for (Throwable c = t; c != null; c = c.getCause()) {
            if (c instanceof PSQLException pe) {
                p = pe;
            }
        }
        assertThat((Object) p).as("eine PSQLException: " + (t == null ? "keine Ausnahme" : t.getMessage())).isNotNull();
        return p;
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
