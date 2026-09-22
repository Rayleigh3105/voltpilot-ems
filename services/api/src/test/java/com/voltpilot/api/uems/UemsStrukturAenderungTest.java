package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Date;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Pfad 2 der Berichte — der Strukturänderungs-Läufer gegen eine echte Datenbank (UEMS AP-12 IP-9, E6 = A, bericht.md B3).
 * Welt: das Unternehmen Ahrenberg aus der Referenzdatei (Muster {@code BerichtAbzugUnternehmenTest}, ohne Kennzahlen) mit
 * echten Abzügen — ST-1 Oktober 2026 Nr. 1 (BR-2026-0001), Unternehmen Oktober Nr. 1 (BR-2026-0002), Unternehmen Dezember
 * und Jahr 2026 Nr. 1 (BR-2026-0006/-0007), ST-1 Januar 2027 als Entwurf (BR-2027-0001).
 *
 * <p>Die Prüfnachweise: B8 (Verteilung → Anstoß am Unternehmensbericht, ST-1 nicht), B9 (Fläche → kein Stand, der Entwurf
 * Januar neu), B10 (Umbenennung → nichts), B11 (Teilung → nichts); dazu der Umzug (nichts, auch seine Zeilen am Standort
 * nicht), die Datenstand-Schranke, der Standortwechsel eines Gebäudes, das Wasserzeichen (nichts zweimal; ein Fehler lässt
 * die Zeile ungelesen) und die Bezugsgröße (Pfad 1 — der Läufer stößt sie nie ein zweites Mal an). Die Protokollzeilen haben
 * die Form der Schreibwege ({@code VerteilungService}, {@code OrtService}, {@code AnlageUmzugService},
 * {@code OrtVerschiebenService}); die Schreibwege selbst prüfen ihre eigenen Tests.
 *
 * <p>Die Methoden laufen in fester Reihenfolge über EINER Welt, mit je späterem Eintragstag; jede prüft nur ihre eigenen
 * Zeilen, Kennungen und Berichte.
 */
