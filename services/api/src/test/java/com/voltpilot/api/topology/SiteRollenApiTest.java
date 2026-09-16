package com.voltpilot.api.topology;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.tenant.TenantContext;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
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
 * Die KUNDEN-Fläche der geraeteseitigen Rollen-Zuordnung ({@link com.voltpilot.api.web.SiteRollenController})
 * gegen die echte Kette: Tenant-Scoping/RLS (fremde Anlage = 404), das Setzen/Lesen des
 * massgeblichen PV-Werts eines Geraets (nativer Kanal ODER Gesamtwert) mit is_primary-Ablösung,
 * und der kanonische, ehrlich benannte Rollen-Wert der Anlage (Teil-Summe + stumme Geraete benannt,
 * Rueckfall wenn keine Zuordnung existiert).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class SiteRollenApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String PV = "pv_power_kw";

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

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    // ================================================= Geraete-Zuordnung schreiben/lesen

    @Test
    void kundeSetztUndLiestDenMassgeblichenPvWertEinesGeraets() throws Exception {
        Welt w = welt();
        UUID entity = komponente(w, "Wechselrichter 1");
        UUID ms = gesamtwert(w, entity);
        String pfad = "/api/v1/sites/" + w.anlage() + "/komponenten/" + entity + "/rollen/pv";

        // Ein Gesamtwert wird zugeordnet — noch nichts abgeloest.
        JsonNode a = ok(ruf(w, HttpMethod.PUT, pfad, gesamtwertWert(ms)), 200);
        assertThat(a.at("/zugeordnet/art").asText()).isEqualTo("gesamtwert");
        assertThat(a.at("/zugeordnet/quell_messstelle_id").asText()).isEqualTo(ms.toString());
        assertThat(a.get("abgeloest").isNull()).isTrue();

        JsonNode gelesen = ok(ruf(w, HttpMethod.GET, pfad, null), 200);
        assertThat(gelesen.at("/zugeordnet/art").asText()).isEqualTo("gesamtwert");

        // Ein zweiter Wert auf dieselbe Rolle ERSETZT den ersten (is_primary-Semantik) und nennt ihn.
        JsonNode b = ok(ruf(w, HttpMethod.PUT, pfad, kanalWert(PV)), 200);
        assertThat(b.at("/zugeordnet/art").asText()).isEqualTo("messkanal");
        assertThat(b.at("/zugeordnet/capability").asText()).isEqualTo(PV);
        assertThat(b.at("/abgeloest/art").asText()).isEqualTo("gesamtwert");
        assertThat(b.at("/abgeloest/quell_messstelle_id").asText()).isEqualTo(ms.toString());

        // Genau eine massgebliche Zuordnung bleibt.
        assertThat(root.queryForObject("SELECT count(*) FROM entity_role_assignment "
                + "WHERE entity_id = ? AND role = 'pv' AND is_primary", Long.class, entity)).isOne();
    }

    @Test
    void eineFremdeAnlageIst404NieEine403() throws Exception {
        Welt a = welt();
        Welt b = welt();
        UUID entity = komponente(a, "WR");
        String pfad = "/api/v1/sites/" + a.anlage() + "/komponenten/" + entity + "/rollen/pv";
        assertThat(ruf(b, HttpMethod.GET, pfad, null).status()).isEqualTo(404);
        assertThat(ruf(b, HttpMethod.PUT, pfad, kanalWert(PV)).status()).isEqualTo(404);
        assertThat(ruf(b, HttpMethod.GET, "/api/v1/sites/" + a.anlage() + "/rollen/pv", null).status())
                .isEqualTo(404);
    }

    @Test
    void einGesamtwertMussEineBerechneteMessstelleSein() throws Exception {
        Welt w = welt();
        UUID entity = komponente(w, "WR");
        UUID gemessen = gemesseneMessstelle(w);
        String pfad = "/api/v1/sites/" + w.anlage() + "/komponenten/" + entity + "/rollen/pv";
        assertThat(ruf(w, HttpMethod.PUT, pfad, gesamtwertWert(gemessen)).status()).isEqualTo(400);
        assertThat(ruf(w, HttpMethod.PUT, pfad, gesamtwertWert(UUID.randomUUID())).status()).isEqualTo(404);
    }

    @Test
    void einGesamtwertEinerFremdenAnlageDesselbenMandantenWirdAbgelehnt() throws Exception {
        Welt a = welt();
        Welt b = zweiteAnlage(a);                 // gleicher Mandant, andere Anlage
        UUID entityA = komponente(a, "WR A");
        UUID entityB = komponente(b, "WR B");
        UUID msA = gesamtwert(a, entityA);        // ein Gesamtwert aus einem Kanal von Anlage A

        // An ein Geraet auf Anlage B zuordnen -> 400 (der Gesamtwert gehoert zu Anlage A).
        String pfadB = "/api/v1/sites/" + b.anlage() + "/komponenten/" + entityB + "/rollen/pv";
        assertThat(ruf(a, HttpMethod.PUT, pfadB, gesamtwertWert(msA)).status()).isEqualTo(400);

        // An das Geraet auf Anlage A -> 200 (same-site, alles korrekt).
        String pfadA = "/api/v1/sites/" + a.anlage() + "/komponenten/" + entityA + "/rollen/pv";
        assertThat(ruf(a, HttpMethod.PUT, pfadA, gesamtwertWert(msA)).status()).isEqualTo(200);
    }

    // ================================================= kanonischer Rollen-Wert der Anlage

    @Test
    void derKanonischeWertIstEineBenannteTeilSummeMitStummenGeraeten() throws Exception {
        Welt w = welt();
        UUID e1 = komponente(w, "WR 1");
        UUID e2 = komponente(w, "WR 2");
        ordneKanalZu(w, e1);
        ordneKanalZu(w, e2);
        // e1 liefert frisch 5 kW; e2 ist veraltet (10 min alt) -> stumm, aber benannt.
        telemetrie(w, e1, 5.0, 0);
        telemetrie(w, e2, 4.0, 600);

        JsonNode k = ok(ruf(w, HttpMethod.GET, "/api/v1/sites/" + w.anlage() + "/rollen/pv", null), 200);
        assertThat(k.get("zuordnung_vorhanden").asBoolean()).isTrue();
        assertThat(k.get("wert").asDouble()).as("Teil-Summe der liefernden, nicht 9").isEqualTo(5.0);
        assertThat(k.get("einheit").asText()).isEqualTo("kW");
        assertThat(k.get("unvollstaendig").asBoolean()).isTrue();
        assertThat(k.get("geraete")).hasSize(2);
        // Jedes Geraet ist benannt — eines liefernd, eines mit Grund „veraltet".
        long liefernd = 0;
        boolean veraltetBenannt = false;
        for (JsonNode g : k.get("geraete")) {
            assertThat(g.get("name").asText()).isNotBlank();
            if (g.get("liefernd").asBoolean()) {
                liefernd++;
            } else if ("veraltet".equals(g.get("grund").asText())) {
                veraltetBenannt = true;
            }
        }
        assertThat(liefernd).isOne();
        assertThat(veraltetBenannt).isTrue();
    }

    @Test
    void ohneZuordnungFaelltDasCockpitAufDieRohTelemetrieZurueck() throws Exception {
        Welt w = welt();
        komponente(w, "WR");
        JsonNode k = ok(ruf(w, HttpMethod.GET, "/api/v1/sites/" + w.anlage() + "/rollen/pv", null), 200);
        assertThat(k.get("zuordnung_vorhanden").asBoolean()).as("Rueckfall auf telemetry.pv_power_kw")
                .isFalse();
        assertThat(k.get("wert").isNull()).isTrue();
        assertThat(k.get("geraete")).isEmpty();
    }

    @Test
    void nurDieDreiVertragsrollenSindZuordenbar() throws Exception {
        Welt w = welt();
        assertThat(ruf(w, HttpMethod.GET, "/api/v1/sites/" + w.anlage() + "/rollen/storage", null).status())
                .isEqualTo(400);
    }

    @Test
    void verbrauchAddiertUnabhaengigeGeraeteUndEineEchteNull() throws Exception {
        Welt w = welt();
        UUID a = komponente(w, "Verbrauch A"), b = komponente(w, "Verbrauch B");
        for (UUID id : List.of(a, b)) ok(ruf(w, HttpMethod.PUT, rollenPfad(w, id, "consumer"), kanalWert(PV)), 200);
        telemetrie(w, a, 7, 0);
        telemetrie(w, b, 0, 0);
        JsonNode k = rollenWert(w, "consumer");
        assertThat(k.path("wert").asDouble()).isEqualTo(7);
        assertThat(k.path("unvollstaendig").asBoolean()).isFalse();
        assertThat(k.path("geraete")).hasSize(2);
    }

    @Test
    void netzHatEinenVerschiedenenWertAuchWennDerBisherigeStummIst() throws Exception {
        Welt w = welt();
        UUID a = komponente(w, "Netzhalter"), b = komponente(w, "Zweiter Zähler");
        ok(ruf(w, HttpMethod.PUT, rollenPfad(w, a, "grid"), kanalWert(PV)), 200);
        JsonNode nein = ok(ruf(w, HttpMethod.PUT, rollenPfad(w, b, "grid"), kanalWert(PV)), 409);
        assertThat(nein.path("code").asText()).isEqualTo("netz_mehrfach");
        assertThat(nein.path("halter").get(0).asText()).isEqualTo(a.toString());
        assertThat(nein.path("message").asText()).contains("Netzhalter");
        telemetrie(w, a, -3, 0);
        assertThat(rollenWert(w, "grid").path("wert").asDouble()).isEqualTo(-3);
        assertThat(root.queryForObject("SELECT count(*) FROM entity_role_assignment WHERE site_id = ? AND is_primary",
                Integer.class, w.anlage())).isOne();
    }

    @Test
    void nebenlaeufigeNetzZuordnungenErzeugenGenauEinenHalter() throws Exception {
        Welt w = welt();
        UUID a = komponente(w, "Netz A"), b = komponente(w, "Netz B");
        CountDownLatch start = new CountDownLatch(1);
        var aufrufe = List.of(a, b).stream().map(id -> CompletableFuture.supplyAsync(() -> {
            try {
                start.await();
                return ruf(w, HttpMethod.PUT, rollenPfad(w, id, "grid"), kanalWert(PV)).status();
            } catch (Exception e) { throw new RuntimeException(e); }
        })).toList();
        start.countDown();
        assertThat(aufrufe.stream().map(CompletableFuture::join)).containsExactlyInAnyOrder(200, 409);
        assertThat(root.queryForObject("SELECT count(*) FROM entity_role_assignment WHERE site_id = ? AND is_primary",
                Integer.class, w.anlage())).isOne();
    }

    @Test
    void verbrauchsSummeHaengtAnAllenGeraetenUndZaehltNurEinmal() throws Exception {
        Welt w = welt();
        UUID a = komponente(w, "Verbrauch A"), b = komponente(w, "Verbrauch B");
        UUID summe = summe(w, "Bezug", List.of(a, b), List.of(PV1, PV2));
        probe(w, a, PV1, 4000, 0);
        probe(w, b, PV2, 5000, 0);
        ok(ruf(w, HttpMethod.PUT, "/api/v1/sites/" + w.anlage() + "/rollen/consumer", gesamtwertWert(summe)), 200);
        JsonNode k = rollenWert(w, "consumer");
        assertThat(k.path("wert").asDouble()).isEqualTo(9);
        assertThat(k.path("geraete")).hasSize(2);
        assertThat(k.path("unvollstaendig").asBoolean()).isFalse();
        assertThat(root.queryForObject("SELECT count(*) FROM entity_role_assignment WHERE site_id = ? AND is_primary",
                Integer.class, w.anlage())).isEqualTo(2);
    }

    @Test
    void aeussereSummeVerdraengtInnerenSummenwertUndBlattAuchWennSieStummIst() throws Exception {
        Welt w = welt();
        UUID a = komponente(w, "Blatt"), b = komponente(w, "Innere Summe"), c = komponente(w, "Äußere Summe");
        UUID innen = summe(w, "Erzeugung", List.of(a), List.of(PV1));
        UUID aussen = messstelle(w, "berechnet");
        root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, position, eingang_art, "
                + "quell_messstelle_id, vorzeichen, faktor) VALUES (?, ?, 0, 'messstelle', ?, '+', 1)",
                w.mandant(), aussen, innen);
        ok(ruf(w, HttpMethod.PUT, rollenPfad(w, a, "pv"), kanalWert(PV1)), 200);
        ok(ruf(w, HttpMethod.PUT, rollenPfad(w, b, "pv"), gesamtwertWert(innen)), 200);
        ok(ruf(w, HttpMethod.PUT, rollenPfad(w, c, "pv"), gesamtwertWert(aussen)), 200);
        Instant zeit = Instant.now();
        root.update("INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, entity_id, channel, value) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, 99)", Timestamp.from(zeit), Timestamp.from(zeit), w.mandant(),
                w.anlage(), w.box(), a.toString(), PV1);
        assertThat(rollenWert(w, "pv").path("wert").isNull()).isTrue();
        probe(w, a, PV1, 4000, 0);
        JsonNode k = rollenWert(w, "pv");
        assertThat(k.path("wert").asDouble()).isEqualTo(4);
        assertThat(k.path("geraete")).hasSize(3);
        assertThat(k.path("unvollstaendig").asBoolean()).isFalse();
    }

    @Test
    void teilweiseUeberlappendeSummenWerdenVorDemSchreibenAbgelehnt() throws Exception {
        Welt w = welt();
        UUID a = komponente(w, "A"), b = komponente(w, "B"), c = komponente(w, "C");
        UUID ab = summe(w, "Erzeugung", List.of(a, b), List.of(PV1, PV2));
        UUID bc = summe(w, "Erzeugung", List.of(b, c), List.of(PV2, PV3));
        ok(ruf(w, HttpMethod.PUT, rollenPfad(w, a, "pv"), gesamtwertWert(ab)), 200);
        JsonNode nein = ok(ruf(w, HttpMethod.PUT, rollenPfad(w, c, "pv"), gesamtwertWert(bc)), 409);
        assertThat(nein.path("code").asText()).isEqualTo("ueberlappende_summenwerte");
        assertThat(root.queryForObject("SELECT count(*) FROM entity_role_assignment WHERE site_id = ? AND is_primary",
                Integer.class, w.anlage())).isOne();
    }

    @Test
    void netzSummeIstEinWertUndBestaetigtesErsetzenTauschtAlleZeilen() throws Exception {
        Welt w = welt();
        UUID a = komponente(w, "A"), b = komponente(w, "B"), c = komponente(w, "C");
        UUID ab = summe(w, "richtungslos", List.of(a, b), List.of(PV1, PV2));
        UUID neu = summe(w, "richtungslos", List.of(c), List.of(PV3));
        String pfad = "/api/v1/sites/" + w.anlage() + "/rollen/grid";
        ok(ruf(w, HttpMethod.PUT, pfad, gesamtwertWert(ab)), 200);
        ok(ruf(w, HttpMethod.PUT, pfad, gesamtwertWert(neu)), 409);
        Map<String, Object> eingabe = gesamtwertWert(neu);
        eingabe.put("ersetzen", true);
        ok(ruf(w, HttpMethod.PUT, pfad, eingabe), 200);
        assertThat(root.queryForList("SELECT entity_id FROM entity_role_assignment WHERE site_id = ? AND is_primary",
                UUID.class, w.anlage())).containsExactly(c);
        assertThat(root.queryForObject("SELECT count(*) FROM ort_aenderung WHERE objekt_id = ? AND art = 'rolle_entzogen'",
                Integer.class, w.anlage())).isEqualTo(2);
    }

    @Test
    void summenwertIstNachFuenfMinutenVeraltetDieFormelBleibtFuenfzehnMinutenFrisch() throws Exception {
        Welt w = welt();
        UUID a = komponente(w, "A");
        UUID ms = gesamtwert(w, a);
        probe(w, a, PV1, 5000, 301);
        ok(ruf(w, HttpMethod.PUT, rollenPfad(w, a, "pv"), gesamtwertWert(ms)), 200);
        JsonNode k = rollenWert(w, "pv");
        assertThat(k.path("wert").isNull()).isTrue();
        assertThat(k.at("/geraete/0/grund").asText()).isEqualTo("veraltet");
        JsonNode formel = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + ms + "/wert", null), 200);
        assertThat(formel.path("wert").asDouble()).isEqualTo(5);
    }

    @Test
    void entzugUndErsetzenProtokollierenAltNeuWerUndWannIdempotent() throws Exception {
        Welt w = welt();
        UUID a = komponente(w, "A");
        UUID ms = gesamtwert(w, a);
        String pfad = rollenPfad(w, a, "pv");
        ok(ruf(w, HttpMethod.PUT, pfad, gesamtwertWert(ms)), 200);
        ok(ruf(w, HttpMethod.PUT, pfad, gesamtwertWert(ms)), 200);
        ok(ruf(w, HttpMethod.PUT, pfad, kanalWert(PV)), 200);
        ok(ruf(w, HttpMethod.DELETE, pfad, null), 200);
        ok(ruf(w, HttpMethod.DELETE, pfad, null), 200);
        var zeilen = root.queryForList("SELECT art, alt::text, neu::text, actor_sub, created_at, rueckwirkend "
                + "FROM ort_aenderung WHERE objekt_id = ? ORDER BY id", w.anlage());
        assertThat(zeilen).hasSize(3);
        assertThat(zeilen.stream().map(z -> z.get("art"))).containsExactly("rolle_gesetzt", "rolle_gesetzt", "rolle_entzogen");
        for (var z : zeilen) {
            assertThat(z.get("actor_sub")).isEqualTo("sub-" + w.mandant());
            assertThat(z.get("created_at")).isNotNull();
            assertThat(z.get("rueckwirkend")).isEqualTo(false);
        }
        assertThat(MAPPER.readTree((String) zeilen.get(1).get("alt")).at("/wert/quell_messstelle_id").asText()).isEqualTo(ms.toString());
        assertThat(MAPPER.readTree((String) zeilen.get(1).get("neu")).at("/wert/capability").asText()).isEqualTo(PV);
        assertThat(rollenWert(w, "pv").path("zuordnung_vorhanden").asBoolean()).isFalse();
        telemetrieLegacy(w, 99);
        assertThat(uebersichtPv(w, w.anlage())).isEqualTo(99);
    }

    @Test
    void rollenwechselIstEntzugUndSetzenUndEineFremdeAnlageBleibt404() throws Exception {
        Welt w = welt();
        UUID a = komponente(w, "A");
        ok(ruf(w, HttpMethod.PUT, rollenPfad(w, a, "pv"), kanalWert(PV)), 200);
        ok(ruf(w, HttpMethod.PUT, rollenPfad(w, a, "consumer"), kanalWert(PV)), 200);
        assertThat(rollenWert(w, "pv").path("zuordnung_vorhanden").asBoolean()).isFalse();
        assertThat(root.queryForList("SELECT art FROM ort_aenderung WHERE objekt_id = ? ORDER BY id", String.class,
                w.anlage())).containsExactly("rolle_gesetzt", "rolle_entzogen", "rolle_gesetzt");
        Welt fremd = welt();
        ok(ruf(fremd, HttpMethod.DELETE, rollenPfad(w, a, "consumer"), null), 404);
        ok(ruf(fremd, HttpMethod.PUT, "/api/v1/sites/" + w.anlage() + "/rollen/consumer", gesamtwertWert(UUID.randomUUID())), 404);
    }

    @Test
    void leserDarfLesenAberKeineRolleSetzenOderEntziehen() throws Exception {
        Welt w = welt();
        UUID a = komponente(w, "A");
        String sub = "sub-" + w.mandant();
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', 'Leser', 'aktiv')",
                w.mandant(), sub);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name) VALUES (?, 'Test') RETURNING id", UUID.class, w.mandant());
        UUID standort = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, 'Test', 'ST-01', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, w.mandant(), u);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?, ?, ?, '2026-01-01')",
                w.mandant(), w.anlage(), standort);
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, 'leser', ?, '2026-01-01 00:00:00+01', 'Europe/Berlin')", w.mandant(), sub, standort);
        ok(rufLeser(w, HttpMethod.GET, rollenPfad(w, a, "pv"), null), 200);
        ok(rufLeser(w, HttpMethod.PUT, rollenPfad(w, a, "pv"), kanalWert(PV)), 403);
        ok(rufLeser(w, HttpMethod.DELETE, rollenPfad(w, a, "pv"), null), 403);
        ok(rufLeser(w, HttpMethod.PUT, "/api/v1/sites/" + w.anlage() + "/rollen/pv", gesamtwertWert(UUID.randomUUID())), 403);
        assertThat(root.queryForObject("SELECT count(*) FROM ort_aenderung WHERE objekt_id = ?", Integer.class, w.anlage())).isZero();
    }

    @Test
    void energieSummeKannNichtAlsLeistungZugeordnetWerden() throws Exception {
        Welt w = welt();
        UUID a = komponente(w, "A");
        UUID ms = messstelle(w, "berechnet", "Erzeugung", "Wirkenergie", "kWh", "Zählerstand");
        ok(ruf(w, HttpMethod.PUT, rollenPfad(w, a, "pv"), gesamtwertWert(ms)), 400);
        ok(ruf(w, HttpMethod.PUT, rollenPfad(w, a, "pv"), kanalWert("soc_pct")), 400);
    }

    @Test
    void einProtokollFehlerRolltNurDenZusatzZurueck() throws Exception {
        Welt w = welt();
        UUID a = komponente(w, "A");
        root.execute("ALTER TABLE ort_aenderung ADD CONSTRAINT rollen_test_fehler CHECK (objekt_id <> '" + w.anlage() + "'::uuid)");
        try {
            ok(ruf(w, HttpMethod.PUT, rollenPfad(w, a, "pv"), kanalWert(PV)), 200);
            assertThat(rollenWert(w, "pv").path("zuordnung_vorhanden").asBoolean()).isTrue();
            assertThat(root.queryForObject("SELECT count(*) FROM ort_aenderung WHERE objekt_id = ?", Integer.class, w.anlage())).isZero();
        } finally {
            root.execute("ALTER TABLE ort_aenderung DROP CONSTRAINT rollen_test_fehler");
        }
    }

    @Test
    void auchDerAlteTopologieWegKannKeinenZweitenNetzwertSchreiben() throws Exception {
        Welt w = welt();
        UUID a = komponente(w, "Netz A"), b = komponente(w, "Netz B");
        ok(ruf(w, HttpMethod.PUT, rollenPfad(w, a, "grid"), kanalWert(PV)), 200);
        var body = Map.of("assignments", List.of(Map.of("entityId", b.toString(), "channel", PV,
                "role", "grid", "primary", true)));
        ok(ruf(w, HttpMethod.PUT, "/api/v1/sites/" + w.anlage() + "/topology-roles", body), 409);
        assertThat(root.queryForList("SELECT entity_id FROM entity_role_assignment WHERE site_id = ? AND is_primary",
                UUID.class, w.anlage())).containsExactly(a);
    }

    private static final String PV1 = "deye.hybrid_3p.pv.pv1-power";
    private static final String PV2 = "deye.hybrid_3p.pv.pv2-power";
    private static final String PV3 = "deye.hybrid_3p.pv.pv3-power";

    private String rollenPfad(Welt w, UUID id, String rolle) {
        return "/api/v1/sites/" + w.anlage() + "/komponenten/" + id + "/rollen/" + rolle;
    }

    private JsonNode rollenWert(Welt w, String rolle) throws Exception {
        return ok(ruf(w, HttpMethod.GET, "/api/v1/sites/" + w.anlage() + "/rollen/" + rolle, null), 200);
    }

    private UUID summe(Welt w, String richtung, List<UUID> geraete, List<String> punkte) {
        UUID ms = messstelle(w, "berechnet", richtung, "Wirkleistung", "kW", "Momentanwert");
        for (int i = 0; i < geraete.size(); i++) {
            root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, position, eingang_art, "
                    + "entity_id, point_key, vorzeichen, faktor, gilt_als_erzeugung) VALUES (?, ?, ?, 'messkanal', ?, ?, '+', 1, false)",
                    w.mandant(), ms, i, geraete.get(i), punkte.get(i));
        }
        return ms;
    }

    private void probe(Welt w, UUID entity, String punkt, double watt, long alter) {
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), '2026.09.11.1', "
                + "'test', 'pending_edge', 'energy_counter', 'fifteen_minute') ON CONFLICT DO NOTHING",
                w.mandant(), w.anlage(), w.box(), entity, punkt);
        Timestamp zeit = Timestamp.from(Instant.now().minusSeconds(alter));
        root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, point_key, "
                + "raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, aggregation_kind, long_term_cadence_s) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'good', '2026.09.11.1', ?, 'gauge', 900)",
                zeit, zeit, w.mandant(), w.anlage(), w.box(), punkt, watt, watt, NR.incrementAndGet());
    }

    // ================================================= Cockpit-Uebersicht: Umlenkung + Rueckfall

    @Test
    void dieUebersichtUebernimmtDieKanonischePvMitRueckfall() throws Exception {
        Welt w = welt();
        UUID e1 = komponente(w, "WR 1");
        // Roh-Telemetrie der Anlage: pv_power_kw = 99 — der Rueckfall, wenn nichts zugeordnet ist.
        telemetrieLegacy(w, 99.0);

        // Ohne PV-Zuordnung zeigt die Uebersicht die Roh-Zahl (nichts aendert sich).
        assertThat(uebersichtPv(w, w.anlage())).as("Rueckfall auf telemetry.pv_power_kw").isEqualTo(99.0);

        // Mit einer PV-Zuordnung eines frischen 5-kW-Kanals zeigt die Uebersicht die KANONISCHE Zahl.
        ordneKanalZu(w, e1);
        telemetrie(w, e1, 5.0, 0);
        assertThat(uebersichtPv(w, w.anlage()))
                .as("kanonische PV-Rolle statt telemetry.pv_power_kw").isEqualTo(5.0);
    }

    @Test
    void eineZugeordneteAberStummeAnlageZeigtKeinePvNieEineNull() throws Exception {
        Welt w = welt();
        UUID e1 = komponente(w, "WR 1");
        telemetrieLegacy(w, 99.0);       // Roh-Telemetrie liegt vor …
        ordneKanalZu(w, e1);             // … aber die Zuordnung liefert nichts (kein frischer v2-Wert).

        // Ehrlich: zugeordnet, aber stumm -> PV unbekannt (null), nie ein Rueckfall auf 99 und nie 0.
        assertThat(uebersichtPv(w, w.anlage())).as("null statt Rueckfall/0 bei stummer Zuordnung").isNull();
    }

    // ================================================================ die Welt

    private record Welt(UUID mandant, UUID anlage, UUID box) {}

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Rollen-Probe #" + nr);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) "
                + "VALUES (?, 'Anlage #" + nr + "', now()) RETURNING id", UUID.class, t);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, name, status, "
                + "created_at) VALUES (?, ?, ?, 'Box', 'claimed', now()) RETURNING id",
                UUID.class, t, anlage, "E-" + nr);
        return new Welt(t, anlage, box);
    }

    /** Eine zweite Anlage (Site + Box) im SELBEN Mandanten — für den within-tenant-cross-site-Fall. */
    private Welt zweiteAnlage(Welt w) {
        int nr = NR.incrementAndGet();
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) "
                + "VALUES (?, 'Anlage B #" + nr + "', now()) RETURNING id", UUID.class, w.mandant());
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, name, "
                + "status, created_at) VALUES (?, ?, ?, 'Box B', 'claimed', now()) RETURNING id",
                UUID.class, w.mandant(), anlage, "EB-" + nr);
        return new Welt(w.mandant(), anlage, box);
    }

    private UUID komponente(Welt w, String label) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, control, communication, created_at) VALUES (?, ?, "
                + "'battery-hybrid', ?, 'battery-hybrid', ?, false, 'modbus_tcp', now()) RETURNING id",
                UUID.class, w.mandant(), w.anlage(), label, w.box());
    }

    /** Ein Gesamtwert (berechnete Messstelle), gebaut aus EINEM Kanal des Geräts {@code entity}
     *  — damit er (über seine Terme) zur Anlage dieses Geräts gehört. */
    private UUID gesamtwert(Welt w, UUID entity) {
        UUID ms = messstelle(w, "berechnet");
        root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, position, "
                + "eingang_art, entity_id, point_key, vorzeichen, faktor, gilt_als_erzeugung) "
                + "VALUES (?, ?, 0, 'messkanal', ?, 'deye.hybrid_3p.pv.pv1-power', '+', 1, false)",
                w.mandant(), ms, entity);
        return ms;
    }

    private UUID gemesseneMessstelle(Welt w) {
        return messstelle(w, "gemessen");
    }

    private UUID messstelle(Welt w, String art) {
        return messstelle(w, art, "Erzeugung", "Wirkleistung", "kW", "Momentanwert");
    }

    private UUID messstelle(Welt w, String art, String richtung, String groesse, String einheit, String wertart) {
        return root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, "
                + "groesse, richtung, einheit, wertart) VALUES (?, ?, 'Gesamt-PV', ?, 'Strom', ?, ?, ?, ?) RETURNING id",
                UUID.class, w.mandant(), String.format("MS-%05d", NR.incrementAndGet()), art, groesse, richtung, einheit, wertart);
    }

    private void ordneKanalZu(Welt w, UUID entity) throws Exception {
        ok(ruf(w, HttpMethod.PUT, "/api/v1/sites/" + w.anlage() + "/komponenten/" + entity
                + "/rollen/pv", kanalWert(PV)), 200);
    }

    private void telemetrie(Welt w, UUID entity, double kw, long alterSekunden) {
        Instant zeit = Instant.now().minus(alterSekunden, ChronoUnit.SECONDS);
        root.update("INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, "
                + "entity_id, channel, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                Timestamp.from(zeit), Timestamp.from(zeit), w.mandant(), w.anlage(), w.box(),
                entity.toString(), PV, kw);
    }

    /** Die ROH-Telemetrie der Anlage ({@code telemetry.pv_power_kw}) — der Cockpit-Rueckfall. */
    private void telemetrieLegacy(Welt w, double pvKw) {
        Instant zeit = Instant.now();
        root.update("INSERT INTO telemetry (time, received_at, tenant_id, site_id, device_id, "
                + "pv_power_kw) VALUES (?, ?, ?, ?, ?, ?)",
                Timestamp.from(zeit), Timestamp.from(zeit), w.mandant(), w.anlage(), w.box(), pvKw);
    }

    /** Der PV-Live-Wert einer Anlage in {@code GET /api/v1/overview} (null, wenn keiner). */
    private Double uebersichtPv(Welt w, UUID site) throws Exception {
        JsonNode ov = ok(ruf(w, HttpMethod.GET, "/api/v1/overview", null), 200);
        for (JsonNode s : ov.get("sites")) {
            if (site.toString().equals(s.get("id").asText())) {
                JsonNode live = s.get("live");
                if (live == null || live.isNull() || live.get("pvKw").isNull()) {
                    return null;
                }
                return live.get("pvKw").asDouble();
            }
        }
        return null;
    }

    // ================================================================ das Gerüst

    private static Map<String, Object> kanalWert(String capability) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("art", "messkanal");
        m.put("capability", capability);
        return m;
    }

    private static Map<String, Object> gesamtwertWert(UUID quell) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("art", "gesamtwert");
        m.put("quell_messstelle_id", quell.toString());
        return m;
    }

    private record Antwort(int status, JsonNode body) {}

    private static JsonNode ok(Antwort a, int status) {
        assertThat(a.status()).as("Antwort " + a.body()).isEqualTo(status);
        return a.body();
    }

    private Antwort ruf(Welt w, HttpMethod methode, String pfad, Object body) throws Exception {
        return ruf(w, methode, pfad, body, false);
    }

    private Antwort rufLeser(Welt w, HttpMethod methode, String pfad, Object body) throws Exception {
        return ruf(w, methode, pfad, body, true);
    }

    private Antwort ruf(Welt w, HttpMethod methode, String pfad, Object body, boolean konto) throws Exception {
        var token = jwt().jwt(j -> {
            j.subject("sub-" + w.mandant());
            j.claim("name", "Test");
            j.claim("tenant_id", w.mandant().toString());
        });
        if (konto) token.authorities(new org.springframework.security.core.authority.SimpleGrantedAuthority(
                com.voltpilot.api.config.KeycloakRealmRoleConverter.KONTO_BENUTZER));
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(token)
                .contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(),
                text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
