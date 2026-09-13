package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.EreignisVokabular.Urheber;
import com.voltpilot.api.uems.MessreiheErsatzwertRepository.Anlage;
import com.voltpilot.api.uems.VerbrauchRegeln.Rohwert;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.ZoneId;
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
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Ersatzwert-Methoden über die Datenbank (UEMS AP-08 IP-13): Migration {@code V20260913210000} und
 * {@link ErsatzwertLauf} gegen eine echte TimescaleDB, an ECHTEN Lücken — Rohwerte, Verdichtung (Version 1),
 * die geprüfte {@code data_gap}-Meldung mit ihrem gemessenen Zuwachs, Ersatzwerte über den Schreibweg der
 * App-Rolle.
 *
 * <p>EINE Zeitachse an der Reihe von F11 (MS-10, Box-Tausch Halle 2, 1 872,0 kWh über 78 Viertelstunden):
 * Methode a → Version 2 · ein zweiter Lauf schreibt nichts · der Widerruf allein → Version 3 mit den Zahlen von
 * Version 1 · Methode c aus dem Lastgang → Version 4, vom Bestand aus · Methode b, solange c gilt → benannt
 * abgelehnt · c zurückgenommen → b gilt, Version 5 mit Rundungsrest. Dazu an einer zweiten Reihe d, e, f, g
 * und die benannten Ablehnungen (nie ein stiller Rückfall), der Mandantenzaun, ein Abbruch ohne Rest, die
 * Invariante „Summe = gemessener Zuwachs“ als Summe der GESPEICHERTEN Anteile, append-only und lückenlos, das
 * Offboarding und der Bestandsschutz. Jede Zahl ist die der Rechenregel — der Test rechnet sie über
 * {@link VerbrauchRegeln} nach, nie von Hand im Lauf.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsErsatzwertMethodenTest {

    private static final String DIESE = "20260913210000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Ein Zählerstand in kWh aus dem ausgelieferten Katalog. */
    private static final String KANAL = "deye.hybrid_1p.meter.generator-energy";

    private static final UUID KB = UUID.fromString("4e0e0000-0000-0000-0000-000000000013");
    private static final UUID FREMD = UUID.fromString("4e0e0000-0000-0000-0000-000000000014");

    /** F11: der letzte Wert vor der Lücke 14:00 MEZ, der erste danach 04.11. 09:30 MEZ. */
    private static final Instant F11_LUECKE_VON = Instant.parse("2026-11-03T13:01:00Z");
    private static final Instant F11_LUECKE_BIS = Instant.parse("2026-11-04T08:30:00Z");
    private static final Instant F11_EW_VON = Instant.parse("2026-11-03T13:00:00Z");
    private static final BigDecimal F11_ZUWACHS = new BigDecimal("1872.0");

    /** Die zweite Reihe (10.11.): 1 kWh je Minute ab 08:00 UTC = 1 000, Lücke 09:00 → 10:00 (60 kWh). */
    private static final Instant Z2_LUECKE_VON = Instant.parse("2026-11-10T09:01:00Z");
    private static final Instant Z2_LUECKE_BIS = Instant.parse("2026-11-10T10:00:00Z");

    private static final Instant JETZT = Instant.parse("2026-11-12T00:00:00Z");
    private static final ProtokollAkteur INES = new ProtokollAkteur("kc-ines-kaltenbach", "Ines Kaltenbach",
            "energiemanager", "kunde");
    private static final String BEGRUENDUNG = "Box-Tausch nach Defekt; Energiekarte hat weitergezählt";

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
    private static MessreiheErsatzwertRepository ersatzwerte;
    private static ErsatzwertLauf lauf;

    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;
    private static String viertelstundenNachVerdichtung;

    // Die Zeitachse, festgehalten je Schritt.
    private static boolean abbruchWarf;
    private static int versionenNachAbbruch;
    private static ErsatzwertLauf.Lauf laufA;
    private static String wirkungA;
    private static ErsatzwertLauf.Lauf laufNochmal;
    private static Map<Instant, Map<String, Object>> stufeA;
    private static Map<Instant, Map<String, Object>> stufeWiderruf;
    private static Map<Instant, Map<String, Object>> stufeC;
    private static Map<Instant, Map<String, Object>> stufeBNeben;
    private static Map<Instant, Map<String, Object>> stufeB;
    private static String ewA;
    private static String ewC;
    private static String ewB;
    private static Map<String, String> kennungen = new LinkedHashMap<>();

    // =========================================================================== Aufbau

    @BeforeAll
    static void bauenUndFahren() throws Exception {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        stammdaten();
        rohwerte();
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());
        flyway().target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        flyway().load().migrate();

        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        MeasurementCatalog katalog = new MeasurementCatalog(JSON);
        ViertelstundeVerdichter verdichter = new ViertelstundeVerdichter(admin, katalog, new SpaetankunftMelder(),
                500, 40, 200_000);
        ersatzwerte = new MessreiheErsatzwertRepository(app);
        lauf = new ErsatzwertLauf(admin, katalog, verdichter, 200);

        // Version 1: die Verdichtung aller Rohwerte.
        root.update("""
                INSERT INTO messreihe_viertelstunde_arbeit (tenant_id, entity_id, messkanal, intervall_beginn, grund)
                SELECT DISTINCT s.tenant_id, s.entity_id, s.point_key,
                       to_timestamp(floor(extract(epoch FROM s.time) / 900) * 900), 'eingang'
                  FROM device_measurement_sample s WHERE s.entity_id IS NOT NULL
                ON CONFLICT DO NOTHING
                """);
        while (verdichter.verdichteEinenStapel(JETZT)[0] > 0) {
            // weiter, bis die Liste leer ist
        }
        // Die Rohwerte einer Viertelstunde der zweiten Reihe sind weg (Aufbewahrung 90 Tage) — ihre Zeile bleibt.
        root.update("DELETE FROM device_measurement_sample WHERE entity_id = ? AND time >= ? AND time < ?",
                IDS.get("Z2"), ts("2026-11-10T08:15:00Z"), ts("2026-11-10T08:30:00Z"));
        viertelstundenNachVerdichtung = Bestandsschutz.inhalt(root, "messreihe_viertelstunde", null);

        luecke(KB, "ZW", F11_LUECKE_VON, F11_LUECKE_BIS, "418200.0", "420072.0", F11_ZUWACHS);
        luecke(KB, "Z2", Z2_LUECKE_VON, Z2_LUECKE_BIS, "1060", "1120", new BigDecimal("60"));
        luecke(FREMD, "ZF", Z2_LUECKE_VON, Z2_LUECKE_BIS, "1060", "1120", new BigDecimal("60"));

        // ---- A: Methode a — zuerst bricht der Lauf ab und hinterlässt nichts, dann Version 2 ----------
        ewA = erfassen(KB, verteilen(KB, "ZW", "gleichmaessig_verteilen", F11_EW_VON, F11_LUECKE_BIS, "418200.0",
                "420072.0", F11_ZUWACHS));
        root.execute("REVOKE INSERT ON messreihe_ersatzwert_wirkung FROM " + ADMIN_USER);
        try {
            lauf.lauf(JETZT);
        } catch (RuntimeException e) {
            abbruchWarf = true;
        } finally {
            root.execute("GRANT INSERT ON messreihe_ersatzwert_wirkung TO " + ADMIN_USER);
        }
        versionenNachAbbruch = root.queryForObject("SELECT count(*) FROM messreihe_viertelstunde_version", Integer.class);
        laufA = lauf.lauf(JETZT);
        stufeA = neueste(KB, "ZW");
        wirkungA = wirkung(KB, ewA);
        laufNochmal = lauf.lauf(JETZT);

        // ---- Widerruf allein → die Zahlen von Version 1 ----------------------------------------------
        zuruecknehmen(KB, ewA, "Profil aus Netzbetreiber-Lastgang verfügbar");
        lauf.lauf(JETZT);
        stufeWiderruf = neueste(KB, "ZW");

        // ---- C: Methode c aus dem Lastgang der Vergleichsquelle, vom Bestand aus -----------------------
        ewC = erfassen(KB, mitVergleich(verteilen(KB, "ZW", "profil_vergleichsquelle", F11_EW_VON, F11_LUECKE_BIS,
                "418200.0", "420072.0", F11_ZUWACHS), IDS.get("Q-VQ")));
        lauf.lauf(JETZT);
        stufeC = neueste(KB, "ZW");

        // ---- B neben C: dieselbe Lücke zweimal verteilt → benannt abgelehnt, keine Version ------------
        ewB = erfassen(KB, mitVorperiode(verteilen(KB, "ZW", "profil_vorperiode", F11_EW_VON, F11_LUECKE_BIS,
                "418200.0", "420072.0", F11_ZUWACHS), Instant.parse("2026-10-27T13:00:00Z")));
        lauf.lauf(JETZT);
        stufeBNeben = neueste(KB, "ZW");

        // ---- C zurückgenommen → B gilt (Widerruf und Ersatz in EINEM Lauf) ------------------------------
        zuruecknehmen(KB, ewC, "Lastgang enthielt eine Doppelzählung");
        lauf.lauf(JETZT);
        stufeB = neueste(KB, "ZW");

        // ---- Die zweite Reihe: jede Ablehnung und d, e, f, g --------------------------------------------
        kennungen.put("b ohne Vorperiode", erfassen(KB, mitVorperiode(verteilen(KB, "Z2", "profil_vorperiode",
                Instant.parse("2026-11-10T09:00:00Z"), Z2_LUECKE_BIS, "1060", "1120", new BigDecimal("60")),
                Instant.parse("2026-11-03T08:00:00Z"))));
        kennungen.put("c ohne Vergleichsquelle", erfassen(KB, mitVergleich(verteilen(KB, "Z2",
                "profil_vergleichsquelle", Instant.parse("2026-11-10T09:00:00Z"), Z2_LUECKE_BIS, "1060", "1120",
                new BigDecimal("60")), UUID.randomUUID())));
        kennungen.put("d Endstand zu klein", erfassen(KB, ablesestand("2026-11-10T10:45:00Z", "2026-11-10T10:52:00Z",
                "1.0", "0.0")));
        kennungen.put("d", erfassen(KB, ablesestand("2026-11-10T11:00:00Z", "2026-11-10T11:07:00Z", "1186.5",
                "1187.0")));
        kennungen.put("d ohne Rohwerte", erfassen(KB, ablesestand("2026-11-10T08:15:00Z", "2026-11-10T08:22:00Z",
                "1022.0", "1022.5")));
        kennungen.put("e", erfassen(KB, eingeben("2026-11-10T11:30:00Z", "2026-11-10T11:45:00Z", "20.0")));
        kennungen.put("e über zwei Viertelstunden", erfassen(KB, eingeben("2026-11-10T10:30:00Z",
                "2026-11-10T11:00:00Z", "30.0")));
        kennungen.put("f", erfassen(KB, mitVorperiode(ohneZuwachs("Z2", "vorperiode_uebernehmen",
                "2026-11-10T11:45:00Z", "2026-11-10T12:00:00Z"), Instant.parse("2026-11-10T10:45:00Z"))));
        kennungen.put("g", erfassen(KB, mitVergleich(ohneZuwachs("Z2", "vergleichsquelle_uebernehmen",
                "2026-11-10T11:15:00Z", "2026-11-10T11:30:00Z"), IDS.get("Q-VQ"))));
        // Der fremde Kundenbereich verteilt seine eigene Lücke.
        kennungen.put("fremd a", erfassen(FREMD, verteilen(FREMD, "ZF", "gleichmaessig_verteilen",
                Instant.parse("2026-11-10T09:00:00Z"), Z2_LUECKE_BIS, "1060", "1120", new BigDecimal("60"))));
        lauf.lauf(JETZT);
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ==================================================================== Methode a und die Version

    /** Version 2: 78 Viertelstunden zu je 24,0 kWh „mit Ersatzwert“ — und ein Abbruch vorher hinterließ nichts. */
    @Test
    void methodeAVerteiltDenGemessenenZuwachsAlsVersion2() {
        assertThat(abbruchWarf).as("der Lauf scheitert an der Wirkung").isTrue();
        assertThat(versionenNachAbbruch).as("abbruchsicher: keine halbe Version").isZero();
        assertThat(laufA).isEqualTo(new ErsatzwertLauf.Lauf(1, 78));
        assertThat(stufeA).hasSize(78);
        String satz = "mit Ersatzwert (Methode „Zuwachs gleichmäßig verteilen“, " + ewA + ")";
        for (Map<String, Object> v : stufeA.values()) {
            assertThat(v.get("version")).isEqualTo(2);
            assertThat((BigDecimal) v.get("menge")).isEqualByComparingTo("24.0");
            assertThat((BigDecimal) v.get("anteil")).isEqualByComparingTo("24.0");
            assertThat(v.get("menge_zustand")).isEqualTo("mit Ersatzwert");
            assertThat(v.get("kennzeichen")).isEqualTo(List.of(satz));
            assertThat(v.get("ersatzwerte")).isEqualTo(List.of(ewA));
        }
        assertThat(stufeA.keySet()).containsExactlyElementsOf(VerbrauchRegeln.viertelstunden(F11_EW_VON, F11_LUECKE_BIS));
        assertThat(wirkungA).isEqualTo("gebildet");
    }

    /** Zweimal ergibt dasselbe und schreibt beim zweiten Mal nichts. */
    @Test
    void einZweiterLaufSchreibtNichts() {
        assertThat(laufNochmal).isEqualTo(new ErsatzwertLauf.Lauf(0, 0));
    }

    /** Die Invariante in der Datenbank: die Summe der GESPEICHERTEN Anteile ist EXAKT der gemessene Zuwachs. */
    @Test
    void dieSummeDerGespeichertenAnteileIstExaktDerGemesseneZuwachs() {
        for (Map<Instant, Map<String, Object>> stufe : List.of(stufeA, stufeC, stufeB)) {
            BigDecimal summe = stufe.values().stream().map(v -> (BigDecimal) v.get("anteil"))
                    .reduce(BigDecimal.ZERO, BigDecimal::add);
            assertThat(summe).isEqualByComparingTo(F11_ZUWACHS);
        }
        assertThat(root.queryForObject("""
                SELECT sum(v.anteil) FROM messreihe_viertelstunde_version v
                 WHERE v.tenant_id = ? AND v.entity_id = ? AND v.anlass_kennung = ? AND v.intervall_beginn >= ?
                """, BigDecimal.class, KB, IDS.get("ZW"), ewA, Timestamp.from(F11_EW_VON))).isEqualByComparingTo(F11_ZUWACHS);
    }

    // ======================================================================= F21: Widerruf und Ersatz

    /** Der Widerruf allein ist Version 3 — mit Zeichen für Zeichen den Zahlen von Version 1. */
    @Test
    void einZurueckgenommenerErsatzwertHinterlaesstKeineSpurInDenZahlen() {
        assertThat(stufeWiderruf).hasSize(78);
        Map<Instant, Map<String, Object>> bestand = bestand(KB, "ZW");
        for (Map.Entry<Instant, Map<String, Object>> e : stufeWiderruf.entrySet()) {
            Map<String, Object> v = e.getValue();
            Map<String, Object> b = bestand.get(e.getKey());
            assertThat(v.get("version")).isEqualTo(3);
            assertThat(v.get("anteil")).isNull();
            assertThat(v.get("ersatzwerte")).isEqualTo(List.of());
            if (b == null) {
                assertThat(v.get("menge")).isNull();
                assertThat(v.get("menge_zustand")).isEqualTo("keine Werte");
                assertThat(v.get("kennzeichen")).isEqualTo(List.of());
            } else {
                assertThat(v.get("menge")).isEqualTo(b.get("menge"));
                assertThat(v.get("menge_zustand")).isEqualTo(b.get("menge_zustand"));
                assertThat(v.get("kennzeichen")).isEqualTo(b.get("kennzeichen"));
            }
        }
        // Die Viertelstunde mit dem Stand vor der Lücke: Version 1 sagt „nur ein Stand“, Version 3 auch.
        assertThat(stufeWiderruf.get(F11_EW_VON).get("kennzeichen"))
                .isEqualTo(List.of("nur ein Stand in der Periode — keine Menge bildbar"));
        assertThat(wirkung(KB, ewA)).isEqualTo("ohne_wirkung");
        // Version 2 bleibt lesbar.
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_viertelstunde_version WHERE tenant_id = ? "
                + "AND entity_id = ? AND version = 2", Integer.class, KB, IDS.get("ZW"))).isEqualTo(78);
    }

    /** Methode c rechnet vom Bestand aus: Version 4 ist genau die Regel über Zuwachs und Lastgang — nie Version 2. */
    @Test
    void dieBessereMethodeRechnetVomBestandAus() {
        assertThat(stufeC).hasSize(78);
        List<VerbrauchRegeln.Anteil> soll = VerbrauchRegeln.ersatzwertAnteile(new VerbrauchRegeln.Ersatzwert(ewC,
                "profil_vergleichsquelle", F11_EW_VON, F11_LUECKE_BIS, "wirksam",
                new VerbrauchRegeln.LueckenZuwachs(Instant.parse("2026-11-03T13:00:00Z"), F11_LUECKE_BIS,
                        new BigDecimal("418200.0"), new BigDecimal("420072.0"), F11_ZUWACHS),
                F11_LUECKE_VON, lastgang(), "kWh", null, null, null, null, null), "zaehlerstand", "kWh");
        for (VerbrauchRegeln.Anteil a : soll) {
            Map<String, Object> v = stufeC.get(a.beginn());
            assertThat(v.get("version")).isEqualTo(4);
            assertThat((BigDecimal) v.get("anteil")).as(a.beginn().toString()).isEqualByComparingTo(a.menge());
            assertThat((BigDecimal) v.get("menge")).isEqualByComparingTo(a.menge());
            assertThat(v.get("kennzeichen")).isEqualTo(List.of(
                    "mit Ersatzwert (Methode „Zuwachs nach dem Profil der Vergleichsquelle verteilen“, " + ewC + ")"));
        }
        // F21: 03.11. 14:00–24:00 zusammen 1 010,4 kWh, 04.11. 00:00–09:30 861,6 kWh.
        BigDecimal tag03 = stufeC.entrySet().stream().filter(e -> e.getKey().isBefore(Instant.parse("2026-11-03T23:00:00Z")))
                .map(e -> (BigDecimal) e.getValue().get("anteil")).reduce(BigDecimal.ZERO, BigDecimal::add);
        assertThat(tag03).isEqualByComparingTo("1010.4");
        assertThat(wirkung(KB, ewC)).isEqualTo("ohne_wirkung");
    }

    /** Zwei wirksame Verteilungen derselben Lücke: die spätere ist benannt abgelehnt und schreibt nichts. */
    @Test
    void eineZweiteVerteilungDerselbenLueckeIstBenanntAbgelehnt() {
        assertThat(stufeBNeben).isEqualTo(stufeC);
    }

    /** Nach dem Widerruf von c gilt b — Version 5 mit dem Rundungsrest in der letzten Viertelstunde. */
    @Test
    void nachDemWiderrufGiltDieAbgelehnteVerteilungMitIhremRundungsrest() {
        assertThat(stufeB).hasSize(78);
        assertThat(wirkung(KB, ewB)).isEqualTo("gebildet");
        List<BigDecimal> gewichte = new ArrayList<>();
        for (int i = 0; i < 78; i++) {
            gewichte.add(i < 40 ? new BigDecimal("30.0") : new BigDecimal("22.5"));
        }
        List<BigDecimal> soll = VerbrauchRegeln.verteilen(F11_ZUWACHS, gewichte);
        List<Instant> q = VerbrauchRegeln.viertelstunden(F11_EW_VON, F11_LUECKE_BIS);
        for (int i = 0; i < 78; i++) {
            Map<String, Object> v = stufeB.get(q.get(i));
            assertThat(v.get("version")).isEqualTo(5);
            assertThat((BigDecimal) v.get("anteil")).as(q.get(i).toString()).isEqualByComparingTo(soll.get(i));
        }
        assertThat((BigDecimal) stufeB.get(q.get(0)).get("anteil")).isEqualByComparingTo("27.328467153");
        assertThat((BigDecimal) stufeB.get(q.get(77)).get("anteil"))
                .as("der Rest: 1 872 − 40 × 27,328467153 − 37 × 20,496350364")
                .isEqualByComparingTo(F11_ZUWACHS.subtract(new BigDecimal("27.328467153").multiply(BigDecimal.valueOf(40)))
                        .subtract(new BigDecimal("20.496350364").multiply(BigDecimal.valueOf(37))));
    }

    // ================================================================ Die zweite Reihe: d, e, f, g

    /** d: der Ablesestand macht die Viertelstunde zur Gerätegrenze mit Ableseständen — Z4 rechnet 14,5 kWh. */
    @Test
    void methodeDRechnetDieGeraetegrenzeMitAbleseStaenden() {
        Map<String, Object> v = neueste(KB, "Z2").get(Instant.parse("2026-11-10T11:00:00Z"));
        assertThat((BigDecimal) v.get("menge")).isEqualByComparingTo("14.5");
        assertThat(v.get("menge_zustand")).isEqualTo("mit Ersatzwert");
        assertThat(v.get("anteil")).isNull();
        assertThat(v.get("kennzeichen")).isEqualTo(List.of("Gerätegrenze 12:07 mit Ableseständen",
                "mit Ersatzwert (Methode „Ablesestand nachtragen“, " + kennungen.get("d") + ")"));
        assertThat(wirkung(KB, kennungen.get("d"))).isEqualTo("gebildet");
    }

    /** e, f, g: der Wert IST die Menge der Viertelstunde. */
    @Test
    void methodenEFGSetzenDieMengeDerViertelstunde() {
        Map<Instant, Map<String, Object>> z2 = neueste(KB, "Z2");
        assertThat((BigDecimal) z2.get(Instant.parse("2026-11-10T11:30:00Z")).get("menge")).isEqualByComparingTo("20.0");
        assertThat(z2.get(Instant.parse("2026-11-10T11:30:00Z")).get("kennzeichen"))
                .isEqualTo(List.of("mit Ersatzwert (Methode „Wert eingeben (mit Beleg)“, " + kennungen.get("e") + ")"));
        assertThat((BigDecimal) z2.get(Instant.parse("2026-11-10T11:45:00Z")).get("menge")).isEqualByComparingTo("15.0");
        assertThat((BigDecimal) z2.get(Instant.parse("2026-11-10T11:15:00Z")).get("menge")).isEqualByComparingTo("12.5");
        assertThat(z2.get(Instant.parse("2026-11-10T11:15:00Z")).get("kennzeichen"))
                .isEqualTo(List.of("mit Ersatzwert (Methode „Vergleichsquelle übernehmen“, " + kennungen.get("g") + ")"));
        for (String k : List.of("e", "f", "g")) {
            assertThat(wirkung(KB, kennungen.get(k))).as(k).isEqualTo("gebildet");
        }
    }

    /** Fehlt ein Profil, ist das eine benannte Ablehnung — nie ein stiller Rückfall auf a. */
    @Test
    void jedeAblehnungIstBenanntUndSchreibtKeineVersion() {
        assertThat(wirkung(KB, kennungen.get("b ohne Vorperiode"))).isEqualTo("vorperiode_fehlt");
        assertThat(wirkung(KB, kennungen.get("c ohne Vergleichsquelle"))).isEqualTo("vergleichsquelle_fehlt");
        assertThat(wirkung(KB, kennungen.get("d Endstand zu klein"))).isEqualTo("endstand_unter_letztem_wert");
        assertThat(wirkung(KB, kennungen.get("d ohne Rohwerte"))).isEqualTo("rohwerte_fehlen");
        assertThat(wirkung(KB, kennungen.get("e über zwei Viertelstunden"))).isEqualTo("betrag_fuer_mehrere_viertelstunden");
        Map<Instant, Map<String, Object>> z2 = neueste(KB, "Z2");
        for (String q : List.of("2026-11-10T09:00:00Z", "2026-11-10T09:15:00Z", "2026-11-10T09:30:00Z",
                "2026-11-10T09:45:00Z", "2026-11-10T10:45:00Z", "2026-11-10T08:15:00Z", "2026-11-10T10:30:00Z")) {
            assertThat(z2).as("keine Version in " + q).doesNotContainKey(Instant.parse(q));
        }
    }

    // ========================================================================= Zaun, Rechte, Form

    @Test
    void derMandantenzaunHaelt() {
        assertThat(als(KB, () -> app.queryForObject("SELECT count(DISTINCT tenant_id) FROM messreihe_viertelstunde_version",
                Integer.class))).isEqualTo(1);
        assertThat(als(FREMD, () -> app.queryForList("SELECT DISTINCT tenant_id FROM messreihe_viertelstunde_version",
                UUID.class))).containsExactly(FREMD);
        assertThat(als(FREMD, () -> app.queryForObject("SELECT count(*) FROM messreihe_ersatzwert_wirkung WHERE tenant_id = ?",
                Integer.class, KB))).isZero();
        Map<Instant, Map<String, Object>> fremd = neueste(FREMD, "ZF");
        assertThat(fremd).hasSize(4);
        fremd.values().forEach(v -> assertThat((BigDecimal) v.get("anteil")).isEqualByComparingTo("15"));
        for (String t : List.of("messreihe_viertelstunde_version", "messreihe_ersatzwert_wirkung")) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = ?",
                    Boolean.class, t)).as(t).isTrue();
        }
    }

    @Test
    void eineVersionIstAppendOnlyUndLueckenlos() {
        abgelehnt("messreihe_viertelstunde_version_append_only", () -> root.update(
                "UPDATE messreihe_viertelstunde_version SET menge = 0 WHERE tenant_id = ?", KB));
        PSQLException ohneRecht = psql(() -> admin.update("UPDATE messreihe_viertelstunde_version SET menge = 0"));
        assertThat(ohneRecht.getSQLState()).isEqualTo("42501");
        PSQLException appDarfNicht = psql(() -> als(KB, () -> app.update("INSERT INTO messreihe_viertelstunde_version "
                + "(tenant_id, entity_id, messkanal, intervall_beginn, version, menge_zustand, kennzeichen, ersatzwerte, "
                + "anlass_kennung, anlass_fassung) VALUES (?, ?, ?, ?, 9, 'keine Werte', '[]', '{}', 'EW-2026-0001', 1)",
                KB, IDS.get("ZW"), KANAL, ts("2026-11-03T13:00:00Z"))));
        assertThat(appDarfNicht.getSQLState()).isEqualTo("42501");
        abgelehnt("messreihe_viertelstunde_version_lueckenlos", () -> root.update("INSERT INTO messreihe_viertelstunde_version "
                + "(tenant_id, entity_id, messkanal, intervall_beginn, version, menge_zustand, kennzeichen, ersatzwerte, "
                + "anlass_kennung, anlass_fassung) VALUES (?, ?, ?, ?, 9, 'keine Werte', '[]', '{}', 'EW-2026-0001', 1)",
                KB, IDS.get("ZW"), KANAL, ts("2026-11-03T13:00:00Z")));
    }

    /** Die Wörter der Wirkung sind die Ablehnungen der Vektor-Datei — plus die zwei Ausgänge und die eine des Laufs. */
    @Test
    void dieWoerterDerWirkungSindDieDerRechenregel() {
        List<String> woerter = root.queryForList("SELECT unnest(messreihe_ersatzwert_wirkung_woerter())", String.class);
        List<String> soll = new ArrayList<>(List.of("gebildet", "ohne_wirkung"));
        soll.addAll(VerbrauchRegeln.ERSATZWERT_ABLEHNUNGEN);
        soll.add("rohwerte_fehlen");
        assertThat(woerter).containsExactlyElementsOf(soll);
    }

    @Test
    void dasOffboardingRaeumtBeideTabellenAb() {
        UUID weg = root.queryForObject("INSERT INTO tenant (name) VALUES ('Offboarding-Probe') RETURNING id", UUID.class);
        root.update("INSERT INTO messreihe_viertelstunde_version (tenant_id, entity_id, messkanal, intervall_beginn, "
                + "version, menge_zustand, kennzeichen, ersatzwerte, anlass_kennung, anlass_fassung) VALUES "
                + "(?, ?, ?, ?, 2, 'keine Werte', '[]', '{}', 'EW-2026-0001', 2)", weg, UUID.randomUUID(), KANAL,
                ts("2026-11-03T13:00:00Z"));
        root.update("INSERT INTO messreihe_ersatzwert_wirkung (tenant_id, kennung, fassung, ergebnis, versionen, "
                + "berechnet_am) VALUES (?, 'EW-2026-0001', 2, 'ohne_wirkung', 1, now())", weg);
        int fremdVorher = root.queryForObject("SELECT count(*) FROM messreihe_viertelstunde_version WHERE tenant_id = ?",
                Integer.class, FREMD);
        new TenantRepository(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW))).offboard(weg);
        for (String t : List.of("messreihe_viertelstunde_version", "messreihe_ersatzwert_wirkung")) {
            assertThat(root.queryForObject("SELECT count(*) FROM " + t + " WHERE tenant_id = ?", Integer.class, weg))
                    .as(t).isZero();
        }
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_viertelstunde_version WHERE tenant_id = ?",
                Integer.class, FREMD)).isEqualTo(fremdVorher);
    }

    // ============================================================================ Bestandsschutz

    @Test
    void dieMigrationLegtNurDanebenUndLaesstDenBestandZeichengleich() {
        assertThat(fingerVorher).hasSizeGreaterThan(100).doesNotContainKeys("messreihe_viertelstunde_version",
                "messreihe_ersatzwert_wirkung");
        assertThat(fingerVorher.get("device_measurement_sample")).isNotEqualTo(Bestandsschutz.LEER);
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
        assertThat(fingerNachMigration).containsEntry("messreihe_viertelstunde_version", Bestandsschutz.LEER)
                .containsEntry("messreihe_ersatzwert_wirkung", Bestandsschutz.LEER);
    }

    /** Kein Lauf rührt Version 1 an: die Viertelstunden der Verdichtung sind nach allem Zeichen für Zeichen dieselben. */
    @Test
    void derLaufRuehrtVersionEinsNieAn() {
        assertThat(Bestandsschutz.inhalt(root, "messreihe_viertelstunde", null)).isEqualTo(viertelstundenNachVerdichtung);
    }

    @Test
    void derBestandsvergleichFaengtEineGeaenderteZeile() {
        Bestandsschutz.mutationsprobe(root, List.of(), "unternehmen", "UPDATE unternehmen SET name = name || ' (Probe)'");
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
        reihe(KB, "ZW", 60);
        reihe(KB, "VQ", 900);
        reihe(KB, "Z2", 60);
        reihe(FREMD, "ZF", 60);
        UUID ms = uuid("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, einheit, "
                + "wertart) VALUES (?, 'MS-10', 'Halle 2', 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                + "'Zählerstand') RETURNING id", KB);
        IDS.put("Q-ZW", bindung(ms, "ZW", "fuehrend", null));
        IDS.put("Q-VQ", bindung(ms, "VQ", "vergleich", "Abrechnungszähler"));
    }

    /** Eine Komponente mit eigener Box und dem kWh-Zählerkanal; Kadenz in Sekunden. */
    private static void reihe(UUID tenant, String name, int kadenz) {
        UUID an = IDS.get("AN:" + tenant);
        UUID box = uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, 'claimed') "
                + "RETURNING id", tenant, an, "VP-BOX-EW-" + name);
        UUID entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, "
                + "communication, connection_json, created_at) VALUES (?, ?, 'grid-meter', ?, 'grid-meter', ?, "
                + "'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, '2024-03-12T00:00:00Z') RETURNING id",
                tenant, an, name, box);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, ?, 1, "
                + "'2024-03-12T00:00:00Z', '2026.09.11.1', 'test', 'pending_edge', 'live_power', 'fifteen_minute')",
                tenant, an, box, entity, KANAL, kadenz);
        IDS.put(name, entity);
        IDS.put("BOX:" + name, box);
    }

    private static UUID bindung(UUID messstelle, String reihe, String rolle, String zweck) {
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, IDS.get(reihe));
        return root.queryForObject("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, "
                + "entity_id, geraet_id, kanal, kanal_wertart, herleitung, rolle, zweck, gueltig_ab, rueckwirkend, "
                + "eingetragen_am, actor_sub, actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', 'Bezug', ?, ?, ?, "
                + "'counter', 'zaehlerstand', ?, ?, '2024-03-12T00:00:00Z', true, now(), 'sub', 'Probe', 'kunde') "
                + "RETURNING id", UUID.class, KB, messstelle, IDS.get(reihe), geraet, KANAL, rolle, zweck);
    }

    private static void rohwerte() throws Exception {
        // F11 — die Rohwerte der Vektor-Datei.
        for (JsonNode fall : VerbrauchVectorsTest.lies(VerbrauchVectorsTest.VECTORS).path("cases")) {
            if (fall.path("name").asText().startsWith("f11-")) {
                saeen(KB, "ZW", VerbrauchVectorsTest.rohwerte(fall.path("input").path("reihe")));
            }
        }
        // Die Vorwoche derselben Viertelstunden: 30,0 kWh je Viertelstunde bis 23:00 UTC, danach 22,5.
        List<Rohwert> vorwoche = new ArrayList<>();
        BigDecimal stand = new BigDecimal("400000.0");
        for (Instant t = Instant.parse("2026-10-27T12:00:00Z"); !t.isAfter(Instant.parse("2026-10-28T10:00:00Z"));
                t = t.plusSeconds(60)) {
            vorwoche.add(new Rohwert(t, stand));
            stand = stand.add(t.isBefore(Instant.parse("2026-10-27T23:00:00Z")) ? new BigDecimal("2.0") : new BigDecimal("1.5"));
        }
        saeen(KB, "ZW", vorwoche);
        // Die Vergleichsquelle (15 min): der Lastgang des Netzbetreibers über die Lücke — und am 10.11.
        List<Rohwert> vq = new ArrayList<>();
        BigDecimal lastgang = new BigDecimal("50000.0");
        List<VerbrauchRegeln.Profilwert> profil = lastgang();
        List<Instant> q = VerbrauchRegeln.viertelstunden(F11_EW_VON, F11_LUECKE_BIS);
        for (int i = 0; i < q.size(); i++) {
            vq.add(new Rohwert(q.get(i), lastgang));
            lastgang = lastgang.add(profil.get(i).menge());
        }
        vq.add(new Rohwert(F11_LUECKE_BIS, lastgang));
        vq.add(new Rohwert(Instant.parse("2026-11-10T11:00:00Z"), new BigDecimal("60000.0")));
        vq.add(new Rohwert(Instant.parse("2026-11-10T11:15:00Z"), new BigDecimal("60012.5")));
        vq.add(new Rohwert(Instant.parse("2026-11-10T11:30:00Z"), new BigDecimal("60025.0")));
        saeen(KB, "VQ", vq);
        // Die zweite Reihe und die fremde: 1 kWh je Minute ab 08:00 UTC, Lücke (09:00, 10:00).
        for (Object[] r : new Object[][] {{KB, "Z2"}, {FREMD, "ZF"}}) {
            List<Rohwert> werte = new ArrayList<>();
            long i = 0;
            for (Instant t = Instant.parse("2026-11-10T08:00:00Z"); !t.isAfter(Instant.parse("2026-11-10T12:00:00Z"));
                    t = t.plusSeconds(60), i++) {
                if (t.isAfter(Instant.parse("2026-11-10T09:00:00Z")) && t.isBefore(Z2_LUECKE_BIS)) {
                    continue;
                }
                werte.add(new Rohwert(t, BigDecimal.valueOf(1000 + i)));
            }
            saeen((UUID) r[0], (String) r[1], werte);
        }
    }

    /** F21: 40 × 25,26 (03.11. 14:00–24:00), 36 × 22,6 (04.11. 00:00–09:00), 2 × 24,0 (09:00–09:30). */
    private static List<VerbrauchRegeln.Profilwert> lastgang() {
        List<VerbrauchRegeln.Profilwert> out = new ArrayList<>();
        for (int i = 0; i < 78; i++) {
            out.add(new VerbrauchRegeln.Profilwert(new BigDecimal(i < 40 ? "25.26" : i < 76 ? "22.6" : "24.0"),
                    "vollständig"));
        }
        return out;
    }

    private static final String ROH_SQL =
            "INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, point_key, "
                    + "raw_numeric, quality, catalog_version, edge_sequence, aggregation_kind, entity_id, "
                    + "applied_revision, value_kind, role, delivery, delay_s) VALUES (?, ?, ?, ?, ?, ?, ?, 'good', "
                    + "'2026.09.11.1', ?, 'counter', ?, 3, 'counter', 'fuehrend', 'direkt', 2) ON CONFLICT DO NOTHING";

    private static void saeen(UUID tenant, String reihe, List<Rohwert> werte) {
        List<Object[]> stapel = new ArrayList<>();
        for (Rohwert r : werte) {
            stapel.add(new Object[] {Timestamp.from(r.zeit()), Timestamp.from(r.zeit().plusSeconds(2)), tenant,
                    IDS.get("AN:" + tenant), IDS.get("BOX:" + reihe), KANAL, r.wert(), r.zeit().getEpochSecond(),
                    IDS.get(reihe)});
        }
        root.batchUpdate(ROH_SQL, stapel);
    }

    /** Eine geschlossene Lücke der Reihe MIT gemessenem Zuwachs, über den Schreibweg der Ereignis-Tabelle. */
    private static void luecke(UUID tenant, String reihe, Instant von, Instant bis, String vor, String nach,
            BigDecimal zuwachs) {
        UUID id = UUID.randomUUID();
        ObjectNode e = JSON.createObjectNode()
                .put("ereignis_id", id.toString()).put("art", "data_gap")
                .put("von", von.toString()).put("bis", bis.toString()).put("box", IDS.get("BOX:" + reihe).toString())
                .put("komponente", IDS.get(reihe).toString()).put("messkanal", KANAL).put("erkannt_aus", "kadenz")
                .put("zuwachs", zuwachs).put("einheit", "kWh").put("stand_vor", new BigDecimal(vor))
                .put("stand_nach", new BigDecimal(nach));
        MessreiheEreignisRepository.Ergebnis r = als(tenant, () ->
                new MessreiheEreignisRepository(app).anhaengen(tenant, null, Urheber.CLOUD, e, null, null));
        assertThat(r.ausgang()).as("Lücke angehängt: " + r).isEqualTo(MessreiheEreignisRepository.Ausgang.ANGEHAENGT);
        IDS.put("LUECKE:" + reihe, id);
    }

    private static Anlage verteilen(UUID tenant, String reihe, String methode, Instant von, Instant bis, String vor,
            String nach, BigDecimal zuwachs) {
        return new Anlage(methode, IDS.get(reihe), KANAL, null, von, bis, null, BEGRUENDUNG, null,
                IDS.get("LUECKE:" + reihe), zuwachs, new BigDecimal(vor), new BigDecimal(nach), "kWh", null, null, null,
                null, null);
    }

    private static Anlage ohneZuwachs(String reihe, String methode, String von, String bis) {
        return new Anlage(methode, IDS.get(reihe), KANAL, null, Instant.parse(von), Instant.parse(bis), null,
                "Karte ohne Zählerstand, Werte aus dem Bezug übernommen", null, null, null, null, null, null, null,
                null, null, null, null);
    }

    private static Anlage ablesestand(String von, String zeitpunkt, String endstand, String anfangsstand) {
        Instant v = Instant.parse(von);
        return new Anlage("ablesestand_nachtragen", IDS.get("Z2"), KANAL, null, v, v.plusSeconds(900),
                Instant.parse(zeitpunkt), "Protokoll Elektro Brunner: Stände vor und nach dem Tausch", null, null, null,
                null, null, "kWh", null, null, new BigDecimal(endstand), new BigDecimal(anfangsstand), null);
    }

    private static Anlage eingeben(String von, String bis, String betrag) {
        return new Anlage("wert_eingeben", IDS.get("Z2"), KANAL, null, Instant.parse(von), Instant.parse(bis), null,
                "Netzrechnung November 2026 nennt die Menge", "Netzrechnung 2026-11, Lastgang-Anlage", null, null,
                null, null, "kWh", null, null, null, null, new BigDecimal(betrag));
    }

    private static Anlage mitVorperiode(Anlage a, Instant vorperiode) {
        return new Anlage(a.methode(), a.entityId(), a.messkanal(), a.messstelleId(), a.von(), a.bis(), a.zeitpunkt(),
                a.begruendung(), a.beleg(), a.lueckeEreignisId(), a.zuwachs(), a.standVor(), a.standNach(), a.einheit(),
                vorperiode, a.vergleichQuelleId(), a.endstand(), a.anfangsstand(), a.betrag());
    }

    private static Anlage mitVergleich(Anlage a, UUID quelle) {
        return new Anlage(a.methode(), a.entityId(), a.messkanal(), a.messstelleId(), a.von(), a.bis(), a.zeitpunkt(),
                a.begruendung(), a.beleg(), a.lueckeEreignisId(), a.zuwachs(), a.standVor(), a.standNach(), a.einheit(),
                a.vorperiodeVon(), quelle, a.endstand(), a.anfangsstand(), a.betrag());
    }

    private static String erfassen(UUID tenant, Anlage a) {
        return als(tenant, () -> new TransactionTemplate(new DataSourceTransactionManager(app.getDataSource()))
                .execute(s -> ersatzwerte.erfassen(tenant, a, INES, BERLIN))).kennung();
    }

    private static void zuruecknehmen(UUID tenant, String kennung, String grund) {
        als(tenant, () -> new TransactionTemplate(new DataSourceTransactionManager(app.getDataSource()))
                .execute(s -> ersatzwerte.zuruecknehmen(tenant, kennung, grund, INES)));
    }

    /** Die neueste Version je Viertelstunde der Reihe. */
    private static Map<Instant, Map<String, Object>> neueste(UUID tenant, String reihe) {
        Map<Instant, Map<String, Object>> out = new LinkedHashMap<>();
        root.query("""
                SELECT DISTINCT ON (intervall_beginn) intervall_beginn, version, menge, menge_zustand, kennzeichen::text,
                       anteil, ersatzwerte
                  FROM messreihe_viertelstunde_version WHERE tenant_id = ? AND entity_id = ?
                 ORDER BY intervall_beginn, version DESC
                """, rs -> {
                    Map<String, Object> v = new LinkedHashMap<>();
                    v.put("version", rs.getInt(2));
                    v.put("menge", rs.getBigDecimal(3));
                    v.put("menge_zustand", rs.getString(4));
                    v.put("kennzeichen", saetze(rs.getString(5)));
                    v.put("anteil", rs.getBigDecimal(6));
                    v.put("ersatzwerte", Arrays.asList((String[]) rs.getArray(7).getArray()));
                    out.put(rs.getTimestamp(1).toInstant(), v);
                }, tenant, IDS.get(reihe));
        return out;
    }

    private static Map<Instant, Map<String, Object>> bestand(UUID tenant, String reihe) {
        Map<Instant, Map<String, Object>> out = new LinkedHashMap<>();
        root.query("SELECT intervall_beginn, menge, menge_zustand, kennzeichen::text FROM messreihe_viertelstunde "
                + "WHERE tenant_id = ? AND entity_id = ?", rs -> {
                    Map<String, Object> v = new LinkedHashMap<>();
                    v.put("menge", rs.getBigDecimal(2));
                    v.put("menge_zustand", rs.getString(3));
                    v.put("kennzeichen", saetze(rs.getString(4)));
                    out.put(rs.getTimestamp(1).toInstant(), v);
                }, tenant, IDS.get(reihe));
        return out;
    }

    private static String wirkung(UUID tenant, String kennung) {
        return root.queryForObject("SELECT ergebnis FROM messreihe_ersatzwert_wirkung WHERE tenant_id = ? AND kennung = ?",
                String.class, tenant, kennung);
    }

    private static List<String> saetze(String json) {
        try {
            List<String> out = new ArrayList<>();
            JSON.readTree(json).forEach(n -> out.add(n.asText()));
            return out;
        } catch (Exception e) {
            throw new IllegalStateException(json, e);
        }
    }

    private static UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
    }

    private static Timestamp ts(String iso) {
        return Timestamp.from(Instant.parse(iso));
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

    private static void abgelehnt(String constraint, Runnable arbeit) {
        PSQLException p = psql(arbeit);
        assertThat(p.getServerErrorMessage().getConstraint()).as(p.getMessage()).isEqualTo(constraint);
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