@Testcontainers(disabledWithoutDocker = true)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class UemsStrukturAenderungTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");

    private static final UUID KB = UUID.fromString("4c1d7b0e-6a2f-5e93-b8d4-0f1e2d3c4b5a");
    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    private static final String KANAL = "energy_kwh";
    private static final ProtokollAkteur JONAS = new ProtokollAkteur("kc-jonas-wendlinger", "Jonas Wendlinger",
            "kundenadministrator", "kunde");
    private static final String ORT = BerichtRegeln.ORT_AENDERUNG;
    private static final String MESSSTELLE = BerichtRegeln.MESSSTELLE_AENDERUNG;

    private static final LocalDate OKT_AB = LocalDate.parse("2026-10-01");
    private static final LocalDate OKT_BIS = LocalDate.parse("2026-10-31");
    private static final LocalDate LIN_AB = LocalDate.parse("2026-10-15");
    private static final LocalDate JAN_AB = LocalDate.parse("2027-01-01");
    private static final Instant OKT_BEGINN = Instant.parse("2026-09-30T22:00:00Z");
    private static final Instant OKT_ENDE = Instant.parse("2026-10-31T23:00:00Z");
    private static final Instant OKT_ENDGUELTIG = Instant.parse("2026-11-07T23:00:00Z");
    private static final Instant MONATSLAUF = Instant.parse("2026-10-31T23:20:00Z");

    /** B8: die Verteilung von MS-07 in der Form von {@code VerteilungService} — 70/30 → 60/40 ab 01.10.2026, berichtigt. */
    private static final String VERTEILUNG_ALT = "{\"gueltig_ab\": \"2026-10-01\", \"zeilen\": ["
            + "{\"kostenstelle\": \"4100\", \"anteil_prozent\": \"70\"}, {\"kostenstelle\": \"4200\", \"anteil_prozent\": \"30\"}]}";
    private static final String VERTEILUNG_NEU = "{\"gueltig_ab\": \"2026-10-01\", \"zeilen\": ["
            + "{\"kostenstelle\": \"4100\", \"anteil_prozent\": \"60\"}, {\"kostenstelle\": \"4200\", \"anteil_prozent\": \"40\"}], "
            + "\"korrektur\": true}";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static final Map<String, UUID> IDS = new LinkedHashMap<>();
    private static JdbcTemplate root;
    private static DataSource admin;
    private static JsonNode referenz;
    private static BerichtAbzugBildung bildung;
    private static StrukturAenderungLaeufer laeufer;
    private static UUID st1Oktober;
    private static UUID uOktober;
    private static UUID uDezember;
    private static UUID uJahr;
    private static UUID st1Januar;

    @FunctionalInterface
    private interface Schritt {
        void fahren(Connection con) throws SQLException;
    }

    @BeforeAll
    static void aufbauen() throws Exception {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW))
                .load().migrate();
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        admin = ds(ADMIN_USER, ADMIN_PW);
        referenz = JSON.readTree(Files.readString(V2.resolve("uems-referenzunternehmen.json")));
        bildung = new BerichtAbzugBildung(new MeasurementCatalog(JSON), JSON,
                new BerichtRegelwerk("VoltPilot Test", Map.of("bericht", "1.1")));
        laeufer = new StrukturAenderungLaeufer(new JdbcTemplate(admin), new BerichtKaskade(bildung), 200);

        ahrenberg();
        st1Oktober = freigegeben("BR-2026-0001", "monatsbericht_standort", "standort", IDS.get("ST-1"), "monat", "2026-10",
                Instant.parse("2026-11-10T07:55:00Z"), Instant.parse("2026-11-10T08:02:00Z"));
        uOktober = freigegeben("BR-2026-0002", "monatsbericht_unternehmen", "unternehmen", IDS.get("U"), "monat",
                "2026-10", Instant.parse("2026-11-12T09:15:00Z"), Instant.parse("2026-11-12T09:20:00Z"));
        uDezember = freigegeben("BR-2026-0006", "monatsbericht_unternehmen", "unternehmen", IDS.get("U"), "monat",
                "2026-12", Instant.parse("2027-01-09T09:00:00Z"), Instant.parse("2027-01-09T09:10:00Z"));
        uJahr = freigegeben("BR-2026-0007", "jahresbericht_unternehmen", "unternehmen", IDS.get("U"), "jahr", "2026",
                Instant.parse("2027-01-12T09:00:00Z"), Instant.parse("2027-01-12T09:10:00Z"));
        st1Januar = angelegt("BR-2027-0001", "monatsbericht_standort", "standort", IDS.get("ST-1"), "monat", "2027-01",
                Instant.parse("2027-01-10T09:00:00Z"));
    }

    // ============================================================================================ B8

    /**
     * B8: Ines berichtigt am 20.11.2026 die Verteilung von MS-07 ab 01.10.2026 (70/30 → 60/40). Die verteilten Zahlen sind
     * MS-20 (liest 70 % von MS-07 als Anteil der 4100) und die Kostenstellen 4100 und 4200 — der Unternehmensbericht Nr. 1
     * zitiert sie und bekommt den Anstoß „verteilung_rueckwirkend“, sein Entwurf bildet sich neu. ST-1 zitiert MS-07 selbst,
     * aber keine verteilte Zahl: nichts. Dezember und Jahr zitieren 4100/4200 auch — sie sind nach dem 20.11. gebildet und
     * kennen die Berichtigung. Ein zweiter Takt liest die Zeile nicht wieder.
     */
    @Test
    @Order(1)
    void b8_eineBerichtigteVerteilungStoesstDenUnternehmensberichtAn_denStandortberichtSt1Nicht() throws Exception {
        assertThat(quellen(st1Oktober, 1)).contains("MS-07").doesNotContain("MS-20", "4100", "4200");
        assertThat(quellen(uOktober, 1)).contains("MS-20", "4100", "4200");
        JdbcTemplate j = new JdbcTemplate(admin);
        assertThat(StrukturAufloesung.verteilung(j, KB, IDS.get("MS-07"), StrukturAufloesung.kostenstellen(j, KB,
                StrukturAufloesung.json(VERTEILUNG_ALT), StrukturAufloesung.json(VERTEILUNG_NEU)), OKT_AB))
                .as("die verteilten Zahlen").containsExactlyInAnyOrder(IDS.get("4100"), IDS.get("4200"), IDS.get("MS-20"));
        String st1Vorher = bericht(st1Oktober);
        String nr1Vorher = stand(uOktober, 1);

        long zeile = messstelleAenderung("MS-07", "verteilung_geaendert", VERTEILUNG_ALT, VERTEILUNG_NEU,
                beginn(OKT_AB), true, Instant.parse("2026-11-20T09:00:00Z"));
        Instant takt = Instant.parse("2026-11-20T09:05:00Z");
        StrukturAenderungLaeufer.Lauf lauf = laeufer.lauf(takt);

        assertThat(lauf.gescheitert()).isEmpty();
        assertThat(gelesen(MESSSTELLE, zeile)).isEqualTo("verteilung_rueckwirkend · 2");
        String kennung = "verteilung_rueckwirkend/MS-07/2026-10-01/2026-11-20/messstelle_aenderung-" + zeile;
        assertThat(anstoesse(kennung)).containsExactly("BR-2026-0002 Nr. 1 | verteilung_rueckwirkend | offen | Fassung -");
        assertThat(BerichtRegeln.anlass(kennung))
                .isEqualTo("Verteilung MS-07 berichtigt, gilt ab 01.10.2026, eingetragen 20.11.2026");
        assertThat(stand(uOktober, 1)).as("Nr. 1 bleibt Byte für Byte").isEqualTo(nr1Vorher);
        assertThat(entwurf(uOktober)).isEqualTo(takt + " kaskade");
        assertThat(bericht(st1Oktober)).as("ST-1 ist nicht betroffen").isEqualTo(st1Vorher);
        assertThat(anstoesseAn(uDezember)).isEmpty();
        assertThat(anstoesseAn(uJahr)).isEmpty();

        List<JsonNode> angestossen = meldungen(BerichtKaskade.ANGESTOSSEN, kennung);
        assertThat(angestossen).hasSize(1);
        assertThat(angestossen.get(0).path("anstoss_art").asText()).isEqualTo("verteilung_rueckwirkend");
        assertThat(angestossen.get(0).path("nr").asInt()).isEqualTo(1);
        assertThat(angestossen.get(0).has("anlass_fassung")).as("Pfad 2 hat keine Fassung").isFalse();
        assertThat(meldungen(BerichtKaskade.NEU_GEBILDET, kennung)).hasSize(1);

        String nachher = berichtsTabellen();
        assertThat(laeufer.lauf(takt.plusSeconds(300)).gelesen()).as("nichts zweimal").isZero();
        assertThat(berichtsTabellen()).isEqualTo(nachher);
    }

    // ============================================================================================ B9

    /**
     * B9: Jonas trägt am 15.01.2027 für Halle 2 3 400 m² ab 01.01.2027 ein. Das Quellenverzeichnis nennt die Bezugsfläche von
     * Halle 2 am Oktober-Stand und am Januar-Entwurf (Objekt = der Ort; heute bringt sie noch keine Kennzahl hinein, der Test
     * schreibt die Zeile, wie der Abzug sie schreiben wird). Kein freigegebener Stand reicht bis 01.01.2027 — kein Anstoß;
     * der Entwurf Januar bildet sich neu.
     */
    @Test
    @Order(2)
    void b9_eineRueckwirkendeFlaecheStoesstKeinenStandAn_derEntwurfJanuarBildetSichNeu() throws Exception {
        zitiereFlaeche(st1Oktober, 1, OKT_AB, OKT_BIS);
        zitiereFlaeche(st1Januar, null, JAN_AB, LocalDate.parse("2027-01-31"));
        String oktoberVorher = bericht(st1Oktober);

        long zeile = ortAenderung("gebaeude", IDS.get("G-2"), "flaeche_geaendert", "{\"flaeche_m2\": 3100}",
                "{\"flaeche_m2\": 3400, \"korrektur\": false}", JAN_AB, true, Instant.parse("2027-01-15T09:30:00Z"));
        Instant takt = Instant.parse("2027-01-15T09:35:00Z");
        assertThat(laeufer.lauf(takt).gescheitert()).isEmpty();

        assertThat(gelesen(ORT, zeile)).isEqualTo("flaeche_rueckwirkend · 1");
        String kennung = "flaeche_rueckwirkend/G-2/2027-01-01/2027-01-15/ort_aenderung-" + zeile;
        assertThat(anstoesse(kennung)).as("kein freigegebener Stand betroffen").isEmpty();
        assertThat(entwurf(st1Januar)).as("der Entwurf Januar ist neu gebildet").isEqualTo(takt + " kaskade");
        assertThat(meldungen(BerichtKaskade.NEU_GEBILDET, kennung)).hasSize(1);
        assertThat(bericht(st1Oktober)).isEqualTo(oktoberVorher);
        assertThat(BerichtRegeln.anlass(kennung)).isEqualTo("Fläche G-2 geändert, gilt ab 01.01.2027, eingetragen 15.01.2027");
    }

    // ============================================================================================ B10

    /** B10: MS-12 heißt ab 01.12.2026 „Montage Linie M1 (Halle 2)“, Halle 2 bekommt einen neuen Namen — der Läufer liest beides nicht. */
    @Test
    @Order(3)
    void b10_eineUmbenennungStoesstNichtsAn() {
        String vorher = berichtsTabellen();
        long messstelle = messstelleAenderung("MS-12", "bearbeitet", "{\"name\": \"Montage Linie M1\"}",
                "{\"name\": \"Montage Linie M1 (Halle 2)\"}", beginn(LocalDate.parse("2026-12-01")), false,
                Instant.parse("2026-12-01T08:00:00Z"));
        long gebaeude = ortAenderung("gebaeude", IDS.get("G-2"), "bearbeitet", "{\"name\": \"Halle 2\"}",
                "{\"name\": \"Halle 2 (Montage)\"}", LocalDate.parse("2026-12-01"), false, Instant.parse("2026-12-01T08:01:00Z"));

        StrukturAenderungLaeufer.Lauf lauf = laeufer.lauf(Instant.parse("2026-12-01T08:05:00Z"));

        assertThat(lauf.gelesen()).isZero();
        assertThat(gelesen(MESSSTELLE, messstelle)).isNull();
        assertThat(gelesen(ORT, gebaeude)).isNull();
        assertThat(berichtsTabellen()).isEqualTo(vorher);
        assertThat(BerichtRegeln.struktur(MESSSTELLE, "messstelle", "bearbeitet", true, true).grund()).isEqualTo("umbenennung");
        assertThat(StrukturAufloesung.MESSSTELLE_ARTEN).doesNotContain("bearbeitet");
        assertThat(StrukturAufloesung.ORT_ARTEN).doesNotContain("bearbeitet");
    }

    // ============================================================================================ B11

    /**
     * B11: 9000 wird ab 01.01.2027 in 9010 und 9020 geteilt — Dezember und Jahr 2026 zitieren 9000 und bleiben, wie sie
     * sind. Als geplante Änderung (keine Berichtigung) ist die Zeile nie ein Anstoß; selbst als Berichtigung ab 01.01.2027,
     * eingetragen nach beiden Ständen, schneidet sie keinen Zeitraum 2026.
     */
    @Test
    @Order(4)
    void b11_eineTeilungStoesstNichtsAn() {
        JdbcTemplate j = new JdbcTemplate(admin);
        assertThat(BerichtRegeln.betroffene(BerichtKaskade.strukturQuellen(j, KB, Set.of(IDS.get("9000")),
                LocalDate.parse("2026-12-01"), null), List.of(IDS.get("9000").toString()), LocalDate.parse("2026-12-01")))
                .as("Dezember und Jahr zitieren 9000").extracting(BerichteNaht.Bericht::kennung)
                .contains("BR-2026-0006", "BR-2026-0007");
        assertThat(BerichtRegeln.betroffene(BerichtKaskade.strukturQuellen(j, KB, Set.of(IDS.get("9000")), JAN_AB, null),
                List.of(IDS.get("9000").toString()), JAN_AB)).as("B11: betroffene ab 01.01.2027").isEmpty();
        String vorher = berichtsTabellen();
        String alt = "{\"gueltig_ab\": \"2027-01-01\", \"zeilen\": [{\"kostenstelle\": \"9000\", \"anteil_prozent\": \"100\"}]}";
        String neu = "{\"gueltig_ab\": \"2027-01-01\", \"zeilen\": [{\"kostenstelle\": \"9010\", \"anteil_prozent\": \"50\"}, "
                + "{\"kostenstelle\": \"9020\", \"anteil_prozent\": \"50\"}], \"korrektur\": %s}";

        long geplant = messstelleAenderung("MS-02", "verteilung_geaendert", alt, neu.formatted("false"), beginn(JAN_AB), true,
                Instant.parse("2027-01-02T09:00:00Z"));
        long berichtigt = messstelleAenderung("MS-02", "verteilung_geaendert", alt, neu.formatted("true"), beginn(JAN_AB),
                true, Instant.parse("2027-01-20T09:00:00Z"));
        assertThat(laeufer.lauf(Instant.parse("2027-01-20T09:05:00Z")).gescheitert()).isEmpty();

        assertThat(gelesen(MESSSTELLE, geplant)).isEqualTo("nicht_rueckwirkend · 0");
        assertThat(gelesen(MESSSTELLE, berichtigt)).isEqualTo("verteilung_rueckwirkend · 0");
        assertThat(berichtsTabellen()).isEqualTo(vorher);
    }

    // ============================================================================================ Umzug

    /**
     * Ein rückwirkender Umzug von AN-1 (drei Zeilen wie {@code AnlageUmzugService}: Anlage, Ziel „hinzu“, Herkunft „hinaus“)
     * ist nichts: kein Abzug liest {@code anlage_standort}, und die Standort-Zeilen sind die Begleitzeilen des Umzugs, keine
     * Zuordnung eines Standorts.
     */
    @Test
    @Order(5)
    void einRueckwirkenderUmzugStoesstNichtsAn_auchSeineZeilenAmStandortNicht() {
        String vorher = berichtsTabellen();
        Instant eingetragen = Instant.parse("2026-11-23T09:00:00Z");
        String st1 = IDS.get("ST-1").toString();
        String st2 = IDS.get("ST-2").toString();
        long anlage = ortAenderung("anlage", IDS.get("AN-1"), "verschoben", "{\"standort_id\": \"" + st1 + "\"}",
                "{\"anlage_name\": \"AN-1\", \"standort_id\": \"" + st2 + "\"}", OKT_AB, true, eingetragen);
        long hinzu = ortAenderung("standort", IDS.get("ST-2"), "verschoben", null,
                "{\"anlage_id\": \"" + IDS.get("AN-1") + "\", \"richtung\": \"hinzu\"}", OKT_AB, true, eingetragen);
        long hinaus = ortAenderung("standort", IDS.get("ST-1"), "verschoben", null,
                "{\"anlage_id\": \"" + IDS.get("AN-1") + "\", \"richtung\": \"hinaus\"}", OKT_AB, true, eingetragen);

        assertThat(laeufer.lauf(Instant.parse("2026-11-23T09:05:00Z")).gescheitert()).isEmpty();

        assertThat(gelesen(ORT, anlage)).isEqualTo("anlage_umzug_rueckwirkend · 0");
        assertThat(gelesen(ORT, hinzu)).isEqualTo("zuordnung_rueckwirkend · 0");
        assertThat(gelesen(ORT, hinaus)).isEqualTo("zuordnung_rueckwirkend · 0");
        assertThat(berichtsTabellen()).isEqualTo(vorher);
    }

    // ============================================================================================ Datenstand

    /**
     * Wer die Änderung schon kennt, ist nicht betroffen: dieselbe rückwirkende Ortskorrektur von MS-12, einmal am 05.11.2026
     * eingetragen (vor beiden Oktober-Ständen) — nichts —, einmal am 24.11.2026 — Anstoß an ST-1 Nr. 1 und Unternehmen Nr. 1
     * (MS-12 steht dort mittelbar), beide Entwürfe neu; Dezember, Jahr und Januar sind danach gebildet.
     */
    @Test
    @Order(6)
    void werDieAenderungSchonKenntIstNichtBetroffen() {
        long frueh = messstelleAenderung("MS-12", "ort_korrigiert", "{}", "{}", beginn(OKT_AB), true,
                Instant.parse("2026-11-05T09:00:00Z"));
        long spaet = messstelleAenderung("MS-12", "ort_korrigiert", "{}", "{}", beginn(OKT_AB), true,
                Instant.parse("2026-11-24T09:00:00Z"));
        Instant takt = Instant.parse("2026-11-24T09:05:00Z");
        assertThat(laeufer.lauf(takt).gescheitert()).isEmpty();

        assertThat(gelesen(MESSSTELLE, frueh)).isEqualTo("zuordnung_rueckwirkend · 0");
        assertThat(anstoesse("zuordnung_rueckwirkend/MS-12/2026-10-01/2026-11-05/messstelle_aenderung-" + frueh)).isEmpty();
        assertThat(gelesen(MESSSTELLE, spaet)).isEqualTo("zuordnung_rueckwirkend · 4");
        assertThat(anstoesse("zuordnung_rueckwirkend/MS-12/2026-10-01/2026-11-24/messstelle_aenderung-" + spaet))
                .containsExactly("BR-2026-0001 Nr. 1 | zuordnung_rueckwirkend | offen | Fassung -",
                        "BR-2026-0002 Nr. 1 | zuordnung_rueckwirkend | offen | Fassung -");
        assertThat(entwurf(st1Oktober)).isEqualTo(takt + " kaskade");
        assertThat(entwurf(uOktober)).isEqualTo(takt + " kaskade");
        assertThat(anstoesseAn(uDezember)).isEmpty();
        assertThat(anstoesseAn(uJahr)).isEmpty();
    }

    // ============================================================================================ Gebäude

    /**
     * Halle 2 zieht rückwirkend nach Lindach: ihre Messstellen verlassen ST-1 — ST-1 Nr. 1 und das Unternehmen Nr. 1 werden
     * angestoßen. Dieselbe Verschiebung innerhalb von ST-1 ändert keine Zahl eines Berichts: nichts.
     */
    @Test
    @Order(7)
    void einGebaeudeWechseltRueckwirkendDenStandort_innerhalbDesStandortsNicht() {
        String st1 = IDS.get("ST-1").toString();
        String st2 = IDS.get("ST-2").toString();
        long wechsel = ortAenderung("gebaeude", IDS.get("G-2"), "verschoben", "{\"eltern_id\": \"" + st1
                + "\", \"standort_id\": \"" + st1 + "\"}", "{\"eltern_id\": \"" + st2 + "\", \"standort_id\": \"" + st2 + "\"}",
                OKT_AB, true, Instant.parse("2026-11-25T09:00:00Z"));
        long innen = ortAenderung("gebaeude", IDS.get("G-2"), "verschoben", "{\"eltern_id\": \"" + st1
                + "\", \"standort_id\": \"" + st1 + "\"}", "{\"eltern_id\": \"" + st1 + "\", \"standort_id\": \"" + st1 + "\"}",
                OKT_AB, true, Instant.parse("2026-11-25T09:01:00Z"));
        assertThat(laeufer.lauf(Instant.parse("2026-11-25T09:05:00Z")).gescheitert()).isEmpty();

        assertThat(anstoesse("zuordnung_rueckwirkend/G-2/2026-10-01/2026-11-25/ort_aenderung-" + wechsel))
                .containsExactly("BR-2026-0001 Nr. 1 | zuordnung_rueckwirkend | offen | Fassung -",
                        "BR-2026-0002 Nr. 1 | zuordnung_rueckwirkend | offen | Fassung -");
        assertThat(gelesen(ORT, wechsel)).isEqualTo("zuordnung_rueckwirkend · 4");
        assertThat(gelesen(ORT, innen)).isEqualTo("zuordnung_rueckwirkend · 0");
    }

    // ============================================================================================ Wasserzeichen

    /**
     * Scheitert die Transaktion einer Zeile, ist sie nicht gelesen: kein Anstoß, keine Neubildung, kein Urteil — der nächste
     * Takt holt sie nach, und danach liest keiner sie wieder.
     */
    @Test
    @Order(8)
    void einFehlerLaesstDieZeileUngelesen_derNaechsteTaktHoltSieNach() {
        long zeile = messstelleAenderung("MS-12", "ort_korrigiert", "{}", "{}", beginn(OKT_AB), true,
                Instant.parse("2026-11-26T09:00:00Z"));
        String kennung = "zuordnung_rueckwirkend/MS-12/2026-10-01/2026-11-26/messstelle_aenderung-" + zeile;
        String vorher = berichtsTabellen();
        StrukturAenderungLaeufer scheitert = new StrukturAenderungLaeufer(new JdbcTemplate(admin), new BerichtKaskade(bildung) {
            @Override
            public void revisionAusloesen(Connection con, BerichteNaht.Bericht bericht, BerichteNaht.StrukturBetroffen s) {
                throw new IllegalStateException("Bildung gescheitert");
            }
        }, 200);

        StrukturAenderungLaeufer.Lauf lauf = scheitert.lauf(Instant.parse("2026-11-26T09:05:00Z"));

        assertThat(lauf.gescheitert()).containsOnlyKeys("messstelle_aenderung-" + zeile);
        assertThat(gelesen(MESSSTELLE, zeile)).isNull();
        assertThat(berichtsTabellen()).as("die Transaktion rollt ganz zurück").isEqualTo(vorher);

        assertThat(laeufer.lauf(Instant.parse("2026-11-26T09:10:00Z")).gescheitert()).isEmpty();
        assertThat(gelesen(MESSSTELLE, zeile)).isEqualTo("zuordnung_rueckwirkend · 4");
        assertThat(anstoesse(kennung)).hasSize(2);
        String nachher = berichtsTabellen();
        assertThat(laeufer.lauf(Instant.parse("2026-11-26T09:15:00Z")).gelesen()).isZero();
        assertThat(berichtsTabellen()).isEqualTo(nachher);
    }

    // ============================================================================================ Bezugsgröße

    /**
     * Die Bezugsgröße trägt Pfad 1 (AP-11 IP-9): die Berichtigung BK-2026-0001 von BZ-6 stößt ST-1 Nr. 1 an — zweimal
     * gerufen bleibt es EIN Anstoß (B7). Ihr Protokoll ({@code bezugsgroesse_aenderung}) liest der Läufer nicht: liefe er,
     * gäbe es mit anderer Art und Kennung einen zweiten Anstoß, und die Idempotenz fände ihn nicht.
     */
    @Test
    @Order(9)
    void dieBezugsgroesseTraegtPfadEins_derLaeuferStoesstSieNieEinZweitesMalAn() throws Exception {
        bezugsgroesse("BZ-6", "gebaeude", "ort_id", IDS.get("G-2"));
        root.update("INSERT INTO bericht_quelle (tenant_id, bericht_id, stand_nr, art, kennzeichen, objekt_id, bezug, "
                + "erster_tag, letzter_tag, version, fassung, name_zum_datenstand) VALUES (?, ?, 1, 'bezugsgroesse', 'BZ-6', ?, "
                + "'unmittelbar', ?, ?, NULL, 1, 'Stückzahl Halle 2')", KB, st1Oktober, IDS.get("BZ-6"), Date.valueOf(OKT_AB),
                Date.valueOf(OKT_BIS));
        BerichtKaskade pfadEins = new BerichtKaskade(bildung);
        KorrekturKaskade.Betroffen bk = new KorrekturKaskade.Betroffen(KB, "BK-2026-0001", 2, "freigegeben", List.of(),
                OKT_BEGINN, OKT_ENDE, ZONE, OKT_AB, OKT_BIS, List.of(), List.of(), 0, Instant.parse("2026-11-27T09:00:00Z"),
                List.of(new KorrekturKaskade.Bezugsgroesse(IDS.get("BZ-6"), "BZ-6", OKT_AB, OKT_BIS, 2, "freigegeben")));
        BerichteNaht.Bericht nr1 = new BerichteNaht.Bericht("BR-2026-0001", BerichteNaht.Stand.FREIGEGEBEN);
        for (int i = 0; i < 2; i++) {
            inDerKaskade(con -> {
                assertThat(pfadEins.betroffene(con, bk)).contains(nr1);
                pfadEins.revisionAusloesen(con, nr1, bk);
            });
        }
        root.update("INSERT INTO bezugsgroesse_aenderung (tenant_id, bezugsgroesse_id, art, alt, neu, gilt_ab, rueckwirkend, "
                + "grund, actor_sub, actor_name, actor_rolle, actor_art, created_at) VALUES (?, ?, 'bearbeitet', "
                + "'{\"wert\": \"41000\"}'::jsonb, '{\"wert\": \"40000\"}'::jsonb, ?, true, 'Zählfehler', 'kc-ines-kaltenbach', "
                + "'Ines Kaltenbach', 'energiemanager', 'kunde', ?)", KB, IDS.get("BZ-6"), ts(OKT_BEGINN),
                ts(Instant.parse("2026-11-27T09:01:00Z")));
        String vorher = berichtsTabellen();

        assertThat(laeufer.lauf(Instant.parse("2026-11-27T09:05:00Z")).gelesen()).isZero();

        assertThat(anstoesse("BK-2026-0001")).containsExactly("BR-2026-0001 Nr. 1 | bezugsgroesse_fassung | offen | Fassung 2");
        assertThat(root.queryForObject("SELECT count(*) FROM bericht_revision_anstoss a JOIN bericht_stand s ON s.id = a.stand_id "
                + "WHERE s.bericht_id = ? AND a.art = 'bezugsgroesse_fassung'", Integer.class, st1Oktober)).isEqualTo(1);
        assertThat(berichtsTabellen()).isEqualTo(vorher);
    }

    /**
     * AP-04 A2: Der am 20.11. nachgetragene Zählerwechsel gilt seit dem 18.11. Der November-Stand bleibt Byte für Byte
     * stehen und erhält über den vorhandenen AP-12-Pfad genau einen Revisions-Anstoß.
     */
    @Test
    @Order(10)
    void a2EinSpaeterZaehlerwechselStoesstBetroffeneBerichteAnUndAendertKeinenStand() {
        UUID bericht = root.queryForObject("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, "
                + "geltung_art, unternehmen_id, zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_name) "
                + "VALUES (?, 'BR-2026-0099', 'monatsbericht_unternehmen', 1, 'unternehmen', ?, 'monat', '2026-11', "
                + "'Europe/Berlin', 'Jonas Wendlinger') RETURNING id", UUID.class, KB, IDS.get("U"));
        root.update("INSERT INTO bericht_stand (tenant_id, bericht_id, nr, abzug, pruefsumme, datenstand, freigegeben_am, "
                + "freigeber_sub, freigeber_name, freigeber_rolle, darstellung, regelwerk, vorlage_fassung) "
                + "SELECT ?, ?, 1, abzug, pruefsumme, '2026-11-19T08:00:00Z', '2026-11-19T08:05:00Z', "
                + "'kc-jonas-wendlinger', 'Jonas Wendlinger', 'kundenadministrator', darstellung, regelwerk, 1 "
                + "FROM bericht_stand WHERE bericht_id = ? AND nr = 1", KB, bericht, uOktober);
        root.update("INSERT INTO bericht_quelle (tenant_id, bericht_id, stand_nr, art, kennzeichen, objekt_id, bezug, "
                + "erster_tag, letzter_tag, version, fassung, name_zum_datenstand) VALUES (?, ?, 1, 'messstelle', "
                + "'MS-06', ?, 'unmittelbar', '2026-11-18', '2026-11-19', 1, NULL, 'Spritzguss SG01–SG06')",
                KB, bericht, IDS.get("MS-06"));
        String vorher = stand(bericht, 1);
        long zeile = messstelleAenderung("MS-06", "zaehler_gewechselt", "{}", "{}",
                Instant.parse("2026-11-18T09:40:00Z"), true, Instant.parse("2026-11-20T08:00:00Z"));

        assertThat(laeufer.lauf(Instant.parse("2026-11-20T08:05:00Z")).gescheitert()).isEmpty();

        String anlass = "zuordnung_rueckwirkend/MS-06/2026-11-18/2026-11-20/messstelle_aenderung-" + zeile;
        assertThat(gelesen(MESSSTELLE, zeile)).isEqualTo("zuordnung_rueckwirkend · 1");
        assertThat(anstoesse(anlass))
                .containsExactly("BR-2026-0099 Nr. 1 | zuordnung_rueckwirkend | offen | Fassung -");
        assertThat(stand(bericht, 1)).as("der freigegebene Stand bleibt byte-gleich").isEqualTo(vorher);
    }

    /** AP-16 R7/R11/R15: beide Pfade treffen nur die Bewertung, halten Nr. 1 fest und beachten den Not-Aus. */
    @Test
    @Order(11)
    void bewertungKorrekturUndFassungenStossenAn_ohneBewertungUndBeiFlagAusSchweigtDerLaeufer() throws Exception {
        long ohneBewertung = root.queryForObject("INSERT INTO bewertung_aenderung "
                + "(tenant_id,art,alt,neu,actor_sub,actor_name,actor_art,created_at) VALUES "
                + "(?, 'kriterien_freigegeben', '{}'::jsonb, jsonb_build_object('unternehmen_id', ?::text), "
                + "'kc-ines-kaltenbach','Ines Kaltenbach', 'kunde', '2026-11-18T08:00:00Z') RETURNING id", Long.class, KB,
                IDS.get("U"));
        laeufer.lauf(Instant.parse("2026-11-18T08:05:00Z"));
        assertThat(gelesen(BerichtRegeln.BEWERTUNG_AENDERUNG, ohneBewertung))
                .as("R11: ohne Bewertung kein Wasserzeichen").isNull();
        root.update("DELETE FROM bewertung_aenderung WHERE id=?", ohneBewertung);

        UUID umfang = uuid("INSERT INTO bewertung_umfang (tenant_id,unternehmen_id,fassung,gueltig_ab,traeger,"
                + "actor_sub,actor_name,actor_art) VALUES (?,?,1,'2026-10-01',ARRAY['Strom'],'kc-ines-kaltenbach',"
                + "'Ines Kaltenbach','kunde') RETURNING id",
                KB, IDS.get("U"));
        UUID einsatz = uuid("INSERT INTO energieeinsatz (tenant_id,kennzeichen,prozess_id,traeger,name,gueltig_ab,"
                + "actor_sub,actor_name,actor_art) VALUES (?,'EE-99',?,'Strom','Spritzguss','2026-10-01',"
                + "'kc-ines-kaltenbach','Ines Kaltenbach','kunde') "
                + "RETURNING id", KB, IDS.get("P-1"));
        UUID bedarf = uuid("INSERT INTO messbedarf (tenant_id,kennzeichen,einsatz_id,wortlaut,zustand,actor_sub,actor_name,"
                + "actor_art) VALUES (?,'MB-99',?,'Unterzähler ergänzen','offen','kc-ines-kaltenbach',"
                + "'Ines Kaltenbach','kunde') RETURNING id", KB, einsatz);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM messstelle_quelle WHERE tenant_id=? AND messstelle_id=? "
                + "ORDER BY created_at LIMIT 1", UUID.class, KB, IDS.get("MS-12"));
        UUID bewertung = uuid("INSERT INTO bericht (tenant_id,kennung,vorlage,vorlage_fassung,geltung_art,unternehmen_id,"
                + "zeitraum_art,zeitraum_schluessel,zeitzone,angelegt_von_name) VALUES "
                + "(?,'BR-2026-0199','energetische_bewertung',1,'unternehmen',?,'datengrundlage','2026-10',"
                + "'Europe/Berlin','Ines Kaltenbach') RETURNING id", KB, IDS.get("U"));
        root.update("INSERT INTO bericht_stand (tenant_id,bericht_id,nr,abzug,pruefsumme,datenstand,freigegeben_am,"
                + "freigeber_sub,freigeber_name,freigeber_rolle,darstellung,regelwerk,vorlage_fassung) "
                + "SELECT ?,?,1,abzug,pruefsumme,'2026-11-19T08:00:00Z','2026-11-19T08:05:00Z',"
                + "'kc-ines-kaltenbach','Ines Kaltenbach','energiemanager',darstellung,regelwerk,1 "
                + "FROM bericht_stand WHERE bericht_id=? AND nr=1", KB, bewertung, uOktober);
        for (Object[] q : List.of(new Object[] {"messstelle", "MS-12", IDS.get("MS-12"), null},
                new Object[] {"umfang", "Umfang", umfang, 1}, new Object[] {"energieeinsatz", "EE-99", einsatz, 1},
                new Object[] {"messbedarf", "MB-99", bedarf, null}, new Object[] {"messmittel", "Z-99", geraet, null})) {
            root.update("INSERT INTO bericht_quelle (tenant_id,bericht_id,stand_nr,art,kennzeichen,objekt_id,bezug,"
                    + "erster_tag,letzter_tag,fassung,name_zum_datenstand) VALUES (?,?,1,?,?,?,'unmittelbar',"
                    + "'2026-10-01','2026-10-31',?,?)", KB, bewertung, q[0], q[1], q[2], q[3], q[1]);
        }
        String nr1 = stand(bewertung, 1);

        BerichtKaskade kaskade = new BerichtKaskade(bildung);
        KorrekturKaskade.Betroffen korrektur = new KorrekturKaskade.Betroffen(KB, "K-2026-0099", 1,
                KorrekturKaskade.FREIGEGEBEN, List.of(), OKT_BEGINN, OKT_ENDE, ZONE, OKT_AB, OKT_BIS,
                List.of("MS-12"), List.of(), 1, Instant.parse("2026-11-20T08:05:00Z"));
        inDerKaskade(con -> KorrekturKaskade.berichteBenachrichtigen(con, kaskade, korrektur));
        assertThat(anstoesse("K-2026-0099"))
                .contains("BR-2026-0199 Nr. 1 | korrektur_freigegeben | offen | Fassung 1");
        assertThat(stand(bewertung, 1)).as("R7: Nr. 1 bleibt byte-gleich").isEqualTo(nr1);

        long kriterien = bewertungAenderung("kriterien_geaendert", IDS.get("U"),
                Instant.parse("2026-11-20T09:00:00Z"));
        long umfangAenderung = root.queryForObject("INSERT INTO bewertung_aenderung "
                + "(tenant_id,art,alt,neu,actor_sub,actor_name,actor_art,created_at) VALUES "
                + "(?,'umfang_geaendert',jsonb_build_object('id',?::text,'unternehmen_id',?::text),"
                + "jsonb_build_object('id',?::text,'unternehmen_id',?::text),'kc-ines-kaltenbach','Ines Kaltenbach',"
                + "'kunde','2026-11-20T09:00:30Z') RETURNING id", Long.class, KB, umfang, IDS.get("U"),
                UUID.randomUUID(), IDS.get("U"));
        long einstufung = root.queryForObject("INSERT INTO energieeinsatz_aenderung "
                + "(tenant_id,einsatz_id,art,alt,neu,actor_sub,actor_name,actor_art,created_at) VALUES "
                + "(?,?,'einstufung_gesetzt','{}'::jsonb,'{\"freigabe_status\":\"freigegeben\"}'::jsonb,"
                + "'kc-ines-kaltenbach','Ines Kaltenbach','kunde','2026-11-20T09:01:00Z') RETURNING id", Long.class, KB,
                einsatz);
        long messbedarf = root.queryForObject("INSERT INTO messbedarf_aenderung "
                + "(tenant_id,messbedarf_id,art,alt,neu,actor_sub,actor_name,actor_art,created_at) VALUES "
                + "(?,?,'eingeloest','{}'::jsonb,'{}'::jsonb,'kc-ines-kaltenbach','Ines Kaltenbach','kunde',"
                + "'2026-11-20T09:02:00Z') "
                + "RETURNING id", Long.class, KB, bedarf);
        long messmittel = root.queryForObject("INSERT INTO geraet_aenderung "
                + "(tenant_id,geraet_id,art,alt,neu,actor_sub,actor_name,actor_art,created_at) VALUES "
                + "(?,?,'messmittel_angabe','{}'::jsonb,'{}'::jsonb,'kc-ines-kaltenbach','Ines Kaltenbach','kunde',"
                + "'2026-11-20T09:03:00Z') "
                + "RETURNING id", Long.class, KB, geraet);
        long prozess = messstelleAenderung("MS-12", "prozesse_zugeordnet",
                "{\"prozesse\":[]}", "{\"prozesse\":[\"P-1\"]}", beginn(OKT_AB), true,
                Instant.parse("2026-11-20T09:04:00Z"));

        assertThat(laeufer.lauf(Instant.parse("2026-11-20T09:05:00Z")).gescheitert()).isEmpty();
        assertThat(gelesen(BerichtRegeln.BEWERTUNG_AENDERUNG, kriterien)).isEqualTo("kriterien_fassung · 1");
        assertThat(gelesen(BerichtRegeln.BEWERTUNG_AENDERUNG, umfangAenderung)).isEqualTo("umfang_fassung · 1");
        assertThat(gelesen(BerichtRegeln.ENERGIEEINSATZ_AENDERUNG, einstufung)).isEqualTo("einstufung_fassung · 1");
        assertThat(gelesen(BerichtRegeln.MESSBEDARF_AENDERUNG, messbedarf)).isEqualTo("messbedarf_zustand · 1");
        assertThat(gelesen(BerichtRegeln.GERAET_AENDERUNG, messmittel)).isEqualTo("messmittel_angabe · 1");
        assertThat(gelesen(MESSSTELLE, prozess)).isEqualTo("prozess_zuordnung_rueckwirkend · 1");
        assertThat(stand(bewertung, 1)).as("Pfad 2 ändert den freigegebenen Stand nicht").isEqualTo(nr1);

        long flagAus = bewertungAenderung("kriterien_freigegeben", IDS.get("U"),
                Instant.parse("2026-11-20T10:00:00Z"));
        ReflectionTestUtils.setField(laeufer, "bewertungEnabled", false);
        assertThat(laeufer.lauf(Instant.parse("2026-11-20T10:05:00Z")).gescheitert()).isEmpty();
        assertThat(gelesen(BerichtRegeln.BEWERTUNG_AENDERUNG, flagAus)).as("Flag aus: kein Wasserzeichen").isNull();
        assertThat(stand(bewertung, 1)).isEqualTo(nr1);
        ReflectionTestUtils.setField(kaskade, "bewertungEnabled", false);
        try (Connection con = admin.getConnection()) {
            assertThat(kaskade.betroffene(con, korrektur)).extracting(BerichteNaht.Bericht::kennung)
                    .as("Flag aus: Pfad 1 lässt nur Bewertungsstände schweigen").doesNotContain("BR-2026-0199");
        }
    }

    private static long bewertungAenderung(String art, UUID unternehmen, Instant erstellt) {
        return root.queryForObject("INSERT INTO bewertung_aenderung "
                + "(tenant_id,art,alt,neu,actor_sub,actor_name,actor_art,created_at) VALUES "
                + "(?,?,jsonb_build_object('unternehmen_id',?::text),jsonb_build_object('unternehmen_id',?::text,"
                + "'freigabe_status','freigegeben'),"
                + "'kc-ines-kaltenbach','Ines Kaltenbach','kunde',?) RETURNING id", Long.class, KB, art, unternehmen,
                unternehmen, ts(erstellt));
    }

    // ============================================================================================ Hilfen: Protokolle

    private static long messstelleAenderung(String kz, String art, String alt, String neu, Instant giltAb,
            boolean rueckwirkend, Instant eingetragen) {
        return root.queryForObject("INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, art, alt, neu, gilt_ab, "
                + "rueckwirkend, actor_sub, actor_name, actor_rolle, actor_art, created_at) VALUES (?, ?, ?, ?::jsonb, ?::jsonb, "
                + "?, ?, 'kc-ines-kaltenbach', 'Ines Kaltenbach', 'energiemanager', 'kunde', ?) RETURNING id", Long.class, KB,
                IDS.get(kz), art, alt, neu, ts(giltAb), rueckwirkend, ts(eingetragen));
    }

    private static long ortAenderung(String objektArt, UUID objekt, String art, String alt, String neu, LocalDate giltAb,
            boolean rueckwirkend, Instant eingetragen) {
        return root.queryForObject("INSERT INTO ort_aenderung (tenant_id, objekt_art, objekt_id, art, alt, neu, gilt_ab, "
                + "rueckwirkend, actor_sub, actor_name, actor_art, created_at) VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, "
                + "'kc-jonas-wendlinger', 'Jonas Wendlinger', 'kunde', ?) RETURNING id", Long.class, KB, objektArt, objekt, art, alt, neu,
                Date.valueOf(giltAb), rueckwirkend, ts(eingetragen));
    }

    /** Das Urteil im Wasserzeichen: „Urteil · Einträge“, {@code null} = nicht gelesen. */
    private static String gelesen(String protokoll, long zeile) {
        return root.queryForList("SELECT urteil || ' · ' || berichte FROM bericht_struktur_gelesen WHERE protokoll = ? "
                + "AND eintrag_id = ?", String.class, protokoll, zeile).stream().findFirst().orElse(null);
    }

    private static void zitiereFlaeche(UUID bericht, Integer nr, LocalDate erster, LocalDate letzter) {
        root.update("INSERT INTO bericht_quelle (tenant_id, bericht_id, stand_nr, art, kennzeichen, objekt_id, bezug, "
                + "erster_tag, letzter_tag, version, fassung, name_zum_datenstand) VALUES (?, ?, ?, 'stammdatum', 'BZ-4 (G-2)', ?, "
                + "'unmittelbar', ?, ?, NULL, 1, 'Bezugsfläche')", KB, bericht, nr, IDS.get("G-2"), Date.valueOf(erster),
                Date.valueOf(letzter));
    }

    // ============================================================================================ Hilfen: Berichte

    private static UUID angelegt(String kennung, String vorlage, String geltungArt, UUID geltung, String zeitraumArt,
            String schluessel, Instant datenstand) throws SQLException {
        UUID id = uuid("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, geltung_art, " + geltungArt
                + "_id, zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_name) VALUES (?, ?, ?, 1, ?, ?, ?, ?, "
                + "'Europe/Berlin', 'Jonas Wendlinger') RETURNING id", KB, kennung, vorlage, geltungArt, geltung,
                zeitraumArt, schluessel);
        try (Connection con = root.getDataSource().getConnection()) {
            bildung.bilden(con, id, datenstand, "anlegen");
        }
        return id;
    }

    /** Angelegt und Nr. 1 freigegeben — mit den Anweisungen der Route (F2): Kopie des Entwurfs und seiner Quellen. */
    private static UUID freigegeben(String kennung, String vorlage, String geltungArt, UUID geltung, String zeitraumArt,
            String schluessel, Instant datenstand, Instant am) throws SQLException {
        UUID id = angelegt(kennung, vorlage, geltungArt, geltung, zeitraumArt, schluessel, datenstand);
        BerichtRepository repo = new BerichtRepository(root);
        Instant gebildet = root.queryForObject("SELECT datenstand FROM bericht_entwurf WHERE bericht_id = ?", Timestamp.class,
                id).toInstant();
        assertThat(repo.standEinfrieren(KB, id, 1, gebildet, am, JONAS, "kundenadministrator", "{}", "{}", 1, null))
                .as(kennung + " Nr. 1").isPresent();
        repo.quellenEinfrieren(KB, id, 1);
        return id;
    }

    private static List<String> quellen(UUID bericht, int nr) {
        return root.queryForList("SELECT DISTINCT kennzeichen FROM bericht_quelle WHERE bericht_id = ? AND stand_nr = ?",
                String.class, bericht, nr);
    }

    private static String stand(UUID bericht, int nr) {
        return root.queryForObject("SELECT pruefsumme || ' ' || md5(abzug) FROM bericht_stand WHERE bericht_id = ? AND nr = ?",
                String.class, bericht, nr);
    }

    /** „Datenstand gebildet_von“ des Entwurfs. */
    private static String entwurf(UUID bericht) {
        Map<String, Object> e = root.queryForMap("SELECT datenstand, gebildet_von FROM bericht_entwurf WHERE bericht_id = ?",
                bericht);
        return ((Timestamp) e.get("datenstand")).toInstant() + " " + e.get("gebildet_von");
    }

    private static List<String> anstoesse(String anlass) {
        return root.queryForList("SELECT b.kennung || ' Nr. ' || s.nr || ' | ' || a.art || ' | ' || a.zustand || ' | Fassung ' "
                + "|| coalesce(a.anlass_fassung::text, '-') FROM bericht_revision_anstoss a JOIN bericht_stand s "
                + "ON s.id = a.stand_id AND s.tenant_id = a.tenant_id JOIN bericht b ON b.id = s.bericht_id "
                + "AND b.tenant_id = s.tenant_id WHERE a.tenant_id = ? AND a.anlass_kennung = ? ORDER BY b.kennung, s.nr",
                String.class, KB, anlass);
    }

    private static List<String> anstoesseAn(UUID bericht) {
        return root.queryForList("SELECT a.anlass_kennung FROM bericht_revision_anstoss a JOIN bericht_stand s "
                + "ON s.id = a.stand_id WHERE s.bericht_id = ?", String.class, bericht);
    }

    private static List<JsonNode> meldungen(String art, String anlass) throws Exception {
        List<JsonNode> aus = new ArrayList<>();
        for (String n : root.queryForList("SELECT nutzlast::text FROM messreihe_ereignis WHERE tenant_id = ? AND art = ? "
                + "AND nutzlast->>'anlass_kennung' = ? ORDER BY zeit", String.class, KB, art, anlass)) {
            aus.add(JSON.readTree(n));
        }
        return aus;
    }

    /** Entwurf, Stände und Anstöße EINES Berichts. */
    private static String bericht(UUID id) {
        return Bestandsschutz.inhalt(root, "bericht_entwurf", "t.bericht_id = ?", id) + "\n"
                + Bestandsschutz.inhalt(root, "bericht_stand", "t.bericht_id = ?", id) + "\n"
                + Bestandsschutz.inhalt(root, "bericht_revision_anstoss",
                        "t.stand_id IN (SELECT s.id FROM bericht_stand s WHERE s.bericht_id = ?)", id);
    }

    private static String berichtsTabellen() {
        StringBuilder s = new StringBuilder();
        for (String tabelle : List.of("bericht_entwurf", "bericht_stand", "bericht_quelle", "bericht_revision_anstoss",
                "messreihe_ereignis")) {
            s.append(tabelle).append(": ").append(Bestandsschutz.inhalt(root, tabelle, "t.tenant_id = ?", KB)).append('\n');
        }
        return s.toString();
    }

    private static void inDerKaskade(Schritt schritt) throws SQLException {
        try (Connection con = admin.getConnection()) {
            con.setAutoCommit(false);
            try {
                schritt.fahren(con);
                con.commit();
            } catch (SQLException | RuntimeException e) {
                con.rollback();
                throw e;
            }
        }
    }

    // ============================================================================================ Hilfen: Welt

    /** Das Unternehmen Ahrenberg wie in {@code BerichtAbzugUnternehmenTest} — ohne Kennzahlen, mit dem Verteilungs-Term von MS-20. */
    private static void ahrenberg() {
        root.update("INSERT INTO tenant (id, name) VALUES (?, ?)", KB, "Kunststoffwerk Ahrenberg GmbH (Pfad 2)");
        JsonNode u = referenz.path("unternehmen");
        IDS.put("U", uuid("INSERT INTO unternehmen (tenant_id, name, zeitzone, sitz_strasse, sitz_ort) "
                + "VALUES (?, ?, 'Europe/Berlin', ?, ?) RETURNING id", KB, u.path("name").asText(),
                u.path("sitz").path("strasse").asText(), u.path("sitz").path("ort").asText()));
        standort("ST-1", OKT_AB, LocalDate.parse("2024-03-12"), "AN-1", "AN-2");
        standort("ST-2", LIN_AB, LIN_AB, "AN-3");
        for (JsonNode b : referenz.path("bereiche")) {
            String eltern = b.path("eltern").asText();
            if (IDS.containsKey(eltern)) {
                ort("bereich", b, null, IDS.get(eltern), OKT_AB);
            }
        }
        for (String kz : List.of("MS-01", "MS-02", "MS-06", "MS-07", "MS-10", "MS-11", "MS-12", "MS-16", "MS-17", "MS-18",
                "MS-19", "MS-20")) {
            messstelle(eintrag("messstellen", kz));
        }
        for (String kz : List.of("MS-01", "MS-02", "MS-07", "MS-10", "MS-12", "MS-16", "MS-17", "MS-18")) {
            quelle(kz);
        }
        monat("MS-01", 128400);
        monat("MS-10", 36900);
        monat("MS-16", 9100);
        berechnet("MS-19", 174400, new Object[] {"MS-01", 128400L, "1"}, new Object[] {"MS-10", 36900L, "1"},
                new Object[] {"MS-16", 9100L, "1"});
        berechnet("MS-20", 88630, new Object[] {"MS-06", 55100L, "1"}, new Object[] {"MS-07", 15900L, "0.7"},
                new Object[] {"MS-11", 22400L, "1"});
        for (LocalDate d = OKT_AB; !d.isAfter(OKT_BIS); d = d.plusDays(1)) {
            boolean letzter = d.equals(OKT_BIS);
            tag("MS-07", d, letzter ? 600 : 510);
            tag("MS-12", d, letzter ? 220 : 196);
            if (!d.isBefore(LIN_AB)) {
                tag("MS-18", d, letzter ? 224 : 211);
            }
        }
        for (LocalDate d = LocalDate.parse("2026-11-01"); !d.isAfter(LocalDate.parse("2026-12-31")); d = d.plusDays(1)) {
            tag("MS-02", d, d.getDayOfMonth() == 1 ? 10 : 20);
        }
        IDS.put("P-1", uuid("INSERT INTO prozess (tenant_id, unternehmen_id, kennzeichen, name, gueltig_ab, created_by) "
                + "VALUES (?, ?, 'P-1', ?, ?, 'test') RETURNING id", KB, IDS.get("U"),
                eintrag("prozesse", "P-1").path("name").asText(), Date.valueOf(OKT_AB)));
        root.update("INSERT INTO messstelle_prozess (tenant_id, messstelle_id, prozess_id, gueltig_ab, created_by) "
                + "VALUES (?, ?, ?, ?, 'test')", KB, IDS.get("MS-20"), IDS.get("P-1"), Date.valueOf(OKT_AB));
        for (JsonNode k : referenz.path("kostenstellen")) {
            IDS.put(k.path("kennzeichen").asText(), uuid("INSERT INTO kostenstelle (tenant_id, unternehmen_id, kennzeichen, "
                    + "name, gueltig_ab, gueltig_bis, created_by) VALUES (?, ?, ?, ?, ?, ?, 'test') RETURNING id", KB,
                    IDS.get("U"), k.path("kennzeichen").asText(), k.path("name").asText(),
                    LocalDate.parse(k.path("gueltig_ab").asText()),
                    k.path("gueltig_bis").isNull() ? null : LocalDate.parse(k.path("gueltig_bis").asText())));
        }
        verteilung("MS-06", OKT_AB, null, "4100", 100);
        verteilung("MS-11", OKT_AB, null, "4100", 100);
        verteilung("MS-20", OKT_AB, null, "4100", 100);
        verteilung("MS-07", OKT_AB, null, "4100", 70, "4200", 30);
        verteilung("MS-12", OKT_AB, null, "4200", 100);
        verteilung("MS-18", LIN_AB, null, "4200", 100);
        verteilung("MS-02", LocalDate.parse("2026-11-01"), LocalDate.parse("2026-12-31"), "9000", 100);
        // B8: MS-20 liest den Anteil der 4100 an MS-07 als Term der Art `verteilung` (AP-10 IP-5) — die verteilte Zahl.
        root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, position, eingang_art, quell_messstelle_id, "
                + "verteilung_ziel, vorzeichen, faktor) VALUES (?, ?, 0, 'verteilung', ?, ?, '+', 1)", KB, IDS.get("MS-20"),
                IDS.get("MS-07"), IDS.get("4100"));
    }

    private static void standort(String kz, LocalDate orteAb, LocalDate anlagenAb, String... anlagen) {
        UUID st = uuid("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", KB, IDS.get("U"),
                eintrag("standorte", kz).path("name").asText(), kz);
        IDS.put(kz, st);
        for (String anlage : anlagen) {
            UUID site = uuid("INSERT INTO site (tenant_id, name) VALUES (?, ?) RETURNING id", KB, anlage);
            root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?, ?, ?, ?)",
                    KB, site, st, Date.valueOf(anlagenAb));
            IDS.put(anlage, site);
            IDS.put("BOX:" + anlage, uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                    + "VALUES (?, ?, ?, 'claimed') RETURNING id", KB, site, "VP-BOX-STRUKTUR-" + anlage));
        }
        for (JsonNode g : referenz.path("gebaeude")) {
            if (kz.equals(g.path("standort").asText())) {
                ort("gebaeude", g, st, null, orteAb);
            }
        }
    }

    private static void ort(String art, JsonNode o, UUID elternStandort, UUID elternOrt, LocalDate ab) {
        UUID id = uuid("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, ?, ?, ?, 'aktiv') "
                + "RETURNING id", KB, art, o.path("name").asText(), o.path("kennzeichen").asText());
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, eltern_ort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, ?, ?)", KB, id, elternStandort, elternOrt, Date.valueOf(ab));
        IDS.put(o.path("kennzeichen").asText(), id);
    }

    private static void messstelle(JsonNode m) {
        String kz = m.path("kennzeichen").asText();
        JsonNode h = m.path("hauptgroesse");
        UUID id = uuid("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, einheit, "
                + "wertart) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id", KB, kz, m.path("name").asText(),
                m.path("art").asText(), m.path("medium").asText(), h.path("groesse").asText(),
                h.path("richtung").asText(), h.path("einheit").asText(), h.path("wertart").asText());
        IDS.put(kz, id);
        JsonNode stellung = m.path("elektrische_stellung").path(0);
        LocalDate ab = "AN-3".equals(stellung.path("anlage").asText()) ? LIN_AB : OKT_AB;
        String ort = m.path("ort").path("kennzeichen").asText();
        switch (m.path("ort").path("art").asText()) {
            case "standort" -> root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, standort_id, gueltig_ab) "
                    + "VALUES (?, ?, ?, ?)", KB, id, IDS.get(ort), Date.valueOf(ab));
            case "gebaeude", "bereich" -> root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, "
                    + "gueltig_ab) VALUES (?, ?, ?, ?)", KB, id, IDS.get(ort), Date.valueOf(ab));
            case "unternehmen" -> root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, unternehmen_id, "
                    + "gueltig_ab) VALUES (?, ?, ?, ?)", KB, id, IDS.get("U"), Date.valueOf(ab));
            default -> {
                // „keiner“ — MS-20 ist eine Prozess-Messstelle ohne Ort.
            }
        }
        if (Set.of("Hauptzähler", "Erzeuger", "Speicher").contains(stellung.path("stellung").asText())) {
            root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, gueltig_ab) "
                    + "VALUES (?, ?, ?, ?, ?)", KB, id, IDS.get(stellung.path("anlage").asText()),
                    stellung.path("stellung").asText(), Date.valueOf(stellung.path("gueltig_ab").asText()));
        }
    }

    private static void quelle(String kz) {
        JsonNode m = eintrag("messstellen", kz);
        String anlage = m.path("elektrische_stellung").path(0).path("anlage").asText();
        UUID entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, "
                + "communication, connection_json, created_at) VALUES (?, ?, 'grid-meter', ?, 'grid-meter', ?, "
                + "'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, '2024-03-12T00:00:00Z') RETURNING id",
                KB, IDS.get(anlage), "K " + kz, IDS.get("BOX:" + anlage));
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, 'energy_kwh', true, 60, 1, "
                + "'2024-03-12T00:00:00Z', '2026.09.11.1', 'test', 'pending_edge', 'live_power', 'fifteen_minute')",
                KB, IDS.get(anlage), IDS.get("BOX:" + anlage), entity);
        IDS.put("K:" + kz, entity);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, entity);
        JsonNode h = m.path("hauptgroesse");
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_sub, "
                + "actor_name, actor_art) VALUES (?, ?, ?, ?, ?, ?, ?, 'counter', 'zaehlerstand', 'fuehrend', "
                + "'2024-03-12T00:00:00Z', true, now(), 'sub', 'Probe', 'kunde')", KB, IDS.get(kz),
                h.path("groesse").asText(), h.path("richtung").asText(), entity, geraet, KANAL);
    }

    /** Oktober 2026, gezählt, vollständig und endgültig. */
    private static void monat(String kz, long menge) {
        root.update("INSERT INTO messreihe_periode (tag, art, tenant_id, entity_id, messkanal, zeitzone, "
                + "zeitzone_herkunft, beginn, ende, stunden, teile_erwartet, teile_vorhanden, teile_endgueltig, wertart, "
                + "menge, menge_zustand, kennzeichen, erhalten, erwartet, abdeckung_prozent, zustand, endgueltig_ab, "
                + "version, berechnet_am) VALUES (DATE '2026-10-01', 'monat', ?, ?, ?, 'Europe/Berlin', 'standort', ?, ?, "
                + "745, 31, 31, 31, 'counter', ?, 'vollständig', '[]'::jsonb, 44700, 44700, 100, 'endgueltig', ?, 1, ?)",
                KB, IDS.get("K:" + kz), KANAL, ts(OKT_BEGINN), ts(OKT_ENDE), BigDecimal.valueOf(menge), ts(OKT_ENDGUELTIG),
                ts(MONATSLAUF));
    }

    /** Ein gemessener, vollständiger, endgültiger Tageswert der Reihe einer Messstelle. */
    private static void tag(String kz, LocalDate tag, long menge) {
        int stunden = TagRegeln.stunden(tag, ZONE);
        int slots = stunden * 4;
        int erwartet = stunden * 60;
        root.update("INSERT INTO messreihe_tag (tag, tenant_id, entity_id, messkanal, zeitzone, zeitzone_herkunft, "
                + "beginn, ende, stunden, slots_erwartet, slots_vorhanden, slots_endgueltig, wertart, erhalten, erwartet, "
                + "abdeckung_prozent, rolle, zustand, endgueltig_ab, version, menge, menge_zustand, kennzeichen) "
                + "VALUES (?, ?, ?, ?, 'Europe/Berlin', 'vorgabe', ?, ?, ?, ?, ?, ?, 'counter', ?, ?, 100, 'fuehrend', "
                + "'endgueltig', ?, 1, ?, 'vollständig', '[]'::jsonb)", tag, KB, IDS.get("K:" + kz), KANAL,
                ts(beginn(tag)), ts(beginn(tag.plusDays(1))), stunden, slots, slots, slots, erwartet, erwartet,
                ts(beginn(tag.plusDays(1)).plus(Duration.ofDays(7))), BigDecimal.valueOf(menge));
    }

    /** Eine berechnete Messstelle (gewichtete Summe) mit ihrem Oktober-Wert und seiner gespeicherten Herkunft. */
    private static void berechnet(String kz, long menge, Object[]... eingaenge) {
        UUID fassung = uuid("INSERT INTO messstelle_formel_fassung (tenant_id, messstelle_id, nummer, formel_typ, herkunft, "
                + "actor_sub, actor_name, actor_art) VALUES (?, ?, 1, 'gewichtete_summe', 'anlage', 'sub-test', 'Test', "
                + "'kunde') RETURNING id", KB, IDS.get(kz));
        root.update("INSERT INTO messreihe_periode (tag, art, tenant_id, messstelle_id, formel_fassung_id, formel_typ, "
                + "zeitzone, zeitzone_herkunft, beginn, ende, stunden, menge, menge_zustand, kennzeichen, abdeckung_prozent, "
                + "zustand, endgueltig_ab, version, berechnet_am) VALUES (DATE '2026-10-01', 'monat', ?, ?, ?, "
                + "'gewichtete_summe', 'Europe/Berlin', 'standort', ?, ?, 745, ?, 'vollständig', '[]'::jsonb, 100, "
                + "'endgueltig', ?, 1, ?)", KB, IDS.get(kz), fassung, ts(OKT_BEGINN), ts(OKT_ENDE),
                BigDecimal.valueOf(menge), ts(OKT_ENDGUELTIG), ts(MONATSLAUF));
        int position = 0;
        for (Object[] e : eingaenge) {
            root.update("INSERT INTO bilanzwert_eingang (periode_beginn, tenant_id, messstelle_id, periode, version, "
                    + "position, eingang_messstelle_id, eingang_kennzeichen, vorzeichen, faktor, menge, menge_zustand, "
                    + "fassung, abdeckung_prozent, eingang_version, kennzeichen, berechnet_am) VALUES (?, ?, ?, 'monat', 1, "
                    + "?, ?, ?, '+', ?, ?, 'vollständig', 'endgueltig', 100, 1, '[]'::jsonb, ?)", ts(OKT_BEGINN), KB,
                    IDS.get(kz), position++, IDS.get((String) e[0]), e[0], new BigDecimal((String) e[2]),
                    BigDecimal.valueOf((Long) e[1]), ts(MONATSLAUF));
        }
    }

    /** Ein Satz in EINER Anweisung — die 100 % prüft die Datenbank zur Commit-Zeit. */
    private static void verteilung(String kz, LocalDate ab, LocalDate bis, Object... zielUndProzent) {
        StringBuilder sql = new StringBuilder("INSERT INTO messstelle_verteilung (tenant_id, messstelle_id, kostenstelle_id, "
                + "anteil_prozent, gueltig_ab, gueltig_bis, created_by) VALUES ");
        List<Object> args = new ArrayList<>();
        for (int i = 0; i < zielUndProzent.length; i += 2) {
            sql.append(i == 0 ? "" : ", ").append("(?, ?, ?, ?::numeric, ?, ?, 'test')");
            args.addAll(Arrays.asList(KB, IDS.get(kz), IDS.get((String) zielUndProzent[i]),
                    zielUndProzent[i + 1].toString(), ab, bis));
        }
        root.update(sql.toString(), args.toArray());
    }

    private static void bezugsgroesse(String kz, String geltungArt, String spalte, UUID objekt) {
        JsonNode bz = eintrag("bezugsgroessen", kz);
        IDS.put(kz, uuid("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, "
                + "geltung_art, " + spalte + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id", KB, kz,
                bz.path("name").asText(), bz.path("wertart").asText(), bz.path("einheit_code").asText(),
                bz.path("periode_code").isNull() ? null : bz.path("periode_code").asText(), geltungArt, objekt));
    }

    private static JsonNode eintrag(String liste, String kennzeichen) {
        for (JsonNode e : referenz.path(liste)) {
            if (kennzeichen.equals(e.path("kennzeichen").asText())) {
                return e;
            }
        }
        throw new IllegalStateException(liste + " " + kennzeichen);
    }

    private static Instant beginn(LocalDate tag) {
        return tag.atStartOfDay(ZONE).toInstant();
    }

    private static Timestamp ts(Instant t) {
        return Timestamp.from(t);
    }

    private static UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
