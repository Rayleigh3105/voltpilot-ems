package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
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
 * Die Quellenbindung an der Datenbankgrenze (Migration V20260911250000, UEMS AP-04 IP-13): der
 * Mandantenzaun, die drei Verbote als Exklusion (eine führende Quelle je Größe und Zeitpunkt,
 * dieselbe Vergleichsquelle nie doppelt, ein Messwert führt nur EINE Messstelle), die CHECKs,
 * „nur einmal beendet, nie überschrieben“, die Rechte der App-Rolle, das Löschen von Komponente
 * und Anlage und das Offboarding.
 *
 * <p>Die Zeitpunkte sind die des Zählerwechsels von MS-06 im Referenzunternehmen
 * ({@code uems-referenzunternehmen.json}: Z-5a bis 18.11.2026 10:40, Z-5b ab 10:40).
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsMessstelleQuelleMigrationTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final Instant BEGINN = Instant.parse("2024-03-11T23:00:00Z");   // 12.03.2024 00:00 MEZ
    private static final Instant WECHSEL = Instant.parse("2026-11-18T09:40:00Z");  // 18.11.2026 10:40 MEZ
    private static final Instant EINGETRAGEN = Instant.parse("2026-11-18T10:05:00Z");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static JdbcTemplate admin;

    @BeforeAll
    static void migriere() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW))
                .load().migrate();
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ---- Der Zaun -------------------------------------------------------------------------

    @Test
    void derZaunStehtUndDerMandantReistInJedemVerweisMit() {
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'messstelle_quelle'", Boolean.class)).isTrue();
        assertThat(anzahl("SELECT count(*) FROM pg_policies WHERE tablename = 'messstelle_quelle'")).isOne();
        assertThat(root.queryForObject("SELECT qual IS NOT NULL AND with_check IS NOT NULL FROM pg_policies "
                + "WHERE tablename = 'messstelle_quelle'", Boolean.class)).as("USING und WITH CHECK").isTrue();

        Werkstatt a = new Werkstatt("Quelle Zaun A");
        Werkstatt b = new Werkstatt("Quelle Zaun B");
        UUID ms = a.messstelle("MS-06");
        UUID k = a.komponente();
        a.quelle(ms, "Wirkenergie", "Bezug", k, "fuehrend", null, BEGINN, WECHSEL);

        // Ohne gewählten Kundenbereich sieht die App-Rolle nichts, mit ihm nur den eigenen.
        assertThat(app.queryForObject("SELECT count(*) FROM messstelle_quelle", Long.class)).isZero();
        assertThat(als(b.tenant, () -> app.queryForObject("SELECT count(*) FROM messstelle_quelle", Long.class)))
                .isZero();
        assertThat(als(a.tenant, () -> app.queryForObject("SELECT count(*) FROM messstelle_quelle", Long.class)))
                .isOne();

        // Keine Zeile für einen fremden Mandanten und keine an einer fremden Messstelle: der Trigger
        // sieht sie unter RLS gar nicht und sagt nur „keine Größe dieser Messstelle“ — nichts über
        // die fremde; dahinter stünde das WITH CHECK der Policy.
        abgelehnt("23514", "messstelle_quelle_groesse_der_messstelle", () -> alsTue(b.tenant, () -> einfuegen(
                a.tenant, ms, "Wirkenergie", "Bezug", k, a.geraet(k), "sunspec.model_203.totwhimp", "fuehrend", null,
                WECHSEL, null)));
        // Keine an einer fremden Komponente oder einem fremden Gerät (die zusammengesetzten
        // Fremdschlüssel).
        UUID fremdeK = b.komponente();
        abgelehnt("23514", "messstelle_quelle_groesse_der_messstelle", () -> alsTue(b.tenant, () -> einfuegen(
                b.tenant, ms, "Wirkenergie", "Bezug", fremdeK, b.geraet(fremdeK), "sunspec.model_203.totwhimp",
                "fuehrend", null, WECHSEL, null)));
        UUID eigeneMs = b.messstelle("MS-06");
        abgelehnt("23503", "messstelle_quelle_entity_fk", () -> alsTue(b.tenant, () -> einfuegen(b.tenant,
                eigeneMs, "Wirkenergie", "Bezug", k, b.geraet(fremdeK), "sunspec.model_203.totwhimp", "fuehrend",
                null, WECHSEL, null)));
        abgelehnt("23503", "messstelle_quelle_geraet_fk", () -> alsTue(b.tenant, () -> einfuegen(b.tenant,
                eigeneMs, "Wirkenergie", "Bezug", fremdeK, a.geraet(k), "sunspec.model_203.totwhimp", "fuehrend",
                null, WECHSEL, null)));
    }

    // ---- Die drei Verbote -----------------------------------------------------------------

    /**
     * Regel 1: je Größe und Zeitpunkt EINE führende Quelle — berühren ja (Z-5a bis 10:40, Z-5b ab
     * 10:40), überschneiden nie, auch nicht um eine Minute. Eine Nebengröße hat ihre eigene.
     * Eine Lücke ist erlaubt: die Datenbank füllt nichts auf.
     */
    @Test
    void jeGroesseUndZeitpunktEineFuehrendeQuelleUndLueckenSindErlaubt() {
        Werkstatt w = new Werkstatt("Quelle Regel 1");
        UUID ms = w.messstelle("MS-06");
        w.nebengroesse(ms, "Wirkleistung", "Bezug", "kW", "Momentanwert");
        UUID k = w.komponente();
        w.quelle(ms, "Wirkenergie", "Bezug", k, "fuehrend", null, BEGINN, WECHSEL);
        w.quelle(ms, "Wirkenergie", "Bezug", k, "fuehrend", null, WECHSEL, WECHSEL.plusSeconds(3600));
        abgelehnt("23P01", "messstelle_quelle_eine_fuehrende_je_groesse", () -> w.quelle(ms, "Wirkenergie", "Bezug",
                k, "fuehrend", null, WECHSEL.minusSeconds(60), null));
        // Eine Lücke von 11:40 bis 12:00, dann wieder eine Quelle — erlaubt.
        w.quelle(ms, "Wirkenergie", "Bezug", k, "fuehrend", null, WECHSEL.plusSeconds(4800), null);
        // Die Nebengröße liest denselben Zeitraum aus ihrem eigenen Messwert.
        w.quelleKanal(ms, "Wirkleistung", "Bezug", k, "sunspec.model_203.w", "gauge", "momentanwert", "fuehrend",
                null, BEGINN, null);
        assertThat(w.quellen(ms)).isEqualTo(4);
    }

    /** Vergleichsquellen 0..n nebeneinander — nur derselbe Messwert nie zweimal zugleich. */
    @Test
    void vergleichsquellenUeberlappenAberNieDieselbeZweimal() {
        Werkstatt w = new Werkstatt("Quelle Vergleich");
        UUID ms = w.messstelle("MS-01");
        UUID k3 = w.komponente();
        UUID k1 = w.komponente();
        UUID k4 = w.komponente();
        w.quelle(ms, "Wirkenergie", "Bezug", k3, "fuehrend", null, BEGINN, null);
        w.quelle(ms, "Wirkenergie", "Bezug", k1, "vergleich", "Plausibilität", BEGINN, null);
        w.quelle(ms, "Wirkenergie", "Bezug", k4, "vergleich", "Abrechnungszähler", WECHSEL, null);
        abgelehnt("23P01", "messstelle_quelle_vergleich_nie_doppelt", () -> w.quelle(ms, "Wirkenergie", "Bezug",
                k1, "vergleich", "Ersatz bei Ausfall", WECHSEL, null));
        assertThat(w.quellen(ms)).isEqualTo(3);
    }

    /**
     * Ein Messwert speist je Zeitpunkt höchstens EINE Messstelle führend; innerhalb einer
     * Messstelle darf er zwei Größen speisen (MS-03 „PV-Leistung“), zum Vergleich darf er
     * überall stehen.
     */
    @Test
    void einMesswertFuehrtHoechstensEineMessstelle() {
        Werkstatt w = new Werkstatt("Quelle Kanal");
        UUID ms06 = w.messstelle("MS-06");
        UUID ms07 = w.messstelle("MS-07");
        UUID ms03 = w.messstelle("MS-03", "Wirkenergie", "Erzeugung", "kWh", "Intervallmenge");
        w.nebengroesse(ms03, "Wirkleistung", "Erzeugung", "kW", "Momentanwert");
        UUID k5 = w.komponente();
        UUID k1 = w.komponente();
        w.quelle(ms06, "Wirkenergie", "Bezug", k5, "fuehrend", null, BEGINN, WECHSEL);
        abgelehnt("23P01", "messstelle_quelle_kanal_fuehrt_eine_messstelle", () -> w.quelle(ms07, "Wirkenergie",
                "Bezug", k5, "fuehrend", null, WECHSEL.minusSeconds(60), null));
        // Nach dem Ende bei MS-06 darf derselbe Messwert MS-07 führen, und zum Vergleich ohnehin.
        w.quelle(ms07, "Wirkenergie", "Bezug", k5, "fuehrend", null, WECHSEL, null);
        w.quelle(ms06, "Wirkenergie", "Bezug", k5, "vergleich", "Plausibilität", WECHSEL, null);
        // MS-03: „PV-Leistung“ für Energie (integriert) und Leistung.
        w.quelleKanal(ms03, "Wirkenergie", "Erzeugung", k1, "sunspec.model_103.w", "gauge", "integration",
                "fuehrend", null, BEGINN, null);
        w.quelleKanal(ms03, "Wirkleistung", "Erzeugung", k1, "sunspec.model_103.w", "gauge", "momentanwert",
                "fuehrend", null, BEGINN, null);
        assertThat(w.quellen(ms03)).isEqualTo(2);
    }

    // ---- Die CHECKs ----------------------------------------------------------------------

    @Test
    void dieChecksLehnenAbStattZuRundenOderZuRaten() {
        Werkstatt w = new Werkstatt("Quelle Checks");
        UUID ms = w.messstelle("MS-06");
        UUID k = w.komponente();
        UUID g = w.geraet(k);
        String kanal = "sunspec.model_203.totwhimp";
        alsTue(w.tenant, () -> {
            abgelehnt("23514", "messstelle_quelle_volle_minute", () -> einfuegen(w.tenant, ms, "Wirkenergie",
                    "Bezug", k, g, kanal, "fuehrend", null, WECHSEL.plusSeconds(30), null));
            abgelehnt("23514", "messstelle_quelle_nicht_leer", () -> einfuegen(w.tenant, ms, "Wirkenergie",
                    "Bezug", k, g, kanal, "fuehrend", null, WECHSEL, WECHSEL));
            abgelehnt("23514", "messstelle_quelle_zweck_chk", () -> einfuegen(w.tenant, ms, "Wirkenergie",
                    "Bezug", k, g, kanal, "vergleich", null, WECHSEL, null));
            abgelehnt("23514", "messstelle_quelle_zweck_chk", () -> einfuegen(w.tenant, ms, "Wirkenergie",
                    "Bezug", k, g, kanal, "fuehrend", "Plausibilität", WECHSEL, null));
            abgelehnt("23514", "messstelle_quelle_zweck_chk", () -> einfuegen(w.tenant, ms, "Wirkenergie",
                    "Bezug", k, g, kanal, "vergleich", "Gefühl", WECHSEL, null));
            abgelehnt("23514", "messstelle_quelle_rolle_chk", () -> einfuegen(w.tenant, ms, "Wirkenergie",
                    "Bezug", k, g, kanal, "nebenbei", null, WECHSEL, null));
            // Die Herleitung folgt aus der Wertart: ein Zählerstand wird nie „integriert“.
            abgelehnt("23514", "messstelle_quelle_herleitung_chk", () -> app.update("INSERT INTO messstelle_quelle "
                    + "(tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, kanal, kanal_wertart, "
                    + "herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_sub, actor_name, "
                    + "actor_art) VALUES (?, ?, 'Wirkenergie', 'Bezug', ?, ?, ?, 'counter', 'integration', "
                    + "'fuehrend', ?, false, ?, 'sub', 'Ines Kaltenbach', 'kunde')", w.tenant, ms, k, g, kanal,
                    ts(WECHSEL), ts(EINGETRAGEN)));
            // Ein Endstand gehört zum Ende; eine Einheit nie ohne Stand.
            abgelehnt("23514", "messstelle_quelle_stand_chk", () -> app.update("INSERT INTO messstelle_quelle "
                    + "(tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, kanal, kanal_wertart, "
                    + "herleitung, rolle, gueltig_ab, endstand, endstand_einheit, rueckwirkend, eingetragen_am, "
                    + "actor_sub, actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', 'Bezug', ?, ?, ?, 'counter', "
                    + "'zaehlerstand', 'fuehrend', ?, 1083415.2, 'kWh', false, ?, 'sub', 'Ines Kaltenbach', "
                    + "'kunde')", w.tenant, ms, k, g, kanal, ts(WECHSEL), ts(EINGETRAGEN)));
            abgelehnt("23514", "messstelle_quelle_stand_chk", () -> app.update("INSERT INTO messstelle_quelle "
                    + "(tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, kanal, kanal_wertart, "
                    + "herleitung, rolle, gueltig_ab, anfangsstand_einheit, rueckwirkend, eingetragen_am, "
                    + "actor_sub, actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', 'Bezug', ?, ?, ?, 'counter', "
                    + "'zaehlerstand', 'fuehrend', ?, 'kWh', false, ?, 'sub', 'Ines Kaltenbach', 'kunde')",
                    w.tenant, ms, k, g, kanal, ts(WECHSEL), ts(EINGETRAGEN)));
            // „rückwirkend“ ist ein Urteil über die Vergangenheit.
            abgelehnt("23514", "messstelle_quelle_rueckwirkend_chk", () -> app.update("INSERT INTO "
                    + "messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, kanal, "
                    + "kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_sub, "
                    + "actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', 'Bezug', ?, ?, ?, 'counter', "
                    + "'zaehlerstand', 'fuehrend', ?, true, ?, 'sub', 'Ines Kaltenbach', 'kunde')", w.tenant, ms,
                    k, g, kanal, ts(EINGETRAGEN), ts(WECHSEL)));
            // Die Größe gehört zur Messstelle.
            abgelehnt("23514", "messstelle_quelle_groesse_der_messstelle", () -> einfuegen(w.tenant, ms,
                    "Wirkenergie", "Abgabe", k, g, "sunspec.model_203.totwhexp", "fuehrend", null, WECHSEL, null));
        });
        assertThat(w.quellen(ms)).isZero();
    }

    // ---- Nur einmal beendet ----------------------------------------------------------------

    @Test
    void dieAppRolleLoeschtNieUndBeendetGenauEinmal() {
        Werkstatt w = new Werkstatt("Quelle Rechte");
        UUID ms = w.messstelle("MS-06");
        UUID k = w.komponente();
        UUID q = w.quelle(ms, "Wirkenergie", "Bezug", k, "fuehrend", null, BEGINN, null);
        alsTue(w.tenant, () -> {
            abgelehntWegen("42501", "permission denied", () -> app.update("DELETE FROM messstelle_quelle"));
            for (String zuweisung : List.of("kanal = 'x'",
                    "rolle = 'vergleich'", "geraet_id = geraet_id", "entity_id = entity_id",
                    "anfangsstand = 0", "rueckwirkend = false", "actor_name = 'jemand'", "tenant_id = tenant_id")) {
                abgelehntWegen("42501", "permission denied",
                        () -> app.update("UPDATE messstelle_quelle SET " + zuweisung + " WHERE id = ?", q));
            }
            abgelehnt("23514", "messstelle_quelle_nie_ueberschrieben", () -> app.update(
                    "UPDATE messstelle_quelle SET gueltig_ab=gueltig_ab-interval '1 day' WHERE id=?", q));
            // Beenden: das Ende und der Endstand, genau einmal.
            assertThat(app.update("UPDATE messstelle_quelle SET gueltig_bis = ?, endstand = 1083415.2, "
                    + "endstand_einheit = 'kWh' WHERE id = ?", ts(WECHSEL), q)).isOne();
            abgelehnt("23514", "messstelle_quelle_nie_ueberschrieben", () -> app.update(
                    "UPDATE messstelle_quelle SET gueltig_bis = ? WHERE id = ?", ts(WECHSEL.plusSeconds(420)), q));
            abgelehnt("23514", "messstelle_quelle_nie_ueberschrieben", () -> app.update(
                    "UPDATE messstelle_quelle SET endstand = 1083500 WHERE id = ?", q));
        });
        // Auch die Admin-Rolle schreibt eine Quelle nie um — und öffnet keine beendete wieder.
        UUID offen = w.quelle(ms, "Wirkenergie", "Bezug", k, "fuehrend", null, WECHSEL, null);
        abgelehnt("23514", "messstelle_quelle_nie_ueberschrieben",
                () -> admin.update("UPDATE messstelle_quelle SET kanal = 'anders' WHERE id = ?", offen));
        abgelehnt("23514", "messstelle_quelle_nie_ueberschrieben",
                () -> admin.update("UPDATE messstelle_quelle SET gueltig_bis = NULL WHERE id = ?", q));
        assertThat(root.queryForObject("SELECT endstand::text FROM messstelle_quelle WHERE id = ?", String.class, q))
                .isEqualTo("1083415.2");
    }

    @Test
    void dasProtokollKenntDieZweiNeuenArten() {
        Werkstatt w = new Werkstatt("Quelle Protokoll");
        UUID ms = w.messstelle("MS-06");
        alsTue(w.tenant, () -> {
            // Die Arten der Vorgänger bleiben (IP-7 hat den CHECK vorher geweitet).
            for (String art : List.of("quelle_gebunden", "quelle_beendet", "angelegt", "archiviert",
                    "ort_zugeordnet", "ort_korrigiert", "stellung_zugeordnet", "stellung_korrigiert")) {
                assertThat(app.update("INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, art, gilt_ab, "
                        + "rueckwirkend, actor_sub, actor_name, actor_art) VALUES (?, ?, ?, ?, false, 'sub', "
                        + "'Ines Kaltenbach', 'kunde')", w.tenant, ms, art, ts(WECHSEL))).isOne();
            }
            abgelehnt("23514", "messstelle_aenderung_art_chk", () -> app.update("INSERT INTO messstelle_aenderung "
                    + "(tenant_id, messstelle_id, art, gilt_ab, rueckwirkend, actor_sub, actor_name, actor_art) "
                    + "VALUES (?, ?, 'quelle_verschoben', ?, false, 'sub', 'Ines Kaltenbach', 'kunde')", w.tenant,
                    ms, ts(WECHSEL)));
        });
    }

    // ---- Löschen und Offboarding -----------------------------------------------------------

    /**
     * Komponente und Anlage bleiben löschbar wie heute: die Bindungen an ihnen gehen mit, die
     * Messstelle bleibt (ihr Protokoll erzählt, was war).
     */
    @Test
    void komponenteUndAnlageBleibenLoeschbarDieMessstelleBleibt() {
        Werkstatt w = new Werkstatt("Quelle Löschen");
        UUID ms = w.messstelle("MS-06");
        UUID k = w.komponente();
        UUID k2 = w.komponente();
        w.quelle(ms, "Wirkenergie", "Bezug", k, "fuehrend", null, BEGINN, WECHSEL);
        w.quelle(ms, "Wirkenergie", "Bezug", k2, "fuehrend", null, WECHSEL, null);
        assertThat(als(w.tenant, () -> app.update("DELETE FROM measurement_point WHERE id = ?", k))).isOne();
        assertThat(w.quellen(ms)).isOne();
        assertThat(als(w.tenant, () -> app.update("DELETE FROM site WHERE id = ?", w.site))).isOne();
        assertThat(w.quellen(ms)).isZero();
        assertThat(anzahl("SELECT count(*) FROM messstelle WHERE id = ?", ms)).isOne();
    }

    @Test
    void ohneOffboardingVerweigertDieDatenbankUndDasOffboardingRaeumtAusdruecklichAb() {
        Werkstatt w = new Werkstatt("Quelle Offboarding");
        UUID ms = w.messstelle("MS-06");
        UUID k = w.komponente();
        w.quelle(ms, "Wirkenergie", "Bezug", k, "fuehrend", null, BEGINN, null);
        w.quelle(ms, "Wirkenergie", "Bezug", w.komponente(), "vergleich", "Plausibilität", BEGINN, null);

        abgelehnt("23503", null, () -> root.update("DELETE FROM tenant WHERE id = ?", w.tenant));
        // Nie Kaskade von Mandant und Messstelle; Komponente und Gerät nehmen ihre Bindungen mit.
        assertThat(root.queryForList("SELECT conname || ':' || confdeltype::text FROM pg_constraint WHERE conrelid = "
                + "'messstelle_quelle'::regclass AND contype = 'f' ORDER BY conname", String.class))
                .containsExactly("messstelle_quelle_entity_fk:c", "messstelle_quelle_geraet_fk:c",
                        "messstelle_quelle_messstelle_fk:r", "messstelle_quelle_tenant_fk:r");

        new TenantRepository(admin).offboard(w.tenant);
        assertThat(anzahl("SELECT count(*) FROM tenant WHERE id = ?", w.tenant)).isZero();
        assertThat(anzahl("SELECT count(*) FROM messstelle_quelle WHERE tenant_id = ?", w.tenant)).isZero();
    }

    // ---- Gerüst ----------------------------------------------------------------------------

    /** Ein Kundenbereich mit einer Anlage und einer Box; Messstellen, Komponenten und Quellen darin. */
    private static final class Werkstatt {
        final UUID tenant;
        final UUID site;
        final UUID box;
        private int komponenten;

        Werkstatt(String name) {
            tenant = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
            site = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) "
                    + "RETURNING id", UUID.class, tenant, name, ts(BEGINN));
            box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                    + "RETURNING id", UUID.class, tenant, site, "VP-BOX-" + tenant);
        }

        /** Eine Komponente — ihr Gerät legt der Anlege-Weg an (V20260911240000), ab ihrer Anlagezeit. */
        UUID komponente() {
            komponenten++;
            return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                    + "connection_json, created_at) VALUES (?, ?, 'modbus-generic', ?, 'modbus-generic', ?::jsonb, ?) "
                    + "RETURNING id", UUID.class, tenant, site, "Zähler " + komponenten,
                    "{\"unit_id\":" + komponenten + "}", ts(BEGINN));
        }

        UUID geraet(UUID komponente) {
            return root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ?", UUID.class,
                    komponente);
        }

        UUID messstelle(String kennzeichen) {
            return messstelle(kennzeichen, "Wirkenergie", "Bezug", "kWh", "Zählerstand");
        }

        UUID messstelle(String kennzeichen, String groesse, String richtung, String einheit, String wertart) {
            return als(tenant, () -> app.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, "
                    + "medium, groesse, richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', ?, ?, ?, ?) "
                    + "RETURNING id", UUID.class, tenant, kennzeichen, kennzeichen, groesse, richtung, einheit,
                    wertart));
        }

        void nebengroesse(UUID messstelle, String groesse, String richtung, String einheit, String wertart) {
            alsTue(tenant, () -> app.update("INSERT INTO messstelle_groesse (tenant_id, messstelle_id, medium, "
                    + "groesse, richtung, einheit, wertart) VALUES (?, ?, 'Strom', ?, ?, ?, ?)", tenant, messstelle,
                    groesse, richtung, einheit, wertart));
        }

        UUID quelle(UUID messstelle, String groesse, String richtung, UUID komponente, String rolle, String zweck,
                Instant ab, Instant bis) {
            return quelleKanal(messstelle, groesse, richtung, komponente, "sunspec.model_203.totwhimp", "counter",
                    "zaehlerstand", rolle, zweck, ab, bis);
        }

        UUID quelleKanal(UUID messstelle, String groesse, String richtung, UUID komponente, String kanal,
                String wertart, String herleitung, String rolle, String zweck, Instant ab, Instant bis) {
            UUID geraet = geraet(komponente);
            return als(tenant, () -> app.queryForObject("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, "
                    + "groesse, richtung, entity_id, geraet_id, kanal, kanal_wertart, herleitung, rolle, zweck, "
                    + "gueltig_ab, gueltig_bis, rueckwirkend, eingetragen_am, actor_sub, actor_name, actor_rolle, "
                    + "actor_art) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sub-ines', 'Ines Kaltenbach', "
                    + "'kundenadministrator', 'kunde') RETURNING id", UUID.class, tenant, messstelle, groesse,
                    richtung, komponente, geraet, kanal, wertart, herleitung, rolle, zweck, ts(ab), ts(bis),
                    ab.isBefore(EINGETRAGEN), ts(EINGETRAGEN)));
        }

        long quellen(UUID messstelle) {
            return anzahl("SELECT count(*) FROM messstelle_quelle WHERE messstelle_id = ?", messstelle);
        }
    }

    /** Eine führende Wirkenergie-Quelle aus einem Zählerstand — als die App-Rolle im gewählten Mandanten. */
    private static void einfuegen(UUID tenant, UUID messstelle, String groesse, String richtung, UUID komponente,
            UUID geraet, String kanal, String rolle, String zweck, Instant ab, Instant bis) {
        app.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, "
                + "geraet_id, kanal, kanal_wertart, herleitung, rolle, zweck, gueltig_ab, gueltig_bis, rueckwirkend, "
                + "eingetragen_am, actor_sub, actor_name, actor_art) VALUES (?, ?, ?, ?, ?, ?, ?, 'counter', "
                + "'zaehlerstand', ?, ?, ?, ?, false, ?, 'sub', 'Ines Kaltenbach', 'kunde')", tenant, messstelle,
                groesse, richtung, komponente, geraet, kanal, rolle, zweck, ts(ab), ts(bis), ts(EINGETRAGEN));
    }

    private static Timestamp ts(Instant t) {
        return t == null ? null : Timestamp.from(t);
    }

    private static long anzahl(String sql, Object... args) {
        return root.queryForObject(sql, Long.class, args);
    }

    private static <T> T als(UUID tenant, Supplier<T> arbeit) {
        UUID vorher = TenantContext.get();
        TenantContext.set(tenant);
        try {
            return arbeit.get();
        } finally {
            if (vorher == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(vorher);
            }
        }
    }

    private static void alsTue(UUID tenant, Runnable arbeit) {
        als(tenant, () -> {
            arbeit.run();
            return null;
        });
    }

    /** Die Ablehnung der Datenbank — oder {@code null}, wenn sie annimmt. */
    private static PSQLException ablehnung(Runnable arbeit) {
        try {
            arbeit.run();
            return null;
        } catch (RuntimeException e) {
            for (Throwable t = e; t != null; t = t.getCause()) {
                if (t instanceof PSQLException p) {
                    return p;
                }
            }
            throw e;
        }
    }

    private static void abgelehnt(String sqlState, String constraint, Runnable arbeit) {
        PSQLException p = ablehnung(arbeit);
        assertThat((Object) p).as("die Datenbank muss ablehnen (" + constraint + ")").isNotNull();
        assertThat(p.getSQLState()).as(p.getMessage()).isEqualTo(sqlState);
        if (constraint != null) {
            assertThat(p.getServerErrorMessage().getConstraint()).as(p.getMessage()).isEqualTo(constraint);
        }
    }

    private static void abgelehntWegen(String sqlState, String nachricht, Runnable arbeit) {
        PSQLException p = ablehnung(arbeit);
        assertThat((Object) p).as("die Datenbank muss ablehnen (" + nachricht + ")").isNotNull();
        assertThat(p.getSQLState()).as(p.getMessage()).isEqualTo(sqlState);
        assertThat(p.getMessage()).contains(nachricht);
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
