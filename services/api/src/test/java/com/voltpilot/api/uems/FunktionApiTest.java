package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
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
 * Die Funktions-Routen (UEMS AP-01 IP-3) gegen die echte Kette: {@code GET /api/v1/funktionen},
 * {@code PUT /api/v1/sites/{id}/funktionen/steuern} und {@code PUT /api/v1/standorte/{id}/funktionen/steuern}.
 * Namen und Kennzeichen (Werk Ahrenberg, Halle 1/2, NA-1/NA-2, MS-10, Lastspitzenkappung seit 02.05.2024) stammen
 * aus dem Referenzunternehmen; die Zuordnungs-TAGE liegen bewusst in der Vergangenheit, weil „heute“ zählt und
 * die Tage der Vektor-Datei (01.10.2026) noch vor uns liegen.
 *
 * <p>Die Prüfnachweise des Berichts (§8 IP-3): Start ohne grüne Prüfliste → 409 mit Grund (und Weg), nichts
 * geschrieben · Anhalten setzt den Ruhe-Eintrag (herkunft {@code funktion}, ohne Ende) · Standort-Anhalten setzt
 * ihn für ALLE teilnehmenden Anlagen · fremde Anlage und fremder Standort → 404, nie 403. Dazu R1/R2: die Liste
 * läuft beim Starten und Fortsetzen IN der Transaktion erneut — eine rote Grenze wird grün, und erst dann startet es.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class FunktionApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path REFERENZ = Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");
    private static final LocalDate AB = LocalDate.of(2024, 3, 12);
    private static final Instant LSK_SEIT = Instant.parse("2024-05-02T06:00:00Z");
    private static final String ENERGIE_BEZUG = "sunspec.model_203.totwhimp";

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

    private record Welt(UUID mandant, Map<String, UUID> ids, Map<String, String> namen) {
        UUID id(String kennzeichen) {
            return ids.get(kennzeichen);
        }

        String name(String kennzeichen) {
            return namen.get(kennzeichen);
        }
    }

    private record Antwort(int status, JsonNode body) {}

    @BeforeAll
    static void verbinde() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        referenz = MAPPER.readTree(REFERENZ.toFile());
    }

    // ================================================================== Nachweis 1 + R1/R2

    @Test
    void startOhneGruenePrueflisteIst409MitGrundUndWegUndSchreibtNichts() throws Exception {
        Welt w = welt();
        UUID funktion = funktion(w, "ST-1", "eingerichtet");
        UUID teilnahme = teilnahme(w, funktion, "AN-2", "eingerichtet", null, false);
        ruhe(w, "AN-2");
        String vorher = stand(w);

        JsonNode pruefung = ok(ruf(w, HttpMethod.GET, pruefung(w, "AN-2"), null), 200).body();
        assertThat(pruefung.path("bereit").asBoolean(true)).isFalse();
        assertThat(texte(pruefung.path("zeilen"), "pruefung"))
                .containsExactly("box", "freigabe", "verbindungstest", "grenze", "hauptzaehler", "betriebsweise");
        JsonNode box = pruefung.path("zeilen").get(0);
        assertThat(box.path("fakt").asText()).isEqualTo("Keine Box verbunden");
        assertThat(box.path("grund").asText()).isNotBlank();
        assertThat(box.path("weg").asText()).contains("Verbinden Sie eine Box");
        assertThat(stand(w)).as("die GET-Prüfung schreibt nichts").isEqualTo(vorher);

        Antwort a = ruf(w, HttpMethod.PUT, anlage(w, "AN-2"), Map.of("aktion", "starten"));

        assertThat(a.status()).as(a.body().toString()).isEqualTo(409);
        assertThat(a.body().path("code").asText()).isEqualTo("pruefliste_offen");
        String halle2 = w.name("AN-2");
        assertThat(a.body().path("message").asText()).startsWith("Noch nicht möglich — es fehlt: Box " + halle2);
        assertThat(texte(a.body().path("fehlt"))).containsExactly("Box " + halle2, "Steuer-Freigabe " + halle2,
                "plausible Grenze " + halle2);
        assertThat(texte(a.body().path("wege"), "pruefung")).containsExactly("box", "freigabe", "grenze");
        assertThat(texte(a.body().path("wege"), "satz")).contains("Ordnen Sie " + halle2
                + " unter Standort › Netzanschlüsse ihrem Netzanschluss zu und tragen Sie dort die vereinbarte Leistung ein.");
        // Nichts geschrieben: Teilnahme, Funktion und Ruhe zeichengleich.
        assertThat(stand(w)).isEqualTo(vorher);
        assertThat(root.queryForObject("SELECT zustand FROM funktion_teilnahme WHERE id = ?", String.class, teilnahme))
                .isEqualTo("eingerichtet");
    }

    @Test
    void freigabeStandDerSeedAnlageLiestDreiBestehendeWegeUndZaehltZweiVonDrei() throws Exception {
        Welt w = welt();
        UUID site = w.id("AN-2");
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, name) VALUES (?,?,?,?) "
                + "RETURNING id", UUID.class, w.mandant(), site, "VP-FREIGABE-" + UUID.randomUUID(), "Box Halle 2");

        root.update("INSERT INTO measurement_point (tenant_id, site_id, role, label, control, device_id, entity_type, "
                + "capabilities, guard_config) VALUES (?,?,'battery-hybrid','Batteriespeicher',false,?,"
                + "'battery-hybrid','{\"actuate\":[{\"command\":\"setpoint_kw\"}]}'::jsonb,'{}'::jsonb)",
                w.mandant(), site, box);
        root.update("INSERT INTO device_control_activation (device_id, activated_by, note) "
                + "VALUES (?,'betrieb','Seed-Scharfschaltung')", box);

        root.update("INSERT INTO measurement_point (tenant_id, site_id, role, label, control, device_id, entity_type, "
                + "source_kind, capabilities, guard_config, connection_json) VALUES (?,?,'consumer','Abluft "
                + "Wärmepumpe',true,?,'modbus-load','custom','{\"actuate\":[{\"command\":\"on_off\"}]}'::jsonb,"
                + "'{}'::jsonb,'{\"switch\":{\"freigabe\":{\"released_at\":\"2026-09-01T08:00:00Z\"}}}'::jsonb)",
                w.mandant(), site, box);

        UUID ladepunkt = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, control, "
                + "device_id, entity_type, source_kind, capabilities, guard_config) VALUES (?,?,'consumer',"
                + "'Parkplatz Halle 2',true,?,'ev-charger','composed',"
                + "'{\"actuate\":[{\"command\":\"setpoint_kw\"}]}'::jsonb,'{}'::jsonb) RETURNING id",
                UUID.class, w.mandant(), site, box);
        root.update("INSERT INTO device_charge_point (device_id, charge_point_id, tenant_id, site_id, label, connected, "
                + "ready, entity_id, reported_at) VALUES (?,'AHR-LP-01',?,?,'Parkplatz Halle 2',false,true,?,now())",
                box, w.mandant(), site, ladepunkt);
        root.update("INSERT INTO ocpp_station (device_id, charge_point_id, tenant_id, site_id, connected, last_seen, "
                + "updated_at) VALUES (?,'AHR-LP-01',?,?,false,now(),now())", box, w.mandant(), site);

        JsonNode p = ok(ruf(w, HttpMethod.GET, pruefung(w, "AN-2"), null), 200).body();
        JsonNode stand = p.path("freigaben");
        assertThat(stand.path("text").asText()).isEqualTo("2 von 3 freigegeben");
        assertThat(stand.path("freigegeben").asInt()).isEqualTo(2);
        assertThat(stand.path("gesamt").asInt()).isEqualTo(3);
        assertThat(texte(stand.path("komponenten"), "weg"))
                .containsExactly("selbstbau", "ocpp", "wechselrichter");
        assertThat(texte(stand.path("komponenten"), "status")).containsExactly(
                "Von Ihnen freigegeben", "Station nicht verbunden", "Von VoltPilot freigegeben");
    }

    @Test
    void dieListeLaeuftInDerTransaktionErneutUndErstEineGrueneGrenzeStartet() throws Exception {
        Welt w = welt();
        UUID funktion = funktion(w, "ST-1", "eingerichtet");
        UUID teilnahme = teilnahme(w, funktion, "AN-2", "eingerichtet", null, false);
        ruhe(w, "AN-2");
        gruen(w, "AN-2", "ST-1", "NA-2");
        // Die Netzgrenze des Ladeparks liegt ÜBER der vereinbarten Leistung von NA-2 (200 kW).
        root.update("INSERT INTO site_charging_config (site_id, tenant_id, grid_limit_kw, updated_at, updated_by) "
                + "VALUES (?, ?, 250, now(), 'test')", w.id("AN-2"), w.mandant());

        Antwort rot = ruf(w, HttpMethod.PUT, anlage(w, "AN-2"), Map.of("aktion", "starten"));
        assertThat(rot.status()).as(rot.body().toString()).isEqualTo(409);
        assertThat(texte(rot.body().path("fehlt"))).containsExactly("plausible Grenze " + w.name("AN-2"));
        assertThat(texte(rot.body().path("wege"), "satz")).containsExactly("Senken Sie die Netzgrenze des Ladeparks "
                + "von 250 kW auf höchstens 200 kW — die vereinbarte Leistung des Netzanschlusses NA-2.");
        assertThat(ruhen(w, "AN-2")).isEqualTo(1);

        // Die GET-Sicht sagt dasselbe, ohne Knopf „starten“.
        JsonNode halle2 = anlageIn(ok(ruf(w, HttpMethod.GET, "/api/v1/funktionen", null), 200).body(), "ST-1", "AN-2", w);
        assertThat(halle2.at("/teilnahme/zustand").asText()).isEqualTo("entwurf");
        assertThat(texte(halle2.at("/teilnahme/aktionen"))).isEmpty();
        assertThat(halle2.at("/teilnahme/pruefliste/3/pruefung").asText()).isEqualTo("grenze");
        assertThat(halle2.at("/teilnahme/pruefliste/3/bestanden").asBoolean(true)).isFalse();

        root.update("UPDATE site_charging_config SET grid_limit_kw = 200 WHERE site_id = ?", w.id("AN-2"));
        Antwort gestartet = ok(ruf(w, HttpMethod.PUT, anlage(w, "AN-2"), Map.of("aktion", "starten")), 200);

        assertThat(gestartet.body().path("aktion").asText()).isEqualTo("starten");
        assertThat(texte(gestartet.body().path("betroffen"), "name")).containsExactly(w.name("AN-2"));
        assertThat(root.queryForObject("SELECT zustand FROM funktion_teilnahme WHERE id = ?", String.class, teilnahme))
                .isEqualTo("aktiv");
        assertThat(root.queryForObject("SELECT gestartet_am IS NOT NULL FROM funktion_teilnahme WHERE id = ?",
                Boolean.class, teilnahme)).isTrue();
        assertThat(ruhen(w, "AN-2")).as("der Start hebt die Ruhe auf").isZero();
        assertThat(root.queryForObject("SELECT zustand FROM funktion WHERE id = ?", String.class, funktion))
                .isEqualTo("aktiv");
        JsonNode st1 = gestartet.body().path("standort");
        assertThat(st1.at("/steuern/zustand").asText()).isEqualTo("aktiv");
        assertThat(st1.at("/steuern/text").asText()).isEqualTo("Läuft mit " + w.name("AN-2"));
    }

    @Test
    void a3PruefenOhneStartLaesstTeilnahmeBetriebsmodellRuheUndBefehlsverlaufUnveraendert() throws Exception {
        Welt w = welt();
        UUID funktion = funktion(w, "ST-1", "eingerichtet");
        teilnahme(w, funktion, "AN-2", "eingerichtet", null, false);
        ruhe(w, "AN-2");
        gruen(w, "AN-2", "ST-1", "NA-2");
        String vorher = stand(w);
        List<Map<String, Object>> profileVorher = root.queryForList(
                "SELECT profile, state FROM site_profile_state WHERE tenant_id = ? ORDER BY profile", w.mandant());
        int befehleVorher = root.queryForObject(
                "SELECT count(*) FROM device_command_log WHERE tenant_id = ?", Integer.class, w.mandant());

        JsonNode p = ok(ruf(w, HttpMethod.GET, pruefung(w, "AN-2"), null), 200).body();

        assertThat(p.path("bereit").asBoolean()).isTrue();
        assertThat(p.path("zeilen")).allMatch(z -> z.path("bestanden").asBoolean());
        assertThat(p.path("folgen").asText()).contains("spätestens in 15 Minuten");
        assertThat(stand(w)).isEqualTo(vorher);
        assertThat(root.queryForList(
                "SELECT profile, state FROM site_profile_state WHERE tenant_id = ? ORDER BY profile", w.mandant()))
                .isEqualTo(profileVorher);
        assertThat(root.queryForObject("SELECT count(*) FROM device_command_log WHERE tenant_id = ?",
                Integer.class, w.mandant())).isEqualTo(befehleVorher);
        assertThat(ruhen(w, "AN-2")).as("bis zum ausdrücklichen Start in Ruhe").isEqualTo(1);
    }

    @Test
    void a3AufnehmenLegtNurEntwurfUndRuheAnUndLoestKeineSteuerungAus() throws Exception {
        Welt w = welt();
        int profileVorher = root.queryForObject(
                "SELECT count(*) FROM site_profile_state WHERE tenant_id = ?", Integer.class, w.mandant());
        int befehleVorher = root.queryForObject(
                "SELECT count(*) FROM device_command_log WHERE tenant_id = ?", Integer.class, w.mandant());

        JsonNode antwort = ok(ruf(w, HttpMethod.PUT, anlage(w, "AN-2"), Map.of("aktion", "aufnehmen")), 200).body();

        assertThat(antwort.path("aktion").asText()).isEqualTo("aufnehmen");
        assertThat(root.queryForObject("SELECT zustand FROM funktion_teilnahme WHERE tenant_id = ? AND site_id = ?",
                String.class, w.mandant(), w.id("AN-2"))).isEqualTo("entwurf");
        assertThat(root.queryForObject("SELECT zustand FROM funktion WHERE tenant_id = ? AND standort_id = ? "
                + "AND funktion = 'steuern'", String.class, w.mandant(), w.id("ST-1"))).isEqualTo("entwurf");
        assertThat(ruhen(w, "AN-2")).isEqualTo(1);
        assertThat(root.queryForObject("SELECT count(*) FROM site_profile_state WHERE tenant_id = ?",
                Integer.class, w.mandant())).isEqualTo(profileVorher);
        assertThat(root.queryForObject("SELECT count(*) FROM device_command_log WHERE tenant_id = ?",
                Integer.class, w.mandant())).isEqualTo(befehleVorher);
    }

    @Test
    void startIstAllesOderNichtsWennDerFunktionsschrittScheitert() throws Exception {
        Welt w = welt();
        UUID funktion = funktion(w, "ST-1", "eingerichtet");
        UUID teilnahme = teilnahme(w, funktion, "AN-2", "eingerichtet", null, false);
        ruhe(w, "AN-2");
        gruen(w, "AN-2", "ST-1", "NA-2");
        String vorher = stand(w);
        root.execute("CREATE OR REPLACE FUNCTION funktion_start_testfehler() RETURNS trigger LANGUAGE plpgsql AS "
                + "$$ BEGIN RAISE EXCEPTION 'erzwungener Startfehler'; END $$");
        root.execute("CREATE TRIGGER funktion_start_testfehler BEFORE UPDATE ON funktion FOR EACH ROW "
                + "WHEN (NEW.zustand = 'aktiv' AND OLD.zustand <> 'aktiv') EXECUTE FUNCTION funktion_start_testfehler()");
        try {
            assertThatThrownBy(() -> ruf(w, HttpMethod.PUT, anlage(w, "AN-2"), Map.of("aktion", "starten")))
                    .hasMessageContaining("erzwungener Startfehler");
        } finally {
            root.execute("DROP TRIGGER funktion_start_testfehler ON funktion");
            root.execute("DROP FUNCTION funktion_start_testfehler()");
        }
        assertThat(stand(w)).as("Teilnahme, Funktion und Ruhe rollen gemeinsam zurück").isEqualTo(vorher);
        assertThat(root.queryForObject("SELECT zustand FROM funktion_teilnahme WHERE id = ?", String.class, teilnahme))
                .isEqualTo("eingerichtet");
        assertThat(ruhen(w, "AN-2")).isEqualTo(1);
    }

    /** AP-01 IP-13: die neue Kunden-Route prüft NA-2, bevor sie denselben Box-Wunsch speichert. */
    @Test
    void kundenGrenze220Bei200VereinbartIst422MitGrundUndSchreibtNichts() throws Exception {
        Welt w = welt();
        gruen(w, "AN-2", "ST-1", "NA-2");
        root.update("INSERT INTO site_charging_config (site_id, tenant_id, house_reserve_kw, "
                + "max_house_load_kw, updated_at, updated_by) VALUES (?, ?, 30, 96.5, now(), 'test')",
                w.id("AN-2"), w.mandant());

        Antwort zuHoch = ruf(w, HttpMethod.PUT, "/api/v1/sites/" + w.id("AN-2") + "/charging-frame",
                Map.of("gridLimitKw", 220));

        assertThat(zuHoch.status()).as(zuHoch.body().toString()).isEqualTo(422);
        assertThat(zuHoch.body().path("message").asText())
                .isEqualTo("220 kW liegen über 200 kW vereinbarter Leistung (Netzanschluss NA-2) — bitte prüfen.");
        assertThat(root.queryForObject("SELECT grid_limit_kw IS NULL FROM site_charging_config WHERE site_id = ?",
                Boolean.class, w.id("AN-2"))).isTrue();

        Antwort passend = ok(ruf(w, HttpMethod.PUT, "/api/v1/sites/" + w.id("AN-2") + "/charging-frame",
                Map.of("gridLimitKw", 200)), 200);
        assertThat(passend.body().path("gridLimitKw").decimalValue()).isEqualByComparingTo("200");
        assertThat(passend.body().at("/frame/houseReserveKw").decimalValue()).isEqualByComparingTo("30");
    }

    // ============================================================================ Nachweis 2

    @Test
    void anhaltenSetztDieRuheOhneEndeUndFortsetzenPrueftErneut() throws Exception {
        Welt w = welt();
        UUID funktion = funktion(w, "ST-1", "aktiv");
        UUID teilnahme = teilnahme(w, funktion, "AN-1", "aktiv", LSK_SEIT, true);

        Antwort a = ok(ruf(w, HttpMethod.PUT, anlage(w, "AN-1"), Map.of("aktion", "anhalten")), 200);

        Map<String, Object> ruhe = root.queryForMap("SELECT kind, entity_id, ends_at, herkunft, created_by "
                + "FROM device_override WHERE site_id = ?", w.id("AN-1"));
        assertThat(ruhe.get("kind")).isEqualTo("pause");
        assertThat(ruhe.get("entity_id")).isNull();
        assertThat(ruhe.get("ends_at")).as("die Ruhe hat nie ein Ende").isNull();
        assertThat(ruhe.get("herkunft")).isEqualTo("funktion");
        assertThat(ruhe.get("created_by")).isEqualTo("sub-jonas-" + w.mandant());
        assertThat(root.queryForMap("SELECT zustand, angehalten_seit IS NOT NULL AS seit, gestartet_am "
                + "FROM funktion_teilnahme WHERE id = ?", teilnahme))
                .containsEntry("zustand", "angehalten").containsEntry("seit", true)
                .containsEntry("gestartet_am", Timestamp.from(LSK_SEIT));
        assertThat(root.queryForObject("SELECT zustand FROM funktion WHERE id = ?", String.class, funktion))
                .isEqualTo("angehalten");
        JsonNode halle1 = anlageIn(a.body().path("standort"), w.name("AN-1"));
        assertThat(halle1.at("/teilnahme/text").asText()).startsWith("Angehalten seit ");
        assertThat(texte(halle1.at("/teilnahme/aktionen"))).containsExactly("beenden");

        // Nochmal anhalten: der Grund des Vertrags, nichts geschrieben.
        Antwort doppelt = ruf(w, HttpMethod.PUT, anlage(w, "AN-1"), Map.of("aktion", "anhalten"));
        assertThat(doppelt.status()).isEqualTo(409);
        assertThat(doppelt.body().path("code").asText()).isEqualTo("bereits_angehalten");
        assertThat(doppelt.body().path("message").asText()).isEqualTo("Steuerung bereits angehalten");

        // Fortsetzen prüft die Liste erneut (E9): ohne Box, Freigabe, Netzanschluss bleibt sie angehalten.
        Antwort fortsetzen = ruf(w, HttpMethod.PUT, anlage(w, "AN-1"), Map.of("aktion", "fortsetzen"));
        assertThat(fortsetzen.status()).as(fortsetzen.body().toString()).isEqualTo(409);
        assertThat(fortsetzen.body().path("code").asText()).isEqualTo("pruefliste_offen");
        assertThat(ruhen(w, "AN-1")).as("die Ruhe bleibt stehen").isEqualTo(1);

        // Mit grünen Fakten setzt es fort und hebt die Ruhe auf — der Start bleibt der vom 02.05.2024.
        gruen(w, "AN-1", "ST-1", "NA-1");
        ok(ruf(w, HttpMethod.PUT, anlage(w, "AN-1"), Map.of("aktion", "fortsetzen")), 200);
        assertThat(ruhen(w, "AN-1")).isZero();
        assertThat(root.queryForMap("SELECT zustand, angehalten_seit, gestartet_am FROM funktion_teilnahme WHERE id = ?",
                teilnahme)).containsEntry("zustand", "aktiv").containsEntry("angehalten_seit", null)
                .containsEntry("gestartet_am", Timestamp.from(LSK_SEIT));
    }

    // ============================================================================ Nachweis 3

    @Test
    void standortAnhaltenSetztDieRuheFuerAlleTeilnehmendenAnlagenUndBeendenArchiviert() throws Exception {
        Welt w = welt();
        UUID zweite = neueAnlage(w, "AN-X", "Werk Ahrenberg – Halle 3", "ST-1");
        UUID funktion = funktion(w, "ST-1", "aktiv");
        UUID t1 = teilnahme(w, funktion, "AN-1", "aktiv", LSK_SEIT, true);
        UUID t2 = teilnahme(w, funktion, "AN-2", "aktiv", Instant.parse("2026-12-01T07:00:00Z"), false);
        UUID t3 = teilnahme(w, funktion, "AN-X", "eingerichtet", null, false);

        Antwort a = ok(ruf(w, HttpMethod.PUT, standort(w, "ST-1"), Map.of("aktion", "anhalten")), 200);

        assertThat(texte(a.body().path("betroffen"), "name")).containsExactly(w.name("AN-1"), w.name("AN-2"));
        for (String an : List.of("AN-1", "AN-2")) {
            assertThat(root.queryForMap("SELECT kind, ends_at, herkunft FROM device_override WHERE site_id = ? "
                    + "AND entity_id IS NULL", w.id(an)))
                    .as(an).containsEntry("kind", "pause").containsEntry("ends_at", null).containsEntry("herkunft", "funktion");
        }
        assertThat(root.queryForObject("SELECT count(*) FROM device_override WHERE site_id = ?", Long.class, zweite))
                .as("eine nie gestartete Anlage wird nicht angehalten").isZero();
        assertThat(zustaende(t1, t2, t3)).containsExactly("angehalten", "angehalten", "eingerichtet");
        assertThat(root.queryForObject("SELECT zustand FROM funktion WHERE id = ?", String.class, funktion))
                .isEqualTo("angehalten");
        assertThat(a.body().at("/standort/steuern/zustand").asText()).isEqualTo("angehalten");
        assertThat(texte(a.body().at("/standort/steuern/aktionen"))).contains("beenden").doesNotContain("anhalten");

        // Standort-Fortsetzen ist ganz oder gar nicht: rote Listen → keine Teilnahme fortgesetzt.
        Antwort fortsetzen = ruf(w, HttpMethod.PUT, standort(w, "ST-1"), Map.of("aktion", "fortsetzen"));
        assertThat(fortsetzen.status()).isEqualTo(409);
        assertThat(fortsetzen.body().path("code").asText()).isEqualTo("pruefliste_offen");
        assertThat(texte(fortsetzen.body().path("fehlt"))).contains("Box " + w.name("AN-1"), "Box " + w.name("AN-2"));
        assertThat(zustaende(t1, t2, t3)).containsExactly("angehalten", "angehalten", "eingerichtet");

        // Beenden: beide archiviert, die Ruhe bleibt (eine beendete Anlage steuert nicht), die Funktion archiviert
        // erst, wenn KEINE Teilnahme mehr läuft — die nie gestartete Halle 3 hält den Standort darüber.
        Antwort beenden = ok(ruf(w, HttpMethod.PUT, standort(w, "ST-1"), Map.of("aktion", "beenden")), 200);
        assertThat(texte(beenden.body().path("betroffen"), "name")).containsExactly(w.name("AN-1"), w.name("AN-2"));
        assertThat(zustaende(t1, t2, t3)).containsExactly("archiviert", "archiviert", "eingerichtet");
        assertThat(ruhen(w, "AN-1") + ruhen(w, "AN-2")).isEqualTo(2);
        assertThat(beenden.body().at("/standort/steuern/zustand").asText()).isIn("entwurf", "eingerichtet");
        assertThat(root.queryForObject("SELECT zustand FROM funktion WHERE id = ?", String.class, funktion))
                .isIn("entwurf", "eingerichtet");
    }

    // ============================================================================ Nachweis 4

    @Test
    void fremdeAnlageUndFremderStandortSind404NieDerGrundUndNichtsGeschrieben() throws Exception {
        Welt a = welt();
        Welt b = welt();
        UUID funktion = funktion(a, "ST-1", "aktiv");
        teilnahme(a, funktion, "AN-1", "aktiv", LSK_SEIT, true);
        String vorher = stand(a);

        for (String aktion : List.of("anhalten", "beenden", "quatsch")) {
            Antwort anl = ruf(b, HttpMethod.PUT, anlage(a, "AN-1"), Map.of("aktion", aktion));
            assertThat(anl.status()).as(aktion).isEqualTo(404);
            assertThat(anl.body().path("code").asText()).isEqualTo("nicht_gefunden");
            Antwort st = ruf(b, HttpMethod.PUT, standort(a, "ST-1"), Map.of("aktion", aktion));
            assertThat(st.status()).as(aktion).isEqualTo(404);
            assertThat(st.body().path("code").asText()).isEqualTo("nicht_gefunden");
        }
        assertThat(ruf(b, HttpMethod.PUT, "/api/v1/sites/keine-id/funktionen/steuern", Map.of("aktion", "anhalten"))
                .status()).isEqualTo(404);
        assertThat(ruf(b, HttpMethod.GET, pruefung(a, "AN-1"), null).status()).isEqualTo(404);
        assertThat(stand(a)).isEqualTo(vorher);
        // Die Übersicht des fremden Kundenbereichs kennt die Standorte von A nicht.
        JsonNode sicht = ok(ruf(b, HttpMethod.GET, "/api/v1/funktionen", null), 200).body();
        for (JsonNode s : sicht.path("standorte")) {
            assertThat(s.path("id").asText()).isNotIn(a.id("ST-1").toString(), a.id("ST-2").toString());
        }
        // Im eigenen Kundenbereich: eine unbekannte Aktion ist 400, „starten“ am Standort auch.
        Antwort quatsch = ruf(a, HttpMethod.PUT, anlage(a, "AN-1"), Map.of("aktion", "quatsch"));
        assertThat(quatsch.status()).isEqualTo(400);
        assertThat(quatsch.body().path("code").asText()).isEqualTo("anfrage_ungueltig");
        assertThat(ruf(a, HttpMethod.PUT, standort(a, "ST-1"), Map.of("aktion", "starten")).status()).isEqualTo(400);
        assertThat(ruf(a, HttpMethod.PUT, anlage(a, "AN-1"), Map.of("aktion", "anhalten", "bis", "morgen")).status())
                .isEqualTo(400);
        assertThat(stand(a)).isEqualTo(vorher);
    }

    // ============================================== Messen & Auswerten einrichten (AP-01 IP-9a, Schritt 1)

    @Test
    void messenEinrichtenLegtDieFunktionImEntwurfGenauEinmalAnFremdIst404ArchiviertIst409() throws Exception {
        Welt a = welt();
        Welt b = welt();
        String pfad = messen(a, "ST-2");
        String vorher = stand(a);

        // Fremd ist 404 — vor der Aktion geprüft, nichts geschrieben.
        for (String aktion : List.of("einrichten", "quatsch")) {
            Antwort fremd = ruf(b, HttpMethod.PUT, pfad, Map.of("aktion", aktion));
            assertThat(fremd.status()).as(aktion).isEqualTo(404);
            assertThat(fremd.body().path("code").asText()).isEqualTo("nicht_gefunden");
        }
        // Im eigenen Kundenbereich gibt es nur „einrichten“ — alles andere ist 400.
        for (String aktion : List.of("starten", "anhalten", "beenden", "aufnehmen", "quatsch")) {
            Antwort falsch = ruf(a, HttpMethod.PUT, pfad, Map.of("aktion", aktion));
            assertThat(falsch.status()).as(aktion).isEqualTo(400);
            assertThat(falsch.body().path("code").asText()).isEqualTo("anfrage_ungueltig");
        }
        assertThat(stand(a)).isEqualTo(vorher);

        JsonNode erst = ok(ruf(a, HttpMethod.PUT, pfad, Map.of("aktion", "einrichten")), 200).body();
        assertThat(erst.path("aktion").asText()).isEqualTo("einrichten");
        assertThat(erst.at("/standort/id").asText()).isEqualTo(a.id("ST-2").toString());
        assertThat(erst.at("/standort/messen/zustand").asText()).isEqualTo("entwurf");
        assertThat(messenZeilen(a, "ST-2")).containsExactly("entwurf|Jonas Wendlinger");
        String nachEinrichten = stand(a);

        // Ein zweites Einrichten ist der Grund des Vertrags — nie eine zweite Funktion, nichts geschrieben.
        Antwort zweit = ruf(a, HttpMethod.PUT, pfad, Map.of("aktion", "einrichten"));
        assertThat(zweit.status()).isEqualTo(409);
        assertThat(zweit.body().path("code").asText()).isEqualTo("bereits_angelegt");
        assertThat(zweit.body().path("message").asText()).isEqualTo("Messen & Auswerten ist hier bereits angelegt");
        assertThat(messenZeilen(a, "ST-2")).hasSize(1);
        assertThat(stand(a)).isEqualTo(nachEinrichten);

        // Die Übersicht liest dasselbe: Lindach im Entwurf, Ahrenberg ohne Funktion, Steuern unberührt.
        JsonNode sicht = ok(ruf(a, HttpMethod.GET, "/api/v1/funktionen", null), 200).body();
        assertThat(standortIn(sicht, a.id("ST-2")).at("/messen")).isEqualTo(erst.at("/standort/messen"));
        assertThat(standortIn(sicht, a.id("ST-1")).at("/messen/zustand").asText()).isEqualTo("kein_objekt");
        assertThat(standortIn(sicht, a.id("ST-2")).at("/steuern/zustand").asText()).isEqualTo("kein_objekt");

        // Ein archivierter Standort bekommt keine Funktion mehr.
        a.ids().put("ST-9", root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, "
                + "zeitzone, zustand, archiviert_am) VALUES (?, ?, 'Werk Altstadt', 'ST-9', 'Europe/Berlin', "
                + "'archiviert', now()) RETURNING id", UUID.class, a.mandant(), a.id("U")));
        Antwort archiviert = ruf(a, HttpMethod.PUT, messen(a, "ST-9"), Map.of("aktion", "einrichten"));
        assertThat(archiviert.status()).isEqualTo(409);
        assertThat(archiviert.body().path("code").asText()).isEqualTo("standort_archiviert");
        assertThat(messenZeilen(a, "ST-9")).isEmpty();
    }

    // ================================================================================ Lesen

    @Test
    void dieUebersichtZeigtJeStandortBeideFunktionenUndDasUnternehmen() throws Exception {
        Welt w = welt();
        UUID funktion = funktion(w, "ST-1", "aktiv");
        teilnahme(w, funktion, "AN-1", "aktiv", LSK_SEIT, true);

        JsonNode sicht = ok(ruf(w, HttpMethod.GET, "/api/v1/funktionen", null), 200).body();

        assertThat(sicht.at("/unternehmen/steuern/text").asText())
                .isEqualTo("Steuern & Optimieren läuft an 1 von 2 Standorten");
        assertThat(sicht.at("/unternehmen/steuern/laeuft_an").asInt()).isEqualTo(1);
        assertThat(sicht.at("/unternehmen/messen/text").asText())
                .isEqualTo("Messen & Auswerten läuft an 0 von 2 Standorten");
        JsonNode st1 = standortIn(sicht, w.id("ST-1"));
        assertThat(st1.path("kurzzeichen").asText()).isEqualTo("ST-1");
        assertThat(st1.at("/steuern/zustand").asText()).isEqualTo("aktiv");
        assertThat(java.time.OffsetDateTime.parse(st1.at("/steuern/seit").asText()).toInstant()).isEqualTo(LSK_SEIT);
        assertThat(st1.at("/steuern/text").asText()).isEqualTo("Läuft mit " + w.name("AN-1"));
        assertThat(texte(st1.at("/steuern/aktionen"))).containsExactly("anhalten", "beenden");
        assertThat(st1.at("/messen/zustand").asText()).isEqualTo("kein_objekt");
        assertThat(st1.at("/messen/text").asText()).isEqualTo("Messen & Auswerten — noch nicht eingerichtet");

        JsonNode halle1 = anlageIn(st1, w.name("AN-1"));
        assertThat(halle1.at("/teilnahme/zustand").asText()).isEqualTo("aktiv");
        assertThat(halle1.at("/teilnahme/text").asText()).isEqualTo("Gestartet am 02.05.2024 (übernommen)");
        assertThat(halle1.at("/teilnahme/uebernommen").asBoolean()).isTrue();
        assertThat(halle1.at("/teilnahme/pruefliste")).isEmpty();
        assertThat(texte(halle1.at("/teilnahme/aktionen"))).containsExactly("anhalten", "beenden");
        JsonNode halle2 = anlageIn(st1, w.name("AN-2"));
        assertThat(halle2.at("/teilnahme/zustand").asText()).isEqualTo("kein_objekt");
        assertThat(halle2.at("/teilnahme/text").asText()).isEqualTo("Diese Anlage misst nur");
        assertThat(texte(halle2.at("/teilnahme/aktionen"))).isEmpty();

        JsonNode st2 = standortIn(sicht, w.id("ST-2"));
        assertThat(st2.at("/steuern/zustand").asText()).isEqualTo("kein_objekt");
        assertThat(st2.at("/steuern/text").asText()).isEqualTo("Steuern & Optimieren — noch nicht eingerichtet");

        // Übernommen OHNE Startdatum (nur Lade-Steuerart im Bestand): der Satz des Vertrags ohne Datum.
        Welt ohne = welt();
        teilnahme(ohne, funktion(ohne, "ST-2", "aktiv"), "AN-3", "aktiv", null, true);
        JsonNode lindach = anlageIn(standortIn(ok(ruf(ohne, HttpMethod.GET, "/api/v1/funktionen", null), 200).body(),
                ohne.id("ST-2")), ohne.name("AN-3"));
        assertThat(lindach.at("/teilnahme/text").asText()).isEqualTo("Gestartet (übernommen)");
        assertThat(lindach.at("/teilnahme/seit").isNull()).isTrue();
    }

    /**
     * AP-13 IP-7 (E13 = A, W6): die Datenlage von „Messen &amp; Auswerten“ ist die Zählung des Registers — dieselbe Zahl,
     * die {@code GET /api/v1/messstellen} für den Standort nennt. Der Fall ist so gebaut, dass die Zählung VOR IP-7 (nur
     * gemessene, nicht archivierte Zeilen) etwas anderes sagte: MS-01 liefert, MS-31 ist berechnet ohne Formel (keine
     * Datenquelle → Nenner), MS-32 ist archiviert (steht im Register, also im Nenner).
     */
    @Test
    void dieDatenlageVonMessenIstDieZaehlungDesRegisters() throws Exception {
        Welt w = welt();
        gruen(w, "AN-1", "ST-1", "NA-1");
        root.update("INSERT INTO funktion (tenant_id, standort_id, funktion, zustand, geaendert_von) "
                + "VALUES (?, ?, 'messen', 'entwurf', 'test')", w.mandant(), w.id("ST-1"));
        messstelleOhneQuelle(w, "MS-31", "berechnet", "ST-1", null);
        messstelleOhneQuelle(w, "MS-32", "gemessen", "ST-1", Instant.parse("2026-01-02T00:00:00Z"));

        JsonNode register = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen", null), 200).body();
        String zaehlung = null;
        for (JsonNode s : register.at("/aggregat/standorte")) {
            if ("ST-1".equals(s.path("kurzzeichen").asText())) {
                zaehlung = s.path("text").asText();
            }
        }
        // Die Zählung VOR IP-7, aus denselben Zeilen nachgestellt: nur gemessene mit Beobachtung, nicht archiviert.
        List<ZustandAbleitung.LiefertDaten> alt = new ArrayList<>();
        for (JsonNode z : register.path("register")) {
            if ("ST-1".equals(z.at("/ort/standort").asText()) && !z.path("beobachtung").isNull()
                    && !"archiviert".equals(z.path("lebenszyklus").asText())) {
                alt.add(ZustandAbleitung.LiefertDaten.vonCode(z.at("/beobachtung/zustand").asText()));
            }
        }
        String vorher = ZustandAbleitung.aggregatLiefertDaten(alt, ZustandAbleitung.Einheit.MESSSTELLE).text();

        JsonNode sicht = ok(ruf(w, HttpMethod.GET, "/api/v1/funktionen", null), 200).body();
        String nachher = standortIn(sicht, w.id("ST-1")).at("/messen/datenlage").asText();

        System.out.println("E13 Datenlage ST-1 — vorher: " + vorher + " | nachher: " + nachher + " | Register: " + zaehlung);
        assertThat(vorher).isEqualTo("1 von 1 Messstelle liefert Daten");
        assertThat(zaehlung).isEqualTo("1 von 3 Messstellen liefert Daten");
        assertThat(nachher).isEqualTo(zaehlung);
    }

    // ============================================================================== Gerüst

    /** Eine Messstelle am Standort OHNE Quelle — berechnet ohne Formel oder gemessen, auf Wunsch archiviert. */
    private static void messstelleOhneQuelle(Welt w, String kennzeichen, String art, String standort,
            Instant archiviertAm) {
        UUID m = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart, archiviert_am) VALUES (?, ?, ?, ?, 'Strom', 'Wirkenergie', 'Bezug', "
                + "'kWh', 'Zählerstand', ?) RETURNING id", UUID.class, w.mandant(), kennzeichen, "Prüfung " + kennzeichen,
                art, archiviertAm == null ? null : Timestamp.from(archiviertAm));
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, standort_id, gueltig_ab) VALUES (?,?,?,?)",
                w.mandant(), m, w.id(standort), AB);
    }

    /** Ein Kundenbereich mit Werk Ahrenberg (ST-1), Werk Lindach (ST-2) und AN-1 … AN-3, zugeordnet ab 12.03.2024. */
    private Welt welt() {
        int nr = NR.incrementAndGet();
        Map<String, UUID> ids = new LinkedHashMap<>();
        Map<String, String> namen = new LinkedHashMap<>();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Funktionen #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, "
                + "'Kunststoffwerk Ahrenberg GmbH', 'Europe/Berlin') RETURNING id", UUID.class, t);
        ids.put("U", u);
        for (JsonNode s : referenz.path("standorte")) {
            String kz = s.path("kennzeichen").asText();
            ids.put(kz, root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, "
                    + "zeitzone, zustand) VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u,
                    s.path("name").asText(), kz));
        }
        Welt w = new Welt(t, ids, namen);
        for (JsonNode an : referenz.path("anlagen")) {
            neueAnlage(w, an.path("kennzeichen").asText(), an.path("name").asText(), an.path("standort").asText());
        }
        return w;
    }

    private static UUID neueAnlage(Welt w, String kennzeichen, String name, String standort) {
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, ?) RETURNING id", UUID.class,
                w.mandant(), name);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?, ?, ?, ?)",
                w.mandant(), site, w.id(standort), AB);
        w.ids().put(kennzeichen, site);
        w.namen().put(kennzeichen, name);
        return site;
    }

    private static UUID funktion(Welt w, String standort, String zustand) {
        return root.queryForObject("INSERT INTO funktion (tenant_id, standort_id, funktion, zustand, aktiv_seit, "
                + "geaendert_von) VALUES (?, ?, 'steuern', ?, ?, 'test') RETURNING id", UUID.class, w.mandant(),
                w.id(standort), zustand, "aktiv".equals(zustand) ? Timestamp.from(LSK_SEIT) : null);
    }

    private static UUID teilnahme(Welt w, UUID funktion, String anlage, String zustand, Instant gestartet,
            boolean uebernommen) {
        return root.queryForObject("INSERT INTO funktion_teilnahme (tenant_id, funktion_id, site_id, zustand, "
                + "uebernommen, gestartet_am) VALUES (?, ?, ?, ?, ?, ?) RETURNING id", UUID.class, w.mandant(), funktion,
                w.id(anlage), zustand, uebernommen, gestartet == null ? null : Timestamp.from(gestartet));
    }

    /** Die Ruhe bis zum Start (R0), wie IP-4 sie schreibt. */
    private static void ruhe(Welt w, String anlage) {
        root.update("INSERT INTO device_override (tenant_id, site_id, kind, created_by, herkunft) "
                + "VALUES (?, ?, 'pause', 'test', 'funktion')", w.mandant(), w.id(anlage));
    }

    private static int ruhen(Welt w, String anlage) {
        return root.queryForObject("SELECT count(*) FROM device_override WHERE site_id = ? AND entity_id IS NULL "
                + "AND ends_at IS NULL AND herkunft = 'funktion'", Integer.class, w.id(anlage));
    }

    /**
     * Jede Zeile der Prüfliste grün: Box mit Eingang vor 20 s, Speicher mit Scharfschaltung, Lastspitzenkappung
     * „an“, Netzanschluss mit vereinbarter Leistung ab 12.03.2024 und ein Hauptzähler Bezug, der Daten liefert.
     */
    private void gruen(Welt w, String anlage, String standort, String netzanschluss) throws Exception {
        UUID t = w.mandant();
        UUID site = w.id(anlage);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, name) VALUES (?, ?, ?, ?) "
                + "RETURNING id", UUID.class, t, site, "VP-FUNKTION-" + UUID.randomUUID(), "Box " + anlage);
        root.update("INSERT INTO telemetry (time, received_at, tenant_id, site_id, device_id, power_kw, payload) "
                + "VALUES (now() - interval '20 seconds', now() - interval '20 seconds', ?, ?, ?, 1.5, "
                + "jsonb_build_object('schema_version', 1, 'source', 'test'))", t, site, box);
        root.update("INSERT INTO measurement_point (tenant_id, site_id, role, label, control, device_id, entity_type, "
                + "capabilities, guard_config) VALUES (?, ?, 'battery-hybrid', 'Batteriespeicher', FALSE, ?, "
                + "'battery-hybrid', '{\"measure\":[{\"channel\":\"soc_pct\"}]}'::jsonb, '{}'::jsonb)", t, site, box);
        root.update("INSERT INTO device_control_activation (device_id, activated_by, note) VALUES (?, 'betrieb', "
                + "'Scharfschaltung Prüfstand')", box);
        root.update("INSERT INTO site_profile_state (site_id, profile, state, tenant_id, updated_at) "
                + "VALUES (?, 'lastspitzenkappung', 'an', ?, ?)", site, t, Timestamp.from(LSK_SEIT));

        JsonNode na = null;
        for (JsonNode n : referenz.path("netzanschluesse")) {
            if (n.path("kennzeichen").asText().equals(netzanschluss)) {
                na = n;
            }
        }
        Map<String, Object> anschluss = new LinkedHashMap<>();
        anschluss.put("kennzeichen", netzanschluss);
        anschluss.put("name", na.path("name").asText());
        anschluss.put("malo", na.path("malo").asText());
        anschluss.put("netzbetreiber", na.path("netzbetreiber").asText());
        anschluss.put("anschluss_kva", na.path("anschluss_kva").numberValue());
        anschluss.put("vereinbart_kw", na.path("vereinbart_kw").numberValue());
        anschluss.put("messung", na.path("messung").asText());
        String pfad = "/api/v1/standorte/" + w.id(standort) + "/netzanschluesse";
        String naId = ok(ruf(w, HttpMethod.POST, pfad, anschluss), 201).body().path("id").asText();
        ok(ruf(w, HttpMethod.POST, pfad + "/" + naId + "/anlagen",
                Map.of("anlage_id", site.toString(), "gueltig_ab", AB.toString())), 201);

        String kennzeichen = "AN-1".equals(anlage) ? "MS-01" : "MS-10";
        UUID zaehler = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "device_id, communication, connection_json, created_at) VALUES (?, ?, 'modbus-generic', ?, "
                + "'modbus-generic', ?, 'modbus_tcp', '{\"unit_id\":1}'::jsonb, ?) RETURNING id", UUID.class, t, site,
                "Zähler " + kennzeichen, box, Timestamp.from(Instant.parse("2024-03-12T00:00:00Z")));
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), '2026.08.26.3', "
                + "'test', 'pending_edge', 'energy_counter', 'fifteen_minute')", t, site, box, zaehler, ENERGIE_BEZUG);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ?", UUID.class,
                zaehler);
        UUID messstelle = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, "
                + "groesse, richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', "
                + "'kWh', 'Zählerstand') RETURNING id", UUID.class, t, kennzeichen, "Netzbezug " + anlage);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, standort_id, gueltig_ab) VALUES (?,?,?,?)",
                t, messstelle, w.id(standort), AB);
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, gueltig_ab) "
                + "VALUES (?,?,?,'Hauptzähler',?)", t, messstelle, site, AB);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_name, "
                + "actor_art) VALUES (?,?,'Wirkenergie','Bezug',?,?,?,'counter','zaehlerstand','fuehrend',?,false,?,"
                + "'test','voltpilot')", t, messstelle, zaehler, geraet, ENERGIE_BEZUG,
                Timestamp.from(Instant.parse("2024-03-12T00:00:00Z")), Timestamp.from(Instant.parse("2024-03-12T00:01:00Z")));
        root.update("INSERT INTO device_measurement_sample (time, tenant_id, site_id, device_id, point_key, raw_numeric, "
                + "decoded_numeric, quality, catalog_version, edge_sequence, aggregation_kind) VALUES "
                + "(now() - interval '30 seconds', ?, ?, ?, ?, 1000, 1000, 'good', '2026.08.26.3', ?, 'counter')",
                t, site, box, ENERGIE_BEZUG, NR.incrementAndGet());
    }

    /** Teilnahmen, Funktionen und Ruhe-Einträge des Kundenbereichs als Text — der Vergleich „nichts geschrieben“. */
    private static String stand(Welt w) {
        return root.queryForObject("SELECT coalesce((SELECT string_agg(id || zustand || coalesce(gestartet_am::text, '') "
                + "|| coalesce(angehalten_seit::text, '') || coalesce(beendet_am::text, '') || updated_at, ',' ORDER BY id) "
                + "FROM funktion_teilnahme WHERE tenant_id = ?), '') || '|' || coalesce((SELECT string_agg(id || zustand "
                + "|| updated_at, ',' ORDER BY id) FROM funktion WHERE tenant_id = ?), '') || '|' || coalesce((SELECT "
                + "string_agg(id || kind || coalesce(herkunft, '') || created_at, ',' ORDER BY id) FROM device_override "
                + "WHERE tenant_id = ?), '')", String.class, w.mandant(), w.mandant(), w.mandant());
    }

    private static List<String> zustaende(UUID... teilnahmen) {
        List<String> out = new ArrayList<>();
        for (UUID id : teilnahmen) {
            out.add(root.queryForObject("SELECT zustand FROM funktion_teilnahme WHERE id = ?", String.class, id));
        }
        return out;
    }

    private static String anlage(Welt w, String kennzeichen) {
        return "/api/v1/sites/" + w.id(kennzeichen) + "/funktionen/steuern";
    }

    private static String standort(Welt w, String kennzeichen) {
        return "/api/v1/standorte/" + w.id(kennzeichen) + "/funktionen/steuern";
    }

    private static String pruefung(Welt w, String kennzeichen) {
        return anlage(w, kennzeichen) + "/pruefung";
    }

    private static String messen(Welt w, String kennzeichen) {
        return "/api/v1/standorte/" + w.id(kennzeichen) + "/funktionen/messen";
    }

    /** Die Funktionen „Messen &amp; Auswerten“ des Standorts als „zustand|geändert von“. */
    private static List<String> messenZeilen(Welt w, String standort) {
        return root.queryForList("SELECT zustand || '|' || geaendert_von FROM funktion WHERE standort_id = ? "
                + "AND funktion = 'messen' ORDER BY created_at", String.class, w.id(standort));
    }

    private static JsonNode standortIn(JsonNode sicht, UUID id) {
        for (JsonNode s : sicht.path("standorte")) {
            if (s.path("id").asText().equals(id.toString())) {
                return s;
            }
        }
        throw new AssertionError("Standort " + id + " fehlt in " + sicht);
    }

    private static JsonNode anlageIn(JsonNode sicht, String standort, String anlage, Welt w) {
        return anlageIn(standortIn(sicht, w.id(standort)), w.name(anlage));
    }

    private static JsonNode anlageIn(JsonNode standort, String name) {
        for (JsonNode a : standort.at("/steuern/anlagen")) {
            if (a.path("name").asText().equals(name)) {
                return a;
            }
        }
        throw new AssertionError("Anlage " + name + " fehlt in " + standort);
    }

    private static List<String> texte(JsonNode liste) {
        List<String> out = new ArrayList<>();
        liste.forEach(x -> out.add(x.asText()));
        return out;
    }

    private static List<String> texte(JsonNode liste, String feld) {
        List<String> out = new ArrayList<>();
        liste.forEach(x -> out.add(x.path(feld).asText()));
        return out;
    }

    private static Antwort ok(Antwort a, int status) {
        assertThat(a.status()).as(a.body().toString()).isEqualTo(status);
        return a;
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
