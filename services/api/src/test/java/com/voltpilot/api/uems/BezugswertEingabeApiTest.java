package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.tenant.TenantContext;
import java.nio.charset.StandardCharsets;
import java.time.YearMonth;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
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
 * Den Wert einer Bezugsgröße eingeben, berichtigen und freigeben (UEMS AP-09 IP-7) — über die echten Routen gegen
 * die echte Datenbank. Die Fälle sind B4 und B5 aus {@code bezugsdaten-vectors.json} (die verbindliche Fallquelle),
 * gerechnet in einem Monat, der zu Ende ist: Oktober 2025 statt Oktober 2026 (Z4 prüft gegen die Uhr).
 *
 * <ul>
 *   <li>F1 gegen F5: ein Erstwert ist Fassung 1 ohne Begründung und ohne Freigabe — auch bei Vier-Augen an; ein
 *       zweiter, anderer Wert für dieselbe Periode ist 409 und führt in die Berichtigung; derselbe Wert schreibt gar
 *       nichts, auch nicht als Berichtigung.</li>
 *   <li>Vier-Augen aus: die Berichtigung steht sofort — Fassung 2, {@code correction} 1 → 2 mit Bezug
 *       {@code bezugsgroesse}.</li>
 *   <li>Vier-Augen an: ein Vorschlag, Fassung 1 bleibt wirksam; die Erstellerin gibt sich nicht selbst frei (403);
 *       Jonas Wendlinger gibt über die Route aus AP-08 IP-15 frei → Fassung 2 mit Urheberin UND Freigeber.</li>
 *   <li>U5/U6: „48 200,5“ Stück ist {@code zahl_unlesbar} mit „Stück sind ganze Zahlen.“; eine negative Menge
 *       {@code wert_negativ}; ein unplausibler, gültiger Wert geht durch und trägt nur den Hinweis.</li>
 *   <li>Die Datenbank sagt die Vier Augen noch einmal, und ein fremder Kundenbereich sieht nichts (404).</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class BezugswertEingabeApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String PFAD = "/api/v1/bezugsgroessen";
    private static final String BEGRUENDUNG = "Tippfehler — eine Null fehlte (Montagebericht Oktober)";

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

    private record Wer(String sub, String name, UUID kundenbereich) {}

    private record Welt(UUID mandant, UUID standort, UUID messstelle, Wer ines, Wer jonas) {}

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

    // ================================================================ F1 gegen F5

    /** B4: der Erstwert ist Fassung 1 — ohne Begründung, ohne Freigabe, ohne Ereignis; F5: derselbe Wert schreibt nichts. */
    @Test
    void einErstwertIstFassungEinsUndDerselbeWertSchreibtNichts() throws Exception {
        Welt w = welt();
        // F1: auch bei eingeschalteten Vier Augen braucht ein Erstwert keine Freigabe — er ist keine Korrektur.
        vierAugen(w, true);
        String werte = PFAD + "/" + bezugsgroesse(w, "BZ-2", "Gutteile Montage", "Stück", "standort", w.standort())
                + "/werte";

        Antwort neu = ok(ruf(w.ines(), HttpMethod.POST, werte, Map.of("periode", "Oktober 2025", "wert", "48.200")), 201);
        assertThat(felder(neu.body())).containsExactly("urteil", "satz", "kennung", "hinweise", "wert");
        assertThat(neu.body().get("urteil").asText()).isEqualTo("neu");
        assertThat(neu.body().get("satz").asText()).isEqualTo("Der Wert ist gespeichert.");
        assertThat(neu.body().get("kennung").isNull()).isTrue();
        assertThat(neu.body().get("hinweise")).isEmpty();
        JsonNode wert = neu.body().get("wert");
        assertThat(wert.get("periode_von").asText()).isEqualTo("2025-10-01");
        assertThat(wert.get("periode_bis").asText()).isEqualTo("2025-10-31");
        assertThat(wert.get("wirksamer_betrag").asText()).isEqualTo("48200");
        assertThat(wert.get("wirksame_fassung").asInt()).isEqualTo(1);
        assertThat(wert.get("vorschlag").isNull()).isTrue();
        assertThat(wert.get("fassungen")).hasSize(1);
        JsonNode f1 = wert.at("/fassungen/0");
        assertThat(f1.get("fassung").asInt()).isEqualTo(1);
        assertThat(f1.get("vorgang").asText()).isEqualTo("erstwert");
        assertThat(f1.get("status").asText()).isEqualTo("wirksam");
        assertThat(f1.get("stand").asText()).isEqualTo("wirksam");
        assertThat(f1.get("begruendung").isNull()).isTrue();
        assertThat(f1.get("freigeber").isNull()).isTrue();
        assertThat(f1.at("/herkunft/art").asText()).isEqualTo("eingabe");
        assertThat(f1.at("/herkunft/geliefert_text").asText()).isEqualTo("48.200");
        assertThat(f1.at("/herkunft/geliefert_einheit").asText()).isEqualTo("Stück");
        assertThat(f1.at("/urheber/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(vorgaenge(w)).as("ein Erstwert ist kein Vorgang").isEmpty();
        assertThat(corrections(w)).as("F4: Fassung 1 meldet nichts").isEmpty();

        // F5: derselbe Wert noch einmal — als Eingabe und als Berichtigung — ist eine Wiederholung ohne neue Fassung.
        String vorher = zustand(w);
        Antwort nochmal = ok(ruf(w.ines(), HttpMethod.POST, werte, Map.of("periode", "2025-10", "wert", "48.200")), 200);
        assertThat(nochmal.body().get("urteil").asText()).isEqualTo("wiederholung");
        assertThat(nochmal.body().get("satz").asText()).isEqualTo("Bereits gespeichert, keine Änderung.");
        assertThat(nochmal.body().at("/wert/fassungen")).hasSize(1);
        Antwort gleich = ok(ruf(w.ines(), HttpMethod.POST, werte + "/2025-10/berichtigung",
                Map.of("wert", "48.200", "begruendung", BEGRUENDUNG)), 200);
        assertThat(gleich.body().get("urteil").asText()).isEqualTo("wiederholung");
        assertThat(gleich.body().get("kennung").isNull()).isTrue();
        assertThat(zustand(w)).as("eine Wiederholung schreibt nichts").isEqualTo(vorher);

        // F5: ein ANDERER Wert für dieselbe Periode ist kein zweiter Eintrag — der Weg ist die Berichtigung.
        Antwort anderer = abgelehnt(ruf(w.ines(), HttpMethod.POST, werte, Map.of("periode", "2025-10", "wert", "4.820")),
                "konflikt_anderer_wert");
        assertThat(anderer.body().get("wirksamer_betrag").asText()).isEqualTo("48200");
        assertThat(zustand(w)).isEqualTo(vorher);
        Antwort berichtigt = ok(ruf(w.ines(), HttpMethod.POST, werte + "/2025-10/berichtigung",
                Map.of("wert", "4.820", "begruendung", BEGRUENDUNG)), 201);
        assertThat(berichtigt.body().get("urteil").asText()).as("Vier-Augen an").isEqualTo("vorschlag");
    }

    // ================================================================ Vier-Augen aus

    /** B5, Vier-Augen AUS (Vorgabe): Fassung 2 steht sofort, Fassung 1 bleibt lesbar, correction 1 → 2. */
    @Test
    void vierAugenAusDieBerichtigungStehtSofort() throws Exception {
        Welt w = welt();
        String werte = PFAD + "/" + bezugsgroesse(w, "BZ-2", "Gutteile Montage", "Stück", "standort", w.standort())
                + "/werte";
        ok(ruf(w.ines(), HttpMethod.POST, werte, Map.of("periode", "2025-10", "wert", "4.820")), 201);

        Antwort a = ok(ruf(w.ines(), HttpMethod.POST, werte + "/2025-10/berichtigung",
                Map.of("wert", "48.200", "begruendung", BEGRUENDUNG)), 201);
        assertThat(a.body().get("urteil").asText()).isEqualTo("berichtigung");
        assertThat(a.body().get("satz").asText()).isEqualTo("Berichtigt — die bisherige Fassung bleibt lesbar.");
        String kennung = a.body().get("kennung").asText();
        assertThat(kennung).matches("BK-[0-9]{4}-0001");
        JsonNode wert = a.body().get("wert");
        assertThat(wert.get("wirksamer_betrag").asText()).isEqualTo("48200");
        assertThat(wert.get("wirksame_fassung").asInt()).isEqualTo(2);
        assertThat(wert.get("stand_offen").asBoolean()).isFalse();
        assertThat(wert.get("vorschlag").isNull()).isTrue();
        assertThat(wert.get("fassungen").findValuesAsText("stand")).containsExactly("wirksam bis Fassung 2", "wirksam");
        assertThat(wert.get("fassungen").findValuesAsText("betrag")).containsExactly("4820", "48200");
        JsonNode f2 = wert.at("/fassungen/1");
        assertThat(f2.get("vorgang").asText()).isEqualTo("berichtigung");
        assertThat(f2.get("ersetzt_fassung").asInt()).isEqualTo(1);
        assertThat(f2.get("begruendung").asText()).isEqualTo(BEGRUENDUNG);
        assertThat(f2.at("/urheber/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(f2.get("freigeber").isNull()).isTrue();
        assertThat(vorgaenge(w)).containsExactly(kennung + " 1 freigegeben false 2");
        assertThat(corrections(w)).containsExactly(correction(kennung, 1, 2));
    }

    // ================================================================ Vier-Augen an

    /** B5, Vier-Augen AN: ein Vorschlag; die Erstellerin gibt nicht selbst frei; Jonas gibt frei → Fassung 2 wirksam. */
    @Test
    void vierAugenAnEinVorschlagDenNurEineZweitePersonFreigibt() throws Exception {
        Welt w = welt();
        String werte = PFAD + "/" + bezugsgroesse(w, "BZ-2", "Gutteile Montage", "Stück", "standort", w.standort())
                + "/werte";
        ok(ruf(w.ines(), HttpMethod.POST, werte, Map.of("periode", "2025-10", "wert", "4.820")), 201);
        vierAugen(w, true);

        Antwort v = ok(ruf(w.ines(), HttpMethod.POST, werte + "/2025-10/berichtigung",
                Map.of("wert", "48.200", "begruendung", BEGRUENDUNG)), 201);
        assertThat(v.body().get("urteil").asText()).isEqualTo("vorschlag");
        assertThat(v.body().get("satz").asText()).isEqualTo("Vorschlag gesendet — bis zur Freigabe gilt der bisherige Wert.");
        String kennung = v.body().get("kennung").asText();
        JsonNode wert = v.body().get("wert");
        assertThat(wert.get("wirksamer_betrag").asText()).as("Fassung 1 bleibt wirksam").isEqualTo("4820");
        assertThat(wert.get("wirksame_fassung").asInt()).isEqualTo(1);
        assertThat(wert.get("fassungen")).as("ein Vorschlag ist noch keine Fassung").hasSize(1);
        assertThat(wert.at("/vorschlag/kennung").asText()).isEqualTo(kennung);
        assertThat(wert.at("/vorschlag/betrag").asText()).isEqualTo("48200");
        assertThat(wert.at("/vorschlag/ersetzt_fassung").asInt()).isEqualTo(1);
        assertThat(wert.at("/vorschlag/begruendung").asText()).isEqualTo(BEGRUENDUNG);
        assertThat(wert.at("/vorschlag/urheber/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(ruf(w.ines(), HttpMethod.GET, werte, null).body().at("/werte/0/vorschlag/kennung").asText())
                .isEqualTo(kennung);
        assertThat(corrections(w)).as("ein Vorschlag meldet nichts").isEmpty();
        abgelehnt(ruf(w.ines(), HttpMethod.POST, werte + "/2025-10/berichtigung",
                Map.of("wert", "50.000", "begruendung", "Noch einmal nachgezählt")), "vorschlag_offen");

        // E8: die Erstellerin gibt sich nicht selbst frei — auch mit Recht; nichts ist geschrieben.
        String vorher = zustand(w);
        Antwort selbst = ruf(w.ines(), HttpMethod.POST, "/api/v1/korrekturen/" + kennung + "/freigeben",
                Map.of("begruendung", "Selbst am Montagebericht geprüft"));
        assertThat(selbst.status()).as(String.valueOf(selbst.body())).isEqualTo(403);
        assertThat(selbst.body().get("code").asText()).isEqualTo("zweite_person_noetig");
        assertThat(zustand(w)).isEqualTo(vorher);

        // Jonas Wendlinger (≠ Erstellerin) gibt frei → Fassung 2 wirksam, Urheberin UND Freigeber an derselben Fassung.
        Antwort frei = ok(ruf(w.jonas(), HttpMethod.POST, "/api/v1/korrekturen/" + kennung + "/freigeben",
                Map.of("begruendung", "Montagebericht Oktober geprüft")), 200);
        assertThat(frei.body().get("kennung").asText()).isEqualTo(kennung);
        assertThat(frei.body().get("status").asText()).isEqualTo("freigegeben");
        assertThat(frei.body().get("fassung").asInt()).isEqualTo(2);
        assertThat(frei.body().at("/ersteller/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(frei.body().at("/entschieden_von/name").asText()).isEqualTo("Jonas Wendlinger");
        assertThat(frei.body().get("begruendung").asText()).isEqualTo("Montagebericht Oktober geprüft");
        assertThat(frei.body().get("vieraugen").asBoolean()).isTrue();
        assertThat(frei.body().get("von_ersteller").asBoolean()).isFalse();
        JsonNode nach = ruf(w.ines(), HttpMethod.GET, werte + "?fassungen=alle", null).body().at("/werte/0");
        assertThat(nach.get("wirksamer_betrag").asText()).isEqualTo("48200");
        assertThat(nach.get("wirksame_fassung").asInt()).isEqualTo(2);
        assertThat(nach.get("stand_offen").asBoolean()).isFalse();
        assertThat(nach.get("vorschlag").isNull()).isTrue();
        assertThat(nach.get("fassungen").findValuesAsText("stand")).containsExactly("wirksam bis Fassung 2", "wirksam");
        assertThat(nach.at("/fassungen/1/urheber/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(nach.at("/fassungen/1/freigeber/name").asText()).isEqualTo("Jonas Wendlinger");
        assertThat(nach.at("/fassungen/1/begruendung").asText()).isEqualTo(BEGRUENDUNG);
        assertThat(vorgaenge(w)).containsExactly(kennung + " 1 vorschlag true null", kennung + " 2 freigegeben true 2");
        assertThat(corrections(w)).containsExactly(correction(kennung, 1, 2));

        // Über einen Vorschlag wird genau einmal entschieden; zurückgenommen wird ein BK-… nicht.
        Antwort zweimal = ruf(w.jonas(), HttpMethod.POST, "/api/v1/korrekturen/" + kennung + "/freigeben",
                Map.of("begruendung", "Montagebericht Oktober geprüft"));
        assertThat(zweimal.status()).isEqualTo(409);
        assertThat(zweimal.body().get("code").asText()).isEqualTo("status_passt_nicht");
        Antwort zurueck = ruf(w.jonas(), HttpMethod.POST, "/api/v1/korrekturen/" + kennung + "/zuruecknehmen",
                Map.of("grund", "Doch nicht so gemeint"));
        assertThat(zurueck.status()).isEqualTo(404);
        assertThat(corrections(w)).hasSize(1);
    }

    /** Die Datenbank sagt die Vier Augen noch einmal: eine zweite Person, append-only, kein Vorschlag bei aus. */
    @Test
    void dieDatenbankHaeltDieVierAugen() throws Exception {
        Welt w = welt();
        UUID bz = bezugsgroesse(w, "BZ-2", "Gutteile Montage", "Stück", "standort", w.standort());
        ok(ruf(w.ines(), HttpMethod.POST, PFAD + "/" + bz + "/werte", Map.of("periode", "2025-10", "wert", "4.820")), 201);
        vierAugen(w, true);
        String kennung = ok(ruf(w.ines(), HttpMethod.POST, PFAD + "/" + bz + "/werte/2025-10/berichtigung",
                Map.of("wert", "48.200", "begruendung", BEGRUENDUNG)), 201).body().get("kennung").asText();

        assertThatThrownBy(() -> root.update("INSERT INTO bezugsgroesse_berichtigung (tenant_id, kennung, fassung, "
                + "status, grund, freigabe_vieraugen, wert_fassung, actor_sub, actor_name, actor_art) VALUES (?, ?, 2, "
                + "'freigegeben', 'Selbst am Montagebericht geprüft', true, 2, ?, 'Ines Kaltenbach', 'kunde')",
                w.mandant(), kennung, w.ines().sub())).hasMessageContaining("zweite Person");
        assertThatThrownBy(() -> root.update("UPDATE bezugsgroesse_berichtigung SET begruendung = 'Still und leise geändert' "
                + "WHERE tenant_id = ?", w.mandant())).hasMessageContaining("append-only");
        assertThatThrownBy(() -> root.update("INSERT INTO bezugsgroesse_berichtigung (tenant_id, kennung, fassung, status, "
                + "bezugsgroesse_id, periode_von, periode_bis, zeitzone, ersetzt_fassung, betrag, begruendung, "
                + "freigabe_vieraugen, actor_sub, actor_name, actor_art) VALUES (?, 'BK-2025-0009', 1, 'vorschlag', ?, "
                + "'2025-10-01', '2025-10-31', 'Europe/Berlin', 1, 48200, ?, false, ?, 'Ines Kaltenbach', 'kunde')",
                w.mandant(), bz, BEGRUENDUNG, w.ines().sub())).hasMessageContaining("bezugsgroesse_berichtigung_vieraugen_chk");
        assertThat(vorgaenge(w)).containsExactly(kennung + " 1 vorschlag true null");
    }

    // ================================================================ U5, U6, Z4

    /** U5/U6/Z4: ganze Zahlen, negative Mengen und laufende Perioden sind abgelehnt; ein unplausibler Wert geht durch. */
    @Test
    void ganzeZahlenNegativeMengenUndUnplausibleWerte() throws Exception {
        Welt w = welt();
        String werte = PFAD + "/" + bezugsgroesse(w, "BZ-2", "Gutteile Montage", "Stück", "standort", w.standort())
                + "/werte";
        String vorher = zustand(w);
        Antwort ganz = abgelehnt(ruf(w.ines(), HttpMethod.POST, werte, Map.of("periode", "2025-10", "wert", "48 200,5")),
                "zahl_unlesbar");
        assertThat(ganz.body().get("hinweis").asText()).isEqualTo("Stück sind ganze Zahlen.");
        assertThat(ganz.body().get("feld").asText()).isEqualTo("wert");
        Antwort b4 = abgelehnt(ruf(w.ines(), HttpMethod.POST, werte, Map.of("periode", "2025-10", "wert", "48.200,5")),
                "zahl_unlesbar");
        assertThat(b4.body().get("hinweis").asText()).as("B4: „48.200,5“").isEqualTo("Stück sind ganze Zahlen.");
        abgelehnt(ruf(w.ines(), HttpMethod.POST, werte, Map.of("periode", "2025-10", "wert", "-48.200")), "wert_negativ");
        abgelehnt(ruf(w.ines(), HttpMethod.POST, werte, Map.of("periode",
                YearMonth.now(ZoneId.of("Europe/Berlin")).plusMonths(1).toString(), "wert", "48.200")), "periode_nicht_zu_ende");
        abgelehnt(ruf(w.ines(), HttpMethod.POST, werte, Map.of("periode", "KW 40", "wert", "48.200")), "periode_passt_nicht");
        assertThat(zustand(w)).as("jede Ablehnung schreibt nichts").isEqualTo(vorher);
        Antwort ohneZahl = abgelehnt(ruf(w.ines(), HttpMethod.POST, werte, Map.of("periode", "2025-10", "wert", "viel")),
                "zahl_unlesbar");
        assertThat(ohneZahl.body().has("hinweis")).as("keine Zahl — kein Satz über ganze Zahlen").isFalse();

        // U6: eine Ladezeit über den 745 Stunden des Oktobers 2025 ist auffällig — sie geht durch, mit Hinweis.
        String ladezeit = PFAD + "/" + bezugsgroesse(w, "BZ-7", "Ladezeit Ladepunkt Halle 2", "h", "messstelle",
                w.messstelle()) + "/werte";
        Antwort auffaellig = ok(ruf(w.ines(), HttpMethod.POST, ladezeit, Map.of("periode", "2025-10", "wert", "800")), 201);
        assertThat(auffaellig.body().get("urteil").asText()).isEqualTo("neu");
        assertThat(auffaellig.body().get("hinweise").findValuesAsText("code")).containsExactly("wert_unplausibel");
        assertThat(auffaellig.body().get("hinweise").findValuesAsText("satz"))
                .containsExactly("Dieser Wert ist auffällig — bitte prüfen.");
        assertThat(auffaellig.body().at("/wert/wirksamer_betrag").asText()).isEqualTo("800");
        Antwort plausibel = ok(ruf(w.ines(), HttpMethod.POST, ladezeit, Map.of("periode", "2025-09", "wert", "700")), 201);
        assertThat(plausibel.body().get("hinweise")).isEmpty();
    }

    // ================================================================ Mandantenzaun

    /** Ein fremder Kundenbereich sieht weder die Bezugsgröße noch den Vorschlag: 404, nie 403. */
    @Test
    void einFremderKundenbereichSiehtNichts() throws Exception {
        Welt w = welt();
        Welt fremd = welt();
        UUID bz = bezugsgroesse(w, "BZ-2", "Gutteile Montage", "Stück", "standort", w.standort());
        ok(ruf(w.ines(), HttpMethod.POST, PFAD + "/" + bz + "/werte", Map.of("periode", "2025-10", "wert", "4.820")), 201);
        vierAugen(w, true);
        String kennung = ok(ruf(w.ines(), HttpMethod.POST, PFAD + "/" + bz + "/werte/2025-10/berichtigung",
                Map.of("wert", "48.200", "begruendung", BEGRUENDUNG)), 201).body().get("kennung").asText();

        abgelehnt(ruf(fremd.ines(), HttpMethod.POST, PFAD + "/" + bz + "/werte", Map.of("periode", "2025-11", "wert", "1")),
                "nicht_gefunden");
        abgelehnt(ruf(fremd.ines(), HttpMethod.POST, PFAD + "/" + bz + "/werte/2025-10/berichtigung",
                Map.of("wert", "1", "begruendung", BEGRUENDUNG)), "nicht_gefunden");
        Antwort freigabe = ruf(fremd.jonas(), HttpMethod.POST, "/api/v1/korrekturen/" + kennung + "/freigeben",
                Map.of("begruendung", "Aus einem anderen Kundenbereich"));
        assertThat(freigabe.status()).isEqualTo(404);
        assertThat(freigabe.body().get("code").asText()).isEqualTo("nicht_gefunden");
        assertThat(vorgaenge(w)).containsExactly(kennung + " 1 vorschlag true null");
    }

    // ================================================================ Gerüst

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Bezugswerte #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, "
                + "'Kunststoffwerk Ahrenberg GmbH', 'Europe/Berlin') RETURNING id", UUID.class, t);
        UUID st = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-14', 'Ladepunkt Halle 2', 'gemessen', 'Strom', "
                + "'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, t);
        return new Welt(t, st, ms, new Wer("kc-ines-" + t, "Ines Kaltenbach", t),
                new Wer("kc-jonas-" + t, "Jonas Wendlinger", t));
    }

    private UUID bezugsgroesse(Welt w, String kennzeichen, String name, String einheit, String geltungArt, UUID geltung)
            throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", kennzeichen);
        m.put("name", name);
        m.put("wertart", "periodenwert");
        m.put("einheit", einheit);
        m.put("periode_art", "monat");
        m.put("geltung_art", geltungArt);
        m.put("geltung_id", geltung.toString());
        return UUID.fromString(ok(ruf(w.ines(), HttpMethod.POST, PFAD, m), 201).body().get("id").asText());
    }

    private static void vierAugen(Welt w, boolean an) {
        root.update("UPDATE unternehmen SET vieraugen_freigabe = ? WHERE tenant_id = ?", an, w.mandant());
    }

    /** Die Vorgänge des Kundenbereichs: „Kennung Fassung Status Vier-Augen Wert-Fassung“. */
    private static List<String> vorgaenge(Welt w) {
        return root.query("SELECT kennung, fassung, status, freigabe_vieraugen, wert_fassung FROM bezugsgroesse_berichtigung "
                + "WHERE tenant_id = ? ORDER BY kennung, fassung",
                (rs, n) -> rs.getString("kennung") + " " + rs.getInt("fassung") + " " + rs.getString("status") + " "
                        + rs.getObject("freigabe_vieraugen") + " " + rs.getObject("wert_fassung"),
                w.mandant());
    }

    /** Die Meldungen {@code correction} des Kundenbereichs, wie sie in {@code messreihe_ereignis} stehen. */
    private static List<String> corrections(Welt w) {
        return root.query("SELECT kennungen->>'bezugsgroesse' AS bz, nutzlast->>'korrektur' AS k, "
                + "nutzlast->>'korrektur_art' AS a, nutzlast->>'status' AS s, nutzlast->>'fassung_alt' AS alt, "
                + "nutzlast->>'fassung_neu' AS neu, urheber, von, bis, entity_id FROM messreihe_ereignis "
                + "WHERE tenant_id = ? AND art = 'correction' ORDER BY eingang",
                (rs, n) -> rs.getString("bz") + " " + rs.getString("k") + " " + rs.getString("a") + " "
                        + rs.getString("s") + " " + rs.getString("alt") + "→" + rs.getString("neu") + " "
                        + rs.getString("urheber") + " " + rs.getTimestamp("von").toInstant() + " "
                        + rs.getTimestamp("bis").toInstant() + " " + rs.getObject("entity_id"),
                w.mandant());
    }

    /** B5: Bezug BZ-2, Oktober 2025 in Berlin halboffen, die Art einer Berichtigung, keine Reihe. */
    private static String correction(String kennung, int alt, int neu) {
        return "BZ-2 " + kennung + " wert_berichtigt freigegeben " + alt + "→" + neu
                + " kunde 2025-09-30T22:00:00Z 2025-10-31T23:00:00Z null";
    }

    /** Werte, Vorgänge und Ereignisse des Kundenbereichs als Text — vor und nach einer Ablehnung derselbe. */
    private static String zustand(Welt w) {
        StringBuilder s = new StringBuilder();
        for (String tabelle : List.of("bezugsgroesse_wert", "bezugsgroesse_berichtigung", "messreihe_ereignis")) {
            s.append(tabelle).append('=').append(root.queryForObject("SELECT coalesce(string_agg(to_jsonb(t)::text, '|' "
                    + "ORDER BY to_jsonb(t)::text), '') FROM " + tabelle + " t WHERE tenant_id = ?", String.class,
                    w.mandant())).append('\n');
        }
        return s.toString();
    }

    private static Antwort ok(Antwort a, int status) {
        assertThat(a.status()).as(String.valueOf(a.body())).isEqualTo(status);
        return a;
    }

    /** Eine Ablehnung der Bezugsgrößen-Schnittstelle: Status und Kundensatz aus dem geschlossenen Satz des Vertrags. */
    private static Antwort abgelehnt(Antwort a, String code) {
        BezugsgroesseRegeln.Ablehnung soll = BezugsgroesseRegeln.Ablehnung.valueOf(code.toUpperCase(Locale.ROOT));
        assertThat(a.body().path("code").asText()).as(String.valueOf(a.body())).isEqualTo(code);
        assertThat(a.status()).as(code).isEqualTo(soll.status());
        assertThat(a.body().path("message").asText()).as("Kundensatz " + code).isEqualTo(soll.satz());
        return a;
    }

    private static List<String> felder(JsonNode n) {
        List<String> aus = new ArrayList<>();
        n.fieldNames().forEachRemaining(aus::add);
        return aus;
    }

    private Antwort ruf(Wer wer, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject(wer.sub());
                    j.claim("preferred_username", wer.name());
                    j.claim("tenant_id", wer.kundenbereich().toString());
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
