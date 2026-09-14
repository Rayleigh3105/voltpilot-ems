package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Import-VORSCHAU (UEMS AP-09 IP-12) gegen die echte Kette: {@code POST /api/v1/bezugsdaten/importe/vorschau}
 * mit Datei und Zuordnung, Bezugsgrößen, Werten und früheren Importen in der Datenbank, unter RLS.
 *
 * <p>Der Kern ist {@link #vorschauZweimalIdentischUndNullZeilenInBezugsgroesseWert()}: die Vorschau schreibt
 * nichts — keinen Wert, keinen Import, keine Vorlage, und nicht die Datei — und zweimal ist dieselbe Antwort.
 * {@link #dieFaelleDesVertragsUeberDieRoute()} schickt jede Vorschau-Prüfung der Vektor-Datei (B1, B2, B9–B13) über
 * die Route; die Bezugsgrößen, der Bestand und die früheren Importe stehen dafür so in den Tabellen, wie der
 * Vertrag sie beschreibt (geschrieben werden sie erst mit IP-7/IP-13).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class BezugsdatenImportVorschauApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2", "bezugsdaten-vectors.json");
    private static final String PFAD = "/api/v1/bezugsdaten/importe/vorschau";
    private static final Instant JETZT = OffsetDateTime.parse("2026-11-03T09:12:00+01:00").toInstant();

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
    ImportVorschauService service;

    @Autowired
    org.springframework.transaction.PlatformTransactionManager transaktionen;

    @Autowired
    JdbcTemplate app;

    private static JdbcTemplate root;
    private static JsonNode vertrag;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID unternehmen, UUID standort, UUID messstelle) {}

    private record Antwort(int status, String text, JsonNode body) {}

    @BeforeAll
    static void verbinde() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        vertrag = MAPPER.readTree(VEKTOREN.toFile());
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        service.uhrStellen(Clock.systemUTC());
    }

    // ================================================================ Der Satz, der das Paket definiert

    /**
     * Die Abnahme im Wortlaut: zweimal dieselbe Vorschau ergibt dasselbe, und null Zeilen sind entstanden — in
     * {@code bezugsgroesse_wert} und in JEDER anderen Tabelle der Datenbank (Bestandsschutz-Fingerabdruck). Einmal auf
     * leerem Bestand (die Zeile ist „neu“, eine Übernahme schriebe sie), einmal mit Wert und früherem Import (die
     * Lese-Wege für „Wiederholung“ und {@code datei_bekannt} laufen mit).
     */
    @Test
    void vorschauZweimalIdentischUndNullZeilenInBezugsgroesseWert() throws Exception {
        JsonNode b1 = pruefung("B1", "ERP-Datei").path("eingang").path("vorschau");
        Welt leer = welt();
        bezugsgroessen(leer, b1.path("bezugsgroessen"));
        service.uhrStellen(Clock.fixed(JETZT, ZoneOffset.UTC));

        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());
        Antwort erste = vorschau(leer, b1);
        Antwort zweite = vorschau(leer, b1);
        assertThat(erste.status()).as(erste.text()).isEqualTo(200);
        assertThat(erste.body().at("/zeilen/0/urteil").asText()).isEqualTo("neu");
        assertThat(erste.body().at("/import/aenderungen").asInt()).as("eine Übernahme schriebe genau eine Zeile").isOne();
        assertThat(zweite.text()).as("zweimal = Zeichen für Zeichen dieselbe Antwort").isEqualTo(erste.text());
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of())))
                .as("keine Tabelle hat sich geändert").isEmpty();
        for (String tabelle : List.of("bezugsgroesse_wert", "bezugsdaten_import", "bezugsdaten_import_zeile",
                "bezugsdaten_vorlage", "bezugsgroesse_aenderung")) {
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?", Long.class,
                    leer.mandant())).as(tabelle).isZero();
        }

        // Später gerechnet: dasselbe Ergebnis, nur die Ausstellung der Kennung ist eine andere.
        service.uhrStellen(Clock.fixed(JETZT.plus(Duration.ofMinutes(7)), ZoneOffset.UTC));
        Antwort spaeter = vorschau(leer, b1);
        assertThat(ohneAusstellung(spaeter.body())).isEqualTo(ohneAusstellung(erste.body()));
        assertThat(spaeter.body().at("/vorschau/ergebnis_fingerabdruck").asText())
                .isEqualTo(erste.body().at("/vorschau/ergebnis_fingerabdruck").asText());

        // Mit Wert und früherem Import: gelesen wird mehr, geschrieben wieder nichts.
        JsonNode b2 = pruefung("B2", "Dieselbe Datei").path("eingang").path("vorschau");
        Welt bekannt = welt();
        Map<String, UUID> ids = bezugsgroessen(bekannt, b2.path("bezugsgroessen"));
        bestand(bekannt, ids, b2);
        importe(bekannt, b2);
        service.uhrStellen(Clock.fixed(OffsetDateTime.parse(b2.path("jetzt").asText()).toInstant(), ZoneOffset.UTC));
        Map<String, String> mitBestand = Bestandsschutz.fingerabdruck(root, List.of());
        Antwort a = vorschau(bekannt, b2);
        Antwort b = vorschau(bekannt, b2);
        assertThat(a.body().at("/zeilen/0/urteil").asText()).isEqualTo("wiederholung");
        assertThat(a.body().at("/zeilen/0/befunde/0/befund").asText()).isEqualTo("datei_bekannt");
        assertThat(b.text()).isEqualTo(a.text());
        assertThat(Bestandsschutz.abweichungen(mitBestand, Bestandsschutz.fingerabdruck(root, List.of()))).isEmpty();
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsgroesse_wert WHERE tenant_id = ?", Long.class,
                bekannt.mandant())).as("nur der Bestand, kein zweiter Wert — 312 400 kg, nicht 624 800").isOne();
    }

    /**
     * Die zweite Wand hinter dem Fingerabdruck: die Transaktion, in der die Vorschau liest, ist auf DIESER Datenquelle
     * wirklich {@code READ ONLY} — die Datenbank selbst lehnt ein INSERT darin ab (dieselbe Einstellung wie
     * {@code ImportVorschauService}).
     */
    @Test
    void dieNurLeseTransaktionDerVorschauLehntJedesSchreibenAb() {
        Welt w = welt();
        org.springframework.transaction.support.TransactionTemplate lesen =
                new org.springframework.transaction.support.TransactionTemplate(transaktionen);
        lesen.setReadOnly(true);
        TenantContext.set(w.mandant());
        try {
            Throwable t = org.assertj.core.api.Assertions.catchThrowable(() -> lesen.executeWithoutResult(s -> app.update(
                    "INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, geltung_art, "
                            + "standort_id) VALUES (?, 'BZ-99', 'Schreibversuch', 'periodenwert', 'kg', 'monat', 'standort', ?)",
                    w.mandant(), w.standort())));
            assertThat(t).as("ein Schreibversuch in der Vorschau-Transaktion").isNotNull();
            assertThat(org.assertj.core.util.Throwables.getRootCause(t).getMessage()).contains("read-only transaction");
        } finally {
            TenantContext.clear();
        }
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsgroesse WHERE tenant_id = ?", Long.class, w.mandant())).isZero();
    }

    // ================================================================ Die Fälle des Vertrags

    /** Jede Vorschau-Prüfung der Vektor-Datei über die Route — dieselbe Antwort wie die reine Regel. */
    @TestFactory
    List<DynamicTest> dieFaelleDesVertragsUeberDieRoute() {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode fall : vertrag.path("cases")) {
            for (JsonNode p : fall.path("pruefungen")) {
                if (!"vorschau".equals(p.path("regel").asText())) {
                    continue;
                }
                String name = fall.path("id").asText() + " · " + p.path("name").asText();
                tests.add(DynamicTest.dynamicTest(name, () -> fall(name, p.path("eingang").path("vorschau"),
                        p.path("ergebnis").path("vorschau"))));
            }
        }
        assertThat(tests).hasSize(14);
        return tests;
    }

    private void fall(String why, JsonNode ein, JsonNode soll) throws Exception {
        Welt w = welt();
        Map<String, UUID> ids = bezugsgroessen(w, ein.path("bezugsgroessen"));
        bestand(w, ids, ein);
        importe(w, ein);
        service.uhrStellen(Clock.fixed(OffsetDateTime.parse(ein.path("jetzt").asText()).toInstant(), ZoneOffset.UTC));
        Antwort a = vorschau(w, ein);
        assertThat(a.status()).as(why + " · " + a.text()).isEqualTo(200);
        JsonNode ist = a.body();

        JsonNode d = soll.path("datei");
        for (String feld : List.of("sha256", "bytes", "zusatz", "kodierung", "trennzeichen", "kopfzeile", "datenzeilen")) {
            assertThat(ist.path("datei").path(feld)).as(why + " · datei." + feld).isEqualTo(d.path(feld));
        }
        assertThat(ist.at("/datei/befund/befund").isMissingNode() ? NullNode.getInstance() : ist.at("/datei/befund/befund"))
                .as(why + " · datei.befund").isEqualTo(d.path("befund"));
        JsonNode f = soll.path("frueherer_import");
        assertThat(ist.path("frueherer_import").isNull() ? null : ist.at("/frueherer_import/kennung").asText() + " "
                + ist.at("/frueherer_import/status").asText())
                .as(why + " · frueherer_import").isEqualTo(f.isNull() ? null : f.path("kennung").asText() + " " + f.path("status").asText());

        List<String> sollZeilen = new ArrayList<>();
        for (JsonNode z : soll.path("zeilen")) {
            String bz = z.path("bezugsgroesse").asText(null);
            String fp = z.path("fingerabdruck").isNull() ? null : ImportVorschau.zeilenFingerabdruck(ids.get(bz),
                    schluesselRoh(z.path("schluessel").asText(), ein, bz), new BigDecimal(z.path("betrag").asText()));
            sollZeilen.add(zeile(z.path("nr").asInt(), bz, z.path("schluessel").asText(null), z.path("betrag").asText(null),
                    z.path("einheit").asText(null), z.path("urteil").asText(), CsvVektoren.texte(z.path("befunde")), fp));
        }
        List<String> istZeilen = new ArrayList<>();
        for (JsonNode z : ist.path("zeilen")) {
            istZeilen.add(zeile(z.path("nr").asInt(), z.path("bezugsgroesse").asText(null), z.path("schluessel").asText(null),
                    z.path("betrag").asText(null), z.path("einheit").asText(null), z.path("urteil").asText(),
                    z.path("befunde").findValuesAsText("befund"), z.path("fingerabdruck").asText(null)));
            for (JsonNode b : z.path("befunde")) {
                assertThat(b.path("satz").asText()).as(why + " · Satz").isEqualTo(vertrag.path("befund_saetze")
                        .path(b.path("befund").asText()).asText());
            }
        }
        assertThat(istZeilen).as(why + " · zeilen").isEqualTo(sollZeilen);

        JsonNode i = soll.path("import");
        for (String feld : List.of("status", "zaehler", "uebernahme_moeglich", "import_datensatz", "bestaetigung", "aenderungen")) {
            assertThat(ist.path("import").path(feld)).as(why + " · import." + feld).isEqualTo(i.path(feld));
        }
        assertThat(ist.at("/import/befunde").findValuesAsText("befund")).as(why + " · import.befunde")
                .isEqualTo(CsvVektoren.texte(i.path("befunde")));
        assertThat(ist.at("/vorschau/status").asText()).isEqualTo("vorschau");
    }

    // ================================================================ Fingerabdrücke, Kennung, Zaun

    /** C2 über die Route: dieselben Werte in anderer Spaltenreihenfolge sind eine andere Datei, aber dieselbe Zeile. */
    @Test
    void derZeilenFingerabdruckIstFachlichUndDieDateiIstDieDatei() throws Exception {
        Welt w = welt();
        JsonNode b1 = pruefung("B1", "ERP-Datei").path("eingang").path("vorschau");
        JsonNode umgestellt = pruefung("B1", "Dieselben Werte").path("eingang").path("vorschau");
        Map<String, UUID> ids = bezugsgroessen(w, b1.path("bezugsgroessen"));
        service.uhrStellen(Clock.fixed(JETZT, ZoneOffset.UTC));
        JsonNode a = vorschau(w, b1).body();
        JsonNode b = vorschau(w, umgestellt).body();
        assertThat(b.at("/datei/sha256").asText()).isNotEqualTo(a.at("/datei/sha256").asText());
        assertThat(b.at("/zeilen/0/fingerabdruck").asText()).isEqualTo(a.at("/zeilen/0/fingerabdruck").asText())
                .isEqualTo(ImportVorschau.zeilenFingerabdruck(ids.get("BZ-1"), "2026-10", new BigDecimal("312400")));
        assertThat(a.at("/zeilen/0/periode_von").asText()).isEqualTo("2026-10-01");
        assertThat(a.at("/zeilen/0/periode_bis").asText()).as("letzter Tag einschließlich").isEqualTo("2026-10-31");
        assertThat(a.at("/datei/sha256").asText()).isEqualTo(ImportVorschau.sha256(CsvVektoren.datei(b1.path("datei"))));
    }

    /**
     * Die Kennung lebt 30 Minuten und gehört zu genau diesem Ergebnis: ändert sich der Bestand, rechnet die nächste
     * Vorschau ein anderes Ergebnis, und die alte Kennung ist veraltet — sie hat nichts reserviert.
     */
    @Test
    void dieKennungIstKurzlebigUndReserviertNichts() throws Exception {
        Welt w = welt();
        JsonNode b1 = pruefung("B1", "ERP-Datei").path("eingang").path("vorschau");
        Map<String, UUID> ids = bezugsgroessen(w, b1.path("bezugsgroessen"));
        service.uhrStellen(Clock.fixed(JETZT, ZoneOffset.UTC));
        JsonNode v = vorschau(w, b1).body().path("vorschau");
        String kennung = v.path("kennung").asText();
        String fp = v.path("ergebnis_fingerabdruck").asText();
        assertThat(OffsetDateTime.parse(v.path("gueltig_bis").asText()).toInstant())
                .isEqualTo(OffsetDateTime.parse(v.path("ausgestellt_am").asText()).toInstant().plus(Duration.ofMinutes(30)));
        assertThat(ImportVorschau.kennungPruefen(kennung, w.mandant(), fp, JETZT.plus(Duration.ofMinutes(29)))).isEqualTo("gueltig");
        assertThat(ImportVorschau.kennungPruefen(kennung, w.mandant(), fp, JETZT.plus(Duration.ofMinutes(30)))).isEqualTo("abgelaufen");

        // Jemand trägt den Oktober ein, bevor übernommen wird: die nächste Vorschau sagt „Wiederholung“.
        JsonNode b2 = pruefung("B2", "Dieselbe Datei").path("eingang").path("vorschau");
        bestand(w, ids, b2);
        JsonNode neu = vorschau(w, b1).body();
        assertThat(neu.at("/zeilen/0/urteil").asText()).isEqualTo("wiederholung");
        String neuerFp = neu.at("/vorschau/ergebnis_fingerabdruck").asText();
        assertThat(neuerFp).isNotEqualTo(fp);
        assertThat(ImportVorschau.kennungPruefen(kennung, w.mandant(), neuerFp, JETZT.plus(Duration.ofMinutes(5)))).isEqualTo("veraltet");
    }

    /** RLS: fremde Bezugsgrößen, fremde Werte und fremde Importe sieht die Vorschau nicht. */
    @Test
    void derMandantenzaunHaeltBezugsgroessenWerteUndImporte() throws Exception {
        JsonNode b2 = pruefung("B2", "Dieselbe Datei").path("eingang").path("vorschau");
        Welt a = welt();
        Map<String, UUID> ids = bezugsgroessen(a, b2.path("bezugsgroessen"));
        bestand(a, ids, b2);
        importe(a, b2);
        service.uhrStellen(Clock.fixed(OffsetDateTime.parse(b2.path("jetzt").asText()).toInstant(), ZoneOffset.UTC));

        Welt b = welt();
        JsonNode ohneBz = vorschau(b, b2).body();
        assertThat(ohneBz.at("/zeilen/0/befunde").findValuesAsText("befund")).containsExactly("bezug_unbekannt");
        assertThat(ohneBz.path("frueherer_import").isNull()).as("die Datei ist bei B nicht bekannt").isTrue();

        bezugsgroessen(b, b2.path("bezugsgroessen"));
        JsonNode mitBz = vorschau(b, b2).body();
        assertThat(mitBz.at("/zeilen/0/urteil").asText()).as("A's Oktober-Wert ist nicht B's").isEqualTo("neu");
        assertThat(mitBz.at("/zeilen/0/befunde").findValuesAsText("befund")).isEmpty();
        assertThat(mitBz.at("/zeilen/0/bestand").isNull()).isTrue();
    }

    // ================================================================ Die Anfrage

    @Test
    void eineUnvollstaendigeOderFremdeZuordnungIst400MitFeld() throws Exception {
        Welt w = welt();
        JsonNode b1 = pruefung("B1", "ERP-Datei").path("eingang").path("vorschau");
        byte[] datei = CsvVektoren.datei(b1.path("datei"));
        ObjectNode z = (ObjectNode) b1.path("zuordnung").deepCopy();

        assertThat(anfrage(w, datei, z.deepCopy().put("spalte", 3).toString())).containsEntry("feld", "spalte");
        ObjectNode ohneWert = z.deepCopy();
        ((ObjectNode) ohneWert.path("spalten")).putNull("wert");
        assertThat(anfrage(w, datei, ohneWert.toString())).containsEntry("feld", "spalten.wert");
        assertThat(anfrage(w, datei, z.deepCopy().put("deutung", "quartal").toString())).containsEntry("feld", "deutung");
        ObjectNode csv = z.deepCopy();
        ((ObjectNode) csv.path("csv")).put("kodierung", "utf-16");
        assertThat(anfrage(w, datei, csv.toString())).containsEntry("feld", "csv.kodierung");
        ObjectNode text = z.deepCopy();
        ((ObjectNode) text.path("spalten")).put("wert", "drei");
        assertThat(anfrage(w, datei, text.toString())).containsEntry("feld", "spalten.wert");
        assertThat(anfrage(w, datei, "kein json")).containsEntry("feld", "zuordnung");

        MvcResult ohneDatei = mvc.perform(multipart(PFAD)
                .file(new MockMultipartFile("zuordnung", "", "application/json", z.toString().getBytes(StandardCharsets.UTF_8)))
                .with(ines(w))).andReturn();
        assertThat(ohneDatei.getResponse().getStatus()).isEqualTo(400);
        assertThat(MAPPER.readTree(ohneDatei.getResponse().getContentAsString(StandardCharsets.UTF_8)).path("feld").asText())
                .isEqualTo("datei");
    }

    /** Was an der DATEI nicht passt, ist nie 400 — es ist ein Befund der Vorschau (C1), und er schreibt nichts. */
    @Test
    void eineZuGrosseOderUnlesbareDateiIstEinBefundKeinFehler() throws Exception {
        Welt w = welt();
        JsonNode b1 = pruefung("B1", "ERP-Datei").path("eingang").path("vorschau");
        bezugsgroessen(w, b1.path("bezugsgroessen"));
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());

        byte[] zuGross = new byte[CsvLeser.BYTES_HOECHSTENS + 1];
        java.util.Arrays.fill(zuGross, (byte) 'x');
        JsonNode gross = vorschauRoh(w, zuGross, b1.path("zuordnung").toString()).body();
        assertThat(gross.at("/datei/befund/befund").asText()).isEqualTo("datei_zu_gross");
        assertThat(gross.at("/datei/zusatz").asText()).isEqualTo("zu_viele_bytes");
        assertThat(gross.at("/datei/befund/satz").asText()).isEqualTo("Die Datei ist zu groß.");
        assertThat(gross.at("/import/uebernahme_moeglich").asBoolean()).isFalse();

        byte[] zip = {0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08, 0x00};
        JsonNode unlesbar = vorschauRoh(w, zip, b1.path("zuordnung").toString()).body();
        assertThat(unlesbar.at("/datei/befund/befund").asText()).isEqualTo("kodierung_unlesbar");
        assertThat(unlesbar.path("zeilen")).isEmpty();
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of()))).isEmpty();
    }

    /** Die Formel-Neutralisierung gilt der ANZEIGE (C1); gerechnet wird mit dem Text der Datei. */
    @Test
    void felderWerdenZurAnzeigeNeutralisiert() throws Exception {
        Welt w = welt();
        JsonNode b1 = pruefung("B1", "ERP-Datei").path("eingang").path("vorschau");
        bezugsgroessen(w, b1.path("bezugsgroessen"));
        service.uhrStellen(Clock.fixed(JETZT, ZoneOffset.UTC));
        ObjectNode z = (ObjectNode) b1.path("zuordnung").deepCopy();
        z.putNull("csv");
        ((ObjectNode) z.path("bezug_tabelle")).put("=HYPERLINK(\"x\")", "BZ-1");
        byte[] datei = "Periode;Artikelgruppe;Menge;Einheit\n2026-10;=HYPERLINK(\"x\");-5;kg\n".getBytes(StandardCharsets.UTF_8);
        JsonNode v = vorschauRoh(w, datei, z.toString()).body();
        assertThat(v.at("/zeilen/0/felder/1").asText()).isEqualTo("'=HYPERLINK(\"x\")");
        assertThat(v.at("/zeilen/0/felder/2").asText()).isEqualTo("'-5");
        assertThat(v.at("/zeilen/0/bezugsgroesse").asText()).as("zugeordnet wird mit dem Text der Datei").isEqualTo("BZ-1");
        assertThat(v.at("/zeilen/0/befunde").findValuesAsText("befund")).containsExactly("wert_negativ");
    }

    // ===================================================================== Gerüst

    private static JsonNode pruefung(String fall, String nameBeginnt) {
        for (JsonNode f : vertrag.path("cases")) {
            if (!f.path("id").asText().equals(fall)) {
                continue;
            }
            for (JsonNode p : f.path("pruefungen")) {
                if ("vorschau".equals(p.path("regel").asText()) && p.path("name").asText().startsWith(nameBeginnt)) {
                    return p;
                }
            }
        }
        throw new IllegalStateException("keine Vorschau-Prüfung " + fall + " " + nameBeginnt);
    }

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Vorschau #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID st = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-14', 'Ladepunkt Halle 2', 'gemessen', 'Strom', "
                + "'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, t);
        return new Welt(t, u, st, ms);
    }

    /** Die Bezugsgrößen des Falls, am Standort (Zeitzone Europe/Berlin); Kennzeichen → neue ID. */
    private static Map<String, UUID> bezugsgroessen(Welt w, JsonNode liste) {
        Map<String, UUID> ids = new LinkedHashMap<>();
        for (JsonNode b : liste) {
            ids.put(b.path("kennzeichen").asText(), root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, "
                    + "name, wertart, einheit, periode_art, geltung_art, standort_id) VALUES (?, ?, ?, ?, ?, ?, 'standort', ?) "
                    + "RETURNING id", UUID.class, w.mandant(), b.path("kennzeichen").asText(), "Bezugsgröße "
                    + b.path("kennzeichen").asText(), b.path("wertart").asText(), b.path("einheit").asText(),
                    b.path("periode_art").asText(null), w.standort()));
        }
        return ids;
    }

    /** Der Bestand des Falls als wirksame Fassung 1 (so, wie IP-13 sie schreiben wird), erfasst nach Periodenende. */
    private static void bestand(Welt w, Map<String, UUID> ids, JsonNode ein) {
        for (JsonNode b : ein.path("bestand")) {
            LocalDate von = LocalDate.parse(b.path("schluessel").asText() + "-01");
            root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                    + "periode_von, periode_bis, zeitzone, fassung, vorgang, status, betrag, herkunft_art, import_kennung, "
                    + "import_zeile, geliefert_text, geliefert_einheit, actor_sub, actor_name, actor_rolle, actor_art, "
                    + "created_at) VALUES (?, ?, 'periodenwert', 'kg', 'monat', ?, ?, 'Europe/Berlin', ?, 'erstwert', "
                    + "'wirksam', ?, 'import', ?, 2, '312.400,0', 'kg', 'sub-ik', 'Ines Kaltenbach', 'energiemanager', "
                    + "'kunde', ?)", w.mandant(), ids.get(b.path("bezugsgroesse").asText()), von,
                    von.plusMonths(1).minusDays(1), b.path("fassung").asInt(), new BigDecimal(b.path("betrag").asText()),
                    b.path("import_kennung").asText(), OffsetDateTime.parse("2026-11-03T09:12:00+01:00"));
        }
    }

    /** Die früheren Importe DIESER Datei als Fassung 1 mit ihrem Status. */
    private static void importe(Welt w, JsonNode ein) {
        String sha = ImportVorschau.sha256(CsvVektoren.datei(ein.path("datei")));
        for (JsonNode i : ein.path("importe_dieser_datei")) {
            String status = i.path("status").asText();
            boolean schrieb = status.equals("uebernommen") || status.equals("teilweise_uebernommen");
            root.update("INSERT INTO bezugsdaten_import (tenant_id, kennung, fassung, status, datei_name, datei_bytes, "
                    + "datei_sha256, kodierung, trennzeichen, kopfzeile, zeilen, neu, wiederholung, konflikt, berichtigung, "
                    + "uebersprungen, abgelehnt, mit_hinweis, aenderungen, befunde, actor_sub, actor_name, actor_rolle, "
                    + "actor_art, created_at) VALUES (?, ?, 1, ?, 'ERP_Spritzguss_Produktion_2026-10.csv', ?, ?, "
                    + "'windows-1252', ';', true, 1, ?, ?, 0, 0, 0, ?, 0, ?, '[]', 'sub-ik', 'Ines Kaltenbach', "
                    + "'energiemanager', 'kunde', ?)", w.mandant(), i.path("kennung").asText(), status,
                    CsvVektoren.datei(ein.path("datei")).length, sha, schrieb ? 1 : 0,
                    status.equals("wiederholt") ? 1 : 0, status.equals("verworfen") ? 1 : 0, schrieb ? 1 : 0,
                    OffsetDateTime.parse(i.path("am").asText()));
        }
    }

    private static String schluesselRoh(String anzeige, JsonNode ein, String bz) {
        String teil = anzeige.substring(anzeige.indexOf(" · ") + 3);
        for (JsonNode b : ein.path("bezugsgroessen")) {
            if (b.path("kennzeichen").asText().equals(bz) && "stand".equals(b.path("wertart").asText())) {
                return OffsetDateTime.parse(teil).toInstant().toString();
            }
        }
        return teil;
    }

    private static String zeile(int nr, String bz, String schluessel, String betrag, String einheit, String urteil,
            List<String> befunde, String fingerabdruck) {
        String b = betrag == null ? null : new BigDecimal(betrag).signum() == 0 ? "0"
                : new BigDecimal(betrag).stripTrailingZeros().toPlainString();
        return nr + " | " + bz + " | " + schluessel + " | " + b + " " + einheit + " | " + urteil + " " + befunde + " | "
                + fingerabdruck;
    }

    private static JsonNode ohneAusstellung(JsonNode antwort) {
        ObjectNode kopie = antwort.deepCopy();
        ((ObjectNode) kopie.path("vorschau")).remove(List.of("kennung", "ausgestellt_am", "gueltig_bis"));
        return kopie;
    }

    private static org.springframework.test.web.servlet.request.RequestPostProcessor ines(Welt w) {
        return jwt().jwt(j -> {
            j.subject("sub-ines-" + w.mandant());
            j.claim("preferred_username", "Ines Kaltenbach");
            j.claim("tenant_id", w.mandant().toString());
        });
    }

    private Antwort vorschau(Welt w, JsonNode ein) throws Exception {
        return vorschauRoh(w, CsvVektoren.datei(ein.path("datei")), ein.path("zuordnung").toString());
    }

    private Antwort vorschauRoh(Welt w, byte[] datei, String zuordnung) throws Exception {
        MvcResult r = mvc.perform(multipart(PFAD)
                .file(new MockMultipartFile("datei", "ERP_Spritzguss_Produktion_2026-10.csv", "text/csv", datei))
                .file(new MockMultipartFile("zuordnung", "", "application/json", zuordnung.getBytes(StandardCharsets.UTF_8)))
                .with(ines(w))).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text, text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> anfrage(Welt w, byte[] datei, String zuordnung) throws Exception {
        Antwort a = vorschauRoh(w, datei, zuordnung);
        assertThat(a.status()).as(a.text()).isEqualTo(400);
        Map<String, Object> body = MAPPER.convertValue(a.body(), Map.class);
        assertThat(body).containsEntry("code", "anfrage_ungueltig");
        return body;
    }
}
