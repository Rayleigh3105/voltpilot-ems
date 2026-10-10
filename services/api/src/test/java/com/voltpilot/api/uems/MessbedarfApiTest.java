package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantContext;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/** AP-16 R5/P1/P2: Messbedarf von MB-1 über MS-23 bis Register und Messabdeckungs-Naht. */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class MessbedarfApiTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String ENERGIE = "/api/v1/unternehmen/energieeinsaetze";
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");
    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "ip19_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "ip19_test_pw");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> "http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/certs");
    }

    @Autowired MockMvc mvc;
    @Autowired BewertungMessbedarfNaht naht;
    static JdbcTemplate root;
    UUID tenant, unternehmen, standort, fremderStandort, prozess, ms23, entwurf, einsatz;

    @BeforeAll static void start() {
        root = new JdbcTemplate(new DriverManagerDataSource(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @BeforeEach void welt() throws Exception {
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Ahrenberg IP-19') RETURNING id", UUID.class);
        unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name) VALUES (?,'Kunststoffwerk Ahrenberg') RETURNING id",
                UUID.class, tenant);
        standort = standort("ST-1");
        fremderStandort = standort("ST-2");
        benutzer("IK", "Ines Kaltenbach", "energiemanager", null);
        benutzer("PH", "Peter Hollerbach", "bearbeiter", fremderStandort);
        prozess = root.queryForObject("INSERT INTO prozess(tenant_id,unternehmen_id,kennzeichen,name,gueltig_ab) "
                + "VALUES (?,?,'P-8','Druckluft','2024-01-01') RETURNING id", UUID.class, tenant, unternehmen);
        ms23 = messstelle("MS-23", "Druckluftzähler", standort, true);
        entwurf = messstelle("MS-99", "Noch nicht eingerichtet", null, false);
        root.update("INSERT INTO messstelle_prozess(tenant_id,messstelle_id,prozess_id,gueltig_ab) VALUES (?,?,?,'2024-01-01')",
                tenant, ms23, prozess);
        root.update("INSERT INTO energieeinsatz_kennzeichen_seq(tenant_id,zaehler) VALUES (?,7)", tenant);
        JsonNode e = ruf("POST", ENERGIE, "IK", Map.of("prozess_id", prozess.toString(), "traeger", "Strom",
                "name", "Drucklufterzeugung", "gueltig_ab", "2026-01-01"), 201);
        assertThat(e.path("kennzeichen").asText()).isEqualTo("EE-8");
        einsatz = UUID.fromString(e.path("id").asText());
    }

    @Test void r5ErfassenEinloesenRegisterEreignisseUndZaun() throws Exception {
        String basis = ENERGIE + "/" + einsatz + "/messbedarf";
        JsonNode b = ruf("POST", basis, "IK", Map.of("wortlaut", "Druckluftverbrauch der Blasmaschinen",
                "ort", "Halle 2", "groesse", "Wirkenergie", "frist", "2026-10-31"), 201);
        assertThat(b.path("kennzeichen").asText()).isEqualTo("MB-1");
        UUID bedarf = UUID.fromString(b.path("id").asText());
        assertThat(offene()).singleElement().satisfies(p -> {
            assertThat(p.einsatzId()).isEqualTo(einsatz);
            assertThat(p.kennzeichen()).isEqualTo("MB-1");
        });

        ablehnung("POST", basis + "/" + bedarf + "/einloesen", Map.of("messstelle_id", entwurf),
                422, "messstelle_nicht_eingerichtet");
        UUID fremd = fremdeMessstelle();
        ablehnung("POST", basis + "/" + bedarf + "/einloesen", Map.of("messstelle_id", fremd),
                404, "nicht_gefunden");
        JsonNode erledigt = ruf("POST", basis + "/" + bedarf + "/einloesen", "IK",
                Map.of("messstelle_id", ms23), 200);
        assertThat(erledigt.path("zustand").asText()).isEqualTo("eingeloest");
        assertThat(erledigt.at("/messstelle/kennzeichen").asText()).isEqualTo("MS-23");
        assertThat(offene()).isEmpty();

        JsonNode register = ruf("GET", "/api/v1/messstellen?geplantFuerEinsatz=true", "IK", null, 200);
        assertThat(register.path("register")).hasSize(1);
        JsonNode zeile = register.path("register").get(0);
        assertThat(zeile.path("kennzeichen").asText()).isEqualTo("MS-23");
        assertThat(zeile.at("/geplant_fuer_einsaetze/0/kennzeichen").asText()).isEqualTo("EE-8");
        assertThat(zeile.at("/quelle/stand").asText()).isEqualTo("keine_datenquelle");
        assertThat(zeile.path("letzter_wert").isNull()).isTrue();

        assertThat(ruf("GET", basis, "PH", null, 404).path("code").asText()).isEqualTo("nicht_gefunden");
        ruf("POST", basis, "PH", Map.of("wortlaut", "außerhalb"), 403);
        assertThat(root.queryForList("SELECT art FROM messreihe_ereignis WHERE tenant_id=? ORDER BY zeit", String.class, tenant))
                .containsExactlyInAnyOrder("messbedarf_erfasst", "messbedarf_eingeloest");
        JsonNode protokoll = ruf("GET", basis + "/" + bedarf + "/protokoll", "IK", null, 200);
        assertThat(protokoll.path("aenderungen").get(0).path("art").asText()).isEqualTo("erfasst");
        assertThat(protokoll.path("aenderungen").get(1).path("art").asText()).isEqualTo("eingeloest");
        protokoll.path("aenderungen").forEach(a -> assertThat(a.at("/akteur/name").asText())
                .isEqualTo("Ines Kaltenbach"));
    }

    @Test void verwerfenBrauchtBegruendungUndBleibtLesbar() throws Exception {
        String basis = ENERGIE + "/" + einsatz + "/messbedarf";
        JsonNode b = ruf("POST", basis, "IK", Map.of("wortlaut", "Abwärme erfassen"), 201);
        String pfad = basis + "/" + b.path("id").asText();
        ablehnung("POST", pfad + "/verwerfen", Map.of("begruendung", " "), 422, "begruendung_fehlt");
        JsonNode verworfen = ruf("POST", pfad + "/verwerfen", "IK",
                Map.of("begruendung", "Wird im Anlagenumbau ersetzt"), 200);
        assertThat(verworfen.path("zustand").asText()).isEqualTo("verworfen");
        assertThat(ruf("GET", basis, "IK", null, 200).path("messbedarfe").get(0).path("zustand").asText())
                .isEqualTo("verworfen");
        ablehnung("POST", pfad + "/verwerfen", Map.of("begruendung", "noch einmal"),
                409, "messbedarf_abgeschlossen");
    }

    @Test void offboardingRaeumtBedarfProtokollUndZaehlerVorDemEinsatzAb() throws Exception {
        String basis = ENERGIE + "/" + einsatz + "/messbedarf";
        ruf("POST", basis, "IK", Map.of("wortlaut", "Messung für den Umbau"), 201);
        for (String tabelle : List.of("messbedarf", "messbedarf_aenderung", "messbedarf_kennzeichen_seq")) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid=?::regclass",
                    Boolean.class, tabelle)).as(tabelle).isTrue();
            assertThat(root.queryForObject("SELECT has_table_privilege('voltpilot_app',?,'DELETE')",
                    Boolean.class, tabelle)).as(tabelle).isFalse();
        }
        new TenantRepository(root).offboard(tenant);
        assertThat(root.queryForObject("SELECT count(*) FROM tenant WHERE id=?", Integer.class, tenant)).isZero();
        for (String tabelle : List.of("messbedarf", "messbedarf_aenderung", "messbedarf_kennzeichen_seq")) {
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id=?",
                    Integer.class, tenant)).as(tabelle).isZero();
        }
    }

    /**
     * Befund IP-20: Ort und Größe als Struktur — optional, im Katalog geprüft, Wortlaut daraus abgeleitet —, die
     * Standort-Route mit Zaun und das Bearbeiten eines offenen Bedarfs mit Protokoll.
     */
    @Test void strukturOptionalStandortRouteUndBearbeiten() throws Exception {
        String basis = ENERGIE + "/" + einsatz + "/messbedarf";
        UUID halle1 = gebaeude("G-1", "Halle 1", standort);
        UUID nord = bereich("B-1", "Halle 1 Nord", halle1);

        JsonNode g = ruf("POST", basis, "IK", Map.of("wortlaut", "Druckluft der Blasmaschinen",
                "ort_id", nord, "messgroesse", "Wirkenergie", "richtung", "Bezug"), 201);
        assertThat(g.path("ort").asText()).isEqualTo("B-1");
        assertThat(g.path("groesse").asText()).isEqualTo("Wirkenergie · Bezug");
        assertThat(g.path("messgroesse").asText()).isEqualTo("Wirkenergie");
        assertThat(g.path("richtung").asText()).isEqualTo("Bezug");
        assertThat(g.at("/ort_ziel/art").asText()).isEqualTo("bereich");
        assertThat(g.at("/ort_ziel/name").asText()).isEqualTo("Halle 1 Nord");
        assertThat(g.at("/ort_ziel/standort_id").asText()).isEqualTo(standort.toString());
        assertThat(g.at("/ort_ziel/standort_name").asText()).isEqualTo("ST-1");
        JsonNode s = ruf("POST", basis, "IK", Map.of("wortlaut", "Hauptzuleitung", "ort_id", standort,
                "ort", "Werk (Einspeisung)", "messgroesse", "Wirkleistung"), 201);
        assertThat(s.path("ort").asText()).as("ein mitgegebener Wortlaut bleibt").isEqualTo("Werk (Einspeisung)");
        assertThat(s.path("groesse").asText()).isEqualTo("Wirkleistung");
        assertThat(s.path("richtung").isNull()).isTrue();
        assertThat(s.at("/ort_ziel/art").asText()).isEqualTo("standort");
        assertThat(s.at("/ort_ziel/standort_id").asText()).isEqualTo(standort.toString());
        JsonNode anderswo = ruf("POST", basis, "IK", Map.of("wortlaut", "Kältemaschine", "ort_id", fremderStandort), 201);
        assertThat(anderswo.path("groesse").isNull()).isTrue();
        JsonNode wort = ruf("POST", basis, "IK", Map.of("wortlaut", "Abwärme", "ort", "Halle 2",
                "groesse", "Wärme"), 201);
        assertThat(wort.path("ort_ziel").isNull()).isTrue();
        assertThat(wort.path("messgroesse").isNull()).isTrue();

        ablehnung("POST", basis, Map.of("wortlaut", "x", "richtung", "Bezug"), 422, "groesse_ungueltig");
        ablehnung("POST", basis, Map.of("wortlaut", "x", "messgroesse", "Temperatur"), 422, "groesse_ungueltig");
        ablehnung("POST", basis, Map.of("wortlaut", "x", "messgroesse", "Volumen", "richtung", "Abgabe"),
                422, "groesse_ungueltig");
        ablehnung("POST", basis, Map.of("wortlaut", "x", "ort_id", UUID.randomUUID()), 422, "ort_unbekannt");
        UUID fremd = root.queryForObject("INSERT INTO tenant(name) VALUES ('Fremd Ort') RETURNING id", UUID.class);
        UUID fremdU = root.queryForObject("INSERT INTO unternehmen(tenant_id,name) VALUES (?,'Fremd') RETURNING id",
                UUID.class, fremd);
        UUID fremderOrt = root.queryForObject("INSERT INTO standort(tenant_id,unternehmen_id,name,kurzzeichen,zeitzone,zustand) "
                + "VALUES (?,?,'Fremd','ST-1','Europe/Berlin','aktiv') RETURNING id", UUID.class, fremd, fremdU);
        ablehnung("POST", basis, Map.of("wortlaut", "x", "ort_id", fremderOrt), 422, "ort_unbekannt");
        ruf("POST", basis, "IK", Map.of("wortlaut", "x", "ort_id", "kein-ort"), 400);

        String uebersicht = "/api/v1/unternehmen/messbedarf";
        assertThat(kennzeichen(ruf("GET", uebersicht + "?standort=" + standort, "IK", null, 200)))
                .containsExactly(g.path("kennzeichen").asText(), s.path("kennzeichen").asText());
        assertThat(kennzeichen(ruf("GET", uebersicht + "?standort=" + fremderStandort, "IK", null, 200)))
                .containsExactly(anderswo.path("kennzeichen").asText());
        assertThat(kennzeichen(ruf("GET", uebersicht, "IK", null, 200))).containsExactly(g.path("kennzeichen").asText(),
                s.path("kennzeichen").asText(), anderswo.path("kennzeichen").asText(), wort.path("kennzeichen").asText());
        assertThat(ruf("GET", uebersicht + "?standort=" + UUID.randomUUID(), "IK", null, 404).path("code").asText())
                .isEqualTo("nicht_gefunden");
        ruf("GET", uebersicht + "?standort=" + fremderOrt, "IK", null, 404);
        ruf("GET", uebersicht + "?standort=kaputt", "IK", null, 400);
        // PH hat nur ST-2: ST-1 ist außerhalb seines Zauns (404), und den Einsatz (MS-23 an ST-1) sieht er nicht.
        ruf("GET", uebersicht + "?standort=" + standort, "PH", null, 404);
        assertThat(ruf("GET", uebersicht + "?standort=" + fremderStandort, "PH", null, 200).path("messbedarfe")).isEmpty();
        assertThat(ruf("GET", uebersicht, "PH", null, 200).path("messbedarfe")).isEmpty();
        // Die Messabdeckung liest weiter den Wortlaut — beim strukturierten Bedarf das abgeleitete Kurzzeichen.
        assertThat(offene()).extracting(BewertungMessbedarfNaht.Bedarf::ort).contains("B-1", "Halle 2");

        String pfad = basis + "/" + g.path("id").asText();
        JsonNode b = ruf("PUT", pfad, "IK", Map.of("wortlaut", "Druckluft aller Blasmaschinen", "ort_id", halle1,
                "messgroesse", "Wirkenergie", "richtung", "Bezug", "frist", "2026-12-31"), 200);
        assertThat(b.path("ort").asText()).isEqualTo("G-1");
        assertThat(b.at("/ort_ziel/art").asText()).isEqualTo("gebaeude");
        assertThat(b.path("frist").asText()).isEqualTo("2026-12-31");
        ablehnung("PUT", pfad, Map.of("wortlaut", "x", "messgroesse", "Ladestand", "richtung", "Bezug"),
                422, "groesse_ungueltig");
        JsonNode protokoll = ruf("GET", pfad + "/protokoll", "IK", null, 200).path("aenderungen");
        assertThat(protokoll).extracting(a -> a.path("art").asText()).containsExactly("erfasst", "bearbeitet");
        assertThat(protokoll.get(1).at("/alt/ort_id").asText()).isEqualTo(nord.toString());
        assertThat(protokoll.get(1).at("/neu/ort_id").asText()).isEqualTo(halle1.toString());
        assertThat(protokoll.get(1).at("/neu/wortlaut").asText()).isEqualTo("Druckluft aller Blasmaschinen");

        String verworfen = basis + "/" + anderswo.path("id").asText();
        ruf("POST", verworfen + "/verwerfen", "IK", Map.of("begruendung", "Doppelt erfasst"), 200);
        ablehnung("PUT", verworfen, Map.of("wortlaut", "doch noch"), 409, "messbedarf_abgeschlossen");
        assertThat(root.queryForObject("SELECT count(*) FROM messbedarf WHERE tenant_id=? AND num_nonnulls(standort_id, ort_id) > 1",
                Integer.class, tenant)).isZero();
    }

    /** Ein Bedarf aus der Fassung vor der Struktur (nur Wortlaut) bleibt unverändert lesbar und steht an keinem Standort. */
    @Test void bestandOhneStrukturBleibtLesbar() throws Exception {
        root.update("INSERT INTO messbedarf(tenant_id,einsatz_id,wortlaut,ort,groesse,frist,actor_sub,actor_name,actor_rolle,actor_art) "
                + "VALUES (?,?,'Wärmemenge Halle 1','G-1','Wirkenergie · Bezug','2026-11-30','IK','Ines Kaltenbach',"
                + "'energiemanager','kunde')", tenant, einsatz);
        JsonNode liste = ruf("GET", ENERGIE + "/" + einsatz + "/messbedarf", "IK", null, 200).path("messbedarfe");
        assertThat(liste).hasSize(1);
        JsonNode b = liste.get(0);
        assertThat(b.path("kennzeichen").asText()).isEqualTo("MB-1");
        assertThat(b.path("ort").asText()).isEqualTo("G-1");
        assertThat(b.path("groesse").asText()).isEqualTo("Wirkenergie · Bezug");
        assertThat(b.path("frist").asText()).isEqualTo("2026-11-30");
        assertThat(b.path("ort_ziel").isNull()).isTrue();
        assertThat(b.path("messgroesse").isNull()).isTrue();
        assertThat(b.path("richtung").isNull()).isTrue();
        assertThat(kennzeichen(ruf("GET", "/api/v1/unternehmen/messbedarf", "IK", null, 200))).containsExactly("MB-1");
        assertThat(ruf("GET", "/api/v1/unternehmen/messbedarf?standort=" + standort, "IK", null, 200)
                .path("messbedarfe")).isEmpty();
    }

    /**
     * Review r4 M4: jede Antwort nennt {@code zitiert_von} und {@code einloesbar}, damit das Portal VOR dem Anlegen einer
     * Messstelle weiß, dass ein freigegebener Stand den Bedarf zitiert. {@code zitiert_von} ist die Liste der 409
     * {@code berichts_belege} (nach Kennung und Nr.) und in jedem Zustand gefüllt; einlösbar ist nur offen und unzitiert.
     */
    @Test void zitiertVonUndEinloesbarNennenDenBelegschutzVorDemEinrichten() throws Exception {
        String basis = ENERGIE + "/" + einsatz + "/messbedarf";
        JsonNode frei = ruf("POST", basis, "IK", Map.of("wortlaut", "Druckluft Halle 2"), 201);
        assertThat(frei.path("einloesbar").isBoolean()).isTrue();
        assertThat(frei.path("einloesbar").asBoolean()).isTrue();
        assertThat(frei.path("zitiert_von").isArray()).isTrue();
        assertThat(frei.path("zitiert_von")).isEmpty();
        UUID zitiert = id(ruf("POST", basis, "IK", Map.of("wortlaut", "Abwärme der Kompressoren"), 201));
        UUID erledigt = id(ruf("POST", basis, "IK", Map.of("wortlaut", "Hauptzähler Druckluft"), 201));
        UUID verworfen = id(ruf("POST", basis, "IK", Map.of("wortlaut", "Leckage-Ortung"), 201));
        JsonNode eingeloest = ruf("POST", basis + "/" + erledigt + "/einloesen", "IK", Map.of("messstelle_id", ms23), 200);
        assertThat(eingeloest.path("einloesbar").asBoolean(true)).isFalse();
        assertThat(eingeloest.path("zitiert_von")).isEmpty();
        ruf("POST", basis + "/" + verworfen + "/verwerfen", "IK", Map.of("begruendung", "Doppelt erfasst"), 200);

        // Freigegeben, in umgekehrter Reihenfolge angelegt: BR-2026-0002 Nr. 1 zitiert MB-2 und den verworfenen MB-4,
        // BR-2026-0001 Nr. 1 und Nr. 2 zitieren MB-2. Ein Entwurf schützt nichts.
        UUID zweiter = bewertung("BR-2026-0002", "2025-10/2026-09");
        stand(zweiter, 1, zitiert, verworfen);
        UUID erster = bewertung("BR-2026-0001", "2025-01/2025-12");
        stand(erster, 1, zitiert);
        stand(erster, 2, zitiert);
        quelle(bewertung("BR-2026-0003", "2026-01/2026-09"), null, id(frei));

        List<Map<String, Object>> staende = List.of(Map.of("kennung", "BR-2026-0001", "nr", 1),
                Map.of("kennung", "BR-2026-0001", "nr", 2), Map.of("kennung", "BR-2026-0002", "nr", 1));
        for (String pfad : List.of(basis, "/api/v1/unternehmen/messbedarf")) {
            Map<String, JsonNode> je = new java.util.HashMap<>();
            ruf("GET", pfad, "IK", null, 200).path("messbedarfe").forEach(b -> je.put(b.path("kennzeichen").asText(), b));
            assertThat(je.keySet()).as(pfad).containsExactlyInAnyOrder("MB-1", "MB-2", "MB-3", "MB-4");
            assertThat(je.get("MB-1").path("einloesbar").asBoolean()).as(pfad).isTrue();
            assertThat(je.get("MB-1").path("zitiert_von")).as(pfad).isEmpty();
            assertThat(je.get("MB-2").path("einloesbar").asBoolean(true)).as(pfad).isFalse();
            assertThat(JSON.convertValue(je.get("MB-2").path("zitiert_von"), List.class)).as(pfad).isEqualTo(staende);
            assertThat(je.get("MB-3").path("einloesbar").asBoolean(true)).as(pfad).isFalse();
            assertThat(je.get("MB-3").path("zitiert_von")).as(pfad).isEmpty();
            assertThat(je.get("MB-4").path("einloesbar").asBoolean(true)).as(pfad).isFalse();
            assertThat(JSON.convertValue(je.get("MB-4").path("zitiert_von"), List.class)).as(pfad)
                    .isEqualTo(List.of(Map.of("kennung", "BR-2026-0002", "nr", 1)));
        }
        // Die Regel des Belegschutzes bleibt: Einlösen scheitert, und die 409 nennt dieselbe Liste.
        JsonNode abgelehnt = ruf("POST", basis + "/" + zitiert + "/einloesen", "IK", Map.of("messstelle_id", ms23), 409);
        assertThat(abgelehnt.path("code").asText()).isEqualTo("berichts_belege");
        assertThat(JSON.convertValue(abgelehnt.path("berichtsstaende"), List.class)).isEqualTo(staende);
        // Bearbeiten eines unzitierten Bedarfs antwortet mit denselben Feldern.
        JsonNode bearbeitet = ruf("PUT", basis + "/" + id(frei), "IK", Map.of("wortlaut", "Druckluft Halle 2 und 3"), 200);
        assertThat(bearbeitet.path("einloesbar").asBoolean()).isTrue();
        assertThat(bearbeitet.path("zitiert_von")).isEmpty();
    }

    private static UUID id(JsonNode bedarf) {
        return UUID.fromString(bedarf.path("id").asText());
    }

    /** Eine energetische Bewertung, wie das Anlegen sie schreibt, ohne Stand; je Datengrundlage eine. */
    private UUID bewertung(String kennung, String datengrundlage) {
        return root.queryForObject("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, geltung_art, "
                + "unternehmen_id, zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_name) VALUES (?, ?, "
                + "'energetische_bewertung', 1, 'unternehmen', ?, 'datengrundlage', ?, 'Europe/Berlin', 'Ines Kaltenbach') "
                + "RETURNING id", UUID.class, tenant, kennung, unternehmen, datengrundlage);
    }

    /** Ein freigegebener Stand, der die Bedarfe unmittelbar zitiert (Muster {@code EnergiemanagementWiedervorlageApiTest}). */
    private void stand(UUID bericht, int nr, UUID... bedarfe) {
        String abzug = "{\"bericht\":\"" + bericht + "\",\"nr\":" + nr + "}";
        root.update("INSERT INTO bericht_stand (tenant_id, bericht_id, nr, abzug, pruefsumme, datenstand, freigegeben_am, "
                + "freigeber_sub, freigeber_name, freigeber_rolle, darstellung, regelwerk, vorlage_fassung) VALUES "
                + "(?, ?, ?, ?, ?, '2026-10-01T08:00:00Z', '2026-10-01T08:05:00Z', 'IK', 'Ines Kaltenbach', "
                + "'energiemanager', '{}'::jsonb, '{}'::jsonb, 1)", tenant, bericht, nr, abzug,
                BerichtRegeln.pruefsumme(abzug));
        for (UUID b : bedarfe) quelle(bericht, nr, b);
    }

    /** {@code nr = null}: die Quelle des Entwurfs. */
    private void quelle(UUID bericht, Integer nr, UUID bedarf) {
        root.update("INSERT INTO bericht_quelle (tenant_id, bericht_id, stand_nr, art, kennzeichen, objekt_id, bezug, "
                + "erster_tag, letzter_tag, version, fassung, name_zum_datenstand) SELECT ?, ?, ?, 'messbedarf', "
                + "kennzeichen, id, 'unmittelbar', '2026-01-01', '2026-09-30', NULL, NULL, wortlaut FROM messbedarf "
                + "WHERE id = ?", tenant, bericht, nr, bedarf);
    }

    private static List<String> kennzeichen(JsonNode liste) {
        List<String> aus = new java.util.ArrayList<>();
        liste.path("messbedarfe").forEach(b -> aus.add(b.path("kennzeichen").asText()));
        return aus;
    }

    private UUID gebaeude(String kurzzeichen, String name, UUID st) {
        UUID id = root.queryForObject("INSERT INTO ort(tenant_id,art,name,kurzzeichen,zustand) VALUES (?,'gebaeude',?,?,'aktiv') "
                + "RETURNING id", UUID.class, tenant, name, kurzzeichen);
        root.update("INSERT INTO ort_zuordnung(tenant_id,ort_id,eltern_standort_id,gueltig_ab) VALUES (?,?,?,'2024-01-01')",
                tenant, id, st);
        return id;
    }

    private UUID bereich(String kurzzeichen, String name, UUID eltern) {
        UUID id = root.queryForObject("INSERT INTO ort(tenant_id,art,name,kurzzeichen,zustand) VALUES (?,'bereich',?,?,'aktiv') "
                + "RETURNING id", UUID.class, tenant, name, kurzzeichen);
        root.update("INSERT INTO ort_zuordnung(tenant_id,ort_id,eltern_ort_id,gueltig_ab) VALUES (?,?,?,'2024-01-01')",
                tenant, id, eltern);
        return id;
    }

    private void ablehnung(String method, String path, Object body, int status, String code) throws Exception {
        assertThat(ruf(method, path, "IK", body, status).path("code").asText()).isEqualTo(code);
    }

    private List<BewertungMessbedarfNaht.Bedarf> offene() {
        TenantContext.set(tenant);
        try {
            return naht.offene(null, null);
        } finally {
            TenantContext.clear();
        }
    }

    private JsonNode ruf(String method, String path, String sub, Object body, int status) throws Exception {
        Jwt token = Jwt.withTokenValue("test").header("alg", "none").subject(sub).issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600)).claim("tenant_id", tenant.toString())
                .claim("realm_access", Map.of("roles", List.of()))
                .claim("name", sub.equals("IK") ? "Ines Kaltenbach" : "Peter Hollerbach").build();
        var anfrage = request(HttpMethod.valueOf(method), path)
                .with(authentication(new KeycloakRealmRoleConverter().convert(token)));
        if (body != null) anfrage.contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        var antwort = mvc.perform(anfrage).andReturn().getResponse();
        assertThat(antwort.getStatus()).as(method + " " + path + " " + antwort.getContentAsString()).isEqualTo(status);
        return JSON.readTree(antwort.getContentAsString(StandardCharsets.UTF_8));
    }

    private UUID standort(String kennzeichen) {
        return root.queryForObject("INSERT INTO standort(tenant_id,unternehmen_id,name,kurzzeichen,zeitzone,zustand) "
                + "VALUES (?,?,?,?,'Europe/Berlin','aktiv') RETURNING id", UUID.class,
                tenant, unternehmen, kennzeichen, kennzeichen);
    }

    private void benutzer(String sub, String name, String rolle, UUID ort) {
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,?,'benutzer',?,'aktiv')",
                tenant, sub, name);
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,standort_id,gueltig_ab,zeitzone) "
                + "VALUES (?,?,?,?, '2024-01-01','Europe/Berlin')", tenant, sub, rolle, ort);
    }

    private UUID messstelle(String kennzeichen, String name, UUID ort, boolean eingerichtet) {
        UUID id = root.queryForObject("INSERT INTO messstelle(tenant_id,kennzeichen,name,art,medium,groesse,richtung,einheit,wertart) "
                + "VALUES (?,?,?,'gemessen','Strom','Wirkenergie','Bezug','kWh','Zählerstand') RETURNING id",
                UUID.class, tenant, kennzeichen, name);
        if (ort != null) root.update("INSERT INTO messstelle_ort(tenant_id,messstelle_id,standort_id,gueltig_ab) "
                + "VALUES (?,?,?,'2024-01-01')", tenant, id, ort);
        assertThat(eingerichtet).isEqualTo(ort != null);
        return id;
    }

    private UUID fremdeMessstelle() {
        UUID t = root.queryForObject("INSERT INTO tenant(name) VALUES ('Fremd IP-19') RETURNING id", UUID.class);
        return root.queryForObject("INSERT INTO messstelle(tenant_id,kennzeichen,name,art,medium,groesse,richtung,einheit,wertart) "
                + "VALUES (?,'MS-23','Fremd','gemessen','Strom','Wirkenergie','Bezug','kWh','Zählerstand') RETURNING id",
                UUID.class, t);
    }
}
