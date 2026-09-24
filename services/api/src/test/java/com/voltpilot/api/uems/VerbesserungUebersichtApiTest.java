package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.sql.Date;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
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
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * UEMS AP-18 IP-19 (F1–F3, W7, R9, R13): der Übersichts-Leser {@code GET /api/v1/verbesserung/uebersicht} gegen die echte
 * Datenbank. Die Uhr ist die der Kennzahlen und wird gestellt — nie gelesen. R9: am 15.03.2028 ist M-2028-0002 (Termin
 * 29.02.2028) „überfällig seit 15 Tagen“; 1 überfällige und 1 umgesetzte Maßnahme ohne Bewertung, 1 laufendes
 * Energieziel, 0 offene Abweichungen und Auffälligkeiten. W7: der Messbedarf MB-1 zählt ab seiner Frist, ohne dass AP-16
 * etwas davon weiß. R13: ohne Vorgang ist jeder Zähler 0. Zaun: wer nur einen fremden Standort sieht, zählt nichts.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class VerbesserungUebersichtApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String PFAD = "/api/v1/verbesserung/uebersicht";
    private static final Instant ANGELEGT = Instant.parse("2028-01-15T09:00:00Z");
    private static final Instant MAERZ = Instant.parse("2028-03-15T09:00:00Z");

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
        // Der Stundentakt schreibt selbst Kennzahl-Zeilen — hier schreibt allein der Test.
        registry.add("voltpilot.uems.kennzahlen.enabled", () -> "false");
    }

    @Autowired
    MockMvc mvc;

    @Autowired
    KennzahlService kennzahlen;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID st1, UUID st2, UUID kz4, UUID ee3) {}

    private record Antwort(int status, JsonNode body, String text) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void uhrAmAnlegetag() {
        uhr(ANGELEGT);
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        kennzahlen.uhrStellen(Clock.systemUTC());
    }

    /**
     * R9: EZ-2028-0001 läuft, M-2028-0001 (mit Messgrundlage) ist am 22.01.2028 umgesetzt, M-2028-0002 (ohne
     * Messgrundlage, Termin 29.02.2028) ist geplant; MB-1 hat eine Frist nach dem Abruf. Am 15.03.2028 zählt die Übersicht
     * genau die Zahlen des Referenzfalls und nennt M-2028-0002 mit dem Satz aus §5.9. Danach W7 (MB-1 überfällig), eine
     * offene Auffälligkeit und eine überfällige Abweichung.
     */
    @Test
    void r9UeberfaelligSeit15TagenUndDieZaehler() throws Exception {
        Welt w = welt();
        uhr(Instant.parse("2027-12-20T09:00:00Z"));
        Antwort ziel = ruf(w, "ines", HttpMethod.POST, "/api/v1/energieziele", Map.of("kennzahl", w.kz4().toString(),
                "zielwert_prozent", new BigDecimal("-5.0"), "zielperiode", "2028-01/2028-12",
                "wortlaut", "Spritzguss: 5 % weniger Strom", "begruendung", "Energieziel für das Jahr 2028 gesetzt."));
        assertThat(ziel.status()).as(ziel.text()).isEqualTo(201);

        uhr(ANGELEGT);
        Map<String, Object> m1 = new LinkedHashMap<>();
        m1.put("titel", "Werkzeugheizungen in Betriebspausen abschalten");
        m1.put("verantwortlich", sub(w, "murat"));
        m1.put("termin", "2028-01-31");
        m1.put("herkunft", "von_hand");
        m1.put("kennzahl", w.kz4().toString());
        m1.put("monate", "2027-12");
        m1.put("erwartete_wirkung_prozent", new BigDecimal("-3"));
        m1.put("erwartete_wirkung_wortlaut", "Heizungen laufen etwa ein Fünftel der Zeit ohne Produktion.");
        Antwort a1 = ruf(w, "ines", HttpMethod.POST, "/api/v1/massnahmen", m1);
        assertThat(a1.status()).as(a1.text()).isEqualTo(201);
        assertThat(a1.body().get("kennzeichen").asText()).isEqualTo("M-2028-0001");

        Map<String, Object> m2 = new LinkedHashMap<>();
        m2.put("titel", "Druckluft-Leckagen orten und beseitigen");
        m2.put("verantwortlich", sub(w, "ines"));
        m2.put("termin", "2028-02-29");
        m2.put("herkunft", "einsatz");
        m2.put("einsatz", w.ee3().toString());
        m2.put("standort", w.st1().toString());
        m2.put("erwartete_wirkung_wortlaut", "Weniger Druckluft-Verluste im Netz.");
        Antwort a2 = ruf(w, "ines", HttpMethod.POST, "/api/v1/massnahmen", m2);
        assertThat(a2.status()).as(a2.text()).isEqualTo(201);
        assertThat(a2.body().get("kennzeichen").asText()).isEqualTo("M-2028-0002");

        uhr(Instant.parse("2028-01-22T09:00:00Z"));
        Antwort um = ruf(w, "ines", HttpMethod.POST, "/api/v1/massnahmen/" + a1.body().get("id").asText() + "/umgesetzt",
                Map.of("am", "2028-01-22", "begruendung", "Zeitschaltung an den Maschinen 3 bis 6 aktiv."));
        assertThat(um.status()).as(um.text()).isEqualTo(200);

        // W7: der Messbedarf von AP-16, direkt geschrieben — seine Frist liegt nach dem Abruf.
        root.update("INSERT INTO messbedarf (tenant_id, kennzeichen, einsatz_id, wortlaut, frist, actor_sub, actor_name, "
                + "actor_art) VALUES (?, 'MB-1', ?, 'Druckluft-Zähler am Kompressor', '2028-03-31', 'IK', 'Ines Kaltenbach', 'kunde')",
                w.mandant(), w.ee3());

        uhr(MAERZ);
        Antwort r9 = ruf(w, "ines", HttpMethod.GET, PFAD, null);
        assertThat(r9.status()).as(r9.text()).isEqualTo(200);
        JsonNode u = r9.body();
        assertThat(u.get("abruf").asText()).isEqualTo("2028-03-15");
        assertThat(zaehler(u)).containsExactlyEntriesOf(zaehler(0, 0, 0, 1, 1, 1, 1, 0, 0, 0));
        assertThat(u.get("faellig")).hasSize(1);
        JsonNode z = u.at("/faellig/0");
        assertThat(z.get("art").asText()).isEqualTo("massnahme");
        assertThat(z.get("id").asText()).isEqualTo(a2.body().get("id").asText());
        assertThat(z.get("kennzeichen").asText()).isEqualTo("M-2028-0002");
        assertThat(z.get("titel").asText()).isEqualTo("Druckluft-Leckagen orten und beseitigen");
        assertThat(z.get("termin").asText()).isEqualTo("2028-02-29");
        assertThat(z.get("faellig").asText()).isEqualTo("ueberfaellig");
        assertThat(z.get("seit_tagen").asInt()).isEqualTo(15);
        assertThat(z.get("verantwortlich").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(z.get("satz").asText())
                .isEqualTo("M-2028-0002 · geplant · Termin 29.02.2028 · überfällig seit 15 Tagen · Ines Kaltenbach.");
        assertThat(z.get("kennzahl_id").isNull()).isTrue();
        assertThat(z.get("einsatz_id").asText()).isEqualTo(w.ee3().toString());
        // Dieselbe Zeile wie im Maßnahmen-Register — die Übersicht rechnet nichts selbst.
        JsonNode register = ruf(w, "ines", HttpMethod.GET, "/api/v1/massnahmen?ueberfaellig=true", null).body();
        assertThat(register.at("/massnahmen/0/frist/satz").asText()).isEqualTo(z.get("satz").asText());

        // W7: MB-1 mit erreichter Frist zählt — ohne Umbau an AP-16; ein eingelöster oder fristloser Bedarf nicht.
        root.update("UPDATE messbedarf SET frist = '2028-03-15' WHERE tenant_id = ? AND kennzeichen = 'MB-1'", w.mandant());
        root.update("INSERT INTO messbedarf (tenant_id, kennzeichen, einsatz_id, wortlaut, actor_sub, actor_name, "
                + "actor_art) VALUES (?, 'MB-2', ?, 'Zähler ohne Frist', 'IK', 'Ines Kaltenbach', 'kunde')", w.mandant(), w.ee3());
        assertThat(zaehler(ruf(w, "ines", HttpMethod.GET, PFAD, null).body()).get("messbedarfe_ueberfaellig")).isEqualTo(1);

        // Eine offene Auffälligkeit und eine Abweichung mit Frist 01.03.2028 (überfällig seit 14 Tagen).
        UUID bb = root.queryForObject("SELECT id FROM bezugsbasis WHERE kennzahl_id = ?", UUID.class, w.kz4());
        root.update("INSERT INTO auffaelligkeit (tenant_id, kennzahl_id, bezugsbasis_id, fassung, periode, anlass, "
                + "anlass_pruefsumme) VALUES (?, ?, ?, 2, '2028-02', '{}', bericht_pruefsumme('{}'))", w.mandant(),
                w.kz4(), bb);
        root.update("INSERT INTO abweichung (tenant_id, kennzahl_id, bezugsbasis_id, fassung, monate, herkunft_art, "
                + "herkunft_wortlaut, anlass, anlass_pruefsumme, verantwortlich_sub, verantwortlich_name, "
                + "verantwortlich_konto, frist, actor_sub, actor_name, actor_art) VALUES (?, ?, ?, 2, '{2028-02}', "
                + "'von_hand', 'Februar auffällig hoch, von Hand eröffnet.', '{}', bericht_pruefsumme('{}'), ?, "
                + "'Ines Kaltenbach', 'benutzer', '2028-03-01', ?, 'Ines Kaltenbach', 'kunde')", w.mandant(), w.kz4(),
                bb, sub(w, "ines"), sub(w, "ines"));
        JsonNode danach = ruf(w, "ines", HttpMethod.GET, PFAD, null).body();
        assertThat(zaehler(danach)).containsExactlyEntriesOf(zaehler(1, 1, 1, 1, 1, 1, 1, 0, 0, 1));
        assertThat(danach.get("faellig")).hasSize(2);
        assertThat(danach.at("/faellig/0/kennzeichen").asText()).isEqualTo("M-2028-0002");
        JsonNode aw = danach.at("/faellig/1");
        assertThat(aw.get("art").asText()).isEqualTo("abweichung");
        assertThat(aw.get("seit_tagen").asInt()).isEqualTo(14);
        assertThat(aw.get("titel").asText()).isEqualTo("KZ-0004 Stromeinsatz Spritzguss je kg");
        assertThat(aw.get("kennzahl_id").asText()).isEqualTo(w.kz4().toString());
        assertThat(aw.get("satz").asText()).isEqualTo(aw.get("kennzeichen").asText()
                + " · offen · Termin 01.03.2028 · überfällig seit 14 Tagen · Ines Kaltenbach.");
    }

    /** R13: ein Kundenbereich ohne Kennzahl und ohne Vorgang — jeder Zähler 0, keine Zeile. */
    @Test
    void r13OhneVorgangAllesNull() throws Exception {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Bestand #" + nr);
        root.update("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, 'Bestandskunde', 'Europe/Berlin')", t);
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', "
                + "'Ines Kaltenbach', 'aktiv')", t, "sub-ines-" + t);
        uhr(MAERZ);
        Antwort a = ruf(new Welt(t, null, null, null, null), "ines", HttpMethod.GET, PFAD, null);
        assertThat(a.status()).as(a.text()).isEqualTo(200);
        assertThat(zaehler(a.body())).containsExactlyEntriesOf(zaehler(0, 0, 0, 0, 0, 0, 0, 0, 0, 0));
        assertThat(a.body().get("faellig")).isEmpty();
    }

    /**
     * Zaun: wer nur am Standort ST-2 liest, sieht weder die Maßnahme an ST-1 noch die Kennzahl in Halle 2 — alles 0;
     * ein anderer Kundenbereich sieht vom ersten nichts.
     */
    @Test
    void zaunFremderStandortUndFremderMandantZaehlenNichts() throws Exception {
        Welt w = welt();
        Map<String, Object> m2 = new LinkedHashMap<>();
        m2.put("titel", "Druckluft-Leckagen orten und beseitigen");
        m2.put("verantwortlich", sub(w, "ines"));
        m2.put("termin", "2028-02-29");
        m2.put("herkunft", "einsatz");
        m2.put("einsatz", w.ee3().toString());
        m2.put("standort", w.st1().toString());
        m2.put("erwartete_wirkung_wortlaut", "Weniger Druckluft-Verluste im Netz.");
        assertThat(ruf(w, "ines", HttpMethod.POST, "/api/v1/massnahmen", m2).status()).isEqualTo(201);
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', "
                + "'Lara Lindach', 'aktiv')", w.mandant(), sub(w, "lara"));
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, 'leser', ?, '2024-01-01', 'Europe/Berlin')", w.mandant(), sub(w, "lara"), w.st2());

        uhr(MAERZ);
        JsonNode ines = ruf(w, "ines", HttpMethod.GET, PFAD, null).body();
        assertThat(zaehler(ines).get("massnahmen_ueberfaellig")).isEqualTo(1);
        Antwort lara = ruf(w, "lara", HttpMethod.GET, PFAD, null);
        assertThat(lara.status()).as(lara.text()).isEqualTo(200);
        assertThat(zaehler(lara.body())).containsExactlyEntriesOf(zaehler(0, 0, 0, 0, 0, 0, 0, 0, 0, 0));
        assertThat(lara.body().get("faellig")).isEmpty();

        Welt fremd = welt();
        assertThat(zaehler(ruf(fremd, "ines", HttpMethod.GET, PFAD, null).body()))
                .containsExactlyEntriesOf(zaehler(0, 0, 0, 0, 0, 0, 0, 0, 0, 0));
    }

    private static final List<String> ZAEHLER = List.of("auffaelligkeiten_offen", "abweichungen_offen",
            "abweichungen_ueberfaellig", "massnahmen_geplant", "massnahmen_ueberfaellig",
            "massnahmen_umgesetzt_ohne_bewertung", "energieziele_laufend", "energieziele_bewertung_faellig",
            "anstoesse_offen", "messbedarfe_ueberfaellig");

    private static Map<String, Integer> zaehler(int... werte) {
        Map<String, Integer> m = new LinkedHashMap<>();
        for (int i = 0; i < werte.length; i++) {
            m.put(ZAEHLER.get(i), werte[i]);
        }
        return m;
    }

    private static Map<String, Integer> zaehler(JsonNode uebersicht) {
        Map<String, Integer> m = new LinkedHashMap<>();
        uebersicht.get("zaehler").fields().forEachRemaining(e -> m.put(e.getKey(), e.getValue().asInt()));
        return m;
    }

    private static String sub(Welt w, String person) {
        return "sub-" + person + "-" + w.mandant();
    }

    private void uhr(Instant jetzt) {
        kennzahlen.uhrStellen(Clock.fixed(jetzt, ZoneOffset.UTC));
    }

    private Welt welt() throws Exception {
        // Kennzahl und Bezugsbasis entstehen vor den Monaten, die sie lesen; danach wieder der Anlegetag.
        uhr(Instant.parse("2026-10-01T09:00:00Z"));
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Übersicht #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID st1 = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        UUID st2 = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Lindach', 'ST-2', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        UUID g2 = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, 'gebaeude', "
                + "'Halle 2', 'G-2', 'aktiv') RETURNING id", UUID.class, t);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2020-01-01')", t, g2, st1);
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-20', 'Spritzguss', 'gemessen', 'Strom', 'Wirkenergie', "
                + "'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, t);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, NULL, '2020-01-01')", t, ms, g2);
        UUID bz1 = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, "
                + "periode_art, geltung_art, ort_id) VALUES (?, 'BZ-1', 'Produktionsmenge Spritzguss', 'periodenwert', "
                + "'kg', 'monat', 'gebaeude', ?) RETURNING id", UUID.class, t, g2);
        String[][] personen = {{"ines", "Ines Kaltenbach", null, "aktiv"}, {"peter", "Peter Hollerbach", "bearbeiter", "aktiv"},
            {"murat", "Murat Demirci", "bedienberechtigt", "aktiv"}, {"olga", "Olga Alt", null, "entfernt"}};
        for (String[] p : personen) {
            String sub = "sub-" + p[0] + "-" + t;
            root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', ?, ?)",
                    t, sub, p[1], p[3]);
            if (p[2] != null) {
                root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                        + "VALUES (?, ?, ?, ?, '2024-01-01', 'Europe/Berlin')", t, sub, p[2], st1);
            }
        }
        Welt ohne = new Welt(t, st1, st2, null, null);
        UUID kz4 = kennzahl(ohne, g2);
        // R3 „gegeben“: Dezember 2027 78 000 kWh bei 250 000 kg, endgültig am 07.01.2028.
        monat(t, kz4, bz1, "2027-12-01", "78000", "250000");

        UUID p3 = root.queryForObject("INSERT INTO prozess (tenant_id, unternehmen_id, kennzeichen, name, gueltig_ab) "
                + "VALUES (?, ?, 'P-3', 'Druckluft', '2024-01-01') RETURNING id", UUID.class, t, u);
        UUID ee3 = root.queryForObject("INSERT INTO energieeinsatz (tenant_id, kennzeichen, prozess_id, traeger, name, "
                + "gueltig_ab, actor_sub, actor_name, actor_art) VALUES (?, 'EE-3', ?, 'Druckluft', 'Druckluft', "
                + "'2026-10-01', 'IK', 'Ines Kaltenbach', 'kunde') RETURNING id", UUID.class, t, p3);
        root.update("INSERT INTO energieeinsatz_einflussgroesse (tenant_id, einsatz_id, wortlaut, art, position) "
                + "VALUES (?, ?, 'Betriebsstunde', 'betriebszeit', 0)", t, ee3);

        Welt w = new Welt(t, st1, st2, kz4, ee3);
        TenantContext.set(t);
        UUID bb1 = basis(w, kz4);
        fassung(t, bb1, 1, bz1, "verhaeltnis", "2026-10/2026-10", "2026-11-01", "2027-10-31", "0.2837", null, null,
                null, null);
        fassung(t, bb1, 2, bz1, "regression_eine_variable", "2026-11/2027-10", "2027-11-01", null, "0.2685",
                "{\"a\": 10523, \"b\": 0.2343}", "0.8", "254000", "341000");
        TenantContext.clear();
        uhr(ANGELEGT);
        return w;
    }

    /** Eine endgültige Monatszeile der Kennzahl (Version 1) und der Bezugsgrößen-Wert (Fassung 1). */
    private static void monat(UUID t, UUID kennzahl, UUID bz, String erster, String zaehlerText, String nennerText) {
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
                + "'vollständig', NULL, '[]'::jsonb, 'endgueltig', ?, ?, ?)", wert, t, kennzahl,
                Date.valueOf(von), Date.valueOf(bis), zaehler.divide(nenner, 20, RoundingMode.HALF_UP), zaehler, nenner,
                endgueltig, fassung, am);
        root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + "messstelle_id, wert, einheit, menge_zustand, version) VALUES (?, ?, ?, 0, 'zaehler', 'messstelle', "
                + "'MS-20', (SELECT id FROM messstelle WHERE tenant_id = ? AND kennzeichen = 'MS-20'), ?, 'kWh', "
                + "'vollständig', 1)", t, wert, kennzahl, t, zaehler);
        root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + "bezugsgroesse_id, wert, einheit, menge_zustand, fassung) VALUES (?, ?, ?, 1, 'nenner', 'bezugsgroesse', "
                + "'BZ-1', ?, ?, 'kg', 'vollständig', 1)", t, wert, kennzahl, bz, nenner);
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                + "periode_von, periode_bis, zeitzone, fassung, vorgang, status, betrag, herkunft_art, actor_sub, "
                + "actor_name, actor_rolle, actor_art, created_at) VALUES (?, ?, 'periodenwert', 'kg', 'monat', ?, ?, "
                + "'Europe/Berlin', 1, 'erstwert', 'wirksam', ?, 'eingabe', 'IK', 'Ines Kaltenbach', 'energiemanager', "
                + "'kunde', ?)", t, bz, Date.valueOf(von), Date.valueOf(bis), nenner, am);
    }

    /** Die Bezugsbasis über die Route von AP-17 IP-7 (BB-…). */
    private UUID basis(Welt w, UUID kennzahl) throws Exception {
        Antwort a = ruf(w, "ines", HttpMethod.POST, "/api/v1/kennzahlen/" + kennzahl + "/bezugsbasen", null);
        assertThat(a.status()).as(a.text()).isEqualTo(201);
        return UUID.fromString(a.body().get("id").asText());
    }

    /** Eine freigegebene Fassung, direkt geschrieben (Muster EnergiezielApiTest); Fassung 1 ist beendet. */
    private static void fassung(UUID t, UUID basis, int nummer, UUID bz, String methode, String referenzperiode,
            String giltAb, String giltBis, String basiswert, String koeffizienten, String streuung, String von,
            String bis) {
        UUID f = root.queryForObject("INSERT INTO bezugsbasis_fassung (tenant_id, bezugsbasis_id, fassung, referenzperiode, "
                + "methode, datenlage, gilt_ab, gilt_bis, beendet_am, beendet_grund, toleranz_prozent, anpassungsgruende, "
                + "begruendung, basiswert, koeffizienten, streuung_prozent, actor_sub, actor_name, actor_rolle, actor_art, "
                + "freigabe_status, freigabe_sub, freigabe_name, freigabe_rolle, freigabe_art, freigabe_am, freigegeben_am) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2.0, ?::text[], 'Freigabe im Übersicht-Test.', ?, ?::jsonb, ?, "
                + "'IK', 'Ines Kaltenbach', 'energiemanager', 'kunde', 'freigegeben', 'IK', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde', now(), now()) RETURNING id", UUID.class, t, basis, nummer, referenzperiode,
                methode, nummer == 1 ? "vorlaeufig" : "vollstaendig", Date.valueOf(giltAb),
                giltBis == null ? null : Date.valueOf(giltBis), giltBis == null ? null : Timestamp.from(ANGELEGT),
                giltBis == null ? null : "Fassung 2 ersetzt das Verhältnis.",
                nummer > 1 ? "{referenzperiode_vervollstaendigt}" : "{}", new BigDecimal(basiswert), koeffizienten,
                streuung == null ? null : new BigDecimal(streuung));
        root.update("INSERT INTO bezugsbasis_variable (tenant_id, fassung_id, position, bezugsgroesse_id, "
                + "bezugsgroesse_fassung, spannweite_von, spannweite_bis) VALUES (?, ?, 1, ?, 1, ?, ?)", t, f, bz,
                von == null ? null : new BigDecimal(von), bis == null ? null : new BigDecimal(bis));
    }

    private UUID kennzahl(Welt w, UUID gebaeude) throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", "KZ-0004");
        m.put("name", "Stromeinsatz Spritzguss je kg");
        m.put("rechenform", "quotient");
        m.put("geltung_art", "gebaeude");
        m.put("geltung_id", gebaeude.toString());
        m.put("eingaenge", List.of(Map.of("rolle", "zaehler", "art", "messstelle", "kennzeichen", "MS-20"),
                Map.of("rolle", "nenner", "art", "bezugsgroesse", "kennzeichen", "BZ-1")));
        Antwort a = ruf(w, "ines", HttpMethod.POST, "/api/v1/kennzahlen", m);
        assertThat(a.status()).as("KZ-0004 " + a.text()).isEqualTo(201);
        return UUID.fromString(a.body().get("id").asText());
    }

    private static final Map<String, String> NAMEN = Map.of("ines", "Ines Kaltenbach", "peter", "Peter Hollerbach",
            "murat", "Murat Demirci", "olga", "Olga Alt", "lara", "Lara Lindach");

    private Antwort ruf(Welt w, String person, HttpMethod methode, String pfad, Object body) throws Exception {
        // Über den Rollen-Konverter wie in Produktion: erst so entsteht der Zugriff-Kontext (Rolle je Standort).
        Jwt token = Jwt.withTokenValue("test").header("alg", "none").subject(sub(w, person)).issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600)).claim("tenant_id", w.mandant().toString())
                .claim("realm_access", Map.of("roles", List.of())).claim("name", NAMEN.get(person))
                .claim("preferred_username", NAMEN.get(person)).build();
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(authentication(new KeycloakRealmRoleConverter().convert(token)))
                .contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text),
                text);
    }
}
