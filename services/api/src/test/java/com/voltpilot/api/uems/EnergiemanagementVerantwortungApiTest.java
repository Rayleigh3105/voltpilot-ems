package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.zugriff.ZugriffContext;
import com.voltpilot.api.zugriff.ZugriffKontextLader;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.sql.Date;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.UUID;
import java.util.function.Supplier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
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
 * UEMS AP-19 IP-10 (NW-2): „Wer ist wofür verantwortlich“ und die Verzeichnis-Quelle „Aufgaben“ über die echte HTTP-,
 * Rechte- und RLS-Kette mit der App-Rolle — R5 des Konzepts mit der Referenzdatei 1.10 (Kunststoffwerk Ahrenberg):
 * zehn Zuordnungen am 22.01.2029, „Bezugsbasen pflegen und freigeben — keine Person festgelegt.“, an den Bezugsbasen
 * die Verantwortlichen der Kennzahlen (IK, IK, IK, JW, PH), freigegeben hat alle acht Fassungen Ines Kaltenbach.
 *
 * <p>Die Objekte von AP-11 bis AP-18 entstehen wie in ihren eigenen Tests (Routen, freigegebene Fassungen und
 * Energieeinsätze direkt geschrieben) — geprüft wird der Leser, nicht ihre Schreibwege.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class EnergiemanagementVerantwortungApiTest {
    private static final String BASIS = "/api/v1/energiemanagement";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Map<String, String> NAMEN = Map.of("IK", "Ines Kaltenbach", "JW", "Jonas Wendlinger",
            "PH", "Peter Hollerbach", "CB", "Claudia Berger", "MD", "Murat Demirci", "RF", "Robert Falk");
    private static final Map<String, Object> BESTELLUNG = Map.of(
            "bezeichnung", "Bestellung Energiemanagement vom 28.09.2026, unterschrieben",
            "ablage", "Personalakte (Personalabteilung)");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "ip10_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "ip10_test_pw");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> "http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/certs");
        // Der Stundentakt schreibt selbst Kennzahl-Zeilen — hier schreibt allein der Test.
        r.add("voltpilot.uems.kennzahlen.enabled", () -> "false");
    }

    @Autowired MockMvc mvc;
    @Autowired KennzahlService kennzahlen;
    @Autowired AufgabenVerzeichnis aufgabenVerzeichnis;
    @Autowired ZugriffKontextLader lader;
    static JdbcTemplate root;
    UUID tenant, unternehmen, s1, s2, g2, bz1;

    @BeforeAll
    static void start() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void welt() {
        uhr("2026-10-01T09:00:00Z");
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Ahrenberg IP-10') RETURNING id", UUID.class);
        unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name,zeitzone) VALUES (?,"
                + "'Kunststoffwerk Ahrenberg GmbH','Europe/Berlin') RETURNING id", UUID.class, tenant);
        s1 = standort("ST-1", "Werk Ahrenberg");
        s2 = standort("ST-2", "Werk Lindach");
        benutzer("IK", "energiemanager", null);
        benutzer("JW", "kundenadministrator", null);
        benutzer("PH", "bearbeiter", s2);
        benutzer("MD", "bedienberechtigt", s1);
        benutzer("CB", "leser", s1);
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

    @AfterEach
    void uhrZurueck() {
        kennzahlen.uhrStellen(Clock.systemUTC());
    }

    // ------------------------------------------------------------------ R5

    @Test
    void r5ZehnZuordnungenBezugsbasenOhnePersonVerantwortlicheUndFreigebendeAmTwentySecondJanuary() throws Exception {
        Map<String, JsonNode> p = r5Aufgaben();
        // Kennzahlen mit ihren Verantwortlichen und je eine Bezugsbasis — BB-0001 … BB-0005 in dieser Reihenfolge.
        String[][] kz = {{"KZ-0004", "Stromeinsatz Spritzguss je kg", "IK"},
            {"KZ-0001", "Stromeinsatz Montage je Stück — Halle 2", "IK"}, {"KZ-0005", "Netzbezug je m² — Halle 2", "IK"},
            {"KZ-0006", "Gasbezug Verwaltung je Gradtag", "JW"},
            {"KZ-0002", "Stromeinsatz Montage je Stück — Montagehalle Lindach", "PH"}};
        Map<String, UUID> kennzahl = new LinkedHashMap<>();
        Map<String, UUID> basis = new LinkedHashMap<>();
        for (String[] k : kz) kennzahl.put(k[0], kennzahl(k[0], k[1], NAMEN.get(k[2])));
        for (String[] k : kz) {
            JsonNode b = ruf("POST", "/api/v1/kennzahlen/" + kennzahl.get(k[0]) + "/bezugsbasen", "IK", null, 201);
            basis.put(b.path("kennzeichen").asText(), UUID.fromString(b.path("id").asText()));
        }
        assertThat(basis.keySet()).containsExactly("BB-0001", "BB-0002", "BB-0003", "BB-0004", "BB-0005");
        // Acht freigegebene Fassungen, alle von Ines Kaltenbach, ohne zweite Prüfung (Referenzdatei 1.10).
        fassung(basis.get("BB-0001"), 1, "2026-11-01", "2027-10-31");
        fassung(basis.get("BB-0001"), 2, "2027-11-01", null);
        fassung(basis.get("BB-0002"), 1, "2026-11-01", "2026-11-30");
        fassung(basis.get("BB-0002"), 2, "2026-12-01", null);
        fassung(basis.get("BB-0003"), 1, "2026-11-01", "2027-02-28");
        fassung(basis.get("BB-0003"), 2, "2027-03-01", null);
        fassung(basis.get("BB-0004"), 1, "2027-11-01", null);
        fassung(basis.get("BB-0005"), 1, "2026-11-01", null);

        // Energieeinsätze EE-1 … EE-8 mit ihren Verantwortlichen (R5 Schritt 4).
        String[][] ee = {{"EE-1", "Spritzguss", "MD"}, {"EE-2", "Montage", "PH"}, {"EE-3", "Druckluft", "IK"},
            {"EE-4", "Kühlung", "IK"}, {"EE-5", "Logistik", "PH"}, {"EE-6", "Verwaltung", "JW"},
            {"EE-7", "Heizung Verwaltung (Gas)", "JW"}, {"EE-8", "Gebäudetechnik Halle 1", "IK"}};
        Map<String, UUID> einsatz = new LinkedHashMap<>();
        for (String[] e : ee) {
            UUID prozess = root.queryForObject("INSERT INTO prozess (tenant_id, unternehmen_id, kennzeichen, name, "
                    + "gueltig_ab) VALUES (?, ?, ?, ?, '2024-01-01') RETURNING id", UUID.class, tenant, unternehmen,
                    "P-" + e[0].substring(3), e[1]);
            einsatz.put(e[0], root.queryForObject("INSERT INTO energieeinsatz (tenant_id, kennzeichen, prozess_id, "
                    + "traeger, name, gueltig_ab, verantwortlich_sub, verantwortlich_name, verantwortlich_konto, "
                    + "actor_sub, actor_name, actor_art) VALUES (?, ?, ?, ?, ?, '2026-10-01', ?, ?, 'benutzer', 'IK', "
                    + "'Ines Kaltenbach', 'kunde') RETURNING id", UUID.class, tenant, e[0], prozess,
                    e[0].equals("EE-7") ? "Gas" : "Strom", e[1], e[2], NAMEN.get(e[2])));
        }

        // Energieziel und Maßnahmen über ihre Routen (AP-18), eine Abweichung direkt geschrieben.
        monat(kennzahl.get("KZ-0004"), "2027-12-01", "78000", "250000");
        uhr("2027-12-20T09:00:00Z");
        ruf("POST", "/api/v1/energieziele", "IK", Map.of("kennzahl", kennzahl.get("KZ-0004").toString(),
                "zielwert_prozent", new BigDecimal("-5.0"), "zielperiode", "2028-01/2028-12",
                "wortlaut", "Spritzguss: 5 % weniger Strom", "begruendung", "Energieziel für das Jahr 2028 gesetzt."),
                201);
        uhr("2028-01-15T09:00:00Z");
        massnahme("Werkzeugheizungen in Betriebspausen abschalten", "MD", einsatz.get("EE-1"));
        massnahme("Druckluft-Leckagen orten und beseitigen", "IK", einsatz.get("EE-3"));
        root.update("INSERT INTO abweichung (tenant_id, kennzahl_id, bezugsbasis_id, fassung, monate, herkunft_art, "
                + "herkunft_wortlaut, anlass, anlass_pruefsumme, verantwortlich_sub, verantwortlich_name, "
                + "verantwortlich_konto, frist, actor_sub, actor_name, actor_art) VALUES (?, ?, ?, 2, '{2027-12}', "
                + "'von_hand', 'Dezember auffällig hoch, von Hand eröffnet.', '{}', bericht_pruefsumme('{}'), 'JW', "
                + "'Jonas Wendlinger', 'benutzer', '2028-03-01', 'IK', 'Ines Kaltenbach', 'kunde')", tenant,
                kennzahl.get("KZ-0004"), basis.get("BB-0001"));

        uhr("2029-01-22T09:00:00Z");
        JsonNode v = ruf("GET", BASIS + "/verantwortung?tag=2029-01-22", "IK", null, 200);

        // Die Aufgaben: zehn laufende Zuordnungen, neun „entschieden von Robert Falk“, die Leitung ohne Konto.
        assertThat(v.path("tag").asText()).isEqualTo("2029-01-22");
        List<JsonNode> laufend = new ArrayList<>();
        v.path("aufgaben").forEach(a -> a.path("laufend").forEach(laufend::add));
        assertThat(laufend).hasSize(10);
        assertThat(laufend.stream().filter(z -> z.at("/entschieden_von/name").asText().equals("Robert Falk")))
                .hasSize(9);
        assertThat(v.at("/leitung/0/name").asText()).isEqualTo("Robert Falk");
        assertThat(v.at("/leitung/0/mit_konto").asBoolean()).isFalse();
        assertThat(texte(v.path("ohne_person"))).containsExactly("bezugsbasen");
        assertThat(satz(v, "bezugsbasen")).isEqualTo("Bezugsbasen pflegen und freigeben — keine Person festgelegt.");

        // Die Verantwortlichen der Objekte — gelesen, nicht kopiert.
        assertThat(verantwortlich(v, "bezugsbasis")).containsExactly(Map.entry("BB-0001", "Ines Kaltenbach"),
                Map.entry("BB-0002", "Ines Kaltenbach"), Map.entry("BB-0003", "Ines Kaltenbach"),
                Map.entry("BB-0004", "Jonas Wendlinger"), Map.entry("BB-0005", "Peter Hollerbach"));
        assertThat(verantwortlich(v, "kennzahl")).contains(Map.entry("KZ-0006", "Jonas Wendlinger"),
                Map.entry("KZ-0002", "Peter Hollerbach")).hasSize(5);
        Map<String, String> einsaetze = verantwortlich(v, "energieeinsatz");
        assertThat(einsaetze).hasSize(8);
        for (String[] e : ee) assertThat(einsaetze.get(e[0])).as(e[0]).isEqualTo(NAMEN.get(e[2]));
        assertThat(objekt(v, "energieeinsatz", "EE-1").at("/verantwortlich/sub").asText()).isEqualTo("MD");
        assertThat(objekt(v, "bezugsbasis", "BB-0004").at("/verantwortlich/sub").isNull())
                .as("die Bezugsbasis nennt nur den Namen").isTrue();
        assertThat(verantwortlich(v, "energieziel").values()).containsExactly("Ines Kaltenbach");
        assertThat(verantwortlich(v, "massnahme")).containsExactly(Map.entry("M-2028-0001", "Murat Demirci"),
                Map.entry("M-2028-0002", "Ines Kaltenbach"));
        assertThat(verantwortlich(v, "abweichung").values()).containsExactly("Jonas Wendlinger");
        assertThat(objekt(v, "massnahme", "M-2028-0001").path("zustand").asText()).isEqualTo("geplant");
        assertThat(texte(v.path("objekte"), "art")).containsSubsequence("kennzahl", "energieeinsatz", "bezugsbasis",
                "energieziel", "massnahme", "abweichung");

        // Wer freigegeben hat: alle acht Fassungen Ines Kaltenbach, ohne zweite Prüfung — nicht die Verantwortlichen.
        JsonNode freigaben = v.path("bezugsbasen_freigaben");
        assertThat(freigaben).hasSize(8);
        assertThat(new TreeSet<>(texte(freigaben, "freigegeben_von"))).containsExactly("Ines Kaltenbach");
        assertThat(texte(freigaben, "bezugsbasis")).containsExactly("BB-0001", "BB-0001", "BB-0002", "BB-0002",
                "BB-0003", "BB-0003", "BB-0004", "BB-0005");
        freigaben.forEach(f -> {
            assertThat(f.path("vieraugen").asBoolean()).isFalse();
            assertThat(f.path("zweite_person").isNull()).isTrue();
        });

        // Ab 01.03.2029 (Beschluss B4) hat die Aufgabe eine Person — der Satz verschwindet.
        Map<String, Object> b4 = entschieden("bezugsbasen", p.get("IK"), "2029-03-01", id(p.get("RF")),
                id(p.get("JW")));
        b4.put("beschluss_kennung", "BR-2029-0001/B4");
        ManagementbewertungImStand.anlegen(root, tenant, unternehmen, UUID.fromString(id(p.get("RF"))), "BR-2029-0001", 6);
        ruf("POST", BASIS + "/aufgaben", "IK", b4, 201);
        JsonNode maerz = ruf("GET", BASIS + "/verantwortung?tag=2029-03-01", "IK", null, 200);
        assertThat(maerz.path("ohne_person")).isEmpty();
        assertThat(satz(maerz, "bezugsbasen")).isNull();

        // Zaun je Quelle: ein Standort-Konto bekommt keine Aufgabe, nie den Satz, keine fremde Kennzahl.
        JsonNode ph = ruf("GET", BASIS + "/verantwortung?tag=2029-01-22", "PH", null, 200);
        assertThat(ph.path("aufgaben")).isEmpty();
        assertThat(ph.path("ohne_person")).isEmpty();
        assertThat(ph.path("leitung")).isEmpty();
        assertThat(verantwortlich(ph, "kennzahl")).isEmpty();
        assertThat(ph.path("bezugsbasen_freigaben")).isEmpty();
    }

    // ------------------------------------------------------------------ Verzeichnis-Quelle „Aufgaben“

    @Test
    void verzeichnisQuelleAufgabenZehnZeilenDerGruppeVerantwortungMitOrt() throws Exception {
        r5Aufgaben();
        List<Map<String, Object>> zeilen = alsIk(() -> aufgabenVerzeichnis.zeilen(LocalDate.parse("2029-02-12")));
        assertThat(zeilen).hasSize(10);
        assertThat(zeilen).allSatisfy(z -> {
            assertThat(z.get("gruppe")).isEqualTo("verantwortung");
            assertThat(z.get("gruppe_wort")).isEqualTo("Aufgaben und Verantwortliche");
            assertThat(z.get("art")).isEqualTo("aufgabe");
            assertThat(z.get("eingetragen_von")).isEqualTo("Ines Kaltenbach");
            assertThat(z.get("nr")).isNull();
        });
        Map<String, Object> leitung = zeilen.stream().filter(z -> z.get("kennzeichen").equals("Leitung des Unternehmens"))
                .findFirst().orElseThrow();
        assertThat(leitung.get("titel")).isEqualTo("Leitung des Unternehmens: Robert Falk");
        assertThat(leitung.get("entschieden_von")).isNull();
        assertThat(leitung.get("tag")).isEqualTo("2026-10-01");
        assertThat(leitung.get("ort")).isEqualTo("in_voltpilot");
        assertThat(leitung.get("ort_satz")).isEqualTo("in VoltPilot");
        Map<String, Object> leiten = zeilen.stream()
                .filter(z -> z.get("kennzeichen").equals("Energiemanagement leiten und an die Leitung berichten"))
                .findFirst().orElseThrow();
        assertThat(leiten.get("titel"))
                .isEqualTo("Energiemanagement leiten und an die Leitung berichten: Ines Kaltenbach");
        assertThat(leiten.get("entschieden_von")).isEqualTo("Robert Falk");
        assertThat(leiten.get("ort")).isEqualTo("verweis");
        assertThat(leiten.get("ort_satz")).isEqualTo("Geführt in Ihrem System: Personalakte (Personalabteilung)");
        assertThat(zeilen.stream().filter(z -> "Robert Falk".equals(z.get("entschieden_von")))).hasSize(9);
        // Die Aufgabe „interne Audits“ trägt keinen Beleg — ihre Zeile liegt in VoltPilot.
        assertThat(zeilen.stream().filter(z -> z.get("titel").equals("Interne Audits planen und durchführen: "
                + "Claudia Berger")).findFirst().orElseThrow().get("ort")).isEqualTo("in_voltpilot");
        // Vor dem 01.12.2028 ist Claudia Berger noch nicht zugeordnet.
        assertThat(alsIk(() -> aufgabenVerzeichnis.zeilen(LocalDate.parse("2028-11-30")))).hasSize(9);
    }

    // ------------------------------------------------------------------ Welt

    /** R5 „gegeben“: die sechs Personen und die zehn Zuordnungen, Robert Falk ohne Konto. */
    private Map<String, JsonNode> r5Aufgaben() throws Exception {
        Map<String, JsonNode> p = new LinkedHashMap<>();
        p.put("RF", person("Robert Falk", "Geschäftsführer", "RF", null, "2026-10-01"));
        p.put("IK", person("Ines Kaltenbach", "Energiemanagement", "IK", "IK", "2026-10-01"));
        p.put("JW", person("Jonas Wendlinger", "IT-Leitung", "JW", "JW", "2026-10-01"));
        p.put("PH", person("Peter Hollerbach", "Standortleiter Werk Lindach", "PH", "PH", "2026-10-15"));
        p.put("MD", person("Murat Demirci", "Schichtführer Halle 1", "MD", "MD", "2026-10-01"));
        p.put("CB", person("Claudia Berger", "Controlling", "CB", "CB", "2028-12-01"));
        String rf = id(p.get("RF"));
        ruf("POST", BASIS + "/aufgaben", "IK", Map.of("aufgabe", "unternehmensleitung", "person_id", rf,
                "gilt_ab", "2026-10-01", "begruendung", "Geschäftsführer laut Handelsregister"), 201);
        ruf("POST", BASIS + "/aufgaben", "IK",
                entschieden("energiemanagement_leiten", p.get("IK"), "2026-10-01", rf, id(p.get("JW"))), 201);
        for (String k : List.of("IK", "MD")) {
            ruf("POST", BASIS + "/aufgaben", "IK", entschieden("energieteam", p.get(k), "2026-10-01", rf, null), 201);
        }
        ruf("POST", BASIS + "/aufgaben", "IK", entschieden("energieteam", p.get("PH"), "2026-10-15", rf, null), 201);
        for (String a : List.of("energieziele_massnahmen", "bewertung_messplanung", "dokumente", "managementbewertung")) {
            ruf("POST", BASIS + "/aufgaben", "IK", entschieden(a, p.get("IK"), "2026-10-01", rf, null), 201);
        }
        Map<String, Object> audits = entschieden("interne_audits", p.get("CB"), "2028-12-01", rf, null);
        audits.remove("beleg");
        ruf("POST", BASIS + "/aufgaben", "IK", audits, 201);
        return p;
    }

    private Map<String, Object> entschieden(String aufgabe, JsonNode person, String ab, String von, String vertretung) {
        Map<String, Object> a = new LinkedHashMap<>(Map.of("aufgabe", aufgabe, "person_id", id(person),
                "gilt_ab", ab, "entschieden_von", von, "begruendung", "Bestellung vom 28.09.2026",
                "beleg", BESTELLUNG));
        if (vertretung != null) a.put("vertretung_person_id", vertretung);
        return a;
    }

    private JsonNode person(String name, String funktion, String kuerzel, String konto, String seit) throws Exception {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("name", name);
        b.put("funktion", funktion);
        b.put("kuerzel", kuerzel);
        if (konto != null) b.put("konto_sub", konto);
        b.put("seit", seit);
        return ruf("POST", BASIS + "/personen", "IK", b, 201);
    }

    private UUID kennzahl(String kennzeichen, String name, String verantwortlich) throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", kennzeichen);
        m.put("name", name);
        m.put("rechenform", "quotient");
        m.put("geltung_art", "gebaeude");
        m.put("geltung_id", g2.toString());
        m.put("verantwortlich_name", verantwortlich);
        m.put("eingaenge", List.of(Map.of("rolle", "zaehler", "art", "messstelle", "kennzeichen", "MS-20"),
                Map.of("rolle", "nenner", "art", "bezugsgroesse", "kennzeichen", "BZ-1")));
        return UUID.fromString(ruf("POST", "/api/v1/kennzahlen", "IK", m, 201).path("id").asText());
    }

    private void massnahme(String titel, String verantwortlich, UUID einsatz) throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("titel", titel);
        m.put("verantwortlich", verantwortlich);
        m.put("termin", "2028-02-29");
        m.put("herkunft", "einsatz");
        m.put("einsatz", einsatz.toString());
        m.put("standort", s1.toString());
        m.put("erwartete_wirkung_wortlaut", "Weniger Strom außerhalb der Produktion.");
        ruf("POST", "/api/v1/massnahmen", "IK", m, 201);
    }

    /** Eine freigegebene Fassung, direkt geschrieben (Muster VerbesserungUebersichtApiTest): Ines Kaltenbach. */
    private void fassung(UUID basis, int nummer, String giltAb, String giltBis) {
        UUID f = root.queryForObject("INSERT INTO bezugsbasis_fassung (tenant_id, bezugsbasis_id, fassung, "
                + "referenzperiode, methode, datenlage, gilt_ab, gilt_bis, beendet_am, beendet_grund, toleranz_prozent, "
                + "anpassungsgruende, begruendung, basiswert, actor_sub, actor_name, actor_rolle, actor_art, "
                + "freigabe_status, freigabe_sub, freigabe_name, freigabe_rolle, freigabe_art, freigabe_am, "
                + "freigegeben_am) VALUES (?, ?, ?, '2026-10/2026-10', 'verhaeltnis', 'vorlaeufig', ?, ?, ?, ?, 2.0, "
                + "?::text[], 'Freigabe im Verantwortungs-Test.', 0.2837, 'IK', 'Ines Kaltenbach', 'energiemanager', "
                + "'kunde', 'freigegeben', 'IK', 'Ines Kaltenbach', 'energiemanager', 'kunde', now(), now()) "
                + "RETURNING id", UUID.class, tenant, basis, nummer, Date.valueOf(giltAb),
                giltBis == null ? null : Date.valueOf(giltBis), giltBis == null ? null : Timestamp.from(Instant.now()),
                giltBis == null ? null : "Die nächste Fassung ersetzt diese.",
                nummer > 1 ? "{referenzperiode_vervollstaendigt}" : "{}");
        root.update("INSERT INTO bezugsbasis_variable (tenant_id, fassung_id, position, bezugsgroesse_id, "
                + "bezugsgroesse_fassung) VALUES (?, ?, 1, ?, 1)", tenant, f, bz1);
    }

    /** Eine endgültige Monatszeile der Kennzahl (Version 1) und der Bezugsgrößen-Wert (Fassung 1). */
    private void monat(UUID kennzahl, String erster, String zaehlerText, String nennerText) {
        LocalDate von = LocalDate.parse(erster);
        LocalDate bis = von.plusMonths(1).minusDays(1);
        BigDecimal zaehler = new BigDecimal(zaehlerText);
        BigDecimal nenner = new BigDecimal(nennerText);
        Timestamp am = Timestamp.from(von.plusMonths(1).atStartOfDay().toInstant(ZoneOffset.UTC).plusSeconds(7200));
        Timestamp endgueltig = Timestamp.from(von.plusMonths(1).plusDays(6).atStartOfDay().toInstant(ZoneOffset.UTC));
        UUID fassung = root.queryForObject("SELECT id FROM kennzahl_fassung WHERE kennzahl_id = ? AND nummer = 1",
                UUID.class, kennzahl);
        UUID wert = UUID.randomUUID();
        root.update("INSERT INTO kennzahl_wert (id, tenant_id, kennzahl_id, periode_art, periode_von, periode_bis, zeitzone, "
                + "version, wert, zaehler, nenner, menge_zustand, richtung, kennzeichen, zustand, endgueltig_ab, "
                + "definition_fassung_id, berechnet_am) VALUES (?, ?, ?, 'monat', ?, ?, 'Europe/Berlin', 1, ?, ?, ?, "
                + "'vollständig', NULL, '[]'::jsonb, 'endgueltig', ?, ?, ?)", wert, tenant, kennzahl,
                Date.valueOf(von), Date.valueOf(bis), zaehler.divide(nenner, 20, RoundingMode.HALF_UP), zaehler, nenner,
                endgueltig, fassung, am);
        root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + "messstelle_id, wert, einheit, menge_zustand, version) VALUES (?, ?, ?, 0, 'zaehler', 'messstelle', "
                + "'MS-20', (SELECT id FROM messstelle WHERE tenant_id = ? AND kennzeichen = 'MS-20'), ?, 'kWh', "
                + "'vollständig', 1)", tenant, wert, kennzahl, tenant, zaehler);
        root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + "bezugsgroesse_id, wert, einheit, menge_zustand, fassung) VALUES (?, ?, ?, 1, 'nenner', 'bezugsgroesse', "
                + "'BZ-1', ?, ?, 'kg', 'vollständig', 1)", tenant, wert, kennzahl, bz1, nenner);
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                + "periode_von, periode_bis, zeitzone, fassung, vorgang, status, betrag, herkunft_art, actor_sub, "
                + "actor_name, actor_rolle, actor_art, created_at) VALUES (?, ?, 'periodenwert', 'kg', 'monat', ?, ?, "
                + "'Europe/Berlin', 1, 'erstwert', 'wirksam', ?, 'eingabe', 'IK', 'Ines Kaltenbach', 'energiemanager', "
                + "'kunde', ?)", tenant, bz1, Date.valueOf(von), Date.valueOf(bis), nenner, am);
    }

    // ------------------------------------------------------------------ Lesen

    /** Kennzeichen → Name des Verantwortlichen je Objekt einer Art, in der Reihenfolge des Lesers. */
    private static Map<String, String> verantwortlich(JsonNode v, String art) {
        Map<String, String> aus = new LinkedHashMap<>();
        v.path("objekte").forEach(o -> {
            if (o.path("art").asText().equals(art)) {
                aus.put(o.path("kennzeichen").asText(), o.at("/verantwortlich/name").asText(null));
            }
        });
        return aus;
    }

    private static JsonNode objekt(JsonNode v, String art, String kennzeichen) {
        for (JsonNode o : v.path("objekte")) {
            if (o.path("art").asText().equals(art) && o.path("kennzeichen").asText().equals(kennzeichen)) return o;
        }
        throw new AssertionError(art + " " + kennzeichen + " fehlt");
    }

    private static String satz(JsonNode v, String aufgabe) {
        for (JsonNode a : v.path("aufgaben")) {
            if (a.path("aufgabe").asText().equals(aufgabe)) return a.path("satz").isNull() ? null : a.path("satz").asText();
        }
        throw new AssertionError(aufgabe + " fehlt");
    }

    private static List<String> texte(JsonNode liste) {
        List<String> aus = new ArrayList<>();
        liste.forEach(n -> aus.add(n.asText()));
        return aus;
    }

    private static List<String> texte(JsonNode liste, String feld) {
        List<String> aus = new ArrayList<>();
        liste.forEach(n -> aus.add(n.path(feld).asText()));
        return aus;
    }

    private static String id(JsonNode n) {
        return n.has("verlauf") ? n.at("/person/id").asText() : n.path("id").asText();
    }

    private void uhr(String jetzt) {
        kennzahlen.uhrStellen(Clock.fixed(Instant.parse(jetzt), ZoneOffset.UTC));
    }

    private Authentication token(String sub) {
        Jwt jwt = Jwt.withTokenValue("test").header("alg", "none").subject(sub).issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600)).claim("tenant_id", tenant.toString())
                .claim("realm_access", Map.of("roles", List.of())).claim("name", NAMEN.get(sub))
                .claim("preferred_username", NAMEN.get(sub)).build();
        return new KeycloakRealmRoleConverter().convert(jwt);
    }

    /**
     * Die Verzeichnis-Quelle direkt (ihr Leser ist IP-8) — im Kontext, den {@code ZugriffFilter} einer echten Anfrage
     * von Ines Kaltenbach aufbaut: Anmeldung, Mandant, Zugriff.
     */
    private <T> T alsIk(Supplier<T> lesen) {
        Authentication auth = token("IK");
        SecurityContextHolder.getContext().setAuthentication(auth);
        TenantContext.set(tenant);
        try {
            ZugriffKontextLader.Ergebnis e = lader.laden(auth, null);
            assertThat(e.zugriff()).isNotNull();
            ZugriffContext.set(e.zugriff());
            return lesen.get();
        } finally {
            ZugriffContext.clear();
            TenantContext.clear();
            SecurityContextHolder.clearContext();
        }
    }

    private JsonNode ruf(String method, String path, String sub, Object body, int status) throws Exception {
        var b = request(HttpMethod.valueOf(method), path).with(authentication(token(sub)));
        if (body != null) b.contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        var r = mvc.perform(b).andReturn().getResponse();
        assertThat(r.getStatus()).as(method + " " + path + " " + r.getContentAsString(StandardCharsets.UTF_8))
                .isEqualTo(status);
        return JSON.readTree(r.getContentAsString(StandardCharsets.UTF_8));
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
