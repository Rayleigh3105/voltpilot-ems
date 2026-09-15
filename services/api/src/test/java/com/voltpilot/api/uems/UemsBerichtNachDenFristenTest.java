package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.MessreiheKorrekturRepository.Korrektur;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.uems.RechteAbleitung.KontoZustand;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Zuweisung;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.Date;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;
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
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * <b>Die Abnahme des Captains, in Code</b> (UEMS AP-12 IP-16, E1 = A, Fälle B1/B16): „Ein freigegebener Bericht lässt sich
 * trotz späterer Korrekturen und abgelaufener Rohdaten erklären.“ Genau dafür ist ein Berichtsstand eine KOPIE und kein
 * Verweis — dieser Test beweist, dass die Entscheidung trägt.
 *
 * <p>Die Geschichte von B1 an der echten Kette, ohne eine Zeile von Hand: Zählerstände von MS-12 (Werk Ahrenberg, Oktober
 * 2026, Tagesmengen der Referenzdatei 196 kWh, am 31.10. 220 kWh) → Viertelstunden, Tage, Monat → endgültig am 08.11. →
 * Ines legt den Monatsbericht an und gibt Nr. 1 frei (Route, 10.11.2026) → Werte vom 18.10. kommen nach der Frist an, der
 * Vorschlag wird freigegeben, die Korrektur-Kaskade bildet Version 2 und stößt den Bericht an (12.11.2026 10:05:33, Pfad 1
 * über die echte {@link BerichtKaskade}) → Ines gibt Nr. 2 frei (16.11.2026). Dann fallen die Fristen: was die
 * Aufbewahrung am 02.11.2036 entfernt hätte — {@code messreihe_periode}, {@code messreihe_tag},
 * {@code messreihe_viertelstunde} und die Rohtabellen {@code device_measurement_sample} und {@code telemetry_v2} bis zum
 * Ende des Oktobers —, wird per SQL gelöscht und GEZÄHLT (vorher Zeilen, nachher keine). Danach gilt: Nr. 1 und Nr. 2 sind
 * lesbar, Abzug und Prüfsumme Zeichen für Zeichen wie vorher, PDF und CSV byte-gleich, und {@code werte?version=1}
 * antwortet 404 {@code wert_nicht_mehr_gespeichert} mit dem Satz aus {@code bericht-vectors.json} B16 (Familie
 * {@code ablauf}). Zwei Gegenproben halten die 404 ehrlich: am 02.11.2036 OHNE Löschen steht die Zahl noch da, und
 * innerhalb der Aufbewahrung ist eine gelöschte Periode „keine Werte“ — die Antwort kommt nie von der Uhr allein.
 *
 * <p>Annahme (nicht in der Referenzdatei): die Korrektur trägt hier eine Nachlieferung (Muster F10 aus
 * {@code verbrauch-vectors.json}) statt des Ablesefehlers von K-2026-0007 — Kaskade und Berichts-Naht behandeln beide
 * gleich. Die Zahlen von Nr. 1 und Nr. 2 sind die, die die Verdichtung bildet.
 *
 * <p>Testcontainers: ohne Docker ist dieser Test LAUT übersprungen ({@link DockerPflicht}) — nie still grün.
 */
