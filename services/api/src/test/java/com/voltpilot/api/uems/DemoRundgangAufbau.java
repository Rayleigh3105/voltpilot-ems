package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.springframework.mock.web.MockHttpServletResponse;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Der Rundgang der Demo-Umgebung (Captain 27.09.2026: „ein Benutzer, der alles hat“) — kein Test, ein Werkzeug wie
 * {@link PruefumgebungAhrenbergAufbau}: nur mit {@code -Drundgang.jdbc=…} aktiv, Aufruf über
 * {@code infra/local/demo/demo.sh rundgang}. Er legt auf die Welt 1.10 von Ahrenberg, was ihr zum Vorzeigen fehlt:
 * <ul>
 *   <li>„Messen &amp; Auswerten“ an ST-1 und ST-2. Die Welt legt die Funktion nie an, und ohne einen messenden
 *       Standort blendet das Portal Messstellen, Bezugsgrößen, Kennzahlen, Berichte, Bewertung, Ziele und
 *       Energiemanagement aus ({@code ebenenNav.ts}, {@code ebenenBereiche}). Angelegt über die Route des Assistenten;
 *       eingerichtet am Tag der Zeitachse der Referenzdatei (ST-1 01.10.2026, ST-2 15.10.2026) als direkter Stand —
 *       eine Route, die {@code eingerichtet_am} setzt, gibt es nicht (dasselbe Muster wie die Bestandsübernahme).</li>
 *   <li>Monatliche Ablesungen an MS-20 und Monatswerte an BZ-1 ab 10/2024 über die Routen des Portals, bis zum
 *       letzten abgeschlossenen Monat der echten Zeit (Messwerte und Bezugsgrößen laufen auf der echten Uhr, die Welt
 *       des Energiemanagements auf der Bühne). Die Anker der Referenzdatei stimmen, sobald die echte Zeit sie erreicht:
 *       Oktober 2026 88 630 kWh ÷ 312 400 kg, Dezember 2027 78 000 kWh ÷ 250 000 kg, Jahr 2028 876 600 kWh.</li>
 *   <li>Danach ein Rechenlauf der Kennzahlen (sonst stündlich im Stapel) — alle sechs Kennzahlen der Welt lesen
 *       MS-20 ÷ BZ-1.</li>
 * </ul>
 * Idempotent: dieselbe Ablesung und derselbe Bezugswert sind Wiederholungen, die nichts schreiben.
 */
