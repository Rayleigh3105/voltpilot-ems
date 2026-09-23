package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.tenant.TenantContext;
import java.nio.charset.StandardCharsets;
import java.sql.Date;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
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
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
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
 * Wiedervorlage, „geprüft, bleibt“, Beenden und Übersicht (UEMS AP-17 IP-17) gegen die echte Kette — Referenzfall R13:
 * BB-0001 Fassung 2 (freigegeben am 24.11.2027, Wiedervorlage 12 Monate) ist am 25.11.2028 „fällig seit 1 Tag“, ohne
 * Läufer; „bleibt“ setzt die Frist neu und lässt die Fassung byte-gleich; die Archivierung von KZ-0004 beendet die Basis
 * am selben Tag. Die Fassungen legt der Test direkt an (die Freigabe-Route ist IP-8), der Stichtag ist die Uhr der
 * Kennzahl ({@link KennzahlService#uhrStellen}).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class BezugsbasisPflegeApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    /** 25.11.2028, 11:00 in Berlin: ein Tag nach der Frist der Fassung 2. */
    private static final Instant R13 = Instant.parse("2028-11-25T10:00:00Z");

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
    KennzahlService kennzahlen;

    @MockBean
    KennzahlAufrufer aufrufer;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID kennzahl, UUID basis, UUID fassung2) {}

    private record Antwort(int status, JsonNode body) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void stichtag() {
        doAnswer(inv -> KorrekturRechte.benutzer(inv.getArgument(0))).when(aufrufer).benutzer(any());
        kennzahlen.uhrStellen(Clock.fixed(R13, ZoneOffset.UTC));
    }

    @AfterEach
    void aufraeumen() {
        kennzahlen.uhrStellen(Clock.systemUTC());
        TenantContext.clear();
    }

    // ================================================================ R13: Frist, bleibt

    @Test
    void r13FaelligSeitEinemTagOhneLaeuferUndBleibtSetztDieFristNeu() throws Exception {
        Welt w = welt();
        Antwort u = ruf(w, HttpMethod.GET, "/api/v1/bezugsbasen/uebersicht", null);
        assertThat(u.status()).isEqualTo(200);
        assertThat(u.body().path("stichtag").asText()).isEqualTo("2028-11-25");
        assertThat(u.body().path("laufend").asInt()).isEqualTo(1);
        assertThat(u.body().path("freigegeben").asInt()).isEqualTo(1);
        assertThat(u.body().path("vorlaeufig").asInt()).isZero();
        assertThat(u.body().path("mit_anstoss").asInt()).isEqualTo(1);
        assertThat(u.body().path("ueberpruefung_faellig").asInt()).isEqualTo(1);
        JsonNode f = u.body().path("faellig").get(0);
        assertThat(f.path("kennzeichen").asText()).isEqualTo("BB-0001");
        assertThat(f.path("kennzahl_kennzeichen").asText()).isEqualTo("KZ-0004");
        assertThat(f.path("fassung").asInt()).isEqualTo(2);
        assertThat(f.path("freigegeben_am").asText()).isEqualTo("2027-11-24");
        assertThat(f.path("faellig_am").asText()).isEqualTo("2028-11-24");
        assertThat(f.path("faellig_seit_tagen").asInt()).isEqualTo(1);
        assertThat(f.path("zustand").asText()).isEqualTo("ueberpruefung_faellig");
        assertThat(protokoll(w)).isZero();

        String vorher = fassungText(w.fassung2());
        String bleibt = "/api/v1/kennzahlen/" + w.kennzahl() + "/bezugsbasen/" + w.basis() + "/bleibt";
        Antwort kurz = ruf(w, HttpMethod.POST, bleibt, Map.of("begruendung", "passt"));
        assertThat(kurz.status()).isEqualTo(422);
        assertThat(kurz.body().path("code").asText()).isEqualTo("begruendung_fehlt");
        assertThat(ruf(w, HttpMethod.POST, bleibt, Map.of("begruendung", "Produktion unverändert, Basis trägt weiter",
                "grund", "sonstiger")).status()).isEqualTo(400);
        assertThat(protokoll(w)).isZero();

        Antwort ok = ruf(w, HttpMethod.POST, bleibt, Map.of("begruendung", "Produktion unverändert, Basis trägt weiter"));
        assertThat(ok.status()).isEqualTo(200);
        assertThat(ok.body().path("zustand").asText()).isEqualTo("freigegeben");
        assertThat(ok.body().path("faellig_am").asText()).isEqualTo("2029-11-25");
        assertThat(ok.body().path("faellig_seit_tagen").isNull()).isTrue();
        assertThat(ok.body().path("anstoss_liegt_vor").asBoolean()).isFalse();
        // Die Fassung bleibt byte-gleich — nur die Frist wandert, und sie steht im Protokoll.
        assertThat(fassungText(w.fassung2())).isEqualTo(vorher);
        assertThat(root.queryForMap("SELECT art, fassung, begruendung, neu->>'faellig_am' AS faellig, created_at "
                + "FROM bezugsbasis_aenderung WHERE bezugsbasis_id = ?", w.basis()))
                .containsEntry("art", "gueltig_bleibt").containsEntry("fassung", 2)
                .containsEntry("begruendung", "Produktion unverändert, Basis trägt weiter")
                .containsEntry("faellig", "2029-11-25").containsEntry("created_at", Timestamp.from(R13));
        assertThat(root.queryForObject("SELECT antwort FROM bezugsbasis_anstoss WHERE fassung_id = ?", String.class,
                w.fassung2())).isEqualTo("bleibt");

        Antwort danach = ruf(w, HttpMethod.GET, "/api/v1/bezugsbasen/uebersicht", null);
        assertThat(danach.body().path("ueberpruefung_faellig").asInt()).isZero();
        assertThat(danach.body().path("mit_anstoss").asInt()).isZero();
        assertThat(danach.body().path("faellig").size()).isZero();
    }

    // ================================================================ F4: beenden

    @Test
    void beendenMitTagGrundUndBegruendungGenauEinmal() throws Exception {
        Welt w = welt();
        String pfad = "/api/v1/kennzahlen/" + w.kennzahl() + "/bezugsbasen/" + w.basis() + "/beenden";
        String text = "Anbau Halle 2 ändert die Struktur";
        assertThat(ruf(w, HttpMethod.POST, pfad, Map.of("tag", "2028-11-01", "grund", "struktur_geaendert",
                "begruendung", text)).body().path("code").asText()).isEqualTo("rueckwirkend_fehlt");
        assertThat(ruf(w, HttpMethod.POST, pfad, Map.of("tag", "2028-12-31", "grund", "kennzahl_archiviert",
                "begruendung", text)).body().path("code").asText()).isEqualTo("grund_unbekannt");
        assertThat(ruf(w, HttpMethod.POST, pfad, Map.of("tag", "2027-10-31", "grund", "struktur_geaendert",
                "begruendung", text, "rueckwirkend", true)).body().path("code").asText()).isEqualTo("tag_vor_fassung");
        assertThat(ruf(w, HttpMethod.POST, pfad, Map.of("tag", "31.12.2028", "grund", "struktur_geaendert",
                "begruendung", text)).status()).isEqualTo(400);
        assertThat(protokoll(w)).isZero();

        Antwort ok = ruf(w, HttpMethod.POST, pfad, Map.of("tag", "2028-12-31", "grund", "struktur_geaendert",
                "begruendung", text));
        assertThat(ok.status()).isEqualTo(200);
        assertThat(ok.body().path("zustand").asText()).isEqualTo("beendet");
        assertThat(ok.body().path("beendet_zum").asText()).isEqualTo("2028-12-31");
        assertThat(ok.body().path("beendet_grund").asText()).isEqualTo("struktur_geaendert");
        assertThat(root.queryForObject("SELECT gilt_bis FROM bezugsbasis_fassung WHERE id = ?", Date.class,
                w.fassung2())).isEqualTo(Date.valueOf("2028-12-31"));
        assertThat(root.queryForObject("SELECT antwort FROM bezugsbasis_anstoss WHERE fassung_id = ?", String.class,
                w.fassung2())).isEqualTo("beendet");
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsbasis_aenderung WHERE bezugsbasis_id = ? "
                + "AND art = 'bezugsbasis_beendet' AND begruendung = ?", Integer.class, w.basis(), text)).isEqualTo(1);

        Antwort zweimal = ruf(w, HttpMethod.POST, pfad, Map.of("tag", "2029-01-31", "grund", "sonstiger",
                "begruendung", text));
        assertThat(zweimal.status()).isEqualTo(409);
        assertThat(zweimal.body().path("code").asText()).isEqualTo("bezugsbasis_beendet");
        assertThat(zweimal.body().path("message").asText()).isEqualTo("Nicht bewertbar: Bezugsbasis beendet am 31.12.2028.");
        assertThat(ruf(w, HttpMethod.GET, "/api/v1/bezugsbasen/uebersicht", null).body().path("laufend").asInt()).isZero();
        // B1: nach dem Ende darf die Kennzahl eine neue Basis bekommen; die alte bleibt (nie gelöscht).
        basis(w.mandant(), w.kennzahl());
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsbasis WHERE kennzahl_id = ?", Integer.class,
                w.kennzahl())).isEqualTo(2);
    }

    // ================================================================ F4: Naht an der Archivierung

    @Test
    void archivierungDerKennzahlBeendetDieBasisAmSelbenTag() throws Exception {
        Welt w = welt();
        Antwort a = ruf(w, HttpMethod.POST, "/api/v1/kennzahlen/" + w.kennzahl() + "/archivieren", null);
        assertThat(a.status()).isEqualTo(200);
        assertThat(root.queryForMap("SELECT beendet_zum, beendet_grund FROM bezugsbasis WHERE id = ?", w.basis()))
                .containsEntry("beendet_zum", Date.valueOf("2028-11-25"))
                .containsEntry("beendet_grund", "nicht_mehr_anwendbar");
        assertThat(root.queryForObject("SELECT gilt_bis FROM bezugsbasis_fassung WHERE id = ?", Date.class,
                w.fassung2())).isEqualTo(Date.valueOf("2028-11-25"));
        assertThat(root.queryForMap("SELECT art, fassung, begruendung, neu->>'grund' AS grund FROM bezugsbasis_aenderung "
                + "WHERE bezugsbasis_id = ?", w.basis())).containsEntry("art", "bezugsbasis_beendet")
                .containsEntry("fassung", 2).containsEntry("begruendung", "Kennzahl archiviert")
                .containsEntry("grund", "nicht_mehr_anwendbar");
        Antwort u = ruf(w, HttpMethod.GET, "/api/v1/bezugsbasen/uebersicht", null);
        assertThat(u.body().path("laufend").asInt()).isZero();
        assertThat(u.body().path("ueberpruefung_faellig").asInt()).isZero();
    }

    // ================================================================ R10: Bestand

    @Test
    void ohneBezugsbasisIstDieUebersichtLeerUndDieArchivierungWieBisher() throws Exception {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Bestand #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, 'Bestand GmbH', "
                + "'Europe/Berlin') RETURNING id", UUID.class, t);
        benutzer(t);
        UUID kz = kennzahl(t, u);
        Welt w = new Welt(t, kz, null, null);
        Antwort leer = ruf(w, HttpMethod.GET, "/api/v1/bezugsbasen/uebersicht", null);
        assertThat(leer.status()).isEqualTo(200);
        assertThat(leer.body().path("laufend").asInt()).isZero();
        assertThat(leer.body().path("faellig").size()).isZero();
        assertThat(ruf(w, HttpMethod.POST, "/api/v1/kennzahlen/" + kz + "/archivieren", null).status()).isEqualTo(200);
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsbasis_aenderung WHERE tenant_id = ?", Integer.class, t))
                .isZero();
    }

    // ================================================================ Gerüst

    /** Kunststoffwerk Ahrenberg, KZ-0004 mit BB-0001: Fassung 1 (beendet 31.10.2027), Fassung 2 (R13), ein Anstoß. */
    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "R13 #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, "
                + "'Kunststoffwerk Ahrenberg GmbH', 'Europe/Berlin') RETURNING id", UUID.class, t);
        benutzer(t);
        UUID kz = kennzahl(t, u);
        UUID bb = basis(t, kz);
        fassung(t, bb, 1, "2026-10/2026-10", "vorlaeufig", "2026-11-01", "2026-11-12 10:00:00", "2027-10-31", null);
        UUID f2 = fassung(t, bb, 2, "2026-11/2027-10", "vollstaendig", "2027-11-01", "2027-11-24 10:00:00", null,
                "{referenzperiode_vervollstaendigt}");
        root.update("INSERT INTO bezugsbasis_anstoss (tenant_id, fassung_id, pfad, art, anlass_kennung, anlass) "
                + "VALUES (?, ?, 1, 'grundlage_korrigiert', 'K-2028-0001', 'Korrektur Oktober 2027')", t, f2);
        return new Welt(t, kz, bb, f2);
    }

    private static void benutzer(UUID t) {
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', "
                + "'Ines Kaltenbach', 'aktiv')", t, "sub-ines-" + t);
    }

    private static UUID kennzahl(UUID t, UUID u) {
        return root.queryForObject("INSERT INTO kennzahl (tenant_id, kennzeichen, name, rechenform, geltung_art, "
                + "unternehmen_id, verantwortlich_sub, verantwortlich_name) VALUES (?, 'KZ-0004', "
                + "'Stromeinsatz Spritzguss je kg', 'quotient', 'unternehmen', ?, ?, 'Ines Kaltenbach') RETURNING id",
                UUID.class, t, u, "sub-ines-" + t);
    }

    private static UUID basis(UUID t, UUID kz) {
        return root.queryForObject("INSERT INTO bezugsbasis (tenant_id, kennzahl_id, verantwortlich_name, actor_sub, "
                + "actor_name, actor_rolle, actor_art) VALUES (?, ?, 'Ines Kaltenbach', ?, 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde') RETURNING id", UUID.class, t, kz, "sub-ines-" + t);
    }

    private static UUID fassung(UUID t, UUID bb, int nr, String periode, String datenlage, String giltAb,
            String freigegeben, String giltBis, String gruende) {
        Timestamp am = Timestamp.from(java.time.LocalDateTime.parse(freigegeben.replace(' ', 'T'))
                .atZone(java.time.ZoneId.of("Europe/Berlin")).toInstant());
        return root.queryForObject("INSERT INTO bezugsbasis_fassung (tenant_id, bezugsbasis_id, fassung, referenzperiode, "
                + "methode, datenlage, gilt_ab, gilt_bis, beendet_am, beendet_grund, anpassungsgruende, begruendung, "
                + "actor_sub, actor_name, actor_rolle, actor_art, freigabe_status, freigabe_sub, freigabe_name, "
                + "freigabe_rolle, freigabe_art, freigabe_am, freigegeben_am) VALUES (?, ?, ?, ?, 'verhaeltnis', ?, "
                + "?::date, ?::date, ?, ?, coalesce(?::text[], '{}'), 'Referenzperiode geprüft und freigegeben', "
                + "'IK', 'Ines Kaltenbach', 'energiemanager', 'kunde', 'freigegeben', 'IK', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde', ?, ?) RETURNING id", UUID.class, t, bb, nr, periode, datenlage, giltAb,
                giltBis, giltBis == null ? null : am, giltBis == null ? null : "referenzperiode_vervollstaendigt",
                gruende, am, am);
    }

    private static String fassungText(UUID fassung) {
        return root.queryForObject("SELECT to_jsonb(f)::text FROM bezugsbasis_fassung f WHERE id = ?", String.class,
                fassung);
    }

    private static int protokoll(Welt w) {
        return root.queryForObject("SELECT count(*) FROM bezugsbasis_aenderung WHERE bezugsbasis_id = ?", Integer.class,
                w.basis());
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
