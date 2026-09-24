package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Date;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
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
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * AP-19 IP-5: die Datenhaltung des Energiemanagements — Grundlage und Dokument (G3, G5, DK1–DK8, PA1, PA2, RE1, RE2)
 * unter der wirklichen App-Rolle. Die Datenbank hält „jede Art aus der geschlossenen Liste“, „Wortlaut oder Verweis mit
 * Ablage, ganz oder gar nicht“, „ab der Freigabe unveränderlich“, „entschieden von“ (bei den Leitungs-Arten die
 * Leitung am Tag), Vier-Augen, die einmaligen Übergänge, den Kennzeichen-Zähler (D-0001 ohne Jahr), den Mandanten-
 * und den Standort-Zaun und die Rechte selbst; die Migration legt nur daneben und trägt auch als späte Ankunft.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsEnergiemanagementMigrationTest {

    private static final String DIESE = "20260925013500";
    private static final String APP = "voltpilot_app", ADMIN = "voltpilot_admin", PW = "ap19_ip5_test_pw";
    private static final List<String> TABELLEN = List.of("energiemanagement_kennung_seq", "energiemanagement_einstellung",
            "energiemanagement_person", "energiemanagement_aufgabe", "energiemanagement_dokument",
            "energiemanagement_dokument_fassung", "energiemanagement_anwendungsbereich",
            "energiemanagement_dokument_eintrag", "energiemanagement_aenderung");
    private static final String BEGRUENDUNG = "Beschluss der Geschäftsführung vom 15.12.2026, unterschrieben.";
    private static final String POLITIK = "Die Kunststoffwerk Ahrenberg GmbH verpflichtet sich, ihre energiebezogene "
            + "Leistung fortlaufend zu verbessern.";
    /** Spätere Migrationen, die auf diese aufbauen: sie reisen bei der späten Ankunft mit. */
    private static final List<String> BAUEN_DARAUF_AUF = List.of(
            "20260925031500"); // AP-19 IP-16: Audit und Feststellung nennen Person, Fassung und Zähler; weitet das Protokoll.

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root, app, admin;
    private static Map<String, String> fingerVorher, fingerNachMigration;
    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** Ein Kundenbereich mit zwei Standorten und den Konten IK, JW, PH. */
    private record Kunde(UUID tenant, UUID unternehmen, UUID st1, UUID st2) {
    }

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway(POSTGRES.getJdbcUrl()).target(letzteFassungVorDieser()).load().migrate();
        TenantContext.clear();
        kunde("Kunststoffwerk Ahrenberg GmbH");
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

    // ============================================================ G5: die geschlossene Liste der Arten

    @Test
    void eineArtAusserhalbDerListeScheitertAmCheck() {
        Kunde k = kunde("Arten");
        TenantContext.set(k.tenant());
        checkFehler("energiemanagement_dokument_art_chk", () -> dokument(k, "sonstiges", "unternehmen", null));
        checkFehler("energiemanagement_dokument_art_chk", () -> dokument(k, "Energiepolitik", "unternehmen", null));
        // Der Bezug nennt genau seinen Verweis: am Standort mit Standort, am Unternehmen ohne.
        checkFehler("energiemanagement_dokument_bezug_chk", () -> dokument(k, "betrieb", "standort", null));
        checkFehler("energiemanagement_dokument_bezug_chk", () -> dokument(k, "betrieb", "unternehmen", k.st1()));
        checkFehler("energiemanagement_dokument_bezug_chk", () -> dokument(k, "betrieb", "abteilung", null));
        for (String art : List.of("energiepolitik", "anwendungsbereich", "kontext", "rechtliche_anforderungen",
                "risiken_chancen", "bestellung", "verfahren", "betrieb", "beschaffung", "kommunikation", "auslegung",
                "kompetenz")) {
            dokument(k, art, "unternehmen", null);
        }
        assertThat(app.queryForObject("SELECT count(*) FROM energiemanagement_dokument", Integer.class)).isEqualTo(12);
    }

    // ============================================================ G3/DK2: Wortlaut oder Verweis, Prüfsumme

    @Test
    void eineFassungOhneWortlautUndOhneAblageScheitert() {
        Kunde k = kunde("Form");
        TenantContext.set(k.tenant());
        UUID dok = dokument(k, "betrieb", "standort", k.st1());
        String fassung = "INSERT INTO energiemanagement_dokument_fassung(tenant_id,dokument_id,form,wortlaut,verweis_ablage,"
                + "verweis_kennung,actor_sub,actor_name,actor_rolle,actor_art) VALUES (?,?,?,?,?,?,'IK','Ines Kaltenbach',"
                + "'energiemanager','kunde')";
        // Weder Wortlaut noch Ablage — in beiden Formen.
        checkFehler("energiemanagement_fassung_form_chk", () -> app.update(fassung, k.tenant(), dok, "wortlaut", null, null,
                null));
        checkFehler("energiemanagement_fassung_form_chk", () -> app.update(fassung, k.tenant(), dok, "verweis", null, null,
                "IH-SG-01"));
        // Beides zugleich, ein Wortlaut über 20 000 Zeichen, eine Form außerhalb der Liste (eine Datei gibt es nicht).
        checkFehler("energiemanagement_fassung_form_chk", () -> app.update(fassung, k.tenant(), dok, "wortlaut", "Text",
                "Instandhaltungssystem", "IH-SG-01"));
        checkFehler("energiemanagement_fassung_form_chk", () -> app.update(fassung, k.tenant(), dok, "wortlaut",
                "x".repeat(20_001), null, null));
        checkFehler("energiemanagement_fassung_form_chk", () -> app.update(fassung, k.tenant(), dok, "datei", "Text", null,
                null));
        assertThat(app.queryForObject("SELECT count(*) FROM energiemanagement_dokument_fassung", Integer.class)).isZero();
    }

    /** Vertrag §6: die Kopien D-0001/1 (Wortlaut) und D-0004/1 (Verweis) tragen in der Datenbank die Prüfsumme des Vertrags. */
    @Test
    void dieKopieEinerFassungTraegtDiePruefsummeDesVertrags() throws IOException {
        Kunde k = kunde("Kopie");
        TenantContext.set(k.tenant());
        Map<String, JsonNode> faelle = new LinkedHashMap<>();
        for (JsonNode c : MAPPER.readTree(Path.of("../../docs/contracts/v2/energiemanagement-vectors.json").toFile())
                .path("cases")) {
            if (c.path("operation").asText().equals("pruefsumme") && c.path("name").asText().contains("Fassung 1")) {
                faelle.put(c.path("eingang").path("kopie").path("form").asText() + ":"
                        + c.path("name").asText().substring(3, 9), c);
            }
        }
        assertThat(faelle).containsKeys("wortlaut:D-0001", "verweis:D-0004");
        JsonNode d1 = faelle.get("wortlaut:D-0001");
        UUID politik = dokument(k, "energiepolitik", "unternehmen", null);
        String kopie1 = d1.path("erwartet").path("kanonisch").asText();
        UUID f1 = app.queryForObject("INSERT INTO energiemanagement_dokument_fassung(tenant_id,dokument_id,form,wortlaut,kopie,"
                + "pruefsumme,actor_sub,actor_name,actor_art) VALUES (?,?,'wortlaut',?,?,bericht_pruefsumme(?),'IK',"
                + "'Ines Kaltenbach','kunde') RETURNING id", UUID.class, k.tenant(), politik,
                d1.path("eingang").path("kopie").path("wortlaut").asText(), kopie1, kopie1);
        assertThat(app.queryForObject("SELECT pruefsumme FROM energiemanagement_dokument_fassung WHERE id = ?", String.class,
                f1)).isEqualTo(d1.path("erwartet").path("pruefsumme").asText()).startsWith("sha256:163ae836");
        JsonNode d4 = faelle.get("verweis:D-0004");
        JsonNode v = d4.path("eingang").path("kopie").path("verweis");
        UUID betrieb = dokument(k, "betrieb", "standort", k.st1());
        String kopie4 = d4.path("erwartet").path("kanonisch").asText();
        UUID f4 = app.queryForObject("INSERT INTO energiemanagement_dokument_fassung(tenant_id,dokument_id,form,"
                + "verweis_bezeichnung,verweis_ablage,verweis_kennung,verweis_adresse,verweis_fassungsangabe,verweis_datum,"
                + "verweis_sha256,kopie,pruefsumme,actor_sub,actor_name,actor_art) VALUES (?,?,'verweis',?,?,?,?,?,?::date,?,?,"
                + "bericht_pruefsumme(?),'IK','Ines Kaltenbach','kunde') RETURNING id", UUID.class, k.tenant(), betrieb,
                v.path("bezeichnung").asText(), v.path("ablage").asText(), v.path("kennung").asText(),
                v.path("adresse").asText(), v.path("fassungsangabe").asText(), v.path("datum").asText(),
                v.path("sha256").asText(), kopie4, kopie4);
        assertThat(app.queryForObject("SELECT pruefsumme FROM energiemanagement_dokument_fassung WHERE id = ?", String.class,
                f4)).isEqualTo(d4.path("erwartet").path("pruefsumme").asText()).startsWith("sha256:bd330fe4");
        // Eine Prüfsumme, die nicht die der Kopie ist, und eine Kopie, die nicht zu den Spalten passt, hält sie nicht.
        String andereKopie = kopie1.replace("\"nr\":1", "\"nr\":2");
        UUID kontext = dokument(k, "kontext", "unternehmen", null);
        String insert = "INSERT INTO energiemanagement_dokument_fassung(tenant_id,dokument_id,form,wortlaut,kopie,pruefsumme,"
                + "actor_sub,actor_name,actor_art) VALUES (?,?,'wortlaut',?,?,?,'IK','Ines Kaltenbach','kunde')";
        String wortlaut = d1.path("eingang").path("kopie").path("wortlaut").asText();
        checkFehler("energiemanagement_fassung_pruefsumme_chk", () -> app.update(insert, k.tenant(), kontext, wortlaut, kopie1,
                "sha256:00"));
        checkFehler("energiemanagement_fassung_kopie_chk", () -> app.update(insert, k.tenant(), kontext, wortlaut, andereKopie,
                root.queryForObject("SELECT bericht_pruefsumme(?)", String.class, andereKopie)));
        checkFehler("energiemanagement_fassung_kopie_chk", () -> app.update(insert, k.tenant(), kontext, wortlaut + " anders",
                kopie1, d1.path("erwartet").path("pruefsumme").asText()));
    }

    // ============================================================ DK2–DK4: Freigabe, unveränderlich, Nr. n

    @Test
    void eineFreigegebeneFassungLaesstSichNichtAendern() {
        Kunde k = kunde("Unveränderlich");
        TenantContext.set(k.tenant());
        UUID rf = person(k, "Robert Falk", "Geschäftsführer", null);
        leitung(k, rf, "2026-09-28");
        UUID dok = dokument(k, "energiepolitik", "unternehmen", null);
        UUID f1 = fassung(k, dok, POLITIK, null);
        checkFehler("energiemanagement_dokument_uebergang_einmalig", () -> app.update(
                "UPDATE energiemanagement_dokument SET zustand = 'gueltig' WHERE id = ?", dok));
        // Im Entwurf ist die Fassung änderbar (mit neuer Prüfsumme).
        assertThat(app.update("UPDATE energiemanagement_dokument_fassung SET wortlaut = ? WHERE id = ?", POLITIK + " Entwurf 2.",
                f1)).isOne();
        // Ohne Kopie verlässt keine Fassung den Entwurf.
        checkFehler("energiemanagement_fassung_kopie_chk", () -> app.update("UPDATE energiemanagement_dokument_fassung SET "
                + "freigabe_status = 'freigegeben', entschieden_von = ?, entschieden_tag = '2026-12-15', freigabe_begruendung = ?, "
                + "freigabe_sub = 'IK', freigabe_name = 'Ines Kaltenbach', freigabe_art = 'kunde', freigabe_am = now(), "
                + "freigegeben_am = now() WHERE id = ?", rf, BEGRUENDUNG, f1));
        freigeben(f1, rf, "2026-12-15");
        assertThat(app.update("UPDATE energiemanagement_dokument SET zustand = 'gueltig' WHERE id = ?", dok)).isOne();
        String vorher = app.queryForObject("SELECT to_jsonb(f)::text FROM energiemanagement_dokument_fassung f WHERE id = ?",
                String.class, f1);
        // Freigegeben: keine Spalte ändert sich mehr — Wortlaut, Status, Entscheid.
        checkFehler("energiemanagement_fassung_unveraenderlich", () -> app.update("UPDATE energiemanagement_dokument_fassung "
                + "SET wortlaut = 'geändert' WHERE id = ?", f1));
        checkFehler("energiemanagement_fassung_unveraenderlich", () -> app.update("UPDATE energiemanagement_dokument_fassung "
                + "SET beschluss_kennung = 'BR-2029-0001/B3' WHERE id = ?", f1));
        checkFehler("energiemanagement_fassung_unveraenderlich", () -> app.update("UPDATE energiemanagement_dokument_fassung "
                + "SET freigabe_status = 'entwurf', entschieden_von = NULL, entschieden_tag = NULL, freigabe_begruendung = NULL,"
                + " freigabe_sub = NULL, freigabe_name = NULL, freigabe_rolle = NULL, freigabe_art = NULL, freigabe_am = NULL,"
                + " freigegeben_am = NULL, kopie = NULL, pruefsumme = NULL WHERE id = ?", f1));
        checkState("42501", () -> app.update("UPDATE energiemanagement_dokument_fassung SET fassung = 7 WHERE id = ?", f1));
        checkFehler("energiemanagement_fassung_identitaet_bleibt", () -> root.update(
                "UPDATE energiemanagement_dokument_fassung SET fassung = 7 WHERE id = ?", f1));
        assertThat(app.queryForObject("SELECT to_jsonb(f)::text FROM energiemanagement_dokument_fassung f WHERE id = ?",
                String.class, f1)).isEqualTo(vorher);
        // „abgelöst“ wird gelesen, nie gespeichert; Fassung 2 braucht eine Begründung und ist Nr. 2.
        checkFehler("energiemanagement_fassung_begruendung_chk", () -> fassung(k, dok, POLITIK + " Fassung 2", null));
        checkFehler("energiemanagement_fassung_lueckenlos", () -> app.update("INSERT INTO energiemanagement_dokument_fassung"
                + "(tenant_id,dokument_id,fassung,form,wortlaut,pruefsumme,begruendung,actor_sub,actor_name,actor_art) VALUES "
                + "(?,?,5,'wortlaut','x',NULL,?,'IK','Ines Kaltenbach','kunde')", k.tenant(), dok, BEGRUENDUNG));
        UUID f2 = fassung(k, dok, POLITIK + " Fassung 2", "Beschluss B3 der Managementbewertung 2028 (BR-2029-0001).");
        assertThat(app.queryForObject("SELECT fassung FROM energiemanagement_dokument_fassung WHERE id = ?", Integer.class, f2))
                .isEqualTo(2);
        UUID verfahren = dokument(k, "verfahren", "unternehmen", null);
        UUID fv = fassung(k, verfahren, "Verfahren Überprüfung", null);
        String kopieFv = kopie(fv);
        checkFehler("energiemanagement_fassung_status_chk", () -> app.update("UPDATE energiemanagement_dokument_fassung "
                + "SET freigabe_status = 'abgeloest', entschieden_von = ?, entschieden_tag = '2027-01-10', "
                + "freigabe_begruendung = ?, freigabe_sub = 'IK', freigabe_name = 'Ines Kaltenbach', freigabe_art = 'kunde', "
                + "freigabe_am = now(), kopie = ?, pruefsumme = bericht_pruefsumme(?) WHERE id = ?", rf, BEGRUENDUNG, kopieFv,
                kopieFv, fv));
        // Höchstens ein offener Entwurf je Dokument.
        checkState("23505", () -> fassung(k, dok, POLITIK + " Fassung 3", BEGRUENDUNG));
    }

    @Test
    void ueberEnergiepolitikEntscheidetDieLeitungAmTagDerEntscheidung() {
        Kunde k = kunde("Leitung");
        TenantContext.set(k.tenant());
        UUID rf = person(k, "Robert Falk", "Geschäftsführer", null);
        UUID ik = person(k, "Ines Kaltenbach", "Energiemanagerin", "IK");
        UUID dok = dokument(k, "energiepolitik", "unternehmen", null);
        UUID f1 = fassung(k, dok, POLITIK, null);
        // Ohne laufende Aufgabe „Leitung des Unternehmens“ gibt niemand die Energiepolitik frei.
        checkFehler("energiemanagement_fassung_leitung", () -> freigeben(f1, rf, "2026-12-15"));
        leitung(k, rf, "2026-12-01");
        checkFehler("energiemanagement_fassung_leitung", () -> freigeben(f1, ik, "2026-12-15"));
        checkFehler("energiemanagement_fassung_leitung", () -> freigeben(f1, rf, "2026-11-30"));
        // Ohne „entschieden von“ keine Freigabe (G2).
        checkFehler("energiemanagement_fassung_freigabe_chk", () -> freigeben(f1, null, "2026-12-15"));
        freigeben(f1, rf, "2026-12-15");
        // Eine Verfahrensanweisung entscheidet auch die Energiemanagerin.
        UUID verfahren = dokument(k, "verfahren", "unternehmen", null);
        freigeben(fassung(k, verfahren, "Verfahren Bezugsbasen", null), ik, "2027-01-10");
    }

    @Test
    void beiVierAugenBestaetigtNieDerUrheberUndJedeFreigabeGehtUeberEinenAntrag() {
        Kunde k = kunde("Vier-Augen");
        TenantContext.set(k.tenant());
        UUID ik = person(k, "Ines Kaltenbach", "Energiemanagerin", "IK");
        UUID dok = dokument(k, "verfahren", "unternehmen", null);
        UUID f1 = fassung(k, dok, "Verfahren", null);
        app.update("UPDATE energiemanagement_dokument_fassung SET vieraugen = true WHERE id = ?", f1);
        checkFehler("energiemanagement_fassung_uebergang_einmalig", () -> freigeben(f1, ik, "2027-01-10"));
        String kopie = kopie(f1);
        app.update("UPDATE energiemanagement_dokument_fassung SET freigabe_status = 'beantragt', entschieden_von = ?, "
                + "entschieden_tag = '2027-01-10', freigabe_begruendung = ?, freigabe_sub = 'IK', freigabe_name = 'Ines "
                + "Kaltenbach', freigabe_rolle = 'energiemanager', freigabe_art = 'kunde', freigabe_am = now(), kopie = ?, "
                + "pruefsumme = bericht_pruefsumme(?) WHERE id = ?", ik, BEGRUENDUNG, kopie, kopie, f1);
        checkFehler("energiemanagement_fassung_antrag_bleibt", () -> app.update("UPDATE energiemanagement_dokument_fassung "
                + "SET wortlaut = 'anders' WHERE id = ?", f1));
        String entscheid = "UPDATE energiemanagement_dokument_fassung SET freigabe_status = ?, entscheidung_sub = ?, "
                + "entscheidung_name = ?, entscheidung_rolle = 'kundenadministrator', entscheidung_art = 'kunde', entschieden_am = "
                + "now(), entscheidungs_begruendung = ?, freigegeben_am = CASE WHEN ? = 'freigegeben' THEN now() END WHERE id = ?";
        checkFehler("energiemanagement_fassung_entscheidung_chk", () -> app.update(entscheid, "freigegeben", "IK",
                "Ines Kaltenbach", null, "freigegeben", f1));
        checkFehler("energiemanagement_fassung_ablehnung_chk", () -> app.update(entscheid, "abgelehnt", "JW",
                "Jonas Wendlinger", null, "abgelehnt", f1));
        assertThat(app.update(entscheid, "freigegeben", "JW", "Jonas Wendlinger", null, "freigegeben", f1)).isOne();
    }

    // ============================================================ Kennzeichen-Zähler

    @Test
    void derZaehlerVergibtDOhneJahrUndAuUndFJeJahrLueckenlosJeKundenbereich() {
        Kunde a = kunde("Zähler A");
        Kunde b = kunde("Zähler B");
        TenantContext.set(a.tenant());
        assertThat(kennzeichen(dokument(a, "energiepolitik", "unternehmen", null))).isEqualTo("D-0001");
        assertThat(kennzeichen(dokument(a, "anwendungsbereich", "unternehmen", null))).isEqualTo("D-0002");
        app.update("INSERT INTO energiemanagement_dokument(tenant_id,kennzeichen,art,titel,bezug,actor_sub,actor_name,actor_art) "
                + "VALUES (?,'D-0005','betrieb','Übernommen','unternehmen','IK','Ines Kaltenbach','kunde')", a.tenant());
        assertThat(kennzeichen(dokument(a, "verfahren", "unternehmen", null))).isEqualTo("D-0006");
        checkFehler("energiemanagement_dokument_kennzeichen_chk", () -> app.update("INSERT INTO energiemanagement_dokument("
                + "tenant_id,kennzeichen,art,titel,bezug,actor_sub,actor_name,actor_art) VALUES (?,'D-2029-0001','betrieb',"
                + "'Falsch','unternehmen','IK','Ines Kaltenbach','kunde')", a.tenant()));
        assertThat(app.queryForObject("SELECT uems_energiemanagement_kennung(?, 'AU', 2029)", String.class, a.tenant()))
                .isEqualTo("AU-2029-0001");
        assertThat(app.queryForObject("SELECT uems_energiemanagement_kennung(?, 'F', 2029)", String.class, a.tenant()))
                .isEqualTo("F-2029-0001");
        assertThat(app.queryForObject("SELECT uems_energiemanagement_kennung(?, 'F', 2029)", String.class, a.tenant()))
                .isEqualTo("F-2029-0002");
        assertThat(app.queryForObject("SELECT uems_energiemanagement_kennung(?, 'F', 2030)", String.class, a.tenant()))
                .isEqualTo("F-2030-0001");
        checkState("22023", () -> app.queryForObject("SELECT uems_energiemanagement_kennung(?, 'D', 2029)", String.class,
                a.tenant()));
        checkFehler("energiemanagement_kennung_seq_rueckt_nur_vor", () -> app.update("UPDATE energiemanagement_kennung_seq "
                + "SET naechste_nummer = 1 WHERE art = 'D'"));
        TenantContext.set(b.tenant());
        assertThat(kennzeichen(dokument(b, "energiepolitik", "unternehmen", null))).isEqualTo("D-0001");
    }

    // ============================================================ PA1/PA2: Person und Aufgabe

    @Test
    void personOhneKontoUndAufgabenNurAnhaengen() {
        Kunde k = kunde("Aufgaben");
        TenantContext.set(k.tenant());
        UUID rf = person(k, "Robert Falk", "Geschäftsführer", null);
        UUID ik = person(k, "Ines Kaltenbach", "Energiemanagerin", "IK");
        UUID jw = person(k, "Jonas Wendlinger", "Leiter Technik", "JW");
        checkState("23503", () -> person(k, "Niemand", "ohne Konto im Kundenbereich", "XX"));
        checkState("23505", () -> person(k, "Ines K.", "zweite Person am selben Konto", "IK"));
        app.update("UPDATE energiemanagement_person SET kuerzel = 'RF' WHERE id = ?", rf);
        checkState("23505", () -> app.update("UPDATE energiemanagement_person SET kuerzel = 'RF' WHERE id = ?", ik));
        UUID leitung = leitung(k, rf, "2026-09-28");
        // „Entschieden von“ ist Pflicht außer bei der Leitung; „weitere“ nur mit Wortlaut.
        checkFehler("energiemanagement_aufgabe_entschieden_chk", () -> aufgabe(k, "bezugsbasen", null, ik, null));
        checkFehler("energiemanagement_aufgabe_wortlaut_chk", () -> aufgabe(k, "weitere", null, ik, rf));
        checkFehler("energiemanagement_aufgabe_aufgabe_chk", () -> aufgabe(k, "zustaendigkeit", null, ik, rf));
        aufgabe(k, "weitere", "Energiebeauftragte Werk Lindach", jw, rf);
        UUID bb = aufgabe(k, "bezugsbasen", null, jw, rf);
        checkState("42501", () -> app.update("UPDATE energiemanagement_aufgabe SET person_id = ? WHERE id = ?", ik, bb));
        checkFehler("energiemanagement_aufgabe_nur_anhaengen", () -> root.update(
                "UPDATE energiemanagement_aufgabe SET person_id = ? WHERE id = ?", ik, bb));
        app.update("UPDATE energiemanagement_aufgabe SET gilt_bis = '2029-02-28', zustand = 'beendet', beendet_begruendung = ? "
                + "WHERE id = ?", "Übergabe an Ines Kaltenbach ab 01.03.2029 (Beschluss B4).", bb);
        checkFehler("energiemanagement_aufgabe_endgueltig", () -> app.update(
                "UPDATE energiemanagement_aufgabe SET gilt_bis = '2029-03-31' WHERE id = ?", bb));
        assertThat(app.queryForObject("SELECT entschieden_von FROM energiemanagement_aufgabe WHERE id = ?", UUID.class, leitung))
                .isNull();
        // Eine beendete Person ist endgültig.
        app.update("UPDATE energiemanagement_person SET bis = '2029-12-31', zustand = 'beendet', beendet_begruendung = ? "
                + "WHERE id = ?", "Ausgeschieden zum Jahresende 2029.", jw);
        checkFehler("energiemanagement_person_endgueltig", () -> app.update(
                "UPDATE energiemanagement_person SET funktion = 'anders' WHERE id = ?", jw));
    }

    // ============================================================ DK5, DK6, DK8: Einträge und Aufheben

    @Test
    void eintraegeFolgenDemDokumentUndAufgehobenIstEndgueltig() {
        Kunde k = kunde("Einträge");
        TenantContext.set(k.tenant());
        UUID ik = person(k, "Ines Kaltenbach", "Energiemanagerin", "IK");
        UUID md = person(k, "Murat Demirci", "Schichtführer", null);
        UUID kompetenz = dokument(k, "kompetenz", "person", null, Map.of("person_id", md));
        UUID f = fassung(k, kompetenz, null, null, "Personalsystem", "UW-2028-014");
        String eintrag = "INSERT INTO energiemanagement_dokument_eintrag(tenant_id,dokument_id,fassung,art,person_id,"
                + "entschieden_von,am,kreis,weg,begruendung,actor_sub,actor_name,actor_art) VALUES (?,?,?,?,?,?,?,?,?,?,'IK',"
                + "'Ines Kaltenbach','kunde')";
        // Bekannt gemacht wird ein gültiges Dokument.
        checkFehler("energiemanagement_eintrag_fassung_freigegeben", () -> app.update(eintrag, k.tenant(), kompetenz, 1,
                "bekannt_gemacht", ik, null, Date.valueOf("2028-11-12"), "Schichtführer", "unterweisung", null));
        freigeben(f, ik, "2028-11-10");
        app.update("UPDATE energiemanagement_dokument SET zustand = 'gueltig' WHERE id = ?", kompetenz);
        app.update(eintrag, k.tenant(), kompetenz, 1, "bekannt_gemacht", ik, null, Date.valueOf("2028-11-12"), "Schichtführer",
                "unterweisung", null);
        checkFehler("energiemanagement_eintrag_inhalt_chk", () -> app.update(eintrag, k.tenant(), kompetenz, 1,
                "bekannt_gemacht", ik, null, Date.valueOf("2028-11-12"), "Schichtführer", "brieftaube", null));
        // Ein Nachweis (Kompetenz) hat keine Überprüfung (DK5).
        checkFehler("energiemanagement_eintrag_nur_vorgabe", () -> app.update(eintrag, k.tenant(), kompetenz, 1,
                "geprueft_bleibt", null, ik, Date.valueOf("2029-11-10"), null, null, BEGRUENDUNG));
        // Aufheben: erst der Eintrag (Tag, Begründung, entschieden von), dann der Zustand; danach endgültig.
        checkFehler("energiemanagement_dokument_uebergang_einmalig", () -> app.update(
                "UPDATE energiemanagement_dokument SET zustand = 'aufgehoben' WHERE id = ?", kompetenz));
        checkFehler("energiemanagement_eintrag_inhalt_chk", () -> app.update(eintrag, k.tenant(), kompetenz, null,
                "aufgehoben", null, ik, Date.valueOf("2029-12-31"), null, null, "kurz"));
        app.update(eintrag, k.tenant(), kompetenz, null, "aufgehoben", null, ik, Date.valueOf("2029-12-31"), null, null,
                "Unterweisung durch die Schulung 2030 ersetzt.");
        app.update("UPDATE energiemanagement_dokument SET zustand = 'aufgehoben' WHERE id = ?", kompetenz);
        checkFehler("energiemanagement_dokument_endgueltig", () -> app.update(
                "UPDATE energiemanagement_dokument SET titel = 'neu' WHERE id = ?", kompetenz));
        checkFehler("energiemanagement_dokument_endgueltig", () -> fassung(k, kompetenz, "neu", BEGRUENDUNG));
        checkFehler("energiemanagement_dokument_endgueltig", () -> app.update(eintrag, k.tenant(), kompetenz, 1,
                "bekannt_gemacht", ik, null, Date.valueOf("2030-01-12"), "Schichtführer", "aushang", null));
        assertThat(app.queryForObject("SELECT count(*) FROM energiemanagement_dokument_fassung WHERE dokument_id = ?",
                Integer.class, kompetenz)).isOne();
    }

    // ============================================================ DK7: Anwendungsbereich

    @Test
    void derAnwendungsbereichNenntStandorteUndTraegerUndBleibtMitSeinerFassung() {
        Kunde k = kunde("Anwendungsbereich");
        TenantContext.set(k.tenant());
        UUID rf = person(k, "Robert Falk", "Geschäftsführer", null);
        leitung(k, rf, "2026-09-28");
        UUID dok = dokument(k, "anwendungsbereich", "unternehmen", null);
        UUID f1 = fassung(k, dok, "Werk Ahrenberg und Werk Lindach, Strom und Gas, keine Ausschlüsse.", null);
        String bereich = "INSERT INTO energiemanagement_anwendungsbereich(fassung_id,tenant_id,standort_ids,traeger,ausschluesse) "
                + "VALUES (?,?,?::uuid[],?::text[],?::jsonb)";
        checkFehler("energiemanagement_fassung_anwendungsbereich", () -> freigeben(f1, rf, "2026-12-15"));
        checkFehler("energiemanagement_anwendungsbereich_traeger_chk", () -> app.update(bereich, f1, k.tenant(),
                "{" + k.st1() + "}", "{Strom,Öl}", "[]"));
        checkFehler("energiemanagement_anwendungsbereich_ausschluesse_chk", () -> app.update(bereich, f1, k.tenant(),
                "{" + k.st1() + "}", "{Strom}", "[{\"art\":\"gebaeude\",\"verweis\":\"" + k.st2() + "\",\"begruendung\":"
                        + "\"Verwaltung ohne eigenen Zähler.\"}]"));
        checkState("23503", () -> app.update(bereich, f1, k.tenant(), "{" + UUID.randomUUID() + "}", "{Strom}", "[]"));
        app.update(bereich, f1, k.tenant(), "{" + k.st1() + "," + k.st2() + "}", "{Strom,Gas}", "[]");
        freigeben(f1, rf, "2026-12-15");
        checkFehler("energiemanagement_fassung_unveraenderlich", () -> app.update(
                "UPDATE energiemanagement_anwendungsbereich SET traeger = '{Strom}' WHERE fassung_id = ?", f1));
        // Standorte und Träger trägt nur eine Fassung des Anwendungsbereichs.
        UUID politik = dokument(k, "energiepolitik", "unternehmen", null);
        UUID fp = fassung(k, politik, POLITIK, null);
        checkFehler("energiemanagement_anwendungsbereich_art", () -> app.update(bereich, fp, k.tenant(),
                "{" + k.st1() + "}", "{Strom}", "[]"));
    }

    // ============================================================ RE2: App-Rechte, Mandanten- und Standort-Zaun

    @Test
    void dieAppLoeschtNieUndProtokollUndEintraegeWerdenNurAngehaengt() {
        Kunde k = kunde("Löschen");
        TenantContext.set(k.tenant());
        UUID ik = person(k, "Ines Kaltenbach", "Energiemanagerin", "IK");
        UUID dok = dokument(k, "betrieb", "standort", k.st1());
        fassung(k, dok, "Betrieb", null);
        protokoll(k, dok);
        for (String t : TABELLEN) {
            checkState("42501", () -> app.update("DELETE FROM " + t + " WHERE tenant_id = ?", k.tenant()));
        }
        checkState("42501", () -> app.update("UPDATE energiemanagement_aenderung SET neu = NULL WHERE objekt_id = ?", dok));
        checkState("42501", () -> app.update("UPDATE energiemanagement_dokument_eintrag SET kommentar = 'x'"));
        checkState("42501", () -> app.update("UPDATE energiemanagement_aufgabe SET person_id = ? WHERE tenant_id = ?", ik,
                k.tenant()));
        checkFehler("energiemanagement_aenderung_art_chk", () -> app.update("INSERT INTO energiemanagement_aenderung("
                + "tenant_id,objekt,objekt_id,art,actor_sub,actor_name,actor_art) VALUES (?,'dokument',?,'massnahme_angelegt',"
                + "'IK','Ines Kaltenbach','kunde')", k.tenant(), dok));
    }

    @Test
    void derMandantenzaunHaeltMandantASiehtBNicht() {
        Kunde a = kunde("Zaun A");
        Kunde b = kunde("Zaun B");
        TenantContext.set(b.tenant());
        UUID rfB = person(b, "Robert Falk", "Geschäftsführer", null);
        leitung(b, rfB, "2026-09-28");
        UUID dokB = dokument(b, "betrieb", "standort", b.st1());
        fassung(b, dokB, "Betrieb B", null);
        protokoll(b, dokB);
        TenantContext.set(a.tenant());
        for (String t : TABELLEN) {
            assertThat(app.queryForObject("SELECT count(*) FROM " + t + " WHERE tenant_id = ?", Integer.class, b.tenant()))
                    .as(t).isZero();
        }
        assertThat(app.update("UPDATE energiemanagement_dokument SET titel = 'fremd' WHERE id = ?", dokB)).isZero();
        checkState("42501", () -> dokument(b, "betrieb", "standort", b.st1()));
        checkState("23503", () -> dokument(a, "betrieb", "standort", b.st1()));
        checkState("23503", () -> aufgabe(a, "energieteam", null, rfB, rfB));
        TenantContext.clear();
        assertThat(app.queryForObject("SELECT count(*) FROM energiemanagement_dokument", Integer.class)).isZero();
    }

    @Test
    void derStandortZaunZeigtEinemStandortNurSeineDokumenteUndNieEinsAmUnternehmen() {
        Kunde k = kunde("Standort-Zaun");
        TenantContext.set(k.tenant());
        UUID ik = person(k, "Ines Kaltenbach", "Energiemanagerin", "IK");
        UUID rf = person(k, "Robert Falk", "Geschäftsführer", null);
        leitung(k, rf, "2026-09-28");
        UUID amUnternehmen = dokument(k, "verfahren", "unternehmen", null);
        UUID amSt1 = dokument(k, "betrieb", "standort", k.st1());
        UUID amSt2 = dokument(k, "betrieb", "standort", k.st2());
        UUID anPerson = dokument(k, "kompetenz", "person", null, Map.of("person_id", ik));
        for (UUID d : List.of(amUnternehmen, amSt1, amSt2, anPerson)) {
            fassung(k, d, "Wortlaut", null);
            protokoll(k, d);
        }
        TenantContext.clear();
        eng(k.tenant(), List.of(k.st1()), jdbc -> {
            assertThat(jdbc.queryForList("SELECT id FROM energiemanagement_dokument", UUID.class)).containsExactly(amSt1);
            assertThat(jdbc.queryForList("SELECT DISTINCT dokument_id FROM energiemanagement_dokument_fassung", UUID.class))
                    .containsExactly(amSt1);
            assertThat(jdbc.queryForList("SELECT DISTINCT objekt_id FROM energiemanagement_aenderung", UUID.class))
                    .containsExactly(amSt1);
            // Aufgaben haben keinen Standort: nur unternehmensweit; Personen (Namen) sieht jeder im Kundenbereich.
            assertThat(jdbc.queryForObject("SELECT count(*) FROM energiemanagement_aufgabe", Integer.class)).isZero();
            assertThat(jdbc.queryForObject("SELECT count(*) FROM energiemanagement_person", Integer.class)).isEqualTo(2);
            assertThat(jdbc.update("UPDATE energiemanagement_dokument SET titel = 'fremd' WHERE id = ?", amSt2)).isZero();
            checkState("42501", () -> jdbc.update("INSERT INTO energiemanagement_dokument(tenant_id,art,titel,bezug,standort_id,"
                    + "actor_sub,actor_name,actor_art) VALUES (?,'betrieb','fremd','standort',?,'PH','Peter Hollerbach','kunde')",
                    k.tenant(), k.st2()));
            checkState("42501", () -> jdbc.update("INSERT INTO energiemanagement_aufgabe(tenant_id,aufgabe,person_id,gilt_ab,"
                    + "entschieden_von,begruendung,actor_sub,actor_name,actor_art) VALUES (?,'energieteam',?,'2027-01-01',?,?,"
                    + "'PH','Peter Hollerbach','kunde')", k.tenant(), ik, rf, BEGRUENDUNG));
            return null;
        });
        eng(k.tenant(), null, jdbc -> {
            assertThat(jdbc.queryForObject("SELECT count(*) FROM energiemanagement_dokument", Integer.class)).isEqualTo(4);
            assertThat(jdbc.queryForObject("SELECT count(*) FROM energiemanagement_aufgabe", Integer.class)).isOne();
            return null;
        });
    }

    // ============================================================ RE1: Rechte, RLS, Matrix; Vokabulare

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
        for (String t : List.of("energiemanagement_aufgabe", "energiemanagement_dokument", "energiemanagement_dokument_fassung",
                "energiemanagement_anwendungsbereich", "energiemanagement_dokument_eintrag", "energiemanagement_aenderung")) {
            assertThat(root.queryForObject("SELECT count(*) FROM pg_policies WHERE tablename = ? AND policyname = 'site_scope' "
                    + "AND permissive = 'RESTRICTIVE'", Integer.class, t)).as(t + " site_scope").isOne();
            assertThat(root.queryForObject("SELECT count(*) FROM pg_policies WHERE tablename = ? AND permissive = 'PERMISSIVE'",
                    Integer.class, t)).as(t + " nur die Mandanten-Policy öffnet").isOne();
        }
        for (String t : List.of("energiemanagement_dokument_eintrag", "energiemanagement_aenderung")) {
            assertThat(root.queryForObject("SELECT has_table_privilege(?, ?, 'UPDATE')", Boolean.class, APP, t)).as(t).isFalse();
        }
        for (String s : List.of("energiemanagement_dokument_eintrag_id_seq", "energiemanagement_aenderung_id_seq")) {
            assertThat(root.queryForObject("SELECT has_sequence_privilege(?, ?, 'USAGE')", Boolean.class, APP, s)).as(s)
                    .isTrue();
        }
        // RE1: drei Kennungen in der Gruppe kennzahlen, Zellen wie verbesserung.verwalten, bezugsbasis.freigeben,
        // verbesserung.ansehen; seit IP-12 die achte Spalte Einsicht: − an verwalten/freigeben, U an ansehen (RE3).
        JsonNode matrix = MAPPER.readTree(Path.of("../../docs/contracts/v2/rechte-matrix.json").toFile());
        Map<String, String> zellen = new LinkedHashMap<>();
        matrix.path("aktionen").forEach(r -> {
            if (r.path("kennung").asText().startsWith("energiemanagement.")) {
                assertThat(r.path("gruppe").asText()).isEqualTo("kennzahlen");
                StringBuilder s = new StringBuilder();
                r.path("zellen").fields().forEachRemaining(z -> s.append(z.getValue().asText()));
                zellen.put(r.path("kennung").asText(), s.toString());
            }
        });
        assertThat(zellen).containsExactly(Map.entry("energiemanagement.verwalten", "UUS-----"),
                Map.entry("energiemanagement.freigeben", "UU------"), Map.entry("energiemanagement.ansehen", "UUSSSA-U"));
    }

    /** Vertrag IP-2: Vokabulare zeilengleich, `leitungs_pflicht`, `dokument_art_klasse`, Kennzeichen-Muster, Startwerte. */
    @Test
    void dieVokabulareUndMusterDerDatenbankSindDieDesVertrags() throws IOException {
        JsonNode vertrag = MAPPER.readTree(Path.of("../../docs/contracts/v2/energiemanagement-vectors.json").toFile());
        List<String> bloecke = new ArrayList<>();
        vertrag.path("vokabulare").fieldNames().forEachRemaining(bloecke::add);
        assertThat(bloecke).hasSize(25);
        for (String block : bloecke) {
            List<String> woerter = new ArrayList<>();
            vertrag.path("vokabulare").path(block).forEach(w -> woerter.add(w.asText()));
            assertThat(root.queryForList("SELECT wort FROM energiemanagement_vokabular() WHERE vokabular = ? ORDER BY nr",
                    String.class, block)).as(block).isNotEmpty().containsExactlyElementsOf(woerter);
        }
        List<String> leitung = new ArrayList<>();
        vertrag.path("leitungs_pflicht").forEach(w -> leitung.add(w.asText()));
        assertThat(root.queryForList("SELECT wort FROM energiemanagement_vokabular() WHERE vokabular = 'leitungs_pflicht' "
                + "ORDER BY nr", String.class)).containsExactlyElementsOf(leitung);
        List<String> nurTabellen = new ArrayList<>(root.queryForList("SELECT DISTINCT vokabular FROM "
                + "energiemanagement_vokabular() ORDER BY vokabular", String.class));
        nurTabellen.removeAll(bloecke);
        assertThat(nurTabellen).containsExactly("anwendungsbereich_ausschluss", "energiemanagement_protokoll", "kennung_art",
                "leitungs_pflicht");
        vertrag.path("dokument_art_klasse").fields().forEachRemaining(e -> assertThat(root.queryForObject(
                "SELECT energiemanagement_dokument_klasse(?)", String.class, e.getKey())).as(e.getKey())
                .isEqualTo(e.getValue().asText()));
        assertThat(root.queryForObject("SELECT energiemanagement_dokument_klasse('sonstiges')", String.class)).isNull();
        // Die Muster der Kennzeichen stehen wörtlich in den CHECKs.
        JsonNode muster = vertrag.path("kennzeichen_muster");
        assertThat(root.queryForObject("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = "
                + "'energiemanagement_dokument_kennzeichen_chk'", String.class)).contains(muster.path("dokument").asText());
        for (String chk : List.of("energiemanagement_fassung_beschluss_chk", "energiemanagement_eintrag_beschluss_chk",
                "energiemanagement_aufgabe_beschluss_chk")) {
            assertThat(root.queryForObject("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = ?",
                    String.class, chk)).as(chk).contains(muster.path("beschluss").asText());
        }
        // Die Vorgaben der Einstellung sind die Startwerte des Vertrags.
        JsonNode start = vertrag.path("startwerte");
        for (String spalte : List.of("ueberpruefung_monate", "audit_rhythmus_monate", "managementbewertung_rhythmus_monate",
                "feststellung_frist_tage", "vorschau_tage")) {
            assertThat(root.queryForObject("SELECT column_default FROM information_schema.columns WHERE table_name = "
                    + "'energiemanagement_einstellung' AND column_name = ?", String.class, spalte)).as(spalte)
                    .isEqualTo(start.path(spalte).asText());
        }
        // `nr` ist je Block lückenlos ab 1.
        assertThat(root.queryForObject("SELECT count(*) FROM (SELECT vokabular, array_agg(nr ORDER BY nr) n, count(*) c "
                + "FROM energiemanagement_vokabular() GROUP BY vokabular) s WHERE n <> (SELECT array_agg(g) FROM "
                + "generate_series(1, c::int) g)", Integer.class)).isZero();
    }

    /** DK5: eine Vorgabe bekommt die Überprüfungs-Monate der Einstellung (Startwert 12), ein Nachweis keine. */
    @Test
    void dieUeberpruefungStehtNurAnVorgabenUndKommtAusDerEinstellung() {
        Kunde k = kunde("Überprüfung");
        TenantContext.set(k.tenant());
        UUID politik = dokument(k, "energiepolitik", "unternehmen", null);
        UUID kompetenz = dokument(k, "auslegung", "unternehmen", null);
        assertThat(app.queryForObject("SELECT ueberpruefung_monate FROM energiemanagement_dokument WHERE id = ?",
                Integer.class, politik)).isEqualTo(12);
        assertThat(app.queryForObject("SELECT ueberpruefung_monate FROM energiemanagement_dokument WHERE id = ?",
                Integer.class, kompetenz)).isNull();
        checkFehler("energiemanagement_dokument_ueberpruefung_chk", () -> dokument(k, "kompetenz", "unternehmen", null,
                Map.of("ueberpruefung_monate", 12)));
        checkFehler("energiemanagement_dokument_ueberpruefung_chk", () -> dokument(k, "verfahren", "unternehmen", null,
                Map.of("ueberpruefung_monate", 61)));
        app.update("INSERT INTO energiemanagement_einstellung(tenant_id,ueberpruefung_monate,actor_sub,actor_name,actor_art) "
                + "VALUES (?,24,'IK','Ines Kaltenbach','kunde')", k.tenant());
        assertThat(app.queryForObject("SELECT ueberpruefung_monate FROM energiemanagement_dokument WHERE id = ?",
                Integer.class, dokument(k, "verfahren", "unternehmen", null))).isEqualTo(24);
        // Das unterschriebene Original ist ein Verweis: ohne Ablage keiner seiner Teile.
        checkFehler("energiemanagement_dokument_beleg_chk", () -> app.update("UPDATE energiemanagement_dokument SET "
                + "beleg_kennung = 'EP-2026' WHERE id = ?", politik));
        assertThat(app.update("UPDATE energiemanagement_dokument SET beleg_bezeichnung = 'Energiepolitik Fassung 1, "
                + "unterschrieben', beleg_ablage = 'QM-Laufwerk, Ordner Energiemanagement/Politik', beleg_kennung = 'EP-2026' "
                + "WHERE id = ?", politik)).isOne();
    }

    @Test
    void dasOffboardingRaeumtAlleTabellenVorStandortEinsatzUndBenutzerAb() {
        Kunde k = kunde("Offboarding");
        TenantContext.set(k.tenant());
        UUID ik = person(k, "Ines Kaltenbach", "Energiemanagerin", "IK");
        UUID rf = person(k, "Robert Falk", "Geschäftsführer", null);
        leitung(k, rf, "2026-09-28");
        UUID aufgabe = aufgabe(k, "bezugsbasen", null, ik, rf);
        UUID dok = dokument(k, "anwendungsbereich", "standort", k.st1());
        UUID f = fassung(k, dok, "Werk Ahrenberg", null);
        app.update("INSERT INTO energiemanagement_anwendungsbereich(fassung_id,tenant_id,standort_ids,traeger) VALUES "
                + "(?,?,?::uuid[],'{Strom}')", f, k.tenant(), "{" + k.st1() + "}");
        freigeben(f, rf, "2026-12-15");
        app.update("UPDATE energiemanagement_dokument SET zustand = 'gueltig' WHERE id = ?", dok);
        dokument(k, "bestellung", "aufgabe", null, Map.of("aufgabe_id", aufgabe));
        app.update("INSERT INTO energiemanagement_dokument_eintrag(tenant_id,dokument_id,fassung,art,person_id,am,kreis,weg,"
                + "actor_sub,actor_name,actor_art) VALUES (?,?,1,'bekannt_gemacht',?,'2026-12-18','alle Mitarbeitenden',"
                + "'aushang','IK','Ines Kaltenbach','kunde')", k.tenant(), dok, ik);
        app.update("INSERT INTO energiemanagement_einstellung(tenant_id,actor_sub,actor_name,actor_art) VALUES (?,'IK',"
                + "'Ines Kaltenbach','kunde')", k.tenant());
        protokoll(k, dok);
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
        assertThat(fingerVorher.get("benutzer")).as("es gibt Bestand").isNotEqualTo(Bestandsschutz.LEER);
        assertThat(fingerVorher.get("standort")).as("es gibt Bestand").isNotEqualTo(Bestandsschutz.LEER);
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
        Path ohneDiese = Files.createTempDirectory("ohne-energiemanagement");
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
        List<String> spaeteAnkunft = new ArrayList<>(List.of(DIESE));
        spaeteAnkunft.addAll(BAUEN_DARAUF_AUF);
        assertThat(spaet.migrations).extracting(m -> m.version).containsExactlyElementsOf(spaeteAnkunft);
        JdbcTemplate spaetDb = new JdbcTemplate(ds(url, POSTGRES.getUsername(), POSTGRES.getPassword()));
        String tabellen = "(" + String.join(", ", TABELLEN.stream().map(t -> "'" + t + "'").toList()) + ")";
        for (String sql : List.of(
                "SELECT string_agg(conrelid::regclass || ':' || conname || ':' || pg_get_constraintdef(oid), '|' "
                        + "ORDER BY conrelid::regclass::text, conname) FROM pg_constraint WHERE conrelid::regclass::text IN "
                        + tabellen,
                "SELECT string_agg(tablename || ':' || policyname || ':' || permissive || ':' || qual, '|' "
                        + "ORDER BY tablename, policyname) FROM pg_policies WHERE tablename IN " + tabellen,
                "SELECT string_agg(tgname, '|' ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal "
                        + "AND tgrelid::regclass::text IN " + tabellen,
                "SELECT string_agg(format('%s/%s/%s', vokabular, nr, wort), '|' ORDER BY vokabular, nr) "
                        + "FROM energiemanagement_vokabular()")) {
            assertThat(spaetDb.queryForObject(sql, String.class)).as(sql).isNotNull()
                    .isEqualTo(root.queryForObject(sql, String.class));
        }
    }

    // ============================================================ Gerüst

    /** Ein Kundenbereich mit Unternehmen, zwei Standorten und den Konten IK, JW, PH (nur Tabellen, die es vorher gibt). */
    private static Kunde kunde(String name) {
        UUID tenant = root.queryForObject("INSERT INTO tenant(name) VALUES (?) RETURNING id", UUID.class, name);
        UUID unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name) VALUES (?,?) RETURNING id",
                UUID.class, tenant, name);
        for (String[] p : new String[][] {{"IK", "Ines Kaltenbach"}, {"JW", "Jonas Wendlinger"}, {"PH", "Peter Hollerbach"}}) {
            root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,?,'benutzer',?,'aktiv')",
                    tenant, p[0], p[1]);
        }
        UUID st1 = UUID.randomUUID(), st2 = UUID.randomUUID();
        for (Object[] s : new Object[][] {{st1, "Werk Ahrenberg", "AHR"}, {st2, "Werk Lindach", "LIN"}}) {
            root.update("INSERT INTO standort (id, tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                    + "VALUES (?, ?, ?, ?, ?, 'Europe/Berlin', 'aktiv')", s[0], tenant, unternehmen, s[1], s[2]);
        }
        return new Kunde(tenant, unternehmen, st1, st2);
    }

    private static UUID person(Kunde k, String name, String funktion, String konto) {
        return app.queryForObject("INSERT INTO energiemanagement_person(tenant_id,name,funktion,konto_sub,actor_sub,actor_name,"
                + "actor_rolle,actor_art) VALUES (?,?,?,?,'IK','Ines Kaltenbach','energiemanager','kunde') RETURNING id",
                UUID.class, k.tenant(), name, funktion, konto);
    }

    /** Die Aufgabe „Leitung des Unternehmens“ ab diesem Tag — ohne „entschieden von“ (PA2). */
    private static UUID leitung(Kunde k, UUID person, String ab) {
        return app.queryForObject("INSERT INTO energiemanagement_aufgabe(tenant_id,aufgabe,person_id,gilt_ab,begruendung,"
                + "beleg_ablage,beleg_kennung,actor_sub,actor_name,actor_rolle,actor_art) VALUES (?,'unternehmensleitung',?,?,"
                + "'Geschäftsführer laut Handelsregister.','Personalakte','Bestellung vom 28.09.2026','IK','Ines Kaltenbach',"
                + "'energiemanager','kunde') RETURNING id", UUID.class, k.tenant(), person, Date.valueOf(ab));
    }

    private static UUID aufgabe(Kunde k, String aufgabe, String wortlaut, UUID person, UUID entschiedenVon) {
        return app.queryForObject("INSERT INTO energiemanagement_aufgabe(tenant_id,aufgabe,aufgabe_wortlaut,person_id,gilt_ab,"
                + "entschieden_von,begruendung,actor_sub,actor_name,actor_rolle,actor_art) VALUES (?,?,?,?,'2029-01-22',?,?,"
                + "'IK','Ines Kaltenbach','energiemanager','kunde') RETURNING id", UUID.class, k.tenant(), aufgabe, wortlaut,
                person, entschiedenVon, BEGRUENDUNG);
    }

    private static UUID dokument(Kunde k, String art, String bezug, UUID standort) {
        return dokument(k, art, bezug, standort, Map.of());
    }

    private static UUID dokument(Kunde k, String art, String bezug, UUID standort, Map<String, Object> spalten) {
        Map<String, Object> werte = new LinkedHashMap<>();
        werte.put("tenant_id", k.tenant());
        werte.put("art", art);
        werte.put("titel", "Dokument " + art);
        werte.put("bezug", bezug);
        werte.put("standort_id", standort);
        werte.put("actor_sub", "IK");
        werte.put("actor_name", "Ines Kaltenbach");
        werte.put("actor_rolle", "energiemanager");
        werte.put("actor_art", "kunde");
        werte.putAll(spalten);
        String sql = "INSERT INTO energiemanagement_dokument(" + String.join(",", werte.keySet()) + ") VALUES ("
                + String.join(",", werte.keySet().stream().map(s -> "?").toList()) + ") RETURNING id";
        return app.queryForObject(sql, UUID.class, werte.values().toArray());
    }

    /** Ein Entwurf als Wortlaut (die Kopie kommt mit dem Antrag bzw. der Freigabe). */
    private static UUID fassung(Kunde k, UUID dokument, String wortlaut, String begruendung) {
        return app.queryForObject("INSERT INTO energiemanagement_dokument_fassung(tenant_id,dokument_id,form,wortlaut,"
                + "begruendung,actor_sub,actor_name,actor_rolle,actor_art) VALUES (?,?,'wortlaut',?,?,'IK','Ines Kaltenbach',"
                + "'energiemanager','kunde') RETURNING id", UUID.class, k.tenant(), dokument, wortlaut, begruendung);
    }

    /** Eine Fassung als Verweis auf das System des Kunden (Ablage, Kennung). */
    private static UUID fassung(Kunde k, UUID dokument, String wortlaut, String begruendung, String ablage, String kennung) {
        return app.queryForObject("INSERT INTO energiemanagement_dokument_fassung(tenant_id,dokument_id,form,verweis_ablage,"
                + "verweis_kennung,begruendung,actor_sub,actor_name,actor_rolle,actor_art) VALUES (?,?,'verweis',?,?,?,'IK',"
                + "'Ines Kaltenbach','energiemanager','kunde') RETURNING id", UUID.class, k.tenant(), dokument, ablage, kennung,
                begruendung);
    }

    /** Ines trägt die Freigabe ohne Vier-Augen ein — entschieden von dieser Person an diesem Tag, mit der Kopie. */
    private static void freigeben(UUID fassung, UUID entschiedenVon, String tag) {
        String kopie = kopie(fassung);
        app.update("UPDATE energiemanagement_dokument_fassung SET freigabe_status = 'freigegeben', entschieden_von = ?, "
                + "entschieden_tag = ?, freigabe_begruendung = ?, freigabe_sub = 'IK', freigabe_name = 'Ines Kaltenbach', "
                + "freigabe_rolle = 'energiemanager', freigabe_art = 'kunde', freigabe_am = ?, freigegeben_am = ?, kopie = ?, "
                + "pruefsumme = bericht_pruefsumme(?) WHERE id = ?", entschiedenVon, Date.valueOf(tag), BEGRUENDUNG,
                Timestamp.valueOf(tag + " 10:00:00"), Timestamp.valueOf(tag + " 10:00:00"), kopie, kopie, fassung);
    }

    /**
     * Die Kopie einer Fassung, wie ein Schreibweg sie bildet (Vertrag §6): {@code nr}, {@code form}, {@code wortlaut},
     * {@code verweis}, {@code anwendungsbereich} in der kanonischen Form {@link BerichtRegeln#kanonisch}.
     */
    private static String kopie(UUID fassung) {
        Map<String, Object> f = app.queryForMap("SELECT f.fassung, f.form, f.wortlaut, f.verweis_ablage, f.verweis_kennung, "
                + "(SELECT jsonb_build_object('standorte', to_jsonb(b.standort_ids), 'traeger', to_jsonb(b.traeger), "
                + "'ausschluesse', b.ausschluesse)::text FROM energiemanagement_anwendungsbereich b WHERE b.fassung_id = f.id) "
                + "AS bereich FROM energiemanagement_dokument_fassung f WHERE f.id = ?", fassung);
        ObjectNode k = MAPPER.createObjectNode();
        k.put("nr", (Integer) f.get("fassung"));
        k.put("form", (String) f.get("form"));
        k.put("wortlaut", (String) f.get("wortlaut"));
        if (f.get("verweis_ablage") == null) {
            k.putNull("verweis");
        } else {
            k.putObject("verweis").put("ablage", (String) f.get("verweis_ablage"))
                    .put("kennung", (String) f.get("verweis_kennung"));
        }
        try {
            k.set("anwendungsbereich", f.get("bereich") == null ? MAPPER.nullNode()
                    : MAPPER.readTree((String) f.get("bereich")));
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        return BerichtRegeln.kanonisch(k);
    }

    private static String kennzeichen(UUID dokument) {
        return app.queryForObject("SELECT kennzeichen FROM energiemanagement_dokument WHERE id = ?", String.class, dokument);
    }

    private static void protokoll(Kunde k, UUID dokument) {
        app.update("INSERT INTO energiemanagement_aenderung(tenant_id,objekt,objekt_id,art,neu,actor_sub,actor_name,actor_art) "
                + "VALUES (?,'dokument',?,'dokument_angelegt','{}'::jsonb,'IK','Ines Kaltenbach','kunde')", k.tenant(), dokument);
    }

    /**
     * Eine Verbindung der App-Rolle mit Zugriff wie `TenantAwareDataSource`: {@code standorte} = null heißt
     * unternehmensweit, sonst der enge Zaun über genau diese Standorte.
     */
    private static <T> T eng(UUID tenant, List<UUID> standorte, Function<JdbcTemplate, T> arbeit) {
        try (Connection c = ds(POSTGRES.getJdbcUrl(), APP, PW).getConnection()) {
            try (var ps = c.prepareStatement("SELECT set_config('app.tenant_id', ?, false), "
                    + "set_config('app.zugriff', ?, false), set_config('app.standort_ids', ?, false)")) {
                ps.setString(1, tenant.toString());
                ps.setString(2, standorte == null ? "unternehmen" : "standorte");
                ps.setString(3, standorte == null ? null : "{" + String.join(",", standorte.stream().map(UUID::toString)
                        .toList()) + "}");
                ps.execute();
            }
            return arbeit.apply(new JdbcTemplate(new SingleConnectionDataSource(c, true)));
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    private static void checkState(String state, Runnable aktion) {
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
        assertThat(((SQLException) ursache).getSQLState()).as(ursache.getMessage()).isEqualTo("23514");
        assertThat(ursache.getMessage() + " " + ((org.postgresql.util.PSQLException) ursache).getServerErrorMessage()
                .getConstraint()).contains(constraint);
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
