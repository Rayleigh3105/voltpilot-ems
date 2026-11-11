package com.voltpilot.api.erzeugungsanlage;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.mastr.MastrHttp;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.math.BigDecimal;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.boot.resttestclient.TestRestTemplate;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureTestRestTemplate;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Erzeugungsanlagen end to end gegen eine ECHTE TimescaleDB und Keycloak (Messkonzepte S1, nur Anzeige):
 *
 * <ul>
 *   <li><b>Einfach bleibt einfach:</b> der bisherige Weg SEE-Nummer → Nachschlagen → Übernehmen erzeugt EA 1, die der
 *       Anlage folgt; ihr Satz ist Zahl für Zahl der der Karte „Einspeisevergütung“, auch nach einem eigenen
 *       Satz;</li>
 *   <li><b>nur Anzeige:</b> eine zweite EA, ihre Fassungen und ihr eigener Satz lassen die Karte der Anlage
 *       Zeichen für Zeichen, wie sie war;</li>
 *   <li>Fassungen ab einem Tag, am selben Tag ersetzt; Komponenten und Vorschläge; eine EA, die der Anlage folgt,
 *       nimmt Leistung und Inbetriebnahme nur über die Anlage an; der Mandantenzaun.</li>
 * </ul>
 *
 * <p>Jeder Fall legt seine eigene Anlage an. Läuft ohne Docker nicht (übersprungen).
 */
