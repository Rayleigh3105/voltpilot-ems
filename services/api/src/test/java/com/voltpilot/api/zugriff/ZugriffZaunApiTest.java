package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.SpyBean;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpMethod;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Zaun von UEMS AP-03 IP-4 über ALLE Routen des API (aus dem {@link RequestMappingHandlerMapping}, keine Liste von
 * Hand) — mit dem Demo-Kundenbereich des Dev-Seeds.
 *
 * <ol>
 *   <li><b>Partner ohne wirksame Unterstützung: 404 auf jeder Kundenroute</b>, jede Methode, in acht Varianten (ohne
 *       Kopf, fremder/kaputter Kopf, {@code X-Tenant-Id}, beendete Unterstützung, Unterstützung in einem ANDEREN
 *       Kundenbereich, Plattform mit {@code X-Kundenbereich} ohne Unterstützung).</li>
 *   <li><b>Die Einstellungen je Anfrage</b> über eine Test-Route, die {@code current_setting} liest: jeder Aufrufer
 *       sieht seine eigenen, auch abwechselnd hintereinander (der Pool gibt Verbindungen weiter).</li>
 *   <li><b>Bestand: jedes heutige Konto sieht auf jeder lesenden Kundenroute dasselbe wie vor IP-4.</b> „Vorher" ist
 *       derselbe Aufbau, in dem der {@link ZugriffKontextLader} nichts lädt — dann bleibt der Kontext leer, der Filter
 *       reicht durch, und die Verbindung setzt nur {@code app.tenant_id}, genau wie vor diesem Paket. Verglichen werden
 *       Status und Körper; eine Route, deren Antwort schon zwischen zwei „vorher"-Aufrufen wechselt (Zeitstempel),
 *       zählt als flüchtig und wird nur am Status gemessen.</li>
 * </ol>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
