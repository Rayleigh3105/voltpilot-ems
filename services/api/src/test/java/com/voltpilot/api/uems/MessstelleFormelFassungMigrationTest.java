package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.MessstelleFormelFassungRepository.FassungZeile;
import com.voltpilot.api.uems.MessstelleFormelTermRepository.TermZeile;
import com.voltpilot.api.uems.MessstelleRegeln.Groesse;
import com.voltpilot.api.uems.MessstelleRepository.NeueMessstelle;
import java.time.Instant;
import java.time.LocalDate;
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
 * Die Formel-Fassungen (UEMS AP-10 IP-3, {@code V20260912210000}) gegen eine echte TimescaleDB — mit
 * einem BESTAND, der vor der Migration so geschrieben wurde, wie PR #688 schrieb:
 *
 * <ul>
 *   <li>Rückfüllen: je berechneter Messstelle mit Termen GENAU EINE Fassung 1 (ohne ersten Tag,
 *       Herkunft {@code bestand}, von VoltPilot), jeder Term zeigt auf sie; ohne Term keine Fassung.
 *   <li>Fingerabdruck: Messstellen, Protokoll und jede Bestandsspalte der Terme sind nach der
 *       Migration Zeichen für Zeichen dieselben.
 *   <li>Verhaltensgleich: die Terme, die die Berechnung an JEDEM Tag liest (Fassung des Tages), und
 *       der Stand des Lebenszyklus sind die, die der Leseweg von PR #688 las.
 *   <li>Zaun, Rechte, die zeitlose Hälfte der Tages-Regeln in der Datenbank, der Weg für Schreiber
 *       ohne Fassung und das Offboarding.
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
class MessstelleFormelFassungMigrationTest {

    private static final String DIESE = "20260912210000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final Groesse WIRKLEISTUNG = new Groesse("Wirkleistung", "Erzeugung", "kW", "Momentanwert");
    private static final Groesse GEMESSEN = new Groesse("Wirkenergie", "Bezug", "kWh", "Zählerstand");

    /** Der Leseweg von PR #688 (MessstelleFormelTermRepository.derMessstelle vor IP-3), wörtlich. */
    private static final String TERME_VOR_IP3 = "SELECT id FROM messstelle_formel_term WHERE messstelle_id = ? "
            + "ORDER BY position";

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
    private static MessstelleFormelFassungRepository fassungen;

    /** Der Bestand: Mandant A mit drei berechneten (PV-Summe, Baustein, ohne Formel) + gemessen, Mandant B. */
    private static UUID mandantA;
    private static UUID mandantB;
    private static UUID pvSumme;
    private static UUID baustein;
    private static UUID ohneFormel;
    private static UUID gemessenA;
    private static UUID pvB;
    private static final Map<UUID, List<UUID>> TERME_VORHER = new LinkedHashMap<>();
    private static final Map<UUID, List<Boolean>> STAND_VORHER = new LinkedHashMap<>();
    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachher;
    private static int fassungenNachMigration;

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        messstellen = new MessstelleRepository(app);

