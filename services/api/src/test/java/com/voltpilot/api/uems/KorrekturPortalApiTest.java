package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import java.nio.charset.StandardCharsets;
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
import org.springframework.security.core.authority.SimpleGrantedAuthority;
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

@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class KorrekturPortalApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String VIERAUGEN = "/api/v1/unternehmen/vieraugen";
    private static final String BEGRUENDUNG = "Nachlieferung nach Endgültigkeit (Box Halle 2 repariert)";

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
        registry.add("voltpilot.admin-datasource.url", POSTGRES::getJdbcUrl);
        registry.add("voltpilot.admin-datasource.username", () -> "voltpilot_admin");
        registry.add("voltpilot.admin-datasource.password", () -> "voltpilot_admin_test_pw");
        registry.add("spring.flyway.placeholders.adminDbPassword", () -> "voltpilot_admin_test_pw");
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot");
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot/protocol/openid-connect/certs");
    }

    @Autowired MockMvc mvc;
    @Autowired ViertelstundeVerdichter verdichter;
    @Autowired ErsatzwertLauf lauf;
    @Autowired KorrekturKaskade kaskade;
    @Autowired KorrekturPortalService portal;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Wer(String sub, String name, UUID kundenbereich, boolean plattform) {}

    private record Antwort(int status, JsonNode body) {}

    /** Ein Kundenbereich mit Unternehmen und seinen drei Personen. */
    private record Welt(UUID mandant, Wer ines, Wer jonas, Wer voss) {

        String korrektur(String kennung) {
            return "/api/v1/korrekturen/" + kennung;
        }
    }

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }


    private static final String KANAL = "deye.hybrid_1p.meter.generator-energy";
    private static final java.time.Instant VON = java.time.Instant.parse("2026-11-10T08:00:00Z");
    private static final java.time.Instant JETZT = java.time.Instant.parse("2026-11-12T00:00:00Z");
    private record Ort(Welt w, UUID standort, UUID entity, UUID quelle) {}

    @Test
    void vorschauIstLesendUndFreigabeRechnetGenauDenAngezeigtenWertMitWiderruf() throws Exception {
        Ort o = ort(false);
        var e = eingabe(o);
        long vorher = zahl("messreihe_ersatzwert", o);
        var p = ok(ruf(o.w().ines(), HttpMethod.POST, "/api/v1/messstellen/MS-10/ersatzwerte/vorschau", e));
        assertThat(zahl("messreihe_ersatzwert", o)).isEqualTo(vorher);
        assertThat(versionen(o)).isZero();
        assertThat(p.path("perioden").get(0).path("neu").path("menge").decimalValue()).isEqualByComparingTo("20");
        var k = ok(ruf(o.w().ines(), HttpMethod.POST, "/api/v1/messstellen/MS-10/ersatzwerte", e));
        assertThat(k.path("status").asText()).isEqualTo("freigegeben");
        assertThat(versionen(o)).isZero();
        lauf.lauf(JETZT);
        assertThat(neueste(o)).isEqualByComparingTo(p.path("perioden").get(0).path("neu").path("menge").decimalValue());
        var liste = ok(ruf(o.w().ines(), HttpMethod.GET, "/api/v1/standorte/" + o.standort() + "/korrekturen", null));
        assertThat(liste.size()).isEqualTo(1);
        var detail = ok(ruf(o.w().ines(), HttpMethod.GET, "/api/v1/korrekturen/" + k.path("kennung").asText(), null));
        assertThat(detail.path("vorschau")).isEqualTo(k.path("vorschau"));
        assertThat(detail.path("auswirkungen").path("perioden").size()).isEqualTo(3);
        ok(ruf(o.w().ines(), HttpMethod.POST, "/api/v1/ersatzwerte/" + k.path("ersatzwert_kennung").asText()
                + "/zuruecknehmen", Map.of("grund", "Beleg wurde anschließend berichtigt")));
        lauf.lauf(JETZT);
        assertThat(neueste(o)).isEqualByComparingTo("15");
        assertThat(versionen(o)).isEqualTo(2);
    }

    @Test
    void vierAugenHaeltWerteZurueckUndZeigtDerErstellerinDenZustand() throws Exception {
        Ort o = ort(true);
        var k = ok(ruf(o.w().ines(), HttpMethod.POST, "/api/v1/messstellen/MS-10/ersatzwerte", eingabe(o)));
        String pfad = "/api/v1/korrekturen/" + k.path("kennung").asText();
        assertThat(k.path("status").asText()).isEqualTo("vorschlag");
        assertThat(k.path("freigeben").path("erlaubt").asBoolean()).isFalse();
        assertThat(k.path("freigeben").path("grund").asText()).isEqualTo("zweite_person_noetig");
        lauf.lauf(JETZT); kaskade.lauf(JETZT);
        assertThat(versionen(o)).isZero();
        assertThat(ruf(o.w().ines(), HttpMethod.POST, pfad + "/freigeben", Map.of("begruendung", BEGRUENDUNG)).status()).isEqualTo(403);
        assertThat(ruf(o.w().voss(), HttpMethod.POST, pfad + "/freigeben", Map.of("begruendung", BEGRUENDUNG)).status()).isEqualTo(403);
        ok(ruf(o.w().jonas(), HttpMethod.POST, pfad + "/freigeben", Map.of("begruendung", BEGRUENDUNG)));
        lauf.lauf(JETZT);
        assertThat(neueste(o)).isEqualByComparingTo(k.path("vorschau").get(0).path("neu").path("menge").decimalValue());
        ok(ruf(o.w().jonas(), HttpMethod.POST, pfad + "/zuruecknehmen", Map.of("grund", BEGRUENDUNG)));
        lauf.lauf(JETZT);
        assertThat(neueste(o)).isEqualByComparingTo("15");
    }

    @Test
    void ablehnenBleibtAppendOnlyUndOhneWirkung() throws Exception {
        Ort o = ort(true);
        var k = ok(ruf(o.w().ines(), HttpMethod.POST, "/api/v1/messstellen/MS-10/ersatzwerte", eingabe(o)));
        String pfad = "/api/v1/korrekturen/" + k.path("kennung").asText();
        var ab = ok(ruf(o.w().jonas(), HttpMethod.POST, pfad + "/ablehnen", Map.of("grund", "Beleg gehört nicht zu diesem Zähler")));
        assertThat(ab.path("status").asText()).isEqualTo("abgelehnt");
        assertThat(ab.path("fassung").asInt()).isEqualTo(2);
        lauf.lauf(JETZT); kaskade.lauf(JETZT);
        assertThat(versionen(o)).isZero();
        assertThat(zahl("messreihe_ersatzwert", o)).isEqualTo(2);
        assertThat(ruf(o.w().jonas(), HttpMethod.POST, pfad + "/freigeben", Map.of("begruendung", BEGRUENDUNG)).status()).isEqualTo(409);
    }

    @Test
    void fremderStandortUndFremdeKorrekturSind404() throws Exception {
        Ort a = ort(false), b = ort(false);
        var k = ok(ruf(a.w().ines(), HttpMethod.POST, "/api/v1/messstellen/MS-10/ersatzwerte", eingabe(a)));
        assertThat(ruf(b.w().ines(), HttpMethod.GET, "/api/v1/standorte/" + a.standort() + "/korrekturen", null).status()).isEqualTo(404);
        assertThat(ruf(b.w().ines(), HttpMethod.GET, "/api/v1/korrekturen/" + k.path("kennung").asText(), null).status()).isEqualTo(404);
        assertThat(ruf(b.w().ines(), HttpMethod.POST, "/api/v1/ersatzwerte/" + k.path("ersatzwert_kennung").asText()
                + "/zuruecknehmen", Map.of("grund", BEGRUENDUNG)).status()).isEqualTo(404);
        assertThat(ruf(a.w().voss(), HttpMethod.POST, "/api/v1/messstellen/MS-10/ersatzwerte", eingabe(a)).status()).isEqualTo(403);
    }

    @Test
    void unpassendeMethodeUndFremdeQuelleSchreibenNichts() throws Exception {
        Ort o = ort(false);
        var falsch = new java.util.LinkedHashMap<String, Object>(eingabe(o));
        falsch.put("methode", "gleichmaessig_verteilen");
        assertThat(ruf(o.w().ines(), HttpMethod.POST, "/api/v1/messstellen/MS-10/ersatzwerte/vorschau", falsch).status()).isEqualTo(422);
        falsch = new java.util.LinkedHashMap<>(eingabe(o)); falsch.put("quelle_id", UUID.randomUUID().toString());
        assertThat(ruf(o.w().ines(), HttpMethod.POST, "/api/v1/messstellen/MS-10/ersatzwerte", falsch).status()).isEqualTo(404);
        falsch = new java.util.LinkedHashMap<>(eingabe(o)); falsch.put("tenant_id", UUID.randomUUID().toString());
        assertThat(ruf(o.w().ines(), HttpMethod.POST, "/api/v1/messstellen/MS-10/ersatzwerte", falsch).status()).isEqualTo(400);
        assertThat(zahl("messreihe_ersatzwert", o)).isZero();
    }

    @Test
    void standortBearbeiterSiehtFremdenStandortAuchImEigenenMandantenNicht() throws Exception {
        Ort o = ort(false);
        UUID u = root.queryForObject("SELECT id FROM unternehmen WHERE tenant_id = ?", UUID.class, o.w().mandant());
        UUID fremd = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, 'Werk Süd', 'ST-2', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, o.w().mandant(), u);
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', 'Ines Kaltenbach', 'aktiv')", o.w().mandant(), o.w().ines().sub());
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, 'bearbeiter', ?, '2024-01-01', 'Europe/Berlin')", o.w().mandant(), o.w().ines().sub(), o.standort());
        var k = ok(ruf(o.w().ines(), HttpMethod.POST, "/api/v1/messstellen/MS-10/ersatzwerte", eingabe(o)));
        assertThat(k.path("status").asText()).isEqualTo("freigegeben");
        assertThat(ruf(o.w().ines(), HttpMethod.GET, "/api/v1/standorte/" + fremd + "/korrekturen", null).status()).isEqualTo(404);
        ok(ruf(o.w().ines(), HttpMethod.GET, "/api/v1/standorte/" + o.standort() + "/korrekturen", null));
    }

    @Test
    void monatsbetragHatKeineErfundenenViertelstundenUndDieselbeJahresVorschauWieDieKaskade() throws Exception {
        Ort o = ort(false);
        var e = new java.util.LinkedHashMap<String, Object>(eingabe(o));
        e.put("von", "2026-10-01T00:00:00Z"); e.put("bis", "2026-10-31T00:00:00Z"); e.put("betrag", 2304);
        var k = ok(ruf(o.w().ines(), HttpMethod.POST, "/api/v1/messstellen/MS-10/ersatzwerte", e));
        assertThat(k.path("vorschau")).allMatch(p -> !p.path("periode").asText().equals("viertelstunde"));
        lauf.lauf(JETZT); kaskade.lauf(JETZT);
        assertThat(versionen(o)).isZero();
        for (JsonNode p : k.path("vorschau")) {
            var menge = root.queryForObject("SELECT menge FROM messreihe_periode_version WHERE entity_id = ? AND ebene = ? "
                    + "AND periode_beginn = ? ORDER BY version DESC LIMIT 1", java.math.BigDecimal.class, o.entity(),
                    p.path("periode").asText(), java.sql.Timestamp.from(java.time.Instant.parse(p.path("von").asText())));
            assertThat(menge).as(p.toString()).isEqualByComparingTo(p.path("neu").path("menge").decimalValue());
        }
    }

    @Test
    void einErsatzwertAusDemBestandOhneKorrekturBleibtWiderrufbar() throws Exception {
        Ort o = ort(false);
        root.update("INSERT INTO messreihe_ersatzwert (tenant_id, kennung, fassung, status, methode, entity_id, messkanal, "
                + "von, bis, betrag, einheit, begruendung, beleg, actor_sub, actor_name, actor_rolle, actor_art) "
                + "VALUES (?, 'EW-2026-0001', 1, 'wirksam', 'wert_eingeben', ?, ?, ?, ?, 20, 'kWh', ?, ?, ?, 'Ines Kaltenbach', 'kundenadministrator', 'kunde')",
                o.w().mandant(), o.entity(), KANAL, java.sql.Timestamp.from(VON), java.sql.Timestamp.from(VON.plusSeconds(900)),
                BEGRUENDUNG, BEGRUENDUNG, o.w().ines().sub());
        lauf.lauf(JETZT);
        var neu = ok(ruf(o.w().ines(), HttpMethod.POST, "/api/v1/ersatzwerte/EW-2026-0001/zuruecknehmen", Map.of("grund", BEGRUENDUNG)));
        assertThat(neu.path("status").asText()).isEqualTo("zurueckgenommen");
        assertThat(neu.path("korrektur").isNull()).isTrue();
        lauf.lauf(JETZT);
        assertThat(neueste(o)).isEqualByComparingTo("15");
    }

    @Test
    void vorperiodeWirdAlsProfilMitDenselbenWertenVorgeschautUndErfasst() throws Exception {
        Ort o = ort(false);
        var e = new java.util.LinkedHashMap<String, Object>(eingabe(o));
        e.put("methode", "vorperiode_uebernehmen"); e.remove("betrag"); e.remove("einheit");
        e.put("von", VON.plusSeconds(900).toString()); e.put("bis", VON.plusSeconds(1800).toString());
        e.put("vorperiode_von", VON.toString());
        var p = ok(ruf(o.w().ines(), HttpMethod.POST, "/api/v1/messstellen/MS-10/ersatzwerte/vorschau", e));
        var k = ok(ruf(o.w().ines(), HttpMethod.POST, "/api/v1/messstellen/MS-10/ersatzwerte", e));
        lauf.lauf(JETZT); kaskade.lauf(JETZT);
        var menge = root.queryForObject("SELECT menge FROM messreihe_viertelstunde_version WHERE entity_id = ? "
                + "AND intervall_beginn = ? ORDER BY version DESC LIMIT 1", java.math.BigDecimal.class,
                o.entity(), java.sql.Timestamp.from(VON.plusSeconds(900)));
        assertThat(menge).isEqualByComparingTo(p.path("perioden").get(0).path("neu").path("menge").decimalValue());
        for (JsonNode z : k.path("vorschau")) if (!z.path("periode").asText().equals("viertelstunde")) {
            var gespeichert = root.queryForObject("SELECT menge FROM messreihe_periode_version WHERE entity_id = ? AND ebene = ? "
                    + "AND periode_beginn = ? ORDER BY version DESC LIMIT 1", java.math.BigDecimal.class, o.entity(),
                    z.path("periode").asText(), java.sql.Timestamp.from(java.time.Instant.parse(z.path("von").asText())));
            assertThat(gespeichert).as(z.toString()).isEqualByComparingTo(z.path("neu").path("menge").decimalValue());
        }
    }

    @Test
    void lueckenLiefernDenGemessenenZuwachsLesendUndNurFuerDieEigeneQuelle() throws Exception {
        Ort o = ort(false);
        UUID id = UUID.randomUUID();
        UUID box = root.queryForObject("SELECT device_id FROM measurement_point WHERE id = ?", UUID.class, o.entity());
        var e = MAPPER.createObjectNode().put("ereignis_id", id.toString()).put("art", "data_gap")
                .put("von", VON.toString()).put("bis", VON.plusSeconds(900).toString())
                .put("box", box.toString()).put("komponente", o.entity().toString()).put("messkanal", KANAL)
                .put("erkannt_aus", "kadenz").put("zuwachs", 15).put("einheit", "kWh")
                .put("stand_vor", 100).put("stand_nach", 115);
        var geschrieben = new MessreiheEreignisRepository(root).anhaengen(o.w().mandant(), null,
                EreignisVokabular.Urheber.CLOUD, e, null, null);
        assertThat(geschrieben.ausgang()).isEqualTo(MessreiheEreignisRepository.Ausgang.ANGEHAENGT);
        String pfad = "/api/v1/messstellen/MS-10/ersatzwerte/luecken?quelle_id=" + o.quelle()
                + "&von=" + VON + "&bis=" + VON.plusSeconds(3600);
        long vorher = zahl("messreihe_ereignis", o);
        var l = ok(ruf(o.w().ines(), HttpMethod.GET, pfad, null));
        assertThat(l.size()).isEqualTo(1);
        assertThat(l.get(0).path("id").asText()).isEqualTo(id.toString());
        assertThat(l.get(0).path("zuwachs").decimalValue()).isEqualByComparingTo("15");
        assertThat(zahl("messreihe_ereignis", o)).isEqualTo(vorher);
        Ort fremd = ort(false);
        assertThat(ruf(fremd.w().ines(), HttpMethod.GET, pfad, null).status()).isEqualTo(404);
    }

    @Test
    void vollstaendigGemesseneZeitraeumeLassenSichNichtDurchErsatzwerteUeberschreiben() throws Exception {
        Ort o = ort(false, true);
        var a = ruf(o.w().ines(), HttpMethod.POST, "/api/v1/messstellen/MS-10/ersatzwerte", eingabe(o));
        assertThat(a.status()).isEqualTo(422);
        assertThat(a.body().path("message").asText()).contains("alle Werte gemessen");
        assertThat(zahl("messreihe_ersatzwert", o)).isZero();
    }

    @Test
    void endstandNachEndgueltigkeitWartetAuchOhneVierAugenBisZurFreigabe() throws Exception {
        Ort o = ort(false);
        portal.uhrStellen(java.time.Clock.fixed(VON.plusSeconds(10 * 86400), java.time.ZoneOffset.UTC));
        try {
            var e = new java.util.LinkedHashMap<String, Object>(eingabe(o));
            e.put("methode", "ablesestand_nachtragen"); e.remove("betrag");
            e.put("zeitpunkt", VON.plusSeconds(12 * 60).toString());
            e.put("endstand", 112.5); e.put("anfangsstand", 112);
            var p = ok(ruf(o.w().ines(), HttpMethod.POST, "/api/v1/messstellen/MS-10/ersatzwerte/vorschau", e));
            assertThat(p.path("vieraugen").asBoolean()).isFalse();
            assertThat(p.path("freigabe_noetig").asBoolean()).isTrue();
            var k = ok(ruf(o.w().ines(), HttpMethod.POST, "/api/v1/messstellen/MS-10/ersatzwerte", e));
            assertThat(k.path("status").asText()).isEqualTo("vorschlag");
            lauf.lauf(JETZT);
            assertThat(versionen(o)).isZero();
            ok(ruf(o.w().ines(), HttpMethod.POST, "/api/v1/korrekturen/" + k.path("kennung").asText() + "/freigeben",
                    Map.of("begruendung", BEGRUENDUNG)));
            lauf.lauf(JETZT);
            assertThat(neueste(o)).isEqualByComparingTo(p.path("perioden").get(0).path("neu").path("menge").decimalValue());
        } finally { portal.uhrStellen(java.time.Clock.systemUTC()); }
    }

    private Map<String, Object> eingabe(Ort o) {
        return Map.of("quelle_id", o.quelle().toString(), "methode", "wert_eingeben", "von", VON.toString(),
                "bis", VON.plusSeconds(900).toString(), "betrag", 20, "einheit", "kWh",
                "begruendung", BEGRUENDUNG, "beleg", "Ableseprotokoll Halle 2 vom 10. November");
    }
    private long zahl(String tabelle, Ort o) {
        return root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?", Long.class, o.w().mandant());
    }
    private long versionen(Ort o) { return zahl("messreihe_viertelstunde_version", o); }
    private java.math.BigDecimal neueste(Ort o) {
        return root.queryForObject("SELECT menge FROM messreihe_viertelstunde_version WHERE entity_id = ? "
                + "AND intervall_beginn = ? ORDER BY version DESC LIMIT 1", java.math.BigDecimal.class, o.entity(), java.sql.Timestamp.from(VON));
    }
    private JsonNode ok(Antwort a) { assertThat(a.status()).as(a.body().toString()).isEqualTo(200); return a.body(); }

    private Ort ort(boolean vier) { return ort(vier, false); }

    private Ort ort(boolean vier, boolean alleWerte) {
        UUID t = root.queryForObject("INSERT INTO tenant(name) VALUES ('Kunststoffwerk Ahrenberg') RETURNING id", UUID.class);
        UUID u = root.queryForObject("INSERT INTO unternehmen(tenant_id, name, zeitzone, vieraugen_freigabe) "
                + "VALUES (?, 'Ahrenberg', 'Europe/Berlin', ?) RETURNING id", UUID.class, t, vier);
        UUID st = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        UUID an = root.queryForObject("INSERT INTO site(tenant_id, name) VALUES (?, 'Halle 2') RETURNING id", UUID.class, t);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?, ?, ?, '2024-01-01')", t, an, st);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, 'claimed') RETURNING id", UUID.class, t, an, "VP-BOX-" + t);
        UUID entity = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, communication, connection_json, created_at) "
                + "VALUES (?, ?, 'grid-meter', 'Halle 2', 'grid-meter', ?, 'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}', '2024-03-12') RETURNING id", UUID.class, t, an, box);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, retention_class, long_term_strategy) "
                + "VALUES (?, ?, ?, ?, ?, true, 60, 1, '2024-03-12', '2026.09.11.1', 'test', 'pending_edge', 'live_power', 'fifteen_minute')", t, an, box, entity, KANAL);
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, einheit, wertart) "
                + "VALUES (?, 'MS-10', 'Halle 2', 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, t);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? AND gueltig_bis IS NULL", UUID.class, entity);
        UUID q = root.queryForObject("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_sub, actor_name, actor_art) "
                + "VALUES (?, ?, 'Wirkenergie', 'Bezug', ?, ?, ?, 'counter', 'zaehlerstand', 'fuehrend', '2024-03-12', true, now(), 'ines', 'Ines Kaltenbach', 'kunde') RETURNING id", UUID.class, t, ms, entity, geraet, KANAL);
        for (int minute = 0; minute <= 30; minute++) {
            // Fehlende Kadenzen, Zählerdifferenz bleibt gemessen: kein frei erfundener Zuwachs.
            if (!alleWerte && (minute == 7 || minute == 22)) continue;
            var zeit = java.sql.Timestamp.from(VON.plusSeconds(minute * 60));
            root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, point_key, raw_numeric, quality, catalog_version, edge_sequence, aggregation_kind, entity_id, applied_revision, value_kind, role, delivery, delay_s) "
                    + "VALUES (?, ?, ?, ?, ?, ?, ?, 'good', '2026.09.11.1', ?, 'counter', ?, 1, 'counter', 'fuehrend', 'direkt', 0)", zeit, zeit, t, an, box, KANAL, 100 + minute, minute, entity);
        }
        for (int qn = 0; qn < 3; qn++) root.update("INSERT INTO messreihe_viertelstunde_arbeit "
                + "(tenant_id, entity_id, messkanal, intervall_beginn, grund) VALUES (?, ?, ?, ?, 'eingang') ON CONFLICT DO NOTHING",
                t, entity, KANAL, java.sql.Timestamp.from(VON.plusSeconds(qn * 900)));
        verdichter.lauf(JETZT);
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_viertelstunde WHERE entity_id = ?", Integer.class, entity)).isEqualTo(3);
        Welt w = new Welt(t, new Wer("ines-" + t, "Ines Kaltenbach", t, false), new Wer("jonas-" + t, "Jonas Wendlinger", t, false), new Wer("voss", "Lena Voss", t, true));
        return new Ort(w, st, entity, q);
    }
    private Antwort ruf(Wer wer, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject(wer.sub());
                    j.claim("preferred_username", wer.name());
                    if (!wer.plattform()) {
                        j.claim("tenant_id", wer.kundenbereich().toString());
                    }
                }).authorities(wer.plattform()
                        ? List.of(new SimpleGrantedAuthority("ROLE_platform-admin"))
                        : Boolean.TRUE.equals(root.queryForObject("SELECT EXISTS (SELECT 1 FROM benutzer WHERE tenant_id = ? AND sub = ?)",
                                Boolean.class, wer.kundenbereich(), wer.sub()))
                            ? List.of(new SimpleGrantedAuthority("KONTO_benutzer")) : List.of()))
                .contentType(MediaType.APPLICATION_JSON);
        if (wer.plattform()) {
            anfrage.header("X-Tenant-Id", wer.kundenbereich().toString());
        }
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
