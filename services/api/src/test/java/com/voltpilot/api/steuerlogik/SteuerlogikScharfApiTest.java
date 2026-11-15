package com.voltpilot.api.steuerlogik;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.consumers.ConsumerPolicyActivationService;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.FlowClaimRepository;
import com.voltpilot.api.repo.SteuerlogikRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import com.voltpilot.api.ueberwachung.SteuerlogikWerteLeser;
import com.voltpilot.api.ueberwachung.WerteKatalog;
import com.voltpilot.api.ueberwachung.WerteLeser;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Steuerlogik Stufe 3 ("scharf") über die echte API und Datenbank. Der Logik-Dienst antwortet mit seiner gepinnten
 * Antwort für das Warmwasser-Beispiel ({@code steuerlogik-dienst.valid.wasser-scharf.json}, gehalten von
 * {@code logikdienst_test.go}), auf diese Anlage gestellt. Geprüft: Scharfschalten ist ein eigener, protokollierter
 * Schritt mit einer Bestätigung; die Logik beansprucht ihr Gerät ({@code flow_claim}, Registry-Push); ein zweiter
 * Herr wird abgewiesen, in beide Richtungen; "Zurück" und "Stilllegen" gehen in derselben Anfrage an die Box; der
 * Kunde sieht die Karte, stellt Werte nach {@code editable_by} und Rolle, und eine Störung wird eine Meldung.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class SteuerlogikScharfApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path V2 = Path.of("../../docs/contracts/v2");
    /** Die Kennung des Stabs in der gepinnten Antwort des Dienstes. */
    private static final String STAB_IM_BEISPIEL = "7b0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

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

    @Autowired MockMvc mvc;
    @Autowired DeviceRepository devices;
    @Autowired SteuerlogikRepository logiken;
    @Autowired FlowClaimRepository claims;
    @Autowired TransactionTemplate tx;
    @Autowired ConsumerPolicyActivationService steuerarten;
    @Autowired SteuerlogikWerteLeser meldungsLeser;
    @Autowired WerteKatalog katalog;
    @MockitoSpyBean BoxFaehigkeiten faehigkeiten;
    @MockitoSpyBean EntityRegistryService registry;
    @MockitoBean SteuerlogikDienst dienst;
    @MockitoBean FlowDeploymentPublisher publisher;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();
    private final List<SteuerlogikDienst.Auftrag> auftraege = new ArrayList<>();
    /** Statt des gepinnten Befehls verlangt das scharfe Artefakt diesen (null = wie gepinnt). */
    private String verlangtScharf;

    /** Eine Anlage mit Box, Heizstab, Standort und drei Menschen mit ihren Rollen. */
    private record Welt(UUID mandant, UUID site, UUID box, UUID stab, UUID standort) {
        String admin() {
            return "/api/v1/admin/sites/" + site + "/steuerlogik";
        }

        String kunde() {
            return "/api/v1/sites/" + site + "/steuerlogik";
        }

        String admin(UUID logik, String rest) {
            return admin() + "/" + logik + rest;
        }

        String sub(String rolle) {
            return "sub-" + rolle + "-" + mandant;
        }
    }

    private record Antwort(int status, JsonNode body) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    /**
     * Der Dienst antwortet wie gepinnt, auf Logik, Fassung, Gerät, Zustand und Werte des Auftrags gestellt; der Hash
     * folgt dem Bündel (scharf und Werte ändern ihn wie beim echten Dienst). Den Wert {@code netz_ab} legt hier der
     * Fachbetrieb fest, damit die Rollen etwas zu unterscheiden haben.
     */
    @BeforeEach
    void dienstWieGepinnt() throws Exception {
        String gepinnt = Files.readString(V2.resolve("examples/steuerlogik-dienst.valid.wasser-scharf.json"));
        when(dienst.artefakt(any())).thenAnswer(inv -> {
            SteuerlogikDienst.Auftrag a = inv.getArgument(0);
            auftraege.add(a);
            String stab = root.queryForObject("SELECT id::text FROM measurement_point WHERE entity_type = "
                    + "'heating-rod' AND label = 'Heizstab' AND site_id = ?", String.class, siteAus(a));
            JsonNode antwort = MAPPER.readTree(gepinnt.replace(STAB_IM_BEISPIEL, stab));
            ObjectNode art = antwort.path("artifact").deepCopy();
            art.put("flow_id", a.logikId().toString());
            art.put("flow_version", a.fassung());
            ObjectNode bundle = (ObjectNode) art.path("bundle");
            bundle.remove("settings");
            bundle.remove("armed");
            if (a.scharf()) bundle.put("armed", true);
            SteuerlogikDienst.Werte werte = a.werte();
            if (werte != null) {
                ObjectNode s = bundle.putObject("settings");
                s.put("revision", werte.stand());
                ObjectNode v = s.putObject("values");
                werte.werte().forEach(v::set);
            }
            if (!a.scharf()) {
                for (JsonNode r : art.path("required_entities")) ((ObjectNode) r).putArray("capabilities");
            } else if (verlangtScharf != null) {
                for (JsonNode r : art.path("required_entities")) {
                    ((ObjectNode) r).putArray("capabilities").add(verlangtScharf);
                }
            }
            art.put("content_hash", "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(bundle.toString().getBytes(StandardCharsets.UTF_8))));
            ObjectNode bericht = antwort.path("bericht").deepCopy();
            for (JsonNode s : bericht.path("stellwerte")) {
                if ("netz_ab".equals(s.path("kennung").asText())) ((ObjectNode) s).put("darf", "installer");
            }
            return new SteuerlogikDienst.Artefakt(art, bericht, werte, List.of());
        });
        when(publisher.publishDeployment(any(), any(), any(), any())).thenReturn(true);
    }

    @Test
    void scharfSchaltenZurueckUndStilllegenWirkenSofort() throws Exception {
        Welt w = welt();
        UUID logik = annehmen(w);

        // Der Dialog: Hinweise gesammelt, kein Konflikt, die Box kann es.
        JsonNode vorschau = plattform(w, get(w.admin(logik, "/scharf"))).body();
        assertThat(vorschau.path("moeglich").asBoolean()).as(vorschau.toString()).isTrue();
        assertThat(vorschau.path("hinweise").toString())
                .contains(SteuerlogikService.HINWEIS_ALTE_STEUERUNG, "im erlaubten Bereich verletzen");
        assertThat(vorschau.path("geraete").toString()).contains("Heizstab");
        assertThat(vorschau.path("kundeStellt")).hasSize(4);

        // Ohne Bestätigung und an einer Box ohne die Fähigkeit geht nichts scharf.
        assertThat(plattform(w, post(w.admin(logik, "/scharf")).content("{\"fassung\":1}")).body().path("grund")
                .asText()).isEqualTo("bestaetigung_fehlt");
        doReturn(false).when(faehigkeiten).kann(w.box(), SteuerlogikAuslieferung.FAEHIGKEIT_SCHARF);
        assertThat(scharf(w, logik, 1).body().path("grund").asText()).isEqualTo("box_ohne_scharf");
        doReturn(true).when(faehigkeiten).kann(w.box(), SteuerlogikAuslieferung.FAEHIGKEIT_SCHARF);
        assertThat(zustaende(logik)).containsExactly("mitlaufend");

        clearInvocations(publisher, registry);
        Antwort scharf = scharf(w, logik, 1);
        assertThat(scharf.status()).as(scharf.body().toString()).isEqualTo(200);
        assertThat(scharf.body().path("zustand").asText()).isEqualTo("scharf");
        assertThat(zustaende(logik)).containsExactly("scharf");
        assertThat(root.queryForObject("SELECT scharf_von FROM steuerlogik WHERE logik_id = ?", String.class, logik))
                .isEqualTo("sub-betrieb");
        assertThat(root.queryForObject("SELECT hinweise::text FROM steuerlogik WHERE logik_id = ?", String.class,
                logik)).contains("Home Assistant");
        JsonNode artefakt = einzigesSteuerlogikArtefakt(letzterSatz(w));
        assertThat(artefakt.path("bundle").path("armed").asBoolean()).as("der Satz trägt das scharfe Bündel").isTrue();
        assertThat(artefakt.path("required_entities").get(0).path("capabilities").get(0).asText())
                .isEqualTo("actuate:setpoint_kw");
        assertThat(besitzer(w)).as("die Logik beansprucht ihr Gerät").containsEntry(w.stab(), "Warmwasser");
        verify(registry, atLeastOnce()).pushRegistryBestEffort(w.site());
        assertThat(protokoll(logik)).containsExactly("angenommen", "scharf");

        // Die Gegenrichtung: eine Steuerart auf dem Stab der Logik wird abgewiesen, nicht still übernommen.
        root.update("INSERT INTO consumer_policy (entity_id, tenant_id, site_id, version, lifecycle, document, "
                + "content_hash) VALUES (?, ?, ?, 1, 'draft', '{}'::jsonb, 'x')", w.stab(), w.mandant(), w.site());
        TenantContext.set(w.mandant());
        try {
            assertThatThrownBy(() -> steuerarten.activate(w.site(), w.stab(), "sub-kunde"))
                    .isInstanceOf(ResponseStatusException.class).hasMessageContaining("gehört der Logik");
        } finally {
            TenantContext.clear();
            root.update("DELETE FROM consumer_policy WHERE entity_id = ?", w.stab());
        }

        // Eine neue Fassung löst eine scharfe nur scharf ab.
        Antwort ohneScharf = plattform(w, post(w.admin(logik, "/fassungen")).content(text("logic: 1", false)));
        assertThat(ohneScharf.body().path("grund").asText()).isEqualTo("scharf_abloesen");
        Antwort zwei = plattform(w, post(w.admin(logik, "/fassungen")).content(text("logic: 1", true)));
        assertThat(zwei.status()).as(zwei.body().toString()).isEqualTo(201);
        assertThat(zwei.body().path("zustand").asText()).isEqualTo("scharf");
        assertThat(zustaende(logik)).containsExactly("stillgelegt", "scharf");

        // Zurück zur vorigen Fassung: im selben Zustand, in derselben Anfrage an die Box.
        clearInvocations(publisher);
        Antwort zurueck = plattform(w, post(w.admin(logik, "/zurueck")));
        assertThat(zurueck.status()).as(zurueck.body().toString()).isEqualTo(200);
        assertThat(zurueck.body().path("fassung").asInt()).isEqualTo(1);
        assertThat(zustaende(logik)).containsExactly("scharf", "stillgelegt");
        JsonNode nachZurueck = einzigesSteuerlogikArtefakt(letzterSatz(w));
        assertThat(nachZurueck.path("flow_version").asInt()).isEqualTo(1);
        assertThat(nachZurueck.path("bundle").path("armed").asBoolean()).isTrue();
        assertThat(besitzer(w)).containsEntry(w.stab(), "Warmwasser");
        JsonNode schritte = plattform(w, get(w.admin(logik, "/protokoll"))).body().path("schritte");
        assertThat(schritte.get(0).path("was").asText()).isEqualTo("zurueck");
        assertThat(schritte.get(0).path("daten").path("von").asInt()).isEqualTo(2);
        assertThat(schritte.get(0).path("daten").path("auf").asInt()).isEqualTo(1);
        assertThat(plattform(w, post(w.admin(logik, "/zurueck"))).body().path("grund").asText())
                .isEqualTo("keine_vorige");

        // Stilllegen: der Satz geht ohne die Logik hinaus, der Besitz fällt weg.
        clearInvocations(publisher, registry);
        Antwort still = plattform(w, post(w.admin(logik, "/stilllegen")));
        assertThat(still.body().path("stillgelegt").asBoolean()).isTrue();
        assertThat(steuerlogikArtefakte(letzterSatz(w))).isEmpty();
        assertThat(besitzer(w)).doesNotContainKey(w.stab());
        verify(registry, atLeastOnce()).pushRegistryBestEffort(w.site());
        assertThat(protokoll(logik)).endsWith("stillgelegt");
    }

    @Test
    void einZweiterHerrWirdAbgewiesenNichtStillAufgeloest() throws Exception {
        Welt w = welt();
        UUID logik = annehmen(w);

        // Ein Befehl, den das Gerät laut Registry nicht ausführt (ein Sollwert in °C am Heizstab): schon der Dialog
        // nennt ihn, und Scharfschalten lehnt ab - wie die Box das Bündel nicht annähme.
        verlangtScharf = "actuate:setpoint_c";
        JsonNode ohneBefehl = plattform(w, get(w.admin(logik, "/scharf"))).body();
        assertThat(ohneBefehl.path("moeglich").asBoolean()).as(ohneBefehl.toString()).isFalse();
        assertThat(ohneBefehl.path("konflikte").get(0).path("art").asText()).isEqualTo("ausgang_offen");
        assertThat(ohneBefehl.path("konflikte").get(0).path("text").asText()).contains("Sollwert in °C");
        Antwort ohne = scharf(w, logik, 1);
        assertThat(ohne.status()).isEqualTo(409);
        assertThat(ohne.body().path("konflikte").get(0).path("art").asText()).isEqualTo("ausgang_offen");
        assertThat(zustaende(logik)).containsExactly("mitlaufend");
        verlangtScharf = null;

        // Eine Steuerart am Stab: Scharfschalten wird mit dem Konflikt abgelehnt, nichts ändert sich.
        root.update("INSERT INTO consumer_policy (entity_id, tenant_id, site_id, version, lifecycle, document, "
                + "content_hash) VALUES (?, ?, ?, 1, 'active', '{}'::jsonb, 'x')", w.stab(), w.mandant(), w.site());
        clearInvocations(publisher);
        Antwort mitSteuerart = scharf(w, logik, 1);
        assertThat(mitSteuerart.status()).isEqualTo(409);
        assertThat(mitSteuerart.body().path("grund").asText()).isEqualTo("zweiter_herr");
        assertThat(mitSteuerart.body().path("konflikte").get(0).path("art").asText()).isEqualTo("steuerart");
        assertThat(zustaende(logik)).containsExactly("mitlaufend");
        assertThat(besitzer(w)).doesNotContainKey(w.stab());
        verify(publisher, never()).publishDeployment(any(), any(), any(), any());
        assertThat(plattform(w, get(w.admin(logik, "/scharf"))).body().path("moeglich").asBoolean()).isFalse();
        root.update("DELETE FROM consumer_policy WHERE entity_id = ?", w.stab());

        // Eine andere scharfe Logik am selben Stab: die zweite wird abgelehnt.
        assertThat(scharf(w, logik, 1).status()).isEqualTo(200);
        Antwort neu = plattform(w, post(w.admin()).content(text("logic: 1", false)));
        UUID zweite = UUID.fromString(neu.body().path("logikId").asText());
        Antwort doppelt = scharf(w, zweite, 1);
        assertThat(doppelt.status()).isEqualTo(409);
        assertThat(doppelt.body().path("konflikte").get(0).path("art").asText()).isEqualTo("logik");
        assertThat(doppelt.body().path("konflikte").get(0).path("text").asText()).contains("Warmwasser");
        assertThat(besitzer(w)).containsEntry(w.stab(), "Warmwasser");
    }

    @Test
    void derKundeSiehtSeineKarteUndStelltWerteNachRolle() throws Exception {
        Welt w = welt();
        UUID logik = annehmen(w);
        assertThat(scharf(w, logik, 1).status()).isEqualTo(200);

        // Noch kein Herzschlag: die Karte sagt, dass die Logik auf der Box nicht läuft.
        JsonNode karte = einzigeKarte(w, "bedienberechtigt");
        assertThat(karte.path("stoerungen").get(0).path("code").asText()).isEqualTo("haelt_an");

        // Der Kundenadministrator stellt „Nie kälter als“ auf 42 °C (Stand 1) - der Wert, den der gepinnte Block der
        // Box mit Stand 1 meldet: Cloud und Box stimmen überein, wie im Betrieb.
        Antwort mindest = als(w, "kundenadministrator", put(w.kunde() + "/" + logik + "/stellwerte/mindest")
                .content("{\"wert\":\"42 °C\"}"));
        assertThat(mindest.status()).as(mindest.body().toString()).isEqualTo(200);
        assertThat(mindest.body().path("stand").asInt()).isEqualTo(1);

        // Der Herzschlag mit dem gepinnten scharfen Block der Box.
        SteuerlogikRueckmeldungListener eingang = new SteuerlogikRueckmeldungListener("tcp://127.0.0.1:9", "", "",
                devices, logiken, tx);
        String hash = root.queryForObject("SELECT content_hash FROM steuerlogik WHERE logik_id = ? AND fassung = 1",
                String.class, logik);
        eingang.handle(topic(w), herzschlag(w, logik, hash, null));
        karte = einzigeKarte(w, "bedienberechtigt");
        assertThat(karte.path("name").asText()).isEqualTo("Warmwasser");
        assertThat(karte.path("lage").path("titel").asText()).isEqualTo("Wartet auf Sonnenstrom");
        assertThat(karte.path("stoerungen")).isEmpty();
        JsonNode stab = karte.path("geraete").get(0);
        assertThat(stab.path("befehl").path("stufe").asInt()).isEqualTo(3);
        assertThat(stab.path("schutz").path("code").asText()).isEqualTo("guard_min_on");
        assertThat(karte.path("warum")).isNotEmpty();
        Map<String, JsonNode> werte = new HashMap<>();
        karte.path("stellwerte").forEach(s -> werte.put(s.path("kennung").asText(), s));
        assertThat(werte.get("ziel").path("zielwert").asBoolean()).isTrue();
        assertThat(werte.get("ziel").path("aendern").asBoolean()).as("ein Zielwert: der Kunde immer").isTrue();
        assertThat(werte.get("ziel").path("einheit").asText()).isEqualTo("°C");
        assertThat(werte.get("netz_ab").path("frei").asBoolean()).isFalse();
        assertThat(werte.get("netz_ab").path("aendern").asBoolean()).as("Wert des Fachbetriebs").isFalse();
        assertThat(werte.get("mindest").path("wertBox").asText()).isEqualTo("42 °C");
        assertThat(werte.get("mindest").path("wert").asText()).as("Cloud und Box: derselbe Wert").isEqualTo("42 °C");
        assertThat(werte.get("mindest").path("uebernommen").asBoolean()).isTrue();
        pinneKarte(karte);

        // Bedienberechtigt: der Zielwert ja, der Wert des Fachbetriebs nicht.
        Antwort ziel = als(w, "bedienberechtigt", put(w.kunde() + "/" + logik + "/stellwerte/ziel")
                .content("{\"wert\":\"60 °C\"}"));
        assertThat(ziel.status()).as(ziel.body().toString()).isEqualTo(200);
        assertThat(ziel.body().path("stand").asInt()).isEqualTo(2);
        SteuerlogikDienst.Auftrag letzter = auftraege.get(auftraege.size() - 1);
        assertThat(letzter.scharf()).isTrue();
        assertThat(letzter.werte().werte().get("ziel").asText()).isEqualTo("60 °C");
        assertThat(einzigesSteuerlogikArtefakt(letzterSatz(w)).path("bundle").path("settings").path("revision")
                .asInt()).isEqualTo(2);
        Antwort fachbetrieb = als(w, "bedienberechtigt", put(w.kunde() + "/" + logik + "/stellwerte/netz_ab")
                .content("{\"wert\":\"07:00\"}"));
        assertThat(fachbetrieb.status()).isEqualTo(403);
        assertThat(fachbetrieb.body().path("grund").asText()).isEqualTo("recht_fehlt");

        // Der Kundenadministrator darf auch die Werte des Fachbetriebs (E3 = B).
        Antwort admin = als(w, "kundenadministrator", put(w.kunde() + "/" + logik + "/stellwerte/netz_ab")
                .content("{\"wert\":\"07:00\"}"));
        assertThat(admin.status()).as(admin.body().toString()).isEqualTo(200);
        assertThat(admin.body().path("stand").asInt()).isEqualTo(3);
        assertThat(einzigeKarte(w, "kundenadministrator").path("stellwerte").toString()).contains("\"07:00\"");

        // Was nicht passt, lehnt der Dienst ab - und nichts ändert sich.
        doThrow(new SteuerlogikDienstException(SteuerlogikDienstException.STELLWERTE,
                "„Mit Sonnenstrom bis“: 90 °C liegt außerhalb 45 °C bis 65 °C", null)).when(dienst).artefakt(any());
        Antwort zuHoch = als(w, "bedienberechtigt", put(w.kunde() + "/" + logik + "/stellwerte/ziel")
                .content("{\"wert\":\"90 °C\"}"));
        assertThat(zuHoch.status()).isEqualTo(422);
        assertThat(root.queryForObject("SELECT stand FROM steuerlogik_einstellung WHERE logik_id = ?", Long.class,
                logik)).isEqualTo(3L);
        // Zwei gleichzeitige Änderungen überschreiben einander nicht still: ein veralteter Stand schreibt nichts.
        TenantContext.set(w.mandant());
        try {
            Boolean veraltet = tx.execute(st -> logiken.setzeEinstellungWennStand(w.mandant(), w.site(), logik, 1, 2,
                    "{}", Instant.now()));
            Boolean ersteZeile = tx.execute(st -> logiken.setzeEinstellungWennStand(w.mandant(), w.site(), logik, 0, 1,
                    "{}", Instant.now()));
            assertThat(veraltet).as("ein veralteter Stand schreibt nichts").isFalse();
            assertThat(ersteZeile).as("Stand 0, aber schon eine Zeile da").isFalse();
        } finally {
            TenantContext.clear();
        }
        assertThat(root.queryForObject("SELECT werte FROM steuerlogik_einstellung WHERE logik_id = ?", String.class,
                logik)).contains("07:00");

        // Leser sehen die Karte, ändern aber nichts.
        assertThat(einzigeKarte(w, "leser").path("stellwerte").get(0).path("aendern").asBoolean()).isFalse();
        assertThat(als(w, "leser", put(w.kunde() + "/" + logik + "/stellwerte/ziel").content("{\"wert\":\"50 °C\"}"))
                .status()).isEqualTo(403);

        // Der Verlauf des Tages nennt, wer welchen Wert gestellt hat.
        JsonNode verlauf = als(w, "bedienberechtigt", get(w.kunde() + "/" + logik + "/verlauf")).body();
        List<String> gestellt = new ArrayList<>();
        verlauf.path("schritte").forEach(s -> {
            if ("stellwert".equals(s.path("was").asText())) gestellt.add(s.path("daten").path("kennung").asText());
        });
        assertThat(gestellt).containsExactly("netz_ab", "ziel", "mindest");

        // Eine Störung (Fühler ohne Wert, Lage "Störung Fühler") steht auf der Karte und wird eine Meldung.
        eingang.handle(topic(w), herzschlag(w, logik, hash, "fault"));
        karte = einzigeKarte(w, "bedienberechtigt");
        assertThat(karte.path("stoerungen").get(0).path("text").asText()).isEqualTo("Störung Fühler");
        assertThat(karte.path("stoerungen").toString()).contains("Ohne Wert: Speicher");
        TenantContext.set(w.mandant());
        try {
            WerteLeser.Lesung lesung = meldungsLeser.lese(katalog.eintrag("steuerlogik.stoerung"),
                    WerteLeser.Bezug.anlage(w.site()), Instant.now());
            assertThat(lesung.zustandswort()).isEqualTo(SteuerlogikWerteLeser.STOERUNG);
            assertThat(lesung.text()).isEqualTo("Logik „Warmwasser“: Störung Fühler");
        } finally {
            TenantContext.clear();
        }
    }

    /**
     * Die Karte, wie die API sie dem Portal gibt, als Vertrags-Fixture ({@code steuerlogik-karte.valid.wasser.json}):
     * aus dem gepinnten Block der Box und der gepinnten Antwort des Dienstes gebaut, mit festen Kennungen und Zeiten.
     * Die Portal-Tests und die E2E-Bühne lesen sie - Box, API und Portal treffen sich auf denselben Bytes.
     * {@code VP_FIXTURES_SCHREIBEN=1} schreibt sie nach einer gewollten Änderung neu.
     */
    private static void pinneKarte(JsonNode karte) throws Exception {
        ObjectNode k = karte.deepCopy();
        k.put("logikId", "5e1f0c2a-7b3d-4e8f-9a1b-2c3d4e5f6a7b");
        k.put("scharfSeit", "2026-11-14T09:00:00Z");
        k.put("gemeldetAm", "2026-11-14T09:07:10Z");
        for (JsonNode g : k.path("geraete")) ((ObjectNode) g).put("entityId", STAB_IM_BEISPIEL);
        String text = MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(k) + "\n";
        Path pfad = V2.resolve("examples/steuerlogik-karte.valid.wasser.json");
        if ("1".equals(System.getenv("VP_FIXTURES_SCHREIBEN"))) Files.writeString(pfad, text);
        assertThat(Files.exists(pfad)).as("VP_FIXTURES_SCHREIBEN=1 legt %s an", pfad).isTrue();
        assertThat(Files.readString(pfad)).as("%s weicht von der Karte ab (VP_FIXTURES_SCHREIBEN=1 nach gewollter "
                + "Änderung)", pfad).isEqualTo(text);
    }

    // --- Welt und Wege ----------------------------------------------------------------------------------------------

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Steuerlogik scharf #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, "
                + "'Europe/Berlin') RETURNING id", UUID.class, t, "Haus " + nr);
        UUID standort = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, "
                + "zeitzone, zustand) VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u,
                "Haus " + nr, "H-" + nr);
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name, latitude, longitude) VALUES (?, 'Haus "
                + nr + "', 48.137, 11.575) RETURNING id", UUID.class, t);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES "
                + "(?, ?, ?, '2024-01-01')", t, site, standort);
        UUID box = UUID.randomUUID();
        root.update("INSERT INTO device (id, tenant_id, site_id, external_ref, kind) VALUES (?, ?, ?, ?, 'edge')",
                box, t, site, "edge-scharf-" + nr);
        // Die Befehle eines Heizstabs, wie der Aufbau ihn aus dem Typkatalog anlegt: der Registry-Push nennt sie, und
        // Scharfschalten prüft jeden Befehl des scharfen Bündels dagegen.
        UUID stab = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "capabilities) VALUES (?, ?, 'heating-rod', 'Heizstab', 'heating-rod', '{\"measure\":[],"
                + "\"actuate\":[{\"command\":\"on_off\"},{\"command\":\"setpoint_kw\"},"
                + "{\"command\":\"limit_kw\"}]}'::jsonb) RETURNING id", UUID.class, t, site);
        root.update("INSERT INTO consumer_profile (entity_id, tenant_id, site_id, control_kind, rated_power_kw) "
                + "VALUES (?, ?, ?, 'on_off', 6.0)", stab, t, site);
        Welt w = new Welt(t, site, box, stab, standort);
        for (String[] r : List.of(new String[] {"kundenadministrator", null}, new String[] {"bedienberechtigt", "s"},
                new String[] {"leser", "s"})) {
            root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', "
                    + "?, 'aktiv')", t, w.sub(r[0]), "Person " + r[0]);
            root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                    + "VALUES (?, ?, ?, ?, '2024-01-01T00:00:00+01:00'::timestamptz, 'Europe/Berlin')", t, w.sub(r[0]),
                    r[0], r[1] == null ? null : standort);
        }
        doReturn(true).when(faehigkeiten).kann(box, SteuerlogikAuslieferung.FAEHIGKEIT);
        doReturn(true).when(faehigkeiten).kann(box, SteuerlogikAuslieferung.FAEHIGKEIT_SCHARF);
        return w;
    }

    private UUID annehmen(Welt w) throws Exception {
        Antwort neu = plattform(w, post(w.admin()).content(text("logic: 1", false)));
        assertThat(neu.status()).as(neu.body().toString()).isEqualTo(201);
        return UUID.fromString(neu.body().path("logikId").asText());
    }

    private Antwort scharf(Welt w, UUID logik, int fassung) throws Exception {
        return plattform(w, post(w.admin(logik, "/scharf"))
                .content("{\"fassung\":" + fassung + ",\"bestaetigt\":true}"));
    }

    private static UUID siteAus(SteuerlogikDienst.Auftrag a) throws Exception {
        return UUID.fromString(MAPPER.readTree(a.registry()).path("site_id").asText());
    }

    private static List<String> zustaende(UUID logik) {
        return root.queryForList("SELECT zustand FROM steuerlogik WHERE logik_id = ? ORDER BY fassung", String.class,
                logik);
    }

    private static List<String> protokoll(UUID logik) {
        return root.queryForList("SELECT was FROM steuerlogik_protokoll WHERE logik_id = ? ORDER BY am, was",
                String.class, logik);
    }

    private Map<UUID, String> besitzer(Welt w) {
        TenantContext.set(w.mandant());
        try {
            return claims.claimedEntities(w.site());
        } finally {
            TenantContext.clear();
        }
    }

    private static String text(String logik, boolean scharf) throws Exception {
        ObjectNode n = MAPPER.createObjectNode().put("text", logik);
        if (scharf) n.put("scharf", true).put("bestaetigt", true);
        return MAPPER.writeValueAsString(n);
    }

    private static String topic(Welt w) {
        return "ems/" + w.mandant() + "/" + w.site() + "/" + w.box() + "/status";
    }

    /** Der Herzschlag mit dem gepinnten scharfen Block der Box, auf diese Logik gestellt; {@code art} ändert die Lage. */
    private byte[] herzschlag(Welt w, UUID logik, String hash, String art) throws Exception {
        ObjectNode block = (ObjectNode) MAPPER.readTree(
                Files.readString(V2.resolve("examples/steuerlogik-rueckmeldung.valid.scharf.json")));
        ObjectNode lauf = (ObjectNode) block.path("laeufe").get(0);
        lauf.put("flow_id", logik.toString());
        lauf.put("content_hash", hash);
        ((ObjectNode) lauf.path("geraete").path("heizstab")).put("entity_id", w.stab().toString());
        if (art != null) {
            ((ObjectNode) lauf.path("lage")).put("art", art).put("titel", "Störung Fühler");
            ((ArrayNode) lauf.withArray("unbekannt")).add("t");
        }
        ObjectNode n = MAPPER.createObjectNode();
        n.put("schema_version", "1.0");
        n.put("tenant_id", w.mandant().toString());
        n.put("site_id", w.site().toString());
        n.put("device_id", w.box().toString());
        n.put("ts", Instant.now().toString());
        n.set("logik", block);
        return MAPPER.writeValueAsBytes(n);
    }

    private JsonNode einzigeKarte(Welt w, String rolle) throws Exception {
        Antwort a = als(w, rolle, get(w.kunde()));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        assertThat(a.body().path("logiken")).hasSize(1);
        return a.body().path("logiken").get(0);
    }

    private JsonNode letzterSatz(Welt w) throws Exception {
        ArgumentCaptor<byte[]> satz = ArgumentCaptor.forClass(byte[].class);
        verify(publisher, atLeastOnce()).publishDeployment(eq(w.mandant()), eq(w.site()), eq(w.box()), satz.capture());
        return MAPPER.readTree(new String(satz.getValue(), StandardCharsets.UTF_8));
    }

    private static List<JsonNode> steuerlogikArtefakte(JsonNode satz) {
        List<JsonNode> out = new ArrayList<>();
        satz.path("artifacts").forEach(a -> {
            if ("steuerlogik".equals(a.path("bundle").path("format").asText())) out.add(a);
        });
        return out;
    }

    private static JsonNode einzigesSteuerlogikArtefakt(JsonNode satz) {
        List<JsonNode> a = steuerlogikArtefakte(satz);
        assertThat(a).hasSize(1);
        return a.get(0);
    }

    private Antwort als(Welt w, String rolle, MockHttpServletRequestBuilder r) throws Exception {
        Map<String, Object> c = new HashMap<>();
        c.put("sub", w.sub(rolle));
        c.put("preferred_username", w.sub(rolle));
        c.put("realm_access", Map.of("roles", List.of()));
        c.put("tenant_id", w.mandant().toString());
        Jwt jwt = new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600), Map.of("alg", "none"), c);
        return ruf(r.with(authentication(new KeycloakRealmRoleConverter().convert(jwt))));
    }

    private Antwort plattform(Welt w, MockHttpServletRequestBuilder r) throws Exception {
        return ruf(r.header("X-Tenant-Id", w.mandant().toString()).with(jwt().jwt(j -> {
            j.subject("sub-betrieb");
            j.claim("preferred_username", "VoltPilot Betrieb");
        }).authorities(new SimpleGrantedAuthority("ROLE_platform-admin"))));
    }

    private Antwort ruf(MockHttpServletRequestBuilder r) throws Exception {
        MvcResult res = mvc.perform(r.contentType(MediaType.APPLICATION_JSON)).andReturn();
        String text = res.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(res.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
