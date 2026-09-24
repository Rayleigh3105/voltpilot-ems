package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.io.IOException;
import java.math.BigDecimal;
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
 * AP-18 IP-9: die Datenhaltung der Maßnahme (M1, M2, M4, M5, M6, M7, WK6) unter der wirklichen App-Rolle. Die
 * Datenbank hält „eine Zahl der erwarteten Wirkung und eine Ausgangslage nur mit Messgrundlage“, „die Messgrundlage
 * zitiert eine freigegebene Fassung der Kennzahl“, den Zähler M-2028-0001 im Jahr des Anlegens, die einmaligen
 * Übergänge („umgesetzt“ nie in der Zukunft und nie zweimal), die Stände Nr. n mit Prüfsumme und Vier-Augen („ohne
 * Messgrundlage nur nicht messbar“), den Anstoß mit genau einem Bezug (eindeutig je Vorgang × Art × Anlass, Antwort
 * einmalig), das Protokoll nur zum Anhängen, den Mandanten- und den Standort-Zaun und die Rechte selbst; die Migration
 * legt nur daneben und trägt auch als späte Ankunft.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsMassnahmeMigrationTest {

    private static final String DIESE = "20260924233000";
    /** Spätere Migrationen, die auf diese aufbauen: sie reisen bei der späten Ankunft mit. */
    private static final List<String> BAUEN_DARAUF_AUF = List.of(
            "20260924235130"); // AP-18 IP-14: die Abweichung verweist auf ihre Maßnahme und weitet das Vokabular.
    private static final String APP = "voltpilot_app", ADMIN = "voltpilot_admin", PW = "ap18_ip9_test_pw";
    private static final List<String> TABELLEN = List.of("massnahme", "massnahme_aenderung", "massnahme_bewertung",
            "vorgang_anstoss");
    private static final String BEGRUENDUNG = "Zeitschaltung seit 22.01.2028 aktiv, Maschinen 3–6 umgestellt.";
    private static final OffsetDateTime AM_15_01_2028 = OffsetDateTime.parse("2028-01-15T10:00:00+01:00");
    private static final OffsetDateTime AM_22_01_2028 = OffsetDateTime.parse("2028-01-22T16:00:00+01:00");
    /** Die Ausgangslage von M-2028-0001 (R3): Dezember 2027, +12,9 % — als kanonischer Text. */
    private static final String AUSGANGSLAGE = "{\"bezugsbasis\":\"BB-0001\",\"delta_prozent\":12.9,\"erwartet_kwh\":69098,"
            + "\"fassung\":1,\"gemessen_kwh\":78000,\"gemessen_version\":1,\"kennzahl\":\"KZ-0004\",\"monat\":\"2027-12\","
            + "\"urteil\":\"schlechter\"}";
    /** Die Kopie der Wirkung zum 15.11.2028 (R5/R6): 2,4 % weniger, 8 von 12 Monaten. */
    private static final String WIRKUNG = "{\"abruf\":\"2028-11-15\",\"bewertbar\":8,\"delta_prozent\":-2.4,"
            + "\"nachher\":\"2028-02/2029-01\",\"von\":12}";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root, app, admin;
    private static Map<String, String> fingerVorher, fingerNachMigration;
    private static List<String> vokabularVorher;
    private static final ObjectMapper MAPPER = new ObjectMapper();

    /**
     * Ein Kundenbereich mit zwei Standorten, einer Unternehmens- und zwei Standort-Kennzahlen samt freigegebener Basis,
     * dem Einsatz EE-1 (Einstufung 1 freigegeben, 2 beantragt) und dem Energieziel EZ-2028-0001 an der Kennzahl von ST-1.
     */
    private record Kunde(UUID tenant, UUID unternehmen, UUID st1, UUID st2, UUID kennzahl, UUID basis,
            UUID kennzahlSt1, UUID basisSt1, UUID kennzahlSt2, UUID basisSt2, UUID einsatz, UUID ziel) {
    }

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway(POSTGRES.getJdbcUrl()).target(letzteFassungVorDieser()).load().migrate();
        // Bestand vor der Migration: Kennzahlen, Benutzer, Bezugsbasen, Einsatz mit Einstufungen, ein Energieziel.
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

    // ============================================================ M2/M4: Zahl und Ausgangslage nur mit Messgrundlage

    @Test
    void eineZahlOderAusgangslageOhneMessgrundlageScheitertAmCheck() {
        Kunde k = kunde("M4 Messgrundlage");
        TenantContext.set(k.tenant());
        // R7: ohne Messgrundlage erlaubt — mit Wortlaut, ohne Zahl.
        UUID ohne = massnahme(k, null, Map.of("titel", "Druckluft-Leckagen orten und beseitigen"));
        assertThat(app.queryForMap("SELECT kennzahl_id, ausgangslage, erwartete_wirkung_prozent FROM massnahme WHERE id = ?",
                ohne).values()).containsOnlyNulls();
        // Eine Zahl ohne Messgrundlage, eine Ausgangslage ohne Messgrundlage, eine Messgrundlage ohne Ausgangslage
        // oder nur zur Hälfte: der CHECK.
        checkFehler("massnahme_messgrundlage_chk",
                () -> massnahme(k, null, Map.of("erwartete_wirkung_prozent", new BigDecimal("-3.0"))));
        checkFehler("massnahme_messgrundlage_chk", () -> massnahme(k, null,
                Map.of("ausgangslage", AUSGANGSLAGE, "ausgangslage_pruefsumme", pruefsumme(AUSGANGSLAGE))));
        checkFehler("massnahme_messgrundlage_chk", () -> massnahme(k, k.st1(), Map.of("kennzahl_id", k.kennzahlSt1(),
                "bezugsbasis_id", k.basisSt1(), "fassung", 1)));
        checkFehler("massnahme_messgrundlage_chk", () -> massnahme(k, k.st1(), Map.of("kennzahl_id", k.kennzahlSt1(),
                "ausgangslage", AUSGANGSLAGE, "ausgangslage_pruefsumme", pruefsumme(AUSGANGSLAGE))));
        // Der Wortlaut der erwarteten Wirkung ist immer Pflicht, die Zahl hat eine Stelle.
        checkFehler("massnahme_wirkung_chk", () -> massnahme(k, null, Map.of("erwartete_wirkung_wortlaut", " ")));
        checkState("23502", () -> {
            Map<String, Object> ohneWortlaut = new LinkedHashMap<>();
            ohneWortlaut.put("erwartete_wirkung_wortlaut", null);
            massnahme(k, null, ohneWortlaut);
        });
        checkFehler("massnahme_wirkung_chk", () -> mitMessgrundlage(k, Map.of("erwartete_wirkung_prozent",
                new BigDecimal("-3.05"))));
        // Die Prüfsumme der Ausgangslage hält die Datenbank.
        checkFehler("massnahme_ausgangslage_pruefsumme_chk", () -> mitMessgrundlage(k,
                Map.of("ausgangslage_pruefsumme", "sha256:" + "0".repeat(64))));
        checkFehler("massnahme_ausgangslage_pruefsumme_chk", () -> mitMessgrundlage(k,
                Map.of("ausgangslage", "[1]", "ausgangslage_pruefsumme", pruefsumme("[1]"))));
        // Mit Messgrundlage: Zahl, Ausgangslage mit Prüfsumme (R3).
        UUID mit = mitMessgrundlage(k, Map.of());
        assertThat(app.queryForObject("SELECT ausgangslage_pruefsumme FROM massnahme WHERE id = ?", String.class, mit))
                .isEqualTo(pruefsumme(AUSGANGSLAGE)).startsWith("sha256:");
    }

    @Test
    void dieMessgrundlageZitiertEineFreigegebeneFassungIhrerKennzahlUndDerStandortFolgtIhr() {
        Kunde k = kunde("M2 Fassung");
        TenantContext.set(k.tenant());
        // Fassung 2 ist ein Entwurf: nicht freigegeben, also keine Messgrundlage daran.
        root.update("INSERT INTO bezugsbasis_fassung(tenant_id,bezugsbasis_id,fassung,referenzperiode,methode,datenlage,"
                + "gilt_ab,actor_sub,actor_name,actor_rolle,actor_art) VALUES (?,?,2,'2026-11/2027-10','verhaeltnis',"
                + "'vollstaendig','2027-11-01','IK','Ines Kaltenbach','energiemanager','kunde')", k.tenant(), k.basisSt1());
        checkFehler("massnahme_fassung_freigegeben_chk", () -> mitMessgrundlage(k, Map.of("fassung", 2)));
        checkState("23503", () -> mitMessgrundlage(k, Map.of("fassung", 9)));
        checkFehler("massnahme_basis_der_kennzahl_chk", () -> mitMessgrundlage(k, Map.of("bezugsbasis_id", k.basisSt2())));
        // Der Standort ist der der Kennzahl: am Standort derselbe, am Unternehmen keiner.
        checkFehler("massnahme_standort_der_kennzahl_chk", () -> mitMessgrundlage(k, Map.of("standort_id", k.st2())));
        checkFehler("massnahme_standort_der_kennzahl_chk", () -> massnahme(k, k.st1(), Map.of("kennzahl_id", k.kennzahl(),
                "bezugsbasis_id", k.basis(), "fassung", 1, "ausgangslage", AUSGANGSLAGE,
                "ausgangslage_pruefsumme", pruefsumme(AUSGANGSLAGE))));
        // Einsatz × Einstufungs-Fassung: nur eine freigegebene, nie ohne Einsatz; ohne Einstufung geht der Einsatz allein.
        checkFehler("massnahme_einstufung_freigegeben_chk", () -> massnahme(k, k.st1(),
                Map.of("einsatz_id", k.einsatz(), "einstufung_fassung", 2)));
        checkFehler("massnahme_einstufung_chk", () -> massnahme(k, k.st1(), Map.of("einstufung_fassung", 1)));
        checkState("23503", () -> massnahme(k, k.st1(), Map.of("einsatz_id", k.einsatz(), "einstufung_fassung", 7)));
        massnahme(k, k.st1(), Map.of("einsatz_id", k.einsatz()));
        // Die Herkunft trägt ihre Kennung und, aus einem Energieziel bzw. am Einsatz, den Verweis.
        checkFehler("massnahme_herkunft_chk", () -> massnahme(k, null, Map.of("herkunft_art", "energieziel",
                "herkunft_kennung", "EZ-2028-0001")));
        checkFehler("massnahme_herkunft_chk", () -> massnahme(k, null, Map.of("herkunft_art", "abweichung")));
        checkFehler("massnahme_herkunft_chk", () -> massnahme(k, null, Map.of("herkunft_kennung", "AW-2028-0001")));
        checkFehler("massnahme_herkunft_chk", () -> massnahme(k, null, Map.of("herkunft_art", "audit",
                "herkunft_kennung", "NK-1")));
        UUID ausEz = massnahme(k, k.st1(), Map.of("herkunft_art", "energieziel", "herkunft_kennung", "EZ-2028-0001",
                "energieziel_id", k.ziel()));
        UUID amEe = massnahme(k, k.st1(), Map.of("herkunft_art", "einsatz", "herkunft_kennung", "EE-1",
                "einsatz_id", k.einsatz(), "einstufung_fassung", 1));
        // R3: aus der Abweichung, am Einsatz EE-1 Fassung 1, zum Energieziel, mit Messgrundlage.
        UUID r3 = mitMessgrundlage(k, Map.of("einsatz_id", k.einsatz(), "einstufung_fassung", 1, "energieziel_id", k.ziel()));
        assertThat(List.of(ausEz, amEe, r3)).doesNotHaveDuplicates();
        // Die Maßnahme entsteht geplant.
        checkFehler("massnahme_entsteht_geplant", () -> massnahme(k, null, Map.of("zustand", "umgesetzt",
                "umgesetzt_am", LocalDate.parse("2028-01-14"), "umgesetzt_begruendung", BEGRUENDUNG,
                "umgesetzt_gemeldet_am", AM_15_01_2028)));
    }

    // ============================================================ M1/LA6: der Zähler

    @Test
    void derZaehlerVergibtM2028_0001ImJahrDesAnlegensLueckenlos() {
        Kunde k = kunde("M1 Zähler");
        TenantContext.set(k.tenant());
        assertThat(kennzeichen(mitMessgrundlage(k, Map.of()))).as("angelegt am 15.01.2028").isEqualTo("M-2028-0001");
        // Eine gescheiterte Anlage rollt ihre Nummer zurück: kein Loch.
        checkFehler("massnahme_titel_chk", () -> massnahme(k, null, Map.of("titel", " ")));
        assertThat(kennzeichen(massnahme(k, null, Map.of()))).isEqualTo("M-2028-0002");
        // Das Jahr ist das des Anlegens in der Zeitzone des Unternehmens: 31.12.2027 23:30 UTC ist in Berlin 2028.
        assertThat(kennzeichen(massnahme(k, null, Map.of("angelegt_am",
                OffsetDateTime.parse("2027-12-31T23:30:00Z"))))).isEqualTo("M-2028-0003");
        assertThat(kennzeichen(massnahme(k, null, Map.of("angelegt_am",
                OffsetDateTime.parse("2027-12-31T22:30:00Z"))))).isEqualTo("M-2027-0001");
        // Ein ausdrücklich gesetztes Kennzeichen rückt den Zähler dahinter; sein Jahr ist das des Anlegens.
        massnahme(k, null, Map.of("kennzeichen", "M-2028-0009"));
        assertThat(kennzeichen(massnahme(k, null, Map.of()))).isEqualTo("M-2028-0010");
        checkFehler("massnahme_kennzeichen_jahr_chk", () -> massnahme(k, null, Map.of("kennzeichen", "M-2027-0005")));
        checkFehler("massnahme_kennzeichen_chk", () -> massnahme(k, null, Map.of("kennzeichen", "M-2028-0000")));
        checkState("23505", () -> massnahme(k, null, Map.of("kennzeichen", "M-2028-0001")));
        // Die Energieziele zählen ihre eigene Reihe weiter.
        assertThat(app.queryForObject("SELECT uems_verbesserung_kennung(?, 'EZ', 2028)", String.class, k.tenant()))
                .isEqualTo("EZ-2028-0002");
        // Je Kundenbereich: ein anderer beginnt wieder bei 0001.
        Kunde anderer = kunde("M1 Zähler B");
        TenantContext.set(anderer.tenant());
        assertThat(kennzeichen(massnahme(anderer, null, Map.of()))).isEqualTo("M-2028-0001");
    }

    // ============================================================ M6: die Übergänge

    @Test
    void dieUebergaengeSindEinmaligUndUmgesetztNieInDerZukunft() {
        Kunde k = kunde("M6 Übergänge");
        TenantContext.set(k.tenant());
        UUID m = mitMessgrundlage(k, Map.of());
        // Solange geplant: Titel, Termin, Verantwortlicher und Messgrundlage änderbar.
        app.update("UPDATE massnahme SET titel = 'Werkzeugheizungen in Betriebspausen abschalten (Maschinen 3–6)', "
                + "termin = DATE '2028-02-15', verantwortlich_sub = 'JW', verantwortlich_name = 'Jonas Wendlinger' "
                + "WHERE id = ?", m);
        // `umgesetzt_am` in der Zukunft: nach dem Tag der Meldung bzw. — ohne Meldezeit — nach dem Tag der Datenbank.
        checkFehler("massnahme_umgesetzt_nicht_in_der_zukunft", () -> umsetzen(m, "2028-01-23", AM_22_01_2028));
        checkFehler("massnahme_umgesetzt_nicht_in_der_zukunft", () -> app.update("UPDATE massnahme SET zustand = "
                + "'umgesetzt', umgesetzt_am = current_date + 1, umgesetzt_begruendung = ? WHERE id = ?", BEGRUENDUNG, m));
        checkFehler("massnahme_umgesetzt_chk", () -> app.update("UPDATE massnahme SET zustand = 'umgesetzt', "
                + "umgesetzt_am = DATE '2028-01-22', umgesetzt_begruendung = 'kurz', umgesetzt_gemeldet_am = ? WHERE id = ?",
                AM_22_01_2028, m));
        // Der Tag der Meldung selbst geht (R3: umgesetzt am 22.01.2028).
        umsetzen(m, "2028-01-22", AM_22_01_2028);
        assertThat(app.queryForObject("SELECT zustand FROM massnahme WHERE id = ?", String.class, m)).isEqualTo("umgesetzt");
        // Ein zweiter Übergang `umgesetzt` scheitert am Trigger — auch mit einem früheren Tag; zurück nie.
        checkFehler("massnahme_uebergang_einmalig", () -> umsetzen(m, "2028-01-21", AM_22_01_2028));
        checkFehler("massnahme_uebergang_einmalig", () -> app.update("UPDATE massnahme SET umgesetzt_begruendung = ? "
                + "WHERE id = ?", BEGRUENDUNG + " Nachtrag.", m));
        checkFehler("massnahme_uebergang_einmalig", () -> app.update("UPDATE massnahme SET zustand = 'geplant', "
                + "umgesetzt_am = NULL, umgesetzt_begruendung = NULL, umgesetzt_gemeldet_am = NULL WHERE id = ?", m));
        checkFehler("massnahme_uebergang_einmalig", () -> verwerfen(m));
        // Ab `umgesetzt` bleiben Titel, Termin, Verantwortlicher, Messgrundlage und Verweise.
        checkFehler("massnahme_nur_geplant_aenderbar", () -> app.update("UPDATE massnahme SET termin = DATE '2028-03-01' "
                + "WHERE id = ?", m));
        checkFehler("massnahme_nur_geplant_aenderbar", () -> app.update("UPDATE massnahme SET einsatz_id = ? WHERE id = ?",
                k.einsatz(), m));
        // Die Ausgangslage ersetzt nur eine Antwort `neu_kopiert` — mit neuer Prüfsumme.
        String neu = AUSGANGSLAGE.replace("\"gemessen_version\":1", "\"gemessen_version\":2");
        app.update("UPDATE massnahme SET ausgangslage = ?, ausgangslage_pruefsumme = ? WHERE id = ?", neu, pruefsumme(neu), m);
        // `bewertet` erst mit einem bewerteten Stand.
        checkFehler("massnahme_bewertet_mit_stand", () -> app.update("UPDATE massnahme SET zustand = 'bewertet' "
                + "WHERE id = ?", m));
        stand(k, m, Map.of());
        app.update("UPDATE massnahme SET zustand = 'bewertet' WHERE id = ?", m);
        checkFehler("massnahme_uebergang_einmalig", () -> app.update("UPDATE massnahme SET zustand = 'umgesetzt' "
                + "WHERE id = ?", m));
        // Kennzeichen, Herkunft und Anlage nie; die Spalten ohne Grant fängt schon das Recht.
        checkState("42501", () -> app.update("UPDATE massnahme SET kennzeichen = 'M-2028-0099' WHERE id = ?", m));
        checkState("42501", () -> app.update("UPDATE massnahme SET herkunft_art = 'von_hand' WHERE id = ?", m));
        // Verworfen: nur aus `geplant`, mit Begründung, danach endgültig.
        UUID v = massnahme(k, null, Map.of());
        checkFehler("massnahme_verworfen_chk", () -> app.update("UPDATE massnahme SET zustand = 'verworfen', "
                + "verworfen_am = now() WHERE id = ?", v));
        verwerfen(v);
        checkFehler("massnahme_endgueltig", () -> app.update("UPDATE massnahme SET titel = 'wieder da' WHERE id = ?", v));
        checkFehler("massnahme_endgueltig", () -> umsetzen(v, "2028-01-22", AM_22_01_2028));
    }

    // ============================================================ WK6/M4: Stand Nr. n

    @Test
    void dieBewertungIstEinStandNrNUndOhneMessgrundlageNurNichtMessbar() {
        Kunde k = kunde("WK6 Stände");
        TenantContext.set(k.tenant());
        UUID m = mitMessgrundlage(k, Map.of());
        // Bewertet wird erst nach der Umsetzung.
        checkFehler("massnahme_bewertung_nach_umsetzung", () -> stand(k, m, Map.of()));
        umsetzen(m, "2028-01-22", AM_22_01_2028);
        // Mit Messgrundlage: die Kopie der Wirkung ist Pflicht, ihre Prüfsumme hält die Datenbank.
        checkFehler("massnahme_bewertung_wirkung_chk", () -> stand(k, m, ohne("wirkung", "pruefsumme")));
        checkFehler("massnahme_bewertung_wirkung_chk", () -> stand(k, m, Map.of("pruefsumme", pruefsumme(AUSGANGSLAGE))));
        checkFehler("massnahme_bewertung_messgrundlage_der_massnahme", () -> stand(k, m, ohne("kennzahl_id",
                "bezugsbasis_id", "fassung")));
        checkFehler("massnahme_bewertung_begruendung_chk", () -> stand(k, m, Map.of("begruendung", "belegt")));
        // R6: Stand Nr. 1 `belegt` mit Kopie und Prüfsumme; die Nr. vergibt die Datenbank.
        UUID eins = stand(k, m, Map.of());
        assertThat(app.queryForObject("SELECT stand_nr FROM massnahme_bewertung WHERE id = ?", Integer.class, eins)).isOne();
        // Ein Stand wird nie zurückgenommen oder geändert; die Nr. ist lückenlos.
        checkFehler("massnahme_bewertung_einmalig", () -> app.update("UPDATE massnahme_bewertung SET status = 'abgelehnt', "
                + "entscheidungs_begruendung = 'zurück' WHERE id = ?", eins));
        checkState("42501", () -> app.update("UPDATE massnahme_bewertung SET ergebnis = 'nicht_belegt' WHERE id = ?", eins));
        checkFehler("massnahme_bewertung_stand_nr_lueckenlos", () -> stand(k, m, Map.of("stand_nr", 3)));
        // Vier-Augen: ein Antrag (Nr. 2), höchstens einer offen, die zweite Person nie die erste.
        checkFehler("massnahme_bewertung_entsteht_als_antrag", () -> stand(k, m, Map.of("vieraugen", true)));
        UUID antrag = stand(k, m, Map.of("vieraugen", true, "status", "beantragt"));
        checkState("23505", () -> stand(k, m, Map.of("vieraugen", true, "status", "beantragt")));
        checkFehler("massnahme_bewertung_entscheidung_chk", () -> entscheiden(antrag, "bewertet", "IK", "Ines Kaltenbach",
                null));
        checkFehler("massnahme_bewertung_ablehnung_chk", () -> entscheiden(antrag, "abgelehnt", "PH", "Peter Hollerbach",
                null));
        entscheiden(antrag, "abgelehnt", "PH", "Peter Hollerbach", "Juli ist ein Sonderauftrag; bitte nach zwölf Monaten.");
        checkFehler("massnahme_bewertung_einmalig", () -> entscheiden(antrag, "bewertet", "PH", "Peter Hollerbach", null));
        // Nach der Ablehnung darf ein neuer Antrag kommen: Nr. 3.
        UUID drei = stand(k, m, Map.of("vieraugen", true, "status", "beantragt"));
        entscheiden(drei, "bewertet", "PH", "Peter Hollerbach", null);
        assertThat(app.queryForList("SELECT stand_nr || ':' || status FROM massnahme_bewertung WHERE massnahme_id = ? "
                + "ORDER BY stand_nr", String.class, m)).containsExactly("1:bewertet", "2:abgelehnt", "3:bewertet");
        // R7: ohne Messgrundlage ist `nicht_messbar` das einzige Ergebnis — der CHECK.
        UUID ohneMg = massnahme(k, null, Map.of());
        umsetzen(ohneMg, "2028-01-22", AM_22_01_2028);
        // Ein Stand gibt sich keine Messgrundlage, die die Maßnahme nicht hat.
        checkFehler("massnahme_bewertung_messgrundlage_der_massnahme", () -> stand(k, ohneMg, Map.of()));
        Map<String, Object> belegtOhne = ohne("kennzahl_id", "bezugsbasis_id", "fassung", "wirkung", "pruefsumme");
        checkFehler("massnahme_bewertung_nicht_messbar_chk", () -> stand(k, ohneMg, belegtOhne));
        Map<String, Object> nichtMessbar = new LinkedHashMap<>(belegtOhne);
        nichtMessbar.put("ergebnis", "nicht_messbar");
        stand(k, ohneMg, nichtMessbar);
        app.update("UPDATE massnahme SET zustand = 'bewertet' WHERE id = ?", ohneMg);
        checkFehler("massnahme_bewertung_ergebnis_chk", () -> {
            Map<String, Object> wort = new LinkedHashMap<>(nichtMessbar);
            wort.put("ergebnis", "gewirkt");
            stand(k, ohneMg, wort);
        });
    }

    // ============================================================ M5: der Anstoß am Vorgang

    @Test
    void derAnstossHatGenauEinenBezugIstEindeutigUndWirdEinmalBeantwortet() {
        Kunde k = kunde("M5 Anstoß");
        TenantContext.set(k.tenant());
        UUID m = mitMessgrundlage(k, Map.of());
        // Genau ein Bezug: Maßnahme XOR Energieziel.
        checkFehler("vorgang_anstoss_bezug_chk", () -> anstoss(k, null, null, "bewertung_korrigiert", "K-2028-0001"));
        checkFehler("vorgang_anstoss_bezug_chk", () -> anstoss(k, m, k.ziel(), "bewertung_korrigiert", "K-2028-0001"));
        checkFehler("vorgang_anstoss_art_chk", () -> anstoss(k, m, null, "ausgangslage_geaendert", "K-2028-0001"));
        checkFehler("vorgang_anstoss_anlass_chk", () -> anstoss(k, m, null, "ausgangslage_korrigiert", " "));
        // Eine Ausgangslage hat nur die Maßnahme.
        checkFehler("vorgang_anstoss_ausgangslage_chk", () -> anstoss(k, null, k.ziel(), "ausgangslage_korrigiert",
                "K-2028-0001"));
        // R12: genau ein Anstoß je Vorgang × Art × Anlass.
        UUID r12 = anstoss(k, m, null, "ausgangslage_korrigiert", "K-2028-0001");
        checkState("23505", () -> anstoss(k, m, null, "ausgangslage_korrigiert", "K-2028-0001"));
        anstoss(k, m, null, "ausgangslage_korrigiert", "K-2028-0002");
        anstoss(k, m, null, "messgrundlage_beendet", "K-2028-0001");
        UUID amZiel = anstoss(k, null, k.ziel(), "messgrundlage_beendet", "K-2028-0001");
        checkState("23505", () -> anstoss(k, null, k.ziel(), "messgrundlage_beendet", "K-2028-0001"));
        // Er entsteht offen.
        checkFehler("vorgang_anstoss_entsteht_offen", () -> app.update("INSERT INTO vorgang_anstoss(tenant_id,massnahme_id,"
                + "art,anlass_kennung,zustand,antwort,antwort_begruendung,beantwortet_am,beantwortet_sub,beantwortet_name,"
                + "beantwortet_art) VALUES (?,?,'bewertung_korrigiert','K-2028-0003','beantwortet','bleibt',?,now(),'IK',"
                + "'Ines Kaltenbach','kunde')", k.tenant(), m, BEGRUENDUNG));
        // `bleibt` verlangt eine Begründung; die Antwort ist einmalig.
        checkFehler("vorgang_anstoss_antwort_chk", () -> antworten(r12, "bleibt", null));
        checkFehler("vorgang_anstoss_antwort_chk", () -> antworten(r12, "vergessen", BEGRUENDUNG));
        antworten(r12, "bleibt", "Version 2 ändert die Ausgangslage um 0,9 Punkte; die Maßnahme bleibt, wie angelegt.");
        checkFehler("vorgang_anstoss_antwort_einmalig", () -> antworten(r12, "neu_kopiert", null));
        checkFehler("vorgang_anstoss_antwort_einmalig", () -> app.update("UPDATE vorgang_anstoss SET zustand = 'offen', "
                + "antwort = NULL, antwort_begruendung = NULL, beantwortet_am = NULL, beantwortet_sub = NULL, "
                + "beantwortet_name = NULL, beantwortet_rolle = NULL, beantwortet_art = NULL WHERE id = ?", r12));
        checkState("42501", () -> app.update("UPDATE vorgang_anstoss SET anlass_kennung = 'K-2028-0009' WHERE id = ?", r12));
        // `neu_kopiert` nie am Energieziel; `neu_bewertet` dort schon.
        checkFehler("vorgang_anstoss_ausgangslage_chk", () -> antworten(amZiel, "neu_kopiert", null));
        antworten(amZiel, "neu_bewertet", null);
        assertThat(app.queryForList("SELECT art || ':' || zustand FROM vorgang_anstoss WHERE massnahme_id = ? "
                + "ORDER BY art, anlass_kennung", String.class, m)).containsExactly("ausgangslage_korrigiert:beantwortet",
                "ausgangslage_korrigiert:offen", "messgrundlage_beendet:offen");
    }

    // ============================================================ M7: Protokoll, nichts löschbar

    @Test
    void dieAppLoeschtNieUndDasProtokollWirdNurAngehaengt() {
        Kunde k = kunde("M7 Löschen");
        TenantContext.set(k.tenant());
        UUID m = mitMessgrundlage(k, Map.of());
        protokoll(k, m, "massnahme_angelegt", null);
        protokoll(k, m, "kommentar", "Zeitschaltung für Maschine 3 bestellt.");
        protokoll(k, m, "kommentar", "x".repeat(2000));
        umsetzen(m, "2028-01-22", AM_22_01_2028);
        UUID s = stand(k, m, Map.of());
        UUID a = anstoss(k, m, null, "ausgangslage_korrigiert", "K-2028-0001");
        for (String sql : List.of("DELETE FROM massnahme WHERE id = ?", "DELETE FROM massnahme_aenderung WHERE massnahme_id = ?",
                "DELETE FROM massnahme_bewertung WHERE massnahme_id = ?", "DELETE FROM vorgang_anstoss WHERE massnahme_id = ?")) {
            checkState("42501", () -> app.update(sql, m));
        }
        checkState("42501", () -> app.update("UPDATE massnahme_aenderung SET kommentar = 'anders' WHERE massnahme_id = ?", m));
        // Ein Kommentar ist eine Zeile mit Text (1–2 000 Zeichen); keine andere Zeile hat einen.
        checkFehler("massnahme_aenderung_kommentar_chk", () -> protokoll(k, m, "kommentar", "x".repeat(2001)));
        checkFehler("massnahme_aenderung_kommentar_chk", () -> protokoll(k, m, "kommentar", " "));
        checkFehler("massnahme_aenderung_kommentar_chk", () -> protokoll(k, m, "kommentar", null));
        checkFehler("massnahme_aenderung_kommentar_chk", () -> protokoll(k, m, "massnahme_umgesetzt", "Text"));
        checkFehler("massnahme_aenderung_art_chk", () -> protokoll(k, m, "energieziel_bewertet", null));
        // Ein Protokoll überlebt sein Objekt: kein Fremdschlüssel auf die Maßnahme.
        assertThat(root.queryForObject("SELECT count(*) FROM pg_constraint WHERE conrelid = 'massnahme_aenderung'::regclass "
                + "AND contype = 'f' AND pg_get_constraintdef(oid) LIKE '%massnahme%'", Integer.class)).isZero();
        assertThat(app.queryForObject("SELECT count(*) FROM massnahme_aenderung WHERE massnahme_id = ?", Integer.class, m))
                .isEqualTo(3);
        assertThat(List.of(s, a)).doesNotContainNull();
    }

    // ============================================================ RE2: Mandanten- und Standort-Zaun

    @Test
    void derMandantenzaunHaeltMandantASiehtBNicht() {
        Kunde a = kunde("Zaun A");
        Kunde b = kunde("Zaun B");
        TenantContext.set(b.tenant());
        vollerVorgang(b, mitMessgrundlage(b, Map.of()));
        TenantContext.set(a.tenant());
        for (String t : TABELLEN) {
            assertThat(app.queryForObject("SELECT count(*) FROM " + t + " WHERE tenant_id = ?", Integer.class, b.tenant()))
                    .as(t).isZero();
        }
        // Fremde Zeilen einschleusen: RLS-Prüfung bzw. der Mandant reist im Verweis mit.
        checkState("42501", () -> massnahme(b, null, Map.of()));
        checkState("23503", () -> massnahme(a, a.st1(), Map.of("kennzahl_id", b.kennzahlSt1(), "bezugsbasis_id",
                b.basisSt1(), "fassung", 1, "ausgangslage", AUSGANGSLAGE, "ausgangslage_pruefsumme", pruefsumme(AUSGANGSLAGE))));
        checkState("23503", () -> anstoss(a, null, b.ziel(), "messgrundlage_beendet", "BB-0002/2"));
        TenantContext.clear();
        for (String t : TABELLEN) {
            assertThat(app.queryForObject("SELECT count(*) FROM " + t, Integer.class)).as(t).isZero();
        }
    }

    @Test
    void derStandortZaunZeigtEinemFremdenStandortNullZeilenUndNieEineAmUnternehmen() {
        Kunde k = kunde("Standort-Zaun");
        TenantContext.set(k.tenant());
        UUID amUnternehmen = vollerVorgang(k, massnahme(k, null, Map.of()));
        UUID amSt1 = vollerVorgang(k, mitMessgrundlage(k, Map.of()));
        UUID amSt2 = vollerVorgang(k, massnahme(k, k.st2(), Map.of()));
        UUID zielAnstoss = anstoss(k, null, k.ziel(), "messgrundlage_beendet", "BB-0002/1");
        TenantContext.clear();
        // Nur ST-2: seine Maßnahme mit allem; ST-1 und das Unternehmen — auch der Anstoß am Ziel von ST-1 — 0 Zeilen.
        eng(k.tenant(), List.of(k.st2()), jdbc -> {
            assertThat(jdbc.queryForList("SELECT id FROM massnahme", UUID.class)).containsExactly(amSt2);
            for (String t : List.of("massnahme_aenderung", "massnahme_bewertung", "vorgang_anstoss")) {
                assertThat(jdbc.queryForList("SELECT DISTINCT massnahme_id FROM " + t, UUID.class)).as(t)
                        .containsExactly(amSt2);
                assertThat(jdbc.queryForObject("SELECT count(*) FROM " + t + " WHERE massnahme_id IN (?, ?)", Integer.class,
                        amSt1, amUnternehmen)).as(t).isZero();
            }
            assertThat(jdbc.queryForObject("SELECT count(*) FROM vorgang_anstoss WHERE id = ?", Integer.class, zielAnstoss))
                    .isZero();
            assertThat(jdbc.update("UPDATE massnahme SET titel = 'fremd' WHERE id = ?", amSt1)).isZero();
            checkState("42501", () -> jdbc.update("INSERT INTO massnahme_aenderung(tenant_id,massnahme_id,art,kommentar,"
                    + "actor_sub,actor_name,actor_art) VALUES (?,?,'kommentar','fremd','PH','Peter Hollerbach','kunde')",
                    k.tenant(), amSt1));
            checkState("42501", () -> jdbc.update("INSERT INTO vorgang_anstoss(tenant_id,massnahme_id,art,anlass_kennung) "
                    + "VALUES (?,?,'bewertung_korrigiert','K-2028-0007')", k.tenant(), amUnternehmen));
            checkState("42501", () -> jdbc.update("INSERT INTO massnahme(tenant_id,titel,verantwortlich_sub,"
                    + "verantwortlich_name,verantwortlich_konto,termin,standort_id,herkunft_art,erwartete_wirkung_wortlaut,"
                    + "actor_sub,actor_name,actor_art) VALUES (?,'fremd','PH','Peter Hollerbach','benutzer',DATE '2028-01-31',"
                    + "?,'von_hand','fremd','PH','Peter Hollerbach','kunde')", k.tenant(), k.st1()));
            return null;
        });
        // ST-1: die Maßnahme, der Anstoß an seinem Ziel.
        eng(k.tenant(), List.of(k.st1()), jdbc -> {
            assertThat(jdbc.queryForList("SELECT id FROM massnahme", UUID.class)).containsExactly(amSt1);
            assertThat(jdbc.queryForObject("SELECT count(*) FROM vorgang_anstoss WHERE id = ?", Integer.class, zielAnstoss))
                    .isOne();
            return null;
        });
        // Unternehmensweit: alle drei.
        eng(k.tenant(), null, jdbc -> {
            assertThat(jdbc.queryForObject("SELECT count(*) FROM massnahme", Integer.class)).isEqualTo(3);
            assertThat(jdbc.queryForObject("SELECT count(*) FROM vorgang_anstoss", Integer.class)).isEqualTo(4);
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
        assertThat(root.queryForObject("SELECT has_table_privilege(?, 'massnahme_aenderung', 'UPDATE')", Boolean.class, APP))
                .isFalse();
        assertThat(root.queryForObject("SELECT has_sequence_privilege(?, 'massnahme_aenderung_id_seq', 'USAGE')",
                Boolean.class, APP)).isTrue();
        // §4.9 RE1: die drei Kennungen aus IP-5 decken die Maßnahme — keine neue.
        JsonNode matrix = MAPPER.readTree(Path.of("../../docs/contracts/v2/rechte-matrix.json").toFile());
        List<String> kennungen = new ArrayList<>();
        matrix.path("aktionen").forEach(r -> {
            String kennung = r.path("kennung").asText();
            if (kennung.startsWith("verbesserung.") || kennung.contains("massnahme")) {
                kennungen.add(kennung);
            }
        });
        assertThat(kennungen).containsExactlyInAnyOrder("verbesserung.verwalten", "verbesserung.abschliessen",
                "verbesserung.ansehen");
    }

    /** Die Funktion wird nur geweitet: jede Zeile von IP-5 bleibt, dazu genau die zwei Listen der Tabellen (IP-14 dahinter). */
    @Test
    void dasVokabularWirdNurGeweitet() {
        List<String> nachher = vokabular();
        assertThat(vokabularVorher).hasSize(72);
        assertThat(nachher).containsAll(vokabularVorher);
        List<String> neu = new ArrayList<>(nachher);
        neu.removeAll(vokabularVorher);
        assertThat(neu).containsExactly("massnahme_bewertung_status:1:beantragt", "massnahme_bewertung_status:2:bewertet",
                "massnahme_bewertung_status:3:abgelehnt", "massnahme_protokoll:1:massnahme_angelegt",
                "massnahme_protokoll:2:massnahme_geaendert", "massnahme_protokoll:3:verantwortlicher_geaendert",
                "massnahme_protokoll:4:kommentar", "massnahme_protokoll:5:massnahme_umgesetzt",
                "massnahme_protokoll:6:massnahme_verworfen", "massnahme_protokoll:7:bewertung_beantragt",
                "massnahme_protokoll:8:bewertung_abgelehnt", "massnahme_protokoll:9:massnahme_bewertet",
                "massnahme_protokoll:10:anstoss_gesetzt", "massnahme_protokoll:11:anstoss_beantwortet",
                // IP-14 weitet hinter IP-9 um die Wörter seiner Tabellen.
                "abweichung_herkunft:1:auffaelligkeit", "abweichung_herkunft:2:von_hand",
                "abweichung_protokoll:1:abweichung_eroeffnet", "abweichung_protokoll:2:kommentar",
                "abweichung_protokoll:3:ursache_aussage", "abweichung_protokoll:4:abweichung_geaendert",
                "abweichung_protokoll:5:verantwortlicher_geaendert", "abweichung_protokoll:6:abweichung_abgeschlossen");
    }

    @Test
    void dasOffboardingRaeumtAlleTabellenVorZielFassungEinsatzKennzahlStandortUndBenutzerAb() {
        Kunde k = kunde("Offboarding");
        TenantContext.set(k.tenant());
        vollerVorgang(k, mitMessgrundlage(k, Map.of("einsatz_id", k.einsatz(), "einstufung_fassung", 1,
                "energieziel_id", k.ziel())));
        anstoss(k, null, k.ziel(), "messgrundlage_beendet", "BB-0002/1");
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
        assertThat(fingerVorher.get("energieziel")).as("es gibt Bestand").isNotEqualTo(Bestandsschutz.LEER);
        assertThat(fingerVorher.get("energieeinsatz_einstufung")).as("es gibt Bestand").isNotEqualTo(Bestandsschutz.LEER);
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
        Path ohneDiese = Files.createTempDirectory("ohne-massnahme");
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
        String woerter = "SELECT string_agg(vokabular || ':' || nr || ':' || wort, '|' ORDER BY vokabular, nr) "
                + "FROM verbesserung_vokabular()";
        assertThat(spaetDb.queryForObject(woerter, String.class)).isEqualTo(root.queryForObject(woerter, String.class));
    }

    // ============================================================ Gerüst

    /** Kundenbereich mit allem, woran eine Maßnahme hängt (nur Tabellen, die es vor dieser Migration gibt). */
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
        UUID bb1 = basis(tenant, kz1, "BB-0001");
        UUID prozess = root.queryForObject("INSERT INTO prozess (tenant_id, unternehmen_id, kennzeichen, name, gueltig_ab) "
                + "VALUES (?, ?, 'P-1', 'Spritzguss', DATE '2026-10-01') RETURNING id", UUID.class, tenant, unternehmen);
        UUID einsatz = root.queryForObject("INSERT INTO energieeinsatz(tenant_id,kennzeichen,prozess_id,traeger,name,"
                + "gueltig_ab,actor_sub,actor_name,actor_art) VALUES (?,'EE-1',?,'Strom','Spritzguss','2026-10-01','IK',"
                + "'Ines Kaltenbach','kunde') RETURNING id", UUID.class, tenant, prozess);
        root.update("INSERT INTO energieeinsatz_einstufung(tenant_id,einsatz_id,nummer,einstufung,begruendung,herkunft,grund,"
                + "vorgeschlagen_ab,gueltig_ab,rueckwirkend,actor_sub,actor_name,actor_rolle,actor_art,vieraugen,freigabe_status) "
                + "VALUES (?,?,1,'wesentlich','R3: 62 % des Stroms','{}'::jsonb,'[\"K1\"]'::jsonb,'2026-11-06','2026-11-06',"
                + "false,'IK','Ines Kaltenbach','energiemanager','kunde',false,'freigegeben')", tenant, einsatz);
        root.update("INSERT INTO energieeinsatz_einstufung(tenant_id,einsatz_id,nummer,einstufung,begruendung,herkunft,grund,"
                + "vorgeschlagen_ab,rueckwirkend,actor_sub,actor_name,actor_rolle,actor_art,vieraugen,freigabe_status) "
                + "VALUES (?,?,2,'nicht_wesentlich','Antrag offen','{}'::jsonb,'[]'::jsonb,'2027-11-06',false,'IK',"
                + "'Ines Kaltenbach','energiemanager','kunde',true,'beantragt')", tenant, einsatz);
        UUID ziel = root.queryForObject("INSERT INTO energieziel(tenant_id,kennzahl_id,bezugsbasis_id,fassung,zielwert_prozent,"
                + "zielperiode,wortlaut,begruendung,verantwortlich_sub,verantwortlich_name,verantwortlich_konto,standort_id,"
                + "actor_sub,actor_name,actor_rolle,actor_art,angelegt_am) VALUES (?,?,?,1,-5.0,'2028-01/2028-12',"
                + "'Spritzguss: 5 % weniger Strom als die Bezugsbasis erwarten lässt.','Jahresplanung 2028 nach der "
                + "Freigabe.','IK','Ines Kaltenbach','benutzer',?,'IK','Ines Kaltenbach','energiemanager','kunde',"
                + "TIMESTAMPTZ '2027-12-20 10:00+01') RETURNING id", UUID.class, tenant, kz1, bb1, st1);
        return new Kunde(tenant, unternehmen, st1, st2, kz, basis(tenant, kz, "BB-0002"), kz1, bb1, kz2,
                basis(tenant, kz2, "BB-0003"), einsatz, ziel);
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

    /** Eine Maßnahme von Hand, verantwortlich Murat, angelegt von Ines am 15.01.2028, mit den genannten Abweichungen. */
    private static UUID massnahme(Kunde k, UUID standort, Map<String, Object> spalten) {
        Map<String, Object> werte = new LinkedHashMap<>();
        werte.put("tenant_id", k.tenant());
        werte.put("titel", "Werkzeugheizungen in Betriebspausen abschalten (Zeitschaltung Maschinen 3–6)");
        werte.put("verantwortlich_sub", "MD");
        werte.put("verantwortlich_name", "Murat Demirci");
        werte.put("verantwortlich_konto", "benutzer");
        werte.put("termin", LocalDate.parse("2028-01-31"));
        werte.put("standort_id", standort);
        werte.put("herkunft_art", "von_hand");
        werte.put("erwartete_wirkung_wortlaut", "Heizungen laufen etwa ein Fünftel der Zeit ohne Produktion; "
                + "Abschaltung spart geschätzt 3 % des Prozessstroms.");
        werte.put("actor_sub", "IK");
        werte.put("actor_name", "Ines Kaltenbach");
        werte.put("actor_rolle", "energiemanager");
        werte.put("actor_art", "kunde");
        werte.put("angelegt_am", AM_15_01_2028);
        werte.putAll(spalten);
        String sql = "INSERT INTO massnahme(" + String.join(",", werte.keySet()) + ") VALUES ("
                + String.join(",", werte.keySet().stream().map(s -> "?").toList()) + ") RETURNING id";
        return app.queryForObject(sql, UUID.class, werte.values().toArray());
    }

    /** R3: M-2028-0001 an ST-1 mit Messgrundlage KZ-0004 × BB-0001 Fassung 1, Ausgangslage mit Prüfsumme, −3,0 %. */
    private static UUID mitMessgrundlage(Kunde k, Map<String, Object> spalten) {
        Map<String, Object> werte = new LinkedHashMap<>();
        werte.put("herkunft_art", "abweichung");
        werte.put("herkunft_kennung", "AW-2028-0001");
        werte.put("kennzahl_id", k.kennzahlSt1());
        werte.put("bezugsbasis_id", k.basisSt1());
        werte.put("fassung", 1);
        werte.put("ausgangslage", AUSGANGSLAGE);
        werte.put("ausgangslage_pruefsumme", pruefsumme(AUSGANGSLAGE));
        werte.put("erwartete_wirkung_prozent", new BigDecimal("-3.0"));
        werte.putAll(spalten);
        UUID standort = (UUID) werte.getOrDefault("standort_id", k.st1());
        werte.remove("standort_id");
        return massnahme(k, standort, werte);
    }

    private static String kennzeichen(UUID massnahme) {
        return app.queryForObject("SELECT kennzeichen FROM massnahme WHERE id = ?", String.class, massnahme);
    }

    private static void umsetzen(UUID massnahme, String tag, OffsetDateTime gemeldet) {
        app.update("UPDATE massnahme SET zustand = 'umgesetzt', umgesetzt_am = ?, umgesetzt_begruendung = ?, "
                + "umgesetzt_gemeldet_am = ? WHERE id = ?", LocalDate.parse(tag), BEGRUENDUNG, gemeldet, massnahme);
    }

    private static void verwerfen(UUID massnahme) {
        app.update("UPDATE massnahme SET zustand = 'verworfen', verworfen_am = now(), verworfen_grund = "
                + "'Maschinen 3–6 werden 2028 ersetzt; die Zeitschaltung lohnt nicht.' WHERE id = ?", massnahme);
    }

    /**
     * Ein Stand an Ines' Maßnahme: `belegt` mit der Kopie der Wirkung, der Messgrundlage R3 und Person Ines — mit den
     * genannten Abweichungen (ein Wert {@code null} lässt die Spalte weg).
     */
    private static UUID stand(Kunde k, UUID massnahme, Map<String, Object> spalten) {
        Map<String, Object> werte = new LinkedHashMap<>();
        werte.put("tenant_id", k.tenant());
        werte.put("massnahme_id", massnahme);
        werte.put("kennzahl_id", k.kennzahlSt1());
        werte.put("bezugsbasis_id", k.basisSt1());
        werte.put("fassung", 1);
        werte.put("wirkung", WIRKUNG);
        werte.put("pruefsumme", pruefsumme(WIRKUNG));
        werte.put("ergebnis", "belegt");
        werte.put("begruendung", "Zeitschaltung seit 22.01.2028 aktiv, Laufzeit der Werkzeugheizungen 18 % niedriger.");
        werte.put("status", "bewertet");
        werte.put("freigabe_sub", "IK");
        werte.put("freigabe_name", "Ines Kaltenbach");
        werte.put("freigabe_rolle", "energiemanager");
        werte.put("freigabe_art", "kunde");
        werte.put("freigabe_am", OffsetDateTime.parse("2028-11-15T10:00:00+01:00"));
        werte.putAll(spalten);
        werte.values().removeIf(java.util.Objects::isNull);
        String sql = "INSERT INTO massnahme_bewertung(" + String.join(",", werte.keySet()) + ") VALUES ("
                + String.join(",", werte.keySet().stream().map(s -> "?").toList()) + ") RETURNING id";
        return app.queryForObject(sql, UUID.class, werte.values().toArray());
    }

    /** Spalten, die ein Stand weglässt. */
    private static Map<String, Object> ohne(String... spalten) {
        Map<String, Object> weg = new LinkedHashMap<>();
        for (String s : spalten) {
            weg.put(s, null);
        }
        return weg;
    }

    private static void entscheiden(UUID stand, String status, String sub, String name, String begruendung) {
        app.update("UPDATE massnahme_bewertung SET status = ?, entscheidung_sub = ?, entscheidung_name = ?, "
                + "entscheidung_rolle = 'kundenadministrator', entscheidung_art = 'kunde', entschieden_am = now(), "
                + "entscheidungs_begruendung = ? WHERE id = ?", status, sub, name, begruendung, stand);
    }

    private static UUID anstoss(Kunde k, UUID massnahme, UUID ziel, String art, String anlass) {
        return app.queryForObject("INSERT INTO vorgang_anstoss(tenant_id,massnahme_id,energieziel_id,art,anlass_kennung) "
                + "VALUES (?,?,?,?,?) RETURNING id", UUID.class, k.tenant(), massnahme, ziel, art, anlass);
    }

    private static void antworten(UUID anstoss, String antwort, String begruendung) {
        app.update("UPDATE vorgang_anstoss SET zustand = 'beantwortet', antwort = ?, antwort_begruendung = ?, "
                + "beantwortet_am = now(), beantwortet_sub = 'IK', beantwortet_name = 'Ines Kaltenbach', "
                + "beantwortet_rolle = 'energiemanager', beantwortet_art = 'kunde' WHERE id = ?", antwort, begruendung, anstoss);
    }

    private static void protokoll(Kunde k, UUID massnahme, String art, String kommentar) {
        app.update("INSERT INTO massnahme_aenderung(tenant_id,massnahme_id,art,kommentar,actor_sub,actor_name,actor_art) "
                + "VALUES (?,?,?,?,'IK','Ines Kaltenbach','kunde')", k.tenant(), massnahme, art, kommentar);
    }

    /** Protokoll, Umsetzung, Stand Nr. 1 und ein Anstoß an einer Maßnahme. */
    private static UUID vollerVorgang(Kunde k, UUID massnahme) {
        protokoll(k, massnahme, "massnahme_angelegt", null);
        umsetzen(massnahme, "2028-01-22", AM_22_01_2028);
        if (app.queryForObject("SELECT fassung IS NOT NULL FROM massnahme WHERE id = ?", Boolean.class, massnahme)) {
            stand(k, massnahme, Map.of());
        } else {
            Map<String, Object> nichtMessbar = ohne("kennzahl_id", "bezugsbasis_id", "fassung", "wirkung", "pruefsumme");
            nichtMessbar.put("ergebnis", "nicht_messbar");
            stand(k, massnahme, nichtMessbar);
        }
        anstoss(k, massnahme, null, "bewertung_korrigiert", "K-2028-0001");
        return massnahme;
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
