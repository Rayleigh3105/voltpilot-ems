package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.sql.Date;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

/**
 * Die Welt der Maßnahme-Tests (UEMS AP-18) — R3/R5/R6/R7 der Referenzdatei 1.9, gemeinsam für {@link MassnahmeApiTest}
 * und {@link UemsMassnahmeAbnahmeTest}, damit die Abnahme dieselbe Welt liest und keine zweite baut: KZ-0004
 * Spritzguss (MS-20 ÷ BZ-1) mit BB-0001 Fassung 1 (Verhältnis) und Fassung 2 (Modell 10 523 kWh + 0,2343 kWh je kg,
 * Streuung ± 0,8 %, Spannweite 254 000–341 000 kg, gilt ab 01.11.2027); Dezember 2027 78 000 kWh bei 250 000 kg,
 * endgültig ab 07.01.2028; der Einsatz EE-3 Druckluft ohne Kennzahl.
 *
 * <p>Personen: Ines Kaltenbach und Jonas Wendlinger nie zugewiesen (Kundenadministrator), Peter Hollerbach Bearbeiter
 * an ST-1, Murat Demirci Bedienberechtigter an ST-1, Olga Alt mit beendetem Konto. Die Uhr der Kennzahlen ist gestellt.
 */
final class MassnahmeWelt {

    static final ObjectMapper MAPPER = new ObjectMapper();
    static final String PFAD = "/api/v1/massnahmen";
    static final Instant ANGELEGT = Instant.parse("2028-01-15T09:00:00Z");
    static final Instant UMGESETZT = Instant.parse("2028-01-22T09:00:00Z");
    /** Die ganze Referenzdatei 1.9. */
    static final JsonNode REFERENZ = datei();
    /** {@code massnahmen[]} nach Kennzeichen. */
    static final Map<String, JsonNode> RU = nach(REFERENZ.get("massnahmen"), "kennzeichen");
    /** {@code abnahmefaelle_ap18.faelle[]} nach Fall (R5, R6, …). */
    static final Map<String, JsonNode> FAELLE = nach(REFERENZ.at("/abnahmefaelle_ap18/faelle"), "fall");
    private static final AtomicInteger NR = new AtomicInteger();
    private static final Map<String, String> NAMEN = Map.of("ines", "Ines Kaltenbach", "peter", "Peter Hollerbach",
            "murat", "Murat Demirci", "olga", "Olga Alt", "jonas", "Jonas Wendlinger");

    record Welt(UUID mandant, UUID st1, UUID st2, UUID kz4, UUID ee3) {}

    record Antwort(int status, JsonNode body, String text) {}

    private final MockMvc mvc;
    private final KennzahlService kennzahlen;
    private final JdbcTemplate root;

    MassnahmeWelt(MockMvc mvc, KennzahlService kennzahlen, JdbcTemplate root) {
        this.mvc = mvc;
        this.kennzahlen = kennzahlen;
        this.root = root;
    }

    /** M-2028-0001 (R3) angelegt am 15.01.2028 und umgesetzt am 22.01.2028: {id, Ausgangslage, Prüfsumme}. */
    String[] umgesetzteMassnahme(Welt w, String verantwortlich) throws Exception {
        return umgesetzteMassnahme(w, verantwortlich, Map.of());
    }

    /** Wie {@link #umgesetzteMassnahme(Welt, String)}, mit weiteren Feldern im Anlege-Körper (z. B. {@code energieziel}). */
    String[] umgesetzteMassnahme(Welt w, String verantwortlich, Map<String, Object> mehr) throws Exception {
        JsonNode r3 = RU.get("M-2028-0001");
        uhr(ANGELEGT);
        Map<String, Object> body = mitMessgrundlage(w, r3);
        body.put("verantwortlich", sub(w, verantwortlich));
        body.putAll(mehr);
        Antwort neu = ruf(w, "ines", HttpMethod.POST, PFAD, body);
        assertThat(neu.status()).as(neu.text()).isEqualTo(201);
        String id = neu.body().get("id").asText();
        uhr(UMGESETZT);
        Antwort um = ruf(w, "ines", HttpMethod.POST, PFAD + "/" + id + "/umgesetzt", Map.of("am", "2028-01-22",
                "begruendung", r3.get("verlauf").get(1).get("begruendung").asText()));
        assertThat(um.status()).as(um.text()).isEqualTo(200);
        return new String[] {id, neu.body().at("/messgrundlage/ausgangslage").asText(),
                neu.body().at("/messgrundlage/pruefsumme").asText()};
    }

