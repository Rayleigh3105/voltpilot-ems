package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Date;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Abnahme der Plan-Konstruktion (UEMS AP-19 IP-26, NW-6) — die zwei Hälften des Auftrags als grüner Test:
 * „Die erforderlichen Entscheidungen und Nachweise sind auffindbar“ und „Die Verantwortung des Kunden bleibt
 * ausdrücklich erkennbar“ (Report §3.13, „Die Plan-Abnahme“). Eine Welt — Kunststoffwerk Ahrenberg vom 01.10.2026 bis
 * zum 30.04.2029, R1–R14 über die Routen, die das Portal ruft, die Leistungs-Stände von AP-11/12/16/17/18 direkt
 * geschrieben (Muster IP-8, IP-22, IP-23) — einmal gebaut, mit gestellter Uhr; die Gruppen je Satz der §8-Zeile:
 * <ol>
 *   <li><b>Auffindbar</b> (R1–R14, R3): jede Entscheidung steht im Verzeichnis mit Person, Tag, Fassung oder Nr. und
 *       Prüfsumme; das Verzeichnis vom 12.02.2029 gegen den Katalog R3 — was das Produkt nicht erreicht, steht je Zeile
 *       mit Grund in {@link #KEIN_NACHWEIS} (Befund R3, Captain 25.09.2026 = A: Katalog berichtigt auf 62).</li>
 *   <li><b>Verantwortungs-Satz</b> (SP4, R4): an jedem Leser, der ihn trägt (Verzeichnis, CSV, Wiedervorlage,
 *       Managementbewertung mit PDF), und auf jeder Energiemanagement-Fläche des Portals.</li>
 *   <li><b>Kein Vollständigkeits- oder Konformitätswort</b> (SP2, G4, Invariante 4): kein Satz eines Lesers — einmal im
 *       Quelltext der Leser und Schablonen, einmal in jeder Antwort der Welt.</li>
 *   <li><b>Audit → Feststellung → Maßnahme → Wirksamkeit durch eine Person</b> (R9, R10, R11).</li>
 *   <li><b>Managementbewertung mit Beschlüssen der Leitung und Folgen</b> (R13, R14).</li>
 * </ol>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class UemsEnergiemanagementAbnahmeTest {
    private static final String BASIS = "/api/v1/energiemanagement";
    private static final String VERZEICHNIS = BASIS + "/verzeichnis";
    private static final String MB = BASIS + "/managementbewertungen/BR-2029-0001";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Map<String, String> NAMEN = Map.of("IK", "Ines Kaltenbach", "JW", "Jonas Wendlinger",
            "PH", "Peter Hollerbach", "CB", "Claudia Berger", "MD", "Murat Demirci", "RF", "Robert Falk");
    private static final String VERANTWORTUNG = EnergiemanagementRegeln.SAETZE.get("verantwortung");
    private static final String GRENZ_SATZ = EnergiemanagementRegeln.SAETZE.get("grenz_satz");
    private static final String LEER = "Hier ist noch nichts festgehalten.";
    private static final String BEGRUENDUNG = "In der Besprechung am selben Tag entschieden.";
    private static final Map<String, Object> BESTELLUNG = Map.of(
            "bezeichnung", "Bestellung Energiemanagement vom 28.09.2026, unterschrieben",
            "ablage", "Personalakte (Personalabteilung)");
    private static final Map<String, Object> ORIGINAL = Map.of(
            "bezeichnung", "Energiepolitik Fassung 1, unterschrieben",
            "ablage", "QM-Laufwerk, Ordner Energiemanagement/Politik", "kennung", "EP-2026",
            "sha256", "3f1f253d0c40224028a65d3cd9409b689463ff4feab3282db32f83252bf73b9b");
    private static final Map<String, Object> AUDITBERICHT = Map.of(
            "bezeichnung", "Bericht internes Audit 2029, unterschrieben",
            "ablage", "QM-Laufwerk, Ordner Energiemanagement/Audits", "kennung", "IA-2029",
            "sha256", "761d45606a2ed3511c91e2a61bf4ba3287dac583b70f43ead3f3d8716233fdeb");
    private static final Map<String, Object> UNTERWEISUNG = Map.of(
            "bezeichnung", "Unterweisung Zeitschaltung Werkzeugheizungen, Murat Demirci", "ablage", "Personalsystem",
            "kennung", "UW-2028-014",
            "sha256", "5b0d6c3f1e2a4978b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3");
    private static final String SHA_GR2 = "3b1f4d86f164c8e54eaa3a9c335975dd54dcbd68b42bbb9c7b24d2195e2a9a2e";
    private static final String SHA_Z5B = "c07dd7a33d2b17df6fece484ec4e08bb50c93326653576cfb1b8dd8dcf8a41f0";

    /**
     * Der Katalog R3 (Report §7, „Ergebnis (erwartet)“), berichtigt am 25.09.2026 (Captain, Befund R3 = A): 62 Zeilen,
     * „Bewertung und Messplanung“ 20 statt 22 — die zwei Angaben aus {@link #KEIN_NACHWEIS} zählen nicht. Nie an das
     * Produkt angepasst: jede andere Zahl ist die des Konzepts.
     */
    private static final Map<String, Integer> KATALOG_R3 = katalogR3();

    /**
     * Befund R3 (bau-befunde.md, 25.09.2026; hier nachgeprüft), entschieden A: diese Angaben stehen in der Referenzdatei
     * ({@code messmittel_angaben[]}, „nicht erhoben“) und der ursprüngliche Katalog zählte sie mit Person und Tag — sie
     * sind aber kein Nachweis mit Person und Tag (AP-16 G3) und tragen keine Zeile im Verzeichnis. Die dritte Lücke des
     * Befunds, die abgelöste Kriterien-Fassung Nr. 1, hat dieses Paket im Produkt geschlossen (VerzeichnisBestand liest sie
     * als „abgelöst am …“, firstmate 25.09.2026 = B).
     */
    static final Map<String, String> KEIN_NACHWEIS = Map.of(
            "GR-5", "„nicht erhoben“ ist das Fehlen einer Angabe: das Produkt speichert dafür weder Person noch Tag "
                    + "(MessmittelService: nicht_erhoben = leere Spalten, kein Journal-Eintrag), VerzeichnisBestand liest "
                    + "nur Angaben mit Beleg",
            "K-8.2", "die Klasse des Wandlers ist „nicht erhoben“: sie hat keinen Beleg und keine Person, es gibt keine "
                    + "Zeile, die sie tragen könnte");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        // Eine Instanz je Klasse: Spring baut den Kontext vor @BeforeAll — die Datenbank muss schon laufen.
        POSTGRES.start();
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "ip26_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "ip26_test_pw");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> "http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/certs");
        r.add("voltpilot.uems.kennzahlen.enabled", () -> "false");
    }

    @Autowired MockMvc mvc;
    @Autowired EnergiemanagementDokumentService dokumente;
    @Autowired InternesAuditService audits;
    @Autowired FeststellungService feststellungen;
    @Autowired KennzahlService kennzahlen;
    @Autowired BerichtService berichte;
    @Autowired EnergiemanagementVerzeichnisService verzeichnis;
    @Autowired EnergiemanagementWiedervorlageService wiedervorlage;

    JdbcTemplate root;
    JsonNode referenz;
    Map<String, JsonNode> kopien = new HashMap<>();
    UUID tenant, unternehmen, s1, s2, g2, bz1;
    Map<String, String> person = new LinkedHashMap<>();
    Map<String, String> dokument = new LinkedHashMap<>();
    Map<String, UUID> einsatz = new LinkedHashMap<>();
    String audit, feststellung, pruefsummeNr1, abzugNr1;

    /** Was die Welt an ihren Tagen gelesen hat: das Verzeichnis vom 12.02.2029 08:00, auch gefiltert für Robert Falk. */
    JsonNode r3, r3Rf;
    /** Jede Antwort eines Lesers, an ihrem Tag (Sprach-Probe, Verantwortungs-Satz). */
    final Map<String, String> leser = new LinkedHashMap<>();

    // ================================================================================ Die Welt, einmal gebaut

    @BeforeAll
    void welt() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        referenz = JSON.readTree(Path.of("../../docs/contracts/v2/uems-referenzunternehmen.json").toFile());
        for (JsonNode c : JSON.readTree(Path.of("../../docs/contracts/v2/energiemanagement-vectors.json").toFile())
                .path("cases")) {
            if (c.path("operation").asText().equals("pruefsumme") && c.path("name").asText().contains("Fassung 1")) {
                kopien.put(c.path("name").asText().substring(3, 9), c);
            }
        }
        stammdaten();
        bis12Februar2029();
        uhr("2029-02-12T07:00:00Z");
        r3 = ruf(VERZEICHNIS, "IK", 200);
        r3Rf = ruf(VERZEICHNIS + "?person=" + person.get("RF"), "RF", 200);
        lies("verzeichnis 12.02.2029", VERZEICHNIS, "IK");
        lies("verzeichnis csv 12.02.2029", VERZEICHNIS + "?format=csv", "IK");
        lies("wiedervorlage 12.02.2029", BASIS + "/wiedervorlage", "IK");
        lies("wiedervorlage ics 12.02.2029", BASIS + "/wiedervorlage?format=ics", "IK");
        managementbewertungUndFolgen();
        uhr("2029-04-30T08:00:00Z");
        for (String wer : List.of("IK", "RF")) {
            lies("verzeichnis 30.04.2029 " + wer, VERZEICHNIS, wer);
            lies("wiedervorlage 30.04.2029 " + wer, BASIS + "/wiedervorlage", wer);
            lies("personen " + wer, BASIS + "/personen", wer);
            lies("aufgaben " + wer, BASIS + "/aufgaben?tag=2029-04-30", wer);
            lies("verantwortung " + wer, BASIS + "/verantwortung?tag=2029-04-30", wer);
            lies("dokumente " + wer, BASIS + "/dokumente", wer);
            lies("audits " + wer, BASIS + "/audits", wer);
            lies("feststellungen " + wer, BASIS + "/feststellungen", wer);
            lies("bekanntmachungen " + wer, BASIS + "/bekanntmachungen", wer);
            lies("managementbewertung " + wer, MB, wer);
            lies("stand BR-2029-0001/1 " + wer, "/api/v1/berichte/BR-2029-0001/staende/1", wer);
        }
        for (var d : dokument.entrySet()) {
            lies("dokument " + d.getKey(), BASIS + "/dokumente/" + d.getValue(), "IK");
        }
        lies("vergleich D-0002", BASIS + "/dokumente/" + dokument.get("D-0002") + "/vergleich", "IK");
        lies("audit AU-2029-0001", BASIS + "/audits/" + audit, "IK");
        lies("feststellung F-2029-0001", BASIS + "/feststellungen/" + feststellung, "IK");
        lies("nachweise EE-1", BASIS + "/energieeinsaetze/" + einsatz.get("EE-1") + "/nachweise", "IK");
        lies("nachweise MD", BASIS + "/personen/" + person.get("MD") + "/nachweise", "IK");
        lies("person RF", BASIS + "/personen/" + person.get("RF"), "IK");
        lies("massnahme M-2029-0001", "/api/v1/massnahmen/" + id("massnahme", "M-2029-0001"), "IK");
        berichte.uhrStellen(Clock.fixed(Instant.parse("2029-04-30T08:00:00Z"), ZoneOffset.UTC));
        JsonNode naechste = ruf("POST", "/api/v1/berichte", "IK", Map.of("vorlage", "managementbewertung", "geltung_id",
                unternehmen.toString(), "zeitraum", "2029"), 201);
        lies("entwurf " + naechste.path("kennung").asText(), "/api/v1/berichte/" + naechste.path("kennung").asText()
                + "/entwurf", "IK");
    }

    @AfterAll
    void uhrZurueck() {
        uhr(Clock.systemUTC());
    }

    // ================================================================================ (1) Auffindbar

    /**
     * R3 am 12.02.2029 08:00 — der berichtigte Katalog gegen das Produkt, Gruppe für Gruppe; die zwei Angaben aus
     * {@link #KEIN_NACHWEIS} stehen in der Referenzdatei und im Produkt, aber nicht im Verzeichnis. Zwei leere Gruppen mit dem Satz, keine Zahl über das Ganze, jede Zeile mit Person,
     * Tag und Ort; „in meinem Namen festgehalten“ zeigt Robert Falk seine 11 Zeilen.
     */
    @Test
    void r3DasVerzeichnisGegenDenBerichtigtenKatalogZweiAngabenOhneNachweisMitGrund() {
        Map<String, Integer> produkt = new LinkedHashMap<>();
        r3.path("gruppen").forEach(g -> produkt.put(g.path("gruppe").asText(), g.path("zeilen").size()));
        assertThat(produkt.keySet()).containsExactlyElementsOf(KATALOG_R3.keySet());
        assertThat(produkt).as("Verzeichnis = Katalog R3 (berichtigt)").isEqualTo(KATALOG_R3);
        assertThat(alle(r3)).hasSize(62);
        // Die Orte (G1): in VoltPilot 47, Wortlaut mit Original beim Kunden 2, Verweis 13 (Katalog 49/2/13 ohne die zwei).
        Map<String, Integer> orte = new LinkedHashMap<>();
        alle(r3).forEach(z -> orte.merge(z.path("ort").asText(), 1, Integer::sum));
        assertThat(orte).containsOnly(Map.entry("in_voltpilot", 47), Map.entry("wortlaut_original_beim_kunden", 2),
                Map.entry("verweis", 13));
        // Die zwei Angaben ohne Nachweis — benannt, nicht still weggelassen: in der Referenzdatei „nicht erhoben“ ohne
        // Beleg, im Verzeichnis keine Zeile (Grund je Angabe in KEIN_NACHWEIS).
        List<String> nichtErhoben = new ArrayList<>();
        referenz.path("messmittel_angaben").forEach(a -> {
            if (a.path("pruefungsart").asText().equals("nicht_erhoben") && a.path("beleg").isNull()) {
                nichtErhoben.add(a.path("ziel").asText());
            }
        });
        assertThat(nichtErhoben).containsExactlyInAnyOrderElementsOf(KEIN_NACHWEIS.keySet());
        assertThat(alle(r3)).noneMatch(z -> KEIN_NACHWEIS.containsKey(z.path("kennzeichen").asText()));
        assertThat(KEIN_NACHWEIS.values()).allSatisfy(grund -> assertThat(grund).isNotBlank());
        // Die zwei erreichbaren Messmittel-Angaben: die mit Beleg (GR-2, Z-5b) — „Geführt in Ihrem System“.
        assertThat(alle(r3).stream().filter(z -> z.path("art").asText().equals("messmittel_angabe"))
                .map(z -> z.path("kennzeichen").asText())).containsExactly("GR-2", "Z-5b");
        // Die Kriterien: Nr. 1 ist von Nr. 2 abgelöst und bleibt eine Entscheidung (VZ1, DK4; firstmate 25.09.2026).
        assertThat(alle(r3).stream().filter(z -> z.path("art").asText().equals("kriterien_fassung"))
                .map(z -> z.path("nr").asInt() + " " + z.path("tag").asText() + " " + z.path("eingetragen_von").asText()
                        + " " + z.path("titel").asText())).containsExactlyInAnyOrder(
                "1 2026-11-04 Ines Kaltenbach Kriterien der energetischen Bewertung — abgelöst am 20.11.2026",
                "2 2026-11-20 Ines Kaltenbach Kriterien der energetischen Bewertung");

        // VZ3/G4: zwei leere Gruppen sagen den Satz; keine Zahl über das Ganze, kein Erfüllungsgrad.
        for (String g : List.of("risiken_chancen", "managementbewertung")) {
            assertThat(gruppe(r3, g).path("satz").asText()).isEqualTo(LEER);
        }
        assertThat(felder(r3)).containsExactly("stichtag", "verantwortung", "filter", "gruppen");
        r3.path("gruppen").forEach(g -> {
            assertThat(felder(g)).containsExactly("gruppe", "gruppe_wort", "zuschnitt", "satz", "zeilen");
            assertThat(g.path("satz").isNull() || g.path("satz").asText().equals(LEER)).as(g.path("gruppe").asText())
                    .isTrue();
        });

        // VZ2, G1, G2: jede Zeile mit Person, Tag und Ort.
        assertThat(alle(r3)).allSatisfy(z -> {
            assertThat(z.path("entschieden_von").isNull() && z.path("eingetragen_von").isNull()).as(z.toString())
                    .isFalse();
            assertThat(z.path("tag").asText()).as(z.toString()).isNotBlank();
            assertThat(z.path("ort_satz").asText()).as(z.toString()).isNotBlank();
        });

        // G2, RE3: Robert Falk (Einsicht) sieht die 11 Zeilen in seinem Namen — D-0001, D-0002 und 9 Aufgaben.
        List<JsonNode> rf = alle(r3Rf);
        assertThat(rf).hasSize(11).allSatisfy(z -> assertThat(z.path("entschieden_von").asText())
                .isEqualTo("Robert Falk"));
        assertThat(rf.stream().filter(z -> z.path("art").asText().equals("aufgabe"))).hasSize(9);
    }

    /**
     * Jede Entscheidung von R1–R14 (Invariante 2: Freigabe, Audit-Abschluss, Wirksamkeit, Stand der
     * Managementbewertung) steht im Verzeichnis vom 30.04.2029 mit „entschieden von“, Tag, Fassung oder Nr. und
     * Prüfsumme. Die Aufgaben (R5, R14 B4) tragen „entschieden von“, Tag und Beleg — eine Prüfsumme nur, wenn der
     * Browser eine gebildet hat (G3; die Bestellung der Referenzdatei hat {@code sha256: null}). „Geprüft, bleibt“ und
     * die Beschlüsse sind Einträge ihres Trägers (DK5, MG5): am Dokument und im Stand Nr. 1 mit dessen Prüfsumme.
     */
    @Test
    void jedeEntscheidungVonR1BisR14ImVerzeichnisMitPersonTagNrUndPruefsumme() throws Exception {
        JsonNode v = antwort("verzeichnis 30.04.2029 IK");
        record E(String fall, String art, String kennzeichen, int nr, String entschieden, String tag) { }
        List<E> entscheidungen = List.of(
                new E("R1", "energiepolitik", "D-0001", 1, "Robert Falk", "2026-12-15"),
                new E("R2", "anwendungsbereich", "D-0002", 1, "Robert Falk", "2026-12-15"),
                new E("R3", "rechtliche_anforderungen", "D-0003", 1, "Ines Kaltenbach", "2028-12-05"),
                new E("R7", "betrieb", "D-0004", 1, "Ines Kaltenbach", "2028-11-10"),
                new E("R8", "kompetenz", "D-0005", 1, "Ines Kaltenbach", "2028-01-25"),
                new E("R9", "internes_audit", "AU-2029-0001", 0, "Ines Kaltenbach", "2029-01-31"),
                new E("R11", "wirksamkeit", "F-2029-0001", 1, "Ines Kaltenbach", "2029-04-15"),
                new E("R13", "berichtsstand", "BR-2029-0001", 1, "Robert Falk", "2029-02-12"),
                new E("R14 B3", "energiepolitik", "D-0001", 2, "Robert Falk", "2029-03-20"));
        for (E e : entscheidungen) {
            JsonNode z = alle(v).stream().filter(x -> x.path("art").asText().equals(e.art())
                    && x.path("kennzeichen").asText().equals(e.kennzeichen())
                    && (e.nr() == 0 || x.path("nr").asInt() == e.nr())).findFirst()
                    .orElseThrow(() -> new AssertionError(e + " fehlt im Verzeichnis"));
            String wer = z.path("entschieden_von").isNull() ? z.path("eingetragen_von").asText()
                    : z.path("entschieden_von").asText();
            assertThat(wer).as(e.fall()).isEqualTo(e.entschieden());
            assertThat(z.path("eingetragen_von").asText()).as(e.fall() + " eingetragen von").isNotBlank();
            assertThat(z.path("tag").asText()).as(e.fall()).isEqualTo(e.tag());
            assertThat(e.nr() == 0 || z.path("nr").asInt() == e.nr()).as(e.fall()).isTrue();
            assertThat(z.path("pruefsumme").asText()).as(e.fall() + " Prüfsumme").matches("(sha256:)?[0-9a-f]{64}");
        }
        // Die Prüfsummen sind die der Träger — gelesen, nicht gebildet (VZ1).
        assertThat(zeile(v, "energiepolitik", "D-0001", 1).path("pruefsumme").asText())
                .isEqualTo("sha256:163ae8360abb4f614f4fb4b37a7e983dff1f42e548b7f10c64890fdde68b09bb");
        assertThat(zeile(v, "berichtsstand", "BR-2029-0001", 1).path("pruefsumme").asText()).isEqualTo(pruefsummeNr1);
        assertThat(zeile(v, "wirksamkeit", "F-2029-0001", 1).path("pruefsumme").asText()).isEqualTo(root
                .queryForObject("SELECT pruefsumme FROM feststellung_wirksamkeit WHERE tenant_id = ? AND stand_nr = 1", String.class,
                        tenant));
        assertThat(zeile(v, "internes_audit", "AU-2029-0001", 0).path("pruefsumme").asText())
                .isEqualTo("sha256:27a580b9761668e43f8cdc5afb66a4124f1394cb030a8629c8dc4f82a4d56701");
        // Wo das Original liegt (G1): Wortlaut mit Original beim Kunden, Verweise in seinem System.
        assertThat(zeile(v, "energiepolitik", "D-0001", 1).path("ort_satz").asText())
                .startsWith("Wortlaut in VoltPilot, Original bei Ihnen: QM-Laufwerk");
        assertThat(zeile(v, "kompetenz", "D-0005", 1).path("ort_satz").asText())
                .startsWith("Geführt in Ihrem System: Personalsystem");
        assertThat(zeile(v, "internes_audit", "AU-2029-0001", 0).path("ort_satz").asText())
                .startsWith("Wortlaut in VoltPilot, Original bei Ihnen: QM-Laufwerk, Ordner Energiemanagement/Audits");

        // R5, R14 B4: elf laufende Zuordnungen am 30.04.2029, die zehn mit „entschieden von“ Robert Falk.
        List<JsonNode> aufgaben = alle(v).stream().filter(z -> z.path("art").asText().equals("aufgabe")).toList();
        assertThat(aufgaben).hasSize(11).allSatisfy(z -> assertThat(z.path("tag").asText()).isNotBlank());
        assertThat(aufgaben.stream().filter(z -> "Robert Falk".equals(z.path("entschieden_von").asText()))).hasSize(10);
        JsonNode bezugsbasen = aufgaben.stream().filter(z -> z.path("titel").asText().startsWith("Bezugsbasen"))
                .findFirst().orElseThrow();
        assertThat(bezugsbasen.path("tag").asText()).isEqualTo("2029-03-01");
        assertThat(bezugsbasen.path("eingetragen_von").asText()).isEqualTo("Jonas Wendlinger");
        assertThat(aufgaben).allSatisfy(z -> assertThat(z.path("pruefsumme").isNull()).as("Bestellung ohne sha256")
                .isTrue());

        // R1, R14 B6: „geprüft, bleibt“ ist ein Eintrag am Dokument mit „entschieden von“, Tag und Beschluss (DK5).
        JsonNode d2 = antwort("dokument D-0002");
        List<String> geprueft = new ArrayList<>();
        d2.path("eintraege").forEach(e -> {
            if (e.path("art").asText().equals("geprueft_bleibt")) {
                geprueft.add(e.path("am").asText() + " " + e.at("/entschieden_von/name").asText() + " "
                        + e.path("beschluss_kennung").asText(""));
            }
        });
        assertThat(geprueft).containsExactly("2027-12-10 Robert Falk ", "2029-02-13 Robert Falk BR-2029-0001/B6");
        // R13, R14: die sechs Beschlüsse stehen im Stand Nr. 1 — dessen Prüfsumme trägt sie.
        JsonNode nr1 = antwort("stand BR-2029-0001/1 IK");
        assertThat(nr1.path("pruefsumme").asText()).isEqualTo(pruefsummeNr1);
        assertThat(nr1.at("/abzug/beschluesse")).hasSize(6);
    }

    // ================================================================================ (2) Verantwortungs-Satz

    /**
     * SP4, R4: der Verantwortungs-Satz steht an jedem Leser, der ein Blatt oder eine Seite bildet — Verzeichnis (JSON
     * und CSV-Kopf), Wiedervorlage, Managementbewertung (Stand und PDF) — und auf jeder Energiemanagement-Fläche des
     * Portals, neben dem Grenz-Satz; beide Welten sprechen EINEN Satz.
     */
    @Test
    void verantwortungsSatzAufJederFlaeche() throws Exception {
        assertThat(VERANTWORTUNG).isEqualTo("Inhalte und Entscheidungen Ihres Energiemanagements verantwortet Ihr "
                + "Unternehmen. VoltPilot hält fest, wer was wann entschieden hat, und beurteilt nicht, ob Ihr "
                + "Energiemanagement genügt.");
        for (String wo : List.of("verzeichnis 12.02.2029", "verzeichnis 30.04.2029 IK", "verzeichnis 30.04.2029 RF")) {
            assertThat(antwort(wo).path("verantwortung").asText()).as(wo).isEqualTo(VERANTWORTUNG);
        }
        assertThat(leser.get("verzeichnis csv 12.02.2029")).contains("# " + VERANTWORTUNG + "\r\n");
        for (String wo : List.of("wiedervorlage 12.02.2029", "wiedervorlage 30.04.2029 IK", "wiedervorlage 30.04.2029 RF")) {
            assertThat(antwort(wo).path("verantwortung").asText()).as(wo).isEqualTo(VERANTWORTUNG);
        }
        assertThat(antwort("stand BR-2029-0001/1 RF").at("/abzug/kopf/verantwortung").asText()).isEqualTo(VERANTWORTUNG);
        MockHttpServletResponse pdf = roh("/api/v1/berichte/BR-2029-0001/staende/1/pdf", "RF");
        assertThat(pdf.getStatus()).isEqualTo(200);
        try (PDDocument d = Loader.loadPDF(pdf.getContentAsByteArray())) {
            String text = new PDFTextStripper().getText(d).replace(' ', ' ').replaceAll("\\s+", " ");
            assertThat(text).contains(VERANTWORTUNG);
        }

        // Das Portal: jede Energiemanagement-Fläche (die Liste des Sprach-Wächters in copy.test.ts und jede Datei mit
        // einem Wort des Bereichs im Namen) trägt den Satz aus glossar.ts und den Grenz-Satz.
        Path src = Path.of("../../frontend/portal/src");
        String glossar = Files.readString(src.resolve("glossar.ts"), StandardCharsets.UTF_8);
        assertThat(glossar.replaceAll("'\\s*\\+\\s*'", "")).contains(VERANTWORTUNG);
        List<String> flaechen = energiemanagementFlaechen(src);
        assertThat(flaechen).hasSizeGreaterThanOrEqualTo(18).contains("pages/EnergiemanagementBereich.tsx",
                "components/VerzeichnisTabelle.tsx", "pages/AuditSeite.tsx", "pages/FeststellungSeite.tsx");
        List<String> ohne = new ArrayList<>();
        for (String f : flaechen) {
            String code = Files.readString(src.resolve(f), StandardCharsets.UTF_8);
            if (!code.contains("UEMS_VERANTWORTUNG") && !code.contains(VERANTWORTUNG)) ohne.add(f + " ohne Verantwortungs-Satz");
            if (!code.contains("UEMS_NORMGRENZE") && !code.contains(GRENZ_SATZ)) ohne.add(f + " ohne Grenz-Satz");
        }
        assertThat(ohne).isEmpty();
    }

    // ================================================================================ (3) Kein Vollständigkeits- oder Konformitätswort

    /** SP2 und G4 im Quelltext: die Leser des Energiemanagements und die §5.8-Schablonen (Muster AP-18 IP-22). */
    @Test
    void keinVollstaendigkeitsOderKonformitaetswortImQuelltextDerLeser() throws IOException {
        List<String> funde = new ArrayList<>();
        EnergiemanagementRegeln.SAETZE.forEach((k, v) -> pruefe("SAETZE." + k, v, funde));
        int texte = 0;
        for (String klasse : LESER) {
            Path datei = Path.of("src", "main", "java", "com", "voltpilot", "api", "uems", klasse + ".java");
            for (String text : texte(Files.readString(datei, StandardCharsets.UTF_8))) {
                if (satz(text)) {
                    texte++;
                    pruefe(klasse, text, funde);
                }
            }
        }
        assertThat(texte).as("Sätze in den Lesern").isGreaterThan(150);
        assertThat(funde).as("Satz mit Vollständigkeits- oder Konformitätswort").isEmpty();
    }

    /** SP2 und G4 in den Antworten: jeder Leser der Welt, an seinem Tag, jede Rolle — auch Kopien in Ständen. */
    @Test
    void keinVollstaendigkeitsOderKonformitaetswortInDenAntwortenDerLeser() throws Exception {
        assertThat(leser).hasSizeGreaterThanOrEqualTo(30);
        List<String> funde = new ArrayList<>();
        int saetze = 0;
        for (var e : leser.entrySet()) {
            if (e.getKey().contains("csv") || e.getKey().contains("ics")) {
                for (String zeile : e.getValue().split("\r?\n")) {
                    pruefe(e.getKey(), zeile, funde);
                }
                continue;
            }
            saetze += texte(JSON.readTree(e.getValue()), e.getKey(), funde);
        }
        assertThat(saetze).as("Sätze in den Antworten").isGreaterThan(300);
        assertThat(funde).as("Satz mit Vollständigkeits- oder Konformitätswort").isEmpty();
        // Die Sonde greift: jede verbotene Form wird gefunden, der Grenz-Satz nicht.
        List<String> probe = new ArrayList<>();
        for (String s : List.of("Ihr Energiemanagement ist konform.", "Die Nachweise sind vollständig dokumentiert.",
                "Bereit für das Audit.", "Alle Nachweise liegen vor.", "Erfüllungsgrad 80 %", "nach ISO 50001",
                "Nichtkonformität F-2029-0001", "Ihr Managementsystem", "zertifizierbar", "revisionssicher abgelegt")) {
            List<String> f = new ArrayList<>();
            pruefe("probe", s, f);
            if (f.isEmpty()) probe.add(s);
        }
        assertThat(probe).as("Probe-Sätze, die die Sonde nicht fand").isEmpty();
        List<String> grenz = new ArrayList<>();
        pruefe("grenz", GRENZ_SATZ + " " + VERANTWORTUNG, grenz);
        assertThat(grenz).isEmpty();
    }

    // ================================================================================ (4) Audit → Feststellung → Maßnahme → Wirksamkeit

    /**
     * R9–R11: AU-2029-0001 (Auditorin Claudia Berger, nicht im Energieteam) → Hinweis → M-2029-0002 (Herkunft
     * {@code audit}) und Feststellung F-2029-0001 (festgestellt von Claudia Berger) → M-2029-0001 (Herkunft
     * {@code nichtkonformitaet}, auf der Fläche „Feststellung F-2029-0001“) → umgesetzt am 01.03.2029 → Wirksamkeit Stand
     * Nr. 1 „wirksam“ am 15.04.2029, entschieden von Ines Kaltenbach, mit Begründung, Kopie und Prüfsumme; die Maßnahme
     * selbst bleibt „nicht messbar“ bewertet — ob sie gewirkt hat, sagt eine Person, nie das System.
     */
    @Test
    void auditFeststellungMassnahmeWirksamkeitDurchEinePerson() throws Exception {
        JsonNode a = antwort("audit AU-2029-0001").path("audit");
        assertThat(a.path("kennzeichen").asText()).isEqualTo("AU-2029-0001");
        assertThat(a.path("zustand").asText()).isEqualTo("abgeschlossen");
        assertThat(a.at("/auditoren/0/name").asText()).isEqualTo("Claudia Berger");
        assertThat(a.path("unabhaengigkeit").asText()).contains("gehört nicht zum Energieteam");
        assertThat(a.at("/abschluss/entschieden_von/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(a.at("/abschluss/pruefsumme").asText()).startsWith("sha256:");
        assertThat(texte(a.path("feststellungen"), null)).containsExactly("F-2029-0001");
        JsonNode hinweis = antwort("audit AU-2029-0001").at("/hinweise/0");
        assertThat(hinweis.at("/festgestellt_von/name").asText()).isEqualTo("Claudia Berger");

        JsonNode f = antwort("feststellung F-2029-0001");
        assertThat(f.at("/feststellung/quelle/kennung").asText()).isEqualTo("AU-2029-0001");
        assertThat(f.at("/feststellung/festgestellt_von/name").asText()).isEqualTo("Claudia Berger");
        assertThat(f.at("/feststellung/zustand").asText()).isEqualTo("abgeschlossen");
        assertThat(texte(f.at("/feststellung/massnahmen"), null)).containsExactly("M-2029-0001");
        assertThat(texte(f.path("massnahmen"), "kennzeichen")).containsExactly("M-2029-0001");
        JsonNode stand = f.at("/wirksamkeit/0");
        assertThat(stand.path("nr").asInt()).isEqualTo(1);
        assertThat(stand.path("ergebnis").asText()).isEqualTo("wirksam");
        assertThat(stand.path("am").asText()).isEqualTo("2029-04-15");
        assertThat(stand.at("/entschieden_von/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(stand.path("begruendung").asText()).isNotBlank();
        assertThat(stand.path("pruefsumme").asText()).startsWith("sha256:");
        assertThat(root.queryForObject("SELECT pruefsumme = bericht_pruefsumme(kopie) FROM feststellung_wirksamkeit "
                + "WHERE tenant_id = ? AND stand_nr = 1", Boolean.class, tenant)).isTrue();

        // Die Maßnahme trägt die Feststellung als Herkunft; die Fläche sagt „Feststellung F-…“ (SP5).
        JsonNode m = antwort("massnahme M-2029-0001");
        assertThat(m.at("/herkunft/art").asText()).isEqualTo("nichtkonformitaet");
        assertThat(m.at("/herkunft/kennung").asText()).isEqualTo("F-2029-0001");
        assertThat(m.path("zustand").asText()).isEqualTo("umgesetzt");
        assertThat(m.toString()).doesNotContain("Nichtkonformität");
        assertThat(root.queryForObject("SELECT herkunft_art FROM massnahme WHERE tenant_id = ? AND kennzeichen = "
                + "'M-2029-0002'", String.class, tenant)).isEqualTo("audit");

        // Keine Wirksamkeit ohne Person: die Datenbank kennt keinen Stand ohne „entschieden von“, und der eine Stand
        // der Welt ist der, den Ines Kaltenbach festgehalten hat — kein Läufer schreibt einen (Invariante 4, 5).
        assertThat(root.queryForObject("SELECT is_nullable FROM information_schema.columns WHERE table_name = "
                + "'feststellung_wirksamkeit' AND column_name = 'entschieden_von'", String.class)).isEqualTo("NO");
        assertThat(root.queryForObject("SELECT count(*) FROM feststellung_wirksamkeit WHERE tenant_id = ?",
                Integer.class, tenant)).isEqualTo(1);
    }

    // ================================================================================ (5) Managementbewertung

    /**
     * R13, R14: BR-2029-0001 für 2028 — Sitzung am 12.02.2029 mit Robert Falk als Leitung, sechs Beschlüsse, jeder
     * „entschieden von“ der Leitung, Stand Nr. 1 mit Prüfsumme; die Folgen B1 → EZ-2029-0001, B2 → M-2029-0003, B3 →
     * D-0001 Fassung 2, B4 → Aufgabe „Bezugsbasen“, B5 keine Folge in VoltPilot, B6 → „geprüft, bleibt“; der Stand vom
     * 12.02.2029 bleibt byte-gleich, der Entwurf der nächsten Managementbewertung liest die Folgen von heute.
     */
    @Test
    void managementbewertungMitBeschluessenDerLeitungUndFolgen() throws Exception {
        JsonNode seite = antwort("managementbewertung RF");
        assertThat(seite.at("/sitzung/leitung/name").asText()).isEqualTo("Robert Falk");
        assertThat(seite.at("/sitzung/tag").asText()).isEqualTo("2029-02-12");
        JsonNode b = seite.path("beschluesse");
        assertThat(texte(b, "nr")).containsExactly("1", "2", "3", "4", "5", "6");
        b.forEach(x -> assertThat(x.at("/entschieden_von/name").asText()).isEqualTo("Robert Falk"));
        assertThat(texte(b.at("/0/folgen"), "objekt")).containsExactly("EZ-2029-0001");
        assertThat(texte(b.at("/1/folgen"), "objekt")).containsExactly("M-2029-0003");
        assertThat(texte(b.at("/2/folgen"), "objekt")).containsExactly("D-0001/2");
        assertThat(texte(b.at("/3/folgen"), "art")).containsExactly("aufgabe");
        assertThat(b.at("/4/folgen")).isEmpty();
        assertThat(texte(b.at("/5/folgen"), "objekt")).containsExactly("D-0002");

        // Der Stand vom 12.02.2029: freigegeben 14:10, Prüfsumme — byte-gleich, obwohl F-2029-0001 inzwischen zu ist.
        assertThat(root.queryForObject("SELECT s.abzug FROM bericht_stand s JOIN bericht r ON r.id = s.bericht_id "
                + "WHERE r.tenant_id = ? AND r.kennung = 'BR-2029-0001' AND s.nr = 1", String.class, tenant))
                .isEqualTo(abzugNr1);
        assertThat(root.queryForObject("SELECT count(*) FROM bericht_stand s JOIN bericht r ON r.id = s.bericht_id "
                + "WHERE r.tenant_id = ? AND r.kennung = 'BR-2029-0001'", Integer.class, tenant)).isEqualTo(1);
        JsonNode nr1 = antwort("stand BR-2029-0001/1 RF");
        assertThat(nr1.path("pruefsumme").asText()).isEqualTo(pruefsummeNr1);
        assertThat(nr1.at("/abzug/sitzung/leitung").asText()).isEqualTo("Robert Falk");
        assertThat(nr1.at("/abzug/audits_feststellungen/feststellungen/0/zustand").asText()).isEqualTo("offen");

        // MG6: die nächste Managementbewertung zeigt, was aus den Beschlüssen wurde.
        JsonNode vorige = leser.keySet().stream().filter(k -> k.startsWith("entwurf ")).findFirst()
                .map(this::antwortUnchecked).orElseThrow().at("/abzug/vorige_beschluesse");
        assertThat(vorige.at("/managementbewertung/pruefsumme").asText()).isEqualTo(pruefsummeNr1);
        assertThat(texte(vorige.path("beschluesse"), "entschieden_von")).containsOnly("Robert Falk").hasSize(6);
        assertThat(vorige.at("/beschluesse/4/satz").asText())
                .isEqualTo("Keine Folge in VoltPilot — der Beschluss steht im Stand vom 12.02.2029.");

        // Das Verzeichnis: der Stand in der Gruppe „Managementbewertung“, entschieden von der Leitung, freigegeben von
        // Ines Kaltenbach (G2) — am 12.02.2029 08:00 war die Gruppe noch leer (R3).
        JsonNode z = zeile(antwort("verzeichnis 30.04.2029 RF"), "berichtsstand", "BR-2029-0001", 1);
        assertThat(z.path("gruppe").asText()).isEqualTo("managementbewertung");
        assertThat(z.path("entschieden_von").asText()).isEqualTo("Robert Falk");
        assertThat(z.path("eingetragen_von").asText()).isEqualTo("Ines Kaltenbach");
    }

    // ================================================================================ Welt: Stammdaten

    private void stammdaten() {
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Ahrenberg IP-26') RETURNING id", UUID.class);
        unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name,zeitzone) VALUES (?,"
                + "'Kunststoffwerk Ahrenberg GmbH','Europe/Berlin') RETURNING id", UUID.class, tenant);
        s1 = standort("ST-1", "Werk Ahrenberg");
        s2 = standort("ST-2", "Werk Lindach");
        benutzer("IK", "energiemanager", null);
        benutzer("JW", "kundenadministrator", null);
        benutzer("PH", "bearbeiter", s2);
        benutzer("MD", "bedienberechtigt", s1);
        benutzer("CB", "leser", s1);
        benutzer("RF", "einsicht", null);
        g2 = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, 'gebaeude', "
                + "'Halle 2', 'G-2', 'aktiv') RETURNING id", UUID.class, tenant);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2020-01-01')", tenant, g2, s1);
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-20', 'Spritzguss', 'gemessen', 'Strom', 'Wirkenergie', "
                + "'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, tenant);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, NULL, '2020-01-01')", tenant, ms, g2);
        bz1 = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, "
                + "periode_art, geltung_art, ort_id) VALUES (?, 'BZ-1', 'Produktionsmenge', 'periodenwert', 'kg', "
                + "'monat', 'gebaeude', ?) RETURNING id", UUID.class, tenant, g2);
    }

    // ================================================================================ Welt: bis zum 12.02.2029, 08:00

    private void bis12Februar2029() throws Exception {
        // R5: sechs Personen, zehn Zuordnungen — neun „entschieden von Robert Falk“ (Muster IP-8/IP-10).
        uhr("2026-10-01T10:00:00Z");
        person.put("RF", personAnlegen("Robert Falk", "Geschäftsführer", "RF", "RF", "2026-10-01"));
        person.put("IK", personAnlegen("Ines Kaltenbach", "Energiemanagement", "IK", "IK", "2026-10-01"));
        person.put("JW", personAnlegen("Jonas Wendlinger", "IT-Leitung", "JW", "JW", "2026-10-01"));
        person.put("PH", personAnlegen("Peter Hollerbach", "Standortleiter Werk Lindach", "PH", "PH", "2026-10-15"));
        person.put("MD", personAnlegen("Murat Demirci", "Schichtführer Halle 1", "MD", "MD", "2026-10-01"));
        person.put("CB", personAnlegen("Claudia Berger", "Controlling", "CB", "CB", "2028-12-01"));
        String rf = person.get("RF");
        ruf("POST", BASIS + "/aufgaben", "IK", Map.of("aufgabe", "unternehmensleitung", "person_id", rf,
                "gilt_ab", "2026-10-01", "begruendung", "Geschäftsführer laut Handelsregister"), 201);
        ruf("POST", BASIS + "/aufgaben", "IK", entschieden("energiemanagement_leiten", "IK", "2026-10-01",
                person.get("JW")), 201);
        for (String k : List.of("IK", "MD")) {
            ruf("POST", BASIS + "/aufgaben", "IK", entschieden("energieteam", k, "2026-10-01", null), 201);
        }
        ruf("POST", BASIS + "/aufgaben", "IK", entschieden("energieteam", "PH", "2026-10-15", null), 201);
        for (String a : List.of("energieziele_massnahmen", "bewertung_messplanung", "dokumente", "managementbewertung")) {
            ruf("POST", BASIS + "/aufgaben", "IK", entschieden(a, "IK", "2026-10-01", null), 201);
        }
        Map<String, Object> auditAufgabe = entschieden("interne_audits", "CB", "2028-12-01", null);
        auditAufgabe.remove("beleg");
        ruf("POST", BASIS + "/aufgaben", "IK", auditAufgabe, 201);

        // AP-16: Betrachtungsumfang, Kriterien Nr. 1 und Nr. 2, acht Einsätze mit zwölf Einstufungs-Fassungen, MB-1,
        // die Messmittel-Angaben GR-2 und Z-5b mit Beleg, GR-5 „nicht erhoben“.
        umfang();
        kriterien(1, "2026-11-04", null);
        kriterien(2, "2026-11-20", "Schwellen nach der ersten Rangliste nachgeschärft.");
        einsaetzeUndEinstufungen();
        root.update("INSERT INTO messbedarf (tenant_id, kennzeichen, einsatz_id, wortlaut, frist, actor_sub, actor_name, "
                + "actor_art, created_at) VALUES (?, 'MB-1', ?, 'Lüftung, Beleuchtung und Allgemeinstrom Halle 1', "
                + "'2027-03-31', 'IK', 'Ines Kaltenbach', 'kunde', '2026-11-27T09:00:00Z')", tenant, einsatz.get("EE-8"));
        messmittel();

        // R1, R2: D-0001 und D-0002 am 15.12.2026, entschieden von Robert Falk; bekannt gemacht am 18.12.2026.
        uhr("2026-12-15T10:00:00Z");
        String d1 = dokumentAnlegen("D-0001", "energiepolitik", "Energiepolitik", ORIGINAL, unternehmenBezug());
        fassung(d1, Map.of("form", "wortlaut", "wortlaut", kopien.get("D-0001").at("/eingang/kopie/wortlaut").asText()));
        freigeben(d1, 1, "RF");
        String d2 = dokumentAnlegen("D-0002", "anwendungsbereich", "Anwendungsbereich des Energiemanagements", null,
                unternehmenBezug());
        fassung(d2, Map.of("form", "wortlaut", "wortlaut", kopien.get("D-0002").at("/eingang/kopie/wortlaut").asText(),
                "anwendungsbereich", Map.of("standort_ids", List.of(s1.toString(), s2.toString()),
                        "traeger", List.of("Strom", "Gas"), "ausschluesse", List.of())));
        freigeben(d2, 1, "RF");
        uhr("2026-12-18T10:00:00Z");
        for (String weg : List.of("aushang", "intranet")) {
            ruf("POST", BASIS + "/dokumente/" + d1 + "/bekanntmachungen", "IK",
                    Map.of("kreis", "alle Mitarbeitenden beider Werke", "weg", weg), 201);
        }
        uhr("2027-12-10T10:00:00Z");
        for (String d : List.of(d1, d2)) {
            ruf("POST", BASIS + "/dokumente/" + d + "/geprueft", "IK", Map.of("entschieden_von", rf, "am",
                    "2027-12-10", "begruendung", "Mit der Jahresplanung 2028 durchgesehen; gilt unverändert."), 200);
        }

        // AP-11, AP-17, AP-12, AP-18: sechs Kennzahlen, fünf Bezugsbasen mit acht Fassungen, Berichtsstände, die
        // Bewertungen und Abschlüsse der Referenzdatei 1.9 (Muster IP-8, IP-22).
        leistung();

        // D-0003 … D-0005 nach der Referenzdatei nummeriert (Anlage-Reihenfolge), freigegeben an ihren Tagen.
        uhr("2028-01-25T09:00:00Z");
        String d3 = dokumentAnlegen("D-0003", "rechtliche_anforderungen", "Rechtskataster", null, unternehmenBezug());
        String d4 = dokumentAnlegen("D-0004", "betrieb", "Kriterien für Betrieb und Instandhaltung — Spritzguss", null,
                Map.of("art", "energieeinsatz", "energieeinsatz_id", einsatz.get("EE-1").toString()));
        String d5 = dokumentAnlegen("D-0005", "kompetenz", "Unterweisung Zeitschaltung Werkzeugheizungen",
                null, Map.of("art", "person", "person_id", person.get("MD")));
        // R8: die Unterweisung von Murat Demirci am 25.01.2028 als Verweis auf das Personalsystem, ohne Überprüfung.
        uhr("2028-01-25T10:00:00Z");
        fassung(d5, Map.of("form", "verweis", "verweis", UNTERWEISUNG));
        freigeben(d5, 1, "IK");
        // R7: D-0004 am Einsatz EE-1 — Verweis auf den Arbeitsplan IH-SG-01 im Instandhaltungssystem.
        uhr("2028-11-10T10:00:00Z");
        fassung(d4, Map.of("form", "verweis", "verweis", JSON.convertValue(kopien.get("D-0004")
                .at("/eingang/kopie/verweis"), Map.class)));
        freigeben(d4, 1, "IK");
        uhr("2028-11-12T10:00:00Z");
        ruf("POST", BASIS + "/dokumente/" + d4 + "/bekanntmachungen", "IK",
                Map.of("kreis", "Schichtführer und Instandhaltung", "weg", "besprechung"), 201);
        // D-0003 Rechtliche Anforderungen am 05.12.2028 als Verweis auf den Rechtskataster-Dienst.
        uhr("2028-12-05T10:00:00Z");
        Map<String, Object> kataster = new LinkedHashMap<>(JSON.convertValue(kopien.get("D-0004")
                .at("/eingang/kopie/verweis"), Map.class));
        kataster.put("ablage", "Rechtskataster-Dienst");
        kataster.put("kennung", "RK-2028");
        fassung(d3, Map.of("form", "verweis", "verweis", kataster));
        freigeben(d3, 1, "IK");

        // R9, R10: AU-2029-0001 am 22.01.2029 mit Hinweis und Feststellung F-2029-0001; M-2029-0001/-0002; Abschluss
        // am 31.01.2029 mit dem unterschriebenen Bericht als Verweis.
        uhr("2029-01-10T09:00:00Z");
        Map<String, Object> a = new LinkedHashMap<>();
        a.put("titel", "Internes Audit 2029: Bezugsbasen, Energieziele, Maßnahmen und Grundlagen");
        a.put("termin", "2029-01-22");
        a.put("auditor_ids", List.of(person.get("CB")));
        a.put("unabhaengigkeit", "Claudia Berger (Controlling) gehört nicht zum Energieteam und prüft keine eigene Arbeit.");
        a.put("was", "Bezugsbasen, Energieziel, Maßnahmen und Grundlagen");
        a.put("woran", "Energiepolitik D-0001 Fassung 1, Anwendungsbereich D-0002, Aufgaben im Energiemanagement");
        a.put("verantwortlich", "IK");
        audit = ruf("POST", BASIS + "/audits", "IK", a, 201).at("/audit/id").asText();
        uhr("2029-01-22T15:00:00Z");
        ruf("POST", BASIS + "/audits/" + audit + "/durchgefuehrt", "IK", Map.of("am", "2029-01-22"), 200);
        ruf("POST", BASIS + "/audits/" + audit + "/hinweise", "IK", Map.of("wortlaut", "Die Energiepolitik wurde im "
                + "Dezember 2026 bekannt gemacht; wer seitdem eingestellt wurde, lernt sie in der Einarbeitung nicht "
                + "kennen.", "festgestellt_von", person.get("CB")), 201);
        uhr("2029-01-23T10:00:00Z");
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("quelle", Map.of("art", "internes_audit", "audit_id", audit));
        f.put("wortlaut", "Wer die Bezugsbasen pflegt und freigibt und wer vertritt, ist nicht festgelegt.");
        f.put("vorgabe", Map.of("wortlaut", "„Wir legen fest, wer im Energiemanagement wofür zuständig ist.“"));
        f.put("festgestellt_von", person.get("CB"));
        f.put("festgestellt_am", "2029-01-22");
        f.put("verantwortlich", "JW");
        feststellung = ruf("POST", BASIS + "/feststellungen", "IK", f, 201).at("/feststellung/id").asText();
        uhr("2029-01-26T10:00:00Z");
        massnahme("Aufgabe „Bezugsbasen pflegen und freigeben“ festlegen und über die zweite Prüfung entscheiden", "JW",
                "2029-02-28", "nichtkonformitaet", "F-2029-0001");
        massnahme("Hinweis aus dem internen Audit: Bekanntmachung der Energiepolitik im Werk Lindach wiederholen", "IK",
                "2029-06-30", "audit", "AU-2029-0001");
        uhr("2029-01-31T15:00:00Z");
        ruf("POST", BASIS + "/audits/" + audit + "/abschliessen", "IK", Map.of("entschieden_von", person.get("IK"),
                "am", "2029-01-31", "bericht", AUDITBERICHT, "zusammenfassung", "Ein Hinweis, eine Feststellung; Bericht "
                + "unterschrieben von Claudia Berger am 30.01.2029.", "massnahmen", List.of(Map.of("hinweis", 1,
                "massnahme", "M-2029-0002"))), 200);
    }

    /** AP-11/12/16/17/18 der Referenzdatei 1.9 — nur, was das Verzeichnis und die Managementbewertung lesen. */
    private void leistung() throws Exception {
        String[][] kz = {{"KZ-0004", "Stromeinsatz Spritzguss je kg"}, {"KZ-0001", "Stromeinsatz Montage je Stück"},
            {"KZ-0005", "Netzbezug je m²"}, {"KZ-0006", "Gasbezug Verwaltung je Gradtag"},
            {"KZ-0002", "Stromeinsatz Montage Lindach"}, {"KZ-0003", "Stromeinsatz Montage je Stück — Unternehmen"}};
        uhr("2026-11-01T10:00:00Z");
        Map<String, UUID> basis = new LinkedHashMap<>();
        Map<String, UUID> kennzahl = new LinkedHashMap<>();
        for (String[] k : kz) {
            UUID id = kennzahlAnlegen(k[0], k[1]);
            kennzahl.put(k[0], id);
            if (k[0].equals("KZ-0003")) continue;
            JsonNode b = ruf("POST", "/api/v1/kennzahlen/" + id + "/bezugsbasen", "IK", null, 201);
            basis.put(b.path("kennzeichen").asText(), UUID.fromString(b.path("id").asText()));
        }
        bezugsbasisFassung(basis.get("BB-0001"), 1, "2026-11-01", "2027-10-31", "2026-11-02T10:00:00Z");
        bezugsbasisFassung(basis.get("BB-0001"), 2, "2027-11-01", null, "2027-11-25T10:00:00Z");
        bezugsbasisFassung(basis.get("BB-0002"), 1, "2026-11-01", "2026-11-30", "2026-11-02T10:00:00Z");
        bezugsbasisFassung(basis.get("BB-0002"), 2, "2026-12-01", null, "2026-11-13T10:00:00Z");
        bezugsbasisFassung(basis.get("BB-0003"), 1, "2026-11-01", "2027-02-28", "2026-11-02T10:00:00Z");
        bezugsbasisFassung(basis.get("BB-0003"), 2, "2027-03-01", null, "2027-03-05T10:00:00Z");
        bezugsbasisFassung(basis.get("BB-0004"), 1, "2027-11-01", null, "2027-11-24T10:00:00Z");
        bezugsbasisFassung(basis.get("BB-0005"), 1, "2026-11-01", null, "2026-11-20T10:00:00Z");

        // AP-12: BR-2026-0001 (Monatsbericht, Nr. 1 und Nr. 2); AP-16 S5: zwei energetische Bewertungen mit drei
        // Ständen; AP-17: der Leistungsvergleich mit seinem Stand (Code-Kennung BR-, Datei-Kennung BW-/VB-, W11).
        root.update("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, geltung_art, standort_id, "
                + "zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_name) VALUES (?, 'BR-2026-0001', "
                + "'monatsbericht_standort', 1, 'standort', ?, 'monat', '2026-10', 'Europe/Berlin', 'Ines Kaltenbach')",
                tenant, s1);
        UUID monat = root.queryForObject("SELECT id FROM bericht WHERE tenant_id = ? AND kennung = 'BR-2026-0001'",
                UUID.class, tenant);
        stand(monat, 1, "2026-11-05T10:00:00Z", null);
        stand(monat, 2, "2026-12-20T10:00:00Z", null);
        UUID bw1 = bericht("BR-2026-0002", "energetische_bewertung", "datengrundlage", "2026-10", null);
        stand(bw1, 1, "2026-11-24T10:00:00Z", null);
        stand(bw1, 2, "2027-02-10T10:00:00Z", null);
        UUID bw2 = bericht("BR-2027-0001", "energetische_bewertung", "datengrundlage", "2027-10", null);
        stand(bw2, 1, "2027-11-24T10:00:00Z", null);
        UUID vb = bericht("BR-2028-0001", "leistungsvergleich", "monat", "2027-12", kennzahl.get("KZ-0004"));
        JsonNode urteil = referenz.at("/massnahmen/0/ausgangslage/kopie");
        stand(vb, 1, "2028-01-20T10:00:00Z", "{\"kopf\":{\"bericht\":\"BR-2028-0001\"},\"urteil\":{\"delta_prozent\":"
                + urteil.path("delta_prozent").asText() + ",\"urteil\":\"" + urteil.path("urteil").asText() + "\"}}");

        // AP-18 (Muster IP-22): EZ-2028-0001 verfehlt, M-2028-0001 belegt, M-2028-0002 nicht messbar, AW-2026-0001
        // und AW-2028-0001 abgeschlossen.
        UUID kz4 = kennzahl.get("KZ-0004");
        UUID bb1 = basis.get("BB-0001");
        JsonNode ez = referenz.at("/energieziele/0");
        UUID ezId = root.queryForObject("INSERT INTO energieziel (tenant_id, kennzeichen, kennzahl_id, bezugsbasis_id, "
                + "fassung, zielwert_prozent, zielperiode, wortlaut, begruendung, verantwortlich_sub, verantwortlich_name, "
                + "verantwortlich_konto, standort_id, actor_sub, actor_name, actor_rolle, actor_art, angelegt_am) VALUES "
                + "(?, 'EZ-2028-0001', ?, ?, 2, -5.0, '2028-01/2028-12', ?, ?, 'IK', 'Ines Kaltenbach', 'benutzer', ?, "
                + "'IK', 'Ines Kaltenbach', 'energiemanager', 'kunde', '2027-12-20T09:00:00Z') RETURNING id", UUID.class,
                tenant, kz4, bb1, ez.path("wortlaut").asText(), ez.path("begruendung").asText(), s1);
        root.update("UPDATE energieziel SET zustand = 'bewertet', ergebnis = 'verfehlt', bewertung_status = 'bewertet', "
                + "bewertung_begruendung = ?, bewertung_kopie = ?, bewertung_pruefsumme = ?, freigabe_sub = 'IK', "
                + "freigabe_name = 'Ines Kaltenbach', freigabe_rolle = 'energiemanager', freigabe_art = 'kunde', "
                + "freigabe_am = '2029-01-15T09:00:00Z' WHERE id = ?", ez.at("/bewertung/begruendung").asText(),
                BerichtRegeln.kanonisch(ez.at("/bewertung/kopie")), ez.at("/bewertung/pruefsumme").asText(), ezId);
        JsonNode m1 = referenz.at("/massnahmen/0");
        UUID m1Id = massnahmeDirekt("M-2028-0001", m1, "abweichung", "AW-2028-0001", kz4, bb1,
                BerichtRegeln.kanonisch(m1.at("/ausgangslage/kopie")), "2028-01-15T09:00:00Z", "2028-01-22");
        bewertungDirekt(m1Id, m1.at("/bewertungen/0"), kz4, bb1, "2028-11-15T10:00:00Z");
        JsonNode m2 = referenz.at("/massnahmen/1");
        UUID m2Id = massnahmeDirekt("M-2028-0002", m2, "von_hand", null, null, null, null, "2028-01-20T09:00:00Z",
                "2028-03-28");
        bewertungDirekt(m2Id, m2.at("/bewertungen/0"), null, null, "2028-11-20T10:00:00Z");
        for (JsonNode aw : referenz.path("abweichungen")) {
            String k = aw.path("kennzeichen").asText();
            boolean mitMassnahme = k.equals("AW-2028-0001");
            UUID awId = root.queryForObject("INSERT INTO abweichung (tenant_id, kennzeichen, kennzahl_id, bezugsbasis_id, "
                    + "fassung, monate, herkunft_art, anlass, anlass_pruefsumme, verantwortlich_sub, verantwortlich_name, "
                    + "verantwortlich_konto, frist, actor_sub, actor_name, actor_art, eroeffnet_am) VALUES (?, ?, ?, ?, ?, "
                    + "?::text[], 'auffaelligkeit', ?, ?, 'IK', 'Ines Kaltenbach', 'benutzer', ?::date, 'IK', "
                    + "'Ines Kaltenbach', 'kunde', ?::timestamptz) RETURNING id", UUID.class, tenant, k, kz4, bb1, mitMassnahme ? 2 : 1,
                    "{" + String.join(",", texte(aw.path("monate"), null)) + "}",
                    BerichtRegeln.kanonisch(aw.path("anlass")), aw.path("pruefsumme").asText(), aw.path("frist").asText(),
                    aw.at("/eroeffnet/am").asText() + "T09:00:00Z");
            String am = aw.at("/abschluss/am").asText() + "T10:00:00Z";
            root.update("UPDATE abweichung SET zustand = 'abgeschlossen', ergebnis = ?, massnahme_id = ?, "
                    + "abschluss_begruendung = ?, abgeschlossen_am = ?::timestamptz, abgeschlossen_sub = 'IK', "
                    + "abgeschlossen_name = 'Ines Kaltenbach', abgeschlossen_rolle = 'energiemanager', "
                    + "abgeschlossen_art = 'kunde' WHERE id = ?", aw.at("/abschluss/ergebnis").asText(),
                    mitMassnahme ? m1Id : null, aw.at("/abschluss/begruendung").asText("Erklärt."), am, awId);
        }
    }

    // ================================================================================ Welt: Managementbewertung und Folgen

    private void managementbewertungUndFolgen() throws Exception {
        JsonNode rmb = referenz.at("/managementbewertungen/0");
        uhr("2029-02-12T13:00:00Z");
        ruf("POST", "/api/v1/berichte", "IK", Map.of("vorlage", "managementbewertung", "geltung_id",
                unternehmen.toString(), "zeitraum", "2028"), 201);
        Map<String, Object> sitzung = new LinkedHashMap<>();
        sitzung.put("tag", rmb.at("/sitzung/tag").asText());
        sitzung.put("leitung", person.get("RF"));
        List<String> teilnehmende = new ArrayList<>();
        rmb.at("/sitzung/teilnehmende").forEach(t -> teilnehmende.add(person.get(t.asText())));
        sitzung.put("teilnehmende", teilnehmende);
        sitzung.put("ort", rmb.at("/sitzung/ort").asText());
        ruf("PUT", MB + "/sitzung", "IK", sitzung, 200);
        for (JsonNode b : rmb.path("beschluesse")) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("art", b.path("art").asText());
            m.put("wortlaut", b.path("wortlaut").asText());
            m.put("zustaendig", person.get(b.path("zustaendig").asText()));
            if (b.hasNonNull("termin")) m.put("termin", b.path("termin").asText());
            ruf("POST", MB + "/beschluesse", "IK", m, 201);
        }
        String datenstand = ruf("/api/v1/berichte/BR-2029-0001/entwurf", "IK", 200).path("datenstand").asText();
        uhr("2029-02-12T13:10:00Z");
        ruf("POST", "/api/v1/berichte/BR-2029-0001/freigeben", "IK", Map.of("entwurf_datenstand", datenstand), 201);
        abzugNr1 = root.queryForObject("SELECT s.abzug FROM bericht_stand s JOIN bericht r ON r.id = s.bericht_id "
                + "WHERE r.tenant_id = ? AND r.kennung = 'BR-2029-0001' AND s.nr = 1", String.class, tenant);
        pruefsummeNr1 = root.queryForObject("SELECT s.pruefsumme FROM bericht_stand s JOIN bericht r "
                + "ON r.id = s.bericht_id WHERE r.tenant_id = ? AND r.kennung = 'BR-2029-0001' AND s.nr = 1",
                String.class, tenant);

        // B6 13.02.2029: „geprüft, bleibt“ an D-0002 mit dem Beschluss.
        uhr("2029-02-13T10:00:00Z");
        ruf("POST", BASIS + "/dokumente/" + dokument.get("D-0002") + "/geprueft", "IK", Map.of("entschieden_von",
                person.get("RF"), "am", "2029-02-13", "begruendung", "Beschluss B6 der Managementbewertung 2028: bleibt "
                + "unverändert.", "beschluss_kennung", "BR-2029-0001/B6"), 200);
        // B2 14.02.2029: M-2029-0003 mit Herkunft `managementbewertung`.
        uhr("2029-02-14T10:00:00Z");
        massnahme("Druckluft: Leckagen jährlich orten, 2029 im zweiten Quartal", "IK", "2029-06-30",
                "managementbewertung", "BR-2029-0001/B2");
        // B1 15.02.2029: EZ-2029-0001 ab März (ein Energieziel beginnt nicht rückwirkend), von Hand verknüpft.
        uhr("2029-02-15T10:00:00Z");
        root.update("INSERT INTO energieziel (tenant_id, kennzeichen, kennzahl_id, bezugsbasis_id, fassung, "
                + "zielwert_prozent, zielperiode, wortlaut, begruendung, verantwortlich_sub, verantwortlich_name, "
                + "verantwortlich_konto, standort_id, actor_sub, actor_name, actor_rolle, actor_art, angelegt_am) "
                + "SELECT tenant_id, 'EZ-2029-0001', kennzahl_id, bezugsbasis_id, fassung, -4.0, '2029-03/2029-12', "
                + "'Energieziel 2029 für den Spritzguss: 4 % weniger Strom, als die Bezugsbasis erwarten lässt.', "
                + "'Beschluss B1 der Managementbewertung vom 12.02.2029 (BR-2029-0001).', verantwortlich_sub, "
                + "verantwortlich_name, verantwortlich_konto, standort_id, actor_sub, actor_name, actor_rolle, actor_art, "
                + "'2029-02-15T09:00:00Z' FROM energieziel WHERE tenant_id = ? AND kennzeichen = 'EZ-2028-0001'", tenant);
        ruf("POST", MB + "/beschluesse/1/folgen", "IK", Map.of("art", "energieziel", "objekt", "EZ-2029-0001"), 201);
        // B4 26.02.2029: die Aufgabe „Bezugsbasen“ ab 01.03.2029, eingetragen von Jonas Wendlinger.
        uhr("2029-02-26T10:00:00Z");
        ruf("POST", BASIS + "/aufgaben", "JW", new LinkedHashMap<>(Map.of("aufgabe", "bezugsbasen", "person_id",
                person.get("IK"), "gilt_ab", "2029-03-01", "vertretung_person_id", person.get("JW"), "entschieden_von",
                person.get("RF"), "begruendung", "Beschluss B4 der Managementbewertung 2028", "beschluss_kennung",
                "BR-2029-0001/B4")), 201);
        // R11 01.03.2029: M-2029-0001 umgesetzt.
        uhr("2029-03-01T10:00:00Z");
        ruf("POST", "/api/v1/massnahmen/" + id("massnahme", "M-2029-0001") + "/umgesetzt", "JW", Map.of("am",
                "2029-03-01", "begruendung", "Aufgabe seit 01.03.2029 Ines Kaltenbach, Vertretung Jonas Wendlinger "
                + "(Beschluss B4)."), 200);
        // B3 10.03./20.03.2029: D-0001 Fassung 2, entschieden von Robert Falk.
        uhr("2029-03-10T10:00:00Z");
        fassung(dokument.get("D-0001"), Map.of("form", "wortlaut", "wortlaut", "Energiepolitik, ergänzt um Einkauf und "
                + "Planung.", "begruendung", "Beschluss B3 der Managementbewertung 2028", "beschluss_kennung",
                "BR-2029-0001/B3"));
        uhr("2029-03-20T10:00:00Z");
        freigeben(dokument.get("D-0001"), 2, "RF");
        // R11 15.04.2029: Wirksamkeit Stand Nr. 1 „wirksam“ — eine Person sagt es.
        uhr("2029-04-15T10:00:00Z");
        ruf("POST", BASIS + "/feststellungen/" + feststellung + "/wirksamkeit", "IK", Map.of("ergebnis", "wirksam",
                "begruendung", "Aufgabe seit 01.03.2029 festgelegt (Ines Kaltenbach, Vertretung Jonas Wendlinger); die "
                + "Freigaben seit März nennen die zuständige Person.", "entschieden_von", person.get("IK")), 201);
    }

    // ================================================================================ Welt: Helfer

    private Map<String, Object> entschieden(String aufgabe, String wer, String ab, String vertretung) {
        Map<String, Object> a = new LinkedHashMap<>(Map.of("aufgabe", aufgabe, "person_id", person.get(wer),
                "gilt_ab", ab, "entschieden_von", person.get("RF"), "begruendung", "Bestellung vom 28.09.2026",
                "beleg", BESTELLUNG));
        if (vertretung != null) a.put("vertretung_person_id", vertretung);
        return a;
    }

    private String personAnlegen(String name, String funktion, String kuerzel, String konto, String seit)
            throws Exception {
        Map<String, Object> b = new LinkedHashMap<>(Map.of("name", name, "funktion", funktion, "kuerzel", kuerzel,
                "seit", seit, "konto_sub", konto));
        JsonNode p = ruf("POST", BASIS + "/personen", "IK", b, 201);
        return p.has("verlauf") ? p.at("/person/id").asText() : p.path("id").asText();
    }

    private static Map<String, Object> unternehmenBezug() {
        return Map.of("art", "unternehmen");
    }

    private String dokumentAnlegen(String kennzeichen, String art, String titel, Map<String, Object> beleg,
            Map<String, Object> bezug) throws Exception {
        Map<String, Object> b = new LinkedHashMap<>(Map.of("art", art, "titel", titel, "bezug", bezug));
        if (beleg != null) b.put("beleg", beleg);
        JsonNode d = ruf("POST", BASIS + "/dokumente", "IK", b, 201);
        assertThat(d.path("kennzeichen").asText()).isEqualTo(kennzeichen);
        dokument.put(kennzeichen, d.path("id").asText());
        return d.path("id").asText();
    }

    private void fassung(String dokument, Map<String, Object> fassung) throws Exception {
        ruf("POST", BASIS + "/dokumente/" + dokument + "/fassungen", "IK", fassung, 201);
    }

    private void freigeben(String dokument, int nr, String von) throws Exception {
        ruf("POST", BASIS + "/dokumente/" + dokument + "/fassungen/" + nr + "/freigeben", "IK", Map.of("entschieden_von",
                person.get(von), "begruendung", BEGRUENDUNG), 200);
    }

    private void massnahme(String titel, String verantwortlich, String termin, String herkunft, String kennung)
            throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("titel", titel);
        m.put("verantwortlich", verantwortlich);
        m.put("termin", termin);
        m.put("herkunft", herkunft);
        m.put("herkunft_kennung", kennung);
        m.put("erwartete_wirkung_wortlaut", "Zuständigkeit festgelegt; jede Freigabe nennt die zuständige Person.");
        ruf("POST", "/api/v1/massnahmen", "IK", m, 201);
    }

    /** AP-16 U1: der Betrachtungsumfang Fassung 1 ab 04.11.2026 an beiden Werken (Muster IP-8). */
    private void umfang() {
        UUID u = root.queryForObject("INSERT INTO bewertung_umfang (tenant_id, unternehmen_id, fassung, gueltig_ab, "
                + "traeger, begruendung, actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, 1, '2026-11-04', "
                + "'{Strom,Gas}'::text[], 'Erster Betrachtungsumfang der energetischen Bewertung.', 'IK', "
                + "'Ines Kaltenbach', 'energiemanager', 'kunde') RETURNING id", UUID.class, tenant, unternehmen);
        for (UUID s : List.of(s1, s2)) {
            root.update("INSERT INTO bewertung_umfang_standort (tenant_id, umfang_id, standort_id) VALUES (?, ?, ?)",
                    tenant, u, s);
        }
    }

    /** AP-16 K: eine freigegebene Kriterien-Fassung ohne Vier-Augen; die neue hebt die vorige auf wie der Dienst. */
    private void kriterien(int fassung, String ab, String begruendung) {
        JsonNode k = referenz.path("bewertung_kriterien").get(fassung - 1);
        root.update("UPDATE bewertung_kriterien_fassung SET aufgehoben_am = ?::timestamptz WHERE tenant_id = ? "
                + "AND freigabe_status = 'freigegeben' AND aufgehoben_am IS NULL", ab + "T10:00:00Z", tenant);
        root.update("INSERT INTO bewertung_kriterien_fassung (tenant_id, unternehmen_id, fassung, werte, kriterien, "
                + "gueltig_ab, begruendung, actor_sub, actor_name, actor_rolle, actor_art, vieraugen, freigabe_status, "
                + "created_at) VALUES (?, ?, ?, '{}'::jsonb, ?::jsonb, ?::date, ?, 'IK', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde', false, 'freigegeben', ?::timestamptz)", tenant, unternehmen, fassung,
                k.path("kriterien").toString(), ab, begruendung, ab + "T10:00:00Z");
    }

    /** AP-16 E: die acht Einsätze der Referenzdatei und ihre zwölf freigegebenen Einstufungs-Fassungen. */
    private void einsaetzeUndEinstufungen() {
        for (JsonNode e : referenz.path("energieeinsaetze")) {
            String k = e.path("kennzeichen").asText();
            UUID prozess = root.queryForObject("INSERT INTO prozess (tenant_id, unternehmen_id, kennzeichen, name, "
                    + "gueltig_ab) VALUES (?, ?, ?, ?, '2024-01-01') RETURNING id", UUID.class, tenant, unternehmen,
                    "P-" + k.substring(3), e.path("name").asText());
            einsatz.put(k, root.queryForObject("INSERT INTO energieeinsatz (tenant_id, kennzeichen, prozess_id, traeger, "
                    + "name, gueltig_ab, actor_sub, actor_name, actor_art) VALUES (?, ?, ?, ?, ?, '2026-10-01', 'IK', "
                    + "'Ines Kaltenbach', 'kunde') RETURNING id", UUID.class, tenant, k, prozess,
                    e.path("traeger").asText(), e.path("name").asText()));
        }
        for (JsonNode e : referenz.path("einstufungen")) {
            for (JsonNode f : e.path("fassungen")) {
                root.update("INSERT INTO energieeinsatz_einstufung (tenant_id, einsatz_id, nummer, einstufung, "
                        + "begruendung, herkunft, grund, vorgeschlagen_ab, gueltig_ab, gueltig_bis, rueckwirkend, "
                        + "actor_sub, actor_name, actor_rolle, actor_art, vieraugen, freigabe_status) VALUES (?, ?, ?, ?, "
                        + "?, '{}'::jsonb, ?::jsonb, ?::date, ?::date, ?::date, false, 'IK', 'Ines Kaltenbach', "
                        + "'energiemanager', 'kunde', false, 'freigegeben')", tenant,
                        einsatz.get(e.path("einsatz").asText()), f.path("fassung").asInt(), f.path("einstufung").asText(),
                        f.path("begruendung").asText("Einstufung der Referenzdatei."), f.path("grund").toString(),
                        f.path("gueltig_ab").asText(), f.path("gueltig_ab").asText(),
                        f.hasNonNull("gueltig_bis") ? f.path("gueltig_bis").asText() : null);
            }
        }
    }

    /** AP-16 M: GR-2 und Z-5b mit Beleg über die Route, GR-5 „nicht erhoben“ — der Wandler K-8.2 hat keine Zeile. */
    private void messmittel() throws Exception {
        UUID an1 = root.queryForObject("INSERT INTO site(tenant_id,name) VALUES (?, 'AN-1') RETURNING id", UUID.class,
                tenant);
        root.update("INSERT INTO anlage_standort(tenant_id,site_id,standort_id,gueltig_ab) VALUES (?,?,?,'2024-01-01')",
                tenant, an1, s1);
        UUID gr2 = geraet(an1, "GR-2", "GR-2");
        UUID z5b = geraet(an1, "GR-4", "Z-5b");
        UUID gr5 = geraet(an1, "GR-5", "GR-5");
        ruf("PUT", "/api/v1/geraete/" + gr2 + "/messmittel", "IK", Map.of("pruefungsart", "eichung", "beleg",
                Map.of("bezeichnung", "Zählerstandsmitteilung 10/2026, Netzgesellschaft Ahrental", "ablage",
                        "beim Kunden (Netzrechnung)", "sha256", SHA_GR2)), 200);
        ruf("PUT", "/api/v1/geraete/" + z5b + "/messmittel", "IK", Map.of("genauigkeitsklasse", "1", "beleg",
                Map.of("bezeichnung", "Werksprüfprotokoll Seriennr. 88231", "ablage", "beim Kunden", "sha256", SHA_Z5B)),
                200);
        // „nicht erhoben“ ist der leere Stand — ein PUT ohne Angabe ändert nichts und schreibt keine Person.
        JsonNode leer = ruf("/api/v1/geraete/" + gr5 + "/messmittel", "IK", 200);
        assertThat(leer.path("beleg").isNull()).isTrue();
        assertThat(leer.path("pruefungsart").asText()).isEqualTo("nicht_erhoben");
        root.update("UPDATE geraet SET beleg_am = '2026-11-28T08:00:00Z' WHERE tenant_id = ? AND beleg_am IS NOT NULL",
                tenant);
    }

    private UUID geraet(UUID site, String kennzeichen, String einbau) {
        return root.queryForObject("INSERT INTO geraet(tenant_id,site_id,kennzeichen,einbau_kennzeichen,geraeteart,"
                + "eingebaut_am) VALUES (?,?,?,?,'zaehler','2024-01-01T00:00:00Z') RETURNING id", UUID.class, tenant,
                site, kennzeichen, einbau);
    }

    private UUID kennzahlAnlegen(String kennzeichen, String name) throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", kennzeichen);
        m.put("name", name);
        m.put("rechenform", "quotient");
        m.put("geltung_art", "gebaeude");
        m.put("geltung_id", g2.toString());
        m.put("verantwortlich_name", "Ines Kaltenbach");
        m.put("eingaenge", List.of(Map.of("rolle", "zaehler", "art", "messstelle", "kennzeichen", "MS-20"),
                Map.of("rolle", "nenner", "art", "bezugsgroesse", "kennzeichen", "BZ-1")));
        return UUID.fromString(ruf("POST", "/api/v1/kennzahlen", "IK", m, 201).path("id").asText());
    }

    /** Eine freigegebene Fassung, direkt geschrieben (Muster IP-8/IP-22) — mit dem Tag ihrer Freigabe. */
    private void bezugsbasisFassung(UUID basis, int nummer, String giltAb, String giltBis, String freigegeben) {
        Timestamp am = Timestamp.from(Instant.parse(freigegeben));
        UUID f = root.queryForObject("INSERT INTO bezugsbasis_fassung (tenant_id, bezugsbasis_id, fassung, "
                + "referenzperiode, methode, datenlage, gilt_ab, gilt_bis, beendet_am, beendet_grund, toleranz_prozent, "
                + "anpassungsgruende, begruendung, basiswert, actor_sub, actor_name, actor_rolle, actor_art, "
                + "freigabe_status, freigabe_sub, freigabe_name, freigabe_rolle, freigabe_art, freigabe_am, "
                + "freigegeben_am) VALUES (?, ?, ?, '2026-10/2026-10', 'verhaeltnis', 'vorlaeufig', ?, ?, ?, ?, 2.0, "
                + "?::text[], 'Freigabe im Abnahme-Test.', 0.2837, 'IK', 'Ines Kaltenbach', 'energiemanager', "
                + "'kunde', 'freigegeben', 'IK', 'Ines Kaltenbach', 'energiemanager', 'kunde', ?, ?) "
                + "RETURNING id", UUID.class, tenant, basis, nummer, Date.valueOf(giltAb),
                giltBis == null ? null : Date.valueOf(giltBis), giltBis == null ? null : am,
                giltBis == null ? null : "Die nächste Fassung ersetzt diese.",
                nummer > 1 ? "{referenzperiode_vervollstaendigt}" : "{}", am, am);
        root.update("INSERT INTO bezugsbasis_variable (tenant_id, fassung_id, position, bezugsgroesse_id, "
                + "bezugsgroesse_fassung) VALUES (?, ?, 1, ?, 1)", tenant, f, bz1);
    }

    private UUID bericht(String kennung, String vorlage, String zeitraumArt, String schluessel, UUID kennzahl) {
        return root.queryForObject("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, geltung_art, "
                + "unternehmen_id, zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_name, kennzahl_id) "
                + "VALUES (?, ?, ?, 1, 'unternehmen', ?, ?, ?, 'Europe/Berlin', 'Ines Kaltenbach', ?) RETURNING id",
                UUID.class, tenant, kennung, vorlage, unternehmen, zeitraumArt, schluessel, kennzahl);
    }

    private void stand(UUID bericht, int nr, String am, String abzug) {
        String a = abzug == null ? "{\"bericht\":\"" + bericht + "\",\"nr\":" + nr + "}" : abzug;
        Timestamp t = Timestamp.from(Instant.parse(am));
        root.update("INSERT INTO bericht_stand (tenant_id, bericht_id, nr, abzug, pruefsumme, datenstand, "
                + "freigegeben_am, freigeber_sub, freigeber_name, freigeber_rolle, darstellung, regelwerk, "
                + "vorlage_fassung) VALUES (?, ?, ?, ?, ?, ?, ?, 'IK', 'Ines Kaltenbach', 'energiemanager', "
                + "'{}'::jsonb, '{}'::jsonb, 1)", tenant, bericht, nr, a, BerichtRegeln.pruefsumme(a), t, t);
    }

    private UUID massnahmeDirekt(String kennzeichen, JsonNode m, String herkunft, String herkunftKennung, UUID kennzahl,
            UUID basis, String ausgangslage, String angelegt, String umgesetzt) {
        UUID id = root.queryForObject("INSERT INTO massnahme (tenant_id, kennzeichen, titel, verantwortlich_sub, "
                + "verantwortlich_name, verantwortlich_konto, termin, standort_id, herkunft_art, herkunft_kennung, "
                + "kennzahl_id, bezugsbasis_id, fassung, ausgangslage, ausgangslage_pruefsumme, erwartete_wirkung_prozent, "
                + "erwartete_wirkung_wortlaut, actor_sub, actor_name, actor_rolle, actor_art, angelegt_am) VALUES (?, ?, ?, "
                + "'IK', 'Ines Kaltenbach', 'benutzer', ?::date, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'IK', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde', ?::timestamptz) RETURNING id", UUID.class, tenant, kennzeichen,
                m.path("titel").asText(), m.path("termin").asText(), s1, herkunft, herkunftKennung, kennzahl, basis,
                kennzahl == null ? null : 2, ausgangslage,
                ausgangslage == null ? null : BerichtRegeln.pruefsumme(ausgangslage),
                m.at("/erwartete_wirkung/prozent").isNumber() ? m.at("/erwartete_wirkung/prozent").decimalValue() : null,
                m.at("/erwartete_wirkung/wortlaut").asText(), angelegt);
        root.update("UPDATE massnahme SET zustand = 'umgesetzt', umgesetzt_am = ?::date, umgesetzt_begruendung = "
                + "'Umgesetzt wie in der Referenzdatei.', umgesetzt_gemeldet_am = ?::timestamptz WHERE id = ?", umgesetzt,
                umgesetzt + "T12:00:00Z", id);
        return id;
    }

    private void bewertungDirekt(UUID massnahme, JsonNode b, UUID kennzahl, UUID basis, String am) {
        String wirkung = b.path("kopie").isObject() ? BerichtRegeln.kanonisch(b.path("kopie")) : null;
        String summe = wirkung == null ? null : b.path("pruefsumme").asText();
        root.update("INSERT INTO massnahme_bewertung (tenant_id, massnahme_id, kennzahl_id, bezugsbasis_id, fassung, "
                + "wirkung, pruefsumme, ergebnis, begruendung, status, freigabe_sub, freigabe_name, freigabe_rolle, "
                + "freigabe_art, freigabe_am) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'bewertet', 'IK', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde', ?::timestamptz)", tenant, massnahme, kennzahl, basis,
                kennzahl == null ? null : 2, wirkung, summe, b.path("ergebnis").asText(), b.path("begruendung").asText(), am);
        root.update("UPDATE massnahme SET zustand = 'bewertet' WHERE id = ?", massnahme);
    }

    private String id(String tabelle, String kennzeichen) {
        return root.queryForObject("SELECT id FROM " + tabelle + " WHERE tenant_id = ? AND kennzeichen = ?", UUID.class,
                tenant, kennzeichen).toString();
    }

    // ================================================================================ Die Sprach-Probe

    /** Die Leser und Schablonen des Energiemanagements, deren Sätze der Kunde liest (Quelltext-Probe). */
    private static final List<String> LESER = List.of("EnergiemanagementRegeln", "EnergiemanagementVerzeichnisService",
            "EnergiemanagementWiedervorlageService", "EnergiemanagementDokumentService", "EnergiemanagementPersonenService",
            "EnergiemanagementVerantwortungService", "EnergiemanagementNachweise", "InternesAuditService",
            "FeststellungService", "ManagementbewertungService", "ManagementbewertungLeser", "BerichtManagementbewertung",
            "DokumentVerzeichnis", "AufgabenVerzeichnis", "AuditVerzeichnis", "FeststellungVerzeichnis",
            "ManagementbewertungVerzeichnis", "VerzeichnisBestand", "DokumentWiedervorlage", "AuditWiedervorlage",
            "FeststellungWiedervorlage", "ManagementbewertungWiedervorlage", "WiedervorlageBestand", "AuditVerantwortung",
            "FeststellungVerantwortung", "EnergiemanagementAbgelehnt");

    /**
     * SP2 (R4) und G4: die Konformitäts-, Zertifizierungs- und Vollständigkeits-Wörter — dieselbe Liste wie der
     * Sprach-Wächter des Portals (copy.test.ts, Block „Energiemanagement“). Das Code-Wort {@code nichtkonformitaet}
     * (ae) ist kein Satz; „Nichtkonformität“ (ä) ist es.
     */
    private static final List<Pattern> VERBOTEN = Stream.of(
            "Nichtkonformität", "Korrekturma(ß|ss)nahme", "Aktionsplan", "Ursachenanalyse", "(?<![\\p{L}])konform",
            "zertifizier", "audit-?(fest|sicher|bereit)", "revisions-?sicher", "norm-?gerecht",
            "(^|[^\\p{L}\\p{N}])EnMS([^\\p{L}\\p{N}]|$)", "management[-\\s]?system", "erf(ü|ue)llungs[-\\s]?grad",
            "reife[-\\s]?grad", "vollst(ä|ae)ndig\\s+(dokumentiert|erf(ü|ue)llt|abgedeckt|nachgewiesen)",
            "(Energiemanagement|Nachweise?|Dokumentation)\\s+(ist|sind)\\s+vollst(ä|ae)ndig",
            "alle\\s+(erforderlichen\\s+)?Nachweise\\s+(liegen|sind)",
            "bereit\\s+f(ü|ue)r\\s+(\\p{L}+\\s+){0,2}(Audit|Zertifizierung)", "(^|[^\\p{L}\\p{N}])ISO([^\\p{L}\\p{N}]|$)")
            .map(p -> Pattern.compile(p, Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE)).toList();

    private static void pruefe(String wo, String text, List<String> funde) {
        String ohneGrenze = text.replace(GRENZ_SATZ, " ");
        for (Pattern p : VERBOTEN) {
            if (p.matcher(ohneGrenze).find()) {
                funde.add(wo + " [" + p + "]: " + text);
            }
        }
    }

    /** Ein Satz: ein Text mit Buchstaben und Leerraum — Code-Wörter ({@code nichtkonformitaet}) sind keiner. */
    private static boolean satz(String text) {
        return text.matches("(?s).*\\p{L}.*\\s.*") && !text.matches("(?s).*\\b(SELECT|INSERT|UPDATE|WHERE|JOIN)\\b.*");
    }

    /** Jeder Satz einer Antwort, auch in Kopien, die als JSON-Text gespeichert sind; zählt die Sätze. */
    private static int texte(JsonNode n, String wo, List<String> funde) {
        int zahl = 0;
        if (n.isTextual()) {
            String t = n.asText();
            if (satz(t)) {
                zahl++;
                pruefe(wo, t, funde);
            }
            if (t.startsWith("{") || t.startsWith("[")) {
                try {
                    zahl += texte(JSON.readTree(t), wo + " (Kopie)", funde);
                } catch (IOException kein) {
                    // kein JSON — der Text selbst ist geprüft
                }
            }
        }
        for (JsonNode k : n) {
            zahl += texte(k, wo, funde);
        }
        return zahl;
    }

    /** Die Texte einer Java-Quelle: Kommentare weg, zusammengesetzte Literale als ein Text (Muster AP-18 IP-22). */
    private static List<String> texte(String quelle) {
        String ohneBlock = quelle.replaceAll("(?s)/\\*.*?\\*/", "");
        StringBuilder code = new StringBuilder();
        for (String zeile : ohneBlock.split("\n")) {
            int i = zeile.indexOf("//");
            code.append(i >= 0 && zeile.substring(0, i).chars().filter(c -> c == '"').count() % 2 == 0
                    ? zeile.substring(0, i) : zeile).append('\n');
        }
        String verbunden = code.toString().replaceAll("\"\\s*\\+\\s*\"", "");
        List<String> texte = new ArrayList<>();
        Matcher m = Pattern.compile("\"((?:[^\"\\\\\\n]|\\\\.)*)\"").matcher(verbunden);
        while (m.find()) {
            texte.add(m.group(1));
        }
        return texte;
    }

    /**
     * Die Energiemanagement-Flächen des Portals wie der Sprach-Wächter sie findet: seine Liste
     * {@code ENERGIEMANAGEMENT_FLAECHEN} (copy.test.ts, IP-9 … IP-24 tragen dort ein) und jede Kunden-Komponente, deren
     * Name mit einem Wort des Bereichs beginnt.
     */
    private static List<String> energiemanagementFlaechen(Path src) throws IOException {
        String waechter = Files.readString(src.resolve("copy.test.ts"), StandardCharsets.UTF_8);
        int von = waechter.indexOf("const ENERGIEMANAGEMENT_FLAECHEN: string[] = [");
        assertThat(von).as("Liste des Sprach-Wächters").isPositive();
        String liste = waechter.substring(von, waechter.indexOf("];", von));
        List<String> aus = new ArrayList<>();
        Matcher m = Pattern.compile("'([^']+\\.tsx)'").matcher(liste);
        while (m.find()) {
            aus.add(m.group(1));
        }
        Pattern name = Pattern.compile("(?:^|/)(?:Energiemanagement|Energiepolitik|Anwendungsbereich|Dokument|Verzeichnis|"
                + "Wiedervorlage|InternesAudit|Audit|Feststellung|Managementbewertung|Beschluss|Wirksamkeit|Zuschnitt|"
                + "Nachweis)[^/]*\\.tsx$", Pattern.CASE_INSENSITIVE);
        try (Stream<Path> dateien = Files.walk(src)) {
            dateien.map(p -> src.relativize(p).toString().replace('\\', '/'))
                    .filter(p -> (p.startsWith("pages/") || p.startsWith("components/")) && !p.contains(".test."))
                    .filter(p -> name.matcher(p).find()).sorted().forEach(p -> {
                        if (!aus.contains(p)) aus.add(p);
                    });
        }
        return aus;
    }

    // ================================================================================ Lesen

    private void lies(String wo, String path, String sub) throws Exception {
        MockHttpServletResponse r = roh(path, sub);
        assertThat(r.getStatus()).as(wo + " " + r.getContentAsString(StandardCharsets.UTF_8)).isEqualTo(200);
        leser.put(wo, r.getContentAsString(StandardCharsets.UTF_8));
    }

    private JsonNode antwort(String wo) throws IOException {
        assertThat(leser).containsKey(wo);
        return JSON.readTree(leser.get(wo));
    }

    private JsonNode antwortUnchecked(String wo) {
        try {
            return antwort(wo);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private static JsonNode gruppe(JsonNode v, String gruppe) {
        for (JsonNode g : v.path("gruppen")) {
            if (g.path("gruppe").asText().equals(gruppe)) return g;
        }
        throw new AssertionError(gruppe + " fehlt");
    }

    private static List<JsonNode> alle(JsonNode v) {
        List<JsonNode> aus = new ArrayList<>();
        v.path("gruppen").forEach(g -> g.path("zeilen").forEach(aus::add));
        return aus;
    }

    /** Die Zeile einer Art und eines Kennzeichens; {@code nr} 0 = ohne Nr. */
    private static JsonNode zeile(JsonNode v, String art, String kennzeichen, int nr) {
        return alle(v).stream().filter(z -> z.path("art").asText().equals(art)
                && z.path("kennzeichen").asText().equals(kennzeichen) && (nr == 0 || z.path("nr").asInt() == nr))
                .findFirst().orElseThrow(() -> new AssertionError(art + " " + kennzeichen + " " + nr + " fehlt"));
    }

    private static List<String> felder(JsonNode n) {
        List<String> aus = new ArrayList<>();
        n.fieldNames().forEachRemaining(aus::add);
        return aus;
    }

    private static List<String> texte(JsonNode liste, String feld) {
        List<String> aus = new ArrayList<>();
        liste.forEach(n -> aus.add(feld == null ? n.asText() : n.path(feld).asText()));
        return aus;
    }

    private static Map<String, Integer> katalogR3() {
        Map<String, Integer> k = new LinkedHashMap<>();
        k.put("grundlagen", 4);
        k.put("verantwortung", 10);
        k.put("risiken_chancen", 0);
        k.put("kompetenz_kommunikation", 3);
        k.put("betrieb_auslegung_beschaffung", 1);
        k.put("bewertung_messplanung", 20);
        k.put("kennzahlen_bezugsbasen", 15);
        k.put("ziele_massnahmen_abweichungen", 5);
        k.put("audits_feststellungen", 2);
        k.put("managementbewertung", 0);
        k.put("berichte", 2);
        return k;
    }

    /** Alle Uhren, an denen ein Dienst „heute“ misst, auf denselben Augenblick. */
    private void uhr(String jetzt) {
        uhr(Clock.fixed(Instant.parse(jetzt), ZoneOffset.UTC));
    }

    private void uhr(Clock c) {
        dokumente.uhrStellen(c);
        audits.uhrStellen(c);
        feststellungen.uhrStellen(c);
        kennzahlen.uhrStellen(c);
        berichte.uhrStellen(c);
        verzeichnis.uhrStellen(c);
        wiedervorlage.uhrStellen(c);
    }

    private Authentication token(String sub) {
        Jwt jwt = Jwt.withTokenValue("test").header("alg", "none").subject(sub).issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600)).claim("tenant_id", tenant.toString())
                .claim("realm_access", Map.of("roles", List.of())).claim("name", NAMEN.get(sub))
                .claim("preferred_username", NAMEN.get(sub)).build();
        return new KeycloakRealmRoleConverter().convert(jwt);
    }

    private JsonNode ruf(String path, String sub, int status) throws Exception {
        return ruf("GET", path, sub, null, status);
    }

    private MockHttpServletResponse roh(String path, String sub) throws Exception {
        return mvc.perform(request(HttpMethod.GET, path).with(authentication(token(sub)))).andReturn().getResponse();
    }

    private JsonNode ruf(String method, String path, String sub, Object body, int status) throws Exception {
        var b = request(HttpMethod.valueOf(method), path).with(authentication(token(sub)));
        if (body != null) b.contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        var r = mvc.perform(b).andReturn().getResponse();
        assertThat(r.getStatus()).as(method + " " + path + " " + r.getContentAsString(StandardCharsets.UTF_8))
                .isEqualTo(status);
        String text = r.getContentAsString(StandardCharsets.UTF_8);
        return text.isBlank() ? JSON.nullNode() : JSON.readTree(text);
    }

    private UUID standort(String k, String name) {
        return root.queryForObject("INSERT INTO standort(tenant_id,unternehmen_id,name,kurzzeichen,zeitzone,zustand) "
                + "VALUES (?,?,?,?,'Europe/Berlin','aktiv') RETURNING id", UUID.class, tenant, unternehmen, name, k);
    }

    private void benutzer(String sub, String rolle, UUID standort) {
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,?,'benutzer',?,'aktiv')",
                tenant, sub, NAMEN.get(sub));
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,standort_id,gueltig_ab,zeitzone) "
                + "VALUES (?,?,?,?,'2024-01-01','Europe/Berlin')", tenant, sub, rolle, standort);
    }
}
