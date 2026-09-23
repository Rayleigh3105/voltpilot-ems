package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
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
 * Der Schreibweg zum Wetter-Archiv (UEMS AP-17 IP-12c, E9 = C): {@code PUT/DELETE …/wetterbezug} bindet eine
 * Gradtagzahl an das Archiv und löst sie (Werte bleiben); ohne Koordinaten 422 mit dem Satz aus §5.8 (Lindach), falsche
 * Art 422, Kanalbindung oder Import-Werte 409, fremder Kundenbereich 404. Die Leser: an der Bezugsgröße Bindung, letzter
 * Abruf und „x von y Tagen“, am Standort die Zeile „Wetter“.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class UemsWetterbezugApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String PFAD = "/api/v1/bezugsgroessen/";
    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    // Wie UemsWetterArchivAbrufTest: der Takt am Ersten dieses Monats 06:10, der Vormonat ist ganz vorbei.
    private static final LocalDate ERSTER = LocalDate.now(ZONE).withDayOfMonth(1);
    private static final Instant TAKT = ERSTER.atTime(6, 10).atZone(ZONE).toInstant();
    private static final LocalDate MONAT = ERSTER.minusMonths(1);
    private static final String LINDACH = "Für den Standort Lindach kann VoltPilot kein Wetter beziehen: die Koordinaten "
            + "fehlen. Eine Wetterbereinigung über Gradtage ist hier erst möglich, wenn der Standort Koordinaten hat.";

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
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate admin;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID standort, UUID anlage) {}

    private record Antwort(int status, JsonNode body) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    // ================================================================ binden, lesen, lösen

    @Test
    void bindenOhneAbrufDannStandXVonYTagenUndLoesenLaesstDieWerte() throws Exception {
        Welt w = welt(true);
        UUID bz = gradtagzahl(w, "tag");
        Antwort vorher = ruf(w, HttpMethod.GET, PFAD + bz + "/wetterbezug", null);
        assertThat(vorher.status()).isEqualTo(200);
        assertThat(vorher.body().path("moeglich").asBoolean()).isTrue();
        assertThat(vorher.body().path("koordinaten").asBoolean()).isTrue();
        assertThat(vorher.body().path("bindung").isNull()).isTrue();

        Antwort a = ruf(w, HttpMethod.PUT, PFAD + bz + "/wetterbezug", Map.of("von", MONAT.toString()));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        assertThat(a.body().at("/bindung/regel").asText()).isEqualTo("Gradtage G20/15");
        assertThat(a.body().at("/bindung/von").asText()).isEqualTo(MONAT.toString());
        assertThat(a.body().at("/bindung/letzter_abruf").isMissingNode()).as("Binden ruft nichts ab").isTrue();
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsgroesse_wert WHERE bezugsgroesse_id = ?", Long.class, bz))
                .isZero();
        assertThat(ruf(w, HttpMethod.PUT, PFAD + bz + "/wetterbezug", Map.of("von", MONAT.toString())).status())
                .as("dieselbe Bindung noch einmal: idempotent").isEqualTo(200);
        Antwort anders = ruf(w, HttpMethod.PUT, PFAD + bz + "/wetterbezug",
                Map.of("von", MONAT.toString(), "heizgrenze", 12));
        assertThat(anders.status()).isEqualTo(409);
        assertThat(anders.body().path("code").asText()).isEqualTo("wetterbezug_vorhanden");
        assertThat(protokoll(bz, "wetter_gebunden")).isEqualTo(1);
        Antwort kanal = ruf(w, HttpMethod.POST, PFAD + bz + "/kanalbindung",
                Map.of("entity_id", UUID.randomUUID().toString(), "kanal", "aussen.temperatur",
                        "von", ERSTER.atStartOfDay(ZONE).toInstant().toString()));
        assertThat(kanal.status()).as("umgekehrt: am Wetterbezug kein Messkanal").isEqualTo(409);
        assertThat(kanal.body().path("code").asText()).isEqualTo("wetterbezug_vorhanden");

        // Der Läufer holt: der Vormonat mit vier Ausfall-Tagen → „(y − 4) von y Tagen“, Quelle und letzter Abruf.
        Map<LocalDate, BigDecimal> daten = new TreeMap<>();
        for (LocalDate t = MONAT; t.isBefore(ERSTER); t = t.plusDays(1)) daten.put(t, new BigDecimal("5.0"));
        for (int d : new int[] {3, 4, 5, 6}) daten.remove(MONAT.withDayOfMonth(d));
        new WetterArchivAbruf(admin, MAPPER, (breite, laenge, von, bis, zone) ->
                new WetterArchiv.Abruf(OpenMeteoWetterArchiv.QUELLE, TAKT, daten, null)).lauf(TAKT, w.mandant());
        int y = MONAT.lengthOfMonth();
        Antwort stand = ruf(w, HttpMethod.GET, PFAD + bz + "/wetterbezug", null);
        assertThat(stand.body().at("/bindung/quelle").asText()).isEqualTo("Open-Meteo-Archiv");
        assertThat(Instant.parse(stand.body().at("/bindung/letzter_abruf").asText())).isEqualTo(TAKT);
        assertThat(stand.body().at("/bindung/stand/monat").asText()).isEqualTo(MONAT.toString().substring(0, 7));
        assertThat(stand.body().at("/bindung/stand/tage").asInt()).isEqualTo(y - 4);
        assertThat(stand.body().at("/bindung/stand/tage_erwartet").asInt()).isEqualTo(y);
        assertThat(stand.body().at("/bindung/stand/zustand").asText()).isEqualTo("unvollständig");

        Antwort standort = ruf(w, HttpMethod.GET, "/api/v1/standorte/" + w.standort() + "/wetter", null);
        assertThat(standort.status()).isEqualTo(200);
        assertThat(standort.body().path("koordinaten").asBoolean()).isTrue();
        assertThat(standort.body().path("satz").isMissingNode()).isTrue();
        assertThat(standort.body().path("gradtagzahlen")).hasSize(1);
        assertThat(standort.body().at("/gradtagzahlen/0/kennzeichen").asText()).isEqualTo("BZ-8");
        assertThat(standort.body().path("quelle").asText()).isEqualTo("Open-Meteo-Archiv");

        Antwort geloest = ruf(w, HttpMethod.DELETE, PFAD + bz + "/wetterbezug", null);
        assertThat(geloest.status()).isEqualTo(204);
        assertThat(ruf(w, HttpMethod.GET, PFAD + bz + "/wetterbezug", null).body().path("bindung").isNull()).isTrue();
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsgroesse_wert WHERE bezugsgroesse_id = ?", Long.class, bz))
                .as("die bezogenen Werte bleiben").isEqualTo((long) (y - 4));
        assertThat(protokoll(bz, "wetter_geloest")).isEqualTo(1);
        assertThat(ruf(w, HttpMethod.DELETE, PFAD + bz + "/wetterbezug", null).status()).as("ohne Bindung: nichts")
                .isEqualTo(204);
        assertThat(protokoll(bz, "wetter_geloest")).isEqualTo(1);
        assertThat(ruf(w, HttpMethod.GET, "/api/v1/standorte/" + w.standort() + "/wetter", null).body()
                .path("gradtagzahlen")).isEmpty();
    }

    // ================================================================ Ablehnungen

    @Test
    void ohneKoordinaten422MitDemSatzAusParagraf58() throws Exception {
        Welt w = welt(false);
        UUID bz = gradtagzahl(w, "monat");
        Antwort a = ruf(w, HttpMethod.PUT, PFAD + bz + "/wetterbezug", Map.of("von", MONAT.toString()));
        assertThat(a.status()).isEqualTo(422);
        assertThat(a.body().path("code").asText()).isEqualTo("koordinaten_fehlen");
        assertThat(a.body().path("message").asText()).isEqualTo(LINDACH);
        Antwort sicht = ruf(w, HttpMethod.GET, PFAD + bz + "/wetterbezug", null);
        assertThat(sicht.body().path("koordinaten").asBoolean()).isFalse();
        assertThat(sicht.body().path("satz").asText()).isEqualTo(LINDACH);
        Antwort standort = ruf(w, HttpMethod.GET, "/api/v1/standorte/" + w.standort() + "/wetter", null);
        assertThat(standort.body().path("koordinaten").asBoolean()).isFalse();
        assertThat(standort.body().path("satz").asText()).isEqualTo(LINDACH);
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsgroesse_wetterbezug WHERE bezugsgroesse_id = ?",
                Long.class, bz)).isZero();
    }

    @Test
    void falscheArtFalscheGrenzenUndFalschesVon422() throws Exception {
        Welt w = welt(true);
        UUID menge = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, "
                + "periode_art, geltung_art, standort_id, art) VALUES (?, 'BZ-1', 'Produktionsmenge', 'periodenwert', 't', "
                + "'monat', 'standort', ?, 'produktionsmenge') RETURNING id", UUID.class, w.mandant(), w.standort());
        Antwort art = ruf(w, HttpMethod.PUT, PFAD + menge + "/wetterbezug", Map.of("von", MONAT.toString()));
        assertThat(art.status()).isEqualTo(422);
        assertThat(art.body().path("code").asText()).isEqualTo("art_passt_nicht");
        assertThat(ruf(w, HttpMethod.GET, PFAD + menge + "/wetterbezug", null).body().path("moeglich").asBoolean())
                .isFalse();

        UUID bz = gradtagzahl(w, "monat");
        Map<String, Object> grenzen = new LinkedHashMap<>();
        grenzen.put("von", MONAT.toString());
        grenzen.put("raumtemperatur", 15);
        grenzen.put("heizgrenze", 15);
        assertThat(ruf(w, HttpMethod.PUT, PFAD + bz + "/wetterbezug", grenzen).body().path("code").asText())
                .isEqualTo("grenzen_ungueltig");
        assertThat(ruf(w, HttpMethod.PUT, PFAD + bz + "/wetterbezug", Map.of("von", MONAT.plusDays(1).toString()))
                .body().path("code").asText()).as("Monatswerte beginnen am Ersten").isEqualTo("von_ungueltig");
        assertThat(ruf(w, HttpMethod.PUT, PFAD + bz + "/wetterbezug", Map.of("von", LocalDate.now(ZONE).toString()))
                .body().path("code").asText()).as("heute ist kein Archiv-Tag").isEqualTo("von_ungueltig");
    }

    @Test
    void kanalbindungOderImportWerte409UndUmgekehrtKeinKanalAmWetterbezug() throws Exception {
        Welt w = welt(true);
        UUID kanal = gradtagzahl(w, "tag");
        UUID entity = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, family) "
                + "VALUES (?, ?, 'meter', 'Außenfühler', 'temperature') RETURNING id", UUID.class, w.mandant(), w.anlage());
        root.update("INSERT INTO bezugsgroesse_kanalbindung (tenant_id,bezugsgroesse_id,entity_id,kanal,wertart,einheit,"
                + "kadenz_s,von,raumtemperatur,heizgrenze,actor_name,actor_art) VALUES (?,?,?,'aussen.temperatur','gauge',"
                + "'°C',60,?,20,15,'Test','voltpilot')", w.mandant(), kanal, entity,
                Timestamp.from(ERSTER.atStartOfDay(ZONE).toInstant()));
        Antwort a = ruf(w, HttpMethod.PUT, PFAD + kanal + "/wetterbezug", Map.of("von", MONAT.toString()));
        assertThat(a.status()).isEqualTo(409);
        assertThat(a.body().path("code").asText()).isEqualTo("kanalbindung_vorhanden");

        UUID importiert = gradtagzahl(w, "monat");
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id,bezugsgroesse_id,wertart,einheit,periode_art,periode_von,"
                + "periode_bis,zeitzone,fassung,vorgang,status,betrag,herkunft_art,import_kennung,kennzeichen,actor_sub,"
                + "actor_name,actor_art) VALUES (?,?,'periodenwert','Kd','monat',?,?,'Europe/Berlin',1,'erstwert','wirksam',"
                + "300,'import','I-2026-0001','[]'::jsonb,'sub-jonas','Jonas Wendlinger','kunde')", w.mandant(), importiert, MONAT,
                ERSTER.minusDays(1));
        Antwort b = ruf(w, HttpMethod.PUT, PFAD + importiert + "/wetterbezug", Map.of("von", MONAT.toString()));
        assertThat(b.status()).isEqualTo(409);
        assertThat(b.body().path("code").asText()).isEqualTo("werte_vorhanden");
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsgroesse_wetterbezug WHERE tenant_id = ?", Long.class,
                w.mandant())).isZero();
    }

    @Test
    void fremderKundenbereichSiehtNichtsUndSchreibtNichts404() throws Exception {
        Welt w = welt(true);
        UUID bz = gradtagzahl(w, "tag");
        Welt fremd = welt(true);
        assertThat(ruf(fremd, HttpMethod.GET, PFAD + bz + "/wetterbezug", null).status()).isEqualTo(404);
        assertThat(ruf(fremd, HttpMethod.PUT, PFAD + bz + "/wetterbezug", Map.of("von", MONAT.toString())).status())
                .isEqualTo(404);
        assertThat(ruf(fremd, HttpMethod.DELETE, PFAD + bz + "/wetterbezug", null).status()).isEqualTo(404);
        assertThat(ruf(fremd, HttpMethod.GET, "/api/v1/standorte/" + w.standort() + "/wetter", null).status())
                .isEqualTo(404);
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsgroesse_wetterbezug WHERE bezugsgroesse_id = ?",
                Long.class, bz)).isZero();
    }

    // ================================================================ Hilfen

    private Welt welt(boolean koordinaten) {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Wetterbezug #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID st = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand, lage_breitengrad, lage_laengengrad) VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv', ?, ?) "
                + "RETURNING id", UUID.class, t, u, koordinaten ? "Werk Ahrenberg" : "Lindach",
                koordinaten ? "ST-1" : "ST-2", koordinaten ? new BigDecimal("48.25") : null,
                koordinaten ? new BigDecimal("11.43") : null);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, "Verwaltung #" + nr, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        return new Welt(t, st, anlage);
    }

    /** BZ-8 Gradtagzahl am Standort, noch ohne Quelle. */
    private static UUID gradtagzahl(Welt w, String periode) {
        long schon = root.queryForObject("SELECT count(*) FROM bezugsgroesse WHERE tenant_id = ?", Long.class, w.mandant());
        return root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, "
                + "periode_art, geltung_art, standort_id, art) VALUES (?, ?, 'Gradtagzahl Werk Ahrenberg', "
                + "'periodenwert', 'Kd', ?, 'standort', ?, 'gradtagzahl') RETURNING id", UUID.class, w.mandant(),
                "BZ-" + (8 + schon), periode, w.standort());
    }

    private static long protokoll(UUID bz, String art) {
        return root.queryForObject("SELECT count(*) FROM bezugsgroesse_aenderung WHERE bezugsgroesse_id = ? AND art = ?",
                Long.class, bz, art);
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
