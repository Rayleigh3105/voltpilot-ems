package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
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
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.mock.web.MockHttpServletResponse;
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
    private static final String VERANTWORTUNG = EnergiemanagementRegeln.SAETZE.get("verantwortung");
    private static final String GRENZ_SATZ = EnergiemanagementRegeln.SAETZE.get("grenz_satz");
    private static final String LEER = "Hier ist noch nichts festgehalten.";

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
    /** Die Welt (seit AP-20 IP-13 eine eigene Klasse, auch der Seed-Weg der Prüfumgebung); ihre Stände hier gespiegelt. */
    AhrenbergWelt welt;
    JsonNode referenz;
    UUID tenant, unternehmen;
    Map<String, String> person;
    Map<String, String> dokument;
    Map<String, UUID> einsatz;
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
        welt = new AhrenbergWelt(mvc, root, this::uhr, AhrenbergWelt.Ziel.NEU);
        referenz = welt.referenz;
        person = welt.person;
        dokument = welt.dokument;
        einsatz = welt.einsatz;
        welt.stammdaten();
        welt.bis12Februar2029();
        uebernehmen();
        uhr("2029-02-12T07:00:00Z");
        r3 = ruf(VERZEICHNIS, "IK", 200);
        r3Rf = ruf(VERZEICHNIS + "?person=" + person.get("RF"), "RF", 200);
        lies("verzeichnis 12.02.2029", VERZEICHNIS, "IK");
        lies("verzeichnis csv 12.02.2029", VERZEICHNIS + "?format=csv", "IK");
        lies("wiedervorlage 12.02.2029", BASIS + "/wiedervorlage", "IK");
        lies("wiedervorlage ics 12.02.2029", BASIS + "/wiedervorlage?format=ics", "IK");
        welt.managementbewertungUndFolgen();
        uebernehmen();
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

    /** Die Stände der Welt, die die Gruppen lesen. */
    private void uebernehmen() {
        tenant = welt.tenant;
        unternehmen = welt.unternehmen;
        audit = welt.audit;
        feststellung = welt.feststellung;
        pruefsummeNr1 = welt.pruefsummeNr1;
        abzugNr1 = welt.abzugNr1;
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

    private JsonNode ruf(String path, String sub, int status) throws Exception {
        return welt.ruf(path, sub, status);
    }

    private MockHttpServletResponse roh(String path, String sub) throws Exception {
        return welt.roh(path, sub);
    }

    private JsonNode ruf(String method, String path, String sub, Object body, int status) throws Exception {
        return welt.ruf(method, path, sub, body, status);
    }

    private String id(String tabelle, String kennzeichen) {
        return welt.id(tabelle, kennzeichen);
    }
}
