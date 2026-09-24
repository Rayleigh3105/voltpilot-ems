package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.SQLException;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
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
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * AP-17 IP-6: die Datenhaltung der Bezugsbasis (B1, B4, V3, F1) unter der wirklichen App-Rolle. Die Datenbank hält
 * „je Kennzahl höchstens eine laufende Basis“, „keine Fassung außerhalb des Entwurfs ohne Begründung“, die
 * eingefrorene Fassung, Vier-Augen, den Mandantenzaun und die Rechte selbst; die Migration legt nur daneben und
 * trägt auch als späte Ankunft.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsBezugsbasisMigrationTest {

    private static final String DIESE = "20260924071500";
    private static final String APP = "voltpilot_app", ADMIN = "voltpilot_admin", PW = "ip6_test_pw";
    private static final List<String> TABELLEN = List.of("bezugsbasis_kennzeichen_seq", "bezugsbasis",
            "bezugsbasis_fassung", "bezugsbasis_variable", "bezugsbasis_faktor", "bezugsbasis_anstoss",
            "bezugsbasis_aenderung");
    private static final String BEGRUENDUNG = "Erste Energieleistungskennzahl: ein abgeschlossener Monat — vorläufig.";
    /**
     * Migrationen, die auf diesen Tabellen AUFBAUEN (ohne {@code to_regclass}-Wache) — in der späten Ankunft kommen sie
     * MIT dieser, nicht vor ihr.
     */
    private static final List<String> BAUEN_DARAUF_AUF = List.of(
            "20260924223000", // AP-18 IP-5: das Energieziel zitiert eine Bezugsbasis-Fassung.
            "20260924233000", // AP-18 IP-9: die Messgrundlage der Maßnahme zitiert eine Bezugsbasis-Fassung.
            "20260924235130"); // AP-18 IP-14: Vermerk und Abweichung zitieren eine Bezugsbasis-Fassung.

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root, app, admin;
    private static Map<String, String> fingerVorher, fingerNachMigration;
    private static Kunde a, b;

    private record Kunde(UUID tenant, UUID unternehmen, UUID kennzahl, UUID kennzahl2, UUID prozess, UUID bezugsgroesse) {
    }

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway(POSTGRES.getJdbcUrl()).target(letzteFassungVorDieser()).load().migrate();
        a = kunde("Kunststoffwerk Ahrenberg GmbH");
        b = kunde("Kundenbereich B");
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());
        flyway(POSTGRES.getJdbcUrl()).target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        flyway(POSTGRES.getJdbcUrl()).load().migrate();
        app = new JdbcTemplate(new TenantAwareDataSource(ds(POSTGRES.getJdbcUrl(), APP, PW)));
        admin = new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), ADMIN, PW));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ============================================================ B1: eine laufende Basis je Kennzahl

    @Test
    void eineZweiteLaufendeBasisJeKennzahlScheitertAnDerDatenbank() {
        Kunde k = kunde("B1");
        TenantContext.set(k.tenant());
        UUID erste = basis(k, k.kennzahl());
        assertThat(kennzeichen(erste)).isEqualTo("BB-0001");
        sqlFehler("23505", () -> basis(k, k.kennzahl()));
        UUID andere = basis(k, k.kennzahl2());
        assertThat(kennzeichen(andere)).isEqualTo("BB-0002");
        // Beendet, nie gelöscht: danach darf die Kennzahl eine neue laufende Basis tragen.
        sqlFehler("23514", () -> app.update("UPDATE bezugsbasis SET beendet_am = now() WHERE id = ?", erste));
        app.update("UPDATE bezugsbasis SET beendet_zum = DATE '2027-10-31', beendet_am = now(), "
                + "beendet_grund = 'Kennzahl archiviert' WHERE id = ?", erste);
        UUID dritte = basis(k, k.kennzahl());
        assertThat(kennzeichen(dritte)).isEqualTo("BB-0003");
        sqlFehler("42501", () -> app.update("DELETE FROM bezugsbasis WHERE id = ?", erste));
        sqlFehler("23514", () -> app.update("INSERT INTO bezugsbasis(tenant_id,kennzeichen,kennzahl_id,verantwortlich_name,"
                + "actor_sub,actor_name,actor_art) VALUES (?,'KZ-0001',?,'Ines','IK','Ines','kunde')", k.tenant(), k.kennzahl()));
    }

    // ============================================================ F1/A1: Begründung und Anpassungsgründe

    @Test
    void eineFassungOhneBegruendungScheitertAmCheck() {
        Kunde k = kunde("F1");
        TenantContext.set(k.tenant());
        UUID basis = basis(k, k.kennzahl());
        String check = "bezugsbasis_fassung_begruendung_chk";
        checkFehler(check, () -> fassung(basis, 1, freigegeben(null)));
        checkFehler(check, () -> fassung(basis, 1, mit(mit(mit(freigegeben(null), "freigabe_status", "beantragt"),
                "vieraugen", true), "freigegeben_am", null)));
        checkFehler(check, () -> fassung(basis, 1, freigegeben("zu kurz")));
        checkFehler(check, () -> fassung(basis, 1, freigegeben("x".repeat(501))));
        UUID entwurf = fassung(basis, 1, Map.of());
        assertThat(app.queryForObject("SELECT freigabe_status FROM bezugsbasis_fassung WHERE id = ?", String.class, entwurf))
                .isEqualTo("entwurf");
        checkFehler(check, () -> app.update("UPDATE bezugsbasis_fassung SET freigabe_status = 'freigegeben', "
                + "freigegeben_am = now(), freigabe_sub = 'IK', freigabe_name = 'Ines Kaltenbach', freigabe_art = 'kunde', "
                + "freigabe_am = now() WHERE id = ?", entwurf));
        app.update("UPDATE bezugsbasis_fassung SET freigabe_status = 'freigegeben', freigegeben_am = now(), "
                + "freigabe_sub = 'IK', freigabe_name = 'Ines Kaltenbach', freigabe_rolle = 'energiemanager', "
                + "freigabe_art = 'kunde', freigabe_am = now(), begruendung = ? WHERE id = ?", BEGRUENDUNG, entwurf);
        // Fassung 1 nennt keinen Anpassungsgrund, Fassung n + 1 mindestens einen aus A1; `sonstiger` mit Wortlaut.
        sqlFehler("23514", () -> fassung(basis, 1, mit(freigegeben(BEGRUENDUNG), "anpassungsgruende", "{methode_geaendert}")));
        sqlFehler("23514", () -> fassung(basis, 2, freigegeben(BEGRUENDUNG)));
        sqlFehler("23514", () -> fassung(basis, 2, mit(freigegeben(BEGRUENDUNG), "anpassungsgruende", "{neu_erfunden}")));
        sqlFehler("23514", () -> fassung(basis, 2, mit(freigegeben(BEGRUENDUNG), "anpassungsgruende", "{sonstiger}")));
        UUID zwei = fassung(basis, 2, mit(mit(freigegeben(BEGRUENDUNG), "anpassungsgruende",
                "{referenzperiode_vervollstaendigt,methode_geaendert,sonstiger}"), "anpassung_wortlaut", "Messkonzept neu"));
        assertThat(app.queryForObject("SELECT array_length(anpassungsgruende, 1) FROM bezugsbasis_fassung WHERE id = ?",
                Integer.class, zwei)).isEqualTo(3);
        sqlFehler("23514", () -> fassung(basis, 3, mit(mit(freigegeben(BEGRUENDUNG), "anpassungsgruende",
                "{grundlage_korrigiert}"), "referenzperiode", "2026-10/2026-09")));
        sqlFehler("23514", () -> fassung(basis, 3, mit(mit(freigegeben(BEGRUENDUNG), "anpassungsgruende",
                "{grundlage_korrigiert}"), "methode", "modell")));
    }

    // ============================================================ F3/M4, Invariante 3: eingefroren

    @Test
    void eineFreigegebeneFassungIstEingefrorenUndIhrePruefsummeHaeltDieDatenbank() {
        Kunde k = kunde("F3");
        TenantContext.set(k.tenant());
        UUID basis = basis(k, k.kennzahl());
        String grundlage = "[{\"periode\":\"2026-10\",\"zaehler\":{\"objekt\":\"MS-20\",\"wert\":88630,\"version\":1}}]";
        String summe = app.queryForObject("SELECT bericht_pruefsumme(?)", String.class, grundlage);
        sqlFehler("23514", () -> fassung(basis, 1, mit(mit(freigegeben(BEGRUENDUNG), "grundlage", grundlage),
                "pruefsumme", "sha256:" + "0".repeat(64))));
        sqlFehler("23514", () -> fassung(basis, 1, mit(freigegeben(BEGRUENDUNG), "grundlage", grundlage)));
        UUID id = fassung(basis, 1, mit(mit(mit(freigegeben(BEGRUENDUNG), "grundlage", grundlage), "pruefsumme", summe),
                "basiswert", 0.2837));
        assertThat(summe).startsWith("sha256:").hasSize(71);
        for (String aenderung : List.of("basiswert = 0.3", "grundlage = '[]', pruefsumme = bericht_pruefsumme('[]')",
                "methode = 'gradtage'", "gilt_ab = DATE '2026-12-01'", "freigabe_status = 'abgelehnt'",
                "freigegeben_am = now() - interval '1 day'")) {
            sqlFehler("23514", () -> app.update("UPDATE bezugsbasis_fassung SET " + aenderung + " WHERE id = ?", id));
        }
        sqlFehler("42501", () -> app.update("UPDATE bezugsbasis_fassung SET fassung = 7 WHERE id = ?", id));
        // Erlaubt: das Ende (F4), einmal.
        app.update("UPDATE bezugsbasis_fassung SET gilt_bis = DATE '2027-10-31', beendet_am = now(), "
                + "beendet_grund = 'Fassung 2 gilt ab 01.11.2027' WHERE id = ?", id);
        sqlFehler("23514", () -> app.update("UPDATE bezugsbasis_fassung SET gilt_bis = DATE '2027-12-31' WHERE id = ?", id));
        // Variablen und Faktoren einer freigegebenen Fassung bleiben stehen.
        UUID v = app.queryForObject("INSERT INTO bezugsbasis_variable(tenant_id,fassung_id,position,bezugsgroesse_id,"
                + "bezugsgroesse_fassung) VALUES (?,?,1,?,1) RETURNING id", UUID.class, k.tenant(), id, k.bezugsgroesse());
        sqlFehler("23514", () -> app.update("UPDATE bezugsbasis_variable SET aufgehoben_am = now() WHERE id = ?", v));
        sqlFehler("42501", () -> app.update("DELETE FROM bezugsbasis_variable WHERE id = ?", v));
        assertThat(app.queryForObject("SELECT pruefsumme FROM bezugsbasis_fassung WHERE id = ?", String.class, id))
                .isEqualTo(summe);
    }

    // ============================================================ F2: Vier-Augen

    @Test
    void beiVierAugenBestaetigtNieDerUrheber() {
        Kunde k = kunde("F2");
        TenantContext.set(k.tenant());
        UUID basis = basis(k, k.kennzahl());
        sqlFehler("23514", () -> fassung(basis, 1, mit(freigegeben(BEGRUENDUNG), "freigabe_status", "beantragt")));
        UUID antrag = fassung(basis, 1, mit(mit(mit(freigegeben(BEGRUENDUNG), "freigabe_status", "beantragt"),
                "vieraugen", true), "freigegeben_am", null));
        String bestaetigen = "UPDATE bezugsbasis_fassung SET freigabe_status = 'freigegeben', freigegeben_am = now(), "
                + "entscheidung_sub = ?, entscheidung_name = ?, entscheidung_rolle = ?, entscheidung_art = 'kunde', "
                + "entschieden_am = now() WHERE id = ?";
        sqlFehler("23514", () -> app.update(bestaetigen, "IK", "Ines Kaltenbach", "energiemanager", antrag));
        sqlFehler("23514", () -> app.update(bestaetigen, "PH", "Peter Hollerbach", "bearbeiter", antrag));
        sqlFehler("23514", () -> app.update("UPDATE bezugsbasis_fassung SET freigabe_status = 'abgelehnt', entscheidung_sub = 'JW', "
                + "entscheidung_name = 'Jonas Wendlinger', entscheidung_rolle = 'kundenadministrator', entscheidung_art = 'kunde', "
                + "entschieden_am = now() WHERE id = ?", antrag));
        // Höchstens ein offener Antrag je Basis.
        sqlFehler("23505", () -> fassung(basis, 2, Map.of()));
        app.update(bestaetigen, "JW", "Jonas Wendlinger", "kundenadministrator", antrag);
        assertThat(app.queryForObject("SELECT freigabe_status FROM bezugsbasis_fassung WHERE id = ?", String.class, antrag))
                .isEqualTo("freigegeben");
    }

    // ============================================================ V3/V5: Variablen und Faktoren

    @Test
    void variablenHoechstensZweiUndFaktorenGenauVerweisOderWortlaut() {
        Kunde k = kunde("V3");
        TenantContext.set(k.tenant());
        UUID entwurf = fassung(basis(k, k.kennzahl()), 1, Map.of());
        String variable = "INSERT INTO bezugsbasis_variable(tenant_id,fassung_id,position,bezugsgroesse_id,spannweite_von,"
                + "spannweite_bis) VALUES (?,?,?,?,?,?)";
        sqlFehler("23514", () -> app.update(variable, k.tenant(), entwurf, 3, k.bezugsgroesse(), null, null));
        sqlFehler("23514", () -> app.update(variable, k.tenant(), entwurf, 1, k.bezugsgroesse(), 341000, 254000));
        app.update(variable, k.tenant(), entwurf, 1, k.bezugsgroesse(), 254000, 341000);
        sqlFehler("23505", () -> app.update(variable, k.tenant(), entwurf, 2, k.bezugsgroesse(), null, null));
        String faktor = "INSERT INTO bezugsbasis_faktor(tenant_id,fassung_id,position,art,verweis,wortlaut,wert,einheit) "
                + "VALUES (?,?,?,?,?,?,?,?)";
        sqlFehler("23514", () -> app.update(faktor, k.tenant(), entwurf, 1, "wortlaut", null, " ", null, null));
        sqlFehler("23514", () -> app.update(faktor, k.tenant(), entwurf, 1, "prozess", k.prozess(), "beides", null, null));
        sqlFehler("23514", () -> app.update(faktor, k.tenant(), entwurf, 1, "maschine", k.prozess(), null, null, null));
        sqlFehler("23503", () -> app.update(faktor, k.tenant(), entwurf, 1, "prozess", UUID.randomUUID(), null, null, null));
        sqlFehler("23503", () -> app.update(faktor, k.tenant(), entwurf, 1, "prozess", a.prozess(), null, null, null));
        app.update(faktor, k.tenant(), entwurf, 1, "prozess", k.prozess(), null, 3100, "m²");
        app.update(faktor, k.tenant(), entwurf, 2, "wortlaut", null, "Zwei Schichten, fünf Tage", null, null);
        // Im Entwurf darf ein Teil aufgehoben werden — einmal.
        app.update("UPDATE bezugsbasis_faktor SET aufgehoben_am = now() WHERE fassung_id = ? AND position = 2", entwurf);
        sqlFehler("23514", () -> app.update("UPDATE bezugsbasis_faktor SET aufgehoben_am = now() WHERE fassung_id = ? "
                + "AND position = 2", entwurf));
    }

    @Test
    void einAnstossStehtJeAnlassEinmalUndEinePersonAntwortet() {
        Kunde k = kunde("A2");
        TenantContext.set(k.tenant());
        UUID f = fassung(basis(k, k.kennzahl()), 1, freigegeben(BEGRUENDUNG));
        String anstoss = "INSERT INTO bezugsbasis_anstoss(tenant_id,fassung_id,pfad,art,anlass_kennung,anlass) "
                + "VALUES (?,?,?,?,?,?) RETURNING id";
        sqlFehler("23514", () -> app.queryForObject(anstoss, UUID.class, k.tenant(), f, 1, "methode_geaendert", "K-2026-0007", null));
        UUID id = app.queryForObject(anstoss, UUID.class, k.tenant(), f, 1, "grundlage_korrigiert", "K-2026-0007",
                "K-2026-0007 (freigegeben 12.11.2026): KZ-0001 Version 2 = 0,1473");
        sqlFehler("23505", () -> app.queryForObject(anstoss, UUID.class, k.tenant(), f, 1, "grundlage_korrigiert", "K-2026-0007", null));
        sqlFehler("23514", () -> app.update("UPDATE bezugsbasis_anstoss SET antwort = 'bleibt', beantwortet_am = now(), "
                + "beantwortet_sub = 'IK', beantwortet_name = 'Ines Kaltenbach' WHERE id = ?", id));
        app.update("UPDATE bezugsbasis_anstoss SET antwort = 'neue_fassung', beantwortet_am = now(), "
                + "beantwortet_sub = 'IK', beantwortet_name = 'Ines Kaltenbach' WHERE id = ?", id);
        sqlFehler("42501", () -> app.update("UPDATE bezugsbasis_anstoss SET art = 'struktur_geaendert' WHERE id = ?", id));
        sqlFehler("42501", () -> app.update("DELETE FROM bezugsbasis_anstoss WHERE id = ?", id));
    }

    // ============================================================ Zaun und Rechte

    @Test
    void derMandantenzaunHaeltMandantASiehtBNicht() {
        TenantContext.set(b.tenant());
        UUID basisB = basis(b, b.kennzahl());
        UUID fassungB = fassung(basisB, 1, freigegeben(BEGRUENDUNG));
        protokoll(b, basisB);
        TenantContext.set(a.tenant());
        for (String t : TABELLEN) {
            assertThat(app.queryForObject("SELECT count(*) FROM " + t + " WHERE tenant_id = ?", Integer.class, b.tenant()))
                    .as(t).isZero();
        }
        assertThat(app.queryForObject("SELECT count(*) FROM bezugsbasis WHERE id = ?", Integer.class, basisB)).isZero();
        assertThat(app.update("UPDATE bezugsbasis SET zweck = 'fremd' WHERE id = ?", basisB)).isZero();
        // Fremde Zeilen einschleusen: RLS-Prüfung bzw. der Mandant reist im Verweis mit.
        sqlFehler("42501", () -> basis(b, b.kennzahl2()));
        sqlFehler("23503", () -> basis(a, b.kennzahl2()));
        sqlFehler("23503", () -> app.update("INSERT INTO bezugsbasis_variable(tenant_id,fassung_id,position,bezugsgroesse_id) "
                + "VALUES (?,?,1,?)", a.tenant(), fassungB, a.bezugsgroesse()));
        TenantContext.clear();
        assertThat(app.queryForObject("SELECT count(*) FROM bezugsbasis", Integer.class)).isZero();
    }

    @Test
    void dieRechteSindBeschnittenUndStehenInDerMatrix() throws IOException {
        for (String t : TABELLEN) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = ?::regclass",
                    Boolean.class, t)).as(t + " RLS + FORCE").isTrue();
            assertThat(root.queryForObject("SELECT has_table_privilege(?, ?, 'SELECT') AND has_table_privilege(?, ?, 'INSERT')",
                    Boolean.class, APP, t, APP, t)).as(t).isTrue();
            assertThat(root.queryForObject("SELECT has_table_privilege(?, ?, 'DELETE') OR has_table_privilege(?, ?, 'TRUNCATE')",
                    Boolean.class, APP, t, APP, t)).as(t + " kein DELETE").isFalse();
            assertThat(root.queryForObject("SELECT has_table_privilege(?, ?, 'DELETE')", Boolean.class, ADMIN, t))
                    .as(t + " Offboarding").isTrue();
        }
        for (String[] spalte : new String[][] {{"bezugsbasis", "kennzahl_id"}, {"bezugsbasis", "kennzeichen"},
                {"bezugsbasis", "tenant_id"}, {"bezugsbasis_fassung", "bezugsbasis_id"}, {"bezugsbasis_fassung", "fassung"},
                {"bezugsbasis_fassung", "actor_sub"}, {"bezugsbasis_variable", "bezugsgroesse_id"},
                {"bezugsbasis_faktor", "wert"}, {"bezugsbasis_anstoss", "anlass_kennung"}}) {
            assertThat(root.queryForObject("SELECT has_column_privilege(?, ?, ?, 'UPDATE')", Boolean.class,
                    APP, spalte[0], spalte[1])).as(spalte[0] + "." + spalte[1]).isFalse();
        }
        assertThat(root.queryForObject("SELECT has_table_privilege(?, 'bezugsbasis_aenderung', 'UPDATE')", Boolean.class, APP))
                .isFalse();
        assertThat(root.queryForObject("SELECT has_sequence_privilege(?, 'bezugsbasis_aenderung_id_seq', 'USAGE')",
                Boolean.class, APP)).isTrue();
        // Rechte-Nachtrag §6.1: verwalten KA U · EM U · BE S, freigeben KA U · EM U, ansehen … · US A.
        JsonNode matrix = new ObjectMapper().readTree(Path.of("../../docs/contracts/v2/rechte-matrix.json").toFile());
        Map<String, String> zellen = new LinkedHashMap<>();
        matrix.path("aktionen").forEach(r -> {
            if (r.path("kennung").asText().startsWith("bezugsbasis.")) {
                StringBuilder s = new StringBuilder();
                r.path("zellen").fields().forEachRemaining(z -> s.append(z.getValue().asText()));
                zellen.put(r.path("kennung").asText(), s.toString());
            }
        });
        assertThat(zellen).containsExactly(Map.entry("bezugsbasis.verwalten", "UUS----"),
                Map.entry("bezugsbasis.freigeben", "UU-----"), Map.entry("bezugsbasis.ansehen", "UUSSSA-"));
    }

    /** Jede Liste des Vertrags (IP-2) steht Zeile für Zeile in der Datenbank; `freigabe_status` ist die Vereinigung. */
    @Test
    void dieVokabulareDerDatenbankSindDieDesVertrags() throws IOException {
        JsonNode vertrag = new ObjectMapper().readTree(Path.of("../../docs/contracts/v2/bezugsbasis-vectors.json").toFile())
                .path("vokabulare");
        for (String block : List.of("methode", "urteil", "grund", "datenlage", "anpassungsgrund", "faktor_art")) {
            List<String> woerter = new java.util.ArrayList<>();
            vertrag.path(block).forEach(w -> woerter.add(w.asText()));
            assertThat(woerter).as(block).isNotEmpty();
            assertThat(root.queryForList("SELECT wort FROM bezugsbasis_vokabular() WHERE vokabular = ? ORDER BY nr",
                    String.class, block)).as(block).containsExactlyElementsOf(woerter);
        }
        List<String> status = new java.util.ArrayList<>(List.of("entwurf"));
        vertrag.path("freigabe_status").forEach(w -> status.add(w.asText()));
        assertThat(root.queryForList("SELECT wort FROM bezugsbasis_vokabular() WHERE vokabular = 'freigabe_status' "
                + "ORDER BY nr", String.class)).containsExactlyElementsOf(status);
        // Die vier Namen aus §6.1 lesen dieselbe Stelle.
        for (String[] f : new String[][] {{"bezugsbasis_methode", "methode"}, {"bezugsbasis_anpassungsgrund", "anpassungsgrund"},
                {"bezugsbasis_urteil", "urteil"}, {"bezugsbasis_grund", "grund"}}) {
            assertThat(root.queryForList("SELECT * FROM " + f[0] + "()", String.class)).as(f[0])
                    .containsExactlyElementsOf(root.queryForList("SELECT wort FROM bezugsbasis_vokabular() "
                            + "WHERE vokabular = ? ORDER BY nr", String.class, f[1]));
        }
    }

    @Test
    void dasOffboardingRaeumtAlleTabellenVorKennzahlUndBenutzerAb() {
        Kunde k = kunde("Offboarding");
        TenantContext.set(k.tenant());
        UUID basis = basis(k, k.kennzahl());
        UUID f = fassung(basis, 1, freigegeben(BEGRUENDUNG));
        app.update("INSERT INTO bezugsbasis_variable(tenant_id,fassung_id,position,bezugsgroesse_id) VALUES (?,?,1,?)",
                k.tenant(), f, k.bezugsgroesse());
        app.update("INSERT INTO bezugsbasis_faktor(tenant_id,fassung_id,position,art,verweis) VALUES (?,?,1,'prozess',?)",
                k.tenant(), f, k.prozess());
        app.update("INSERT INTO bezugsbasis_anstoss(tenant_id,fassung_id,pfad,art,anlass_kennung) "
                + "VALUES (?,?,2,'struktur_geaendert','flaeche G-2')", k.tenant(), f);
        protokoll(k, basis);
        TenantContext.clear();
        new TenantRepository(admin).offboard(k.tenant());
        for (String t : TABELLEN) {
            assertThat(root.queryForObject("SELECT count(*) FROM " + t + " WHERE tenant_id = ?", Integer.class, k.tenant()))
                    .as(t).isZero();
        }
        assertThat(root.queryForObject("SELECT count(*) FROM tenant WHERE id = ?", Integer.class, k.tenant())).isZero();
    }

    // ============================================================ Bestand und Reihenfolge

    @Test
    void dieMigrationLegtNurDanebenUndLaesstDenBestandZeichengleich() {
        assertThat(fingerVorher).hasSizeGreaterThan(100).doesNotContainKeys(TABELLEN.toArray(String[]::new));
        assertThat(fingerVorher.get("kennzahl")).as("es gibt Bestand").isNotEqualTo(Bestandsschutz.LEER);
        assertThat(fingerVorher.get("benutzer")).as("es gibt Bestand").isNotEqualTo(Bestandsschutz.LEER);
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
        for (String tabelle : TABELLEN) {
            assertThat(fingerNachMigration).as(tabelle).containsEntry(tabelle, Bestandsschutz.LEER);
        }
    }

    @Test
    void derBestandsvergleichFaengtEineGeaenderteZeile() {
        Bestandsschutz.mutationsprobe(root, List.of(), "unternehmen", "UPDATE unternehmen SET name = name || ' (Probe)'");
    }

    /** Out-of-order: auf einer Datenbank mit ALLEN anderen Migrationen kommt diese zuletzt an und trägt genauso. */
    @Test
    void dieMigrationTraegtAuchAlsSpaeteAnkunft() throws IOException {
        root.execute("CREATE DATABASE voltpilot_spaet");
        String url = POSTGRES.getJdbcUrl().replace("/voltpilot?", "/voltpilot_spaet?");
        Path ohneDiese = Files.createTempDirectory("ohne-bezugsbasis");
        try (var dateien = Files.list(Path.of("src", "main", "resources", "db", "migration"))) {
            for (Path datei : dateien.toList()) {
                String name = datei.getFileName().toString();
                if (!name.startsWith("V" + DIESE + "__")
                        && BAUEN_DARAUF_AUF.stream().noneMatch(v -> name.startsWith("V" + v + "__"))) {
                    Files.copy(datei, ohneDiese.resolve(datei.getFileName()));
                }
            }
        }
        flyway(url).locations("filesystem:" + ohneDiese).load().migrate();
        var spaet = flyway(url).outOfOrder(true).load().migrate();
        List<String> spaeteAnkunft = new java.util.ArrayList<>(List.of(DIESE));
        spaeteAnkunft.addAll(BAUEN_DARAUF_AUF);
        assertThat(spaet.migrations).extracting(m -> m.version).containsExactlyElementsOf(spaeteAnkunft);
        JdbcTemplate spaetDb = new JdbcTemplate(ds(url, POSTGRES.getUsername(), POSTGRES.getPassword()));
        String schema = "SELECT string_agg(conrelid::regclass || ':' || conname || ':' || pg_get_constraintdef(oid), '|' "
                + "ORDER BY conrelid::regclass::text, conname) FROM pg_constraint WHERE conrelid::regclass::text LIKE 'bezugsbasis%'";
        assertThat(spaetDb.queryForObject(schema, String.class)).isEqualTo(root.queryForObject(schema, String.class));
    }

    // ============================================================ Gerüst

    private static Kunde kunde(String name) {
        UUID tenant = root.queryForObject("INSERT INTO tenant(name) VALUES (?) RETURNING id", UUID.class, name);
        UUID unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name) VALUES (?,?) RETURNING id",
                UUID.class, tenant, name);
        for (String[] p : new String[][] {{"IK", "Ines Kaltenbach"}, {"JW", "Jonas Wendlinger"}, {"PH", "Peter Hollerbach"}}) {
            root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,?,'benutzer',?,'aktiv')",
                    tenant, p[0], p[1]);
        }
        UUID prozess = root.queryForObject("INSERT INTO prozess(tenant_id,unternehmen_id,kennzeichen,name,gueltig_ab) "
                + "VALUES (?,?,'P-1','Spritzguss','2026-01-01') RETURNING id", UUID.class, tenant, unternehmen);
        UUID bezug = root.queryForObject("INSERT INTO bezugsgroesse(tenant_id,kennzeichen,name,wertart,einheit,periode_art,"
                + "geltung_art,unternehmen_id) VALUES (?,'BZ-1','Produktionsmenge','periodenwert','kg','monat','unternehmen',?) "
                + "RETURNING id", UUID.class, tenant, unternehmen);
        return new Kunde(tenant, unternehmen, kennzahl(tenant, unternehmen, "KZ-0004"), kennzahl(tenant, unternehmen, "KZ-0001"),
                prozess, bezug);
    }

    private static UUID kennzahl(UUID tenant, UUID unternehmen, String kennzeichen) {
        return root.queryForObject("INSERT INTO kennzahl(tenant_id,kennzeichen,name,rechenform,geltung_art,unternehmen_id,"
                + "verantwortlich_sub,verantwortlich_name) VALUES (?,?,?,'quotient','unternehmen',?,'IK','Ines Kaltenbach') "
                + "RETURNING id", UUID.class, tenant, kennzeichen, kennzeichen, unternehmen);
    }

    private static UUID basis(Kunde k, UUID kennzahl) {
        return app.queryForObject("INSERT INTO bezugsbasis(tenant_id,kennzahl_id,zweck,verantwortlich_sub,verantwortlich_name,"
                + "verantwortlich_konto,actor_sub,actor_name,actor_rolle,actor_art) VALUES (?,?,'Spritzguss je kg',"
                + "'IK','Ines Kaltenbach','benutzer','IK','Ines Kaltenbach','energiemanager','kunde') RETURNING id",
                UUID.class, k.tenant(), kennzahl);
    }

    private static String kennzeichen(UUID basis) {
        return app.queryForObject("SELECT kennzeichen FROM bezugsbasis WHERE id = ?", String.class, basis);
    }

    /** Eine Fassung aus Vorgaben (Referenzperiode Oktober 2026, Verhältnis, vorläufig) und den genannten Spalten. */
    private static UUID fassung(UUID basis, int nummer, Map<String, Object> spalten) {
        Map<String, Object> werte = new LinkedHashMap<>();
        werte.put("tenant_id", TenantContext.get());
        werte.put("bezugsbasis_id", basis);
        werte.put("fassung", nummer);
        werte.put("referenzperiode", "2026-10/2026-10");
        werte.put("methode", "verhaeltnis");
        werte.put("datenlage", "vorlaeufig");
        werte.put("gilt_ab", java.sql.Date.valueOf("2026-11-01"));
        werte.put("actor_sub", "IK");
        werte.put("actor_name", "Ines Kaltenbach");
        werte.put("actor_rolle", "energiemanager");
        werte.put("actor_art", "kunde");
        werte.putAll(spalten);
        String sql = "INSERT INTO bezugsbasis_fassung(" + String.join(",", werte.keySet()) + ") VALUES ("
                + String.join(",", werte.keySet().stream().map(s -> s.equals("anpassungsgruende") ? "?::text[]"
                        : s.equals("koeffizienten") ? "?::jsonb" : "?").toList()) + ") RETURNING id";
        return app.queryForObject(sql, UUID.class, werte.values().toArray());
    }

    /** Freigegeben ohne Vier-Augen, von Ines, mit dieser Begründung. */
    private static Map<String, Object> freigegeben(String begruendung) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("freigabe_status", "freigegeben");
        m.put("freigabe_sub", "IK");
        m.put("freigabe_name", "Ines Kaltenbach");
        m.put("freigabe_rolle", "energiemanager");
        m.put("freigabe_art", "kunde");
        m.put("freigabe_am", java.sql.Timestamp.valueOf("2026-11-12 10:00:00"));
        m.put("freigegeben_am", java.sql.Timestamp.valueOf("2026-11-12 10:00:00"));
        m.put("begruendung", begruendung);
        return m;
    }

    private static Map<String, Object> mit(Map<String, Object> m, String spalte, Object wert) {
        Map<String, Object> neu = new LinkedHashMap<>(m);
        neu.put(spalte, wert);
        return neu;
    }

    private static void protokoll(Kunde k, UUID basis) {
        app.update("INSERT INTO bezugsbasis_aenderung(tenant_id,bezugsbasis_id,fassung,art,neu,actor_sub,actor_name,actor_art) "
                + "VALUES (?,?,1,'fassung_freigegeben','{}'::jsonb,'IK','Ines Kaltenbach','kunde')", k.tenant(), basis);
        sqlFehler("23514", () -> app.update("INSERT INTO bezugsbasis_aenderung(tenant_id,bezugsbasis_id,art,actor_sub,actor_name,"
                + "actor_art) VALUES (?,?,'erfunden','IK','Ines Kaltenbach','kunde')", k.tenant(), basis));
        sqlFehler("42501", () -> app.update("UPDATE bezugsbasis_aenderung SET neu = NULL WHERE bezugsbasis_id = ?", basis));
    }

    private static void sqlFehler(String state, Runnable aktion) {
        Throwable fehler = catchThrowable(aktion::run);
        assertThat(fehler).as("erwartet SQLSTATE " + state).isInstanceOf(DataAccessException.class);
        Throwable ursache = ((DataAccessException) fehler).getMostSpecificCause();
        assertThat(ursache).isInstanceOf(SQLException.class);
        assertThat(((SQLException) ursache).getSQLState()).as(ursache.getMessage()).isEqualTo(state);
    }

    private static void checkFehler(String constraint, Runnable aktion) {
        Throwable fehler = catchThrowable(aktion::run);
        assertThat(fehler).as("erwartet CHECK " + constraint).isInstanceOf(DataAccessException.class);
        Throwable ursache = ((DataAccessException) fehler).getMostSpecificCause();
        assertThat(((SQLException) ursache).getSQLState()).isEqualTo("23514");
        assertThat(ursache.getMessage()).contains(constraint);
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
                .placeholders(Map.of("appDbUser", APP, "appDbPassword", PW, "adminDbUser", ADMIN, "adminDbPassword", PW));
    }

    private static DataSource ds(String url, String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(url);
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
