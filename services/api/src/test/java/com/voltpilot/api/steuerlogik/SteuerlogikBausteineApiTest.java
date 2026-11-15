package com.voltpilot.api.steuerlogik;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
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
import java.time.LocalDate;
import java.time.ZoneId;
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
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * Steuerlogik Stufe 5 ("Bausteine") über die echte API und Datenbank: die Sammlung (VoltPilot aus dem Vertrag, im
 * Jar; die eines Fachbetriebs nur bei seinen Kunden - die Datenbank setzt das durch), die Rechte je Konto und Rolle
 * und dass aus einem Baustein eine gewöhnliche Logik entsteht (Fassung 1, geprüft, mitlaufen wie jede). Der Dienst
 * antwortet mit seiner gepinnten Antwort ({@code examples/steuerlogik-baustein.valid.eingesetzt.json}, geschrieben
 * vom Dienst selbst); dass jeder Baustein des Vertrags gefüllt die Prüfung besteht, belegt der Dienst
 * ({@code logikdienst/baustein_test.go}).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class SteuerlogikBausteineApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path V2 = Path.of("../../docs/contracts/v2");
    private static final String PARTNER = "sub-partner-brunner";
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

    private record Welt(UUID mandant, UUID site, UUID box, UUID standort) {
        String bausteine() {
            return "/api/v1/sites/" + site + "/steuerlogik/bausteine";
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
     * Der Dienst: {@code /bausteine} nennt jeden Baustein lesbar mit seinem Namen aus dem Text, {@code /baustein}
     * antwortet wie gepinnt, {@code /aus-logik} baut einen Baustein mit dem Satz, {@code /artefakt} wie in Stufe 4.
     */
    @BeforeEach
    void dienst() throws Exception {
        when(dienst.bausteine(any(), any())).thenAnswer(inv -> {
            List<SteuerlogikDienst.BausteinText> texte = inv.getArgument(0);
            ArrayNode out = MAPPER.createArrayNode();
            for (SteuerlogikDienst.BausteinText t : texte) {
                String name = t.text().lines().filter(l -> l.startsWith("name: ")).findFirst().orElse("name: ?")
                        .substring(6).replace("\"", "");
                ObjectNode k = out.addObject().put("id", t.id()).put("lesbar", !t.text().contains("kaputt"))
                        .put("name", name).put("passt", true);
                k.putArray("satz").addObject().put("text", name);
                k.putArray("luecken");
            }
            return out;
        });
        JsonNode eingesetzt = MAPPER.readTree(Files.readString(
                V2.resolve("examples/steuerlogik-baustein.valid.eingesetzt.json")));
        when(dienst.baustein(anyString(), any(), any())).thenReturn(eingesetzt);
        when(dienst.ausLogik(anyString(), anyString(), any(), anyString())).thenAnswer(inv -> {
            ObjectNode b = MAPPER.createObjectNode();
            b.put("baustein", "block: 1\nname: \"" + inv.getArgument(1) + "\"\nsentence: \"" + inv.getArgument(3)
                    + "\"\nlogic: |\n  logic: 1\n");
            b.put("name", (String) inv.getArgument(1));
            b.putArray("satz").addObject().put("text", (String) inv.getArgument(3));
            b.putArray("luecken");
            return b;
        });
        // Das Artefakt wie in Stufe 4 aus der gepinnten Antwort des Dienstes, auf Logik, Fassung und Text gestellt.
        String gepinnt = Files.readString(V2.resolve("examples/steuerlogik-dienst.valid.wasser-scharf.json"));
        when(dienst.artefakt(any())).thenAnswer(inv -> {
            SteuerlogikDienst.Auftrag a = inv.getArgument(0);
            String stab = root.queryForObject("SELECT id::text FROM measurement_point WHERE entity_type = "
                    + "'heating-rod' AND site_id = ?", String.class,
                    UUID.fromString(MAPPER.readTree(a.registry()).path("site_id").asText()));
            JsonNode antwort = MAPPER.readTree(gepinnt.replace(STAB_IM_BEISPIEL, stab));
            ObjectNode art = antwort.path("artifact").deepCopy();
            art.put("flow_id", a.logikId().toString());
            art.put("flow_version", a.fassung());
            ObjectNode bundle = (ObjectNode) art.path("bundle");
            bundle.remove("settings");
            bundle.remove("armed");
            bundle.put("logic", a.text());
            for (JsonNode r : art.path("required_entities")) ((ObjectNode) r).putArray("capabilities");
            art.put("content_hash", "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(bundle.toString().getBytes(StandardCharsets.UTF_8))));
            ObjectNode bericht = eingesetzt.path("bericht").deepCopy();
            return new SteuerlogikDienst.Artefakt(art, bericht, a.werte(), List.of());
        });
        when(publisher.publishDeployment(any(), any(), any(), any())).thenReturn(true);
    }

    @Test
    void dieBausteineVonVoltPilotKommenAusDemVertrag() throws Exception {
        Welt w = welt();
        Antwort a = ka(w, get(w.bausteine()));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        assertThat(a.body().path("darfEinsetzen").asBoolean()).isTrue();
        assertThat(a.body().path("darfSpeichern").asBoolean())
                .as("der Kundenadministrator setzt ein, eine Sammlung hat er nicht (E4 = A)").isFalse();
        List<String> ids = a.body().path("bausteine").findValuesAsText("id");
        try (var dateien = Files.list(V2.resolve("steuerlogik/bausteine"))) {
            List<String> vertrag = dateien.map(p -> p.getFileName().toString())
                    .filter(n -> n.endsWith(".block.yaml")).map(n -> n.replace(".block.yaml", "")).sorted().toList();
            assertThat(vertrag).hasSizeBetween(5, 7);
            assertThat(ids).as("jeder Baustein des Vertrags liegt im Jar").containsExactlyElementsOf(vertrag);
        }
        for (JsonNode b : a.body().path("bausteine")) {
            assertThat(b.path("herkunft").asText()).isEqualTo("voltpilot");
            assertThat(b.path("eigen").asBoolean()).isFalse();
        }
        // Der Dienst bekommt die Texte des Vertrags und den Registry-Inhalt dieser Anlage.
        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<SteuerlogikDienst.BausteinText>> texte = ArgumentCaptor.forClass(List.class);
        ArgumentCaptor<String> registry = ArgumentCaptor.forClass(String.class);
        verify(dienst).bausteine(texte.capture(), registry.capture());
        assertThat(texte.getValue().get(0).text())
                .isEqualTo(Files.readString(V2.resolve("steuerlogik/bausteine/" + ids.get(0) + ".block.yaml")));
        assertThat(MAPPER.readTree(registry.getValue()).path("site_id").asText()).isEqualTo(w.site().toString());

        // Leser sehen die Bausteine, dürfen aber nichts einsetzen.
        Antwort le = als(w, "leser", get(w.bausteine()));
        assertThat(le.status()).isEqualTo(200);
        assertThat(le.body().path("darfEinsetzen").asBoolean()).isFalse();
    }

    @Test
    void ausEinemBausteinEntstehtEineGewoehnlicheLogik() throws Exception {
        Welt w = welt();
        ObjectNode fuellung = MAPPER.createObjectNode();
        fuellung.put("name", "Puffer nachheizen");
        fuellung.putObject("werte").put("mindest", "45 °C");
        String body = MAPPER.writeValueAsString(MAPPER.createObjectNode().set("fuellung", fuellung));

        // Vorschau: was der Dienst rechnet, unverändert ("So verhält sie sich"); nichts wird gespeichert.
        Antwort v = ka(w, post(w.bausteine() + "/netzheizen-zeitfenster/vorschau").content(body));
        assertThat(v.status()).as(v.body().toString()).isEqualTo(200);
        assertThat(v.body().path("verhalten").size()).isGreaterThanOrEqualTo(4);
        assertThat(v.body().path("vollstaendig").asBoolean()).isTrue();
        assertThat(root.queryForObject("SELECT count(*) FROM steuerlogik WHERE site_id = ?", Integer.class,
                w.site())).isZero();
        ArgumentCaptor<JsonNode> geschickt = ArgumentCaptor.forClass(JsonNode.class);
        verify(dienst).baustein(eq(Files.readString(V2.resolve("steuerlogik/bausteine/netzheizen-zeitfenster.block.yaml"))),
                geschickt.capture(), any());
        assertThat(geschickt.getValue().path("werte").path("mindest").asText()).isEqualTo("45 °C");
        assertThat(geschickt.getValue().path("name").asText()).isEqualTo("Puffer nachheizen");

        // Einsetzen: die Logik ist der Text, den der Dienst füllte - Fassung 1, geprüft, die Notiz nennt den Baustein.
        Antwort s = ka(w, post(w.bausteine() + "/netzheizen-zeitfenster/logik").content(body));
        assertThat(s.status()).as(s.body().toString()).isEqualTo(201);
        UUID logik = UUID.fromString(s.body().path("logikId").asText());
        assertThat(s.body().path("fassung").asInt()).isEqualTo(1);
        Map<String, Object> zeile = root.queryForMap("SELECT zustand, quelltext, notiz, angelegt_rolle FROM steuerlogik "
                + "WHERE logik_id = ?", logik);
        assertThat(zeile.get("zustand")).isEqualTo("geprueft");
        assertThat(zeile.get("notiz")).isEqualTo("Aus dem Baustein „Aus dem Netz nachheizen“");
        assertThat(zeile.get("angelegt_rolle")).isEqualTo("kundenadministrator");
        JsonNode eingesetzt = MAPPER.readTree(Files.readString(
                V2.resolve("examples/steuerlogik-baustein.valid.eingesetzt.json")));
        assertThat(zeile.get("quelltext")).isEqualTo(eingesetzt.path("text").asText());

        // Danach ist sie eine Logik wie jede: sie steht im Reiter und läuft mit.
        Antwort liste = ka(w, get("/api/v1/sites/" + w.site() + "/steuerlogik/logiken"));
        assertThat(liste.body().path("logiken").findValuesAsText("logikId")).containsExactly(logik.toString());
        Antwort mit = ka(w, post("/api/v1/sites/" + w.site() + "/steuerlogik/" + logik + "/fassungen/1/mitlaufen"));
        assertThat(mit.status()).as(mit.body().toString()).isEqualTo(200);
        assertThat(mit.body().path("zustand").asText()).isEqualTo("mitlaufend");
    }

    @Test
    void nurVollstaendigesUndUngesperrtesWirdGespeichert() throws Exception {
        Welt w = welt();
        ObjectNode halb = MAPPER.readTree(Files.readString(
                V2.resolve("examples/steuerlogik-baustein.valid.eingesetzt.json"))).deepCopy();
        halb.put("vollstaendig", false);
        when(dienst.baustein(anyString(), any(), any())).thenReturn(halb);
        Antwort a = ka(w, post(w.bausteine() + "/netzheizen-zeitfenster/logik").content("{}"));
        assertThat(a.status()).isEqualTo(422);
        assertThat(a.body().path("grund").asText()).isEqualTo("baustein_unvollstaendig");

        ObjectNode gesperrt = halb.deepCopy();
        gesperrt.put("vollstaendig", true);
        ((ObjectNode) gesperrt.path("bericht")).put("sperrt", true);
        when(dienst.baustein(anyString(), any(), any())).thenReturn(gesperrt);
        Antwort b = ka(w, post(w.bausteine() + "/netzheizen-zeitfenster/logik").content("{}"));
        assertThat(b.status()).isEqualTo(422);
        assertThat(b.body().path("grund").asText()).isEqualTo("pruefung_sperrt");

        assertThat(ka(w, post(w.bausteine() + "/gibt-es-nicht/vorschau").content("{}")).body().path("grund")
                .asText()).isEqualTo("baustein_unbekannt");
        assertThat(ka(w, post(w.bausteine() + "/" + UUID.randomUUID() + "/vorschau").content("{}")).status())
                .isEqualTo(404);
        assertThat(root.queryForObject("SELECT count(*) FROM steuerlogik WHERE site_id = ?", Integer.class,
                w.site())).isZero();
    }

    @Test
    void rechteJeRolleUndKonto() throws Exception {
        Welt w = welt();
        UUID logik = logikVon(w);
        String speichern = alsBaustein(logik, "Mein Puffer", "Heize {heizstab}");
        for (MockHttpServletRequestBuilder r : List.of(post(w.bausteine() + "/heizstab-ueberschuss/vorschau")
                .content("{}"), post(w.bausteine() + "/heizstab-ueberschuss/logik").content("{}"))) {
            Antwort a = als(w, "bedienberechtigt", r);
            assertThat(a.status()).as(a.body().toString()).isEqualTo(403);
            assertThat(a.body().path("recht").asText()).isEqualTo("logik.bearbeiten");
        }
        // Speichern: nicht der Kundenadministrator - ein Kundenkonto hat keine Sammlung (E4 = A) -, nicht ein
        // Unterstützer mit „Einrichten“ (logik.bearbeiten verlangt „Einrichten und Bedienen“).
        Antwort ka = ka(w, post(w.bausteine()).content(speichern));
        assertThat(ka.status()).isEqualTo(403);
        assertThat(ka.body().path("grund").asText()).isEqualTo("recht_fehlt");
        assertThat(ka.body().path("message").asText()).contains("Fachbetrieb");
        assertThat(root.queryForObject("SELECT count(*) FROM steuerlogik_baustein WHERE name = 'Mein Puffer'", Integer.class)).isZero();
        partner(w, "einrichten", false);
        Antwort einrichten = alsPartner(w, post(w.bausteine()).content(speichern));
        assertThat(einrichten.status()).isEqualTo(403);
        assertThat(einrichten.body().path("recht").asText()).isEqualTo("logik.bearbeiten");
        assertThat(alsPartner(w, get(w.bausteine())).body().path("darfSpeichern").asBoolean()).isFalse();
        assertThat(ka(w, get("/api/v1/sites/" + w.site() + "/steuerlogik/" + logik)).body()
                .path("darfBausteinSpeichern").asBoolean()).isFalse();

        // Die Bausteine des Vertrags lassen sich nicht entfernen; die Plattform darf es versuchen.
        Antwort vertrag = plattform(w, delete(w.bausteine() + "/heizstab-ueberschuss"));
        assertThat(vertrag.status()).isEqualTo(409);
        assertThat(vertrag.body().path("grund").asText()).isEqualTo("aus_dem_vertrag");
    }

    @Test
    void derFachbetriebSpeichertFuerSeineKunden() throws Exception {
        Welt w = welt();
        Welt andere = welt();
        UUID logik = logikVon(w);
        partner(w, "einrichten_und_bedienen", false);
        partner(andere, "einrichten_und_bedienen", false);

        Antwort liste = alsPartner(w, get(w.bausteine()));
        assertThat(liste.status()).as(liste.body().toString()).isEqualTo(200);
        assertThat(liste.body().path("darfSpeichern").asBoolean()).isTrue();
        assertThat(alsPartner(w, get("/api/v1/sites/" + w.site() + "/steuerlogik/" + logik)).body()
                .path("darfBausteinSpeichern").asBoolean()).isTrue();

        Antwort s = alsPartner(w, post(w.bausteine()).content(alsBaustein(logik, "Puffer bei Brunner",
                "Heize {heizstab} aus dem Netz")));
        assertThat(s.status()).as(s.body().toString()).isEqualTo(201);
        assertThat(s.body().path("herkunft").asText()).isEqualTo("fachbetrieb");
        UUID id = UUID.fromString(s.body().path("id").asText());
        Map<String, Object> zeile = root.queryForMap("SELECT herkunft, partner_sub, angelegt_name, content_hash "
                + "FROM steuerlogik_baustein WHERE id = ?", id);
        assertThat(zeile.get("partner_sub")).isEqualTo(PARTNER);
        assertThat(zeile.get("angelegt_name")).isEqualTo("Thomas Brunner");
        assertThat((String) zeile.get("content_hash")).matches("^sha256:[0-9a-f]{64}$");
        verify(dienst).ausLogik(eq("logic: 1\n# aus der Anlage"), eq("Puffer bei Brunner"), isNull(),
                eq("Heize {heizstab} aus dem Netz"));

        // Der Kunde sieht ihn mit dem Namen des Fachbetriebs, der Partner als seinen eigenen.
        JsonNode beimKunden = baustein(ka(w, get(w.bausteine())).body(), id);
        assertThat(beimKunden.path("herkunft").asText()).isEqualTo("fachbetrieb");
        assertThat(beimKunden.path("von").asText()).isEqualTo("Thomas Brunner");
        assertThat(beimKunden.path("eigen").asBoolean()).isFalse();
        assertThat(baustein(alsPartner(w, get(w.bausteine())).body(), id).path("eigen").asBoolean()).isTrue();

        // Ein anderer Kunde desselben Fachbetriebs sieht ihn auch; ein Kunde ohne ihn nicht (die Datenbank).
        assertThat(baustein(ka(andere, get(andere.bausteine())).body(), id)).isNotNull();
        Welt fremd = welt();
        assertThat(baustein(ka(fremd, get(fremd.bausteine())).body(), id)).isNull();
        assertThat(ka(fremd, post(fremd.bausteine() + "/" + id + "/vorschau").content("{}")).status())
                .isEqualTo(404);

        // Beendet ein Kunde die Unterstützung, verschwinden die Bausteine des Fachbetriebs bei ihm.
        root.update("UPDATE zugriff SET beendet_am = now(), beendet_von = ?, beendet_grund = 'entzogen' "
                + "WHERE tenant_id = ? AND benutzer_sub = ?", andere.sub("kundenadministrator"), andere.mandant(),
                PARTNER);
        assertThat(baustein(ka(andere, get(andere.bausteine())).body(), id)).isNull();

        // Entfernen darf nur er selbst; danach sieht ihn niemand mehr, die Zeile bleibt mit wer und wann.
        assertThat(ka(w, delete(w.bausteine() + "/" + id)).status()).isEqualTo(403);
        assertThat(alsPartner(w, delete(w.bausteine() + "/" + id)).status()).isEqualTo(200);
        assertThat(baustein(ka(w, get(w.bausteine())).body(), id)).isNull();
        assertThat(root.queryForObject("SELECT entfernt_von FROM steuerlogik_baustein WHERE id = ?", String.class, id))
                .isEqualTo(PARTNER);
        assertThat(alsPartner(w, delete(w.bausteine() + "/" + id)).status()).isEqualTo(404);
    }

    @Test
    void voltPilotSpeichertFuerAlle() throws Exception {
        Welt w = welt();
        UUID logik = logikVon(w);
        Antwort s = plattform(w, post(w.bausteine()).content(alsBaustein(logik, "Für alle", "Heize {heizstab}")));
        assertThat(s.status()).as(s.body().toString()).isEqualTo(201);
        assertThat(s.body().path("herkunft").asText()).isEqualTo("voltpilot");
        UUID id = UUID.fromString(s.body().path("id").asText());
        Welt fremd = welt();
        JsonNode b = baustein(ka(fremd, get(fremd.bausteine())).body(), id);
        assertThat(b).as("ein Baustein von VoltPilot gilt für alle Kunden").isNotNull();
        assertThat(b.path("herkunft").asText()).isEqualTo("voltpilot");
        assertThat(plattform(w, delete(w.bausteine() + "/" + id)).status()).isEqualTo(200);
        assertThat(baustein(ka(fremd, get(fremd.bausteine())).body(), id)).isNull();

        // Den Baustein eines Fachbetriebs, der hier nie unterstützt hat, zeigt die Datenbank niemandem.
        root.update("INSERT INTO steuerlogik_baustein (id, herkunft, partner_sub, name, text, content_hash, "
                + "angelegt_am, angelegt_von) VALUES (?, 'fachbetrieb', 'sub-niemand', 'x', 'block: 1', 'sha256:x', "
                + "now(), 'sub-niemand')", UUID.randomUUID());
        assertThat(ka(w, get(w.bausteine())).body().path("bausteine").findValuesAsText("herkunft"))
                .doesNotContain("fachbetrieb");
    }

    // --- Welt und Wege ----------------------------------------------------------------------------------------------

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Steuerlogik Bausteine #" + nr);
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
                box, t, site, "edge-bausteine-" + nr);
        UUID stab = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "capabilities) VALUES (?, ?, 'heating-rod', 'Heizstab Puffer', 'heating-rod', '{\"measure\":[],"
                + "\"actuate\":[{\"command\":\"on_off\"},{\"command\":\"setpoint_kw\"}]}'::jsonb) RETURNING id",
                UUID.class, t, site);
        root.update("INSERT INTO consumer_profile (entity_id, tenant_id, site_id, control_kind, rated_power_kw) "
                + "VALUES (?, ?, ?, 'on_off', 6.0)", stab, t, site);
        Welt w = new Welt(t, site, box, standort);
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

    /** Thomas Brunner (Partner-Konto) mit einer Unterstützung der Art Installateur an diesem Kunden. */
    private void partner(Welt w, String umfang, boolean ohneSpiegel) {
        if (!ohneSpiegel) {
            root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'partner', "
                    + "'Thomas Brunner', 'aktiv') ON CONFLICT DO NOTHING", w.mandant(), PARTNER);
        }
        LocalDate bis = LocalDate.parse("2099-12-30");
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, art, umfang, gueltig_ab, "
                + "gueltig_bis, endet_am, zeitzone) VALUES (?, ?, 'unterstuetzer', ?, 'installateur', ?, '2024-01-01', ?, "
                + "?, 'Europe/Berlin')", w.mandant(), PARTNER, w.standort(), umfang, bis,
                bis.plusDays(1).atStartOfDay(ZoneId.of("Europe/Berlin")).toOffsetDateTime());
    }

    /** Eine Logik der Anlage, aus der ein Baustein werden kann. */
    private UUID logikVon(Welt w) throws Exception {
        Antwort a = ka(w, post("/api/v1/sites/" + w.site() + "/steuerlogik").content(MAPPER.writeValueAsString(
                MAPPER.createObjectNode().put("text", "logic: 1\n# aus der Anlage"))));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(201);
        return UUID.fromString(a.body().path("logikId").asText());
    }

    private static String alsBaustein(UUID logik, String name, String satz) throws Exception {
        return MAPPER.writeValueAsString(MAPPER.createObjectNode().put("logikId", logik.toString()).put("fassung", 1)
                .put("name", name).put("satz", satz));
    }

    private static JsonNode baustein(JsonNode liste, UUID id) {
        for (JsonNode b : liste.path("bausteine")) {
            if (b.path("id").asText().equals(id.toString())) return b;
        }
        return null;
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

    private Antwort alsPartner(Welt w, MockHttpServletRequestBuilder r) throws Exception {
        Map<String, Object> c = new HashMap<>();
        c.put("sub", PARTNER);
        c.put("preferred_username", PARTNER);
        c.put("realm_access", Map.of("roles", new ArrayList<>(List.of("partner"))));
        Jwt jwt = new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600), Map.of("alg", "none"), c);
        return ruf(r.header("X-Kundenbereich", w.mandant().toString())
                .with(authentication(new KeycloakRealmRoleConverter().convert(jwt))));
    }

    private Antwort plattform(Welt w, MockHttpServletRequestBuilder r) throws Exception {
        return ruf(r.header("X-Tenant-Id", w.mandant().toString()).with(jwt().jwt(j -> {
            j.subject("sub-betrieb");
            j.claim("preferred_username", "VoltPilot Betrieb");
        }).authorities(new SimpleGrantedAuthority("ROLE_platform-admin"),
                new SimpleGrantedAuthority("KONTO_plattform"))));
    }

    private Antwort ruf(MockHttpServletRequestBuilder r) throws Exception {
        MvcResult res = mvc.perform(r.contentType(MediaType.APPLICATION_JSON)).andReturn();
        String text = res.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(res.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
