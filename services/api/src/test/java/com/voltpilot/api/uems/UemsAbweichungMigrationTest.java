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
import java.time.LocalDate;
import java.time.OffsetDateTime;
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
 * AP-18 IP-14: die Datenhaltung von Auffälligkeit und Abweichung (A1–A4, A6, U1, U2) unter der wirklichen App-Rolle.
 * Die Datenbank hält „ein Vermerk je Kennzahl × Fassung × Monat“ (UNIQUE), „die Antwort ist einmalig“ (Trigger),
 * „Abschluss `massnahme` nur mit Verweis“ (CHECK), die Anker (freigegebene Fassung der Kennzahl, Monate in ihrer
 * Geltung, Standort der Kennzahl), den Zähler AW-2028-0001 im Jahr des Eröffnens mit der Frist-Vorgabe von dreißig
 * Tagen, den einmaligen Abschluss, das Protokoll nur zum Anhängen (Kommentar, Ursache-Aussage mit Person und
 * wahlfreiem Beleg, Frist/Verantwortlicher mit Begründung), den Mandanten- und den Standort-Zaun und die Rechte selbst;
 * die Migration legt nur daneben und trägt auch als späte Ankunft.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsAbweichungMigrationTest {

    private static final String DIESE = "20260924235130";
    /** Spätere Migrationen, die auf diese aufbauen: sie reisen bei der späten Ankunft mit. */
    private static final List<String> BAUEN_DARAUF_AUF = List.of(
            "20260925040000", // AP-19 IP-17: weitet das Vokabular als Vereinigung (mit den Wörtern dieser Migration).
            "20260926001500"); // Folge zu AP-19 IP-12: weitet die Akteur-Rollen-CHECKs um einsicht.
    private static final String APP = "voltpilot_app", ADMIN = "voltpilot_admin", PW = "ap18_ip14_test_pw";
    private static final List<String> TABELLEN = List.of("auffaelligkeit", "abweichung", "abweichung_aenderung");
    private static final String BEGRUENDUNG = "Aussage von Murat Demirci erklärt die Ursache plausibel; Maßnahme "
            + "M-2028-0001 angelegt; Dezember-Werte bleiben, keine Korrektur.";
    private static final String ZUR_KENNTNIS = "Kleinserien-Sonderauftrag im Juli, dokumentiert im Auftragsbuch.";
    private static final OffsetDateTime AM_07_01_2028 = OffsetDateTime.parse("2028-01-07T05:12:00+01:00");
    private static final OffsetDateTime AM_12_01_2028 = OffsetDateTime.parse("2028-01-12T09:30:00+01:00");
    /** Der Anlass von R1: Dezember 2027, +12,9 % schlechter — als kanonischer Text. */
    private static final String ANLASS = "{\"band_prozent\":2.0,\"bezugsbasis\":\"BB-0001\",\"delta_prozent\":12.9,"
            + "\"erwartet_kwh\":69098,\"fassung\":1,\"gemessen_kwh\":78000,\"gemessen_version\":1,\"kennzahl\":\"KZ-0004\","
            + "\"monat\":\"2027-12\",\"urteil\":\"schlechter\"}";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root, app, admin;
    private static Map<String, String> fingerVorher, fingerNachMigration;
    private static List<String> vokabularVorher;
    private static final ObjectMapper MAPPER = new ObjectMapper();

    /**
     * Ein Kundenbereich mit zwei Standorten, einer Unternehmens- und zwei Standort-Kennzahlen samt freigegebener Basis
     * (Fassung 1 gilt ab 01.11.2026) und der Maßnahme M-2028-0001 an ST-1 (aus AW-2028-0001, R3).
     */
    private record Kunde(UUID tenant, UUID unternehmen, UUID st1, UUID st2, UUID kennzahl, UUID basis,
            UUID kennzahlSt1, UUID basisSt1, UUID kennzahlSt2, UUID basisSt2, UUID massnahme) {
    }

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway(POSTGRES.getJdbcUrl()).target(letzteFassungVorDieser()).load().migrate();
        // Bestand vor der Migration: Kennzahlen, Benutzer, Bezugsbasen, eine Maßnahme.
        TenantContext.clear();
        kunde("Kunststoffwerk Ahrenberg GmbH");
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());
        vokabularVorher = vokabular();
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

    // ============================================================ A1: ein Vermerk je Kennzahl × Fassung × Monat

    @Test
    void einZweiterVermerkDerselbenKennzahlFassungUndPeriodeScheitertAmUnique() {
        Kunde k = kunde("A1 eindeutig");
        TenantContext.set(k.tenant());
        UUID dezember = vermerk(k, "2027-12", Map.of());
        checkEindeutig("auffaelligkeit_eindeutig_uq", () -> vermerk(k, "2027-12", Map.of()));
        // Die Naht setzt ihn idempotent (IP-15): ein zweiter Takt schreibt nichts.
        assertThat(app.update("INSERT INTO auffaelligkeit(tenant_id,kennzahl_id,bezugsbasis_id,fassung,periode,standort_id,"
                + "anlass,anlass_pruefsumme) VALUES (?,?,?,1,'2027-12',?,?,?) ON CONFLICT ON CONSTRAINT "
                + "auffaelligkeit_eindeutig_uq DO NOTHING", k.tenant(), k.kennzahlSt1(), k.basisSt1(), k.st1(), ANLASS,
                pruefsumme(ANLASS))).isZero();
        // Ein anderer Monat, eine andere Kennzahl im selben Monat: je ein eigener Vermerk.
        UUID juli = vermerk(k, "2028-07", Map.of());
        UUID st2 = vermerk(k, "2027-12", Map.of("kennzahl_id", k.kennzahlSt2(), "bezugsbasis_id", k.basisSt2(),
                "standort_id", k.st2()));
        assertThat(List.of(dezember, juli, st2)).doesNotHaveDuplicates();
        assertThat(app.queryForObject("SELECT zustand FROM auffaelligkeit WHERE id = ?", String.class, dezember))
                .isEqualTo("offen");
        // Die Anker: freigegebene Fassung der Kennzahl, der Monat in ihrer Geltung, der Standort der Kennzahl.
        root.update("INSERT INTO bezugsbasis_fassung(tenant_id,bezugsbasis_id,fassung,referenzperiode,methode,datenlage,"
                + "gilt_ab,actor_sub,actor_name,actor_rolle,actor_art) VALUES (?,?,2,'2026-11/2027-10','verhaeltnis',"
                + "'vollstaendig','2027-11-01','IK','Ines Kaltenbach','energiemanager','kunde')", k.tenant(), k.basisSt1());
        checkFehler("auffaelligkeit_fassung_freigegeben_chk", () -> vermerk(k, "2028-01", Map.of("fassung", 2)));
        checkState("23503", () -> vermerk(k, "2028-01", Map.of("fassung", 9)));
        checkFehler("auffaelligkeit_basis_der_kennzahl_chk", () -> vermerk(k, "2028-01",
                Map.of("bezugsbasis_id", k.basisSt2())));
        checkFehler("auffaelligkeit_monat_in_der_fassung_chk", () -> vermerk(k, "2026-10", Map.of()));
        checkFehler("auffaelligkeit_standort_der_kennzahl_chk", () -> vermerk(k, "2028-01", Map.of("standort_id", k.st2())));
        checkFehler("auffaelligkeit_standort_der_kennzahl_chk", () -> vermerk(k, "2028-01", Map.of("kennzahl_id",
                k.kennzahl(), "bezugsbasis_id", k.basis(), "standort_id", k.st1())));
        checkFehler("auffaelligkeit_periode_chk", () -> vermerk(k, "2027-13", Map.of()));
        checkFehler("auffaelligkeit_anlass_pruefsumme_chk", () -> vermerk(k, "2028-01",
                Map.of("anlass_pruefsumme", pruefsumme(ANLASS + " "))));
        // Der Vermerk entsteht offen.
        checkFehler("auffaelligkeit_entsteht_offen", () -> vermerk(k, "2028-02", Map.of("zustand", "beantwortet",
                "antwort", "zur_kenntnis", "antwort_begruendung", ZUR_KENNTNIS, "beantwortet_am", AM_12_01_2028,
                "beantwortet_sub", "IK", "beantwortet_name", "Ines Kaltenbach", "beantwortet_art", "kunde")));
    }

    // ============================================================ A2: die Antwort ist einmalig

    @Test
    void eineZweiteAntwortScheitertAmTrigger() {
        Kunde k = kunde("A2 Antwort");
        TenantContext.set(k.tenant());
        UUID dezember = vermerk(k, "2027-12", Map.of());
        UUID juli = vermerk(k, "2028-07", Map.of());
        UUID aw = abweichung(k, Map.of());
        // `zur_kenntnis` nur mit Begründung (10–500), `abweichung` nur mit Verweis — und nie umgekehrt.
        checkFehler("auffaelligkeit_antwort_chk", () -> antworten(juli, "zur_kenntnis", null, null));
        checkFehler("auffaelligkeit_antwort_chk", () -> antworten(juli, "zur_kenntnis", null, "zu kurz"));
        checkFehler("auffaelligkeit_antwort_chk", () -> antworten(juli, "zur_kenntnis", null, "x".repeat(501)));
        checkFehler("auffaelligkeit_antwort_chk", () -> antworten(juli, "zur_kenntnis", aw, ZUR_KENNTNIS));
        checkFehler("auffaelligkeit_antwort_chk", () -> antworten(dezember, "abweichung", null, null));
        checkFehler("auffaelligkeit_antwort_chk", () -> antworten(dezember, "wesentlich", null, null));
        // Der Verweis zeigt auf eine Abweichung derselben Kennzahl und Fassung, die den Monat enthält.
        checkFehler("auffaelligkeit_abweichung_passt_chk", () -> antworten(juli, "abweichung", aw, null));
        UUID anderswo = abweichung(k, Map.of("kennzahl_id", k.kennzahlSt2(), "bezugsbasis_id", k.basisSt2(),
                "standort_id", k.st2()));
        checkFehler("auffaelligkeit_abweichung_passt_chk", () -> antworten(dezember, "abweichung", anderswo, null));
        // R1: Dezember 2027 → AW-2028-0001; R11: Juli 2028 → zur Kenntnis.
        antworten(dezember, "abweichung", aw, null);
        antworten(juli, "zur_kenntnis", null, ZUR_KENNTNIS);
        assertThat(app.queryForList("SELECT antwort FROM auffaelligkeit WHERE id IN (?, ?) ORDER BY periode", String.class,
                dezember, juli)).containsExactly("abweichung", "zur_kenntnis");
        // Eine zweite Antwort, auch dieselbe noch einmal, scheitert am Trigger; der Vermerk bleibt lesbar.
        checkFehler("auffaelligkeit_antwort_einmalig", () -> antworten(juli, "abweichung", aw, null));
        checkFehler("auffaelligkeit_antwort_einmalig", () -> antworten(dezember, "abweichung", aw, null));
        checkFehler("auffaelligkeit_antwort_einmalig", () -> app.update("UPDATE auffaelligkeit SET zustand = 'offen', "
                + "antwort = NULL, antwort_begruendung = NULL, beantwortet_am = NULL, beantwortet_sub = NULL, "
                + "beantwortet_name = NULL, beantwortet_rolle = NULL, beantwortet_art = NULL WHERE id = ?", juli));
        // Die Kopie bleibt byte-gleich: die App darf sie gar nicht ändern, und auch sonst niemand.
        checkState("42501", () -> app.update("UPDATE auffaelligkeit SET anlass = anlass WHERE id = ?", dezember));
        UUID offen = vermerk(k, "2028-01", Map.of());
        checkFehler("auffaelligkeit_antwort_einmalig", () -> root.update("UPDATE auffaelligkeit SET periode = '2028-02' "
                + "WHERE id = ?", offen));
        assertThat(app.queryForObject("SELECT anlass = ? AND anlass_pruefsumme = bericht_pruefsumme(anlass) "
                + "FROM auffaelligkeit WHERE id = ?", Boolean.class, ANLASS, dezember)).isTrue();
    }

    // ============================================================ A3/A6: Abweichung, Abschluss nur einmal

    @Test
    void derAbschlussMassnahmeOhneVerweisScheitertAmCheck() {
        Kunde k = kunde("A6 Abschluss");
        TenantContext.set(k.tenant());
        UUID aw = abweichung(k, Map.of());
        checkFehler("abweichung_massnahme_verweis_chk", () -> abschliessen(aw, "massnahme", null, BEGRUENDUNG));
        checkFehler("abweichung_massnahme_verweis_chk", () -> abschliessen(aw, "erklaert", k.massnahme(), BEGRUENDUNG));
        checkFehler("abweichung_massnahme_verweis_chk", () -> app.update("UPDATE abweichung SET massnahme_id = ? "
                + "WHERE id = ?", k.massnahme(), aw));
        // Immer mit Ergebnis-Wort und Begründung (10–500).
        checkFehler("abweichung_abschluss_chk", () -> abschliessen(aw, "keine_abweichung", null, "zu kurz"));
        checkFehler("abweichung_abschluss_chk", () -> abschliessen(aw, "ursache_gefunden", null, BEGRUENDUNG));
        checkFehler("abweichung_abschluss_chk", () -> app.update("UPDATE abweichung SET ergebnis = 'erklaert', "
                + "abschluss_begruendung = ? WHERE id = ?", BEGRUENDUNG, aw));
        checkState("23503", () -> abschliessen(aw, "massnahme", UUID.randomUUID(), BEGRUENDUNG));
        // Solange offen: Frist und Verantwortlicher ändern sich (die Begründung steht im Protokoll).
        app.update("UPDATE abweichung SET frist = DATE '2028-02-15', verantwortlich_sub = 'MD', "
                + "verantwortlich_name = 'Murat Demirci' WHERE id = ?", aw);
        // R2: Abschluss am 15.01.2028 mit Ergebnis `massnahme` und dem Verweis auf M-2028-0001.
        abschliessen(aw, "massnahme", k.massnahme(), BEGRUENDUNG);
        assertThat(app.queryForMap("SELECT zustand, ergebnis, massnahme_id, abgeschlossen_am IS NOT NULL AS am "
                + "FROM abweichung WHERE id = ?", aw)).containsEntry("zustand", "abgeschlossen")
                .containsEntry("ergebnis", "massnahme").containsEntry("massnahme_id", k.massnahme())
                .containsEntry("am", true);
        // Der Abschluss ist einmalig; danach ändert sich nichts mehr, auch nicht Frist oder Verantwortlicher.
        checkFehler("abweichung_abschluss_einmalig", () -> abschliessen(aw, "erklaert", null, BEGRUENDUNG));
        checkFehler("abweichung_abschluss_einmalig", () -> app.update("UPDATE abweichung SET frist = DATE '2028-03-01' "
                + "WHERE id = ?", aw));
        checkFehler("abweichung_abschluss_einmalig", () -> app.update("UPDATE abweichung SET zustand = 'offen', "
                + "ergebnis = NULL, massnahme_id = NULL, abschluss_begruendung = NULL, abgeschlossen_am = NULL, "
                + "abgeschlossen_sub = NULL, abgeschlossen_name = NULL, abgeschlossen_rolle = NULL, "
                + "abgeschlossen_art = NULL WHERE id = ?", aw));
        // R8: an der Unternehmens-Kennzahl, erklärt — ohne Maßnahme.
        UUID r8 = abweichung(k, Map.of("kennzahl_id", k.kennzahl(), "bezugsbasis_id", k.basis(), "standort_id",
                KEIN_STANDORT, "monate", "{2026-11}", "verantwortlich_sub", "JW", "verantwortlich_name",
                "Jonas Wendlinger", "eroeffnet_am", OffsetDateTime.parse("2026-12-09T10:00:00+01:00")));
        abschliessen(r8, "erklaert", null, "Baustellenstrom des Anbaus über MS-10 (Aussage JW); keine Maßnahme.");
        // Anker, Anlass und Herkunft ändern sich nie: die App darf es nicht, der Trigger hält es auch sonst.
        UUID offen = abweichung(k, Map.of());
        checkState("42501", () -> app.update("UPDATE abweichung SET monate = '{2027-11,2027-12}' WHERE id = ?", offen));
        checkFehler("abweichung_identitaet_bleibt", () -> root.update("UPDATE abweichung SET monate = '{2027-11,2027-12}' "
                + "WHERE id = ?", offen));
        checkFehler("abweichung_identitaet_bleibt", () -> root.update("UPDATE abweichung SET anlass = ?, "
                + "anlass_pruefsumme = bericht_pruefsumme(?) WHERE id = ?", ANLASS + " ", ANLASS + " ", offen));
        // Sie entsteht offen.
        checkFehler("abweichung_entsteht_offen", () -> abweichung(k, Map.of("zustand", "abgeschlossen", "ergebnis",
                "erklaert", "abschluss_begruendung", BEGRUENDUNG, "abgeschlossen_am", AM_12_01_2028,
                "abgeschlossen_sub", "IK", "abgeschlossen_name", "Ines Kaltenbach", "abgeschlossen_art", "kunde")));
    }

    @Test
    void dieAbweichungZitiertGenauEineKennzahlFassungUndMonate() {
        Kunde k = kunde("A3 Anker");
        TenantContext.set(k.tenant());
        // Monate: JJJJ-MM, aufsteigend, ohne Doppel, mindestens einer.
        abweichung(k, Map.of("monate", "{2027-11,2027-12}"));
        for (String monate : List.of("{}", "{2027-12,2027-11}", "{2027-12,2027-12}", "{2027-12,NULL}", "{2027-1}",
                "{{2027-11},{2027-12}}")) {
            checkFehler("abweichung_monate_chk", () -> abweichung(k, Map.of("monate", monate)));
        }
        root.update("INSERT INTO bezugsbasis_fassung(tenant_id,bezugsbasis_id,fassung,referenzperiode,methode,datenlage,"
                + "gilt_ab,actor_sub,actor_name,actor_rolle,actor_art) VALUES (?,?,2,'2026-11/2027-10','verhaeltnis',"
                + "'vollstaendig','2027-11-01','IK','Ines Kaltenbach','energiemanager','kunde')", k.tenant(), k.basisSt1());
        checkFehler("abweichung_fassung_freigegeben_chk", () -> abweichung(k, Map.of("fassung", 2)));
        checkState("23503", () -> abweichung(k, Map.of("fassung", 9)));
        checkFehler("abweichung_basis_der_kennzahl_chk", () -> abweichung(k, Map.of("bezugsbasis_id", k.basisSt2())));
        checkFehler("abweichung_monat_in_der_fassung_chk", () -> abweichung(k, Map.of("monate", "{2026-10,2026-11}")));
        checkFehler("abweichung_standort_der_kennzahl_chk", () -> abweichung(k, Map.of("standort_id", k.st2())));
        checkFehler("abweichung_standort_der_kennzahl_chk", () -> abweichung(k, Map.of("standort_id", KEIN_STANDORT)));
        checkFehler("abweichung_anlass_pruefsumme_chk", () -> abweichung(k, Map.of("anlass_pruefsumme",
                pruefsumme(ANLASS + " "))));
        checkState("23503", () -> abweichung(k, Map.of("verantwortlich_sub", "XX")));
        // Von Hand mit Wortlaut, warum (10–500) — auch an `im_rahmen`; aus einer Auffälligkeit ohne Pflicht.
        checkFehler("abweichung_herkunft_chk", () -> abweichung(k, Map.of("herkunft_art", "von_hand")));
        checkFehler("abweichung_herkunft_chk", () -> abweichung(k, Map.of("herkunft_art", "von_hand",
                "herkunft_wortlaut", "warum")));
        checkFehler("abweichung_herkunft_chk", () -> abweichung(k, Map.of("herkunft_art", "naht")));
        abweichung(k, Map.of("herkunft_art", "von_hand", "herkunft_wortlaut",
                "Im Rahmen, aber drei Monate in Folge am oberen Rand — bitte ansehen."));
    }

    // ============================================================ LA6: der Zähler und die Frist-Vorgabe

    @Test
    void derZaehlerVergibtAW2028_0001ImJahrDesEroeffnensUndDieFristHatDieVorgabe() {
        Kunde k = kunde("AW Zähler");
        TenantContext.set(k.tenant());
        UUID erste = abweichung(k, Map.of());
        assertThat(kennzeichen(erste)).as("eröffnet am 12.01.2028").isEqualTo("AW-2028-0001");
        // Eine gescheiterte Eröffnung rollt ihre Nummer zurück: kein Loch.
        checkFehler("abweichung_herkunft_chk", () -> abweichung(k, Map.of("herkunft_art", "von_hand")));
        assertThat(kennzeichen(abweichung(k, Map.of()))).isEqualTo("AW-2028-0002");
        // Das Jahr ist das des Eröffnens in der Zeitzone des Unternehmens: 31.12.2027 23:30 UTC ist in Berlin 2028.
        assertThat(kennzeichen(abweichung(k, Map.of("eroeffnet_am", OffsetDateTime.parse("2027-12-31T23:30:00Z")))))
                .isEqualTo("AW-2028-0003");
        assertThat(kennzeichen(abweichung(k, Map.of("eroeffnet_am", OffsetDateTime.parse("2027-12-31T22:30:00Z")))))
                .isEqualTo("AW-2027-0001");
        // Ein ausdrücklich gesetztes Kennzeichen rückt den Zähler dahinter; sein Jahr ist das des Eröffnens.
        abweichung(k, Map.of("kennzeichen", "AW-2028-0009"));
        assertThat(kennzeichen(abweichung(k, Map.of()))).isEqualTo("AW-2028-0010");
        checkFehler("abweichung_kennzeichen_jahr_chk", () -> abweichung(k, Map.of("kennzeichen", "AW-2027-0005")));
        checkFehler("abweichung_kennzeichen_chk", () -> abweichung(k, Map.of("kennzeichen", "AW-2028-0000")));
        checkEindeutig("abweichung_kennzeichen_uq", () -> abweichung(k, Map.of("kennzeichen", "AW-2028-0001")));
        // Maßnahmen und Energieziele zählen ihre eigene Reihe weiter (M-2028-0001 steht im Bestand).
        assertThat(app.queryForObject("SELECT uems_verbesserung_kennung(?, 'M', 2028)", String.class, k.tenant()))
                .isEqualTo("M-2028-0002");
        // R8: eröffnet am 09.12.2026 ohne Frist → Vorgabe dreißig Tage, 08.01.2027; eine gesetzte bleibt.
        UUID r8 = abweichung(k, Map.of("frist", KEINE_FRIST, "eroeffnet_am",
                OffsetDateTime.parse("2026-12-09T10:00:00+01:00"), "monate", "{2026-11}"));
        assertThat(app.queryForMap("SELECT kennzeichen, frist::text AS frist FROM abweichung WHERE id = ?", r8))
                .containsEntry("kennzeichen", "AW-2026-0001").containsEntry("frist", "2027-01-08");
        assertThat(app.queryForObject("SELECT frist::text FROM abweichung WHERE id = ?", String.class, erste))
                .isEqualTo("2028-01-31");
        // Je Kundenbereich: ein anderer beginnt wieder bei 0001.
        Kunde anderer = kunde("AW Zähler B");
        TenantContext.set(anderer.tenant());
        assertThat(kennzeichen(abweichung(anderer, Map.of()))).isEqualTo("AW-2028-0001");
    }

    // ============================================================ A4/U1/U2: das Protokoll, nur anhängen

    @Test
    void dieAppLoeschtNieUndDasProtokollWirdNurAngehaengt() {
        Kunde k = kunde("A4 Protokoll");
        TenantContext.set(k.tenant());
        UUID vermerk = vermerk(k, "2027-12", Map.of());
        UUID aw = abweichung(k, Map.of());
        antworten(vermerk, "abweichung", aw, null);
        // R2: zwei Kommentare und die Ursache-Aussage von Murat, eingetragen von Ines, ohne Beleg („keine Messung“).
        eintrag(k, aw, "abweichung_eroeffnet", Map.of());
        eintrag(k, aw, "kommentar", Map.of("kommentar", "Produktion 21,9 % unter November, Strom nur 8,8 % — bitte "
                + "Halle 1 prüfen: liefen Werkzeugheizungen über die Feiertage?"));
        eintrag(k, aw, "ursache_aussage", aussage("MD", "Murat Demirci", null));
        eintrag(k, aw, "kommentar", Map.of("kommentar", "x".repeat(2000)));
        // Mit Beleg: „Aussage mit Beleg K-2028-0001“; die Person muss kein Konto haben.
        eintrag(k, aw, "ursache_aussage", aussage(null, "Elektro Kranz GmbH (Wartung)", "K-2028-0001"));
        // Frist und Verantwortlicher ändern sich nur mit Begründung (10–500).
        eintrag(k, aw, "abweichung_geaendert", Map.of("alt", "{\"frist\":\"2028-01-31\"}", "neu",
                "{\"frist\":\"2028-02-15\"}", "begruendung", "Messdaten der Halle 1 kommen erst am 10.02.2028."));
        checkFehler("abweichung_aenderung_begruendung_chk", () -> eintrag(k, aw, "abweichung_geaendert", Map.of()));
        checkFehler("abweichung_aenderung_begruendung_chk", () -> eintrag(k, aw, "verantwortlicher_geaendert",
                Map.of("begruendung", "Urlaub")));
        // Ein Kommentar hat Text (1–2 000 Zeichen); keine andere Zeile hat einen.
        checkFehler("abweichung_aenderung_kommentar_chk", () -> eintrag(k, aw, "kommentar",
                Map.of("kommentar", "x".repeat(2001))));
        checkFehler("abweichung_aenderung_kommentar_chk", () -> eintrag(k, aw, "kommentar", Map.of("kommentar", " ")));
        checkFehler("abweichung_aenderung_kommentar_chk", () -> eintrag(k, aw, "kommentar", Map.of()));
        checkFehler("abweichung_aenderung_kommentar_chk", () -> eintrag(k, aw, "abweichung_abgeschlossen",
                Map.of("kommentar", "Text")));
        // Die Ursache ist immer die Aussage einer Person: Wortlaut (10–500), Name, Tag; nur sie trägt einen Beleg.
        Map<String, Object> ohneName = aussage("MD", "Murat Demirci", null);
        ohneName.put("aussage_name", " ");
        checkFehler("abweichung_aenderung_ursache_chk", () -> eintrag(k, aw, "ursache_aussage", ohneName));
        Map<String, Object> kurz = aussage("MD", "Murat Demirci", null);
        kurz.put("aussage_wortlaut", "Heizung.");
        checkFehler("abweichung_aenderung_ursache_chk", () -> eintrag(k, aw, "ursache_aussage", kurz));
        Map<String, Object> ohneTag = aussage("MD", "Murat Demirci", null);
        ohneTag.remove("aussage_am");
        checkFehler("abweichung_aenderung_ursache_chk", () -> eintrag(k, aw, "ursache_aussage", ohneTag));
        checkFehler("abweichung_aenderung_ursache_chk", () -> eintrag(k, aw, "kommentar", Map.of("kommentar", "Beleg?",
                "beleg_kennung", "K-2028-0001")));
        checkFehler("abweichung_aenderung_ursache_chk", () -> eintrag(k, aw, "kommentar", Map.of("kommentar", "Wer?",
                "aussage_name", "Murat Demirci")));
        checkFehler("abweichung_aenderung_art_chk", () -> eintrag(k, aw, "leckage", Map.of()));
        checkFehler("abweichung_aenderung_art_chk", () -> eintrag(k, aw, "massnahme_bewertet", Map.of()));
        // Die App löscht nie und ändert keine Protokollzeile.
        for (String sql : List.of("DELETE FROM abweichung WHERE id = ?", "DELETE FROM abweichung_aenderung "
                + "WHERE abweichung_id = ?", "DELETE FROM auffaelligkeit WHERE abweichung_id = ?")) {
            checkState("42501", () -> app.update(sql, aw));
        }
        checkState("42501", () -> app.update("UPDATE abweichung_aenderung SET kommentar = 'anders' WHERE abweichung_id = ?",
                aw));
        // Ein Protokoll überlebt sein Objekt: kein Fremdschlüssel auf die Abweichung.
        assertThat(root.queryForObject("SELECT count(*) FROM pg_constraint WHERE conrelid = 'abweichung_aenderung'::regclass "
                + "AND contype = 'f' AND pg_get_constraintdef(oid) LIKE '%abweichung%'", Integer.class)).isZero();
        assertThat(app.queryForList("SELECT art FROM abweichung_aenderung WHERE abweichung_id = ? ORDER BY id",
                String.class, aw)).containsExactly("abweichung_eroeffnet", "kommentar", "ursache_aussage", "kommentar",
                "ursache_aussage", "abweichung_geaendert");
        assertThat(app.queryForObject("SELECT count(*) FROM abweichung_aenderung WHERE abweichung_id = ? "
                + "AND beleg_kennung IS NULL AND art = 'ursache_aussage'", Integer.class, aw)).as("keine Messung").isOne();
    }

    // ============================================================ RE2: Mandanten- und Standort-Zaun

    @Test
    void derMandantenzaunHaeltMandantASiehtBNicht() {
        Kunde a = kunde("Zaun A");
        Kunde b = kunde("Zaun B");
        TenantContext.set(b.tenant());
        vollerVorgang(b, b.kennzahlSt1(), b.basisSt1(), b.st1());
        TenantContext.set(a.tenant());
        for (String t : TABELLEN) {
            assertThat(app.queryForObject("SELECT count(*) FROM " + t + " WHERE tenant_id = ?", Integer.class, b.tenant()))
                    .as(t).isZero();
        }
        // Fremde Zeilen einschleusen: RLS-Prüfung bzw. der Mandant reist im Verweis mit.
        checkState("42501", () -> vermerk(b, "2028-01", Map.of()));
        checkState("42501", () -> abweichung(b, Map.of()));
        checkState("23503", () -> vermerk(a, "2028-01", Map.of("kennzahl_id", b.kennzahlSt1(), "bezugsbasis_id",
                b.basisSt1())));
        checkState("23503", () -> abweichung(a, Map.of("kennzahl_id", b.kennzahlSt1(), "bezugsbasis_id", b.basisSt1())));
        UUID aw = abweichung(a, Map.of());
        checkState("23503", () -> abschliessen(aw, "massnahme", b.massnahme(), BEGRUENDUNG));
        TenantContext.clear();
        for (String t : TABELLEN) {
            assertThat(app.queryForObject("SELECT count(*) FROM " + t, Integer.class)).as(t).isZero();
        }
    }

    @Test
    void derStandortZaunZeigtEinemFremdenStandortNullZeilenUndNieEineAmUnternehmen() {
        Kunde k = kunde("Standort-Zaun");
        TenantContext.set(k.tenant());
        UUID amUnternehmen = vollerVorgang(k, k.kennzahl(), k.basis(), null);
        UUID amSt1 = vollerVorgang(k, k.kennzahlSt1(), k.basisSt1(), k.st1());
        UUID amSt2 = vollerVorgang(k, k.kennzahlSt2(), k.basisSt2(), k.st2());
        TenantContext.clear();
        // Nur ST-2: seine Abweichung mit Vermerk und Protokoll; ST-1 und das Unternehmen — 0 Zeilen.
        eng(k.tenant(), List.of(k.st2()), jdbc -> {
            assertThat(jdbc.queryForList("SELECT id FROM abweichung", UUID.class)).containsExactly(amSt2);
            assertThat(jdbc.queryForList("SELECT DISTINCT abweichung_id FROM abweichung_aenderung", UUID.class))
                    .containsExactly(amSt2);
            assertThat(jdbc.queryForList("SELECT abweichung_id FROM auffaelligkeit", UUID.class)).containsExactly(amSt2);
            for (String t : List.of("abweichung_aenderung", "auffaelligkeit")) {
                assertThat(jdbc.queryForObject("SELECT count(*) FROM " + t + " WHERE abweichung_id IN (?, ?)", Integer.class,
                        amSt1, amUnternehmen)).as(t).isZero();
            }
            assertThat(jdbc.update("UPDATE abweichung SET frist = DATE '2028-03-01' WHERE id = ?", amSt1)).isZero();
            checkState("42501", () -> jdbc.update("INSERT INTO abweichung_aenderung(tenant_id,abweichung_id,art,kommentar,"
                    + "actor_sub,actor_name,actor_art) VALUES (?,?,'kommentar','fremd','PH','Peter Hollerbach','kunde')",
                    k.tenant(), amSt1));
            checkState("42501", () -> jdbc.update("INSERT INTO auffaelligkeit(tenant_id,kennzahl_id,bezugsbasis_id,fassung,"
                    + "periode,standort_id,anlass,anlass_pruefsumme) VALUES (?,?,?,1,'2028-03',?,?,?)", k.tenant(),
                    k.kennzahlSt1(), k.basisSt1(), k.st1(), ANLASS, pruefsumme(ANLASS)));
            checkState("42501", () -> jdbc.update("INSERT INTO abweichung(tenant_id,kennzahl_id,bezugsbasis_id,fassung,"
                    + "monate,herkunft_art,anlass,anlass_pruefsumme,verantwortlich_sub,verantwortlich_name,"
                    + "verantwortlich_konto,frist,actor_sub,actor_name,actor_art) VALUES (?,?,?,1,'{2028-03}',"
                    + "'auffaelligkeit',?,?,'PH','Peter Hollerbach','benutzer',DATE '2028-05-01','PH','Peter Hollerbach',"
                    + "'kunde')", k.tenant(), k.kennzahl(), k.basis(), ANLASS, pruefsumme(ANLASS)));
            return null;
        });
        eng(k.tenant(), List.of(k.st1()), jdbc -> {
            assertThat(jdbc.queryForList("SELECT id FROM abweichung", UUID.class)).containsExactly(amSt1);
            assertThat(jdbc.queryForList("SELECT abweichung_id FROM auffaelligkeit", UUID.class)).containsExactly(amSt1);
            return null;
        });
        // Unternehmensweit: alle drei.
        eng(k.tenant(), null, jdbc -> {
            assertThat(jdbc.queryForObject("SELECT count(*) FROM abweichung", Integer.class)).isEqualTo(3);
            assertThat(jdbc.queryForObject("SELECT count(*) FROM auffaelligkeit", Integer.class)).isEqualTo(3);
            assertThat(jdbc.queryForObject("SELECT count(DISTINCT abweichung_id) FROM abweichung_aenderung",
                    Integer.class)).isEqualTo(3);
            return null;
        });
    }

    // ============================================================ RE1: Rechte, RLS, Matrix, Vokabulare

    @Test
    void dieRechteSindBeschnittenUndKeineNeueKennungKommtHinzu() throws IOException {
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
        assertThat(root.queryForObject("SELECT has_table_privilege(?, 'abweichung_aenderung', 'UPDATE')", Boolean.class, APP))
                .isFalse();
        assertThat(root.queryForObject("SELECT has_sequence_privilege(?, 'abweichung_aenderung_id_seq', 'USAGE')",
                Boolean.class, APP)).isTrue();
        // Nur benannte Spalten: Frist ja, Anker und Anlass nie.
        for (String[] spalte : new String[][] {{"abweichung", "frist", "true"}, {"abweichung", "massnahme_id", "true"},
                {"abweichung", "anlass", "false"}, {"abweichung", "monate", "false"}, {"abweichung", "standort_id", "false"},
                {"auffaelligkeit", "antwort", "true"}, {"auffaelligkeit", "anlass", "false"},
                {"auffaelligkeit", "periode", "false"}}) {
            assertThat(root.queryForObject("SELECT has_column_privilege(?, ?, ?, 'UPDATE')", Boolean.class, APP, spalte[0],
                    spalte[1])).as(spalte[0] + "." + spalte[1]).isEqualTo(Boolean.parseBoolean(spalte[2]));
        }
        // §4.9 RE1: die drei Kennungen aus IP-5 decken Eröffnen, Einträge, Antwort und Abschluss — keine neue.
        JsonNode matrix = MAPPER.readTree(Path.of("../../docs/contracts/v2/rechte-matrix.json").toFile());
        List<String> kennungen = new ArrayList<>();
        matrix.path("aktionen").forEach(r -> {
            String kennung = r.path("kennung").asText();
            if (kennung.startsWith("verbesserung.") || kennung.contains("abweichung") || kennung.contains("auffaellig")) {
                kennungen.add(kennung);
            }
        });
        assertThat(kennungen).containsExactlyInAnyOrder("verbesserung.verwalten", "verbesserung.abschliessen",
                "verbesserung.ansehen");
    }

    /** Die Funktion wird nur geweitet: jede Zeile von IP-5 und IP-9 bleibt, dazu genau die zwei Listen der Tabellen. */
    @Test
    void dasVokabularWirdNurGeweitet() {
        List<String> nachher = vokabular();
        assertThat(vokabularVorher).hasSize(86);
        assertThat(nachher.subList(0, vokabularVorher.size())).containsExactlyElementsOf(vokabularVorher);
        List<String> neu = new ArrayList<>(nachher);
        neu.removeAll(vokabularVorher);
        assertThat(neu).containsExactly("abweichung_herkunft:1:auffaelligkeit", "abweichung_herkunft:2:von_hand",
                "abweichung_protokoll:1:abweichung_eroeffnet", "abweichung_protokoll:2:kommentar",
                "abweichung_protokoll:3:ursache_aussage", "abweichung_protokoll:4:abweichung_geaendert",
                "abweichung_protokoll:5:verantwortlicher_geaendert", "abweichung_protokoll:6:abweichung_abgeschlossen",
                // AP-19 IP-17 weitet dahinter die Herkunft der Maßnahme.
                "massnahme_herkunft:5:nichtkonformitaet", "massnahme_herkunft:6:audit",
                "massnahme_herkunft:7:managementbewertung");
        // Die Einträge des Vertrags (`abweichung_eintrag_art`) sind Wörter des Protokolls.
        assertThat(root.queryForList("SELECT wort FROM verbesserung_vokabular() WHERE vokabular = 'abweichung_eintrag_art' "
                + "EXCEPT SELECT wort FROM verbesserung_vokabular() WHERE vokabular = 'abweichung_protokoll'", String.class))
                .isEmpty();
    }

    @Test
    void dasOffboardingRaeumtAlleTabellenVorMassnahmeFassungKennzahlStandortUndBenutzerAb() {
        Kunde k = kunde("Offboarding");
        TenantContext.set(k.tenant());
        UUID aw = vollerVorgang(k, k.kennzahlSt1(), k.basisSt1(), k.st1());
        abschliessen(aw, "massnahme", k.massnahme(), BEGRUENDUNG);
        vermerk(k, "2028-07", Map.of());
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
        assertThat(fingerVorher.get("massnahme")).as("es gibt Bestand").isNotEqualTo(Bestandsschutz.LEER);
        assertThat(fingerVorher.get("bezugsbasis_fassung")).as("es gibt Bestand").isNotEqualTo(Bestandsschutz.LEER);
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
        for (String tabelle : TABELLEN) {
            assertThat(fingerNachMigration).as(tabelle).containsEntry(tabelle, Bestandsschutz.LEER);
        }
    }

    @Test
    void derBestandsvergleichFaengtEineGeaenderteZeile() {
        Bestandsschutz.mutationsprobe(root, List.of(), "massnahme", "UPDATE massnahme SET titel = titel || ' (Probe)'");
    }

    /** Out-of-order: auf einer Datenbank mit ALLEN anderen Migrationen kommt diese zuletzt an und trägt genauso. */
    @Test
    void dieMigrationTraegtAuchAlsSpaeteAnkunft() throws IOException {
        root.execute("CREATE DATABASE voltpilot_spaet");
        String url = POSTGRES.getJdbcUrl().replace("/voltpilot?", "/voltpilot_spaet?");
        Path ohneDiese = Files.createTempDirectory("ohne-abweichung");
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
        String liste = "'" + String.join("', '", TABELLEN) + "'";
        String schema = "SELECT string_agg(conrelid::regclass || ':' || conname || ':' || pg_get_constraintdef(oid), '|' "
                + "ORDER BY conrelid::regclass::text, conname) FROM pg_constraint WHERE conrelid::regclass::text IN (" + liste + ")";
        assertThat(spaetDb.queryForObject(schema, String.class)).isEqualTo(root.queryForObject(schema, String.class));
        String policies = "SELECT string_agg(tablename || ':' || policyname || ':' || permissive || ':' || qual, '|' "
                + "ORDER BY tablename, policyname) FROM pg_policies WHERE tablename IN (" + liste + ")";
        assertThat(spaetDb.queryForObject(policies, String.class)).isEqualTo(root.queryForObject(policies, String.class));
        String trigger = "SELECT string_agg(tgrelid::regclass || ':' || tgname, '|' ORDER BY tgrelid::regclass::text, tgname) "
                + "FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text IN (" + liste + ")";
        assertThat(spaetDb.queryForObject(trigger, String.class)).isEqualTo(root.queryForObject(trigger, String.class));
        String woerter = "SELECT string_agg(vokabular || ':' || nr || ':' || wort, '|' ORDER BY vokabular, nr) "
                + "FROM verbesserung_vokabular()";
        assertThat(spaetDb.queryForObject(woerter, String.class)).isEqualTo(root.queryForObject(woerter, String.class));
    }

    // ============================================================ Gerüst

    /** Markiert „Spalte ausdrücklich NULL“ in den Vorgaben (Map.of kennt kein null). */
    private static final Object KEIN_STANDORT = new Object(), KEINE_FRIST = new Object();

    /** Kundenbereich mit allem, woran Vermerk und Abweichung hängen (nur Tabellen, die es vor dieser Migration gibt). */
    private static Kunde kunde(String name) {
        UUID tenant = root.queryForObject("INSERT INTO tenant(name) VALUES (?) RETURNING id", UUID.class, name);
        UUID unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name) VALUES (?,?) RETURNING id",
                UUID.class, tenant, name);
        for (String[] p : new String[][] {{"IK", "Ines Kaltenbach"}, {"MD", "Murat Demirci"}, {"JW", "Jonas Wendlinger"},
                {"PH", "Peter Hollerbach"}}) {
            root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,?,'benutzer',?,'aktiv')",
                    tenant, p[0], p[1]);
        }
        UUID st1 = UUID.randomUUID(), st2 = UUID.randomUUID();
        for (Object[] s : new Object[][] {{st1, "Werk Ahrenberg", "AHR"}, {st2, "Werk Lindach", "LIN"}}) {
            root.update("INSERT INTO standort (id, tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                    + "VALUES (?, ?, ?, ?, ?, 'Europe/Berlin', 'aktiv')", s[0], tenant, unternehmen, s[1], s[2]);
        }
        UUID kz = kennzahl(tenant, "KZ-0005", "unternehmen", unternehmen, null);
        UUID kz1 = kennzahl(tenant, "KZ-0004", "standort", null, st1);
        UUID kz2 = kennzahl(tenant, "KZ-0006", "standort", null, st2);
        UUID massnahme = root.queryForObject("INSERT INTO massnahme(tenant_id,titel,verantwortlich_sub,verantwortlich_name,"
                + "verantwortlich_konto,termin,standort_id,herkunft_art,herkunft_kennung,erwartete_wirkung_wortlaut,actor_sub,"
                + "actor_name,actor_rolle,actor_art,angelegt_am) VALUES (?,'Werkzeugheizungen in Betriebspausen abschalten',"
                + "'MD','Murat Demirci','benutzer',DATE '2028-01-31',?,'abweichung','AW-2028-0001','Abschaltung spart "
                + "geschätzt 3 % des Prozessstroms.','IK','Ines Kaltenbach','energiemanager','kunde',"
                + "TIMESTAMPTZ '2028-01-15 10:00+01') RETURNING id", UUID.class, tenant, st1);
        return new Kunde(tenant, unternehmen, st1, st2, kz, basis(tenant, kz, "BB-0002"), kz1, basis(tenant, kz1, "BB-0001"),
                kz2, basis(tenant, kz2, "BB-0003"), massnahme);
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

    /** R1: ein Vermerk der Naht an KZ-0004 (ST-1) × BB-0001 Fassung 1 für den Monat, mit Anlass und Prüfsumme. */
    private static UUID vermerk(Kunde k, String periode, Map<String, Object> spalten) {
        Map<String, Object> werte = new LinkedHashMap<>();
        werte.put("tenant_id", k.tenant());
        werte.put("kennzahl_id", k.kennzahlSt1());
        werte.put("bezugsbasis_id", k.basisSt1());
        werte.put("fassung", 1);
        werte.put("periode", periode);
        werte.put("standort_id", k.st1());
        werte.put("anlass", ANLASS);
        werte.put("anlass_pruefsumme", pruefsumme(ANLASS));
        werte.put("vermerkt_am", AM_07_01_2028);
        werte.putAll(spalten);
        return einfuegen("auffaelligkeit", werte);
    }

    /**
     * R1/R2: AW-… an KZ-0004 (ST-1) × BB-0001 Fassung 1 × Dezember 2027, aus der Auffälligkeit, verantwortlich Ines,
     * Frist 31.01.2028, eröffnet von Ines am 12.01.2028 — mit den genannten Abweichungen.
     */
    private static UUID abweichung(Kunde k, Map<String, Object> spalten) {
        Map<String, Object> werte = new LinkedHashMap<>();
        werte.put("tenant_id", k.tenant());
        werte.put("kennzahl_id", k.kennzahlSt1());
        werte.put("bezugsbasis_id", k.basisSt1());
        werte.put("fassung", 1);
        werte.put("monate", "{2027-12}");
        werte.put("herkunft_art", "auffaelligkeit");
        werte.put("anlass", ANLASS);
        werte.put("anlass_pruefsumme", pruefsumme(ANLASS));
        werte.put("verantwortlich_sub", "IK");
        werte.put("verantwortlich_name", "Ines Kaltenbach");
        werte.put("verantwortlich_konto", "benutzer");
        werte.put("frist", LocalDate.parse("2028-01-31"));
        werte.put("standort_id", k.st1());
        werte.put("actor_sub", "IK");
        werte.put("actor_name", "Ines Kaltenbach");
        werte.put("actor_rolle", "energiemanager");
        werte.put("actor_art", "kunde");
        werte.put("eroeffnet_am", AM_12_01_2028);
        werte.putAll(spalten);
        return einfuegen("abweichung", werte);
    }

    private static UUID einfuegen(String tabelle, Map<String, Object> werte) {
        werte.replaceAll((spalte, wert) -> wert == KEIN_STANDORT || wert == KEINE_FRIST ? null : wert);
        String sql = "INSERT INTO " + tabelle + "(" + String.join(",", werte.keySet()) + ") VALUES ("
                + String.join(",", werte.keySet().stream().map(s -> "monate".equals(s) ? "?::text[]" : "?").toList())
                + ") RETURNING id";
        return app.queryForObject(sql, UUID.class, werte.values().toArray());
    }

    private static String kennzeichen(UUID abweichung) {
        return app.queryForObject("SELECT kennzeichen FROM abweichung WHERE id = ?", String.class, abweichung);
    }

    private static void antworten(UUID vermerk, String antwort, UUID abweichung, String begruendung) {
        app.update("UPDATE auffaelligkeit SET zustand = 'beantwortet', antwort = ?, abweichung_id = ?, "
                + "antwort_begruendung = ?, beantwortet_am = now(), beantwortet_sub = 'IK', "
                + "beantwortet_name = 'Ines Kaltenbach', beantwortet_rolle = 'energiemanager', beantwortet_art = 'kunde' "
                + "WHERE id = ?", antwort, abweichung, begruendung, vermerk);
    }

    private static void abschliessen(UUID abweichung, String ergebnis, UUID massnahme, String begruendung) {
        app.update("UPDATE abweichung SET zustand = 'abgeschlossen', ergebnis = ?, massnahme_id = ?, "
                + "abschluss_begruendung = ?, abgeschlossen_sub = 'IK', abgeschlossen_name = 'Ines Kaltenbach', "
                + "abgeschlossen_rolle = 'energiemanager', abgeschlossen_art = 'kunde' WHERE id = ?", ergebnis, massnahme,
                begruendung, abweichung);
    }

    /** Eine Protokollzeile, eingetragen von Ines; `alt`/`neu` als JSON-Text. */
    private static void eintrag(Kunde k, UUID abweichung, String art, Map<String, Object> spalten) {
        Map<String, Object> werte = new LinkedHashMap<>();
        werte.put("tenant_id", k.tenant());
        werte.put("abweichung_id", abweichung);
        werte.put("art", art);
        werte.put("actor_sub", "IK");
        werte.put("actor_name", "Ines Kaltenbach");
        werte.put("actor_rolle", "energiemanager");
        werte.put("actor_art", "kunde");
        werte.putAll(spalten);
        app.update("INSERT INTO abweichung_aenderung(" + String.join(",", werte.keySet()) + ") VALUES ("
                + String.join(",", werte.keySet().stream().map(s -> s.equals("alt") || s.equals("neu") ? "?::jsonb" : "?")
                        .toList()) + ")", werte.values().toArray());
    }

    /** U1/U2: die Aussage einer Person (R2: Murat, 14.01.2028), wahlfrei mit Beleg-Kennung. */
    private static Map<String, Object> aussage(String sub, String name, String beleg) {
        Map<String, Object> werte = new LinkedHashMap<>();
        werte.put("aussage_wortlaut", "Die Werkzeugheizungen der Maschinen 3 bis 6 liefen vom 23.12. bis 02.01. durch — "
                + "keine Abschaltung in der Betriebspause programmiert.");
        werte.put("aussage_sub", sub);
        werte.put("aussage_name", name);
        werte.put("aussage_am", LocalDate.parse("2028-01-14"));
        werte.put("beleg_kennung", beleg);
        return werte;
    }

    /** Vermerk, Abweichung aus ihm (Antwort), zwei Protokollzeilen — an der genannten Kennzahl und ihrem Standort. */
    private static UUID vollerVorgang(Kunde k, UUID kennzahl, UUID basis, UUID standort) {
        Object ort = standort == null ? KEIN_STANDORT : standort;
        UUID vermerk = vermerk(k, "2027-12", Map.of("kennzahl_id", kennzahl, "bezugsbasis_id", basis, "standort_id", ort));
        UUID aw = abweichung(k, Map.of("kennzahl_id", kennzahl, "bezugsbasis_id", basis, "standort_id", ort));
        antworten(vermerk, "abweichung", aw, null);
        eintrag(k, aw, "abweichung_eroeffnet", Map.of());
        eintrag(k, aw, "kommentar", Map.of("kommentar", "Bitte Halle 1 prüfen."));
        return aw;
    }

    private static String pruefsumme(String text) {
        return root.queryForObject("SELECT bericht_pruefsumme(?)", String.class, text);
    }

    private static List<String> vokabular() {
        return root.queryForList("SELECT vokabular || ':' || nr || ':' || wort FROM verbesserung_vokabular()", String.class);
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
        pruefeVerletzung("23514", constraint, aktion);
    }

    private static void checkEindeutig(String constraint, Runnable aktion) {
        pruefeVerletzung("23505", constraint, aktion);
    }

    private static void pruefeVerletzung(String state, String constraint, Runnable aktion) {
        Throwable fehler = catchThrowable(aktion::run);
        assertThat(fehler).as("erwartet " + state + " " + constraint).isInstanceOf(DataAccessException.class);
        Throwable ursache = ((DataAccessException) fehler).getMostSpecificCause();
        assertThat(((SQLException) ursache).getSQLState()).as(ursache.getMessage()).isEqualTo(state);
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
