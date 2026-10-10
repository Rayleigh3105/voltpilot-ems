package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
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
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Migration {@code V20260913160000} (UEMS AP-10 IP-7): Kostenstelle, Prozess, Messstelle →
 * Prozess — und die drei Stellen, die auf diese Objekte gewartet haben.
 *
 * <ul>
 *   <li>Bestandsschutz über den gemeinsamen Vergleich ({@link Bestandsschutz}, PR #708);</li>
 *   <li>Prozess: höchstens eine Ebene, per Trigger; Kostenstelle: flach;</li>
 *   <li>eine Zuordnung gilt nie länger als ihr Ziel — von BEIDEN Seiten, am Prozess mit der echten
 *       Tabelle {@code messstelle_prozess}, an der Kostenstelle mit einer Anteils-Probe, die denselben
 *       Trigger anhängt wie die Verteilung (IP-8), gegen die Anteile des Referenzunternehmens;</li>
 *   <li>die wartenden Stellen: Bezugsgröße an Prozess/Kostenstelle, der Fremdschlüssel auf
 *       {@code verteilung_ziel}, die Protokoll-Art;</li>
 *   <li>Zaun, Rechte (beenden statt löschen), erneutes Ausführen und Offboarding aller drei.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsKostenstelleProzessMigrationTest {

    private static final String DIESE = "20260913160000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final Path REFERENZ = Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");
    private static final LocalDate OKT_1 = LocalDate.of(2026, 10, 1);

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static JsonNode referenz;
    private static Kunde a;
    private static Kunde b;
    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;

    private record Kunde(UUID tenant, UUID unternehmen, UUID messstelle, UUID berechnet) {
    }

    @BeforeAll
    static void bestandUndMigration() throws IOException {
        referenz = new ObjectMapper().readTree(REFERENZ.toFile());
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        a = kunde("Kunststoffwerk Ahrenberg GmbH");
        b = kunde("Kundenbereich B");
        // Der Bestand der Tabellen, die diese Migration anfasst: eine Bezugsgröße (CHECK, Schlüssel und
        // Trigger werden abgeschrieben), ein Formel-Term (neuer Fremdschlüssel), ein Protokolleintrag.
        root.update("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, "
                + "geltung_art, unternehmen_id) VALUES (?, 'BZ-5', 'Mitarbeitende', 'periodenwert', 'Personen', "
                + "'monat', 'unternehmen', ?)", a.tenant(), a.unternehmen());
        root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, position, eingang_art, "
                + "quell_messstelle_id, vorzeichen, faktor) VALUES (?, ?, 0, 'messstelle', ?, '+', 1)",
                a.tenant(), a.berechnet(), a.messstelle());
        root.update("INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, art, gilt_ab, rueckwirkend, "
                + "actor_name, actor_art) VALUES (?, ?, 'formel_geaendert', now(), false, 'VoltPilot', 'voltpilot')",
                a.tenant(), a.berechnet());
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());

        flyway().target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        flyway().load().migrate();
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ================================================================== Bestandsschutz

    @Test
    void dieMigrationLaesstDenBestandZeichengleich() {
        for (String tabelle : List.of("bezugsgroesse", "messstelle_formel_term", "messstelle_aenderung", "unternehmen")) {
            assertThat(fingerVorher.get(tabelle)).as("es gibt Bestand in " + tabelle).isNotEqualTo(Bestandsschutz.LEER);
        }
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
        for (String tabelle : List.of("kostenstelle", "prozess", "messstelle_prozess")) {
            assertThat(fingerVorher).as("neu: " + tabelle).doesNotContainKey(tabelle);
            assertThat(fingerNachMigration.get(tabelle)).as(tabelle + " kommt leer").isEqualTo(Bestandsschutz.LEER);
        }
    }

    @Test
    void derBestandsvergleichBeisst() {
        Bestandsschutz.mutationsprobe(root, List.of(), "bezugsgroesse", "UPDATE bezugsgroesse SET name = name || '!'");
    }

    // ============================================================ Prozess: eine Ebene

    @Test
    void einProzessHatHoechstensEineEbeneUndDieKostenstelleKeine() {
        Kunde k = kunde("Ebenen");
        UUID p1 = prozess(root, k, "P-1", null, OKT_1, null);
        UUID p11 = prozess(root, k, "P-1.1", p1, OKT_1, null);
        assertThat(root.queryForObject("SELECT eltern_id FROM prozess WHERE id = ?", UUID.class, p11)).isEqualTo(p1);

        // Die zweite Ebene ist ein Fehler — auch für eine Rolle ohne Zaun.
        abgelehnt("prozess_eine_ebene", () -> prozess(root, k, "P-1.1.1", p11, OKT_1, null));
        // Wer Kinder hat, wird kein Unterprozess — und wer ein Elternteil hat, bekommt keine Kinder.
        UUID p2 = prozess(root, k, "P-2", null, OKT_1, null);
        abgelehnt("prozess_eine_ebene", () -> root.update("UPDATE prozess SET eltern_id = ? WHERE id = ?", p2, p1));
        abgelehnt("prozess_eine_ebene", () -> root.update("UPDATE prozess SET eltern_id = ? WHERE id = ?", p11, p2));
        // Ein Elternteil auf gleicher Ebene umzuhängen bleibt eine Ebene.
        root.update("UPDATE prozess SET eltern_id = ? WHERE id = ?", p2, p11);
        abgelehnt("prozess_nicht_eigenes_eltern", () -> root.update("UPDATE prozess SET eltern_id = id WHERE id = ?", p1));
        // Das Elternteil liegt im selben Kundenbereich.
        UUID fremd = prozess(root, b, "P-9", null, OKT_1, null);
        abgelehnt("prozess_eltern_fk", () -> prozess(root, k, "P-3", fremd, OKT_1, null));
        // Die App-Rolle setzt das Elternteil nur beim Anlegen.
        assertThat(root.queryForObject("SELECT has_column_privilege(?, 'prozess', 'eltern_id', 'UPDATE')",
                Boolean.class, APP_USER)).isFalse();

        // Die Kostenstelle ist flach: keine Spalte und kein Schlüssel verweist auf eine Kostenstelle.
        assertThat(root.queryForObject("SELECT count(*) FROM pg_constraint WHERE conrelid = 'kostenstelle'::regclass "
                + "AND confrelid = 'kostenstelle'::regclass", Long.class)).isZero();
        assertThat(root.queryForList("SELECT column_name FROM information_schema.columns WHERE table_name = "
                + "'kostenstelle' ORDER BY ordinal_position", String.class))
                .containsExactly("id", "tenant_id", "unternehmen_id", "kennzeichen", "name", "gueltig_ab",
                        "gueltig_bis", "created_at", "updated_at", "created_by");
    }

    // ============================================== eine Zuordnung gilt nie länger als ihr Ziel

    @Test
    void eineProzessZuordnungGiltNieLaengerAlsIhrProzessVonBeidenSeiten() {
        Kunde k = kunde("Zuordnung");
        LocalDate ende = LocalDate.of(2026, 12, 31);
        UUID p = prozess(root, k, "P-4", null, OKT_1, ende);

        abgelehnt("messstelle_prozess_prozess_besteht", () -> zuordnung(root, k, p, OKT_1, null));
        abgelehnt("messstelle_prozess_prozess_besteht", () -> zuordnung(root, k, p, OKT_1.minusDays(1), ende));
        abgelehnt("messstelle_prozess_prozess_besteht", () -> zuordnung(root, k, p, OKT_1, ende.plusDays(1)));
        UUID z = zuordnung(root, k, p, OKT_1, ende);
        // Dieselbe Messstelle, derselbe Prozess, überlappende Tage: nie zweimal.
        abgelehnt("messstelle_prozess_keine_ueberlappung", () -> zuordnung(root, k, p, ende, ende));
        // Verlängern über das Ende des Prozesses: abgelehnt.
        abgelehnt("messstelle_prozess_prozess_besteht",
                () -> root.update("UPDATE messstelle_prozess SET gueltig_bis = NULL WHERE id = ?", z));

        // Die Seite des Ziels: ein Ende, das die Zuordnung abschneidet, nie still.
        LocalDate frueher = LocalDate.of(2026, 11, 30);
        abgelehnt("prozess_zuordnung_besteht",
                () -> root.update("UPDATE prozess SET gueltig_bis = ? WHERE id = ?", frueher, p));
        assertThat(ausserhalb("prozess", k, p, OKT_1, frueher)).containsExactly("messstelle_prozess:" + z);
        assertThat(root.queryForObject("SELECT gueltig_bis FROM messstelle_prozess WHERE id = ?", LocalDate.class, z))
                .as("nichts wurde gekürzt").isEqualTo(ende);
        // Ein Ende nach dem der Zuordnung, und erst die Zuordnung beenden, dann den Prozess: erlaubt.
        root.update("UPDATE prozess SET gueltig_bis = ? WHERE id = ?", LocalDate.of(2027, 3, 31), p);
        root.update("UPDATE messstelle_prozess SET gueltig_bis = ? WHERE id = ?", frueher, z);
        root.update("UPDATE prozess SET gueltig_bis = ? WHERE id = ?", frueher, p);
        // Ein aufgehobenes Intervall zählt nicht.
        UUID p5 = prozess(root, k, "P-5", null, OKT_1, null);
        UUID z5 = zuordnung(root, k, p5, OKT_1, null);
        root.update("UPDATE messstelle_prozess SET aufgehoben_am = now() WHERE id = ?", z5);
        root.update("UPDATE prozess SET gueltig_bis = ? WHERE id = ?", OKT_1, p5);
        // Der Beginn des Ziels wandert auch nicht über eine Zuordnung.
        UUID p6 = prozess(root, k, "P-6", null, OKT_1, null);
        zuordnung(root, k, p6, OKT_1, null);
        abgelehnt("prozess_zuordnung_besteht",
                () -> root.update("UPDATE prozess SET gueltig_ab = ? WHERE id = ?", OKT_1.plusDays(1), p6));

        // Ein Unterprozess ist eine Zuordnung an sein Elternteil: nie länger als es.
        UUID eltern = prozess(root, k, "P-7", null, OKT_1, ende);
        abgelehnt("prozess_eltern_besteht", () -> prozess(root, k, "P-7.1", eltern, OKT_1, null));
        UUID kind = prozess(root, k, "P-7.2", eltern, LocalDate.of(2026, 11, 1), ende);
        abgelehnt("prozess_zuordnung_besteht",
                () -> root.update("UPDATE prozess SET gueltig_bis = ? WHERE id = ?", frueher, eltern));
        assertThat(ausserhalb("prozess", k, eltern, OKT_1, frueher)).containsExactly("prozess:" + kind);
    }

    /**
     * „Ein Anteil gilt nie länger als seine Kostenstelle“ — die Regel, die das Referenzunternehmen seit
     * Fassung 1.2 als Eigenschaft trägt (MS-02/03/04/09 enden mit 9000 am 31.12.2026). Die Tabelle der
     * Anteile ist die Verteilung (IP-8); die Kostenstelle trägt ihre Hälfte schon, und die Verteilung
     * hängt nur {@code uems_zuordnung_im_ziel('kostenstelle', …)} an. Genau das tut diese Probe — in
     * einer Transaktion, die zurückgerollt wird: danach gibt es die Probe-Tabelle nicht mehr.
     */
    @Test
    void einAnteilGiltNieLaengerAlsSeineKostenstelle() {
        Kunde k = kunde("Anteile");
        TransactionTemplate tx = new TransactionTemplate(new DataSourceTransactionManager(root.getDataSource()));
        tx.executeWithoutResult(status -> {
            status.setRollbackOnly();
            root.execute("CREATE TABLE anteil_probe (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "
                    + "tenant_id UUID NOT NULL, messstelle TEXT NOT NULL, kostenstelle_id UUID NOT NULL, "
                    + "anteil_prozent NUMERIC NOT NULL, gueltig_ab DATE NOT NULL, gueltig_bis DATE, "
                    + "aufgehoben_am TIMESTAMPTZ, FOREIGN KEY (kostenstelle_id, tenant_id) "
                    + "REFERENCES kostenstelle (id, tenant_id))");
            root.execute("CREATE TRIGGER anteil_probe_im_ziel BEFORE INSERT OR UPDATE ON anteil_probe FOR EACH ROW "
                    + "EXECUTE FUNCTION uems_zuordnung_im_ziel('kostenstelle', 'kostenstelle_id', "
                    + "'anteil_probe_kostenstelle_besteht')");

            // Die Kostenstellen und JEDER Anteil des Referenzunternehmens stehen so in den Tabellen.
            Map<String, UUID> ks = new LinkedHashMap<>();
            for (JsonNode kst : referenz.path("kostenstellen")) {
                ks.put(kst.path("kennzeichen").asText(), kostenstelle(root, k, kst.path("kennzeichen").asText(),
                        LocalDate.parse(kst.path("gueltig_ab").asText()), tag(kst.path("gueltig_bis"))));
            }
            int anteile = 0;
            for (JsonNode m : referenz.path("messstellen")) {
                for (JsonNode an : m.path("kostenstellen_anteile")) {
                    anteil(k, m.path("kennzeichen").asText(), ks.get(an.path("kostenstelle").asText()),
                            an.path("anteil_prozent").asInt(), LocalDate.parse(an.path("gueltig_ab").asText()),
                            tag(an.path("gueltig_bis")));
                    anteile++;
                }
            }
            assertThat(anteile).as("die Anteile des Referenzunternehmens").isGreaterThan(15);

            UUID k9000 = ks.get("9000");
            LocalDate ende9000 = LocalDate.of(2026, 12, 31);
            // Vor 1.2 galten die Anteile auf 9000 offen — genau das lehnt die Datenbank jetzt ab.
            abgelehntImSavepoint(status, "anteil_probe_kostenstelle_besteht", () -> anteil(k, "MS-03", k9000, 100, OKT_1, null));
            abgelehntImSavepoint(status, "anteil_probe_kostenstelle_besteht",
                    () -> anteil(k, "MS-03", k9000, 100, ende9000.plusDays(1), ende9000.plusDays(31)));
            abgelehntImSavepoint(status, "anteil_probe_kostenstelle_besteht",
                    () -> anteil(k, "MS-03", k9000, 100, LocalDate.of(2026, 9, 30), ende9000));
            // Die Nachfolger 9010/9020 bestehen erst ab 2027 — kein Anteil davor.
            abgelehntImSavepoint(status, "anteil_probe_kostenstelle_besteht", () -> anteil(k, "MS-03", ks.get("9010"), 100,
                    ende9000, null));

            // Die Seite der Kostenstelle: 4100 früher beenden, während MS-06 dort offen gilt — abgelehnt,
            // nichts wird still gekürzt.
            UUID k4100 = ks.get("4100");
            abgelehntImSavepoint(status, "kostenstelle_zuordnung_besteht",
                    () -> root.update("UPDATE kostenstelle SET gueltig_bis = ? WHERE id = ?", ende9000, k4100));
            assertThat(ausserhalb("kostenstelle", k, k4100, OKT_1, ende9000))
                    .as("MS-06, MS-07 (70 %), MS-08, MS-11, MS-20").hasSize(5)
                    .allMatch(s -> s.startsWith("anteil_probe:"));
            // 9000 endet schon am 31.12.2026: ein unverändertes Ende und ein späteres gehen.
            root.update("UPDATE kostenstelle SET name = 'Infrastruktur' WHERE id = ?", k9000);
            root.update("UPDATE kostenstelle SET gueltig_bis = NULL WHERE id = ?", k9000);
            root.update("UPDATE kostenstelle SET gueltig_bis = ? WHERE id = ?", ende9000, k9000);
        });
        assertThat(root.queryForObject("SELECT to_regclass('anteil_probe') IS NULL", Boolean.class)).isTrue();
        assertThat(root.queryForObject("SELECT count(*) FROM uems_zuordnungen_ausserhalb('kostenstelle', ?, ?, ?, ?)",
                Long.class, k.tenant(), UUID.randomUUID(), OKT_1, OKT_1))
                .as("ohne Verteilung hat eine Kostenstelle heute keine Zuordnung mit Tagen").isZero();
    }

    // ================================================================= die wartenden Stellen

    @Test
    void dieBezugsgroessenDesReferenzunternehmensHaengenJetztAnIhremProzess() {
        Kunde k = kunde("Bezugsgrößen");
        Map<String, UUID> prozesse = new LinkedHashMap<>();
        for (JsonNode p : referenz.path("prozesse")) {
            prozesse.put(p.path("kennzeichen").asText(), prozess(root, k, p.path("kennzeichen").asText(), null, OKT_1, null));
        }
        List<String> angelegt = new ArrayList<>();
        for (JsonNode bz : referenz.path("bezugsgroessen")) {
            if (!bz.path("geltung_art").asText().equals("prozess")) {
                continue;
            }
            String kz = bz.path("kennzeichen").asText();
            alsTue(k.tenant(), () -> app.update("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, "
                    + "einheit, periode_art, geltung_art, prozess_id) VALUES (?, ?, ?, ?, ?, ?, 'prozess', ?)",
                    k.tenant(), kz, bz.path("name").asText(), bz.path("wertart").asText(),
                    bz.path("einheit_code").asText(), bz.path("periode_code").asText(),
                    prozesse.get(bz.path("geltung").asText())));
            angelegt.add(kz);
        }
        assertThat(angelegt).containsExactly("BZ-1", "BZ-2", "BZ-3");

        // Genau EIN Objekt, und es ist das der Art — auch für die zwei neuen.
        UUID kst = kostenstelle(root, k, "4100", OKT_1, null);
        root.update("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, "
                + "geltung_art, kostenstelle_id) VALUES (?, 'K.1', 'Stück je Kostenstelle', 'periodenwert', 'Stück', "
                + "'monat', 'kostenstelle', ?)", k.tenant(), kst);
        abgelehnt("bezugsgroesse_geltung_objekt_chk", () -> root.update("INSERT INTO bezugsgroesse (tenant_id, "
                + "kennzeichen, name, wertart, einheit, periode_art, geltung_art, prozess_id) VALUES (?, 'K.2', 'X', "
                + "'periodenwert', 'kg', 'monat', 'kostenstelle', ?)", k.tenant(), prozesse.get("P-1")));
        abgelehnt("bezugsgroesse_geltung_objekt_chk", () -> root.update("INSERT INTO bezugsgroesse (tenant_id, "
                + "kennzeichen, name, wertart, einheit, periode_art, geltung_art, prozess_id, kostenstelle_id) VALUES "
                + "(?, 'K.3', 'X', 'periodenwert', 'kg', 'monat', 'prozess', ?, ?)", k.tenant(), prozesse.get("P-1"), kst));
        abgelehnt("bezugsgroesse_prozess_fk", () -> root.update("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, "
                + "name, wertart, einheit, periode_art, geltung_art, prozess_id) VALUES (?, 'K.4', 'X', 'periodenwert', "
                + "'kg', 'monat', 'prozess', ?)", b.tenant(), prozesse.get("P-1")));
        // Der Geltungsbereich bleibt nach dem ersten Wert fest — auch der neue (der Trigger ist abgeschrieben).
        assertThat(root.queryForObject("SELECT pg_get_functiondef('bezugsgroesse_identitaet_bleibt'::regproc)",
                String.class)).contains("NEW.prozess_id", "OLD.kostenstelle_id");
        assertThat(root.queryForObject("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = "
                + "'bezugsgroesse_geltung_uq'", String.class)).contains("prozess_id", "kostenstelle_id");
        assertThat(root.queryForObject("SELECT has_column_privilege(?, 'bezugsgroesse', 'prozess_id', 'UPDATE') "
                + "AND has_column_privilege(?, 'bezugsgroesse', 'kostenstelle_id', 'UPDATE')", Boolean.class,
                APP_USER, APP_USER)).isTrue();
    }

    @Test
    void dasZielEinesVerteilungsTermsIstEineKostenstelleDesKundenbereichs() {
        Kunde k = kunde("Verteilungs-Term");
        UUID kst = kostenstelle(root, k, "4100", OKT_1, null);
        String term = "INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, position, eingang_art, "
                + "quell_messstelle_id, vorzeichen, faktor, verteilung_ziel) VALUES (?, ?, ?, 'verteilung', ?, '+', 1, ?)";
        abgelehnt("messstelle_formel_term_verteilung_ziel_fk",
                () -> root.update(term, k.tenant(), k.berechnet(), 0, k.messstelle(), UUID.randomUUID()));
        UUID fremd = kostenstelle(root, b, "4100", OKT_1, null);
        abgelehnt("messstelle_formel_term_verteilung_ziel_fk",
                () -> root.update(term, k.tenant(), k.berechnet(), 0, k.messstelle(), fremd));
        root.update(term, k.tenant(), k.berechnet(), 0, k.messstelle(), kst);
        // Eine Kostenstelle, auf die ein Term zeigt, verschwindet nicht (RESTRICT) — sie wird beendet.
        abgelehnt("messstelle_formel_term_verteilung_ziel_fk", () -> root.update("DELETE FROM kostenstelle WHERE id = ?", kst));
        root.update("UPDATE kostenstelle SET gueltig_bis = ? WHERE id = ?", LocalDate.of(2026, 12, 31), kst);
    }

    @Test
    void dasProtokollKenntDieProzessZuordnung() {
        alsTue(a.tenant(), () -> app.update("INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, art, gilt_ab, "
                + "rueckwirkend, actor_name, actor_art) VALUES (?, ?, 'prozesse_zugeordnet', now(), false, 'VoltPilot', "
                + "'voltpilot')", a.tenant(), a.messstelle()));
        abgelehnt("messstelle_aenderung_art_chk", () -> alsTue(a.tenant(), () -> app.update("INSERT INTO "
                + "messstelle_aenderung (tenant_id, messstelle_id, art, gilt_ab, rueckwirkend, actor_name, actor_art) "
                + "VALUES (?, ?, 'kostenstelle_zugeordnet', now(), false, 'VoltPilot', 'voltpilot')", a.tenant(),
                a.messstelle())));
    }

    // ============================================================ Zaun, Rechte, Wiederholung, Offboarding

    @Test
    void derZaunStehtUndBeendetWirdStattGeloescht() {
        Kunde k = kunde("Zaun");
        UUID kst = als(k.tenant(), () -> kostenstelle(app, k, "4200", OKT_1, null));
        UUID p = als(k.tenant(), () -> prozess(app, k, "P-2", null, OKT_1, null));
        UUID z = als(k.tenant(), () -> zuordnung(app, k, p, OKT_1, null));
        for (String tabelle : List.of("kostenstelle", "prozess", "messstelle_prozess")) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = ?",
                    Boolean.class, tabelle)).as(tabelle + ": ENABLE + FORCE").isTrue();
            assertThat(root.queryForObject("SELECT count(*) FROM pg_policies WHERE tablename = ? AND qual IS NOT NULL "
                    + "AND with_check IS NOT NULL", Long.class, tabelle)).as(tabelle + ": USING und WITH CHECK").isOne();
            assertThat(app.queryForObject("SELECT count(*) FROM " + tabelle, Long.class)).as(tabelle + " ohne Mandant")
                    .isZero();
            assertThat(als(b.tenant(), () -> app.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?",
                    Long.class, k.tenant()))).as(tabelle + ": B sieht A nicht").isZero();
            for (String recht : List.of("SELECT", "INSERT", "DELETE", "TRUNCATE")) {
                assertThat(root.queryForObject("SELECT has_table_privilege(?, ?, ?)", Boolean.class, APP_USER, tabelle,
                        recht)).as(tabelle + " " + recht).isEqualTo(!recht.equals("DELETE") && !recht.equals("TRUNCATE"));
            }
            assertThat(root.queryForObject("SELECT has_table_privilege(?, ?, 'DELETE') AND NOT has_table_privilege(?, ?, "
                    + "'INSERT')", Boolean.class, ADMIN_USER, tabelle, ADMIN_USER, tabelle)).as(tabelle + " Offboarding")
                    .isTrue();
        }
        assertThat(spaltenMitUpdate("kostenstelle")).containsExactly("gueltig_bis", "name", "updated_at");
        assertThat(spaltenMitUpdate("prozess")).containsExactly("gueltig_bis", "name", "updated_at");
        assertThat(spaltenMitUpdate("messstelle_prozess")).containsExactly("aufgehoben_am", "gueltig_bis");

        // Beenden statt löschen: die App-Rolle hat kein DELETE.
        assertThat(zurueckgewiesen(() -> alsTue(k.tenant(), () -> app.update("DELETE FROM kostenstelle WHERE id = ?", kst))))
                .isEqualTo("42501");
        assertThat(zurueckgewiesen(() -> alsTue(k.tenant(), () -> app.update("DELETE FROM prozess WHERE id = ?", p))))
                .isEqualTo("42501");
        // B schreibt nicht in den Kundenbereich von A, und nicht über A's Prozess.
        assertThat(zurueckgewiesen(() -> alsTue(b.tenant(), () -> kostenstelle(app, k, "4300", OKT_1, null))))
                .isEqualTo("42501");
        assertThat(zurueckgewiesen(() -> alsTue(b.tenant(), () -> app.update("INSERT INTO messstelle_prozess (tenant_id, "
                + "messstelle_id, prozess_id, gueltig_ab) VALUES (?, ?, ?, ?)", b.tenant(), b.messstelle(), p, OKT_1))))
                .isEqualTo("23503");
        // Unter dem Zaun: beenden geht, der Zuordnungs-Trigger sperrt das Ziel mit dem Recht der App-Rolle.
        alsTue(k.tenant(), () -> app.update("UPDATE messstelle_prozess SET gueltig_bis = ? WHERE id = ?",
                LocalDate.of(2026, 12, 31), z));
        alsTue(k.tenant(), () -> app.update("UPDATE prozess SET gueltig_bis = ? WHERE id = ?", LocalDate.of(2026, 12, 31), p));
        alsTue(k.tenant(), () -> app.update("UPDATE kostenstelle SET gueltig_bis = ? WHERE id = ?", OKT_1, kst));
        abgelehnt("kostenstelle_bis_nicht_vor_ab", () -> alsTue(k.tenant(), () -> app.update(
                "UPDATE kostenstelle SET gueltig_bis = ? WHERE id = ?", OKT_1.minusDays(1), kst)));
        abgelehnt("kostenstelle_kennzeichen_eindeutig", () -> kostenstelle(root, k, "4200", OKT_1, null));
        abgelehnt("kostenstelle_kennzeichen_format", () -> kostenstelle(root, k, "4 200", OKT_1, null));
    }

    /** {@code out-of-order: true}: dieselbe Datei ein zweites Mal auf dem neuesten Stand ändert nichts. */
    @Test
    void dieMigrationLaeuftAuchEinZweitesMal() throws Exception {
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());
        String sql = Files.readString(Path.of("src", "main", "resources", "db", "migration",
                "V" + DIESE + "__uems_kostenstelle_prozess.sql"))
                .replace("${appDbUser}", APP_USER).replace("${adminDbUser}", ADMIN_USER);
        root.execute(sql);
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of()))).isEmpty();
        // Nur die Trigger DIESER Migration zählen: spätere Pakete hängen denselben Trigger an ihre eigenen
        // Zuordnungen (AP-10 IP-8 an `messstelle_verteilung`, IP-6 an `anlage_netzanschluss`).
        assertThat(root.queryForObject("SELECT count(*) FROM pg_trigger WHERE tgfoid = "
                + "'uems_zuordnung_im_ziel()'::regprocedure AND NOT tgisinternal "
                + "AND tgrelid IN ('messstelle_prozess'::regclass, 'prozess'::regclass)", Long.class)).isEqualTo(2);
        assertThat(root.queryForObject("SELECT count(*) FROM pg_constraint WHERE conname IN "
                + "('bezugsgroesse_geltung_objekt_chk', 'bezugsgroesse_geltung_uq', 'bezugsgroesse_prozess_fk', "
                + "'bezugsgroesse_kostenstelle_fk', 'messstelle_formel_term_verteilung_ziel_fk')", Long.class)).isEqualTo(5);
    }

    @Test
    void dasOffboardingRaeumtAlleDreiAb() {
        Kunde k = kunde("Offboarding");
        UUID kst = kostenstelle(root, k, "9000", OKT_1, LocalDate.of(2026, 12, 31));
        UUID p = prozess(root, k, "P-1", null, OKT_1, null);
        UUID kind = prozess(root, k, "P-1.1", p, OKT_1, null);
        zuordnung(root, k, p, OKT_1, null);
        root.update("INSERT INTO messstelle_prozess (tenant_id, messstelle_id, prozess_id, gueltig_ab) VALUES (?, ?, ?, ?)",
                k.tenant(), k.berechnet(), kind, OKT_1);
        root.update("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, geltung_art, "
                + "prozess_id) VALUES (?, 'BZ-1', 'Produktionsmenge', 'periodenwert', 'kg', 'monat', 'prozess', ?)",
                k.tenant(), p);
        root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, position, eingang_art, "
                + "quell_messstelle_id, vorzeichen, faktor, verteilung_ziel) VALUES (?, ?, 0, 'verteilung', ?, '+', 1, ?)",
                k.tenant(), k.berechnet(), k.messstelle(), kst);
        new TenantRepository(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW))).offboard(k.tenant());
        for (String tabelle : List.of("messstelle_prozess", "prozess", "kostenstelle", "bezugsgroesse",
                "messstelle_formel_term", "messstelle", "unternehmen", "tenant")) {
            String spalte = tabelle.equals("tenant") ? "id" : "tenant_id";
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE " + spalte + " = ?",
                    Integer.class, k.tenant())).as(tabelle).isZero();
        }
        assertThat(root.queryForObject("SELECT count(*) FROM prozess WHERE tenant_id = ?", Integer.class, a.tenant()))
                .as("die anderen bleiben").isNotNull();
    }

    // ===================================================================== Gerüst

    private static Kunde kunde(String name) {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, name);
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-07', 'Druckluft', 'gemessen', 'Strom', "
                + "'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, t);
        UUID be = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-20', 'Spritzguss gesamt', 'berechnet', 'Strom', "
                + "'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, t);
        return new Kunde(t, u, ms, be);
    }

    private static UUID kostenstelle(JdbcTemplate db, Kunde k, String kennzeichen, LocalDate ab, LocalDate bis) {
        return db.queryForObject("INSERT INTO kostenstelle (tenant_id, unternehmen_id, kennzeichen, name, gueltig_ab, "
                + "gueltig_bis) VALUES (?, ?, ?, ?, ?, ?) RETURNING id", UUID.class, k.tenant(), k.unternehmen(),
                kennzeichen, "Kostenstelle " + kennzeichen, ab, bis);
    }

    private static UUID prozess(JdbcTemplate db, Kunde k, String kennzeichen, UUID eltern, LocalDate ab, LocalDate bis) {
        return db.queryForObject("INSERT INTO prozess (tenant_id, unternehmen_id, kennzeichen, name, eltern_id, "
                + "gueltig_ab, gueltig_bis) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id", UUID.class, k.tenant(),
                k.unternehmen(), kennzeichen, "Prozess " + kennzeichen, eltern, ab, bis);
    }

    private static UUID zuordnung(JdbcTemplate db, Kunde k, UUID prozess, LocalDate ab, LocalDate bis) {
        return db.queryForObject("INSERT INTO messstelle_prozess (tenant_id, messstelle_id, prozess_id, gueltig_ab, "
                + "gueltig_bis) VALUES (?, ?, ?, ?, ?) RETURNING id", UUID.class, k.tenant(), k.messstelle(), prozess,
                ab, bis);
    }

    private static void anteil(Kunde k, String messstelle, UUID kostenstelle, int prozent, LocalDate ab, LocalDate bis) {
        root.update("INSERT INTO anteil_probe (tenant_id, messstelle, kostenstelle_id, anteil_prozent, gueltig_ab, "
                + "gueltig_bis) VALUES (?, ?, ?, ?, ?, ?)", k.tenant(), messstelle, kostenstelle, prozent, ab, bis);
    }

    private static List<String> ausserhalb(String ziel, Kunde k, UUID id, LocalDate ab, LocalDate bis) {
        return root.queryForList("SELECT tabelle || ':' || zeile_id FROM uems_zuordnungen_ausserhalb(?, ?, ?, ?, ?)",
                String.class, ziel, k.tenant(), id, ab, bis);
    }

    private static List<String> spaltenMitUpdate(String tabelle) {
        return root.queryForList("SELECT column_name FROM information_schema.columns c WHERE table_name = ? "
                + "AND has_column_privilege(?, c.table_name, c.column_name, 'UPDATE') ORDER BY column_name",
                String.class, tabelle, APP_USER);
    }

    private static LocalDate tag(JsonNode wert) {
        return wert == null || wert.isNull() ? null : LocalDate.parse(wert.asText());
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

    private static PSQLException psql(Runnable arbeit) {
        Throwable t = null;
        try {
            arbeit.run();
        } catch (Throwable e) {
            t = e;
        }
        assertThat(t).as("die Datenbank muss ablehnen").isNotNull();
        PSQLException p = null;
        for (Throwable c = t; c != null; c = c.getCause()) {
            if (c instanceof PSQLException pe) {
                p = pe;
            }
        }
        assertThat((Object) p).as("eine PSQLException: " + t.getMessage()).isNotNull();
        return p;
    }

    private static String zurueckgewiesen(Runnable arbeit) {
        return psql(arbeit).getSQLState();
    }

    private static void abgelehnt(String constraint, Runnable arbeit) {
        PSQLException p = psql(arbeit);
        assertThat(p.getServerErrorMessage().getConstraint()).as(p.getMessage()).isEqualTo(constraint);
    }

    /** Eine erwartete Ablehnung INNERHALB einer Transaktion: sonst bräche sie die Transaktion ab. */
    private static void abgelehntImSavepoint(org.springframework.transaction.TransactionStatus status, String constraint,
            Runnable arbeit) {
        Object punkt = status.createSavepoint();
        try {
            abgelehnt(constraint, arbeit);
        } finally {
            status.rollbackToSavepoint(punkt);
        }
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
