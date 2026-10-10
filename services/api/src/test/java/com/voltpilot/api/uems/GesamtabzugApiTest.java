package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.kundenbereich.Gesamtabzug;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.zugriff.ZugriffKontextLader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.lang.management.ManagementFactory;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.Authentication;
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
 * UEMS AP-20 IP-17 — Vertragsende II, NW-5 für den Gesamtabzug {@code GET /api/v1/unternehmen/abzug} (E10 = A, BT4,
 * RF-08):
 * <ul>
 *   <li><b>Manifest-Prüfsummen stimmen</b> — jede Datei des Archivs hat im Manifest genau ihre SHA-256 und Bytes,
 *       {@code pruefsummen.sha256} nennt dieselben und die des Manifests; ein Berichtsstand trägt als Datei die
 *       gespeicherte Prüfsumme; nichts aus einem anderen Kundenbereich; der
 *       Abruf steht abgeschlossen im Protokoll mit der SHA-256 des Manifests.</li>
 *   <li><b>Unterstützer und Einsicht 403</b> — ebenso Leserin, Energiemanager und der Umschalter der Plattform; keine
 *       Protokollzeile.</li>
 *   <li><b>Zustand „beendet"</b> — der Filter aus IP-16 lässt den Abzug für den Kundenadministrator durch, alle
 *       anderen bekommen dort seine 409.</li>
 *   <li><b>Großer Bereich ohne Speicher-Spitze</b> — eine Million Messzeilen gehen durch den Strom, während der Cursor
 *       offen ist, und der lebende Speicher wächst dabei um weniger als ein Bruchteil der Daten.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
