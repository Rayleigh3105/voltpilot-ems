package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.uems.RechteAbleitung;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
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
 * {@code GET /api/v1/me} je Person des Referenzunternehmens (UEMS AP-03 IP-4) — gegen die Vektoren des Rechte-Vertrags
 * ({@code rechte-vectors.json}), nicht gegen eine zweite Erwartung: jeder Fall legt seinen Kundenbereich, die Person
 * mit ihren Zuweisungen und die Kundenadministratoren in die Datenbank, stellt die Uhr auf den Stichtag und ruft die
 * Route mit einem Token, das der ECHTE Konverter übersetzt (Kundenkonto mit {@code tenant_id}; Partner und Plattform
 * mit {@code X-Kundenbereich}).
 *
 * <ul>
 *   <li>Ableitung {@code sichtbare_standorte}: Standorte, Rollen, Umfang, künftige Zuweisungen, Satz und Teilansicht
 *       zeichengleich.</li>
 *   <li>Ableitung {@code darf} (Ziel Standort oder Unternehmen): die Aktion steht genau dann in den Rechten des
 *       Standorts bzw. des Unternehmens, wenn der Vertrag „darf" sagt; ein 404 des Vertrags heißt: der Standort fehlt.</li>
 *   <li>Unterstützung: der Banner-Satz beim Kunden und beim Unterstützer ist der des Vertrags; ein Kundenkonto sieht
 *       eine Unterstützung nur an seinen Standorten.</li>
 * </ul>
 * Die acht Personen: Jonas, Ines, Peter, Murat, Claudia, Thomas Brunner (Partner), Lena Voss (Plattform) und Sabine
 * Rauch (AP-03 §8 IP-16; die Referenzdatei führt sieben, Sabine steht in den Vektoren).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class SelbstauskunftApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2", "rechte-vectors.json");
    private static final Path MATRIX = Path.of("..", "..", "docs", "contracts", "v2", "rechte-matrix.json");
    private static final Set<String> PERSONEN = Set.of("JW", "IK", "PH", "MD", "CB", "TB", "LV", "SR");
    private static final AtomicInteger NR = new AtomicInteger();

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
    ZugriffKontextLader lader;

    private static JdbcTemplate root;
    private static JsonNode vertrag;
    private static JsonNode matrix;

    /** Ein Kundenbereich in der Datenbank; {@code standorte} = Kennzeichen → Standort. */
    private record Welt(UUID tenant, UUID unternehmen, Map<String, UUID> standorte) {}

    @BeforeAll
    static void verbinde() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        vertrag = MAPPER.readTree(VEKTOREN.toFile());
        matrix = MAPPER.readTree(MATRIX.toFile());
    }

    @AfterEach
    void uhrZurueck() {
        lader.uhrStellen(Clock.systemUTC());
    }

    @Test
    void jedePersonSiehtIhreStandorteKuenftigenZuweisungenUndTeilansichtWieDerVertrag() throws Exception {
        List<String> faelle = new ArrayList<>();
        for (JsonNode c : vertrag.path("cases")) {
            if (!"sichtbare_standorte".equals(c.path("ableitung").asText())) {
                continue;
            }
            String fall = c.path("name").asText();
            JsonNode in = c.path("input");
            JsonNode soll = c.path("expected");
            Welt w = welt(in.path("kundenbereich"));
            JsonNode me = me(w, in);
            faelle.add(fall);

            boolean dritter = !"benutzer".equals(in.path("benutzer").path("konto").asText());
            if (dritter && soll.path("standorte").isEmpty()) {
                // Ohne wirksame Unterstützung wird der Kundenbereich nicht angenommen — über ihn steht nichts in der
                // Antwort, auch nicht die Zahl seiner Standorte, die der Vertrag in der Teilansicht mitführt.
                assertThat(me.path("kundenbereich").isNull()).as(fall).isTrue();
                assertThat(me.path("standorte")).as(fall).isEmpty();
                assertThat(me.path("teilansicht").isNull()).as(fall).isTrue();
                assertThat(me.path("kundenadministratoren")).as(fall).isEmpty();
                continue;
            }
            assertThat(projiziert(me.path("standorte"), "kennzeichen", "name", "rollen", "umfang")).as(fall)
                    .isEqualTo(soll.path("standorte"));
            for (JsonNode s : me.path("standorte")) {
                assertThat(s.path("id").asText()).as(fall).isEqualTo(w.standorte().get(s.path("kennzeichen").asText())
                        .toString());
            }
            assertThat(me.path("unternehmensweit")).as(fall).isEqualTo(soll.path("unternehmensweit"));
            assertThat(me.path("text")).as(fall).isEqualTo(soll.path("text"));
            assertThat(me.path("teilansicht")).as(fall).isEqualTo(soll.path("teilansicht"));
            assertThat(me.path("kuenftig")).as(fall).hasSameSizeAs(soll.path("kuenftig"));
            for (int i = 0; i < soll.path("kuenftig").size(); i++) {
                JsonNode ist = me.path("kuenftig").get(i);
                JsonNode k = soll.path("kuenftig").get(i);
                assertThat(ist.path("standort")).as(fall).isEqualTo(k.path("standort"));
                assertThat(ist.path("text")).as(fall).isEqualTo(k.path("text"));
                assertThat(zeit(ist.path("ab"))).as(fall).isEqualTo(zeit(k.path("ab")));
            }
            assertThat(me.path("kundenbereich").path("id").asText()).as(fall).isEqualTo(w.tenant().toString());
            assertThat(me.path("name").asText()).as(fall).isEqualTo(in.path("benutzer").path("name").asText());
        }
        assertThat(faelle).hasSizeGreaterThanOrEqualTo(13);
    }

    @Test
    void dieRechteJeAktionSindDieDerAbleitungDarfUndJedePersonKommtVor() throws Exception {
        Set<String> personen = new TreeSet<>();
        List<String> fehler = new ArrayList<>();
        int geprueft = 0;
        for (JsonNode c : vertrag.path("cases")) {
            JsonNode in = c.path("input");
            if ("sichtbare_standorte".equals(c.path("ableitung").asText())) {
                personen.add(in.path("benutzer").path("kennung").asText());
            }
            if (!"darf".equals(c.path("ableitung").asText()) || !in.path("ziel").path("anlage").isNull()) {
                continue; // eine Anlage am Stichtag ist kein Feld der Selbstauskunft
            }
            String fall = c.path("name").asText();
            JsonNode soll = c.path("expected");
            String aktion = in.path("aktion").asText();
            boolean darf = soll.path("darf").asBoolean();
            JsonNode me = me(welt(in.path("kundenbereich")), in);
            personen.add(in.path("benutzer").path("kennung").asText());
            geprueft++;

            JsonNode standortZiel = in.path("ziel").path("standort");
            if (standortZiel.isNull()) {
                if (enthaelt(me.path("unternehmen_rechte"), aktion) != darf) {
                    fehler.add(fall + ": Unternehmen " + aktion + " darf=" + darf);
                }
                continue;
            }
            JsonNode s = standort(me, standortZiel.asText());
            if (s != null) {
                if (enthaelt(s.path("rechte"), aktion) != darf) {
                    fehler.add(fall + ": " + standortZiel.asText() + " " + aktion + " darf=" + darf);
                }
            } else if (darf && !enthaelt(me.path("unternehmen_rechte"), aktion)) {
                fehler.add(fall + ": erlaubt ohne sichtbaren Standort, fehlt in unternehmen_rechte: " + aktion);
            } else if (soll.path("http").asInt() == 403) {
                fehler.add(fall + ": 403 heißt sichtbar, der Standort fehlt: " + standortZiel.asText());
            }
        }
        assertThat(fehler).isEmpty();
        assertThat(geprueft).isGreaterThanOrEqualTo(90);
        assertThat(personen).containsAll(PERSONEN);
    }

    @Test
    void dieBannerSaetzeSindDieDesVertragsUndEinKundenkontoSiehtSieNurAnSeinenStandorten() throws Exception {
        List<String> geprueft = new ArrayList<>();
        for (JsonNode c : vertrag.path("cases")) {
            JsonNode u = c.path("input").path("unterstuetzung");
            if (!"unterstuetzung".equals(c.path("ableitung").asText())
                    || !"aktiv".equals(c.path("expected").path("zustand").asText())) {
                continue;
            }
            String fall = c.path("name").asText();
            JsonNode in = c.path("input");
            JsonNode soll = c.path("expected");
            Welt w = welt(in.path("kundenbereich"));
            uhr(in.path("jetzt"));
            kundenadministratoren(w, in.path("kundenbereich"), null);

            String art = u.path("art").asText();
            String konto = "installateur".equals(art) ? "partner" : "plattform";
            String sub = "sub-" + u.path("unterstuetzer").path("kennung").asText("VP") + "-" + NR.incrementAndGet();
            spiegel(w, sub, u.path("unterstuetzer").path("anzeigename").asText("VoltPilot-Support"), konto, "aktiv");
            ObjectNode z = MAPPER.createObjectNode();
            z.put("rolle", "unterstuetzer");
            z.set("standorte", u.path("standorte"));
            z.set("umfang", u.path("umfang"));
            z.put("art", art);
            z.set("gueltig_ab", u.path("gueltig_ab"));
            z.set("gueltig_bis", u.path("gueltig_bis"));
            z.set("beendet_am", u.path("beendet_am"));
            List<UUID> ids = zuweisung(w, sub, z);
            if (!u.path("grund").isMissingNode() && !u.path("grund").isNull()) {
                for (UUID id : ids) {
                    protokollGrund(w, id, sub, u.path("grund").asText());
                }
            }

            // der Kunde: Jonas (Kundenadministrator, alle Standorte)
            JsonNode jonasSicht = ruf(w.tenant(), "sub-JW", "Jonas Wendlinger", "benutzer", null);
            JsonNode gewaehrt = jonasSicht.path("unterstuetzungen").path("gewaehrte");
            assertThat(gewaehrt).as(fall).hasSize(1);
            assertThat(gewaehrt.get(0).path("banner")).as(fall).isEqualTo(soll.path("banner_kunde"));
            assertThat(gewaehrt.get(0).path("erinnerung")).as(fall).isEqualTo(soll.path("erinnerung"));
            assertThat(zeit(gewaehrt.get(0).path("endet"))).as(fall).isEqualTo(zeit(soll.path("endet")));
            assertThat(gewaehrt.get(0).path("zustand").asText()).as(fall).isEqualTo("aktiv");
            assertThat(jonasSicht.path("kundenadministratoren").get(0).path("name").asText()).as(fall)
                    .isEqualTo("Jonas Wendlinger");

            // der Unterstützer selbst, über X-Kundenbereich
            JsonNode selbst = ruf(w.tenant(), sub, "Unterstützer", konto, w.tenant());
            assertThat(selbst.path("zugang").asText()).as(fall).isEqualTo("unterstuetzung");
            assertThat(selbst.path("konto").asText()).as(fall).isEqualTo(konto);
            JsonNode eigene = selbst.path("unterstuetzungen").path("eigene");
            assertThat(eigene).as(fall).hasSize(1);
            assertThat(eigene.get(0).path("banner")).as(fall).isEqualTo(soll.path("banner_unterstuetzer"));
            assertThat(selbst.path("unterstuetzungen").path("gewaehrte")).as(fall).isEmpty();
            assertThat(texte(selbst.path("standorte"), "kennzeichen")).as(fall).isEqualTo(texte(u.path("standorte")));

            // ein Kundenkonto an einem Standort OHNE die Unterstützung sieht sie nicht (auch keinen Standortnamen)
            List<String> andere = new ArrayList<>(w.standorte().keySet());
            andere.removeAll(texte(u.path("standorte")));
            if (!andere.isEmpty()) {
                String peter = "sub-leser-" + NR.incrementAndGet();
                spiegel(w, peter, "Peter Hollerbach", "benutzer", "aktiv");
                ObjectNode leser = MAPPER.createObjectNode();
                leser.put("rolle", "leser");
                leser.set("standorte", MAPPER.createArrayNode().add(andere.get(0)));
                leser.put("gueltig_ab", "2024-01-01T00:00:00+01:00");
                zuweisung(w, peter, leser);
                JsonNode fremd = ruf(w.tenant(), peter, "Peter Hollerbach", "benutzer", null);
                assertThat(fremd.path("unterstuetzungen").path("gewaehrte")).as(fall).isEmpty();
            }
            geprueft.add(fall);
        }
        assertThat(geprueft).isNotEmpty();
    }

    @Test
    void ohneAngenommenenKundenbereichStehtNurDasEigeneKonto() throws Exception {
        Welt w = welt(ahrenberg());
        kundenadministratoren(w, ahrenberg(), null);
        List<String> eigenesKonto = new ArrayList<>();
        for (JsonNode a : matrix.path("aktionen")) {
            boolean nurE = true;
            for (JsonNode zelle : a.path("zellen")) {
                nurE &= "E".equals(zelle.asText());
            }
            if (nurE) {
                eigenesKonto.add(a.path("kennung").asText());
            }
        }
        spiegel(w, "sub-partner-ohne", "Elektro Brunner", "partner", "aktiv");

        for (UUID kopf : new UUID[] {null, w.tenant(), UUID.randomUUID()}) {
            JsonNode me = ruf(w.tenant(), "sub-partner-ohne", "Thomas Brunner", "partner", kopf);
            assertThat(me.path("konto").asText()).isEqualTo("partner");
            assertThat(me.path("kundenbereich").isNull()).isTrue();
            assertThat(me.path("zugang").isNull()).isTrue();
            assertThat(me.path("standorte")).isEmpty();
            assertThat(me.path("kundenadministratoren")).isEmpty();
            assertThat(me.path("teilansicht").isNull()).isTrue();
            assertThat(me.path("name").asText()).as("kein Spiegelname aus dem gewählten Kundenbereich")
                    .isEqualTo("Thomas Brunner");
            assertThat(texte(me.path("unternehmen_rechte"))).isEqualTo(eigenesKonto);
        }
    }

    @Test
    void diePlattformAmUmschalterSiehtDenKundenbereichWieHeute() throws Exception {
        Welt w = welt(ahrenberg());
        kundenadministratoren(w, ahrenberg(), null);
        Map<String, Object> claims = claims("sub-lena", "Lena Voss", "plattform", null);
        MockHttpServletRequestBuilder r = get("/api/v1/me")
                .with(authentication(new KeycloakRealmRoleConverter().convert(jwt(claims))))
                .header("X-Tenant-Id", w.tenant().toString());
        JsonNode me = MAPPER.readTree(mvc.perform(r).andReturn().getResponse()
                .getContentAsString(StandardCharsets.UTF_8));

        assertThat(me.path("konto").asText()).isEqualTo("plattform");
        assertThat(me.path("zugang").asText()).isEqualTo("umschalter");
        assertThat(me.path("unternehmensweit").asBoolean()).isTrue();
        assertThat(texte(me.path("standorte"), "kennzeichen")).isEqualTo(new ArrayList<>(w.standorte().keySet()));
        assertThat(texte(me.path("rollen"))).containsExactly("unterstuetzer");
        assertThat(me.path("unterstuetzungen").path("eigene")).isEmpty();
    }

    // ------------------------------------------------------------------ Welt

    private static JsonNode ahrenberg() {
        for (JsonNode c : vertrag.path("cases")) {
            if ("a2-claudia-zwei-von-drei".equals(c.path("name").asText())) {
                return c.path("input").path("kundenbereich");
            }
        }
        throw new IllegalStateException("Fall a2 fehlt");
    }

    private static Welt welt(JsonNode kundenbereich) {
        String name = kundenbereich.path("name").asText();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                name + " #" + NR.incrementAndGet());
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, name);
        Map<String, UUID> standorte = new LinkedHashMap<>();
        for (JsonNode s : kundenbereich.path("standorte")) {
            standorte.put(s.path("kennzeichen").asText(), root.queryForObject("INSERT INTO standort (tenant_id, "
                    + "unternehmen_id, name, kurzzeichen, zeitzone, zustand) VALUES (?, ?, ?, ?, 'Europe/Berlin', "
                    + "'aktiv') RETURNING id", UUID.class, t, u, s.path("name").asText(),
                    s.path("kennzeichen").asText()));
        }
        return new Welt(t, u, standorte);
    }

    /** Person und Kundenadministratoren des Falls, Uhr auf den Stichtag, dann {@code /me}. */
    private JsonNode me(Welt w, JsonNode in) throws Exception {
        JsonNode b = in.path("benutzer");
        String kennung = b.path("kennung").asText();
        String konto = b.path("konto").asText();
        spiegel(w, "sub-" + kennung, b.path("name").asText(), konto, b.path("zustand").asText());
        for (JsonNode z : b.path("zuweisungen")) {
            zuweisung(w, "sub-" + kennung, z);
        }
        kundenadministratoren(w, in.path("kundenbereich"), kennung);
        uhr(in.path("jetzt"));
        return ruf(w.tenant(), "sub-" + kennung, b.path("name").asText(), konto,
                "benutzer".equals(konto) ? null : w.tenant());
    }

    private void uhr(JsonNode jetzt) {
        lader.uhrStellen(Clock.fixed(OffsetDateTime.parse(jetzt.asText()).toInstant(), ZoneOffset.UTC));
    }

    /** Die Kundenadministratoren des Falls, mandantenweit seit 2024 — außer der Person des Falls selbst. */
    private static void kundenadministratoren(Welt w, JsonNode kundenbereich, String ausser) {
        for (JsonNode ka : kundenbereich.path("kundenadministratoren")) {
            String kennung = ka.path("kennung").asText();
            if (kennung.equals(ausser)) {
                continue;
            }
            spiegel(w, "sub-" + kennung, ka.path("name").asText(), "benutzer", "aktiv");
            root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, gueltig_ab, zeitzone) "
                    + "VALUES (?, ?, 'kundenadministrator', ?, 'Europe/Berlin')", w.tenant(), "sub-" + kennung,
                    OffsetDateTime.parse("2024-01-01T00:00:00+01:00"));
        }
    }

    private static void spiegel(Welt w, String sub, String name, String konto, String zustand) {
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, ?, ?, ?) "
                + "ON CONFLICT (tenant_id, sub) DO NOTHING", w.tenant(), sub, konto, name, zustand);
    }

    /** Eine Zuweisung des Vertrags als Zeilen — eine je Standort; ein Enddatum mit seinem Zeitpunkt (bisZeitpunkt). */
    private static List<UUID> zuweisung(Welt w, String sub, JsonNode z) {
        List<UUID> orte = new ArrayList<>();
        if (z.path("standorte").isArray()) {
            z.path("standorte").forEach(s -> orte.add(standortId(w, s.asText())));
        } else {
            orte.add(null);
        }
        String art = text(z, "art");
        String bisText = text(z, "gueltig_bis");
        LocalDate bis = null;
        OffsetDateTime endet = null;
        if (bisText != null && "notfall".equals(art)) {
            endet = OffsetDateTime.parse(bisText);
        } else if (bisText != null) {
            bis = LocalDate.parse(bisText);
            endet = RechteAbleitung.bisZeitpunkt(bisText).atOffset(ZoneOffset.UTC);
        }
        OffsetDateTime beendet = text(z, "beendet_am") == null ? null : OffsetDateTime.parse(text(z, "beendet_am"));
        List<UUID> ids = new ArrayList<>();
        for (UUID ort : orte) {
            ids.add(root.queryForObject("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, art, umfang, "
                    + "gueltig_ab, gueltig_bis, endet_am, zeitzone, beendet_am, beendet_von) "
                    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Europe/Berlin', ?, ?) RETURNING id", UUID.class, w.tenant(),
                    sub, z.path("rolle").asText(), ort, art, text(z, "umfang"),
                    OffsetDateTime.parse(z.path("gueltig_ab").asText()), bis, endet, beendet,
                    beendet == null ? null : "sub-JW"));
        }
        return ids;
    }

    /** Ein Standort, den die Zuweisung nennt, der Kundenbereich des Falls aber nicht: archiviert (zählt nicht mit). */
    private static UUID standortId(Welt w, String kennzeichen) {
        return w.standorte().computeIfAbsent(kennzeichen, kz -> root.queryForObject("INSERT INTO standort (tenant_id, "
                + "unternehmen_id, name, kurzzeichen, zeitzone, zustand, archiviert_am, archiviert_von) VALUES (?, ?, ?, "
                + "?, 'Europe/Berlin', 'archiviert', now(), 'sub-JW') RETURNING id", UUID.class, w.tenant(),
                w.unternehmen(), "Standort " + kz, kz));
    }

    private static void protokollGrund(Welt w, UUID zugriffId, String sub, String grund) {
        root.update("INSERT INTO zugriff_protokoll (tenant_id, aktion, betroffener_sub, betroffener_name, zugriff_id, "
                + "rolle, grund, actor_name, actor_art) VALUES (?, 'zuweisen', ?, ?, ?, 'unterstuetzer', ?, "
                + "'VoltPilot-Support', 'voltpilot')", w.tenant(), sub, sub, zugriffId, grund);
    }

    // ------------------------------------------------------------------ Anfrage

    private JsonNode ruf(UUID tenant, String sub, String name, String konto, UUID kundenbereichKopf) throws Exception {
        MockHttpServletRequestBuilder r = get("/api/v1/me")
                .with(authentication(new KeycloakRealmRoleConverter().convert(jwt(claims(sub, name, konto, tenant)))));
        if (kundenbereichKopf != null) {
            r.header(ZugriffKontextLader.KUNDENBEREICH_HEADER, kundenbereichKopf.toString());
        }
        MvcResult res = mvc.perform(r).andReturn();
        assertThat(res.getResponse().getStatus()).as(sub).isEqualTo(200);
        return MAPPER.readTree(res.getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    private static Map<String, Object> claims(String sub, String name, String konto, UUID tenant) {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", sub);
        claims.put("name", name);
        claims.put("realm_access", Map.of("roles", switch (konto) {
            case "partner" -> List.of("partner");
            case "plattform" -> List.of("platform-admin");
            default -> List.of();
        }));
        if ("benutzer".equals(konto)) {
            claims.put("tenant_id", tenant.toString());
        }
        return claims;
    }

    private static Jwt jwt(Map<String, Object> claims) {
        return new Jwt("token", Instant.now(), Instant.now().plusSeconds(300), Map.of("alg", "none"), claims);
    }

    // ------------------------------------------------------------------ JSON

    private static ArrayNode projiziert(JsonNode liste, String... felder) {
        ArrayNode aus = MAPPER.createArrayNode();
        for (JsonNode x : liste) {
            ObjectNode o = aus.addObject();
            for (String f : felder) {
                o.set(f, x.path(f));
            }
        }
        return aus;
    }

    private static JsonNode standort(JsonNode me, String kennzeichen) {
        for (JsonNode s : me.path("standorte")) {
            if (kennzeichen.equals(s.path("kennzeichen").asText())) {
                return s;
            }
        }
        return null;
    }

    private static boolean enthaelt(JsonNode liste, String wert) {
        for (JsonNode x : liste) {
            if (wert.equals(x.asText())) {
                return true;
            }
        }
        return false;
    }

    private static List<String> texte(JsonNode liste) {
        List<String> aus = new ArrayList<>();
        liste.forEach(x -> aus.add(x.asText()));
        return aus;
    }

    private static List<String> texte(JsonNode liste, String feld) {
        List<String> aus = new ArrayList<>();
        liste.forEach(x -> aus.add(x.path(feld).asText()));
        return aus;
    }

    private static String text(JsonNode n, String feld) {
        JsonNode x = n.path(feld);
        return x.isMissingNode() || x.isNull() ? null : x.asText();
    }

    private static Instant zeit(JsonNode n) {
        return n.isNull() || n.isMissingNode() ? null : OffsetDateTime.parse(n.asText()).toInstant();
    }
}