    /** Die Monate der Referenzdatei 1.9: Januar 2028 aus R6, Februar 2028 bis Januar 2029 aus R5 (kWh, kg). */
    void nachher(Welt w, String von, String bis) {
        UUID bz = bz1(w);
        for (YearMonth m = YearMonth.parse(von); !m.isAfter(YearMonth.parse(bis)); m = m.plusMonths(1)) {
            JsonNode n = m.equals(YearMonth.of(2028, 1)) ? FAELLE.get("R6").at("/gegeben/januar_2028")
                    : FAELLE.get("R5").at("/gegeben/je_monat/" + m);
            monat(w.mandant(), w.kz4(), bz, m.atDay(1).toString(), n.get("kwh").asText(), n.get("kg").asText());
        }
    }

    UUID bz1(Welt w) {
        return root.queryForObject("SELECT id FROM bezugsgroesse WHERE tenant_id = ? AND kennzeichen = 'BZ-1'",
                UUID.class, w.mandant());
    }

    static Map<String, Object> mitMessgrundlage(Welt w, JsonNode r3) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("titel", r3.get("titel").asText());
        m.put("verantwortlich", sub(w, "murat"));
        m.put("termin", r3.get("termin").asText());
        m.put("herkunft", r3.at("/herkunft/art").asText());
        m.put("herkunft_kennung", r3.at("/herkunft/kennung").asText());
        m.put("kennzahl", w.kz4().toString());
        m.put("monate", r3.at("/ausgangslage/kopie/monat").asText());
        m.put("erwartete_wirkung_prozent", r3.at("/erwartete_wirkung/prozent").decimalValue());
        m.put("erwartete_wirkung_wortlaut", r3.at("/erwartete_wirkung/wortlaut").asText());
        return m;
    }

    static String sub(Welt w, String person) {
        return "sub-" + person + "-" + w.mandant();
    }

    void uhr(Instant jetzt) {
        kennzahlen.uhrStellen(Clock.fixed(jetzt, ZoneOffset.UTC));
    }

    Welt welt() throws Exception {
        // Kennzahl und Bezugsbasis entstehen vor den Monaten, die sie lesen; danach wieder der Anlegetag.
        uhr(Instant.parse("2026-10-01T09:00:00Z"));
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Maßnahme #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID st1 = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        UUID st2 = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Lindach', 'ST-2', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        UUID g2 = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, 'gebaeude', "
                + "'Halle 2', 'G-2', 'aktiv') RETURNING id", UUID.class, t);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2020-01-01')", t, g2, st1);
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-20', 'Spritzguss', 'gemessen', 'Strom', 'Wirkenergie', "
                + "'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, t);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, NULL, '2020-01-01')", t, ms, g2);
        UUID bz1 = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, "
                + "periode_art, geltung_art, ort_id) VALUES (?, 'BZ-1', 'Produktionsmenge Spritzguss', 'periodenwert', "
                + "'kg', 'monat', 'gebaeude', ?) RETURNING id", UUID.class, t, g2);
        String[][] personen = {{"ines", "Ines Kaltenbach", null, "aktiv"}, {"peter", "Peter Hollerbach", "bearbeiter", "aktiv"},
            {"murat", "Murat Demirci", "bedienberechtigt", "aktiv"}, {"olga", "Olga Alt", null, "entfernt"},
            {"jonas", "Jonas Wendlinger", null, "aktiv"}};
        for (String[] p : personen) {
            String sub = "sub-" + p[0] + "-" + t;
            root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', ?, ?)",
                    t, sub, p[1], p[3]);
            if (p[2] != null) {
                root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                        + "VALUES (?, ?, ?, ?, '2024-01-01', 'Europe/Berlin')", t, sub, p[2], st1);
            }
        }
        Welt ohne = new Welt(t, st1, st2, null, null);
        UUID kz4 = kennzahl(ohne, g2);
        // R3 „gegeben“: Dezember 2027 78 000 kWh bei 250 000 kg, endgültig am 07.01.2028.
        monat(t, kz4, bz1, "2027-12-01", "78000", "250000");

        UUID p3 = root.queryForObject("INSERT INTO prozess (tenant_id, unternehmen_id, kennzeichen, name, gueltig_ab) "
                + "VALUES (?, ?, 'P-3', 'Druckluft', '2024-01-01') RETURNING id", UUID.class, t, u);
        UUID ee3 = root.queryForObject("INSERT INTO energieeinsatz (tenant_id, kennzeichen, prozess_id, traeger, name, "
                + "gueltig_ab, actor_sub, actor_name, actor_art) VALUES (?, 'EE-3', ?, 'Druckluft', 'Druckluft', "
                + "'2026-10-01', 'IK', 'Ines Kaltenbach', 'kunde') RETURNING id", UUID.class, t, p3);
        root.update("INSERT INTO energieeinsatz_einflussgroesse (tenant_id, einsatz_id, wortlaut, art, position) "
                + "VALUES (?, ?, 'Betriebsstunde', 'betriebszeit', 0)", t, ee3);

        Welt w = new Welt(t, st1, st2, kz4, ee3);
        TenantContext.set(t);
        UUID bb1 = basis(w, kz4);
        fassung(t, bb1, 1, bz1, "verhaeltnis", "2026-10/2026-10", "2026-11-01", "2027-10-31", "0.2837", null, null,
                null, null);
        fassung(t, bb1, 2, bz1, "regression_eine_variable", "2026-11/2027-10", "2027-11-01", null, "0.2685",
                "{\"a\": 10523, \"b\": 0.2343}", "0.8", "254000", "341000");
        TenantContext.clear();
        uhr(ANGELEGT);
        return w;
    }

    /** Eine endgültige Monatszeile der Kennzahl (Version 1) und der Bezugsgrößen-Wert (Fassung 1). */
    void monat(UUID t, UUID kennzahl, UUID bz, String erster, String zaehlerText, String nennerText) {
        LocalDate von = LocalDate.parse(erster);
        LocalDate bis = von.plusMonths(1).minusDays(1);
        BigDecimal zaehler = new BigDecimal(zaehlerText);
        BigDecimal nenner = new BigDecimal(nennerText);
        Timestamp am = Timestamp.from(von.plusMonths(1).atStartOfDay().toInstant(ZoneOffset.UTC).plusSeconds(7200));
        Timestamp endgueltig = Timestamp.from(von.plusMonths(1).plusDays(6).atStartOfDay().toInstant(ZoneOffset.UTC));
        UUID fassung = root.queryForObject("SELECT id FROM kennzahl_fassung WHERE kennzahl_id = ? AND nummer = 1",
                UUID.class, kennzahl);
        UUID wert = UUID.randomUUID();
        root.update("INSERT INTO kennzahl_wert (id, tenant_id, kennzahl_id, periode_art, periode_von, periode_bis, zeitzone, "
                + "version, wert, zaehler, nenner, menge_zustand, richtung, kennzeichen, zustand, endgueltig_ab, "
                + "definition_fassung_id, berechnet_am) VALUES (?, ?, ?, 'monat', ?, ?, 'Europe/Berlin', 1, ?, ?, ?, "
                + "'vollständig', NULL, '[]'::jsonb, 'endgueltig', ?, ?, ?)", wert, t, kennzahl,
                Date.valueOf(von), Date.valueOf(bis), zaehler.divide(nenner, 20, RoundingMode.HALF_UP), zaehler, nenner,
                endgueltig, fassung, am);
        root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + "messstelle_id, wert, einheit, menge_zustand, version) VALUES (?, ?, ?, 0, 'zaehler', 'messstelle', "
                + "'MS-20', (SELECT id FROM messstelle WHERE tenant_id = ? AND kennzeichen = 'MS-20'), ?, 'kWh', "
                + "'vollständig', 1)", t, wert, kennzahl, t, zaehler);
        root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + "bezugsgroesse_id, wert, einheit, menge_zustand, fassung) VALUES (?, ?, ?, 1, 'nenner', 'bezugsgroesse', "
                + "'BZ-1', ?, ?, 'kg', 'vollständig', 1)", t, wert, kennzahl, bz, nenner);
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                + "periode_von, periode_bis, zeitzone, fassung, vorgang, status, betrag, herkunft_art, actor_sub, "
                + "actor_name, actor_rolle, actor_art, created_at) VALUES (?, ?, 'periodenwert', 'kg', 'monat', ?, ?, "
                + "'Europe/Berlin', 1, 'erstwert', 'wirksam', ?, 'eingabe', 'IK', 'Ines Kaltenbach', 'energiemanager', "
                + "'kunde', ?)", t, bz, Date.valueOf(von), Date.valueOf(bis), nenner, am);
    }

    /** Die Bezugsbasis über die Route von AP-17 IP-7 (BB-…). */
    private UUID basis(Welt w, UUID kennzahl) throws Exception {
        Antwort a = ruf(w, "ines", HttpMethod.POST, "/api/v1/kennzahlen/" + kennzahl + "/bezugsbasen", null);
        assertThat(a.status()).as(a.text()).isEqualTo(201);
        return UUID.fromString(a.body().get("id").asText());
    }

    /** Eine freigegebene Fassung, direkt geschrieben (Muster EnergiezielApiTest); Fassung 1 ist beendet. */
    void fassung(UUID t, UUID basis, int nummer, UUID bz, String methode, String referenzperiode,
            String giltAb, String giltBis, String basiswert, String koeffizienten, String streuung, String von,
            String bis) {
        UUID f = root.queryForObject("INSERT INTO bezugsbasis_fassung (tenant_id, bezugsbasis_id, fassung, referenzperiode, "
                + "methode, datenlage, gilt_ab, gilt_bis, beendet_am, beendet_grund, toleranz_prozent, anpassungsgruende, "
                + "begruendung, basiswert, koeffizienten, streuung_prozent, actor_sub, actor_name, actor_rolle, actor_art, "
                + "freigabe_status, freigabe_sub, freigabe_name, freigabe_rolle, freigabe_art, freigabe_am, freigegeben_am) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2.0, ?::text[], 'Freigabe im Maßnahme-Test.', ?, ?::jsonb, ?, "
                + "'IK', 'Ines Kaltenbach', 'energiemanager', 'kunde', 'freigegeben', 'IK', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde', now(), now()) RETURNING id", UUID.class, t, basis, nummer, referenzperiode,
                methode, nummer == 1 ? "vorlaeufig" : "vollstaendig", Date.valueOf(giltAb),
                giltBis == null ? null : Date.valueOf(giltBis), giltBis == null ? null : Timestamp.from(ANGELEGT),
                giltBis == null ? null : "Fassung 2 ersetzt das Verhältnis.",
                nummer > 1 ? "{referenzperiode_vervollstaendigt}" : "{}", new BigDecimal(basiswert), koeffizienten,
                streuung == null ? null : new BigDecimal(streuung));
        root.update("INSERT INTO bezugsbasis_variable (tenant_id, fassung_id, position, bezugsgroesse_id, "
                + "bezugsgroesse_fassung, spannweite_von, spannweite_bis) VALUES (?, ?, 1, ?, 1, ?, ?)", t, f, bz,
                von == null ? null : new BigDecimal(von), bis == null ? null : new BigDecimal(bis));
    }

    private UUID kennzahl(Welt w, UUID gebaeude) throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", "KZ-0004");
        m.put("name", "Stromeinsatz Spritzguss je kg");
        m.put("rechenform", "quotient");
        m.put("geltung_art", "gebaeude");
        m.put("geltung_id", gebaeude.toString());
        m.put("eingaenge", List.of(Map.of("rolle", "zaehler", "art", "messstelle", "kennzeichen", "MS-20"),
                Map.of("rolle", "nenner", "art", "bezugsgroesse", "kennzeichen", "BZ-1")));
        Antwort a = ruf(w, "ines", HttpMethod.POST, "/api/v1/kennzahlen", m);
        assertThat(a.status()).as("KZ-0004 " + a.text()).isEqualTo(201);
        return UUID.fromString(a.body().get("id").asText());
    }

    /** Die Zahlen sind JSON-Texte (exakte Dezimalen). */
    static BigDecimal zahl(JsonNode n) {
        return new BigDecimal(n.asText());
    }

    Antwort ruf(Welt w, String person, HttpMethod methode, String pfad, Object body) throws Exception {
        // Über den Rollen-Konverter wie in Produktion: erst so entsteht der Zugriff-Kontext (Rolle je Standort).
        Jwt token = Jwt.withTokenValue("test").header("alg", "none").subject(sub(w, person)).issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600)).claim("tenant_id", w.mandant().toString())
                .claim("realm_access", Map.of("roles", List.of())).claim("name", NAMEN.get(person))
                .claim("preferred_username", NAMEN.get(person)).build();
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(authentication(new KeycloakRealmRoleConverter().convert(token)))
                .contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text),
                text);
    }

    private static JsonNode datei() {
        try {
            return MAPPER.readTree(java.nio.file.Path.of("..", "..", "docs", "contracts", "v2",
                    "uems-referenzunternehmen.json").toFile());
        } catch (java.io.IOException x) {
            throw new IllegalStateException(x);
        }
    }

    private static Map<String, JsonNode> nach(JsonNode liste, String schluessel) {
        Map<String, JsonNode> m = new LinkedHashMap<>();
        liste.forEach(n -> m.put(n.get(schluessel).asText(), n));
        return m;
    }
}
