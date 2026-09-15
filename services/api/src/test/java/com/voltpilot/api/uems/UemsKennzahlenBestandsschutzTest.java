package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.measurement.BestandGeraeteCsvVergleich;
import com.voltpilot.api.measurement.MeasurementHistoryService;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Bestandsschutz des Kennzahlen-Konzepts (UEMS AP-11 IP-16, Meilenstein 6 „freigabefähig“): die GANZE Kennzahl-Maschine
 * läuft über dem Kern, und am Kern ändert sich kein Byte — die Rollups (Telemetrie v1 und v2, Geräte-Messwerte 5 und
 * 15 Minuten), der Verlauf und der Export eines Messwerts, und jede Tabelle außerhalb von {@code kennzahl%}.
 *
 * <p><b>Die Maschine</b> ist, was die fünfzehn Pakete davor gebaut haben, in der Reihenfolge des Betriebs: Kennzahlen über
 * die Route anlegen (IP-5), der Kennzahl-Schritt des Stundentakts (IP-6, K1–K3 in Ahrenberg im März 2026; seine Stelle im
 * Takt prüft {@code EndgueltigkeitLaeuferReihenfolgeTest}), eine
 * rückwirkende Fassung durch die Korrektur-Kaskade (IP-9, Version 2 „Berechnung geändert“ samt Zusammenfassung) und die
 * Kaskaden-Naht auf dem Reihen-Pfad (IP-8, Version 2 „korrigiert“). Jeder Schritt prüft, dass er wirklich geschrieben hat —
 * sonst bewiese der Vergleich nichts.
 *
 * <p><b>Der Vergleichsstand ist der Kern ohne AP-11:</b> der erste Fingerabdruck entsteht nach dem Takt in der
 * Verdrahtung von VOR AP-11 ({@code EndgueltigkeitLaeufer} ohne Kennzahl-Schritt — der Konstruktor ist geblieben) und
 * bevor es eine Kennzahl gibt. Der Code der Rollups (Prozeduren der Migrationen bis V20260853000000) und des Exports
 * ({@code MeasurementHistoryService}, {@code DeviceMeasurementSelectionController}) hat seit dem Stand vor AP-11 kein
 * AP-11-Commit berührt; die Aufnahme {@code UemsLesepfadMengenTest.FLAECHE_VORHER} stammt von 0de28e6e, also von vor AP-11.
 *
 * <p><b>Was sich am Kern ändern DARF, steht mit Namen da</b> — und nur die Zeilen, nie die Tabelle:
 * <ul>
 *   <li>AP-11 selbst: die Meldung {@code kennzahl_neu_gebildet} in {@code messreihe_ereignis} (IP-8) und die Wirkung einer
 *       rückwirkenden Kennzahl-Fassung {@code kennzahl_fassung:…} in {@code messreihe_kaskade_wirkung} (IP-9);</li>
 *   <li>der Test an Stelle von AP-08: die Korrektur K-2026-0007 in {@code messreihe_korrektur} und die Monats-Version 2
 *       der Reihe von MS-12 in {@code messreihe_periode_version} — die schriebe die Kaskaden-Stufe auch ohne AP-11.</li>
 * </ul>
 */
