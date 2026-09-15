package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.measurement.BestandGeraeteCsvVergleich;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.measurement.MeasurementHistoryService;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.uems.RechteAbleitung.KontoZustand;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Zuweisung;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ConditionEvaluationResult;
import org.junit.jupiter.api.extension.ExecutionCondition;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Bestandsschutz des Berichtswesens (UEMS AP-12 IP-15, Meilenstein 7 „freigabefähig“): die GANZE Berichts-Maschine
 * läuft über dem Kern, und am Kern ändert sich kein Byte — die Rollups (Telemetrie v1 und v2, Geräte-Messwerte 5 und 15
 * Minuten), Verlauf und Export eines Messwerts (auch der Bestand-Geräte-CSV über seine Route, Spalten und Zeilen) und jede
 * Tabelle außerhalb von {@code bericht%}.
 *
 * <p><b>Die Maschine</b> ist, was die Pakete davor gebaut haben, in der Reihenfolge des Betriebs: der Oktober von MS-12 an
 * der echten Kette bis endgültig (Vergleichsstand), dann Bericht anlegen und Entwurf lesen (IP-5/IP-7), Nr. 1 freigeben
 * (IP-7), Stand, PDF und CSV abrufen (IP-10/IP-11), eine rückwirkende Ortskorrektur über den Strukturänderungs-Läufer
 * (IP-9, Pfad 2), die Korrektur K-2026-0007 über die echte {@link BerichtKaskade} in der Transaktion der Kaskade (IP-8,
 * Pfad 1) und die Revision Nr. 2. Jeder Schritt prüft, dass er wirklich geschrieben hat — sonst bewiese der Vergleich
 * nichts. Der Belegschutz (IP-12) schreibt bei seiner Ablehnung nichts; das beweist schon
 * {@code UemsBelegschutzApiTest.b12_…} mit dem Fingerabdruck der ganzen Datenbank.
 *
 * <p><b>Was sich außerhalb von {@code bericht%} ändern DARF, steht mit Namen da</b> — und nur die Zeilen, nie die Tabelle:
 * <ul>
 *   <li>AP-12 selbst: die vier Meldungen {@link #BERICHTS_MELDUNGEN} in {@code messreihe_ereignis};</li>
 *   <li>der Test an Stelle von AP-04: die Protokollzeile {@code ort_korrigiert} von MS-12 in {@code messstelle_aenderung};</li>
 *   <li>der Test an Stelle von AP-08: die Korrektur K-2026-0007 in {@code messreihe_korrektur} und die Monats-Version 2
 *       der Reihe von MS-12 in {@code messreihe_periode_version} — die schriebe die Kaskaden-Stufe auch ohne AP-12.</li>
 * </ul>
 * Die Kaskade OHNE Berichte ({@link BerichteNaht.Keine}) prüft {@code UemsKorrekturKaskadeTest}.
 *
 * <p>Testcontainers: ohne Docker ist dieser Test LAUT übersprungen ({@link DockerPflicht}) — nie still grün.
 */
@ExtendWith(UemsBerichteBestandsschutzTest.DockerPflicht.class)
@Testcontainers
@SpringBootTest
@AutoConfigureMockMvc
class UemsBerichteBestandsschutzTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    /** Die Vorgabe aus {@code application.yml} — dieselbe Rolle wie der Verwaltungs-Pool der Anwendung, sonst scheitern dessen Beans beim Start. */
    private static final String ADMIN_PW = "voltpilot_admin_dev_pw";
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final String KANAL = "deye.hybrid_1p.meter.generator-energy";
    private static final String ENERGIE = "sunspec.model_203.totwhimp";
    private static final String KATALOG = "2026.09.11.1";
    private static final String KENNUNG = "BR-2026-0001";
    private static final String PFAD = "/api/v1/berichte/" + KENNUNG;
    private static final String K7 = "K-2026-0007";
    private static final Map<String, Benutzer> PERSONEN = new ConcurrentHashMap<>();

    /** Die Meldungen, die AP-12 in die geteilte Ereignis-Tabelle schreibt (Vokabular AP-12 IP-4). */
    static final List<String> BERICHTS_MELDUNGEN = List.of("bericht_freigegeben", "bericht_revision_angestossen",
            "bericht_entwurf_neu_gebildet", "bericht_abgerufen");

    private static final Instant OKTOBER = Instant.parse("2026-09-30T22:00:00Z");
    private static final Instant NOVEMBER = Instant.parse("2026-10-31T23:00:00Z");
    private static final LocalDate OKTOBER_1 = LocalDate.parse("2026-10-01");
    private static final BigDecimal STAND_1_OKTOBER = new BigDecimal("400000");
    private static final Instant T_VERDICHTET = Instant.parse("2026-11-02T00:30:00Z");
    private static final Instant T_TAKT = Instant.parse("2026-11-02T01:00:00Z");
    private static final Instant T_ENDGUELTIG = Instant.parse("2026-11-09T07:00:00Z");
    /** Die rückwirkende Ortskorrektur an MS-12 (Pfad 2) — nach Nr. 1, vor der Korrektur. */
    private static final Instant T_ORT_KORRIGIERT = Instant.parse("2026-11-11T09:00:00Z");
    private static final Instant T_STRUKTUR = Instant.parse("2026-11-11T09:05:00Z");
    /** Die Kaskade im Takt der Freigabe von K-2026-0007 (Pfad 1). */
    private static final Instant T_KASKADE = Instant.parse("2026-11-12T09:05:33Z");

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
    BerichtService berichte;

    @Autowired
    BerichtAbzugBildung bildung;

    @Autowired
    MeasurementHistoryService verlauf;

    @MockBean
    KennzahlAufrufer aufrufer;

    private JdbcTemplate root;
    private JdbcTemplate admin;
    private UUID kb;
    private UUID st1;
    private UUID anlage;
    private UUID box;
    private UUID entity;
    private UUID ms12;
    /** Die zwei Boxen des Kerns: A trägt Telemetrie v1/v2 und den Zählerstand im Takt 900 s, B den Langzeit-Takt 300 s. */
    private UUID boxA;
    private UUID komponenteA;
    private UUID boxB;
    private UUID komponenteB;
    private Wer ines;
    private Wer jonas;
    private ViertelstundeVerdichter verdichter;
    private TagVerdichter tage;
    private EndgueltigkeitLaeufer laeufer;
    private BerichtKaskade pfadEins;
    private StrukturAenderungLaeufer pfadZwei;
    private Object uhrVorher;

    private record Wer(String sub, String name) {}

    private record Antwort(int status, JsonNode body, String text) {}

    @BeforeEach
    void rechteUndUhr() {
        doAnswer(inv -> {
            ProtokollAkteur a = inv.getArgument(0);
            Benutzer b = PERSONEN.get(a.sub());
            return b != null ? b : KorrekturRechte.benutzer(a);
        }).when(aufrufer).benutzer(any());
        uhrVorher = ReflectionTestUtils.getField(verlauf, "uhr");
        ReflectionTestUtils.setField(verlauf, "uhr", UHR);
    }

    @AfterEach
    void uhrenZurueck() {
        berichte.uhrStellen(Clock.systemUTC());
        ReflectionTestUtils.setField(verlauf, "uhr", uhrVorher);
        TenantContext.clear();
    }

    @Test
    void dieGanzeBerichtsMaschineLaeuftUndDerKernBleibtByteGleich() throws Exception {
        welt();
        kette();
        // Die Hintergrund-Jobs der Datenbank (Rollups, Aufbewahrung) rechnen sonst zwischen den Fingerabdrücken.
        root.queryForList("SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs "
                + "WHERE job_id >= 1000");

        // ---- Der Kern ohne AP-12: der Oktober von MS-12 an der echten Kette, Rohwerte und Rollups -----------------------
        saeen(rohwerte(OKTOBER, NOVEMBER));
        verdichten(T_VERDICHTET);
        tage.rueckrechnenGanz(T_TAKT, 200);
        laeufer.takt(T_TAKT);
        laeufer.takt(T_ENDGUELTIG);
        assertThat(zahl("SELECT count(*) FROM messreihe_periode WHERE tenant_id = ? AND art = 'monat' "
                + "AND tag = DATE '2026-10-01' AND zustand = 'endgueltig'", kb)).as("der Oktober ist endgültig").isEqualTo(1);
        kern();

        Map<String, String> vorher = fingerabdruck();
        for (String rollup : ROLLUPS) {
            assertThat(vorher.get(rollup)).as("der Aufbau füllt " + rollup).isNotEqualTo(Bestandsschutz.LEER);
        }
        assertThat(datenzeilen(export("decoded"))).as("der Export trägt die Rohwerte").isEqualTo(24);
        assertThat(zahl("SELECT count(*) FROM bericht WHERE tenant_id = ?", kb)).as("vorher gibt es keinen Bericht").isZero();

        // ---- IP-5/IP-7: anlegen, Entwurf lesen, Nr. 1 freigeben ---------------------------------------------------------
        uhrBerichte("2026-11-10T08:55:00+01:00");
        Antwort angelegt = ok(ruf(ines, HttpMethod.POST, "/api/v1/berichte", Map.of("vorlage", "monatsbericht_standort",
                "geltung_id", st1.toString(), "zeitraum", "2026-10")), 201);
        assertThat(angelegt.body().path("kennung").asText()).isEqualTo(KENNUNG);
        ok(ruf(ines, HttpMethod.GET, PFAD + "/entwurf", null), 200);
        uhrBerichte("2026-11-10T09:02:00+01:00");
        assertThat(ok(ruf(ines, HttpMethod.POST, PFAD + "/freigeben",
                Map.of("entwurf_datenstand", "2026-11-10T08:55:00+01:00")), 201).body().path("nr").asInt()).isEqualTo(1);

        // ---- IP-10/IP-11: Stand, PDF und CSV abrufen, Liste und Vergleich lesen ------------------------------------------
        ok(ruf(jonas, HttpMethod.GET, PFAD + "/staende/1", null), 200);
        assertThat(datei(jonas, PFAD + "/staende/1/pdf")).isNotEmpty();
        assertThat(datei(jonas, PFAD + "/staende/1/csv")).isNotEmpty();
        ok(ruf(jonas, HttpMethod.GET, "/api/v1/berichte", null), 200);
        ok(ruf(jonas, HttpMethod.GET, PFAD + "/entwurf/vergleich?gegen=1", null), 200);
        assertThat(zahl("SELECT count(*) FROM bericht_abruf WHERE tenant_id = ?", kb)).as("zwei Abrufe protokolliert")
                .isEqualTo(2);

        // ---- IP-9, Pfad 2: eine rückwirkende Ortskorrektur an MS-12 (die Zeile schreibt der Test an Stelle von AP-04) ---
        root.update("INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, art, alt, neu, gilt_ab, rueckwirkend, "
                + "actor_sub, actor_name, actor_rolle, actor_art, created_at) VALUES (?, ?, 'ort_korrigiert', '{}'::jsonb, "
                + "'{}'::jsonb, ?, true, 'kc-ines-kaltenbach', 'Ines Kaltenbach', 'energiemanager', 'kunde', ?)", kb, ms12,
                Timestamp.from(OKTOBER), Timestamp.from(T_ORT_KORRIGIERT));
        StrukturAenderungLaeufer.Lauf struktur = pfadZwei.lauf(T_STRUKTUR);
        assertThat(struktur.gescheitert()).isEmpty();
        assertThat(struktur.berichte()).as("Pfad 2 benachrichtigt den Bericht").isPositive();
        assertThat(zahl("SELECT count(*) FROM bericht_revision_anstoss WHERE tenant_id = ?", kb))
                .as("Nr. 1 bekommt den Anstoß aus Pfad 2").isEqualTo(1);

        // ---- IP-8, Pfad 1: K-2026-0007 — Stufe (an Stelle von AP-08) und Berichts-Naht in EINER Transaktion ------------
        korrekturK7();
        inDerKaskade(con -> {
            oktoberVersion2(con);
            KorrekturKaskade.berichteBenachrichtigen(con, pfadEins, betroffen());
        });
        assertThat(zahl("SELECT count(*) FROM bericht_revision_anstoss WHERE tenant_id = ? AND anlass_kennung = ?", kb, K7))
                .as("Nr. 1 bekommt den Anstoß aus Pfad 1").isEqualTo(1);
        assertThat(root.queryForObject("SELECT gebildet_von FROM bericht_entwurf WHERE tenant_id = ?", String.class, kb))
                .as("der Entwurf ist von der Kaskade neu gebildet").isEqualTo("kaskade");

        // ---- Die Revision: Nr. 2 freigeben und abrufen -------------------------------------------------------------------
        Instant datenstandNr2 = root.queryForObject("SELECT datenstand FROM bericht_entwurf WHERE tenant_id = ?",
                Timestamp.class, kb).toInstant();
        uhrBerichte("2026-11-16T14:20:00+01:00");
        assertThat(ok(ruf(ines, HttpMethod.POST, PFAD + "/freigeben",
                Map.of("entwurf_datenstand", MessstelleWerteRegeln.iso(datenstandNr2, BERLIN))), 201).body().path("nr")
                .asInt()).isEqualTo(2);
        assertThat(datei(jonas, PFAD + "/staende/2/csv")).isNotEmpty();
        assertThat(zahl("SELECT count(*) FROM messreihe_ereignis WHERE tenant_id = ? AND art = ANY (?)", kb,
                BERICHTS_MELDUNGEN.toArray(String[]::new))).as("AP-12 hat in die geteilte Tabelle geschrieben").isPositive();

        Map<String, String> nachher = fingerabdruck();
        assertThat(Bestandsschutz.abweichungen(vorher, nachher)).as("der Kern nach der Berichts-Maschine").isEmpty();
        assertThat(nachher.keySet()).containsExactlyElementsOf(vorher.keySet());
    }

    // ================================================================ der Fingerabdruck

    /**
     * Jede Tabelle außerhalb von {@code bericht%} (die geteilten Tabellen ohne die benannten Zeilen, siehe Klasse) und die
     * Flächen des Kerns: Verlauf und Export eines Messwerts über zwei Stunden (gelesen und roh) und über einen Monat, dazu
     * der Bestand-Geräte-CSV über seine Route ohne die neun Kopfzeilen von AP-12 IP-10 (die tragen den Abrufzeitpunkt).
     */
    private Map<String, String> fingerabdruck() throws Exception {
        Map<String, String> f = new TreeMap<>(Bestandsschutz.fingerabdruck(root, List.of("bericht%")));
        f.put("messreihe_ereignis", Bestandsschutz.inhalt(root, "messreihe_ereignis", "NOT (t.art = ANY (?))",
                (Object) BERICHTS_MELDUNGEN.toArray(String[]::new)));
        f.put("messstelle_aenderung", Bestandsschutz.inhalt(root, "messstelle_aenderung",
                "NOT (t.messstelle_id = ? AND t.art = 'ort_korrigiert')", ms12));
        f.put("messreihe_korrektur", Bestandsschutz.inhalt(root, "messreihe_korrektur", "t.kennung <> ?", K7));
        f.put("messreihe_periode_version", Bestandsschutz.inhalt(root, "messreihe_periode_version",
                "NOT (t.entity_id = ? AND t.ebene = 'monat' AND t.version = 2)", entity));
        TenantContext.set(kb);
        try {
            for (String darstellung : List.of("decoded", "raw")) {
                MeasurementHistoryService.History h = verlauf.history(boxA, ENERGIE, "free", ROH_VON, ROH_BIS, darstellung,
                        null, komponenteA);
                f.put("Fläche Verlauf 2 h " + darstellung, md5(json.writeValueAsBytes(h)));
                f.put("Fläche Export 2 h " + darstellung, md5(verlauf.csv(h, BestandGeraeteCsvVergleich.erzeugung())));
            }
            MeasurementHistoryService.History monat = verlauf.history(boxA, ENERGIE, "free",
                    ROH_VON.minus(Duration.ofDays(30)), ROH_BIS, "decoded", null, komponenteA);
            f.put("Fläche Verlauf Monat", md5(json.writeValueAsBytes(monat)));
            f.put("Fläche Export Monat", md5(verlauf.csv(monat, BestandGeraeteCsvVergleich.erzeugung())));
        } finally {
            TenantContext.clear();
        }
        byte[] route = datei(jonas, "/api/v1/devices/" + boxA + "/measurement-selection/" + ENERGIE + "/export?range=free"
                + "&from=" + ROH_VON + "&to=" + ROH_BIS + "&representation=decoded&entityId=" + komponenteA);
        f.put("Fläche Bestand-Geräte-CSV über die Route", md5(BestandGeraeteCsvVergleich.ohneNeueKopfzeilen(route)));
        return f;
    }

    private byte[] export(String darstellung) {
        TenantContext.set(kb);
        try {
            return verlauf.csv(verlauf.history(boxA, ENERGIE, "free", ROH_VON, ROH_BIS, darstellung, null, komponenteA),
                    BestandGeraeteCsvVergleich.erzeugung());
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

    // ================================================================ die Welt (Werk Ahrenberg, MS-12)

    private void welt() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        kb = uuid("INSERT INTO tenant (name) VALUES ('Bestandsschutz AP-12') RETURNING id");
        UUID u = uuid("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH', "
                + "'Europe/Berlin') RETURNING id", kb);
        st1 = uuid("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", kb, u);
        anlage = uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-1') RETURNING id", kb);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, DATE '2024-03-12')", kb, anlage, st1);
        box = uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, 'claimed') RETURNING id",
                kb, anlage, "VP-BOX-IP15-MS12-" + UUID.randomUUID());
        entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, "
                + "communication, connection_json, created_at) VALUES (?, ?, 'grid-meter', 'Zähler Montage', 'grid-meter', ?, "
                + "'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, '2024-03-12T00:00:00Z') RETURNING id",
                kb, anlage, box);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, '2024-03-12T00:00:00Z', "
                + "?, 'test', 'pending_edge', 'live_power', 'fifteen_minute')", kb, anlage, box, entity, KANAL, KATALOG);
        ms12 = uuid("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, einheit, "
                + "wertart) VALUES (?, 'MS-12', 'Montage Linie M1', 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                + "'Zählerstand') RETURNING id", kb);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, DATE '2024-03-12')", kb, ms12, st1);
        UUID geraet = uuid("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? AND gueltig_bis IS NULL", entity);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_sub, actor_name, "
                + "actor_art) VALUES (?, ?, 'Wirkenergie', 'Bezug', ?, ?, ?, 'counter', 'zaehlerstand', 'fuehrend', "
                + "'2024-03-12T00:00:00Z', true, now(), 'sub', 'Probe', 'kunde')", kb, ms12, entity, geraet, KANAL);
        UUID[] a = kernBox("A");
        boxA = a[0];
        komponenteA = a[1];
        UUID[] b = kernBox("B");
        boxB = b[0];
        komponenteB = b[1];
        ines = person("kc-ines-" + kb, "Ines Kaltenbach", "energiemanager");
        jonas = person("kc-jonas-" + kb, "Jonas Wendlinger", "kundenadministrator");
    }

    /** Eine Box der Anlage mit einer Komponente und der Mess-Selektion des Zählerstands — ohne Messstelle, nur Kern. */
    private UUID[] kernBox(String name) {
        UUID b = uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, 'claimed') "
                + "RETURNING id", kb, anlage, "VP-BESTAND-IP15-" + name + "-" + UUID.randomUUID());
        UUID k = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, "
                + "communication, connection_json, created_at) VALUES (?, ?, 'modbus-generic', ?, 'modbus-generic', ?, "
                + "'modbus_tcp', '{\"unit_id\":1}'::jsonb, '2020-01-01T00:00:00Z') RETURNING id", kb, anlage,
                "Kernzähler " + name, b);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), ?, 'test', "
                + "'pending_edge', 'energy_counter', 'fifteen_minute')", kb, anlage, b, k, ENERGIE, KATALOG);
        return new UUID[] {b, k};
    }

    /** Die Läufe, wie der Betrieb sie fährt — beide Berichts-Pfade mit der echten {@link BerichtKaskade}. */
    private void kette() {
        MeasurementCatalog katalog = new MeasurementCatalog(MAPPER);
        SpaetankunftMelder melder = new SpaetankunftMelder();
        verdichter = new ViertelstundeVerdichter(admin, katalog, melder, 500, 40, 200_000);
        tage = new TagVerdichter(admin, katalog, 200, 40, 20_000, 200_000);
        // Diese Welt hat keine berechnete Messstelle: der Hook antwortet leer.
        BerechnetePeriodenLauf berechnete = mock(BerechnetePeriodenLauf.class);
        when(berechnete.zoneDesKundenbereichs(any())).thenReturn(BERLIN);
        laeufer = new EndgueltigkeitLaeufer(new EndgueltigkeitLauf(admin, 2000, 200), tage,
                new PeriodeVerdichter(admin, katalog, 50, 40, 2000), berechnete,
                new KorrekturVorschlagLauf(admin, verdichter, melder, 200));
        pfadEins = new BerichtKaskade(bildung);
        pfadZwei = new StrukturAenderungLaeufer(admin, new BerichtKaskade(bildung), 200);
    }

    private static Wer person(String sub, String name, String rolle) {
        PERSONEN.put(sub, new Benutzer(sub, name, Konto.vonCode("benutzer"), KontoZustand.AKTIV,
                List.of(new Zuweisung(Rolle.vonCode(rolle), null, null, null, Instant.EPOCH, null, null))));
        return new Wer(sub, name);
    }

    // ================================================================ der Kern: Rohwerte und Rollups

    /** Tagesmengen der Referenzdatei für MS-12 im Oktober 2026: 196 kWh, am 31.10. 220 kWh. */
    private static BigDecimal tagesmenge(LocalDate tag) {
        return new BigDecimal(tag.getDayOfMonth() == 31 ? "220" : "196");
    }

    /** Die Zählerstände von MS-12 im Minutentakt von {@code von} bis {@code bis} einschließlich (wie IP-16, ohne Lücke). */
    private static List<Object[]> rohwerte(Instant von, Instant bis) {
        Map<LocalDate, BigDecimal> tagesbeginn = new HashMap<>();
        BigDecimal summe = STAND_1_OKTOBER;
        for (LocalDate d = OKTOBER_1; !d.isAfter(LocalDate.of(2026, 11, 1)); d = d.plusDays(1)) {
            tagesbeginn.put(d, summe);
            summe = summe.add(tagesmenge(d));
        }
        List<Object[]> zeilen = new ArrayList<>();
        for (Instant t = von; !t.isAfter(bis); t = t.plusSeconds(60)) {
            LocalDate tag = t.atZone(BERLIN).toLocalDate();
            Instant beginn = tag.atStartOfDay(BERLIN).toInstant();
            long minuten = Duration.between(beginn, tag.plusDays(1).atStartOfDay(BERLIN).toInstant()).toMinutes();
            BigDecimal stand = tagesbeginn.get(tag).add(tagesmenge(tag)
                    .multiply(BigDecimal.valueOf(Duration.between(beginn, t).toMinutes()))
                    .divide(BigDecimal.valueOf(minuten), 4, RoundingMode.HALF_UP));
            zeilen.add(new Object[] {Timestamp.from(t), Timestamp.from(t.plusSeconds(2)), stand.doubleValue(),
                    t.getEpochSecond()});
        }
        return zeilen;
    }

    private void saeen(List<Object[]> zeilen) {
        List<Object[]> stapel = new ArrayList<>();
        for (Object[] z : zeilen) {
            stapel.add(new Object[] {z[0], z[1], kb, anlage, box, KANAL, z[2], z[3], entity});
        }
        for (int i = 0; i < stapel.size(); i += 5000) {
            root.batchUpdate("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, "
                    + "point_key, raw_numeric, quality, catalog_version, edge_sequence, aggregation_kind, entity_id, "
                    + "applied_revision, value_kind, role, delivery, delay_s) VALUES (?, ?, ?, ?, ?, ?, ?, 'good', "
                    + "'2026.09.11.1', ?, 'counter', ?, 3, 'counter', 'fuehrend', 'direkt', 2) ON CONFLICT DO NOTHING",
                    stapel.subList(i, Math.min(i + 5000, stapel.size())));
        }
    }

    private void verdichten(Instant jetzt) {
        for (int i = 0; i < 200; i++) {
            ViertelstundeVerdichter.Lauf l = verdichter.lauf(jetzt);
            if (l.rueckrechnungFertig() && zahl("SELECT count(*) FROM messreihe_viertelstunde_arbeit") == 0) {
                return;
            }
        }
        throw new AssertionError("die Verdichtung wird nicht fertig");
    }

    /**
     * Zwei Stunden an Box A: Telemetrie v1 und v2 und der Zählerstand als Geräte-Messwert (Takt 900 s), an Box B der
     * Langzeit-Takt 300 s, den nur der 5-Minuten-Rollup liest; dann die Rollups (wie {@code UemsKennzahlenBestandsschutzTest}).
     */
    private void kern() {
        for (int i = 0; i < 24; i++) {
            Timestamp zeit = Timestamp.from(ROH_VON.plus(Duration.ofMinutes(5L * i)));
            root.update("INSERT INTO device_measurement_sample (time, tenant_id, site_id, device_id, point_key, "
                    + "raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, aggregation_kind, "
                    + "long_term_cadence_s, entity_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'good', ?, ?, 'counter', 300, ?)",
                    zeit, kb, anlage, boxB, ENERGIE, 2_000_000.0 + i * 40, 2_000_000.0 + i * 40, KATALOG, 20_000 + i,
                    komponenteB);
            root.update("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw, load_kw, pv_power_kw) "
                    + "VALUES (?, ?, ?, ?, ?, ?, 0)", zeit, kb, anlage, boxA, 2.0 + i / 10.0, 2.0 + i / 10.0);
            root.update("INSERT INTO telemetry_v2 (time, tenant_id, site_id, device_id, entity_id, channel, value) "
                    + "VALUES (?, ?, ?, ?, ?, 'active_power', ?)", zeit, kb, anlage, boxA, komponenteA.toString(),
                    1500.0 + i * 10);
            root.update("INSERT INTO device_measurement_sample (time, tenant_id, site_id, device_id, point_key, "
                    + "raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, aggregation_kind, "
                    + "long_term_cadence_s, entity_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'good', ?, ?, 'counter', 900, ?)",
                    zeit, kb, anlage, boxA, ENERGIE, 1_000_000.0 + i * 125, 1_000_000.0 + i * 125, KATALOG, 10_000 + i,
                    komponenteA);
        }
        String seit = ROH_TAG.atStartOfDay().toInstant(ZoneOffset.UTC).toString();
        root.execute("CALL refresh_telemetry_rollups('" + seit + "')");
        root.execute("CALL refresh_telemetry_v2_rollups('" + seit + "')");
        root.execute("CALL refresh_device_measurement_rollup('device_measurement_rollup_5m'::regclass, "
                + "interval '5 minutes', '" + seit + "')");
        root.execute("CALL refresh_device_measurement_rollup('device_measurement_rollup_15m'::regclass, "
                + "interval '15 minutes', '" + seit + "')");
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
    private void korrekturK7() {
        String reihen = MAPPER.createArrayNode().add(MAPPER.createObjectNode().put("entity_id", entity.toString())
                .put("messkanal", KANAL)).toString();
        root.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, art, reihen, von, bis, "
                + "begruendung, vorschau, actor_sub, actor_name, actor_rolle, actor_art, created_at) VALUES (?, ?, 1, "
                + "'vorschlag', 'nachlieferung_nach_endgueltigkeit', ?::jsonb, '2026-10-01T00:00:00+02:00', "
                + "'2026-11-01T00:00:00+01:00', ?, '[{}]'::jsonb, 'kc-ines-kaltenbach', 'Ines Kaltenbach', 'energiemanager', "
                + "'kunde', '2026-11-11T16:40:00+01:00')", kb, K7, reihen, "Zählerablesung 31.10. berichtigt (Ablesefehler 60 kWh)");
        root.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, grund, actor_sub, actor_name, "
                + "actor_rolle, actor_art, created_at) VALUES (?, ?, 2, 'freigegeben', NULL, 'kc-ines-kaltenbach', "
                + "'Ines Kaltenbach', 'energiemanager', 'kunde', '2026-11-12T10:05:33+01:00')", kb, K7);
    }

    /** Die Monats-Version 2 der Reihe von MS-12, so wie die Monats-Stufe der Kaskade sie schreibt: 6 040 kWh, endgültig. */
    private void oktoberVersion2(Connection con) throws SQLException {
        int minuten = (int) ChronoUnit.MINUTES.between(OKTOBER, NOVEMBER);
        KaskadeStufen.Inhalt inhalt = new KaskadeStufen.Inhalt("counter", new BigDecimal("6040"), "vollständig", List.of(),
                minuten, minuten, 100, null, null, null, null, null, null, null, null, null, null, null, "endgueltig");
        KaskadeStufen.periodeSchreiben(con, new KaskadeStufen.Periode(kb, "monat", entity, KANAL, null, OKTOBER, NOVEMBER,
                OKTOBER_1, BERLIN), 2, inhalt, List.of(K7), List.of(), K7, 2, null);
    }

    /** Was die Kaskade nach K-2026-0007 an die Nähte gibt: die Reihe, der Oktober, der Zeitpunkt des Laufs. */
    private KorrekturKaskade.Betroffen betroffen() {
        return new KorrekturKaskade.Betroffen(kb, K7, 2, KorrekturKaskade.FREIGEGEBEN,
                List.of(new KorrekturKaskade.Reihe(entity, KANAL)), OKTOBER, NOVEMBER, BERLIN, OKTOBER_1,
                LocalDate.parse("2026-10-31"), List.of(), List.of(), 1, T_KASKADE);
    }

    // ================================================================ Hilfen

    private void uhrBerichte(String zeit) {
        berichte.uhrStellen(Clock.fixed(OffsetDateTime.parse(zeit).toInstant(), ZoneOffset.UTC));
    }

    private long zahl(String sql, Object... args) {
        return root.queryForObject(sql, Long.class, args);
    }

    private UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
    }

    private static Antwort ok(Antwort a, int status) {
        assertThat(a.status()).as(a.text()).isEqualTo(status);
        return a;
    }

    private MockHttpServletRequestBuilder als(Wer wer, HttpMethod methode, String pfad) {
        return request(methode, URI.create(pfad))
                .with(jwt().jwt(j -> {
                    j.subject(wer.sub());
                    j.claim("preferred_username", wer.name());
                    j.claim("tenant_id", kb.toString());
                }))
                .contentType(MediaType.APPLICATION_JSON);
    }

    private Antwort ruf(Wer wer, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = als(wer, methode, pfad);
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text),
                text);
    }

    private byte[] datei(Wer wer, String pfad) throws Exception {
        MvcResult r = mvc.perform(als(wer, HttpMethod.GET, pfad)).andReturn();
        assertThat(r.getResponse().getStatus()).as(pfad + " " + r.getResponse().getContentAsString()).isEqualTo(200);
        return r.getResponse().getContentAsByteArray();
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource d = new PGSimpleDataSource();
        d.setUrl(POSTGRES.getJdbcUrl());
        d.setUser(user);
        d.setPassword(password);
        return d;
    }

    /**
     * Ohne Docker ist der Bestandsschutz NICHT gelaufen: der Test wird mit einem Satz übersprungen, der das sagt — auf der
     * Konsole und im Bericht der Testläufe. {@code @Testcontainers(disabledWithoutDocker = true)} übersprünge still.
     */
    static final class DockerPflicht implements ExecutionCondition {
        @Override
        public ConditionEvaluationResult evaluateExecutionCondition(ExtensionContext context) {
            if (DockerClientFactory.instance().isDockerAvailable()) {
                return ConditionEvaluationResult.enabled("Docker ist da — der Bestandsschutz läuft");
            }
            String satz = "ÜBERSPRUNGEN: " + context.getDisplayName() + " — der Bestandsschutz der Berichte (UEMS AP-12 "
                    + "IP-15) ist NICHT gelaufen, weil Docker fehlt. Ein grüner Lauf ohne diesen Test beweist nichts.";
            System.err.println(satz);
            return ConditionEvaluationResult.disabled(satz);
        }
    }
}
