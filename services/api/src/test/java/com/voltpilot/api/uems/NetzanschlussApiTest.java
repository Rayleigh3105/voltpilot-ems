package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.uems.NetzanschlussAbgelehnt.Ablehnung;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
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
 * Die Netzanschluss-Schnittstelle (UEMS AP-10 IP-6) gegen die echte Kette:
 * {@code /api/v1/standorte/{id}/netzanschluesse} und {@code …/netzanschluesse/{id}/anlagen}. Kennzeichen,
 * Marktlokationen, Leistungen und Bindungstage stammen aus dem Referenzunternehmen Ahrenberg (F16).
 *
 * <p>Geprüft: eine zweite Bindung derselben Anlage am selben Tag ist 409; ein Wechsel beendet die laufende
 * Bindung am Vortag und die Nachfolgerin gilt ab dem Folgetag; ein Kennzeichen wird nach dem Beenden nie
 * wiederverwendet; das Standort-Lesemodell nennt den Netzanschluss jeder Anlage (statt {@code null}); der
 * Mandantenzaun (fremd = 404, nie 403); jede Ablehnung spricht den Satz ihres Codes und schreibt nichts.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class NetzanschlussApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path REFERENZ = Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");
    private static final LocalDate OKT_1 = LocalDate.of(2026, 10, 1);

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
    private static JsonNode referenz;
    private static final AtomicInteger NR = new AtomicInteger();

    /** Ein Kundenbereich mit Werk Ahrenberg (ST-1), Werk Lindach (ST-2) und den Anlagen AN-1 … AN-3. */
    private record Welt(UUID mandant, Map<String, UUID> ids) {
        UUID id(String kennzeichen) {
            return ids.get(kennzeichen);
        }
    }

    private record Antwort(int status, JsonNode body) {}

    @BeforeAll
    static void verbinde() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        referenz = MAPPER.readTree(REFERENZ.toFile());
    }

    // ======================================================================== F16: drei Anschlüsse

    @Test
    void f16DieDreiNetzanschluesseDesReferenzunternehmensUndDasLesemodellNenntSie() throws Exception {
        Welt w = welt();
        Map<String, UUID> na = new LinkedHashMap<>();
        for (JsonNode n : referenz.path("netzanschluesse")) {
            String st = n.path("standort").asText();
            Antwort a = ok(ruf(w, HttpMethod.POST, pfad(w, st), anschluss(n)), 201);
            assertThat(a.body().get("kennzeichen").asText()).isEqualTo(n.path("kennzeichen").asText());
            assertThat(a.body().get("malo").asText()).isEqualTo(n.path("malo").asText());
            assertThat(a.body().get("anschluss_kva").decimalValue()).isEqualByComparingTo(n.path("anschluss_kva").decimalValue());
            assertThat(a.body().get("vereinbart_kw").decimalValue()).isEqualByComparingTo(n.path("vereinbart_kw").decimalValue());
            assertThat(a.body().get("hinweise")).isEmpty();
            assertThat(a.body().at("/standort/kurzzeichen").asText()).isEqualTo(st);
            na.put(n.path("kennzeichen").asText(), id(a));
        }
        // Die Bindungstage der Vektor-Datei (F16, `_abweichungen` „Anlegetag der Objekte“).
        Map<String, LocalDate> seit = Map.of("AN-1", LocalDate.of(2024, 3, 12), "AN-2", OKT_1,
                "AN-3", LocalDate.of(2026, 10, 15));
        for (JsonNode an : referenz.path("anlagen")) {
            String k = an.path("kennzeichen").asText();
            String n = an.path("netzanschluss").asText();
            ok(ruf(w, HttpMethod.POST, pfad(w, an.path("standort").asText()) + "/" + na.get(n) + "/anlagen",
                    binden(w.id(k), seit.get(k))), 201);
        }

        Antwort liste = ok(ruf(w, HttpMethod.GET, pfad(w, "ST-1"), null), 200);
        assertThat(kennzeichen(liste.body().get("netzanschluesse"))).containsExactly("NA-1", "NA-2");
        assertThat(liste.body().at("/netzanschluesse/0/anlagen/0/anlage/name").asText())
                .isEqualTo("Werk Ahrenberg – Halle 1");
        assertThat(liste.body().at("/netzanschluesse/0/anlagen/0/gueltig_ab").asText()).isEqualTo("2024-03-12");
        assertThat(kennzeichen(ok(ruf(w, HttpMethod.GET, pfad(w, "ST-2"), null), 200).body().get("netzanschluesse")))
                .containsExactly("NA-3");

        // StandortLesemodell füllt den Netzanschluss der Anlage — nicht mehr null.
        Antwort st1 = ok(ruf(w, HttpMethod.GET, "/api/v1/standorte/" + w.id("ST-1") + "?stichtag=2026-10-20", null), 200);
        Map<String, String> netz = new LinkedHashMap<>();
        st1.body().get("anlagen").forEach(a -> netz.put(a.get("name").asText(), a.at("/netzanschluss/kennzeichen").asText()));
        assertThat(netz).isEqualTo(Map.of("Werk Ahrenberg – Halle 1", "NA-1", "Werk Ahrenberg – Halle 2", "NA-2"));
        Antwort st2 = ok(ruf(w, HttpMethod.GET, "/api/v1/standorte/" + w.id("ST-2") + "?stichtag=2026-10-20", null), 200);
        assertThat(st2.body().at("/anlagen/0/netzanschluss/kennzeichen").asText()).isEqualTo("NA-3");
        assertThat(st2.body().at("/anlagen/0/netzanschluss/gueltigAb").asText()).isEqualTo("2026-10-15");

        // Genau ein Protokolleintrag je Schreibvorgang: drei angelegt, drei gebunden.
        assertThat(root.queryForList("SELECT art FROM netzanschluss_aenderung WHERE tenant_id = ? ORDER BY id",
                String.class, w.mandant())).containsExactly("angelegt", "angelegt", "angelegt", "gebunden", "gebunden",
                        "gebunden");
        // W9: die Preis- und Grenzspalten der Anlage sind unberührt — es gibt keine Netzanschluss-Spalte an ihr.
        assertThat(root.queryForObject("SELECT count(*) FROM information_schema.columns WHERE table_name = 'site' "
                + "AND column_name LIKE '%netzanschluss%'", Long.class)).isZero();
    }

    // ================================================================= 1 : 1 je Tag (E8)

    @Test
    void eineZweiteBindungDerselbenAnlageAmSelbenTagIst409UndSchreibtNichts() throws Exception {
        Welt w = welt();
        UUID na1 = id(ok(ruf(w, HttpMethod.POST, pfad(w, "ST-1"), anschluss("NA-1", "Hauptanschluss Halle 1")), 201));
        UUID na2 = id(ok(ruf(w, HttpMethod.POST, pfad(w, "ST-1"), anschluss("NA-2", "Anschluss Halle 2")), 201));
        ok(ruf(w, HttpMethod.POST, pfad(w, "ST-1") + "/" + na1 + "/anlagen", binden(w.id("AN-1"), OKT_1)), 201);
        long bindungen = zahl("anlage_netzanschluss", w);
        long protokoll = zahl("netzanschluss_aenderung", w);

        Antwort a = abgelehnt(w, HttpMethod.POST, pfad(w, "ST-1") + "/" + na2 + "/anlagen", binden(w.id("AN-1"), OKT_1),
                "bindung_ueberlappt");
        assertThat(a.status()).isEqualTo(409);
        assertThat(a.body().get("bindungen")).hasSize(1);
        // Auch derselbe Anschluss ein zweites Mal am selben Tag ist kein Nachtrag.
        abgelehnt(w, HttpMethod.POST, pfad(w, "ST-1") + "/" + na1 + "/anlagen", binden(w.id("AN-1"), OKT_1),
                "bindung_ueberlappt");
        // Ein früherer Beginn schiebt sich nicht vor die laufende.
        abgelehnt(w, HttpMethod.POST, pfad(w, "ST-1") + "/" + na2 + "/anlagen",
                binden(w.id("AN-1"), LocalDate.of(2026, 9, 1)), "bindung_ueberlappt");
        // Der Anschluss hängt an dem Tag schon an einer anderen Anlage.
        abgelehnt(w, HttpMethod.POST, pfad(w, "ST-1") + "/" + na1 + "/anlagen", binden(w.id("AN-2"), OKT_1),
                "anschluss_belegt");
        assertThat(zahl("anlage_netzanschluss", w)).isEqualTo(bindungen);
        assertThat(zahl("netzanschluss_aenderung", w)).isEqualTo(protokoll);
    }

    @Test
    void einWechselBeendetDieLaufendeBindungAmVortagUndDieNachfolgerinGiltAbDemFolgetag() throws Exception {
        Welt w = welt();
        UUID na1 = id(ok(ruf(w, HttpMethod.POST, pfad(w, "ST-1"), anschluss("NA-1", "Hauptanschluss Halle 1")), 201));
        UUID na2 = id(ok(ruf(w, HttpMethod.POST, pfad(w, "ST-1"), anschluss("NA-2", "Anschluss Halle 2")), 201));
        ok(ruf(w, HttpMethod.POST, pfad(w, "ST-1") + "/" + na2 + "/anlagen", binden(w.id("AN-2"), OKT_1)), 201);

        Antwort wechsel = ok(ruf(w, HttpMethod.POST, pfad(w, "ST-1") + "/" + na1 + "/anlagen",
                binden(w.id("AN-2"), LocalDate.of(2027, 1, 1))), 201);
        assertThat(wechsel.body().at("/anlagen/0/gueltig_ab").asText()).isEqualTo("2027-01-01");
        assertThat(wechsel.body().at("/anlagen/0/gueltig_bis").isNull()).isTrue();
        Antwort alt = ok(ruf(w, HttpMethod.GET, pfad(w, "ST-1") + "/" + na2, null), 200);
        assertThat(alt.body().at("/anlagen/0/gueltig_ab").asText()).isEqualTo("2026-10-01");
        assertThat(alt.body().at("/anlagen/0/gueltig_bis").asText()).isEqualTo("2026-12-31");

        // Das Lesemodell: der Vortag zeigt den alten, der Folgetag den neuen Anschluss — nie beide.
        assertThat(netzanschlussAm(w, "Werk Ahrenberg – Halle 2", "2026-12-31")).isEqualTo("NA-2");
        assertThat(netzanschlussAm(w, "Werk Ahrenberg – Halle 2", "2027-01-01")).isEqualTo("NA-1");
        // Mit Stichtag nennt die Liste je Anschluss nur die Bindungen des Tages.
        Antwort amTag = ok(ruf(w, HttpMethod.GET, pfad(w, "ST-1") + "?stichtag=2026-12-31", null), 200);
        assertThat(amTag.body().at("/netzanschluesse/0/anlagen")).isEmpty();
        assertThat(amTag.body().at("/netzanschluesse/1/anlagen")).hasSize(1);

        // EIN Protokolleintrag für den Wechsel — alt ist die am Vortag beendete Bindung.
        JsonNode eintrag = MAPPER.readTree(root.queryForObject("SELECT jsonb_build_object('alt', alt, 'neu', neu)::text "
                + "FROM netzanschluss_aenderung WHERE tenant_id = ? AND art = 'gebunden' ORDER BY id DESC LIMIT 1",
                String.class, w.mandant()));
        assertThat(eintrag.at("/alt/netzanschluss").asText()).isEqualTo("NA-2");
        assertThat(eintrag.at("/alt/gueltig_bis").asText()).isEqualTo("2026-12-31");
        assertThat(eintrag.at("/neu/netzanschluss").asText()).isEqualTo("NA-1");
        assertThat(eintrag.at("/neu/gueltig_ab").asText()).isEqualTo("2027-01-01");
    }

    // ======================================================================== Kennzeichen

    @Test
    void einKennzeichenWirdNachDemBeendenNieWiederverwendet() throws Exception {
        Welt w = welt();
        assertThat(ok(ruf(w, HttpMethod.GET, pfad(w, "ST-1"), null), 200).body().get("kennzeichen_vorschlag").asText())
                .isEqualTo("NA-0001");
        Map<String, Object> ohne = anschluss(null, "Hauptanschluss Halle 1");
        Antwort erster = ok(ruf(w, HttpMethod.POST, pfad(w, "ST-1"), ohne), 201);
        assertThat(erster.body().get("kennzeichen").asText()).isEqualTo("NA-0001");
        UUID id = id(erster);

        // Beenden: das Ende setzen (PUT ist die ganze Menge).
        Map<String, Object> beendet = anschluss("NA-0001", "Hauptanschluss Halle 1");
        beendet.put("gueltig_bis", "2026-12-31");
        assertThat(ok(ruf(w, HttpMethod.PUT, pfad(w, "ST-1") + "/" + id, beendet), 200).body().get("gueltig_bis").asText())
                .isEqualTo("2026-12-31");
        // Ein Ende wird nur vorgezogen.
        Map<String, Object> wieder = anschluss("NA-0001", "Hauptanschluss Halle 1");
        abgelehnt(w, HttpMethod.PUT, pfad(w, "ST-1") + "/" + id, wieder, "bereits_beendet");

        // Das Kennzeichen des beendeten Anschlusses bleibt belegt — von Hand und automatisch.
        abgelehnt(w, HttpMethod.POST, pfad(w, "ST-1"), anschluss("NA-0001", "Neuer Anschluss"), "kennzeichen_belegt");
        abgelehnt(w, HttpMethod.POST, pfad(w, "ST-2"), anschluss("NA-0001", "Neuer Anschluss"), "kennzeichen_belegt");
        Antwort zweiter = ok(ruf(w, HttpMethod.POST, pfad(w, "ST-1"), ohne), 201);
        assertThat(zweiter.body().get("kennzeichen").asText()).isEqualTo("NA-0002");

        // Umbenannt: das frühere bleibt belegt; der Anschluss selbst darf zurück.
        Map<String, Object> umbenannt = anschluss("NA-7", "Hauptanschluss Halle 1");
        ok(ruf(w, HttpMethod.PUT, pfad(w, "ST-1") + "/" + id(zweiter), umbenannt), 200);
        abgelehnt(w, HttpMethod.POST, pfad(w, "ST-1"), anschluss("NA-0002", "Dritter"), "kennzeichen_belegt");
        ok(ruf(w, HttpMethod.PUT, pfad(w, "ST-1") + "/" + id(zweiter), anschluss("NA-0002", "Hauptanschluss Halle 1")), 200);
        assertThat(ok(ruf(w, HttpMethod.GET, pfad(w, "ST-1"), null), 200).body().get("kennzeichen_vorschlag").asText())
                .isEqualTo("NA-0003");
        abgelehntMitFeld(w, HttpMethod.POST, pfad(w, "ST-1"), anschluss("na 1", "Dritter"), "kennzeichen_format",
                "kennzeichen");
        // Ohne Änderung: kein Protokolleintrag.
        long vorher = zahl("netzanschluss_aenderung", w);
        ok(ruf(w, HttpMethod.PUT, pfad(w, "ST-1") + "/" + id(zweiter), anschluss("NA-0002", "Hauptanschluss Halle 1")), 200);
        assertThat(zahl("netzanschluss_aenderung", w)).isEqualTo(vorher);
    }

    // ======================================================================= Mandantenzaun

    @Test
    void einFremderStandortIst404NieEin403() throws Exception {
        Welt a = welt();
        Welt b = welt();
        UUID na = id(ok(ruf(a, HttpMethod.POST, pfad(a, "ST-1"), anschluss("NA-1", "Hauptanschluss Halle 1")), 201));

        abgelehnt(b, HttpMethod.GET, pfad(a, "ST-1"), null, "nicht_gefunden");
        abgelehnt(b, HttpMethod.POST, pfad(a, "ST-1"), anschluss("NA-1", "Übernommen"), "nicht_gefunden");
        abgelehnt(b, HttpMethod.GET, pfad(a, "ST-1") + "/" + na, null, "nicht_gefunden");
        abgelehnt(b, HttpMethod.PUT, pfad(a, "ST-1") + "/" + na, anschluss("NA-1", "Übernommen"), "nicht_gefunden");
        abgelehnt(b, HttpMethod.POST, pfad(a, "ST-1") + "/" + na + "/anlagen", binden(b.id("AN-1"), OKT_1),
                "nicht_gefunden");
        // Der Anschluss unter dem eigenen Standort des anderen Kundenbereichs — auch nicht da.
        abgelehnt(b, HttpMethod.GET, pfad(b, "ST-1") + "/" + na, null, "nicht_gefunden");
        // Und im eigenen Kundenbereich unter dem FALSCHEN Standort.
        abgelehnt(a, HttpMethod.GET, pfad(a, "ST-2") + "/" + na, null, "nicht_gefunden");
        abgelehnt(a, HttpMethod.GET, pfad(a, "ST-1") + "/kein-uuid", null, "nicht_gefunden");
        // Eine fremde Anlage ist für den Kundenbereich keine Anlage.
        abgelehntMitFeld(a, HttpMethod.POST, pfad(a, "ST-1") + "/" + na + "/anlagen", binden(b.id("AN-1"), OKT_1),
                "anlage_unbekannt", "anlage_id");
        assertThat(ok(ruf(b, HttpMethod.GET, pfad(b, "ST-1"), null), 200).body().get("netzanschluesse")).isEmpty();
        // Dasselbe Kennzeichen darf ein anderer Kundenbereich tragen.
        ok(ruf(b, HttpMethod.POST, pfad(b, "ST-1"), anschluss("NA-1", "Hauptanschluss")), 201);
        assertThat(root.queryForObject("SELECT name FROM netzanschluss WHERE id = ?", String.class, na))
                .isEqualTo("Hauptanschluss Halle 1");
    }

    // ============================================================= Felder, Tage, Anlage löschen

    @Test
    void dieAblehnungenSprechenIhrenSatzUndSchreibenNichts() throws Exception {
        Welt w = welt();
        Map<String, Object> malo = anschluss("NA-1", "Hauptanschluss Halle 1");
        malo.put("malo", "4711000000");
        abgelehntMitFeld(w, HttpMethod.POST, pfad(w, "ST-1"), malo, "malo_form", "malo");
        Map<String, Object> messung = anschluss("NA-1", "Hauptanschluss Halle 1");
        messung.put("messung", "Smart");
        abgelehntMitFeld(w, HttpMethod.POST, pfad(w, "ST-1"), messung, "anfrage_ungueltig", "messung");
        abgelehntMitFeld(w, HttpMethod.POST, pfad(w, "ST-1"), anschluss("NA-1", "  "), "anfrage_ungueltig", "name");
        Map<String, Object> null_kva = anschluss("NA-1", "Hauptanschluss Halle 1");
        null_kva.put("anschluss_kva", 0);
        abgelehntMitFeld(w, HttpMethod.POST, pfad(w, "ST-1"), null_kva, "anfrage_ungueltig", "anschluss_kva");
        Map<String, Object> fremd = anschluss("NA-1", "Hauptanschluss Halle 1");
        fremd.put("standortId", "x");
        abgelehntMitFeld(w, HttpMethod.POST, pfad(w, "ST-1"), fremd, "anfrage_ungueltig", "standortId");
        Map<String, Object> tage = anschluss("NA-1", "Hauptanschluss Halle 1");
        tage.put("gueltig_ab", "2027-01-01");
        tage.put("gueltig_bis", "2026-12-31");
        abgelehnt(w, HttpMethod.POST, pfad(w, "ST-1"), tage, "zeitraum_ungueltig");
        assertThat(zahl("netzanschluss", w)).isZero();
        assertThat(zahl("netzanschluss_aenderung", w)).isZero();

        // Vereinbart über Anschluss ist ein HINWEIS — der Netzbetreiber hat recht, nicht wir.
        Map<String, Object> hinweis = anschluss("NA-1", "Hauptanschluss Halle 1");
        hinweis.put("anschluss_kva", "200");
        hinweis.put("gueltig_ab", "2026-10-01");
        hinweis.put("gueltig_bis", "2027-12-31");
        Antwort na = ok(ruf(w, HttpMethod.POST, pfad(w, "ST-1"), hinweis), 201);
        assertThat(na.body().get("hinweise").get(0).asText()).isEqualTo("vereinbart_ueber_anschluss");

        // Die Bindung gilt nie länger als ihr Anschluss — sie endet mit ihm, und vor seinem Beginn gibt es keine.
        abgelehnt(w, HttpMethod.POST, pfad(w, "ST-1") + "/" + id(na) + "/anlagen",
                binden(w.id("AN-1"), LocalDate.of(2026, 9, 30)), "netzanschluss_besteht_nicht");
        Antwort gebunden = ok(ruf(w, HttpMethod.POST, pfad(w, "ST-1") + "/" + id(na) + "/anlagen",
                binden(w.id("AN-1"), LocalDate.of(2026, 10, 15))), 201);
        assertThat(gebunden.body().at("/anlagen/0/gueltig_bis").asText()).isEqualTo("2027-12-31");
        // Ein Ende, das die Bindung abschnitte: 409 mit der Liste — gekürzt wird nichts.
        hinweis.put("gueltig_bis", "2027-06-30");
        Antwort imWeg = abgelehnt(w, HttpMethod.PUT, pfad(w, "ST-1") + "/" + id(na), hinweis, "bindung_besteht");
        assertThat(imWeg.body().at("/bindungen/0/anlage_name").asText()).isEqualTo("Werk Ahrenberg – Halle 1");
        assertThat(root.queryForObject("SELECT gueltig_bis FROM netzanschluss WHERE id = ?", LocalDate.class, id(na)))
                .isEqualTo(LocalDate.of(2027, 12, 31));

        abgelehntMitFeld(w, HttpMethod.POST, pfad(w, "ST-1") + "/" + id(na) + "/anlagen",
                Map.of("anlage_id", w.id("AN-1").toString()), "anfrage_ungueltig", "gueltig_ab");
        abgelehntMitFeld(w, HttpMethod.POST, pfad(w, "ST-1") + "/" + id(na) + "/anlagen",
                Map.of("anlage_id", "keine", "gueltig_ab", "2026-10-15"), "anfrage_ungueltig", "anlage_id");
        abgelehnt(w, HttpMethod.DELETE, pfad(w, "ST-1") + "/" + id(na), null, null);
    }

    /** Die Anlage darf gehen (W5): ihre Bindung endet heute, bleibt stehen und gibt den Anschluss frei. */
    @Test
    void eineGeloeschteAnlageGibtIhrenAnschlussFrei() throws Exception {
        Welt w = welt();
        UUID na = id(ok(ruf(w, HttpMethod.POST, pfad(w, "ST-1"), anschluss("NA-2", "Anschluss Halle 2")), 201));
        ok(ruf(w, HttpMethod.POST, pfad(w, "ST-1") + "/" + na + "/anlagen", binden(w.id("AN-2"), LocalDate.of(2026, 1, 1))),
                201);
        assertThat(ruf(w, HttpMethod.DELETE, "/api/v1/sites/" + w.id("AN-2"), null).status()).isEqualTo(204);

        LocalDate heute = LocalDate.now(ZoneId.of("Europe/Berlin"));
        Antwort nachher = ok(ruf(w, HttpMethod.GET, pfad(w, "ST-1") + "/" + na, null), 200);
        assertThat(nachher.body().at("/anlagen/0/gueltig_bis").asText()).isEqualTo(heute.toString());
        assertThat(nachher.body().at("/anlagen/0/anlage/name").isNull()).isTrue();
        assertThat(root.queryForList("SELECT art FROM netzanschluss_aenderung WHERE tenant_id = ? ORDER BY id",
                String.class, w.mandant())).containsExactly("angelegt", "gebunden", "anlage_entfernt");
        // Ab morgen hängt der Anschluss an einer anderen Anlage.
        ok(ruf(w, HttpMethod.POST, pfad(w, "ST-1") + "/" + na + "/anlagen", binden(w.id("AN-1"), heute.plusDays(1))), 201);
    }

    @Test
    void vorschlagLiestNurUndUebernahmeBindetAtomarOhneSiteAenderung() throws Exception {
        Welt w = vorschlagswelt();
        root.update("UPDATE site SET max_feed_in_kw = 75, leistungspreis_eur_kw = 120, "
                + "tarif_art = 'fest', tarif_param_ct_kwh = 32, netzladen_erlaubt = true, "
                + "anzulegender_wert_ct_kwh = 8, marktpraemie_ct_kwh = 2 WHERE tenant_id = ?", w.mandant());
        List<String> vorher = siteZeilen(w);
        String p = pfad(w, "ST-1") + "/vorschlaege";
        Antwort liste = ok(ruf(w, HttpMethod.GET, p, null), 200);
        assertThat(liste.body()).hasSize(2);
        JsonNode v = liste.body().get(0);
        assertThat(v.path("kennzeichen").asText()).isEqualTo("NA-0001");
        assertThat(liste.body().get(1).path("kennzeichen").asText()).isEqualTo("NA-0002");
        assertThat(v.path("name").asText()).isEqualTo("Netzanschluss " + v.path("anlage_name").asText());
        assertThat(v.path("bindung_ab").asText()).isEqualTo("2024-03-12");
        assertThat(v.has("vereinbart_kw")).isFalse();
        assertThat(v.has("netzbetreiber")).isFalse();
        assertThat(zahl("netzanschluss", w)).isZero();
        assertThat(zahl("netzanschluss_vorschlag_entscheidung", w)).isZero();
        Map<String, Object> a = anschluss(referenz.path("netzanschluesse").get(0));
        a.put("kennzeichen", v.path("kennzeichen").asText());
        a.put("bindung_ab", v.path("bindung_ab").asText());
        a.put("grund", "Vorhandene Anlage zugeordnet.");
        String uebernehmen = p + "/" + v.path("anlage_id").asText() + "/uebernehmen";
        Antwort neu = ok(ruf(w, HttpMethod.POST, uebernehmen, a), 201);
        assertThat(neu.body().at("/anlagen/0/anlage/id").asText()).isEqualTo(v.path("anlage_id").asText());
        assertThat(neu.body().at("/anlagen/0/gueltig_ab").asText()).isEqualTo("2024-03-12");
        assertThat(neu.body().path("vereinbart_kw").decimalValue()).isEqualByComparingTo("550");
        ok(ruf(w, HttpMethod.POST, uebernehmen, a), 409);
        assertThat(zahl("netzanschluss", w)).isEqualTo(1);
        assertThat(zahl("anlage_netzanschluss", w)).isEqualTo(1);
        assertThat(zahl("netzanschluss_vorschlag_entscheidung", w)).isEqualTo(1);
        assertThat(siteZeilen(w)).isEqualTo(vorher);
        assertThat(ok(ruf(w, HttpMethod.GET, p, null), 200).body()).hasSize(1);
    }

    @Test
    void verwerfenBleibtGemerktUndBetriebskundeHatKeineVorschlaege() throws Exception {
        Welt w = vorschlagswelt();
        String p = pfad(w, "ST-1") + "/vorschlaege";
        List<String> vorher = siteZeilen(w);
        ok(ruf(w, HttpMethod.POST, p + "/" + w.id("AN-1") + "/verwerfen", null), 204);
        ok(ruf(w, HttpMethod.POST, p + "/" + w.id("AN-1") + "/verwerfen", null), 409);
        assertThat(ok(ruf(w, HttpMethod.GET, p, null), 200).body()).hasSize(1);
        assertThat(root.queryForObject("SELECT entscheidung FROM netzanschluss_vorschlag_entscheidung WHERE tenant_id = ?",
                String.class, w.mandant())).isEqualTo("verworfen");
        assertThat(zahl("netzanschluss", w)).isZero();
        assertThat(siteZeilen(w)).isEqualTo(vorher);
        Welt betrieb = welt();
        assertThat(ok(ruf(betrieb, HttpMethod.GET, pfad(betrieb, "ST-1") + "/vorschlaege", null), 200).body()).isEmpty();
        ok(ruf(betrieb, HttpMethod.GET, p, null), 404);
        ok(ruf(w, HttpMethod.POST, p + "/" + betrieb.id("AN-1") + "/verwerfen", null), 404);
    }

    @Test
    void fehlgeschlageneBindungRolltAnschlussKennzeichenUndEntscheidungZurueck() throws Exception {
        Welt w = vorschlagswelt();
        Map<String, Object> a = anschluss("NA-0001", "Netzanschluss Halle 1");
        a.put("gueltig_ab", "2025-01-01");
        a.put("bindung_ab", "2024-03-12");
        a.put("grund", "Zuordnung des Bestands.");
        String p = pfad(w, "ST-1") + "/vorschlaege/" + w.id("AN-1") + "/uebernehmen";
        ok(ruf(w, HttpMethod.POST, p, a), 422);
        assertThat(zahl("netzanschluss", w)).isZero();
        assertThat(zahl("netzanschluss_kennzeichen", w)).isZero();
        assertThat(zahl("netzanschluss_aenderung", w)).isZero();
        assertThat(zahl("netzanschluss_vorschlag_entscheidung", w)).isZero();
        a.remove("gueltig_ab");
        a.put("bindung_ab", "2024-04-01");
        Antwort neu = ok(ruf(w, HttpMethod.POST, p, a), 201);
        assertThat(neu.body().at("/anlagen/0/gueltig_ab").asText()).isEqualTo("2024-04-01");
    }

    @Test
    void bestehendeBindungUndFehlendePflichtfelderWerdenNichtUmgangen() throws Exception {
        Welt w = vorschlagswelt();
        String p = pfad(w, "ST-1") + "/vorschlaege/" + w.id("AN-1") + "/uebernehmen";
        Map<String, Object> a = anschluss("NA-0001", "Netzanschluss Halle 1");
        a.put("bindung_ab", "2024-03-12");
        ok(ruf(w, HttpMethod.POST, p, a), 400); // Rückwirkung braucht Begründung.
        a.put("grund", "Zuordnung des Bestands.");
        a.remove("messung");
        ok(ruf(w, HttpMethod.POST, p, a), 400);
        a.put("messung", "RLM");
        UUID id = id(ok(ruf(w, HttpMethod.POST, pfad(w, "ST-1"), anschluss("NA-9", "Anschluss")), 201));
        ok(ruf(w, HttpMethod.POST, pfad(w, "ST-1") + "/" + id + "/anlagen",
                binden(w.id("AN-1"), LocalDate.of(2024, 3, 12))), 201);
        ok(ruf(w, HttpMethod.POST, p, a), 409);
        assertThat(zahl("netzanschluss", w)).isEqualTo(1);
        assertThat(zahl("netzanschluss_vorschlag_entscheidung", w)).isZero();
    }

    @Test
    void entscheidungHatErzwungeneRlsUndNurLesenEintragenRechte() throws Exception {
        Welt w = vorschlagswelt();
        ok(ruf(w, HttpMethod.POST, pfad(w, "ST-1") + "/vorschlaege/" + w.id("AN-1") + "/verwerfen", null), 204);
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'netzanschluss_vorschlag_entscheidung'", Boolean.class)).isTrue();
        assertThat(root.queryForObject("SELECT has_table_privilege(?, 'netzanschluss_vorschlag_entscheidung', 'UPDATE,DELETE')",
                Boolean.class, APP_USER)).isFalse();
        Welt fremd = vorschlagswelt();
        try (var c = new DriverManagerDataSource(POSTGRES.getJdbcUrl(), APP_USER, APP_PW).getConnection()) {
            try (var st = c.prepareStatement("SELECT set_config('app.tenant_id', ?, false)")) {
                st.setString(1, fremd.mandant().toString());
                st.execute();
            }
            try (var st = c.createStatement(); var rs = st.executeQuery("SELECT count(*) FROM netzanschluss_vorschlag_entscheidung")) {
                rs.next();
                assertThat(rs.getInt(1)).isZero();
            }
            try (var st = c.prepareStatement("INSERT INTO netzanschluss_vorschlag_entscheidung "
                    + "(tenant_id, site_id, entscheidung, entschieden_von) VALUES (?, ?, 'verworfen', 'Test')")) {
                st.setObject(1, w.mandant());
                st.setObject(2, w.id("AN-2"));
                assertThatThrownBy(st::executeUpdate).hasMessageContaining("row-level security");
            }
        }
    }

    private Welt vorschlagswelt() {
        Welt w = welt();
        root.update("UPDATE anlage_standort SET gueltig_ab = DATE '2024-03-12' WHERE tenant_id = ?", w.mandant());
        root.update("INSERT INTO funktion (tenant_id, standort_id, funktion, zustand, geaendert_von) "
                + "VALUES (?, ?, 'messen', 'aktiv', 'Test')", w.mandant(), w.id("ST-1"));
        return w;
    }

    private List<String> siteZeilen(Welt w) {
        return root.queryForList("SELECT row_to_json(s)::text FROM site s WHERE tenant_id = ? ORDER BY id",
                String.class, w.mandant());
    }

    // ============================================================================== Gerüst

    private Welt welt() {
        int nr = NR.incrementAndGet();
        Map<String, UUID> ids = new LinkedHashMap<>();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Netzanschluss #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, "
                + "'Kunststoffwerk Ahrenberg GmbH', 'Europe/Berlin') RETURNING id", UUID.class, t);
        for (JsonNode s : referenz.path("standorte")) {
            String kz = s.path("kennzeichen").asText();
            ids.put(kz, root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                    + "zustand) VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u,
                    s.path("name").asText(), kz));
        }
        for (JsonNode an : referenz.path("anlagen")) {
            UUID site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, ?) RETURNING id", UUID.class, t,
                    an.path("name").asText());
            ids.put(an.path("kennzeichen").asText(), site);
            root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?, ?, ?, ?)",
                    t, site, ids.get(an.path("standort").asText()), OKT_1);
        }
        return new Welt(t, ids);
    }

    private static String pfad(Welt w, String standort) {
        return "/api/v1/standorte/" + w.id(standort) + "/netzanschluesse";
    }

    private static Map<String, Object> anschluss(JsonNode n) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", n.path("kennzeichen").asText());
        m.put("name", n.path("name").asText());
        m.put("malo", n.path("malo").asText());
        m.put("netzbetreiber", n.path("netzbetreiber").asText());
        m.put("anschluss_kva", n.path("anschluss_kva").numberValue());
        m.put("vereinbart_kw", n.path("vereinbart_kw").numberValue());
        m.put("messung", n.path("messung").asText());
        return m;
    }

    private static Map<String, Object> anschluss(String kennzeichen, String name) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", kennzeichen);
        m.put("name", name);
        m.put("malo", "47110000001");
        m.put("netzbetreiber", "Netzgesellschaft Ahrental (fiktiv)");
        m.put("anschluss_kva", "630");
        m.put("vereinbart_kw", "550");
        m.put("messung", "RLM");
        return m;
    }

    private static Map<String, Object> binden(UUID anlage, LocalDate ab) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("anlage_id", anlage.toString());
        m.put("gueltig_ab", ab.toString());
        return m;
    }

    private String netzanschlussAm(Welt w, String anlage, String tag) throws Exception {
        Antwort st = ok(ruf(w, HttpMethod.GET, "/api/v1/standorte/" + w.id("ST-1") + "?stichtag=" + tag, null), 200);
        for (JsonNode a : st.body().get("anlagen")) {
            if (a.get("name").asText().equals(anlage)) {
                return a.get("netzanschluss").isNull() ? null : a.at("/netzanschluss/kennzeichen").asText();
            }
        }
        throw new AssertionError("keine Anlage " + anlage + " am " + tag);
    }

    private static long zahl(String tabelle, Welt w) {
        return root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?", Long.class, w.mandant());
    }

    private static List<String> kennzeichen(JsonNode liste) {
        List<String> aus = new ArrayList<>();
        liste.forEach(x -> aus.add(x.get("kennzeichen").asText()));
        return aus;
    }

    private static UUID id(Antwort a) {
        return UUID.fromString(a.body().get("id").asText());
    }

    private static Antwort ok(Antwort a, int status) {
        assertThat(a.status()).as(a.body().toString()).isEqualTo(status);
        return a;
    }

    /** Die Ablehnung: Status und Kundensatz des Codes aus dem geschlossenen Satz; {@code code == null}: 405 ohne Route. */
    private Antwort abgelehnt(Welt w, HttpMethod methode, String pfad, Object body, String code) throws Exception {
        Antwort a = ruf(w, methode, pfad, body);
        if (code == null) {
            assertThat(a.status()).isEqualTo(405);
            return a;
        }
        Ablehnung soll = Arrays.stream(Ablehnung.values()).filter(x -> x.code().equals(code)).findFirst().orElseThrow();
        assertThat(a.body().path("code").asText()).as(a.body().toString()).isEqualTo(code);
        assertThat(a.status()).as(code).isEqualTo(soll.status());
        assertThat(a.body().path("message").asText()).isEqualTo(soll.satz());
        return a;
    }

    private void abgelehntMitFeld(Welt w, HttpMethod methode, String pfad, Object body, String code, String feld)
            throws Exception {
        assertThat(abgelehnt(w, methode, pfad, body, code).body().path("feld").asText()).isEqualTo(feld);
    }

    private Antwort ruf(Welt w, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-jonas-" + w.mandant());
                    j.claim("preferred_username", "Jonas Wendlinger");
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
