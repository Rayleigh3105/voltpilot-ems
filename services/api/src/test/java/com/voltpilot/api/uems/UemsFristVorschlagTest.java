package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.MessreiheKorrekturRepository.Korrektur;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
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
 * UEMS AP-08 IP-19 auf echter TimescaleDB: <b>vor der Frist rechnet das System nach, nach der Frist fragt es.</b>
 *
 * <p>Dieselbe Nachlieferung — die 210 Werte 14:01–17:30 vom 03.11. — trifft zweimal ein: bei F9 am 05.11. 09:00,
 * solange die Viertelstunden vorläufig sind, bei F10 am 12.11. 09:02, nachdem sie endgültig wurden. Beide Reihen
 * haben dieselben Rohwerte, nur die Eingangszeit unterscheidet sich — und genau sie entscheidet: F9 wird automatisch
 * neu gebildet (keine Korrektur, keine Version 2), F10 wird gemeldet und vorgeschlagen, und keine Zahl ändert sich.
 * Die Reihe RUECK bekommt dieselbe Nachlieferung wie F10, während für ihre Viertelstunden noch Einträge einer
 * Rückrechnung in der Arbeitsliste stehen: der GRUND des Eintrags entscheidet nicht über die Frist.
 *
 * <p>Gefahren wird nichts nachgebaut, sondern die Takte der Produktion mit einer Test-Uhr:
 * {@link ViertelstundeVerdichter#lauf} (Eingang, Rückrechnung, Verdichten) und {@link EndgueltigkeitLaeufer#takt(Instant)}
 * (Endgültigkeit → Tage → Monate/Jahre → Korrektur-Vorschläge). Die Zeitachse in {@link #bauenUndFahren}:
 * Monatserster (F16 Oktober vorläufig) → Version 1 des 03.11. → F9 trifft ein → 07.11. 23:59 und 08.11. 00:00
 * MEZ (F16: die letzte Viertelstunde) → alles vom 03.11. endgültig → F10 trifft ein → FINGERABDRUCK → ein
 * abgebrochener Lauf → Verdichtung und Stundenlauf (zu früh, dann rechtzeitig) → dieselbe Nachlieferung noch
 * einmal → FINGERABDRUCK.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsFristVorschlagTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Ein Zählerstand in kWh aus dem ausgelieferten Katalog. */
    private static final String KANAL = "deye.hybrid_1p.meter.generator-energy";

    private static final UUID KB = UUID.fromString("4e0e0000-0000-0000-0000-000000000019");
    private static final UUID FREMD = UUID.fromString("4e0e0000-0000-0000-0000-000000000020");

    /** 01.11.2026 00:30 MEZ — der Oktober ist vorbei, aber nicht endgültig. */
    private static final Instant T_MONATSERSTER = Instant.parse("2026-10-31T23:30:00Z");
    private static final Instant T_MONATSERSTER_TAKT = Instant.parse("2026-11-01T00:00:00Z");
    private static final Instant T_V1 = Instant.parse("2026-11-04T00:30:00Z");
    private static final Instant T_V1_TAKT = Instant.parse("2026-11-04T01:00:00Z");
    /** F9: die Nachlieferung ist am 05.11. 09:00 MEZ eingegangen, der Takt läuft fünf Minuten später. */
    private static final Instant T_F9 = Instant.parse("2026-11-05T08:05:00Z");
    private static final Instant T_F9_TAKT = Instant.parse("2026-11-05T09:00:00Z");
    /** F16: 07.11. 23:59 MEZ — eine Minute, bevor die letzte Oktober-Viertelstunde endgültig wird. */
    private static final Instant T_F16_VORHER = Instant.parse("2026-11-07T22:59:00Z");
    /** F16: 08.11. 00:00 MEZ = 31.10. 23:45–24:00 MEZ + 7 Tage. */
    private static final Instant T_F16_GRENZE = Instant.parse("2026-11-07T23:00:00Z");
    private static final Instant T_ALLES_ENDGUELTIG = Instant.parse("2026-11-12T07:00:00Z");
    /** F10: die Nachlieferung ist am 12.11. 09:02 MEZ eingegangen. */
    private static final Instant T_F10 = Instant.parse("2026-11-12T08:05:00Z");
    private static final Instant T_ZU_FRUEH = Instant.parse("2026-11-12T08:10:00Z");
    private static final Instant T_F10_TAKT = Instant.parse("2026-11-12T09:00:00Z");
    private static final Instant T_NOCHMAL = Instant.parse("2026-11-12T09:05:00Z");
    private static final Instant T_NOCHMAL_TAKT = Instant.parse("2026-11-12T10:00:00Z");

    /** 03.11.2026 14:00 MEZ … 17:45 MEZ: die 15 Viertelstunden der Nachlieferung. */
    private static final Instant VON = Instant.parse("2026-11-03T13:00:00Z");
    private static final Instant BIS = Instant.parse("2026-11-03T16:45:00Z");

    /** Der Oktober 2026 in Europe/Berlin. */
    private static final Instant OKTOBER_VON = Instant.parse("2026-09-30T22:00:00Z");
    private static final Instant OKTOBER_BIS = Instant.parse("2026-10-31T23:00:00Z");
    private static final Instant LETZTE_OKTOBER_VIERTELSTUNDE = Instant.parse("2026-10-31T22:45:00Z");

    /** Was der Fingerabdruck um die Nachlieferung F10 NICHT misst: der Vorgang selbst und die Laufzustände. */
    private static final List<String> VORGANG = List.of("messreihe_korrektur%", "messreihe_ereignis",
            "messreihe_%_arbeit", "messreihe_%_lauf");

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

    private static Map<String, Object> oktoberAmMonatsersten;
    private static List<Map<String, Object>> f9VorDerNachlieferung;
    private static List<Map<String, Object>> f9NachDerNachlieferung;
    private static Map<String, Object> f9TagNachDerNachlieferung;
    private static Map<String, Object> oktoberVorher;
    private static List<Instant> vorlaeufigeOktoberViertelstundenVorher;
    private static Map<String, Object> letzterOktobertagVorher;
    private static Map<String, Object> oktoberNachher;
    private static Map<String, Object> letzterOktobertagNachher;
    private static List<Map<String, Object>> f10VorDerNachlieferung;
    private static Map<String, String> vorDerNachlieferung;
    private static boolean abbruchWarf;
    private static int arbeitNachAbbruch;
    private static int meldungenNachAbbruch;
    private static int erkennungNachAbbruch;
    private static Map<String, String> nachAbbruch;
    private static int korrekturenZuFrueh;
    private static int korrekturenNachDemTakt;
    private static int meldungenNachDemTakt;
    private static Map<String, String> nachDemTakt;
    private static int korrekturenNochmal;
    private static int meldungenNochmal;
    private static Map<String, String> nachAllem;

    // =========================================================================== Aufbau

    @BeforeAll
    static void bauenUndFahren() throws Exception {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().load().migrate();
        stammdaten();
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        MeasurementCatalog katalog = new MeasurementCatalog(JSON);
        SpaetankunftMelder melder = new SpaetankunftMelder();
        verdichter = new ViertelstundeVerdichter(admin, katalog, melder, 500, 40, 200_000);
        tage = new TagVerdichter(admin, katalog, 200, 40, 20_000, 200_000);
        laeufer = new EndgueltigkeitLaeufer(new EndgueltigkeitLauf(admin, 2000, 200), tage,
                new PeriodeVerdichter(admin, katalog, 50, 40, 2000),
                // Die berechneten Messstellen (AP-10 IP-10) rechnen im Takt nach den gemessenen; diese Welt hat keine.
                org.mockito.Mockito.mock(BerechnetePeriodenLauf.class),
                new KorrekturVorschlagLauf(admin, verdichter, melder, 200));
        korrekturen = new MessreiheKorrekturRepository(app);

        // Was pünktlich eintraf: der Oktober von F16 und der 03.11. der vier Nachlieferungs-Reihen.
        saeen(KB, "F16", abschnitte("f16-", false));
        saeen(KB, "F9", abschnitte("f9-", false));
        for (String r : List.of("F10", "RUECK")) {
            saeen(KB, r, abschnitte("f10-", false));
        }
        saeen(FREMD, "ZF", abschnitte("f10-", false));

        // ---- 01.11. 00:30 MEZ: die Vergangenheit wird gebildet, der Oktober steht — vorläufig ----------------
        verdichtungstakt(T_MONATSERSTER);
        tage.rueckrechnenGanz(T_MONATSERSTER_TAKT, 200);
        laeufer.takt(T_MONATSERSTER_TAKT);
        oktoberAmMonatsersten = periode("F16", "monat", LocalDate.of(2026, 10, 1));

        // ---- 04.11.: Version 1 des 03.11. aus dem Eingang ----------------------------------------------------
        verdichtungstakt(T_V1);
        laeufer.takt(T_V1_TAKT);
        f9VorDerNachlieferung = viertelstunden("F9");

        // ---- F9: die Nachlieferung trifft VOR der Frist ein ---------------------------------------------------
        saeen(KB, "F9", abschnitte("f9-", true));
        verdichtungstakt(T_F9);
        laeufer.takt(T_F9_TAKT);
        f9NachDerNachlieferung = viertelstunden("F9");
        f9TagNachDerNachlieferung = tag("F9", LocalDate.of(2026, 11, 3));

        // ---- F16: eine Minute vor und genau an der Frist der letzten Oktober-Viertelstunde -------------------
        laeufer.takt(T_F16_VORHER);
        oktoberVorher = periode("F16", "monat", LocalDate.of(2026, 10, 1));
        vorlaeufigeOktoberViertelstundenVorher = root.queryForList("SELECT intervall_beginn FROM messreihe_viertelstunde "
                + "WHERE entity_id = ? AND zustand = 'vorlaeufig' AND intervall_beginn >= ? AND intervall_beginn < ? "
                + "ORDER BY intervall_beginn", Timestamp.class, IDS.get("F16"), ts(OKTOBER_VON), ts(OKTOBER_BIS))
                .stream().map(Timestamp::toInstant).toList();
        letzterOktobertagVorher = tag("F16", LocalDate.of(2026, 10, 31));
        laeufer.takt(T_F16_GRENZE);
        oktoberNachher = periode("F16", "monat", LocalDate.of(2026, 10, 1));
        letzterOktobertagNachher = tag("F16", LocalDate.of(2026, 10, 31));

        // ---- 12.11.: der 03.11. ist endgültig ----------------------------------------------------------------
        laeufer.takt(T_ALLES_ENDGUELTIG);
        f10VorDerNachlieferung = viertelstunden("F10");

        // ---- F10: dieselbe Nachlieferung NACH der Frist — für RUECK steht noch eine Rückrechnung in der Liste ----
        saeen(KB, "F10", abschnitte("f10-", true));
        saeen(KB, "RUECK", abschnitte("f10-", true));
        saeen(FREMD, "ZF", abschnitte("f10-", true));
        rueckrechnungEintragen("RUECK");
        vorDerNachlieferung = Bestandsschutz.fingerabdruck(root, VORGANG);

        // Abbruchsicher: das Vorschlagen scheitert mitten im Stapel — nichts Halbes bleibt liegen.
        root.execute("REVOKE INSERT ON messreihe_korrektur_vorschlag FROM " + ADMIN_USER);
        try {
            verdichter.lauf(T_F10);
            abbruchWarf = false;
        } catch (RuntimeException e) {
            abbruchWarf = true;
        } finally {
            root.execute("GRANT INSERT ON messreihe_korrektur_vorschlag TO " + ADMIN_USER);
        }
        arbeitNachAbbruch = zahl("SELECT count(*) FROM messreihe_viertelstunde_arbeit");
        meldungenNachAbbruch = zahl("SELECT count(*) FROM messreihe_ereignis WHERE art = 'late_arrival'");
        erkennungNachAbbruch = zahl("SELECT count(*) FROM messreihe_korrektur_vorschlag");
        nachAbbruch = Bestandsschutz.fingerabdruck(root, VORGANG);

        verdichtungstakt(T_F10);
        laeufer.takt(T_ZU_FRUEH);
        korrekturenZuFrueh = zahl("SELECT count(*) FROM messreihe_korrektur");
        laeufer.takt(T_F10_TAKT);
        korrekturenNachDemTakt = zahl("SELECT count(*) FROM messreihe_korrektur");
        meldungenNachDemTakt = zahl("SELECT count(*) FROM messreihe_ereignis WHERE art = 'late_arrival'");
        nachDemTakt = Bestandsschutz.fingerabdruck(root, VORGANG);

        // ---- Wiederholbar: dieselbe Nachlieferung steht noch einmal in der Liste (Überlappung, Betriebs-Anstoß) ----
        root.update("INSERT INTO messreihe_viertelstunde_arbeit (tenant_id, entity_id, messkanal, intervall_beginn, grund) "
                + "SELECT DISTINCT s.tenant_id, s.entity_id, s.point_key, "
                + "to_timestamp(floor(extract(epoch FROM s.time) / 900) * 900), 'eingang' "
                + "FROM device_measurement_sample s WHERE s.received_at = ? ON CONFLICT DO NOTHING",
                ts(Instant.parse("2026-11-12T08:02:00Z")));
        rueckrechnungEintragen("RUECK");
        verdichtungstakt(T_NOCHMAL);
        laeufer.takt(T_NOCHMAL_TAKT);
        korrekturenNochmal = zahl("SELECT count(*) FROM messreihe_korrektur");
        meldungenNochmal = zahl("SELECT count(*) FROM messreihe_ereignis WHERE art = 'late_arrival'");
        nachAllem = Bestandsschutz.fingerabdruck(root, VORGANG);
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ============================================================= Das Paar: F9 gegen F10

    /**
     * F9 — VOR der Frist: die Nachlieferung wird automatisch neu gebildet. Keine Meldung, keine Erkennung, kein
     * Vorschlag, keine Version 2 — sie ist gemessen, nicht korrigiert. Dieser Test hält fest, dass das so BLEIBT:
     * wer die Frist-Prüfung verschärft, darf diesen Weg nicht mit abschalten.
     */
    @Test
    void f9VorDerFristWirdAutomatischNeuGebildetOhneVorschlag() {
        assertThat(f9VorDerNachlieferung).as("vorher: nur 14:00 und 17:30 hatten eine Zeile").hasSize(2);
        assertThat(f9NachDerNachlieferung).hasSize(15);
        for (Map<String, Object> z : f9NachDerNachlieferung) {
            assertThat((BigDecimal) z.get("menge")).as(String.valueOf(z.get("intervall_beginn")))
                    .isEqualByComparingTo("24.0");
            assertThat(z.get("menge_zustand")).isEqualTo("vollständig");
            assertThat(n(z.get("erhalten"))).isEqualTo(15);
            assertThat(n(z.get("version"))).isEqualTo(1);
            assertThat(z.get("zustand")).as("vor der Frist").isEqualTo("vorlaeufig");
        }
        JsonNode soll = erwartung("f9-", "Tag 03.11.2026");
        assertThat((BigDecimal) f9TagNachDerNachlieferung.get("menge"))
                .isEqualByComparingTo(soll.path("menge").decimalValue());
        assertThat(n(f9TagNachDerNachlieferung.get("erhalten"))).isEqualTo(soll.path("erhalten").asInt());
        assertThat(n(f9TagNachDerNachlieferung.get("erwartet"))).isEqualTo(soll.path("erwartet").asInt());

        assertThat(zahl("SELECT count(*) FROM messreihe_ereignis WHERE art = 'late_arrival' AND entity_id = ?",
                IDS.get("F9"))).isZero();
        assertThat(zahl("SELECT count(*) FROM messreihe_korrektur_vorschlag WHERE entity_id = ?", IDS.get("F9")))
                .isZero();
        assertThat(als(KB, () -> korrekturen.fuerReihe(KB, IDS.get("F9"), KANAL))).isEmpty();
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde_version WHERE entity_id = ?", IDS.get("F9")))
                .isZero();
    }

    /**
     * F10 — NACH der Frist: gemeldet und vorgeschlagen, und die Zahl bleibt bis zur Freigabe Zeichen für Zeichen
     * Version 1 — auch die 13 Viertelstunden, die „keine Werte“ waren, bekommen keine Zeile.
     */
    @Test
    void f10NachDerFristEntstehtEinVorschlagUndDieZahlBleibt() {
        assertThat(viertelstunden("F10")).isEqualTo(f10VorDerNachlieferung).hasSize(2);
        assertThat(f10VorDerNachlieferung).allSatisfy(z -> assertThat(z.get("zustand")).isEqualTo("endgueltig"));
        assertThat(f10VorDerNachlieferung.get(0).get("menge")).as("14:00: nur ein Stand").isNull();
        assertThat((BigDecimal) f10VorDerNachlieferung.get(1).get("menge")).isEqualByComparingTo("22.4");

        assertThat(zahl("SELECT count(*) FROM messreihe_ereignis WHERE art = 'late_arrival' AND entity_id = ?",
                IDS.get("F10"))).as("15 Ereignisse, je Viertelstunde eins").isEqualTo(15);
        assertThat(zahl("SELECT count(*) FROM messreihe_korrektur_vorschlag WHERE entity_id = ? AND zustand = 'erledigt'",
                IDS.get("F10"))).isEqualTo(15);
        Korrektur k = vorschlag(KB, "F10");
        assertThat(k.anlage().art()).isEqualTo("nachlieferung_nach_endgueltigkeit");
        assertThat(k.anlage().von()).isEqualTo(VON);
        assertThat(k.anlage().bis()).isEqualTo(BIS);
        assertThat(k.anlage().vorschau()).hasSize(15);
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde_version")).as("keine Version 2").isZero();
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde WHERE version <> 1")).isZero();
    }

    /**
     * <b>Der Unterschied selbst:</b> F9 und F10 sind dieselben Rohwerte — gleiche Messzeiten, gleiche Stände —, nur
     * die Eingangszeit liegt einmal vor und einmal nach der Frist. Und die Zahl, die F9 automatisch bekam, ist genau
     * die, die F10 VORGESCHLAGEN bekommt: beide Wege rechnen dasselbe, nur der eine wendet es an und der andere fragt.
     */
    @Test
    void f9UndF10SindDieselbeNachlieferungUndNurDieFristEntscheidet() {
        String werte = "SELECT string_agg(time::text || '=' || raw_numeric::text, ',' ORDER BY time) "
                + "FROM device_measurement_sample WHERE entity_id = ?";
        assertThat(root.queryForObject(werte, String.class, IDS.get("F9")))
                .isEqualTo(root.queryForObject(werte, String.class, IDS.get("F10")));

        String spaeteste = "SELECT max(received_at) FROM device_measurement_sample WHERE entity_id = ?";
        Instant frist = ViertelstundeRegeln.endgueltigAb(VON);
        assertThat(root.queryForObject(spaeteste, Timestamp.class, IDS.get("F9")).toInstant()).isBefore(frist);
        assertThat(root.queryForObject(spaeteste, Timestamp.class, IDS.get("F10")).toInstant()).isAfter(frist);

        JsonNode vorschau = vorschlag(KB, "F10").anlage().vorschau();
        assertThat(vorschau).hasSize(f9NachDerNachlieferung.size());
        for (int i = 0; i < vorschau.size(); i++) {
            JsonNode neu = vorschau.get(i).path("neu");
            Map<String, Object> f9 = f9NachDerNachlieferung.get(i);
            assertThat(Instant.parse(vorschau.get(i).path("von").asText()))
                    .isEqualTo(((Timestamp) f9.get("intervall_beginn")).toInstant());
            assertThat(new BigDecimal(neu.path("menge").asText())).isEqualByComparingTo((BigDecimal) f9.get("menge"));
            assertThat(neu.path("menge_zustand").asText()).isEqualTo(f9.get("menge_zustand"));
            assertThat(neu.path("erhalten").asInt()).isEqualTo(n(f9.get("erhalten")));
            assertThat(vorschau.get(i).path("aendert").asBoolean()).isTrue();
        }
        assertThat(als(KB, () -> korrekturen.fuerReihe(KB, IDS.get("F9"), KANAL))).isEmpty();
    }

    // ================================================== Nach der Frist ändert sich nichts ohne Freigabe

    /**
     * <b>Die Abnahme von IP-19:</b> nach der Frist ändert sich ohne Freigabe keine Zahl und keine Version. Vom
     * Eintreffen der Nachlieferung F10 (samt RUECK und dem fremden Kundenbereich) über einen abgebrochenen Lauf,
     * die Verdichtung, zwei Stundenläufe und dieselbe Nachlieferung noch einmal trägt JEDE Tabelle außer dem Vorgang
     * selbst (Korrekturen, Erkennung, Ereignisse) und den Laufzuständen Zeichen für Zeichen denselben Inhalt:
     * dieselben Viertelstunden, Versionen, Tage, Monate und Jahre.
     */
    @Test
    void nachDerFristAendertSichOhneFreigabeKeineZahlUndKeineVersion() {
        assertThat(vorDerNachlieferung.get("messreihe_viertelstunde")).isNotEqualTo(Bestandsschutz.LEER);
        assertThat(vorDerNachlieferung.get("messreihe_tag")).isNotEqualTo(Bestandsschutz.LEER);
        assertThat(vorDerNachlieferung.get("messreihe_periode")).isNotEqualTo(Bestandsschutz.LEER);
        assertThat(korrekturenNachDemTakt).as("es ist wirklich etwas passiert").isEqualTo(3);
        assertThat(Bestandsschutz.abweichungen(vorDerNachlieferung, nachAbbruch)).isEmpty();
        assertThat(Bestandsschutz.abweichungen(vorDerNachlieferung, nachDemTakt)).isEmpty();
        assertThat(Bestandsschutz.abweichungen(vorDerNachlieferung, nachAllem)).isEmpty();
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde_version")).isZero();
        assertThat(zahl("SELECT count(*) FROM messreihe_korrektur WHERE fassung > 1")).as("niemand gab frei").isZero();
    }

    /** Der Vergleich beißt: eine geänderte Viertelstunde fällt ihm auf. */
    @Test
    void derBestandsvergleichFaengtEineGeaenderteZeile() {
        Bestandsschutz.mutationsprobe(root, VORGANG, "messreihe_viertelstunde",
                "UPDATE messreihe_viertelstunde SET menge = menge + 1 WHERE menge IS NOT NULL");
    }

    /**
     * Der GRUND eines Eintrags entscheidet nicht über die Frist. Für RUECK standen die 15 Viertelstunden schon als
     * Rückrechnung in der Arbeitsliste, als die Nachlieferung eintraf — ihr Eingang fand den Schlüssel belegt. Die
     * Frist fragt trotzdem: 13 Lücken bleiben ohne Zeile, 15 Meldungen, ein Vorschlag wie bei F10.
     */
    @Test
    void derGrundDerArbeitslisteEntscheidetNichtUeberDieFrist() {
        assertThat(viertelstunden("RUECK")).hasSize(2);
        assertThat(zahl("SELECT count(*) FROM messreihe_ereignis WHERE art = 'late_arrival' AND entity_id = ?",
                IDS.get("RUECK"))).isEqualTo(15);
        Korrektur k = vorschlag(KB, "RUECK");
        assertThat(k.anlage().von()).isEqualTo(VON);
        assertThat(k.anlage().bis()).isEqualTo(BIS);
        assertThat(k.anlage().vorschau()).isEqualTo(vorschlag(KB, "F10").anlage().vorschau());
    }

    /**
     * Der Vorschlag entsteht über den System-Weg von IP-14 — und dort hält die Datenbank fest, dass er nur vorschlagen
     * kann: Fassung 1 von VoltPilot, Status Vorschlag, und eine Freigabe über dieselbe Rolle scheitert am Trigger.
     */
    @Test
    void derVorschlagGehtDurchDenSystemWegDerNurVorschlagenKann() {
        Korrektur k = vorschlag(KB, "F10");
        assertThat(k.fassungen()).extracting(MessreiheFassungen.Fassung::status).containsExactly("vorschlag");
        assertThat(k.ersteller()).isEqualTo(KorrekturVorschlagLauf.SYSTEM);
        PSQLException p = psql(() -> admin.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, "
                + "actor_name, actor_rolle, actor_art) VALUES (?, ?, 2, 'freigegeben', 'VoltPilot', 'voltpilot_betrieb', "
                + "'voltpilot')", KB, k.kennung()));
        assertThat(p.getServerErrorMessage().getConstraint()).as(p.getMessage())
                .isEqualTo("messreihe_korrektur_system_nur_vorschlag");
        assertThat(vorschlag(KB, "F10").status()).isEqualTo("vorschlag");
    }

    // ============================================================== Wiederholbar · abbruchsicher

    /** Die Ruhe von IP-14 gilt auch hier: fünf Minuten nach dem Eingang entsteht noch kein Vorschlag. */
    @Test
    void derStundenlaufWartetDieRuheAb() {
        assertThat(korrekturenZuFrueh).isZero();
        assertThat(meldungenNachDemTakt).as("F10, RUECK, ZF je 15").isEqualTo(45);
    }

    /** Dieselbe Nachlieferung noch einmal in der Liste: keine zweite Meldung, kein zweiter Vorschlag, keine Zahl. */
    @Test
    void einZweiterDurchgangSchreibtNichts() {
        assertThat(korrekturenNochmal).isEqualTo(korrekturenNachDemTakt);
        assertThat(meldungenNochmal).isEqualTo(meldungenNachDemTakt);
        assertThat(Bestandsschutz.abweichungen(nachDemTakt, nachAllem)).isEmpty();
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde_arbeit")).isZero();
    }

    /**
     * Scheitert das Vorschlagen mitten im Stapel, rollt ALLES mit zurück: keine Meldung ohne Erkennung, keine Zeile,
     * und die Einträge stehen wieder in der Arbeitsliste — der nächste Lauf meldet genau einmal.
     */
    @Test
    void einAbgebrochenerLaufHinterlaesstNichtsHalbes() {
        assertThat(abbruchWarf).as("der Abbruch wird nicht verschwiegen").isTrue();
        assertThat(arbeitNachAbbruch).as("die Entnahme rollt mit zurück").isEqualTo(45);
        assertThat(meldungenNachAbbruch).isZero();
        assertThat(erkennungNachAbbruch).isZero();
        assertThat(meldungenNachDemTakt).isEqualTo(45);
    }

    // ============================================================================== F16

    /** F16: am Monatsersten um Mitternacht ist der Oktober vorbei — und trotzdem vorläufig. */
    @Test
    void f16AmMonatserstenIstDerOktoberVorlaeufig() {
        assertThat(oktoberAmMonatsersten.get("zustand")).isEqualTo("vorlaeufig");
        assertThat((BigDecimal) oktoberAmMonatsersten.get("menge")).isEqualByComparingTo("55100.000");
        assertThat(oktoberAmMonatsersten.get("menge_zustand")).isEqualTo("vollständig");
    }

    /**
     * F16: 07.11. 23:59 MEZ — jede Oktober-Viertelstunde ist endgültig bis auf die letzte, 30 von 31 Tagen sind es.
     * Das reicht nicht: EINE vorläufige Viertelstunde hält den Monat vorläufig.
     */
    @Test
    void f16EineEinzigeVorlaeufigeViertelstundeHaeltDenMonatVorlaeufig() {
        assertThat(vorlaeufigeOktoberViertelstundenVorher).containsExactly(LETZTE_OKTOBER_VIERTELSTUNDE);
        assertThat(letzterOktobertagVorher.get("zustand")).isEqualTo("vorlaeufig");
        assertThat(oktoberVorher.get("zustand")).isEqualTo("vorlaeufig");
        assertThat(n(oktoberVorher.get("teile_endgueltig"))).isEqualTo(30);
        assertThat(n(oktoberVorher.get("teile_vorhanden"))).isEqualTo(31);
    }

    /**
     * F16: 08.11. 00:00 MEZ — mit der letzten Viertelstunde (31.10. 23:45–24:00 + 7 Tage) wird ihr Tag endgültig und
     * der Monat mit ihm; seine Frist ist genau die Frist dieser Viertelstunde, und die Menge ist dieselbe geblieben.
     */
    @Test
    void f16MitDerLetztenViertelstundeWirdDerMonatEndgueltig() {
        assertThat(letzterOktobertagNachher.get("zustand")).isEqualTo("endgueltig");
        assertThat(oktoberNachher.get("zustand")).isEqualTo("endgueltig");
        assertThat(n(oktoberNachher.get("teile_endgueltig"))).isEqualTo(31);
        assertThat(((Timestamp) oktoberNachher.get("endgueltig_ab")).toInstant()).isEqualTo(T_F16_GRENZE)
                .isEqualTo(ViertelstundeRegeln.endgueltigAb(LETZTE_OKTOBER_VIERTELSTUNDE));
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde WHERE entity_id = ? AND zustand = 'vorlaeufig' "
                + "AND intervall_beginn >= ? AND intervall_beginn < ?", IDS.get("F16"), ts(OKTOBER_VON), ts(OKTOBER_BIS)))
                .isZero();
        assertThat((BigDecimal) oktoberNachher.get("menge")).isEqualByComparingTo((BigDecimal) oktoberVorher.get("menge"))
                .isEqualByComparingTo(erwartung("f16-", "Monat Oktober 2026").path("menge").decimalValue());
    }

    // ======================================================================== Mandantenzaun

    @Test
    void derMandantenzaunHaelt() {
        assertThat(als(FREMD, () -> app.queryForObject("SELECT count(*) FROM messreihe_korrektur", Integer.class)))
                .isOne();
        assertThat(als(KB, () -> app.queryForObject("SELECT count(*) FROM messreihe_korrektur", Integer.class)))
                .isEqualTo(2);
        assertThat(als(FREMD, () -> app.queryForObject("SELECT count(*) FROM messreihe_korrektur_vorschlag",
                Integer.class))).isEqualTo(15);
        assertThat(als(FREMD, () -> korrekturen.fuerReihe(FREMD, IDS.get("F10"), KANAL))).isEmpty();
        assertThat(als(FREMD, () -> app.queryForObject("SELECT count(*) FROM messreihe_viertelstunde WHERE entity_id = ?",
                Integer.class, IDS.get("F10")))).isZero();
        Korrektur fremd = vorschlag(FREMD, "ZF");
        assertThat(fremd.anlage().vorschau()).isEqualTo(vorschlag(KB, "F10").anlage().vorschau());
        assertThat(root.queryForList("SELECT DISTINCT r->>'entity_id' FROM messreihe_korrektur k, "
                + "jsonb_array_elements(k.reihen) r WHERE k.tenant_id = ?", String.class, FREMD))
                .containsExactly(IDS.get("ZF").toString());
    }

    // ===================================================================================== Gerüst

    /**
     * Der Fünf-Minuten-Takt, so oft, bis Rückrechnung und Arbeitsliste durch sind. (Mit stehender Test-Uhr trägt
     * jeder Takt die Überlappung des Zeigers wieder ein — fertig ist er darum an der leeren Liste, nicht an null.)
     */
    private static void verdichtungstakt(Instant jetzt) {
        for (int i = 0; i < 200; i++) {
            ViertelstundeVerdichter.Lauf l = verdichter.lauf(jetzt);
            if (l.rueckrechnungFertig() && zahl("SELECT count(*) FROM messreihe_viertelstunde_arbeit") == 0) {
                return;
            }
        }
        throw new AssertionError("die Verdichtung wird nicht fertig");
    }

    /** Als stünde für die Viertelstunden der Nachlieferung noch eine Rückrechnung in der Liste. */
    private static void rueckrechnungEintragen(String reihe) {
        root.update("INSERT INTO messreihe_viertelstunde_arbeit (tenant_id, entity_id, messkanal, intervall_beginn, grund) "
                + "SELECT ?, ?, ?, b, 'rueckrechnung' FROM generate_series(?::timestamptz, ?::timestamptz, "
                + "interval '15 minutes') b ON CONFLICT DO NOTHING", KB, IDS.get(reihe), KANAL, ts(VON),
                ts(BIS.minusSeconds(900)));
    }

    private static List<Map<String, Object>> viertelstunden(String reihe) {
        return root.queryForList("SELECT intervall_beginn, menge, menge_zustand, erhalten, version, zustand, kennzeichen::text "
                + "AS kennzeichen, berechnet_am FROM messreihe_viertelstunde WHERE entity_id = ? AND intervall_beginn >= ? "
                + "AND intervall_beginn < ? ORDER BY intervall_beginn", IDS.get(reihe), ts(VON), ts(BIS));
    }

    private static Map<String, Object> tag(String reihe, LocalDate tag) {
        return root.queryForMap("SELECT * FROM messreihe_tag WHERE entity_id = ? AND tag = ?", IDS.get(reihe), tag);
    }

    private static Map<String, Object> periode(String reihe, String art, LocalDate tag) {
        return root.queryForMap("SELECT * FROM messreihe_periode WHERE entity_id = ? AND art = ? AND tag = ?",
                IDS.get(reihe), art, tag);
    }

    private static Korrektur vorschlag(UUID tenant, String reihe) {
        List<Korrektur> k = als(tenant, () -> korrekturen.fuerReihe(tenant, IDS.get(reihe), KANAL));
        assertThat(k).as("genau ein Vorschlag für " + reihe).hasSize(1);
        return k.get(0);
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
        }
        for (String r : List.of("F9", "F10", "RUECK", "F16")) {
            reihe(KB, r);
        }
        reihe(FREMD, "ZF");
    }

    /** Eine Komponente mit eigener Box und dem kWh-Zählerkanal, Kadenz 60 s. */
    private static void reihe(UUID tenant, String name) {
        UUID an = IDS.get("AN:" + tenant);
        UUID box = uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, 'claimed') "
                + "RETURNING id", tenant, an, "VP-BOX-FV-" + name);
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
     * zwei Sekunden nach der Messzeit) oder die mit (die Nachlieferung, mit ihrer Eingangszeit aus dem Vertrag).
     */
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

    private static JsonNode fall(String praefix) throws Exception {
        for (JsonNode c : JSON.readTree(Files.readString(VerbrauchVectorsTest.VECTORS)).path("cases")) {
            if (c.path("name").asText().startsWith(praefix)) {
                return c;
            }
        }
        throw new AssertionError("kein Fall " + praefix);
    }

    private static JsonNode erwartung(String praefix, String name) {
        try {
            for (JsonNode e : fall(praefix).path("expected")) {
                if (name.equals(e.path("name").asText())) {
                    return e;
                }
            }
        } catch (Exception x) {
            throw new IllegalStateException(x);
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
