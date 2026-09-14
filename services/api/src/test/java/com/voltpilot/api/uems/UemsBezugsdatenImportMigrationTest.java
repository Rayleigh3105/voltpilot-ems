package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
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
 * Die Migration {@code V20260914173000__uems_bezugsdaten_import.sql} (UEMS AP-09 IP-12): die Tabellen eines
 * Imports — {@code bezugsdaten_import} und {@code _zeile} append-only, {@code bezugsdaten_vorlage} als Fassungen —
 * und die Zwei-Jahres-Frist der Zeilentexte (E14).
 *
 * <p>Der Bestand (Bezugsgröße mit Wert, Stammdatum und Protokoll) wird VOR der Migration geschrieben;
 * {@link Bestandsschutz} beweist, dass sie keine Zeile anfasst und keine neue Tabelle füllt. Die Datei des Kunden
 * hat keine Spalte: {@link #dieDateiSelbstHatKeinenPlatz()}.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsBezugsdatenImportMigrationTest {

    private static final String DIESE = "20260914173000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final List<String> TABELLEN = List.of("bezugsdaten_vorlage", "bezugsdaten_import", "bezugsdaten_import_zeile");
    private static final String SHA = "ab".repeat(32);

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static JdbcTemplate admin;
    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;

    private record Kunde(UUID tenant, UUID unternehmen, UUID standort) {}

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        Kunde a = kunde("Kunststoffwerk Ahrenberg GmbH");
        UUID bg = periodenwert(root, a, "BZ-1");
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, periode_von, "
                + "periode_bis, zeitzone, fassung, vorgang, status, betrag, herkunft_art, import_kennung, import_zeile, "
                + "geliefert_text, geliefert_einheit, actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, "
                + "'periodenwert', 'kg', 'monat', '2025-10-01', '2025-10-31', 'Europe/Berlin', 1, 'erstwert', 'wirksam', "
                + "312400, 'import', 'I-2025-0001', 2, '312.400,0', 'kg', 'sub-ik', 'Ines Kaltenbach', 'energiemanager', "
                + "'kunde')", a.tenant(), bg);
        root.update("INSERT INTO bezugsgroesse_aenderung (tenant_id, bezugsgroesse_id, art, gilt_ab, rueckwirkend, "
                + "actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, 'angelegt', date_trunc('minute', now()), "
                + "false, 'sub-ik', 'Ines Kaltenbach', 'energiemanager', 'kunde')", a.tenant(), bg);
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());

        flyway().target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        flyway().load().migrate();

        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ============================================================ Bestandsschutz

    @Test
    void dieMigrationLaesstDenBestandZeichengleichUndFuelltKeineNeueTabelle() {
        assertThat(fingerVorher.get("bezugsgroesse_wert")).as("es gibt Werte").isNotEqualTo(Bestandsschutz.LEER);
        assertThat(fingerVorher.get("bezugsgroesse_aenderung")).isNotEqualTo(Bestandsschutz.LEER);
        for (String t : TABELLEN) {
            assertThat(fingerNachMigration.get(t)).as(t + " bleibt leer").isEqualTo(Bestandsschutz.LEER);
        }
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
    }

    @Test
    void derBestandsvergleichBeisst() {
        Bestandsschutz.mutationsprobe(root, List.of(), "bezugsgroesse", "UPDATE bezugsgroesse SET name = name || ' '");
    }

    // ============================================================ Vokabular: eine Stelle

    @Test
    void jederVokabularCheckFragtDieEineStelle() {
        for (String[] c : new String[][] {
                {"bezugsdaten_import", "bezugsdaten_import_status_chk", "import_status"},
                {"bezugsdaten_import", "bezugsdaten_import_kodierung_chk", "kodierung"},
                {"bezugsdaten_import", "bezugsdaten_import_trennzeichen_chk", "trennzeichen"},
                {"bezugsdaten_import", "bezugsdaten_import_befunde_chk", "bezugsdaten_befunde_gueltig"},
                {"bezugsdaten_import_zeile", "bezugsdaten_import_zeile_urteil_chk", "zeilen_urteil"},
                {"bezugsdaten_import_zeile", "bezugsdaten_import_zeile_befunde_chk", "bezugsdaten_befunde_gueltig"},
                {"bezugsdaten_import_zeile", "bezugsdaten_import_zeile_einheit_chk", "einheiten"}}) {
            String def = root.queryForObject("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = ? "
                    + "AND conrelid = ?::regclass", String.class, c[1], c[0]);
            assertThat(def).as(c[1]).contains(c[2]).doesNotContain("'uebernommen'").doesNotContain("'neu'")
                    .doesNotContain("'utf-8'");
        }
        assertThat(root.queryForObject("SELECT bezugsdaten_befunde_gueltig('[\"datei_bekannt\", \"einheit_umgerechnet\"]')",
                Boolean.class)).isTrue();
        assertThat(root.queryForObject("SELECT bezugsdaten_befunde_gueltig('[\"datei_bekannt\", \"datei_bekannt\"]')",
                Boolean.class)).as("ein Wort nie doppelt").isFalse();
        assertThat(root.queryForObject("SELECT bezugsdaten_befunde_gueltig('[\"vorschau_veraltet\"]')", Boolean.class))
                .as("C8 ist geschlossen").isFalse();
        assertThat(root.queryForObject("SELECT bezugsdaten_befunde_gueltig('{}')", Boolean.class)).isFalse();
        assertThat(root.queryForObject("SELECT bezugsdaten_zeilentext_frist() = interval '2 years'", Boolean.class)).isTrue();
    }

    // ============================================================ Die Datei selbst wird nicht gespeichert (E14)

    @Test
    void dieDateiSelbstHatKeinenPlatz() {
        List<String> spalten = root.queryForList("SELECT column_name || ':' || data_type FROM information_schema.columns "
                + "WHERE table_name IN ('bezugsdaten_import', 'bezugsdaten_import_zeile', 'bezugsdaten_vorlage')", String.class);
        assertThat(spalten).as("keine Bytes, kein Dateiinhalt").noneMatch(s -> s.endsWith(":bytea"))
                .noneMatch(s -> s.startsWith("inhalt:") || s.startsWith("datei:") || s.startsWith("datei_inhalt:"));
        assertThat(spalten).contains("datei_sha256:text", "datei_name:text", "datei_bytes:integer", "text:text");
    }

    // ============================================================ Zaun und Rechte

    @Test
    void jedeTabelleHatDenZaunUndEngeRechte() {
        for (String t : TABELLEN) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = ?",
                    Boolean.class, t)).as(t + " ENABLE + FORCE").isTrue();
            Map<String, Object> policy = root.queryForMap("SELECT qual, with_check FROM pg_policies WHERE tablename = ?", t);
            assertThat((String) policy.get("qual")).as(t).contains("app.tenant_id");
            assertThat((String) policy.get("with_check")).as(t).contains("app.tenant_id");
            assertThat(tabellenrechte(APP_USER, t)).as(t + ": lesen, spaltenweise anlegen — nie ändern, nie löschen").isEqualTo("S");
            assertThat(tabellenrechte(ADMIN_USER, t)).as(t + ": nur das Offboarding löscht").isEqualTo("SD");
            assertThat(spaltenrecht(APP_USER, t, "created_at", "INSERT")).as(t + ": die Zeit setzt die Datenbank").isFalse();
            assertThat(spaltenrecht(APP_USER, t, "tenant_id", "INSERT")).isTrue();
            assertThat(spaltenrecht(APP_USER, t, "tenant_id", "UPDATE")).isFalse();
        }
        assertThat(spaltenrecht(APP_USER, "bezugsdaten_import_zeile", "import_fassung", "INSERT")).isFalse();
        for (String spalte : List.of("text", "text_entfernt_am")) {
            assertThat(spaltenrecht(ADMIN_USER, "bezugsdaten_import_zeile", spalte, "UPDATE")).as(spalte).isTrue();
            assertThat(spaltenrecht(APP_USER, "bezugsdaten_import_zeile", spalte, "UPDATE")).as(spalte).isFalse();
        }
        for (String spalte : List.of("urteil", "befunde", "betrag", "fingerabdruck", "bezugsgroesse_id")) {
            assertThat(spaltenrecht(ADMIN_USER, "bezugsdaten_import_zeile", spalte, "UPDATE")).as(spalte).isFalse();
        }
        assertThat(tabellenrechte(APP_USER, "bezugsgroesse_wert")).as("die Rechte des Bestands bleiben").isEqualTo("S");
    }

    @Test
    void ohneMandantKeineZeileUndFremdIstNichtDa() {
        Kunde a = kunde("Zaun A");
        Kunde b = kunde("Zaun B");
        vorlage(root, a, UUID.randomUUID(), 1);
        importFassung1(root, a, "I-2026-0001", "uebernommen", null);
        zeile(root, a, "I-2026-0001", 2, "abgelehnt", "[\"bezug_unbekannt\"]", null);
        for (String t : TABELLEN) {
            assertThat(app.queryForObject("SELECT count(*) FROM " + t, Long.class)).as(t + " ohne app.tenant_id").isZero();
            assertThat(als(b.tenant(), () -> app.queryForObject("SELECT count(*) FROM " + t, Long.class))).as(t).isZero();
            assertThat(als(a.tenant(), () -> app.queryForObject("SELECT count(*) FROM " + t, Long.class))).as(t).isOne();
        }
        PSQLException fremd = psql(() -> als(b.tenant(), () -> importFassung1(app, a, "I-2026-0002", "uebernommen", null)));
        assertThat(fremd.getMessage()).contains("row-level security");
        // Ein fremder Import ist auch per Fremdschlüssel nicht erreichbar: der Mandant reist im Schlüssel mit.
        abgelehnt("bezugsdaten_import_zeile_import_fk",
                () -> root.update("INSERT INTO bezugsdaten_import_zeile (tenant_id, import_kennung, nr, text, urteil) "
                        + "VALUES (?, 'I-2026-0001', 3, 'x', 'abgelehnt')", b.tenant()));
    }

    // ============================================================ Import: Fassungen, append-only

    @Test
    void einImportIstEineFolgeVonFassungenUndNieEineVorschau() {
        Kunde k = kunde("Fassungen");
        abgelehnt("bezugsdaten_import_status_chk", () -> importFassung1(root, k, "I-2026-0001", "vorschau", null));
        abgelehnt("bezugsdaten_import_status_chk", () -> importFassung1(root, k, "I-2026-0001", "unbekannt", null));
        als(k.tenant(), () -> importFassung1(app, k, "I-2026-0001", "uebernommen", null));
        abgelehnt("bezugsdaten_import_fassung_lueckenlos", () -> ruecknahme(root, k, "I-2026-0001", 3, "ERP-Nachbuchung storniert"));
        abgelehnt("bezugsdaten_import_erste_fassung_chk", () -> ruecknahme(root, k, "I-2026-0001", 2, null));
        abgelehnt("bezugsdaten_import_begruendung_chk", () -> ruecknahme(root, k, "I-2026-0001", 2, "zu kurz"));
        assertThat(als(k.tenant(), () -> ruecknahme(app, k, "I-2026-0001", 2, "ERP-Nachbuchung storniert"))).isOne();
        abgelehnt("bezugsdaten_import_kennung_chk", () -> importFassung1(root, k, "I-26-1", "uebernommen", null));
        abgelehnt("bezugsdaten_import_trennzeichen_chk", () -> root.update(importSql("'|'"), k.tenant(), "I-2026-0009",
                "uebernommen", null, null));
        abgelehnt("bezugsdaten_import_zaehler_chk", () -> root.update("INSERT INTO bezugsdaten_import (tenant_id, kennung, "
                + "fassung, status, datei_name, datei_bytes, datei_sha256, kodierung, trennzeichen, kopfzeile, zeilen, neu, "
                + "wiederholung, konflikt, berichtigung, uebersprungen, abgelehnt, mit_hinweis, aenderungen, befunde, "
                + "actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, 'I-2026-0008', 1, 'uebernommen', 'a.csv', 77, ?, "
                + "'utf-8', ';', true, 1, 1, 0, 0, 0, 0, 0, 0, 0, '[]', 'sub-ik', 'Ines Kaltenbach', 'energiemanager', 'kunde')",
                k.tenant(), SHA));

        PSQLException aendern = psql(() -> als(k.tenant(), () -> app.update(
                "UPDATE bezugsdaten_import SET status = 'verworfen' WHERE kennung = 'I-2026-0001'")));
        assertThat(aendern.getMessage()).contains("permission denied");
        PSQLException auchRoot = psql(() -> root.update("UPDATE bezugsdaten_import SET datei_name = 'b.csv' WHERE kennung = 'I-2026-0001'"));
        assertThat(auchRoot.getMessage()).contains("append-only");
        PSQLException loeschen = psql(() -> als(k.tenant(), () -> app.update("DELETE FROM bezugsdaten_import")));
        assertThat(loeschen.getMessage()).contains("permission denied");
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsdaten_import WHERE tenant_id = ?", Long.class, k.tenant()))
                .isEqualTo(2);
    }

    @Test
    void eineVorlageIstEineFolgeVonFassungenUndEinImportNenntSeine() {
        Kunde k = kunde("Vorlage");
        UUID v = UUID.randomUUID();
        als(k.tenant(), () -> vorlage(app, k, v, 1));
        abgelehnt("bezugsdaten_vorlage_fassung_lueckenlos", () -> vorlage(root, k, v, 3));
        als(k.tenant(), () -> vorlage(app, k, v, 2));
        PSQLException umschreiben = psql(() -> root.update("UPDATE bezugsdaten_vorlage SET name = 'neu' WHERE vorlage_id = ?", v));
        assertThat(umschreiben.getMessage()).contains("append-only");
        abgelehnt("bezugsdaten_vorlage_json_chk", () -> root.update("INSERT INTO bezugsdaten_vorlage (tenant_id, vorlage_id, "
                + "fassung, name, formatregeln, actor_sub, actor_name, actor_art) VALUES (?, ?, 1, 'x', '[]', 'sub-ik', 'Ines', "
                + "'kunde')", k.tenant(), UUID.randomUUID()));
        assertThat(root.update(importSql("';'"), k.tenant(), "I-2026-0001", "uebernommen", v, 1)).isOne();
        abgelehnt("bezugsdaten_import_vorlage_fk", () -> root.update(importSql("';'"), k.tenant(), "I-2026-0002", "uebernommen", v, 9));
        abgelehnt("bezugsdaten_import_vorlage_chk", () -> root.update(importSql("';'"), k.tenant(), "I-2026-0003", "uebernommen", v, null));
    }

    // ============================================================ Zeile: Urteil, Schlüssel, zwei Jahre Text

    @Test
    void eineZeileTraegtUrteilBefundeUndDenFachlichenSchluessel() {
        Kunde k = kunde("Zeile");
        UUID bg = periodenwert(root, k, "BZ-1");
        importFassung1(root, k, "I-2026-0001", "teilweise_uebernommen", null);
        assertThat(als(k.tenant(), () -> zeileMitSchluessel(app, k, "I-2026-0001", 2, bg, "neu", "[]"))).isOne();
        assertThat(als(k.tenant(), () -> zeile(app, k, "I-2026-0001", 3, "abgelehnt", "[\"einheit_unbekannt\"]", null))).isOne();
        abgelehnt("bezugsdaten_import_zeile_urteil_chk", () -> zeile(root, k, "I-2026-0001", 4, "vielleicht", "[]", null));
        abgelehnt("bezugsdaten_import_zeile_befunde_chk", () -> zeile(root, k, "I-2026-0001", 4, "abgelehnt", "[\"lbs\"]", null));
        abgelehnt("bezugsdaten_import_zeile_urteil_schluessel_chk", () -> zeile(root, k, "I-2026-0001", 4, "neu", "[]", null));
        abgelehnt("bezugsdaten_import_zeile_pk", () -> zeile(root, k, "I-2026-0001", 3, "abgelehnt", "[]", null));
        abgelehnt("bezugsdaten_import_zeile_schluessel_chk", () -> root.update("INSERT INTO bezugsdaten_import_zeile (tenant_id, "
                + "import_kennung, nr, text, urteil, bezugsgroesse_id, bezugsgroesse_kennzeichen, periode_von, periode_bis, "
                + "zeitpunkt, zeitzone, betrag, einheit, fingerabdruck) VALUES (?, 'I-2026-0001', 5, 'x', 'neu', ?, 'BZ-1', "
                + "'2026-10-01', '2026-10-31', now(), 'Europe/Berlin', 1, 'kg', ?)", k.tenant(), bg, SHA));
        PSQLException umurteilen = psql(() -> root.update("UPDATE bezugsdaten_import_zeile SET urteil = 'wiederholung' "
                + "WHERE import_kennung = 'I-2026-0001' AND nr = 2 AND tenant_id = ?", k.tenant()));
        assertThat(umurteilen.getMessage()).contains("append-only");
    }

    /**
     * E14 — ein Zeilentext bleibt zwei Jahre. Vorher lehnt der Trigger das Entfernen für JEDE Rolle ab; danach entfernt
     * der Lauf ihn und NUR ihn: Urteil, Befunde, Schlüssel und Fingerabdruck bleiben. Kein anderes Feld wird je
     * geändert, auch nach der Frist nicht.
     */
    @Test
    void derZeilentextBleibtZweiJahreUndDannNurDerText() {
        Kunde k = kunde("Zwei Jahre");
        UUID bg = periodenwert(root, k, "BZ-1");
        importFassung1(root, k, "I-2024-0001", "uebernommen", null);
        root.update("INSERT INTO bezugsdaten_import_zeile (tenant_id, import_kennung, nr, text, urteil, befunde, "
                + "bezugsgroesse_id, bezugsgroesse_kennzeichen, periode_von, periode_bis, zeitzone, betrag, einheit, "
                + "geliefert_wert, geliefert_einheit, fingerabdruck, created_at) VALUES (?, 'I-2024-0001', 2, "
                + "'2024-08;Spritzguss gesamt;298.100,0;kg', 'neu', '[]', ?, 'BZ-1', '2024-08-01', '2024-08-31', "
                + "'Europe/Berlin', 298100, 'kg', '298.100,0', 'kg', ?, now() - interval '2 years' - interval '1 day')",
                k.tenant(), bg, SHA);
        root.update("INSERT INTO bezugsdaten_import_zeile (tenant_id, import_kennung, nr, text, urteil, befunde, created_at) "
                + "VALUES (?, 'I-2024-0001', 3, '2024-08;Montage;96;Paletten', 'abgelehnt', '[\"einheit_unbekannt\"]', "
                + "now() - interval '2 years' + interval '1 day')", k.tenant());
        String behalten = "SELECT urteil || befunde::text || coalesce(fingerabdruck, '-') || coalesce(betrag::text, '-') "
                + "FROM bezugsdaten_import_zeile WHERE tenant_id = ? ORDER BY nr";
        List<String> vorher = root.queryForList(behalten, String.class, k.tenant());

        PSQLException zuFrueh = psql(() -> admin.update("UPDATE bezugsdaten_import_zeile SET text = NULL, "
                + "text_entfernt_am = now() WHERE tenant_id = ? AND nr = 3", k.tenant()));
        assertThat(zuFrueh.getMessage()).as("vor der Frist").contains("append-only");
        PSQLException mehrAlsText = psql(() -> root.update("UPDATE bezugsdaten_import_zeile SET text = NULL, "
                + "text_entfernt_am = now(), betrag = 1 WHERE tenant_id = ? AND nr = 2", k.tenant()));
        assertThat(mehrAlsText.getMessage()).as("nach der Frist geht NUR der Text").contains("append-only");
        abgelehnt("bezugsdaten_import_zeile_append_only", () -> root.update("UPDATE bezugsdaten_import_zeile SET text = NULL "
                + "WHERE tenant_id = ? AND nr = 2", k.tenant()));
        abgelehnt("bezugsdaten_import_zeile_text_chk", () -> root.update("INSERT INTO bezugsdaten_import_zeile (tenant_id, "
                + "import_kennung, nr, urteil) VALUES (?, 'I-2024-0001', 9, 'abgelehnt')", k.tenant()));
        PSQLException app2 = psql(() -> als(k.tenant(), () -> app.update("UPDATE bezugsdaten_import_zeile SET text = NULL, "
                + "text_entfernt_am = now() WHERE nr = 2")));
        assertThat(app2.getMessage()).as("die Anwendung hat das Recht nicht").contains("permission denied");

        assertThat(new ZeilentextAufbewahrung(admin).lauf()).as("genau die eine alte Zeile").isGreaterThanOrEqualTo(1);
        assertThat(root.queryForObject("SELECT text IS NULL AND text_entfernt_am IS NOT NULL FROM bezugsdaten_import_zeile "
                + "WHERE tenant_id = ? AND nr = 2", Boolean.class, k.tenant())).isTrue();
        assertThat(root.queryForObject("SELECT text FROM bezugsdaten_import_zeile WHERE tenant_id = ? AND nr = 3", String.class,
                k.tenant())).as("die jüngere bleibt").isEqualTo("2024-08;Montage;96;Paletten");
        assertThat(root.queryForList(behalten, String.class, k.tenant())).as("Urteil, Befunde, Schlüssel bleiben").isEqualTo(vorher);
        assertThat(new ZeilentextAufbewahrung(admin).lauf()).as("zweimal = nichts mehr zu tun").isZero();
    }

    /** Eine Bezugsgröße ohne Wert bleibt löschbar; ihre Import-Zeile wird ein Grabstein mit dem alten Kennzeichen. */
    @Test
    void eineGeloeschteBezugsgroesseHinterlaesstEinenGrabstein() {
        Kunde k = kunde("Grabstein");
        UUID bg = periodenwert(root, k, "BZ-7");
        importFassung1(root, k, "I-2026-0001", "verworfen", null);
        root.update("INSERT INTO bezugsdaten_import_zeile (tenant_id, import_kennung, nr, text, urteil, befunde, bezugsgroesse_id, "
                + "bezugsgroesse_kennzeichen) VALUES (?, 'I-2026-0001', 2, 'KW 40;71.300', 'abgelehnt', '[\"periode_passt_nicht\"]', "
                + "?, 'BZ-7')", k.tenant(), bg);
        assertThat(als(k.tenant(), () -> app.update("DELETE FROM bezugsgroesse WHERE id = ?", bg))).isOne();
        assertThat(root.queryForObject("SELECT bezugsgroesse_id IS NULL AND bezugsgroesse_kennzeichen = 'BZ-7' "
                + "AND text = 'KW 40;71.300' FROM bezugsdaten_import_zeile WHERE tenant_id = ?", Boolean.class, k.tenant())).isTrue();
    }

    @Test
    void dasOffboardingRaeumtDieImporteAb() {
        Kunde k = kunde("Offboarding");
        UUID v = UUID.randomUUID();
        UUID bg = periodenwert(root, k, "BZ-1");
        vorlage(root, k, v, 1);
        root.update(importSql("';'"), k.tenant(), "I-2026-0001", "uebernommen", v, 1);
        ruecknahme(root, k, "I-2026-0001", 2, "ERP-Nachbuchung storniert");
        zeileMitSchluessel(root, k, "I-2026-0001", 2, bg, "neu", "[]");

        new TenantRepository(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW))).offboard(k.tenant());

        for (String tabelle : List.of("bezugsdaten_import_zeile", "bezugsdaten_import", "bezugsdaten_vorlage", "bezugsgroesse",
                "tenant")) {
            String spalte = tabelle.equals("tenant") ? "id" : "tenant_id";
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE " + spalte + " = ?", Long.class,
                    k.tenant())).as(tabelle).isZero();
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

    private static UUID periodenwert(JdbcTemplate db, Kunde k, String kennzeichen) {
        return db.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, "
                + "geltung_art, standort_id) VALUES (?, ?, ?, 'periodenwert', 'kg', 'monat', 'standort', ?) RETURNING id",
                UUID.class, k.tenant(), kennzeichen, "Produktionsmenge " + kennzeichen, k.standort());
    }

    private static int vorlage(JdbcTemplate db, Kunde k, UUID vorlage, int fassung) {
        return db.update("INSERT INTO bezugsdaten_vorlage (tenant_id, vorlage_id, fassung, name, formatregeln, bezug_tabelle, "
                + "actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, ?, 'ERP-Export Spritzguss', "
                + "'{\"deutung\": \"periode\", \"zahlformat\": \"de\"}', '{\"Spritzguss gesamt\": \"BZ-1\"}', 'sub-ik', "
                + "'Ines Kaltenbach', 'energiemanager', 'kunde')", k.tenant(), vorlage, fassung);
    }

    private static String importSql(String trennzeichen) {
        return "INSERT INTO bezugsdaten_import (tenant_id, kennung, fassung, status, datei_name, datei_bytes, datei_sha256, "
                + "kodierung, trennzeichen, kopfzeile, vorlage_id, vorlage_fassung, zeilen, neu, wiederholung, konflikt, "
                + "berichtigung, uebersprungen, abgelehnt, mit_hinweis, aenderungen, befunde, actor_sub, actor_name, "
                + "actor_rolle, actor_art) VALUES (?, ?, 1, ?, 'ERP_Spritzguss_Produktion_2026-10.csv', 77, '" + SHA + "', "
                + "'windows-1252', " + trennzeichen + ", true, ?, ?, 1, 1, 0, 0, 0, 0, 0, 0, 1, '[]', 'sub-ik', "
                + "'Ines Kaltenbach', 'energiemanager', 'kunde')";
    }

    private static int importFassung1(JdbcTemplate db, Kunde k, String kennung, String status, UUID vorlage) {
        return db.update(importSql("';'"), k.tenant(), kennung, status, vorlage, vorlage == null ? null : 1);
    }

    private static int ruecknahme(JdbcTemplate db, Kunde k, String kennung, int fassung, String begruendung) {
        return db.update("INSERT INTO bezugsdaten_import (tenant_id, kennung, fassung, status, begruendung, actor_sub, "
                + "actor_name, actor_rolle, actor_art) VALUES (?, ?, ?, 'zurueckgenommen', ?, 'sub-ik', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde')", k.tenant(), kennung, fassung, begruendung);
    }

    private static int zeile(JdbcTemplate db, Kunde k, String kennung, int nr, String urteil, String befunde, UUID bg) {
        return db.update("INSERT INTO bezugsdaten_import_zeile (tenant_id, import_kennung, nr, text, urteil, befunde, "
                + "bezugsgroesse_id) VALUES (?, ?, ?, 'Zeile', ?, ?::jsonb, ?)", k.tenant(), kennung, nr, urteil, befunde, bg);
    }

    private static int zeileMitSchluessel(JdbcTemplate db, Kunde k, String kennung, int nr, UUID bg, String urteil, String befunde) {
        return db.update("INSERT INTO bezugsdaten_import_zeile (tenant_id, import_kennung, nr, text, urteil, befunde, "
                + "bezugsgroesse_id, bezugsgroesse_kennzeichen, periode_von, periode_bis, zeitzone, betrag, einheit, "
                + "geliefert_wert, geliefert_einheit, fingerabdruck) VALUES (?, ?, ?, '2026-10;Spritzguss gesamt;312.400,0;kg', "
                + "?, ?::jsonb, ?, 'BZ-1', '2026-10-01', '2026-10-31', 'Europe/Berlin', 312400, 'kg', '312.400,0', 'kg', ?)",
                k.tenant(), kennung, nr, urteil, befunde, bg, SHA);
    }

    private static String tabellenrechte(String rolle, String tabelle) {
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

    private static boolean spaltenrecht(String rolle, String tabelle, String spalte, String recht) {
        return Boolean.TRUE.equals(root.queryForObject("SELECT has_column_privilege(?, ?, ?, ?)",
                Boolean.class, rolle, tabelle, spalte, recht));
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
        assertThat((Object) p).as("eine PSQLException: " + t).isNotNull();
        return p;
    }

    private static void abgelehnt(String constraint, Runnable arbeit) {
        PSQLException p = psql(arbeit);
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
