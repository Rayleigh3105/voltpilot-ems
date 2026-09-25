package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Date;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Consumer;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Die Welt des Kunststoffwerks Ahrenberg nach der Referenzdatei 1.10 — vom 01.10.2026 bis zum 30.04.2029, R1–R14 über die
 * Routen, die das Portal ruft, die Leistungs-Stände von AP-11/12/16/17/18 direkt geschrieben (Muster IP-8, IP-22, IP-23),
 * mit gestellter Uhr. Gebaut für die Abnahme {@link UemsEnergiemanagementAbnahmeTest} (AP-19 IP-26, NW-6); seit UEMS
 * AP-20 IP-13 auch der Seed-Weg der Prüfumgebung (E5, PD1) — dieselben Schritte, zwei Ziele:
 * <ul>
 *   <li>{@link Ziel#NEU}: ein eigener Kundenbereich mit den Kürzeln als Subject und Zuweisungen ab 2024 — die Abnahme.</li>
 *   <li>{@link Ziel#SEED}: der Kundenbereich aus {@code infra/local/seed/ahrenberg.sql} (Fassung 1.4: Standorte, Orte,
 *       Anlagen, Personen, Zuweisungen) mit den Subjects des lokalen Realms; die Welt legt nur an, was 1.4 noch nicht
 *       trägt (MS-20, BZ-1, Geräte, Robert Falk und {@code zugriffe_1_10}), und stellt dafür auch die Uhr der
 *       Zuweisungen — die Zuweisungen des Seeds beginnen erst am 01.10.2026.</li>
 * </ul>
 * Direkt geschriebene Zeilen tragen das Subject von Ines Kaltenbach aus dem Ziel (NEU: das Kürzel, wie seit IP-26).
 */
final class AhrenbergWelt {
    /** Wohin die Welt geschrieben wird. */
    enum Ziel { NEU, SEED }

    /** Der Kundenbereich des Seeds; dieselbe Kennung trägt das Realm-Attribut der Ahrenberg-Logins. */
    static final UUID AHRENBERG = UUID.fromString("20000000-0000-0000-0000-000000000001");

    /**
     * Die Subjects des lokalen Realms ({@code infra/local/keycloak/voltpilot-realm.json}, {@code id} = Subject) je Kürzel;
     * Robert Falk hat im Seed 1.4 noch kein Konto — sein Konto kommt mit der Welt (1.10: {@code konto_ab} 01.02.2029).
     */
    static final Map<String, String> SEED_SUBJECTS = Map.of(
            "JW", "20000000-0000-0000-0000-0000000008a1", "IK", "20000000-0000-0000-0000-0000000008a2",
            "PH", "20000000-0000-0000-0000-0000000008a3", "MD", "20000000-0000-0000-0000-0000000008a4",
            "CB", "20000000-0000-0000-0000-0000000008a5", "RF", "20000000-0000-0000-0000-0000000008a6");

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String BASIS = "/api/v1/energiemanagement";
    private static final String MB = BASIS + "/managementbewertungen/BR-2029-0001";
    static final Map<String, String> NAMEN = Map.of("IK", "Ines Kaltenbach", "JW", "Jonas Wendlinger",
            "PH", "Peter Hollerbach", "CB", "Claudia Berger", "MD", "Murat Demirci", "RF", "Robert Falk");
    private static final String BEGRUENDUNG = "In der Besprechung am selben Tag entschieden.";
    private static final Map<String, Object> BESTELLUNG = Map.of(
            "bezeichnung", "Bestellung Energiemanagement vom 28.09.2026, unterschrieben",
            "ablage", "Personalakte (Personalabteilung)");
    private static final Map<String, Object> ORIGINAL = Map.of(
            "bezeichnung", "Energiepolitik Fassung 1, unterschrieben",
            "ablage", "QM-Laufwerk, Ordner Energiemanagement/Politik", "kennung", "EP-2026",
            "sha256", "3f1f253d0c40224028a65d3cd9409b689463ff4feab3282db32f83252bf73b9b");
    private static final Map<String, Object> AUDITBERICHT = Map.of(
            "bezeichnung", "Bericht internes Audit 2029, unterschrieben",
            "ablage", "QM-Laufwerk, Ordner Energiemanagement/Audits", "kennung", "IA-2029",
            "sha256", "761d45606a2ed3511c91e2a61bf4ba3287dac583b70f43ead3f3d8716233fdeb");
    private static final Map<String, Object> UNTERWEISUNG = Map.of(
            "bezeichnung", "Unterweisung Zeitschaltung Werkzeugheizungen, Murat Demirci", "ablage", "Personalsystem",
            "kennung", "UW-2028-014",
            "sha256", "5b0d6c3f1e2a4978b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3");
    private static final String SHA_GR2 = "3b1f4d86f164c8e54eaa3a9c335975dd54dcbd68b42bbb9c7b24d2195e2a9a2e";
    private static final String SHA_Z5B = "c07dd7a33d2b17df6fece484ec4e08bb50c93326653576cfb1b8dd8dcf8a41f0";

    private final MockMvc mvc;
    private final JdbcTemplate root;
    private final Consumer<Clock> uhren;
    private final Ziel ziel;
    /** Das Subject von Ines Kaltenbach in den direkt geschriebenen Zeilen (Fremdschlüssel auf {@code benutzer}). */
    private final String ik;
    final JsonNode referenz;
    final Map<String, JsonNode> kopien = new HashMap<>();
    UUID tenant, unternehmen, s1, s2, g2, bz1;
    final Map<String, String> person = new LinkedHashMap<>();
    final Map<String, String> dokument = new LinkedHashMap<>();
    final Map<String, UUID> einsatz = new LinkedHashMap<>();
    String audit, feststellung, pruefsummeNr1, abzugNr1;

    /**
     * @param root  eine Verbindung als Eigentümer (ohne RLS) für die direkt geschriebenen Stände
     * @param uhren stellt jede Uhr, an der ein Dienst „heute“ misst — im Ziel {@link Ziel#SEED} auch die der Zuweisungen
     */
    AhrenbergWelt(MockMvc mvc, JdbcTemplate root, Consumer<Clock> uhren, Ziel ziel) throws IOException {
        this.mvc = mvc;
        this.root = root;
        this.uhren = uhren;
        this.ziel = ziel;
        this.ik = sub("IK");
        this.referenz = JSON.readTree(Path.of("../../docs/contracts/v2/uems-referenzunternehmen.json").toFile());
        for (JsonNode c : JSON.readTree(Path.of("../../docs/contracts/v2/energiemanagement-vectors.json").toFile())
                .path("cases")) {
            if (c.path("operation").asText().equals("pruefsumme") && c.path("name").asText().contains("Fassung 1")) {
                kopien.put(c.path("name").asText().substring(3, 9), c);
            }
        }
    }

    /** Die ganze Welt bis zum 30.04.2029, 08:00 — der Seed-Weg der Prüfumgebung (ohne die Lesungen der Abnahme). */
    void aufbauen() throws Exception {
        stammdaten();
        bis12Februar2029();
        managementbewertungUndFolgen();
        uhr("2029-04-30T08:00:00Z");
    }

    /** Das Subject eines Kürzels im Ziel. */
    String sub(String kuerzel) {
        return ziel == Ziel.SEED ? SEED_SUBJECTS.get(kuerzel) : kuerzel;
    }

    // ================================================================================ Welt: Stammdaten aus dem Seed

    /**
     * Ziel {@link Ziel#SEED}: was {@code ahrenberg.sql} (1.4) schon trägt, wird gelesen, nicht angelegt. Neu aus 1.10:
     * das Konto von Robert Falk ({@code energiemanagement.personen[RF].konto_ab}) und die zwei Einsicht-Zuweisungen aus
     * {@code zugriffe_1_10} — Claudia Berger befristet für das interne Audit, Robert Falk unbefristet, beide
     * zugewiesen von Jonas Wendlinger.
     */
    private void stammdatenAusDemSeed() {
        tenant = AHRENBERG;
        unternehmen = root.queryForObject("SELECT id FROM unternehmen WHERE tenant_id = ?", UUID.class, tenant);
        s1 = kurzzeichen("standort", "ST-1");
        s2 = kurzzeichen("standort", "ST-2");
        g2 = kurzzeichen("ort", "G-2");
        JsonNode rf = null;
        for (JsonNode p : referenz.at("/energiemanagement/personen")) {
            if (p.path("kuerzel").asText().equals("RF")) rf = p;
        }
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, email, zustand, angenommen_am, created_at) "
                + "VALUES (?, ?, 'benutzer', ?, 'robert@voltpilot.local', 'aktiv', (?::date)::timestamp AT TIME ZONE "
                + "'Europe/Berlin', (?::date)::timestamp AT TIME ZONE 'Europe/Berlin')", tenant, sub("RF"),
                rf.path("name").asText(), rf.path("konto_ab").asText(), rf.path("konto_ab").asText());
        for (JsonNode z : referenz.path("zugriffe_1_10")) {
            String bis = z.hasNonNull("bis") ? z.path("bis").asText() : null;
            root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, gueltig_ab, gueltig_bis, endet_am, zeitzone, "
                    + "gewaehrt_von, created_at) VALUES (?, ?, ?, (?::date)::timestamp AT TIME ZONE 'Europe/Berlin', "
                    + "?::date, ((?::date + 1)::timestamp) AT TIME ZONE 'Europe/Berlin', 'Europe/Berlin', ?, "
                    + "(?::date)::timestamp AT TIME ZONE 'Europe/Berlin')", tenant, sub(z.path("person").asText()),
                    z.path("rolle").asText(), z.path("seit").asText(), bis, bis, sub(z.path("zugewiesen_von").asText()),
                    z.path("seit").asText());
        }
        messstelleUndBezugsgroesse();
    }

    private static List<String> texte(JsonNode liste) {
        List<String> aus = new ArrayList<>();
        liste.forEach(n -> aus.add(n.asText()));
        return aus;
    }

    private UUID kurzzeichen(String tabelle, String kurzzeichen) {
        return root.queryForObject("SELECT id FROM " + tabelle + " WHERE tenant_id = ? AND kurzzeichen = ?", UUID.class,
                tenant, kurzzeichen);
    }

    private String anlagenname(String kennzeichen) {
        for (JsonNode a : referenz.path("anlagen")) {
            if (a.path("kennzeichen").asText().equals(kennzeichen)) return a.path("name").asText();
        }
        throw new IllegalStateException(kennzeichen + " fehlt in der Referenz");
    }

    // ================================================================================ Welt: Stammdaten

    void stammdaten() {
        if (ziel == Ziel.SEED) {
            stammdatenAusDemSeed();
            return;
        }
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Ahrenberg IP-26') RETURNING id", UUID.class);
        unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name,zeitzone) VALUES (?,"
                + "'Kunststoffwerk Ahrenberg GmbH','Europe/Berlin') RETURNING id", UUID.class, tenant);
        s1 = standort("ST-1", "Werk Ahrenberg");
        s2 = standort("ST-2", "Werk Lindach");
        benutzer("IK", "energiemanager", null);
        benutzer("JW", "kundenadministrator", null);
        benutzer("PH", "bearbeiter", s2);
        benutzer("MD", "bedienberechtigt", s1);
        benutzer("CB", "leser", s1);
        benutzer("RF", "einsicht", null);
        g2 = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, 'gebaeude', "
                + "'Halle 2', 'G-2', 'aktiv') RETURNING id", UUID.class, tenant);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2020-01-01')", tenant, g2, s1);
        messstelleUndBezugsgroesse();
    }

    /** MS-20 an G-2 und BZ-1 „Produktionsmenge“ — der Seed von 1.4 trägt noch keine Messstelle und keine Bezugsgröße. */
    private void messstelleUndBezugsgroesse() {
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-20', 'Spritzguss', 'gemessen', 'Strom', 'Wirkenergie', "
                + "'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, tenant);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, NULL, '2020-01-01')", tenant, ms, g2);
        bz1 = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, "
                + "periode_art, geltung_art, ort_id) VALUES (?, 'BZ-1', 'Produktionsmenge', 'periodenwert', 'kg', "
                + "'monat', 'gebaeude', ?) RETURNING id", UUID.class, tenant, g2);
    }

    // ================================================================================ Welt: bis zum 12.02.2029, 08:00

    void bis12Februar2029() throws Exception {
        // R5: sechs Personen, zehn Zuordnungen — neun „entschieden von Robert Falk“ (Muster IP-8/IP-10).
        uhr("2026-10-01T10:00:00Z");
        person.put("RF", personAnlegen("Robert Falk", "Geschäftsführer", "RF", "RF", "2026-10-01"));
        person.put("IK", personAnlegen("Ines Kaltenbach", "Energiemanagement", "IK", "IK", "2026-10-01"));
        person.put("JW", personAnlegen("Jonas Wendlinger", "IT-Leitung", "JW", "JW", "2026-10-01"));
        person.put("PH", personAnlegen("Peter Hollerbach", "Standortleiter Werk Lindach", "PH", "PH", "2026-10-15"));
        person.put("MD", personAnlegen("Murat Demirci", "Schichtführer Halle 1", "MD", "MD", "2026-10-01"));
        person.put("CB", personAnlegen("Claudia Berger", "Controlling", "CB", "CB", "2028-12-01"));
        String rf = person.get("RF");
        ruf("POST", BASIS + "/aufgaben", "IK", Map.of("aufgabe", "unternehmensleitung", "person_id", rf,
                "gilt_ab", "2026-10-01", "begruendung", "Geschäftsführer laut Handelsregister"), 201);
        ruf("POST", BASIS + "/aufgaben", "IK", entschieden("energiemanagement_leiten", "IK", "2026-10-01",
                person.get("JW")), 201);
        for (String k : List.of("IK", "MD")) {
            ruf("POST", BASIS + "/aufgaben", "IK", entschieden("energieteam", k, "2026-10-01", null), 201);
        }
        ruf("POST", BASIS + "/aufgaben", "IK", entschieden("energieteam", "PH", "2026-10-15", null), 201);
        for (String a : List.of("energieziele_massnahmen", "bewertung_messplanung", "dokumente", "managementbewertung")) {
            ruf("POST", BASIS + "/aufgaben", "IK", entschieden(a, "IK", "2026-10-01", null), 201);
        }
        Map<String, Object> auditAufgabe = entschieden("interne_audits", "CB", "2028-12-01", null);
        auditAufgabe.remove("beleg");
        ruf("POST", BASIS + "/aufgaben", "IK", auditAufgabe, 201);

        // AP-16: Betrachtungsumfang, Kriterien Nr. 1 und Nr. 2, acht Einsätze mit zwölf Einstufungs-Fassungen, MB-1,
        // die Messmittel-Angaben GR-2 und Z-5b mit Beleg, GR-5 „nicht erhoben“.
        umfang();
        kriterien(1, "2026-11-04", null);
        kriterien(2, "2026-11-20", "Schwellen nach der ersten Rangliste nachgeschärft.");
        einsaetzeUndEinstufungen();
        root.update("INSERT INTO messbedarf (tenant_id, kennzeichen, einsatz_id, wortlaut, frist, actor_sub, actor_name, "
                + "actor_art, created_at) VALUES (?, 'MB-1', ?, 'Lüftung, Beleuchtung und Allgemeinstrom Halle 1', "
                + "'2027-03-31', '" + ik + "', 'Ines Kaltenbach', 'kunde', '2026-11-27T09:00:00Z')", tenant, einsatz.get("EE-8"));
        messmittel();

        // R1, R2: D-0001 und D-0002 am 15.12.2026, entschieden von Robert Falk; bekannt gemacht am 18.12.2026.
        uhr("2026-12-15T10:00:00Z");
        String d1 = dokumentAnlegen("D-0001", "energiepolitik", "Energiepolitik", ORIGINAL, unternehmenBezug());
        fassung(d1, Map.of("form", "wortlaut", "wortlaut", kopien.get("D-0001").at("/eingang/kopie/wortlaut").asText()));
        freigeben(d1, 1, "RF");
        String d2 = dokumentAnlegen("D-0002", "anwendungsbereich", "Anwendungsbereich des Energiemanagements", null,
                unternehmenBezug());
        fassung(d2, Map.of("form", "wortlaut", "wortlaut", kopien.get("D-0002").at("/eingang/kopie/wortlaut").asText(),
                "anwendungsbereich", Map.of("standort_ids", List.of(s1.toString(), s2.toString()),
                        "traeger", List.of("Strom", "Gas"), "ausschluesse", List.of())));
        freigeben(d2, 1, "RF");
        uhr("2026-12-18T10:00:00Z");
        for (String weg : List.of("aushang", "intranet")) {
            ruf("POST", BASIS + "/dokumente/" + d1 + "/bekanntmachungen", "IK",
                    Map.of("kreis", "alle Mitarbeitenden beider Werke", "weg", weg), 201);
        }
        uhr("2027-12-10T10:00:00Z");
        for (String d : List.of(d1, d2)) {
            ruf("POST", BASIS + "/dokumente/" + d + "/geprueft", "IK", Map.of("entschieden_von", rf, "am",
                    "2027-12-10", "begruendung", "Mit der Jahresplanung 2028 durchgesehen; gilt unverändert."), 200);
        }

        // AP-11, AP-17, AP-12, AP-18: sechs Kennzahlen, fünf Bezugsbasen mit acht Fassungen, Berichtsstände, die
        // Bewertungen und Abschlüsse der Referenzdatei 1.9 (Muster IP-8, IP-22).
        leistung();

        // D-0003 … D-0005 nach der Referenzdatei nummeriert (Anlage-Reihenfolge), freigegeben an ihren Tagen.
        uhr("2028-01-25T09:00:00Z");
        String d3 = dokumentAnlegen("D-0003", "rechtliche_anforderungen", "Rechtskataster", null, unternehmenBezug());
        String d4 = dokumentAnlegen("D-0004", "betrieb", "Kriterien für Betrieb und Instandhaltung — Spritzguss", null,
                Map.of("art", "energieeinsatz", "energieeinsatz_id", einsatz.get("EE-1").toString()));
        String d5 = dokumentAnlegen("D-0005", "kompetenz", "Unterweisung Zeitschaltung Werkzeugheizungen",
                null, Map.of("art", "person", "person_id", person.get("MD")));
        // R8: die Unterweisung von Murat Demirci am 25.01.2028 als Verweis auf das Personalsystem, ohne Überprüfung.
        uhr("2028-01-25T10:00:00Z");
        fassung(d5, Map.of("form", "verweis", "verweis", UNTERWEISUNG));
        freigeben(d5, 1, "IK");
        // R7: D-0004 am Einsatz EE-1 — Verweis auf den Arbeitsplan IH-SG-01 im Instandhaltungssystem.
        uhr("2028-11-10T10:00:00Z");
        fassung(d4, Map.of("form", "verweis", "verweis", JSON.convertValue(kopien.get("D-0004")
                .at("/eingang/kopie/verweis"), Map.class)));
        freigeben(d4, 1, "IK");
        uhr("2028-11-12T10:00:00Z");
        ruf("POST", BASIS + "/dokumente/" + d4 + "/bekanntmachungen", "IK",
                Map.of("kreis", "Schichtführer und Instandhaltung", "weg", "besprechung"), 201);
        // D-0003 Rechtliche Anforderungen am 05.12.2028 als Verweis auf den Rechtskataster-Dienst.
        uhr("2028-12-05T10:00:00Z");
        Map<String, Object> kataster = new LinkedHashMap<>(JSON.convertValue(kopien.get("D-0004")
                .at("/eingang/kopie/verweis"), Map.class));
        kataster.put("ablage", "Rechtskataster-Dienst");
        kataster.put("kennung", "RK-2028");
        fassung(d3, Map.of("form", "verweis", "verweis", kataster));
        freigeben(d3, 1, "IK");

        // R9, R10: AU-2029-0001 am 22.01.2029 mit Hinweis und Feststellung F-2029-0001; M-2029-0001/-0002; Abschluss
        // am 31.01.2029 mit dem unterschriebenen Bericht als Verweis.
        uhr("2029-01-10T09:00:00Z");
        Map<String, Object> a = new LinkedHashMap<>();
        a.put("titel", "Internes Audit 2029: Bezugsbasen, Energieziele, Maßnahmen und Grundlagen");
        a.put("termin", "2029-01-22");
        a.put("auditor_ids", List.of(person.get("CB")));
        a.put("unabhaengigkeit", "Claudia Berger (Controlling) gehört nicht zum Energieteam und prüft keine eigene Arbeit.");
        a.put("was", "Bezugsbasen, Energieziel, Maßnahmen und Grundlagen");
        a.put("woran", "Energiepolitik D-0001 Fassung 1, Anwendungsbereich D-0002, Aufgaben im Energiemanagement");
        a.put("verantwortlich", sub("IK"));
        audit = ruf("POST", BASIS + "/audits", "IK", a, 201).at("/audit/id").asText();
        uhr("2029-01-22T15:00:00Z");
        ruf("POST", BASIS + "/audits/" + audit + "/durchgefuehrt", "IK", Map.of("am", "2029-01-22"), 200);
        ruf("POST", BASIS + "/audits/" + audit + "/hinweise", "IK", Map.of("wortlaut", "Die Energiepolitik wurde im "
                + "Dezember 2026 bekannt gemacht; wer seitdem eingestellt wurde, lernt sie in der Einarbeitung nicht "
                + "kennen.", "festgestellt_von", person.get("CB")), 201);
        uhr("2029-01-23T10:00:00Z");
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("quelle", Map.of("art", "internes_audit", "audit_id", audit));
        f.put("wortlaut", "Wer die Bezugsbasen pflegt und freigibt und wer vertritt, ist nicht festgelegt.");
        f.put("vorgabe", Map.of("wortlaut", "„Wir legen fest, wer im Energiemanagement wofür zuständig ist.“"));
        f.put("festgestellt_von", person.get("CB"));
        f.put("festgestellt_am", "2029-01-22");
        f.put("verantwortlich", sub("JW"));
        feststellung = ruf("POST", BASIS + "/feststellungen", "IK", f, 201).at("/feststellung/id").asText();
        uhr("2029-01-26T10:00:00Z");
        massnahme("Aufgabe „Bezugsbasen pflegen und freigeben“ festlegen und über die zweite Prüfung entscheiden", "JW",
                "2029-02-28", "nichtkonformitaet", "F-2029-0001");
        massnahme("Hinweis aus dem internen Audit: Bekanntmachung der Energiepolitik im Werk Lindach wiederholen", "IK",
                "2029-06-30", "audit", "AU-2029-0001");
        uhr("2029-01-31T15:00:00Z");
        ruf("POST", BASIS + "/audits/" + audit + "/abschliessen", "IK", Map.of("entschieden_von", person.get("IK"),
                "am", "2029-01-31", "bericht", AUDITBERICHT, "zusammenfassung", "Ein Hinweis, eine Feststellung; Bericht "
                + "unterschrieben von Claudia Berger am 30.01.2029.", "massnahmen", List.of(Map.of("hinweis", 1,
                "massnahme", "M-2029-0002"))), 200);
    }

    /** AP-11/12/16/17/18 der Referenzdatei 1.9 — nur, was das Verzeichnis und die Managementbewertung lesen. */
    private void leistung() throws Exception {
        String[][] kz = {{"KZ-0004", "Stromeinsatz Spritzguss je kg"}, {"KZ-0001", "Stromeinsatz Montage je Stück"},
            {"KZ-0005", "Netzbezug je m²"}, {"KZ-0006", "Gasbezug Verwaltung je Gradtag"},
            {"KZ-0002", "Stromeinsatz Montage Lindach"}, {"KZ-0003", "Stromeinsatz Montage je Stück — Unternehmen"}};
        uhr("2026-11-01T10:00:00Z");
        Map<String, UUID> basis = new LinkedHashMap<>();
        Map<String, UUID> kennzahl = new LinkedHashMap<>();
        for (String[] k : kz) {
            UUID id = kennzahlAnlegen(k[0], k[1]);
            kennzahl.put(k[0], id);
            if (k[0].equals("KZ-0003")) continue;
            JsonNode b = ruf("POST", "/api/v1/kennzahlen/" + id + "/bezugsbasen", "IK", null, 201);
            basis.put(b.path("kennzeichen").asText(), UUID.fromString(b.path("id").asText()));
        }
        bezugsbasisFassung(basis.get("BB-0001"), 1, "2026-11-01", "2027-10-31", "2026-11-02T10:00:00Z");
        bezugsbasisFassung(basis.get("BB-0001"), 2, "2027-11-01", null, "2027-11-25T10:00:00Z");
        bezugsbasisFassung(basis.get("BB-0002"), 1, "2026-11-01", "2026-11-30", "2026-11-02T10:00:00Z");
        bezugsbasisFassung(basis.get("BB-0002"), 2, "2026-12-01", null, "2026-11-13T10:00:00Z");
        bezugsbasisFassung(basis.get("BB-0003"), 1, "2026-11-01", "2027-02-28", "2026-11-02T10:00:00Z");
        bezugsbasisFassung(basis.get("BB-0003"), 2, "2027-03-01", null, "2027-03-05T10:00:00Z");
        bezugsbasisFassung(basis.get("BB-0004"), 1, "2027-11-01", null, "2027-11-24T10:00:00Z");
        bezugsbasisFassung(basis.get("BB-0005"), 1, "2026-11-01", null, "2026-11-20T10:00:00Z");

        // AP-12: BR-2026-0001 (Monatsbericht, Nr. 1 und Nr. 2); AP-16 S5: zwei energetische Bewertungen mit drei
        // Ständen; AP-17: der Leistungsvergleich mit seinem Stand (Code-Kennung BR-, Datei-Kennung BW-/VB-, W11).
        root.update("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, geltung_art, standort_id, "
                + "zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_name) VALUES (?, 'BR-2026-0001', "
                + "'monatsbericht_standort', 1, 'standort', ?, 'monat', '2026-10', 'Europe/Berlin', 'Ines Kaltenbach')",
                tenant, s1);
        UUID monat = root.queryForObject("SELECT id FROM bericht WHERE tenant_id = ? AND kennung = 'BR-2026-0001'",
                UUID.class, tenant);
        stand(monat, 1, "2026-11-05T10:00:00Z", null);
        stand(monat, 2, "2026-12-20T10:00:00Z", null);
        UUID bw1 = bericht("BR-2026-0002", "energetische_bewertung", "datengrundlage", "2026-10", null);
        stand(bw1, 1, "2026-11-24T10:00:00Z", null);
        stand(bw1, 2, "2027-02-10T10:00:00Z", null);
        UUID bw2 = bericht("BR-2027-0001", "energetische_bewertung", "datengrundlage", "2027-10", null);
        stand(bw2, 1, "2027-11-24T10:00:00Z", null);
        UUID vb = bericht("BR-2028-0001", "leistungsvergleich", "monat", "2027-12", kennzahl.get("KZ-0004"));
        JsonNode urteil = referenz.at("/massnahmen/0/ausgangslage/kopie");
        stand(vb, 1, "2028-01-20T10:00:00Z", "{\"kopf\":{\"bericht\":\"BR-2028-0001\"},\"urteil\":{\"delta_prozent\":"
                + urteil.path("delta_prozent").asText() + ",\"urteil\":\"" + urteil.path("urteil").asText() + "\"}}");

        // AP-18 (Muster IP-22): EZ-2028-0001 verfehlt, M-2028-0001 belegt, M-2028-0002 nicht messbar, AW-2026-0001
        // und AW-2028-0001 abgeschlossen.
        UUID kz4 = kennzahl.get("KZ-0004");
        UUID bb1 = basis.get("BB-0001");
        JsonNode ez = referenz.at("/energieziele/0");
        UUID ezId = root.queryForObject("INSERT INTO energieziel (tenant_id, kennzeichen, kennzahl_id, bezugsbasis_id, "
                + "fassung, zielwert_prozent, zielperiode, wortlaut, begruendung, verantwortlich_sub, verantwortlich_name, "
                + "verantwortlich_konto, standort_id, actor_sub, actor_name, actor_rolle, actor_art, angelegt_am) VALUES "
                + "(?, 'EZ-2028-0001', ?, ?, 2, -5.0, '2028-01/2028-12', ?, ?, '" + ik + "', 'Ines Kaltenbach', 'benutzer', ?, "
                + "'" + ik + "', 'Ines Kaltenbach', 'energiemanager', 'kunde', '2027-12-20T09:00:00Z') RETURNING id", UUID.class,
                tenant, kz4, bb1, ez.path("wortlaut").asText(), ez.path("begruendung").asText(), s1);
        root.update("UPDATE energieziel SET zustand = 'bewertet', ergebnis = 'verfehlt', bewertung_status = 'bewertet', "
                + "bewertung_begruendung = ?, bewertung_kopie = ?, bewertung_pruefsumme = ?, freigabe_sub = '" + ik + "', "
                + "freigabe_name = 'Ines Kaltenbach', freigabe_rolle = 'energiemanager', freigabe_art = 'kunde', "
                + "freigabe_am = '2029-01-15T09:00:00Z' WHERE id = ?", ez.at("/bewertung/begruendung").asText(),
                BerichtRegeln.kanonisch(ez.at("/bewertung/kopie")), ez.at("/bewertung/pruefsumme").asText(), ezId);
        JsonNode m1 = referenz.at("/massnahmen/0");
        UUID m1Id = massnahmeDirekt("M-2028-0001", m1, "abweichung", "AW-2028-0001", kz4, bb1,
                BerichtRegeln.kanonisch(m1.at("/ausgangslage/kopie")), "2028-01-15T09:00:00Z", "2028-01-22");
        bewertungDirekt(m1Id, m1.at("/bewertungen/0"), kz4, bb1, "2028-11-15T10:00:00Z");
        JsonNode m2 = referenz.at("/massnahmen/1");
        UUID m2Id = massnahmeDirekt("M-2028-0002", m2, "von_hand", null, null, null, null, "2028-01-20T09:00:00Z",
                "2028-03-28");
        bewertungDirekt(m2Id, m2.at("/bewertungen/0"), null, null, "2028-11-20T10:00:00Z");
        for (JsonNode aw : referenz.path("abweichungen")) {
            String k = aw.path("kennzeichen").asText();
            boolean mitMassnahme = k.equals("AW-2028-0001");
            UUID awId = root.queryForObject("INSERT INTO abweichung (tenant_id, kennzeichen, kennzahl_id, bezugsbasis_id, "
                    + "fassung, monate, herkunft_art, anlass, anlass_pruefsumme, verantwortlich_sub, verantwortlich_name, "
                    + "verantwortlich_konto, frist, actor_sub, actor_name, actor_art, eroeffnet_am) VALUES (?, ?, ?, ?, ?, "
                    + "?::text[], 'auffaelligkeit', ?, ?, '" + ik + "', 'Ines Kaltenbach', 'benutzer', ?::date, '" + ik + "', "
                    + "'Ines Kaltenbach', 'kunde', ?::timestamptz) RETURNING id", UUID.class, tenant, k, kz4, bb1, mitMassnahme ? 2 : 1,
                    "{" + String.join(",", texte(aw.path("monate"))) + "}",
                    BerichtRegeln.kanonisch(aw.path("anlass")), aw.path("pruefsumme").asText(), aw.path("frist").asText(),
                    aw.at("/eroeffnet/am").asText() + "T09:00:00Z");
            String am = aw.at("/abschluss/am").asText() + "T10:00:00Z";
            root.update("UPDATE abweichung SET zustand = 'abgeschlossen', ergebnis = ?, massnahme_id = ?, "
                    + "abschluss_begruendung = ?, abgeschlossen_am = ?::timestamptz, abgeschlossen_sub = '" + ik + "', "
                    + "abgeschlossen_name = 'Ines Kaltenbach', abgeschlossen_rolle = 'energiemanager', "
                    + "abgeschlossen_art = 'kunde' WHERE id = ?", aw.at("/abschluss/ergebnis").asText(),
                    mitMassnahme ? m1Id : null, aw.at("/abschluss/begruendung").asText("Erklärt."), am, awId);
        }
    }

    // ================================================================================ Welt: Managementbewertung und Folgen

    void managementbewertungUndFolgen() throws Exception {
        JsonNode rmb = referenz.at("/managementbewertungen/0");
        uhr("2029-02-12T13:00:00Z");
        ruf("POST", "/api/v1/berichte", "IK", Map.of("vorlage", "managementbewertung", "geltung_id",
                unternehmen.toString(), "zeitraum", "2028"), 201);
        Map<String, Object> sitzung = new LinkedHashMap<>();
        sitzung.put("tag", rmb.at("/sitzung/tag").asText());
        sitzung.put("leitung", person.get("RF"));
        List<String> teilnehmende = new ArrayList<>();
        rmb.at("/sitzung/teilnehmende").forEach(t -> teilnehmende.add(person.get(t.asText())));
        sitzung.put("teilnehmende", teilnehmende);
        sitzung.put("ort", rmb.at("/sitzung/ort").asText());
        ruf("PUT", MB + "/sitzung", "IK", sitzung, 200);
        for (JsonNode b : rmb.path("beschluesse")) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("art", b.path("art").asText());
            m.put("wortlaut", b.path("wortlaut").asText());
            m.put("zustaendig", person.get(b.path("zustaendig").asText()));
            if (b.hasNonNull("termin")) m.put("termin", b.path("termin").asText());
            ruf("POST", MB + "/beschluesse", "IK", m, 201);
        }
        String datenstand = ruf("/api/v1/berichte/BR-2029-0001/entwurf", "IK", 200).path("datenstand").asText();
        uhr("2029-02-12T13:10:00Z");
        ruf("POST", "/api/v1/berichte/BR-2029-0001/freigeben", "IK", Map.of("entwurf_datenstand", datenstand), 201);
        abzugNr1 = root.queryForObject("SELECT s.abzug FROM bericht_stand s JOIN bericht r ON r.id = s.bericht_id "
                + "WHERE r.tenant_id = ? AND r.kennung = 'BR-2029-0001' AND s.nr = 1", String.class, tenant);
        pruefsummeNr1 = root.queryForObject("SELECT s.pruefsumme FROM bericht_stand s JOIN bericht r "
                + "ON r.id = s.bericht_id WHERE r.tenant_id = ? AND r.kennung = 'BR-2029-0001' AND s.nr = 1",
                String.class, tenant);

        // B6 13.02.2029: „geprüft, bleibt“ an D-0002 mit dem Beschluss.
        uhr("2029-02-13T10:00:00Z");
        ruf("POST", BASIS + "/dokumente/" + dokument.get("D-0002") + "/geprueft", "IK", Map.of("entschieden_von",
                person.get("RF"), "am", "2029-02-13", "begruendung", "Beschluss B6 der Managementbewertung 2028: bleibt "
                + "unverändert.", "beschluss_kennung", "BR-2029-0001/B6"), 200);
        // B2 14.02.2029: M-2029-0003 mit Herkunft `managementbewertung`.
        uhr("2029-02-14T10:00:00Z");
        massnahme("Druckluft: Leckagen jährlich orten, 2029 im zweiten Quartal", "IK", "2029-06-30",
                "managementbewertung", "BR-2029-0001/B2");
        // B1 15.02.2029: EZ-2029-0001 ab März (ein Energieziel beginnt nicht rückwirkend), von Hand verknüpft.
        uhr("2029-02-15T10:00:00Z");
        root.update("INSERT INTO energieziel (tenant_id, kennzeichen, kennzahl_id, bezugsbasis_id, fassung, "
                + "zielwert_prozent, zielperiode, wortlaut, begruendung, verantwortlich_sub, verantwortlich_name, "
                + "verantwortlich_konto, standort_id, actor_sub, actor_name, actor_rolle, actor_art, angelegt_am) "
                + "SELECT tenant_id, 'EZ-2029-0001', kennzahl_id, bezugsbasis_id, fassung, -4.0, '2029-03/2029-12', "
                + "'Energieziel 2029 für den Spritzguss: 4 % weniger Strom, als die Bezugsbasis erwarten lässt.', "
                + "'Beschluss B1 der Managementbewertung vom 12.02.2029 (BR-2029-0001).', verantwortlich_sub, "
                + "verantwortlich_name, verantwortlich_konto, standort_id, actor_sub, actor_name, actor_rolle, actor_art, "
                + "'2029-02-15T09:00:00Z' FROM energieziel WHERE tenant_id = ? AND kennzeichen = 'EZ-2028-0001'", tenant);
        ruf("POST", MB + "/beschluesse/1/folgen", "IK", Map.of("art", "energieziel", "objekt", "EZ-2029-0001"), 201);
        // B4 26.02.2029: die Aufgabe „Bezugsbasen“ ab 01.03.2029, eingetragen von Jonas Wendlinger.
        uhr("2029-02-26T10:00:00Z");
        ruf("POST", BASIS + "/aufgaben", "JW", new LinkedHashMap<>(Map.of("aufgabe", "bezugsbasen", "person_id",
                person.get("IK"), "gilt_ab", "2029-03-01", "vertretung_person_id", person.get("JW"), "entschieden_von",
                person.get("RF"), "begruendung", "Beschluss B4 der Managementbewertung 2028", "beschluss_kennung",
                "BR-2029-0001/B4")), 201);
        // R11 01.03.2029: M-2029-0001 umgesetzt.
        uhr("2029-03-01T10:00:00Z");
        ruf("POST", "/api/v1/massnahmen/" + id("massnahme", "M-2029-0001") + "/umgesetzt", "JW", Map.of("am",
                "2029-03-01", "begruendung", "Aufgabe seit 01.03.2029 Ines Kaltenbach, Vertretung Jonas Wendlinger "
                + "(Beschluss B4)."), 200);
        // B3 10.03./20.03.2029: D-0001 Fassung 2, entschieden von Robert Falk.
        uhr("2029-03-10T10:00:00Z");
        fassung(dokument.get("D-0001"), Map.of("form", "wortlaut", "wortlaut", "Energiepolitik, ergänzt um Einkauf und "
                + "Planung.", "begruendung", "Beschluss B3 der Managementbewertung 2028", "beschluss_kennung",
                "BR-2029-0001/B3"));
        uhr("2029-03-20T10:00:00Z");
        freigeben(dokument.get("D-0001"), 2, "RF");
        // R11 15.04.2029: Wirksamkeit Stand Nr. 1 „wirksam“ — eine Person sagt es.
        uhr("2029-04-15T10:00:00Z");
        ruf("POST", BASIS + "/feststellungen/" + feststellung + "/wirksamkeit", "IK", Map.of("ergebnis", "wirksam",
                "begruendung", "Aufgabe seit 01.03.2029 festgelegt (Ines Kaltenbach, Vertretung Jonas Wendlinger); die "
                + "Freigaben seit März nennen die zuständige Person.", "entschieden_von", person.get("IK")), 201);
    }

    // ================================================================================ Welt: Helfer

    private Map<String, Object> entschieden(String aufgabe, String wer, String ab, String vertretung) {
        Map<String, Object> a = new LinkedHashMap<>(Map.of("aufgabe", aufgabe, "person_id", person.get(wer),
                "gilt_ab", ab, "entschieden_von", person.get("RF"), "begruendung", "Bestellung vom 28.09.2026",
                "beleg", BESTELLUNG));
        if (vertretung != null) a.put("vertretung_person_id", vertretung);
        return a;
    }

    private String personAnlegen(String name, String funktion, String kuerzel, String konto, String seit)
            throws Exception {
        Map<String, Object> b = new LinkedHashMap<>(Map.of("name", name, "funktion", funktion, "kuerzel", kuerzel,
                "seit", seit, "konto_sub", sub(konto)));
        JsonNode p = ruf("POST", BASIS + "/personen", "IK", b, 201);
        return p.has("verlauf") ? p.at("/person/id").asText() : p.path("id").asText();
    }

    private static Map<String, Object> unternehmenBezug() {
        return Map.of("art", "unternehmen");
    }

    private String dokumentAnlegen(String kennzeichen, String art, String titel, Map<String, Object> beleg,
            Map<String, Object> bezug) throws Exception {
        Map<String, Object> b = new LinkedHashMap<>(Map.of("art", art, "titel", titel, "bezug", bezug));
        if (beleg != null) b.put("beleg", beleg);
        JsonNode d = ruf("POST", BASIS + "/dokumente", "IK", b, 201);
        assertThat(d.path("kennzeichen").asText()).isEqualTo(kennzeichen);
        dokument.put(kennzeichen, d.path("id").asText());
        return d.path("id").asText();
    }

    private void fassung(String dokument, Map<String, Object> fassung) throws Exception {
        ruf("POST", BASIS + "/dokumente/" + dokument + "/fassungen", "IK", fassung, 201);
    }

    private void freigeben(String dokument, int nr, String von) throws Exception {
        ruf("POST", BASIS + "/dokumente/" + dokument + "/fassungen/" + nr + "/freigeben", "IK", Map.of("entschieden_von",
                person.get(von), "begruendung", BEGRUENDUNG), 200);
    }

    private void massnahme(String titel, String verantwortlich, String termin, String herkunft, String kennung)
            throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("titel", titel);
        m.put("verantwortlich", sub(verantwortlich));
        m.put("termin", termin);
        m.put("herkunft", herkunft);
        m.put("herkunft_kennung", kennung);
        m.put("erwartete_wirkung_wortlaut", "Zuständigkeit festgelegt; jede Freigabe nennt die zuständige Person.");
        ruf("POST", "/api/v1/massnahmen", "IK", m, 201);
    }

    /** AP-16 U1: der Betrachtungsumfang Fassung 1 ab 04.11.2026 an beiden Werken (Muster IP-8). */
    private void umfang() {
        UUID u = root.queryForObject("INSERT INTO bewertung_umfang (tenant_id, unternehmen_id, fassung, gueltig_ab, "
                + "traeger, begruendung, actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, 1, '2026-11-04', "
                + "'{Strom,Gas}'::text[], 'Erster Betrachtungsumfang der energetischen Bewertung.', '" + ik + "', "
                + "'Ines Kaltenbach', 'energiemanager', 'kunde') RETURNING id", UUID.class, tenant, unternehmen);
        for (UUID s : List.of(s1, s2)) {
            root.update("INSERT INTO bewertung_umfang_standort (tenant_id, umfang_id, standort_id) VALUES (?, ?, ?)",
                    tenant, u, s);
        }
    }

    /** AP-16 K: eine freigegebene Kriterien-Fassung ohne Vier-Augen; die neue hebt die vorige auf wie der Dienst. */
    private void kriterien(int fassung, String ab, String begruendung) {
        JsonNode k = referenz.path("bewertung_kriterien").get(fassung - 1);
        root.update("UPDATE bewertung_kriterien_fassung SET aufgehoben_am = ?::timestamptz WHERE tenant_id = ? "
                + "AND freigabe_status = 'freigegeben' AND aufgehoben_am IS NULL", ab + "T10:00:00Z", tenant);
        root.update("INSERT INTO bewertung_kriterien_fassung (tenant_id, unternehmen_id, fassung, werte, kriterien, "
                + "gueltig_ab, begruendung, actor_sub, actor_name, actor_rolle, actor_art, vieraugen, freigabe_status, "
                + "created_at) VALUES (?, ?, ?, '{}'::jsonb, ?::jsonb, ?::date, ?, '" + ik + "', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde', false, 'freigegeben', ?::timestamptz)", tenant, unternehmen, fassung,
                k.path("kriterien").toString(), ab, begruendung, ab + "T10:00:00Z");
    }

    /** AP-16 E: die acht Einsätze der Referenzdatei und ihre zwölf freigegebenen Einstufungs-Fassungen. */
    private void einsaetzeUndEinstufungen() {
        for (JsonNode e : referenz.path("energieeinsaetze")) {
            String k = e.path("kennzeichen").asText();
            UUID prozess = root.queryForObject("INSERT INTO prozess (tenant_id, unternehmen_id, kennzeichen, name, "
                    + "gueltig_ab) VALUES (?, ?, ?, ?, '2024-01-01') RETURNING id", UUID.class, tenant, unternehmen,
                    "P-" + k.substring(3), e.path("name").asText());
            einsatz.put(k, root.queryForObject("INSERT INTO energieeinsatz (tenant_id, kennzeichen, prozess_id, traeger, "
                    + "name, gueltig_ab, actor_sub, actor_name, actor_art) VALUES (?, ?, ?, ?, ?, '2026-10-01', '" + ik + "', "
                    + "'Ines Kaltenbach', 'kunde') RETURNING id", UUID.class, tenant, k, prozess,
                    e.path("traeger").asText(), e.path("name").asText()));
        }
        for (JsonNode e : referenz.path("einstufungen")) {
            for (JsonNode f : e.path("fassungen")) {
                root.update("INSERT INTO energieeinsatz_einstufung (tenant_id, einsatz_id, nummer, einstufung, "
                        + "begruendung, herkunft, grund, vorgeschlagen_ab, gueltig_ab, gueltig_bis, rueckwirkend, "
                        + "actor_sub, actor_name, actor_rolle, actor_art, vieraugen, freigabe_status) VALUES (?, ?, ?, ?, "
                        + "?, '{}'::jsonb, ?::jsonb, ?::date, ?::date, ?::date, false, '" + ik + "', 'Ines Kaltenbach', "
                        + "'energiemanager', 'kunde', false, 'freigegeben')", tenant,
                        einsatz.get(e.path("einsatz").asText()), f.path("fassung").asInt(), f.path("einstufung").asText(),
                        f.path("begruendung").asText("Einstufung der Referenzdatei."), f.path("grund").toString(),
                        f.path("gueltig_ab").asText(), f.path("gueltig_ab").asText(),
                        f.hasNonNull("gueltig_bis") ? f.path("gueltig_bis").asText() : null);
            }
        }
    }

    /** AP-16 M: GR-2 und Z-5b mit Beleg über die Route, GR-5 „nicht erhoben“ — der Wandler K-8.2 hat keine Zeile. */
    private void messmittel() throws Exception {
        UUID an1;
        if (ziel == Ziel.SEED) {
            an1 = root.queryForObject("SELECT id FROM site WHERE tenant_id = ? AND name = ?", UUID.class, tenant,
                    anlagenname("AN-1"));
        } else {
            an1 = root.queryForObject("INSERT INTO site(tenant_id,name) VALUES (?, 'AN-1') RETURNING id", UUID.class,
                    tenant);
            root.update("INSERT INTO anlage_standort(tenant_id,site_id,standort_id,gueltig_ab) VALUES (?,?,?,"
                    + "'2024-01-01')", tenant, an1, s1);
        }
        String k2 = kennzeichen("GR-2");
        UUID gr2 = geraet(an1, k2, k2);
        UUID z5b = geraet(an1, kennzeichen("GR-4"), "Z-5b");
        String k5 = kennzeichen("GR-5");
        UUID gr5 = geraet(an1, k5, k5);
        ruf("PUT", "/api/v1/geraete/" + gr2 + "/messmittel", "IK", Map.of("pruefungsart", "eichung", "beleg",
                Map.of("bezeichnung", "Zählerstandsmitteilung 10/2026, Netzgesellschaft Ahrental", "ablage",
                        "beim Kunden (Netzrechnung)", "sha256", SHA_GR2)), 200);
        ruf("PUT", "/api/v1/geraete/" + z5b + "/messmittel", "IK", Map.of("genauigkeitsklasse", "1", "beleg",
                Map.of("bezeichnung", "Werksprüfprotokoll Seriennr. 88231", "ablage", "beim Kunden", "sha256", SHA_Z5B)),
                200);
        // „nicht erhoben“ ist der leere Stand — ein PUT ohne Angabe ändert nichts und schreibt keine Person.
        JsonNode leer = ruf("/api/v1/geraete/" + gr5 + "/messmittel", "IK", 200);
        assertThat(leer.path("beleg").isNull()).isTrue();
        assertThat(leer.path("pruefungsart").asText()).isEqualTo("nicht_erhoben");
        root.update("UPDATE geraet SET beleg_am = '2026-11-28T08:00:00Z' WHERE tenant_id = ? AND beleg_am IS NOT NULL",
                tenant);
    }

    /**
     * Das Kennzeichen der Referenz — im Ziel {@link Ziel#SEED} nur, wenn es frei ist: im laufenden Stapel hat der
     * Geräte-Bestand der drei Boxen GR-1 … GR-6 womöglich schon vergeben; dann vergibt das Produkt das nächste freie
     * ({@code uems_geraet_kennzeichen}, überspringt von Hand vergebene Nummern — auch umgekehrt kollidiert nichts).
     */
    private String kennzeichen(String referenz) {
        if (ziel != Ziel.SEED || root.queryForObject("SELECT count(*) FROM geraet WHERE tenant_id = ? AND ? IN "
                + "(kennzeichen, einbau_kennzeichen)", Integer.class, tenant, referenz) == 0) {
            return referenz;
        }
        return root.queryForObject("SELECT uems_geraet_kennzeichen(?)", String.class, tenant);
    }

    private UUID geraet(UUID site, String kennzeichen, String einbau) {
        return root.queryForObject("INSERT INTO geraet(tenant_id,site_id,kennzeichen,einbau_kennzeichen,geraeteart,"
                + "eingebaut_am) VALUES (?,?,?,?,'zaehler','2024-01-01T00:00:00Z') RETURNING id", UUID.class, tenant,
                site, kennzeichen, einbau);
    }

    private UUID kennzahlAnlegen(String kennzeichen, String name) throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", kennzeichen);
        m.put("name", name);
        m.put("rechenform", "quotient");
        m.put("geltung_art", "gebaeude");
        m.put("geltung_id", g2.toString());
        m.put("verantwortlich_name", "Ines Kaltenbach");
        m.put("eingaenge", List.of(Map.of("rolle", "zaehler", "art", "messstelle", "kennzeichen", "MS-20"),
                Map.of("rolle", "nenner", "art", "bezugsgroesse", "kennzeichen", "BZ-1")));
        return UUID.fromString(ruf("POST", "/api/v1/kennzahlen", "IK", m, 201).path("id").asText());
    }

    /** Eine freigegebene Fassung, direkt geschrieben (Muster IP-8/IP-22) — mit dem Tag ihrer Freigabe. */
    private void bezugsbasisFassung(UUID basis, int nummer, String giltAb, String giltBis, String freigegeben) {
        Timestamp am = Timestamp.from(Instant.parse(freigegeben));
        UUID f = root.queryForObject("INSERT INTO bezugsbasis_fassung (tenant_id, bezugsbasis_id, fassung, "
                + "referenzperiode, methode, datenlage, gilt_ab, gilt_bis, beendet_am, beendet_grund, toleranz_prozent, "
                + "anpassungsgruende, begruendung, basiswert, actor_sub, actor_name, actor_rolle, actor_art, "
                + "freigabe_status, freigabe_sub, freigabe_name, freigabe_rolle, freigabe_art, freigabe_am, "
                + "freigegeben_am) VALUES (?, ?, ?, '2026-10/2026-10', 'verhaeltnis', 'vorlaeufig', ?, ?, ?, ?, 2.0, "
                + "?::text[], 'Freigabe im Abnahme-Test.', 0.2837, '" + ik + "', 'Ines Kaltenbach', 'energiemanager', "
                + "'kunde', 'freigegeben', '" + ik + "', 'Ines Kaltenbach', 'energiemanager', 'kunde', ?, ?) "
                + "RETURNING id", UUID.class, tenant, basis, nummer, Date.valueOf(giltAb),
                giltBis == null ? null : Date.valueOf(giltBis), giltBis == null ? null : am,
                giltBis == null ? null : "Die nächste Fassung ersetzt diese.",
                nummer > 1 ? "{referenzperiode_vervollstaendigt}" : "{}", am, am);
        root.update("INSERT INTO bezugsbasis_variable (tenant_id, fassung_id, position, bezugsgroesse_id, "
                + "bezugsgroesse_fassung) VALUES (?, ?, 1, ?, 1)", tenant, f, bz1);
    }

    private UUID bericht(String kennung, String vorlage, String zeitraumArt, String schluessel, UUID kennzahl) {
        return root.queryForObject("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, geltung_art, "
                + "unternehmen_id, zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_name, kennzahl_id) "
                + "VALUES (?, ?, ?, 1, 'unternehmen', ?, ?, ?, 'Europe/Berlin', 'Ines Kaltenbach', ?) RETURNING id",
                UUID.class, tenant, kennung, vorlage, unternehmen, zeitraumArt, schluessel, kennzahl);
    }

    private void stand(UUID bericht, int nr, String am, String abzug) {
        String a = abzug == null ? "{\"bericht\":\"" + bericht + "\",\"nr\":" + nr + "}" : abzug;
        Timestamp t = Timestamp.from(Instant.parse(am));
        root.update("INSERT INTO bericht_stand (tenant_id, bericht_id, nr, abzug, pruefsumme, datenstand, "
                + "freigegeben_am, freigeber_sub, freigeber_name, freigeber_rolle, darstellung, regelwerk, "
                + "vorlage_fassung) VALUES (?, ?, ?, ?, ?, ?, ?, '" + ik + "', 'Ines Kaltenbach', 'energiemanager', "
                + "'{}'::jsonb, '{}'::jsonb, 1)", tenant, bericht, nr, a, BerichtRegeln.pruefsumme(a), t, t);
    }

    private UUID massnahmeDirekt(String kennzeichen, JsonNode m, String herkunft, String herkunftKennung, UUID kennzahl,
            UUID basis, String ausgangslage, String angelegt, String umgesetzt) {
        UUID id = root.queryForObject("INSERT INTO massnahme (tenant_id, kennzeichen, titel, verantwortlich_sub, "
                + "verantwortlich_name, verantwortlich_konto, termin, standort_id, herkunft_art, herkunft_kennung, "
                + "kennzahl_id, bezugsbasis_id, fassung, ausgangslage, ausgangslage_pruefsumme, erwartete_wirkung_prozent, "
                + "erwartete_wirkung_wortlaut, actor_sub, actor_name, actor_rolle, actor_art, angelegt_am) VALUES (?, ?, ?, "
                + "'" + ik + "', 'Ines Kaltenbach', 'benutzer', ?::date, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '" + ik + "', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde', ?::timestamptz) RETURNING id", UUID.class, tenant, kennzeichen,
                m.path("titel").asText(), m.path("termin").asText(), s1, herkunft, herkunftKennung, kennzahl, basis,
                kennzahl == null ? null : 2, ausgangslage,
                ausgangslage == null ? null : BerichtRegeln.pruefsumme(ausgangslage),
                m.at("/erwartete_wirkung/prozent").isNumber() ? m.at("/erwartete_wirkung/prozent").decimalValue() : null,
                m.at("/erwartete_wirkung/wortlaut").asText(), angelegt);
        root.update("UPDATE massnahme SET zustand = 'umgesetzt', umgesetzt_am = ?::date, umgesetzt_begruendung = "
                + "'Umgesetzt wie in der Referenzdatei.', umgesetzt_gemeldet_am = ?::timestamptz WHERE id = ?", umgesetzt,
                umgesetzt + "T12:00:00Z", id);
        return id;
    }

    private void bewertungDirekt(UUID massnahme, JsonNode b, UUID kennzahl, UUID basis, String am) {
        String wirkung = b.path("kopie").isObject() ? BerichtRegeln.kanonisch(b.path("kopie")) : null;
        String summe = wirkung == null ? null : b.path("pruefsumme").asText();
        root.update("INSERT INTO massnahme_bewertung (tenant_id, massnahme_id, kennzahl_id, bezugsbasis_id, fassung, "
                + "wirkung, pruefsumme, ergebnis, begruendung, status, freigabe_sub, freigabe_name, freigabe_rolle, "
                + "freigabe_art, freigabe_am) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'bewertet', '" + ik + "', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde', ?::timestamptz)", tenant, massnahme, kennzahl, basis,
                kennzahl == null ? null : 2, wirkung, summe, b.path("ergebnis").asText(), b.path("begruendung").asText(), am);
        root.update("UPDATE massnahme SET zustand = 'bewertet' WHERE id = ?", massnahme);
    }

    String id(String tabelle, String kennzeichen) {
        return root.queryForObject("SELECT id FROM " + tabelle + " WHERE tenant_id = ? AND kennzeichen = ?", UUID.class,
                tenant, kennzeichen).toString();
    }

    /** Alle Uhren, an denen ein Dienst „heute“ misst, auf denselben Augenblick — welche, sagt der Aufrufer. */
    void uhr(String jetzt) {
        uhren.accept(Clock.fixed(Instant.parse(jetzt), ZoneOffset.UTC));
    }

    private Authentication token(String kuerzel) {
        Jwt jwt = Jwt.withTokenValue("test").header("alg", "none").subject(sub(kuerzel)).issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600)).claim("tenant_id", tenant.toString())
                .claim("realm_access", Map.of("roles", List.of())).claim("name", NAMEN.get(kuerzel))
                .claim("preferred_username", NAMEN.get(kuerzel)).build();
        return new KeycloakRealmRoleConverter().convert(jwt);
    }

    JsonNode ruf(String path, String sub, int status) throws Exception {
        return ruf("GET", path, sub, null, status);
    }

    MockHttpServletResponse roh(String path, String sub) throws Exception {
        return mvc.perform(request(HttpMethod.GET, path).with(authentication(token(sub)))).andReturn().getResponse();
    }

    JsonNode ruf(String method, String path, String sub, Object body, int status) throws Exception {
        var b = request(HttpMethod.valueOf(method), path).with(authentication(token(sub)));
        if (body != null) b.contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        var r = mvc.perform(b).andReturn().getResponse();
        assertThat(r.getStatus()).as(method + " " + path + " " + r.getContentAsString(StandardCharsets.UTF_8))
                .isEqualTo(status);
        String text = r.getContentAsString(StandardCharsets.UTF_8);
        return text.isBlank() ? JSON.nullNode() : JSON.readTree(text);
    }

    private UUID standort(String k, String name) {
        return root.queryForObject("INSERT INTO standort(tenant_id,unternehmen_id,name,kurzzeichen,zeitzone,zustand) "
                + "VALUES (?,?,?,?,'Europe/Berlin','aktiv') RETURNING id", UUID.class, tenant, unternehmen, name, k);
    }

    private void benutzer(String sub, String rolle, UUID standort) {
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,?,'benutzer',?,'aktiv')",
                tenant, sub, NAMEN.get(sub));
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,standort_id,gueltig_ab,zeitzone) "
                + "VALUES (?,?,?,?,'2024-01-01','Europe/Berlin')", tenant, sub, rolle, standort);
    }
}
