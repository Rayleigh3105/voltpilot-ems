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
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.UUID;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.flywaydb.core.api.output.MigrateResult;
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
 * UEMS AP-12 IP-4: die Berichts-Tabellen ({@code V20260915050000}) gegen den Vertrag
 * {@code docs/contracts/v2/bericht-vectors.json} und {@code bericht-vorlagen.json} — Testcontainers, Docker nötig
 * (sonst übersprungen).
 *
 * <ul>
 *   <li><b>Löschschutz (E13 S1):</b> UPDATE und DELETE auf {@code bericht_stand} scheitern für die App-Rolle UND die
 *       Verwaltungsrolle — ohne Recht an den Rechten, MIT Recht am Trigger, ebenso für den Eigentümer; nur
 *       {@code ersetzt_durch_nr} wird genau einmal gesetzt. Quellen eines Stands, Anstöße, Abrufe und Protokoll
 *       ebenso; der eine Ausgang ist das Offboarding. Kein bestehender Weg wird enger.</li>
 *   <li><b>Vokabulare zeilengleich:</b> {@code bericht_vokabular()} ist Zeile für Zeile der Vertrag,
 *       {@code bericht_vorlage()} die Vorlagen-Datei, jeder Vokabular-CHECK fragt nur sie.</li>
 *   <li><b>Abzug (E1, A6/A7):</b> Text, Prüfsumme als CHECK, die Prüfsummen der Vektoren entstehen auch in der
 *       Datenbank; keine Hypertable, keine Aufbewahrung.</li>
 *   <li><b>Anstoß idempotent (B7)</b>, Belege (B12), Kennung je Kundenbereich und Jahr, Mandantenzaun, Rechte,
 *       Offboarding, Bestandsschutz — und die Migration auf frischer Datenbank wie als spät ankommende.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsBerichtMigrationTest {

    private static final String DIESE = "20260915050000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2", "bericht-vectors.json");
    private static final Path VORLAGEN = Path.of("..", "..", "docs", "contracts", "v2", "bericht-vorlagen.json");
    private static final Path MIGRATIONEN = Path.of("src", "main", "resources", "db", "migration");
    /**
     * Migrationen, die auf den Berichts-Tabellen AUFBAUEN — in der späten Ankunft kommen sie mit dieser, in
     * Versionsfolge. AP-17: IP-6 ({@code 071500}) prüft die Fassung per CHECK mit {@code bericht_pruefsumme}; IP-15
     * ({@code 200500}) ersetzt das Vokabular von IP-6 und muss darum nach ihr laufen; IP-21b ({@code 211800}) erweitert
     * {@code bericht} um die Kennzahl.
     */
    private static final List<String> BAUEN_DARAUF_AUF = List.of("20260915113000", "20260922251800", "20260923230000",
            "20260924071500", "20260924071945", "20260924200500", "20260924211800", "20260924214500",
            "20260924223000", // AP-18 IP-5: die Bewertungs-Kopie des Energieziels prüft bericht_pruefsumme.
            "20260924233000", // AP-18 IP-9: Ausgangslage und Stände der Maßnahme prüfen bericht_pruefsumme.
            "20260924235130", // AP-18 IP-14: der Anlass von Vermerk und Abweichung prüft bericht_pruefsumme.
            "20260925013500", // AP-19 IP-5: die Prüfsumme einer Dokument-Fassung prüft bericht_pruefsumme.
            "20260925030000", // AP-19 IP-12: tauscht bericht_abruf_actor_rolle_chk (plus einsicht).
            "20260925031500"); // AP-19 IP-16: Abschluss eines Audits und Stand der Wirksamkeit prüfen bericht_pruefsumme.
    private static final List<String> TABELLEN = List.of("bericht", "bericht_entwurf", "bericht_stand", "bericht_quelle",
            "bericht_revision_anstoss", "bericht_abruf", "bericht_aenderung", "bericht_kennung_seq");

    /** Die Vokabular-Blöcke des Vertrags, die diese Tabellen speichern — in der Reihenfolge der Funktion. */
    private static final List<String> LISTEN = List.of("vorlage", "geltung_art", "zeitraum_art", "quelle_art",
            "quelle_bezug", "anstoss_art", "anstoss_zustand", "handlung");

    /**
     * Die Blöcke, die keine Spalte sind: `bericht_stand` ist `stand_nr IS NULL` an der Quelle, die übrigen sind
     * Wörter von Regeln, Antworten, Ereignissen und Rechten.
     */
    private static final List<String> NICHT_GESPEICHERT = List.of("bericht_stand", "vergleich_art",
            "grund_ohne_vergleich", "kein_anstoss", "struktur_protokoll", "fehler", "ereignisse_reserviert", "rechte");

    /** Jede Spalte, die ein Vertragswort trägt: Tabelle, Spalte, CHECK, Vokabular. */
    private static final List<List<String>> VOKABULAR_CHECKS = List.of(
            List.of("bericht", "vorlage", "bericht_vorlage_chk", "vorlage"),
            List.of("bericht", "geltung_art", "bericht_geltung_art_chk", "geltung_art"),
            List.of("bericht", "zeitraum_art", "bericht_zeitraum_art_chk", "zeitraum_art"),
            List.of("bericht_quelle", "art", "bericht_quelle_art_chk", "quelle_art"),
            List.of("bericht_quelle", "bezug", "bericht_quelle_bezug_chk", "quelle_bezug"),
            List.of("bericht_revision_anstoss", "art", "bericht_revision_anstoss_art_chk", "anstoss_art"),
            List.of("bericht_revision_anstoss", "zustand", "bericht_revision_anstoss_zustand_chk", "anstoss_zustand"),
            List.of("bericht_abruf", "format", "bericht_abruf_format_chk", "handlung"),
            List.of("bericht_aenderung", "art", "bericht_aenderung_art_chk", "handlung"));

    /** B1/B5: Datenstand und Freigabe von Nr. 1. */
    private static final OffsetDateTime DATENSTAND = OffsetDateTime.parse("2026-11-10T08:55:00+01:00");
    private static final OffsetDateTime FREIGABE = OffsetDateTime.parse("2026-11-10T09:02:00+01:00");

    private static final String STAND = "INSERT INTO bericht_stand (tenant_id, bericht_id, nr, abzug, pruefsumme, "
            + "datenstand, freigegeben_am, freigeber_sub, freigeber_name, freigeber_rolle, darstellung, regelwerk, "
            + "vorlage_fassung, anlass_anstoss_id) VALUES (?, ?, ?, ?, bericht_pruefsumme(?), ?, ?, 'sub-ines', "
            + "'Ines Kaltenbach', 'energiemanager', '{\"zone\":\"Europe/Berlin\"}'::jsonb, '{\"build\":\"test\"}'::jsonb, "
            + "1, ?) RETURNING id";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static JdbcTemplate admin;
    private static JsonNode vertrag;
    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;

    private record Kunde(UUID tenant, UUID unternehmen, UUID standort) {
    }

    @BeforeAll
    static void bestandUndMigration() throws IOException {
        vertrag = new ObjectMapper().readTree(VEKTOREN.toFile());
        root = new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway(POSTGRES.getJdbcUrl()).target(letzteFassungVorDieser()).load().migrate();
        kunde("Kunststoffwerk Ahrenberg GmbH");
        kunde("Kundenbereich B");
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());

        flyway(POSTGRES.getJdbcUrl()).target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        flyway(POSTGRES.getJdbcUrl()).load().migrate();

        app = new JdbcTemplate(new TenantAwareDataSource(ds(POSTGRES.getJdbcUrl(), APP_USER, APP_PW)));
        admin = new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), ADMIN_USER, ADMIN_PW));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ============================================================ E13 S1: der Löschschutz

    @Test
    void einBerichtsstandWirdVonKeinerRolleGeaendertOderGeloescht() {
        Kunde k = kunde("Append-only");
        Map<String, UUID> r = vollstaendig(k);
        UUID s1 = r.get("stand1");
        String vorher = root.queryForObject("SELECT abzug || pruefsumme || freigeber_name FROM bericht_stand WHERE id = ?",
                String.class, s1);

        for (String sql : List.of(
                "UPDATE bericht_stand SET abzug = '{}', pruefsumme = bericht_pruefsumme('{}') WHERE id = ?",
                "UPDATE bericht_stand SET freigeber_name = 'Jemand anderes' WHERE id = ?",
                "DELETE FROM bericht_stand WHERE id = ?")) {
            // Die Anwendung und die Verwaltungsrolle haben das Recht nicht …
            verweigert(() -> alsTue(k.tenant(), () -> app.update(sql, s1)));
            verweigert(() -> admin.update(sql, s1));
            // … aber der Schutz ist der TRIGGER: beide Rollen MIT Recht und der Eigentümer scheitern auch.
            for (String rolle : List.of(APP_USER, ADMIN_USER)) {
                abgelehnt("bericht_stand_append_only", () -> mitRecht(rolle, "bericht_stand", k.tenant(),
                        () -> root.update(sql, s1)));
            }
            abgelehnt("bericht_stand_append_only", () -> root.update(sql, s1));
        }
        for (String rolle : List.of(APP_USER, ADMIN_USER)) {
            assertThat(rechte(rolle, "bericht_stand")).as("das GRANT der Probe ist zurückgerollt: " + rolle)
                    .doesNotContain("U").doesNotContain("D");
        }
        assertThat(zahl("bericht_stand", k.tenant())).isEqualTo(2L);
        assertThat(root.queryForObject("SELECT abzug || pruefsumme || freigeber_name FROM bericht_stand WHERE id = ?",
                String.class, s1)).as("Nr. 1 ist byte-gleich").isEqualTo(vorher);

        // Der eine Ausgang: nur die Verwaltungsrolle ruft ihn, und er schließt sich im selben Aufruf wieder.
        verweigert(() -> alsTue(k.tenant(), () -> app.queryForObject(
                "SELECT uems_berichte_des_kundenbereichs_entfernen(?)", Long.class, k.tenant())));
        zurueckgerollt(root, () -> {
            root.execute("SET LOCAL ROLE " + ADMIN_USER);
            assertThat(root.queryForObject("SELECT uems_berichte_des_kundenbereichs_entfernen(?)", Long.class,
                    k.tenant())).as("Abruf, Protokoll, Anstoß, drei Quellen, zwei Stände").isEqualTo(8L);
            assertThat(root.queryForObject("SELECT current_setting('uems.berichte_entfernen', true)", String.class))
                    .as("die Kennzeichnung ist nach dem Aufruf zurückgenommen").isEmpty();
        });
        assertThat(zahl("bericht_stand", k.tenant())).as("zurückgerollt").isEqualTo(2L);
    }

    @Test
    void ersetztDurchLaesstSichGenauEinmalSetzen() {
        Kunde k = kunde("Ersetzt");
        UUID b = bericht(k, "BR-2026-0001", "2026-10");
        UUID s1 = stand(root, k, b, 1, null);
        UUID a = anstoss(admin, k, s1, "korrektur_freigegeben", "K-2026-0007", 2, "freigegeben");

        // R2: die Freigabe der Revision schreibt die Anwendung — Nr. 2 mit Anlass, dann „ersetzt durch“ am Vorgänger.
        UUID s2 = als(k.tenant(), () -> stand(app, k, b, 2, a));
        assertThat(als(k.tenant(), () -> app.update("UPDATE bericht_stand SET ersetzt_durch_nr = 2 WHERE id = ?", s1)))
                .isEqualTo(1);

        // Ein zweites Mal — mit derselben, einer anderen oder keiner Nummer — von niemandem.
        stand(root, k, b, 3, null);
        for (Integer neu : new Integer[] {2, 3, null}) {
            abgelehnt("bericht_stand_ersetzt_einmal", () -> alsTue(k.tenant(),
                    () -> app.update("UPDATE bericht_stand SET ersetzt_durch_nr = ? WHERE id = ?", neu, s1)));
            abgelehnt("bericht_stand_ersetzt_einmal", () -> mitRecht(ADMIN_USER, "bericht_stand", k.tenant(),
                    () -> root.update("UPDATE bericht_stand SET ersetzt_durch_nr = ? WHERE id = ?", neu, s1)));
            abgelehnt("bericht_stand_ersetzt_einmal",
                    () -> root.update("UPDATE bericht_stand SET ersetzt_durch_nr = ? WHERE id = ?", neu, s1));
        }
        verweigert(() -> admin.update("UPDATE bericht_stand SET ersetzt_durch_nr = 3 WHERE id = ?", s2));
        assertThat(root.queryForObject("SELECT ersetzt_durch_nr FROM bericht_stand WHERE id = ?", Integer.class, s1))
                .isEqualTo(2);

        // Der Nachfolger ist ein SPÄTERER Stand DESSELBEN Berichts.
        abgelehnt("bericht_stand_ersetzt_durch_chk",
                () -> root.update("UPDATE bericht_stand SET ersetzt_durch_nr = 1 WHERE id = ?", s2));
        abgelehnt("bericht_stand_ersetzt_durch_fk",
                () -> root.update("UPDATE bericht_stand SET ersetzt_durch_nr = 9 WHERE id = ?", s2));
        assertThat(als(k.tenant(), () -> app.update("UPDATE bericht_stand SET ersetzt_durch_nr = 3 WHERE id = ?", s2)))
                .isEqualTo(1);

        // F2: Nr. = letzte + 1; der Anlass ist ein Anstoß an einen früheren Stand DESSELBEN Berichts.
        abgelehnt("bericht_stand_folgt", () -> stand(root, k, b, 5, null));
        // Zwei gleichzeitige Freigaben sähen beide „letzte + 1“ — die zweite scheitert am Schlüssel (Trigger in der
        // Probe aus, zurückgerollt).
        abgelehnt("bericht_stand_nr_eindeutig", () -> zurueckgerollt(root, () -> {
            root.execute("ALTER TABLE bericht_stand DISABLE TRIGGER bericht_stand_folgt");
            stand(root, k, b, 3, null);
        }));
        UUID anderer = bericht(k, "BR-2026-0002", "2026-11");
        stand(root, k, anderer, 1, null);
        stand(root, k, anderer, 2, null);
        abgelehnt("bericht_stand_folgt", () -> stand(root, k, anderer, 3, a));
        assertThat(root.queryForObject("SELECT count(*) FROM pg_trigger WHERE tgname = 'bericht_stand_folgt' "
                + "AND tgenabled = 'O'", Long.class)).as("der Trigger ist wieder an").isEqualTo(1L);
    }

    @Test
    void quellenEinesStandsAnstoesseAbrufeUndProtokollBleiben() {
        Kunde k = kunde("Belege bleiben");
        Map<String, UUID> r = vollstaendig(k);
        UUID b = r.get("bericht");

        // Die Quellen eines Stands bleiben — für jede Rolle.
        UUID standQuelle = root.queryForObject("SELECT id FROM bericht_quelle WHERE tenant_id = ? AND stand_nr = 1",
                UUID.class, k.tenant());
        abgelehnt("bericht_quelle_append_only", () -> alsTue(k.tenant(),
                () -> app.update("DELETE FROM bericht_quelle WHERE id = ?", standQuelle)));
        abgelehnt("bericht_quelle_append_only", () -> admin.update("DELETE FROM bericht_quelle WHERE id = ?", standQuelle));
        abgelehnt("bericht_quelle_append_only", () -> root.update("DELETE FROM bericht_quelle WHERE id = ?", standQuelle));
        abgelehnt("bericht_quelle_append_only",
                () -> root.update("UPDATE bericht_quelle SET version = 2 WHERE id = ?", standQuelle));
        verweigert(() -> alsTue(k.tenant(), () -> app.update("UPDATE bericht_quelle SET version = 2 WHERE id = ?",
                standQuelle)));

        // Der Entwurf wird ersetzt: seine Quellen gehen, sein Abzug wird überschrieben — von der Anwendung (Abruf, D4)
        // und von Kaskade oder Läufer (Verwaltungsrolle); die Prüfsumme muss zum Text passen.
        assertThat(als(k.tenant(), () -> app.update("DELETE FROM bericht_quelle WHERE bericht_id = ? AND stand_nr IS NULL",
                b))).isEqualTo(1);
        assertThat(als(k.tenant(), () -> app.update("UPDATE bericht_entwurf SET abzug = ?, pruefsumme = "
                + "bericht_pruefsumme(?), datenstand = ?, gebildet_von = 'abruf' WHERE bericht_id = ?", abzug(3), abzug(3),
                DATENSTAND.plusDays(5), b))).isEqualTo(1);
        assertThat(admin.update("UPDATE bericht_entwurf SET abzug = ?, pruefsumme = bericht_pruefsumme(?), datenstand = ?, "
                + "gebildet_von = 'kaskade' WHERE bericht_id = ?", abzug(4), abzug(4), DATENSTAND.plusDays(6), b)).isEqualTo(1);
        abgelehnt("bericht_entwurf_pruefsumme_chk",
                () -> admin.update("UPDATE bericht_entwurf SET abzug = '{}' WHERE bericht_id = ?", b));
        verweigert(() -> alsTue(k.tenant(), () -> app.update("DELETE FROM bericht_entwurf WHERE bericht_id = ?", b)));
        verweigert(() -> alsTue(k.tenant(), () -> app.update("DELETE FROM bericht WHERE id = ?", b)));

        // Ein abgeschlossener Anstoß bleibt, wie er ist; gelöscht wird keiner.
        UUID a = r.get("anstoss");
        abgelehnt("bericht_revision_anstoss_append_only", () -> alsTue(k.tenant(), () -> app.update(
                "UPDATE bericht_revision_anstoss SET zustand = 'verworfen', erledigt_durch_nr = NULL, "
                        + "verworfen_begruendung = 'später', verworfen_von_name = 'Ines Kaltenbach', verworfen_am = now() "
                        + "WHERE id = ?", a)));
        abgelehnt("bericht_revision_anstoss_append_only",
                () -> root.update("DELETE FROM bericht_revision_anstoss WHERE id = ?", a));
        verweigert(() -> admin.update("DELETE FROM bericht_revision_anstoss WHERE id = ?", a));
        verweigert(() -> alsTue(k.tenant(), () -> app.update("DELETE FROM bericht_revision_anstoss WHERE id = ?", a)));

        // Abrufe und Protokoll.
        for (String tabelle : List.of("bericht_abruf", "bericht_aenderung")) {
            String setze = tabelle.equals("bericht_abruf") ? "teilansicht = true" : "grund = 'nachträglich'";
            for (String sql : List.of("UPDATE " + tabelle + " SET " + setze + " WHERE tenant_id = ?",
                    "DELETE FROM " + tabelle + " WHERE tenant_id = ?")) {
                verweigert(() -> alsTue(k.tenant(), () -> app.update(sql, k.tenant())));
                verweigert(() -> admin.update(sql, k.tenant()));
                abgelehnt(tabelle + "_append_only", () -> root.update(sql, k.tenant()));
            }
        }
    }

    /**
     * Kein bestehender Weg wird enger: die neuen Fremdschlüssel zeigen nur auf den Mandanten, Standort und Unternehmen
     * (die nur das Offboarding löscht — und das räumt die Berichte vorher ab) und aufeinander; nichts Bestehendes zeigt
     * auf eine Berichts-Tabelle, kein Berichts-Trigger hängt an einer bestehenden Tabelle, und keine bestehende
     * Funktion fragt die Berichts-Belege.
     */
    @Test
    void keinBestehenderWegWirdEnger() {
        String tabellen = pgArray(TABELLEN);
        // AP-17 IP-21b (V4 je Kennzahl): bericht.kennzahl_id → kennzahl RESTRICT — bewusst; eine zitierte Kennzahl wird
        // nie hart gelöscht (Archivieren antwortet 409 berichts_belege), und das Offboarding löscht die Berichte vor
        // den Kennzahlen (TenantRepository.offboard).
        List<String> ziele = Stream.concat(TABELLEN.stream(), Stream.of("tenant", "standort", "unternehmen", "kennzahl"))
                .toList();
        assertThat(root.queryForList("SELECT DISTINCT confrelid::regclass::text FROM pg_constraint WHERE contype = 'f' "
                + "AND conrelid::regclass::text = ANY (?::text[])", String.class, tabellen))
                .isNotEmpty().allSatisfy(ziel -> assertThat(ziel).isIn(ziele));
        assertThat(root.queryForList("SELECT conrelid::regclass::text || '.' || conname FROM pg_constraint "
                + "WHERE contype = 'f' AND confrelid::regclass::text = ANY (?::text[]) "
                + "AND NOT conrelid::regclass::text = ANY (?::text[])", String.class, tabellen, tabellen)).isEmpty();
        assertThat(root.queryForList("SELECT t.tgrelid::regclass::text || '.' || t.tgname FROM pg_trigger t "
                + "JOIN pg_proc p ON p.oid = t.tgfoid WHERE NOT t.tgisinternal "
                + "AND (p.proname LIKE 'bericht%' OR p.proname LIKE 'uems_bericht%') "
                + "AND NOT t.tgrelid::regclass::text = ANY (?::text[])", String.class, tabellen)).isEmpty();
        assertThat(root.queryForList("SELECT t.tgrelid::regclass::text || '.' || t.tgname FROM pg_trigger t "
                + "WHERE NOT t.tgisinternal AND t.tgrelid::regclass::text = ANY (?::text[]) "
                + "AND t.tgname NOT LIKE 'bericht%'", String.class, tabellen)).isEmpty();
        assertThat(root.queryForList("SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
                + "WHERE n.nspname = 'public' AND p.proname NOT LIKE 'bericht%' AND p.proname NOT LIKE 'uems_bericht%' "
                + "AND (p.prosrc LIKE '%bericht_stand%' OR p.prosrc LIKE '%bericht_quelle%' "
                + "OR p.prosrc LIKE '%uems_berichts_belege%')", String.class)).isEmpty();
    }

    // ============================================================ Vokabulare zeilengleich

    @Test
    void dieVokabulareDerDatenbankSindZeileFuerZeileDieDesVertrags() {
        List<String> ausDemVertrag = new ArrayList<>();
        for (String liste : LISTEN) {
            int nr = 0;
            for (JsonNode wort : vertrag.path("vokabulare").path(liste)) {
                ausDemVertrag.add(zeile(liste, ++nr, wort.asText()));
            }
        }
        List<String> ausDerDatenbank = root.queryForList("SELECT format('(%L, %s, %L)', v.vokabular, v.nr, v.wort) "
                + "FROM bericht_vokabular() WITH ORDINALITY AS v(vokabular, nr, wort, stelle) ORDER BY v.stelle",
                String.class);

        assertThat(ausDemVertrag).as("der Vertrag hat Vokabulare — sonst bewiese Gleichheit nichts").hasSizeGreaterThan(30);
        assertThat(ausDerDatenbank)
                .as("bericht_vokabular() weicht von %s ab. Eine NEUE Migration ersetzt die Funktion mit diesem "
                        + "VALUES-Block (CREATE OR REPLACE FUNCTION, kein CHECK wird angefasst):%n%s",
                        VEKTOREN, String.join(",\n", ausDemVertrag))
                .containsExactlyElementsOf(ausDemVertrag);

        Set<String> bloecke = new LinkedHashSet<>();
        vertrag.path("vokabulare").fieldNames().forEachRemaining(bloecke::add);
        Set<String> entschieden = new LinkedHashSet<>(LISTEN);
        entschieden.addAll(NICHT_GESPEICHERT);
        assertThat(bloecke).as("jeder Vokabular-Block des Vertrags ist entschieden: gespeichert (LISTEN) oder "
                + "ausdrücklich keine Spalte (NICHT_GESPEICHERT)").containsExactlyInAnyOrderElementsOf(entschieden);
    }

    @Test
    void dieVorlagenDerDatenbankSindZeileFuerZeileDieDerVorlagenDatei() throws IOException {
        List<String> ausDerDatei = new ArrayList<>();
        List<String> schluessel = new ArrayList<>();
        for (JsonNode v : new ObjectMapper().readTree(VORLAGEN.toFile()).path("vorlagen")) {
            schluessel.add(v.path("schluessel").asText());
            // 1.4 (AP-17 IP-21a): `geltung_arten` × `zeitraum_arten`, sonst das eine Paar der Vorlage.
            JsonNode geltungen = v.has("geltung_arten") ? v.path("geltung_arten")
                    : new ObjectMapper().createArrayNode().add(v.path("geltung_art").asText());
            JsonNode zeitraeume = v.has("zeitraum_arten") ? v.path("zeitraum_arten")
                    : new ObjectMapper().createArrayNode().add(v.path("zeitraum_art").asText());
            for (JsonNode g : geltungen) {
                for (JsonNode z : zeitraeume) {
                    ausDerDatei.add("('" + v.path("schluessel").asText() + "', '" + g.asText() + "', '" + z.asText() + "')");
                }
            }
        }
        assertThat(ausDerDatei).hasSize(11);
        assertThat(root.queryForList("SELECT format('(%L, %L, %L)', v.vorlage, v.geltung_art, v.zeitraum_art) "
                + "FROM bericht_vorlage() WITH ORDINALITY AS v(vorlage, geltung_art, zeitraum_art, stelle) ORDER BY v.stelle",
                String.class)).as("bericht_vorlage() weicht von %s ab", VORLAGEN).containsExactlyElementsOf(ausDerDatei);
        assertThat(schluessel).as("die Vorlagen sind genau die Wörter von vokabulare.vorlage").isEqualTo(liste("vorlage"));
    }

    @Test
    void jederVokabularCheckFragtDieEineStelleUndTraegtKeineEigeneListe() {
        for (List<String> c : VOKABULAR_CHECKS) {
            assertThat(definition(c.get(0), c.get(2))).as(c.get(2))
                    .contains("bericht_wort('" + c.get(3) + "'::text, " + c.get(1) + ")")
                    .doesNotContain(" IN (").doesNotContain("ANY");
        }
        // Keine Spalte mit einem Vertragswort ohne ihren CHECK.
        assertThat(root.queryForList("SELECT table_name || '.' || column_name FROM information_schema.columns "
                + "WHERE table_schema = 'public' AND table_name = ANY (?::text[]) AND column_name IN ('vorlage', "
                + "'geltung_art', 'zeitraum_art', 'art', 'bezug', 'zustand', 'format')", String.class, pgArray(TABELLEN)))
                .containsExactlyInAnyOrderElementsOf(VOKABULAR_CHECKS.stream().map(c -> c.get(0) + "." + c.get(1)).toList());
        assertThat(definition("bericht", "bericht_zeitraum_zur_vorlage_chk")).contains("bericht_vorlage_passt(");
    }

    @Test
    void jedesWortDesVertragsIstSpeicherbarUndEinFremdesNie() {
        for (String liste : LISTEN) {
            for (String wort : liste(liste)) {
                assertThat(root.queryForObject("SELECT bericht_wort(?, ?)", Boolean.class, liste, wort))
                        .as(liste + " / " + wort).isTrue();
            }
            assertThat(root.queryForObject("SELECT bericht_wort(?, 'fremd')", Boolean.class, liste)).isFalse();
            assertThat(root.queryForObject("SELECT bericht_wort(?, NULL)", Boolean.class, liste)).isFalse();
        }
        Kunde k = kunde("Wörter");
        Map<String, UUID> r = vollstaendig(k);

        abgelehnt("bericht_vorlage_chk", () -> dazu(root, "bericht",
                berichtZeile(k, "BR-2026-0090", "wochenbericht_standort", "monat", "2026-12")));
        abgelehnt("bericht_quelle_art_chk", () -> root.update("INSERT INTO bericht_quelle (tenant_id, bericht_id, art, "
                + "kennzeichen, objekt_id, bezug, erster_tag, letzter_tag, name_zum_datenstand) VALUES (?, ?, 'erloes', "
                + "'E-1', ?, 'unmittelbar', DATE '2026-10-01', DATE '2026-10-31', 'Erlöse')", k.tenant(), r.get("bericht"),
                UUID.randomUUID()));
        // B6: eine Umbenennung ist kein Anstoß — das Wort von `kein_anstoss` nimmt keine Spalte.
        abgelehnt("bericht_revision_anstoss_art_chk",
                () -> anstoss(root, k, r.get("stand2"), "umbenennung", "MS-12", null, null));
        abgelehnt("bericht_abruf_format_chk", () -> abruf(k, r.get("stand2"), "xlsx"));
        // DA5: ein Abruf ist eine AUSGABE — `anlegen` ist ein Wort von `handlung`, aber keine.
        abgelehnt("bericht_abruf_format_zur_ausgabe_chk", () -> abruf(k, r.get("stand2"), "anlegen"));
        // Das Protokoll spricht den Vertrag, nicht Konzept §4.2.
        abgelehnt("bericht_aenderung_art_chk", () -> protokoll(k, r.get("bericht"), "angelegt"));
        protokoll(k, r.get("bericht"), "anlegen");

        // Die Literale mit Quelle (Kopf der Migration).
        assertThat(woerter(definition("bericht_abruf", "bericht_abruf_format_zur_ausgabe_chk")))
                .containsExactlyInAnyOrder("pdf", "csv").allSatisfy(w -> assertThat(liste("handlung")).contains(w));
        assertThat(woerter(definition("bericht_entwurf", "bericht_entwurf_gebildet_von_chk")))
                .as("bericht.md EW1: Anlegen, Abruf (D4), Pfad 1, Pfad 2")
                .containsExactlyInAnyOrder("anlegen", "abruf", "kaskade", "struktur");
    }

    @Test
    void einBerichtPasstZuSeinerVorlageUndBleibtWasErIst() {
        Kunde k = kunde("Vorlage");
        dazu(root, "bericht", berichtZeile(k, "BR-2026-0001", "monatsbericht_standort", "monat", "2026-10"));
        dazu(root, "bericht", berichtZeile(k, "BR-2027-0001", "jahresbericht_unternehmen", "jahr", "2026"));

        // V2: Monatsbericht Standort ist ein Monat am Standort.
        abgelehnt("bericht_zeitraum_zur_vorlage_chk", () -> dazu(root, "bericht",
                berichtZeile(k, "BR-2026-0002", "monatsbericht_standort", "jahr", "2026")));
        abgelehnt("bericht_zeitraum_zur_vorlage_chk", () -> dazu(root, "bericht", mit(
                berichtZeile(k, "BR-2026-0003", "monatsbericht_unternehmen", "monat", "2026-10"),
                "geltung_art", "standort", "unternehmen_id", null, "standort_id", k.standort())));
        abgelehnt("bericht_geltung_chk", () -> dazu(root, "bericht", mit(
                berichtZeile(k, "BR-2026-0004", "monatsbericht_standort", "monat", "2026-11"),
                "unternehmen_id", k.unternehmen())));
        abgelehnt("bericht_zeitraum_schluessel_chk", () -> dazu(root, "bericht",
                berichtZeile(k, "BR-2026-0005", "monatsbericht_standort", "monat", "2026-13")));
        abgelehnt("bericht_kennung_chk", () -> dazu(root, "bericht",
                berichtZeile(k, "BR-26-1", "monatsbericht_standort", "monat", "2026-12")));
        // V4: dieselbe Vorlage × Geltung × Zeitraum gibt es nur einmal.
        abgelehnt("bericht_gibt_es_schon", () -> dazu(root, "bericht",
                berichtZeile(k, "BR-2026-0006", "monatsbericht_standort", "monat", "2026-10")));
        abgelehnt("bericht_kennung_eindeutig", () -> dazu(root, "bericht",
                berichtZeile(k, "BR-2026-0001", "monatsbericht_standort", "monat", "2026-09")));

        // Archivieren ist die eine Änderung; Kennung, Vorlage, Geltung und Zeitraum bleiben — für jede Rolle.
        assertThat(als(k.tenant(), () -> app.update("UPDATE bericht SET archiviert_am = now() WHERE kennung = 'BR-2026-0001' "
                + "AND tenant_id = ?", k.tenant()))).isEqualTo(1);
        verweigert(() -> alsTue(k.tenant(), () -> app.update("UPDATE bericht SET zeitraum_schluessel = '2026-09' "
                + "WHERE tenant_id = ?", k.tenant())));
        abgelehnt("bericht_identitaet_bleibt", () -> root.update("UPDATE bericht SET zeitraum_schluessel = '2026-09' "
                + "WHERE tenant_id = ? AND kennung = 'BR-2026-0001'", k.tenant()));
        abgelehnt("bericht_identitaet_bleibt", () -> root.update("UPDATE bericht SET vorlage_fassung = 2 "
                + "WHERE tenant_id = ? AND kennung = 'BR-2026-0001'", k.tenant()));
    }

    // ============================================================ E1, A6/A7: der Abzug

    @Test
    void derAbzugIstTextUndDiePruefsummeIstDieDesVertrags() {
        for (String tabelle : List.of("bericht_entwurf", "bericht_stand")) {
            assertThat(root.queryForObject("SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' "
                    + "AND table_name = ? AND column_name = 'abzug'", String.class, tabelle)).as("A7: " + tabelle)
                    .isEqualTo("text");
        }
        Kunde k = kunde("Abzug");
        UUID b = bericht(k, "BR-2026-0001", "2026-10");
        Map<String, JsonNode> pruefungen = new TreeMap<>();
        for (JsonNode fall : vertrag.path("cases")) {
            for (JsonNode p : fall.path("pruefungen")) {
                String abzug = p.at("/eingang/abzug").asText();
                if (p.path("regel").asText().equals("kanonisch") && abzug.startsWith("BR-2026-0001/")) {
                    pruefungen.putIfAbsent(abzug, p);
                }
            }
        }
        assertThat(pruefungen).containsOnlyKeys("BR-2026-0001/1", "BR-2026-0001/2");

        int nr = 0;
        for (Map.Entry<String, JsonNode> e : pruefungen.entrySet()) {
            String text = BerichtRegeln.kanonisch(vertrag.path("abzuege").path(e.getKey()));
            String erwartet = e.getValue().at("/ergebnis/pruefsumme").asText();
            assertThat(BerichtRegeln.pruefsumme(text)).as(e.getKey()).isEqualTo(erwartet);
            assertThat(root.queryForObject("SELECT bericht_pruefsumme(?)", String.class, text))
                    .as("A6 in der Datenbank: " + e.getKey()).isEqualTo(erwartet);
            int dieseNr = ++nr;
            UUID s = root.queryForObject("INSERT INTO bericht_stand (tenant_id, bericht_id, nr, abzug, pruefsumme, "
                    + "datenstand, freigegeben_am, freigeber_sub, freigeber_name, darstellung, regelwerk, vorlage_fassung) "
                    + "VALUES (?, ?, ?, ?, ?, ?, ?, 'sub-ines', 'Ines Kaltenbach', '{}'::jsonb, '{}'::jsonb, 1) RETURNING id",
                    UUID.class, k.tenant(), b, dieseNr, text, erwartet, DATENSTAND.plusDays(dieseNr),
                    FREIGABE.plusDays(dieseNr));
            assertThat(root.queryForObject("SELECT abzug FROM bericht_stand WHERE id = ?", String.class, s))
                    .as("byte-gleich zurück").isEqualTo(text);
            assertThat(root.queryForObject("SELECT octet_length(abzug) FROM bericht_stand WHERE id = ?", Integer.class, s))
                    .isEqualTo(e.getValue().at("/ergebnis/bytes").asInt());
        }
        String nrEins = BerichtRegeln.kanonisch(vertrag.path("abzuege").path("BR-2026-0001/1"));
        abgelehnt("bericht_stand_pruefsumme_chk", () -> root.update("INSERT INTO bericht_stand (tenant_id, bericht_id, nr, "
                + "abzug, pruefsumme, datenstand, freigegeben_am, freigeber_sub, freigeber_name, darstellung, regelwerk, "
                + "vorlage_fassung) VALUES (?, ?, 3, ?, ?, ?, ?, 'sub-ines', 'Ines Kaltenbach', '{}'::jsonb, '{}'::jsonb, 1)",
                k.tenant(), b, nrEins + " ", BerichtRegeln.pruefsumme(nrEins), DATENSTAND, FREIGABE));
        abgelehnt("bericht_entwurf_pruefsumme_chk", () -> root.update("INSERT INTO bericht_entwurf (tenant_id, bericht_id, "
                + "abzug, pruefsumme, datenstand, gebildet_von) VALUES (?, ?, ?, 'sha256:' || repeat('0', 64), ?, 'anlegen')",
                k.tenant(), b, nrEins, DATENSTAND));
        abgelehnt("bericht_stand_datenstand_chk", () -> root.update("INSERT INTO bericht_stand (tenant_id, bericht_id, nr, "
                + "abzug, pruefsumme, datenstand, freigegeben_am, freigeber_sub, freigeber_name, darstellung, regelwerk, "
                + "vorlage_fassung) VALUES (?, ?, 3, '{}', bericht_pruefsumme('{}'), ?, ?, 'sub-ines', 'Ines Kaltenbach', "
                + "'{}'::jsonb, '{}'::jsonb, 1)", k.tenant(), b, FREIGABE, DATENSTAND));
    }

    @Test
    void keineHypertableKeineAufbewahrungKeineKompression() {
        String tabellen = pgArray(TABELLEN);
        assertThat(root.queryForObject("SELECT count(*) FROM timescaledb_information.hypertables "
                + "WHERE hypertable_name = ANY (?::text[])", Long.class, tabellen)).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM timescaledb_information.jobs "
                + "WHERE hypertable_name = ANY (?::text[])", Long.class, tabellen)).isZero();
        // Gegenprobe: die Abfragen sehen Hypertable und Aufbewahrung, wo es sie gibt.
        assertThat(root.queryForObject("SELECT count(*) FROM timescaledb_information.hypertables "
                + "WHERE hypertable_name = 'messreihe_viertelstunde'", Long.class)).isEqualTo(1L);
        assertThat(root.queryForObject("SELECT count(*) FROM timescaledb_information.jobs "
                + "WHERE hypertable_name = 'messreihe_viertelstunde' AND proc_name = 'policy_retention'", Long.class))
                .isEqualTo(1L);
    }

    // ============================================================ B7, B12, Kennung

    @Test
    void derRevisionsAnstossIstIdempotent() {
        Kunde k = kunde("Anstoß");
        UUID b = bericht(k, "BR-2026-0001", "2026-10");
        UUID s1 = stand(root, k, b, 1, null);
        String einmal = "INSERT INTO bericht_revision_anstoss (tenant_id, stand_id, art, anlass_kennung, anlass_fassung, "
                + "anlass_status) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT ON CONSTRAINT bericht_revision_anstoss_einmal "
                + "DO NOTHING";

        // B7: dieselbe Freigabe von K-2026-0007 zweimal gemeldet — eine Zeile.
        assertThat(admin.update(einmal, k.tenant(), s1, "korrektur_freigegeben", "K-2026-0007", 2, "freigegeben"))
                .isEqualTo(1);
        assertThat(admin.update(einmal, k.tenant(), s1, "korrektur_freigegeben", "K-2026-0007", 2, "freigegeben"))
                .isZero();
        // Die Rücknahme ist ein eigener Anstoß …
        assertThat(admin.update(einmal, k.tenant(), s1, "korrektur_zurueckgenommen", "K-2026-0007", 3, "zurueckgenommen"))
                .isEqualTo(1);
        // … und eine Strukturänderung ohne Fassung und Status ist ebenso nur EINE Zeile (NULLS NOT DISTINCT).
        assertThat(admin.update(einmal, k.tenant(), s1, "verteilung_rueckwirkend", "MS-07 ab 01.10.2026", null, null))
                .isEqualTo(1);
        assertThat(admin.update(einmal, k.tenant(), s1, "verteilung_rueckwirkend", "MS-07 ab 01.10.2026", null, null))
                .isZero();
        abgelehnt("bericht_revision_anstoss_einmal",
                () -> anstoss(root, k, s1, "verteilung_rueckwirkend", "MS-07 ab 01.10.2026", null, null));
        assertThat(zahl("bericht_revision_anstoss", k.tenant())).isEqualTo(3L);
        // Anstöße legen Naht und Läufer an (Verwaltungsrolle), nie die Anwendung.
        verweigert(() -> alsTue(k.tenant(),
                () -> app.update(einmal, k.tenant(), s1, "flaeche_rueckwirkend", "Halle 2", null, null)));

        // R4: ein offener Anstoß wird verworfen — nur mit Begründung, Person und Zeit — und danach nie wieder geändert.
        UUID offen = root.queryForObject("SELECT id FROM bericht_revision_anstoss WHERE tenant_id = ? "
                + "AND art = 'verteilung_rueckwirkend'", UUID.class, k.tenant());
        abgelehnt("bericht_revision_anstoss_zustand_passt_chk", () -> alsTue(k.tenant(), () -> app.update(
                "UPDATE bericht_revision_anstoss SET zustand = 'verworfen', verworfen_am = now() WHERE id = ?", offen)));
        assertThat(als(k.tenant(), () -> app.update("UPDATE bericht_revision_anstoss SET zustand = 'verworfen', "
                + "verworfen_begruendung = 'Die Verteilung war im Bericht schon berücksichtigt', verworfen_von_sub = 'sub-ines', "
                + "verworfen_von_name = 'Ines Kaltenbach', verworfen_am = now() WHERE id = ?", offen))).isEqualTo(1);
        abgelehnt("bericht_revision_anstoss_append_only", () -> alsTue(k.tenant(), () -> app.update(
                "UPDATE bericht_revision_anstoss SET zustand = 'offen', verworfen_begruendung = NULL, verworfen_von_sub = NULL, "
                        + "verworfen_von_name = NULL, verworfen_am = NULL WHERE id = ?", offen)));
        abgelehnt("bericht_revision_anstoss_append_only", () -> root.update("UPDATE bericht_revision_anstoss "
                + "SET anlass_kennung = 'K-2026-0008' WHERE tenant_id = ? AND art = 'korrektur_freigegeben'", k.tenant()));
    }

    @Test
    void dieBelegeNennenJedenFreigegebenenStandDerDasObjektZitiert() {
        Kunde k = kunde("Belege B12");
        UUID ms12 = UUID.randomUUID();
        UUID andere = UUID.randomUUID();
        // BR-2026-0001: Nr. 1 (ersetzt) und Nr. 2 zitieren MS-12 unmittelbar.
        UUID b1 = bericht(k, "BR-2026-0001", "2026-10");
        stand(root, k, b1, 1, null);
        quelle(k, b1, 1, ms12, "unmittelbar");
        stand(root, k, b1, 2, null);
        quelle(k, b1, 2, ms12, "unmittelbar");
        root.update("UPDATE bericht_stand SET ersetzt_durch_nr = 2 WHERE bericht_id = ? AND nr = 1", b1);
        // BR-2026-0002 (Unternehmen): mittelbar über eine verteilte Zahl.
        UUID b2 = berichtAus(berichtZeile(k, "BR-2026-0002", "monatsbericht_unternehmen", "monat", "2026-10"));
        stand(root, k, b2, 1, null);
        quelle(k, b2, 1, ms12, "mittelbar");
        // BR-2026-0004: der November zitiert den Oktober als Vergleich.
        UUID b4 = bericht(k, "BR-2026-0004", "2026-11");
        stand(root, k, b4, 1, null);
        quelle(k, b4, 1, ms12, "vergleich");
        quelle(k, b4, 1, andere, "unmittelbar");
        // Nicht dabei: ein Entwurf (schützt nichts) und ein Stand, der MS-12 nicht zitiert.
        UUID b3 = bericht(k, "BR-2026-0003", "2026-12");
        entwurf(k, b3, abzug(1));
        quelle(k, b3, null, ms12, "unmittelbar");
        stand(root, k, b3, 1, null);
        quelle(k, b3, 1, andere, "unmittelbar");

        List<String> erwartet = new ArrayList<>();
        for (JsonNode s : fall("B12").at("/pruefungen/0/eingang/werte/staende")) {
            erwartet.add(s.path("kennung").asText() + " Nr. " + s.path("nr").asInt());
        }
        assertThat(erwartet).as("B12 nennt vier Stände").hasSize(4);
        assertThat(als(k.tenant(), () -> app.queryForList("SELECT kennung || ' Nr. ' || nr FROM uems_berichts_belege(?)",
                String.class, ms12))).containsExactlyElementsOf(erwartet);
        assertThat(als(k.tenant(), () -> app.queryForObject("SELECT ersetzt_durch_nr FROM uems_berichts_belege(?) "
                + "WHERE kennung = 'BR-2026-0001' AND nr = 1", Integer.class, ms12))).isEqualTo(2);

        // Als Aufrufer: ohne Kundenbereich und im fremden sieht die Anwendung nichts.
        Kunde fremd = kunde("Belege fremd");
        assertThat(app.queryForList("SELECT kennung FROM uems_berichts_belege(?)", String.class, ms12)).isEmpty();
        assertThat(als(fremd.tenant(), () -> app.queryForList("SELECT kennung FROM uems_berichts_belege(?)", String.class,
                ms12))).isEmpty();
    }

    @Test
    void dieKennungZaehltJeKundenbereichUndJahrUndUeberspringtBelegte() {
        Kunde k = kunde("Kennung");
        Kunde anderer = kunde("Kennung B");
        assertThat(kennung(k, 2026)).isEqualTo("BR-2026-0001");
        assertThat(kennung(k, 2026)).isEqualTo("BR-2026-0002");
        assertThat(kennung(k, 2027)).isEqualTo("BR-2027-0001");
        assertThat(kennung(anderer, 2026)).isEqualTo("BR-2026-0001");
        dazu(root, "bericht", berichtZeile(k, "BR-2026-0003", "monatsbericht_standort", "monat", "2026-10"));
        assertThat(kennung(k, 2026)).as("eine belegte Kennung wird übersprungen").isEqualTo("BR-2026-0004");
        assertThat(root.queryForObject("SELECT naechste_nummer FROM bericht_kennung_seq WHERE tenant_id = ? AND jahr = 2026",
                Integer.class, k.tenant())).isEqualTo(5);

        // Unter dem Zaun vergibt die Anwendung nur für den eigenen Kundenbereich — und nie ohne.
        verweigert(() -> alsTue(k.tenant(), () -> app.queryForObject("SELECT uems_bericht_kennung(?, 2026)", String.class,
                anderer.tenant())));
        verweigert(() -> app.queryForObject("SELECT uems_bericht_kennung(?, 2028)", String.class, k.tenant()));

        // Über 9999 wächst die Nummer, statt abgeschnitten zu werden — und der CHECK nimmt sie an.
        root.update("UPDATE bericht_kennung_seq SET naechste_nummer = 10000 WHERE tenant_id = ? AND jahr = 2027", k.tenant());
        String gross = kennung(k, 2027);
        assertThat(gross).isEqualTo("BR-2027-10000");
        dazu(root, "bericht", berichtZeile(k, gross, "jahresbericht_standort", "jahr", "2026"));
    }

    // ============================================================ Zaun, Rechte, Offboarding

    @Test
    void derMandantenzaunHaeltGegenEinenFremdenKundenbereich() {
        Kunde k = kunde("Zaun");
        Kunde fremd = kunde("Fremd");
        vollstaendig(k);
        Map<String, UUID> f = vollstaendig(fremd);
        for (String tabelle : TABELLEN) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = ?",
                    Boolean.class, tabelle)).as(tabelle + " ENABLE + FORCE").isTrue();
            assertThat(als(k.tenant(), () -> app.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?",
                    Long.class, k.tenant()))).as(tabelle + " im eigenen Zaun").isPositive();
            assertThat(als(fremd.tenant(), () -> app.queryForObject("SELECT count(*) FROM " + tabelle
                    + " WHERE tenant_id = ?", Long.class, k.tenant()))).as(tabelle + " aus dem fremden Zaun").isZero();
            assertThat(app.queryForObject("SELECT count(*) FROM " + tabelle, Long.class)).as(tabelle + " ohne Zaun").isZero();
        }
        // Schreiben in einen fremden Kundenbereich scheitert am WITH CHECK …
        verweigert(() -> alsTue(fremd.tenant(), () -> dazu(app, "bericht",
                berichtZeile(k, "BR-2026-0099", "monatsbericht_standort", "monat", "2026-12"))));
        // … ein Verweis über den Zaun am Fremdschlüssel (der Mandant reist mit).
        abgelehnt("bericht_standort_fk", () -> alsTue(k.tenant(), () -> dazu(app, "bericht", mit(
                berichtZeile(k, "BR-2026-0098", "monatsbericht_standort", "monat", "2026-12"), "standort_id",
                fremd.standort()))));
        abgelehnt("bericht_quelle_bericht_fk", () -> alsTue(k.tenant(), () -> app.update("INSERT INTO bericht_quelle "
                + "(tenant_id, bericht_id, art, kennzeichen, objekt_id, bezug, erster_tag, letzter_tag, name_zum_datenstand) "
                + "VALUES (?, ?, 'messstelle', 'MS-12', ?, 'unmittelbar', DATE '2026-10-01', DATE '2026-10-31', 'Fremd')",
                k.tenant(), f.get("bericht"), UUID.randomUUID())));
        assertThat(als(k.tenant(), () -> app.queryForList("SELECT kennung FROM uems_berichts_belege(?)", String.class,
                f.get("objekt")))).isEmpty();
    }

    @Test
    void dieRechteSindBeschnitten() {
        Map<String, String> appRechte = Map.of("bericht", "SI", "bericht_entwurf", "SI", "bericht_stand", "SI",
                "bericht_quelle", "SID", "bericht_revision_anstoss", "S", "bericht_abruf", "SI", "bericht_aenderung", "SI",
                "bericht_kennung_seq", "SIU");
        Map<String, String> adminRechte = Map.of("bericht", "SD", "bericht_entwurf", "SD", "bericht_stand", "S",
                "bericht_quelle", "SID", "bericht_revision_anstoss", "SI", "bericht_abruf", "S", "bericht_aenderung", "S",
                "bericht_kennung_seq", "SD");
        for (String tabelle : TABELLEN) {
            assertThat(rechte(APP_USER, tabelle)).as("App " + tabelle).isEqualTo(appRechte.get(tabelle));
            assertThat(rechte(ADMIN_USER, tabelle)).as("Verwaltung " + tabelle).isEqualTo(adminRechte.get(tabelle));
        }
        // Spaltenweise nur, was sich wirklich ändern darf.
        assertThat(spalte(APP_USER, "bericht", "archiviert_am", "UPDATE")).isTrue();
        for (String s : List.of("kennung", "vorlage", "geltung_art", "standort_id", "zeitraum_schluessel", "tenant_id")) {
            assertThat(spalte(APP_USER, "bericht", s, "UPDATE")).as("bericht." + s).isFalse();
        }
        for (String rolle : List.of(APP_USER, ADMIN_USER)) {
            for (String s : List.of("abzug", "pruefsumme", "datenstand", "gebildet_von")) {
                assertThat(spalte(rolle, "bericht_entwurf", s, "UPDATE")).as(rolle + " bericht_entwurf." + s).isTrue();
            }
            assertThat(spalte(rolle, "bericht_entwurf", "bericht_id", "UPDATE")).isFalse();
            for (String s : List.of("abzug", "pruefsumme", "nr", "datenstand", "freigeber_name", "anlass_anstoss_id")) {
                assertThat(spalte(rolle, "bericht_stand", s, "UPDATE")).as(rolle + " bericht_stand." + s).isFalse();
            }
        }
        assertThat(spalte(APP_USER, "bericht_stand", "ersetzt_durch_nr", "UPDATE")).isTrue();
        assertThat(spalte(ADMIN_USER, "bericht_stand", "ersetzt_durch_nr", "UPDATE")).isFalse();
        for (String s : List.of("zustand", "erledigt_durch_nr", "verworfen_begruendung", "verworfen_am")) {
            assertThat(spalte(APP_USER, "bericht_revision_anstoss", s, "UPDATE")).as("anstoss." + s).isTrue();
        }
        for (String s : List.of("art", "anlass_kennung", "stand_id", "erkannt_am")) {
            assertThat(spalte(APP_USER, "bericht_revision_anstoss", s, "UPDATE")).as("anstoss." + s).isFalse();
        }
        assertThat(spalte(ADMIN_USER, "bericht_revision_anstoss", "zustand", "UPDATE")).isFalse();

        // Funktionen und Sequenz.
        assertThat(funktion(APP_USER, "uems_berichts_belege(uuid)")).isTrue();
        assertThat(funktion(APP_USER, "uems_bericht_kennung(uuid, integer)")).isTrue();
        assertThat(funktion(APP_USER, "uems_berichte_des_kundenbereichs_entfernen(uuid)")).isFalse();
        assertThat(funktion(ADMIN_USER, "uems_berichte_des_kundenbereichs_entfernen(uuid)")).isTrue();
        assertThat(root.queryForObject("SELECT has_sequence_privilege(?, 'bericht_aenderung_id_seq', 'USAGE')",
                Boolean.class, APP_USER)).isTrue();
        assertThat(root.queryForObject("SELECT prosecdef FROM pg_proc WHERE proname = 'uems_berichts_belege'",
                Boolean.class)).as("SECURITY INVOKER").isFalse();
        assertThat(root.queryForObject("SELECT prosecdef FROM pg_proc WHERE proname = 'uems_bericht_kennung'",
                Boolean.class)).as("SECURITY INVOKER").isFalse();
        assertThat(root.queryForObject("SELECT prosecdef FROM pg_proc "
                + "WHERE proname = 'uems_berichte_des_kundenbereichs_entfernen'", Boolean.class)).isTrue();
    }

    @Test
    void dasOffboardingRaeumtAlleAchtTabellenAb() {
        Kunde k = kunde("Offboarding");
        vollstaendig(k);
        Kunde bleibt = kunde("Bleibt");
        vollstaendig(bleibt);
        Map<String, Long> vorher = new LinkedHashMap<>();
        Map<String, Long> andere = new LinkedHashMap<>();
        for (String tabelle : TABELLEN) {
            vorher.put(tabelle, zahl(tabelle, k.tenant()));
            andere.put(tabelle, root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id <> ?",
                    Long.class, k.tenant()));
        }
        assertThat(vorher).as("jede Tabelle hat Zeilen des Kundenbereichs").allSatisfy((t, n) -> assertThat(n).isPositive());

        new TenantRepository(new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), ADMIN_USER, ADMIN_PW))).offboard(k.tenant());

        for (String tabelle : TABELLEN) {
            assertThat(zahl(tabelle, k.tenant())).as(tabelle).isZero();
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id <> ?", Long.class,
                    k.tenant())).as("andere Kundenbereiche bleiben: " + tabelle).isEqualTo(andere.get(tabelle));
        }
        for (String tabelle : List.of("standort", "unternehmen")) {
            assertThat(zahl(tabelle, k.tenant())).as(tabelle).isZero();
        }
        assertThat(root.queryForObject("SELECT count(*) FROM tenant WHERE id = ?", Long.class, k.tenant())).isZero();
    }

    // ============================================================ Bestand, out-of-order

    @Test
    void dieMigrationLegtNurDanebenUndLaesstDenBestandZeichengleich() {
        assertThat(fingerVorher).hasSizeGreaterThan(100).doesNotContainKeys(TABELLEN.toArray(String[]::new));
        assertThat(fingerVorher.get("standort")).as("es gibt Bestand").isNotEqualTo(Bestandsschutz.LEER);
        assertThat(fingerVorher.get("unternehmen")).as("es gibt Bestand").isNotEqualTo(Bestandsschutz.LEER);
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
        for (String tabelle : TABELLEN) {
            assertThat(fingerNachMigration).as(tabelle).containsEntry(tabelle, Bestandsschutz.LEER);
        }
    }

    /** Der Vergleich beißt noch: eine geänderte Bestandszeile fällt auf. */
    @Test
    void derBestandsvergleichFaengtEineGeaenderteZeile() {
        Bestandsschutz.mutationsprobe(root, List.of(), "unternehmen", "UPDATE unternehmen SET name = name || ' (Probe)'");
    }

    /**
     * Out-of-order: eine Datenbank, auf der ALLE anderen Migrationen schon liegen, bekommt diese als späte Ankunft —
     * und hat danach dieselben Tabellen, Constraints, Indexe und Vokabulare wie die frische Datenbank in
     * Versionsreihenfolge.
     */
    @Test
    void dieMigrationTraegtAuchAlsSpaeteAnkunft() throws IOException {
        root.execute("CREATE DATABASE voltpilot_spaet");
        Path ohneDiese = Files.createTempDirectory("migrationen-ohne-bericht");
        try (var dateien = Files.list(MIGRATIONEN)) {
            for (Path datei : dateien.toList()) {
                String name = datei.getFileName().toString();
                if (!name.startsWith("V" + DIESE + "__")
                        && BAUEN_DARAUF_AUF.stream().noneMatch(v -> name.startsWith("V" + v + "__"))) {
                    Files.copy(datei, ohneDiese.resolve(datei.getFileName()));
                }
            }
        }
        String url = POSTGRES.getJdbcUrl().replaceFirst("/voltpilot(?=\\?|$)", "/voltpilot_spaet");
        flyway(url).locations("filesystem:" + ohneDiese.toAbsolutePath()).load().migrate();
        MigrateResult spaet = flyway(url).outOfOrder(true).load().migrate();
        List<String> spaeteAnkunft = new ArrayList<>(List.of(DIESE));
        spaeteAnkunft.addAll(BAUEN_DARAUF_AUF);
        assertThat(spaet.migrations).extracting(m -> m.version).containsExactlyElementsOf(spaeteAnkunft);

        JdbcTemplate db = new JdbcTemplate(ds(url, POSTGRES.getUsername(), POSTGRES.getPassword()));
        for (String sql : List.of(
                "SELECT format('(%L, %s, %L)', vokabular, nr, wort) FROM bericht_vokabular()",
                "SELECT format('(%L, %L, %L)', vorlage, geltung_art, zeitraum_art) FROM bericht_vorlage()",
                "SELECT table_name || '.' || column_name || ':' || data_type FROM information_schema.columns "
                        + "WHERE table_schema = 'public' AND table_name LIKE 'bericht%' ORDER BY table_name, ordinal_position",
                "SELECT conrelid::regclass::text || '.' || conname || ' ' || pg_get_constraintdef(oid) FROM pg_constraint "
                        + "WHERE conrelid::regclass::text LIKE 'bericht%' ORDER BY 1",
                "SELECT tablename || ' ' || indexname || ' ' || indexdef FROM pg_indexes WHERE tablename LIKE 'bericht%' "
                        + "ORDER BY 1",
                "SELECT tgrelid::regclass::text || '.' || tgname FROM pg_trigger WHERE NOT tgisinternal "
                        + "AND tgrelid::regclass::text LIKE 'bericht%' ORDER BY 1")) {
            assertThat(db.queryForList(sql, String.class)).as(sql).isNotEmpty()
                    .isEqualTo(root.queryForList(sql, String.class));
        }
    }

    // ===================================================================== Gerüst

    private static Kunde kunde(String name) {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, name);
        UUID st = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        return new Kunde(t, u, st);
    }

    /** Je Tabelle mindestens eine Zeile: Bericht mit Entwurf, Nr. 1 (ersetzt) und Nr. 2 (Revision), Quellen, Anstoß, Abruf, Protokoll, Kennung. */
    private static Map<String, UUID> vollstaendig(Kunde k) {
        UUID b = bericht(k, "BR-2026-0001", "2026-10");
        entwurf(k, b, abzug(2));
        UUID objekt = UUID.randomUUID();
        quelle(k, b, null, objekt, "unmittelbar");
        UUID s1 = stand(root, k, b, 1, null);
        quelle(k, b, 1, objekt, "unmittelbar");
        UUID a = anstoss(root, k, s1, "korrektur_freigegeben", "K-2026-0007", 2, "freigegeben");
        UUID s2 = stand(root, k, b, 2, a);
        quelle(k, b, 2, objekt, "unmittelbar");
        root.update("UPDATE bericht_stand SET ersetzt_durch_nr = 2 WHERE id = ?", s1);
        root.update("UPDATE bericht_revision_anstoss SET zustand = 'erledigt', erledigt_durch_nr = 2 WHERE id = ?", a);
        abruf(k, s1, "csv");
        protokoll(k, b, "freigeben");
        root.queryForObject("SELECT uems_bericht_kennung(?, 2026)", String.class, k.tenant());
        return Map.of("bericht", b, "stand1", s1, "stand2", s2, "anstoss", a, "objekt", objekt);
    }

    private static Map<String, Object> berichtZeile(Kunde k, String kennung, String vorlage, String zeitraumArt,
            String schluessel) {
        boolean amStandort = vorlage.endsWith("_standort");
        Map<String, Object> z = new LinkedHashMap<>();
        z.put("tenant_id", k.tenant());
        z.put("kennung", kennung);
        z.put("vorlage", vorlage);
        z.put("vorlage_fassung", 1);
        z.put("geltung_art", amStandort ? "standort" : "unternehmen");
        z.put(amStandort ? "standort_id" : "unternehmen_id", amStandort ? k.standort() : k.unternehmen());
        z.put("zeitraum_art", zeitraumArt);
        z.put("zeitraum_schluessel", schluessel);
        z.put("zeitzone", "Europe/Berlin");
        z.put("angelegt_von_sub", "sub-ines");
        z.put("angelegt_von_name", "Ines Kaltenbach");
        return z;
    }

    private static UUID bericht(Kunde k, String kennung, String zeitraum) {
        return berichtAus(berichtZeile(k, kennung, "monatsbericht_standort", "monat", zeitraum));
    }

    private static UUID berichtAus(Map<String, Object> zeile) {
        return root.queryForObject(insert("bericht", zeile) + " RETURNING id", UUID.class, zeile.values().toArray());
    }

    private static void entwurf(Kunde k, UUID bericht, String abzug) {
        root.update("INSERT INTO bericht_entwurf (tenant_id, bericht_id, abzug, pruefsumme, datenstand, gebildet_von) "
                + "VALUES (?, ?, ?, bericht_pruefsumme(?), ?, 'anlegen')", k.tenant(), bericht, abzug, abzug, DATENSTAND);
    }

    private static UUID stand(JdbcTemplate db, Kunde k, UUID bericht, int nr, UUID anlass) {
        String abzug = abzug(nr);
        return db.queryForObject(STAND, UUID.class, k.tenant(), bericht, nr, abzug, abzug, DATENSTAND.plusDays(nr - 1),
                FREIGABE.plusDays(nr - 1), anlass);
    }

    private static String abzug(int nr) {
        return "{\"bericht\":\"BR-2026-0001\",\"nr\":" + nr + "}";
    }

    private static void quelle(Kunde k, UUID bericht, Integer standNr, UUID objekt, String bezug) {
        root.update("INSERT INTO bericht_quelle (tenant_id, bericht_id, stand_nr, art, kennzeichen, objekt_id, bezug, "
                + "erster_tag, letzter_tag, version, name_zum_datenstand) VALUES (?, ?, ?, 'messstelle', 'MS-12', ?, ?, "
                + "DATE '2026-10-01', DATE '2026-10-31', 1, 'Montage Linie M1')", k.tenant(), bericht, standNr, objekt, bezug);
    }

    private static UUID anstoss(JdbcTemplate db, Kunde k, UUID stand, String art, String kennung, Integer fassung,
            String status) {
        return db.queryForObject("INSERT INTO bericht_revision_anstoss (tenant_id, stand_id, art, anlass_kennung, "
                + "anlass_fassung, anlass_status) VALUES (?, ?, ?, ?, ?, ?) RETURNING id", UUID.class, k.tenant(), stand, art,
                kennung, fassung, status);
    }

    private static UUID abruf(Kunde k, UUID stand, String format) {
        return root.queryForObject("INSERT INTO bericht_abruf (tenant_id, stand_id, format, actor_sub, actor_name, "
                + "actor_rolle, actor_art) VALUES (?, ?, ?, 'sub-claudia', 'Claudia', 'leser', 'kunde') RETURNING id",
                UUID.class, k.tenant(), stand, format);
    }

    private static long protokoll(Kunde k, UUID bericht, String art) {
        return root.queryForObject("INSERT INTO bericht_aenderung (tenant_id, bericht_id, art, actor_sub, actor_name, "
                + "actor_rolle, actor_art) VALUES (?, ?, ?, 'sub-ines', 'Ines Kaltenbach', 'energiemanager', 'kunde') "
                + "RETURNING id", Long.class, k.tenant(), bericht, art);
    }

    private static String kennung(Kunde k, int jahr) {
        return als(k.tenant(), () -> app.queryForObject("SELECT uems_bericht_kennung(?, ?)", String.class, k.tenant(), jahr));
    }

    private static JsonNode fall(String id) {
        for (JsonNode f : vertrag.path("cases")) {
            if (f.path("id").asText().equals(id)) {
                return f;
            }
        }
        throw new AssertionError("kein Fall " + id);
    }

    private static String zeile(String vokabular, int nr, String wort) {
        return "('" + vokabular + "', " + nr + ", '" + wort + "')";
    }

    private static List<String> liste(String vokabular) {
        List<String> woerter = new ArrayList<>();
        vertrag.path("vokabulare").path(vokabular).forEach(w -> woerter.add(w.asText()));
        assertThat(woerter).as(vokabular).isNotEmpty();
        return woerter;
    }

    private static String definition(String tabelle, String constraint) {
        return root.queryForObject("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = ? "
                + "AND conrelid = ?::regclass", String.class, constraint, tabelle);
    }

    private static Set<String> woerter(String definition) {
        Set<String> gefunden = new TreeSet<>();
        Matcher m = Pattern.compile("'([^']+)'::text").matcher(definition);
        while (m.find()) {
            gefunden.add(m.group(1));
        }
        return gefunden;
    }

    private static String pgArray(List<String> werte) {
        return "{" + String.join(",", werte) + "}";
    }

    private static void dazu(JdbcTemplate db, String tabelle, Map<String, Object> spalten) {
        db.update(insert(tabelle, spalten), spalten.values().toArray());
    }

    private static String insert(String tabelle, Map<String, Object> spalten) {
        return "INSERT INTO " + tabelle + " (" + String.join(", ", spalten.keySet()) + ") VALUES ("
                + String.join(", ", Collections.nCopies(spalten.size(), "?")) + ")";
    }

    private static Map<String, Object> mit(Map<String, Object> zeile, Object... paare) {
        Map<String, Object> neu = new LinkedHashMap<>(zeile);
        for (int i = 0; i < paare.length; i += 2) {
            neu.put((String) paare[i], paare[i + 1]);
        }
        return neu;
    }

    private static long zahl(String tabelle, UUID tenant) {
        return root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?", Long.class, tenant);
    }

    private static String rechte(String rolle, String tabelle) {
        StringBuilder s = new StringBuilder();
        for (String[] r : new String[][] {{"S", "SELECT"}, {"I", "INSERT"}, {"U", "UPDATE"}, {"D", "DELETE"},
                {"T", "TRUNCATE"}}) {
            if (Boolean.TRUE.equals(root.queryForObject("SELECT has_table_privilege(?, ?, ?)", Boolean.class, rolle,
                    tabelle, r[1]))) {
                s.append(r[0]);
            }
        }
        return s.toString();
    }

    private static boolean spalte(String rolle, String tabelle, String spalte, String recht) {
        return Boolean.TRUE.equals(root.queryForObject("SELECT has_column_privilege(?, ?, ?, ?)", Boolean.class,
                rolle, tabelle, spalte, recht));
    }

    private static boolean funktion(String rolle, String signatur) {
        return Boolean.TRUE.equals(root.queryForObject("SELECT has_function_privilege(?, ?, 'EXECUTE')", Boolean.class,
                rolle, signatur));
    }

    /** Die Probe „MIT Recht“: die Rolle bekommt UPDATE und DELETE, im Zaun des Kundenbereichs — zurückgerollt. */
    private static void mitRecht(String rolle, String tabelle, UUID tenant, Runnable arbeit) {
        zurueckgerollt(root, () -> {
            root.execute("GRANT UPDATE, DELETE ON " + tabelle + " TO " + rolle);
            root.execute("SET LOCAL ROLE " + rolle);
            root.queryForObject("SELECT set_config('app.tenant_id', ?, true)", String.class, tenant.toString());
            arbeit.run();
        });
    }

    private static void zurueckgerollt(JdbcTemplate db, Runnable arbeit) {
        new TransactionTemplate(new DataSourceTransactionManager(db.getDataSource())).executeWithoutResult(status -> {
            status.setRollbackOnly();
            arbeit.run();
        });
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

    private static PSQLException psql(Runnable arbeit, String erwartet) {
        Throwable t = null;
        try {
            arbeit.run();
        } catch (Throwable e) {
            t = e;
        }
        assertThat(t).as("die Datenbank muss ablehnen (" + erwartet + ")").isNotNull();
        PSQLException p = null;
        for (Throwable c = t; c != null; c = c.getCause()) {
            if (c instanceof PSQLException pe) {
                p = pe;
            }
        }
        assertThat((Object) p).as("eine PSQLException: " + t).isNotNull();
        return p;
    }

    private static void abgelehnt(String constraint, Runnable arbeit) {
        PSQLException p = psql(arbeit, constraint);
        assertThat(p.getServerErrorMessage().getConstraint()).as(p.getMessage()).isEqualTo(constraint);
    }

    private static void verweigert(Runnable arbeit) {
        PSQLException p = psql(arbeit, "42501");
        assertThat(p.getSQLState()).as(p.getMessage()).isEqualTo("42501");
    }

    private static String letzteFassungVorDieser() {
        MigrationVersion diese = MigrationVersion.fromVersion(DIESE);
        return Arrays.stream(flyway(POSTGRES.getJdbcUrl()).load().info().all())
                .map(MigrationInfo::getVersion)
                .filter(v -> v != null && v.compareTo(diese) < 0)
                .max(Comparator.naturalOrder())
                .orElseThrow()
                .getVersion();
    }

    private static FluentConfiguration flyway(String url) {
        return Flyway.configure()
                .dataSource(url, POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW));
    }

    private static DataSource ds(String url, String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(url);
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
