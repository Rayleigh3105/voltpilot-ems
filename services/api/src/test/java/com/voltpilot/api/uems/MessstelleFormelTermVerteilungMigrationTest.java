package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.MessstelleFormelTermRepository.TermZeile;
import com.voltpilot.api.uems.MessstelleRegeln.Groesse;
import com.voltpilot.api.uems.MessstelleRepository.NeueMessstelle;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
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
 * Die Migration {@code V20260913143000} (UEMS AP-10 IP-5) gegen einen Bestand, der vor ihr so
 * geschrieben wurde, wie PR #688 und IP-3 schrieben:
 *
 * <ul>
 *   <li>Bestandsschutz über den gemeinsamen Vergleich ({@link Bestandsschutz}, PR #708): keine Zeile
 *       irgendeiner Tabelle ändert sich — die neuen Spalten sind in jeder Bestandszeile NULL
 *       ({@code anteil} NULL = {@code gesamt});</li>
 *   <li>verhaltensgleich: die Terme jeder Fassung und der Stand des Lebenszyklus sind dieselben;</li>
 *   <li>die Datenbank hält die neue Term-Art: Bindung, Faktor 1, eine Schreibweise für {@code gesamt};</li>
 *   <li>Zaun, Rechte, erneutes Ausführen (out-of-order) und Offboarding.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
class MessstelleFormelTermVerteilungMigrationTest {

    private static final String DIESE = "20260913143000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final Groesse WIRKLEISTUNG = new Groesse("Wirkleistung", "Erzeugung", "kW", "Momentanwert");
    private static final Groesse GEMESSEN = new Groesse("Wirkenergie", "Bezug", "kWh", "Zählerstand");
    private static final String PV1 = "deye.hybrid_3p.pv.pv1-power";
    private static final String PV2 = "deye.hybrid_3p.pv.pv2-power";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static MessstelleRepository messstellen;
    private static MessstelleFormelTermRepository terme;

    private static UUID mandantA;
    private static UUID mandantB;
    private static UUID komponenteA;
    private static UUID gemessenA;
    private static UUID pvSumme;
    private static UUID baustein;
    private static UUID pvB;
    /** Je Bestands-Messstelle: jede Spalte jedes Terms VOR der Migration, und der Stand des Lebenszyklus. */
    private static final Map<UUID, List<String>> TERME_VORHER = new LinkedHashMap<>();
    private static final Map<UUID, List<Boolean>> STAND_VORHER = new LinkedHashMap<>();
    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        messstellen = new MessstelleRepository(app);
        terme = new MessstelleFormelTermRepository(app);

        // ---- der Bestand: Terme, geschrieben wie PR #688 (die Datenbank legt Fassung 1 an)
        mandantA = mandant("Bestand A");
        mandantB = mandant("Bestand B");
        komponenteA = komponente(mandantA, 1);
        UUID komponenteB = komponente(mandantB, 2);
        gemessenA = messstelle(mandantA, "MS-0001", "gemessen", GEMESSEN);
        pvSumme = messstelle(mandantA, "MS-0002", "berechnet", WIRKLEISTUNG);
        baustein = messstelle(mandantA, "MS-0003", "berechnet", WIRKLEISTUNG);
        pvB = messstelle(mandantB, "MS-0001", "berechnet", WIRKLEISTUNG);
        kanalTerm(mandantA, pvSumme, 0, komponenteA, PV1, "+", 1);
        kanalTerm(mandantA, pvSumme, 1, komponenteA, PV2, "-", 0.5);
        root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, position, eingang_art, "
                + "quell_messstelle_id, vorzeichen, faktor) VALUES (?, ?, 0, 'messstelle', ?, '+', 1)",
                mandantA, baustein, pvSumme);
        kanalTerm(mandantB, pvB, 0, komponenteB, PV1, "+", 1);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, "
                + "point_key, enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, "
                + "apply_status, retention_class, long_term_strategy) SELECT p.tenant_id, p.site_id, p.device_id, "
                + "p.id, ?, true, 60, 1, now(), '2026.09.11.1', 'test', 'pending_edge', 'energy_counter', "
                + "'fifteen_minute' FROM measurement_point p WHERE p.id = ?", PV1, komponenteA);

        for (UUID m : List.of(pvSumme, baustein, pvB)) {
            TERME_VORHER.put(m, root.queryForList("SELECT concat_ws('~', id, fassung_id, position, eingang_art, "
                    + "entity_id, point_key, quell_messstelle_id, vorzeichen, faktor) FROM messstelle_formel_term "
                    + "WHERE messstelle_id = ? ORDER BY position", String.class, m));
        }
        // Der Stand des Lebenszyklus VOR der Migration: die Erwartung des Bestands, ausgeschrieben. Er lässt
        // sich hier nicht mehr mit dem Repository von heute lesen — dessen Abfrage filtert seit AP-07 IP-11
        // (PR #716) `device.ausgebaut_am`, eine Spalte, die es auf dieser Fassung noch nicht gibt.
        STAND_VORHER.put(pvSumme, List.of(true, false));
        STAND_VORHER.put(baustein, List.of(true, true));
        STAND_VORHER.put(pvB, List.of(true, false));
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
        for (String tabelle : List.of("messstelle", "messstelle_formel_term", "messstelle_formel_fassung")) {
            assertThat(fingerVorher.get(tabelle)).as("es gibt Bestand in " + tabelle).isNotEqualTo(Bestandsschutz.LEER);
        }
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle_formel_term WHERE messstelle_id IN (?, ?, ?) "
                + "AND (anteil IS NOT NULL OR verteilung_ziel IS NOT NULL)", Long.class, pvSumme, baustein, pvB))
                .as("keine Bestandszeile bekommt einen Anteil oder ein Ziel").isZero();
    }

    @Test
    void derBestandsvergleichBeisst() {
        Bestandsschutz.mutationsprobe(root, List.of(), "messstelle_formel_term",
                "UPDATE messstelle_formel_term SET vorzeichen = CASE vorzeichen WHEN '+' THEN '-' ELSE '+' END");
    }

    @Test
    void derBestandRechnetNachDerMigrationUnveraendert() {
        for (Map.Entry<UUID, List<String>> e : TERME_VORHER.entrySet()) {
            UUID m = e.getKey();
            UUID tenant = m.equals(pvB) ? mandantB : mandantA;
            List<TermZeile> nachher = als(tenant, () -> terme.derMessstelle(m));
            List<String> text = new ArrayList<>();
            for (TermZeile t : nachher) {
                String fassung = root.queryForObject("SELECT fassung_id::text FROM messstelle_formel_term WHERE id = ?",
                        String.class, t.id());
                text.add(wieConcatWs(t.id(), fassung, t.position(), t.eingangArt(), t.entityId(), t.pointKey(),
                        t.quellMessstelleId(), t.vorzeichen(), faktor(t.faktor())));
                assertThat(t.anteil()).as("anteil NULL = gesamt").isNull();
                assertThat(t.verteilungZiel()).isNull();
            }
            assertThat(text).as("Terme von " + m).containsExactlyElementsOf(e.getValue());
            MessstelleFormelTermRepository.FormelStand s = als(tenant, () -> terme.stand(m, java.time.LocalDate.now()));
            assertThat(List.of(s.vorhanden(), s.eingerichtet())).as("Stand von " + m).isEqualTo(STAND_VORHER.get(m));
        }
        assertThat(STAND_VORHER.get(pvSumme)).as("PV2 ohne Selektion: nicht eingerichtet").containsExactly(true, false);
        assertThat(STAND_VORHER.get(baustein)).containsExactly(true, true);
    }

    // ============================================================ die neue Term-Art in der DB

    @Test
    void dieDatenbankHaeltDieNeueTermArt() {
        UUID ms = messstelle(mandantA, "MS-0010", "berechnet", WIRKLEISTUNG);
        // Seit AP-10 IP-7 zeigt das Ziel per Fremdschlüssel auf eine Kostenstelle desselben Kundenbereichs.
        UUID kostenstelle = kostenstelle(mandantA);
        // Ein Verteilungs-Term: Quell-Messstelle + Ziel, Faktor 1 — die Datenbank nimmt ihn an (die
        // Schnittstelle speichert ihn erst, wenn AnteilLeseweg ihn lesen kann).
        alsTue(mandantA, () -> terme.anlegen(null, ms, 0, "verteilung", null, null, gemessenA, "+", 1.0,
                kostenstelle, null));
        TermZeile t = als(mandantA, () -> terme.derMessstelle(ms)).get(0);
        assertThat(t.eingangArt()).isEqualTo("verteilung");
        assertThat(t.verteilungZiel()).isEqualTo(kostenstelle);
        assertThat(t.quellMessstelleId()).isEqualTo(gemessenA);
        assertThat(t.anteil()).isNull();
        // Der Lebenszyklus zählt die Quell-Messstelle eines Verteilungs-Terms wie die eines Bausteins.
        assertThat(als(mandantA, () -> terme.stand(ms, java.time.LocalDate.now())).eingerichtet()).isTrue();

        UUID zweite = messstelle(mandantA, "MS-0011", "berechnet", WIRKLEISTUNG);
        abgelehnt("messstelle_formel_term_bindung_chk", () -> alsTue(mandantA, () -> terme.anlegen(null, zweite, 0,
                "verteilung", null, null, gemessenA, "+", 1.0, null, null)));
        abgelehnt("messstelle_formel_term_bindung_chk", () -> alsTue(mandantA, () -> terme.anlegen(null, zweite, 0,
                "verteilung", komponenteA, PV1, gemessenA, "+", 1.0, kostenstelle, null)));
        abgelehnt("messstelle_formel_term_bindung_chk", () -> alsTue(mandantA, () -> terme.anlegen(null, zweite, 0,
                "messkanal", komponenteA, PV1, null, "+", 1.0, kostenstelle, null)));
        abgelehnt("messstelle_formel_term_bindung_chk", () -> alsTue(mandantA, () -> terme.anlegen(null, zweite, 0,
                "messstelle", null, null, gemessenA, "+", 1.0, kostenstelle, null)));
        abgelehnt("messstelle_formel_term_verteilung_faktor_chk", () -> alsTue(mandantA, () -> terme.anlegen(null,
                zweite, 0, "verteilung", null, null, gemessenA, "+", 0.7, kostenstelle, null)));
        // `gesamt` hat genau eine Schreibweise: keine.
        abgelehnt("messstelle_formel_term_anteil_chk", () -> alsTue(mandantA, () -> terme.anlegen(null, zweite, 0,
                "messstelle", null, null, gemessenA, "+", 1.0, null, "gesamt")));
        abgelehnt("messstelle_formel_term_anteil_chk", () -> alsTue(mandantA, () -> terme.anlegen(null, zweite, 0,
                "messstelle", null, null, gemessenA, "+", 1.0, null, "halb")));
        // Ein Teil des Messwerts ist ein gültiges Wort — ob er lesbar ist, entscheidet nicht die Datenbank.
        alsTue(mandantA, () -> terme.anlegen(null, zweite, 0, "messstelle", null, null, gemessenA, "-", 1.0, null,
                "positiv"));
        alsTue(mandantA, () -> terme.anlegen(null, zweite, 1, "messstelle", null, null, gemessenA, "+", 1.0, null,
                "negativ"));
        assertThat(als(mandantA, () -> terme.derMessstelle(zweite))).extracting(TermZeile::anteil)
                .containsExactly("positiv", "negativ");
        // Der Selbst-Verweis bleibt verboten, auch als Verteilung.
        abgelehnt("messstelle_formel_term_nicht_selbst", () -> alsTue(mandantA, () -> terme.anlegen(null, zweite, 2,
                "verteilung", null, null, zweite, "+", 1.0, kostenstelle, null)));
    }

    @Test
    void derZaunStehtUndDieRechteBleiben() {
        UUID ms = messstelle(mandantA, "MS-0020", "berechnet", WIRKLEISTUNG);
        alsTue(mandantA, () -> terme.anlegen(null, ms, 0, "verteilung", null, null, gemessenA, "+", 1.0,
                kostenstelle(mandantA), null));
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'messstelle_formel_term'", Boolean.class)).isTrue();
        assertThat(app.queryForObject("SELECT count(*) FROM messstelle_formel_term", Long.class))
                .as("ohne Mandant: nichts").isZero();
        assertThat(als(mandantB, () -> app.queryForObject("SELECT count(*) FROM messstelle_formel_term "
                + "WHERE eingang_art = 'verteilung' OR tenant_id <> ?", Long.class, mandantB)))
                .as("B sieht die Verteilungs-Terme von A nicht").isZero();
        assertThat(als(mandantB, () -> terme.derMessstelle(ms))).isEmpty();
        // B kann keinen Term in den Kundenbereich von A schreiben (Trigger unter RLS + WITH CHECK der Policy).
        assertThatThrownBy(() -> alsTue(mandantB, () -> app.update("INSERT INTO messstelle_formel_term (tenant_id, "
                + "messstelle_id, position, eingang_art, quell_messstelle_id, vorzeichen, faktor, verteilung_ziel) "
                + "VALUES (?, ?, 5, 'verteilung', ?, '+', 1, ?)", mandantA, ms, gemessenA, UUID.randomUUID())))
                .isNotNull();
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle_formel_term WHERE messstelle_id = ?",
                Long.class, ms)).isOne();
        // Die Terme bleiben Historie ihrer Fassung: nur Lesen und Anlegen.
        for (String[] r : new String[][] {{"SELECT", "true"}, {"INSERT", "true"}, {"UPDATE", "false"},
                {"DELETE", "false"}}) {
            assertThat(root.queryForObject("SELECT has_table_privilege(?, 'messstelle_formel_term', ?)",
                    Boolean.class, APP_USER, r[0])).as(r[0]).isEqualTo(Boolean.parseBoolean(r[1]));
        }
        assertThat(root.queryForObject("SELECT count(*) FROM pg_indexes WHERE tablename = 'messstelle_formel_term' "
                + "AND indexname = 'idx_messstelle_formel_term_verteilung_ziel'", Long.class)).isOne();
        assertThat(root.queryForObject("SELECT count(*) FROM pg_constraint WHERE conrelid = "
                + "'messstelle_formel_term'::regclass AND contype = 'f' AND pg_get_constraintdef(oid) LIKE "
                + "'%verteilung_ziel%'", Long.class)).as("der Fremdschlüssel, den AP-10 IP-7 nachgezogen hat")
                .isOne();
    }

    /** {@code out-of-order: true}: dieselbe Datei ein zweites Mal auf dem neuesten Stand ändert nichts. */
    @Test
    void dieMigrationLaeuftAuchEinZweitesMal() throws Exception {
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());
        String sql = Files.readString(Path.of("src", "main", "resources", "db", "migration",
                "V" + DIESE + "__uems_formel_term_verteilung.sql"));
        root.execute(sql);
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of()))).isEmpty();
        for (String name : List.of("eingang_chk", "bindung_chk", "anteil_chk", "verteilung_faktor_chk")) {
            assertThat(root.queryForObject("SELECT count(*) FROM pg_constraint WHERE conrelid = "
                    + "'messstelle_formel_term'::regclass AND conname = ?", Long.class, "messstelle_formel_term_" + name))
                    .as(name).isOne();
        }
    }

    @Test
    void dasOffboardingRaeumtAuchVerteilungsTermeAb() {
        UUID t = mandant("Offboarding");
        UUID gem = messstelle(t, "MS-0001", "gemessen", GEMESSEN);
        UUID ms = messstelle(t, "MS-0002", "berechnet", WIRKLEISTUNG);
        alsTue(t, () -> terme.anlegen(null, ms, 0, "verteilung", null, null, gem, "+", 1.0, kostenstelle(t), null));
        alsTue(t, () -> terme.anlegen(null, ms, 1, "messstelle", null, null, gem, "-", 1.0, null, "negativ"));

        new TenantRepository(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW))).offboard(t);

        for (String tabelle : List.of("messstelle_formel_term", "messstelle_formel_fassung", "messstelle", "kostenstelle",
                "tenant")) {
            String spalte = tabelle.equals("tenant") ? "id" : "tenant_id";
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE " + spalte + " = ?",
                    Integer.class, t)).as(tabelle).isZero();
        }
    }

    // ===================================================================== Gerüst

    /** Wie {@code concat_ws('~', …)}: NULL-Werte fallen weg. */
    private static String wieConcatWs(Object... werte) {
        return String.join("~", Arrays.stream(werte).filter(java.util.Objects::nonNull).map(String::valueOf).toList());
    }

    /** Wie {@code concat_ws} einen numeric-Faktor schreibt (1 → „1“, 0.5 → „0.5“). */
    private static String faktor(double f) {
        return new java.math.BigDecimal(String.valueOf(f)).stripTrailingZeros().toPlainString();
    }

    private static UUID mandant(String name) {
        return root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
    }

    /** Eine Kostenstelle (AP-10 IP-7) im Kundenbereich — mit seinem Unternehmen, falls der Test keins angelegt hat. */
    private static UUID kostenstelle(UUID tenant) {
        root.update("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, 'Unternehmen', 'Europe/Berlin') "
                + "ON CONFLICT (tenant_id) DO NOTHING", tenant);
        return root.queryForObject("INSERT INTO kostenstelle (tenant_id, unternehmen_id, kennzeichen, name, gueltig_ab) "
                + "SELECT u.tenant_id, u.id, 'K-' || (SELECT count(*) + 1 FROM kostenstelle k WHERE k.tenant_id = u.tenant_id), "
                + "'Spritzguss', DATE '2026-10-01' FROM unternehmen u WHERE u.tenant_id = ? RETURNING id", UUID.class, tenant);
    }

    private static UUID komponente(UUID tenant, int nr) {
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, now()) "
                + "RETURNING id", UUID.class, tenant, "Anlage #" + nr);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, name, status, created_at) "
                + "VALUES (?, ?, ?, 'Box', 'claimed', now()) RETURNING id", UUID.class, tenant, anlage, "V-" + nr);
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "device_id, control, communication, created_at) VALUES (?, ?, 'battery-hybrid', 'Wechselrichter', "
                + "'battery-hybrid', ?, false, 'modbus_tcp', now()) RETURNING id", UUID.class, tenant, anlage, box);
    }

    private static UUID messstelle(UUID tenant, String kennzeichen, String art, Groesse g) {
        return als(tenant, () -> messstellen.anlegen(new NeueMessstelle(tenant, kennzeichen,
                "Messstelle " + kennzeichen, art, "Strom", g, null))).id();
    }

    private static void kanalTerm(UUID tenant, UUID messstelle, int position, UUID komponente, String kanal,
            String vorzeichen, double faktor) {
        root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, position, eingang_art, entity_id, "
                + "point_key, vorzeichen, faktor) VALUES (?, ?, ?, 'messkanal', ?, ?, ?, ?)",
                tenant, messstelle, position, komponente, kanal, vorzeichen, faktor);
    }

    private static <T> T als(UUID tenant, Supplier<T> arbeit) {
        TenantContext.set(tenant);
        try {
            return arbeit.get();
        } finally {
            TenantContext.clear();
        }
    }

    private static void alsTue(UUID tenant, Runnable arbeit) {
        als(tenant, () -> {
            arbeit.run();
            return null;
        });
    }

    private static void abgelehnt(String constraint, Runnable arbeit) {
        Throwable t = null;
        try {
            arbeit.run();
        } catch (Throwable e) {
            t = e;
        }
        assertThat(t).as("die Datenbank muss ablehnen (" + constraint + ")").isNotNull();
        PSQLException p = null;
        for (Throwable c = t; c != null; c = c.getCause()) {
            if (c instanceof PSQLException pe) {
                p = pe;
            }
        }
        assertThat((Object) p).as("eine PSQLException: " + t.getMessage()).isNotNull();
        assertThat(p.getServerErrorMessage().getConstraint()).as(p.getMessage()).isEqualTo(constraint);
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