@Testcontainers
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class UemsKennzahlenBestandsschutzTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ENERGIE = "sunspec.model_203.totwhimp";
    private static final String KATALOG = "2026.09.11.1";
    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    private static final String PFAD = "/api/v1/kennzahlen";
    private static final String K7 = "K-2026-0007";
    private static final LocalDate MAERZ_1 = LocalDate.parse("2026-03-01");
    private static final LocalDate MAERZ_31 = LocalDate.parse("2026-03-31");
    /** Der Takt nach dem Monatsende: die Monatswerte sind endgültig, BZ-6 und BZ-7 eingetragen. */
    private static final Instant T_TAKT = Instant.parse("2026-04-10T08:00:00Z");
    /** Die Korrektur-Kaskade liest die rückwirkende Fassung 2 von KZ-0002. */
    private static final Instant T_AUSLOESER = Instant.parse("2026-04-11T08:00:00Z");
    /** Die Kaskade im Takt der Freigabe von K-2026-0007 (Reihen-Pfad). */
    private static final Instant T_KASKADE = Instant.parse("2026-04-12T09:05:33Z");

    /** Die Rohwerte des Kerns liegen innerhalb der Rohdaten-Frist — unabhängig vom Tag, an dem der Test läuft. */
    private static final LocalDate ROH_TAG = LocalDate.now(ZoneOffset.UTC).minusDays(20);
    private static final Instant ROH_VON = ROH_TAG.atTime(10, 0).toInstant(ZoneOffset.UTC);
    private static final Instant ROH_BIS = ROH_VON.plus(Duration.ofHours(2));
    /** Die Rohdaten-Grenze des Verlaufs ({@code Meta.rohGrenze}) hängt an der Uhr — fest, sonst trüge jeder Abruf eine andere. */
    private static final Clock UHR = Clock.fixed(ROH_TAG.plusDays(20).atStartOfDay().toInstant(ZoneOffset.UTC), ZoneOffset.UTC);

    /** Die Rollup-Tabellen des Kerns — jede muss nach dem Aufbau Zeilen haben. */
    private static final List<String> ROLLUPS = List.of("telemetry_rollup_15m", "telemetry_rollup_1h",
            "telemetry_rollup_1d", "telemetry_v2_rollup_15m", "device_measurement_rollup_5m",
            "device_measurement_rollup_15m");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> APP_USER);
        registry.add("spring.datasource.password", () -> APP_PW);
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> APP_USER);
        registry.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot");
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot/protocol/openid-connect/certs");
    }

    @Autowired
    MockMvc mvc;

    @Autowired
    ObjectMapper json;

    @Autowired
    EndgueltigkeitLauf endgueltigkeit;

    @Autowired
    TagVerdichter tage;

    @Autowired
    PeriodeVerdichter perioden;

    @Autowired
    BerechnetePeriodenLauf berechnete;

    @Autowired
    KorrekturVorschlagLauf vorschlaege;

    @Autowired
    KennzahlLauf kennzahlen;

    @Autowired
    KennzahlenNaht naht;

    @Autowired
    KorrekturKaskade kaskade;

    @Autowired
    MeasurementHistoryService verlauf;

    @Autowired
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate admin;

    @MockBean
    KennzahlAufrufer aufrufer;

    private static JdbcTemplate root;
    private Object uhrVorher;

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void aufruferWieHeute() {
        doAnswer(inv -> KorrekturRechte.benutzer(inv.getArgument(0))).when(aufrufer).benutzer(any());
        uhrVorher = ReflectionTestUtils.getField(verlauf, "uhr");
        ReflectionTestUtils.setField(verlauf, "uhr", UHR);
    }

    @AfterEach
    void aufraeumen() {
        ReflectionTestUtils.setField(verlauf, "uhr", uhrVorher);
        TenantContext.clear();
    }

    @Test
    void dieGanzeKennzahlMaschineLaeuftUndDerKernBleibtByteGleich() throws Exception {
        // Die Hintergrund-Jobs der Datenbank (Rollups, Aufbewahrung) rechnen sonst zwischen den Fingerabdrücken.
        root.queryForList("SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs "
                + "WHERE job_id >= 1000");
        Welt w = welt();
        kern(w);
        monat(w, "MS-12", "6100");
        monat(w, "MS-16", "4200");
        monat(w, "MS-18", "3600");
        bezugswert(w, "BZ-6", "41000");
        bezugswert(w, "BZ-7", "7200");

        // Der Takt in der Verdrahtung von vor AP-11 — dann der Vergleichsstand.
        new EndgueltigkeitLaeufer(endgueltigkeit, tage, perioden, berechnete, vorschlaege).takt(T_TAKT);
        Map<String, String> vorher = fingerabdruck(w);
        for (String rollup : ROLLUPS) {
            assertThat(vorher.get(rollup)).as("der Aufbau füllt " + rollup).isNotEqualTo(Bestandsschutz.LEER);
        }
        assertThat(datenzeilen(export(w, "decoded"))).as("der Export trägt die Rohwerte").isEqualTo(24);

        // IP-5: anlegen über die Route. IP-6: der Kennzahl-Schritt des Takts — ein zweiter GANZER Takt verschöbe die Zeiger
        // des Kerns (messreihe_tag_lauf) auch ohne AP-11.
        w.kz().put("KZ-0001", anlegen(w, "KZ-0001", "quotient", "gebaeude", w.g2(),
                e("zaehler", "messstelle", "MS-12"), e("nenner", "bezugsgroesse", "BZ-6")));
        w.kz().put("KZ-0002", anlegen(w, "KZ-0002", "quotient", "gebaeude", w.g5(),
                e("zaehler", "messstelle", "MS-18"), e("nenner", "bezugsgroesse", "BZ-7")));
        w.kz().put("KZ-0003", anlegen(w, "KZ-0003", "zusammenfassung", "unternehmen", w.unternehmen(),
                e("paar", "kennzahl", "KZ-0001"), e("paar", "kennzahl", "KZ-0002")));
        kennzahlen.lauf(T_TAKT);
        assertThat(zeile(w, "KZ-0001")).as("K1 im Takt").containsEntry("version", 1).containsEntry("zustand", "endgueltig");
        assertThat(zeile(w, "KZ-0003")).as("K3 im Takt").containsEntry("version", 1).containsEntry("zustand", "endgueltig");

        // IP-9: rückwirkende Fassung 2 von KZ-0002 (Hauptzähler MS-16) ab 01.03. — die Kaskade bildet sie neu.
        fassungZwei(w, "KZ-0002");
        kaskade.lauf(T_AUSLOESER);
        assertThat(zeile(w, "KZ-0002")).as("Berechnung geändert").containsEntry("version", 2)
                .containsEntry("anlass_art", "definition");
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_kaskade_wirkung WHERE tenant_id = ? "
                + "AND anlass_kennung LIKE 'kennzahl_fassung:%'", Long.class, w.mandant())).isPositive();

        // IP-8: die Korrektur K-2026-0007 an MS-12 — Stufe (AP-08) und Naht in EINER Transaktion.
        korrekturK7(w);
        inDerKaskade(con -> {
            ms12Version2(con, w);
            naht.nachKorrektur(con, betroffen(w));
        });
        assertThat(zeile(w, "KZ-0001")).as("korrigiert").containsEntry("version", 2);
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE tenant_id = ? "
                + "AND art = 'kennzahl_neu_gebildet'", Long.class, w.mandant())).isPositive();

        Map<String, String> nachher = fingerabdruck(w);
        assertThat(Bestandsschutz.abweichungen(vorher, nachher)).as("der Kern nach der Kennzahl-Maschine").isEmpty();
        assertThat(nachher.keySet()).containsExactlyElementsOf(vorher.keySet());
    }

    // ================================================================ der Fingerabdruck

    /**
     * Jede Tabelle außerhalb von {@code kennzahl%} (die geteilten Tabellen ohne die benannten Zeilen, siehe Klasse) und die
     * Flächen des Kerns: Verlauf und Export eines Messwerts über zwei Stunden (Rohwerte, gelesen und roh) und über einen
     * Monat.
     */
    private Map<String, String> fingerabdruck(Welt w) throws Exception {
        Map<String, String> f = new TreeMap<>(Bestandsschutz.fingerabdruck(root, List.of("kennzahl%")));
        f.put("messreihe_ereignis", Bestandsschutz.inhalt(root, "messreihe_ereignis",
                "t.art <> 'kennzahl_neu_gebildet'"));
        f.put("messreihe_kaskade_wirkung", Bestandsschutz.inhalt(root, "messreihe_kaskade_wirkung",
                "t.anlass_kennung NOT LIKE 'kennzahl_fassung:%'"));
        f.put("messreihe_korrektur", Bestandsschutz.inhalt(root, "messreihe_korrektur", "t.kennung <> ?", K7));
        f.put("messreihe_periode_version", Bestandsschutz.inhalt(root, "messreihe_periode_version",
                "NOT (t.entity_id = ? AND t.ebene = 'monat' AND t.version = 2)", w.komponenten().get("MS-12")));
        TenantContext.set(w.mandant());
        try {
            for (String darstellung : List.of("decoded", "raw")) {
                MeasurementHistoryService.History h = verlauf.history(w.boxen().get("MS-12"), ENERGIE, "free", ROH_VON,
                        ROH_BIS, darstellung, null, w.komponenten().get("MS-12"));
                f.put("Fläche Verlauf 2 h " + darstellung, md5(json.writeValueAsBytes(h)));
                f.put("Fläche Export 2 h " + darstellung, md5(verlauf.csv(h, BestandGeraeteCsvVergleich.erzeugung())));
            }
            MeasurementHistoryService.History monat = verlauf.history(w.boxen().get("MS-12"), ENERGIE, "free",
                    ROH_VON.minus(Duration.ofDays(30)), ROH_BIS, "decoded", null, w.komponenten().get("MS-12"));
            f.put("Fläche Verlauf Monat", md5(json.writeValueAsBytes(monat)));
            f.put("Fläche Export Monat", md5(verlauf.csv(monat, BestandGeraeteCsvVergleich.erzeugung())));
        } finally {
            TenantContext.clear();
        }
        return f;
    }

    private byte[] export(Welt w, String darstellung) {
        TenantContext.set(w.mandant());
        try {
            return verlauf.csv(verlauf.history(w.boxen().get("MS-12"), ENERGIE, "free", ROH_VON, ROH_BIS, darstellung,
                    null, w.komponenten().get("MS-12")), BestandGeraeteCsvVergleich.erzeugung());
        } finally {
            TenantContext.clear();
        }
    }

    private static long datenzeilen(byte[] csv) {
        return new String(csv, StandardCharsets.UTF_8).lines().filter(z -> !z.isBlank() && !z.startsWith("#")).count()
                - 1;
    }

    private static String md5(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("MD5").digest(bytes));
    }

    // ================================================================ der Kern: Rohwerte und Rollups

    /**
     * Zwei Stunden an der Box von MS-12: Telemetrie v1 und v2 und der Zählerstand als Geräte-Messwert (Takt 900 s), dann die
     * Rollups. Der 5-Minuten-Rollup liest nur Reihen mit dem Langzeit-Takt 300 s — die trägt die Box von MS-18.
     */
    private static void kern(Welt w) {
        UUID box = w.boxen().get("MS-12");
        UUID komponente = w.komponenten().get("MS-12");
        for (int i = 0; i < 24; i++) {
            root.update("INSERT INTO device_measurement_sample (time, tenant_id, site_id, device_id, point_key, "
                    + "raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, aggregation_kind, "
                    + "long_term_cadence_s, entity_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'good', ?, ?, 'counter', 300, ?)",
                    Timestamp.from(ROH_VON.plus(Duration.ofMinutes(5L * i))), w.mandant(), w.lindach(),
                    w.boxen().get("MS-18"), ENERGIE, 2_000_000.0 + i * 40, 2_000_000.0 + i * 40, KATALOG, 20_000 + i,
                    w.komponenten().get("MS-18"));
            Timestamp zeit = Timestamp.from(ROH_VON.plus(Duration.ofMinutes(5L * i)));
            root.update("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw, load_kw, pv_power_kw) "
                    + "VALUES (?, ?, ?, ?, ?, ?, 0)", zeit, w.mandant(), w.halle2(), box, 2.0 + i / 10.0, 2.0 + i / 10.0);
            root.update("INSERT INTO telemetry_v2 (time, tenant_id, site_id, device_id, entity_id, channel, value) "
                    + "VALUES (?, ?, ?, ?, ?, 'active_power', ?)", zeit, w.mandant(), w.halle2(), box,
                    komponente.toString(), 1500.0 + i * 10);
            root.update("INSERT INTO device_measurement_sample (time, tenant_id, site_id, device_id, point_key, "
                    + "raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, aggregation_kind, "
                    + "long_term_cadence_s, entity_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'good', ?, ?, 'counter', 900, ?)",
                    zeit, w.mandant(), w.halle2(), box, ENERGIE, 1_000_000.0 + i * 125, 1_000_000.0 + i * 125, KATALOG,
                    10_000 + i, komponente);
        }
        String seit = ROH_TAG.atStartOfDay().toInstant(ZoneOffset.UTC).toString();
        root.execute("CALL refresh_telemetry_rollups('" + seit + "')");
        root.execute("CALL refresh_telemetry_v2_rollups('" + seit + "')");
        root.execute("CALL refresh_device_measurement_rollup('device_measurement_rollup_5m'::regclass, "
                + "interval '5 minutes', '" + seit + "')");
        root.execute("CALL refresh_device_measurement_rollup('device_measurement_rollup_15m'::regclass, "
                + "interval '15 minutes', '" + seit + "')");
    }

    // ================================================================ die Welt (Ahrenberg 1.3, wie in der Kaskade)

    private record Welt(UUID mandant, UUID unternehmen, UUID g2, UUID g5, UUID halle2, UUID lindach,
            Map<String, UUID> messstellen, Map<String, UUID> komponenten, Map<String, UUID> boxen, Map<String, UUID> kz) {}

    private record Antwort(int status, JsonNode body) {}

    /** ST-1 mit Halle 2 (MS-10, MS-12), ST-2 mit der Montagehalle Lindach (MS-16, MS-18), BZ-6/BZ-7. */
    private static Welt welt() {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES ('Bestandsschutz AP-11') RETURNING id", UUID.class);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID st1 = standort(t, u, "Werk Ahrenberg", "ST-1");
        UUID st2 = standort(t, u, "Werk Lindach", "ST-2");
        Welt w = new Welt(t, u, gebaeude(t, st1, "Halle 2", "G-2"), gebaeude(t, st2, "Montagehalle Lindach", "G-5"),
                anlage(t, "Halle 2"), anlage(t, "Lindach"), new LinkedHashMap<>(), new LinkedHashMap<>(),
                new LinkedHashMap<>(), new LinkedHashMap<>());
        messstelle(w, "MS-10", w.halle2(), "Hauptzähler", null);
        messstelle(w, "MS-12", w.halle2(), "Unterzähler", "MS-10");
        messstelle(w, "MS-16", w.lindach(), "Hauptzähler", null);
        messstelle(w, "MS-18", w.lindach(), "Unterzähler", "MS-16");
        root.update("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, geltung_art, "
                + "ort_id) VALUES (?, 'BZ-6', 'Gutteile Montage Halle 2', 'periodenwert', 'Stück', 'monat', 'gebaeude', ?)",
                t, w.g2());
        root.update("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, geltung_art, "
                + "ort_id) VALUES (?, 'BZ-7', 'Gutteile Montage Lindach', 'periodenwert', 'Stück', 'monat', 'gebaeude', ?)",
                t, w.g5());
        return w;
    }

    private static UUID standort(UUID t, UUID u, String name, String kurz) {
        return root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u, name, kurz);
    }

    private static UUID gebaeude(UUID t, UUID standort, String name, String kurz) {
        UUID g = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, 'gebaeude', ?, "
                + "?, 'aktiv') RETURNING id", UUID.class, t, name, kurz);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2020-01-01')", t, g, standort);
        return g;
    }

    private static UUID anlage(UUID t, String name) {
        return root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, name, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
    }

    /** Box, Komponente, Mess-Selektion des Zählerstands, gemessene Messstelle mit führender Quelle, Stellung. */
    private static void messstelle(Welt w, String kennzeichen, UUID anlage, String stellung, String unterzaehlerVon) {
        UUID t = w.mandant();
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, anlage, "VP-BESTAND-" + kennzeichen + "-" + UUID.randomUUID());
        UUID komponente = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, communication, connection_json, created_at) VALUES (?, ?, 'modbus-generic', ?, "
                + "'modbus-generic', ?, 'modbus_tcp', '{\"unit_id\":1}'::jsonb, ?) RETURNING id", UUID.class, t, anlage,
                "Zähler " + kennzeichen, box, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), ?, 'test', "
                + "'pending_edge', 'energy_counter', 'fifteen_minute')", t, anlage, box, komponente, ENERGIE, KATALOG);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ?", UUID.class,
                komponente);
        UUID messstelle = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                + "'Zählerstand') RETURNING id", UUID.class, t, kennzeichen, "Zähler " + kennzeichen);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_name, actor_art) "
                + "VALUES (?,?,'Wirkenergie','Bezug',?,?,?,'counter','zaehlerstand','fuehrend',?,false,?,'test','voltpilot')",
                t, messstelle, komponente, geraet, ENERGIE, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")),
                Timestamp.from(Instant.parse("2020-01-01T00:01:00Z")));
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, unterzaehler_von, "
                + "gueltig_ab) VALUES (?,?,?,?,?,?)", t, messstelle, anlage, stellung,
                unterzaehlerVon == null ? null : w.messstellen().get(unterzaehlerVon), LocalDate.parse("2020-01-01"));
        w.messstellen().put(kennzeichen, messstelle);
        w.komponenten().put(kennzeichen, komponente);
        w.boxen().put(kennzeichen, box);
    }

    /** Der gemessene, endgültige März der Reihe einer Messstelle (AP-08 IP-5) — Version 1 der Verdichtung. */
    private static void monat(Welt w, String kennzeichen, String menge) {
        Instant b = MAERZ_1.atStartOfDay(ZONE).toInstant();
        Instant e = MAERZ_1.plusMonths(1).atStartOfDay(ZONE).toInstant();
        int tage = MAERZ_1.lengthOfMonth();
        long stunden = ChronoUnit.HOURS.between(b, e);
        root.update("INSERT INTO messreihe_periode (tag, art, tenant_id, entity_id, messkanal, zeitzone, zeitzone_herkunft, "
                + "beginn, ende, stunden, teile_erwartet, teile_vorhanden, teile_endgueltig, wertart, menge, menge_zustand, "
                + "kennzeichen, erhalten, erwartet, abdeckung_prozent, zustand, endgueltig_ab, version) VALUES (?, 'monat', "
                + "?, ?, ?, 'Europe/Berlin', 'vorgabe', ?, ?, ?, ?, ?, ?, 'counter', ?::numeric, 'vollständig', '[]'::jsonb, "
                + "?, ?, 100, 'endgueltig', ?, 1)", MAERZ_1, w.mandant(), w.komponenten().get(kennzeichen), ENERGIE,
                Timestamp.from(b), Timestamp.from(e), stunden, tage, tage, tage, menge, stunden * 60, stunden * 60,
                Timestamp.from(e.plus(Duration.ofDays(7))));
    }

    /** Ein wirksamer März-Wert einer Bezugsgröße, eingetragen nach dem Monatsende (E16). */
    private static void bezugswert(Welt w, String kennzeichen, String betrag) {
        UUID bg = root.queryForObject("SELECT id FROM bezugsgroesse WHERE tenant_id = ? AND kennzeichen = ?", UUID.class,
                w.mandant(), kennzeichen);
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                + "periode_von, periode_bis, zeitzone, fassung, vorgang, status, betrag, herkunft_art, actor_sub, "
                + "actor_name, actor_rolle, actor_art, created_at) VALUES (?, ?, 'periodenwert', 'Stück', 'monat', ?, ?, "
                + "'Europe/Berlin', 1, 'erstwert', 'wirksam', ?, 'eingabe', 'sub-ik', 'Ines Kaltenbach', 'energiemanager', "
                + "'kunde', ?)", w.mandant(), bg, MAERZ_1, MAERZ_31, new BigDecimal(betrag),
                Timestamp.from(MAERZ_1.plusMonths(1).atStartOfDay(ZONE).plusHours(9).toInstant()));
    }

    // ================================================================ die Korrektur (an Stelle von AP-08)

    @FunctionalInterface
    private interface Schritt {
        void fahren(Connection con) throws SQLException;
    }

    /** EINE Transaktion wie ein Anlass der Kaskade: alles oder nichts, als Verwaltungsrolle. */
    private void inDerKaskade(Schritt schritt) {
        admin.execute((Connection con) -> {
            boolean autoCommit = con.getAutoCommit();
            con.setAutoCommit(false);
            try {
                schritt.fahren(con);
                con.commit();
                return null;
            } catch (Exception e) {
                con.rollback();
                throw e instanceof SQLException sql ? sql : new SQLException("Kaskade abgebrochen", e);
            } finally {
                con.setAutoCommit(autoCommit);
            }
        });
    }

    /** K-2026-0007, freigegeben — der Beleg, den die Naht als Anlass nennt. */
    private static void korrekturK7(Welt w) {
        String reihen = MAPPER.createArrayNode().add(MAPPER.createObjectNode()
                .put("entity_id", w.komponenten().get("MS-12").toString()).put("messkanal", ENERGIE)).toString();
        root.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, art, reihen, von, bis, "
                + "begruendung, vorschau, actor_sub, actor_name, actor_rolle, actor_art, created_at) VALUES (?, "
                + "'K-2026-0007', 1, 'vorschlag', 'nachlieferung_nach_endgueltigkeit', ?::jsonb, "
                + "'2026-03-01T00:00:00+01:00', '2026-04-01T00:00:00+02:00', ?, '[{}]'::jsonb, 'kc-ines-kaltenbach', "
                + "'Ines Kaltenbach', 'energiemanager', 'kunde', '2026-04-11T16:40:00+02:00')", w.mandant(), reihen,
                "Zählerablesung 31.03. berichtigt (Ablesefehler 60 kWh)");
        root.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, grund, actor_sub, actor_name, "
                + "actor_rolle, actor_art, created_at) VALUES (?, 'K-2026-0007', 2, 'freigegeben', NULL, "
                + "'kc-ines-kaltenbach', 'Ines Kaltenbach', 'energiemanager', 'kunde', '2026-04-12T11:05:33+02:00')",
                w.mandant());
    }

    /** Die Monats-Version 2 der Reihe von MS-12, so wie die Monats-Stufe der Kaskade sie schreibt: 6 040 kWh, endgültig. */
    private static void ms12Version2(Connection con, Welt w) throws SQLException {
        Instant b = MAERZ_1.atStartOfDay(ZONE).toInstant();
        Instant e = MAERZ_1.plusMonths(1).atStartOfDay(ZONE).toInstant();
        int minuten = (int) ChronoUnit.MINUTES.between(b, e);
        KaskadeStufen.Inhalt inhalt = new KaskadeStufen.Inhalt("counter", new BigDecimal("6040"), "vollständig", List.of(),
                minuten, minuten, 100, null, null, null, null, null, null, null, null, null, null, null, "endgueltig");
        KaskadeStufen.periodeSchreiben(con, new KaskadeStufen.Periode(w.mandant(), "monat", w.komponenten().get("MS-12"),
                ENERGIE, null, b, e, MAERZ_1, ZONE), 2, inhalt, List.of(K7), List.of(), K7, 2, null);
    }

    /** Was die Kaskade nach K-2026-0007 an die Nähte gibt: die Reihe, der März, der Zeitpunkt des Laufs. */
    private static KorrekturKaskade.Betroffen betroffen(Welt w) {
        return new KorrekturKaskade.Betroffen(w.mandant(), K7, 2, KorrekturKaskade.FREIGEGEBEN,
                List.of(new KorrekturKaskade.Reihe(w.komponenten().get("MS-12"), ENERGIE)),
                MAERZ_1.atStartOfDay(ZONE).toInstant(), MAERZ_1.plusMonths(1).atStartOfDay(ZONE).toInstant(), ZONE, MAERZ_1,
                MAERZ_31, List.of(), List.of(), 1, T_KASKADE);
    }

    // ================================================================ die Kennzahlen (Route und gespeicherte Zeile)

    @SafeVarargs
    private UUID anlegen(Welt w, String kennzeichen, String rechenform, String geltungArt, UUID geltung,
            Map<String, Object>... eingaenge) throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", kennzeichen);
        m.put("name", "Kennzahl " + kennzeichen);
        m.put("rechenform", rechenform);
        m.put("geltung_art", geltungArt);
        m.put("geltung_id", geltung.toString());
        m.put("eingaenge", List.of(eingaenge));
        Antwort a = ruf(w, HttpMethod.POST, PFAD, m);
        assertThat(a.status()).as(a.body().toString()).isEqualTo(201);
        return UUID.fromString(a.body().get("id").asText());
    }

    /** Fassung 2 von KZ-0002 ab 01.03.2026: der Hauptzähler Lindach statt des Unterzählers — nach der echten Uhr rückwirkend. */
    private void fassungZwei(Welt w, String kennzahl) throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("gueltig_ab", MAERZ_1.toString());
        m.put("begruendung", "Die Montage Lindach wird seit März über den Hauptzähler geführt.");
        m.put("eingaenge", List.of(e("zaehler", "messstelle", "MS-16"), e("nenner", "bezugsgroesse", "BZ-7")));
        Antwort a = ruf(w, HttpMethod.POST, PFAD + "/" + w.kz().get(kennzahl) + "/fassungen", m);
        assertThat(a.status()).as(a.body().toString()).isBetween(200, 201);
        assertThat(root.queryForObject("SELECT rueckwirkend FROM kennzahl_fassung WHERE kennzahl_id = ? AND nummer = 2",
                Boolean.class, w.kz().get(kennzahl))).as("rückwirkend nach der echten Uhr").isTrue();
    }

    private static Map<String, Object> e(String rolle, String art, String kennzeichen) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("rolle", rolle);
        m.put("art", art);
        m.put("kennzeichen", kennzeichen);
        return m;
    }

    /** Die aktuelle März-Zeile einer Kennzahl: höchste Version, dann jüngstes {@code berechnet_am}. */
    private static Map<String, Object> zeile(Welt w, String kennzahl) {
        List<Map<String, Object>> z = root.queryForList("SELECT w.version, w.zustand, w.anlass_art FROM kennzahl_wert w "
                + "JOIN kennzahl k ON k.id = w.kennzahl_id WHERE w.tenant_id = ? AND k.kennzeichen = ? "
                + "AND w.periode_art = 'monat' AND w.periode_von = ? ORDER BY w.version DESC NULLS LAST, "
                + "w.berechnet_am DESC LIMIT 1", w.mandant(), kennzahl, MAERZ_1);
        assertThat(z).as(kennzahl + " März hat eine Zeile").hasSize(1);
        return z.get(0);
    }

    private Antwort ruf(Welt w, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-ines-" + w.mandant());
                    j.claim("preferred_username", "Ines Kaltenbach");
                    j.claim("tenant_id", w.mandant().toString());
                }))
                .contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
