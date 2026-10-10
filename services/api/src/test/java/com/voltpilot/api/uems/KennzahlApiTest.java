package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doReturn;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
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
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
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
 * Die Kennzahl-Schnittstelle (UEMS AP-11 IP-5) gegen die echte Kette — der Prüfnachweis des Reports §8:
 * K13 (422 {@code periode_passt_nicht}), K16 (Kette), K17 (Fassung 2, Überlappung), K18 (403 und 404 genau wie im
 * Fall), U2 (die Einheiten-Regel), die Vorschau, die nichts schreibt, und der geschlossene Satz der Ablehnungen.
 *
 * <p>Jede Ablehnung wird mit Code, Status UND Satz geprüft — der Satz der Schnittstelle aus der Vektor-Datei, der der
 * Regel wörtlich aus dem Vertrag, der eines 403/404 aus {@link RechteAbleitung#TEXTE} — und mit dem Nachweis, dass
 * die Kennzahl-Tabellen des Kundenbereichs danach Zeichen für Zeichen dieselben sind.
 *
 * <p>Die Personen von K18 setzt der Test über die Naht {@link KennzahlAufrufer} ein (Peter: Bearbeiter in Werk
 * Lindach; Murat: Bedienberechtigt in Werk Ahrenberg) — bis AP-03 IP-2 Zuweisungen bringt, ist jeder Kundenbenutzer
 * Kundenadministrator. Die Standorte der Rechte-Ableitung sind die Standort-IDs.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class KennzahlApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2", "kennzahl-vectors.json");
    private static final String PFAD = "/api/v1/kennzahlen";
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");

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

    @MockBean
    KennzahlAufrufer aufrufer;

    @Autowired
    KennzahlVorlagen vorlagen;

    private static JdbcTemplate root;
    private static JsonNode vertrag;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID unternehmen, UUID st1, UUID st2, UUID g2, UUID g5, UUID prozess) {}

    private record Antwort(int status, JsonNode body) {}

    @BeforeAll
    static void verbinde() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        vertrag = MAPPER.readTree(VEKTOREN.toFile());
    }

    /** Ohne Person aus K18: der Aufrufer von heute (Kundenbenutzer = Kundenadministrator unternehmensweit). */
    @BeforeEach
    void aufruferWieHeute() {
        doAnswer(inv -> KorrekturRechte.benutzer(inv.getArgument(0))).when(aufrufer).benutzer(any());
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    // ================================================================ anlegen, lesen (K1-Form)

    @Test
    void anlegenGibtFassungEinsUndGenauEinenProtokolleintrag() throws Exception {
        Welt w = welt();
        Antwort a = ruf(w, HttpMethod.POST, PFAD, anfrage(null, "Stromeinsatz Montage je Stück — Halle 2", "quotient",
                "gebaeude", w.g2(), e("zaehler", "messstelle", "MS-12"), e("nenner", "bezugsgroesse", "BZ-6")));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(201);
        assertThat(felder(a.body())).containsExactly("id", "kennzeichen", "name", "rechenform", "geltung_art", "geltung_id",
                "geltung_name", "rechte_geltung", "standort_id", "kennung", "verantwortlich_name", "zweck", "fassung",
                "einheit", "einheit_anzeige", "grundperiode", "perioden", "hat_werte", "archiviert_am", "angelegt_am",
                "bezugsbasis");
        JsonNode k = a.body();
        // AP-17 IP-8 (B3): ohne laufende Bezugsbasis steht das Feld als null da.
        assertThat(k.get("bezugsbasis").isNull()).isTrue();
        assertThat(k.get("kennzeichen").asText()).isEqualTo("KZ-0001");
        assertThat(k.get("geltung_name").asText()).isEqualTo("Halle 2");
        assertThat(k.get("rechte_geltung").asText()).isEqualTo("standort");
        assertThat(k.get("standort_id").asText()).isEqualTo(w.st1().toString());
        assertThat(k.get("kennung").asText()).isEqualTo("kennzahl.standort_definieren");
        assertThat(k.get("verantwortlich_name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(k.get("fassung").asInt()).isEqualTo(1);
        assertThat(k.get("einheit").asText()).isEqualTo("kWh/Stück");
        assertThat(k.get("einheit_anzeige").asText()).isEqualTo("kWh je Stück");
        assertThat(k.get("grundperiode").asText()).isEqualTo("monat");
        assertThat(texte(k.get("perioden"))).containsExactly("monat", "jahr");
        assertThat(k.get("hat_werte").asBoolean()).isFalse();
        UUID id = UUID.fromString(k.get("id").asText());
        assertThat(root.queryForList("SELECT art || ':' || actor_name || ':' || actor_rolle || ':' || rueckwirkend || ':' "
                + "|| (neu->>'kennzeichen') || ':' || (neu->>'fassung') FROM kennzahl_aenderung WHERE kennzahl_id = ?",
                String.class, id)).containsExactly("kennzahl_fassung_eingetragen:Ines Kaltenbach:kundenadministrator:false:KZ-0001:1");

        JsonNode fassungen = ruf(w, HttpMethod.GET, PFAD + "/" + id + "/fassungen", null).body().get("fassungen");
        assertThat(fassungen).hasSize(1);
        assertThat(fassungen.get(0).get("gueltig_ab").isNull()).as("Fassung 1 gilt seit Beginn").isTrue();
        assertThat(fassungen.get(0).get("herkunft").asText()).isEqualTo("anlage");
        assertThat(fassungen.get(0).get("eingaenge").findValuesAsText("kennzeichen")).containsExactly("MS-12", "BZ-6");
        assertThat(ruf(w, HttpMethod.GET, PFAD + "/" + id + "/berechnung", null).body().get("fassung").get("nummer").asInt())
                .isEqualTo(1);

        // Die Nummer folgt der höchsten je belegten: KZ-7 zählt wie KZ-0007.
        assertThat(anlegenKz(w, null, "gebaeude", w.g2(), "MS-20", "BZ-6").get("kennzeichen").asText()).isEqualTo("KZ-0002");
        assertThat(anlegenKz(w, "KZ-7", "gebaeude", w.g2(), "MS-24", "BZ-6").get("kennzeichen").asText()).isEqualTo("KZ-7");
        assertThat(anlegenKz(w, null, "gebaeude", w.g2(), "MS-01", "BZ-6").get("kennzeichen").asText()).isEqualTo("KZ-0008");
        assertThat(ruf(w, HttpMethod.GET, PFAD, null).body().get("kennzahlen").findValuesAsText("kennzeichen"))
                .containsExactly("KZ-0001", "KZ-0002", "KZ-0008", "KZ-7");
    }

    // ================================================================ K13 — Periode passt nicht

    @Test
    void k13EineTageskennzahlAusMonatswertenWirdAbgelehnt() throws Exception {
        Welt w = welt();
        Map<String, Object> versuch1 = mit(anfrage(null, "Stromeinsatz Montage je Stück je Tag", "quotient", "gebaeude",
                w.g2(), e("zaehler", "messstelle", "MS-12"), e("nenner", "bezugsgroesse", "BZ-6")), "periode_art", "tag");
        Antwort a = abgelehnt(w, HttpMethod.POST, PFAD, versuch1, "periode_passt_nicht", "BZ-6 Gutteile Montage Halle 2 "
                + "führt Monatswerte. Eine Kennzahl je Tag ist damit nicht bildbar — ein Monatswert wird nie auf Tage verteilt.");
        assertThat(a.body().get("grundperiode").asText()).isEqualTo("monat");
        assertThat(texte(a.body().get("perioden"))).containsExactly("monat", "jahr");

        Map<String, Object> versuch2 = mit(anfrage(null, "Stromeinsatz Spritzguss je Stück je Monat", "quotient", "gebaeude",
                w.g2(), e("zaehler", "messstelle", "MS-20"), e("nenner", "bezugsgroesse", "BZ-9")), "periode_art", "monat");
        abgelehnt(w, HttpMethod.POST, PFAD, versuch2, "periode_passt_nicht", "BZ-9 Produktionsmenge je Woche führt "
                + "Wochenwerte. Eine Kennzahl je Monat ist daraus nicht bildbar — Wochenwerte gehen nicht restlos in Monatswerten auf.");

        // Die Vorschau sagt dasselbe als Befund — und rechnet nichts.
        Antwort v = ruf(w, HttpMethod.POST, PFAD + "/vorschau", versuch1);
        assertThat(v.status()).isEqualTo(200);
        assertThat(v.body().get("befunde").findValuesAsText("code")).containsExactly("periode_passt_nicht");
        assertThat(v.body().get("letzte_perioden")).isEmpty();

        // Ohne Wunsch entsteht KZ-0001 je Monat und je Jahr.
        assertThat(texte(anlegenKz(w, null, "gebaeude", w.g2(), "MS-12", "BZ-6").get("perioden"))).containsExactly("monat", "jahr");
    }

    // ================================================================ K16 — Kreisbezug

    @Test
    void k16EinKreisUeberKennzahlenWirdMitKetteAbgelehnt() throws Exception {
        Welt w = welt();
        anlegenKz(w, "KZ-0001", "gebaeude", w.g2(), "MS-12", "BZ-6");
        anlegenKz(w, "KZ-0002", "gebaeude", w.g2(), "MS-20", "BZ-6");
        anlegenKz(w, "KZ-0003", "gebaeude", w.g2(), "MS-24", "BZ-6");
        anlegenKz(w, "KZ-0004", "gebaeude", w.g2(), "MS-01", "BZ-6");
        zusammenfassung(w, "KZ-0021", "KZ-0001", "KZ-0002");
        zusammenfassung(w, "KZ-0022", "KZ-0003", "KZ-0004");
        UUID kz12 = zusammenfassung(w, "KZ-0012", "KZ-0021", "KZ-0022");
        zusammenfassung(w, "KZ-0011", "KZ-0012", "KZ-0021");

        // KZ-0012 soll ab morgen KZ-0011 lesen — die liest KZ-0012.
        String morgen = LocalDate.now(BERLIN).plusDays(1).toString();
        Antwort a = abgelehnt(w, HttpMethod.POST, PFAD + "/" + kz12 + "/fassungen",
                fassung(morgen, "Die Zusammenfassung soll KZ-0011 enthalten.", e("paar", "kennzahl", "KZ-0022"),
                        e("paar", "kennzahl", "KZ-0011")),
                "formel_zyklus", "Diese Berechnung würde im Kreis laufen: KZ-0012 → KZ-0011 → KZ-0012. "
                        + "Eine Kennzahl kann sich nicht selbst enthalten.");
        assertThat(texte(a.body().get("kette"))).containsExactly("KZ-0012", "KZ-0011", "KZ-0012");

        // Selbstverweis: dieselbe Regel, eine Kette der Länge 2.
        UUID kz21 = id(ruf(w, HttpMethod.GET, PFAD, null), "KZ-0021");
        Antwort selbst = abgelehnt(w, HttpMethod.POST, PFAD + "/" + kz21 + "/fassungen",
                fassung(morgen, "Selbstverweis", e("paar", "kennzahl", "KZ-0021"), e("paar", "kennzahl", "KZ-0022")),
                "formel_zyklus", null);
        assertThat(texte(selbst.body().get("kette"))).startsWith("KZ-0021").endsWith("KZ-0021");

        // Die Raute ist kein Kreis: KZ-0013 liest KZ-0021 und KZ-0022 wie KZ-0012.
        assertThat(ruf(w, HttpMethod.POST, PFAD, anfrage("KZ-0013", "Raute", "zusammenfassung", "unternehmen",
                w.unternehmen(), e("paar", "kennzahl", "KZ-0021"), e("paar", "kennzahl", "KZ-0022"))).status()).isEqualTo(201);
    }

    // ================================================================ K17 — Fassung 2, Überlappung

    @Test
    void k17DieBerechnungAendertSichAbEinemTagAuchRueckwirkend() throws Exception {
        Welt w = welt();
        JsonNode kz = anlegenKz(w, "KZ-0004", "prozess", w.prozess(), "MS-20", "BZ-1");
        assertThat(kz.get("einheit").asText()).isEqualTo("kWh/kg");
        assertThat(kz.get("rechte_geltung").asText()).as("Prozess → Unternehmen (G1)").isEqualTo("unternehmen");
        UUID id = UUID.fromString(kz.get("id").asText());
        LocalDate ab = LocalDate.now(BERLIN).minusDays(19);
        String begruendung = "Seit dem Umzug des Kaltwassersatzes gehört die Prozesskühlung zum Stromeinsatz Spritzguss.";

        Antwort f = ruf(w, HttpMethod.POST, PFAD + "/" + id + "/fassungen", fassung(ab.toString(), begruendung,
                e("zaehler", "messstelle", "MS-24"), e("nenner", "bezugsgroesse", "BZ-1")));
        assertThat(f.status()).as(f.body().toString()).isEqualTo(200);
        JsonNode fassungen = f.body().get("fassungen");
        assertThat(fassungen).hasSize(2);
        assertThat(fassungen.get(0).get("gueltig_bis").asText()).as("Fassung 1 endet am Vortag").isEqualTo(ab.minusDays(1).toString());
        assertThat(fassungen.get(0).get("eingaenge").findValuesAsText("kennzeichen")).containsExactly("MS-20", "BZ-1");
        JsonNode zwei = fassungen.get(1);
        assertThat(zwei.get("nummer").asInt()).isEqualTo(2);
        assertThat(zwei.get("gueltig_ab").asText()).isEqualTo(ab.toString());
        assertThat(zwei.get("gueltig_bis").isNull()).isTrue();
        assertThat(zwei.get("rueckwirkend").asBoolean()).isTrue();
        assertThat(zwei.get("abzeichen").asText()).isEqualTo("rückwirkend (19 Tage)");
        assertThat(zwei.get("herkunft").asText()).isEqualTo("eintrag");
        assertThat(zwei.get("begruendung").asText()).isEqualTo(begruendung);
        assertThat(zwei.get("eingetragen_von").get("name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(zwei.get("eingaenge").findValuesAsText("kennzeichen")).containsExactly("MS-24", "BZ-1");
        assertThat(root.queryForList("SELECT art || ':' || rueckwirkend || ':' || coalesce(grund, '-') || ':' "
                + "|| (gilt_ab AT TIME ZONE 'Europe/Berlin')::date FROM kennzahl_aenderung WHERE kennzahl_id = ? "
                + "ORDER BY created_at, id", String.class, id)).as("genau ein Eintrag je Fassung")
                .containsExactly("kennzahl_fassung_eingetragen:false:-:" + LocalDate.now(BERLIN),
                        "kennzahl_fassung_eingetragen:true:" + begruendung + ":" + ab);

        // Die Berechnung liest die Fassung des Tages.
        assertThat(nummerAm(w, id, ab.minusDays(1).toString())).isEqualTo(1);
        assertThat(nummerAm(w, id, ab.toString())).isEqualTo(2);
        assertThat(nummerAm(w, id, null)).isEqualTo(2);

        // Überlappung: an oder vor dem Beginn der jüngsten.
        Antwort gleich = abgelehnt(w, HttpMethod.POST, PFAD + "/" + id + "/fassungen", fassung(ab.toString(), "Nochmal",
                e("zaehler", "messstelle", "MS-20"), e("nenner", "bezugsgroesse", "BZ-1")), "fassung_ueberlappt",
                "Ab diesem Tag gilt schon Fassung 2.");
        assertThat(gleich.body().get("fassung").asInt()).isEqualTo(2);
        assertThat(gleich.body().get("gueltig_ab").asText()).isEqualTo(ab.toString());
        Antwort frueher = abgelehnt(w, HttpMethod.POST, PFAD + "/" + id + "/fassungen", fassung(ab.minusDays(5).toString(),
                "Früher", e("zaehler", "messstelle", "MS-20"), e("nenner", "bezugsgroesse", "BZ-1")), "fassung_ueberlappt", null);
        assertThat(frueher.body().get("message").asText()).startsWith("Ab dem ").contains("gilt schon Fassung 2");
        abgelehntMitFeld(w, HttpMethod.GET, PFAD + "/" + id + "/berechnung?am=gestern", null, "anfrage_ungueltig", "am");
    }

    // ================================================================ K18 — 403 und 404

    @Test
    void k18PeterDefiniertLindachBekommt403FuerDasUnternehmenUnd404FuerAhrenberg() throws Exception {
        Welt w = welt();
        // Ines legt vorher je eine Kennzahl für das Unternehmen und für Halle 2 (Werk Ahrenberg) an.
        UUID unternehmen = UUID.fromString(ruf(w, HttpMethod.POST, PFAD, anfrage("KZ-0003", "Stromeinsatz Montage je Stück "
                + "— Unternehmen", "quotient", "unternehmen", w.unternehmen(), e("zaehler", "messstelle", "MS-12"),
                e("nenner", "bezugsgroesse", "BZ-6"))).body().get("id").asText());
        UUID halle2 = UUID.fromString(anlegenKz(w, "KZ-0001", "gebaeude", w.g2(), "MS-12", "BZ-6").get("id").asText());

        doReturn(person("PH", "Peter Hollerbach", RechteAbleitung.Rolle.BEARBEITER, w.st2())).when(aufrufer).benutzer(any());
        Antwort lindach = ruf(w, HttpMethod.POST, PFAD, anfrage("KZ-0002", "Stromeinsatz Montage je Stück — Halle 5",
                "quotient", "gebaeude", w.g5(), e("zaehler", "messstelle", "MS-18"), e("nenner", "bezugsgroesse", "BZ-7")));
        assertThat(lindach.status()).as(lindach.body().toString()).isEqualTo(201);
        assertThat(lindach.body().get("standort_id").asText()).isEqualTo(w.st2().toString());

        Antwort rolle = abgelehnt(w, HttpMethod.POST, PFAD, anfrage(null, "Unternehmen", "quotient", "unternehmen",
                w.unternehmen(), e("zaehler", "messstelle", "MS-18"), e("nenner", "bezugsgroesse", "BZ-7")),
                "recht_fehlt", RechteAbleitung.TEXTE.get("recht_fehlt"));
        assertThat(rolle.status()).isEqualTo(403);
        assertThat(rolle.body().get("rolle_noetig").asText()).isEqualTo("energiemanager");

        String fremd = RechteAbleitung.TEXTE.get("ausserhalb_geltungsbereich");
        assertThat(abgelehnt(w, HttpMethod.POST, PFAD, anfrage(null, "Halle 2", "quotient", "gebaeude", w.g2(),
                e("zaehler", "messstelle", "MS-12"), e("nenner", "bezugsgroesse", "BZ-6")), "nicht_gefunden", fremd).status())
                .as("fremd ist nicht da — 404, nicht 403").isEqualTo(404);

        // Jeder Schreibweg an einer bestehenden Kennzahl urteilt genauso.
        Map<String, Object> stammdaten = stammdaten("KZ-0003", "Neu", "Peter Hollerbach", null);
        Map<String, Object> f = fassung(LocalDate.now(BERLIN).plusDays(1).toString(), "Peter",
                e("zaehler", "messstelle", "MS-12"), e("nenner", "bezugsgroesse", "BZ-6"));
        for (Object[] weg : new Object[][] {{HttpMethod.PUT, "", stammdaten}, {HttpMethod.POST, "/archivieren", null},
                {HttpMethod.DELETE, "", null}, {HttpMethod.POST, "/fassungen", f}}) {
            assertThat(abgelehnt(w, (HttpMethod) weg[0], PFAD + "/" + unternehmen + weg[1], weg[2], "recht_fehlt",
                    RechteAbleitung.TEXTE.get("recht_fehlt")).body().get("rolle_noetig").asText()).isEqualTo("energiemanager");
            abgelehnt(w, (HttpMethod) weg[0], PFAD + "/" + halle2 + weg[1], weg[2], "nicht_gefunden", fremd);
        }
        assertThat(abgelehnt(w, HttpMethod.POST, PFAD + "/vorschau", anfrage(null, "Unternehmen", "quotient", "unternehmen",
                w.unternehmen(), e("zaehler", "messstelle", "MS-18"), e("nenner", "bezugsgroesse", "BZ-7")), "recht_fehlt",
                RechteAbleitung.TEXTE.get("recht_fehlt")).status()).isEqualTo(403);

        // Ein eigener Zielort erlaubt keine Vorschau fremder Eingänge. Fremd und unbekannt sind gleich.
        for (String quelle : List.of("MS-12", "MS-999999")) {
            var a = anfrage(null, "Versuch", "quotient", "gebaeude", w.g5(),
                    e("zaehler", "messstelle", quelle), e("nenner", "bezugsgroesse", "BZ-7"));
            Antwort v = ruf(w, HttpMethod.POST, PFAD + "/vorschau", a);
            assertThat(v.status()).isEqualTo(200);
            assertThat(v.body().get("befunde").findValuesAsText("code")).containsExactly("eingang_unbekannt");
            assertThat(v.body().get("letzte_perioden")).isEmpty();
            assertThat(v.body().toString()).doesNotContain("Montage Linie M1", "kWh", "6100");
            assertThat(abgelehnt(w, HttpMethod.POST, PFAD, a, "eingang_unbekannt", null).status()).isEqualTo(422);
        }

        // Murat (Bedienberechtigt, Werk Ahrenberg) definiert nichts: im eigenen Standort fehlt die Rolle Bearbeiter.
        doReturn(person("MD", "Murat Demirci", RechteAbleitung.Rolle.BEDIENBERECHTIGT, w.st1())).when(aufrufer).benutzer(any());
        assertThat(abgelehnt(w, HttpMethod.POST, PFAD, anfrage(null, "Halle 2", "quotient", "gebaeude", w.g2(),
                e("zaehler", "messstelle", "MS-12"), e("nenner", "bezugsgroesse", "BZ-6")), "recht_fehlt",
                RechteAbleitung.TEXTE.get("recht_fehlt")).body().get("rolle_noetig").asText()).isEqualTo("bearbeiter");
    }

    // ================================================================ U2 — Einheiten

    @Test
    void u2EinAnteilBrauchtDieselbeGroesse() throws Exception {
        Welt w = welt();
        abgelehnt(w, HttpMethod.POST, PFAD, anfrage(null, "Anteil", "anteil", "gebaeude", w.g2(),
                e("zaehler", "messstelle", "MS-12"), e("nenner", "bezugsgroesse", "BZ-6")), "einheit_unpassend",
                "Ein Anteil braucht zwei Werte derselben Größe — MS-12 (kWh) und BZ-6 (Stück) ergeben einen Quotienten, "
                        + "keinen Anteil.");
        Antwort anteil = ruf(w, HttpMethod.POST, PFAD, mit(anfrage(null, "Anteil der Montage am Werk", "anteil", "gebaeude",
                w.g2(), e("zaehler", "messstelle", "MS-12"), e("nenner", "messstelle", "MS-01")), "komplement", true));
        assertThat(anteil.status()).as(anteil.body().toString()).isEqualTo(201);
        assertThat(anteil.body().get("einheit").asText()).isEqualTo("%");
        assertThat(anteil.body().get("einheit_anzeige").asText()).isEqualTo("%");
        assertThat(ruf(w, HttpMethod.GET, PFAD + "/" + anteil.body().get("id").asText() + "/fassungen", null).body()
                .get("fassungen").get(0).get("komplement").asBoolean()).isTrue();
        abgelehntMitFeld(w, HttpMethod.POST, PFAD, mit(anfrage(null, "Quotient", "quotient", "gebaeude", w.g2(),
                e("zaehler", "messstelle", "MS-12"), e("nenner", "bezugsgroesse", "BZ-6")), "komplement", true),
                "anfrage_ungueltig", "komplement");
    }

    // ================================================================ Vorschau

    @Test
    void dieVorschauPrueftRechnetDreiPeriodenUndSchreibtNichts() throws Exception {
        Welt w = welt();
        LocalDate m1 = LocalDate.now(BERLIN).withDayOfMonth(1).minusMonths(1);
        LocalDate m2 = m1.minusMonths(1);
        LocalDate m3 = m2.minusMonths(1);
        UUID bz6 = bezugsgroesseId(w, "BZ-6");
        UUID bz3 = bezugsgroesseId(w, "BZ-3");
        monatswert(w, bz6, "Stück", m1, "41000");
        monatswert(w, bz3, "h", m1, "400");
        monatswert(w, bz6, "Stück", m2, "38000");
        monatswert(w, bz3, "h", m2, "380");
        monatswert(w, bz6, "Stück", m3, "40000");

        String vorher = zustand(w);
        Map<String, Object> anfrage = anfrage("KZ-0500", "Gutteile je Betriebsstunde", "quotient", "gebaeude", w.g2(),
                e("zaehler", "bezugsgroesse", "BZ-6"), e("nenner", "bezugsgroesse", "BZ-3"));
        Antwort v = ruf(w, HttpMethod.POST, PFAD + "/vorschau", anfrage);
        assertThat(v.status()).as(v.body().toString()).isEqualTo(200);
        JsonNode b = v.body();
        assertThat(b.get("befunde")).isEmpty();
        assertThat(b.get("einheit").asText()).isEqualTo("Stück/h");
        assertThat(b.get("kennung").asText()).isEqualTo("kennzahl.standort_definieren");
        assertThat(b.get("periode_art").asText()).isEqualTo("monat");
        JsonNode p = b.get("letzte_perioden");
        assertThat(p).hasSize(3);
        assertThat(p.findValuesAsText("schluessel")).containsExactly(schluessel(m1), schluessel(m2), schluessel(m3));
        assertThat(p.get(0).get("wert").asText()).isEqualTo("102.5");
        assertThat(p.get(0).get("zustand").asText()).isEqualTo("vollständig");
        assertThat(p.get(1).get("wert").asText()).isEqualTo("100");
        assertThat(p.get(2).get("wert").isNull()).as("ohne Nenner keine Zahl, nie 0").isTrue();
        assertThat(p.get(2).get("zustand").asText()).isEqualTo("keine Werte");
        assertThat(p.get(2).get("grund").asText()).isEqualTo("nenner_fehlt");
        assertThat(zustand(w)).as("die Vorschau schreibt nichts").isEqualTo(vorher);

        // Ein Befund statt Perioden; das Kennzeichen der Vorschau ist nicht belegt.
        Antwort befund = ruf(w, HttpMethod.POST, PFAD + "/vorschau", mit(anfrage, "rechenform", "produkt"));
        assertThat(befund.body().get("befunde").findValuesAsText("code")).containsExactly("rechenform_unbekannt");
        assertThat(befund.body().get("letzte_perioden")).isEmpty();
        assertThat(zustand(w)).isEqualTo(vorher);
        assertThat(ruf(w, HttpMethod.POST, PFAD, anfrage).status()).isEqualTo(201);
    }

    // ================================================================ Paare für den Assistenten (IP-11)

    /**
     * {@code GET …/paare} (AP-11 IP-11, §5.6): Halle 2 und Lindach (kWh/Stück) stehen in EINER Gruppe, der Stromeinsatz
     * je kg in einer eigenen, die Zusammenfassung in ihrer; eine archivierte fehlt. Die Filter lassen nur die Gruppe
     * (Rechenform, Einheit) bzw. den Standort übrig; ein unbekannter oder leerer Parameter ist 400. Nichts wird geschrieben.
     */
    @Test
    void diePaareStehenJeRechenformUndEinheitInEinerGruppe() throws Exception {
        Welt w = welt();
        anlegenKz(w, "KZ-0001", "gebaeude", w.g2(), "MS-12", "BZ-6");
        anlegenKz(w, "KZ-0002", "gebaeude", w.g5(), "MS-18", "BZ-7");
        anlegenKz(w, "KZ-0004", "prozess", w.prozess(), "MS-20", "BZ-1");
        UUID alt = UUID.fromString(anlegenKz(w, "KZ-0005", "gebaeude", w.g2(), "MS-24", "BZ-6").get("id").asText());
        assertThat(ruf(w, HttpMethod.POST, PFAD + "/" + alt + "/archivieren", null).status()).isEqualTo(200);
        zusammenfassung(w, "KZ-0003", "KZ-0001", "KZ-0002");
        String vorher = zustand(w);

        Antwort alle = ruf(w, HttpMethod.GET, PFAD + "/paare", null);
        assertThat(alle.status()).as(alle.body().toString()).isEqualTo(200);
        assertThat(gruppen(alle.body())).containsExactly("quotient kWh/Stück KZ-0001 KZ-0002", "quotient kWh/kg KZ-0004",
                "zusammenfassung kWh/Stück KZ-0003");
        assertThat(alle.body().get("gruppen").get(0).get("einheit_anzeige").asText()).isEqualTo("kWh je Stück");
        assertThat(felder(alle.body().get("gruppen").get(0).get("kennzahlen").get(0)))
                .as("die Kennzahl in derselben Form wie GET /kennzahlen")
                .containsExactlyElementsOf(felder(ruf(w, HttpMethod.GET, PFAD + "/" + alt, null).body()));

        assertThat(gruppen(ruf(w, HttpMethod.GET, PFAD + "/paare?rechenform=quotient&einheit=kWh/Stück", null).body()))
                .containsExactly("quotient kWh/Stück KZ-0001 KZ-0002");
        assertThat(gruppen(ruf(w, HttpMethod.GET, PFAD + "/paare?einheit=kWh/Stück", null).body()))
                .containsExactly("quotient kWh/Stück KZ-0001 KZ-0002", "zusammenfassung kWh/Stück KZ-0003");
        assertThat(gruppen(ruf(w, HttpMethod.GET, PFAD + "/paare?standort_id=" + w.st2(), null).body()))
                .as("nur Lindach liegt in ST-2").containsExactly("quotient kWh/Stück KZ-0002");
        assertThat(gruppen(ruf(w, HttpMethod.GET, PFAD + "/paare?rechenform=anteil", null).body())).isEmpty();

        abgelehntMitFeld(w, HttpMethod.GET, PFAD + "/paare?faktor=1", null, "anfrage_ungueltig", "faktor");
        abgelehntMitFeld(w, HttpMethod.GET, PFAD + "/paare?rechenform=produkt", null, "anfrage_ungueltig", "rechenform");
        abgelehntMitFeld(w, HttpMethod.GET, PFAD + "/paare?einheit=", null, "anfrage_ungueltig", "einheit");
        abgelehntMitFeld(w, HttpMethod.GET, PFAD + "/paare?standort_id=ST-2", null, "anfrage_ungueltig", "standort_id");
        assertThat(zustand(w)).isEqualTo(vorher);
    }

    private static List<String> gruppen(JsonNode antwort) {
        List<String> aus = new ArrayList<>();
        antwort.get("gruppen").forEach(g -> aus.add(g.get("rechenform").asText() + " " + g.get("einheit").asText() + " "
                + String.join(" ", g.get("kennzahlen").findValuesAsText("kennzeichen"))));
        return aus;
    }

    // ================================================================ Stammdaten, Archiv, Löschen

    @Test
    void stammdatenArchivierenUndLoeschenOhneWert() throws Exception {
        Welt w = welt();
        JsonNode kz = anlegenKz(w, null, "gebaeude", w.g2(), "MS-12", "BZ-6");
        UUID id = UUID.fromString(kz.get("id").asText());
        String pfad = PFAD + "/" + id;

        assertThat(ruf(w, HttpMethod.PUT, pfad, stammdaten("KZ-0001", kz.get("name").asText(), "Ines Kaltenbach", null))
                .status()).isEqualTo(200);
        assertThat(protokoll(id)).as("ein unverändertes PUT schreibt nichts").hasSize(1);
        Antwort neu = ruf(w, HttpMethod.PUT, pfad, stammdaten("KZ-0101", "Montage je Gutteil", "Jonas Wendlinger", "Vergleich"));
        assertThat(neu.body().get("kennzeichen").asText()).isEqualTo("KZ-0101");
        assertThat(neu.body().get("verantwortlich_name").asText()).isEqualTo("Jonas Wendlinger");
        assertThat(letzter(id)).startsWith("kennzahl_geaendert:");
        abgelehntMitFeld(w, HttpMethod.PUT, pfad, mit(stammdaten("KZ-0101", "X", "Ines", null), "geltung_art", "standort"),
                "anfrage_ungueltig", "geltung_art");

        assertThat(ruf(w, HttpMethod.POST, pfad + "/archivieren", null).body().get("archiviert_am").isNull()).isFalse();
        abgelehnt(w, HttpMethod.POST, pfad + "/archivieren", null, "archiviert", null);
        abgelehnt(w, HttpMethod.PUT, pfad, stammdaten("KZ-0101", "Y", "Ines", null), "archiviert", null);
        abgelehnt(w, HttpMethod.POST, pfad + "/fassungen", fassung(LocalDate.now(BERLIN).plusDays(1).toString(), "Archiv",
                e("zaehler", "messstelle", "MS-20"), e("nenner", "bezugsgroesse", "BZ-6")), "archiviert", null);

        assertThat(ruf(w, HttpMethod.DELETE, pfad, null).status()).isEqualTo(204);
        assertThat(letzter(id)).isEqualTo("kennzahl_geaendert:neu leer");
        abgelehnt(w, HttpMethod.GET, pfad, null, "nicht_gefunden", null);
        // Grabstein: das heutige UND das frühere Kennzeichen bleiben belegt.
        abgelehntMitFeld(w, HttpMethod.POST, PFAD, mit(anfrage("KZ-0101", "Nachfolger", "quotient", "gebaeude", w.g2(),
                e("zaehler", "messstelle", "MS-12"), e("nenner", "bezugsgroesse", "BZ-6")), "zweck", null),
                "kennzeichen_belegt", "kennzeichen");
        assertThat(anlegenKz(w, null, "gebaeude", w.g2(), "MS-12", "BZ-6").get("kennzeichen").asText()).isEqualTo("KZ-0102");
    }

    // ================================================================ der geschlossene Satz

    /** Ein Rundgang über jeden Code des Vertrags — Code, Status, Satz, und nichts ist geschrieben. */
    @Test
    void jederCodeDesGeschlossenenSatzesKommtVor() throws Exception {
        Set<String> gesehen = new LinkedHashSet<>();
        Welt w = welt();
        UUID kz1 = UUID.fromString(anlegenKz(w, "KZ-0001", "gebaeude", w.g2(), "MS-12", "BZ-6").get("id").asText());
        anlegenKz(w, "KZ-0002", "gebaeude", w.g2(), "MS-20", "BZ-6");
        UUID zus = zusammenfassung(w, "KZ-0003", "KZ-0001", "KZ-0002");
        Map<String, Object> gut = anfrage(null, "Gut", "quotient", "gebaeude", w.g2(), e("zaehler", "messstelle", "MS-24"),
                e("nenner", "bezugsgroesse", "BZ-6"));

        // 400
        gesehen.add(abgelehntMitFeld(w, HttpMethod.POST, PFAD, mit(gut, "faktor", "1000"), "anfrage_ungueltig", "faktor"));
        abgelehntMitFeld(w, HttpMethod.POST, PFAD, mit(gut, "geltungArt", "gebaeude"), "anfrage_ungueltig", "geltungArt");
        abgelehntMitFeld(w, HttpMethod.POST, PFAD, mit(gut, "eingaenge", List.of(Map.of("rolle", "zaehler", "id", "x"))),
                "anfrage_ungueltig", "eingaenge");
        abgelehntMitFeld(w, HttpMethod.POST, PFAD, mit(gut, "name", " "), "anfrage_ungueltig", "name");
        abgelehnt(w, HttpMethod.POST, PFAD, List.of("keine", "Anfrage"), "anfrage_ungueltig", null);
        abgelehnt(w, HttpMethod.POST, PFAD, anfrage(null, "Zu klein", "zusammenfassung", "unternehmen", w.unternehmen(),
                e("paar", "kennzahl", "KZ-0001")), "anfrage_ungueltig", "Eine Zusammenfassung braucht mindestens zwei Kennzahlen.");
        gesehen.add(abgelehntMitFeld(w, HttpMethod.POST, PFAD, mit(gut, "kennzeichen", "kz 1"), "kennzeichen_format",
                "kennzeichen"));
        // 403 / 404
        doReturn(person("PH", "Peter Hollerbach", RechteAbleitung.Rolle.BEARBEITER, w.st2())).when(aufrufer).benutzer(any());
        gesehen.add(abgelehnt(w, HttpMethod.POST, PFAD, anfrage(null, "U", "quotient", "unternehmen", w.unternehmen(),
                e("zaehler", "messstelle", "MS-12"), e("nenner", "bezugsgroesse", "BZ-6")), "recht_fehlt",
                RechteAbleitung.TEXTE.get("recht_fehlt")).body().get("code").asText());
        aufruferWieHeute();
        gesehen.add(abgelehnt(w, HttpMethod.GET, PFAD + "/" + UUID.randomUUID(), null, "nicht_gefunden", null)
                .body().get("code").asText());
        abgelehnt(w, HttpMethod.GET, PFAD + "/keine-id/fassungen", null, "nicht_gefunden", null);
        // 409
        gesehen.add(abgelehntMitFeld(w, HttpMethod.POST, PFAD, mit(gut, "kennzeichen", "KZ-0001"), "kennzeichen_belegt",
                "kennzeichen"));
        UUID kz9 = UUID.fromString(anlegenKz(w, "KZ-0009", "gebaeude", w.g2(), "MS-01", "BZ-6").get("id").asText());
        wertAnhaengen(w, kz9);
        Antwort werte = abgelehnt(w, HttpMethod.DELETE, PFAD + "/" + kz9, null, "hat_werte", "KZ-0009 hat Werte — archivieren Sie sie.");
        assertThat(werte.body().get("werte").asInt()).isEqualTo(1);
        gesehen.add(werte.body().get("code").asText());
        Antwort leser = abgelehnt(w, HttpMethod.DELETE, PFAD + "/" + kz1, null, "wird_gelesen",
                "KZ-0001 wird von KZ-0003 gelesen — archivieren Sie sie stattdessen.");
        assertThat(texte(leser.body().get("leser"))).containsExactly("KZ-0003");
        gesehen.add(leser.body().get("code").asText());
        assertThat(ruf(w, HttpMethod.POST, PFAD + "/" + kz9 + "/archivieren", null).status()).isEqualTo(200);
        gesehen.add(abgelehnt(w, HttpMethod.POST, PFAD + "/" + kz9 + "/archivieren", null, "archiviert", null)
                .body().get("code").asText());
        // 422
        gesehen.add(abgelehnt(w, HttpMethod.POST, PFAD, mit(gut, "periode_art", "tag"), "periode_passt_nicht",
                "BZ-6 Gutteile Montage Halle 2 führt Monatswerte. Eine Kennzahl je Tag ist damit nicht bildbar — ein "
                        + "Monatswert wird nie auf Tage verteilt.").body().get("code").asText());
        gesehen.add(abgelehnt(w, HttpMethod.POST, PFAD, mit(gut, "rechenform", "anteil"), "einheit_unpassend",
                "Ein Anteil braucht zwei Werte derselben Größe — MS-24 (kWh) und BZ-6 (Stück) ergeben einen Quotienten, "
                        + "keinen Anteil.").body().get("code").asText());
        gesehen.add(abgelehnt(w, HttpMethod.POST, PFAD, anfrage(null, "Fremd", "quotient", "gebaeude", w.g2(),
                e("zaehler", "messstelle", "MS-18"), e("nenner", "bezugsgroesse", "BZ-6")), "eingang_ausserhalb_geltung",
                "MS-18 liegt in Werk Lindach — eine Kennzahl für Werk Ahrenberg kann sie nicht lesen.").body().get("code").asText());
        String morgen = LocalDate.now(BERLIN).plusDays(1).toString();
        // Dieselbe Kennzahl zweimal als Paar ist keine Zusammenfassung.
        abgelehntMitFeld(w, HttpMethod.POST, PFAD, anfrage(null, "Doppelt", "zusammenfassung", "unternehmen",
                w.unternehmen(), e("paar", "kennzahl", "KZ-0003"), e("paar", "kennzahl", "KZ-0003")), "anfrage_ungueltig",
                "eingaenge");
        zusammenfassung(w, "KZ-0005", "KZ-0001", "KZ-0002");
        UUID kz4 = zusammenfassung(w, "KZ-0004", "KZ-0003", "KZ-0005");
        gesehen.add(abgelehnt(w, HttpMethod.POST, PFAD + "/" + zus + "/fassungen", fassung(morgen, "Kreis",
                e("paar", "kennzahl", "KZ-0004"), e("paar", "kennzahl", "KZ-0005")), "formel_zyklus",
                "Diese Berechnung würde im Kreis laufen: KZ-0003 → KZ-0004 → KZ-0003. Eine Kennzahl kann sich nicht selbst "
                        + "enthalten.").body().get("code").asText());
        assertThat(ruf(w, HttpMethod.POST, PFAD + "/" + kz4 + "/fassungen", fassung(morgen, "Morgen",
                e("paar", "kennzahl", "KZ-0003"), e("paar", "kennzahl", "KZ-0005"))).status()).isEqualTo(200);
        gesehen.add(abgelehnt(w, HttpMethod.POST, PFAD + "/" + kz4 + "/fassungen", fassung(morgen, "Nochmal",
                e("paar", "kennzahl", "KZ-0003"), e("paar", "kennzahl", "KZ-0005")), "fassung_ueberlappt",
                "Ab diesem Tag gilt schon Fassung 2.").body().get("code").asText());
        gesehen.add(abgelehntMitFeld(w, HttpMethod.POST, PFAD, mit(gut, "geltung_id", UUID.randomUUID().toString()),
                "geltung_unbekannt", "geltung_id"));
        assertThat(ruf(w, HttpMethod.POST, PFAD, mit(gut, "geltung_id", UUID.randomUUID().toString())).body().get("message")
                .asText()).isEqualTo("Dieses Gebäude gibt es nicht (mehr).");
        gesehen.add(abgelehnt(w, HttpMethod.POST, PFAD, anfrage(null, "Unbekannt", "quotient", "gebaeude", w.g2(),
                e("zaehler", "messstelle", "MS-12"), e("nenner", "bezugsgroesse", "BZ-99")), "eingang_unbekannt",
                "Die Bezugsgröße BZ-99 gibt es nicht.").body().get("code").asText());
        gesehen.add(abgelehnt(w, HttpMethod.POST, PFAD, mit(gut, "rechenform", "produkt"), "rechenform_unbekannt",
                "Diese Rechenform gibt es noch nicht.").body().get("code").asText());

        // groesse_unbekannt stellt die Schnittstelle nicht nach: welche Messstellen es gibt, bestimmt der Katalog-CHECK
        // der Messstelle; die Regel selbst prüfen die Vektoren (KennzahlVectorsTest).
        List<String> erwartet = new ArrayList<>(KennzahlAbgelehnt.CODES);
        erwartet.remove(KennzahlRegeln.GROESSE_UNBEKANNT);
        assertThat(gesehen).containsExactlyInAnyOrderElementsOf(erwartet);
    }

    // ================================================================ Gerüst

    // ================================================================ Vorlagen (IP-10, K20)

    /**
     * K20: der Katalog steht an der Route (vorlage_gefunden); die Vorbelegung aus „Stromeinsatz je Stück“ ist eine
     * gültige Anfrage — mit den Eingängen, die Ines bindet, rechnet die Vorschau „kWh/Stück“ und schreibt nichts
     * (vorschau_schreibt = false). Erst „Anlegen“ schreibt: Name und Zweck der Vorlage, Fassung 1.
     */
    @Test
    @SuppressWarnings("unchecked")
    void k20DieVorschauAusDerVorlageSchreibtNichts() throws Exception {
        Welt w = welt();
        Antwort katalog = ruf(w, HttpMethod.GET, "/api/v1/kennzahl-vorlagen", null);
        assertThat(katalog.status()).as(katalog.body().toString()).isEqualTo(200);
        assertThat(felder(katalog.body())).containsExactly("schema_version", "vorlagen");
        assertThat(katalog.body().get("vorlagen")).hasSize(10);
        assertThat(katalog.body().get("vorlagen").get(0).get("kennung").asText()).isEqualTo("stromeinsatz_je_stueck");

        KennzahlVorlagen.Vorlage vorlage = vorlagen.vorlage("stromeinsatz_je_stueck").orElseThrow();
        Map<String, Object> anfrage = MAPPER.convertValue(
                KennzahlVorlagen.vorbelegung(vorlage, "gebaeude", w.g2().toString(), "Halle 2"), LinkedHashMap.class);
        anfrage.put("eingaenge", List.of(e("zaehler", "messstelle", "MS-12"), e("nenner", "bezugsgroesse", "BZ-6")));

        String vorher = zustand(w);
        Antwort v = ruf(w, HttpMethod.POST, PFAD + "/vorschau", anfrage);
        assertThat(v.status()).as(v.body().toString()).isEqualTo(200);
        assertThat(v.body().get("befunde")).as(v.body().toString()).isEmpty();
        assertThat(v.body().get("einheit").asText()).isEqualTo("kWh/Stück");
        assertThat(v.body().get("kennung").asText()).isEqualTo("kennzahl.standort_definieren");
        assertThat(zustand(w)).as("die Vorschau aus der Vorlage schreibt nichts").isEqualTo(vorher);

        Antwort a = ruf(w, HttpMethod.POST, PFAD, anfrage);
        assertThat(a.status()).as(a.body().toString()).isEqualTo(201);
        assertThat(a.body().get("kennzeichen").asText()).isEqualTo("KZ-0001");
        assertThat(a.body().get("name").asText()).isEqualTo("Stromeinsatz je Stück — Halle 2");
        assertThat(a.body().get("zweck").asText()).isEqualTo("Spezifischer Stromeinsatz je gutem Stück");
        assertThat(a.body().get("verantwortlich_name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(a.body().get("fassung").asInt()).isEqualTo(1);
    }

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Kennzahlen #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID st1 = standort(t, u, "Werk Ahrenberg", "ST-1");
        UUID st2 = standort(t, u, "Werk Lindach", "ST-2");
        UUID g2 = gebaeude(t, st1, "Halle 2", "G-2");
        UUID g5 = gebaeude(t, st2, "Halle 5", "G-5");
        UUID p1 = root.queryForObject("INSERT INTO prozess (tenant_id, unternehmen_id, kennzeichen, name, gueltig_ab) "
                + "VALUES (?, ?, 'P-1', 'Spritzguss', '2020-01-01') RETURNING id", UUID.class, t, u);
        messstelle(t, "MS-12", "Montage Linie M1", g2, null);
        messstelle(t, "MS-20", "Prozess Spritzguss gesamt", g2, null);
        messstelle(t, "MS-24", "Spritzguss gesamt inkl. Kühlung", g2, null);
        messstelle(t, "MS-01", "Hauptzähler Werk Ahrenberg", null, st1);
        messstelle(t, "MS-18", "Montage Lindach", g5, null);
        bezugsgroesse(t, "BZ-6", "Gutteile Montage Halle 2", "Stück", "monat", "ort_id", g2, "gebaeude");
        bezugsgroesse(t, "BZ-7", "Gutteile Montage Lindach", "Stück", "monat", "ort_id", g5, "gebaeude");
        bezugsgroesse(t, "BZ-1", "Produktionsmenge Spritzguss", "kg", "monat", "prozess_id", p1, "prozess");
        bezugsgroesse(t, "BZ-9", "Produktionsmenge je Woche", "Stück", "woche", "ort_id", g2, "gebaeude");
        bezugsgroesse(t, "BZ-3", "Betriebsstunden Montage Halle 2", "h", "monat", "ort_id", g2, "gebaeude");
        return new Welt(t, u, st1, st2, g2, g5, p1);
    }

    private static UUID standort(UUID t, UUID u, String name, String kurz) {
        return root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u, name, kurz);
    }

    private static UUID gebaeude(UUID t, UUID standort, String name, String kurz) {
        UUID g = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, 'gebaeude', ?, "
                + "?, 'aktiv') RETURNING id", UUID.class, t, name, kurz);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2020-01-01')", t, g, standort);
        return g;
    }

    private static void messstelle(UUID t, String kennzeichen, String name, UUID ort, UUID standort) {
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, "
                + "einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') "
                + "RETURNING id", UUID.class, t, kennzeichen, name);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, ?, '2020-01-01')", t, ms, ort, standort);
    }

    private static void bezugsgroesse(UUID t, String kennzeichen, String name, String einheit, String periode, String spalte,
            UUID objekt, String geltungArt) {
        root.update("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, geltung_art, "
                + spalte + ") VALUES (?, ?, ?, 'periodenwert', ?, ?, ?, ?)", t, kennzeichen, name, einheit, periode,
                geltungArt, objekt);
    }

    private static UUID bezugsgroesseId(Welt w, String kennzeichen) {
        return root.queryForObject("SELECT id FROM bezugsgroesse WHERE tenant_id = ? AND kennzeichen = ?", UUID.class,
                w.mandant(), kennzeichen);
    }

    /** Ein wirksamer Monatswert, so wie ihn AP-09 IP-7 schreibt. */
    private static void monatswert(Welt w, UUID bg, String einheit, LocalDate monat, String betrag) {
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                + "periode_von, periode_bis, zeitzone, fassung, vorgang, status, betrag, herkunft_art, actor_sub, "
                + "actor_name, actor_rolle, actor_art) VALUES (?, ?, 'periodenwert', ?, 'monat', ?, ?, 'Europe/Berlin', 1, "
                + "'erstwert', 'wirksam', ?, 'eingabe', 'sub-ik', 'Ines Kaltenbach', 'energiemanager', 'kunde')",
                w.mandant(), bg, einheit, monat, monat.plusMonths(1).minusDays(1), new BigDecimal(betrag));
    }

    /** Ein Wert ohne Zahl (noch keine Version), so wie der Rechenlauf ihn anhängt (IP-6). */
    private static void wertAnhaengen(Welt w, UUID kennzahl) {
        UUID fassung = root.queryForObject("SELECT id FROM kennzahl_fassung WHERE kennzahl_id = ? AND nummer = 1", UUID.class,
                kennzahl);
        LocalDate monat = LocalDate.of(2026, 10, 1);
        root.update("INSERT INTO kennzahl_wert (tenant_id, kennzahl_id, periode_art, periode_von, periode_bis, zeitzone, "
                + "version, wert, zaehler, nenner, menge_zustand, kennzeichen, abdeckung_prozent, richtung, grund, zustand, "
                + "endgueltig_ab, definition_fassung_id, berechnet_am, anlass_art, anlass_kennung) VALUES (?, ?, 'monat', ?, "
                + "?, 'Europe/Berlin', NULL, NULL, 6100, NULL, 'keine Werte', '[]'::jsonb, 100, NULL, 'nenner_fehlt', NULL, "
                + "NULL, ?, now(), NULL, NULL)", w.mandant(), kennzahl, monat, monat.plusMonths(1).minusDays(1), fassung);
    }

    private static RechteAbleitung.Benutzer person(String kennung, String name, RechteAbleitung.Rolle rolle, UUID standort) {
        return new RechteAbleitung.Benutzer(kennung, name, RechteAbleitung.Konto.BENUTZER, RechteAbleitung.KontoZustand.AKTIV,
                List.of(new RechteAbleitung.Zuweisung(rolle, List.of(standort.toString()), null, null, Instant.EPOCH, null,
                        null)));
    }

    private JsonNode anlegenKz(Welt w, String kennzeichen, String geltungArt, UUID geltung, String zaehler, String nenner)
            throws Exception {
        Antwort a = ruf(w, HttpMethod.POST, PFAD, anfrage(kennzeichen, "Stromeinsatz " + zaehler + " je " + nenner, "quotient",
                geltungArt, geltung, e("zaehler", "messstelle", zaehler), e("nenner", "bezugsgroesse", nenner)));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(201);
        return a.body();
    }

    private UUID zusammenfassung(Welt w, String kennzeichen, String... paare) throws Exception {
        List<Map<String, Object>> eingaenge = new ArrayList<>();
        for (String p : paare) {
            eingaenge.add(e("paar", "kennzahl", p));
        }
        Map<String, Object> m = anfrage(kennzeichen, "Zusammenfassung " + kennzeichen, "zusammenfassung", "unternehmen",
                w.unternehmen());
        m.put("eingaenge", eingaenge);
        Antwort a = ruf(w, HttpMethod.POST, PFAD, m);
        assertThat(a.status()).as(a.body().toString()).isEqualTo(201);
        return UUID.fromString(a.body().get("id").asText());
    }

    @SafeVarargs
    private static Map<String, Object> anfrage(String kennzeichen, String name, String rechenform, String geltungArt,
            UUID geltungId, Map<String, Object>... eingaenge) {
        Map<String, Object> m = new LinkedHashMap<>();
        if (kennzeichen != null) {
            m.put("kennzeichen", kennzeichen);
        }
        m.put("name", name);
        m.put("rechenform", rechenform);
        m.put("geltung_art", geltungArt);
        m.put("geltung_id", geltungId.toString());
        m.put("eingaenge", List.of(eingaenge));
        return m;
    }

    @SafeVarargs
    private static Map<String, Object> fassung(String ab, String begruendung, Map<String, Object>... eingaenge) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("gueltig_ab", ab);
        m.put("begruendung", begruendung);
        m.put("eingaenge", List.of(eingaenge));
        return m;
    }

    private static Map<String, Object> stammdaten(String kennzeichen, String name, String verantwortlich, String zweck) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", kennzeichen);
        m.put("name", name);
        m.put("verantwortlich_name", verantwortlich);
        m.put("zweck", zweck);
        return m;
    }

    private static Map<String, Object> e(String rolle, String art, String kennzeichen) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("rolle", rolle);
        m.put("art", art);
        m.put("kennzeichen", kennzeichen);
        return m;
    }

    private static Map<String, Object> mit(Map<String, Object> basis, String feld, Object wert) {
        Map<String, Object> m = new LinkedHashMap<>(basis);
        m.put(feld, wert);
        return m;
    }

    private int nummerAm(Welt w, UUID id, String am) throws Exception {
        Antwort a = ruf(w, HttpMethod.GET, PFAD + "/" + id + "/berechnung" + (am == null ? "" : "?am=" + am), null);
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        return a.body().get("fassung").get("nummer").asInt();
    }

    private static UUID id(Antwort liste, String kennzeichen) {
        for (JsonNode k : liste.body().get("kennzahlen")) {
            if (k.get("kennzeichen").asText().equals(kennzeichen)) {
                return UUID.fromString(k.get("id").asText());
            }
        }
        throw new AssertionError(kennzeichen + " fehlt");
    }

    private static String schluessel(LocalDate monat) {
        return BezugsPeriode.schluesselVon(monat, "monat");
    }

    private static List<String> protokoll(UUID kennzahl) {
        return root.queryForList("SELECT art || ':' || CASE WHEN neu IS NULL THEN 'neu leer' ELSE neu::text END "
                + "FROM kennzahl_aenderung WHERE kennzahl_id = ? ORDER BY created_at, id", String.class, kennzahl);
    }

    private static String letzter(UUID kennzahl) {
        List<String> p = protokoll(kennzahl);
        return p.get(p.size() - 1);
    }

    /** Die Kennzahl-Tabellen des Kundenbereichs, Zeile für Zeile. */
    private static String zustand(Welt w) {
        StringBuilder s = new StringBuilder();
        for (String tabelle : List.of("kennzahl", "kennzahl_kennzeichen_verlauf", "kennzahl_fassung", "kennzahl_eingang",
                "kennzahl_wert", "kennzahl_aenderung")) {
            s.append(tabelle).append('=').append(root.queryForObject("SELECT count(*) || ':' || coalesce(md5(string_agg(t::text, "
                    + "'|' ORDER BY t::text)), '-') FROM " + tabelle + " t WHERE t.tenant_id = ?", String.class, w.mandant()))
                    .append('\n');
        }
        return s.toString();
    }

    /**
     * Eine Ablehnung: Code und Status aus dem Vertrag; der Satz ist {@code satz} oder — ohne Angabe — der Satz der
     * Schnittstelle aus dem Vertrag (eine Regel spricht ihren; dann genügt der Code). Nichts ist geschrieben.
     */
    private Antwort abgelehnt(Welt w, HttpMethod methode, String pfad, Object body, String code, String satz)
            throws Exception {
        String vorher = zustand(w);
        Antwort a = ruf(w, methode, pfad, body);
        JsonNode soll = null;
        for (JsonNode x : vertrag.path("schnittstelle").path("ablehnungen")) {
            if (x.path("code").asText().equals(code)) {
                soll = x;
            }
        }
        assertThat(soll).as("Code " + code + " steht im Vertrag").isNotNull();
        assertThat(a.body().path("code").asText()).as(methode + " " + pfad + " → " + a.body()).isEqualTo(code);
        assertThat(a.status()).as(code).isEqualTo(soll.path("status").asInt());
        if (satz != null) {
            assertThat(a.body().path("message").asText()).as("Satz " + code).isEqualTo(satz);
        } else if (!soll.path("satz").isNull() && !soll.path("satz").asText().contains("{")) {
            assertThat(a.body().path("message").asText()).as("Satz " + code).isEqualTo(soll.path("satz").asText());
        } else {
            assertThat(a.body().path("message").asText()).as("Satz " + code).isNotBlank();
        }
        assertThat(zustand(w)).as("die Ablehnung " + code + " schreibt nichts").isEqualTo(vorher);
        return a;
    }

    private String abgelehntMitFeld(Welt w, HttpMethod methode, String pfad, Object body, String code, String feld)
            throws Exception {
        assertThat(abgelehnt(w, methode, pfad, body, code, null).body().path("feld").asText()).as(code).isEqualTo(feld);
        return code;
    }

    private static List<String> felder(JsonNode n) {
        List<String> aus = new ArrayList<>();
        n.fieldNames().forEachRemaining(aus::add);
        return aus;
    }

    private static List<String> texte(JsonNode liste) {
        List<String> aus = new ArrayList<>();
        liste.forEach(x -> aus.add(x.asText()));
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
