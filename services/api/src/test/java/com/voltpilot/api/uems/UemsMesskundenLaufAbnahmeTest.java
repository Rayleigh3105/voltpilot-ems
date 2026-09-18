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
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.metrics.UemsMetricsCollector;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.uems.RechteAbleitung.KontoZustand;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Zuweisung;
import io.micrometer.core.instrument.MeterRegistry;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ConditionEvaluationResult;
import org.junit.jupiter.api.extension.ExecutionCondition;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.junit.jupiter.api.extension.ExtendWith;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
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
 * AP-14 IP-7 — <b>Nachweis NW-4: der durchgehende Messkunden-Lauf</b> (Referenzfall U5, Werk Lindach).
 *
 * <p>Die zweite Hälfte der Abnahme des Programms: ein NEUER reiner Messkunde geht in EINEM Lauf von der
 * Datenquelle bis zum freigegebenen Bericht. AP-07 IP-21 hat den Bogen in zwei Hälften belegt und den Rest
 * ausdrücklich offen gelassen — {@code docs/agents/root/uems-abnahme-messdatenstrecke.md}, Abschnitt „Was die
 * Abnahme NICHT beweist": <i>„kein einziger Lauf trägt heute von der Box bis in den freigegebenen Bericht
 * durch"</i>. Dieser Lauf schließt genau diese Klammer.
 *
 * <p><b>Was hier ECHT läuft.</b> Eine echte TimescaleDB im Container, das ganze Flyway-Schema, die ganze api
 * als Spring-Anwendung, und der Weg des Kunden über die ECHTEN Routen mit den Rechten des Kunden — kein
 * {@code INSERT} legt einen Standort, eine Anlage, eine Box, eine Datenquelle oder eine Messstelle an. Das ist
 * der Unterschied zu NW-2: hier IST der Weg des Kunden Teil des Nachweises. Verdichtung, Endgültigkeit,
 * Kennzahl und Bericht laufen über dieselben Läufer und Dienste wie im Betrieb.
 *
 * <p><b>Was hier NICHT als Prozess läuft — und warum.</b> Die Glieder Broker → ingest → Writer stehen in
 * {@code services/ingest} und {@code services/timescale-writer}; sie sind aus dem api-Modul nicht startbar
 * (getrennte Maven-Module, api hat weder Kafka-Client noch die Writer-Beans auf dem Pfad). Die Strecke
 * MQTT/Redpanda → Writer → {@code device_measurement_sample} ist mit echtem Redpanda und echtem Writer in
 * {@link com.voltpilot.writer.UemsStreckeAbnahmeTest} (AP-07 IP-21) belegt. Dieser Lauf setzt genau an deren
 * Ausgang an: er schreibt die Rohzeilen in der Form, die der Writer schreibt, und fährt ab dort alles echt.
 * Die Naht ist damit EINE benannte Stelle, nicht eine stille Annahme.
 *
 * <p><b>Die Zahl im Bericht ist nachgerechnet.</b> Der Lauf rechnet die erwartete Monatsmenge unabhängig aus
 * den gesendeten Zählerständen (letzter Stand minus erster Stand je Tag, aufsummiert) — nicht mit der Formel
 * des Produkts. Eine bewusste Lücke im Drehbuch der Box bleibt auf dem ganzen Weg sichtbar.
 */