@Testcontainers(disabledWithoutDocker = true)
@AutoConfigureTestRestTemplate
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class ErzeugungsanlageApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final UUID TENANT_A = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final String PV_UNIT = "SEE966831669444";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Container
    static final KeycloakContainer KEYCLOAK = new KeycloakContainer("quay.io/keycloak/keycloak:26.0.5")
            .withRealmImportFile("keycloak/voltpilot-realm.json");

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

        String realm = KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot";
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> realm);
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> realm + "/protocol/openid-connect/certs");
    }

    /** Das Register ist das einzige Falsche: aufgezeichnete Antworten statt des lebenden Dienstes. */
    @TestConfiguration
    static class FixtureRegistry {
        @Bean
        MastrHttp mastrHttp() {
            return new MastrHttp() {
                @Override
                public Response post(URI uri, Map<String, String> headers, String body) {
                    throw new UnsupportedOperationException("SOAP source not configured in test");
                }

                @Override
                public Response get(URI uri) {
                    if (uri.toString().contains(PV_UNIT)) {
                        return new Response(200, fixture("json_pv_" + PV_UNIT + ".json"));
                    }
                    return new Response(200, "{\"Data\":[],\"Total\":0}");
                }
            };
        }

        private static String fixture(String name) {
            try (var in = ErzeugungsanlageApiTest.class.getResourceAsStream("/mastr/" + name)) {
                return new String(in.readAllBytes(), StandardCharsets.UTF_8);
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        }
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    // ======================================================================== Einfach bleibt einfach

    @Test
    void derBisherigeWegErzeugtEa1UndIhrSatzIstDerDerKarte() {
        String token = token("demo", "demo");
        String site = neueAnlage("Einfach");
        assertThat(list(liste(site, token).get("erzeugungsanlagen"))).isEmpty();

        // SEE-Nummer → Nachschlagen → Übernehmen, genau wie heute.
        ResponseEntity<Map<String, Object>> vorschau = post("/api/v1/sites/" + site + "/mastr-lookup",
                Map.of("einheitNummer", PV_UNIT), token);
        assertThat(vorschau.getStatusCode()).isEqualTo(HttpStatus.OK);
        uebernehmen(site, token, 9.8, "2023-06-15");

        Map<String, Object> ea = einzige(site, token);
        assertThat(ea).containsEntry("nummer", 1).containsEntry("bezeichnung", "EA 1").containsEntry("folgtAnlage", true)
                .containsEntry("inbetriebnahme", "2023-06-15").containsEntry("registryUnitId", PV_UNIT);
        assertThat(zahl(map(ea.get("fassung")).get("leistungKwp"))).isEqualByComparingTo("9.8");
        gleichDerKarte(site, token, ea);

        // Ein eigener Satz an der Karte: EA 1 übernimmt ihn, der Satz bleibt der der Karte.
        ResponseEntity<Map<String, Object>> satz = exchange(HttpMethod.PUT, "/api/v1/sites/" + site
                + "/einspeiseverguetung", Map.of("satzCtKwh", 12.5), token);
        assertThat(satz.getStatusCode()).isEqualTo(HttpStatus.OK);
        ea = einzige(site, token);
        assertThat(map(ea.get("verguetung"))).containsEntry("zustand", "angegeben");
        gleichDerKarte(site, token, ea);

        // Noch einmal übernehmen mit denselben Werten schreibt keine neue Fassung; am Tag ihres Eintrags wird eine
        // geänderte Leistung die Fassung ersetzen, nie eine zweite daneben stellen.
        uebernehmen(site, token, 9.8, "2023-06-15");
        uebernehmen(site, token, 10.2, "2023-06-15");
        ea = einzige(site, token);
        assertThat(list(ea.get("fassungen"))).hasSize(1);
        assertThat(zahl(map(ea.get("fassung")).get("leistungKwp"))).isEqualByComparingTo("10.2");
        gleichDerKarte(site, token, ea);
    }

    @Test
    void eineEaDieDerAnlageFolgtNimmtLeistungUndInbetriebnahmeNurUeberDieAnlage() {
        String token = token("demo", "demo");
        String site = neueAnlage("Folgt");
        uebernehmen(site, token, 9.8, "2023-06-15");
        Map<String, Object> ea = einzige(site, token);
        String pfad = "/api/v1/sites/" + site + "/erzeugungsanlagen/" + ea.get("id");

        Map<String, Object> anders = new HashMap<>();
        anders.put("inbetriebnahme", "2020-01-01");
        anders.put("registryUnitId", PV_UNIT);
        assertThat(exchange(HttpMethod.PUT, pfad, anders, token).getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(post(pfad + "/fassungen", Map.of("leistungKwp", 20), token).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);
        assertThat(post(pfad + "/aufheben", Map.of(), token).getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        // Name und Einspeiseart sind frei - der Satz bleibt der der Karte.
        Map<String, Object> name = new HashMap<>();
        name.put("name", "PV Dach");
        name.put("inbetriebnahme", "2023-06-15");
        name.put("registryUnitId", PV_UNIT);
        assertThat(exchange(HttpMethod.PUT, pfad, name, token).getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> voll = new HashMap<>();
        voll.put("gueltigAb", null);
        voll.put("leistungKwp", 9.8);
        voll.put("einspeiseart", "ueberschuss");
        assertThat(post(pfad + "/fassungen", voll, token).getStatusCode()).isEqualTo(HttpStatus.OK);
        ea = einzige(site, token);
        assertThat(ea).containsEntry("bezeichnung", "EA 1 · PV Dach").containsEntry("folgtAnlage", true);
        assertThat(map(ea.get("fassung"))).containsEntry("einspeiseart", "ueberschuss");
        gleichDerKarte(site, token, ea);
    }

    // ============================================================================ Nur Anzeige

    @Test
    void eineZweiteEaLaesstDieKarteDerAnlageZeichengleich() {
        String token = token("demo", "demo");
        String site = neueAnlage("Hof Brandl");
        uebernehmen(site, token, 20, "2025-05-12");
        String karteVorher = roh("/api/v1/sites/" + site + "/einspeiseverguetung", token);
        String assetsVorher = roh("/api/v1/sites/" + site + "/assets", token);

        Map<String, Object> altanlage = new HashMap<>();
        altanlage.put("name", "PV Scheune");
        altanlage.put("inbetriebnahme", "2009-04-14");
        altanlage.put("leistungKwp", 30);
        altanlage.put("einspeiseart", "voll");
        ResponseEntity<Map<String, Object>> neu = post("/api/v1/sites/" + site + "/erzeugungsanlagen", altanlage,
                token);
        assertThat(neu.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        List<Map<String, Object>> eas = list(neu.getBody().get("erzeugungsanlagen"));
        assertThat(eas).hasSize(2);
        assertThat(eas.get(0)).containsEntry("folgtAnlage", false);
        Map<String, Object> ea2 = eas.get(1);
        assertThat(ea2).containsEntry("nummer", 2).containsEntry("bezeichnung", "EA 2 · PV Scheune");
        Map<String, Object> v2 = map(ea2.get("verguetung"));
        assertThat(v2).containsEntry("zustand", "eeg").containsEntry("foerderendeAm", "2029-12-31")
                .containsEntry("ohneVerguetungBeiNegativpreis", false);
        assertThat(texte(v2.get("naeherung"))).containsExactly("vor_erstem_band", "volleinspeisung");
        Map<String, Object> v1 = map(eas.get(0).get("verguetung"));
        assertThat(v1).containsEntry("ohneVerguetungBeiNegativpreis", true);

        // Eine Fassung ab einem Tag, am selben Tag ersetzt; vor der Inbetriebnahme nie.
        String pfad = "/api/v1/sites/" + site + "/erzeugungsanlagen/" + ea2.get("id");
        assertThat(post(pfad + "/fassungen", fassung("2026-01-01", 30, "voll", 9.0), token).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(post(pfad + "/fassungen", fassung("2026-01-01", 30, "voll", 9.5), token).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(post(pfad + "/fassungen", fassung("2008-01-01", 30, "voll", null), token).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_CONTENT);
        Map<String, Object> amTag = eaAm(site, token, 2, "2026-06-01");
        assertThat(list(amTag.get("fassungen"))).hasSize(2);
        assertThat(zahl(map(amTag.get("fassung")).get("satzAngegebenCtKwh"))).isEqualByComparingTo("9.5");
        assertThat(map(amTag.get("verguetung"))).containsEntry("zustand", "angegeben");
        Map<String, Object> davor = eaAm(site, token, 2, "2025-12-31");
        assertThat(map(davor.get("fassung")).get("satzAngegebenCtKwh")).isNull();

        // Fahrplan, Erlöse und Box rechnen weiter mit dem Satz der Anlage: Karte und Aggregat Zeichen für Zeichen.
        assertThat(roh("/api/v1/sites/" + site + "/einspeiseverguetung", token)).isEqualTo(karteVorher);
        assertThat(roh("/api/v1/sites/" + site + "/assets", token)).isEqualTo(assetsVorher);

        // Eine versehentlich angelegte EA wird aufgehoben; ihre Nummer kommt nie wieder.
        assertThat(post(pfad + "/aufheben", Map.of(), token).getStatusCode()).isEqualTo(HttpStatus.OK);
        ResponseEntity<Map<String, Object>> dritte = post("/api/v1/sites/" + site + "/erzeugungsanlagen",
                Map.of("leistungKwp", 5), token);
        assertThat(list(dritte.getBody().get("erzeugungsanlagen"))).extracting(e -> e.get("nummer"))
                .containsExactly(1, 3);
    }

    @Test
    void eineEaAusDemNachschlagenTraegtDieRegisterwerteMitHerkunft() {
        String token = token("demo", "demo");
        String site = neueAnlage("Nachschlagen");
        Map<String, Object> body = new HashMap<>();
        body.put("registryUnitId", PV_UNIT);
        body.put("mastrBestaetigt", true);
        body.put("inbetriebnahme", "2024-03-01");
        body.put("leistungKwp", 6.05);
        ResponseEntity<Map<String, Object>> neu = post("/api/v1/sites/" + site + "/erzeugungsanlagen", body, token);
        assertThat(neu.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        Map<String, Object> ea = list(neu.getBody().get("erzeugungsanlagen")).get(0);
        assertThat(ea).containsEntry("registryUnitId", PV_UNIT).containsEntry("folgtAnlage", false);
        assertThat(ea.get("registryFetchedAt")).isNotNull();
        assertThat(map(ea.get("fassung"))).containsEntry("herkunft", "mastr");
        assertThat(post("/api/v1/sites/" + site + "/erzeugungsanlagen", Map.of("registryUnitId", "SEE1"), token)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    // =================================================================== Komponenten und Vorschläge

    @Test
    void einWeitererErzeugerIstEinVorschlagUndWirdNieStillZurEa() {
        String token = token("demo", "demo");
        String site = neueAnlage("Mit Garage");
        uebernehmen(site, token, 9.8, "2023-06-15");
        UUID garage = root().queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "capacity_kwp, registry_unit_id) VALUES (?, ?::uuid, 'pv-generation', 'WR Garage', 5, ?) RETURNING id",
                UUID.class, TENANT_A, site, "SEE900000000001");
        Map<String, Object> liste = liste(site, token);
        assertThat(list(liste.get("erzeugungsanlagen"))).hasSize(1);
        assertThat(list(liste.get("vorschlaege"))).singleElement()
                .satisfies(v -> assertThat(v).containsEntry("komponenteId", garage.toString())
                        .containsEntry("name", "WR Garage").containsEntry("registryUnitId", "SEE900000000001"));

        // Gehört zu EA 1: der Verweis nimmt ihn aus den Vorschlägen.
        Map<String, Object> ea1 = einzige(site, token);
        String pfad = "/api/v1/sites/" + site + "/erzeugungsanlagen/" + ea1.get("id");
        ResponseEntity<Map<String, Object>> verwiesen = post(pfad + "/komponenten",
                Map.of("komponenteId", garage.toString()), token);
        assertThat(verwiesen.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(list(verwiesen.getBody().get("vorschlaege"))).isEmpty();
        Map<String, Object> verweis = list(einzige(site, token).get("komponenten")).get(0);
        assertThat(verweis).containsEntry("name", "WR Garage").containsEntry("eingang", null);

        // Die ganze Komponente speist keine zweite EA; ein Eingang auch nicht.
        ResponseEntity<Map<String, Object>> zweite = post("/api/v1/sites/" + site + "/erzeugungsanlagen",
                Map.of("leistungKwp", 5, "komponenteId", garage.toString(), "eingang", 2), token);
        assertThat(zweite.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(String.valueOf(zweite.getBody().get("message"))).contains("WR Garage").contains("EA 1");

        // Lösen am Tag des Eintrags hebt den Verweis auf - der Vorschlag ist wieder da.
        ResponseEntity<Map<String, Object>> geloest = post(pfad + "/komponenten/" + verweis.get("id") + "/loesen",
                Map.of(), token);
        assertThat(geloest.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(list(geloest.getBody().get("vorschlaege"))).hasSize(1);

        // Eine fremde Komponente gehört nicht zu dieser Anlage.
        String andere = neueAnlage("Andere");
        assertThat(post("/api/v1/sites/" + andere + "/erzeugungsanlagen",
                Map.of("komponenteId", garage.toString()), token).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_CONTENT);
    }

    @Test
    void derWechselrichterEinerEinfachenAnlageIstKeinVorschlag() {
        String token = token("demo", "demo");
        String site = neueAnlage("Nur Dach");
        uebernehmen(site, token, 9.8, "2023-06-15");
        UUID dach = root().queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "capacity_kwp) VALUES (?, ?::uuid, 'pv-generation', 'WR Dach', 9.8) RETURNING id",
                UUID.class, TENANT_A, site);
        root().update("INSERT INTO measurement_point (tenant_id, site_id, role, label, capacity_kwp, "
                + "registry_unit_id) VALUES (?, ?::uuid, 'pv-generation', 'WR Dach Ost', 1, ?)",
                TENANT_A, site, PV_UNIT);

        // EA 1 folgt der Anlage: ihre Wechselrichter ohne eigene SEE-Nummer und der mit ihrer SEE-Nummer gehören
        // still zu ihr - die einfache Anlage sieht keinen Vorschlag.
        assertThat(list(liste(site, token).get("vorschlaege"))).isEmpty();

        // Ab der zweiten EA folgt keine mehr: jetzt fragt jeder Wechselrichter ohne Verweis, wohin er gehört.
        ResponseEntity<Map<String, Object>> zweite = post("/api/v1/sites/" + site + "/erzeugungsanlagen",
                Map.of("leistungKwp", 5, "inbetriebnahme", "2025-05-12"), token);
        assertThat(zweite.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(list(zweite.getBody().get("vorschlaege"))).extracting(v -> v.get("name"))
                .containsExactly("WR Dach", "WR Dach Ost");
        assertThat(list(zweite.getBody().get("vorschlaege")).get(0)).containsEntry("komponenteId", dach.toString());
    }

    // ============================================================================== Zaun

    @Test
    void eineFremdeAnlageIst404() {
        String site = neueAnlage("Fremd");
        String tokenB = token("demo2", "demo2");
        assertThat(rest.exchange(url("/api/v1/sites/" + site + "/erzeugungsanlagen"), HttpMethod.GET,
                new HttpEntity<>(bearer(tokenB)), String.class).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(post("/api/v1/sites/" + site + "/erzeugungsanlagen", Map.of("leistungKwp", 5), tokenB)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ------------------------------------------------------------------------------------------ Hilfen

    /** Satz, Herkunft, Förderende und § 51a der EA sind die der Karte „Einspeisevergütung“. */
    private void gleichDerKarte(String site, String token, Map<String, Object> ea) {
        Map<String, Object> karte = get("/api/v1/sites/" + site + "/einspeiseverguetung", token);
        Map<String, Object> v = map(ea.get("verguetung"));
        assertThat(v.get("zustand")).isEqualTo(karte.get("zustand"));
        assertThat(zahlOderNull(v.get("wirksamCtKwh"))).isEqualTo(zahlOderNull(karte.get("wirksamCtKwh")));
        assertThat(zahlOderNull(v.get("hergeleitetCtKwh"))).isEqualTo(zahlOderNull(karte.get("hergeleitetCtKwh")));
        assertThat(zahlOderNull(v.get("angegebenCtKwh"))).isEqualTo(zahlOderNull(karte.get("angegebenCtKwh")));
        assertThat(v.get("foerderendeAm")).isEqualTo(karte.get("eegEndeAm"));
        assertThat(v.get("ohneVerguetungBeiNegativpreis")).isEqualTo(karte.get("ohneVerguetungBeiNegativpreis"));
        assertThat(texte(v.get("naeherung")).contains("jahresstufen")
                || texte(v.get("naeherung")).contains("vor_erstem_band"))
                .isEqualTo(karte.get("hergeleitetGenaehert"));
        assertThat(ea.get("inbetriebnahme")).isEqualTo(karte.get("inbetriebnahme"));
        assertThat(zahlOderNull(map(ea.get("fassung")).get("leistungKwp")))
                .isEqualTo(zahlOderNull(karte.get("leistungKwp")));
    }

    private void uebernehmen(String site, String token, double kwp, String inbetriebnahme) {
        ResponseEntity<String> r = rest.exchange(url("/api/v1/sites/" + site + "/mastr-apply"), HttpMethod.POST,
                new HttpEntity<>(Map.of("pv", Map.of("mastrNummer", PV_UNIT, "capacityKwp", kwp,
                        "commissionedOn", inbetriebnahme)), bearer(token)), String.class);
        assertThat(r.getStatusCode()).as(r.getBody()).isEqualTo(HttpStatus.OK);
    }

    private Map<String, Object> einzige(String site, String token) {
        List<Map<String, Object>> eas = list(liste(site, token).get("erzeugungsanlagen"));
        assertThat(eas).hasSize(1);
        return eas.get(0);
    }

    private Map<String, Object> eaAm(String site, String token, int nummer, String tag) {
        return list(get("/api/v1/sites/" + site + "/erzeugungsanlagen?stichtag=" + tag, token)
                .get("erzeugungsanlagen")).stream().filter(e -> Integer.valueOf(nummer).equals(e.get("nummer")))
                .findFirst().orElseThrow();
    }

    private Map<String, Object> liste(String site, String token) {
        return get("/api/v1/sites/" + site + "/erzeugungsanlagen", token);
    }

    private static Map<String, Object> fassung(String ab, double kwp, String art, Double satz) {
        Map<String, Object> f = new HashMap<>();
        f.put("gueltigAb", ab);
        f.put("leistungKwp", kwp);
        f.put("einspeiseart", art);
        f.put("satzAngegebenCtKwh", satz);
        return f;
    }

    private String neueAnlage(String name) {
        return root().queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, ?) RETURNING id", UUID.class,
                TENANT_A, name).toString();
    }

    private static JdbcTemplate root() {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(POSTGRES.getUsername());
        ds.setPassword(POSTGRES.getPassword());
        return new JdbcTemplate(ds);
    }

    private Map<String, Object> get(String path, String token) {
        ResponseEntity<Map<String, Object>> r = rest.exchange(url(path), HttpMethod.GET,
                new HttpEntity<>(bearer(token)), new ParameterizedTypeReference<>() {});
        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.OK);
        return r.getBody();
    }

    private String roh(String path, String token) {
        ResponseEntity<String> r = rest.exchange(url(path), HttpMethod.GET, new HttpEntity<>(bearer(token)),
                String.class);
        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.OK);
        return r.getBody();
    }

    private ResponseEntity<Map<String, Object>> post(String path, Map<String, ?> body, String token) {
        return exchange(HttpMethod.POST, path, body, token);
    }

    private ResponseEntity<Map<String, Object>> exchange(HttpMethod method, String path, Map<String, ?> body,
            String token) {
        return rest.exchange(url(path), method, new HttpEntity<>(body, bearer(token)),
                new ParameterizedTypeReference<>() {});
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object o) {
        return (Map<String, Object>) o;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> list(Object o) {
        return (List<Map<String, Object>>) o;
    }

    @SuppressWarnings("unchecked")
    private static List<String> texte(Object o) {
        return (List<String>) o;
    }

    private static BigDecimal zahl(Object o) {
        return new BigDecimal(String.valueOf(o));
    }

    private static BigDecimal zahlOderNull(Object o) {
        return o == null ? null : new BigDecimal(String.valueOf(o)).stripTrailingZeros();
    }

    private String url(String path) {
        return "http://localhost:" + port + path;
    }

    private static HttpHeaders bearer(String token) {
        HttpHeaders h = new HttpHeaders();
        h.setBearerAuth(token);
        h.setContentType(MediaType.APPLICATION_JSON);
        return h;
    }

    private String token(String username, String password) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", "voltpilot-api");
        form.add("client_secret", "voltpilot-api-dev-secret");
        form.add("username", username);
        form.add("password", password);
        form.add("scope", "openid");
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        @SuppressWarnings("unchecked")
        Map<String, Object> body = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("token response").containsKey("access_token");
        return (String) body.get("access_token");
    }
}
