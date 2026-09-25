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
 * AP-19 IP-16: Datenhaltung von internem Audit und Feststellung ({@code V20260925031500}). Abnahme der §8-Zeile: ein
 * zweiter Abschluss scheitert (Audit und Feststellung), ein Stand ohne Begründung scheitert, Einträge nur anhängen; dazu
 * R9 (AU-2029-0001 mit der Prüfsumme des Vertrags), R10/R11 (F-2029-0001, Frist 90 Tage, Stand Nr. 1 „wirksam“ schließt),
 * Vier-Augen (nicht die Urheberin, nicht der Verantwortliche), Zaun, Rechte, Bestand und späte Ankunft.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsAuditFeststellungMigrationTest {

    private static final String DIESE = "20260925031500";
    /** Migrationen, die auf diesen Tabellen AUFBAUEN — in der späten Ankunft kommen sie mit dieser, in Versionsfolge. */
    private static final List<String> BAUEN_DARAUF_AUF = List.of(
            "20260925093000"); // AP-19 IP-23: eine Folge der Managementbewertung nennt ein internes Audit.
    private static final String APP = "voltpilot_app", ADMIN = "voltpilot_admin", PW = "ap19_ip16_test_pw";
    private static final List<String> TABELLEN = List.of("internes_audit", "internes_audit_eintrag", "feststellung",
            "feststellung_eintrag", "feststellung_wirksamkeit");
    private static final String BEGRUENDUNG = "Aufgabe seit 01.03.2029 festgelegt, seither keine Freigabe ohne Zuständige.";
    private static final String UNABHAENGIG = "Claudia Berger (Controlling) gehört nicht zum Energieteam.";
    private static final String F_WORTLAUT = "Wer die Bezugsbasen pflegt und freigibt und wer vertritt, ist nicht festgelegt.";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root, app, admin;
    private static Map<String, String> fingerVorher, fingerNachMigration;
    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** Ein Kundenbereich mit zwei Standorten, den Konten IK, JW, PH und den Personen IK, JW, CB, RF. */
    private record Kunde(UUID tenant, UUID st1, UUID st2, UUID ik, UUID jw, UUID cb, UUID rf) {
    }

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway(POSTGRES.getJdbcUrl()).target(letzteFassungVorDieser()).load().migrate();
        TenantContext.clear();
        UUID t = root.queryForObject("INSERT INTO tenant(name) VALUES ('Bestand') RETURNING id", UUID.class);
        root.update("INSERT INTO unternehmen(tenant_id,name) VALUES (?,'Bestand')", t);
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,'IK','benutzer','Ines','aktiv')", t);
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

    // ============================================================ IA1–IA4: internes Audit (R9)

    /** R9: geplant → durchgeführt → Hinweis → Feststellung → abgeschlossen; die Kopie trägt die Prüfsumme des Vertrags. */
    @Test
    void dasAuditWirdMitDerPruefsummeDesVertragsAbgeschlossenUndEinZweiterAbschlussScheitert() throws IOException {
        Kunde k = kunde("R9");
        TenantContext.set(k.tenant());
        UUID au = audit(k, "{}");
        assertThat(app.queryForObject("SELECT kennzeichen FROM internes_audit WHERE id = ?", String.class, au))
                .isEqualTo("AU-2029-0001");
        // Ein Hinweis entsteht nur am durchgeführten Audit, eine Feststellung aus ihm ebenso.
        checkFehler("internes_audit_eintrag_durchgefuehrt", () -> hinweis(k, au));
        checkFehler("feststellung_audit_durchgefuehrt", () -> feststellung(k, au, null));
        app.update("UPDATE internes_audit SET zustand = 'durchgefuehrt', durchgefuehrt_am = '2029-01-22' WHERE id = ?", au);
        hinweis(k, au);
        UUID f = feststellung(k, au, null);
        assertThat(app.queryForObject("SELECT kennzeichen || ' ' || frist FROM feststellung WHERE id = ?", String.class, f))
                .as("Frist = festgestellt am + 90 Tage (Startwert)").isEqualTo("F-2029-0001 2029-04-22");
        // Durchgeführt ändert sich nur noch der Abschluss.
        checkFehler("internes_audit_uebergang_einmalig",
                () -> app.update("UPDATE internes_audit SET titel = 'Anderer Titel' WHERE id = ?", au));
        // Die Kopie muss die Feststellungen des Audits nennen.
        checkFehler("internes_audit_kopie", () -> abschliessen(au, "{\"bericht\":null,\"feststellungen\":[],"
                + "\"hinweise\":[{\"nr\":1}],\"kennzeichen\":\"AU-2029-0001\"}", null));
        JsonNode vektor = vektor("R9 AU-2029-0001 Abschluss: Prüfsumme der Kopie");
        abschliessen(au, vektor.path("erwartet").path("kanonisch").asText(), "QM-Laufwerk, Ordner Energiemanagement/Audits");
        assertThat(app.queryForObject("SELECT zustand || ' ' || pruefsumme FROM internes_audit WHERE id = ?", String.class,
                au)).isEqualTo("abgeschlossen " + vektor.path("erwartet").path("pruefsumme").asText());
        // Ein zweiter Abschluss scheitert — auch derselbe noch einmal; danach keine Feststellung und kein Hinweis mehr.
        checkFehler("internes_audit_endgueltig", () -> abschliessen(au, vektor.path("erwartet").path("kanonisch").asText(),
                "Anderes Laufwerk"));
        checkFehler("internes_audit_endgueltig",
                () -> app.update("UPDATE internes_audit SET abgeschlossen_am = '2029-02-01' WHERE id = ?", au));
        checkFehler("internes_audit_eintrag_durchgefuehrt", () -> hinweis(k, au));
        checkFehler("feststellung_audit_durchgefuehrt", () -> feststellung(k, au, null));
        // Ein Kommentar bleibt jederzeit möglich (nur anhängen).
        app.update("INSERT INTO internes_audit_eintrag(tenant_id,audit_id,art,wortlaut,actor_sub,actor_name,actor_art) "
                + "VALUES (?,?,'kommentar','Bericht liegt im QM-Laufwerk.','IK','Ines Kaltenbach','kunde')", k.tenant(), au);
    }

    @Test
    void absagenBrauchtEineBegruendungUndIstEndgueltigOhneDurchfuehrungGehtKeinAbschluss() {
        Kunde k = kunde("Absage");
        TenantContext.set(k.tenant());
        UUID au = audit(k, "{}");
        checkFehler("internes_audit_uebergang_einmalig", () -> abschliessen(au, "{}", "QM"));
        checkFehler("internes_audit_abgesagt_chk",
                () -> app.update("UPDATE internes_audit SET zustand = 'abgesagt' WHERE id = ?", au));
        checkFehler("internes_audit_abgesagt_chk", () -> app.update(
                "UPDATE internes_audit SET zustand = 'abgesagt', abgesagt_begruendung = 'zu kurz' WHERE id = ?", au));
        // Geplant ändern sich Termin und Umfang.
        app.update("UPDATE internes_audit SET termin = '2029-01-29', was = 'Nur die Bezugsbasen' WHERE id = ?", au);
        app.update("UPDATE internes_audit SET zustand = 'abgesagt', abgesagt_begruendung = ? WHERE id = ?", BEGRUENDUNG, au);
        checkFehler("internes_audit_endgueltig",
                () -> app.update("UPDATE internes_audit SET zustand = 'geplant', abgesagt_begruendung = NULL WHERE id = ?", au));
        // Unabhängigkeit ist Pflicht (IA1), Auditorinnen sind Personen des Kundenbereichs.
        checkState("23502", () -> app.update("INSERT INTO internes_audit(tenant_id,titel,termin,auditor_ids,was,woran,"
                + "verantwortlich_sub,verantwortlich_name,verantwortlich_konto,actor_sub,actor_name,actor_art) VALUES "
                + "(?,'T','2029-01-22',?::uuid[],'was','woran','IK','Ines','benutzer','IK','Ines','kunde')", k.tenant(),
                "{" + k.cb() + "}"));
        checkState("23503", () -> app.update("INSERT INTO internes_audit(tenant_id,titel,termin,auditor_ids,unabhaengigkeit,"
                + "was,woran,verantwortlich_sub,verantwortlich_name,verantwortlich_konto,actor_sub,actor_name,actor_art) VALUES "
                + "(?,'T','2029-01-22',?::uuid[],?,'was','woran','IK','Ines','benutzer','IK','Ines','kunde')", k.tenant(),
                "{" + UUID.randomUUID() + "}", UNABHAENGIG));
    }

    // ============================================================ FS1, FS2, FS4–FS7: Feststellung (R10, R11)

    /** R11: Stand Nr. 1 „wirksam“ mit der Prüfsumme des Vertrags schließt; ein zweiter Abschluss scheitert. */
    @Test
    void wirksamSchliesstUndEinZweiterAbschlussScheitert() throws IOException {
        Kunde k = kunde("R11");
        TenantContext.set(k.tenant());
        UUID f = feststellung(k, null, null);
        assertThat(app.queryForObject("SELECT kennzeichen FROM feststellung WHERE id = ?", String.class, f))
                .isEqualTo("F-2029-0001");
        // Offen schließt nur ein Stand, nie ein Zustand allein.
        checkFehler("feststellung_uebergang_einmalig",
                () -> app.update("UPDATE feststellung SET zustand = 'abgeschlossen' WHERE id = ?", f));
        JsonNode vektor = vektor("R11 F-2029-0001 Wirksamkeit Stand Nr. 1: Prüfsumme der Kopie");
        UUID stand = stand(k, f, "wirksam", BEGRUENDUNG, "2029-04-15", vektor.path("erwartet").path("kanonisch").asText(),
                false);
        assertThat(app.queryForMap("SELECT w.stand_nr, w.status, w.pruefsumme, f.zustand FROM feststellung_wirksamkeit w "
                + "JOIN feststellung f ON f.id = w.feststellung_id WHERE w.id = ?", stand)).containsEntry("stand_nr", 1)
                .containsEntry("status", "freigegeben").containsEntry("zustand", "abgeschlossen")
                .containsEntry("pruefsumme", vektor.path("erwartet").path("pruefsumme").asText());
        // Ein zweiter Abschluss scheitert — jedes Ergebnis, auch ein weiteres „wirksam“.
        for (String ergebnis : List.of("wirksam", "ohne_massnahme", "zurueckgenommen", "nicht_wirksam")) {
            checkFehler("feststellung_endgueltig", () -> stand(k, f, ergebnis, BEGRUENDUNG, "2029-04-16", null, false));
        }
        checkFehler("feststellung_endgueltig", () -> app.update("UPDATE feststellung SET frist = '2029-05-01' WHERE id = ?", f));
        // Nach dem Abschluss nur noch ein Kommentar.
        checkFehler("feststellung_endgueltig", () -> eintrag(k, f, "behebung"));
        eintrag(k, f, "kommentar");
        // Auch der Unique-Index hält: höchstens ein schließender Stand je Feststellung.
        assertThat(root.queryForObject("SELECT indexdef FROM pg_indexes WHERE indexname = "
                + "'feststellung_wirksamkeit_ein_abschluss_uq'", String.class))
                .contains("UNIQUE").contains("wirksam").contains("ohne_massnahme").contains("zurueckgenommen")
                .doesNotContain("nicht_wirksam");
    }

    /** FS4/FS5: ein Stand ohne Begründung scheitert; `nicht_wirksam` hält offen, Nr. lückenlos, dann schließt Nr. 2. */
    @Test
    void einStandOhneBegruendungScheitertUndNichtWirksamHaeltOffen() {
        Kunde k = kunde("FS4");
        TenantContext.set(k.tenant());
        UUID f = feststellung(k, null, null);
        checkState("23502", () -> stand(k, f, "nicht_wirksam", null, "2029-04-15", null, false));
        checkFehler("feststellung_wirksamkeit_begruendung_chk",
                () -> stand(k, f, "zurueckgenommen", "zu kurz", "2029-04-15", null, false));
        checkFehler("feststellung_wirksamkeit_begruendung_chk",
                () -> stand(k, f, "ohne_massnahme", "          x", "2029-04-15", null, false));
        checkFehler("feststellung_wirksamkeit_ergebnis_chk",
                () -> stand(k, f, "teilweise", BEGRUENDUNG, "2029-04-15", null, false));
        // Die Kopie nennt die Feststellung und den Tag des Stands.
        checkFehler("feststellung_wirksamkeit_kopie", () -> stand(k, f, "wirksam", BEGRUENDUNG, "2029-04-15",
                "{\"am\":\"2029-04-14\",\"feststellung\":\"F-2029-0001\"}", false));
        UUID eins = stand(k, f, "nicht_wirksam", BEGRUENDUNG, "2029-04-15", null, false);
        assertThat(app.queryForObject("SELECT zustand FROM feststellung WHERE id = ?", String.class, f)).isEqualTo("offen");
        UUID zwei = stand(k, f, "ohne_massnahme", BEGRUENDUNG, "2029-05-02", null, false);
        assertThat(app.queryForList("SELECT stand_nr FROM feststellung_wirksamkeit WHERE id IN (?, ?) ORDER BY stand_nr",
                Integer.class, eins, zwei)).containsExactly(1, 2);
        assertThat(app.queryForObject("SELECT zustand FROM feststellung WHERE id = ?", String.class, f))
                .isEqualTo("abgeschlossen");
        // Ein Stand wird nie zurückgenommen oder geändert (FS7): die App-Rolle darf die Spalten nicht, die Datenbank sperrt.
        checkState("42501", () -> app.update("UPDATE feststellung_wirksamkeit SET begruendung = ? WHERE id = ?",
                BEGRUENDUNG + " (neu)", eins));
        checkFehler("feststellung_wirksamkeit_einmalig",
                () -> root.update("UPDATE feststellung_wirksamkeit SET ergebnis = 'wirksam' WHERE id = ?", eins));
        checkFehler("feststellung_wirksamkeit_einmalig",
                () -> app.update("UPDATE feststellung_wirksamkeit SET status = 'abgelehnt', entscheidungs_begruendung = 'x' "
                        + "WHERE id = ?", zwei));
    }

    /** FS6: Vier-Augen — die zweite Person ist nie die Urheberin (IK) und nie der Verantwortliche (JW). */
    @Test
    void vierAugenNieDieUrheberinUndNieDerVerantwortliche() {
        Kunde k = kunde("FS6");
        TenantContext.set(k.tenant());
        UUID f = feststellung(k, null, null);
        UUID antrag = stand(k, f, "wirksam", BEGRUENDUNG, "2029-04-15", null, true);
        assertThat(app.queryForObject("SELECT w.status || ' ' || f.zustand FROM feststellung_wirksamkeit w JOIN feststellung f "
                + "ON f.id = w.feststellung_id WHERE w.id = ?", String.class, antrag)).isEqualTo("beantragt offen");
        checkFehler("feststellung_wirksamkeit_antrag_offen",
                () -> stand(k, f, "nicht_wirksam", BEGRUENDUNG, "2029-04-16", null, false));
        checkFehler("feststellung_wirksamkeit_entscheidung_chk", () -> entscheiden(antrag, "IK", "freigegeben"));
        checkFehler("feststellung_wirksamkeit_vieraugen_verantwortlich", () -> entscheiden(antrag, "JW", "freigegeben"));
        checkFehler("feststellung_wirksamkeit_vieraugen_verantwortlich", () -> entscheiden(antrag, "JW", "abgelehnt"));
        entscheiden(antrag, "PH", "abgelehnt");
        assertThat(app.queryForObject("SELECT zustand FROM feststellung WHERE id = ?", String.class, f)).isEqualTo("offen");
        UUID neu = stand(k, f, "wirksam", BEGRUENDUNG, "2029-04-20", null, true);
        entscheiden(neu, "PH", "freigegeben");
        assertThat(app.queryForMap("SELECT w.stand_nr, f.zustand FROM feststellung_wirksamkeit w JOIN feststellung f "
                + "ON f.id = w.feststellung_id WHERE w.id = ?", neu)).containsEntry("stand_nr", 2)
                .containsEntry("zustand", "abgeschlossen");
        checkFehler("feststellung_wirksamkeit_einmalig", () -> entscheiden(neu, "PH", "abgelehnt"));
    }

    /** FS1/FS2/FS7: Quelle mit genau ihrem Verweis, Vorgabe, Bezug; Einträge mit Person und Tag, nur anhängen. */
    @Test
    void quelleVorgabeBezugUndEintraegeNurAnhaengen() {
        Kunde k = kunde("FS1");
        TenantContext.set(k.tenant());
        UUID f = feststellung(k, null, k.st1());
        checkFehler("feststellung_quelle_chk", () -> app.update("INSERT INTO feststellung(tenant_id,quelle_art,wortlaut,"
                + "vorgabe_wortlaut,festgestellt_von,festgestellt_am,verantwortlich_sub,verantwortlich_name,"
                + "verantwortlich_konto,actor_sub,actor_name,actor_art) VALUES (?,'extern',?,'Vorgabe',?,'2029-01-22','JW',"
                + "'Jonas','benutzer','IK','Ines','kunde')", k.tenant(), F_WORTLAUT, k.cb()));
        checkFehler("feststellung_quelle_chk", () -> app.update("INSERT INTO feststellung(tenant_id,quelle_art,quelle_kennung,"
                + "wortlaut,vorgabe_wortlaut,festgestellt_von,festgestellt_am,verantwortlich_sub,verantwortlich_name,"
                + "verantwortlich_konto,actor_sub,actor_name,actor_art) VALUES (?,'managementbewertung','BR-2029-0001',?,"
                + "'Vorgabe',?,'2029-01-22','JW','Jonas','benutzer','IK','Ines','kunde')", k.tenant(), F_WORTLAUT, k.cb()));
        checkFehler("feststellung_vorgabe_chk", () -> app.update("INSERT INTO feststellung(tenant_id,quelle_art,wortlaut,"
                + "festgestellt_von,festgestellt_am,verantwortlich_sub,verantwortlich_name,verantwortlich_konto,actor_sub,"
                + "actor_name,actor_art) VALUES (?,'eigene',?,?,'2029-01-22','JW','Jonas','benutzer','IK','Ines','kunde')",
                k.tenant(), F_WORTLAUT, k.cb()));
        checkFehler("feststellung_bezug_chk", () -> app.update("INSERT INTO feststellung(tenant_id,quelle_art,wortlaut,"
                + "vorgabe_wortlaut,bezug_objekte,festgestellt_von,festgestellt_am,verantwortlich_sub,verantwortlich_name,"
                + "verantwortlich_konto,actor_sub,actor_name,actor_art) VALUES (?,'eigene',?,'Vorgabe','{BB-0001,BB-0001}',?,"
                + "'2029-01-22','JW','Jonas','benutzer','IK','Ines','kunde')", k.tenant(), F_WORTLAUT, k.cb()));
        checkFehler("feststellung_kennzeichen_jahr_chk", () -> app.update("INSERT INTO feststellung(tenant_id,kennzeichen,"
                + "quelle_art,wortlaut,vorgabe_wortlaut,festgestellt_von,festgestellt_am,verantwortlich_sub,"
                + "verantwortlich_name,verantwortlich_konto,actor_sub,actor_name,actor_art,angelegt_am) VALUES (?,"
                + "'F-2028-0007','eigene',?,'Vorgabe',?,'2029-01-22','JW','Jonas','benutzer','IK','Ines','kunde',"
                + "'2029-01-23 10:00+01')", k.tenant(), F_WORTLAUT, k.cb()));
        // Wortlaut, Quelle und Vorgabe ändern sich nie; offen nur Frist und Verantwortlich.
        checkState("42501", () -> app.update("UPDATE feststellung SET wortlaut = 'anders' WHERE id = ?", f));
        checkFehler("feststellung_identitaet_bleibt",
                () -> root.update("UPDATE feststellung SET wortlaut = 'anders' WHERE id = ?", f));
        app.update("UPDATE feststellung SET frist = '2029-05-31', verantwortlich_sub = 'PH', verantwortlich_name = 'Peter' "
                + "WHERE id = ?", f);
        checkFehler("feststellung_frist_chk", () -> app.update("UPDATE feststellung SET frist = '2029-01-01' WHERE id = ?", f));
        // Einträge: jede Art mit Person und Tag; nur anhängen.
        for (String art : List.of("kommentar", "behebung", "ursache_aussage", "aehnliche_faelle")) {
            eintrag(k, f, art);
        }
        checkState("23502", () -> app.update("INSERT INTO feststellung_eintrag(tenant_id,feststellung_id,art,am,wortlaut,"
                + "actor_sub,actor_name,actor_art) VALUES (?,?,'ursache_aussage','2029-01-25','Aussage ohne Person','IK',"
                + "'Ines','kunde')", k.tenant(), f));
        checkFehler("feststellung_eintrag_art_chk", () -> eintrag(k, f, "systemsatz"));
        long eintragId = app.queryForObject("SELECT min(id) FROM feststellung_eintrag WHERE feststellung_id = ?", Long.class, f);
        checkState("42501", () -> app.update("UPDATE feststellung_eintrag SET wortlaut = 'anders' WHERE id = ?", eintragId));
        checkState("42501", () -> app.update("DELETE FROM feststellung_eintrag WHERE id = ?", eintragId));
    }

    // ============================================================ Protokoll, Zaun, Rechte

    @Test
    void dasProtokollKenntAuditUndFeststellung() {
        Kunde k = kunde("Protokoll");
        TenantContext.set(k.tenant());
        UUID au = audit(k, "{}");
        UUID f = feststellung(k, null, k.st1());
        for (Object[] z : new Object[][] {{"internes_audit", au, "audit_geplant"}, {"feststellung", f, "feststellung_erfasst"},
                {"feststellung", f, "wirksamkeit_geprueft"}, {"feststellung", f, "feststellung_abgeschlossen"}}) {
            app.update("INSERT INTO energiemanagement_aenderung(tenant_id,objekt,objekt_id,art,neu,actor_sub,actor_name,"
                    + "actor_art) VALUES (?,?,?,?,'{}'::jsonb,'IK','Ines Kaltenbach','kunde')", k.tenant(), z[0], z[1], z[2]);
        }
        checkState("23514", () -> app.update("INSERT INTO energiemanagement_aenderung(tenant_id,objekt,art,neu,actor_sub,"
                + "actor_name,actor_art) VALUES (?,'feststellung','feststellung_erfasst','{}'::jsonb,'IK','Ines','kunde')",
                k.tenant()));
        // Der Standort-Leser von ST-1 sieht das Protokoll der Feststellung an ST-1, nicht das des Audits am Unternehmen.
        List<String> objekte = eng(k.tenant(), List.of(k.st1()), j -> j.queryForList("SELECT objekt FROM "
                + "energiemanagement_aenderung ORDER BY id", String.class));
        assertThat(objekte).containsExactly("feststellung", "feststellung", "feststellung");
    }

    @Test
    void derStandortZaunZeigtAuditsNurMitAllenStandortenUndFeststellungenNurAmStandort() {
        Kunde k = kunde("Zaun");
        TenantContext.set(k.tenant());
        UUID auU = audit(k, "{}");
        UUID au1 = audit(k, "{" + k.st1() + "}");
        UUID au12 = audit(k, "{" + k.st1() + "," + k.st2() + "}");
        UUID fU = feststellung(k, null, null);
        UUID f1 = feststellung(k, null, k.st1());
        UUID f2 = feststellung(k, null, k.st2());
        eintrag(k, f1, "kommentar");
        eintrag(k, f2, "kommentar");
        stand(k, f1, "nicht_wirksam", BEGRUENDUNG, "2029-04-15", null, false);
        stand(k, f2, "nicht_wirksam", BEGRUENDUNG, "2029-04-15", null, false);
        assertThat(ids(k.tenant(), null, "SELECT id FROM internes_audit")).containsExactlyInAnyOrder(auU, au1, au12);
        assertThat(ids(k.tenant(), List.of(k.st1()), "SELECT id FROM internes_audit")).containsExactly(au1);
        assertThat(ids(k.tenant(), List.of(k.st1(), k.st2()), "SELECT id FROM internes_audit"))
                .containsExactlyInAnyOrder(au1, au12);
        assertThat(ids(k.tenant(), List.of(k.st1()), "SELECT id FROM feststellung")).containsExactly(f1);
        assertThat(ids(k.tenant(), List.of(k.st1()), "SELECT feststellung_id FROM feststellung_eintrag "
                + "UNION ALL SELECT feststellung_id FROM feststellung_wirksamkeit")).containsOnly(f1).hasSize(2);
        assertThat(ids(k.tenant(), null, "SELECT id FROM feststellung")).containsExactlyInAnyOrder(fU, f1, f2);
        // Mandanten-Zaun: ein anderer Kundenbereich sieht nichts davon.
        Kunde b = kunde("Anderer Mandant");
        assertThat(ids(b.tenant(), null, "SELECT id FROM internes_audit UNION ALL SELECT id FROM feststellung "
                + "UNION ALL SELECT id FROM feststellung_wirksamkeit")).isEmpty();
    }

    @Test
    void dieRechteSindBeschnittenUndDasOffboardingRaeumtAb() {
        for (String t : TABELLEN) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = ?::regclass",
                    Boolean.class, t)).as(t + " RLS + FORCE").isTrue();
            assertThat(root.queryForObject("SELECT has_table_privilege(?, ?, 'SELECT') AND has_table_privilege(?, ?, 'INSERT')",
                    Boolean.class, APP, t, APP, t)).as(t).isTrue();
            assertThat(root.queryForObject("SELECT has_table_privilege(?, ?, 'DELETE') OR has_table_privilege(?, ?, 'TRUNCATE')",
                    Boolean.class, APP, t, APP, t)).as(t + " kein DELETE").isFalse();
            assertThat(root.queryForObject("SELECT has_table_privilege(?, ?, 'DELETE')", Boolean.class, ADMIN, t))
                    .as(t + " Offboarding").isTrue();
            assertThat(root.queryForObject("SELECT count(*) FROM pg_policies WHERE tablename = ? AND policyname = 'site_scope' "
                    + "AND permissive = 'RESTRICTIVE'", Integer.class, t)).as(t + " site_scope").isOne();
            assertThat(root.queryForObject("SELECT count(*) FROM pg_policies WHERE tablename = ? AND permissive = 'PERMISSIVE'",
                    Integer.class, t)).as(t + " nur die Mandanten-Policy öffnet").isOne();
        }
        for (String t : List.of("internes_audit_eintrag", "feststellung_eintrag")) {
            assertThat(root.queryForObject("SELECT has_table_privilege(?, ?, 'UPDATE')", Boolean.class, APP, t))
                    .as(t + " nur anhängen").isFalse();
        }
        for (String s : List.of("internes_audit_eintrag_id_seq", "feststellung_eintrag_id_seq")) {
            assertThat(root.queryForObject("SELECT has_sequence_privilege(?, ?, 'USAGE')", Boolean.class, APP, s)).as(s)
                    .isTrue();
        }
        Kunde k = kunde("Offboarding");
        TenantContext.set(k.tenant());
        UUID au = audit(k, "{" + k.st1() + "}");
        app.update("UPDATE internes_audit SET zustand = 'durchgefuehrt', durchgefuehrt_am = '2029-01-22' WHERE id = ?", au);
        hinweis(k, au);
        UUID f = feststellung(k, au, k.st1());
        eintrag(k, f, "behebung");
        stand(k, f, "nicht_wirksam", BEGRUENDUNG, "2029-04-15", null, false);
        app.update("INSERT INTO energiemanagement_aenderung(tenant_id,objekt,objekt_id,art,neu,actor_sub,actor_name,actor_art) "
                + "VALUES (?,'feststellung',?,'feststellung_erfasst','{}'::jsonb,'IK','Ines Kaltenbach','kunde')", k.tenant(), f);
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
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
        for (String tabelle : TABELLEN) {
            assertThat(fingerNachMigration).as(tabelle).containsEntry(tabelle, Bestandsschutz.LEER);
        }
    }

    @Test
    void derBestandsvergleichFaengtEineGeaenderteZeile() {
        Bestandsschutz.mutationsprobe(root, List.of(), "unternehmen", "UPDATE unternehmen SET name = name || ' (Probe)'");
    }

    /** Die Protokoll-Wörter von IP-5 bleiben an ihrer Stelle, die neuen folgen lückenlos (Vereinigung, nie enger). */
    @Test
    void dasVokabularWirdNurGeweitet() {
        assertThat(root.queryForList("SELECT wort FROM energiemanagement_vokabular() WHERE vokabular = "
                + "'energiemanagement_protokoll' AND nr <= 16 ORDER BY nr", String.class)).hasSize(16)
                .startsWith("person_erfasst").endsWith("einstellung_geaendert");
        assertThat(root.queryForList("SELECT wort FROM energiemanagement_vokabular() WHERE vokabular = "
                + "'energiemanagement_protokoll' AND nr > 16 ORDER BY nr", String.class)).containsExactly("audit_geplant",
                "audit_geaendert", "audit_durchgefuehrt", "hinweis", "audit_abgesagt", "audit_abgeschlossen",
                "feststellung_erfasst", "eintrag", "feststellung_geaendert", "wirksamkeit_beantragt", "wirksamkeit_geprueft",
                "wirksamkeit_abgelehnt", "feststellung_abgeschlossen");
        assertThat(root.queryForObject("SELECT count(*) FROM energiemanagement_vokabular() WHERE vokabular <> "
                + "'energiemanagement_protokoll'", Integer.class)).as("kein anderer Block wächst").isEqualTo(147 - 16);
    }

    /** Out-of-order: auf einer Datenbank mit ALLEN anderen Migrationen kommt diese zuletzt an und trägt genauso. */
    @Test
    void dieMigrationTraegtAuchAlsSpaeteAnkunft() throws IOException {
        root.execute("CREATE DATABASE voltpilot_spaet");
        String url = POSTGRES.getJdbcUrl().replace("/voltpilot?", "/voltpilot_spaet?");
        Path ohneDiese = Files.createTempDirectory("ohne-audit-feststellung");
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
        List<String> alle = new ArrayList<>(TABELLEN);
        alle.add("energiemanagement_aenderung");
        String tabellen = "(" + String.join(", ", alle.stream().map(t -> "'" + t + "'").toList()) + ")";
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

    /** Ein Kundenbereich mit Unternehmen, zwei Standorten, den Konten IK, JW, PH und vier Personen. */
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
        UUID[] personen = new UUID[4];
        String[][] namen = {{"Ines Kaltenbach", "Energiemanagerin", "IK"}, {"Jonas Wendlinger", "Instandhaltung", "JW"},
                {"Claudia Berger", "Controlling", "CB"}, {"Robert Falk", "Geschäftsführer", "RF"}};
        for (int i = 0; i < namen.length; i++) {
            personen[i] = root.queryForObject("INSERT INTO energiemanagement_person(tenant_id,name,funktion,kuerzel,konto_sub,"
                    + "actor_sub,actor_name,actor_art) VALUES (?,?,?,?,?,'IK','Ines Kaltenbach','kunde') RETURNING id",
                    UUID.class, tenant, namen[i][0], namen[i][1], namen[i][2], i < 2 ? namen[i][2] : null);
        }
        return new Kunde(tenant, st1, st2, personen[0], personen[1], personen[2], personen[3]);
    }

    /** AU-…, angelegt am 10.01.2029 für den 22.01.2029, Auditorin Claudia Berger, verantwortlich IK. */
    private static UUID audit(Kunde k, String standorte) {
        return app.queryForObject("INSERT INTO internes_audit(tenant_id,titel,termin,auditor_ids,unabhaengigkeit,was,woran,"
                + "verantwortlich_sub,verantwortlich_name,verantwortlich_konto,standort_ids,actor_sub,actor_name,actor_rolle,"
                + "actor_art,angelegt_am) VALUES (?,'Internes Audit 2029','2029-01-22',?::uuid[],?,'Bezugsbasen und Energieziel',"
                + "'Energiepolitik D-0001 Fassung 1','IK','Ines Kaltenbach','benutzer',?::uuid[],'IK','Ines Kaltenbach',"
                + "'energiemanager','kunde','2029-01-10 09:00+01') RETURNING id", UUID.class, k.tenant(), "{" + k.cb() + "}",
                UNABHAENGIG, standorte);
    }

    private static void hinweis(Kunde k, UUID audit) {
        app.update("INSERT INTO internes_audit_eintrag(tenant_id,audit_id,art,am,festgestellt_von,wortlaut,actor_sub,"
                + "actor_name,actor_rolle,actor_art) VALUES (?,?,'hinweis','2029-01-22',?,'Neue Mitarbeitende lernen die "
                + "Energiepolitik nicht kennen.','IK','Ines Kaltenbach','energiemanager','kunde')", k.tenant(), audit, k.cb());
    }

    /** Abschluss durch IK, entschieden von IK, am 31.01.2029 — mit Bericht-Verweis, wenn eine Ablage gegeben ist. */
    private static void abschliessen(UUID audit, String kopie, String ablage) {
        UUID ik = app.queryForObject("SELECT p.id FROM energiemanagement_person p JOIN internes_audit a ON a.tenant_id = "
                + "p.tenant_id WHERE a.id = ? AND p.kuerzel = 'IK'", UUID.class, audit);
        app.update("UPDATE internes_audit SET zustand = 'abgeschlossen', entschieden_von = ?, abgeschlossen_am = '2029-01-31', "
                + "zusammenfassung = 'Ein Hinweis, eine Feststellung.', bericht_bezeichnung = CASE WHEN ?::text IS NULL THEN "
                + "NULL ELSE 'Bericht internes Audit 2029, unterschrieben' END, bericht_ablage = ?, bericht_kennung = CASE WHEN "
                + "?::text IS NULL THEN NULL ELSE 'IA-2029' END, kopie = ?, pruefsumme = bericht_pruefsumme(?), "
                + "abschluss_sub = 'IK', abschluss_name = 'Ines Kaltenbach', abschluss_rolle = 'energiemanager', "
                + "abschluss_art = 'kunde', abschluss_eingetragen_am = '2029-01-31 16:00+01' WHERE id = ?", ik, ablage, ablage,
                ablage, kopie, kopie, audit);
    }

    /** F-…, festgestellt von CB am 22.01.2029, eingetragen am 23.01.2029, verantwortlich JW, Frist vom Trigger. */
    private static UUID feststellung(Kunde k, UUID audit, UUID standort) {
        return app.queryForObject("INSERT INTO feststellung(tenant_id,quelle_art,audit_id,wortlaut,vorgabe_wortlaut,standort_id,"
                + "bezug_aufgabe,bezug_objekte,festgestellt_von,festgestellt_am,verantwortlich_sub,verantwortlich_name,"
                + "verantwortlich_konto,actor_sub,actor_name,actor_rolle,actor_art,angelegt_am) VALUES (?,?,?,?,"
                + "'„Wir legen fest, wer im Energiemanagement wofür zuständig ist.“',?,'bezugsbasen','{BB-0001,BB-0002}',?,"
                + "'2029-01-22','JW','Jonas Wendlinger','benutzer','IK','Ines Kaltenbach','energiemanager','kunde',"
                + "'2029-01-23 10:00+01') RETURNING id", UUID.class, k.tenant(), audit == null ? "eigene" : "internes_audit",
                audit, F_WORTLAUT, standort, k.cb());
    }

    private static void eintrag(Kunde k, UUID feststellung, String art) {
        app.update("INSERT INTO feststellung_eintrag(tenant_id,feststellung_id,art,am,person_id,wortlaut,actor_sub,actor_name,"
                + "actor_rolle,actor_art) VALUES (?,?,?,'2029-01-25',?,'Aussage der Energiemanagerin.','IK','Ines Kaltenbach',"
                + "'energiemanager','kunde')", k.tenant(), feststellung, art, k.ik());
    }

    /** Ein Stand, festgehalten von IK (Konto), entschieden von IK; ohne Kopie die kleinste passende. */
    private static UUID stand(Kunde k, UUID feststellung, String ergebnis, String begruendung, String tag, String kopie,
            boolean vieraugen) {
        String kennzeichen = app.queryForObject("SELECT kennzeichen FROM feststellung WHERE id = ?", String.class, feststellung);
        String text = kopie;
        if (text == null) {
            ObjectNode n = MAPPER.createObjectNode();
            n.put("feststellung", kennzeichen);
            n.put("am", tag);
            n.putArray("massnahmen");
            text = BerichtRegeln.kanonisch(n);
        }
        return app.queryForObject("INSERT INTO feststellung_wirksamkeit(tenant_id,feststellung_id,ergebnis,begruendung,"
                + "entschieden_von,entschieden_tag,kopie,pruefsumme,vieraugen,status,freigabe_sub,freigabe_name,freigabe_rolle,"
                + "freigabe_art,freigabe_am) VALUES (?,?,?,?,?,?,?,bericht_pruefsumme(?),?,?,'IK','Ines Kaltenbach',"
                + "'energiemanager','kunde',?) RETURNING id", UUID.class, k.tenant(), feststellung, ergebnis, begruendung,
                k.ik(), Date.valueOf(tag), text, text, vieraugen, vieraugen ? "beantragt" : "freigegeben",
                Timestamp.valueOf(tag + " 10:00:00"));
    }

    private static void entscheiden(UUID stand, String sub, String status) {
        app.update("UPDATE feststellung_wirksamkeit SET status = ?, entscheidung_sub = ?, entscheidung_name = ?, "
                + "entscheidung_rolle = 'kundenadministrator', entscheidung_art = 'kunde', entschieden_am = now(), "
                + "entscheidungs_begruendung = CASE WHEN ? = 'abgelehnt' THEN 'Die Aufgabe ist noch nicht vergeben.' END "
                + "WHERE id = ?", status, sub, sub, status, stand);
    }

    private static JsonNode vektor(String name) throws IOException {
        JsonNode vertrag = MAPPER.readTree(Path.of("../../docs/contracts/v2/energiemanagement-vectors.json").toFile());
        for (JsonNode c : vertrag.path("cases")) {
            if (c.path("name").asText().equals(name)) {
                return c;
            }
        }
        throw new IllegalStateException("Vektor fehlt: " + name);
    }

    private static List<UUID> ids(UUID tenant, List<UUID> standorte, String sql) {
        return eng(tenant, standorte, j -> j.queryForList(sql, UUID.class));
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
