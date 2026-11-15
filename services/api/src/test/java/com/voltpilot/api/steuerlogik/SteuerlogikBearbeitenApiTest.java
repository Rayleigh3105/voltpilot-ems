package com.voltpilot.api.steuerlogik;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
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

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.TestDatenbank;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
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
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * Steuerlogik Stufe 4 ("Aufbau und Text") über die echte API und Datenbank: Rechte je Rolle (E3 = B: der
 * Kundenadministrator schreibt, Bedienberechtigte fragen an, Leser sehen nur), die Prüfung mit ihren Meldungen an der
 * Zeile, Fassungen (speichern ohne zu laufen, mitlaufen, vorlegen, zurück, scharf durch die Plattform) und die
 * Anfrage. Der Logik-Dienst antwortet wie in {@link SteuerlogikScharfApiTest} mit seiner gepinnten Antwort.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class SteuerlogikBearbeitenApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path V2 = Path.of("../../docs/contracts/v2");
    private static final String STAB_IM_BEISPIEL = "7b0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

    @Container
    static final TestDatenbank POSTGRES = new TestDatenbank();

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
    @MockitoSpyBean BoxFaehigkeiten faehigkeiten;
    @MockitoBean SteuerlogikDienst dienst;
    @MockitoBean FlowDeploymentPublisher publisher;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID site, UUID box, UUID stab, UUID standort) {
        String kunde() {
            return "/api/v1/sites/" + site + "/steuerlogik";
        }

        String kunde(UUID logik, String rest) {
            return kunde() + "/" + logik + rest;
        }

        String admin(UUID logik, String rest) {
            return "/api/v1/admin/sites/" + site + "/steuerlogik/" + logik + rest;
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

    /** Wie {@link SteuerlogikScharfApiTest}: die gepinnte Antwort des Dienstes, auf Logik, Fassung und Werte gestellt. */
    @BeforeEach
    void dienstWieGepinnt() throws Exception {
        String gepinnt = Files.readString(V2.resolve("examples/steuerlogik-dienst.valid.wasser-scharf.json"));
        when(dienst.artefakt(any())).thenAnswer(inv -> {
            SteuerlogikDienst.Auftrag a = inv.getArgument(0);
            String stab = root.queryForObject("SELECT id::text FROM measurement_point WHERE entity_type = "
                    + "'heating-rod' AND label = 'Heizstab' AND site_id = ?", String.class,
                    UUID.fromString(MAPPER.readTree(a.registry()).path("site_id").asText()));
            JsonNode antwort = MAPPER.readTree(gepinnt.replace(STAB_IM_BEISPIEL, stab));
            ObjectNode art = antwort.path("artifact").deepCopy();
            art.put("flow_id", a.logikId().toString());
            art.put("flow_version", a.fassung());
            ObjectNode bundle = (ObjectNode) art.path("bundle");
            bundle.remove("settings");
            bundle.remove("armed");
            bundle.put("logic", a.text());
            if (a.scharf()) bundle.put("armed", true);
            if (!a.scharf()) {
                for (JsonNode r : art.path("required_entities")) ((ObjectNode) r).putArray("capabilities");
            }
            art.put("content_hash", "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(bundle.toString().getBytes(StandardCharsets.UTF_8))));
            return new SteuerlogikDienst.Artefakt(art, antwort.path("bericht").deepCopy(), a.werte(), List.of());
        });
        when(publisher.publishDeployment(any(), any(), any(), any())).thenReturn(true);
    }

    @Test
    void rechteJeRolle() throws Exception {
        Welt w = welt();
        when(dienst.pruefe(anyString(), any())).thenReturn(new SteuerlogikDienst.Geprueft(true, null, "{}",
                MAPPER.readTree("{\"sperrt\":false,\"meldungen\":[]}"), MAPPER.createArrayNode()));

        // Der Kundenadministrator schreibt (E3 = B).
        Antwort ka = als(w, "kundenadministrator", get(w.kunde() + "/logiken"));
        assertThat(ka.body().path("darfBearbeiten").asBoolean()).isTrue();
        assertThat(als(w, "kundenadministrator", post(w.kunde() + "/pruefe").content(pruefen("logic: 1")))
                .status()).isEqualTo(200);
        UUID logik = speichere(w, null, "logic: 1\n# eins", null);

        // Bedienberechtigte sehen die Logik und fragen an, schreiben aber nicht.
        Antwort bd = als(w, "bedienberechtigt", get(w.kunde() + "/logiken"));
        assertThat(bd.status()).isEqualTo(200);
        assertThat(bd.body().path("darfBearbeiten").asBoolean()).isFalse();
        assertThat(bd.body().path("darfAnfragen").asBoolean()).isTrue();
        assertThat(bd.body().path("logiken")).hasSize(1);
        for (MockHttpServletRequestBuilder r : List.of(post(w.kunde() + "/pruefe").content(pruefen("logic: 1")),
                post(w.kunde()).content(speichern("logic: 1", null)),
                post(w.kunde(logik, "/fassungen")).content(speichern("logic: 1", 1)),
                post(w.kunde(logik, "/fassungen/1/mitlaufen")), post(w.kunde(logik, "/fassungen/1/vorlegen")),
                post(w.kunde(logik, "/stilllegen")))) {
            Antwort a = als(w, "bedienberechtigt", r);
            assertThat(a.status()).as(a.body().toString()).isEqualTo(403);
            assertThat(a.body().path("code").asText()).isEqualTo("recht_fehlt");
            assertThat(a.body().path("recht").asText()).isEqualTo("logik.bearbeiten");
        }
        assertThat(als(w, "bedienberechtigt", get(w.kunde(logik, "/fassungen/1"))).body().path("text").asText())
                .as("der Text ist lesbar für jeden, der die Steuerung sieht").isEqualTo("logic: 1\n# eins");
        assertThat(als(w, "bedienberechtigt", post(w.kunde(logik, "/anfragen")).content(anfrage(null,
                "Bitte wärmer"))).status()).isEqualTo(201);

        // Leser sehen nur.
        Antwort le = als(w, "leser", get(w.kunde(logik, "")));
        assertThat(le.status()).isEqualTo(200);
        assertThat(le.body().path("darfBearbeiten").asBoolean()).isFalse();
        assertThat(le.body().path("darfAnfragen").asBoolean()).isFalse();
        assertThat(als(w, "leser", post(w.kunde(logik, "/anfragen")).content(anfrage(null, "x"))).status())
                .isEqualTo(403);
        assertThat(zustaende(logik)).containsExactly("geprueft");
    }

    @Test
    void pruefungReichtMeldungenAnDerZeileDurch() throws Exception {
        Welt w = welt();
        JsonNode meldung = MAPPER.readTree("[{\"art\":\"fehler\",\"text\":\"„06:00“: Uhrzeiten stehen in "
                + "Anführungszeichen\",\"zeile\":7}]");
        when(dienst.pruefe(eq("kaputt"), any())).thenReturn(new SteuerlogikDienst.Geprueft(false,
                "Logik nicht lesbar: Zeile 7: …", null, null, meldung));
        Antwort a = als(w, "kundenadministrator", post(w.kunde() + "/pruefe").content(pruefen("kaputt")));
        assertThat(a.status()).isEqualTo(200);
        assertThat(a.body().path("lesbar").asBoolean()).isFalse();
        assertThat(a.body().path("sperrt").asBoolean()).isTrue();
        assertThat(a.body().path("meldungen").get(0).path("zeile").asInt()).isEqualTo(7);

        // Die Prüfung sieht die Geräte der Anlage, wie die Box sie bekommt (Registry-Inhalt der führenden Box).
        ArgumentCaptor<String> registry = ArgumentCaptor.forClass(String.class);
        verify(dienst).pruefe(eq("kaputt"), registry.capture());
        assertThat(MAPPER.readTree(registry.getValue()).path("site_id").asText()).isEqualTo(w.site().toString());

        // Speichern prüft beim Dienst; was er nicht liest, wird keine Fassung, und die Meldung trägt ihre Zeile.
        doThrow(new SteuerlogikDienstException(SteuerlogikDienstException.UNLESBAR, "Logik nicht lesbar: Zeile 7",
                null, meldung)).when(dienst).artefakt(any());
        Antwort s = als(w, "kundenadministrator", post(w.kunde()).content(speichern("kaputt", null)));
        assertThat(s.status()).isEqualTo(422);
        assertThat(s.body().path("grund").asText()).isEqualTo("logik_unlesbar");
        assertThat(s.body().path("meldungen").get(0).path("zeile").asInt()).isEqualTo(7);
        assertThat(root.queryForObject("SELECT count(*) FROM steuerlogik WHERE site_id = ?", Integer.class,
                w.site())).isZero();
    }

    @Test
    void fassungenSpeichernMitlaufenVorlegenZurueck() throws Exception {
        Welt w = welt();
        clearInvocations(publisher);
        UUID logik = speichere(w, null, "logic: 1\n# eins", null);
        assertThat(zustaende(logik)).containsExactly("geprueft");
        verify(publisher, never()).publishDeployment(any(), any(), any(), any());

        // Eine neue Fassung geht von der neuesten aus; wer von einer älteren ausgeht, überschreibt nichts still.
        assertThat(speichere(w, logik, "logic: 1\n# zwei", 1)).isEqualTo(logik);
        Antwort veraltet = als(w, "kundenadministrator", post(w.kunde(logik, "/fassungen"))
                .content(speichern("logic: 1\n# drei", 1)));
        assertThat(veraltet.status()).isEqualTo(409);
        assertThat(veraltet.body().path("grund").asText()).isEqualTo("fassung_veraltet");

        // Mitlaufen: die Fassung geht an die Box, die alte (keine) bleibt; eine zweite löst die erste ab.
        Antwort lauf = ka(w, post(w.kunde(logik, "/fassungen/1/mitlaufen")));
        assertThat(lauf.status()).as(lauf.body().toString()).isEqualTo(200);
        assertThat(lauf.body().path("zustand").asText()).isEqualTo("mitlaufend");
        verify(publisher).publishDeployment(eq(w.mandant()), eq(w.site()), eq(w.box()), any());
        assertThat(zustaende(logik)).containsExactly("mitlaufend", "geprueft");
        assertThat(ka(w, post(w.kunde(logik, "/fassungen/1/mitlaufen"))).body().path("grund").asText())
                .isEqualTo("laeuft_schon");
        assertThat(ka(w, post(w.kunde(logik, "/fassungen/2/mitlaufen"))).status()).isEqualTo(200);
        assertThat(zustaende(logik)).containsExactly("stillgelegt", "mitlaufend");
        assertThat(ka(w, post(w.kunde(logik, "/fassungen/1/zurueck"))).status()).isEqualTo(200);
        assertThat(zustaende(logik)).containsExactly("mitlaufend", "stillgelegt");

        // Zur Freigabe vorlegen; die Plattform schaltet die vorgelegte Fassung scharf, sie löst die mitlaufende ab.
        assertThat(ka(w, post(w.kunde(logik, "/fassungen/2/vorlegen"))).status()).isEqualTo(200);
        JsonNode kopf = ka(w, get(w.kunde() + "/logiken")).body().path("logiken").get(0);
        assertThat(kopf.path("vorgelegt").asInt()).isEqualTo(2);
        assertThat(kopf.path("aktiv").asInt()).isEqualTo(1);
        assertThat(kopf.path("zustand").asText()).isEqualTo("mitlaufend");
        JsonNode ansicht = ka(w, get(w.kunde(logik, ""))).body();
        JsonNode zwei = ansicht.path("fassungen").get(0);
        assertThat(zwei.path("fassung").asInt()).isEqualTo(2);
        assertThat(zwei.path("vorgelegtVon").asText()).isEqualTo("Person kundenadministrator");
        assertThat(zwei.path("angelegtVon").asText()).isEqualTo("Person kundenadministrator");
        assertThat(zwei.path("rolle").asText()).isEqualTo("kundenadministrator");
        assertThat(ansicht.path("plattform").asBoolean()).isFalse();

        Antwort vorschau = plattform(w, get(w.admin(logik, "/scharf?fassung=2")));
        assertThat(vorschau.body().path("fassung").asInt()).isEqualTo(2);
        assertThat(vorschau.body().path("moeglich").asBoolean()).as(vorschau.body().toString()).isTrue();
        Antwort scharf = plattform(w, post(w.admin(logik, "/scharf")).content("{\"fassung\":2,\"bestaetigt\":true}"));
        assertThat(scharf.status()).as(scharf.body().toString()).isEqualTo(200);
        assertThat(zustaende(logik)).containsExactly("stillgelegt", "scharf");
        assertThat(ka(w, get(w.kunde() + "/logiken")).body().path("logiken").get(0).path("vorgelegt").isNull())
                .as("eine scharf geschaltete Vorlage wartet nicht mehr").isTrue();

        // Eine scharfe Logik: mitlaufen löst sie nicht ab, zurück nur auf eine Fassung, die schon scharf war.
        assertThat(ka(w, post(w.kunde(logik, "/fassungen/1/mitlaufen"))).body().path("grund").asText())
                .isEqualTo("scharf_abloesen");
        assertThat(ka(w, post(w.kunde(logik, "/fassungen/1/zurueck"))).body().path("grund").asText())
                .isEqualTo("nicht_freigegeben");
        speichere(w, logik, "logic: 1\n# drei", 2);
        ka(w, post(w.kunde(logik, "/fassungen/3/vorlegen")));
        assertThat(plattform(w, post(w.admin(logik, "/scharf")).content("{\"fassung\":3,\"bestaetigt\":true}"))
                .status()).isEqualTo(200);
        Antwort zurueck = ka(w, post(w.kunde(logik, "/fassungen/2/zurueck")));
        assertThat(zurueck.status()).as(zurueck.body().toString()).isEqualTo(200);
        assertThat(zurueck.body().path("zustand").asText()).isEqualTo("scharf");
        assertThat(zustaende(logik)).containsExactly("stillgelegt", "scharf", "stillgelegt");

        // Stilllegen; der Text jeder Fassung bleibt lesbar, das Protokoll nennt jeden Schritt.
        assertThat(ka(w, post(w.kunde(logik, "/stilllegen"))).body().path("stillgelegt").asBoolean()).isTrue();
        assertThat(ka(w, get(w.kunde(logik, "/fassungen/2"))).body().path("text").asText())
                .isEqualTo("logic: 1\n# zwei");
        assertThat(ka(w, get(w.kunde(logik, "/fassungen/9"))).status()).isEqualTo(404);
        JsonNode protokoll = ka(w, get(w.kunde(logik, "/protokoll"))).body().path("schritte");
        assertThat(protokoll.findValuesAsText("was")).contains("gespeichert", "mitlaufen", "zurueck", "vorgelegt",
                "scharf", "stillgelegt");
        assertThat(protokoll.get(0).path("was").asText()).as("jüngstes zuerst").isEqualTo("stillgelegt");
        assertThat(protokoll.get(0).path("von").asText()).isEqualTo("Person kundenadministrator");
        assertThat(ka(w, get(w.kunde(logik, "/protokoll?von=2026-01-02&bis=2026-01-01"))).status()).isEqualTo(400);
    }

    /**
     * Stufe 6: die Dateien von Home Assistant gehen mit der Zuordnung und dem Registry-Inhalt der Anlage an den Dienst,
     * seine Antwort kommt unverändert zurück; gespeichert wird nichts. Wer die Logik nicht bearbeitet, übersetzt nicht.
     */
    @Test
    void homeAssistantUebersetztOhneZuSpeichern() throws Exception {
        Welt w = welt();
        JsonNode gepinnt = MAPPER.readTree(Files.readString(
                V2.resolve("examples/steuerlogik-home-assistant.valid.solarheizung.json")));
        when(dienst.homeAssistant(any(), any(), any())).thenReturn(gepinnt);
        ObjectNode body = MAPPER.createObjectNode();
        body.putArray("dateien").addObject().put("name", "configuration.yaml").put("text", "input_boolean: {}")
                .put("pfad", "fällt weg");
        body.putObject("zuordnung").putObject("wr_netzleistung").put("wert", "site.grid");
        Antwort a = ka(w, post(w.kunde() + "/home-assistant").content(MAPPER.writeValueAsString(body)));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        assertThat(a.body()).isEqualTo(gepinnt);

        ArgumentCaptor<JsonNode> dateien = ArgumentCaptor.forClass(JsonNode.class);
        ArgumentCaptor<JsonNode> zuordnung = ArgumentCaptor.forClass(JsonNode.class);
        ArgumentCaptor<String> registry = ArgumentCaptor.forClass(String.class);
        verify(dienst).homeAssistant(dateien.capture(), zuordnung.capture(), registry.capture());
        assertThat(dateien.getValue().get(0).has("pfad")).as("nur Name und Text gehen an den Dienst").isFalse();
        assertThat(dateien.getValue().get(0).path("text").asText()).isEqualTo("input_boolean: {}");
        assertThat(zuordnung.getValue().path("wr_netzleistung").path("wert").asText()).isEqualTo("site.grid");
        assertThat(MAPPER.readTree(registry.getValue()).path("site_id").asText()).isEqualTo(w.site().toString());

        Antwort bd = als(w, "bedienberechtigt", post(w.kunde() + "/home-assistant")
                .content(MAPPER.writeValueAsString(body)));
        assertThat(bd.status()).isEqualTo(403);
        assertThat(bd.body().path("recht").asText()).isEqualTo("logik.bearbeiten");

        assertThat(ka(w, post(w.kunde() + "/home-assistant").content("{\"dateien\":[]}")).body().path("grund")
                .asText()).isEqualTo("dateien_fehlen");
        ObjectNode gross = MAPPER.createObjectNode();
        gross.putArray("dateien").addObject().put("name", "configuration.yaml").put("text", "#".repeat(1024 * 1024 + 1));
        Antwort zuGross = ka(w, post(w.kunde() + "/home-assistant").content(MAPPER.writeValueAsString(gross)));
        assertThat(zuGross.status()).isEqualTo(400);
        assertThat(zuGross.body().path("grund").asText()).isEqualTo("dateien_zu_gross");

        doThrow(new SteuerlogikDienstException(SteuerlogikDienstException.HOME_ASSISTANT,
                "Dateien von Home Assistant nicht lesbar: configuration.yaml ist kein lesbares YAML", null))
                .when(dienst).homeAssistant(any(), any(), any());
        Antwort kaputt = ka(w, post(w.kunde() + "/home-assistant").content(MAPPER.writeValueAsString(body)));
        assertThat(kaputt.status()).isEqualTo(422);
        assertThat(kaputt.body().path("grund").asText()).isEqualTo("home_assistant_unlesbar");
        assertThat(kaputt.body().path("message").asText()).contains("configuration.yaml");
        assertThat(root.queryForObject("SELECT count(*) FROM steuerlogik WHERE site_id = ?", Integer.class,
                w.site())).isZero();
    }

    @Test
    void anfrageDesBedienberechtigten() throws Exception {
        Welt w = welt();
        UUID logik = speichere(w, null, "logic: 1", null);
        Antwort a = als(w, "bedienberechtigt", post(w.kunde(logik, "/anfragen"))
                .content(anfrage("netz_ab", "Bitte schon ab 5 Uhr aus dem Netz")));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(201);
        UUID id = UUID.fromString(a.body().path("id").asText());
        assertThat(als(w, "bedienberechtigt", post(w.kunde(logik, "/anfragen")).content(anfrage("gibtsnicht", "x")))
                .body().path("grund").asText()).isEqualTo("stellwert_unbekannt");
        assertThat(als(w, "bedienberechtigt", post(w.kunde(logik, "/anfragen")).content(anfrage(null, "  ")))
                .status()).isEqualTo(400);

        assertThat(ka(w, get(w.kunde() + "/logiken")).body().path("logiken").get(0).path("offeneAnfragen").asInt())
                .isEqualTo(1);
        JsonNode anfrage = ka(w, get(w.kunde(logik, ""))).body().path("anfragen").get(0);
        assertThat(anfrage.path("von").asText()).isEqualTo("Person bedienberechtigt");
        assertThat(anfrage.path("kennung").asText()).isEqualTo("netz_ab");
        assertThat(anfrage.path("erledigtAm").isNull()).isTrue();

        assertThat(als(w, "bedienberechtigt", post(w.kunde(logik, "/anfragen/" + id + "/erledigt"))).status())
                .isEqualTo(403);
        assertThat(ka(w, post(w.kunde(logik, "/anfragen/" + id + "/erledigt"))).status()).isEqualTo(200);
        assertThat(ka(w, post(w.kunde(logik, "/anfragen/" + id + "/erledigt"))).body().path("grund").asText())
                .isEqualTo("anfrage_unbekannt");
        assertThat(ka(w, get(w.kunde() + "/logiken")).body().path("logiken").get(0).path("offeneAnfragen").asInt())
                .isZero();
        assertThat(root.queryForList("SELECT was FROM steuerlogik_protokoll WHERE logik_id = ? ORDER BY am",
                String.class, logik)).containsExactly("gespeichert", "anfrage", "erledigt");
    }

    // --- Welt und Wege ----------------------------------------------------------------------------------------------

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Steuerlogik bearbeiten #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, "
                + "'Europe/Berlin') RETURNING id", UUID.class, t, "Haus " + nr);
        UUID standort = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, "
                + "zeitzone, zustand) VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u,
                "Haus " + nr, "B-" + nr);
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name, latitude, longitude) VALUES (?, 'Haus "
                + nr + "', 48.137, 11.575) RETURNING id", UUID.class, t);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES "
                + "(?, ?, ?, '2024-01-01')", t, site, standort);
        UUID box = UUID.randomUUID();
        root.update("INSERT INTO device (id, tenant_id, site_id, external_ref, kind) VALUES (?, ?, ?, ?, 'edge')",
                box, t, site, "edge-bearbeiten-" + nr);
        UUID stab = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "capabilities) VALUES (?, ?, 'heating-rod', 'Heizstab', 'heating-rod', '{\"measure\":[],"
                + "\"actuate\":[{\"command\":\"on_off\"},{\"command\":\"setpoint_kw\"}]}'::jsonb) RETURNING id",
                UUID.class, t, site);
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

    private UUID speichere(Welt w, UUID logik, String text, Integer basis) throws Exception {
        Antwort a = ka(w, post(logik == null ? w.kunde() : w.kunde(logik, "/fassungen"))
                .content(speichern(text, basis)));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(201);
        return UUID.fromString(a.body().path("logikId").asText());
    }

    private static List<String> zustaende(UUID logik) {
        return root.queryForList("SELECT zustand FROM steuerlogik WHERE logik_id = ? ORDER BY fassung", String.class,
                logik);
    }

    private static String pruefen(String text) throws Exception {
        return MAPPER.writeValueAsString(MAPPER.createObjectNode().put("text", text));
    }

    private static String speichern(String text, Integer basis) throws Exception {
        ObjectNode n = MAPPER.createObjectNode().put("text", text).put("notiz", "Test");
        if (basis != null) n.put("basis", basis);
        return MAPPER.writeValueAsString(n);
    }

    private static String anfrage(String kennung, String text) throws Exception {
        ObjectNode n = MAPPER.createObjectNode().put("text", text);
        if (kennung != null) n.put("kennung", kennung);
        return MAPPER.writeValueAsString(n);
    }

    private Antwort ka(Welt w, MockHttpServletRequestBuilder r) throws Exception {
        return als(w, "kundenadministrator", r);
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