@ExtendWith(UemsMesskundenLaufAbnahmeTest.DockerPflicht.class)
@Testcontainers
@SpringBootTest
@AutoConfigureMockMvc
class UemsMesskundenLaufAbnahmeTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final Map<String, Benutzer> PERSONEN = new ConcurrentHashMap<>();

    /**
     * U5: ein SunSpec-Zähler aus dem AUSGELIEFERTEN Katalog — Modell 203, der Zählerstand „Wirkenergie
     * Bezug" in <b>Wh</b>. Kein WAGO (Edge-Release B), kein generischer Modbus.
     */
    private static final String KANAL = "sunspec.model_203.totwhimp";
    private static final String MS = "MS-16";

    /**
     * U5 verschoben auf den Monatsersten (Schritt 10 des Referenzfalls: „ein Start am 01.10. hätte den Monat
     * voll gemessen"): November 2026 ist der erste volle Monat, endgültig ab 08.12.2026.
     */
    private static final Instant NOVEMBER = Instant.parse("2026-10-31T23:00:00Z");
    private static final Instant DEZEMBER = Instant.parse("2026-11-30T23:00:00Z");
    private static final BigDecimal STAND_1_NOVEMBER = new BigDecimal("120000");

    /** Die bewusste Lücke des Drehbuchs: 12.11.2026 08:00–11:00 MEZ liefert die Box nichts. */
    private static final Instant LUECKE_VON = Instant.parse("2026-11-12T07:00:00Z");
    private static final Instant LUECKE_BIS = Instant.parse("2026-11-12T10:00:00Z");

    /** Der Zeitraffer: Verdichtung am 01.12., Takt am 02.12., „Intervallende + 7 Tage" am 08.12.2026. */
    private static final Instant T_VERDICHTET = Instant.parse("2026-12-01T00:30:00Z");
    private static final Instant T_TAKT = Instant.parse("2026-12-01T01:00:00Z");
    private static final Instant T_ENDGUELTIG = Instant.parse("2026-12-08T07:00:00Z");

    /**
     * Wörter, die auf dem ganzen Weg des reinen Messkunden in keiner API-Antwort stehen dürfen (U5, S2).
     * {@code eur}/{@code euro} taugen nicht als Probe — sie stecken in „Europe/Berlin"; Geld wird darum am
     * Zeichen und an {@code ct/kwh} geprüft. Das blosse {@code steuer} taugt auch nicht: das Feld
     * {@code steuerquelle} einer Datenquelle sagt gerade, dass sie NICHT steuert.
     */
    private static final List<String> VERBOTEN = List.of("fahrplan", "erlös", "erloes", "vergütung", "verguetung",
            "marktprämie", "marktpraemie", "direktvermarktung", "ct/kwh", "€", "steuerung", "betriebsmodell",
            "veräußerungsform", "veraeusserungsform");

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
        registry.add("voltpilot.admin-datasource.url", POSTGRES::getJdbcUrl);
        registry.add("voltpilot.admin-datasource.username", () -> ADMIN_USER);
        registry.add("voltpilot.admin-datasource.password", () -> ADMIN_PW);
        registry.add("voltpilot.metrics.uems.enabled", () -> "true");
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
    UemsMetricsCollector metriken;

    @Autowired
    MeterRegistry register;

    @MockBean
    KennzahlAufrufer aufrufer;

    private JdbcTemplate root;
    private JdbcTemplate admin;
    private UUID kb;
    private UUID standort;
    private UUID anlage;
    private UUID box;
    private UUID entity;
    private UUID messstelle;
    /** Anna Lindach legt den Kundenbereich an — sie ist Kundenadministratorin (U5 Schritt 1). */
    private Wer anna;
    /** Peter Hollerbach ist Bearbeiter (U5 „Gegeben") — er baut den Entwurf, er gibt NICHT frei. */
    private Wer peter;
    private ViertelstundeVerdichter verdichter;
    private TagVerdichter tage;
    private EndgueltigkeitLaeufer laeufer;

    private record Wer(String sub, String name) {}

    private record Antwort(int status, JsonNode body, String text) {}

    /** Jede Antwort, die der Messkunde auf seinem Weg gesehen hat — für die Wortprobe am Ende. */
    private final List<String> gesehen = new ArrayList<>();

    /** Die Antwort von {@code POST /api/v1/sites} — sie wird getrennt geprüft, siehe BEFUND B1. */
    private String anlageAntwort;

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
    void derNeueMesskundeGehtVonDerDatenquelleBisZumFreigegebenenBericht() throws Exception {
        registrierung();
        kette();

        // ---- Schritte 2–7: der Weg des Kunden über die ECHTEN Routen ------------------------------------------
        standort = standortAnlegen();
        anlage = anlageNurMessen();
        box = boxAnmelden();
        messenEinrichten();
        UUID quelle = datenquelleAusKatalogvorlage();
        messstelle = messstelleAnlegen();
        quelleBinden(quelle);

        // ---- Schritt 8: die simulierte Box liefert — Rohwerte, Viertelstunde, Tag, Periode ---------------------
        List<Object[]> drehbuch = drehbuch();
        saeen(drehbuch);
        assertThat(zahl("SELECT count(*) FROM device_measurement_sample WHERE tenant_id = ?", kb))
                .as("die Rohzeilen der Box liegen in der Datenbank").isEqualTo(drehbuch.size());

        verdichten(T_VERDICHTET);
        tage.rueckrechnenGanz(T_TAKT, 200);
        laeufer.takt(T_TAKT);
        assertThat(zustandDesNovembers()).as("vor Intervallende + 7 Tage ist der November NICHT endgültig")
                .isNotEqualTo("endgueltig");

        // Der Zeitraffer läuft über die UHR DER LÄUFER, nicht über umgeschriebene Zeitstempel in der Datenbank.
        laeufer.takt(T_ENDGUELTIG);
        assertThat(zustandDesNovembers()).as("am 08.12.2026 ist der November endgültig — Intervallende + 7 Tage")
                .isEqualTo("endgueltig");

        // ---- Schritt 9: Kennzahl aus Vorlage, Bezugsgröße von Hand --------------------------------------------
        flaecheVonHand();
        UUID kennzahl = kennzahlAusVorlage();

        // ---- Schritt 10: Bericht — Entwurf (Peter) → Freigabe (Anna) → PDF und CSV -----------------------------
        uhrBerichte("2026-12-09T09:00:00+01:00");
        Antwort angelegt = ok(ruf(peter, HttpMethod.POST, "/api/v1/berichte", Map.of("vorlage", "monatsbericht_standort",
                "geltung_id", standort.toString(), "zeitraum", "2026-11")), 201);
        String kennung = angelegt.body().path("kennung").asText();
        assertThat(kennung).as("der Bericht hat eine Kennung").isNotBlank();
        String pfad = "/api/v1/berichte/" + kennung;

        // Vier Augen: Peter hat den Entwurf gebaut, Anna gibt frei — zwei Personen, die Rechte aus der Matrix.
        uhrBerichte("2026-12-09T09:12:00+01:00");
        Antwort stand = ok(ruf(anna, HttpMethod.POST, pfad + "/freigeben",
                Map.of("entwurf_datenstand", "2026-12-09T09:00:00+01:00")), 201);
        assertThat(stand.body().path("nr").asInt()).isEqualTo(1);
        assertThat(root.queryForObject("SELECT freigeber_name FROM bericht_stand s JOIN bericht b "
                + "ON b.id = s.bericht_id WHERE b.tenant_id = ? AND s.nr = 1", String.class, kb))
                .as("freigegeben hat Anna, nicht der Ersteller des Entwurfs").isEqualTo(anna.name());

        byte[] pdf = datei(anna, pfad + "/staende/1/pdf");
        byte[] csv = datei(anna, pfad + "/staende/1/csv");
        assertThat(new String(pdf, 0, 5, StandardCharsets.ISO_8859_1)).as("es ist ein PDF").isEqualTo("%PDF-");
        assertThat(csv.length).as("die CSV ist nicht leer").isPositive();
        String csvText = new String(csv, StandardCharsets.UTF_8);

        // ---- Zusicherung 1: der Bericht nennt ENDGÜLTIGE Zahlen, kein „vorläufig" ------------------------------
        String abzug = root.queryForObject("SELECT s.abzug FROM bericht_stand s JOIN bericht b ON b.id = s.bericht_id "
                + "WHERE b.tenant_id = ? AND s.nr = 1", String.class, kb);
        JsonNode abzugJson = MAPPER.readTree(abzug);
        JsonNode qualitaet = abzugJson.path("qualitaet");
        JsonNode wert = abzugJson.path("werte").get(0);
        assertThat(wert).as("der Abzug nennt den Wert der Messstelle").isNotNull();
        assertThat(wert.path("quelle").asText()).isEqualTo(MS);
        assertThat(wert.path("fassung").asText()).as("die Fassung im Bericht ist endgültig, nicht vorläufig")
                .isEqualTo("endgültig");
        assertThat(qualitaet.path("vorlaeufig").asInt()).as("kein einziger vorläufiger Wert im Bericht").isZero();
        assertThat(abzugJson.path("zusammenfassung").path("davon_endgueltig").asInt())
                .as("die Zusammenfassung zählt den Wert als endgültig").isEqualTo(1);

        // ---- Zusicherung 2: die Zahl im Bericht ist aus den gesendeten Samples NACHGERECHNET -------------------
        BigDecimal erwartet = nachgerechnet(drehbuch);
        BigDecimal imBericht = wert.path("menge").decimalValue();
        assertThat(imBericht).as("die Monatsmenge des Berichts, unabhängig aus den Samples nachgerechnet "
                + "(erwartet " + erwartet.toPlainString() + ", der Bericht sagt " + imBericht.toPlainString() + ")")
                .isEqualByComparingTo(erwartet);
        assertThat(csvText).as("dieselbe Zahl steht in der CSV")
                .contains(erwartet.stripTrailingZeros().toPlainString().replace('.', ','));

        // ---- Zusicherung 3: die Lücke bleibt sichtbar — der Bericht verschweigt sie nicht ----------------------
        long inDerLuecke = zahl("SELECT count(*) FROM messreihe_viertelstunde WHERE tenant_id = ? "
                + "AND intervall_beginn >= ? AND intervall_beginn < ?", kb, Timestamp.from(LUECKE_VON),
                Timestamp.from(LUECKE_BIS));
        assertThat(inDerLuecke).as("die Viertelstunden der Lücke sind NICHT erfunden worden").isZero();
        assertThat(wert.path("abdeckung_prozent").asInt()).as("die Abdeckung steht im Bericht und ist nicht 100")
                .isLessThan(100);
        assertThat(wert.path("kennzeichen").toString().toLowerCase(Locale.ROOT))
                .as("der Bericht verschweigt die Lücke nicht — sie steht bei den Kennzeichen des Werts")
                .contains("lücke");

        // ---- Zusicherung 4: der reine Messkunde hört auf seinem ganzen Weg kein Wort von Geld ------------------
        gesehen.add(ok(ruf(anna, HttpMethod.GET, pfad, null), 200).text());
        werte.uhrStellen(Clock.fixed(OffsetDateTime.parse("2026-12-09T09:20:00+01:00").toInstant(), ZoneOffset.UTC));
        gesehen.add(ok(ruf(anna, HttpMethod.GET,
                "/api/v1/messstellen/" + MS + "/werte?raster=monat&von=2026-11-01&bis=2026-11-30", null), 200).text());
        gesehen.add(ok(ruf(anna, HttpMethod.GET, "/api/v1/kennzahlen/" + kennzahl, null), 200).text());
        gesehen.add(csvText);
        assertThat(worteIn(gesehen)).as("kein Wort von Steuern, Geld oder Fahrplan auf dem Weg des reinen "
                + "Messkunden — Standort, Box, Funktion, Datenquelle, Messstelle, Kennzahl, Bericht, Werte, CSV")
                .isEmpty();

        // BEFUND B1, als Tatsache festgehalten statt stillschweigend übergangen: die Antwort von
        // POST /api/v1/sites trägt auch für eine Anlage „nur messen" die Wörter der steuernden Welt. Sie ist
        // die EINZIGE Antwort des Kundenwegs, die das tut. Ändert sich das, wird diese Zusicherung rot und
        // jemand muss die Zeile bewusst streichen — nicht aus Versehen.
        assertThat(worteIn(List.of(anlageAntwort)))
                .as("BEFUND B1: die Anlage-Antwort spricht zum reinen Messkunden von Geld und Steuern — "
                        + "der Weg des Kunden führt daran vorbei, die Antwort selbst nicht: " + anlageAntwort)
                .isNotEmpty();

        // ---- Zusicherung 5: die UEMS-Metriken zeigen nach dem Lauf, was sie sollen (AP-14 IP-9) ---------------
        metriken.tick();
        assertThat(laeuferZustaende()).as("die UEMS-Metriken (AP-14 IP-9) sind gelaufen — ihr erster echter "
                + "Gebrauch: je Läufer eine Zustandszeile").isPositive();
        assertThat(arbeitslistenOffen()).as("nach dem Lauf ist keine Arbeitsliste mehr offen").isZero();

        // B2 aus PR 973 ist behoben (AP-14 IP-7b): der Betreiber SIEHT diesen Messkunden. Die Abfrage
        // MESSKUNDEN verlangte {@code funktion.zustand = 'aktiv'} — einen Zustand, den für „messen“ kein
        // Weg des Produkts je schreibt (es gibt kein Starten, die Zeile bleibt auf 'entwurf', und 'aktiv'
        // leitet erst das Lesen ab). Jetzt zählt, was einen Messkunden wirklich ausmacht: die Funktionszeile
        // besteht und ihr Standort auch.
        assertThat(root.queryForObject("SELECT zustand FROM funktion WHERE tenant_id = ? AND funktion = 'messen'",
                String.class, kb))
                .as("der Kundenweg hinterlässt 'entwurf' — das ist der Normalfall, nicht ein halber Zustand")
                .isEqualTo("entwurf");
        assertThat(messwertZustandDesKunden())
                .as("der neue Messkunde steht in der Betreiber-Metrik — vorher fehlte er dort ganz, und "
                        + "stockt bei ihm etwas, soll es der Betreiber vor dem Kunden wissen")
                .isNotNull();
    }

    // =========================================================================== Schritt 1: Registrierung

    /**
     * Was die Registrierung hinterlässt (U5 Schritt 1): Kundenbereich, Unternehmen, der Anleger als
     * Kundenadministrator. Niemand gibt frei — mit E1 = B hat der neue Kundenbereich vom ersten Tag an alles.
     */
    private void registrierung() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        kb = uuid("INSERT INTO tenant (name) VALUES ('Werk Lindach GmbH') RETURNING id");
        root.update("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, 'Werk Lindach GmbH', "
                + "'Europe/Berlin')", kb);
        anna = person("kc-anna-" + kb, "Anna Lindach", "kundenadministrator");
        peter = person("kc-peter-" + kb, "Peter Hollerbach", "energiemanager");
    }

    /** Die Läufe, wie der Betrieb sie fährt. */
    private void kette() {
        MeasurementCatalog katalog = new MeasurementCatalog(MAPPER);
        SpaetankunftMelder melder = new SpaetankunftMelder();
        verdichter = new ViertelstundeVerdichter(admin, katalog, melder, 500, 40, 200_000);
        tage = new TagVerdichter(admin, katalog, 200, 40, 20_000, 200_000);
        BerechnetePeriodenLauf berechnete = mock(BerechnetePeriodenLauf.class);
        when(berechnete.zoneDesKundenbereichs(any())).thenReturn(BERLIN);
        laeufer = new EndgueltigkeitLaeufer(new EndgueltigkeitLauf(admin, 2000, 200), tage,
                new PeriodeVerdichter(admin, katalog, 50, 40, 2000), berechnete,
                new KorrekturVorschlagLauf(admin, verdichter, melder, 200));
    }

    // =========================================================================== Schritte 2–7: die echten Routen

    /** Schritt 2 — „Zuerst den Standort": der Kunde legt Werk Lindach an. */
    private UUID standortAnlegen() throws Exception {
        Map<String, Object> adresse = new LinkedHashMap<>();
        adresse.put("strasse", "Lindacher Weg 12");
        adresse.put("plz", null);
        adresse.put("ort", "Lindach");
        adresse.put("land", "DE");
        Antwort a = ok(ruf(anna, HttpMethod.POST, "/api/v1/standorte", Map.of("name", "Werk Lindach",
                "zeitzone", "Europe/Berlin", "adresse", adresse)), 201);
        gesehen.add(a.text());
        return UUID.fromString(a.body().path("id").asText());
    }

    /** Schritt 3 — Anlage „nur messen": kein Betriebsmodell, keine Veräußerungsform, kein Geld. */
    private UUID anlageNurMessen() throws Exception {
        Antwort a = ok(ruf(anna, HttpMethod.POST, "/api/v1/sites", Map.of("name", "Werk Lindach",
                "standortId", standort.toString())), 201);
        anlageAntwort = a.text();
        return UUID.fromString(a.body().path("id").asText());
    }

    /**
     * Schritt 4 — Box anmelden über die Sticker-Referenz. Die EINE Hand des Betreibers (U5): die Box ist
     * vorab angelegt und auf dem ausgelieferten Stand. Das Vorablegen ist eine Plattform-Admin-Tat, kein
     * Kundenweg — darum die Zeile direkt; das Anmelden selbst geht über die echte Kundenroute.
     */
    private UUID boxAnmelden() throws Exception {
        root.update("INSERT INTO provisioned_device (external_ref, kind, note) VALUES (?, 'edge', "
                + "'ausgelieferter Stand edge-2026.09.4')", "VP-LINDACH-NW4");
        Antwort a = ok(ruf(anna, HttpMethod.POST, "/api/v1/devices/claim", Map.of("siteId", anlage.toString(),
                "externalRef", "VP-LINDACH-NW4")), 201);
        gesehen.add(a.text());
        return UUID.fromString(a.body().path("id").asText());
    }

    /** Schritt 5 — „Messen &amp; Auswerten" einrichten. */
    private void messenEinrichten() throws Exception {
        Antwort a = ruf(anna, HttpMethod.PUT, "/api/v1/standorte/" + standort + "/funktionen/messen",
                Map.of("aktion", "einrichten"));
        assertThat(a.status()).as(a.text()).isIn(200, 201);
        gesehen.add(a.text());
    }

    /**
     * Schritt 6 — Datenquelle aus einer Katalogvorlage, die das AUSGELIEFERTE Box-Image kann: ein
     * SunSpec-Zähler über Modbus-TCP. Kein WAGO (Edge-Release B), kein generischer Modbus.
     */
    private UUID datenquelleAusKatalogvorlage() throws Exception {
        Antwort a = ok(ruf(anna, HttpMethod.POST, "/api/v1/sites/" + anlage + "/data-sources",
                Map.of("name", "Netzzähler NA-3", "protokoll", "modbus_tcp", "adresse", "10.0.0.9:502",
                        "geraete_ids", List.of(1), "kadenz_s", 10, "device_id", box.toString())), 201);
        gesehen.add(a.text());
        return UUID.fromString(a.body().path("id").asText());
    }

    /** Schritt 7a — Messstelle MS-16 Netzbezug Lindach anlegen. */
    private UUID messstelleAnlegen() throws Exception {
        Map<String, Object> hauptgroesse = new LinkedHashMap<>();
        hauptgroesse.put("groesse", "Wirkenergie");
        hauptgroesse.put("richtung", "Bezug");
        hauptgroesse.put("einheit", "kWh");
        hauptgroesse.put("wertart", "Zählerstand");
        Antwort a = ok(ruf(anna, HttpMethod.POST, "/api/v1/messstellen", Map.of("kennzeichen", MS,
                "name", "Netzbezug Lindach", "art", "gemessen", "medium", "Strom",
                "hauptgroesse", hauptgroesse)), 201);
        gesehen.add(a.text());
        UUID id = UUID.fromString(a.body().path("id").asText());
        ok(ruf(anna, HttpMethod.PUT, "/api/v1/messstellen/" + id + "/ort",
                Map.of("kennzeichen", "ST-1", "gueltig_ab", "2026-11-01")), 200);
        return id;
    }

    /** Schritt 7b — die Quelle binden: die Komponente der Box, ihr Kanal, führend ab 01.11.2026. */
    private void quelleBinden(UUID quelle) throws Exception {
        entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, "
                + "communication, connection_json, created_at) VALUES (?, ?, 'grid-meter', 'Netzzähler NA-3', "
                + "'grid-meter', ?, 'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, "
                + "'2026-10-25T00:00:00Z') RETURNING id", kb, anlage, box);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 10, 1, '2026-11-01T00:00:00Z', "
                + "'2026.09.17.1', 'test', 'pending_edge', 'energy_counter', 'fifteen_minute')",
                kb, anlage, box, entity, KANAL);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("komponente", entity.toString());
        body.put("kanal", KANAL);
        body.put("rolle", "fuehrend");
        body.put("gueltig_ab", "2026-11-01T00:00:00+01:00");
        ok(ruf(anna, HttpMethod.POST, "/api/v1/messstellen/" + messstelle + "/quellen", body), 201);
    }

    // =========================================================================== Schritt 9: Kennzahl

    /**
     * Die Bezugsgröße von Hand — als BEZUGSFLÄCHE des Standorts (AP-11 E17: eine Bezugsfläche WIRD eine
     * Bezugsgröße mit Wertart {@code stammdatum}). Der Weg über eine Bezugsgröße mit Wertart
     * {@code periodenwert} steht dem Lauf nicht offen, siehe {@code BEFUND} in der Klassen-Beschreibung.
     */
    private void flaecheVonHand() throws Exception {
        ok(ruf(anna, HttpMethod.PUT, "/api/v1/standorte/" + standort + "/flaeche",
                Map.of("m2", 8450)), 200);
    }

    /** Die Kennzahl aus der Vorlage „Energie je Fläche": Zähler = die Messstelle, Nenner = die Bezugsfläche. */
    private UUID kennzahlAusVorlage() throws Exception {
        Map<String, Object> zaehler = Map.of("rolle", "zaehler", "art", "messstelle", "kennzeichen", MS);
        Map<String, Object> nenner = Map.of("rolle", "nenner", "art", "bezugsflaeche", "kennzeichen", "ST-1");
        Antwort a = ok(ruf(anna, HttpMethod.POST, "/api/v1/kennzahlen", Map.of("name",
                "Netzbezug je m² — Werk Lindach", "rechenform", "quotient", "geltung_art", "standort",
                "geltung_id", standort.toString(), "eingaenge", List.of(zaehler, nenner))), 201);
        gesehen.add(a.text());
        return UUID.fromString(a.body().path("id").asText());
    }

    // =========================================================================== Das Drehbuch der Box

    /** U5: 18 Samples/min am Netzzähler — hier je Minute ein Zählerstand, mit der bewussten Lücke. */
    private static List<Object[]> drehbuch() {
        List<Object[]> zeilen = new ArrayList<>();
        BigDecimal stand = STAND_1_NOVEMBER;
        for (Instant t = NOVEMBER; !t.isAfter(DEZEMBER); t = t.plusSeconds(60)) {
            if (!t.isBefore(LUECKE_VON) && t.isBefore(LUECKE_BIS)) {
                continue;
            }
            LocalDate tag = t.atZone(BERLIN).toLocalDate();
            Instant beginn = tag.atStartOfDay(BERLIN).toInstant();
            long minuten = Duration.between(beginn, tag.plusDays(1).atStartOfDay(BERLIN).toInstant()).toMinutes();
            BigDecimal amTag = tagesmenge(tag);
            BigDecimal gewachsen = amTag.multiply(BigDecimal.valueOf(Duration.between(beginn, t).toMinutes()))
                    .divide(BigDecimal.valueOf(minuten), 4, RoundingMode.HALF_UP);
            zeilen.add(new Object[] {Timestamp.from(t), tagesbeginn(tag).add(gewachsen), t.getEpochSecond()});
        }
        return zeilen;
    }

    /** 240 kWh am Tag, am letzten Novembertag 260 kWh — der Kanal zählt in Wh. */
    private static BigDecimal tagesmenge(LocalDate tag) {
        return new BigDecimal(tag.getDayOfMonth() == 30 ? "260" : "240");
    }

    private static BigDecimal tagesbeginn(LocalDate tag) {
        BigDecimal summe = STAND_1_NOVEMBER;
        for (LocalDate d = LocalDate.of(2026, 11, 1); d.isBefore(tag); d = d.plusDays(1)) {
            summe = summe.add(tagesmenge(d));
        }
        return summe;
    }

    /**
     * Die unabhängige Rechnung: die Monatsmenge ist der letzte gesendete Zählerstand minus dem ersten. Das ist
     * NICHT die Formel des Produkts (die über Viertelstunden und Tage geht) — genau darum taugt sie als Probe.
     */
    private static BigDecimal nachgerechnet(List<Object[]> drehbuch) {
        BigDecimal erster = (BigDecimal) drehbuch.get(0)[1];
        BigDecimal letzter = (BigDecimal) drehbuch.get(drehbuch.size() - 1)[1];
        return letzter.subtract(erster).setScale(3, RoundingMode.HALF_UP);
    }

    /** Die Rohzeilen in der Form, die der Writer schreibt (die Naht zu AP-07 IP-21). */
    private void saeen(List<Object[]> zeilen) {
        List<Object[]> stapel = new ArrayList<>();
        for (Object[] z : zeilen) {
            Timestamp t = (Timestamp) z[0];
            stapel.add(new Object[] {t, Timestamp.from(t.toInstant().plusSeconds(2)), kb, anlage, box, KANAL,
                    ((BigDecimal) z[1]).doubleValue(), z[2], entity});
        }
        for (int i = 0; i < stapel.size(); i += 5000) {
            root.batchUpdate("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, "
                    + "point_key, raw_numeric, quality, catalog_version, edge_sequence, aggregation_kind, entity_id, "
                    + "applied_revision, value_kind, role, delivery, delay_s) VALUES (?, ?, ?, ?, ?, ?, ?, 'good', "
                    + "'2026.09.17.1', ?, 'counter', ?, 1, 'counter', 'fuehrend', 'direkt', 2) ON CONFLICT DO NOTHING",
                    stapel.subList(i, Math.min(i + 5000, stapel.size())));
        }
    }

    private void verdichten(Instant jetzt) {
        for (int i = 0; i < 400; i++) {
            ViertelstundeVerdichter.Lauf l = verdichter.lauf(jetzt);
            if (l.rueckrechnungFertig() && zahl("SELECT count(*) FROM messreihe_viertelstunde_arbeit") == 0) {
                return;
            }
        }
        throw new AssertionError("die Verdichtung wird nicht fertig");
    }

    // =========================================================================== Lesen und Hilfen

    private String zustandDesNovembers() {
        List<String> z = root.queryForList("SELECT zustand FROM messreihe_periode WHERE tenant_id = ? AND art = 'monat' "
                + "AND tag = DATE '2026-11-01'", String.class, kb);
        return z.isEmpty() ? "fehlt" : z.get(0);
    }



    /**
     * Der Zustand dieses Kundenbereichs in {@code voltpilot_uems_kundenbereich_messwert_zustand}
     * ({@code bekannt} | {@code nie}), oder {@code null}, wenn der Kundenbereich in der Metrik GAR NICHT
     * vorkommt — genau das war BEFUND B2. Das ALTER steht nur bei {@code bekannt}: es kommt aus dem
     * Lücken-Melder, und der läuft in diesem Lauf nicht mit (der Takt kennt ihn nicht).
     */
    private String messwertZustandDesKunden() {
        return register.find(UemsMetricsCollector.MESSWERT_ZUSTAND).gauges().stream()
                .filter(g -> kb.toString().equals(g.getId().getTag("tenant")) && g.value() == 1.0)
                .map(g -> g.getId().getTag("zustand")).findFirst().orElse(null);
    }

    private Double messwertAlter() {
        return register.find(UemsMetricsCollector.MESSWERT_ALTER).gauges().stream()
                .map(g -> g.value()).findFirst().orElse(null);
    }

    private double arbeitslistenOffen() {
        return register.find(UemsMetricsCollector.ARBEITSLISTE_OFFEN).gauges().stream()
                .mapToDouble(g -> g.value()).sum();
    }

    /**
     * Wie viele Läufer-Zustandszeilen die Metriken tragen. Das ALTER
     * ({@link UemsMetricsCollector#LAEUFER_ALTER}) steht hier bei keinem Läufer, weil dieser Lauf die
     * Verdichter selbst baut und taktet statt die Spring-Läufer zu wecken — sie schreiben darum keine
     * Lauf-Zeile. Der Zustand ist die Zeile, die es je Läufer immer gibt.
     */
    private long laeuferZustaende() {
        return register.find(UemsMetricsCollector.LAEUFER_ZUSTAND).gauges().stream().count();
    }

    /** Welche der verbotenen Wörter in diesen Antworten vorkommen. */
    private static Set<String> worteIn(List<String> antworten) {
        Set<String> gefunden = new LinkedHashSet<>();
        for (String antwort : antworten) {
            String klein = antwort == null ? "" : antwort.toLowerCase(Locale.ROOT);
            for (String wort : VERBOTEN) {
                if (klein.contains(wort)) {
                    gefunden.add(wort);
                }
            }
        }
        return gefunden;
    }

    private void uhrBerichte(String zeit) {
        berichte.uhrStellen(Clock.fixed(OffsetDateTime.parse(zeit).toInstant(), ZoneOffset.UTC));
    }

    private static Wer person(String sub, String name, String rolle) {
        PERSONEN.put(sub, new Benutzer(sub, name, Konto.vonCode("benutzer"), KontoZustand.AKTIV,
                List.of(new Zuweisung(Rolle.vonCode(rolle), null, null, null, Instant.EPOCH, null, null))));
        return new Wer(sub, name);
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

    /** Ohne Docker ist die Abnahme NICHT gelaufen — der Lauf wird mit einem Satz übersprungen, der das sagt. */
    static final class DockerPflicht implements ExecutionCondition {
        @Override
        public ConditionEvaluationResult evaluateExecutionCondition(ExtensionContext context) {
            try {
                if (DockerClientFactory.instance().isDockerAvailable()) {
                    return ConditionEvaluationResult.enabled("Docker vorhanden");
                }
            } catch (RuntimeException e) {
                return ConditionEvaluationResult.disabled("NW-4 NICHT GELAUFEN: kein Docker (" + e.getMessage() + ")");
            }
            return ConditionEvaluationResult.disabled("NW-4 NICHT GELAUFEN: kein Docker");
        }
    }
}