public class GesamtabzugApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String ABZUG = "/api/v1/unternehmen/abzug";
    private static final String STAND = "{\"titel\":\"Monatsbericht Juni – Größe\",\"werte\":[1,2,3]}";

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
        registry.add("voltpilot.admin-datasource.url", POSTGRES::getJdbcUrl);
        registry.add("voltpilot.admin-datasource.username", () -> "voltpilot_admin");
        registry.add("voltpilot.admin-datasource.password", () -> "voltpilot_admin_test_pw");
        registry.add("spring.flyway.placeholders.adminDbUser", () -> "voltpilot_admin");
        registry.add("spring.flyway.placeholders.adminDbPassword", () -> "voltpilot_admin_test_pw");
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
    @Autowired Gesamtabzug abzug;
    @MockBean KeycloakAdminClient keycloak;

    private JdbcTemplate root;
    private UUID tenant;
    private UUID standort;
    private UUID site;
    private UUID box;
    private String nr;
    private String kundenadmin;

    @BeforeEach
    void seed() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        nr = UUID.randomUUID().toString().substring(0, 8);
        tenant = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Kunststoffwerk Ahrenberg " + nr);
        UUID unternehmen = root.queryForObject("INSERT INTO unternehmen (tenant_id, name) VALUES (?, 'Ahrenberg') "
                + "RETURNING id", UUID.class, tenant);
        standort = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone,"
                + " zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class,
                tenant, unternehmen);
        site = root.queryForObject("INSERT INTO site (tenant_id, name, bidding_zone) VALUES (?, 'Werk', 'DE-LU') "
                + "RETURNING id", UUID.class, tenant);
        box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) RETURNING id",
                UUID.class, tenant, site, "abzug-" + nr);
        kundenadmin = "jw-" + nr;
        person(kundenadmin, "benutzer", "kundenadministrator", null);
        UUID bericht = root.queryForObject("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, "
                + "geltung_art, unternehmen_id, zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_name) "
                + "VALUES (?, 'BR-2027-0006', 'monatsbericht_unternehmen', 1, 'unternehmen', ?, 'monat', '2027-06', "
                + "'Europe/Berlin', 'Ines Kaltenbach') RETURNING id", UUID.class, tenant, unternehmen);
        root.update("INSERT INTO bericht_stand (tenant_id, bericht_id, nr, abzug, pruefsumme, datenstand, freigegeben_am, "
                + "freigeber_sub, freigeber_name, freigeber_rolle, darstellung, regelwerk, vorlage_fassung) VALUES "
                + "(?, ?, 1, ?, ?, '2027-06-30T14:00:00Z', '2027-06-30T14:05:00Z', 'kc-ines-kaltenbach', "
                + "'Ines Kaltenbach', 'energiemanager', '{}'::jsonb, '{}'::jsonb, 1)", tenant, bericht, STAND,
                BerichtRegeln.pruefsumme(STAND));
    }

    /** NW-5: der Kundenadministrator lädt den Abzug; jede Prüfsumme im Manifest stimmt mit dem Inhalt. */
    @Test
    void derKundenadministratorLaedtDenAbzugUndJedePruefsummeImManifestStimmt() throws Exception {
        for (int i = 0; i < 3; i++) {
            root.update("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw, payload) VALUES "
                    + "(now() - make_interval(mins => ?), ?, ?, ?, -2.5, '{\"quelle\":\"=Formel\"}'::jsonb)",
                    i, tenant, site, box);
        }
        UUID fremd = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Nordwind " + nr);
        UUID fremdeBox = UUID.randomUUID();
        root.update("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw) VALUES (now(), ?, ?, ?, 7)",
                fremd, UUID.randomUUID(), fremdeBox);

        MvcResult r = ruf(get(ABZUG), konto(kundenadmin));
        assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString()).isEqualTo(200);
        assertThat(r.getResponse().getContentType()).isEqualTo("application/zip");
        assertThat(r.getResponse().getHeader("Content-Disposition")).startsWith("attachment; filename=gesamtabzug-")
                .endsWith(".zip");
        Map<String, byte[]> dateien = entpacken(r.getResponse().getContentAsByteArray());
        byte[] manifestBytes = dateien.get("manifest.json");
        JsonNode manifest = JSON.readTree(manifestBytes);

        // Jede Datei steht mit ihrer SHA-256 und ihren Bytes im Manifest — und das Manifest nennt keine, die fehlt.
        List<String> genannt = new ArrayList<>();
        for (JsonNode d : manifest.path("dateien")) {
            String pfad = d.path("pfad").asText();
            genannt.add(pfad);
            assertThat(dateien).as(pfad).containsKey(pfad);
            assertThat(d.path("sha256").asText()).as(pfad).isEqualTo(sha256(dateien.get(pfad)));
            assertThat(d.path("bytes").asLong()).as(pfad).isEqualTo(dateien.get(pfad).length);
        }
        assertThat(genannt).hasSize(manifest.path("summe").path("dateien").asInt());
        List<String> imArchiv = new ArrayList<>(dateien.keySet());
        imArchiv.removeAll(List.of("manifest.json", "pruefsummen.sha256"));
        assertThat(genannt).containsExactlyInAnyOrderElementsOf(imArchiv);
        assertThat(genannt.get(genannt.size() - 1)).isEqualTo("LIESMICH.txt");
        // pruefsummen.sha256 im Format von sha256sum -c: dieselben Summen und die des Manifests.
        String summen = new String(dateien.get("pruefsummen.sha256"), StandardCharsets.UTF_8);
        for (JsonNode d : manifest.path("dateien")) {
            assertThat(summen).contains(d.path("sha256").asText() + "  " + d.path("pfad").asText() + "\n");
        }
        assertThat(summen).endsWith(sha256(manifestBytes) + "  manifest.json\n");

        // Der Berichtsstand: die Datei ist genau der gespeicherte Text, ihre SHA-256 die gespeicherte Prüfsumme.
        JsonNode stand = datei(manifest, "staende/BR-2027-0006-stand-1.json");
        assertThat(stand.path("objektart").asText()).isEqualTo("staende");
        assertThat(new String(dateien.get("staende/BR-2027-0006-stand-1.json"), StandardCharsets.UTF_8)).isEqualTo(STAND);
        assertThat(BerichtRegeln.PRUEFSUMME_PRAEFIX + stand.path("sha256").asText())
                .isEqualTo(stand.path("pruefsumme").asText()).isEqualTo(BerichtRegeln.pruefsumme(STAND));

        // Objektarten: Stände, Berichte, Verzeichnis, Messreihen, Protokolle — und der Bestand.
        List<String> arten = new ArrayList<>();
        manifest.path("dateien").forEach(d -> arten.add(d.path("objektart").asText()));
        assertThat(arten).contains("staende", "berichte", "verzeichnis", "messreihen", "protokolle", "bestand");
        assertThat(dateien).containsKeys("verzeichnis/verzeichnis.json", "verzeichnis/verzeichnis.csv",
                "berichte/bericht.csv", "berichte/bericht_stand.csv", "protokolle/kundenbereich_abzug.csv",
                "bestand/standort.csv");

        // Messreihen nur des eigenen Kundenbereichs; Zahlen unverändert, Textzellen mit Formelschutz.
        String telemetrie = new String(dateien.get("messreihen/telemetry.csv"), StandardCharsets.UTF_8);
        assertThat(datei(manifest, "messreihen/telemetry.csv").path("zeilen").asLong()).isEqualTo(3);
        assertThat(telemetrie).startsWith("﻿time;tenant_id;").contains(box.toString())
                .doesNotContain(fremdeBox.toString()).doesNotContain(fremd.toString())
                .contains(";-2.5000;").contains("=Formel");
        assertThat(String.join("\n", dateien.keySet().stream().map(k -> new String(dateien.get(k),
                StandardCharsets.UTF_8)).toList())).doesNotContain(fremd.toString());

        // Heute trägt keine Tabelle eines Kundenbereichs Zugangsdaten — kein Eintrag nennt eine ausgelassene Spalte.
        manifest.path("dateien").forEach(d -> assertThat(d.has("ausgelassen")).as(d.path("pfad").asText()).isFalse());

        assertThat(manifest.path("zustand").asText()).isEqualTo("aktiv");
        assertThat(manifest.path("kundenbereich").path("id").asText()).isEqualTo(tenant.toString());
        assertThat(new String(manifestBytes, StandardCharsets.UTF_8)).doesNotContainIgnoringCase("vollständig")
                .doesNotContainIgnoringCase("konform").doesNotContainIgnoringCase("zertifiziert");

        // Der Abruf ist protokolliert, abgeschlossen, mit der SHA-256 des Manifests.
        List<Map<String, Object>> protokoll = root.queryForList("SELECT * FROM kundenbereich_abzug WHERE tenant_id = ?",
                tenant);
        assertThat(protokoll).hasSize(1);
        assertThat(protokoll.get(0)).containsEntry("akteur_sub", kundenadmin).containsEntry("zustand", "aktiv")
                .containsEntry("manifest_sha256", sha256(manifestBytes))
                .containsEntry("dateien", genannt.size() + 1);
        assertThat(protokoll.get(0).get("abgeschlossen_am")).isNotNull();
    }

    /** NW-5: Unterstützer und Einsicht 403 — ebenso jede andere Rolle und der Umschalter; nichts wird protokolliert. */
    @Test
    void unterstuetzerEinsichtUndJedeAndereRolleBekommen403() throws Exception {
        String leserin = "berger-" + nr;
        String energiemanager = "kaltenbach-" + nr;
        String einsicht = "pruef-" + nr;
        String partner = "partner-" + nr;
        person(leserin, "benutzer", "leser", standort);
        person(energiemanager, "benutzer", "energiemanager", null);
        person(einsicht, "benutzer", "einsicht", null);
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'partner', ?, "
                + "'aktiv')", tenant, partner, partner);
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, art, umfang, gueltig_ab, "
                + "gueltig_bis, endet_am, zeitzone) VALUES (?, ?, 'unterstuetzer', ?, 'installateur', 'ansehen', "
                + "'2024-01-01T00:00:00+01', '2099-12-30', '2099-12-31T00:00:00+01', 'Europe/Berlin')",
                tenant, partner, standort);

        Map<String, MvcResult> antworten = new LinkedHashMap<>();
        antworten.put("Unterstützer", ruf(get(ABZUG).header(ZugriffKontextLader.KUNDENBEREICH_HEADER, tenant.toString()),
                auth(partner, null, "partner")));
        antworten.put("Einsicht", ruf(get(ABZUG), konto(einsicht)));
        antworten.put("Leserin", ruf(get(ABZUG), konto(leserin)));
        antworten.put("Energiemanager", ruf(get(ABZUG), konto(energiemanager)));
        antworten.put("Umschalter der Plattform", ruf(get(ABZUG).header("X-Tenant-Id", tenant.toString()),
                auth("betrieb-voss", null, "platform-admin")));
        for (Map.Entry<String, MvcResult> a : antworten.entrySet()) {
            String koerper = a.getValue().getResponse().getContentAsString(StandardCharsets.UTF_8);
            assertThat(a.getValue().getResponse().getStatus()).as(a.getKey() + ": " + koerper).isEqualTo(403);
            JsonNode k = JSON.readTree(koerper);
            assertThat(k.path("code").asText()).as(a.getKey()).isEqualTo("recht_fehlt");
            assertThat(k.path("message").asText()).isEqualTo("Den Gesamtabzug lädt nur der Kundenadministrator.");
            assertThat(k.path("rolle_noetig").asText()).isEqualTo("kundenadministrator");
        }
        assertThat(root.queryForObject("SELECT count(*) FROM kundenbereich_abzug WHERE tenant_id = ?", Integer.class,
                tenant)).as("eine Ablehnung schreibt kein Protokoll").isZero();
    }

    /** NW-5: im Zustand „beendet" lässt der Filter aus IP-16 den Abzug für den Kundenadministrator durch — nur ihn. */
    @Test
    void imZustandBeendetLaesstDerFilterDenAbzugFuerDenKundenadministratorDurch() throws Exception {
        String leserin = "berger-" + nr;
        String einsicht = "pruef-" + nr;
        person(leserin, "benutzer", "leser", standort);
        person(einsicht, "benutzer", "einsicht", null);
        String name = root.queryForObject("SELECT name FROM tenant WHERE id = ?", String.class, tenant);
        MvcResult beendet = ruf(post("/api/v1/admin/tenants/" + tenant + "/beenden")
                .contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(Map.of("auftrag",
                        "Kündigung zum 30.06.2029 (Annahme)", "begruendung", "Vertragsende RF-08", "confirmName", name))),
                auth("betrieb-voss", null, "platform-admin"));
        assertThat(beendet.getResponse().getStatus()).as(beendet.getResponse().getContentAsString()).isEqualTo(200);

        MvcResult r = ruf(get(ABZUG), konto(kundenadmin));
        assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString()).isEqualTo(200);
        JsonNode manifest = JSON.readTree(entpacken(r.getResponse().getContentAsByteArray()).get("manifest.json"));
        assertThat(manifest.path("zustand").asText()).isEqualTo("beendet");
        assertThat(manifest.path("loeschung_fruehestens").asText()).isNotBlank();
        assertThat(root.queryForObject("SELECT zustand FROM kundenbereich_abzug WHERE tenant_id = ? AND "
                + "abgeschlossen_am IS NOT NULL", String.class, tenant)).isEqualTo("beendet");

        for (String wer : List.of(leserin, einsicht)) {
            MvcResult gesperrt = ruf(get(ABZUG), konto(wer));
            assertThat(gesperrt.getResponse().getStatus()).as(wer).isEqualTo(409);
            assertThat(JSON.readTree(gesperrt.getResponse().getContentAsString(StandardCharsets.UTF_8)).path("code")
                    .asText()).isEqualTo("kundenbereich_beendet");
        }
        JsonNode me = JSON.readTree(ruf(get("/api/v1/me"), konto(kundenadmin)).getResponse()
                .getContentAsString(StandardCharsets.UTF_8)).path("kundenbereich").path("beendet");
        assertThat(me.path("text").asText()).endsWith("Bis dahin können Sie den Gesamtabzug laden.");
    }

    /**
     * NW-5: ein großer Bereich ohne Speicher-Spitze. Eine Million Messzeilen (über 150 MB CSV) gehen durch den Strom;
     * schon während die ersten Megabytes beim Empfänger ankommen, ist der Cursor auf die Messreihe in der Datenbank
     * noch offen — der Abzug liest und schreibt zugleich, nichts wird vorher gesammelt. Der lebende Speicher (nach GC)
     * wächst dabei um weniger als 64 MB.
     */
    @Test
    void einGrosserBereichGehtOhneSpeicherSpitzeDurchDenStrom() throws Exception {
        root.update("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw, soc_pct, pv_power_kw, load_kw) "
                + "SELECT now() - make_interval(secs => g), ?, ?, ?, round((random() * 200 - 100)::numeric, 4), "
                + "round((random() * 100)::numeric, 2), round((random() * 80)::numeric, 4), "
                + "round((random() * 120)::numeric, 4) FROM generate_series(1, 1000000) g", tenant, site, box);
        var speicher = ManagementFactory.getMemoryMXBean();
        System.gc();
        long grundlinie = speicher.getHeapMemoryUsage().getUsed();
        long[] hoechst = {0};
        boolean[] cursorOffen = {false};
        OutputStream empfaenger = new OutputStream() {
            long bytes;
            long naechsteProbe = 1 << 20;

            @Override
            public void write(int b) throws IOException {
                write(new byte[] {(byte) b}, 0, 1);
            }

            @Override
            public void write(byte[] b, int off, int len) {
                bytes += len;
                if (bytes >= naechsteProbe) {
                    naechsteProbe += 2 << 20;
                    System.gc();
                    hoechst[0] = Math.max(hoechst[0], speicher.getHeapMemoryUsage().getUsed() - grundlinie);
                    Integer offen = root.queryForObject("SELECT count(*) FROM pg_stat_activity WHERE usename = ? "
                            + "AND state IN ('active', 'idle in transaction') AND query LIKE '%FROM public.\"telemetry\"%'",
                            Integer.class, APP_USER);
                    cursorOffen[0] |= offen != null && offen > 0;
                }
            }
        };
        Gesamtabzug.Ergebnis ergebnis;
        TenantContext.set(tenant);
        try {
            Gesamtabzug.Abruf abruf = abzug.beginnen(tenant, new ProtokollAkteur(kundenadmin, "JW", "kundenadministrator",
                    "kunde"));
            ergebnis = abzug.schreiben(abruf, empfaenger);
        } finally {
            TenantContext.clear();
        }
        System.out.printf("Großer Bereich: %d Zeilen, %d MB Daten, lebender Speicher höchstens +%d MB, Cursor offen "
                + "beim Empfang: %s%n", ergebnis.zeilen(), ergebnis.bytes() >> 20, hoechst[0] >> 20, cursorOffen[0]);
        assertThat(ergebnis.zeilen()).isGreaterThanOrEqualTo(1_000_000);
        assertThat(ergebnis.bytes()).isGreaterThan(150L << 20);
        assertThat(cursorOffen[0]).as("der Cursor auf die Messreihe ist offen, während die Bytes ankommen").isTrue();
        assertThat(hoechst[0]).as("lebender Speicher über der Grundlinie").isLessThan(64L << 20);
        assertThat(root.queryForObject("SELECT manifest_sha256 FROM kundenbereich_abzug WHERE tenant_id = ?",
                String.class, tenant)).isEqualTo(ergebnis.manifestSha256());
    }

    private static JsonNode datei(JsonNode manifest, String pfad) {
        for (JsonNode d : manifest.path("dateien")) {
            if (d.path("pfad").asText().equals(pfad)) {
                return d;
            }
        }
        throw new AssertionError("nicht im Manifest: " + pfad);
    }

    private static Map<String, byte[]> entpacken(byte[] zip) throws IOException {
        Map<String, byte[]> aus = new LinkedHashMap<>();
        try (ZipInputStream in = new ZipInputStream(new ByteArrayInputStream(zip), StandardCharsets.UTF_8)) {
            ZipEntry e;
            while ((e = in.getNextEntry()) != null) {
                aus.put(e.getName(), in.readAllBytes());
            }
        }
        assertThat(aus).containsKeys("manifest.json", "pruefsummen.sha256", "LIESMICH.txt");
        return aus;
    }

    private static String sha256(byte[] b) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(b));
    }

    private void person(String wer, String konto, String rolle, UUID ort) {
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, ?, ?, 'aktiv')",
                tenant, wer, konto, wer);
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, ?, ?, '2024-01-01T00:00:00Z', 'Europe/Berlin')", tenant, wer, rolle, ort);
    }

    private MvcResult ruf(MockHttpServletRequestBuilder anfrage, Authentication auth) throws Exception {
        return mvc.perform(anfrage.with(authentication(auth))).andReturn();
    }

    private Authentication konto(String wer) {
        return auth(wer, tenant, null);
    }

    private static Authentication auth(String wer, UUID kunde, String realmRolle) {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", wer);
        claims.put("preferred_username", wer);
        claims.put("realm_access", Map.of("roles", realmRolle == null ? List.of() : List.of(realmRolle)));
        if (kunde != null) {
            claims.put("tenant_id", kunde.toString());
        }
        return new KeycloakRealmRoleConverter().convert(new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600),
                Map.of("alg", "none"), claims));
    }
}
