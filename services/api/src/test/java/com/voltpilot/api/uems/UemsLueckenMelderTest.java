package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.sql.Connection;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Lücken-Melder auf der echten Datenbank (UEMS AP-07 IP-9) — Ahrenberg, Box Halle 2.
 *
 * <p>EINE Zeitachse, in Schritten gefahren ({@link #bauenUndFahren}), die Tests prüfen die
 * festgehaltenen Stände:
 *
 * <ol>
 *   <li><b>A3</b> — Box Halle 2 (E-2) verliert am 03.11.2026 um 14:00 (13:00Z) den Uplink, liest
 *       DQ-4 (K-8.1 → MS-10, K-8.2 → MS-11) und DQ-5 (K-9 → MS-13) weiter und puffert; um 17:30
 *       kommt sie zurück (Kern-Telemetrie), 17:31–17:34 geht der Puffer ein, danach wieder
 *       rechtzeitig. Box Halle 1 (E-1, MS-01) läuft durch.
 *   <li><b>A4</b> — dieselbe Box fällt am 05.11.2026 für acht Tage aus, die Outbox hat die ältesten
 *       drei Tage verdrängt. Seit dem 04.11. gilt für die drei Messstellen die Kadenz 900 s
 *       (Fassung) — die Kante 2 × Kadenz liegt darum bei 30 min, nicht bei 2 min.
 *   <li>Der fremde Kundenbereich hat eine Kern-Box ohne Datenquelle, die ebenfalls schweigt.
 * </ol>
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsLueckenMelderTest {

    private static final String DIESE = "20260913130000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final UUID KB = UUID.fromString("4e0e0000-0000-0000-0000-000000000009");
    private static final UUID FREMD = UUID.fromString("4e0e0000-0000-0000-0000-00000000000a");

    /** Die Tabellen, die dieses Paket beschreibt, und die, in die der Test selbst Werte legt. */
    private static final List<String> AUSNAHMEN =
            List.of("messreihe_%", "device_measurement_sample", "telemetry");

    // --- A3 (03.11.2026, UTC) --------------------------------------------------------------
    private static final Instant A3_BEGINN = Instant.parse("2026-11-03T12:00:00Z");
    /** Letzter Wert vor dem Ausfall: Messzeit 13:59 (Ortszeit), eingegangen 14:00. */
    private static final Instant A3_LETZTER = Instant.parse("2026-11-03T12:59:00Z");
    private static final Instant A3_STILL = Instant.parse("2026-11-03T13:00:00Z");
    private static final Instant A3_RUECKKEHR = Instant.parse("2026-11-03T16:30:00Z");
    private static final Instant A3_PUFFER_VON = Instant.parse("2026-11-03T16:31:00Z");
    private static final Instant A3_PUFFER_BIS = Instant.parse("2026-11-03T16:34:30Z");
    private static final Instant A3_ENDE = Instant.parse("2026-11-03T23:59:00Z");

    // --- A4 (05.–13.11.2026, UTC) ----------------------------------------------------------
    private static final Instant FASSUNG_900 = Instant.parse("2026-11-04T00:00:00Z");
    private static final Instant A4_LETZTER = Instant.parse("2026-11-04T23:45:00Z");
    private static final Instant A4_STILL = Instant.parse("2026-11-05T00:00:00Z");
    private static final Instant A4_PUFFER_AB = Instant.parse("2026-11-08T00:00:00Z");
    private static final Instant A4_RUECKKEHR = Instant.parse("2026-11-13T00:00:00Z");
    private static final Instant A4_PUFFER_VON = Instant.parse("2026-11-13T00:00:30Z");
    private static final Instant A4_PUFFER_BIS = Instant.parse("2026-11-13T00:02:00Z");

    private static final String[] REIHEN = {"K-8.1", "K-8.2", "K-9"};

    /** Ein Loch in K-9 am 04.11., das zwischen zwei Takten entsteht und wieder zugeht. */
    private static final List<Instant> LOCH_K9 = List.of(Instant.parse("2026-11-04T10:15:00Z"),
            Instant.parse("2026-11-04T10:30:00Z"), Instant.parse("2026-11-04T10:45:00Z"));

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final AtomicLong SEQUENZ = new AtomicLong(1);
    private static final Map<String, UUID> IDS = new LinkedHashMap<>();

    private static JdbcTemplate root;
    private static JdbcTemplate admin;
    private static JdbcTemplate app;
    private static LueckenMelder melder;

    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;
    private static Map<String, String> fingerNachAllem;

    /** Momentaufnahmen: jüngste Meldung je Ereignis (Vertragsform) zu einem Schritt. */
    private static final Map<String, List<JsonNode>> STAND = new LinkedHashMap<>();
    private static final Map<String, Integer> ZEILEN = new LinkedHashMap<>();
    private static final Map<String, LueckenMelder.Ergebnis> ERGEBNIS = new LinkedHashMap<>();
    private static int eintragenGesperrt;

    @BeforeAll
    static void bauenUndFahren() throws Exception {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        stammdaten();
        fingerVorher = Bestandsschutz.fingerabdruck(root, AUSNAHMEN);
        flyway().target("20260913130500").load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, AUSNAHMEN);
        flyway().load().migrate();

        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        melder = new LueckenMelder(admin, new MeasurementCatalog(new ObjectMapper()), 50, 40, 20_000);

        fahrenA3();
        fahrenA4();
        fingerNachAllem = Bestandsschutz.fingerabdruck(root, AUSNAHMEN);
    }

    @AfterEach
    void kontextLeeren() {
        TenantContext.clear();
    }

    // ================================================================== Die Zeitachse

    private static void fahrenA3() throws Exception {
        // Vor dem Ausfall: jede Minute ein Wert, eingegangen eine Minute später (ein Umschlag je
        // Minute), die Kern-Telemetrie ebenso; Box Halle 1 läuft den ganzen Tag durch.
        for (String r : REIHEN) {
            werte(r, "E-2", A3_BEGINN, A3_LETZTER, 60, t -> t.plusSeconds(60));
        }
        telemetrie("E-2", A3_BEGINN, A3_LETZTER, 60, t -> t.plusSeconds(60));
        werte("MS-01", "E-1", A3_BEGINN, A3_ENDE, 60, t -> t.plusSeconds(60));
        telemetrie("E-1", A3_BEGINN, A3_ENDE, 60, t -> t.plusSeconds(60));
        // Die fremde Kern-Box schweigt ab 14:00 wie E-2 — sie hat keine Datenquelle.
        telemetrie("F-1", A3_BEGINN, A3_LETZTER, 60, t -> t.plusSeconds(60));
        telemetrie("F-2", A3_BEGINN, A3_LETZTER, 60, t -> t.plusSeconds(60));
        // F-3 schweigt schon drei Tage vor dem ersten Lauf — länger als der Anlauf zurückliest.
        telemetrie("F-3", Instant.parse("2026-10-31T10:00:00Z"), Instant.parse("2026-10-31T11:00:00Z"), 60, t -> t);

        lauf("13:01", Instant.parse("2026-11-03T13:01:00Z"));

        // Sperre mit Überspringen: hält ein anderer (zweiter Melder) die Einheit von K-8.1, prüft
        // dieser Melder die anderen und lässt sie liegen, statt zu warten. Hält er den Zeiger,
        // entfällt der ganze Takt.
        Instant t1305 = Instant.parse("2026-11-03T13:05:00Z");
        melder.eintragen(t1305);
        try (Connection sperre = ds(ADMIN_USER, ADMIN_PW).getConnection()) {
            sperre.setAutoCommit(false);
            try (Statement st = sperre.createStatement()) {
                st.executeQuery("SELECT 1 FROM messreihe_luecke_stand WHERE einheit = 'reihe:"
                        + IDS.get("K-8.1") + ":" + kanal("K-8.1") + "' FOR UPDATE").close();
                ERGEBNIS.put("13:05-gesperrt", melder.pruefen(t1305));
                STAND.put("13:05-gesperrt", juengste());
                ZEILEN.put("13:05-gesperrt", root.queryForObject("SELECT count(*) FROM messreihe_ereignis",
                        Integer.class));
                st.executeQuery("SELECT 1 FROM messreihe_luecke_lauf WHERE schluessel = 'zeiger' FOR UPDATE")
                        .close();
                eintragenGesperrt = melder.eintragen(t1305);
                ERGEBNIS.put("13:05-zeiger-gesperrt", melder.lauf(t1305));
            }
            sperre.rollback();
        }
        // 14:05:00 Ortszeit — genau 300 s nach dem letzten Eingang: die Box meldet sich noch.
        lauf("13:05", Instant.parse("2026-11-03T13:05:00Z"));
        // Ein Abbruch nach dem Eintragen (vor dem Prüfen) und dann der ganze Lauf.
        melder.eintragen(Instant.parse("2026-11-03T13:05:01Z"));
        lauf("13:05:01", Instant.parse("2026-11-03T13:05:01Z"));
        lauf("13:05:01-wieder", Instant.parse("2026-11-03T13:05:01Z"));
        lauf("14:00", Instant.parse("2026-11-03T14:00:00Z"));

        // Rückkehr 17:30: die Kern-Telemetrie zuerst, dann der Puffer (17:31–17:34:30, Messzeit
        // 14:00–17:29 — jeder Wert mehr als 300 s verzögert, also nachgeliefert), dann wieder
        // rechtzeitig.
        telemetrie("E-2", A3_RUECKKEHR, A3_ENDE, 60, t -> t);
        for (String r : REIHEN) {
            puffer(r, "E-2", A3_STILL, A3_RUECKKEHR.minusSeconds(60), 60, A3_PUFFER_VON, A3_PUFFER_BIS);
            werte(r, "E-2", A3_RUECKKEHR, A3_RUECKKEHR.plusSeconds(240), 60,
                    t -> Instant.parse("2026-11-03T16:34:40Z").plusSeconds((t.getEpochSecond()
                            - A3_RUECKKEHR.getEpochSecond()) / 60));
            werte(r, "E-2", A3_RUECKKEHR.plusSeconds(300), A3_ENDE, 60, t -> t.plusSeconds(60));
        }
        lauf("16:40", Instant.parse("2026-11-03T16:40:00Z"));
        lauf("16:40-wieder", Instant.parse("2026-11-03T16:40:00Z"));
        lauf("17:00", Instant.parse("2026-11-03T17:00:00Z"));
    }

    private static void fahrenA4() throws Exception {
        // Der Rest des 03.11. bei 60 s, ab dem 04.11. (Fassung) alle 900 s; E-1 und F-1 schweigen
        // ab hier (ihre Lücken sind nicht Teil dieser Abnahme und werden je Box ausgefiltert).
        for (String r : REIHEN) {
            werte(r, "E-2", A3_ENDE.plusSeconds(60), FASSUNG_900.minusSeconds(60), 60, t -> t.plusSeconds(60));
            werte(r, "E-2", FASSUNG_900, A4_LETZTER, 900, t -> t.plusSeconds(60),
                    r.equals("K-9") ? LOCH_K9 : List.of());
        }
        telemetrie("E-2", A3_ENDE.plusSeconds(60), A4_STILL, 60, t -> t);

        lauf("A4-00:06", Instant.parse("2026-11-05T00:06:00Z"));
        // Genau 2 × 900 s nach dem letzten guten Wert (23:45) — noch keine Lücke.
        lauf("A4-00:15", Instant.parse("2026-11-05T00:15:00Z"));
        lauf("A4-00:15:01", Instant.parse("2026-11-05T00:15:01Z"));
        lauf("A4-06.11.", Instant.parse("2026-11-06T00:00:00Z"));

        // Rückkehr nach acht Tagen: nur die jüngsten fünf Tage sind im Puffer.
        telemetrie("E-2", A4_RUECKKEHR, A4_RUECKKEHR.plusSeconds(1800), 60, t -> t);
        for (String r : REIHEN) {
            puffer(r, "E-2", A4_PUFFER_AB, A4_RUECKKEHR.minusSeconds(900), 900, A4_PUFFER_VON, A4_PUFFER_BIS);
            werte(r, "E-2", A4_RUECKKEHR, A4_RUECKKEHR.plusSeconds(1800), 900, t -> t.plusSeconds(150));
        }
        lauf("A4-13.11.", Instant.parse("2026-11-13T00:10:00Z"));
        lauf("A4-13.11.-wieder", Instant.parse("2026-11-13T00:10:00Z"));
    }

    private static void lauf(String name, Instant jetzt) throws Exception {
        ERGEBNIS.put(name, melder.lauf(jetzt));
        STAND.put(name, juengste());
        ZEILEN.put(name, root.queryForObject("SELECT count(*) FROM messreihe_ereignis", Integer.class));
    }

    // ============================================================== A3: Ausfall 14:00

    @Test
    void a3_dieReiheOeffnetIhreLueckeAbZweiKadenzen_dieBoxErstNachDerToleranz() {
        List<JsonNode> um1305 = STAND.get("13:05");
        assertThat(reihen(um1305, "E-2")).as("drei Reihen, je EINE offene Lücke").hasSize(3)
                .allSatisfy(l -> {
                    assertThat(l.path("von").asText()).isEqualTo("2026-11-03T13:00:00Z");
                    assertThat(l.path("bis").isNull()).isTrue();
                    assertThat(l.path("erkannt_aus").asText()).isEqualTo("kadenz");
                });
        assertThat(boxLuecken(um1305, "E-2")).as("300 s still = die Kante: noch keine Box-Lücke").isEmpty();
        assertThat(quellenLuecken(um1305, "E-2")).isEmpty();
    }

    @Test
    void a3_boxMeldetSichNicht_eineLueckeJeBoxUndJeQuelleStattEinerFlut() {
        List<JsonNode> stand = STAND.get("13:05:01");
        assertThat(boxLuecken(stand, "E-2")).singleElement().satisfies(l -> {
            assertThat(l.path("von").asText()).isEqualTo("2026-11-03T13:00:00Z");
            assertThat(l.path("bis").isNull()).isTrue();
            assertThat(l.path("erkannt_aus").asText()).isEqualTo("herzschlag");
            assertThat(l.path("fehlerklasse").asText()).isEqualTo("box_meldet_sich_nicht");
        });
        assertThat(quellenLuecken(stand, "E-2"))
                .extracting(l -> l.path("datenquelle").asText())
                .containsExactlyInAnyOrder(IDS.get("DQ-4").toString(), IDS.get("DQ-5").toString());
        assertThat(reihen(stand, "E-2")).hasSize(3);
        // Box Halle 1 läuft durch: MS-01 ohne Ereignis.
        assertThat(von(stand, "E-1")).isEmpty();
        // Der Kern-Pfad: die fremde Box ohne Datenquelle bekommt ihre Lücke je Box — und nur die.
        assertThat(meldungenAlsAdmin("F-1")).singleElement().satisfies(l -> {
            assertThat(l.has("datenquelle")).isFalse();
            assertThat(l.path("von").asText()).isEqualTo("2026-11-03T13:00:00Z");
        });
    }

    @Test
    void a3_derZweiteLaufUndDerAbbruchSchreibenNichtsDoppelt() {
        assertThat(ZEILEN.get("13:05:01-wieder")).isEqualTo(ZEILEN.get("13:05:01"));
        assertThat(ZEILEN.get("14:00")).isEqualTo(ZEILEN.get("13:05:01"));
        assertThat(ZEILEN.get("16:40-wieder")).isEqualTo(ZEILEN.get("16:40"));
        assertThat(ZEILEN.get("17:00")).isEqualTo(ZEILEN.get("16:40"));
        assertThat(ZEILEN.get("A4-13.11.-wieder")).isEqualTo(ZEILEN.get("A4-13.11."));
        assertThat(ERGEBNIS.get("13:05:01-wieder").geoeffnet()).isZero();
        assertThat(ERGEBNIS.get("16:40-wieder").geschlossen()).isZero();
        assertThat(ERGEBNIS.values()).allSatisfy(e -> assertThat(e.verworfen()).as(e.toString()).isZero());
        // Der Abbruch nach dem Eintragen hat nichts verloren: der Lauf danach öffnete genau die Box
        // und ihre zwei Quellen (plus die zwei fremden Boxen, F-2 mit ihrer Quelle).
        assertThat(ERGEBNIS.get("13:05:01").geoeffnet()).isEqualTo(6);
        // Je Ereignis höchstens zwei Meldungen: öffnen und schließen (plus eine Nachlieferung).
        assertThat(root.queryForList("SELECT count(*) FROM messreihe_ereignis GROUP BY ereignis_id "
                + "HAVING count(*) > 2", Long.class)).isEmpty();
    }

    @Test
    void a3_entnahmeUnterSperreUeberspringtStattZuWarten() {
        assertThat(eintragenGesperrt).as("Zeiger gehalten → Eintragen übersprungen").isEqualTo(-1);
        assertThat(ERGEBNIS.get("13:05-zeiger-gesperrt")).as("… und der ganze Takt")
                .isEqualTo(new LueckenMelder.Ergebnis(0, 0, 0, 0, 0, 0, 0));
        assertThat(reihen(STAND.get("13:05-gesperrt"), "E-2"))
                .extracting(l -> l.path("komponente").asText())
                .containsExactlyInAnyOrder(IDS.get("K-8.2").toString(), IDS.get("K-9").toString());
        assertThat(reihen(STAND.get("13:05"), "E-2")).hasSize(3);
    }

    @Test
    void a3_rueckkehrUndNachlieferungSchliessenDieLuecken() {
        List<JsonNode> stand = STAND.get("16:40");
        assertThat(boxLuecken(stand, "E-2")).singleElement().satisfies(l -> {
            assertThat(l.path("bis").asText()).as("Rückkehr 17:30").isEqualTo("2026-11-03T16:30:00Z");
            assertThat(l.path("nachgeliefert_am").asText()).isEqualTo("2026-11-03T16:31:00Z");
        });
        assertThat(quellenLuecken(stand, "E-2")).hasSize(2).allSatisfy(l -> {
            assertThat(l.path("bis").asText()).isEqualTo("2026-11-03T16:30:00Z");
            assertThat(l.path("nachgeliefert_am").asText()).isEqualTo("2026-11-03T16:31:00Z");
        });
        assertThat(reihen(stand, "E-2")).hasSize(3).allSatisfy(l -> {
            assertThat(l.path("von").asText()).isEqualTo("2026-11-03T13:00:00Z");
            assertThat(l.path("bis").asText()).isEqualTo("2026-11-03T16:30:00Z");
            assertThat(l.path("erwartet_fehlend").asLong()).isEqualTo(210);
            assertThat(l.path("nachgeliefert_am").asText()).isEqualTo("2026-11-03T16:31:00Z");
        });
        // MS-10 trägt ihre Messstelle und Datenquelle im Bezug.
        assertThat(reihen(stand, "E-2")).filteredOn(l -> l.path("komponente").asText()
                .equals(IDS.get("K-8.1").toString())).singleElement().satisfies(l -> {
                    assertThat(l.path("messstelle").asText()).isEqualTo(IDS.get("MS-10").toString());
                    assertThat(l.path("datenquelle").asText()).isEqualTo(IDS.get("DQ-4").toString());
                });
        // Die Lücke bleibt als Ereignis stehen — die erste Meldung (offen) ist weiter lesbar.
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE device_id = ? "
                + "AND art = 'data_gap' AND bis IS NULL AND zeit = ?", Integer.class,
                IDS.get("E-2"), Timestamp.from(A3_STILL))).isEqualTo(6);
        assertThat(von(stand, "E-1")).isEmpty();
    }

    @Test
    void a3_eineNachlieferungJeBoxUndQuelle() {
        List<JsonNode> backfill = art(STAND.get("16:40"), "backfill");
        assertThat(backfill).hasSize(2);
        assertThat(backfill).filteredOn(b -> b.path("datenquelle").asText().equals(IDS.get("DQ-4").toString()))
                .singleElement().satisfies(b -> {
                    assertThat(b.path("box").asText()).isEqualTo(IDS.get("E-2").toString());
                    assertThat(b.path("von").asText()).isEqualTo("2026-11-03T13:00:00Z");
                    assertThat(b.path("bis").asText()).isEqualTo("2026-11-03T16:29:00Z");
                    assertThat(b.path("eingang_von").asText()).isEqualTo("2026-11-03T16:31:00Z");
                    assertThat(b.path("eingang_bis").asText()).isEqualTo("2026-11-03T16:34:30Z");
                    assertThat(b.path("anzahl").asLong()).as("zwei Reihen × 210").isEqualTo(420);
                    assertThat(b.path("erwartet").asLong()).as("vollständig").isEqualTo(420);
                });
        assertThat(backfill).filteredOn(b -> b.path("datenquelle").asText().equals(IDS.get("DQ-5").toString()))
                .singleElement().satisfies(b -> {
                    assertThat(b.path("anzahl").asLong()).isEqualTo(210);
                    assertThat(b.path("erwartet").asLong()).isEqualTo(210);
                });
    }

    // ============================================================== A4: acht Tage, verdrängt

    @Test
    void kadenzZumZeitpunkt_dieKanteLiegtBeiZweiMal900Sekunden() {
        assertThat(boxLuecken(STAND.get("A4-00:06"), "E-2"))
                .filteredOn(l -> l.path("von").asText().equals("2026-11-05T00:00:00Z")).hasSize(1);
        assertThat(neueReihenluecken("A4-00:06")).as("21 min: bei 60 s längst eine Lücke, bei 900 s nicht")
                .isEmpty();
        assertThat(neueReihenluecken("A4-00:15")).as("genau 2 × 900 s").isEmpty();
        assertThat(neueReihenluecken("A4-00:15:01")).hasSize(3).allSatisfy(l ->
                assertThat(l.path("von").asText()).as("23:45 + 900 s").isEqualTo("2026-11-05T00:00:00Z"));
    }

    @Test
    void eineReiheLiefertDatenUndHatZugleichEineOffeneLuecke() {
        // Der jüngste gute Wert von MS-10 und die Kadenz zum Zeitpunkt aus der Datenbank.
        Instant letzter = root.queryForObject("SELECT max(time) FROM device_measurement_sample WHERE "
                + "entity_id = ? AND time < ?", Timestamp.class, IDS.get("K-8.1"),
                Timestamp.from(A4_STILL)).toInstant();
        int kadenz = root.queryForObject("SELECT k.erwartet_s FROM quelle_kadenz k JOIN messstelle_quelle q "
                + "ON q.id = k.messstelle_quelle_id WHERE q.messstelle_id = ? AND k.gueltig_ab <= ? "
                + "AND (k.gueltig_bis IS NULL OR k.gueltig_bis > ?)", Integer.class, IDS.get("MS-10"),
                Timestamp.from(letzter), Timestamp.from(letzter));
        Instant jetzt = Instant.parse("2026-11-05T00:15:01Z");
        assertThat(ZustandAbleitung.liefertDaten(new ZustandAbleitung.LiefertDatenEingang(true, letzter,
                false, kadenz, jetzt, ZustandAbleitung.VORGABE_ZEITZONE)).zustand())
                .isEqualTo(ZustandAbleitung.LiefertDaten.LIEFERT);
        assertThat(neueReihenluecken("A4-00:15:01"))
                .filteredOn(l -> l.path("messstelle").asText().equals(IDS.get("MS-10").toString()))
                .singleElement().satisfies(l -> assertThat(l.path("bis").isNull()).isTrue());
    }

    @Test
    void a4_unvollstaendigeNachlieferung_dieZaehlungNenntDenVerdraengtenTeil() {
        List<JsonNode> stand = STAND.get("A4-13.11.");
        // ⚠ Die Lücke der REIHE endet nicht bei der Rückkehr der Box: die jüngsten Werte des Puffers
        // (23:30, 23:45) gingen innerhalb von max(300 s, 3 × 900 s) ein und sind nach dem Writer
        // RECHTZEITIG (MesswertHerkunft) — die Lücke ist der Zeitraum ohne rechtzeitigen Wert.
        assertThat(reihen(stand, "E-2")).filteredOn(l -> l.path("von").asText().equals("2026-11-05T00:00:00Z"))
                .hasSize(3).allSatisfy(l -> {
                    assertThat(l.path("bis").asText()).isEqualTo("2026-11-12T23:30:00Z");
                    assertThat(l.path("erwartet_fehlend").asLong()).as("8 Tage × 96 − 2").isEqualTo(766);
                    assertThat(l.path("nachgeliefert_am").asText()).isEqualTo("2026-11-13T00:00:30Z");
                });
        List<JsonNode> wellen = art(stand, "backfill").stream()
                .filter(b -> b.path("von").asText().startsWith("2026-11-08")).toList();
        assertThat(wellen).hasSize(2);
        assertThat(wellen).filteredOn(b -> b.path("datenquelle").asText().equals(IDS.get("DQ-4").toString()))
                .singleElement().satisfies(b -> {
                    assertThat(b.path("anzahl").asLong()).as("zwei Reihen × (5 Tage × 96 − 2 rechtzeitige)")
                            .isEqualTo(956);
                    assertThat(b.path("erwartet").asLong()).as("zwei Reihen × 766 — die verdrängten drei Tage "
                            + "fehlen in der Anzahl, nicht in der Erwartung").isEqualTo(1532);
                    assertThat(b.path("anzahl").asLong()).isLessThan(b.path("erwartet").asLong());
                    assertThat(b.path("bis").asText()).isEqualTo("2026-11-12T23:15:00Z");
                });
        assertThat(boxLuecken(stand, "E-2")).filteredOn(l -> l.path("von").asText().equals("2026-11-05T00:00:00Z"))
                .singleElement().satisfies(l -> {
                    assertThat(l.path("bis").asText()).isEqualTo("2026-11-13T00:00:00Z");
                    assertThat(l.path("nachgeliefert_am").asText()).isEqualTo("2026-11-13T00:00:30Z");
                });
        // Keine zweite A3-Nachlieferung in dieser Welle: je Box wird nur Ungemeldetes gezählt.
        assertThat(art(stand, "backfill")).hasSize(4);
    }

    /** Ein Loch, das zwischen zwei Takten entstand und wieder zu ist: geschlossen gemeldet, gezählt. */
    @Test
    void einLochZwischenZweiTaktenWirdGeschlossenGemeldet() {
        assertThat(reihen(STAND.get("A4-00:06"), "E-2"))
                .filteredOn(l -> l.path("komponente").asText().equals(IDS.get("K-9").toString())
                        && l.path("von").asText().equals("2026-11-04T10:15:00Z"))
                .singleElement().satisfies(l -> {
                    assertThat(l.path("bis").asText()).as("der nächste gute Wert").isEqualTo("2026-11-04T11:00:00Z");
                    assertThat(l.path("erwartet_fehlend").asLong()).as("10:15, 10:30, 10:45").isEqualTo(3);
                    assertThat(l.has("nachgeliefert_am")).isFalse();
                    assertThat(l.path("datenquelle").asText()).isEqualTo(IDS.get("DQ-5").toString());
                });
        // Die anderen Reihen hatten kein Loch — und K-9 nur dieses eine.
        assertThat(reihen(STAND.get("A4-00:06"), "E-2")).filteredOn(l -> l.path("von").asText().startsWith("2026-11-04"))
                .hasSize(1);
    }

    /** Eine Box, die schon vor dem ersten Lauf schwieg, bekommt ihre Lücke — ab ihrem letzten Eingang. */
    @Test
    void eineLangeSchweigendeBoxWirdBeimErstenLaufErkannt() {
        assertThat(boxLuecken(STAND.get("13:01"), "F-3")).singleElement().satisfies(l -> {
            assertThat(l.path("von").asText()).isEqualTo("2026-10-31T11:00:00Z");
            assertThat(l.path("bis").isNull()).isTrue();
        });
        assertThat(ERGEBNIS.get("13:01").geoeffnet()).isEqualTo(1);
    }

    /** Box-Tausch: die Lücke der Quelle endet mit der Zuständigkeit — ohne Nachlieferung; die Box bleibt offen. */
    @Test
    void boxTausch_dieQuellenLueckeEndetMitDerZustaendigkeit() {
        List<JsonNode> stand = STAND.get("16:40");
        assertThat(quellenLuecken(stand, "F-2")).singleElement().satisfies(l -> {
            assertThat(l.path("von").asText()).isEqualTo("2026-11-03T13:00:00Z");
            assertThat(l.path("bis").asText()).isEqualTo("2026-11-03T15:00:00Z");
            assertThat(l.has("nachgeliefert_am")).isFalse();
        });
        assertThat(boxLuecken(stand, "F-2")).singleElement()
                .satisfies(l -> assertThat(l.path("bis").isNull()).isTrue());
        assertThat(quellenLuecken(STAND.get("14:00"), "F-2")).singleElement()
                .as("vor dem Ende der Zuständigkeit noch offen")
                .satisfies(l -> assertThat(l.path("bis").isNull()).isTrue());
    }

    // ============================================================== Zaun, Rechte, Bestand

    @Test
    void mandantenzaun() {
        TenantContext.set(KB);
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE device_id = ?",
                Integer.class, IDS.get("F-1"))).isZero();
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE device_id = ?",
                Integer.class, IDS.get("E-2"))).isPositive();
        TenantContext.set(FREMD);
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_ereignis", Integer.class))
                .isEqualTo(root.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE tenant_id = ?",
                        Integer.class, FREMD)).isPositive();
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_ereignis e JOIN device d ON d.id = e.device_id "
                + "WHERE e.tenant_id <> d.tenant_id", Integer.class)).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_luecke_stand s JOIN device d ON d.id = s.device_id "
                + "WHERE s.tenant_id <> d.tenant_id", Integer.class)).isZero();
        // Der Arbeitsstand gehört nur dem Melder.
        assertThatThrownBy(() -> app.queryForObject("SELECT count(*) FROM messreihe_luecke_stand", Integer.class))
                .rootCause().hasMessageContaining("permission denied");
        assertThat(root.queryForObject("SELECT relforcerowsecurity FROM pg_class WHERE relname = "
                + "'messreihe_luecke_stand'", Boolean.class)).isTrue();
    }

    @Test
    void bestandsschutz_nurDieEigenenTabellen() {
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).as("die Migration").isEmpty();
        assertThat(Bestandsschutz.abweichungen(fingerNachMigration, fingerNachAllem)).as("alle Läufe").isEmpty();
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE urheber <> 'cloud' "
                + "OR aus_bestand", Integer.class)).isZero();
        Bestandsschutz.mutationsprobe(root, AUSNAHMEN, "measurement_point",
                "UPDATE measurement_point SET label = label || ' (Probe)'");
    }

    @Test
    void jedeMeldungStehtImVokabular() {
        for (JsonNode m : alleMeldungen()) {
            assertThat(EreignisVokabular.pruefe(m, EreignisVokabular.Urheber.CLOUD).angenommen())
                    .as(m.toString()).isTrue();
        }
        assertThat(root.queryForObject("SELECT array_to_string(urheber, ',') FROM messreihe_ereignis_vokabular() "
                + "WHERE art = 'backfill'", String.class)).isEqualTo("writer,cloud");
    }

    @Test
    void offboardingRaeumtDenArbeitsstand() {
        UUID abgang = UUID.randomUUID();
        UUID box = UUID.randomUUID();
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Abgang')", abgang);
        root.update("INSERT INTO messreihe_luecke_stand (tenant_id, einheit, art, device_id, zuletzt, luecke_seit, "
                + "faellig_ab) VALUES (?, ?, 'box', ?, now(), now(), now())", abgang, "box:" + box, box);
        new com.voltpilot.api.repo.TenantRepository(admin).offboard(abgang);
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_luecke_stand WHERE tenant_id = ?",
                Integer.class, abgang)).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_luecke_lauf", Integer.class))
                .as("der Zeiger ist nicht mandantengebunden und bleibt").isOne();
    }

    // ================================================================== Stammdaten

    private static void stammdaten() {
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH')", KB);
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kundenbereich B')", FREMD);
        IDS.put("AN-1", uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-1 Halle 1') RETURNING id", KB));
        IDS.put("AN-2", uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-2 Halle 2') RETURNING id", KB));
        IDS.put("B-1", uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'B-1') RETURNING id", FREMD));
        IDS.put("E-1", box(KB, "AN-1", "VP-BOX-HALLE-1"));
        IDS.put("E-2", box(KB, "AN-2", "VP-BOX-2026-0482"));
        IDS.put("F-1", box(FREMD, "B-1", "VP-BOX-FREMD-1"));
        IDS.put("F-2", box(FREMD, "B-1", "VP-BOX-FREMD-2"));
        IDS.put("F-3", box(FREMD, "B-1", "VP-BOX-FREMD-3"));
        // Der Box-Tausch im fremden Kundenbereich: F-2 ist für DQ-1 zuständig bis 16:00 (15:00Z).
        IDS.put("DQ-1-F", uuid("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, adresse, kadenz_s) "
                + "VALUES (?, ?, 'DQ-1', 'modbus_tcp', '10.9.0.1:502', 60) RETURNING id", FREMD, IDS.get("B-1")));
        root.update("INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, protokoll, adresse, "
                + "effective_from, effective_to) VALUES (?, ?, ?, 'modbus_tcp', '10.9.0.1:502', "
                + "'2026-10-01T00:00:00Z', '2026-11-03T15:00:00Z')", FREMD, IDS.get("DQ-1-F"), IDS.get("F-2"));

        for (String[] dq : new String[][] {{"DQ-4", "192.168.20.10:502"}, {"DQ-5", "192.168.20.11:502"}}) {
            IDS.put(dq[0], uuid("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, adresse, "
                    + "kadenz_s) VALUES (?, ?, ?, 'modbus_tcp', ?, 60) RETURNING id", KB, IDS.get("AN-2"), dq[0], dq[1]));
            root.update("INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, protokoll, "
                    + "adresse, effective_from) VALUES (?, ?, ?, 'modbus_tcp', ?, '2026-10-01T00:00:00Z')",
                    KB, IDS.get(dq[0]), IDS.get("E-2"), dq[1]);
        }
        komponente("MS-01", "AN-1", "E-1", null);
        komponente("K-8.1", "AN-2", "E-2", "DQ-4");
        komponente("K-8.2", "AN-2", "E-2", "DQ-4");
        komponente("K-9", "AN-2", "E-2", "DQ-5");
        // Die Messstellen MS-10/MS-11/MS-13 lesen die drei Reihen; ihre Kadenz ist bis zum 04.11.
        // 60 s, danach 900 s (Fassungen, E9).
        String[][] ms = {{"MS-10", "MS-0010", "K-8.1"}, {"MS-11", "MS-0011", "K-8.2"}, {"MS-13", "MS-0013", "K-9"}};
        for (String[] m : ms) {
            UUID messstelle = uuid("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                    + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', "
                    + "'kWh', 'Zählerstand') RETURNING id", KB, m[1], m[0]);
            IDS.put(m[0], messstelle);
            UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                    + "AND gueltig_bis IS NULL", UUID.class, IDS.get(m[2]));
            UUID bindung = uuid("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, "
                    + "entity_id, geraet_id, kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, "
                    + "eingetragen_am, actor_sub, actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', 'Bezug', ?, ?, "
                    + "?, 'counter', 'zaehlerstand', 'fuehrend', '2024-03-12T00:00:00Z', false, now(), 'sub', "
                    + "'Probe', 'kunde') RETURNING id", KB, messstelle, IDS.get(m[2]), geraet, kanal(m[2]));
            root.update("INSERT INTO quelle_kadenz (tenant_id, messstelle_quelle_id, erwartet_s, herkunft, gueltig_ab, "
                    + "gueltig_bis, rueckwirkend, actor_sub, actor_name, actor_art) VALUES (?, ?, 60, 'eintrag', "
                    + "'2024-03-12T00:00:00Z', ?, false, 'sub', 'Probe', 'kunde')", KB, bindung, Timestamp.from(FASSUNG_900));
            root.update("INSERT INTO quelle_kadenz (tenant_id, messstelle_quelle_id, erwartet_s, herkunft, gueltig_ab, "
                    + "rueckwirkend, actor_sub, actor_name, actor_art) VALUES (?, ?, 900, 'eintrag', ?, false, 'sub', "
                    + "'Probe', 'kunde')", KB, bindung, Timestamp.from(FASSUNG_900));
        }
    }

    private static UUID box(UUID tenant, String site, String ref) {
        return uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, 'claimed') "
                + "RETURNING id", tenant, IDS.get(site), ref);
    }

    private static void komponente(String name, String site, String box, String dq) {
        UUID entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, "
                + "communication, connection_json, created_at) VALUES (?, ?, 'grid-meter', ?, 'grid-meter', ?, "
                + "'modbus_tcp', '{\"ip\":\"192.168.20.10\",\"unit_id\":1}'::jsonb, '2024-03-12T00:00:00Z') "
                + "RETURNING id", KB, IDS.get(site), name, IDS.get(box));
        IDS.put(name, entity);
        if (dq != null) {
            root.update("UPDATE measurement_point SET data_source_id = ? WHERE id = ?", IDS.get(dq), entity);
        }
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, "
                + "'2024-03-12T00:00:00Z', '2026.09.11.1', 'test', 'pending_edge', 'live_power', 'fifteen_minute')",
                KB, IDS.get(site), IDS.get(box), entity, kanal(name));
    }

    private static String kanal(String name) {
        return "energy_kwh_" + name.toLowerCase().replace("-", "").replace(".", "");
    }

    // ================================================================== Werte

    @FunctionalInterface
    private interface Eingang {
        Instant von(Instant messzeit);
    }

    private static final String PROBE = "INSERT INTO device_measurement_sample (time, received_at, tenant_id, "
            + "site_id, device_id, point_key, raw_numeric, quality, catalog_version, edge_sequence, "
            + "aggregation_kind, entity_id, applied_revision, value_kind, role, delivery, delay_s) "
            + "VALUES (?, ?, ?, ?, ?, ?, ?, 'good', '2026.09.11.1', ?, 'counter', ?, 1, 'counter', 'fuehrend', ?, ?)";

    private static void werte(String reihe, String box, Instant von, Instant bis, long schrittS, Eingang eingang) {
        werte(reihe, box, von, bis, schrittS, eingang, List.of());
    }

    private static void werte(String reihe, String box, Instant von, Instant bis, long schrittS, Eingang eingang,
            List<Instant> fehlen) {
        List<Object[]> stapel = new ArrayList<>();
        for (Instant t = von; !t.isAfter(bis); t = t.plusSeconds(schrittS)) {
            if (!fehlen.contains(t)) {
                stapel.add(probe(reihe, box, t, eingang.von(t)));
            }
        }
        root.batchUpdate(PROBE, stapel);
    }

    /** Der Puffer: Messzeiten {@code von … bis}, gleichmäßig über das Eingangsfenster verteilt. */
    private static void puffer(String reihe, String box, Instant von, Instant bis, long schrittS,
            Instant eingangVon, Instant eingangBis) {
        long n = (bis.getEpochSecond() - von.getEpochSecond()) / schrittS;
        long fenster = eingangBis.getEpochSecond() - eingangVon.getEpochSecond();
        List<Object[]> stapel = new ArrayList<>();
        for (long i = 0; i <= n; i++) {
            Instant t = von.plusSeconds(i * schrittS);
            stapel.add(probe(reihe, box, t, eingangVon.plusSeconds(n == 0 ? 0 : i * fenster / n)));
        }
        root.batchUpdate(PROBE, stapel);
    }

    private static Object[] probe(String reihe, String box, Instant messzeit, Instant eingang) {
        long verzoegerung = eingang.getEpochSecond() - messzeit.getEpochSecond();
        UUID site = root.queryForObject("SELECT site_id FROM device WHERE id = ?", UUID.class, IDS.get(box));
        // Die Zustellart setzt in Wahrheit der Writer: nachgeliefert ab max(300 s, 3 × Kadenz).
        long kadenz = messzeit.isBefore(FASSUNG_900) ? 60 : 900;
        String zustellung = verzoegerung > Math.max(300, 3 * kadenz) ? "nachgeliefert" : "direkt";
        return new Object[] {Timestamp.from(messzeit), Timestamp.from(eingang), KB, site, IDS.get(box),
            kanal(reihe), messzeit.getEpochSecond() / 60, SEQUENZ.getAndIncrement(), IDS.get(reihe),
            zustellung, verzoegerung};
    }

    private static void telemetrie(String box, Instant von, Instant bis, long schrittS, Eingang eingang) {
        List<Object[]> stapel = new ArrayList<>();
        UUID tenant = root.queryForObject("SELECT tenant_id FROM device WHERE id = ?", UUID.class, IDS.get(box));
        UUID site = root.queryForObject("SELECT site_id FROM device WHERE id = ?", UUID.class, IDS.get(box));
        for (Instant t = von; !t.isAfter(bis); t = t.plusSeconds(schrittS)) {
            stapel.add(new Object[] {Timestamp.from(t), Timestamp.from(eingang.von(t)), tenant, site, IDS.get(box)});
        }
        root.batchUpdate("INSERT INTO telemetry (time, received_at, tenant_id, site_id, device_id, power_kw, payload) "
                + "VALUES (?, ?, ?, ?, ?, 1.0, '{}'::jsonb)", stapel);
    }

    // ================================================================== Lesen

    /** Je Ereignis die jüngste Meldung, in der Form des Vertrags (plus Mandant und Box-Spalte). */
    private static List<JsonNode> juengste() {
        return root.query("SELECT DISTINCT ON (ereignis_id) ereignis_id, art, von, bis, kennungen::text AS k, "
                + "messkanal, nutzlast::text AS n FROM messreihe_ereignis ORDER BY ereignis_id, eingang DESC, "
                + "(bis IS NULL), jsonb_exists(nutzlast, 'nachgeliefert_am') DESC", (rs, i) -> {
                    var e = JSON.createObjectNode();
                    e.put("ereignis_id", rs.getString("ereignis_id"));
                    e.put("art", rs.getString("art"));
                    e.put("von", rs.getTimestamp("von").toInstant().toString());
                    if (rs.getTimestamp("bis") == null) {
                        e.putNull("bis");
                    } else {
                        e.put("bis", rs.getTimestamp("bis").toInstant().toString());
                    }
                    try {
                        e.setAll((com.fasterxml.jackson.databind.node.ObjectNode) JSON.readTree(rs.getString("k")));
                        if (rs.getString("messkanal") != null) {
                            e.put("messkanal", rs.getString("messkanal"));
                        }
                        e.setAll((com.fasterxml.jackson.databind.node.ObjectNode) JSON.readTree(rs.getString("n")));
                    } catch (Exception ex) {
                        throw new IllegalStateException(ex);
                    }
                    return (JsonNode) e;
                });
    }

    private static List<JsonNode> alleMeldungen() {
        return root.query("SELECT ereignis_id, art, von, bis, kennungen::text AS k, messkanal, nutzlast::text AS n "
                + "FROM messreihe_ereignis", (rs, i) -> {
                    var e = JSON.createObjectNode();
                    e.put("ereignis_id", rs.getString("ereignis_id"));
                    e.put("art", rs.getString("art"));
                    e.put("von", rs.getTimestamp("von").toInstant().toString());
                    if (rs.getTimestamp("bis") == null) {
                        e.putNull("bis");
                    } else {
                        e.put("bis", rs.getTimestamp("bis").toInstant().toString());
                    }
                    try {
                        e.setAll((com.fasterxml.jackson.databind.node.ObjectNode) JSON.readTree(rs.getString("k")));
                        if (rs.getString("messkanal") != null) {
                            e.put("messkanal", rs.getString("messkanal"));
                        }
                        e.setAll((com.fasterxml.jackson.databind.node.ObjectNode) JSON.readTree(rs.getString("n")));
                    } catch (Exception ex) {
                        throw new IllegalStateException(ex);
                    }
                    return (JsonNode) e;
                });
    }

    private static List<JsonNode> von(List<JsonNode> stand, String box) {
        return stand.stream().filter(e -> e.path("box").asText().equals(IDS.get(box).toString())).toList();
    }

    private static List<JsonNode> art(List<JsonNode> stand, String art) {
        return stand.stream().filter(e -> e.path("art").asText().equals(art)).toList();
    }

    private static List<JsonNode> boxLuecken(List<JsonNode> stand, String box) {
        return von(stand, box).stream().filter(e -> e.path("art").asText().equals("data_gap")
                && !e.has("datenquelle") && !e.has("komponente")).toList();
    }

    private static List<JsonNode> quellenLuecken(List<JsonNode> stand, String box) {
        return von(stand, box).stream().filter(e -> e.path("art").asText().equals("data_gap")
                && e.has("datenquelle") && !e.has("komponente")).toList();
    }

    private static List<JsonNode> reihen(List<JsonNode> stand, String box) {
        return von(stand, box).stream().filter(e -> e.path("art").asText().equals("data_gap")
                && e.has("komponente")).toList();
    }

    /** Die OFFENEN Reihen-Lücken, die es in diesem Schritt gibt, aber im Schritt davor nicht gab. */
    private static List<JsonNode> neueReihenluecken(String schritt) {
        List<String> namen = new ArrayList<>(STAND.keySet());
        List<JsonNode> vorher = STAND.get(namen.get(namen.indexOf(schritt) - 1));
        List<String> alt = vorher.stream().map(e -> e.path("ereignis_id").asText()).toList();
        return reihen(STAND.get(schritt), "E-2").stream()
                .filter(e -> e.path("bis").isNull())
                .filter(e -> !alt.contains(e.path("ereignis_id").asText())).toList();
    }

    private static List<JsonNode> meldungenAlsAdmin(String box) {
        return von(STAND.get("13:05:01"), box);
    }

    // ================================================================== Infrastruktur

    private static UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
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
