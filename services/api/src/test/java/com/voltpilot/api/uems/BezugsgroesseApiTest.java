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
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
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
 * Die Bezugsgrößen-Schnittstelle (UEMS AP-09 IP-5) gegen die echte Kette: {@code POST/GET
 * /api/v1/bezugsgroessen}, {@code GET/PUT/DELETE …/{id}}, {@code POST …/{id}/archivieren} und das
 * Lesemodell {@code GET …/{id}/werte?von&bis&fassungen=}.
 *
 * <p>⚠ Werte schreibt diese Schnittstelle NICHT (Eingabe und Berichtigung sind AP-09 IP-7, der Import
 * IP-13). Die Fassungen der Lesemodell-Tests schreibt der Test deshalb so in die Tabelle, wie der
 * Vertrag sie beschreibt (B4/B5/B14) — geprüft wird, was die Schnittstelle daraus liest.
 *
 * <p>Jede Ablehnung wird mit Code, Status UND dem Kundensatz aus der Vektor-Datei geprüft und mit dem
 * Nachweis, dass die vier Tabellen des Kundenbereichs danach Zeichen für Zeichen dieselben sind. Der
 * Test sammelt die Codes und verlangt am Ende JEDEN Code des Vertrags.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class BezugsgroesseApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2", "bezugsdaten-vectors.json");
    private static final String PFAD = "/api/v1/bezugsgroessen";

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
    private static JsonNode vertrag;
    private static final AtomicInteger NR = new AtomicInteger();
    /** Jeder Code, den der Ablehnungs-Test gesehen hat — am Ende muss es der ganze Satz sein. */
    private static final Set<String> GESEHEN = new LinkedHashSet<>();

    private record Welt(UUID mandant, UUID unternehmen, UUID standort, UUID gebaeude, UUID bereich, UUID messstelle) {}

    private record Antwort(int status, JsonNode body) {}

    @BeforeAll
    static void verbinde() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        vertrag = MAPPER.readTree(VEKTOREN.toFile());
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    // ================================================================ anlegen, Kennzeichen

    @Test
    void anlegenVergibtDasKennzeichenUndSchreibtGenauEinProtokoll() throws Exception {
        Welt w = welt();
        Antwort a = ruf(w, HttpMethod.POST, PFAD, anfrage(null, "Produktionsmenge Spritzguss", "periodenwert", "kg",
                "monat", "standort", w.standort()));
        assertThat(a.status()).isEqualTo(201);
        assertThat(felder(a.body())).containsExactly("id", "kennzeichen", "name", "wertart", "einheit", "periode_art",
                "geltung_art", "geltung_id", "geltung_name", "hat_werte", "archiviert_am", "angelegt_am");
        assertThat(a.body().get("kennzeichen").asText()).isEqualTo("BZ-0001");
        assertThat(a.body().get("geltung_name").asText()).isEqualTo("Werk Ahrenberg");
        assertThat(a.body().get("hat_werte").asBoolean()).isFalse();
        assertThat(a.body().get("archiviert_am").isNull()).isTrue();
        UUID id = UUID.fromString(a.body().get("id").asText());
        assertThat(root.queryForList("SELECT art || ':' || actor_name || ':' || actor_rolle || ':' || (neu->>'kennzeichen') "
                + "FROM bezugsgroesse_aenderung WHERE bezugsgroesse_id = ?", String.class, id))
                .containsExactly("angelegt:Ines Kaltenbach:kundenadministrator:BZ-0001");

        // Jede Geltungsbereich-Art, deren Objekt gebaut ist.
        assertThat(ruf(w, HttpMethod.POST, PFAD, anfrage(null, "Gutteile", "periodenwert", "Stück", "monat",
                "unternehmen", w.unternehmen())).body().get("kennzeichen").asText()).isEqualTo("BZ-0002");
        assertThat(ruf(w, HttpMethod.POST, PFAD, anfrage("BZ-5", "Ladezeit Ladepunkt Halle 2", "periodenwert", "h", "tag",
                "messstelle", w.messstelle())).body().get("geltung_name").asText()).isEqualTo("Ladepunkt Halle 2");
        // M2: die Nummer folgt der höchsten je belegten — BZ-5 zählt wie BZ-0005.
        assertThat(ruf(w, HttpMethod.POST, PFAD, anfrage(null, "Betriebsstunden Halle 2", "periodenwert", "h", "woche",
                "gebaeude", w.gebaeude())).body().get("kennzeichen").asText()).isEqualTo("BZ-0006");
        assertThat(ruf(w, HttpMethod.POST, PFAD, anfrage(null, "Mitarbeitende Nord", "stammdatum", "Personen", null,
                "bereich", w.bereich())).status()).isEqualTo(201);

        Antwort liste = ruf(w, HttpMethod.GET, PFAD, null);
        assertThat(liste.body().get("bezugsgroessen").findValuesAsText("kennzeichen"))
                .containsExactly("BZ-0001", "BZ-0002", "BZ-0006", "BZ-0007", "BZ-5");
        assertThat(ruf(w, HttpMethod.GET, PFAD + "/" + id, null).body().get("name").asText())
                .isEqualTo("Produktionsmenge Spritzguss");
    }

    /** M2: eindeutig je Kundenbereich, nie weitergegeben — auch nicht das frühere oder das einer gelöschten. */
    @Test
    void einKennzeichenWirdNieWeitergegeben() throws Exception {
        Welt w = welt();
        UUID erste = anlegen(w, "BZ-0010");
        abgelehnt(w, HttpMethod.POST, PFAD, anfrage("BZ-0010", "Zweite", "periodenwert", "kg", "monat", "standort",
                w.standort()), "kennzeichen_belegt");

        Antwort umbenannt = ruf(w, HttpMethod.PUT, PFAD + "/" + erste, anfrage("BZ-0011", "Erste", "periodenwert", "kg",
                "monat", "standort", w.standort()));
        assertThat(umbenannt.status()).isEqualTo(200);
        abgelehnt(w, HttpMethod.POST, PFAD, anfrage("BZ-0010", "Zweite", "periodenwert", "kg", "monat", "standort",
                w.standort()), "kennzeichen_belegt");
        // Die eigene darf zu ihrem früheren zurück.
        assertThat(ruf(w, HttpMethod.PUT, PFAD + "/" + erste, anfrage("BZ-0010", "Erste", "periodenwert", "kg", "monat",
                "standort", w.standort())).status()).isEqualTo(200);

        UUID andere = anlegen(w, "BZ-0020");
        abgelehnt(w, HttpMethod.PUT, PFAD + "/" + andere, anfrage("BZ-0011", "Andere", "periodenwert", "kg", "monat",
                "standort", w.standort()), "kennzeichen_belegt");

        // Gelöscht: die Kennzeichen bleiben belegt, die Vergabe folgt der höchsten je belegten Nummer.
        assertThat(ruf(w, HttpMethod.DELETE, PFAD + "/" + andere, null).status()).isEqualTo(204);
        abgelehnt(w, HttpMethod.POST, PFAD, anfrage("BZ-0020", "Nachfolger", "periodenwert", "kg", "monat", "standort",
                w.standort()), "kennzeichen_belegt");
        assertThat(ruf(w, HttpMethod.POST, PFAD, anfrage(null, "Nachfolger", "periodenwert", "kg", "monat", "standort",
                w.standort())).body().get("kennzeichen").asText()).isEqualTo("BZ-0021");

        // Ein anderer Kundenbereich trägt dasselbe Kennzeichen; die Ablehnung oben verrät nichts über ihn.
        Welt fremd = welt();
        assertThat(ruf(fremd, HttpMethod.POST, PFAD, anfrage("BZ-0010", "Fremd", "periodenwert", "kg", "monat",
                "standort", fremd.standort())).status()).isEqualTo(201);
    }

    // ================================================================ Ablehnungen

    /** Jede Ablehnung der Form und der Regeln: Code, Status, Kundensatz — und nichts ist geschrieben. */
    @Test
    void jedeAblehnungSprichtIhrenKundensatzUndSchreibtNichts() throws Exception {
        GESEHEN.clear();
        Welt w = welt();
        UUID bg = anlegen(w, "BZ-0001");
        String gut = PFAD;
        abgelehntMitFeld(w, HttpMethod.POST, gut, anfrage("BZ-0001", "Zweite", "periodenwert", "kg", "monat", "standort",
                w.standort()), "kennzeichen_belegt", "kennzeichen");

        // 400 Form
        abgelehntMitFeld(w, HttpMethod.POST, gut, mit(anfrage(null, "X", "periodenwert", "kg", "monat", "standort",
                w.standort()), "periodeArt", "monat"), "anfrage_ungueltig", "periodeArt");
        abgelehntMitFeld(w, HttpMethod.POST, gut, mit(anfrage(null, "X", "periodenwert", "kg", "monat", "standort",
                w.standort()), "art", "Produktionsmenge"), "anfrage_ungueltig", "art");
        abgelehntMitFeld(w, HttpMethod.POST, gut, anfrage(null, "  ", "periodenwert", "kg", "monat", "standort",
                w.standort()), "anfrage_ungueltig", "name");
        abgelehntMitFeld(w, HttpMethod.POST, gut, mit(anfrage(null, "X", "periodenwert", "kg", "monat", "standort",
                w.standort()), "name", 42), "anfrage_ungueltig", "name");
        abgelehntMitFeld(w, HttpMethod.POST, gut, anfrage(null, "X", "periodenwert", "kg", "monat", "standort", "ST-1"),
                "anfrage_ungueltig", "geltung_id");
        abgelehnt(w, HttpMethod.POST, gut, List.of("keine", "Anfrage"), "anfrage_ungueltig");
        abgelehntMitFeld(w, HttpMethod.PUT, gut + "/" + bg, anfrage(null, "Ohne Kennzeichen", "periodenwert", "kg",
                "monat", "standort", w.standort()), "anfrage_ungueltig", "kennzeichen");
        Antwort wort = abgelehnt(w, HttpMethod.POST, gut, anfrage(null, "X", "menge", "kg", "monat", "standort",
                w.standort()), "wort_unbekannt");
        assertThat(wort.body().get("feld").asText()).isEqualTo("wertart");
        assertThat(MAPPER.convertValue(wort.body().get("erlaubt"), List.class))
                .containsExactly("periodenwert", "stand", "stammdatum");
        abgelehnt(w, HttpMethod.POST, gut, anfrage(null, "Paletten", "periodenwert", "Paletten", "monat", "standort",
                w.standort()), "einheit_unbekannt");
        abgelehnt(w, HttpMethod.POST, gut, anfrage("bz-2", "X", "periodenwert", "kg", "monat", "standort", w.standort()),
                "kennzeichen_format");
        abgelehnt(w, HttpMethod.GET, gut + "/" + bg + "/werte?von=2025-11-01&bis=2025-10-31", null, "zeitraum_ungueltig");
        abgelehntMitFeld(w, HttpMethod.GET, gut + "/" + bg + "/werte?fassungen=letzte", null, "wort_unbekannt", "fassungen");
        abgelehntMitFeld(w, HttpMethod.GET, gut + "/" + bg + "/werte?von=31.10.2025", null, "anfrage_ungueltig", "von");

        // 422 Regel
        abgelehnt(w, HttpMethod.POST, gut, anfrage(null, "Gaszähler", "stand", "m³", "monat", "messstelle",
                w.messstelle()), "periode_passt_nicht_zur_wertart");
        abgelehnt(w, HttpMethod.POST, gut, anfrage(null, "Menge ohne Periode", "periodenwert", "kg", null, "standort",
                w.standort()), "periode_passt_nicht_zur_wertart");
        abgelehnt(w, HttpMethod.POST, gut, anfrage(null, "Fläche Halle 2", "stammdatum", "m²", null, "gebaeude",
                w.gebaeude()), "flaeche_aus_struktur");
        // Seit AP-10 IP-7 ist der Prozess wählbar — ein unbekannter ist so unbekannt wie jedes andere Objekt.
        abgelehnt(w, HttpMethod.POST, gut, anfrage(null, "Gutteile Montage", "periodenwert", "Stück", "monat", "prozess",
                UUID.randomUUID()), "geltung_unbekannt");
        abgelehnt(w, HttpMethod.POST, gut, anfrage(null, "Gutteile Montage", "periodenwert", "Stück", "monat",
                "kostenstelle", UUID.randomUUID()), "geltung_unbekannt");
        abgelehnt(w, HttpMethod.POST, gut, anfrage(null, "X", "periodenwert", "kg", "monat", "standort",
                UUID.randomUUID()), "geltung_unbekannt");
        // Ein Bereich ist kein Gebäude — und ein fremdes Objekt ist so unbekannt wie keins.
        abgelehnt(w, HttpMethod.POST, gut, anfrage(null, "X", "periodenwert", "kg", "monat", "gebaeude", w.bereich()),
                "geltung_unbekannt");
        Welt fremd = welt();
        abgelehnt(w, HttpMethod.POST, gut, anfrage(null, "X", "periodenwert", "kg", "monat", "standort",
                fremd.standort()), "geltung_unbekannt");

        // M1: nach dem ersten Wert bleibt die Bedeutung fest — Name und Kennzeichen nicht.
        erstwert(w, bg, 1, "erstwert", "wirksam", "4820", null);
        Antwort fest = abgelehnt(w, HttpMethod.PUT, gut + "/" + bg, anfrage("BZ-0001", "Produktionsmenge", "periodenwert",
                "t", "monat", "unternehmen", w.unternehmen()), "bedeutung_fest");
        assertThat(MAPPER.convertValue(fest.body().get("felder"), List.class))
                .containsExactly("einheit", "geltung_art", "geltung_id");
        assertThat(ruf(w, HttpMethod.PUT, gut + "/" + bg, anfrage("BZ-0001", "Produktionsmenge Spritzguss Linie 1",
                "periodenwert", "kg", "monat", "standort", w.standort())).status()).isEqualTo(200);

        // M6
        Antwort werte = abgelehnt(w, HttpMethod.DELETE, gut + "/" + bg, null, "hat_werte");
        assertThat(werte.body().get("werte").asInt()).isEqualTo(1);
        assertThat(ruf(w, HttpMethod.POST, gut + "/" + bg + "/archivieren", null).status()).isEqualTo(200);
        abgelehnt(w, HttpMethod.POST, gut + "/" + bg + "/archivieren", null, "archiviert");
        abgelehnt(w, HttpMethod.PUT, gut + "/" + bg, anfrage("BZ-0001", "Neuer Name", "periodenwert", "kg", "monat",
                "standort", w.standort()), "archiviert");

        // 404: nicht da, fremd, keine ID — nie 403.
        for (Welt wer : List.of(w, fremd)) {
            UUID id = wer == w ? UUID.randomUUID() : bg;
            abgelehnt(wer, HttpMethod.GET, gut + "/" + id, null, "nicht_gefunden");
            abgelehnt(wer, HttpMethod.GET, gut + "/" + id + "/werte", null, "nicht_gefunden");
            abgelehnt(wer, HttpMethod.PUT, gut + "/" + id, anfrage("BZ-0009", "X", "periodenwert", "kg", "monat",
                    "standort", wer.standort()), "nicht_gefunden");
            abgelehnt(wer, HttpMethod.POST, gut + "/" + id + "/archivieren", null, "nicht_gefunden");
            abgelehnt(wer, HttpMethod.DELETE, gut + "/" + id, null, "nicht_gefunden");
        }
        abgelehnt(w, HttpMethod.GET, gut + "/keine-id", null, "nicht_gefunden");
        assertThat(ruf(fremd, HttpMethod.GET, gut, null).body().get("bezugsgroessen")).isEmpty();

        // Der geschlossene Satz ist ganz geprüft: jeder Code des Vertrags kam hier als Antwort — bis auf
        // `geltung_nicht_waehlbar`: seit AP-10 IP-7 ist jede Geltungsbereich-Art des Vokabulars wählbar,
        // die Schnittstelle KANN ihn nicht antworten. Die Regel prüfen weiter die Vektoren (Eingang
        // `waehlbar`, BezugsdatenVectorsTest); hier steht, dass die Lücke genau diese Ursache hat.
        List<String> vertragsCodes = new ArrayList<>(vertrag.path("verwalten").path("ablehnungen").findValuesAsText("code"));
        assertThat(BezugsgroesseRegeln.GELTUNG_WAEHLBAR).as("alle Arten wählbar")
                .containsExactlyInAnyOrderElementsOf(texte(vertrag.path("vokabulare").path("geltung_art")));
        assertThat(vertragsCodes.remove("geltung_nicht_waehlbar")).isTrue();
        assertThat(GESEHEN).containsExactlyInAnyOrderElementsOf(vertragsCodes);
    }

    // ================================================================ ändern, archivieren, löschen

    @Test
    void vorDemErstenWertIstAllesAenderbarUndDasProtokollNenntNurDieAenderung() throws Exception {
        Welt w = welt();
        UUID bg = anlegen(w, "BZ-0001");
        Antwort a = ruf(w, HttpMethod.PUT, PFAD + "/" + bg, anfrage("BZ-0001", "Produktionsmenge", "periodenwert", "t",
                "woche", "gebaeude", w.gebaeude()));
        assertThat(a.status()).isEqualTo(200);
        assertThat(a.body().get("geltung_name").asText()).isEqualTo("Halle 2");
        assertThat(root.queryForObject("SELECT alt::text || ' -> ' || neu::text FROM bezugsgroesse_aenderung "
                + "WHERE bezugsgroesse_id = ? AND art = 'bearbeitet'", String.class, bg))
                .isEqualTo("{\"name\": \"Produktionsmenge Spritzguss\", \"einheit\": \"kg\", \"geltung_id\": \"" + w.standort()
                        + "\", \"geltung_art\": \"standort\", \"periode_art\": \"monat\"} -> {\"name\": \"Produktionsmenge\", "
                        + "\"einheit\": \"t\", \"geltung_id\": \"" + w.gebaeude()
                        + "\", \"geltung_art\": \"gebaeude\", \"periode_art\": \"woche\"}");
        // Unverändert: kein Eintrag.
        ruf(w, HttpMethod.PUT, PFAD + "/" + bg, anfrage("BZ-0001", "Produktionsmenge", "periodenwert", "t", "woche",
                "gebaeude", w.gebaeude().toString().toUpperCase()));
        assertThat(protokoll(bg)).containsExactly("angelegt", "bearbeitet");
    }

    @Test
    void archivierenLaesstLesenUndLoeschenGehtNurOhneWert() throws Exception {
        Welt w = welt();
        UUID bg = anlegen(w, "BZ-0001");
        Antwort archiviert = ruf(w, HttpMethod.POST, PFAD + "/" + bg + "/archivieren", null);
        assertThat(archiviert.status()).isEqualTo(200);
        assertThat(archiviert.body().get("archiviert_am").isNull()).isFalse();
        assertThat(ruf(w, HttpMethod.GET, PFAD, null).body().get("bezugsgroessen")).hasSize(1);

        assertThat(ruf(w, HttpMethod.DELETE, PFAD + "/" + bg, null).status()).isEqualTo(204);
        assertThat(ruf(w, HttpMethod.GET, PFAD + "/" + bg, null).status()).isEqualTo(404);
        assertThat(protokoll(bg)).containsExactly("angelegt", "archiviert", "geloescht");
        assertThat(root.queryForObject("SELECT alt->>'kennzeichen' FROM bezugsgroesse_aenderung WHERE bezugsgroesse_id = ? "
                + "AND art = 'geloescht'", String.class, bg)).isEqualTo("BZ-0001");
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsgroesse_kennzeichen_verlauf WHERE tenant_id = ? "
                + "AND kennzeichen = 'BZ-0001' AND bezugsgroesse_id IS NULL", Long.class, w.mandant())).isOne();
    }

    // ================================================================ Lesemodell

    /** B5: eine Berichtigung ist Fassung 2 — Fassung 1 bleibt mit Betrag, Urheber und Herkunft lesbar. */
    @Test
    void eineBerichtigungIstFassungZweiUndDieErsteBleibtLesbar() throws Exception {
        Welt w = welt();
        UUID bg = anlegen(w, "BZ-2");
        erstwert(w, bg, 1, "erstwert", "wirksam", "4820", null);
        erstwert(w, bg, 2, "berichtigung", "wirksam", "48200", "Tippfehler — eine Null fehlte (Montagebericht Oktober)");

        Antwort alle = ruf(w, HttpMethod.GET, PFAD + "/" + bg + "/werte?fassungen=alle", null);
        assertThat(alle.status()).isEqualTo(200);
        assertThat(felder(alle.body())).containsExactly("bezugsgroesse_id", "kennzeichen", "wertart", "einheit",
                "periode_art", "von", "bis", "fassungen", "werte");
        JsonNode wert = alle.body().at("/werte/0");
        assertThat(alle.body().get("werte")).hasSize(1);
        assertThat(felder(wert)).containsExactly("periode_von", "periode_bis", "zeitpunkt", "zeitzone",
                "wirksamer_betrag", "wirksame_fassung", "stand_offen", "fassungen");
        assertThat(wert.get("periode_von").asText()).isEqualTo("2025-10-01");
        assertThat(wert.get("periode_bis").asText()).isEqualTo("2025-10-31");
        assertThat(wert.get("wirksamer_betrag").asText()).isEqualTo("48200");
        assertThat(wert.get("wirksame_fassung").asInt()).isEqualTo(2);
        assertThat(wert.get("stand_offen").asBoolean()).isFalse();
        JsonNode f1 = wert.at("/fassungen/0");
        assertThat(felder(f1)).containsExactly("fassung", "vorgang", "status", "stand", "betrag", "ersetzt_fassung",
                "begruendung", "kennzeichen", "herkunft", "urheber", "freigeber", "eingetragen_am");
        assertThat(f1.get("stand").asText()).isEqualTo("wirksam bis Fassung 2");
        assertThat(f1.get("status").asText()).isEqualTo("wirksam");
        assertThat(f1.get("betrag").asText()).isEqualTo("4820");
        assertThat(f1.at("/herkunft/art").asText()).isEqualTo("eingabe");
        assertThat(f1.at("/herkunft/von_hand").asBoolean()).isTrue();
        assertThat(f1.at("/urheber/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(f1.get("eingetragen_am").asText()).isNotBlank();
        JsonNode f2 = wert.at("/fassungen/1");
        assertThat(f2.get("stand").asText()).isEqualTo("wirksam");
        assertThat(f2.get("ersetzt_fassung").asInt()).isEqualTo(1);
        assertThat(f2.get("begruendung").asText()).startsWith("Tippfehler");

        // Ohne `fassungen`: nur die wirksame Fassung — mit ihrer Herkunft.
        Antwort wirksam = ruf(w, HttpMethod.GET, PFAD + "/" + bg + "/werte", null);
        assertThat(wirksam.body().get("fassungen").asText()).isEqualTo("wirksam");
        assertThat(wirksam.body().at("/werte/0/fassungen")).hasSize(1);
        assertThat(wirksam.body().at("/werte/0/fassungen/0/fassung").asInt()).isEqualTo(2);
        assertThat(wirksam.body().at("/werte/0/fassungen/0/herkunft/art").asText()).isEqualTo("eingabe");
        assertThat(ruf(w, HttpMethod.GET, PFAD + "/" + bg, null).body().get("hat_werte").asBoolean()).isTrue();
    }

    /** B14: eine Rücknahme ist eine Fassung ohne Betrag — nichts wird gelöscht, nie 0, und ein neuer Erstwert folgt. */
    @Test
    void eineRuecknahmeLoeschtNichts() throws Exception {
        Welt w = welt();
        UUID bg = anlegen(w, "BZ-1");
        importwert(w, bg, 1, "erstwert", "wirksam", "312400", null);
        importwert(w, bg, 2, "ruecknahme", "zurueckgenommen", null, "Import I-2026-0001 zurückgenommen");

        JsonNode wert = ruf(w, HttpMethod.GET, PFAD + "/" + bg + "/werte?fassungen=alle", null).body().at("/werte/0");
        assertThat(wert.get("wirksamer_betrag").isNull()).as("keine Werte — nie 0").isTrue();
        assertThat(wert.get("wirksame_fassung").asInt()).isEqualTo(2);
        assertThat(wert.get("fassungen").findValuesAsText("stand")).containsExactly("wirksam bis Fassung 2", "zurueckgenommen");
        assertThat(wert.at("/fassungen/0/betrag").asText()).isEqualTo("312400");
        assertThat(wert.at("/fassungen/1/betrag").isNull()).isTrue();
        JsonNode herkunft = wert.at("/fassungen/0/herkunft");
        assertThat(herkunft.get("art").asText()).isEqualTo("import");
        assertThat(herkunft.get("von_hand").asBoolean()).isFalse();
        assertThat(herkunft.get("import_kennung").asText()).isEqualTo("I-2026-0001");
        assertThat(herkunft.get("import_zeile").asInt()).isEqualTo(2);
        assertThat(herkunft.get("geliefert_text").asText()).isEqualTo("312.400,0");
        assertThat(herkunft.get("geliefert_einheit").asText()).isEqualTo("kg");

        abgelehnt(w, HttpMethod.DELETE, PFAD + "/" + bg, null, "hat_werte");
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsgroesse_wert WHERE bezugsgroesse_id = ?", Long.class, bg))
                .isEqualTo(2);

        importwert(w, bg, 3, "erstwert", "wirksam", "312400", null);
        JsonNode danach = ruf(w, HttpMethod.GET, PFAD + "/" + bg + "/werte", null).body().at("/werte/0");
        assertThat(danach.get("wirksamer_betrag").asText()).isEqualTo("312400");
        assertThat(danach.get("wirksame_fassung").asInt()).isEqualTo(3);
    }

    /** `von`/`bis` sind Tage mit dem letzten EINSCHLIESSLICH; ein Stand zählt nach seinem Tag in SEINER Zone. */
    @Test
    void dasLesemodellSchneidetTageUndLiestStaendeInIhrerZone() throws Exception {
        Welt w = welt();
        UUID bg = anlegen(w, "BZ-0001");
        erstwert(w, bg, 1, "erstwert", "wirksam", "300000", null, LocalDate.of(2025, 9, 1), LocalDate.of(2025, 9, 30));
        erstwert(w, bg, 1, "erstwert", "wirksam", "312400", null);
        String werte = PFAD + "/" + bg + "/werte";
        assertThat(perioden(ruf(w, HttpMethod.GET, werte, null))).containsExactly("2025-09-01", "2025-10-01");
        assertThat(perioden(ruf(w, HttpMethod.GET, werte + "?von=2025-10-31&bis=2025-10-31", null)))
                .containsExactly("2025-10-01");
        assertThat(perioden(ruf(w, HttpMethod.GET, werte + "?bis=2025-09-30", null))).containsExactly("2025-09-01");
        assertThat(perioden(ruf(w, HttpMethod.GET, werte + "?von=2025-11-01", null))).isEmpty();

        Antwort stand = ruf(w, HttpMethod.POST, PFAD, anfrage(null, "Gaszähler Ablesung", "stand", "m³", null,
                "messstelle", w.messstelle()));
        UUID st = UUID.fromString(stand.body().get("id").asText());
        standwert(w, st, OffsetDateTime.parse("2025-10-01T07:15:00+02:00"), "48211");
        // 01.11. 00:30 in Berlin ist in UTC noch der 31.10. — gezählt wird der Tag des Standorts.
        standwert(w, st, OffsetDateTime.parse("2025-11-01T00:30:00+01:00"), "49451");
        JsonNode oktober = ruf(w, HttpMethod.GET, PFAD + "/" + st + "/werte?von=2025-10-01&bis=2025-10-31", null).body();
        assertThat(oktober.get("werte")).hasSize(1);
        assertThat(oktober.at("/werte/0/zeitpunkt").asText()).isEqualTo("2025-10-01T07:15:00+02:00");
        assertThat(oktober.at("/werte/0/periode_von").isNull()).isTrue();
        assertThat(oktober.at("/werte/0/wirksamer_betrag").asText()).isEqualTo("48211");
        assertThat(ruf(w, HttpMethod.GET, PFAD + "/" + st + "/werte?von=2025-11-01", null).body().at("/werte/0/zeitpunkt")
                .asText()).isEqualTo("2025-11-01T00:30:00+01:00");
    }

    /**
     * Befund 5 aus IP-4 bleibt IP-7: trägt eine Kette einen Vorschlag, ist ihr Stand OFFEN — das Lesemodell zeigt
     * die gespeicherten Fassungen und rechnet keinen wirksamen Betrag, statt die Auflösung vorwegzunehmen.
     */
    @Test
    void eineKetteMitVorschlagBleibtOffen() throws Exception {
        Welt w = welt();
        UUID bg = anlegen(w, "BZ-2");
        erstwert(w, bg, 1, "erstwert", "wirksam", "4820", null);
        erstwert(w, bg, 2, "berichtigung", "vorschlag", "48200", "Tippfehler — eine Null fehlte (Montagebericht Oktober)");
        JsonNode wert = ruf(w, HttpMethod.GET, PFAD + "/" + bg + "/werte", null).body().at("/werte/0");
        assertThat(wert.get("stand_offen").asBoolean()).isTrue();
        assertThat(wert.get("wirksamer_betrag").isNull()).isTrue();
        assertThat(wert.get("fassungen").findValuesAsText("status")).containsExactly("wirksam", "vorschlag");
        assertThat(wert.at("/fassungen/0/stand").isNull()).isTrue();
    }

    // ================================================================ Bestandsschutz

    /**
     * Die Schreibwege berühren nur die vier Bezugsgrößen-Tabellen: ein ganzer Durchlauf (anlegen, ändern,
     * archivieren, löschen, Ablehnungen) lässt jede andere Tabelle der Datenbank Zeichen für Zeichen stehen.
     */
    @Test
    void dieSchreibwegeLassenDenBestandZeichengleich() throws Exception {
        Welt w = welt();
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of("bezugsgroesse%"));
        UUID bg = anlegen(w, null);
        ruf(w, HttpMethod.PUT, PFAD + "/" + bg, anfrage("BZ-0100", "Umbenannt", "periodenwert", "kg", "monat", "standort",
                w.standort()));
        ruf(w, HttpMethod.POST, PFAD + "/" + bg + "/archivieren", null);
        ruf(w, HttpMethod.POST, PFAD, anfrage(null, "X", "periodenwert", "kg", "monat", "prozess", UUID.randomUUID()));
        ruf(w, HttpMethod.DELETE, PFAD + "/" + bg, null);
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of("bezugsgroesse%"))))
                .isEmpty();
    }

    /**
     * Die wartende Stelle aus IP-5 ist eingelöst (AP-10 IP-7): BZ-2 „Gutteile Montage“ hängt am Prozess
     * P-2, und eine Bezugsgröße kann an einer Kostenstelle hängen — mit Namen im Lesemodell.
     */
    @Test
    void prozessUndKostenstelleSindAlsGeltungsbereichWaehlbar() throws Exception {
        Welt w = welt();
        UUID p2 = root.queryForObject("INSERT INTO prozess (tenant_id, unternehmen_id, kennzeichen, name, gueltig_ab) "
                + "VALUES (?, ?, 'P-2', 'Montage', DATE '2026-10-01') RETURNING id", UUID.class, w.mandant(), w.unternehmen());
        UUID k4200 = root.queryForObject("INSERT INTO kostenstelle (tenant_id, unternehmen_id, kennzeichen, name, "
                + "gueltig_ab) VALUES (?, ?, '4200', 'Montage', DATE '2026-10-01') RETURNING id", UUID.class, w.mandant(),
                w.unternehmen());
        Antwort a = ruf(w, HttpMethod.POST, PFAD, anfrage("BZ-2", "Gutteile Montage", "periodenwert", "Stück", "monat",
                "prozess", p2));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(201);
        assertThat(a.body().get("geltung_art").asText()).isEqualTo("prozess");
        assertThat(a.body().get("geltung_id").asText()).isEqualTo(p2.toString());
        assertThat(a.body().get("geltung_name").asText()).isEqualTo("Montage");
        Antwort b = ruf(w, HttpMethod.PUT, PFAD + "/" + a.body().get("id").asText(), anfrage("BZ-2", "Gutteile Montage",
                "periodenwert", "Stück", "monat", "kostenstelle", k4200));
        assertThat(b.status()).as(b.body().toString()).isEqualTo(200);
        assertThat(b.body().get("geltung_art").asText()).isEqualTo("kostenstelle");
        assertThat(root.queryForObject("SELECT prozess_id IS NULL AND kostenstelle_id = ? FROM bezugsgroesse WHERE id = ?",
                Boolean.class, k4200, UUID.fromString(a.body().get("id").asText()))).isTrue();
        // Ein Prozess eines anderen Kundenbereichs ist unbekannt, nie 403.
        Welt fremd = welt();
        abgelehnt(fremd, HttpMethod.POST, PFAD, anfrage(null, "X", "periodenwert", "kg", "monat", "prozess", p2),
                "geltung_unbekannt");
    }

    // ================================================================ Gerüst

    private static List<String> texte(JsonNode liste) {
        List<String> aus = new ArrayList<>();
        liste.forEach(x -> aus.add(x.asText()));
        return aus;
    }

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Bezugsgrößen #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID st = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        UUID g = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) "
                + "VALUES (?, 'gebaeude', 'Halle 2', 'G-2', 'aktiv') RETURNING id", UUID.class, t);
        UUID be = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) "
                + "VALUES (?, 'bereich', 'Halle 1 Nord', 'B-1', 'aktiv') RETURNING id", UUID.class, t);
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-14', 'Ladepunkt Halle 2', 'gemessen', 'Strom', "
                + "'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, t);
        return new Welt(t, u, st, g, be, ms);
    }

    private UUID anlegen(Welt w, String kennzeichen) throws Exception {
        Antwort a = ruf(w, HttpMethod.POST, PFAD, anfrage(kennzeichen, "Produktionsmenge Spritzguss", "periodenwert",
                "kg", "monat", "standort", w.standort()));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(201);
        return UUID.fromString(a.body().get("id").asText());
    }

    private static Map<String, Object> anfrage(String kennzeichen, String name, String wertart, String einheit,
            String periodeArt, String geltungArt, Object geltungId) {
        Map<String, Object> m = new LinkedHashMap<>();
        if (kennzeichen != null) {
            m.put("kennzeichen", kennzeichen);
        }
        m.put("name", name);
        m.put("wertart", wertart);
        m.put("einheit", einheit);
        m.put("periode_art", periodeArt);
        m.put("geltung_art", geltungArt);
        m.put("geltung_id", geltungId == null ? null : geltungId.toString());
        return m;
    }

    private static Map<String, Object> mit(Map<String, Object> basis, String feld, Object wert) {
        Map<String, Object> m = new LinkedHashMap<>(basis);
        m.put(feld, wert);
        return m;
    }

    /** Eine eingegebene Fassung Oktober 2025 (so, wie IP-7 sie schreiben wird). */
    private static void erstwert(Welt w, UUID bg, int fassung, String vorgang, String status, String betrag,
            String begruendung) {
        erstwert(w, bg, fassung, vorgang, status, betrag, begruendung, LocalDate.of(2025, 10, 1), LocalDate.of(2025, 10, 31));
    }

    private static void erstwert(Welt w, UUID bg, int fassung, String vorgang, String status, String betrag,
            String begruendung, LocalDate von, LocalDate bis) {
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                + "periode_von, periode_bis, zeitzone, fassung, ersetzt_fassung, vorgang, status, betrag, begruendung, "
                + "herkunft_art, actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, 'periodenwert', 'kg', 'monat', "
                + "?, ?, 'Europe/Berlin', ?, ?, ?, ?, ?, ?, 'eingabe', 'sub-ik', 'Ines Kaltenbach', 'energiemanager', 'kunde')",
                w.mandant(), bg, von, bis, fassung, fassung == 1 ? null : fassung - 1, vorgang, status,
                betrag == null ? null : new BigDecimal(betrag), begruendung);
    }

    /** Eine importierte Fassung Oktober 2025 aus I-2026-0001, Zeile 2 (B1/B14). */
    private static void importwert(Welt w, UUID bg, int fassung, String vorgang, String status, String betrag,
            String begruendung) {
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                + "periode_von, periode_bis, zeitzone, fassung, ersetzt_fassung, vorgang, status, betrag, begruendung, "
                + "herkunft_art, import_kennung, import_zeile, geliefert_text, geliefert_einheit, actor_sub, actor_name, "
                + "actor_rolle, actor_art) VALUES (?, ?, 'periodenwert', 'kg', 'monat', '2025-10-01', '2025-10-31', "
                + "'Europe/Berlin', ?, ?, ?, ?, ?, ?, 'import', 'I-2026-0001', 2, '312.400,0', 'kg', 'sub-ik', "
                + "'Ines Kaltenbach', 'energiemanager', 'kunde')",
                w.mandant(), bg, fassung, fassung == 1 ? null : fassung - 1, vorgang, status,
                betrag == null ? null : new BigDecimal(betrag), begruendung);
    }

    private static void standwert(Welt w, UUID bg, OffsetDateTime zeitpunkt, String betrag) {
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, zeitpunkt, zeitzone, "
                + "fassung, vorgang, status, betrag, herkunft_art, actor_sub, actor_name, actor_rolle, actor_art) "
                + "VALUES (?, ?, 'stand', 'm³', ?, 'Europe/Berlin', 1, 'erstwert', 'wirksam', ?, 'eingabe', 'sub-ik', "
                + "'Ines Kaltenbach', 'energiemanager', 'kunde')", w.mandant(), bg, zeitpunkt, new BigDecimal(betrag));
    }

    private static List<String> protokoll(UUID bg) {
        return root.queryForList("SELECT art FROM bezugsgroesse_aenderung WHERE bezugsgroesse_id = ? ORDER BY id",
                String.class, bg);
    }

    private static List<String> perioden(Antwort a) {
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        return a.body().get("werte").findValuesAsText("periode_von");
    }

    /** Die vier Tabellen des Kundenbereichs als Text — vor und nach einer Ablehnung derselbe. */
    private static String zustand(Welt w) {
        StringBuilder s = new StringBuilder();
        for (String tabelle : List.of("bezugsgroesse", "bezugsgroesse_kennzeichen_verlauf", "bezugsgroesse_wert",
                "bezugsgroesse_aenderung")) {
            s.append(tabelle).append('=').append(root.queryForObject("SELECT coalesce(string_agg(to_jsonb(t)::text, '|' "
                    + "ORDER BY to_jsonb(t)::text), '') FROM " + tabelle + " t WHERE tenant_id = ?", String.class, w.mandant()))
                    .append('\n');
        }
        return s.toString();
    }

    private Antwort abgelehnt(Welt w, HttpMethod methode, String pfad, Object body, String code) throws Exception {
        String vorher = zustand(w);
        Antwort a = ruf(w, methode, pfad, body);
        JsonNode soll = null;
        for (JsonNode x : vertrag.path("verwalten").path("ablehnungen")) {
            if (x.path("code").asText().equals(code)) {
                soll = x;
            }
        }
        assertThat(soll).as("Code " + code + " steht im Vertrag").isNotNull();
        assertThat(a.body().path("code").asText()).as(methode + " " + pfad + " → " + a.body()).isEqualTo(code);
        assertThat(a.status()).as(code).isEqualTo(soll.path("status").asInt());
        assertThat(a.body().path("message").asText()).as("Kundensatz " + code).isEqualTo(soll.path("satz").asText());
        assertThat(zustand(w)).as("die Ablehnung " + code + " schreibt nichts").isEqualTo(vorher);
        GESEHEN.add(code);
        return a;
    }

    private void abgelehntMitFeld(Welt w, HttpMethod methode, String pfad, Object body, String code, String feld)
            throws Exception {
        assertThat(abgelehnt(w, methode, pfad, body, code).body().path("feld").asText()).as(code).isEqualTo(feld);
    }

    private static List<String> felder(JsonNode n) {
        List<String> aus = new ArrayList<>();
        n.fieldNames().forEachRemaining(aus::add);
        return aus;
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
