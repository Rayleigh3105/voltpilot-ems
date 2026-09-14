package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.measurement.MesskanalService;
import com.voltpilot.api.measurement.SpeicherklasseHistorie;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.KostenstelleEnergieDto;
import com.voltpilot.api.uems.EreignisVokabular.Urheber;
import com.voltpilot.api.uems.MessreiheKorrekturRepository.Korrektur;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
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
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Abnahme von AP-08 IP-17 (Testcontainers): <b>eine freigegebene Korrektur zieht automatisch bis zum Jahr durch — ein
 * freigegebener Bericht aber nie.</b>
 *
 * <p>Die Zeitachse (Ahrenberg, MS-10 Halle 2 und MS-11): pünktliche Rohwerte von F10 (03.11.2026) und F12 (15.01.2027) auf
 * der Fassung VOR {@code V20260914120000} → FINGERABDRUCK → Migration → Version 1 von Viertelstunde, Tag, Monat, Jahr und
 * der berechneten Messstellen MS-15 (= MS-10) und MS-19 (= MS-15) → endgültig → F10 trifft nach der Frist ein → Vorschlag
 * K-2026-0001 (und im fremden Kundenbereich dasselbe) → Ines Kaltenbach gibt frei → eine Kaskade mit kaputter
 * Kennzahlen-Naht bricht ab → die Kaskade → noch einmal → der Monat wächst (Nachzug) → der Monat wird endgültig → F12 →
 * Jonas Wendlinger nimmt K-2026-0001 zurück.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsKorrekturKaskadeTest {

    private static final String DIESE = "20260914120000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Ein Zählerstand in kWh aus dem ausgelieferten Katalog. */
    private static final String KANAL = "deye.hybrid_1p.meter.generator-energy";

    private static final UUID KB = UUID.fromString("4e0e0000-0000-0000-0000-000000000021");
    private static final UUID FREMD = UUID.fromString("4e0e0000-0000-0000-0000-000000000022");

    private static final Instant T_V1 = Instant.parse("2026-11-04T00:30:00Z");
    private static final Instant T_V1_TAKT = Instant.parse("2026-11-04T01:00:00Z");
    private static final Instant T_ALLES_ENDGUELTIG = Instant.parse("2026-11-12T07:00:00Z");
    private static final Instant T_F10 = Instant.parse("2026-11-12T08:05:00Z");
    private static final Instant T_F10_TAKT = Instant.parse("2026-11-12T09:00:00Z");
    private static final Instant T_FREIGABE = Instant.parse("2026-11-12T09:15:00Z");
    private static final Instant T_KASKADE = Instant.parse("2026-11-12T09:20:00Z");
    private static final Instant T_NOCHMAL = Instant.parse("2026-11-12T09:25:00Z");
    /** Der Monat wächst: Werte vom 20.11., gebildet am 21.11. */
    private static final Instant T_WACHSEN = Instant.parse("2026-11-21T00:30:00Z");
    private static final Instant T_WACHSEN_TAKT = Instant.parse("2026-11-21T01:00:00Z");
    private static final Instant T_WACHSEN_KASKADE = Instant.parse("2026-11-21T01:05:00Z");
    /** 08.12.2026: der November ist endgültig (Ende + 7 Tage). */
    private static final Instant T_NOVEMBER_ENDGUELTIG = Instant.parse("2026-12-08T01:00:00Z");
    private static final Instant T_NOVEMBER_KASKADE = Instant.parse("2026-12-08T01:05:00Z");
    /** F12. */
    private static final Instant T_F12_V1 = Instant.parse("2027-01-16T00:30:00Z");
    private static final Instant T_F12_V1_TAKT = Instant.parse("2027-01-16T01:00:00Z");
    private static final Instant T_F12_ENDGUELTIG = Instant.parse("2027-01-25T08:00:00Z");
    private static final Instant F12_EINGANG = Instant.parse("2027-01-25T08:40:00Z");
    private static final Instant T_F12_TAKT = Instant.parse("2027-01-25T09:00:00Z");
    private static final Instant T_F12_KASKADE = Instant.parse("2027-01-25T10:05:00Z");
    private static final Instant T_WIDERRUF_KASKADE = Instant.parse("2027-01-26T10:00:00Z");

    /** 03.11.2026 14:00 MEZ … 17:45 MEZ: die 15 Viertelstunden der Nachlieferung. */
    private static final Instant VON = Instant.parse("2026-11-03T13:00:00Z");
    private static final Instant BIS = Instant.parse("2026-11-03T16:45:00Z");
    private static final Instant F12_VIERTELSTUNDE = Instant.parse("2027-01-15T08:00:00Z");
    private static final LocalDate TAG = LocalDate.of(2026, 11, 3);
    private static final LocalDate NOVEMBER = LocalDate.of(2026, 11, 1);
    private static final LocalDate JAHR = LocalDate.of(2026, 1, 1);

    private static final ProtokollAkteur INES = new ProtokollAkteur("kc-ines-kaltenbach", "Ines Kaltenbach",
            "energiemanager", "kunde");
    private static final ProtokollAkteur JONAS = new ProtokollAkteur("kc-jonas-wendlinger", "Jonas Wendlinger",
            "kundenadministrator", "kunde");

    /** Was die Kaskade schreibt — der Rest muss Zeichen für Zeichen bleiben. */
    private static final List<String> KASKADE = List.of("messreihe_viertelstunde_version", "messreihe_periode_version",
            "messreihe_kaskade_wirkung", "bilanzwert_eingang", "messreihe_ereignis");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static final Map<String, UUID> IDS = new LinkedHashMap<>();

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static JdbcTemplate admin;
    private static ViertelstundeVerdichter verdichter;
    private static TagVerdichter tage;
    private static EndgueltigkeitLaeufer laeufer;
    private static MessreiheKorrekturRepository korrekturen;
    private static KorrekturKaskade kaskade;
    private static Berichte berichte;

    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;

    private static String f10;
    private static String f10Fremd;
    private static Map<String, Object> tagV1;
    private static Map<String, Object> monatV1;
    private static Map<String, Object> jahrV1;
    private static Map<String, Object> ms15TagV1;
    private static boolean abbruchWarf;
    private static Map<String, String> vorDemAbbruch;
    private static Map<String, String> nachAbbruch;
    private static String eingaengeV1Vorher;
    private static String eingaengeV1Nachher;
    private static String meldungenVorher;
    private static String meldungenNachher;
    private static Map<String, String> nachErstemLauf;
    private static String entwurfNachDerFreigabe;
    private static int monatVersionenNachDemWachsen;
    private static Map<String, String> vorDerKaskade;
    private static KorrekturKaskade.Lauf lauf;
    private static Map<String, String> nachDerKaskade;
    private static String bestandNachDerKaskade;
    private static KorrekturKaskade.Lauf nochmal;
    private static Map<String, String> nachNochmal;
    private static List<Map<String, Object>> versionenNachKaskade;
    private static Map<String, Object> monatV2VorDemWachsen;
    private static Map<String, Object> monatV1NachDemWachsen;
    private static KorrekturKaskade.Lauf wachsen;
    private static Map<String, Object> monatV2NachDemWachsen;
    private static KorrekturKaskade.Lauf endgueltig;
    private static Map<String, Object> monatV2Endgueltig;
    private static boolean endgueltigeVersionUnveraenderlich;
    private static String f12;
    private static Map<String, Object> f12TagV1;
    private static Map<String, Object> f12MonatV1;
    private static KorrekturKaskade.Lauf f12Lauf;
    private static KorrekturKaskade.Lauf widerruf;
    private static MessstelleWerteService werte;
    private static List<Map<String, Object>> bilanzMeldungen;
    private static KostenstelleEnergieDto.Energie logistikNeu;
    private static KostenstelleEnergieDto.Energie logistikVersionEins;
    private static KostenstelleEnergieDto.Energie montageNeu;

    // =========================================================================== Aufbau

    @BeforeAll
    static void bauenUndFahren() throws Exception {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        stammdaten();
        saeen(KB, "F10", abschnitte("f10-", false));
        saeen(KB, "F12", abschnitte("f12-", false));
        saeen(FREMD, "ZF", abschnitte("f10-", false));
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());
        flyway().target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        flyway().load().migrate();

        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        MeasurementCatalog katalog = new MeasurementCatalog(JSON);
        SpaetankunftMelder melder = new SpaetankunftMelder();
        verdichter = new ViertelstundeVerdichter(admin, katalog, melder, 500, 40, 200_000);
        tage = new TagVerdichter(admin, katalog, 200, 40, 20_000, 200_000);
        BerechnetePeriodenLauf berechnete = berechnete(katalog);
        laeufer = new EndgueltigkeitLaeufer(new EndgueltigkeitLauf(admin, 2000, 200), tage,
                new PeriodeVerdichter(admin, katalog, 50, 40, 2000), berechnete,
                new KorrekturVorschlagLauf(admin, verdichter, melder, 200));
        korrekturen = new MessreiheKorrekturRepository(app);
        ErsatzwertLauf ersatzwerte = new ErsatzwertLauf(admin, katalog, verdichter, 200);
        berichte = new Berichte();
        kaskade = new KorrekturKaskade(admin, katalog, verdichter, ersatzwerte, berechnete, new KennzahlenNaht.Keine(),
                berichte, 50);
        messstellen();

        // ---- Version 1 des 03.11. und endgültig --------------------------------------------------------------
        verdichtungstakt(T_V1);
        tage.rueckrechnenGanz(T_V1_TAKT, 200);
        laeufer.takt(T_V1_TAKT);
        laeufer.takt(T_ALLES_ENDGUELTIG);

        // ---- F10: die Nachlieferung nach der Frist → Vorschlag (und im fremden Kundenbereich dasselbe) ---------
        saeen(KB, "F10", abschnitte("f10-", true));
        saeen(FREMD, "ZF", abschnitte("f10-", true));
        verdichtungstakt(T_F10);
        laeufer.takt(T_F10_TAKT);
        f10 = vorschlag(KB, "F10").kennung();
        f10Fremd = vorschlag(FREMD, "ZF").kennung();
        tagV1 = tag("F10", TAG);
        monatV1 = periode("F10", "monat", NOVEMBER);
        jahrV1 = periode("F10", "jahr", JAHR);
        ms15TagV1 = berechneterTag("MS-15", TAG);
        // Die Berichte, die AP-12 einmal hat: ein freigegebener über den 03.11. und ein Entwurf.
        berichte.anlegen("BR-2026-W45", BerichteNaht.Stand.FREIGEGEBEN, "Woche 45: Halle 2, 03.11.2026: "
                + tagV1.get("menge") + " kWh · " + tagV1.get("menge_zustand") + " · Verlauf " + tagV1.get("abdeckung_prozent")
                + " %");
        berichte.anlegen("BR-2026-11-ENTWURF", BerichteNaht.Stand.ENTWURF, "November (Entwurf): noch nicht gebildet");

        // ---- Die Freigabe: EIN Mensch, EINE Entscheidung ------------------------------------------------------
        als(KB, () -> korrekturen.freigeben(KB, f10, null, INES));
        als(FREMD, () -> korrekturen.freigeben(FREMD, f10Fremd, null, INES));
        vorDerKaskade = Bestandsschutz.fingerabdruck(root, KASKADE);
        eingaengeV1Vorher = Bestandsschutz.inhalt(root, "bilanzwert_eingang", "t.version = 1");
        meldungenVorher = Bestandsschutz.inhalt(root, "messreihe_ereignis", "NOT (t.art = 'correction' AND t.urheber = 'kunde') AND t.art <> 'bilanz_neu_berechnet'");
        vorDemAbbruch = Bestandsschutz.fingerabdruck(root, List.of());

        // ---- Abbruchsicher: die Kennzahlen-Naht bricht NACH allen Stufen ab — nichts Halbes bleibt --------------
        KorrekturKaskade kaputt = new KorrekturKaskade(admin, katalog, verdichter, ersatzwerte, berechnete,
                (con, b) -> {
                    throw new SQLException("Kennzahlen nicht erreichbar");
                }, berichte, 50);
        try {
            kaputt.lauf(T_KASKADE);
        } catch (RuntimeException e) {
            abbruchWarf = true;
        }
        nachAbbruch = Bestandsschutz.fingerabdruck(root, List.of());

        // ---- Die Kaskade ----------------------------------------------------------------------------------------
        lauf = kaskade.lauf(T_KASKADE);
        // AP-10 IP-11: die Meldungen der Neuberechnung und die Kostenstellen-Sicht direkt nach der Kaskade.
        bilanzMeldungen = root.queryForList("SELECT kennungen ->> 'messstelle' AS messstelle, nutzlast ->> 'ausloeser' "
                + "AS ausloeser, urheber, von, bis, messstelle_id FROM messreihe_ereignis WHERE tenant_id = ? "
                + "AND art = 'bilanz_neu_berechnet' ORDER BY 1", KB);
        KostenstelleEnergieService kostenstellen = new KostenstelleEnergieService(new KostenstelleProzessRepository(app),
                new KostenstelleEnergieRepository(app), new MessstelleRepository(app), werte, berechnete);
        logistikNeu = als(KB, () -> kostenstellen.energie(IDS.get("4300"), "tag", TAG, null));
        logistikVersionEins = als(KB, () -> kostenstellen.energie(IDS.get("4300"), "tag", TAG, "1"));
        montageNeu = als(KB, () -> kostenstellen.energie(IDS.get("4200"), "tag", TAG, null));
        nachDerKaskade = Bestandsschutz.fingerabdruck(root, KASKADE);
        eingaengeV1Nachher = Bestandsschutz.inhalt(root, "bilanzwert_eingang", "t.version = 1");
        meldungenNachher = Bestandsschutz.inhalt(root, "messreihe_ereignis", "NOT (t.art = 'correction' AND t.urheber = 'kunde') AND t.art <> 'bilanz_neu_berechnet'");
        nachErstemLauf = Bestandsschutz.fingerabdruck(root, List.of());
        entwurfNachDerFreigabe = berichte.eintrag("BR-2026-11-ENTWURF").inhalt();
        bestandNachDerKaskade = alleVersionen();
        versionenNachKaskade = root.queryForList("SELECT * FROM messreihe_periode_version ORDER BY tenant_id, ebene, "
                + "periode_beginn, version");
        nochmal = kaskade.lauf(T_NOCHMAL);
        nachNochmal = Bestandsschutz.fingerabdruck(root, List.of());

        // ---- Der Monat wächst: die vorläufige Version zieht mit (Nachzug) ----------------------------------------
        monatV2VorDemWachsen = periodeVersion("F10", "monat", NOVEMBER);
        saeen(KB, "F10", minutenwerte(Instant.parse("2026-11-19T23:00:00Z"), Instant.parse("2026-11-20T23:00:00Z"),
                "440000.0", "1.600"));
        verdichtungstakt(T_WACHSEN);
        tage.rueckrechnenGanz(T_WACHSEN_TAKT, 200);
        laeufer.takt(T_WACHSEN_TAKT);
        monatV1NachDemWachsen = periode("F10", "monat", NOVEMBER);
        wachsen = kaskade.lauf(T_WACHSEN_KASKADE);
        monatV2NachDemWachsen = periodeVersion("F10", "monat", NOVEMBER);
        monatVersionenNachDemWachsen = zahl("SELECT count(*) FROM messreihe_periode_version WHERE entity_id = ? "
                + "AND ebene = 'monat'", IDS.get("F10"));

        laeufer.takt(T_NOVEMBER_ENDGUELTIG);
        endgueltig = kaskade.lauf(T_NOVEMBER_KASKADE);
        monatV2Endgueltig = periodeVersion("F10", "monat", NOVEMBER);
        try {
            root.update("UPDATE messreihe_periode_version SET menge = menge + 1 WHERE entity_id = ? AND ebene = 'monat' "
                    + "AND version = 2", IDS.get("F10"));
        } catch (RuntimeException e) {
            endgueltigeVersionUnveraenderlich = true;
        }

        // ---- F12: der Endstand der Rücksetzung wird nach der Frist nachgetragen ---------------------------------
        verdichtungstakt(T_F12_V1);
        tage.rueckrechnenGanz(T_F12_V1_TAKT, 200);
        laeufer.takt(T_F12_V1_TAKT);
        laeufer.takt(T_F12_ENDGUELTIG);
        ablesestaendeNachtragen();
        laeufer.takt(T_F12_TAKT);
        f12 = vorschlag(KB, "F12").kennung();
        f12TagV1 = tag("F12", LocalDate.of(2027, 1, 15));
        f12MonatV1 = periode("F12", "monat", LocalDate.of(2027, 1, 1));
        als(KB, () -> korrekturen.freigeben(KB, f12, null, JONAS));
        f12Lauf = kaskade.lauf(T_F12_KASKADE);

        // ---- Die Gegenrichtung: K-2026-0001 wird zurückgenommen -----------------------------------------------
        als(KB, () -> korrekturen.zuruecknehmen(KB, f10, "Die Box hat den Puffer doppelt geschickt.", JONAS));
        widerruf = kaskade.lauf(T_WIDERRUF_KASKADE);
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ============================================================================ Bestandsschutz

    /** Die Migration ändert keine bestehende Zeile und legt nur leere Tabellen an. */
    @Test
    void dieMigrationLaesstDenBestandUnberuehrt() {
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
    }

    /**
     * <b>Version 1 bleibt.</b> Die Kaskade schreibt Versionen, Wirkung, Eingänge ihrer Versionen und ihre Meldung — und
     * sonst NICHTS: jede Viertelstunde, jeder Tag, Monat, jedes Jahr der Verdichtung und jede berechnete Zeile trägt
     * nach der Kaskade Zeichen für Zeichen denselben Inhalt.
     */
    @Test
    void dieKaskadeRuehrtVersionEinsNieAn() {
        assertThat(nachDerKaskade).isEqualTo(vorDerKaskade);
        assertThat(eingaengeV1Nachher).as("die Eingänge von Version 1").isEqualTo(eingaengeV1Vorher);
        assertThat(meldungenNachher).as("die Kaskade meldet nur correction").isEqualTo(meldungenVorher);
        assertThat(lauf.versionen()).isPositive();
    }

    // ============================================================================ F10: bis zum Jahr

    /** F10 — die Viertelstunde: 15 Versionen zu je 24,0 kWh, vollständig, 15 von 15, „korrigiert (Version 2)“. */
    @Test
    void f10DieFuenfzehnViertelstundenTragenVersionZwei() throws Exception {
        List<Map<String, Object>> v = viertelVersionen(KB, "F10", 2);
        assertThat(v).hasSize(15);
        JsonNode soll = erwartung("f10-", "Viertelstunde 14:00–14:15 (Version 2)");
        for (Map<String, Object> z : v) {
            assertThat((BigDecimal) z.get("menge")).isEqualByComparingTo(soll.path("menge").decimalValue());
            assertThat(z.get("menge_zustand")).isEqualTo(soll.path("zustand").asText());
            assertThat(n(z.get("erhalten"))).isEqualTo(soll.path("erhalten").asInt());
            assertThat(saetze(z.get("kennzeichen"))).containsExactly("korrigiert (Version 2)");
            assertThat(z.get("anlass_kennung")).isEqualTo(f10);
            assertThat(array(z.get("korrekturen"))).containsExactly(f10);
            assertThat(z.get("stand_anfang")).as("die Rohwert-Fakten reisen mit").isNotNull();
        }
    }

    /**
     * F10 — Tag, Monat, Jahr: jede gröbere Stufe hat Version 2 mit dem Kennzeichen, der Tag 2 304 kWh vollständig mit
     * 1 440 von 1 440 (Vertrag), der Monat und das Jahr „Menge unverändert“, aber mit den 210 nachgelieferten Werten im
     * Verlauf — und Version 1 steht daneben unverändert.
     */
    @Test
    void f10TagMonatUndJahrBekommenVersionZwei() throws Exception {
        JsonNode soll = erwartung("f10-", "Tag 03.11.2026 (Version 2)");
        Map<String, Object> tagV2 = versionAus(versionenNachKaskade, "F10", "tag", TAG, 2);
        assertThat((BigDecimal) tagV2.get("menge")).isEqualByComparingTo(soll.path("menge").decimalValue());
        assertThat(tagV2.get("menge_zustand")).isEqualTo(soll.path("zustand").asText());
        assertThat(n(tagV2.get("erhalten"))).isEqualTo(soll.path("erhalten").asInt());
        assertThat(n(tagV2.get("erwartet"))).isEqualTo(soll.path("erwartet").asInt());
        assertThat(saetze(tagV2.get("kennzeichen"))).containsExactly("korrigiert (Version 2)");
        assertThat(n(tagV2.get("erhalten"))).isGreaterThan(n(tagV1.get("erhalten")));
        assertThat(tagV2.get("anlass_kennung")).isEqualTo(f10);
        assertThat(tagV2.get("zustand")).isEqualTo("endgueltig");

        Map<String, Object> monatV2 = versionAus(versionenNachKaskade, "F10", "monat", NOVEMBER, 2);
        assertThat((BigDecimal) monatV2.get("menge")).as("Menge unverändert")
                .isEqualByComparingTo((BigDecimal) monatV1.get("menge"));
        assertThat(n(monatV2.get("erhalten")) - n(monatV1.get("erhalten"))).isEqualTo(210);
        assertThat(saetze(monatV2.get("kennzeichen"))).last().isEqualTo("korrigiert (Version 2)");

        Map<String, Object> jahrV2 = versionAus(versionenNachKaskade, "F10", "jahr", JAHR, 2);
        assertThat((BigDecimal) jahrV2.get("menge")).isEqualByComparingTo((BigDecimal) jahrV1.get("menge"));
        assertThat(n(jahrV2.get("erhalten")) - n(jahrV1.get("erhalten"))).isEqualTo(210);
        assertThat(saetze(jahrV2.get("kennzeichen"))).last().isEqualTo("korrigiert (Version 2)");
        assertThat(ErgebnisZustand.pruefe(new ErgebnisZustand.Ergebnis((BigDecimal) tagV2.get("menge"), "kWh", "tag",
                (String) tagV2.get("menge_zustand"), BigDecimal.valueOf(n(tagV2.get("abdeckung_prozent"))),
                saetze(tagV2.get("kennzeichen"))))).as("jeder gespeicherte Satz ist ein Satz des Vertrags").isEmpty();
    }

    /**
     * F10 — die berechneten Messstellen (AP-10): MS-15 liest MS-10, MS-19 liest MS-15 — beide bekommen am 03.11. ihre
     * Version 2, in der Ordnung ihrer Eingänge, und nennen ihre Eingänge in DEREN Version.
     */
    @Test
    void f10DieBerechnetenMessstellenFolgenInIhrerOrdnung() {
        Map<String, Object> ms15 = berechneteVersion(versionenNachKaskade, "MS-15", "tag", TAG);
        Map<String, Object> ms19 = berechneteVersion(versionenNachKaskade, "MS-19", "tag", TAG);
        assertThat(n(ms15.get("version"))).isEqualTo(2);
        assertThat(n(ms19.get("version"))).isEqualTo(2);
        assertThat(saetze(ms15.get("kennzeichen"))).last().isEqualTo("korrigiert (Version 2)");
        assertThat(saetze(ms19.get("kennzeichen"))).last().isEqualTo("korrigiert (Version 2)");
        assertThat(array(ms15.get("korrekturen"))).containsExactly(f10);
        assertThat(zahl("SELECT eingang_version FROM bilanzwert_eingang WHERE messstelle_id = ? AND periode = 'tag' "
                + "AND version = 2", IDS.get("MS-15"))).as("MS-15 Version 2 liest MS-10 in Version 2").isEqualTo(2);
        assertThat(zahl("SELECT eingang_version FROM bilanzwert_eingang WHERE messstelle_id = ? AND periode = 'tag' "
                + "AND version = 2", IDS.get("MS-19"))).as("MS-19 liest MS-15 in Version 2").isEqualTo(2);
        assertThat(ms15TagV1.get("menge")).as("Version 1 bleibt").isNotNull();
        assertThat(zahl("SELECT count(*) FROM messreihe_periode_version WHERE messstelle_id = ? AND ebene = 'viertelstunde' "
                + "AND version = 2", IDS.get("MS-15"))).as("auch die berechneten Viertelstunden").isEqualTo(15);
        // Der Monat folgt (die Abdeckung des Eingangs wächst um die nachgelieferten Werte); das Jahr sagt bei MS-15 und
        // MS-19 vorher wie nachher „keine Werte“ mit derselben Abdeckung — eine gleiche Zahl bekommt keine neue Version.
        assertThat(zahl("SELECT count(*) FROM messreihe_periode_version WHERE messstelle_id = ? AND ebene = 'monat'",
                IDS.get("MS-19"))).as("MS-19 Monat").isPositive();
    }

    /**
     * AP-10 IP-11 — der Anschluss an DIESE Kaskade, keine zweite: in derselben Transaktion meldet sie
     * {@code bilanz_neu_berechnet} für jede Messstelle, deren Bilanz-Werte sich geändert haben — die berechneten MS-15 und
     * MS-19 (neue Versionen) und die gemessene MS-10, weil sie auf 4300 verteilt ist. Urheber cloud, Auslöser die
     * Korrektur, [von, bis) = der Tag in der Zeitzone des Kundenbereichs; KR-1/KR-2 (Kreis) melden nichts.
     */
    @Test
    void dieKaskadeMeldetBilanzNeuBerechnetJeBetroffenerMessstelle() {
        assertThat(bilanzMeldungen).extracting(m -> m.get("messstelle")).containsExactly("MS-10", "MS-15", "MS-19");
        assertThat(bilanzMeldungen.get(1).get("messstelle_id")).isEqualTo(IDS.get("MS-15"));
        for (Map<String, Object> m : bilanzMeldungen) {
            assertThat(m.get("ausloeser")).isEqualTo(f10);
            assertThat(m.get("urheber")).isEqualTo("cloud");
            assertThat(((Timestamp) m.get("von")).toInstant()).isEqualTo(Instant.parse("2026-11-02T23:00:00Z"));
            assertThat(((Timestamp) m.get("bis")).toInstant()).isEqualTo(Instant.parse("2026-11-03T23:00:00Z"));
            assertThat(m.get("messstelle_id")).as("die Messstelle ist aufgelöst").isNotNull();
        }
        assertThat(zahl("SELECT count(*) FROM messreihe_ereignis WHERE art = 'bilanz_neu_berechnet' AND tenant_id = ? "
                + "AND nutzlast ->> 'ausloeser' = ?", FREMD, f10Fremd)).as("der fremde Kundenbereich meldet SEINE")
                .isOne();
    }

    /**
     * AP-10 IP-11 — nach der Kaskade liest die Kostenstellen-Sicht Version 2: 4300 bekommt MS-10 als gemessenen Wert mit
     * „korrigiert (Version 2)“, 4200 den Baustein MS-15 als berechneten; mit {@code version=1} steht Version 1 daneben,
     * ohne „korrigiert“ — die damalige Zahl bleibt lesbar.
     */
    @Test
    void dieKostenstellenSichtLiestNachDerKaskadeVersionZweiUndVersionEinsBleibtLesbar() {
        KostenstelleEnergieDto.Posten ms10 = logistikNeu.gemessen().posten().get(0);
        assertThat(ms10.messstelle().kennzeichen()).isEqualTo("MS-10");
        assertThat(ms10.version()).isEqualTo(2);
        assertThat(ms10.kennzeichen()).last().isEqualTo("korrigiert (Version 2)");
        assertThat(ms10.menge()).isEqualByComparingTo(((BigDecimal) versionAus(versionenNachKaskade, "F10", "tag", TAG, 2)
                .get("menge")));
        assertThat(String.valueOf(ms10.herkunft().get("fehlt"))).isEqualTo("[]");
        KostenstelleEnergieDto.Posten ms10v1 = logistikVersionEins.gemessen().posten().get(0);
        assertThat(ms10v1.version()).isEqualTo(1);
        assertThat(ms10v1.kennzeichen()).noneMatch(ErgebnisZustand::istKorrigiert);
        assertThat(ms10v1.menge()).isEqualByComparingTo((BigDecimal) tagV1.get("menge"));
        KostenstelleEnergieDto.Posten ms15 = montageNeu.berechnet().posten().get(0);
        assertThat(ms15.messstelle().kennzeichen()).isEqualTo("MS-15");
        assertThat(ms15.version()).isEqualTo(2);
        assertThat(ms15.kennzeichen()).last().isEqualTo("korrigiert (Version 2)");
    }

    /** Ein Kreis endet: KR-1 ↔ KR-2 wird in der Kaskade benannt abgelehnt — dieselbe Ordnung wie im Lauf. */
    @Test
    void einKreisWirdInDerKaskadeBenanntAbgelehnt() {
        Map<String, BerechnetePeriode.Abgelehnt> k = new LinkedHashMap<>();
        lauf.kreise().forEach(a -> k.put(a.messstelle(), a));
        assertThat(k).containsKeys("KR-1", "KR-2");
        assertThat(k.get("KR-1").grund()).isEqualTo(BerechnetePeriode.FORMEL_KREIS);
        assertThat(zahl("SELECT count(*) FROM messreihe_periode_version WHERE messstelle_id IN (?, ?)", IDS.get("KR-1"),
                IDS.get("KR-2"))).isZero();
    }

    // ============================================================================ Die Grenze: Berichte

    /**
     * <b>Die Grenze von E9 als Test:</b> der freigegebene Bericht bleibt Zeichen für Zeichen, wie er war, und bekommt den
     * Revisions-Auslöser (die Meldung {@code correction} dieser Freigabe); der Entwurf bildet sich aus der neuen Version
     * neu.
     */
    @Test
    void einFreigegebenerBerichtBleibtUnveraendertUndBekommtNurDenAusloeserEinEntwurfAktualisiertSich() {
        Berichte.Eintrag freigegeben = berichte.eintrag("BR-2026-W45");
        assertThat(freigegeben.inhalt()).isEqualTo(freigegeben.urspruenglich());
        assertThat(freigegeben.neuGebildet()).isZero();
        UUID meldung = root.queryForObject("SELECT ereignis_id FROM messreihe_ereignis WHERE tenant_id = ? "
                + "AND art = 'correction' AND nutzlast ->> 'korrektur' = ? AND nutzlast ->> 'status' = 'freigegeben'",
                UUID.class, KB, f10);
        UUID ruecknahme = root.queryForObject("SELECT ereignis_id FROM messreihe_ereignis WHERE tenant_id = ? "
                + "AND art = 'correction' AND nutzlast ->> 'korrektur' = ? AND nutzlast ->> 'status' = 'zurueckgenommen'",
                UUID.class, KB, f10);
        assertThat(freigegeben.ausloeser()).as("Freigabe UND Rücknahme lösen die Revision aus").contains(meldung, ruecknahme);

        Berichte.Eintrag entwurf = berichte.eintrag("BR-2026-11-ENTWURF");
        assertThat(entwurfNachDerFreigabe).isNotEqualTo(entwurf.urspruenglich()).endsWith("Version 2");
        assertThat(entwurf.inhalt()).as("nach der Rücknahme").endsWith("Version 3");
        assertThat(entwurf.neuGebildet()).isGreaterThanOrEqualTo(2);
        assertThat(entwurf.ausloeser()).isEmpty();
    }

    /** Die Meldung: Urheber Kunde, Status freigegeben, eine je Reihe — und das Vokabular nimmt sie an. */
    @Test
    void dieFreigabeWirdAlsCorrectionGemeldet() {
        Map<String, Object> m = root.queryForMap("SELECT urheber, entity_id, messkanal, nutzlast::text AS nutzlast "
                + "FROM messreihe_ereignis WHERE tenant_id = ? AND art = 'correction' AND nutzlast ->> 'korrektur' = ? "
                + "AND nutzlast ->> 'status' = 'freigegeben'", KB, f10);
        assertThat(m.get("urheber")).isEqualTo("kunde");
        assertThat(m.get("entity_id")).isEqualTo(IDS.get("F10"));
        assertThat((String) m.get("nutzlast")).contains("nachlieferung_nach_endgueltigkeit");
    }

    // ============================================================================ Wiederholbar, abbruchsicher

    /** Ein Abbruch hinter allen Stufen (die Kennzahlen-Naht) lässt keine Version, keine Wirkung, keine Meldung zurück. */
    @Test
    void einAbbruchLaesstNichtsHalbesZurueck() {
        assertThat(abbruchWarf).isTrue();
        assertThat(nachAbbruch).as("Zeichen für Zeichen der Stand vor dem Abbruch").isEqualTo(vorDemAbbruch);
        assertThat(nachAbbruch.get("messreihe_viertelstunde_version")).isEqualTo(Bestandsschutz.LEER);
        assertThat(nachAbbruch.get("messreihe_periode_version")).isEqualTo(Bestandsschutz.LEER);
        assertThat(nachAbbruch.get("messreihe_kaskade_wirkung")).isEqualTo(Bestandsschutz.LEER);
    }

    /** Dieselbe Freigabe zweimal: der zweite Lauf findet nichts und schreibt nichts. */
    @Test
    void zweimalVerarbeitetSchreibtBeimZweitenMalNichts() {
        assertThat(lauf.anlaesse()).isEqualTo(2);
        assertThat(nochmal.anlaesse()).isZero();
        assertThat(nochmal.versionen()).isZero();
        assertThat(nachNochmal).as("der zweite Lauf schreibt nichts").isEqualTo(nachErstemLauf);
        assertThat(zahl("SELECT count(*) FROM messreihe_kaskade_wirkung WHERE tenant_id = ? AND anlass_kennung = ? "
                + "AND ergebnis = 'gebildet'", KB, f10)).isEqualTo(1);
    }

    // ============================================================================ Nachzug

    /**
     * Ein laufender Monat bekommt nach der Korrektur seine Version — und wächst danach weiter wie Version 1: dieselbe
     * Nummer, die Werte vom 20.11. darin, die nachgelieferten 210 weiter dazu. Wird er endgültig, bleibt die Version
     * stehen: keine Rolle kann sie mehr ändern.
     */
    @Test
    void eineVorlaeufigeVersionZiehtMitIhrerGrundlageNachBisSieEndgueltigIst() {
        assertThat(monatV2VorDemWachsen.get("zustand")).isEqualTo("vorlaeufig");
        assertThat(wachsen.nachgezogen()).isPositive();
        assertThat(n(monatV2NachDemWachsen.get("version"))).isEqualTo(2);
        assertThat(n(monatV2NachDemWachsen.get("erhalten"))).isGreaterThan(n(monatV2VorDemWachsen.get("erhalten")));
        assertThat(n(monatV2NachDemWachsen.get("erhalten")) - n(monatV1NachDemWachsen.get("erhalten"))).isEqualTo(210);
        assertThat(monatVersionenNachDemWachsen).as("keine neue Nummer beim Wachsen").isEqualTo(1);

        assertThat(monatV2Endgueltig.get("zustand")).isEqualTo("endgueltig");
        assertThat(n(monatV2Endgueltig.get("version"))).isEqualTo(2);
        assertThat(endgueltigeVersionUnveraenderlich).isTrue();
    }

    // ============================================================================ F12

    /**
     * F12 — der nachgetragene Endstand: die Viertelstunde 14,81 kWh vollständig mit „Gerätegrenze 09:12 mit
     * Ableseständen“ (Vertrag), der Tag und der Januar je +0,53 kWh gegenüber Version 1 — alle Version 2.
     */
    @Test
    void f12DerEndstandZiehtAlsVersionZweiBisZumJahrDurch() throws Exception {
        assertThat(f12Lauf.abgelehnt()).isEmpty();
        JsonNode soll = erwartung("f12-", "Viertelstunde 09:00–09:15 (Version 2)");
        Map<String, Object> q = root.queryForMap("SELECT * FROM messreihe_viertelstunde_version WHERE entity_id = ? "
                + "AND intervall_beginn = ?", IDS.get("F12"), ts(F12_VIERTELSTUNDE));
        assertThat((BigDecimal) q.get("menge")).isEqualByComparingTo(soll.path("menge").decimalValue());
        assertThat(q.get("menge_zustand")).isEqualTo(soll.path("zustand").asText());
        List<String> kz = new ArrayList<>();
        soll.path("kennzeichen").forEach(k -> kz.add(k.asText()));
        kz.add("korrigiert (Version 2)");
        assertThat(saetze(q.get("kennzeichen"))).containsExactlyElementsOf(kz);

        Map<String, Object> tagV2 = periodeVersion("F12", "tag", LocalDate.of(2027, 1, 15));
        assertThat(((BigDecimal) tagV2.get("menge")).subtract((BigDecimal) f12TagV1.get("menge")))
                .isEqualByComparingTo("0.53");
        Map<String, Object> monatV2 = periodeVersion("F12", "monat", LocalDate.of(2027, 1, 1));
        assertThat(((BigDecimal) monatV2.get("menge")).subtract((BigDecimal) f12MonatV1.get("menge")))
                .isEqualByComparingTo("0.53");
        assertThat(n(periodeVersion("F12", "jahr", LocalDate.of(2027, 1, 1)).get("version"))).isEqualTo(2);
    }

    // ============================================================================ Widerruf (F21 für eine Korrektur)

    /**
     * Die Gegenrichtung: nach der Rücknahme trägt jede Viertelstunde den Stand von Version 1 als Version 3, und JEDE Stufe
     * darüber passt wieder zu ihr — Tag, Monat, Jahr und die berechneten Messstellen sagen dieselbe Zahl wie Version 1,
     * und keine Stufe nennt die zurückgenommene Korrektur noch als wirksam.
     */
    @Test
    void nachDerRuecknahmePasstJedeStufeWiederZuVersionEins() {
        assertThat(widerruf.abgelehnt()).isEmpty();
        List<Map<String, Object>> v3 = viertelVersionen(KB, "F10", 3);
        assertThat(v3).hasSize(15);
        Map<Instant, Map<String, Object>> v1 = new LinkedHashMap<>();
        root.queryForList("SELECT * FROM messreihe_viertelstunde WHERE entity_id = ? AND intervall_beginn >= ? "
                + "AND intervall_beginn <= ?", IDS.get("F10"), ts(VON), ts(BIS))
                .forEach(z -> v1.put(((Timestamp) z.get("intervall_beginn")).toInstant(), z));
        for (Map<String, Object> z : v3) {
            Map<String, Object> alt = v1.get(((Timestamp) z.get("intervall_beginn")).toInstant());
            if (alt == null) {
                assertThat(z.get("menge_zustand")).isEqualTo("keine Werte");
                assertThat(z.get("menge")).isNull();
                assertThat(saetze(z.get("kennzeichen"))).containsExactly("korrigiert (Version 3)");
            } else {
                assertThat(z.get("menge_zustand")).isEqualTo(alt.get("menge_zustand"));
                assertThat(saetze(z.get("kennzeichen")).subList(0, saetze(z.get("kennzeichen")).size() - 1))
                        .isEqualTo(saetze(alt.get("kennzeichen")));
            }
            assertThat(array(z.get("korrekturen"))).isEmpty();
        }

        Map<String, Object> tagV3 = periodeVersion("F10", "tag", TAG);
        assertThat(n(tagV3.get("version"))).isEqualTo(3);
        assertThat((BigDecimal) tagV3.get("menge")).isEqualByComparingTo((BigDecimal) tagV1.get("menge"));
        assertThat(n(tagV3.get("erhalten"))).isEqualTo(n(tagV1.get("erhalten")));
        assertThat(saetze(tagV3.get("kennzeichen"))).containsExactlyElementsOf(mitVersion(tagV1, 3));
        Map<String, Object> monatV3 = periodeVersion("F10", "monat", NOVEMBER);
        Map<String, Object> monatV1Jetzt = periode("F10", "monat", NOVEMBER);
        assertThat((BigDecimal) monatV3.get("menge")).isEqualByComparingTo((BigDecimal) monatV1Jetzt.get("menge"));
        assertThat(n(monatV3.get("erhalten"))).isEqualTo(n(monatV1Jetzt.get("erhalten")));
        Map<String, Object> ms15 = berechneteVersionJetzt("MS-15", "tag", TAG);
        assertThat(n(ms15.get("version"))).isEqualTo(3);
        assertThat((BigDecimal) ms15.get("menge")).isEqualByComparingTo((BigDecimal) ms15TagV1.get("menge"));

        // Keine Stufe trägt eine Version, die es nicht mehr gibt: die neueste Version jeder Stufe nennt K-2026-0001 nicht.
        assertThat(zahl("""
                SELECT count(*) FROM (SELECT DISTINCT ON (ebene, entity_id, messkanal, messstelle_id, periode_beginn) *
                                        FROM messreihe_periode_version WHERE tenant_id = ?
                                       ORDER BY ebene, entity_id, messkanal, messstelle_id, periode_beginn, version DESC) v
                 WHERE ? = ANY (v.korrekturen)
                """, KB, f10)).isZero();
        // … und jede berechnete Version liest ihre Eingänge in deren NEUESTER Version.
        assertThat(zahl("SELECT eingang_version FROM bilanzwert_eingang WHERE messstelle_id = ? AND periode = 'tag' "
                + "AND version = 3", IDS.get("MS-15"))).isEqualTo(3);
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE art = 'correction' "
                + "AND nutzlast ->> 'korrektur' = ? AND nutzlast ->> 'status' = 'zurueckgenommen'", Integer.class, f10))
                .isEqualTo(1);
    }

    // ============================================================================ Mandantenzaun

    /**
     * Der fremde Kundenbereich hat dieselbe Nachlieferung: seine Versionen tragen nur SEINE Reihe und SEINE Messstellen,
     * und die App-Rolle sieht hinter RLS nur die eigenen Versionen.
     */
    @Test
    void derMandantenzaunHaelt() {
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde_version WHERE tenant_id = ? AND entity_id <> ?",
                FREMD, IDS.get("ZF"))).isZero();
        assertThat(zahl("SELECT count(*) FROM messreihe_periode_version WHERE tenant_id = ? AND entity_id IS NOT NULL "
                + "AND entity_id <> ?", FREMD, IDS.get("ZF"))).isZero();
        assertThat(zahl("SELECT count(*) FROM messreihe_periode_version WHERE tenant_id = ? AND messstelle_id = ?",
                FREMD, IDS.get("MS-15:" + FREMD))).isPositive();
        assertThat(zahl("SELECT count(*) FROM messreihe_periode_version WHERE tenant_id = ? AND messstelle_id = ?",
                KB, IDS.get("MS-15:" + FREMD))).isZero();
        int eigene = zahl("SELECT count(*) FROM messreihe_periode_version WHERE tenant_id = ?", KB);
        assertThat(als(KB, () -> app.queryForObject("SELECT count(*) FROM messreihe_periode_version", Integer.class)))
                .isEqualTo(eigene);
        assertThat(als(KB, () -> app.queryForObject("SELECT count(*) FROM messreihe_kaskade_wirkung WHERE tenant_id = ?",
                Integer.class, FREMD))).isZero();
    }

    /** Die App liest nur — Versionen bildet der Lauf. */
    @Test
    void dieAppRolleDarfKeineVersionSchreiben() {
        PSQLException p = psql(() -> als(KB, () -> app.update("INSERT INTO messreihe_kaskade_wirkung (tenant_id, "
                + "anlass_kennung, fassung, ergebnis, versionen, berechnet_am) VALUES (?, 'K-2026-9999', 1, 'gebildet', 0, "
                + "now())", KB)));
        assertThat(p.getSQLState()).isEqualTo("42501");
        assertThat(root.queryForList("SELECT unnest(messreihe_kaskade_woerter())", String.class))
                .containsExactlyElementsOf(KorrekturKaskade.WOERTER);
    }

    // =========================================================================== Hilfen: Berichte (der Stub)

    /** Ein Stub der Berichte (AP-12): Entwürfe und freigegebene, mit Inhalt, Neubildungen und Auslösern. */
    static final class Berichte implements BerichteNaht {

        static final class Eintrag {
            final String kennung;
            final Stand stand;
            final String urspruenglich;
            String inhalt;
            int neuGebildet;
            final List<UUID> ausloeser = new ArrayList<>();

            Eintrag(String kennung, Stand stand, String inhalt) {
                this.kennung = kennung;
                this.stand = stand;
                this.urspruenglich = inhalt;
                this.inhalt = inhalt;
            }

            String inhalt() {
                return inhalt;
            }

            String urspruenglich() {
                return urspruenglich;
            }

            int neuGebildet() {
                return neuGebildet;
            }

            List<UUID> ausloeser() {
                return ausloeser;
            }
        }

        private final Map<String, Eintrag> eintraege = new LinkedHashMap<>();

        void anlegen(String kennung, Stand stand, String inhalt) {
            eintraege.put(kennung, new Eintrag(kennung, stand, inhalt));
        }

        Eintrag eintrag(String kennung) {
            return eintraege.get(kennung);
        }

        @Override
        public List<Bericht> betroffene(Connection con, KorrekturKaskade.Betroffen b) {
            return b.tenant().equals(KB)
                    ? eintraege.values().stream().map(e -> new Bericht(e.kennung, e.stand)).toList()
                    : List.of();
        }

        @Override
        public void entwurfNeuBilden(Connection con, Bericht bericht, KorrekturKaskade.Betroffen b) throws SQLException {
            Eintrag e = eintraege.get(bericht.kennung());
            if (e.stand != Stand.ENTWURF) {
                throw new AssertionError("ein freigegebener Bericht wurde neu gebildet: " + e.kennung);
            }
            try (PreparedStatement ps = con.prepareStatement("SELECT menge, version FROM messreihe_periode_version "
                    + "WHERE entity_id = ? AND ebene = 'monat' ORDER BY version DESC LIMIT 1")) {
                ps.setObject(1, IDS.get("F10"));
                try (ResultSet rs = ps.executeQuery()) {
                    e.inhalt = rs.next() ? "November (Entwurf): " + rs.getBigDecimal(1).toPlainString() + " kWh, Version "
                            + rs.getInt(2) : e.inhalt;
                }
            }
            e.neuGebildet++;
        }

        @Override
        public void revisionAusloesen(Connection con, Bericht bericht, KorrekturKaskade.Betroffen b) {
            eintraege.get(bericht.kennung()).ausloeser.addAll(b.ereignisse());
        }
    }

    // =========================================================================== Hilfen: Welt

    private static BerechnetePeriodenLauf berechnete(MeasurementCatalog katalog) {
        MessstelleRepository ms = new MessstelleRepository(app);
        MessstelleQuelleRepository quellen = new MessstelleQuelleRepository(app);
        SpeicherklasseHistorie historie = new SpeicherklasseHistorie(app, katalog);
        BerechnetePeriodenRepository speicher = new BerechnetePeriodenRepository(app);
        werte = new MessstelleWerteService(app, ms, quellen, new QuelleKadenzRepository(app),
                new MesskanalService(app, new SiteRepository(app), katalog, JSON, new GeraetRepository(app), quellen),
                historie, speicher);
        return new BerechnetePeriodenLauf(admin, app, ms, new BilanzRestRepository(app),
                new MessstelleFormelTermRepository(app), new BilanzStellungen(ms, new MessstelleZuordnungRepository(app)),
                werte, historie, speicher);
    }

    private static void stammdaten() {
        for (UUID t : new UUID[] {KB, FREMD}) {
            root.update("INSERT INTO tenant (id, name) VALUES (?, ?)", t,
                    t.equals(KB) ? "Kunststoffwerk Ahrenberg GmbH" : "Kundenbereich B");
            UUID u = uuid("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') RETURNING id",
                    t, "U " + t);
            UUID st = uuid("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                    + "VALUES (?, ?, ?, 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", t, u, "Werk " + t);
            UUID an = uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-2') RETURNING id", t);
            root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                    + "VALUES (?, ?, ?, DATE '2024-01-01')", t, an, st);
            IDS.put("AN:" + t, an);
            IDS.put("U:" + t, u);
        }
        reihe(KB, "F10");
        reihe(KB, "F12");
        reihe(FREMD, "ZF");
    }

    /** Eine Komponente mit eigener Box und dem kWh-Zählerkanal, Kadenz 60 s. */
    private static void reihe(UUID tenant, String name) {
        UUID an = IDS.get("AN:" + tenant);
        UUID box = uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, 'claimed') "
                + "RETURNING id", tenant, an, "VP-BOX-KK-" + name);
        UUID entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, "
                + "communication, connection_json, created_at) VALUES (?, ?, 'grid-meter', ?, 'grid-meter', ?, "
                + "'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, '2024-03-12T00:00:00Z') RETURNING id",
                tenant, an, name, box);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, "
                + "'2024-03-12T00:00:00Z', '2026.09.11.1', 'test', 'pending_edge', 'live_power', 'fifteen_minute')",
                tenant, an, box, entity, KANAL);
        IDS.put(name, entity);
        IDS.put("BOX:" + name, box);
    }

    /**
     * Die Messstellen: MS-10 (gemessen, führend F10), MS-15 = MS-10, MS-19 = MS-15, der Kreis KR-1 ↔ KR-2; im fremden
     * Kundenbereich MS-10 an ZF und MS-15 = MS-10.
     */
    private static void messstellen() {
        UUID ms10 = gemessen(KB, "MS-10", "F10");
        UUID ms15 = summe(KB, "MS-15", List.of(ms10));
        IDS.put("MS-15", ms15);
        IDS.put("MS-19", summe(KB, "MS-19", List.of(ms15)));
        UUID kr1 = summe(KB, "KR-1", List.of(ms10));
        UUID kr2 = summe(KB, "KR-2", List.of(kr1));
        // Am Schreibweg vorbei (der lehnt einen Kreis schon beim Anlegen ab): KR-1 liest zusätzlich KR-2.
        root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, fassung_id, position, eingang_art, "
                + "quell_messstelle_id, vorzeichen, faktor) VALUES (?, ?, (SELECT id FROM messstelle_formel_fassung WHERE "
                + "messstelle_id = ?), 1, 'messstelle', ?, '+', 1)", KB, kr1, kr1, kr2);
        IDS.put("KR-1", kr1);
        IDS.put("KR-2", kr2);
        // AP-10 IP-11: MS-10 geht zu 100 % an 4300 (gemessen), der Summen-Baustein MS-15 an 4200 (berechnet).
        IDS.put("4300", kostenstelle(KB, "4300", "Logistik"));
        IDS.put("4200", kostenstelle(KB, "4200", "Montage"));
        verteilung(KB, ms10, IDS.get("4300"));
        verteilung(KB, ms15, IDS.get("4200"));
        UUID fremd10 = gemessen(FREMD, "MS-10", "ZF");
        IDS.put("MS-15:" + FREMD, summe(FREMD, "MS-15", List.of(fremd10)));
    }

    private static UUID gemessen(UUID tenant, String kennzeichen, String reihe) {
        UUID ms = uuid("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, einheit, "
                + "wertart) VALUES (?, ?, 'Halle 2', 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') "
                + "RETURNING id", tenant, kennzeichen);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, IDS.get(reihe));
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_sub, actor_name, "
                + "actor_art) VALUES (?, ?, 'Wirkenergie', 'Bezug', ?, ?, ?, 'counter', 'zaehlerstand', 'fuehrend', "
                + "'2024-03-12T00:00:00Z', true, now(), 'sub', 'Probe', 'kunde')", tenant, ms, IDS.get(reihe), geraet, KANAL);
        return ms;
    }

    private static UUID kostenstelle(UUID tenant, String kennzeichen, String name) {
        return uuid("INSERT INTO kostenstelle (tenant_id, unternehmen_id, kennzeichen, name, gueltig_ab) VALUES (?, ?, ?, "
                + "?, DATE '2026-10-01') RETURNING id", tenant, IDS.get("U:" + tenant), kennzeichen, name);
    }

    private static void verteilung(UUID tenant, UUID messstelle, UUID kostenstelle) {
        root.update("INSERT INTO messstelle_verteilung (tenant_id, messstelle_id, kostenstelle_id, anteil_prozent, "
                + "gueltig_ab, created_by) VALUES (?, ?, ?, 100, DATE '2026-10-01', 'test')", tenant, messstelle,
                kostenstelle);
    }

    private static UUID summe(UUID tenant, String kennzeichen, List<UUID> bausteine) {
        UUID ms = uuid("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, einheit, "
                + "wertart) VALUES (?, ?, ?, 'berechnet', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', 'Intervallmenge') "
                + "RETURNING id", tenant, kennzeichen, kennzeichen + " berechnet");
        UUID fassung = uuid("INSERT INTO messstelle_formel_fassung (tenant_id, messstelle_id, nummer, formel_typ, herkunft, "
                + "actor_sub, actor_name, actor_art) VALUES (?, ?, 1, 'gewichtete_summe', 'anlage', 'sub-test', 'Test', "
                + "'kunde') RETURNING id", tenant, ms);
        int position = 0;
        for (UUID b : bausteine) {
            root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, fassung_id, position, eingang_art, "
                    + "quell_messstelle_id, vorzeichen, faktor) VALUES (?, ?, ?, ?, 'messstelle', ?, '+', 1)", tenant, ms,
                    fassung, position++, b);
        }
        return ms;
    }

    /** Ein Wert je Minute: Zeit, Stand, Eingang. */
    private record Roh(Instant zeit, BigDecimal wert, Instant eingang) {}

    private static List<Roh> abschnitte(String fall, boolean spaet) throws Exception {
        List<Roh> aus = new ArrayList<>();
        JsonNode c = fall(fall);
        for (JsonNode a : c.path("input").path("reihe").path("rohwerte")) {
            if (a.has("eingang") != spaet) {
                continue;
            }
            Instant eingang = spaet ? OffsetDateTime.parse(a.path("eingang").asText()).toInstant() : null;
            BigDecimal wert = new BigDecimal(a.path("stand_von").asText());
            BigDecimal zuwachs = new BigDecimal(a.path("zuwachs_je_kadenz").asText());
            Instant bis = OffsetDateTime.parse(a.path("bis").asText()).toInstant();
            for (Instant t = OffsetDateTime.parse(a.path("von").asText()).toInstant(); !t.isAfter(bis);
                    t = t.plusSeconds(60)) {
                aus.add(new Roh(t, wert, eingang == null ? t.plusSeconds(2) : eingang));
                wert = wert.add(zuwachs);
            }
        }
        return aus;
    }

    private static List<Roh> minutenwerte(Instant von, Instant bis, String start, String zuwachs) {
        List<Roh> aus = new ArrayList<>();
        BigDecimal wert = new BigDecimal(start);
        for (Instant t = von; !t.isAfter(bis); t = t.plusSeconds(60)) {
            aus.add(new Roh(t, wert, t.plusSeconds(2)));
            wert = wert.add(new BigDecimal(zuwachs));
        }
        return aus;
    }

    private static JsonNode fall(String praefix) throws Exception {
        for (JsonNode c : JSON.readTree(Files.readString(VerbrauchVectorsTest.VECTORS)).path("cases")) {
            if (c.path("name").asText().startsWith(praefix)) {
                return c;
            }
        }
        throw new AssertionError("kein Fall " + praefix);
    }

    private static JsonNode erwartung(String praefix, String name) throws Exception {
        for (JsonNode e : fall(praefix).path("expected")) {
            if (name.equals(e.path("name").asText())) {
                return e;
            }
        }
        throw new AssertionError("keine Erwartung " + name + " in " + praefix);
    }

    private static final String ROH_SQL =
            "INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, point_key, "
                    + "raw_numeric, quality, catalog_version, edge_sequence, aggregation_kind, entity_id, "
                    + "applied_revision, value_kind, role, delivery, delay_s) VALUES (?, ?, ?, ?, ?, ?, ?, 'good', "
                    + "'2026.09.11.1', ?, 'counter', ?, 3, 'counter', 'fuehrend', ?, 2) ON CONFLICT DO NOTHING";

    private static void saeen(UUID tenant, String reihe, List<Roh> werte) {
        List<Object[]> stapel = new ArrayList<>();
        for (Roh r : werte) {
            boolean spaet = r.eingang().isAfter(r.zeit().plusSeconds(2));
            stapel.add(new Object[] {Timestamp.from(r.zeit()), Timestamp.from(r.eingang()), tenant,
                    IDS.get("AN:" + tenant), IDS.get("BOX:" + reihe), KANAL, r.wert(), r.zeit().getEpochSecond(),
                    IDS.get(reihe), spaet ? "nachgeliefert" : "direkt"});
        }
        root.batchUpdate(ROH_SQL, stapel);
    }

    private static void verdichtungstakt(Instant jetzt) {
        for (int i = 0; i < 200; i++) {
            ViertelstundeVerdichter.Lauf l = verdichter.lauf(jetzt);
            if (l.rueckrechnungFertig() && zahl("SELECT count(*) FROM messreihe_viertelstunde_arbeit") == 0) {
                return;
            }
        }
        throw new AssertionError("die Verdichtung wird nicht fertig");
    }

    /** F12: Ines Kaltenbach trägt Endstand und Anfangsstand der Rücksetzung 09:12 über den Ereignis-Weg nach. */
    private static void ablesestaendeNachtragen() {
        ObjectNode e = JSON.createObjectNode()
                .put("ereignis_id", UUID.randomUUID().toString())
                .put("art", "device_boundary")
                .put("zeitpunkt", "2027-01-15T08:12:00Z")
                .put("komponente", IDS.get("F12").toString())
                .put("messkanal", KANAL)
                .put("anlass", "zaehler_zurueckgesetzt")
                .put("einbau_alt", "C-1")
                .put("einbau_neu", "C-1")
                .put("eingetragen_am", F12_EINGANG.toString())
                .put("endstand", new BigDecimal("6184.90"))
                .put("anfangsstand", new BigDecimal("0.0"))
                .put("einheit", "kWh");
        MessreiheEreignisRepository.Ergebnis r = als(KB, () -> new MessreiheEreignisRepository(app)
                .anhaengen(KB, IDS.get("AN:" + KB), Urheber.KUNDE, e, null, F12_EINGANG));
        assertThat(r.ausgang()).as(String.valueOf(r.hinweis())).isEqualTo(MessreiheEreignisRepository.Ausgang.ANGEHAENGT);
    }

    // =========================================================================== Hilfen: lesen

    private static Korrektur vorschlag(UUID tenant, String reihe) {
        List<Korrektur> k = als(tenant, () -> korrekturen.fuerReihe(tenant, IDS.get(reihe), KANAL));
        assertThat(k).as("genau ein Vorschlag für " + reihe).hasSize(1);
        return k.get(0);
    }

    private static Map<String, Object> tag(String reihe, LocalDate tag) {
        return root.queryForMap("SELECT * FROM messreihe_tag WHERE entity_id = ? AND tag = ?", IDS.get(reihe), tag);
    }

    private static Map<String, Object> periode(String reihe, String art, LocalDate tag) {
        return root.queryForMap("SELECT * FROM messreihe_periode WHERE entity_id = ? AND art = ? AND tag = ?",
                IDS.get(reihe), art, tag);
    }

    private static Map<String, Object> berechneterTag(String kennzeichen, LocalDate tag) {
        return root.queryForMap("SELECT * FROM messreihe_tag WHERE messstelle_id = ? AND tag = ?", IDS.get(kennzeichen),
                tag);
    }

    /** Die NEUESTE Version einer Stufe der Reihe. */
    private static Map<String, Object> periodeVersion(String reihe, String ebene, LocalDate tag) {
        return root.queryForMap("SELECT * FROM messreihe_periode_version WHERE entity_id = ? AND ebene = ? AND tag = ? "
                + "ORDER BY version DESC LIMIT 1", IDS.get(reihe), ebene, tag);
    }

    private static Map<String, Object> berechneteVersionJetzt(String kennzeichen, String ebene, LocalDate tag) {
        return root.queryForMap("SELECT * FROM messreihe_periode_version WHERE messstelle_id = ? AND ebene = ? AND tag = ? "
                + "ORDER BY version DESC LIMIT 1", IDS.get(kennzeichen), ebene, tag);
    }

    private static Map<String, Object> versionAus(List<Map<String, Object>> zeilen, String reihe, String ebene,
            LocalDate tag, int version) {
        return zeilen.stream().filter(z -> IDS.get(reihe).equals(z.get("entity_id")) && ebene.equals(z.get("ebene"))
                        && tag.equals(((java.sql.Date) z.get("tag")).toLocalDate()) && n(z.get("version")) == version)
                .findFirst().orElseThrow(() -> new AssertionError("keine Version " + version + " " + ebene + " " + tag));
    }

    private static Map<String, Object> berechneteVersion(List<Map<String, Object>> zeilen, String kennzeichen,
            String ebene, LocalDate tag) {
        return zeilen.stream().filter(z -> IDS.get(kennzeichen).equals(z.get("messstelle_id"))
                        && ebene.equals(z.get("ebene")) && tag.equals(((java.sql.Date) z.get("tag")).toLocalDate()))
                .max(Comparator.comparingInt(z -> n(z.get("version"))))
                .orElseThrow(() -> new AssertionError("keine Version von " + kennzeichen + " " + ebene + " " + tag));
    }

    private static List<Map<String, Object>> viertelVersionen(UUID tenant, String reihe, int version) {
        return root.queryForList("SELECT * FROM messreihe_viertelstunde_version WHERE tenant_id = ? AND entity_id = ? "
                + "AND version = ? ORDER BY intervall_beginn", tenant, IDS.get(reihe), version);
    }

    private static String alleVersionen() {
        return Bestandsschutz.inhalt(root, "messreihe_periode_version", null);
    }

    private static List<String> mitVersion(Map<String, Object> v1, int version) {
        List<String> k = new ArrayList<>(saetze(v1.get("kennzeichen")));
        k.add(ErgebnisZustand.korrigiert(version));
        return k;
    }

    private static List<String> saetze(Object json) {
        List<String> aus = new ArrayList<>();
        try {
            JSON.readTree(String.valueOf(json)).forEach(k -> aus.add(k.asText()));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        return aus;
    }

    private static List<String> array(Object a) {
        try {
            return Arrays.asList((String[]) ((java.sql.Array) a).getArray());
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    private static int n(Object zahl) {
        return ((Number) zahl).intValue();
    }

    private static int zahl(String sql, Object... args) {
        return root.queryForObject(sql, Integer.class, args);
    }

    private static UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
    }

    private static Timestamp ts(Instant t) {
        return Timestamp.from(t);
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
        for (Throwable c = t; c != null; c = c.getCause()) {
            if (c instanceof PSQLException p) {
                return p;
            }
        }
        throw new AssertionError("keine PSQLException: " + t);
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
