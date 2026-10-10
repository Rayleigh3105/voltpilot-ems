package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.EreignisVokabular.Urheber;
import com.voltpilot.api.uems.KorrekturVorschlagLauf.Ergebnis;
import com.voltpilot.api.uems.KorrekturVorschlagLauf.Lauf;
import com.voltpilot.api.uems.MessreiheKorrekturRepository.Korrektur;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
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
 * UEMS AP-08 IP-14 auf echter TimescaleDB: das System schlägt vor, freigegeben wird von Hand — nie automatisch,
 * auch nicht, wenn nur Lücken gefüllt werden (E14 = A).
 *
 * <p>Die Zeitachse in {@link #bauenUndFahren}: Version 1 aller Reihen → Endgültigkeit → die Nachlieferung von F10
 * (und eine reine Lücke, und ein zweiter Kundenbereich) trifft ein und landet als Erkennung → der Ablesestand von
 * F12 wird nach der Frist eingetragen → FINGERABDRUCK → Stundenlauf zu früh (Ruhe) → Stundenlauf → derselbe
 * Stundenlauf noch einmal → die Erkennung noch einmal offen (Sperre über den Schlüssel) → Ablehnung von Hand →
 * noch ein Lauf → die Umklassifizierung von F7 → FINGERABDRUCK. Jeder Test prüft einen Schritt.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsKorrekturVorschlaegeTest {

    private static final String DIESE = "20260913224500";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Ein Zählerstand in kWh aus dem ausgelieferten Katalog. */
    private static final String KANAL = "deye.hybrid_1p.meter.generator-energy";

    private static final UUID KB = UUID.fromString("4e0e0000-0000-0000-0000-000000000015");
    private static final UUID FREMD = UUID.fromString("4e0e0000-0000-0000-0000-000000000016");

    /** Version 1 aller Reihen. */
    private static final Instant T_V1 = Instant.parse("2026-11-04T00:30:00Z");
    /** F10: die Puffer-Werte der reparierten Box treffen am 12.11. 09:02 MEZ ein. */
    private static final Instant F10_EINGANG = Instant.parse("2026-11-12T08:02:00Z");
    private static final Instant T_MELDER = Instant.parse("2026-11-12T08:05:00Z");
    private static final Instant T_ZU_FRUEH = Instant.parse("2026-11-12T08:10:00Z");
    /** F12: der Endstand wird am 25.01.2027 09:40 MEZ nachgetragen. */
    private static final Instant F12_EINGANG = Instant.parse("2027-01-25T08:40:00Z");
    private static final Instant T_ENDGUELTIG = Instant.parse("2027-01-25T08:00:00Z");
    private static final Instant T_LAUF = Instant.parse("2027-01-25T09:00:00Z");

    private static final Instant F10_VON = Instant.parse("2026-11-03T13:00:00Z");
    private static final Instant F10_BIS = Instant.parse("2026-11-03T16:45:00Z");
    private static final Instant F12_VON = Instant.parse("2027-01-15T08:00:00Z");
    private static final Instant F7_SPRUNG = Instant.parse("2026-10-20T08:03:00Z");
    /** Die reine Lücke: 04.11. 09:15–09:30 UTC hat vor der Nachlieferung keine einzige Zeile. */
    private static final Instant LUECKE_VON = Instant.parse("2026-11-04T09:15:00Z");

    private static final ProtokollAkteur INES = new ProtokollAkteur("kc-ines-kaltenbach", "Ines Kaltenbach",
            "energiemanager", "kunde");

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
    private static KorrekturVorschlagLauf lauf;
    private static MessreiheKorrekturRepository korrekturen;

    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;
    private static int spaetankuenfte;
    private static Map<String, String> vorDemLauf;
    private static String ereignisseVorDemLauf;
    private static Lauf zuFrueh;
    private static int korrekturenZuFrueh;
    private static Lauf erster;
    private static Lauf zweiter;
    private static Lauf wiederOffen;
    private static int offenNachSperre;
    private static Lauf nachAblehnung;
    private static String f10;
    private static Ergebnis f7;
    private static Ergebnis f7Nochmal;
    private static Ergebnis f7Ruecksetzung;
    private static Ergebnis f7Fremd;
    private static Ergebnis f7OhneWertebereich;
    private static Map<String, String> nachAllem;
    private static String ereignisseNachAllem;

    // =========================================================================== Aufbau

    @BeforeAll
    static void bauenUndFahren() throws Exception {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        stammdaten();
        // Was pünktlich eintraf — der Bestand vor dieser Migration.
        saeen(KB, "F10", abschnitte("f10-", false));
        saeen(KB, "F12", abschnitte("f12-", false));
        saeen(KB, "F7", abschnitte("f7-", false));
        saeen(KB, "LUECKE", minutenwerte(Instant.parse("2026-11-04T08:00:00Z"), Instant.parse("2026-11-04T09:14:00Z"),
                "1000", null));
        saeen(KB, "LUECKE", minutenwerte(Instant.parse("2026-11-04T09:31:00Z"), Instant.parse("2026-11-04T10:00:00Z"),
                "1091", null));
        saeen(FREMD, "ZF", minutenwerte(Instant.parse("2026-11-04T08:00:00Z"), Instant.parse("2026-11-04T09:14:00Z"),
                "500", null));
        saeen(FREMD, "ZF", minutenwerte(Instant.parse("2026-11-04T09:31:00Z"), Instant.parse("2026-11-04T10:00:00Z"),
                "591", null));
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());
        flyway().target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        flyway().load().migrate();

        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        SpaetankunftMelder melder = new SpaetankunftMelder();
        verdichter = new ViertelstundeVerdichter(admin, new MeasurementCatalog(JSON), melder, 500, 40, 200_000);
        lauf = new KorrekturVorschlagLauf(admin, verdichter, melder, 200);
        korrekturen = new MessreiheKorrekturRepository(app);

        // ---- Version 1, dann endgültig ------------------------------------------------------------------
        arbeitAusRohwerten("TRUE");
        verdichten(T_V1);
        new EndgueltigkeitLauf(admin, 2000, 200).umschalten(T_ENDGUELTIG);

        // ---- F10: die 210 Werte 14:01–17:30 kommen nach der Frist; dazu eine reine Lücke je Kundenbereich ----
        saeen(KB, "F10", abschnitte("f10-", true));
        saeen(KB, "LUECKE", minutenwerte(Instant.parse("2026-11-04T09:16:00Z"), Instant.parse("2026-11-04T09:29:00Z"),
                "1076", F10_EINGANG));
        // Im fremden Kundenbereich liegt der erste nachgelieferte Wert GENAU auf der Grenze 09:15 — er ist der
        // Endstand der Viertelstunde davor, die selbst keinen Nachzügler hat.
        saeen(FREMD, "ZF", minutenwerte(Instant.parse("2026-11-04T09:15:00Z"), Instant.parse("2026-11-04T09:29:00Z"),
                "575", F10_EINGANG));
        arbeitAusRohwerten("s.received_at = '" + F10_EINGANG + "'::timestamptz");
        spaetankuenfte = verdichten(T_MELDER);

        // ---- F12: Endstand und Anfangsstand zur Rücksetzung 09:12, eingetragen nach der Frist ---------------
        ablesestaendeNachtragen();

        vorDemLauf = Bestandsschutz.fingerabdruck(root, List.of("messreihe_korrektur%", "messreihe_ereignis"));
        ereignisseVorDemLauf = Bestandsschutz.inhalt(root, "messreihe_ereignis", "t.art <> 'correction'");

        // ---- Der Stundenlauf ---------------------------------------------------------------------------
        zuFrueh = lauf.lauf(T_ZU_FRUEH);
        korrekturenZuFrueh = zahl("SELECT count(*) FROM messreihe_korrektur");
        erster = lauf.lauf(T_LAUF);
        f10 = root.queryForObject("SELECT kennung FROM messreihe_korrektur WHERE tenant_id = ? AND fassung = 1 "
                + "AND art = 'nachlieferung_nach_endgueltigkeit' AND von = ?", String.class, KB, ts(F10_VON));
        zweiter = lauf.lauf(T_LAUF.plus(Duration.ofHours(1)));

        // Als hätte ein Lauf die Erkennung nicht geschlossen: dieselbe Nachlieferung steht wieder offen da.
        wiederOeffnen();
        wiederOffen = lauf.lauf(T_LAUF.plus(Duration.ofHours(2)));
        offenNachSperre = zahl("SELECT count(*) FROM messreihe_korrektur_vorschlag WHERE zustand = 'offen' "
                + "AND entity_id = '" + IDS.get("F10") + "'");
        // Ein Mensch lehnt ab — und der nächste Lauf fragt nicht noch einmal.
        als(KB, () -> korrekturen.ablehnen(KB, f10, "Die Box hat doppelt gezählt, die Werte bleiben.", INES));
        nachAblehnung = lauf.lauf(T_LAUF.plus(Duration.ofHours(3)));

        // ---- F7: die Umklassifizierung, angefragt von Ines Kaltenbach -------------------------------------
        f7 = lauf.umklassifizierung(KB, IDS.get("F7"), KANAL, F7_SPRUNG, "als_ueberlauf", new BigDecimal("65536"), INES,
                T_LAUF);
        f7Nochmal = lauf.umklassifizierung(KB, IDS.get("F7"), KANAL, F7_SPRUNG, "als_ueberlauf",
                new BigDecimal("65536"), INES, T_LAUF);
        f7Ruecksetzung = lauf.umklassifizierung(KB, IDS.get("F7"), KANAL, F7_SPRUNG, "als_ruecksetzung", null, INES,
                T_LAUF);
        f7Fremd = lauf.umklassifizierung(FREMD, IDS.get("F7"), KANAL, F7_SPRUNG, "als_ueberlauf",
                new BigDecimal("65536"), INES, T_LAUF);
        f7OhneWertebereich = lauf.umklassifizierung(KB, IDS.get("F7"), KANAL, F7_SPRUNG, "als_ueberlauf", null, INES,
                T_LAUF);

        nachAllem = Bestandsschutz.fingerabdruck(root, List.of("messreihe_korrektur%", "messreihe_ereignis"));
        ereignisseNachAllem = Bestandsschutz.inhalt(root, "messreihe_ereignis", "t.art <> 'correction'");
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ========================================================== Die Abnahme: nie automatisch

    /**
     * <b>Die Abnahme von IP-14:</b> Vorschläge entstehen — und bis zur Freigabe ändert sich keine Zahl. Alle
     * Tabellen außer den Korrekturen selbst und den Ereignissen tragen nach sechs Stundenläufen, einer Ablehnung
     * und einer Umklassifizierung Zeichen für Zeichen denselben Inhalt: dieselben Viertelstunden, Tage und
     * Perioden, dieselbe Version, keine Version 2. Und an den Ereignissen kam nur der Marker {@code correction}
     * hinzu.
     */
    @Test
    void bisZurFreigabeAendertSichKeineZahlUndKeineVersion() {
        assertThat(zahl("SELECT count(*) FROM messreihe_korrektur WHERE fassung = 1")).as("Vorschläge entstanden")
                .isEqualTo(5);
        assertThat(vorDemLauf.get("messreihe_viertelstunde")).isNotEqualTo(Bestandsschutz.LEER);
        assertThat(Bestandsschutz.abweichungen(vorDemLauf, nachAllem)).isEmpty();
        assertThat(ereignisseNachAllem).isEqualTo(ereignisseVorDemLauf);
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde_version")).as("keine Version 2").isZero();
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde WHERE version <> 1")).isZero();
    }

    /**
     * E14, der letzte Halbsatz: auch wenn NUR Lücken gefüllt werden, bleibt es ein Vorschlag. Die Viertelstunde
     * 09:15 hatte vor der Nachlieferung keine Zeile — sie hat nach dem Lauf immer noch keine, und keine Version.
     */
    @Test
    void einVorschlagDerNurEineLueckeFuelltErzeugtKeineVersionZwei() throws Exception {
        Korrektur k = korrektur(KB, "nachlieferung_nach_endgueltigkeit", LUECKE_VON);
        assertThat(k.status()).isEqualTo("vorschlag");
        JsonNode vorschau = k.anlage().vorschau();
        assertThat(vorschau).hasSize(1);
        assertThat(vorschau.get(0).path("alt").path("version").isNull()).isTrue();
        assertThat(vorschau.get(0).path("alt").path("menge_zustand").asText()).isEqualTo("keine Werte");
        assertThat(vorschau.get(0).path("neu").path("menge_zustand").asText()).isEqualTo("unvollständig");
        assertThat(new BigDecimal(vorschau.get(0).path("neu").path("menge").asText())).isEqualByComparingTo("13");
        assertThat(vorschau.get(0).path("neu").path("erhalten").asInt()).isEqualTo(14);
        assertThat(vorschau.get(0).path("aendert").asBoolean()).isTrue();
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde WHERE entity_id = ? AND intervall_beginn = ?",
                IDS.get("LUECKE"), ts(LUECKE_VON))).as("keine Zeile der Verdichtung").isZero();
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde_version WHERE entity_id = ?", IDS.get("LUECKE")))
                .isZero();
    }

    /** Auch die Datenbank lässt den System-Weg nur vorschlagen: eine Freigabe über die BYPASSRLS-Rolle scheitert. */
    @Test
    void derSystemWegKannNichtFreigeben() {
        String kennung = korrektur(KB, "ablesestaende_nachgetragen", F12_VON).kennung();
        PSQLException p = psql(() -> admin.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, "
                + "actor_name, actor_rolle, actor_art) VALUES (?, ?, 2, 'freigegeben', 'VoltPilot', 'voltpilot_betrieb', "
                + "'voltpilot')", KB, kennung));
        assertThat(p.getServerErrorMessage().getConstraint()).as(p.getMessage())
                .isEqualTo("messreihe_korrektur_system_nur_vorschlag");
        // Und ohne Recht auf `grund` kann er auch nicht mit Grund ablehnen.
        assertThat(psql(() -> admin.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, grund, "
                + "actor_name, actor_art) VALUES (?, ?, 2, 'abgelehnt', 'automatisch abgelehnt', 'VoltPilot', "
                + "'voltpilot')", KB, kennung)).getSQLState()).isEqualTo("42501");
        assertThat(korrektur(KB, "ablesestaende_nachgetragen", F12_VON).status()).isEqualTo("vorschlag");
    }

    // ================================================================================== F10

    /** F10: aus 15 offenen Zeilen der Erkennung wird EIN Vorschlag der Art Nachlieferung — mit Vorschau je Viertelstunde. */
    @Test
    void f10DieNachlieferungWirdEinVorschlagUeberFuenfzehnViertelstunden() throws Exception {
        assertThat(spaetankuenfte).as("die Erkennung aus PR 702").isEqualTo(17);
        Korrektur k = korrektur(KB, "nachlieferung_nach_endgueltigkeit", F10_VON);
        assertThat(k.kennung()).matches("K-\\d{4}-\\d{4}");
        // Fassung 1 legte der Lauf als Vorschlag an; die zweite (Ablehnung) schrieb ein Mensch, später im Ablauf.
        assertThat(k.fassungen()).extracting(MessreiheFassungen.Fassung::status).containsExactly("vorschlag", "abgelehnt");
        assertThat(k.fassungen().get(1).akteur()).isEqualTo(INES);
        assertThat(k.ersteller()).isEqualTo(KorrekturVorschlagLauf.SYSTEM);
        assertThat(k.anlage().reihen()).containsExactly(new MessreiheKorrekturRepository.Reihe(IDS.get("F10"), KANAL));
        assertThat(k.anlage().von()).isEqualTo(F10_VON);
        assertThat(k.anlage().bis()).isEqualTo(F10_BIS);
        assertThat(k.anlage().begruendung()).isEqualTo(satzDesVertrags("f10-nachlieferung-k-2026-0007"));

        JsonNode vorschau = k.anlage().vorschau();
        assertThat(vorschau).hasSize(15);
        for (JsonNode p : vorschau) {
            assertThat(p.path("periode").asText()).isEqualTo("viertelstunde");
            assertThat(p.path("aendert").asBoolean()).isTrue();
            assertThat(new BigDecimal(p.path("neu").path("menge").asText())).as(p.path("von").asText())
                    .isEqualByComparingTo("24.0");
            assertThat(p.path("neu").path("menge_zustand").asText()).isEqualTo("vollständig");
            assertThat(p.path("neu").path("kennzeichen")).isEmpty();
            assertThat(p.path("neu").path("erhalten").asInt()).isEqualTo(15);
            assertThat(p.path("neu").path("version").isNull()).as("die Version vergibt erst die Freigabe").isTrue();
        }
        JsonNode erste = vorschau.get(0).path("alt");
        assertThat(erste.path("version").asInt()).isEqualTo(1);
        assertThat(erste.path("menge").isNull()).isTrue();
        assertThat(erste.path("menge_zustand").asText()).isEqualTo("unvollständig");
        assertThat(erste.path("kennzeichen").get(0).asText()).isEqualTo("nur ein Stand in der Periode — keine Menge bildbar");
        for (int i = 1; i < 14; i++) {
            assertThat(vorschau.get(i).path("alt").path("menge_zustand").asText()).isEqualTo("keine Werte");
            assertThat(vorschau.get(i).path("alt").path("version").isNull()).isTrue();
        }
        JsonNode letzte = vorschau.get(14).path("alt");
        assertThat(new BigDecimal(letzte.path("menge").asText())).isEqualByComparingTo("22.4");
        assertThat(letzte.path("menge_zustand").asText()).isEqualTo("unvollständig");
    }

    /** Die Brücke: die 15 Zeilen der Erkennung stehen auf erledigt und nennen den Vorschlag — ihre Tabelle blieb, wie sie ist. */
    @Test
    void f10DieErkennungIstErledigtUndNenntDenVorschlag() {
        List<Map<String, Object>> zeilen = root.queryForList("SELECT zustand, erledigt_notiz FROM "
                + "messreihe_korrektur_vorschlag WHERE entity_id = ?", IDS.get("F10"));
        assertThat(zeilen).hasSize(15);
        assertThat(zeilen).allSatisfy(z -> {
            assertThat(z.get("zustand")).isEqualTo("erledigt");
            assertThat(z.get("erledigt_notiz")).isEqualTo("Aufgenommen in den Korrektur-Vorschlag " + f10 + ".");
        });
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
    }

    /** Der Verlauf-Marker: {@code correction} von der Cloud, Status {@code vorschlag} — für jeden Vorschlag genau einer. */
    @Test
    void jederVorschlagSetztEinenMarkerImVerlauf() throws Exception {
        assertThat(zahl("SELECT count(*) FROM messreihe_ereignis WHERE art = 'correction'")).isEqualTo(5);
        Map<String, Object> m = root.queryForMap("SELECT urheber, von, bis, entity_id, messkanal, nutzlast::text AS n "
                + "FROM messreihe_ereignis WHERE art = 'correction' AND nutzlast->>'korrektur' = ? AND tenant_id = ?",
                f10, KB);
        assertThat(m.get("urheber")).isEqualTo("cloud");
        assertThat(((Timestamp) m.get("von")).toInstant()).isEqualTo(F10_VON);
        assertThat(((Timestamp) m.get("bis")).toInstant()).isEqualTo(F10_BIS);
        assertThat(m.get("entity_id")).isEqualTo(IDS.get("F10"));
        JsonNode n = JSON.readTree((String) m.get("n"));
        assertThat(n.path("status").asText()).isEqualTo("vorschlag");
        assertThat(n.path("korrektur_art").asText()).isEqualTo("nachlieferung_nach_endgueltigkeit");
        assertThat(zahl("SELECT count(*) FROM messreihe_ereignis WHERE art = 'correction' "
                + "AND nutzlast->>'status' <> 'vorschlag'")).as("die Cloud meldet nie mehr als vorschlag").isZero();
    }

    /** Zu früh: die Box leert vielleicht noch ihren Puffer — die Gruppe wartet die Ruhe ab, nichts entsteht. */
    @Test
    void eineNachlieferungWartetDieRuheAb() {
        assertThat(korrekturenZuFrueh).isZero();
        assertThat(zuFrueh.wartet()).isEqualTo(3);
        assertThat(zuFrueh.vorschlaege()).isZero();
        assertThat(zuFrueh.erledigt()).isZero();
    }

    // ========================================================================= Die Sperre

    /** Zweimal derselbe Stundenlauf: EIN Vorschlag je Sache — für die Nachlieferung und für den Ablesestand. */
    @Test
    void zweimalDerselbeStundenlaufErzeugtEinenVorschlag() {
        assertThat(erster.vorschlaege()).isEqualTo(4);
        assertThat(erster.erledigt()).isEqualTo(17);
        assertThat(zweiter.vorschlaege()).isZero();
        assertThat(zweiter.gesperrt()).as("der Ablesestand von F12 wird wieder gefunden — und gesperrt").isEqualTo(1);
        assertThat(zahl("SELECT count(*) FROM messreihe_korrektur WHERE fassung = 1 AND art = 'ablesestaende_nachgetragen'"))
                .isOne();
        assertThat(zahl("SELECT count(*) FROM messreihe_korrektur WHERE fassung = 1 "
                + "AND art = 'nachlieferung_nach_endgueltigkeit' AND tenant_id = ?", KB)).isEqualTo(2);
    }

    /**
     * Die Sperre hängt am fachlichen Schlüssel, nicht am Zustand der Erkennung: steht dieselbe Nachlieferung wieder
     * offen da, entsteht kein zweiter Vorschlag, solange der erste nicht entschieden ist — und nach der Ablehnung
     * fragt der Lauf nicht noch einmal, sondern schließt die Zeilen mit Verweis auf die Entscheidung.
     */
    @Test
    void dieSperreHaengtAmSchluesselUndAnDerEntscheidung() {
        assertThat(wiederOffen.vorschlaege()).isZero();
        assertThat(wiederOffen.gesperrt()).isEqualTo(2);
        assertThat(offenNachSperre).as("gesperrt heißt: die Zeilen bleiben offen").isEqualTo(15);
        assertThat(nachAblehnung.vorschlaege()).isZero();
        assertThat(nachAblehnung.erledigt()).isEqualTo(15);
        assertThat(korrektur(KB, "nachlieferung_nach_endgueltigkeit", F10_VON).status()).isEqualTo("abgelehnt");
        assertThat(zahl("SELECT count(*) FROM messreihe_korrektur_vorschlag WHERE zustand = 'offen'")).isZero();
        assertThat(zahl("SELECT count(*) FROM messreihe_korrektur WHERE fassung = 1 AND von = ? AND tenant_id = ?",
                ts(F10_VON), KB)).isOne();
    }

    // ================================================================================== F12

    /** F12: der Ablesestand nach der Frist wird ein Vorschlag „Ablesestände nachgetragen“ — 14,28 → 14,81 kWh. */
    @Test
    void f12DerAblesestandNachDerFristWirdEinVorschlag() {
        Korrektur k = korrektur(KB, "ablesestaende_nachgetragen", F12_VON);
        assertThat(k.status()).isEqualTo("vorschlag");
        assertThat(k.ersteller()).isEqualTo(KorrekturVorschlagLauf.SYSTEM);
        assertThat(k.anlage().bis()).isEqualTo(F12_VON.plus(Duration.ofMinutes(15)));
        assertThat(k.anlage().begruendung()).isEqualTo(satzDesVertrags("f12-ablesestaende-k-2027-0002"));
        JsonNode p = k.anlage().vorschau().get(0);
        assertThat(k.anlage().vorschau()).hasSize(1);
        assertThat(new BigDecimal(p.path("alt").path("menge").asText())).isEqualByComparingTo("14.28");
        assertThat(p.path("alt").path("menge_zustand").asText()).isEqualTo("unvollständig");
        assertThat(p.path("alt").path("kennzeichen").get(0).asText())
                .isEqualTo("Rücksetzung 09:12 ohne Endstand — bis zu 1 Kadenz nicht gezählt");
        assertThat(new BigDecimal(p.path("neu").path("menge").asText())).isEqualByComparingTo("14.81");
        assertThat(p.path("neu").path("menge_zustand").asText()).isEqualTo("vollständig");
        assertThat(p.path("neu").path("kennzeichen").get(0).asText()).isEqualTo("Gerätegrenze 09:12 mit Ableseständen");
    }

    // ================================================================================== F7

    /** E4: die Umklassifizierung rechnet die Viertelstunde als Überlauf durch dieselbe Regel und schlägt nur vor. */
    @Test
    void f7DieUmklassifizierungIstEinVorschlagMitRechnung() {
        assertThat(f7.ablehnung()).isNull();
        Korrektur k = als(KB, () -> korrekturen.lies(KB, f7.kennung())).orElseThrow();
        assertThat(k.anlage().art()).isEqualTo("umklassifizierung");
        assertThat(k.status()).isEqualTo("vorschlag");
        assertThat(k.ersteller()).as("wer fragte, legt an").isEqualTo(INES);
        assertThat(k.anlage().begruendung()).isEqualTo(satzDesVertrags("f7-als-ueberlauf"));
        JsonNode p = k.anlage().vorschau().get(0);
        assertThat(p.path("alt").path("kennzeichen").get(0).asText()).startsWith("Rücksetzung 10:03");
        assertThat(p.path("neu").path("kennzeichen").get(0).asText()).isEqualTo("Überlauf 10:03 (Wertebereich 65536)");
        assertThat(p.path("neu").path("menge_zustand").asText()).isEqualTo("vollständig");
        assertThat(new BigDecimal(p.path("neu").path("menge").asText())).isEqualByComparingTo("11505");

        assertThat(f7Nochmal).isEqualTo(new Ergebnis(null, "liegt_schon_vor", f7.kennung()));
        assertThat(f7Ruecksetzung).as("sie ist schon eine Rücksetzung").isEqualTo(new Ergebnis(null, "ohne_aenderung", null));
        assertThat(f7OhneWertebereich).isEqualTo(new Ergebnis(null, "wertebereich_fehlt", null));
    }

    // ======================================================================== Mandantenzaun

    @Test
    void derMandantenzaunHaelt() {
        assertThat(f7Fremd).as("eine fremde Reihe gibt es nicht").isEqualTo(new Ergebnis(null, "reihe_unbekannt", null));
        List<Korrektur> fremde = als(FREMD, () -> korrekturen.fuerReihe(FREMD, IDS.get("ZF"), KANAL));
        assertThat(fremde).hasSize(1);
        assertThat(fremde.get(0).kennung()).endsWith("-0001");
        assertThat(als(FREMD, () -> app.queryForObject("SELECT count(*) FROM messreihe_korrektur WHERE fassung = 1",
                Integer.class))).isOne();
        assertThat(als(KB, () -> app.queryForObject("SELECT count(*) FROM messreihe_korrektur WHERE fassung = 1",
                Integer.class))).isEqualTo(4);
        assertThat(als(FREMD, () -> korrekturen.fuerReihe(FREMD, IDS.get("F10"), KANAL))).isEmpty();
        assertThat(root.queryForList("SELECT DISTINCT r->>'entity_id' FROM messreihe_korrektur k, "
                + "jsonb_array_elements(k.reihen) r WHERE k.tenant_id = ?", String.class, FREMD))
                .containsExactly(IDS.get("ZF").toString());
    }

    /**
     * Ein nachgelieferter Wert genau auf der Grenze ändert auch die Viertelstunde DAVOR (ihr Endstand, Z1) — sie
     * steht mit in der Vorschau und im Zeitraum, obwohl die Erkennung für sie keine Zeile hat.
     */
    @Test
    void derNachbarMitNachgeliefertemRandstandStehtInDerVorschau() {
        Korrektur k = korrektur(FREMD, "nachlieferung_nach_endgueltigkeit", LUECKE_VON.minus(Duration.ofMinutes(15)));
        assertThat(k.anlage().bis()).isEqualTo(LUECKE_VON.plus(Duration.ofMinutes(15)));
        JsonNode vorschau = k.anlage().vorschau();
        assertThat(vorschau).hasSize(2);
        assertThat(vorschau.get(0).path("alt").path("menge_zustand").asText()).isEqualTo("unvollständig");
        assertThat(vorschau.get(0).path("neu").path("menge_zustand").asText()).isEqualTo("vollständig");
        assertThat(vorschau.get(1).path("alt").path("menge_zustand").asText()).isEqualTo("keine Werte");
        assertThat(zahl("SELECT count(*) FROM messreihe_korrektur_vorschlag WHERE tenant_id = ?", FREMD)).isOne();
    }

    // ========================================================================== Migration

    @Test
    void dieMigrationGibtNurDasRechtZumVorschlagen() {
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
        for (String spalte : List.of("begruendung", "vorschau", "reihen", "status")) {
            assertThat(spalte(ADMIN_USER, spalte)).as(spalte).isTrue();
        }
        for (String spalte : List.of("grund", "beleg", "ersatzwert_kennung", "created_at")) {
            assertThat(spalte(ADMIN_USER, spalte)).as(spalte).isFalse();
        }
        assertThat(root.queryForObject("SELECT has_table_privilege(?, 'messreihe_korrektur', 'UPDATE')", Boolean.class,
                ADMIN_USER)).isFalse();
    }

    @Test
    void derBestandsvergleichFaengtEineGeaenderteZeile() {
        Bestandsschutz.mutationsprobe(root, List.of(), "messreihe_viertelstunde",
                "UPDATE messreihe_viertelstunde SET menge = menge + 1 WHERE menge IS NOT NULL");
    }

    // ===================================================================================== Gerüst

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
        }
        for (String r : List.of("F10", "F12", "F7", "LUECKE")) {
            reihe(KB, r);
        }
        reihe(FREMD, "ZF");
    }

    /** Eine Komponente mit eigener Box und dem kWh-Zählerkanal, Kadenz 60 s. */
    private static void reihe(UUID tenant, String name) {
        UUID an = IDS.get("AN:" + tenant);
        UUID box = uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, 'claimed') "
                + "RETURNING id", tenant, an, "VP-BOX-KV-" + name);
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

    /** Ein Wert je Minute: Zeit, Stand, Eingang. */
    private record Roh(Instant zeit, BigDecimal wert, Instant eingang) {}

    /**
     * Die Rohwerte eines Falls aus {@code verbrauch-vectors.json}: die Abschnitte ohne {@code eingang} (pünktlich,
     * zwei Sekunden nach der Messzeit) oder die mit (die Nachlieferung).
     */
    private static List<Roh> abschnitte(String fall, boolean spaet) throws Exception {
        List<Roh> aus = new ArrayList<>();
        for (JsonNode c : JSON.readTree(Files.readString(VerbrauchVectorsTest.VECTORS)).path("cases")) {
            if (!c.path("name").asText().startsWith(fall)) {
                continue;
            }
            for (JsonNode a : c.path("input").path("reihe").path("rohwerte")) {
                if (a.has("eingang") != spaet) {
                    continue;
                }
                Instant eingang = spaet ? OffsetDateTime.parse(a.path("eingang").asText()).toInstant() : null;
                aus.addAll(minutenwerte(OffsetDateTime.parse(a.path("von").asText()).toInstant(),
                        OffsetDateTime.parse(a.path("bis").asText()).toInstant(), a.path("stand_von").asText(),
                        a.path("zuwachs_je_kadenz").asText(), eingang));
            }
            return aus;
        }
        throw new AssertionError("kein Fall " + fall);
    }

    private static List<Roh> minutenwerte(Instant von, Instant bis, String start, Instant eingang) {
        return minutenwerte(von, bis, start, "1", eingang);
    }

    private static List<Roh> minutenwerte(Instant von, Instant bis, String start, String zuwachs, Instant eingang) {
        List<Roh> aus = new ArrayList<>();
        BigDecimal wert = new BigDecimal(start);
        for (Instant t = von; !t.isAfter(bis); t = t.plusSeconds(60)) {
            aus.add(new Roh(t, wert, eingang == null ? t.plusSeconds(2) : eingang));
            wert = wert.add(new BigDecimal(zuwachs));
        }
        return aus;
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

    /** Die Arbeitsliste wie der Zeiger des Laufs sie füllt: je Viertelstunde mit Rohwert, Grund Eingang. */
    private static void arbeitAusRohwerten(String bedingung) {
        root.update("INSERT INTO messreihe_viertelstunde_arbeit (tenant_id, entity_id, messkanal, intervall_beginn, grund) "
                + "SELECT DISTINCT s.tenant_id, s.entity_id, s.point_key, "
                + "to_timestamp(floor(extract(epoch FROM s.time) / 900) * 900), 'eingang' "
                + "FROM device_measurement_sample s WHERE s.entity_id IS NOT NULL AND " + bedingung
                + " ON CONFLICT DO NOTHING");
    }

    /** @return die gemeldeten Spätankünfte */
    private static int verdichten(Instant jetzt) {
        int spaet = 0;
        while (true) {
            int[] r = verdichter.verdichteEinenStapel(jetzt);
            if (r[0] == 0) {
                return spaet;
            }
            spaet += r[2];
        }
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

    private static void wiederOeffnen() {
        root.update("UPDATE messreihe_korrektur_vorschlag SET zustand = 'offen', erledigt_am = NULL, erledigt_notiz = NULL "
                + "WHERE entity_id = ?", IDS.get("F10"));
    }

    private static Korrektur korrektur(UUID tenant, String art, Instant von) {
        String kennung = root.queryForObject("SELECT kennung FROM messreihe_korrektur WHERE tenant_id = ? AND fassung = 1 "
                + "AND art = ? AND von = ?", String.class, tenant, art, ts(von));
        return als(tenant, () -> korrekturen.lies(tenant, kennung)).orElseThrow();
    }

    private static String satzDesVertrags(String name) {
        try {
            for (JsonNode c : JSON.readTree(Files.readString(KorrekturVorschlagRegelnTest.VECTORS)).path("cases")) {
                if (name.equals(c.path("name").asText())) {
                    return c.path("satz").asText();
                }
            }
        } catch (Exception x) {
            throw new IllegalStateException(x);
        }
        throw new AssertionError("kein Fall " + name);
    }

    private static boolean spalte(String rolle, String spalte) {
        return Boolean.TRUE.equals(root.queryForObject("SELECT has_column_privilege(?, 'messreihe_korrektur', ?, 'INSERT')",
                Boolean.class, rolle, spalte));
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
