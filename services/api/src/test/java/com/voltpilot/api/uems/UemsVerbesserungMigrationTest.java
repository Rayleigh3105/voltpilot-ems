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
import java.sql.Connection;
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
 * AP-18 IP-5: die gemeinsame Datenhaltung der Vorgänge und das Energieziel (Z1, Z2, RE1, RE2) unter der wirklichen
 * App-Rolle. Die Datenbank hält „ein Ziel zitiert eine freigegebene Fassung“, „je Kennzahl und Zielperiode höchstens
 * ein laufendes Ziel“, den lückenlosen Kennzeichen-Zähler (EZ-2028-0001 am 20.12.2027), die einmaligen Übergänge,
 * Vier-Augen, den Mandanten- und den Standort-Zaun und die Rechte selbst; die Migration legt nur daneben und trägt
 * auch als späte Ankunft.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsVerbesserungMigrationTest {

    private static final String DIESE = "20260924223000";
    private static final String APP = "voltpilot_app", ADMIN = "voltpilot_admin", PW = "ap18_ip5_test_pw";
    private static final List<String> TABELLEN = List.of("verbesserung_kennung_seq", "energieziel",
            "energieziel_aenderung");
    private static final String BEGRUENDUNG = "Jahresplanung 2028 nach der Freigabe der Fassung 2 (24.11.2027).";
    private static final String AM_20_12_2027 = "2027-12-20 10:00:00";
    /** Spätere Migrationen, die auf diese aufbauen: sie reisen bei der späten Ankunft mit. */
    private static final List<String> BAUEN_DARAUF_AUF = List.of(
            "20260924233000", // AP-18 IP-9: die Maßnahme zitiert Energieziel, Zähler und Vokabular.
            "20260924235130", // AP-18 IP-14: die Abweichung zitiert Zähler und Vokabular.
            "20260925040000", // AP-19 IP-17: tauscht den Herkunft-CHECK der Maßnahme und weitet das Vokabular.
            "20260925093000", // AP-19 IP-23: eine Folge der Managementbewertung nennt ein Energieziel.
            "20260926001500"); // Folge zu AP-19 IP-12: weitet die Akteur-Rollen-CHECKs um einsicht.

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root, app, admin;
    private static Map<String, String> fingerVorher, fingerNachMigration;
    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** Ein Kundenbereich mit zwei Standorten, einer Unternehmens- und einer Standort-Kennzahl samt freigegebener Basis. */
    private record Kunde(UUID tenant, UUID unternehmen, UUID st1, UUID st2, UUID kennzahl, UUID basis,
            UUID kennzahlSt1, UUID basisSt1, UUID kennzahlSt2, UUID basisSt2) {
    }

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway(POSTGRES.getJdbcUrl()).target(letzteFassungVorDieser()).load().migrate();
        // Bestand vor der Migration: Kennzahl, Benutzer, Bezugsbasis mit Fassungen.
        TenantContext.clear();
        kundeBestand("Kunststoffwerk Ahrenberg GmbH");
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

    // ============================================================ Z1: die zitierte Fassung ist freigegeben

    @Test
    void einZielOhneFreigegebeneFassungScheitertAnDerDatenbank() {
        Kunde k = kunde("Z1 Fassung");
        TenantContext.set(k.tenant());
        // Fassung 2 ist ein Entwurf: nicht freigegeben, also kein Ziel daran.
        root.update("INSERT INTO bezugsbasis_fassung(tenant_id,bezugsbasis_id,fassung,referenzperiode,methode,datenlage,"
                + "gilt_ab,actor_sub,actor_name,actor_rolle,actor_art) VALUES (?,?,2,'2026-11/2027-10','verhaeltnis',"
                + "'vollstaendig','2027-11-01','IK','Ines Kaltenbach','energiemanager','kunde')", k.tenant(), k.basis());
        checkFehler("energieziel_fassung_freigegeben_chk", () -> ziel(k, k.kennzahl(), k.basis(), 2, null, Map.of()));
        // Eine Fassung, die es nicht gibt, fängt der Fremdschlüssel.
        checkState("23503", () -> ziel(k, k.kennzahl(), k.basis(), 9, null, Map.of()));
        // Die Basis einer anderen Kennzahl ist nicht die Basis dieses Ziels.
        checkFehler("energieziel_basis_der_kennzahl_chk", () -> ziel(k, k.kennzahl(), k.basisSt1(), 1, k.st1(), Map.of()));
        // Eine beendete Fassung gilt nicht mehr.
        root.update("UPDATE bezugsbasis_fassung SET gilt_bis = DATE '2027-10-31', beendet_am = now(), "
                + "beendet_grund = 'Fassung 2 folgt' WHERE tenant_id = ? AND bezugsbasis_id = ? AND fassung = 1",
                k.tenant(), k.basisSt2());
        checkFehler("energieziel_fassung_freigegeben_chk",
                () -> ziel(k, k.kennzahlSt2(), k.basisSt2(), 1, k.st2(), Map.of()));
        // Die freigegebene, geltende Fassung trägt das Ziel.
        UUID ziel = ziel(k, k.kennzahl(), k.basis(), 1, null, Map.of());
        assertThat(app.queryForObject("SELECT zustand FROM energieziel WHERE id = ?", String.class, ziel)).isEqualTo("offen");
        // Ein Ziel entsteht offen und unbewertet.
        checkFehler("energieziel_entsteht_offen",
                () -> ziel(k, k.kennzahlSt1(), k.basisSt1(), 1, k.st1(), Map.of("zustand", "bewertet")));
    }

    // ============================================================ Z1: ein laufendes Ziel je Kennzahl und Zielperiode

    @Test
    void einZweitesLaufendesZielDerselbenKennzahlUndZielperiodeScheitertAmPartiellenIndex() {
        Kunde k = kunde("Z1 laufend");
        TenantContext.set(k.tenant());
        UUID erstes = ziel(k, k.kennzahl(), k.basis(), 1, null, Map.of());
        checkState("23505", () -> ziel(k, k.kennzahl(), k.basis(), 1, null, Map.of()));
        // Eine andere Zielperiode derselben Kennzahl ist ein eigenes Ziel.
        ziel(k, k.kennzahl(), k.basis(), 1, null, Map.of("zielperiode", "2029-01/2029-12"));
        // Vorzeitig beendet (Tag, Begründung): danach darf dieselbe Zielperiode wieder ein laufendes Ziel tragen.
        app.update("UPDATE energieziel SET zustand = 'beendet', beendet_zum = DATE '2028-03-31', beendet_am = now(), "
                + "beendet_grund = 'Bezugsbasis beendet, Ziel aufgegeben' WHERE id = ?", erstes);
        UUID neues = ziel(k, k.kennzahl(), k.basis(), 1, null, Map.of());
        // Die gescheiterte Anlage hat keine Nummer verbraucht; 2029 zählt eine eigene Reihe.
        assertThat(kennzeichen(neues)).isEqualTo("EZ-2028-0002");
    }

    // ============================================================ Z1/LA6: der Kennzeichen-Zähler

    @Test
    void derZaehlerVergibtEz2028_0001AmZwanzigstenDezember2027LueckenlosJeKundenbereichArtUndJahr() {
        Kunde k = kunde("Z1 Zähler");
        TenantContext.set(k.tenant());
        UUID ez = ziel(k, k.kennzahl(), k.basis(), 1, null, Map.of());
        assertThat(kennzeichen(ez)).as("angelegt am 20.12.2027, Zielperiode 2028").isEqualTo("EZ-2028-0001");
        // Eine gescheiterte Anlage rollt ihre Nummer zurück: kein Loch.
        checkFehler("energieziel_begruendung_chk",
                () -> ziel(k, k.kennzahlSt1(), k.basisSt1(), 1, k.st1(), Map.of("begruendung", "zu kurz")));
        assertThat(kennzeichen(ziel(k, k.kennzahlSt1(), k.basisSt1(), 1, k.st1(), Map.of()))).isEqualTo("EZ-2028-0002");
        assertThat(kennzeichen(ziel(k, k.kennzahl(), k.basis(), 1, null, Map.of("zielperiode", "2029-01/2029-12"))))
                .isEqualTo("EZ-2029-0001");
        // Ein ausdrücklich gesetztes Kennzeichen rückt den Zähler dahinter.
        ziel(k, k.kennzahlSt2(), k.basisSt2(), 1, k.st2(), Map.of("kennzeichen", "EZ-2028-0007"));
        assertThat(kennzeichen(ziel(k, k.kennzahlSt1(), k.basisSt1(), 1, k.st1(),
                Map.of("zielperiode", "2028-01/2028-06")))).isEqualTo("EZ-2028-0008");
        // Das Jahr im Kennzeichen ist das erste Jahr der Zielperiode.
        checkFehler("energieziel_kennzeichen_chk", () -> ziel(k, k.kennzahlSt2(), k.basisSt2(), 1, k.st2(),
                Map.of("kennzeichen", "EZ-2027-0001", "zielperiode", "2028-07/2028-12")));
        // M und AW zählen eigene Reihen, das Jahr sagt der Aufrufer (IP-9, IP-14).
        assertThat(app.queryForObject("SELECT uems_verbesserung_kennung(?, 'M', 2028)", String.class, k.tenant()))
                .isEqualTo("M-2028-0001");
        assertThat(app.queryForObject("SELECT uems_verbesserung_kennung(?, 'M', 2028)", String.class, k.tenant()))
                .isEqualTo("M-2028-0002");
        assertThat(app.queryForObject("SELECT uems_verbesserung_kennung(?, 'AW', 2028)", String.class, k.tenant()))
                .isEqualTo("AW-2028-0001");
        checkFehler("verbesserung_kennung_seq_art_chk",
                () -> app.queryForObject("SELECT uems_verbesserung_kennung(?, 'BR', 2028)", String.class, k.tenant()));
        // Der Zähler rückt nie zurück.
        checkFehler("verbesserung_kennung_seq_rueckt_nur_vor", () -> app.update("UPDATE verbesserung_kennung_seq "
                + "SET naechste_nummer = 1 WHERE tenant_id = ? AND art = 'EZ' AND jahr = 2028", k.tenant()));
        // Je Kundenbereich: ein anderer beginnt wieder bei 0001.
        Kunde anderer = kunde("Z1 Zähler B");
        TenantContext.set(anderer.tenant());
        assertThat(kennzeichen(ziel(anderer, anderer.kennzahl(), anderer.basis(), 1, null, Map.of())))
                .isEqualTo("EZ-2028-0001");
    }

    // ============================================================ Z2: Zielwert und Zielperiode

    @Test
    void zielwertUndZielperiodeHaeltDieDatenbank() {
        Kunde k = kunde("Z2");
        TenantContext.set(k.tenant());
        checkFehler("energieziel_zielperiode_nach_anlegen_chk",
                () -> ziel(k, k.kennzahl(), k.basis(), 1, null, Map.of("zielperiode", "2027-12/2028-11")));
        checkFehler("energieziel_zielperiode_ab_fassung_chk", () -> ziel(k, k.kennzahl(), k.basis(), 1, null,
                Map.of("zielperiode", "2026-10/2027-09", "angelegt_am", Timestamp.valueOf("2026-09-15 10:00:00"))));
        checkFehler("energieziel_zielperiode_chk",
                () -> ziel(k, k.kennzahl(), k.basis(), 1, null, Map.of("zielperiode", "2028-13/2028-12")));
        checkFehler("energieziel_zielperiode_chk",
                () -> ziel(k, k.kennzahl(), k.basis(), 1, null, Map.of("zielperiode", "2028-06/2028-01")));
        checkFehler("energieziel_zielperiode_chk",
                () -> ziel(k, k.kennzahl(), k.basis(), 1, null, Map.of("zielperiode", "2028-01")));
        checkFehler("energieziel_zielwert_chk",
                () -> ziel(k, k.kennzahl(), k.basis(), 1, null, Map.of("zielwert_prozent", new java.math.BigDecimal("-5.05"))));
        checkFehler("energieziel_zielwert_chk",
                () -> ziel(k, k.kennzahl(), k.basis(), 1, null, Map.of("zielwert_prozent", new java.math.BigDecimal("-100"))));
        // RE2: der Standort des Ziels ist der Standort der Kennzahl; am Unternehmen keiner.
        checkFehler("energieziel_standort_der_kennzahl_chk", () -> ziel(k, k.kennzahl(), k.basis(), 1, k.st1(), Map.of()));
        checkFehler("energieziel_standort_der_kennzahl_chk",
                () -> ziel(k, k.kennzahlSt1(), k.basisSt1(), 1, k.st2(), Map.of()));
        UUID ziel = ziel(k, k.kennzahl(), k.basis(), 1, null, Map.of());
        assertThat(app.queryForObject("SELECT zielwert_prozent FROM energieziel WHERE id = ?",
                java.math.BigDecimal.class, ziel)).isEqualByComparingTo("-5.0");
    }

    // ============================================================ §5.7: Übergänge einmalig

    @Test
    void dieUebergaengeSindEinmaligUndBewertetIstEndgueltig() {
        Kunde k = kunde("Übergänge");
        TenantContext.set(k.tenant());
        UUID ziel = ziel(k, k.kennzahl(), k.basis(), 1, null, Map.of());
        // Anker und Zielwert ändert die App-Rolle nicht (Spalten-Rechte).
        for (String spalte : List.of("kennzahl_id = kennzahl_id", "fassung = 1", "zielwert_prozent = -3.0",
                "begruendung = begruendung", "standort_id = NULL", "kennzeichen = 'EZ-2028-0099'")) {
            checkState("42501", () -> app.update("UPDATE energieziel SET " + spalte + " WHERE id = ?", ziel));
        }
        // Ändern solange offen: Verantwortlicher, Wortlaut, das Ende der Zielperiode nur nach hinten.
        app.update("UPDATE energieziel SET verantwortlich_sub = 'JW', verantwortlich_name = 'Jonas Wendlinger', "
                + "wortlaut = 'Spritzguss: 5 % weniger Strom' WHERE id = ?", ziel);
        checkFehler("energieziel_zielperiode_nur_nach_hinten",
                () -> app.update("UPDATE energieziel SET zielperiode = '2028-02/2028-12' WHERE id = ?", ziel));
        checkFehler("energieziel_zielperiode_nur_nach_hinten",
                () -> app.update("UPDATE energieziel SET zielperiode = '2028-01/2028-11' WHERE id = ?", ziel));
        app.update("UPDATE energieziel SET zielperiode = '2028-01/2029-03' WHERE id = ?", ziel);
        checkFehler("energieziel_bewertet_chk", () -> app.update("UPDATE energieziel SET zustand = 'bewertet' WHERE id = ?", ziel));
        // Z5: die Prüfsumme hält die Datenbank gegen die Kopie.
        String kopie = "{\"abruf\":\"2029-01-15\",\"kennzahl\":\"KZ-0004\",\"stand\":{\"delta_prozent\":-2.7}}";
        checkFehler("energieziel_bewertung_pruefsumme_chk", () -> bewerten(ziel, kopie, "sha256:00"));
        bewerten(ziel, kopie, root.queryForObject("SELECT bericht_pruefsumme(?)", String.class, kopie));
        assertThat(app.queryForObject("SELECT zustand || '/' || ergebnis FROM energieziel WHERE id = ?", String.class, ziel))
                .isEqualTo("bewertet/verfehlt");
        // Nie zurückgenommen, nichts ändert sich mehr.
        checkFehler("energieziel_endgueltig",
                () -> app.update("UPDATE energieziel SET wortlaut = 'anders' WHERE id = ?", ziel));
        checkFehler("energieziel_endgueltig", () -> app.update("UPDATE energieziel SET ergebnis = 'erreicht' WHERE id = ?", ziel));
        // Beendet ist ebenso endgültig.
        UUID zweites = ziel(k, k.kennzahlSt1(), k.basisSt1(), 1, k.st1(), Map.of());
        checkFehler("energieziel_beendet_chk",
                () -> app.update("UPDATE energieziel SET zustand = 'beendet' WHERE id = ?", zweites));
        app.update("UPDATE energieziel SET zustand = 'beendet', beendet_zum = DATE '2028-02-29', beendet_am = now(), "
                + "beendet_grund = 'Bezugsbasis beendet, Ziel aufgegeben' WHERE id = ?", zweites);
        checkFehler("energieziel_endgueltig", () -> app.update("UPDATE energieziel SET zustand = 'offen', beendet_zum = NULL, "
                + "beendet_am = NULL, beendet_grund = NULL WHERE id = ?", zweites));
    }

    @Test
    void beiVierAugenBestaetigtNieDerUrheberUndJedeBewertungGehtUeberEinenAntrag() {
        Kunde k = kunde("Vier-Augen");
        TenantContext.set(k.tenant());
        UUID ziel = ziel(k, k.kennzahl(), k.basis(), 1, null, Map.of());
        String kopie = "{\"abruf\":\"2029-01-15\",\"vorschlag\":null}";
        String summe = root.queryForObject("SELECT bericht_pruefsumme(?)", String.class, kopie);
        // Ohne Antrag direkt „bewertet“ mit Vier-Augen: abgelehnt.
        checkFehler("energieziel_bewertung_einmalig", () -> app.update("UPDATE energieziel SET vieraugen = true, "
                + "bewertung_status = 'bewertet', zustand = 'bewertet', ergebnis = 'verfehlt', bewertung_begruendung = ?, "
                + "bewertung_kopie = ?, bewertung_pruefsumme = ?, freigabe_sub = 'IK', freigabe_name = 'Ines Kaltenbach', "
                + "freigabe_rolle = 'energiemanager', freigabe_art = 'kunde', freigabe_am = now(), entscheidung_sub = 'JW', "
                + "entscheidung_name = 'Jonas Wendlinger', entscheidung_rolle = 'kundenadministrator', "
                + "entscheidung_art = 'kunde', entschieden_am = now() WHERE id = ?", BEGRUENDUNG, kopie, summe, ziel));
        antrag(ziel, kopie, summe);
        // Der Antrag ändert sich nicht.
        checkFehler("energieziel_bewertung_einmalig",
                () -> app.update("UPDATE energieziel SET ergebnis = 'erreicht' WHERE id = ?", ziel));
        // Der Urheber bestätigt nie.
        checkFehler("energieziel_entscheidung_chk", () -> entscheiden(ziel, "bewertet", "IK", "Ines Kaltenbach", null));
        // Abgelehnt von der zweiten Person, mit Begründung; danach darf ein neuer Antrag kommen.
        checkFehler("energieziel_ablehnung_chk", () -> entscheiden(ziel, "abgelehnt", "JW", "Jonas Wendlinger", null));
        entscheiden(ziel, "abgelehnt", "JW", "Jonas Wendlinger", "Der März fehlt noch, bitte nach der Korrektur.");
        assertThat(app.queryForObject("SELECT zustand FROM energieziel WHERE id = ?", String.class, ziel)).isEqualTo("offen");
        checkFehler("energieziel_bewertung_einmalig",
                () -> app.update("UPDATE energieziel SET bewertung_status = NULL, ergebnis = NULL WHERE id = ?", ziel));
        app.update("UPDATE energieziel SET bewertung_status = 'beantragt', ergebnis = 'nicht_bewertbar', "
                + "entscheidung_sub = NULL, entscheidung_name = NULL, entscheidung_rolle = NULL, entscheidung_art = NULL, "
                + "entschieden_am = NULL, entscheidungs_begruendung = NULL, freigabe_am = now() WHERE id = ?", ziel);
        entscheiden(ziel, "bewertet", "JW", "Jonas Wendlinger", null);
        assertThat(app.queryForObject("SELECT zustand || '/' || ergebnis || '/' || entscheidung_sub FROM energieziel "
                + "WHERE id = ?", String.class, ziel)).isEqualTo("bewertet/nicht_bewertbar/JW");
    }

    // ============================================================ kein Löschen, Protokoll nur anhängen

    @Test
    void dieAppLoeschtNieUndDasProtokollWirdNurAngehaengt() {
        Kunde k = kunde("Löschen");
        TenantContext.set(k.tenant());
        UUID ziel = ziel(k, k.kennzahl(), k.basis(), 1, null, Map.of());
        protokoll(k, ziel);
        checkState("42501", () -> app.update("DELETE FROM energieziel WHERE id = ?", ziel));
        checkState("42501", () -> app.update("DELETE FROM energieziel_aenderung WHERE energieziel_id = ?", ziel));
        checkState("42501", () -> app.update("DELETE FROM verbesserung_kennung_seq WHERE tenant_id = ?", k.tenant()));
        checkState("42501", () -> app.update("UPDATE energieziel_aenderung SET neu = NULL WHERE energieziel_id = ?", ziel));
        checkFehler("energieziel_aenderung_art_chk", () -> app.update("INSERT INTO energieziel_aenderung(tenant_id,"
                + "energieziel_id,art,actor_sub,actor_name,actor_art) VALUES (?,?,'massnahme_umgesetzt','IK','Ines','kunde')",
                k.tenant(), ziel));
        assertThat(app.queryForObject("SELECT count(*) FROM energieziel WHERE id = ?", Integer.class, ziel)).isOne();
    }

    // ============================================================ RE2: Mandanten- und Standort-Zaun

    @Test
    void derMandantenzaunHaeltMandantASiehtBNicht() {
        Kunde a = kunde("Zaun A");
        Kunde b = kunde("Zaun B");
        TenantContext.set(b.tenant());
        UUID zielB = ziel(b, b.kennzahl(), b.basis(), 1, null, Map.of());
        protokoll(b, zielB);
        TenantContext.set(a.tenant());
        for (String t : TABELLEN) {
            assertThat(app.queryForObject("SELECT count(*) FROM " + t + " WHERE tenant_id = ?", Integer.class, b.tenant()))
                    .as(t).isZero();
        }
        assertThat(app.update("UPDATE energieziel SET wortlaut = 'fremd' WHERE id = ?", zielB)).isZero();
        // Fremde Zeilen einschleusen: RLS-Prüfung bzw. der Mandant reist im Verweis mit.
        checkState("42501", () -> ziel(b, b.kennzahlSt1(), b.basisSt1(), 1, b.st1(), Map.of()));
        checkState("23503", () -> ziel(a, b.kennzahl(), b.basis(), 1, null, Map.of()));
        TenantContext.clear();
        assertThat(app.queryForObject("SELECT count(*) FROM energieziel", Integer.class)).isZero();
    }

    @Test
    void derStandortZaunZeigtEinemStandortNurSeineZieleUndNieEinsAmUnternehmen() {
        Kunde k = kunde("Standort-Zaun");
        TenantContext.set(k.tenant());
        UUID amUnternehmen = ziel(k, k.kennzahl(), k.basis(), 1, null, Map.of());
        UUID amSt1 = ziel(k, k.kennzahlSt1(), k.basisSt1(), 1, k.st1(), Map.of());
        UUID amSt2 = ziel(k, k.kennzahlSt2(), k.basisSt2(), 1, k.st2(), Map.of());
        for (UUID z : List.of(amUnternehmen, amSt1, amSt2)) {
            protokoll(k, z);
        }
        TenantContext.clear();
        // Nur ST-1: ein Ziel und sein Protokoll; ST-2 und das Unternehmen: 0 Zeilen.
        eng(k.tenant(), List.of(k.st1()), jdbc -> {
            assertThat(jdbc.queryForList("SELECT id FROM energieziel", UUID.class)).containsExactly(amSt1);
            assertThat(jdbc.queryForObject("SELECT count(*) FROM energieziel WHERE id IN (?, ?)", Integer.class,
                    amSt2, amUnternehmen)).isZero();
            assertThat(jdbc.queryForList("SELECT DISTINCT energieziel_id FROM energieziel_aenderung", UUID.class))
                    .containsExactly(amSt1);
            assertThat(jdbc.update("UPDATE energieziel SET wortlaut = 'fremd' WHERE id = ?", amSt2)).isZero();
            checkState("42501", () -> jdbc.update("INSERT INTO energieziel_aenderung(tenant_id,energieziel_id,art,neu,"
                    + "actor_sub,actor_name,actor_art) VALUES (?,?,'energieziel_geaendert','{}'::jsonb,'PH','Peter Hollerbach',"
                    + "'kunde')", k.tenant(), amSt2));
            checkState("42501", () -> jdbc.update("INSERT INTO energieziel(tenant_id,kennzahl_id,bezugsbasis_id,fassung,"
                    + "zielwert_prozent,zielperiode,wortlaut,begruendung,verantwortlich_sub,verantwortlich_name,"
                    + "verantwortlich_konto,standort_id,actor_sub,actor_name,actor_art,angelegt_am) VALUES (?,?,?,1,-5.0,"
                    + "'2030-01/2030-12','fremd',?,'PH','Peter Hollerbach','benutzer',?,'PH','Peter Hollerbach','kunde',?)",
                    k.tenant(), k.kennzahlSt2(), k.basisSt2(), BEGRUENDUNG, k.st2(), Timestamp.valueOf(AM_20_12_2027)));
            return null;
        });
        // Unternehmensweit: alle drei.
        eng(k.tenant(), null, jdbc -> {
            assertThat(jdbc.queryForObject("SELECT count(*) FROM energieziel", Integer.class)).isEqualTo(3);
            return null;
        });
    }

    // ============================================================ RE1: Rechte, RLS, Matrix

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
        for (String t : List.of("energieziel", "energieziel_aenderung")) {
            assertThat(root.queryForObject("SELECT count(*) FROM pg_policies WHERE tablename = ? AND policyname = 'site_scope' "
                    + "AND permissive = 'RESTRICTIVE'", Integer.class, t)).as(t + " site_scope").isOne();
            assertThat(root.queryForObject("SELECT count(*) FROM pg_policies WHERE tablename = ? AND permissive = 'PERMISSIVE'",
                    Integer.class, t)).as(t + " nur die Mandanten-Policy öffnet").isOne();
        }
        assertThat(root.queryForObject("SELECT has_table_privilege(?, 'energieziel_aenderung', 'UPDATE')", Boolean.class, APP))
                .isFalse();
        assertThat(root.queryForObject("SELECT has_sequence_privilege(?, 'energieziel_aenderung_id_seq', 'USAGE')",
                Boolean.class, APP)).isTrue();
        // Rechte-Nachtrag §4.9 RE1: verwalten KA U · EM U · BE S, abschliessen KA U · EM U, ansehen … · US A.
        JsonNode matrix = MAPPER.readTree(Path.of("../../docs/contracts/v2/rechte-matrix.json").toFile());
        Map<String, String> zellen = new LinkedHashMap<>();
        matrix.path("aktionen").forEach(r -> {
            if (r.path("kennung").asText().startsWith("verbesserung.")) {
                assertThat(r.path("gruppe").asText()).isEqualTo("kennzahlen");
                StringBuilder s = new StringBuilder();
                r.path("zellen").fields().forEachRemaining(z -> s.append(z.getValue().asText()));
                zellen.put(r.path("kennung").asText(), s.toString());
            }
        });
        assertThat(zellen).containsExactly(Map.entry("verbesserung.verwalten", "UUS-----"),
                Map.entry("verbesserung.abschliessen", "UU------"), Map.entry("verbesserung.ansehen", "UUSSSA-U"));
    }

    /** Jede Liste des Vertrags (IP-2) steht Zeile für Zeile in der Datenbank; dazu nur Wörter-Listen der Tabellen. */
    @Test
    void dieVokabulareDerDatenbankSindDieDesVertrags() throws IOException {
        JsonNode vertrag = MAPPER.readTree(Path.of("../../docs/contracts/v2/verbesserung-vectors.json").toFile())
                .path("vokabulare");
        List<String> bloecke = new ArrayList<>();
        vertrag.fieldNames().forEachRemaining(bloecke::add);
        assertThat(bloecke).hasSize(18);
        for (String block : bloecke) {
            List<String> woerter = new ArrayList<>();
            vertrag.path(block).forEach(w -> woerter.add(w.asText()));
            assertThat(woerter).as(block).isNotEmpty();
            assertThat(root.queryForList("SELECT wort FROM verbesserung_vokabular() WHERE vokabular = ? ORDER BY nr",
                    String.class, block)).as(block).containsExactlyElementsOf(woerter);
        }
        List<String> nurTabellen = new ArrayList<>(root.queryForList("SELECT DISTINCT vokabular FROM verbesserung_vokabular() "
                + "ORDER BY vokabular", String.class));
        nurTabellen.removeAll(bloecke);
        // IP-9 und IP-14 weiten die Funktion um die Wörter ihrer Tabellen (massnahme_*, abweichung_*).
        assertThat(nurTabellen).containsExactly("abweichung_herkunft", "abweichung_protokoll",
                "energieziel_bewertung_status", "energieziel_protokoll", "kennung_art", "massnahme_bewertung_status",
                "massnahme_protokoll");
        assertThat(root.queryForList("SELECT wort FROM verbesserung_vokabular() WHERE vokabular = 'kennung_art' ORDER BY nr",
                String.class)).containsExactly("EZ", "M", "AW");
        // Die Reihenfolge der Blöcke in der Funktion ist die des Vertrags; `nr` ist lückenlos ab 1.
        assertThat(root.queryForObject("SELECT count(*) FROM (SELECT vokabular, array_agg(nr ORDER BY nr) n, count(*) c "
                + "FROM verbesserung_vokabular() GROUP BY vokabular) s WHERE n <> (SELECT array_agg(g) FROM "
                + "generate_series(1, c::int) g)", Integer.class)).isZero();
    }

    @Test
    void dasOffboardingRaeumtAlleTabellenVorFassungKennzahlStandortUndBenutzerAb() {
        Kunde k = kunde("Offboarding");
        TenantContext.set(k.tenant());
        UUID ziel = ziel(k, k.kennzahlSt1(), k.basisSt1(), 1, k.st1(), Map.of());
        protokoll(k, ziel);
        app.queryForObject("SELECT uems_verbesserung_kennung(?, 'AW', 2028)", String.class, k.tenant());
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
        assertThat(fingerVorher.get("bezugsbasis_fassung")).as("es gibt Bestand").isNotEqualTo(Bestandsschutz.LEER);
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
        Path ohneDiese = Files.createTempDirectory("ohne-verbesserung");
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
        String schema = "SELECT string_agg(conrelid::regclass || ':' || conname || ':' || pg_get_constraintdef(oid), '|' "
                + "ORDER BY conrelid::regclass::text, conname) FROM pg_constraint WHERE conrelid::regclass::text "
                + "IN ('verbesserung_kennung_seq', 'energieziel', 'energieziel_aenderung')";
        assertThat(spaetDb.queryForObject(schema, String.class)).isEqualTo(root.queryForObject(schema, String.class));
        String policies = "SELECT string_agg(tablename || ':' || policyname || ':' || permissive || ':' || qual, '|' "
                + "ORDER BY tablename, policyname) FROM pg_policies WHERE tablename IN ('energieziel', 'energieziel_aenderung')";
        assertThat(spaetDb.queryForObject(policies, String.class)).isEqualTo(root.queryForObject(policies, String.class));
    }

    // ============================================================ Gerüst

    /** Bestand vor der Migration (nur Tabellen, die es vorher gibt). */
    private static Kunde kundeBestand(String name) {
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
        UUID kz = kennzahl(tenant, "KZ-0004", "unternehmen", unternehmen, null);
        UUID kz1 = kennzahl(tenant, "KZ-0005", "standort", null, st1);
        UUID kz2 = kennzahl(tenant, "KZ-0006", "standort", null, st2);
        return new Kunde(tenant, unternehmen, st1, st2, kz, basis(tenant, kz, "BB-0001"), kz1, basis(tenant, kz1, "BB-0002"),
                kz2, basis(tenant, kz2, "BB-0003"));
    }

    private static Kunde kunde(String name) {
        return kundeBestand(name);
    }

    private static UUID kennzahl(UUID tenant, String kennzeichen, String geltung, UUID unternehmen, UUID standort) {
        return root.queryForObject("INSERT INTO kennzahl(tenant_id,kennzeichen,name,rechenform,geltung_art,unternehmen_id,"
                + "standort_id,verantwortlich_sub,verantwortlich_name) VALUES (?,?,?,'quotient',?,?,?,'IK','Ines Kaltenbach') "
                + "RETURNING id", UUID.class, tenant, kennzeichen, kennzeichen, geltung, unternehmen, standort);
    }

    /** Eine Bezugsbasis mit freigegebener Fassung 1 (gilt ab 01.11.2026, Referenzperiode Oktober 2026). */
    private static UUID basis(UUID tenant, UUID kennzahl, String kennzeichen) {
        UUID basis = root.queryForObject("INSERT INTO bezugsbasis(tenant_id,kennzeichen,kennzahl_id,verantwortlich_sub,"
                + "verantwortlich_name,verantwortlich_konto,actor_sub,actor_name,actor_rolle,actor_art) VALUES (?,?,?,"
                + "'IK','Ines Kaltenbach','benutzer','IK','Ines Kaltenbach','energiemanager','kunde') RETURNING id",
                UUID.class, tenant, kennzeichen, kennzahl);
        root.update("INSERT INTO bezugsbasis_fassung(tenant_id,bezugsbasis_id,fassung,referenzperiode,methode,datenlage,gilt_ab,"
                + "begruendung,actor_sub,actor_name,actor_rolle,actor_art,freigabe_status,freigabe_sub,freigabe_name,"
                + "freigabe_rolle,freigabe_art,freigabe_am,freigegeben_am) VALUES (?,?,1,'2026-10/2026-10','verhaeltnis',"
                + "'vorlaeufig','2026-11-01','Erste Energieleistungskennzahl: ein abgeschlossener Monat — vorläufig.',"
                + "'IK','Ines Kaltenbach','energiemanager','kunde','freigegeben','IK','Ines Kaltenbach','energiemanager',"
                + "'kunde','2026-11-12 10:00','2026-11-12 10:00')", tenant, basis);
        return basis;
    }

    /** Ein Energieziel „5 % weniger“ für 2028, angelegt von Ines am 20.12.2027, mit den genannten Abweichungen. */
    private static UUID ziel(Kunde k, UUID kennzahl, UUID basis, int fassung, UUID standort, Map<String, Object> spalten) {
        Map<String, Object> werte = new LinkedHashMap<>();
        werte.put("tenant_id", k.tenant());
        werte.put("kennzahl_id", kennzahl);
        werte.put("bezugsbasis_id", basis);
        werte.put("fassung", fassung);
        werte.put("zielwert_prozent", new java.math.BigDecimal("-5.0"));
        werte.put("zielperiode", "2028-01/2028-12");
        werte.put("wortlaut", "Spritzguss: 5 % weniger Strom als die Bezugsbasis erwarten lässt — Jahresziel 2028.");
        werte.put("begruendung", BEGRUENDUNG);
        werte.put("verantwortlich_sub", "IK");
        werte.put("verantwortlich_name", "Ines Kaltenbach");
        werte.put("verantwortlich_konto", "benutzer");
        werte.put("standort_id", standort);
        werte.put("actor_sub", "IK");
        werte.put("actor_name", "Ines Kaltenbach");
        werte.put("actor_rolle", "energiemanager");
        werte.put("actor_art", "kunde");
        werte.put("angelegt_am", Timestamp.valueOf(AM_20_12_2027));
        werte.putAll(spalten);
        String sql = "INSERT INTO energieziel(" + String.join(",", werte.keySet()) + ") VALUES ("
                + String.join(",", werte.keySet().stream().map(s -> "?").toList()) + ") RETURNING id";
        return app.queryForObject(sql, UUID.class, werte.values().toArray());
    }

    private static String kennzeichen(UUID ziel) {
        return app.queryForObject("SELECT kennzeichen FROM energieziel WHERE id = ?", String.class, ziel);
    }

    /** Ines bewertet ohne Vier-Augen „verfehlt“ (R10) mit dieser Kopie und Prüfsumme. */
    private static void bewerten(UUID ziel, String kopie, String pruefsumme) {
        app.update("UPDATE energieziel SET zustand = 'bewertet', bewertung_status = 'bewertet', ergebnis = 'verfehlt', "
                + "bewertung_begruendung = '2,7 % statt 5 % weniger über elf bewertbare Monate.', bewertung_kopie = ?, "
                + "bewertung_pruefsumme = ?, freigabe_sub = 'IK', freigabe_name = 'Ines Kaltenbach', "
                + "freigabe_rolle = 'energiemanager', freigabe_art = 'kunde', freigabe_am = TIMESTAMPTZ '2029-01-15 10:00+01' "
                + "WHERE id = ?", kopie, pruefsumme, ziel);
    }

    /** Ines beantragt bei Vier-Augen „verfehlt“. */
    private static void antrag(UUID ziel, String kopie, String pruefsumme) {
        app.update("UPDATE energieziel SET vieraugen = true, bewertung_status = 'beantragt', ergebnis = 'verfehlt', "
                + "bewertung_begruendung = ?, bewertung_kopie = ?, bewertung_pruefsumme = ?, freigabe_sub = 'IK', "
                + "freigabe_name = 'Ines Kaltenbach', freigabe_rolle = 'energiemanager', freigabe_art = 'kunde', "
                + "freigabe_am = now() WHERE id = ?", BEGRUENDUNG, kopie, pruefsumme, ziel);
    }

    private static void entscheiden(UUID ziel, String status, String sub, String name, String begruendung) {
        app.update("UPDATE energieziel SET bewertung_status = ?, zustand = CASE WHEN ? = 'bewertet' THEN 'bewertet' "
                + "ELSE zustand END, entscheidung_sub = ?, entscheidung_name = ?, entscheidung_rolle = 'kundenadministrator', "
                + "entscheidung_art = 'kunde', entschieden_am = now(), entscheidungs_begruendung = ? WHERE id = ?",
                status, status, sub, name, begruendung, ziel);
    }

    private static void protokoll(Kunde k, UUID ziel) {
        app.update("INSERT INTO energieziel_aenderung(tenant_id,energieziel_id,art,neu,actor_sub,actor_name,actor_art) "
                + "VALUES (?,?,'energieziel_angelegt','{}'::jsonb,'IK','Ines Kaltenbach','kunde')", k.tenant(), ziel);
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