@Import(ZugriffZaunApiTest.SitzungsRoute.class)
class ZugriffZaunApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final UUID DEMO = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID NORDWIND = UUID.fromString("10000000-0000-0000-0000-000000000001");
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";
    private static final String KUNDENBEREICH = ZugriffKontextLader.KUNDENBEREICH_HEADER;
    private static final String TENANT = "X-Tenant-Id";
    static final String SITZUNG = "/api/v1/test-sitzung";

    private static final String PARTNER_GEWAEHRT = "sub-zaun-partner-gewaehrt";
    private static final String PARTNER_BEENDET = "sub-zaun-partner-beendet";
    private static final String KUNDE_KA = "sub-zaun-kundenadministrator";
    private static final String KUNDE_LESER = "sub-zaun-leser";
    private static final String KUNDE_OHNE = "sub-zaun-ohne-zuweisung";

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

    /** Liest die drei Sitzungs-Einstellungen der Verbindung, die die Anfrage bekommt. */
    @RestController
    static class SitzungsRoute {
        private final JdbcTemplate jdbc;

        SitzungsRoute(JdbcTemplate jdbc) {
            this.jdbc = jdbc;
        }

        @GetMapping(SITZUNG)
        Map<String, Object> sitzung() {
            return jdbc.queryForMap("SELECT coalesce(current_setting('app.tenant_id', true), '') AS tenant, "
                    + "coalesce(current_setting('app.zugriff', true), '') AS zugriff, "
                    + "coalesce(current_setting('app.standort_ids', true), '') AS standort_ids");
        }
    }

    @Autowired
    MockMvc mvc;

    @Autowired
    @Qualifier("requestMappingHandlerMapping")
    RequestMappingHandlerMapping mapping;

    @SpyBean
    ZugriffKontextLader lader;

    /** {@code true} = „vorher": der Lader lädt nichts, der Filter reicht durch. */
    private static final AtomicBoolean VORHER = new AtomicBoolean();

    private static JdbcTemplate root;
    private static UUID demoStandort;

    private record Route(HttpMethod methode, String muster, String pfad) {
        @Override
        public String toString() {
            return methode + " " + muster;
        }
    }

    private record Konto(String name, Authentication auth, String[] koepfe) {}

    private record Antwort(int status, String body) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void ladeWieVorherOderNachher() {
        VORHER.set(false);
        doAnswer(inv -> VORHER.get() ? ZugriffKontextLader.Ergebnis.keiner() : inv.callRealMethod())
                .when(lader).laden(any(), any());
        if (demoStandort == null) {
            seed();
        }
    }

    @Test
    void einPartnerOhneWirksameUnterstuetzungBekommtAufJederKundenroute404() throws Exception {
        List<Route> routen = kundenrouten(false);
        Authentication ohne = konto("sub-zaun-partner-ohne", null, "partner");
        Authentication beendet = konto(PARTNER_BEENDET, null, "partner");
        Authentication gewaehrt = konto(PARTNER_GEWAEHRT, null, "partner");
        Authentication plattform = konto("sub-zaun-plattform", null, "platform-admin");
        List<Konto> varianten = List.of(
                new Konto("Partner ohne Kopf", ohne, new String[0]),
                new Konto("Partner, X-Kundenbereich ohne Unterstützung", ohne,
                        new String[] {KUNDENBEREICH, DEMO.toString()}),
                new Konto("Partner, X-Kundenbereich unbekannt", ohne,
                        new String[] {KUNDENBEREICH, UUID.randomUUID().toString()}),
                new Konto("Partner, X-Kundenbereich keine Kennung", ohne, new String[] {KUNDENBEREICH, "demo"}),
                new Konto("Partner, X-Tenant-Id", ohne, new String[] {TENANT, DEMO.toString()}),
                new Konto("Partner, Unterstützung beendet", beendet, new String[] {KUNDENBEREICH, DEMO.toString()}),
                new Konto("Partner, Unterstützung nur in einem anderen Kundenbereich", gewaehrt,
                        new String[] {KUNDENBEREICH, NORDWIND.toString()}),
                new Konto("Plattform, X-Kundenbereich ohne Unterstützung neben X-Tenant-Id", plattform,
                        new String[] {KUNDENBEREICH, DEMO.toString(), TENANT, DEMO.toString()}));

        Map<String, List<String>> nicht404 = new TreeMap<>();
        for (Route r : routen) {
            for (Konto v : varianten) {
                int status = ruf(r, v).status();
                if (status != 404) {
                    nicht404.computeIfAbsent(v.name(), x -> new ArrayList<>()).add(r + " → " + status);
                }
            }
        }
        System.out.printf("Zaun: %d Kundenrouten × %d Varianten, außerhalb /api/v1: %s%n", routen.size(),
                varianten.size(), ausserhalb());
        assertThat(routen).hasSizeGreaterThan(300);
        assertThat(nicht404).isEmpty();
    }

    @Test
    void mitWirksamerUnterstuetzungGiltDerKundenbereichUndJedeAnfrageSiehtIhreEinstellungen() throws Exception {
        Konto partner = new Konto("Partner mit Unterstützung", konto(PARTNER_GEWAEHRT, null, "partner"),
                new String[] {KUNDENBEREICH, DEMO.toString()});
        Konto umschalter = new Konto("Plattform am Umschalter", konto("sub-zaun-plattform", null, "platform-admin"),
                new String[] {TENANT, DEMO.toString()});
        Konto plattformOhne = new Konto("Plattform ohne Kopf", konto("sub-zaun-plattform", null, "platform-admin"),
                new String[0]);
        Konto ka = new Konto("Kundenadministrator", konto(KUNDE_KA, DEMO, "operator"), new String[0]);
        Konto leser = new Konto("Leser", konto(KUNDE_LESER, DEMO), new String[0]);
        Konto ohne = new Konto("Kundenkonto ohne Zuweisung", konto(KUNDE_OHNE, DEMO), new String[0]);
        String ids = "{" + demoStandort + "}";

        assertThat(ruf(get("/api/v1/sites"), partner).status()).isEqualTo(200);
        for (int runde = 0; runde < 2; runde++) {
            assertThat(sitzung(partner)).isEqualTo(List.of(DEMO.toString(), "standorte", ids));
            assertThat(sitzung(ka)).isEqualTo(List.of(DEMO.toString(), "unternehmen", "{}"));
            assertThat(sitzung(partner)).isEqualTo(List.of(DEMO.toString(), "standorte", ids));
            assertThat(sitzung(leser)).isEqualTo(List.of(DEMO.toString(), "standorte", ids));
            assertThat(sitzung(umschalter)).isEqualTo(List.of(DEMO.toString(), "unternehmen", "{}"));
            assertThat(sitzung(ohne)).isEqualTo(List.of(DEMO.toString(), "standorte", "{}"));
            assertThat(sitzung(plattformOhne)).isEqualTo(List.of("", "", ""));
        }
        Konto partnerFremd = new Konto("Partner, Kopf auf Nordwind", partner.auth(),
                new String[] {KUNDENBEREICH, NORDWIND.toString()});
        assertThat(ruf(get(SITZUNG), partnerFremd).status()).isEqualTo(404);
        assertThat(sitzung(partner)).as("danach wieder die eigene").isEqualTo(List.of(DEMO.toString(), "standorte", ids));
    }

    @Test
    void jedesHeutigeKontoSiehtAufJederLesendenKundenrouteDasselbeWieVorIp4() throws Exception {
        List<Route> routen = kundenrouten(true);
        List<Konto> konten = List.of(
                new Konto("Kundenkonto (Bestandsübernahme: Kundenadministrator)", konto(KUNDE_KA, DEMO, "operator"),
                        new String[0]),
                new Konto("Kundenkonto ohne Realm-Rolle, ohne Zuweisung", konto(KUNDE_OHNE, DEMO), new String[0]),
                new Konto("Kundenkonto mit Standort-Zuweisung (Leser)", konto(KUNDE_LESER, DEMO), new String[0]),
                new Konto("Plattform mit X-Tenant-Id", konto("sub-zaun-plattform", null, "platform-admin"),
                        new String[] {TENANT, DEMO.toString()}),
                new Konto("Plattform ohne Kopf", konto("sub-zaun-plattform", null, "platform-admin"),
                        new String[0]));
        List<String> abweichungen = new ArrayList<>();
        Set<String> fluechtig = new TreeSet<>();
        int mitDaten = 0;
        for (Route r : routen) {
            for (Konto k : konten) {
                Antwort vorher1 = vorher(r, k);
                Antwort nachher = ruf(r, k);
                Antwort vorher2 = vorher(r, k);
                if (vorher1.status() != vorher2.status()) {
                    fluechtig.add(r.toString());
                } else if (nachher.status() != vorher2.status()) {
                    abweichungen.add(k.name() + ": " + r + " vorher " + vorher2.status() + ", nachher " + nachher.status());
                } else if (!vorher1.body().equals(vorher2.body())) {
                    fluechtig.add(r.toString());
                } else if (!nachher.body().equals(vorher2.body())) {
                    abweichungen.add(k.name() + ": " + r + " Körper weicht ab");
                } else if (nachher.status() == 200 && nachher.body().length() > 2) {
                    mitDaten++;
                }
            }
        }
        System.out.printf("Bestand: %d lesende Kundenrouten × %d Konten, %d Antworten mit Daten gleich, flüchtig: %s%n",
                routen.size(), konten.size(), mitDaten, fluechtig);
        assertThat(ruf(get("/api/v1/sites"), konten.get(0)).body()).contains(BERLIN_SITE);
        assertThat(routen).hasSizeGreaterThan(150);
        assertThat(mitDaten).isGreaterThan(100);
        assertThat(abweichungen).isEmpty();
    }

    // ------------------------------------------------------------------ Routen

    private List<Route> kundenrouten(boolean nurLesend) {
        List<Route> aus = new ArrayList<>();
        mapping.getHandlerMethods().forEach((info, handler) -> {
            Set<RequestMethod> methoden = info.getMethodsCondition().getMethods();
            for (String muster : info.getPatternValues()) {
                if (!muster.startsWith("/api/v1/") || muster.startsWith("/api/v1/admin/")
                        || muster.equals(ZugriffFilter.SELBSTAUSKUNFT) || muster.equals(SITZUNG)) {
                    continue;
                }
                for (RequestMethod m : methoden.isEmpty() ? Set.of(RequestMethod.GET) : methoden) {
                    if (!nurLesend || m == RequestMethod.GET) {
                        aus.add(new Route(HttpMethod.valueOf(m.name()), muster, fuelle(muster)));
                    }
                }
            }
        });
        aus.sort(Comparator.comparing(Route::muster).thenComparing(r -> r.methode().name()));
        return aus;
    }

    /** Die Muster außerhalb von {@code /api/v1/} — keine Kundenrouten; im Protokoll sichtbar, damit eine auffällt. */
    private Set<String> ausserhalb() {
        Set<String> aus = new TreeSet<>();
        for (RequestMappingInfo info : mapping.getHandlerMethods().keySet()) {
            info.getPatternValues().stream().filter(m -> !m.startsWith("/api/v1/")).forEach(aus::add);
        }
        return aus;
    }

    /** Setzt für jede Variable die Anlage des Demo-Seeds ein (auch in {@code {name:regex}}), {@code *} wird {@code x}. */
    private static String fuelle(String muster) {
        StringBuilder s = new StringBuilder();
        int tiefe = 0;
        for (char c : muster.toCharArray()) {
            if (c == '{') {
                if (tiefe++ == 0) {
                    s.append(BERLIN_SITE);
                }
            } else if (c == '}') {
                tiefe--;
            } else if (tiefe == 0) {
                s.append(c == '*' ? 'x' : c);
            }
        }
        return s.toString().replace("xx", "x");
    }

    // ------------------------------------------------------------------ Anfragen

    private Antwort vorher(Route r, Konto k) throws Exception {
        VORHER.set(true);
        try {
            return ruf(r, k);
        } finally {
            VORHER.set(false);
        }
    }

    private Antwort ruf(Route r, Konto k) throws Exception {
        return ruf(MockMvcRequestBuilders.request(r.methode(), URI.create(r.pfad())), k);
    }

    private Antwort ruf(MockHttpServletRequestBuilder anfrage, Konto k) throws Exception {
        anfrage.with(authentication(k.auth()));
        for (int i = 0; i < k.koepfe().length; i += 2) {
            anfrage.header(k.koepfe()[i], k.koepfe()[i + 1]);
        }
        MvcResult res = mvc.perform(anfrage).andReturn();
        return new Antwort(res.getResponse().getStatus(), res.getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    private static MockHttpServletRequestBuilder get(String pfad) {
        return MockMvcRequestBuilders.get(URI.create(pfad));
    }

    private List<String> sitzung(Konto k) throws Exception {
        Antwort a = ruf(get(SITZUNG), k);
        assertThat(a.status()).as(k.name()).isEqualTo(200);
        JsonNode n = MAPPER.readTree(a.body());
        return List.of(n.path("tenant").asText(), n.path("zugriff").asText(), n.path("standort_ids").asText());
    }

    private static Authentication konto(String sub, UUID tenant, String... realmRollen) {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", sub);
        claims.put("preferred_username", sub);
        claims.put("realm_access", Map.of("roles", List.of(realmRollen)));
        if (tenant != null) {
            claims.put("tenant_id", tenant.toString());
        }
        Jwt jwt = new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600), Map.of("alg", "none"), claims);
        return new KeycloakRealmRoleConverter().convert(jwt);
    }

    // ------------------------------------------------------------------ Seed

    /**
     * Im Demo-Kundenbereich: ein Kundenadministrator (wie nach der Bestandsübernahme), ein Leser am ersten Standort, ein
     * Partner mit wirksamer und einer mit beendeter Unterstützung (Installateur) am selben Standort.
     */
    private static void seed() {
        demoStandort = root.queryForList("SELECT id FROM standort WHERE tenant_id = ? ORDER BY created_at, id",
                UUID.class, DEMO).stream().findFirst().orElseGet(ZugriffZaunApiTest::neuerDemoStandort);
        spiegel(KUNDE_KA, "benutzer");
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, 'kundenadministrator', ?, 'Europe/Berlin')", DEMO, KUNDE_KA, ab("2024-01-01"));
        spiegel(KUNDE_LESER, "benutzer");
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, 'leser', ?, ?, 'Europe/Berlin')", DEMO, KUNDE_LESER, demoStandort, ab("2024-01-01"));
        spiegel(PARTNER_GEWAEHRT, "partner");
        unterstuetzung(PARTNER_GEWAEHRT, "2026-01-01", "2099-12-30");
        spiegel(PARTNER_BEENDET, "partner");
        unterstuetzung(PARTNER_BEENDET, "2026-01-01", "2026-02-01");
    }

    private static UUID neuerDemoStandort() {
        UUID unternehmen = root.queryForList("SELECT id FROM unternehmen WHERE tenant_id = ?", UUID.class, DEMO).stream()
                .findFirst().orElseGet(() -> root.queryForObject("INSERT INTO unternehmen (tenant_id, name) "
                        + "VALUES (?, 'Demo') RETURNING id", UUID.class, DEMO));
        return root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Demo-Standort', 'ST-90', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class,
                DEMO, unternehmen);
    }

    private static void spiegel(String sub, String konto) {
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, ?, ?, 'aktiv')",
                DEMO, sub, konto, sub);
    }

    private static void unterstuetzung(String sub, String von, String bis) {
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, art, umfang, gueltig_ab, "
                + "gueltig_bis, endet_am, zeitzone) VALUES (?, ?, 'unterstuetzer', ?, 'installateur', 'ansehen', ?, ?, ?, "
                + "'Europe/Berlin')", DEMO, sub, demoStandort, ab(von), LocalDate.parse(bis),
                LocalDate.parse(bis).plusDays(1).atStartOfDay(java.time.ZoneId.of("Europe/Berlin")).toOffsetDateTime());
    }

    private static OffsetDateTime ab(String tag) {
        return LocalDate.parse(tag).atStartOfDay().atOffset(ZoneOffset.ofHours(1));
    }
}
