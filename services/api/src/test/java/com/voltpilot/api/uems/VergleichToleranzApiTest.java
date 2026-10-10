package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HashMap;
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

/**
 * AP-16 IP-17 (G5, E10 = A) · R9: MS-01 mit zwei Vergleichsquellen im Dezember 2026 — 1,1 % passt (Toleranz 2 %),
 * 3,4 % ist ein Befund ohne Ursache. Kein Wert ändert sich; die Toleranz ist eine Fassung mit Begründung, die einen
 * abgeschlossenen Monat nie nachträglich anders beurteilt. Echte Leser, App-Rolle, HTTP, Standort-Zaun und RLS.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class VergleichToleranzApiTest {
    private static final String VERGLEICH = "/api/v1/messstellen/MS-01/vergleich?von=2026-11&bis=2026-12";
    private static final ObjectMapper JSON = new ObjectMapper();
    @Container static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    @DynamicPropertySource static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "ip17_app_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "ip17_app_pw");
        r.add("spring.flyway.placeholders.adminDbPassword", () -> "ip17_admin_pw");
        r.add("voltpilot.admin-datasource.password", () -> "ip17_admin_pw");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> "http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/certs");
    }

    @Autowired MockMvc mvc;
    @Autowired MessstelleWerteService werte;
    @Autowired VergleichToleranzService vergleich;
    static JdbcTemplate root;
    UUID tenant;
    Map<String, UUID> ids;

    @BeforeAll static void start() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach void welt() {
        ids = new HashMap<>();
        var uhr = Clock.fixed(Instant.parse("2027-01-10T12:00:00Z"), ZoneOffset.UTC);
        werte.uhrStellen(uhr);
        vergleich.uhrStellen(uhr);
        tenant = uuid("INSERT INTO tenant(name) VALUES ('Ahrenberg IP-17') RETURNING id");
        UUID unternehmen = uuid("INSERT INTO unternehmen(tenant_id,name) VALUES (?,'Ahrenberg') RETURNING id", tenant);
        for (String s : List.of("ST-1", "ST-2")) {
            ids.put(s, uuid("INSERT INTO standort(tenant_id,unternehmen_id,name,kurzzeichen,zeitzone,zustand) "
                    + "VALUES (?,?,?,?,'Europe/Berlin','aktiv') RETURNING id", tenant, unternehmen, s, s));
        }
        benutzer("IK", "energiemanager", null);
        benutzer("BE", "bearbeiter", ids.get("ST-1"));
        benutzer("LE", "leser", ids.get("ST-1"));
        benutzer("FREMD", "bearbeiter", ids.get("ST-2"));
        UUID an1 = uuid("INSERT INTO site(tenant_id,name) VALUES (?,'AN-1') RETURNING id", tenant);
        root.update("INSERT INTO anlage_standort(tenant_id,site_id,standort_id,gueltig_ab) VALUES (?,?,?,'2024-01-01')",
                tenant, an1, ids.get("ST-1"));
        UUID box = uuid("INSERT INTO device(tenant_id,site_id,external_ref) VALUES (?,?,?) RETURNING id", tenant, an1,
                "VP-IP17-" + tenant);
        for (String k : List.of("MS-01", "MS-02")) {
            ids.put(k, uuid("INSERT INTO messstelle(tenant_id,kennzeichen,name,art,medium,groesse,richtung,einheit,wertart) "
                    + "VALUES (?,?,?,'gemessen','Strom','Wirkenergie','Bezug','kWh','Zählerstand') RETURNING id",
                    tenant, k, k.equals("MS-01") ? "Netzbezug Halle 1" : "Halle 2"));
            root.update("INSERT INTO messstelle_ort(tenant_id,messstelle_id,standort_id,gueltig_ab) VALUES (?,?,?,'2024-01-01')",
                    tenant, ids.get(k), ids.get("ST-1"));
        }
        // K-3 Netzzähler führt MS-01; K-1 Netzleistung am Wechselrichter (integriert) und K-9 ein zweiter Zähler
        // vergleichen seit 20.11.2026 08:30 — der November ist darum für beide kein ganzer Monat.
        ids.put("F", quelle("MS-01", komponente(an1, box, "K-3"), "grid.energy_import", "counter", "zaehlerstand",
                "fuehrend", null, "2024-01-01T00:00:00Z"));
        ids.put("V1", quelle("MS-01", komponente(an1, box, "K-1"), "grid.power", "gauge", "integration", "vergleich",
                "Plausibilität", "2026-11-20T07:30:00Z"));
        ids.put("V9", quelle("MS-01", komponente(an1, box, "K-9"), "meter.energy_import", "counter", "zaehlerstand",
                "vergleich", "Abrechnungszähler", "2026-11-20T07:30:00Z"));
        monat("K-3", "grid.energy_import", "counter", "2026-11", "118400");
        monat("K-3", "grid.energy_import", "counter", "2026-12", "131200");
        monat("K-1", "grid.power", "gauge", "2026-11", "41200");
        monat("K-1", "grid.power", "gauge", "2026-12", "129700");
        monat("K-9", "meter.energy_import", "counter", "2026-12", "126700");
    }

    @Test void r9DezemberPasstGegenprobeBefundOhneUrsacheUndKeinWertAendertSich() throws Exception {
        String vorher = fingerabdruck();
        String werteVorher = roh("GET", "/api/v1/messstellen/MS-01/werte?raster=monat&von=2026-11-01&bis=2026-12-31", "IK");

        var a = ruf("GET", VERGLEICH, "IK", null, 200);
        assertThat(a.path("einheit").asText()).isEqualTo("kWh");
        var v1 = quelle(a, ids.get("V1"));
        assertThat(v1.path("monatsvergleich").asText()).isEqualTo("ja");
        assertThat(v1.at("/toleranz/fassung").asInt()).isEqualTo(1);
        assertThat(v1.at("/toleranz/prozent").asText()).isEqualTo("2");
        assertThat(v1.at("/toleranz/startwert").asBoolean()).isTrue();
        assertThat(v1.at("/toleranz/gilt_ab_monat").asText()).isEqualTo("2026-11-01");
        assertThat(v1.at("/toleranz/person").isNull()).isTrue();
        // November: die Vergleichsquelle gilt erst ab 20.11. — nicht vergleichbar, kein Befund.
        assertThat(v1.at("/monate/0/monat").asText()).isEqualTo("2026-11");
        assertThat(v1.at("/monate/0/zustand").asText()).isEqualTo("nicht_vergleichbar");
        assertThat(v1.at("/monate/0/grund").asText()).isEqualTo("vergleich_nicht_ganzer_monat");
        assertThat(v1.at("/monate/0/befund").isNull()).isTrue();
        // Dezember: |131 200 − 129 700| ÷ 131 200 = 1,14 % → 1,1 % ≤ 2 %.
        var dez = v1.at("/monate/1");
        assertThat(dez.path("fuehrend").asText()).isEqualTo("131200");
        assertThat(dez.path("vergleich").asText()).isEqualTo("129700");
        assertThat(dez.path("abweichung_prozent").asText()).isEqualTo("1.1");
        assertThat(dez.path("toleranz_prozent").asText()).isEqualTo("2");
        assertThat(dez.path("zustand").asText()).isEqualTo("passt");
        assertThat(dez.path("befund").asBoolean()).isFalse();
        // Gegenprobe: 126 700 → 3,4 % > 2 % — ein Befund, ohne Ursache und ohne Ersatz.
        var v9 = quelle(a, ids.get("V9"));
        assertThat(v9.at("/monate/1/abweichung_prozent").asText()).isEqualTo("3.4");
        assertThat(v9.at("/monate/1/zustand").asText()).isEqualTo("abweichung");
        assertThat(v9.at("/monate/0/grund").asText()).isEqualTo("vergleich_nicht_ganzer_monat");
        assertThat(a.path("befunde")).hasSize(1);
        var b = a.at("/befunde/0");
        assertThat(b.path("art").asText()).isEqualTo("abweichung_vergleichsquelle");
        assertThat(b.path("quelle_id").asText()).isEqualTo(ids.get("V9").toString());
        assertThat(b.path("monat").asText()).isEqualTo("2026-12");
        assertThat(b.path("abweichung_prozent").asText()).isEqualTo("3.4");
        assertThat(b.path("toleranz_prozent").asText()).isEqualTo("2");
        assertThat(b.path("toleranz_fassung").asInt()).isEqualTo(1);
        assertThat(b.has("ursache")).isFalse();
        assertThat(b.has("ersatz")).isFalse();

        // Kein Wert ändert sich: Speicher und Werte-Route byte-gleich vor und nach dem Lesen und einer neuen Fassung.
        ruf("POST", toleranz("V9"), "IK", Map.of("prozent", "4", "begruendung", "Klasse 3 am Vergleichszähler"), 201);
        assertThat(fingerabdruck()).isEqualTo(vorher);
        assertThat(roh("GET", "/api/v1/messstellen/MS-01/werte?raster=monat&von=2026-11-01&bis=2026-12-31", "IK"))
                .isEqualTo(werteVorher);
    }

    @Test void toleranzFassungZweiMitBegruendungBeurteiltKeinenAbgeschlossenenMonatNeu() throws Exception {
        var f = ruf("POST", toleranz("V9"), "IK", Map.of("prozent", "4", "begruendung",
                "Der Vergleichszähler hat Klasse 3"), 201);
        assertThat(f.path("fassung").asInt()).isEqualTo(2);
        assertThat(f.path("prozent").asText()).isEqualTo("4");
        assertThat(f.path("startwert").asBoolean()).isFalse();
        assertThat(f.path("gilt_ab_monat").asText()).isEqualTo("2027-01-01");
        assertThat(f.path("begruendung").asText()).isEqualTo("Der Vergleichszähler hat Klasse 3");
        assertThat(f.at("/person/sub").asText()).isEqualTo("IK");
        // Dieselbe Toleranz noch einmal schreibt nichts.
        assertThat(ruf("POST", toleranz("V9"), "IK", Map.of("prozent", "4.00", "begruendung", "noch einmal"), 200)
                .path("fassung").asInt()).isEqualTo(2);
        assertThat(root.queryForObject("SELECT count(*) FROM vergleich_toleranz", Integer.class)).isEqualTo(1);

        var a = ruf("GET", VERGLEICH, "IK", null, 200);
        var v9 = quelle(a, ids.get("V9"));
        assertThat(v9.at("/toleranz/fassung").asInt()).isEqualTo(2);
        assertThat(v9.path("fassungen")).hasSize(2);
        // Dezember bleibt mit Fassung 1 beurteilt: der Befund verschwindet nicht.
        assertThat(v9.at("/monate/1/toleranz_fassung").asInt()).isEqualTo(1);
        assertThat(v9.at("/monate/1/zustand").asText()).isEqualTo("abweichung");
        assertThat(a.path("befunde")).hasSize(1);
        // Der Januar gilt mit Fassung 2 — er ist noch nicht gebildet, also nicht vergleichbar, nie „passt“.
        var jan = quelle(ruf("GET", "/api/v1/messstellen/MS-01/vergleich?von=2027-01&bis=2027-01", "IK", null, 200),
                ids.get("V9")).at("/monate/0");
        assertThat(jan.path("toleranz_fassung").asInt()).isEqualTo(2);
        assertThat(jan.path("toleranz_prozent").asText()).isEqualTo("4");
        assertThat(jan.path("zustand").asText()).isEqualTo("nicht_vergleichbar");

        assertThat(ruf("POST", toleranz("V9"), "IK", Map.of("prozent", "3"), 422).path("code").asText())
                .isEqualTo("begruendung_fehlt");
        for (String p : List.of("0", "2,5", "101", "1.234", "-1")) {
            assertThat(ruf("POST", toleranz("V9"), "IK", Map.of("prozent", p, "begruendung", "x"), 422)
                    .path("code").asText()).as(p).isEqualTo("toleranz_ungueltig");
        }
        assertThat(ruf("POST", toleranz("F"), "IK", Map.of("prozent", "3", "begruendung", "x"), 422)
                .path("code").asText()).isEqualTo("keine_vergleichsquelle");
        assertThat(ruf("POST", toleranz("V9"), "IK", Map.of("prozent", "3", "begruendung", "x", "gilt_ab", "2026-12"),
                400).path("code").asText()).isEqualTo("anfrage_ungueltig");
        assertThat(ruf("GET", "/api/v1/messstellen/MS-01/vergleich?von=2026-12", "IK", null, 400).path("feld").asText())
                .isEqualTo("bis");
    }

    @Test void datenbankHaeltFassungEinsUndVergleichsrolleUndIstNurAnfuegbar() {
        assertThatThrownBy(() -> root.update("INSERT INTO vergleich_toleranz(tenant_id,messstelle_quelle_id,fassung,prozent,"
                + "gilt_ab_monat,begruendung,actor_sub,actor_name,actor_art) VALUES (?,?,1,2,'2027-01-01','x','IK','IK','kunde')",
                tenant, ids.get("V9"))).hasMessageContaining("vergleich_toleranz_fassung_chk");
        assertThatThrownBy(() -> root.update("INSERT INTO vergleich_toleranz(tenant_id,messstelle_quelle_id,fassung,prozent,"
                + "gilt_ab_monat,begruendung,actor_sub,actor_name,actor_art) VALUES (?,?,2,2,'2027-01-01','x','IK','IK','kunde')",
                tenant, ids.get("F"))).hasMessageContaining("Vergleichsquelle");
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'vergleich_toleranz'", Boolean.class)).isTrue();
        assertThat(root.queryForList("SELECT privilege_type FROM information_schema.role_table_grants "
                + "WHERE table_name = 'vergleich_toleranz' AND grantee = 'voltpilot_app' ORDER BY 1", String.class))
                .containsExactly("INSERT", "SELECT");
    }

    @Test void zaunRechteUndMandantWieAnDerMessstelle() throws Exception {
        assertThat(ruf("GET", VERGLEICH, "LE", null, 200).path("befunde")).hasSize(1);
        ruf("POST", toleranz("V9"), "LE", Map.of("prozent", "3", "begruendung", "x"), 403);
        ruf("GET", VERGLEICH, "FREMD", null, 404);
        ruf("POST", toleranz("V9"), "FREMD", Map.of("prozent", "3", "begruendung", "x"), 404);
        assertThat(ruf("POST", toleranz("V1"), "BE", Map.of("prozent", "3", "begruendung", "Wechselrichter"), 201)
                .at("/person/rolle").asText()).isEqualTo("bearbeiter");
        // Ein anderer Mandant sieht weder die Messstelle noch die Fassung.
        UUID eigen = tenant;
        tenant = uuid("INSERT INTO tenant(name) VALUES ('Fremd IP-17') RETURNING id");
        benutzer("IK2", "energiemanager", null);
        ruf("GET", VERGLEICH, "IK2", null, 404);
        ruf("POST", "/api/v1/messstellen/" + ids.get("MS-01") + "/quellen/" + ids.get("V1") + "/toleranz", "IK2",
                Map.of("prozent", "3", "begruendung", "x"), 404);
        tenant = eigen;
    }

    @Test void ohneVergleichsquelleMerktDerBestandNichts() throws Exception {
        var a = ruf("GET", "/api/v1/messstellen/MS-02/vergleich", "IK", null, 200);
        assertThat(a.path("vergleichsquellen")).isEmpty();
        assertThat(a.path("befunde")).isEmpty();
        // Ohne Angabe der letzte volle Monat in der Zeitzone der Messstelle.
        assertThat(a.path("von").asText()).isEqualTo("2026-12");
        assertThat(a.path("bis").asText()).isEqualTo("2026-12");
    }

    private String toleranz(String quelle) {
        return "/api/v1/messstellen/" + ids.get("MS-01") + "/quellen/" + ids.get(quelle) + "/toleranz";
    }

    private static JsonNode quelle(JsonNode a, UUID id) {
        for (var q : a.path("vergleichsquellen")) if (q.path("quelle_id").asText().equals(id.toString())) return q;
        throw new AssertionError("Vergleichsquelle fehlt: " + id);
    }

    /** Alles, woraus eine Zahl der Messstelle entsteht — vor und nach dem Lesen und Eintragen byte-gleich. */
    private String fingerabdruck() {
        return root.queryForObject("SELECT md5(coalesce((SELECT string_agg(t::text, '|' ORDER BY t::text) FROM "
                + "messreihe_periode t),'') || coalesce((SELECT string_agg(q::text, '|' ORDER BY q::text) FROM "
                + "messstelle_quelle q),'') || coalesce((SELECT string_agg(m::text, '|' ORDER BY m::text) FROM "
                + "messstelle m),''))", String.class);
    }

    private UUID komponente(UUID site, UUID box, String name) {
        UUID entity = uuid("INSERT INTO measurement_point(tenant_id,site_id,role,label,entity_type,device_id,communication,"
                + "connection_json) VALUES (?,?,'modbus-generic',?,'modbus-generic',?,'modbus_tcp','{\"unit_id\":1}') "
                + "RETURNING id", tenant, site, name, box);
        ids.put(name, entity);
        return entity;
    }

    private UUID quelle(String ms, UUID entity, String kanal, String wertart, String herleitung, String rolle,
            String zweck, String ab) {
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id=?", UUID.class, entity);
        return uuid("INSERT INTO messstelle_quelle(tenant_id,messstelle_id,groesse,richtung,entity_id,geraet_id,kanal,"
                + "kanal_wertart,herleitung,rolle,zweck,gueltig_ab,rueckwirkend,eingetragen_am,actor_name,actor_art) "
                + "VALUES (?,?,'Wirkenergie','Bezug',?,?,?,?,?,?,?,?::timestamptz,false,?::timestamptz,'Test','voltpilot') "
                + "RETURNING id", tenant, ids.get(ms), entity, geraet, kanal, wertart, herleitung, rolle, zweck, ab, ab);
    }

    /** Eine gebildete Monatszeile (Europe/Berlin, endgültig): Zählerstand als Menge, Leistung als Energie. */
    private void monat(String komponente, String kanal, String wertart, String monat, String menge) {
        var m = java.time.YearMonth.parse(monat);
        var zone = java.time.ZoneId.of("Europe/Berlin");
        Instant beginn = m.atDay(1).atStartOfDay(zone).toInstant();
        Instant ende = m.plusMonths(1).atDay(1).atStartOfDay(zone).toInstant();
        long stunden = java.time.Duration.between(beginn, ende).toHours();
        int tage = m.lengthOfMonth();
        boolean zaehler = wertart.equals("counter");
        root.update("INSERT INTO messreihe_periode(tag,art,tenant_id,entity_id,messkanal,zeitzone,zeitzone_herkunft,beginn,ende,"
                + "stunden,teile_erwartet,teile_vorhanden,teile_endgueltig,wertart,menge,energie,menge_zustand,kennzeichen,"
                + "erhalten,erwartet,abdeckung_prozent,zustand,endgueltig_ab,version,berechnet_am) VALUES "
                + "(?::date,'monat',?,?,?,'Europe/Berlin','standort',?,?,?,?,?,?,?,?::numeric,?::numeric,'vollständig',?::jsonb,"
                + "?,?,100,'endgueltig',?,1,'2027-01-08T00:00:00Z')",
                m.atDay(1).toString(), tenant, ids.get(komponente), kanal, java.sql.Timestamp.from(beginn),
                java.sql.Timestamp.from(ende), stunden, tage, tage, tage, wertart, zaehler ? menge : null,
                zaehler ? null : menge, zaehler ? "[]" : "[\"" + VerbrauchRegeln.AUS_LEISTUNG_INTEGRIERT + "\"]",
                tage * 96, tage * 96, java.sql.Timestamp.from(ende.plus(java.time.Duration.ofDays(7))));
    }

    private void benutzer(String sub, String rolle, UUID standort) {
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,?,'benutzer',?,'aktiv')",
                tenant, sub, sub);
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,standort_id,gueltig_ab,zeitzone) "
                + "VALUES (?,?,?,?,'2024-01-01','Europe/Berlin')", tenant, sub, rolle, standort);
    }

    private UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
    }

    private String roh(String method, String path, String sub) throws Exception {
        return antwort(method, path, sub, null).getContentAsString(StandardCharsets.UTF_8);
    }

    private JsonNode ruf(String method, String path, String sub, Object body, int status) throws Exception {
        var r = antwort(method, path, sub, body);
        assertThat(r.getStatus()).as(method + " " + path + " " + r.getContentAsString()).isEqualTo(status);
        String text = r.getContentAsString(StandardCharsets.UTF_8);
        return text.isEmpty() ? JSON.nullNode() : JSON.readTree(text);
    }

    private org.springframework.mock.web.MockHttpServletResponse antwort(String method, String path, String sub,
            Object body) throws Exception {
        Jwt token = Jwt.withTokenValue("test").header("alg", "none").subject(sub).issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600)).claim("tenant_id", tenant.toString())
                .claim("realm_access", Map.of("roles", List.of())).build();
        var b = request(HttpMethod.valueOf(method), path).with(authentication(new KeycloakRealmRoleConverter().convert(token)));
        if (body != null) b.contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        return mvc.perform(b).andReturn().getResponse();
    }
}