@EnabledIfSystemProperty(named = "rundgang.jdbc", matches = "jdbc:postgresql://.+")
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class DemoRundgangAufbau {
    private static final String JDBC = System.getProperty("rundgang.jdbc", "");
    private static final String EIGNER = System.getProperty("pruefumgebung.eigner", "voltpilot");
    private static final String EIGNER_PW = System.getProperty("pruefumgebung.eigner-passwort", "voltpilot_dev_pw");
    private static final String APP_PW = System.getProperty("pruefumgebung.app-passwort", "voltpilot_app_dev_pw");
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final UUID TENANT = AhrenbergWelt.AHRENBERG;
    private static final Map<String, LocalDate> MESSEN_SEIT = Map.of(
            "20000000-0000-0000-0000-0000000000a1", LocalDate.parse("2026-10-01"),
            "20000000-0000-0000-0000-0000000000a2", LocalDate.parse("2026-10-15"));

    /**
     * Die Netzanschlüsse der Referenzwelt (`docs/contracts/v2/uems-referenzunternehmen.json`,
     * {@code netzanschluesse}): je Anlage Arbeitspreis (Tarif), Leistungspreis und die vereinbarte
     * Leistung. Nichts erfunden - die Zahlen stehen in der Referenz. Der Rundgang spielt sie der
     * Demo zu, damit die Kennzahl-Kacheln (Kosten, Lastspitze) echte Werte tragen.
     */
    private record Anschluss(UUID site, UUID standort, String kennzeichen, String name, String malo, int anschlussKva,
            int vereinbartKw, BigDecimal arbeitspreisCtKwh, int leistungspreisEurKw, LocalDate gebundenAb) {}

    private static final String NETZBETREIBER = "Netzgesellschaft Ahrental (fiktiv)";
    private static final List<Anschluss> ANSCHLUESSE = List.of(
            new Anschluss(UUID.fromString("20000000-0000-0000-0000-000000000501"),
                    UUID.fromString("20000000-0000-0000-0000-0000000000a1"), "NA-1", "Hauptanschluss Halle 1",
                    "47110000001", 630, 550, new BigDecimal("22.4"), 96, LocalDate.parse("2024-03-12")),
            new Anschluss(UUID.fromString("20000000-0000-0000-0000-000000000502"),
                    UUID.fromString("20000000-0000-0000-0000-0000000000a1"), "NA-2", "Anschluss Halle 2",
                    "47110000002", 250, 200, new BigDecimal("23.1"), 96, LocalDate.parse("2026-10-01")),
            new Anschluss(UUID.fromString("20000000-0000-0000-0000-000000000503"),
                    UUID.fromString("20000000-0000-0000-0000-0000000000a2"), "NA-3", "Anschluss Lindach",
                    "47110000003", 160, 120, new BigDecimal("23.8"), 88, LocalDate.parse("2026-10-15")));

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", () -> JDBC);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> APP_PW);
        r.add("spring.flyway.url", () -> JDBC);
        r.add("spring.flyway.user", () -> EIGNER);
        r.add("spring.flyway.password", () -> EIGNER_PW);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> "http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/certs");
        // Die Zuweisungen des Seeds beginnen am 01.10.2026 — Ines Kaltenbach hat ihre Rechte auf der Bühne.
        r.add("voltpilot.pruefumgebung.buehnen-uhr", () -> PruefumgebungAhrenberg.BUEHNE);
    }

    @Autowired MockMvc mvc;
    @Autowired BezugswertService bezugswerte;
    @Autowired KennzahlLauf kennzahlen;

    @Test
    void aufbauen() throws Exception {
        JdbcTemplate root = new JdbcTemplate(new DriverManagerDataSource(JDBC, EIGNER, EIGNER_PW));
        for (var e : MESSEN_SEIT.entrySet()) {
            int s = status("PUT", "/api/v1/standorte/" + e.getKey() + "/funktionen/messen", Map.of("aktion", "einrichten"));
            assertThat(s).as("Messen einrichten an " + e.getKey()).isIn(200, 409);
            Instant seit = e.getValue().atStartOfDay(BERLIN).toInstant();
            root.update("UPDATE funktion SET zustand = 'aktiv', eingerichtet_am = ?::timestamptz, "
                    + "aktiv_seit = ?::timestamptz, updated_at = now() WHERE tenant_id = ? AND standort_id = ?::uuid "
                    + "AND funktion = 'messen' AND eingerichtet_am IS NULL AND archiviert_am IS NULL",
                    seit.toString(), seit.toString(), TENANT, e.getKey());
        }

        UUID bz1 = root.queryForObject("SELECT id FROM bezugsgroesse WHERE tenant_id = ? AND kennzeichen = 'BZ-1'",
                UUID.class, TENANT);
        Map<YearMonth, long[]> reihe = reihe(YearMonth.now(BERLIN).minusMonths(1));
        long stand = 1_250_000;
        ablesung(YearMonth.of(2024, 10).atDay(1), stand);
        int neu = 0;
        for (var m : reihe.entrySet()) {
            stand += m.getValue()[0];
            ablesung(m.getKey().plusMonths(1).atDay(1), stand);
            neu += bezugswert(bz1, m.getKey(), m.getValue()[1]) ? 1 : 0;
        }
        KennzahlLauf.Lauf lauf = kennzahlen.lauf(Instant.now());
        System.out.println("Rundgang: " + reihe.size() + " Monate an MS-20 und BZ-1 (" + neu + " Bezugswerte neu), "
                + "Kennzahlen: " + lauf);

        // Referenzwelt: Netzanschluss (vereinbarte Leistung) als Ines, Tarif als Jonas
        // (kundenadministrator), Leistungspreis als Plattform-Admin - jede Einstellung über ihre
        // echte Route mit dem Recht, das sie trägt. Je Anlage für sich; ein Fehler an einer Anlage
        // (z. B. Lindach noch nicht am Standort) hält die anderen nicht auf.
        int tarife = 0;
        for (Anschluss a : ANSCHLUESSE) {
            try {
                netzanschluss(a);
            } catch (Exception e) {
                System.out.println("Rundgang: Netzanschluss " + a.kennzeichen() + " übersprungen (" + e.getMessage() + ")");
            }
            tarif(a);
            leistungspreis(a);
            tarife++;
        }
        System.out.println("Rundgang: Referenzwerte an " + tarife + " Anlagen (Tarif, Leistungspreis, Netzanschluss).");
    }

    /**
     * Netzanschluss mit vereinbarter Leistung (Ines). Idempotent: liegt schon ein {@code NA-x} vor, wird er auf die
     * Referenzwerte gebracht; sonst wird der HEUTE gebundene Anschluss der Anlage auf die Referenz gehoben (statt einen
     * zweiten daneben zu legen); erst ohne jede Bindung wird neu angelegt. Danach die Bindung (schon gebunden = ok).
     */
    private void netzanschluss(Anschluss a) throws Exception {
        String basis = "/api/v1/standorte/" + a.standort() + "/netzanschluesse";
        JsonNode liste = lies(basis, ines());
        UUID id = null;
        // 1) Schon unter dem Referenz-Kennzeichen da?
        for (JsonNode n : liste.path("netzanschluesse")) {
            if (a.kennzeichen().equals(n.path("kennzeichen").asText())) {
                id = UUID.fromString(n.path("id").asText());
                break;
            }
        }
        // 2) Sonst der heute gebundene Anschluss dieser Anlage (eine Alt-Bindung auf die Referenz heben).
        if (id == null) {
            for (JsonNode n : liste.path("netzanschluesse")) {
                for (JsonNode b : n.path("anlagen")) {
                    if (a.site().toString().equals(b.path("anlage").path("id").asText())
                            && b.path("gueltig_bis").isNull()) {
                        id = UUID.fromString(n.path("id").asText());
                    }
                }
            }
        }
        Map<String, Object> felder = new LinkedHashMap<>();
        felder.put("kennzeichen", a.kennzeichen());
        felder.put("name", a.name());
        felder.put("malo", a.malo());
        felder.put("netzbetreiber", NETZBETREIBER);
        felder.put("anschluss_kva", a.anschlussKva());
        felder.put("vereinbart_kw", a.vereinbartKw());
        felder.put("messung", "RLM");
        if (id == null) {
            MockHttpServletResponse r = antwort("POST", basis, felder, ines(), null);
            if (r.getStatus() == 201) {
                id = UUID.fromString(JSON.readTree(r.getContentAsString(StandardCharsets.UTF_8)).path("id").asText());
            } else if (r.getStatus() != 409) {
                throw new IllegalStateException("POST " + basis + " → " + r.getStatus());
            }
        } else {
            status("PUT", basis + "/" + id, felder, ines(), null);
        }
        if (id != null) {
            status("POST", basis + "/" + id + "/anlagen",
                    Map.of("anlage_id", a.site().toString(), "gueltig_ab", a.gebundenAb().toString()), ines(), null);
        }
    }

    /** Arbeitspreis als fester Tarif (Jonas: {@code anlage.verwalten}); die ganze Darstellung GET-dann-PUT. */
    private void tarif(Anschluss a) throws Exception {
        JsonNode site = lies("/api/v1/sites/" + a.site(), jonas());
        ObjectNode put = JSON.createObjectNode();
        for (String f : List.of("name", "biddingZone", "latitude", "longitude", "plantKind",
                "anzulegenderWertCtKwh", "netzladenErlaubt", "maxFeedInKw")) {
            put.set(f, site.has(f) ? site.get(f) : NullNode.getInstance());
        }
        put.put("tarifArt", "fest");
        put.put("tarifParamCtKwh", a.arbeitspreisCtKwh());
        status("PUT", "/api/v1/sites/" + a.site(), put, jonas(), null);
    }

    /** Leistungspreis + Abrechnung (Plattform-Admin über den Mandanten-Umschalter {@code X-Tenant-Id}). */
    private void leistungspreis(Anschluss a) throws Exception {
        Map<String, Object> cfg = new LinkedHashMap<>();
        cfg.put("leistungspreisEurKw", a.leistungspreisEurKw());
        cfg.put("abrechnungLeistung", "jahr");
        status("PUT", "/api/v1/admin/sites/" + a.site() + "/optimizer-config", cfg, plattformAdmin(), TENANT.toString());
    }

    /**
     * Je Monat {kWh an MS-20, kg an BZ-1} bis {@code bis}: Jahreszeit, langsam sinkender Einsatz je kg, die Anker der
     * Referenz. Nur abgeschlossene Monate der ECHTEN Zeit — ein Bezugswert für einen späteren Monat scheitert an
     * {@code bezugsgroesse_wert_abgeschlossen_chk} (Periodenende ≤ {@code created_at}); die Reihe wächst mit jedem Lauf.
     */
    static Map<YearMonth, long[]> reihe(YearMonth bis) {
        double[] saison = {0.95, 0.97, 1.02, 1.00, 1.01, 0.98, 0.93, 0.85, 1.00, 1.04, 1.02, 0.83};
        Map<YearMonth, long[]> out = new LinkedHashMap<>();
        for (YearMonth m = YearMonth.of(2024, 10); !m.isAfter(YearMonth.of(2029, 3)); m = m.plusMonths(1)) {
            long kg = Math.round(300_000 * saison[m.getMonthValue() - 1] / 100.0) * 100;
            double jeKg = m.getYear() <= 2026 ? 0.292 : m.getYear() == 2027 ? 0.283 : m.getYear() == 2028 ? 0.272 : 0.266;
            jeKg += ((m.getMonthValue() * 7) % 5 - 2) * 0.002;
            out.put(m, new long[] {Math.round(kg * jeKg / 10.0) * 10, kg});
        }
        out.put(YearMonth.of(2026, 10), new long[] {88_630, 312_400});
        out.put(YearMonth.of(2027, 12), new long[] {78_000, 250_000});
        long jahr2028 = 0;
        for (int i = 1; i <= 11; i++) {
            jahr2028 += out.get(YearMonth.of(2028, i))[0];
        }
        out.get(YearMonth.of(2028, 12))[0] = 876_600 - jahr2028;
        out.keySet().removeIf(m -> m.isAfter(bis));
        return out;
    }

    private boolean bezugswert(UUID bz, YearMonth monat, long kg) throws Exception {
        return status("POST", "/api/v1/bezugsgroessen/" + bz + "/werte",
                Map.of("periode", monat.toString(), "wert", zahl(kg))) == 201;
    }

    private void ablesung(LocalDate tag, long stand) throws Exception {
        String zeit = tag.atStartOfDay(BERLIN).toOffsetDateTime().toString();
        int s = status("POST", "/api/v1/messstellen/MS-20/ablesungen", Map.of("zeitpunkt", zeit, "stand", zahl(stand)));
        assertThat(s).as("Ablesung MS-20 " + zeit).isIn(200, 201);
    }

    /** Wie im Portal eingetippt: die Zahl-Regel liest ab vier Stellen nur mit Tausenderpunkten ({@code BezugsdatenRegeln}). */
    private static String zahl(long n) {
        return String.format(Locale.GERMANY, "%,d", n);
    }

    private int status(String method, String path, Object body) throws Exception {
        return status(method, path, body, ines(), null);
    }

    /** Eine Route rufen (gegebener Akteur, optionaler Mandanten-Umschalter) und den Status zurückgeben; wirft bei echten Fehlern. */
    private int status(String method, String path, Object body, Authentication auth, String tenant) throws Exception {
        MockHttpServletResponse r = antwort(method, path, body, auth, tenant);
        if (r.getStatus() >= 400 && r.getStatus() != 409) {
            throw new IllegalStateException(method + " " + path + " " + JSON.writeValueAsString(body) + " → " + r.getStatus()
                    + " " + r.getContentAsString(StandardCharsets.UTF_8));
        }
        return r.getStatus();
    }

    private MockHttpServletResponse antwort(String method, String path, Object body, Authentication auth, String tenant)
            throws Exception {
        var b = request(HttpMethod.valueOf(method), path).with(authentication(auth))
                .contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            b = b.content(JSON.writeValueAsString(body));
        }
        if (tenant != null) {
            b = b.header("X-Tenant-Id", tenant);
        }
        return mvc.perform(b).andReturn().getResponse();
    }

    /** Eine Lese-Route als JSON. */
    private JsonNode lies(String path, Authentication auth) throws Exception {
        MockHttpServletResponse r = antwort("GET", path, null, auth, null);
        if (r.getStatus() >= 400) {
            throw new IllegalStateException("GET " + path + " → " + r.getStatus() + " "
                    + r.getContentAsString(StandardCharsets.UTF_8));
        }
        return JSON.readTree(r.getContentAsString(StandardCharsets.UTF_8));
    }

    /** Ein Realm-Benutzer der Welt 1.10 mit dem gegebenen Subject und Realm-Rollen. */
    private static Authentication benutzer(String subject, String name, List<String> rollen, boolean mitTenant) {
        var b = Jwt.withTokenValue("rundgang").header("alg", "none").subject(subject)
                .issuedAt(Instant.now()).expiresAt(Instant.now().plusSeconds(3600))
                .claim("realm_access", Map.of("roles", rollen)).claim("name", name);
        if (mitTenant) {
            b = b.claim("tenant_id", TENANT.toString());
        }
        return new KeycloakRealmRoleConverter().convert(b.build());
    }

    /** Ines Kaltenbach (Energiemanager) — wie die Welt 1.10; trägt u. a. {@code netzanschluss.verwalten}. */
    private static Authentication ines() {
        return benutzer(AhrenbergWelt.SEED_SUBJECTS.get("IK"), "Ines Kaltenbach", List.of(), true);
    }

    /** Jonas Wendlinger (Kundenadministrator) — trägt {@code anlage.verwalten} (Tarif am Standort/an der Anlage). */
    private static Authentication jonas() {
        return benutzer(AhrenbergWelt.SEED_SUBJECTS.get("JW"), "Jonas Wendlinger", List.of(), true);
    }

    /** Plattform-Betrieb (platform-admin) — der Leistungspreis ist admin-geschützt; der Mandant kommt über {@code X-Tenant-Id}. */
    private static Authentication plattformAdmin() {
        return benutzer("20000000-0000-0000-0000-0000000008ad", "Plattform-Betrieb", List.of("platform-admin"), false);
    }
}