        // ---- der Bestand, geschrieben wie PR #688 (ohne Fassung — die Spalte gibt es noch nicht)
        mandantA = mandant("Bestand A");
        mandantB = mandant("Bestand B");
        UUID komponenteA = komponente(mandantA, 1);
        UUID komponenteB = komponente(mandantB, 2);
        gemessenA = messstelle(mandantA, "MS-0001", "gemessen", GEMESSEN);
        pvSumme = messstelle(mandantA, "MS-0002", "berechnet", WIRKLEISTUNG);
        baustein = messstelle(mandantA, "MS-0003", "berechnet", WIRKLEISTUNG);
        ohneFormel = messstelle(mandantA, "MS-0004", "berechnet", WIRKLEISTUNG);
        pvB = messstelle(mandantB, "MS-0001", "berechnet", WIRKLEISTUNG);
        // Die Reihenfolge der Positionen ist absichtlich nicht die des Einfügens.
        kanalTerm(mandantA, pvSumme, 2, komponenteA, "deye.hybrid_3p.pv.pv3-power", "+", 1);
        kanalTerm(mandantA, pvSumme, 0, komponenteA, "deye.hybrid_3p.pv.pv1-power", "+", 1);
        kanalTerm(mandantA, pvSumme, 1, komponenteA, "deye.hybrid_3p.pv.pv2-power", "-", 0.5);
        root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, position, eingang_art, "
                + "quell_messstelle_id, vorzeichen, faktor) VALUES (?, ?, 0, 'messstelle', ?, '+', 1)",
                mandantA, baustein, pvSumme);
        kanalTerm(mandantA, baustein, 1, komponenteA, "deye.hybrid_3p.pv.pv3-power", "+", 2);
        kanalTerm(mandantB, pvB, 0, komponenteB, "deye.hybrid_3p.pv.pv1-power", "+", 1);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, "
                + "point_key, enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, "
                + "apply_status, retention_class, long_term_strategy) SELECT p.tenant_id, p.site_id, p.device_id, "
                + "p.id, 'deye.hybrid_3p.pv.pv1-power', true, 60, 1, now(), '2026.09.11.1', 'test', "
                + "'pending_edge', 'energy_counter', 'fifteen_minute' FROM measurement_point p WHERE p.id = ?",
                komponenteA);
        root.update("INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, art, alt, neu, gilt_ab, "
                + "rueckwirkend, actor_name, actor_art) VALUES (?, ?, 'angelegt', NULL, '{\"art\":\"berechnet\"}', "
                + "date_trunc('minute', now()), false, 'VoltPilot', 'voltpilot')", mandantA, pvSumme);

        for (UUID m : List.of(pvSumme, baustein, ohneFormel, pvB)) {
            TERME_VORHER.put(m, root.queryForList(TERME_VOR_IP3, UUID.class, m));
            STAND_VORHER.put(m, standVorIp3(m));
        }
        fingerVorher = fingerabdruck();

        flyway().target(DIESE).load().migrate();
        fingerNachher = fingerabdruck();
        fassungenNachMigration = root.queryForObject("SELECT count(*) FROM messstelle_formel_fassung", Integer.class);
        flyway().load().migrate();

        terme = new MessstelleFormelTermRepository(app);
        fassungen = new MessstelleFormelFassungRepository(app);
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ===================================================================== Rückfüllen

    @Test
    void jedeBerechneteMessstelleMitTermenBekommtGenauEineFassungEins() {
        assertThat(fassungenNachMigration).as("PV-Summe, Baustein, Mandant B — nicht die ohne Formel").isEqualTo(3);
        List<Map<String, Object>> zeilen = root.queryForList("SELECT messstelle_id, nummer, formel_typ, gueltig_ab, "
                + "gueltig_bis, aufgehoben_am, herkunft, rueckwirkend, begruendung, actor_sub, actor_name, actor_art "
                + "FROM messstelle_formel_fassung WHERE herkunft = 'bestand' ORDER BY messstelle_id");
        assertThat(zeilen).extracting(z -> z.get("messstelle_id"))
                .containsExactlyInAnyOrder(pvSumme, baustein, pvB);
        for (Map<String, Object> z : zeilen) {
            assertThat(z.get("nummer")).isEqualTo(1);
            assertThat(z.get("formel_typ")).isEqualTo("gewichtete_summe");
            assertThat(z.get("gueltig_ab")).as("gilt seit Beginn").isNull();
            assertThat(z.get("gueltig_bis")).isNull();
            assertThat(z.get("aufgehoben_am")).isNull();
            assertThat(z.get("rueckwirkend")).isEqualTo(false);
            assertThat(z.get("begruendung")).isNull();
            assertThat(z.get("actor_sub")).isNull();
            assertThat(z.get("actor_name")).isEqualTo("VoltPilot");
            assertThat(z.get("actor_art")).isEqualTo("voltpilot");
        }
        // Jeder Term zeigt auf die Fassung SEINER Messstelle; die Spalte ist Pflicht.
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle_formel_term t JOIN messstelle_formel_fassung f "
                + "ON f.id = t.fassung_id AND f.messstelle_id = t.messstelle_id", Integer.class)).isEqualTo(6);
        assertThat(root.queryForObject("SELECT is_nullable FROM information_schema.columns WHERE table_name = "
                + "'messstelle_formel_term' AND column_name = 'fassung_id'", String.class)).isEqualTo("NO");
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle_formel_fassung WHERE messstelle_id IN (?, ?)",
                Integer.class, ohneFormel, gemessenA)).isZero();
        // Wiederholbar: ein zweiter Lauf legt nichts an.
        assertThat(root.queryForObject("SELECT uems_formel_fassung_bestand()", Integer.class)).isZero();
    }

    @Test
    void derFingerabdruckDesBestandsBleibtStehen() {
        assertThat(fingerVorher.values()).as("es gibt Bestand — sonst bewiese Gleichheit nichts")
                .doesNotContain("leer");
        assertThat(fingerNachher).isEqualTo(fingerVorher);
    }

    /** Der Vergleich beißt noch: eine geänderte Messstelle fällt auf, eine leere neue Spalte nicht. */
    @Test
    void derBestandsvergleichFaengtEineGeaenderteZeile() {
        Bestandsschutz.inhaltsprobe(root, MessstelleFormelFassungMigrationTest::fingerabdruck, "messstelle",
                "UPDATE messstelle SET name = coalesce(name, 'Probe') || ' (Probe)'");
    }

    @Test
    void derBestandRechnetNachDerMigrationAnJedemTagUnveraendert() {
        for (Map.Entry<UUID, List<UUID>> e : TERME_VORHER.entrySet()) {
            UUID m = e.getKey();
            UUID tenant = m.equals(pvB) ? mandantB : mandantA;
            for (LocalDate tag : List.of(LocalDate.of(1990, 1, 1), LocalDate.of(2026, 9, 12),
                    LocalDate.now(), LocalDate.of(2099, 12, 31))) {
                List<UUID> heute = als(tenant, () -> {
                    List<FassungZeile> wirksam = fassungen.wirksame(m);
                    return MessstelleFormelRegeln.fassungAm(wirksam.stream().map(FassungZeile::alsRegel).toList(), tag)
                            .map(f -> wirksam.stream().filter(z -> z.nummer() == f.nummer()).findFirst().orElseThrow())
                            .map(f -> terme.derFassung(f.id()).stream().map(TermZeile::id).toList())
                            .orElse(List.of());
                });
                assertThat(heute).as("Terme von %s am %s", m, tag).containsExactlyElementsOf(e.getValue());
                MessstelleFormelTermRepository.FormelStand stand = als(tenant, () -> terme.stand(m, tag));
                assertThat(List.of(stand.vorhanden(), stand.eingerichtet())).as("Stand von %s am %s", m, tag)
                        .isEqualTo(STAND_VORHER.get(m));
            }
        }
        assertThat(TERME_VORHER.get(pvSumme)).hasSize(3);
        assertThat(STAND_VORHER.get(pvSumme)).containsExactly(true, false);
        assertThat(STAND_VORHER.get(ohneFormel)).containsExactly(false, false);
    }

    // ===================================================================== Zaun + Rechte

    @Test
    void derZaunStehtUndDieRechteSindBeschnitten() {
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'messstelle_formel_fassung'", Boolean.class)).isTrue();
        assertThat(root.queryForObject("SELECT count(*) FROM pg_policies WHERE tablename = "
                + "'messstelle_formel_fassung' AND qual LIKE '%app.tenant_id%' "
                + "AND with_check LIKE '%app.tenant_id%'", Long.class)).isOne();
        assertThat(app.queryForObject("SELECT count(*) FROM messstelle_formel_fassung", Long.class))
                .as("ohne Mandant: nichts").isZero();
        assertThat(als(mandantB, () -> fassungen.wirksame(pvSumme))).as("B sieht A nicht").isEmpty();
        assertThat(als(mandantB, () -> fassungen.wirksame(pvB))).hasSize(1);
        assertThat(als(mandantB, () -> app.queryForObject(
                "SELECT count(*) FROM messstelle_formel_fassung WHERE tenant_id <> ?", Long.class, mandantB))).isZero();

        assertThat(rechte("messstelle_formel_fassung")).isEqualTo("SI");
        assertThat(spalteAenderbar("gueltig_bis")).isTrue();
        assertThat(spalteAenderbar("aufgehoben_am")).isTrue();
        assertThat(spalteAenderbar("gueltig_ab")).isFalse();
        assertThat(spalteAenderbar("nummer")).isFalse();
        assertThat(rechte("messstelle_formel_term")).as("Terme sind Historie ihrer Fassung").isEqualTo("SI");
    }

    // ============================================================ die Tage in der Datenbank

    @Test
    void dieDatenbankHaeltDieZeitloseHaelfteDerTagesRegeln() {
        UUID t = mandant("Tage");
        UUID ms = messstelle(t, "MS-0001", "berechnet", WIRKLEISTUNG);
        UUID gem = messstelle(t, "MS-0002", "gemessen", GEMESSEN);
        UUID eins = als(t, () -> fassungen.anlegen(ms, 1, "gewichtete_summe", null, "anlage", false, null,
                Instant.now(), ProtokollAkteur.bestandsuebernahme()));

        // Zwei Fassungen an einem Tag: die Exklusion (Fassung 1 ist noch offen).
        abgelehnt("messstelle_formel_fassung_keine_ueberlappung", () -> alsTue(t, () -> fassungen.anlegen(ms, 2,
                "gewichtete_summe", LocalDate.of(2026, 10, 18), "eintrag", false, null, Instant.now(), kunde())));
        // Nur Fassung 1 darf ohne ersten Tag sein.
        abgelehnt("messstelle_formel_fassung_ab_chk", () -> alsTue(t, () -> fassungen.anlegen(ms, 2,
                "gewichtete_summe", null, "eintrag", false, null, Instant.now(), kunde())));
        // Heute gibt es nur die gewichtete Summe (rest/saldo: IP-4).
        abgelehnt("messstelle_formel_fassung_typ_chk", () -> alsTue(t, () -> fassungen.anlegen(ms, 2,
                "rest", LocalDate.of(2026, 10, 18), "eintrag", false, null, Instant.now(), kunde())));
        // Nur an einer berechneten Messstelle.
        abgelehnt("messstelle_formel_fassung_nur_berechnet", () -> alsTue(t, () -> fassungen.anlegen(gem, 1,
                "gewichtete_summe", LocalDate.of(2026, 10, 18), "eintrag", false, null, Instant.now(), kunde())));

        // Der Weg der Regel: Fassung 1 endet am Vortag, Fassung 2 beginnt.
        alsTue(t, () -> fassungen.beenden(eins, LocalDate.of(2026, 10, 17)));
        UUID zwei = als(t, () -> fassungen.anlegen(ms, 2, "gewichtete_summe", LocalDate.of(2026, 10, 18), "eintrag",
                true, "Unterzähler MS-18 ergänzt", Instant.now(), kunde()));
        assertThat(als(t, () -> fassungen.wirksame(ms))).extracting(FassungZeile::nummer).containsExactly(1, 2);
        // Nur verkürzt, nie verlängert.
        abgelehnt("messstelle_formel_fassung_nur_verkuerzen",
                () -> alsTue(t, () -> fassungen.beenden(eins, LocalDate.of(2026, 10, 20))));
        abgelehnt("messstelle_formel_fassung_unveraenderlich", () -> root.update(
                "UPDATE messstelle_formel_fassung SET nummer = 7 WHERE id = ?", zwei));

        // Ein Schreiber ohne Fassung: bei ZWEI Fassungen nicht mehr eindeutig.
        abgelehnt("messstelle_formel_term_fassung_noetig", () -> alsTue(t, () -> terme.anlegen(ms, 0, "messstelle",
                null, null, gem, "+", 1.0)));
        // Mit Fassung: nimmt an; die Reihenfolge zählt je Fassung.
        alsTue(t, () -> terme.anlegen(eins, ms, 0, "messstelle", null, null, gem, "+", 1.0));
        alsTue(t, () -> terme.anlegen(zwei, ms, 0, "messstelle", null, null, gem, "+", 2.0));
        assertThat(als(t, () -> terme.derFassung(zwei))).extracting(TermZeile::faktor).containsExactly(2.0);

        // Ein Term nie in der Fassung einer ANDEREN Messstelle.
        UUID andere = messstelle(t, "MS-0003", "berechnet", WIRKLEISTUNG);
        abgelehnt("messstelle_formel_term_fassung_fk", () -> alsTue(t, () -> terme.anlegen(zwei, andere, 1,
                "messstelle", null, null, gem, "+", 1.0)));

        // Nur aufgehobene Fassungen: ihre Nummern werden nie wiederverwendet — kein stilles Fassung 1.
        UUID aufgehoben = messstelle(t, "MS-0004", "berechnet", WIRKLEISTUNG);
        UUID weg = als(t, () -> fassungen.anlegen(aufgehoben, 1, "gewichtete_summe", null, "anlage", false, null,
                Instant.now(), ProtokollAkteur.bestandsuebernahme()));
        alsTue(t, () -> app.update("UPDATE messstelle_formel_fassung SET aufgehoben_am = now() WHERE id = ?", weg));
        assertThat(als(t, () -> fassungen.hoechsteNummer(aufgehoben))).isEqualTo(1);
        abgelehnt("messstelle_formel_term_fassung_noetig", () -> alsTue(t, () -> terme.anlegen(aufgehoben, 0,
                "messstelle", null, null, gem, "+", 1.0)));

        // Ohne Fassung an einer Messstelle ohne Fassung: Fassung 1 ohne ersten Tag entsteht.
        alsTue(t, () -> terme.anlegen(andere, 0, "messstelle", null, null, gem, "+", 1.0));
        assertThat(als(t, () -> fassungen.wirksame(andere))).singleElement().satisfies(f -> {
            assertThat(f.nummer()).isEqualTo(1);
            assertThat(f.gueltigAb()).isNull();
            assertThat(f.herkunft()).isEqualTo("anlage");
        });
    }

    @Test
    void dasOffboardingRaeumtTermeUndFassungenAb() {
        UUID t = mandant("Offboarding");
        UUID ms = messstelle(t, "MS-0001", "berechnet", WIRKLEISTUNG);
        UUID gem = messstelle(t, "MS-0002", "gemessen", GEMESSEN);
        alsTue(t, () -> terme.anlegen(ms, 0, "messstelle", null, null, gem, "+", 1.0));
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle_formel_fassung WHERE tenant_id = ?",
                Integer.class, t)).isOne();

        new TenantRepository(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW))).offboard(t);

        for (String tabelle : List.of("messstelle_formel_term", "messstelle_formel_fassung", "messstelle", "tenant")) {
            String spalte = tabelle.equals("tenant") ? "id" : "tenant_id";
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE " + spalte + " = ?",
                    Integer.class, t)).as(tabelle).isZero();
        }
    }

    // ===================================================================== Gerüst

    /** Die Zählung des Lebenszyklus vor IP-3 (MessstelleFormelTermRepository.stand), wörtlich. */
    private static List<Boolean> standVorIp3(UUID m) {
        Integer gesamt = root.queryForObject("SELECT count(*) FROM messstelle_formel_term WHERE messstelle_id = ?",
                Integer.class, m);
        if (gesamt == null || gesamt == 0) {
            return List.of(false, false);
        }
        Integer unaufloesbar = root.queryForObject("""
                SELECT count(*) FROM messstelle_formel_term t
                 WHERE t.messstelle_id = ?
                   AND (
                     (t.eingang_art = 'messkanal' AND NOT EXISTS (
                        SELECT 1 FROM device_measurement_selection s
                         WHERE s.entity_id = t.entity_id AND s.point_key = t.point_key))
                     OR (t.eingang_art = 'messstelle' AND NOT EXISTS (
                        SELECT 1 FROM messstelle q
                         WHERE q.id = t.quell_messstelle_id AND q.archiviert_am IS NULL))
                   )
                """, Integer.class, m);
        return List.of(true, unaufloesbar == null || unaufloesbar == 0);
    }

    /**
     * Der Inhalt jeder Bestands-Tabelle als ein Wert ({@link Bestandsschutz#inhalt}) — bei den Termen
     * bewusst NICHT: diese Migration füllt an jedem bestehenden Term neue Spalten mit Wert, die der
     * gemeinsame Vergleich zu Recht als geänderten Bestand meldete. Die Zusage hier ist enger —
     * „jede Spalte VOR IP-3 bleibt stehen" —, darum zählen die Terme ihre alten Spalten mit Namen auf.
     */
    private static Map<String, String> fingerabdruck() {
        Map<String, String> aus = new LinkedHashMap<>();
        for (String tabelle : List.of("messstelle", "messstelle_aenderung", "messstelle_kennzeichen")) {
            aus.put(tabelle, Bestandsschutz.inhalt(root, tabelle, null));
        }
        aus.put("messstelle_formel_term", root.queryForObject("SELECT coalesce(md5(string_agg(concat_ws('~', id, "
                + "tenant_id, messstelle_id, position, eingang_art, entity_id, point_key, quell_messstelle_id, "
                + "vorzeichen, faktor, created_at, updated_at), '|' ORDER BY id)), 'leer') FROM messstelle_formel_term",
                String.class));
        return aus;
    }

    private static UUID mandant(String name) {
        return root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
    }

    private static UUID komponente(UUID tenant, int nr) {
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, now()) "
                + "RETURNING id", UUID.class, tenant, "Anlage #" + nr);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, name, status, created_at) "
                + "VALUES (?, ?, ?, 'Box', 'claimed', now()) RETURNING id", UUID.class, tenant, anlage, "F-" + nr);
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

    private static ProtokollAkteur kunde() {
        return new ProtokollAkteur("sub-ines", "Ines Kaltenbach", "energiemanager", "kunde");
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

    private static String rechte(String tabelle) {
        StringBuilder s = new StringBuilder();
        for (String[] r : new String[][] {{"S", "SELECT"}, {"I", "INSERT"}, {"U", "UPDATE"}, {"D", "DELETE"}}) {
            if (Boolean.TRUE.equals(root.queryForObject("SELECT has_table_privilege(?, ?, ?)",
                    Boolean.class, APP_USER, tabelle, r[1]))) {
                s.append(r[0]);
            }
        }
        return s.toString();
    }

    private static boolean spalteAenderbar(String spalte) {
        return Boolean.TRUE.equals(root.queryForObject("SELECT has_column_privilege(?, 'messstelle_formel_fassung', ?, "
                + "'UPDATE')", Boolean.class, APP_USER, spalte));
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