@ExtendWith(UemsBerichtNachDenFristenTest.DockerPflicht.class)
@Testcontainers
@SpringBootTest
@AutoConfigureMockMvc
class UemsBerichtNachDenFristenTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final ObjectMapper EXAKT = new ObjectMapper()
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
            .setNodeFactory(JsonNodeFactory.withExactBigDecimals(true));
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    /** Ein Zählerstand in kWh aus dem ausgelieferten Katalog. */
    private static final String KANAL = "deye.hybrid_1p.meter.generator-energy";
    private static final String KENNUNG = "BR-2026-0001";
    private static final String PFAD = "/api/v1/berichte/" + KENNUNG;
    private static final String WERTE = "/api/v1/messstellen/MS-12/werte";
    private static final Map<String, Benutzer> PERSONEN = new ConcurrentHashMap<>();
    private static final ProtokollAkteur INES = new ProtokollAkteur("kc-ines-kaltenbach", "Ines Kaltenbach",
            "energiemanager", "kunde");

    /** Oktober 2026 in der Zone des Standorts: 01.10. 00:00 MESZ bis 01.11. 00:00 MEZ. */
    private static final Instant OKTOBER = Instant.parse("2026-09-30T22:00:00Z");
    private static final Instant NOVEMBER = Instant.parse("2026-10-31T23:00:00Z");
    private static final BigDecimal STAND_1_OKTOBER = new BigDecimal("400000");
    /** Die Lücke am 18.10.2026, 14:01–17:30 MESZ — die Werte kommen am 12.11.2026 09:02 MEZ (nach der Frist). */
    private static final Instant LUECKE_VON = Instant.parse("2026-10-18T12:01:00Z");
    private static final Instant LUECKE_BIS = Instant.parse("2026-10-18T15:30:00Z");
    private static final Instant NACHGELIEFERT = Instant.parse("2026-11-12T08:02:00Z");

    private static final Instant T_VERDICHTET = Instant.parse("2026-11-02T00:30:00Z");
    private static final Instant T_TAKT = Instant.parse("2026-11-02T01:00:00Z");
    /** Der Oktober ist ab 08.11.2026 endgültig (Ende + 7 Tage) — ein Takt am Morgen des 09.11. */
    private static final Instant T_ENDGUELTIG = Instant.parse("2026-11-09T07:00:00Z");
    private static final Instant T_NACHLIEFERUNG = Instant.parse("2026-11-12T08:05:00Z");
    private static final Instant T_VORSCHLAG = Instant.parse("2026-11-12T09:00:00Z");
    /** Die Kaskade: 12.11.2026 10:05:33 (MEZ, Referenzdatei 1.4). */
    private static final Instant T_KASKADE = Instant.parse("2026-11-12T09:05:33Z");
    /** B16: der Abruf am 02.11.2036 — die Oktober-Zeilen haben ihre 3 653 Tage hinter sich. */
    private static final String ABRUF_2036 = "2036-11-02T10:00:00+01:00";

    /** Eine Frist: die Tabelle und ihre Zeitspalte (die Dimension der Hypertable, über die die Aufbewahrung rechnet). */
    private record Frist(String tabelle, String spalte, boolean tag) {}

    /** Was am 02.11.2036 schon weg wäre: die Speicherklassen (3 653 Tage) und die Rohtabellen (90 Tage). */
    private static final List<Frist> FRISTEN = List.of(
            new Frist("messreihe_periode", "tag", true),
            new Frist("messreihe_tag", "tag", true),
            new Frist("messreihe_viertelstunde", "intervall_beginn", false),
            new Frist("device_measurement_sample", "time", false),
            new Frist("telemetry_v2", "time", false));

    /** Was keine Frist hat (Bericht-Vertrag S1/S5, AP-08 IP-17): Versionen, Berichtsstände, Quellen, Anstöße, Meldungen. */
    private static final List<String> UNBEFRISTET = List.of("messreihe_periode_version", "messreihe_viertelstunde_version",
            "bericht_stand", "bericht_quelle", "bericht_revision_anstoss", "bericht_abruf", "messreihe_ereignis");

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
        registry.add("spring.flyway.placeholders.adminDbUser", () -> ADMIN_USER);
        registry.add("spring.flyway.placeholders.adminDbPassword", () -> ADMIN_PW);
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot");
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot/protocol/openid-connect/certs");
    }

    @Autowired
    MockMvc mvc;

    @Autowired
    BerichtService berichte;

    @Autowired
    MessstelleWerteService werte;

    @Autowired
    BerichtAbzugBildung bildung;

    @MockBean
    KennzahlAufrufer aufrufer;

    private JdbcTemplate root;
    private JdbcTemplate admin;
    private JdbcTemplate app;
    private UUID kb;
    private UUID st1;
    private UUID anlage;
    private UUID box;
    private UUID entity;
    private Wer ines;
    private Wer jonas;
    private ViertelstundeVerdichter verdichter;
    private TagVerdichter tage;
    private EndgueltigkeitLaeufer laeufer;
    private KorrekturKaskade kaskade;
    private MessreiheKorrekturRepository korrekturen;

    private record Wer(String sub, String name) {}

    private record Antwort(int status, JsonNode body, String text) {}

    /** Was ein Kunde von einem Berichtsstand abholt: der Stand über die Route, der Abzug, PDF und CSV. */
    private record Abgeholt(String standText, String abzug, String pruefsumme, byte[] pdf, byte[] csv) {}

    @BeforeEach
    void rechte() {
        doAnswer(inv -> {
            ProtokollAkteur a = inv.getArgument(0);
            Benutzer b = PERSONEN.get(a.sub());
            return b != null ? b : KorrekturRechte.benutzer(a);
        }).when(aufrufer).benutzer(any());
    }

    @AfterEach
    void uhrenZurueck() {
        berichte.uhrStellen(Clock.systemUTC());
        werte.uhrStellen(Clock.systemUTC());
    }

    @Test
    void einFreigegebenerBerichtBleibtNachKorrekturUndAbgelaufenenRohdatenErklaerbar() throws Exception {
        welt();
        kette();
        JsonNode b16 = b16();

        // ---- 1. Version 1: Zählerstände → Viertelstunden, Tage, Monat; der Oktober wird endgültig --------------------
        List<Object[]> oktober = new ArrayList<>(rohwerte(OKTOBER, NOVEMBER, null));
        oktober.removeIf(r -> !((Timestamp) r[0]).toInstant().isBefore(LUECKE_VON)
                && !((Timestamp) r[0]).toInstant().isAfter(LUECKE_BIS));
        saeen(oktober);
        telemetrie();
        verdichten(T_VERDICHTET);
        tage.rueckrechnenGanz(T_TAKT, 200);
        laeufer.takt(T_TAKT);
        laeufer.takt(T_ENDGUELTIG);
        assertThat(zahl("SELECT count(*) FROM messreihe_periode WHERE tenant_id = ? AND art = 'monat' "
                + "AND tag = DATE '2026-10-01' AND zustand = 'endgueltig'", kb)).as("der Oktober ist endgültig").isEqualTo(1);

        // ---- 2. Nr. 1: Ines legt den Monatsbericht an und gibt ihn frei (10.11.2026) --------------------------------
        uhrBerichte("2026-11-10T08:55:00+01:00");
        Antwort angelegt = ok(ruf(ines, HttpMethod.POST, "/api/v1/berichte", Map.of("vorlage", "monatsbericht_standort",
                "geltung_id", st1.toString(), "zeitraum", "2026-10")), 201);
        assertThat(angelegt.body().path("kennung").asText()).isEqualTo(KENNUNG);
        uhrBerichte("2026-11-10T09:02:00+01:00");
        Antwort nr1 = ok(ruf(ines, HttpMethod.POST, PFAD + "/freigeben",
                Map.of("entwurf_datenstand", "2026-11-10T08:55:00+01:00")), 201);
        assertThat(nr1.body().path("nr").asInt()).isEqualTo(1);
        JsonNode ms12Nr1 = ms12(abzug(1));
        assertThat(ms12Nr1.path("version").asInt()).as("Nr. 1 zitiert Version 1").isEqualTo(1);

        // ---- 3. Die Korrektur: Nachlieferung → Vorschlag → Freigabe → Kaskade (12.11.2026) ---------------------------
        saeen(rohwerte(LUECKE_VON, LUECKE_BIS, NACHGELIEFERT));
        verdichten(T_NACHLIEFERUNG);
        laeufer.takt(T_VORSCHLAG);
        List<Korrektur> vorschlaege = als(() -> korrekturen.fuerReihe(kb, entity, KANAL));
        assertThat(vorschlaege).as("genau ein Vorschlag aus der Nachlieferung").hasSize(1);
        String korrektur = vorschlaege.get(0).kennung();
        als(() -> korrekturen.freigeben(kb, korrektur, null, INES));
        KorrekturKaskade.Lauf lauf = kaskade.lauf(T_KASKADE);
        assertThat(lauf.abgelehnt()).as("die Kaskade lehnt nichts ab").isEmpty();
        assertThat(lauf.anlaesse()).isEqualTo(1);
        assertThat(root.queryForList("SELECT s.nr || ' | ' || a.anlass_kennung || ' | ' || a.zustand "
                + "FROM bericht_revision_anstoss a JOIN bericht_stand s ON s.id = a.stand_id WHERE a.tenant_id = ?",
                String.class, kb)).as("Nr. 1 bekommt den Anstoß — über die Naht, nicht von Hand")
                .containsExactly("1 | " + korrektur + " | offen");
        assertThat(root.queryForObject("SELECT gebildet_von FROM bericht_entwurf WHERE tenant_id = ?", String.class, kb))
                .as("der Entwurf ist von der Kaskade neu gebildet").isEqualTo("kaskade");

        // ---- 4. Nr. 2: die Revision (16.11.2026) --------------------------------------------------------------------
        Instant datenstandNr2 = root.queryForObject("SELECT datenstand FROM bericht_entwurf WHERE tenant_id = ?",
                Timestamp.class, kb).toInstant();
        uhrBerichte("2026-11-16T14:20:00+01:00");
        Antwort nr2 = ok(ruf(ines, HttpMethod.POST, PFAD + "/freigeben",
                Map.of("entwurf_datenstand", MessstelleWerteRegeln.iso(datenstandNr2, BERLIN))), 201);
        assertThat(nr2.body().path("nr").asInt()).isEqualTo(2);
        JsonNode ms12Nr2 = ms12(abzug(2));
        assertThat(ms12Nr2.path("version").asInt()).as("Nr. 2 zitiert Version 2").isEqualTo(2);
        assertThat(ms12Nr2).as("Version 2 ist nicht Version 1").isNotEqualTo(ms12Nr1);
        JsonNode detail = ok(ruf(jonas, HttpMethod.GET, PFAD, null), 200).body();
        assertThat(detail.path("staende").get(0).path("ersetzt_durch_nr").asInt()).isEqualTo(2);

        // ---- 5. Vor den Fristen: was Jonas abholt; die Gegenprobe am 02.11.2036 ohne Löschen ---------------------------
        uhrBerichte("2026-11-20T17:45:00+01:00");
        Map<Integer, Abgeholt> vorher = new LinkedHashMap<>();
        for (int nr : List.of(1, 2)) {
            vorher.put(nr, abholen(nr));
        }
        String staende = Bestandsschutz.inhalt(root, "bericht_stand", "t.tenant_id = ?", kb);
        String quellen = Bestandsschutz.inhalt(root, "bericht_quelle", "t.tenant_id = ? AND t.stand_nr IS NOT NULL", kb);
        uhrWerte(ABRUF_2036);
        JsonNode nochDa = schritt(ok(werte(jonas, 1), 200));
        assertThat(nochDa.path("version").asInt()).isEqualTo(1);
        assertThat(nochDa.path("menge").decimalValue()).as("ohne Löschen steht die Zahl noch da — nie eine 404 der Uhr")
                .isEqualByComparingTo(ms12Nr1.path("menge").decimalValue());
        Map<Integer, String> standTexte = new LinkedHashMap<>();
        for (int nr : List.of(1, 2)) {
            standTexte.put(nr, ok(ruf(jonas, HttpMethod.GET, PFAD + "/staende/" + nr, null), 200).text());
        }
        Map<String, Long> unbefristet = zaehle(UNBEFRISTET);

        // ---- 6. Die Fristen fallen: per SQL gelöscht — und gezählt ------------------------------------------------------
        Map<String, Long> vorDemLoeschen = zaehleFristen();
        assertThat(vorDemLoeschen).as("jede Tabelle der Fristen trägt Oktober-Zeilen — sonst löschte der Test nichts")
                .allSatisfy((tabelle, n) -> assertThat(n).as(tabelle).isPositive());
        Map<String, Long> geloescht = loeschen();
        assertThat(geloescht).as("DELETE meldet genau die gezählten Zeilen").isEqualTo(vorDemLoeschen);
        Map<String, Long> nachDemLoeschen = zaehleFristen();
        assertThat(nachDemLoeschen).as("nachgezählt: die Welt unter den Berichten ist weg")
                .allSatisfy((tabelle, n) -> assertThat(n).as(tabelle).isZero());
        assertThat(zaehle(UNBEFRISTET)).as("was keine Frist hat, bleibt Zeile für Zeile").isEqualTo(unbefristet);
        System.out.println("IP-16 Nachweis · vor dem Löschen " + vorDemLoeschen + " · gelöscht " + geloescht
                + " · danach " + nachDemLoeschen + " · unbefristet " + unbefristet);

        // ---- 7. Danach: Nr. 1 und Nr. 2 erklären sich weiter — Zeichen für Zeichen, Byte für Byte ------------------------
        for (int nr : List.of(1, 2)) {
            Antwort stand = ok(ruf(jonas, HttpMethod.GET, PFAD + "/staende/" + nr, null), 200);
            assertThat(stand.text()).as("Nr. " + nr + " über die Route, wie vor dem Löschen").isEqualTo(standTexte.get(nr));
            String abzug = abzug(nr);
            assertThat(abzug).as("Nr. " + nr + " Abzug").isEqualTo(vorher.get(nr).abzug());
            assertThat(stand.body().path("pruefsumme").asText()).as("Nr. " + nr + " Prüfsumme")
                    .isEqualTo(vorher.get(nr).pruefsumme()).isEqualTo(BerichtRegeln.pruefsumme(abzug));
            assertThat(stand.text()).contains("\"abzug\":" + abzug + "}");
        }
        // Derselbe Abruf wie vorher (Jonas, 20.11.2026 17:45) — PDF und CSV sind dieselben Dateien, Byte für Byte.
        uhrBerichte("2026-11-20T17:45:00+01:00");
        for (int nr : List.of(1, 2)) {
            Abgeholt v = vorher.get(nr);
            Abgeholt n = abholen(nr);
            assertThat(n.pdf()).as("Nr. " + nr + " PDF byte-gleich").isEqualTo(v.pdf());
            assertThat(n.csv()).as("Nr. " + nr + " CSV byte-gleich").isEqualTo(v.csv());
            System.out.println("IP-16 Nachweis · Nr. " + nr + " " + v.pruefsumme() + " · PDF sha256 vorher " + sha(v.pdf())
                    + " nachher " + sha(n.pdf()) + " · CSV sha256 vorher " + sha(v.csv()) + " nachher " + sha(n.csv()));
        }
        // Ein Abruf am 02.11.2036: das PDF bleibt dieselbe Datei (es nennt keinen Abruf); das CSV nennt seinen Abruf im
        // Kopf (DA3 `erzeugt_am`) — jede andere Zeile ist dieselbe.
        uhrBerichte(ABRUF_2036);
        for (int nr : List.of(1, 2)) {
            Abgeholt v = vorher.get(nr);
            Abgeholt n = abholen(nr);
            assertThat(n.pdf()).as("Nr. " + nr + " PDF am 02.11.2036 byte-gleich").isEqualTo(v.pdf());
            List<String> alt = List.of(new String(v.csv(), StandardCharsets.UTF_8).split("\r\n", -1));
            List<String> neu = List.of(new String(n.csv(), StandardCharsets.UTF_8).split("\r\n", -1));
            assertThat(neu).hasSameSizeAs(alt);
            List<String> anders = new ArrayList<>();
            for (int i = 0; i < alt.size(); i++) {
                if (!alt.get(i).equals(neu.get(i))) {
                    anders.add(neu.get(i));
                }
            }
            assertThat(anders).as("Nr. " + nr + " CSV am 02.11.2036: nur der Abruf-Zeitpunkt").singleElement()
                    .asString().contains("erzeugt_am").contains("2036-11-02");
        }
        System.out.println("IP-16 Nachweis · MS-12 in Nr. 1 " + ms12Nr1 + " · in Nr. 2 " + ms12Nr2);
        assertThat(ms12(abzug(1))).as("Nr. 1 nennt MS-12 weiter in Version 1").isEqualTo(ms12Nr1);
        assertThat(ms12(abzug(2))).as("Nr. 2 nennt MS-12 weiter in Version 2").isEqualTo(ms12Nr2);
        assertThat(Bestandsschutz.inhalt(root, "bericht_stand", "t.tenant_id = ?", kb)).isEqualTo(staende);
        assertThat(Bestandsschutz.inhalt(root, "bericht_quelle", "t.tenant_id = ? AND t.stand_nr IS NOT NULL", kb))
                .isEqualTo(quellen);

        // ---- 8. Die Welt darunter sagt ehrlich, was fehlt -----------------------------------------------------------------
        // Innerhalb der Aufbewahrung ist eine Periode ohne Zeile „keine Werte“ — nie „nicht mehr gespeichert“.
        uhrWerte("2026-11-20T17:45:00+01:00");
        JsonNode innen = schritt(ok(werte(jonas, 1), 200));
        assertThat(innen.path("menge").isNull()).isTrue();
        assertThat(innen.path("zustand").asText()).isEqualTo(ErgebnisZustand.KEINE_WERTE);

        // Am 02.11.2036: Version 1 ist nicht mehr gespeichert — mit dem Satz aus B16, der auf Nr. 1 verweist.
        uhrWerte(ABRUF_2036);
        JsonNode satz = satzMitStand(b16);
        Antwort weg = werte(jonas, 1);
        assertThat(weg.status()).as(weg.text()).isEqualTo(satz.path("ergebnis").path("status").asInt()).isEqualTo(404);
        assertThat(weg.body().path("code").asText()).isEqualTo("wert_nicht_mehr_gespeichert");
        assertThat(weg.body().path("message").asText()).isEqualTo(satz.path("ergebnis").path("kundensatz").asText())
                .isEqualTo("Der Wert vom Oktober 2026 wird nicht mehr gespeichert (Aufbewahrung 10 Jahre). "
                        + "Der Berichtsstand Nr. 1 vom 10.11.2026 hält ihn fest.");
        assertThat(weg.body().path("zeitraum")).isEqualTo(satz.path("eingang").path("werte").path("zeitraum"));
        assertThat(weg.body().path("stand")).isEqualTo(satz.path("eingang").path("werte").path("stand"));
        System.out.println("IP-16 Nachweis · werte?version=1 am 02.11.2036 → " + weg.status() + " " + weg.text());

        // Version 2 hat keine Frist (B16: „Version 2 lebt“): ohne Angabe und mit version=2 steht sie da.
        JsonNode neueste = schritt(ok(werte(jonas, null), 200));
        assertThat(neueste.path("version").asInt()).isEqualTo(2);
        assertThat(neueste.path("menge").decimalValue()).isEqualByComparingTo(ms12Nr2.path("menge").decimalValue());
        assertThat(schritt(ok(werte(jonas, 2), 200)).path("version").asInt()).isEqualTo(2);
        JsonNode historie = ok(ruf(jonas, HttpMethod.GET, WERTE + "/versionen?raster=monat&von=2026-10-01&bis=2026-10-31",
                null), 200).body().path("versionen");
        assertThat(historie).hasSize(2);
        assertThat(historie.get(0).path("wert_neu").path("menge").isNull()).as("Version 1 ist nicht mehr lesbar").isTrue();
        assertThat(historie.get(1).path("wert_neu").path("menge").decimalValue()).as("Version 2 ist lesbar")
                .isEqualByComparingTo(ms12Nr2.path("menge").decimalValue());

        // Die Erzählung (wer, wann, warum) bleibt auch ohne Zahlenzeilen: die Meldungen sind unbefristet.
        assertThat(root.queryForList("SELECT art FROM messreihe_ereignis WHERE tenant_id = ? AND art LIKE 'bericht_%' "
                + "AND art <> 'bericht_abgerufen' ORDER BY zeit, art", String.class, kb))
                .containsExactly("bericht_freigegeben", "bericht_entwurf_neu_gebildet", "bericht_revision_angestossen",
                        "bericht_freigegeben");
    }

    // =========================================================================== Die Welt und die Kette

    /** Kunststoffwerk Ahrenberg: Werk Ahrenberg mit einer Anlage, einer Box und MS-12 „Montage Linie M1“ am Zählerkanal. */
    private void welt() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        kb = uuid("INSERT INTO tenant (name) VALUES ('Kunststoffwerk Ahrenberg GmbH') RETURNING id");
        UUID u = uuid("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH', "
                + "'Europe/Berlin') RETURNING id", kb);
        st1 = uuid("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", kb, u);
        anlage = uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-1') RETURNING id", kb);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, DATE '2024-03-12')", kb, anlage, st1);
        box = uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, 'VP-BOX-IP16-MS12', "
                + "'claimed') RETURNING id", kb, anlage);
        entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, "
                + "communication, connection_json, created_at) VALUES (?, ?, 'grid-meter', 'Zähler Montage', 'grid-meter', ?, "
                + "'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, '2024-03-12T00:00:00Z') RETURNING id",
                kb, anlage, box);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, '2024-03-12T00:00:00Z', "
                + "'2026.09.11.1', 'test', 'pending_edge', 'live_power', 'fifteen_minute')", kb, anlage, box, entity, KANAL);
        UUID ms12 = uuid("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, einheit, "
                + "wertart) VALUES (?, 'MS-12', 'Montage Linie M1', 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                + "'Zählerstand') RETURNING id", kb);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, DATE '2024-03-12')", kb, ms12, st1);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, entity);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_sub, actor_name, "
                + "actor_art) VALUES (?, ?, 'Wirkenergie', 'Bezug', ?, ?, ?, 'counter', 'zaehlerstand', 'fuehrend', "
                + "'2024-03-12T00:00:00Z', true, now(), 'sub', 'Probe', 'kunde')", kb, ms12, entity, geraet, KANAL);
        ines = person("kc-ines-" + kb, "Ines Kaltenbach", "energiemanager");
        jonas = person("kc-jonas-" + kb, "Jonas Wendlinger", "kundenadministrator");
    }

    /** Die Läufe, wie der Betrieb sie fährt — die Berichts-Naht ist die echte {@link BerichtKaskade} (Pfad 1). */
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
        kaskade = new KorrekturKaskade(admin, katalog, verdichter, new ErsatzwertLauf(admin, katalog, verdichter, 200),
                berechnete, new KennzahlenNaht.Keine(), new BerichtKaskade(bildung), 50);
        korrekturen = new MessreiheKorrekturRepository(app);
    }

    /** Eine Person des Kundenbereichs mit ihrer Rolle für das ganze Unternehmen (B13). */
    private static Wer person(String sub, String name, String rolle) {
        PERSONEN.put(sub, new Benutzer(sub, name, Konto.vonCode("benutzer"), KontoZustand.AKTIV,
                List.of(new Zuweisung(Rolle.vonCode(rolle), null, null, null, Instant.EPOCH, null, null))));
        return new Wer(sub, name);
    }

    /** Tagesmengen der Referenzdatei für MS-12 im Oktober 2026: 196 kWh, am 31.10. 220 kWh. */
    private static BigDecimal tagesmenge(LocalDate tag) {
        return new BigDecimal(tag.getDayOfMonth() == 31 ? "220" : "196");
    }

    /**
     * Die Zählerstände von MS-12 im Minutentakt von {@code von} bis {@code bis} einschließlich: an jeder Tagesgrenze genau
     * die Summe der Tagesmengen davor, dazwischen linear (25.10.: 25 Stunden). {@code eingang} {@code null} = direkt
     * zugestellt, sonst nachgeliefert zu diesem Zeitpunkt.
     */
    private static List<Object[]> rohwerte(Instant von, Instant bis, Instant eingang) {
        Map<LocalDate, BigDecimal> tagesbeginn = new HashMap<>();
        BigDecimal summe = STAND_1_OKTOBER;
        for (LocalDate d = LocalDate.of(2026, 10, 1); !d.isAfter(LocalDate.of(2026, 11, 1)); d = d.plusDays(1)) {
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
            zeilen.add(new Object[] {Timestamp.from(t), Timestamp.from(eingang == null ? t.plusSeconds(2) : eingang),
                    stand.doubleValue(), t.getEpochSecond(), eingang == null ? "direkt" : "nachgeliefert"});
        }
        return zeilen;
    }

    private void saeen(List<Object[]> zeilen) {
        List<Object[]> stapel = new ArrayList<>();
        for (Object[] z : zeilen) {
            stapel.add(new Object[] {z[0], z[1], kb, anlage, box, KANAL, z[2], z[3], entity, z[4]});
        }
        for (int i = 0; i < stapel.size(); i += 5000) {
            root.batchUpdate("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, "
                    + "point_key, raw_numeric, quality, catalog_version, edge_sequence, aggregation_kind, entity_id, "
                    + "applied_revision, value_kind, role, delivery, delay_s) VALUES (?, ?, ?, ?, ?, ?, ?, 'good', "
                    + "'2026.09.11.1', ?, 'counter', ?, 3, 'counter', 'fuehrend', ?, 2) ON CONFLICT DO NOTHING",
                    stapel.subList(i, Math.min(i + 5000, stapel.size())));
        }
    }

    /** Der zweite Rohweg (AP-07: zwei Pfade): dieselben Zählerstände als Telemetrie der Box, je Viertelstunde. */
    private void telemetrie() {
        List<Object[]> stapel = new ArrayList<>();
        for (Object[] z : rohwerte(OKTOBER, NOVEMBER.minusSeconds(60), null)) {
            if (((Timestamp) z[0]).toInstant().getEpochSecond() % 900 == 0) {
                stapel.add(new Object[] {z[0], z[1], kb, anlage, box, entity.toString(), KANAL, z[2]});
            }
        }
        root.batchUpdate("INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, entity_id, channel, "
                + "value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", stapel);
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

    // =========================================================================== Die Fristen

    /** Zeilen des Kundenbereichs vor dem 01.11.2026 (MEZ) — je Tabelle über ihre Zeitspalte. */
    private Map<String, Long> zaehleFristen() {
        Map<String, Long> n = new LinkedHashMap<>();
        for (Frist f : FRISTEN) {
            n.put(f.tabelle(), root.queryForObject("SELECT count(*) FROM " + f.tabelle() + " WHERE tenant_id = ? AND "
                    + f.spalte() + " < ?", Long.class, kb, grenze(f)));
        }
        return n;
    }

    /** Die Simulation der Fristen: {@code DELETE} je Tabelle, die gemeldete Zahl der Zeilen je Tabelle. */
    private Map<String, Long> loeschen() {
        Map<String, Long> n = new LinkedHashMap<>();
        for (Frist f : FRISTEN) {
            n.put(f.tabelle(), (long) root.update("DELETE FROM " + f.tabelle() + " WHERE tenant_id = ? AND " + f.spalte()
                    + " < ?", kb, grenze(f)));
        }
        return n;
    }

    private static Object grenze(Frist f) {
        return f.tag() ? Date.valueOf(LocalDate.of(2026, 11, 1)) : Timestamp.from(NOVEMBER);
    }

    private Map<String, Long> zaehle(List<String> tabellen) {
        Map<String, Long> n = new LinkedHashMap<>();
        for (String t : tabellen) {
            n.put(t, root.queryForObject("SELECT count(*) FROM " + t + " WHERE tenant_id = ?", Long.class, kb));
        }
        return n;
    }

    // =========================================================================== Abholen und Lesen

    private Abgeholt abholen(int nr) throws Exception {
        Antwort stand = ok(ruf(jonas, HttpMethod.GET, PFAD + "/staende/" + nr, null), 200);
        return new Abgeholt(stand.text(), abzug(nr), stand.body().path("pruefsumme").asText(),
                datei(jonas, PFAD + "/staende/" + nr + "/pdf"), datei(jonas, PFAD + "/staende/" + nr + "/csv"));
    }

    private String abzug(int nr) {
        return root.queryForObject("SELECT s.abzug FROM bericht_stand s JOIN bericht b ON b.id = s.bericht_id "
                + "WHERE b.tenant_id = ? AND b.kennung = ? AND s.nr = ?", String.class, kb, KENNUNG, nr);
    }

    /** Der Monatswert von MS-12 im Abzug — die Zahl mit ihrem Nachweis. */
    private static JsonNode ms12(String abzug) throws Exception {
        for (JsonNode w : EXAKT.readTree(abzug).path("werte")) {
            if ("MS-12".equals(w.path("quelle").asText()) && !w.has("menge_art")) {
                return w;
            }
        }
        throw new AssertionError("MS-12 fehlt im Abzug " + abzug);
    }

    private Antwort werte(Wer wer, Integer version) throws Exception {
        return ruf(wer, HttpMethod.GET, WERTE + "?raster=monat&von=2026-10-01&bis=2026-10-31"
                + (version == null ? "" : "&version=" + version), null);
    }

    /** Der eine Schritt einer Monatsanfrage. */
    private static JsonNode schritt(Antwort a) {
        assertThat(a.body().path("werte")).as(a.text()).hasSize(1);
        return a.body().path("werte").get(0);
    }

    /** B16 aus der Vektor-Datei — der Fall der Familie {@code ablauf}. */
    private static JsonNode b16() throws Exception {
        for (JsonNode fall : EXAKT.readTree(Files.readString(V2.resolve("bericht-vectors.json"))).path("cases")) {
            if ("B16".equals(fall.path("id").asText())) {
                assertThat(fall.path("familie").asText()).isEqualTo("ablauf");
                return fall;
            }
        }
        throw new AssertionError("B16 fehlt in bericht-vectors.json");
    }

    /** Die Prüfung {@code satz} von B16 mit Berichtsstand: {@code werte?version=1} nach den Fristen. */
    private static JsonNode satzMitStand(JsonNode b16) {
        for (JsonNode p : b16.path("pruefungen")) {
            JsonNode e = p.path("eingang");
            if ("satz".equals(p.path("regel").asText()) && "wert_nicht_mehr_gespeichert".equals(e.path("code").asText())
                    && !e.path("werte").path("stand").isNull()) {
                return p;
            }
        }
        throw new AssertionError("B16 hat keine Prüfung wert_nicht_mehr_gespeichert mit Berichtsstand");
    }

    // =========================================================================== Hilfen

    private void uhrBerichte(String zeit) {
        berichte.uhrStellen(Clock.fixed(OffsetDateTime.parse(zeit).toInstant(), ZoneOffset.UTC));
    }

    private void uhrWerte(String zeit) {
        werte.uhrStellen(Clock.fixed(OffsetDateTime.parse(zeit).toInstant(), ZoneOffset.UTC));
    }

    private long zahl(String sql, Object... args) {
        return root.queryForObject(sql, Long.class, args);
    }

    private UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
    }

    private <T> T als(Supplier<T> arbeit) {
        TenantContext.set(kb);
        try {
            return arbeit.get();
        } finally {
            TenantContext.clear();
        }
    }

    private static String sha(byte[] bytes) throws Exception {
        return "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
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
     * Ohne Docker ist die Abnahme NICHT gelaufen: der Test wird mit einem Satz übersprungen, der das sagt — auf der Konsole
     * und im Bericht der Testläufe. {@code @Testcontainers(disabledWithoutDocker = true)} übersprünge still.
     */
    static final class DockerPflicht implements ExecutionCondition {
        @Override
        public ConditionEvaluationResult evaluateExecutionCondition(ExtensionContext context) {
            if (DockerClientFactory.instance().isDockerAvailable()) {
                return ConditionEvaluationResult.enabled("Docker ist da — die Abnahme läuft");
            }
            String satz = "ÜBERSPRUNGEN: " + context.getDisplayName() + " — die Abnahme des Captains (UEMS AP-12 IP-16) "
                    + "ist NICHT gelaufen, weil Docker fehlt. Ein grüner Lauf ohne diesen Test beweist nichts.";
            System.err.println(satz);
            return ConditionEvaluationResult.disabled(satz);
        }
    }
}
