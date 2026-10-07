package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
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
 *   <li>Die restlichen UEMS-Flächen füllen, damit für {@code rundgang} keine Liste leer und kein Pflichtfeld „null“
 *       bleibt: Postleitzahl (Unternehmen und beide Standorte), Lage und Notiz von Werk Lindach; die Netzanschlüsse
 *       NA-0001/NA-0002 (Werk Ahrenberg) und NA-0003 (Werk Lindach) mit Anlagenbindung und Bezugsgrenze; zwei
 *       weitere Messstellen (MS-21 Halle 1, MS-22 Verwaltung) mit Ablesungen; zwei weitere Bezugsgrößen (BZ-2
 *       Stückzahl Montage, BZ-3 Produktionsschichten) mit Werten; vier Kostenstellen; und der Zweck jeder Kennzahl.
 *       Alles über dieselben Portal-Routen wie oben ({@link #stammdaten}, {@link #netzanschluesse},
 *       {@link #messstellenExtra}, {@link #bezugsgroessenExtra}, {@link #kostenstellen}, {@link #kennzahlZwecke}).</li>
 * </ul>
 * Idempotent: dieselbe Ablesung und derselbe Bezugswert sind Wiederholungen, die nichts schreiben; die zusätzlichen
 * Objekte legt der Lauf nur an, wenn ihr Kennzeichen noch fehlt.
 *
 * <p><b>Runde 3 - Demo-Füllung Auswerten (Konzept a1, Entscheid 12; Entscheid A2 vom 06.10.2026):</b> die Kennzahlen
 * KZ-0021 bis KZ-0023 rechnen mit passenden Zählern, und die Bühne bekommt ihre Werte bis zum Bühnen-Tag
 * ({@link #buehnenBestand}): MS-20 und BZ-1 aus der Referenzwelt (2026-10 bis 2029-01, drei Monate als Annahme), die
 * übrigen Reihen nach ihrem Muster. Dazu BB-0001 Fassung 2 als Regression der Referenzwelt
 * ({@link #bezugsbasisReferenzwelt}) - erst dann liegt 2028 rund 3,4 % unter der Bezugsbasis wie im Energieziel 2028.
 * Die Kennzahlen rechnet die Bühne (K1, {@link PruefumgebungUhr} stellt den Kennzahl-Lauf): erst die Kaskaden der
 * eingetragenen Ablesungen, dann der Regellauf. Die Demo-API braucht K1 ebenso, sonst hält ihre Kaskade an.
 *
 * <p>Die {@code null}-Anzeige der Bewertung (Rangliste/Messabdeckung „unvollständig“, „0 von 3 Anlagen“) ist KEIN
 * Datenmangel dieses Werkzeugs, sondern folgt aus der bewusst dünnen Messabdeckung der Welt 1.10 (nur Spritzguss
 * gemessen); eine vollständige energetische Bewertung bräuchte die Anlagen-Bilanz je Energieeinsatz — ein eigener,
 * größerer Aufbau, hier nicht enthalten.
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

    // Die Standorte und Anlagen der Welt 1.4 (fest im SQL-Seed, {@code infra/local/seed/ahrenberg.sql}).
    private static final UUID ST1 = UUID.fromString("20000000-0000-0000-0000-0000000000a1"); // Werk Ahrenberg
    private static final UUID ST2 = UUID.fromString("20000000-0000-0000-0000-0000000000a2"); // Werk Lindach
    private static final UUID AN1 = UUID.fromString("20000000-0000-0000-0000-000000000501"); // Halle 1
    private static final String WR_HALLE1 = "20000000-0000-0000-0000-000000000701"; // Hybrid-Wechselrichter Halle 1
    private static final UUID AN2 = UUID.fromString("20000000-0000-0000-0000-000000000502"); // Halle 2
    private static final UUID AN3 = UUID.fromString("20000000-0000-0000-0000-000000000503"); // Werk Lindach
    private static final UUID GEB_HALLE2 = UUID.fromString("20000000-0000-0000-0000-000000000102"); // G-2
    private static final String G1 = "20000000-0000-0000-0000-000000000101"; // Halle 1
    private static final String G3 = "20000000-0000-0000-0000-000000000103"; // Verwaltung
    private static final UUID UNTERNEHMEN = UUID.fromString("20000000-0000-0000-0000-000000000010");
    // Die Kundenkonten des Seeds (benutzer.sub, siehe infra/local/seed/ahrenberg.sql).
    private static final String JW = "20000000-0000-0000-0000-0000000008a1"; // Jonas Wendlinger (Kundenadministrator)
    private static final String IK = "20000000-0000-0000-0000-0000000008a2"; // Ines Kaltenbach (Energiemanager)
    private static final String PH = "20000000-0000-0000-0000-0000000008a3"; // Peter Hollerbach
    private static final String MD = "20000000-0000-0000-0000-0000000008a4"; // Murat Demirci
    private static final String CB = "20000000-0000-0000-0000-0000000008a5"; // Claudia Berger
    // Der jahreszeitliche Verlauf des Strombezugs (Jan…Dez) für die zusätzlichen Reihen — Winter höher.
    private static final double[] SAISON = {1.08, 1.06, 1.02, 0.98, 0.95, 0.92, 0.90, 0.88, 0.95, 1.03, 1.06, 1.09};
    // Heizgradtage (Kd) je Monat (Jan…Dez) für die Gradtagzahl und den witterungsabhängigen Gasbezug.
    private static final double[] GRADTAGE = {560, 480, 400, 260, 120, 30, 10, 15, 90, 240, 400, 520};

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
    @Autowired AblesungService ablesungen;
    @Autowired KorrekturKaskade kaskade;

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

        // Der Rundgang füllt die restlichen UEMS-Flächen, damit keine Liste leer und kein Pflichtfeld „null" bleibt:
        // Stammdaten (Postleitzahl, Lage, Notiz), Netzanschlüsse, weitere Messstellen und Bezugsgrößen,
        // Kostenstellen und der Zweck der Kennzahlen. Alles über die Portal-Routen als Ines Kaltenbach,
        // idempotent (ein zweiter Lauf schreibt nichts).
        stammdaten();
        netzanschluesse();
        referenzpreise();
        rollenHalle1(root);
        messstellenExtra();
        bezugsgroessenExtra();
        kostenstellen();
        kennzahlZwecke();
        System.out.println("Rundgang: Stammdaten, Netzanschlüsse, Referenzpreise, Rollen Halle 1, Messstellen, "
                + "Bezugsgrößen, Kostenstellen und Kennzahl-Zwecke ergänzt.");

        // Zweite Runde: die Flächen füllen (sonst „fehlt die Fläche" am echten Datum), jede Kennzahl mit eigener
        // Messgröße und eigener Einheit (statt sechsmal identisch kWh je kg), die energetische Bewertung mit echten
        // Zahlen (Hauptzähler + Unterzähler je Energieeinsatz, Verantwortliche, Kriterien), die Verteilung auf
        // Kostenstellen, bestätigte Bezugsbasen, eine aktuelle energetische Bewertung, eine Verteilung-Korrektur,
        // ein Bezugsdaten-Import und eine befristete Einsicht.
        flaechen(root);
        kennzahlenDistinct();
        KennzahlLauf.Lauf lauf2 = kennzahlen.lauf(Instant.now()); // die neuen Kennzahlen rechnen (vor den Bezugsbasen)
        bezugsbasenNeu();
        bewertung(root);
        verteilung();
        bezugsbasenBestaetigen();
        energetischeBewertungAktuell();
        korrektur();
        bezugsdatenImport();
        einsicht();
        System.out.println("Rundgang Runde 2: Flächen, distinkte Kennzahlen, Bewertung, Verteilung, Bezugsbasen, "
                + "energetische Bewertung, Korrektur, Import und Einsicht ergänzt. Kennzahlen: " + lauf2);

        // Runde 3 - Demo-Füllung Auswerten (Konzept a1, Entscheid 12): passende Zähler, Bühnen-Bestand bis 03/2029,
        // BB-0001 Fassung 2 wie die Referenzwelt, Kennzahlen gerechnet auf der Bühne, BB-0006/BB-0007 neu gefasst.
        // Die Kennzahlen rechnet die Bühne: PruefumgebungUhr stellt den Kennzahl-Lauf (K1, PR #1428). Ohne K1 trügen die
        // Werte 2027-2029 ein berechnet_am in der Zukunft, und die erste echte Ablesung hielte die Kaskade der API an.
        assertThat(kennzahlen.rechenzeit(Instant.now())).as("der Kennzahl-Lauf rechnet auf der Bühne (K1)")
                .isAfterOrEqualTo(Instant.parse(PruefumgebungAhrenberg.BUEHNE));
        kennzahlenPassend();
        // Die rückwirkende Berechnung rechnet die alten Monate neu - in der API im nächsten Takt, hier sofort, damit die
        // Bezugsbasen unten aus den neuen Werten gefasst werden.
        int anlaesse = kaskadeLeeren();
        buehnenBestand(root, bz1);
        bezugsbasisReferenzwelt(root);
        // Jede eingetragene Ablesung ist ein Anlass der Kaskade über die ganze Reihe (auch 10/2026 bis 03/2027, vor dem
        // Fenster des Regellaufs von 24 Monaten); danach rechnet der Regellauf den Rest, beides auf der Bühne.
        anlaesse += kaskadeLeeren();
        KennzahlLauf.Lauf buehne = kennzahlen.lauf(Instant.now());
        bezugsbasisNeuGefasst("KZ-0021", "BZ-2");
        bezugsbasisNeuGefasst("KZ-0023", "BZ-2");
        System.out.println("Rundgang Runde 3: passende Zähler, Bühnen-Bestand bis 03/2029, BB-0001 Fassung 2 "
                + "(Referenzwelt). Kaskade: " + anlaesse + " Anlässe, Kennzahlen auf der Bühne: " + buehne);
    }

    /** Die Kaskade, bis kein Anlass mehr offen ist - in der API erledigt das ihr Takt (je Lauf höchstens 50). */
    private int kaskadeLeeren() {
        int summe = 0;
        for (int i = 0; i < 100; i++) {
            KorrekturKaskade.Lauf l = kaskade.lauf(Instant.now());
            if (!l.abgelehnt().isEmpty()) {
                System.out.println("Rundgang: Kaskade lehnte ab: " + l.abgelehnt());
            }
            if (l.anlaesse() == 0) {
                return summe;
            }
            summe += l.anlaesse();
        }
        throw new IllegalStateException("die Kaskade wird nicht leer");
    }

    /** Postleitzahl (Unternehmen und beide Standorte), Lage und Notiz von Werk Lindach — Pflichtfelder, die die Welt leer lässt. */
    private void stammdaten() throws Exception {
        status("PUT", "/api/v1/unternehmen", m(
                "name", "Kunststoffwerk Ahrenberg GmbH", "kurzname", "Ahrenberg", "zeitzone", "Europe/Berlin",
                "rechtsform", "GmbH",
                "sitz", m("strasse", "Gewerbering 7", "plz", "85221", "ort", "Ahrenberg", "land", "DE")));
        status("PUT", "/api/v1/standorte/" + ST1, m(
                "name", "Werk Ahrenberg", "kurzzeichen", "ST-1", "zeitzone", "Europe/Berlin",
                "nutzung", List.of("produktion", "buero"),
                "notiz", "Zwei Netzanschlüsse: NA-0001 (Haupteinspeisung) und NA-0002 (Halle 2).",
                "adresse", m("strasse", "Gewerbering 7", "plz", "85221", "ort", "Ahrenberg", "land", "DE"),
                "lage", m("breitengrad", 48.25, "laengengrad", 11.43)));
        status("PUT", "/api/v1/standorte/" + ST2, m(
                "name", "Werk Lindach", "kurzzeichen", "ST-2", "zeitzone", "Europe/Berlin",
                "nutzung", List.of("lager", "logistik", "montage"),
                "notiz", "Lager, Logistik und Montage; ein Netzanschluss (NA-0003).",
                "adresse", m("strasse", "Am Bahndamm 12", "plz", "85253", "ort", "Lindach", "land", "DE"),
                "lage", m("breitengrad", 48.31, "laengengrad", 11.38)));
    }

    /**
     * Die Netzanschlüsse der beiden Standorte (die Welt trägt sie nur als Notiz): zwei an Werk Ahrenberg, einer an
     * Werk Lindach, je mit Anlagenbindung und Bezugsgrenze. Ohne sie ist der Reiter „Netzanschlüsse" leer und die
     * Anlage zeigt „kein Netzanschluss".
     */
    private void netzanschluesse() throws Exception {
        // Kennzeichen NA-1/2/3, anschluss_kva und vereinbart_kw aus der Referenzwelt
        // (docs/contracts/v2/uems-referenzunternehmen.json, netzanschluesse): 630/550, 250/200, 160/120 — nichts
        // erfinden. Dasselbe Kennzeichen wie auf der laufenden Demo, damit der idempotente Lauf keinen zweiten
        // Anschluss anlegt. Die Kennzahl-Kachel „Lastspitze" liest die vereinbarte Leistung von hier.
        netzanschluss(ST1, "NA-1", "Hauptanschluss Halle 1", "47110000001", "Netzgesellschaft Ahrental (fiktiv)",
                "630", "550", "2024-03-12", AN1, "550");
        netzanschluss(ST1, "NA-2", "Anschluss Halle 2", "47110000002", "Netzgesellschaft Ahrental (fiktiv)",
                "250", "200", "2026-10-01", AN2, "200");
        netzanschluss(ST2, "NA-3", "Anschluss Lindach", "47110000003", "Netzgesellschaft Ahrental (fiktiv)",
                "160", "120", "2026-10-15", AN3, "120");
    }

    private void netzanschluss(UUID standort, String kennzeichen, String name, String malo, String netzbetreiber,
            String kva, String kw, String ab, UUID anlage, String bezugKw) throws Exception {
        String basis = "/api/v1/standorte/" + standort + "/netzanschluesse";
        for (JsonNode n : lies(basis).path("netzanschluesse")) {
            if (kennzeichen.equals(n.path("kennzeichen").asText())) {
                return; // schon da — nichts tun (idempotent)
            }
        }
        JsonNode neu = post(basis, m("kennzeichen", kennzeichen, "name", name, "malo", malo,
                "netzbetreiber", netzbetreiber, "anschluss_kva", kva, "vereinbart_kw", kw, "messung", "RLM",
                "gueltig_ab", ab));
        UUID id = UUID.fromString(neu.get("id").asText());
        status("POST", basis + "/" + id + "/anlagen",
                m("anlage_id", anlage.toString(), "gueltig_ab", ab, "grund", "Anschluss laut Netzanschlussvertrag."));
        status("POST", basis + "/" + id + "/grenzen", m("gueltig_ab", ab, "bezugsgrenze_kw", bezugKw,
                "einspeisegrenze_keine", true, "grund", "Vereinbarte Bezugsleistung laut Netzanschlussvertrag."));
    }

    /**
     * Review PR2 (Captain-Entscheid): die Kennzahl-Kacheln „Kosten" und „Lastspitze" brauchen Arbeits- und
     * Leistungspreis. Beide stehen in der Referenzwelt (docs/contracts/v2/uems-referenzunternehmen.json) und werden je
     * Anlage über die echten Portal-Routen gesetzt — der Arbeitspreis als Jonas (anlage.verwalten), der Leistungspreis
     * als Plattform-Admin über den Mandanten-Umschalter X-Tenant-Id. Beides ist ein PUT, also bei jedem Lauf idempotent.
     */
    private void referenzpreise() throws Exception {
        tarif(AN1, "22.4");
        tarif(AN2, "23.1");
        tarif(AN3, "23.8");
        leistungspreis(AN1, 96);
        leistungspreis(AN2, 96);
        leistungspreis(AN3, 88);
    }

    /** Arbeitspreis als fester Tarif am Standort der Anlage (Jonas, anlage.verwalten); GET-dann-PUT über die ganze Darstellung. */
    private void tarif(UUID site, String ctKwh) throws Exception {
        JsonNode s = lies("/api/v1/sites/" + site, jw());
        ObjectNode put = JSON.createObjectNode();
        for (String f : List.of("name", "biddingZone", "latitude", "longitude", "plantKind",
                "anzulegenderWertCtKwh", "netzladenErlaubt", "maxFeedInKw")) {
            put.set(f, s.has(f) ? s.get(f) : NullNode.getInstance());
        }
        put.put("tarifArt", "fest");
        put.put("tarifParamCtKwh", ctKwh);
        status("PUT", "/api/v1/sites/" + site, put, jw(), null);
    }

    /** Leistungspreis und jährliche Abrechnung (Plattform-Admin über den Mandanten-Umschalter X-Tenant-Id). */
    private void leistungspreis(UUID site, int eurKw) throws Exception {
        Map<String, Object> cfg = new LinkedHashMap<>();
        cfg.put("leistungspreisEurKw", eurKw);
        cfg.put("abrechnungLeistung", "jahr");
        status("PUT", "/api/v1/admin/sites/" + site + "/optimizer-config", cfg, plattformAdmin(), TENANT.toString());
    }

    /**
     * Review PR3 §4: Werk Ahrenberg – Halle 1 trägt laut Referenzwelt
     * ({@code docs/contracts/v2/uems-referenzunternehmen.json}, AN-1) PV 240 kWp + Speicher 200 kWh/100 kW
     * (Hybrid-Wechselrichter K-1 und PV-Wechselrichter K-12, Betriebsmodell Lastspitzenkappung). Die Anlagenkarte
     * liest ihre Rollen aus {@code roleCounts} (= {@code measurement_point.entity_type}), NIE aus Live-Werten -
     * ohne registrierte Erzeuger-/Speicher-Rolle zeigt sie nur „Netz/Verbrauch". Hier werden die beiden Rollen als
     * Entitäten des bestehenden Hybrid-Wechselrichters registriert (wie die composed-Entitäten grid-meter/house-load
     * aus dem SQL-Seed), damit {@code roleCounts.pv}/{@code storage} die Wirklichkeit tragen und die Karte
     * „steuert · PV + Speicher" zeigt. Direkt am Datenbestand (kein Portal-Weg: die Demo führt sonst keine
     * Erzeuger-Entität und es gibt keine adoptierbare PV-Quelle). Idempotent.
     */
    private void rollenHalle1(JdbcTemplate root) {
        root.update(
                "INSERT INTO measurement_point (tenant_id, site_id, role, entity_type, control, unit, device_id, "
                        + "capabilities, guard_config, source_kind) "
                        + "SELECT ?::uuid, ?::uuid, 'battery-hybrid', 'battery-hybrid', true, 'kW', ?::uuid, ?::jsonb, "
                        + "?::jsonb, 'composed' "
                        + "WHERE NOT EXISTS (SELECT 1 FROM measurement_point WHERE site_id = ?::uuid "
                        + "AND entity_type = 'battery-hybrid')",
                TENANT.toString(), AN1.toString(), WR_HALLE1,
                "{\"actuate\":[{\"max\":100.0,\"min\":-100.0,\"command\":\"setpoint_kw\"},{\"command\":\"limit_kw\"}],"
                        + "\"measure\":[{\"unit\":\"%\",\"channel\":\"soc_pct\"},"
                        + "{\"unit\":\"kW\",\"channel\":\"battery_power_kw\"},{\"unit\":\"kW\",\"channel\":\"pv_power_kw\"}]}",
                "{\"limits\":{\"soc_max_pct\":95.0,\"soc_min_pct\":5.0,\"max_charge_kw\":100.0,"
                        + "\"max_discharge_kw\":100.0,\"charge_from_grid_allowed\":false},"
                        + "\"failsafe\":{\"behavior\":\"self-consumption\"}}",
                AN1.toString());
        root.update(
                "INSERT INTO measurement_point (tenant_id, site_id, role, entity_type, control, unit, device_id, "
                        + "capabilities, capacity_kwp, source_kind) "
                        + "SELECT ?::uuid, ?::uuid, 'pv-generation', 'producer', false, 'kW', ?::uuid, ?::jsonb, "
                        + "240, 'composed' "
                        + "WHERE NOT EXISTS (SELECT 1 FROM measurement_point WHERE site_id = ?::uuid "
                        + "AND entity_type = 'producer')",
                TENANT.toString(), AN1.toString(), WR_HALLE1,
                "{\"measure\":[{\"unit\":\"kW\",\"channel\":\"pv_power_kw\"}]}",
                AN1.toString());
    }

    /**
     * Zwei weitere gemessene Messstellen (Strom, Wirkenergie) an den früh bestehenden Gebäuden Halle 1 und
     * Verwaltung — mit monatlichen Ablesungen ab 10/2024, damit die Liste „Messstellen" mehr als die eine zeigt und
     * jede Zeile Werte trägt. Auf einer frischen Demo entsteht die volle Reihe; auf einer bereits bespielten Box hält
     * die vorhandene Ablesung, spätere Rückträge sind ein geduldeter Konflikt.
     */
    private void messstellenExtra() throws Exception {
        messstelle("MS-21", "Netzbezug Halle 1", "Hauptzähler Netzbezug Halle 1 (Spritzguss und Werkzeugbau).",
                "400", "G-1", "2024-03-12");
        messreihe("MS-21", 1_200_000, 85_000);
        messstelle("MS-22", "Netzbezug Verwaltung", "Zähler Verwaltungsgebäude (Beleuchtung, IT, Klima).",
                "120", "G-3", "2024-03-12");
        messreihe("MS-22", 380_000, 12_000);
    }

    private void messstelle(String kennzeichen, String name, String notiz, String anschlussKw, String gebaeude,
            String ortAb) throws Exception {
        for (JsonNode ms : lies("/api/v1/messstellen").path("messstellen")) {
            if (kennzeichen.equals(ms.path("kennzeichen").asText())) {
                return; // schon da
            }
        }
        JsonNode neu = post("/api/v1/messstellen", m("kennzeichen", kennzeichen, "name", name, "art", "gemessen",
                "medium", "Strom", "notiz", notiz, "anschlussleistung_kw", anschlussKw,
                "hauptgroesse", m("groesse", "Wirkenergie", "richtung", "Bezug", "einheit", "kWh", "wertart", "Zählerstand"),
                "nebengroessen", new ArrayList<>()));
        UUID id = UUID.fromString(neu.get("id").asText());
        status("PUT", "/api/v1/messstellen/" + id + "/ort",
                m("kennzeichen", gebaeude, "gueltig_ab", ortAb, "korrektur", false, "grund", "Zuordnung zum Gebäude."));
    }

    /** Monatliche Zählerstände ab 10/2024 bis zum letzten abgeschlossenen Monat — der erste Wert ist der Anfang. */
    private void messreihe(String kennzeichen, long start, long proMonat) throws Exception {
        messreihe(kennzeichen, start, proMonat, YearMonth.now(BERLIN).minusMonths(1));
    }

    /** Wie {@link #messreihe(String, long, long)}, bis {@code bis} - derselbe Stand je Monat, gleich wann der Lauf läuft. */
    private void messreihe(String kennzeichen, long start, long proMonat, YearMonth bis) throws Exception {
        long stand = start;
        messwert(kennzeichen, YearMonth.of(2024, 10), stand);
        for (YearMonth mo = YearMonth.of(2024, 10); !mo.isAfter(bis); mo = mo.plusMonths(1)) {
            stand += Math.round(proMonat * SAISON[mo.getMonthValue() - 1]);
            messwert(kennzeichen, mo.plusMonths(1), stand);
        }
    }

    /** Ablesung an einer zusätzlichen Messstelle — geduldet, was auf einer bereits bespielten Box kollidiert (409/422). */
    private void messwert(String kennzeichen, YearMonth monat, long stand) throws Exception {
        String zeit = monat.atDay(1).atStartOfDay(BERLIN).toOffsetDateTime().toString();
        roh("POST", "/api/v1/messstellen/" + kennzeichen + "/ablesungen", Map.of("zeitpunkt", zeit, "stand", zahl(stand)));
    }

    /**
     * Zwei weitere Bezugsgrößen (Stückzahl Montage, Produktionsschichten) mit monatlichen Werten ab 10/2024 —
     * damit die Liste „Bezugsgrößen" mehr als die eine trägt. Bezugswerte sind je Periode eigenständig, ein Rücktrag
     * ist unkritisch.
     */
    private void bezugsgroessenExtra() throws Exception {
        UUID bz2 = bezugsgroesse("BZ-2", "Stückzahl Montage", "Stück", "gebaeude", GEB_HALLE2.toString());
        bezugsreihe(bz2, 40_000);
        UUID bz3 = bezugsgroesse("BZ-3", "Produktionsschichten", "Schichten", "standort", ST1.toString());
        bezugsreihe(bz3, 60);
    }

    private UUID bezugsgroesse(String kennzeichen, String name, String einheit, String geltungArt, String geltungId)
            throws Exception {
        return bezugsgroesse(kennzeichen, name, einheit, geltungArt, geltungId, null);
    }

    private UUID bezugsgroesse(String kennzeichen, String name, String einheit, String geltungArt, String geltungId,
            String art) throws Exception {
        for (JsonNode bg : lies("/api/v1/bezugsgroessen").path("bezugsgroessen")) {
            if (kennzeichen.equals(bg.path("kennzeichen").asText())) {
                return UUID.fromString(bg.get("id").asText());
            }
        }
        JsonNode neu = post("/api/v1/bezugsgroessen", m("kennzeichen", kennzeichen, "name", name, "wertart",
                "periodenwert", "einheit", einheit, "periode_art", "monat", "geltung_art", geltungArt,
                "geltung_id", geltungId, "art", art));
        return UUID.fromString(neu.get("id").asText());
    }

    private void bezugsreihe(UUID bz, long proMonat) throws Exception {
        YearMonth bis = YearMonth.now(BERLIN).minusMonths(1);
        for (YearMonth mo = YearMonth.of(2024, 10); !mo.isAfter(bis); mo = mo.plusMonths(1)) {
            long wert = Math.round(proMonat * SAISON[mo.getMonthValue() - 1]);
            roh("POST", "/api/v1/bezugsgroessen/" + bz + "/werte", Map.of("periode", mo.toString(), "wert", zahl(wert)));
        }
    }

    /** Ein paar Kostenstellen, damit die Verteilung einer Messstelle nicht ins Leere greift. */
    private void kostenstellen() throws Exception {
        kostenstelle("KS-100", "Produktion Spritzguss");
        kostenstelle("KS-200", "Montage");
        kostenstelle("KS-300", "Verwaltung");
        kostenstelle("KS-400", "Logistik Lindach");
    }

    private void kostenstelle(String kennzeichen, String name) throws Exception {
        for (JsonNode k : lies("/api/v1/unternehmen/kostenstellen").path("kostenstellen")) {
            if (kennzeichen.equals(k.path("kennzeichen").asText())) {
                return;
            }
        }
        status("POST", "/api/v1/unternehmen/kostenstellen",
                m("kennzeichen", kennzeichen, "name", name, "gueltig_ab", "2024-01-01"));
    }

    /** Der Zweck jeder Kennzahl — die Welt lässt ihn leer, das Detail zeigt sonst „—". */
    private void kennzahlZwecke() throws Exception {
        Map<String, String> zwecke = Map.of(
                "KZ-0001", "Spezifischer Stromeinsatz der Montage je gefertigtem Stück; überwacht die Effizienz der Montagelinie.",
                "KZ-0002", "Spezifischer Stromeinsatz der Montage am Standort Lindach; Vergleichsgröße zwischen den Werken.",
                "KZ-0003", "Spezifischer Stromeinsatz der Montage über das ganze Unternehmen; Grundlage der Unternehmensziele.",
                "KZ-0004", "Spezifischer Stromeinsatz des Spritzgusses je kg Produktion; wichtigste Kennzahl für Ziele und Maßnahmen.",
                "KZ-0005", "Netzbezug je Quadratmeter beheizter Fläche; erkennt Auffälligkeiten im Gebäudebetrieb.",
                "KZ-0006", "Gasbezug der Verwaltung je Gradtag; witterungsbereinigte Überwachung des Heizenergieeinsatzes.");
        for (JsonNode k : lies("/api/v1/kennzahlen").path("kennzahlen")) {
            String kz = k.path("kennzeichen").asText();
            String zweck = zwecke.get(kz);
            if (zweck == null || !k.path("zweck").isNull()) {
                continue; // unbekannt oder schon gesetzt
            }
            status("PUT", "/api/v1/kennzahlen/" + k.get("id").asText(), m("kennzeichen", kz,
                    "name", k.path("name").asText(), "verantwortlich_name", k.path("verantwortlich_name").asText(null),
                    "zweck", zweck));
        }
    }

    // ========================= Runde 2: die restlichen Flächen füllen =========================

    /** Gebäudeflächen (Halle 1 4200 m², Verwaltung 1150 m², Halle 2 3400 m²) — sonst „für kWh/m² fehlt die Fläche". */
    private void flaechen(JdbcTemplate root) throws Exception {
        flaeche(root, G1, 4200, "2024-03-12");
        flaeche(root, G3, 1150, "2024-03-12");
        flaeche(root, GEB_HALLE2.toString(), 3400, "2026-10-01");
    }

    private void flaeche(JdbcTemplate root, String ort, int m2, String ab) throws Exception {
        Integer da = root.queryForObject("SELECT count(*) FROM flaeche_gueltigkeit WHERE tenant_id = ? "
                + "AND ort_id = ?::uuid AND gueltig_ab = ?::date", Integer.class, TENANT, ort, ab);
        if (da != null && da > 0) {
            return; // schon gesetzt (idempotent)
        }
        status("PUT", "/api/v1/orte/" + ort + "/flaeche", m("m2", m2, "gueltigAb", ab));
    }

    /**
     * Jede Kennzahl mit eigener Messgröße und eigener Einheit (statt sechsmal MS-20 ÷ BZ-1 = „kWh je kg"):
     * KZ-0001/0002/0003 „je Stück", KZ-0005 „je m²", KZ-0006 „je Gradtag"; KZ-0004 bleibt „je kg".
     */
    private void kennzahlenDistinct() throws Exception {
        UUID bz4 = bezugsgroesse("BZ-4", "Gasbezug Verwaltung", "m³", "standort", ST1.toString(), "produktionsmenge");
        gasreihe(bz4);
        UUID bz5 = bezugsgroesse("BZ-5", "Gradtagzahl Verwaltung", "Kd", "standort", ST1.toString(), "gradtagzahl");
        gradtagreihe(bz5);
        // Die Welt definiert sechs Kennzahlen identisch (MS-20 ÷ BZ-1 = „kWh je kg"), weil sie nur einen Zähler
        // seedet; eine einmal gerechnete Fassung lässt sich nicht rückwirkend umdefinieren (die alten Monate blieben
        // „kWh je kg"). Darum werden die fünf falsch benannten archiviert und durch distinkte neue ersetzt, deren
        // erste Fassung schon die richtige Definition trägt — so stimmt der ganze Verlauf. KZ-0004 (Spritzguss je kg)
        // bleibt richtig und wird von Zielen/Maßnahmen zitiert.
        archiviereKennzahl("KZ-0001");
        archiviereKennzahl("KZ-0002");
        archiviereKennzahl("KZ-0003");
        archiviereKennzahl("KZ-0005");
        archiviereKennzahl("KZ-0006");
        neueKennzahl("KZ-0021", "Stromeinsatz Montage je Stück", "gebaeude", GEB_HALLE2.toString(),
                "Spezifischer Stromeinsatz der Montage je gefertigtem Stück (Halle 2).",
                eingang("zaehler", "messstelle", "MS-21"), eingang("nenner", "bezugsgroesse", "BZ-2"));
        neueKennzahl("KZ-0022", "Stromeinsatz Montage je Stück — Verwaltung", "gebaeude", G3,
                "Spezifischer Stromeinsatz je Stück, bezogen auf den Verwaltungsbereich; Vergleichsgröße.",
                eingang("zaehler", "messstelle", "MS-22"), eingang("nenner", "bezugsgroesse", "BZ-2"));
        neueKennzahl("KZ-0023", "Stromeinsatz Montage je Stück — Unternehmen", "unternehmen", UNTERNEHMEN.toString(),
                "Spezifischer Stromeinsatz der Montage über das ganze Unternehmen; Grundlage der Unternehmensziele.",
                eingang("zaehler", "messstelle", "MS-20"), eingang("nenner", "bezugsgroesse", "BZ-2"));
        neueKennzahl("KZ-0024", "Netzbezug je m²", "gebaeude", G1,
                "Netzbezug je Quadratmeter Bezugsfläche; erkennt Auffälligkeiten im Gebäudebetrieb.",
                eingang("zaehler", "messstelle", "MS-21"), eingang("nenner", "bezugsflaeche", "G-1"));
        neueKennzahl("KZ-0025", "Gasbezug Verwaltung je Gradtag", "gebaeude", G3,
                "Gasbezug der Verwaltung je Heizgradtag; witterungsbereinigte Überwachung des Heizenergieeinsatzes.",
                eingang("zaehler", "bezugsgroesse", "BZ-4"), eingang("nenner", "bezugsgroesse", "BZ-5"));
    }

    private static Map<String, Object> eingang(String rolle, String art, String kennzeichen) {
        return m("rolle", rolle, "art", art, "kennzeichen", kennzeichen);
    }

    /** Eine Welt-Kennzahl archivieren (sie bleibt mit ihren Bezugsbasen im Hintergrund), idempotent. */
    private void archiviereKennzahl(String kennzeichen) throws Exception {
        for (JsonNode k : lies("/api/v1/kennzahlen").path("kennzahlen")) {
            if (kennzeichen.equals(k.path("kennzeichen").asText()) && k.path("archiviert_am").isNull()) {
                roh("POST", "/api/v1/kennzahlen/" + k.get("id").asText() + "/archivieren", Map.of());
                return;
            }
        }
    }

    /** Eine distinkte Kennzahl mit eigenen Eingängen — Fassung 1 trägt schon die richtige Definition. Idempotent. */
    private void neueKennzahl(String kennzeichen, String name, String geltungArt, String geltungId, String zweck,
            Map<String, Object> zaehler, Map<String, Object> nenner) throws Exception {
        for (JsonNode k : lies("/api/v1/kennzahlen").path("kennzahlen")) {
            if (kennzeichen.equals(k.path("kennzeichen").asText())) {
                return; // schon da
            }
        }
        post("/api/v1/kennzahlen", m("kennzeichen", kennzeichen, "name", name, "rechenform", "quotient",
                "geltung_art", geltungArt, "geltung_id", geltungId, "verantwortlich_name", "Ines Kaltenbach",
                "zweck", zweck, "eingaenge", List.of(zaehler, nenner)));
    }

    /**
     * Bezugsbasen für die neuen Kennzahlen (die Welt-Bezugsbasen hängen an den archivierten Kennzahlen). Läuft NACH
     * dem Kennzahl-Lauf, weil eine Referenzperiode gerechnete Werte braucht. Best effort: schlägt eine fehl, bleibt
     * die Kennzahl trotzdem distinkt.
     */
    private void bezugsbasenNeu() throws Exception {
        bezugsbasisFuer("KZ-0021", "BZ-2", "2026-01/2026-03");
        bezugsbasisFuer("KZ-0023", "BZ-2", "2026-01/2026-03");
        bezugsbasisFuer("KZ-0025", "BZ-5", "2026-01/2026-03");
    }

    private void bezugsbasisFuer(String kennzeichen, String nennerKennzeichen, String referenzperiode) throws Exception {
        UUID kid = null;
        for (JsonNode k : lies("/api/v1/kennzahlen").path("kennzahlen")) {
            if (kennzeichen.equals(k.path("kennzeichen").asText())) {
                kid = UUID.fromString(k.get("id").asText());
            }
        }
        if (kid == null || !lies("/api/v1/kennzahlen/" + kid + "/bezugsbasen").path("bezugsbasen").isEmpty()) {
            return; // Kennzahl fehlt oder hat schon eine Bezugsbasis
        }
        UUID nenner = null;
        for (JsonNode b : lies("/api/v1/bezugsgroessen").path("bezugsgroessen")) {
            if (nennerKennzeichen.equals(b.path("kennzeichen").asText())) {
                nenner = UUID.fromString(b.get("id").asText());
            }
        }
        if (roh("POST", "/api/v1/kennzahlen/" + kid + "/bezugsbasen", m("zweck", "Referenzniveau aus 2026.")) >= 400) {
            return;
        }
        UUID bb = UUID.fromString(lies("/api/v1/kennzahlen/" + kid + "/bezugsbasen").path("bezugsbasen").get(0)
                .get("id").asText());
        String basis = "/api/v1/kennzahlen/" + kid + "/bezugsbasen/" + bb;
        if (roh("POST", basis + "/fassungen", m("referenzperiode", referenzperiode, "methode", "verhaeltnis",
                "variablen", List.of(nenner.toString()), "toleranz_prozent", "2.0", "wiedervorlage_monate", 12,
                "begruendung", "Erstfassung aus dem Referenzzeitraum 2026.", "gilt_ab", "2026-04-01")) >= 400) {
            return;
        }
        roh("POST", basis + "/fassungen/1/beantragen", m("begruendung", "Zur Freigabe vorgelegt."));
        roh("POST", basis + "/fassungen/1/freigeben", m("begruendung", "Nach Prüfung freigegeben."));
    }

    /** Witterungsabhängiger Gasbezug (m³) — grob Grundlast plus Heizanteil je Heizgradtag. */
    private void gasreihe(UUID bz) throws Exception {
        for (YearMonth mo = YearMonth.of(2024, 10); !mo.isAfter(YearMonth.now(BERLIN).minusMonths(1)); mo = mo.plusMonths(1)) {
            long wert = Math.round(GRADTAGE[mo.getMonthValue() - 1] * 7 + 500);
            roh("POST", "/api/v1/bezugsgroessen/" + bz + "/werte", Map.of("periode", mo.toString(), "wert", zahl(wert)));
        }
    }

    /** Monatliche Heizgradtage (Kd). */
    private void gradtagreihe(UUID bz) throws Exception {
        for (YearMonth mo = YearMonth.of(2024, 10); !mo.isAfter(YearMonth.now(BERLIN).minusMonths(1)); mo = mo.plusMonths(1)) {
            long wert = Math.round(GRADTAGE[mo.getMonthValue() - 1]);
            roh("POST", "/api/v1/bezugsgroessen/" + bz + "/werte", Map.of("periode", mo.toString(), "wert", zahl(wert)));
        }
    }

    /**
     * Die energetische Bewertung mit echten Zahlen: ein Hauptzähler der Anlage Halle 1 (der Nenner der Bilanz),
     * je Energieeinsatz ein Unterzähler von HZ-1 mit Ablesungen (die Anteile und K1…K6), Kriterien-Schwellen und eine
     * verantwortliche Person je Einsatz. Nur Halle 1 trägt Ablesungen; Montage/Lindach entstehen im Weltszenario
     * erst im Oktober 2026, darum zeigt die Rangliste „1 von … Anlagen". Die Verantwortlichen setzt der Lauf direkt,
     * weil freigegebene Berichte die Route sperren ({@code berichts_belege}).
     */
    private void bewertung(JdbcTemplate root) throws Exception {
        status("PUT", "/api/v1/unternehmen/bewertung/kriterien", m("begruendung",
                "Schwellen der energetischen Bewertung für die Demo gesetzt.",
                "werte", m("K1", "10", "K2", "80", "K3", "100000", "K5", "90", "K6", "10", "K7", 6, "K8", "80",
                        "mindest_monate", 3)));
        Map<String, String> prozess = new LinkedHashMap<>();
        for (JsonNode p : lies("/api/v1/unternehmen/prozesse").path("prozesse")) {
            prozess.put(p.path("kennzeichen").asText(), p.get("id").asText());
        }
        messstelle("HZ-1", "Hauptzähler Halle 1", "Netzbezug-Hauptzähler der Anlage Werk Ahrenberg – Halle 1.",
                "250", "G-1", "2024-03-12");
        stellung("HZ-1", "Hauptzähler");
        messreihe("HZ-1", 2_400_000, 210_000);
        unterzaehlerVonHz1("MS-20"); // Spritzguss hat bereits Ablesungen
        prozesseSetzen("MS-20", prozess.get("P-1"));
        bereichszaehler("AZ-2", "Zähler Montage", prozess.get("P-2"), 27_000);
        bereichszaehler("AZ-3", "Zähler Druckluft", prozess.get("P-3"), 18_000);
        bereichszaehler("AZ-4", "Zähler Kühlung", prozess.get("P-4"), 14_000);
        bereichszaehler("AZ-5", "Zähler Logistik", prozess.get("P-5"), 9_000);
        bereichszaehler("AZ-6", "Zähler Verwaltung", prozess.get("P-6"), 18_000);
        bereichszaehler("AZ-8", "Zähler Gebäudetechnik", prozess.get("P-8"), 13_000);
        verantwortlich(root, "EE-1", MD);
        verantwortlich(root, "EE-2", PH);
        verantwortlich(root, "EE-3", IK);
        verantwortlich(root, "EE-4", IK);
        verantwortlich(root, "EE-5", PH);
        verantwortlich(root, "EE-6", CB);
        verantwortlich(root, "EE-7", IK);
        verantwortlich(root, "EE-8", MD);
    }

    /** Ein Zähler eines Energieeinsatzes: Unterzähler von HZ-1 (die Kennzeichen „AZ-…“ bleiben, wie sie entstanden sind). */
    private void bereichszaehler(String kennzeichen, String name, String prozessId, long proMonat) throws Exception {
        messstelle(kennzeichen, name, "Unterzähler von HZ-1 an der Anlage Werk Ahrenberg – Halle 1.", null, "G-1",
                "2024-03-12");
        unterzaehlerVonHz1(kennzeichen);
        prozesseSetzen(kennzeichen, prozessId);
        messreihe(kennzeichen, 300_000 + proMonat, proMonat);
    }

    /**
     * Konzept Auswerten a1, Entscheid 5: die Bereichszähler hängen als UNTERZÄHLER an HZ-1, nicht als Abzweig daneben -
     * sonst rechnet die Energiebilanz 100 % „ohne eigenen Zähler“, während Verbrauch und Bewertung über die Prozesse
     * zuordnen. Ist die heutige Stellung schon „Unterzähler von HZ-1“, schreibt nichts (wiederholter Lauf). Ohne Stellung
     * entsteht sie ab Beginn; stand sie aus einem früheren Lauf anders (Abzweig), ersetzt eine Korrektur sie ab demselben
     * Tag (die Route, wie im Portal). Jede Ablehnung der Route bricht ab - die Demo bleibt nie still beim Abzweig.
     */
    private void unterzaehlerVonHz1(String kennzeichen) throws Exception {
        UUID id = messstelleId(kennzeichen);
        List<JsonNode> stellungen = new ArrayList<>();
        lies("/api/v1/messstellen/" + id).path("elektrische_stellung").forEach(stellungen::add);
        boolean schon = stellungen.stream().anyMatch(st -> st.path("gueltig_bis").asText(null) == null
                && "Unterzähler".equals(st.path("stellung").asText()) && "HZ-1".equals(st.path("unterzaehler_von").asText()));
        if (schon) {
            return;
        }
        boolean korrektur = !stellungen.isEmpty();
        put("/api/v1/messstellen/" + id + "/stellung", m("anlage", AN1.toString(), "stellung", "Unterzähler",
                "unterzaehler_von", "HZ-1", "gueltig_ab", "2024-03-12", "korrektur", korrektur, "grund", korrektur
                        ? "Korrektur: misst einen Teil des Bezugs von HZ-1 - Unterzähler, nicht Abzweig daneben."
                        : "Zuordnung zur Anlage Halle 1."));
    }

    private void stellung(String kennzeichen, String stellung) throws Exception {
        roh("PUT", "/api/v1/messstellen/" + messstelleId(kennzeichen) + "/stellung", m("anlage", AN1.toString(),
                "stellung", stellung, "gueltig_ab", "2024-03-12", "korrektur", false, "grund", "Zuordnung zur Anlage Halle 1."));
    }

    private void prozesseSetzen(String kennzeichen, String prozessId) throws Exception {
        roh("PUT", "/api/v1/messstellen/" + messstelleId(kennzeichen) + "/prozesse", m("gueltig_ab", "2024-03-12",
                "prozesse", List.of(prozessId), "grund", "Messstelle dem Energieeinsatz zugeordnet."));
    }

    private UUID messstelleId(String kennzeichen) throws Exception {
        for (JsonNode ms : lies("/api/v1/messstellen").path("messstellen")) {
            if (kennzeichen.equals(ms.path("kennzeichen").asText())) {
                return UUID.fromString(ms.get("id").asText());
            }
        }
        throw new IllegalStateException("Messstelle nicht gefunden: " + kennzeichen);
    }

    /** Verantwortliche Person eines Energieeinsatzes — direkt, Name und Kontoart aus dem Benutzer (idempotent). */
    private void verantwortlich(JdbcTemplate root, String einsatz, String sub) {
        root.update("UPDATE energieeinsatz e SET verantwortlich_sub = ?, verantwortlich_name = b.anzeigename, "
                + "verantwortlich_konto = b.konto FROM benutzer b WHERE e.tenant_id = ? AND e.kennzeichen = ? "
                + "AND b.tenant_id = e.tenant_id AND b.sub = ? AND e.verantwortlich_sub IS NULL "
                + "AND e.beendet_am IS NULL", sub, TENANT, einsatz, sub);
    }

    /** Verteilung der Netzbezüge auf Kostenstellen — sonst zeigt „Kostenstellen › Energie" keine Beträge. */
    private void verteilung() throws Exception {
        Map<String, String> ks = new LinkedHashMap<>();
        for (JsonNode k : lies("/api/v1/unternehmen/kostenstellen").path("kostenstellen")) {
            ks.put(k.path("kennzeichen").asText(), k.get("id").asText());
        }
        verteile("MS-20", List.of(m("kostenstelle_id", ks.get("KS-100"), "anteil_prozent", "70"),
                m("kostenstelle_id", ks.get("KS-200"), "anteil_prozent", "30")));
        verteile("MS-21", List.of(m("kostenstelle_id", ks.get("KS-200"), "anteil_prozent", "100")));
        verteile("MS-22", List.of(m("kostenstelle_id", ks.get("KS-300"), "anteil_prozent", "100")));
    }

    private void verteile(String kennzeichen, List<?> zeilen) throws Exception {
        UUID id = messstelleId(kennzeichen);
        if ("verteilt".equals(lies("/api/v1/messstellen/" + id + "/verteilung?am=2026-09-01").path("zustand").asText())) {
            return; // schon verteilt
        }
        roh("PUT", "/api/v1/messstellen/" + id + "/verteilung", m("gueltig_ab", "2024-10-01", "zeilen", zeilen,
                "korrektur", false, "grund", "Aufteilung laut Kostenrechnung."));
    }

    /**
     * Die Bezugsbasis von KZ-0004 als „geprüft, bleibt" bestätigen, damit nicht alles überfällig ist — die neuen
     * Bezugsbasen (KZ-0021/0023/0025) bleiben bewusst fällig, so steht ein „einige bestätigt, einige fällig" da.
     */
    private void bezugsbasenBestaetigen() throws Exception {
        Set<String> ziel = Set.of("BB-0001");
        for (JsonNode k : lies("/api/v1/kennzahlen?stichtag=2029-04-30").path("kennzahlen")) {
            String kid = k.get("id").asText();
            for (JsonNode bb : lies("/api/v1/kennzahlen/" + kid + "/bezugsbasen?stichtag=2029-04-30").path("bezugsbasen")) {
                if (ziel.contains(bb.path("kennzeichen").asText())
                        && bb.path("frist").path("ueberpruefung_faellig").asBoolean()) {
                    status("POST", "/api/v1/kennzahlen/" + kid + "/bezugsbasen/" + bb.get("id").asText() + "/bleibt",
                            m("begruendung", "Bezugsbasis nach der jährlichen Überprüfung unverändert bestätigt; "
                                    + "Datenlage weiterhin plausibel."));
                }
            }
        }
    }

    /** Eine aktuelle energetische Bewertung freigeben, damit die Überprüfung nicht „überfällig" ist. */
    private void energetischeBewertungAktuell() throws Exception {
        boolean faellig = false;
        for (JsonNode b : lies("/api/v1/berichte?stichtag=2029-04-30").path("berichte")) {
            if ("energetische_bewertung".equals(b.path("vorlage").asText())
                    && b.path("ueberpruefung").path("abgeloest_durch").isNull()) {
                faellig = b.path("ueberpruefung").path("ueberpruefung_faellig").asBoolean();
            }
        }
        if (!faellig) {
            return; // schon aktuell
        }
        JsonNode neu = post("/api/v1/berichte", m("vorlage", "energetische_bewertung", "geltung_id", UNTERNEHMEN.toString()));
        status("POST", "/api/v1/berichte/" + neu.path("kennung").asText() + "/freigeben",
                m("entwurf_datenstand", neu.path("entwurf_datenstand").asText()));
    }

    /** Eine Ablesung-Korrektur an MS-20, damit die Korrekturen-Liste nicht leer ist. */
    private void korrektur() throws Exception {
        JsonNode liste = lies("/api/v1/standorte/" + ST1 + "/korrekturen");
        if (liste.isArray() && liste.size() > 0) {
            return; // schon eine Korrektur vorhanden
        }
        JsonNode ablesungen = lies("/api/v1/messstellen/MS-20/ablesungen");
        JsonNode reihe = ablesungen.has("ablesungen") ? ablesungen.get("ablesungen") : ablesungen;
        if (!reihe.isArray() || reihe.isEmpty()) {
            return;
        }
        JsonNode a = reihe.get(reihe.size() - 2 >= 0 ? reihe.size() - 2 : 0); // vorletzte Ablesung
        String zeit = a.path("zeitpunkt").asText();
        long stand = Math.round(Double.parseDouble(a.path("stand").asText("0").replace(".", "").replace(",", "."))) + 500;
        roh("POST", "/api/v1/messstellen/MS-20/ablesungen/" + java.net.URLEncoder.encode(zeit, StandardCharsets.UTF_8)
                + "/berichtigung", m("stand", zahl(stand), "begruendung",
                "Zählerstand nach festgestelltem Ablesefehler um 500 kWh korrigiert."));
    }

    /** Ein Bezugsdaten-Import (BZ-3 Produktionsschichten), damit das Import-Protokoll nicht leer ist. */
    private void bezugsdatenImport() throws Exception {
        if (lies("/api/v1/bezugsdaten/importe").path("importe").size() > 0) {
            return; // schon ein Import vorhanden
        }
        String csv = "periode;wert\n2024-10;60\n2024-11;58\n2024-12;55\n";
        String zuordnung = JSON.writeValueAsString(m("csv", m("trennzeichen", ";", "kopfzeile", true),
                "spalten", m("periode", 1, "wert", 2), "deutung", "periode", "zahlformat", "de", "bezugsgroesse", "BZ-3"));
        var vorschau = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                .multipart("/api/v1/bezugsdaten/importe/vorschau").file(datei(csv)).file(teil("zuordnung", zuordnung))
                .with(authentication(ines()))).andReturn().getResponse();
        if (vorschau.getStatus() >= 400) {
            return; // Vorschau nicht möglich — Import überspringen (best effort)
        }
        String kennung = JSON.readTree(vorschau.getContentAsString(StandardCharsets.UTF_8)).at("/vorschau/kennung").asText();
        String bestaetigung = JSON.writeValueAsString(m("vorschau", kennung));
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                .multipart("/api/v1/bezugsdaten/importe").file(datei(csv)).file(teil("zuordnung", zuordnung))
                .file(teil("bestaetigung", bestaetigung)).with(authentication(ines())));
    }

    private static org.springframework.mock.web.MockMultipartFile datei(String inhalt) {
        return new org.springframework.mock.web.MockMultipartFile("datei", "schichten.csv", "text/csv",
                inhalt.getBytes(StandardCharsets.UTF_8));
    }

    private static org.springframework.mock.web.MockMultipartFile teil(String name, String json) {
        return new org.springframework.mock.web.MockMultipartFile(name, "", "application/json",
                json.getBytes(StandardCharsets.UTF_8));
    }

    /** Eine befristete Einsicht (Fachperson) je als Kundenadministrator — Einsicht ist eine KA-Zuweisung. */
    private void einsicht() throws Exception {
        einsichtFuer(MD, "Befristete Einsicht für das interne Audit.");
        einsichtFuer(CB, "Befristete Einsicht für das Controlling.");
    }

    private void einsichtFuer(String sub, String grund) throws Exception {
        JsonNode liste = lies("/api/v1/zugriff?benutzer=" + sub);
        for (JsonNode z : (liste.isArray() ? liste : liste.path("zugriffe"))) {
            if ("einsicht".equals(z.path("rolle").asText())) {
                return; // hat schon eine Einsicht (die Überlappungssperre lässt keine zweite zu)
            }
        }
        // Einsicht gilt mandantenweit (ohne Standort, „alle Standorte, auch künftige") und ist befristbar.
        var b = request(HttpMethod.POST, "/api/v1/zugriff").with(authentication(jw()))
                .contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(m("benutzer_sub", sub,
                        "rolle", "einsicht", "gueltig_bis", LocalDate.now(BERLIN).plusMonths(6).toString(),
                        "grund", grund)));
        try {
            mvc.perform(b); // best effort — eine Überschneidung mit einer bestehenden Zuweisung ist unkritisch
        } catch (Exception e) {
            System.out.println("Einsicht für " + sub + " übersprungen: " + e.getMessage());
        }
    }

    /** Jonas Wendlinger (Kundenadministrator) — für die Zuweisungen, die ein Energiemanager nicht darf. */
    private static Authentication jw() {
        Jwt jwt = Jwt.withTokenValue("rundgang").header("alg", "none").subject(AhrenbergWelt.SEED_SUBJECTS.get("JW"))
                .issuedAt(Instant.now()).expiresAt(Instant.now().plusSeconds(3600))
                .claim("tenant_id", TENANT.toString()).claim("realm_access", Map.of("roles", List.of()))
                .claim("name", "Jonas Wendlinger").claim("preferred_username", "jonas").build();
        return new KeycloakRealmRoleConverter().convert(jwt);
    }

    /**
     * Je Monat {kWh an MS-20, kg an BZ-1} bis {@code bis}: bis September 2026 das Muster des Rundgangs (Jahreszeit,
     * langsam sinkender Einsatz je kg), ab Oktober 2026 die Referenzwelt ({@link #referenzReihe}) - so stimmen die Läufe
     * der echten Zeit und der Bühnen-Bestand Monat für Monat überein. Über die Route schreibt der Lauf nur abgeschlossene
     * Monate der ECHTEN Zeit (Periodenende ≤ {@code created_at}); den Rest bis zum Bühnen-Tag {@link #buehnenBestand}.
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
        out.putAll(referenzReihe());
        out.keySet().removeIf(m -> m.isAfter(bis));
        return out;
    }

    /**
     * MS-20 (kWh) und BZ-1 (kg) von Oktober 2026 bis März 2029 aus {@code docs/contracts/v2/uems-referenzunternehmen.json}
     * - die Referenzwelt ist die Wahrheit: Oktober 2026 (BB-0001 Fassung 1), November 2026 bis Oktober 2027 (Grundlage
     * von BB-0001 Fassung 2), Dezember 2027 (AP-18 R1), Januar 2028 (R6), Februar 2028 bis Januar 2029 (R5, gleich
     * {@code kennzahlen_1_9_monate}); ihre Summe 2028 ohne den März (außerhalb der Spanne) ist der eingefrorene Stand des
     * Energieziels 2028: 876.600 kWh. Drei Monate nennt die Referenzwelt nicht; sie stehen als Annahme gegen die
     * Regression von BB-0001 Fassung 2 (10.523 kWh + 0,2343 kWh je kg): November 2027 im Rahmen (+0,3 %), Februar 2029
     * wie das Jahr davor (−3,4 %), März 2029 über der Bezugsbasis (+2,2 %, die offene Auffälligkeit der Konzepte).
     */
    static Map<YearMonth, long[]> referenzReihe() {
        JsonNode r = referenz();
        Map<YearMonth, long[]> out = new LinkedHashMap<>();
        JsonNode bb1 = r.at("/bezugsbasen/0");
        for (JsonNode f : bb1.path("fassungen")) {
            for (JsonNode g : f.path("grundlage")) {
                out.put(YearMonth.parse(g.path("periode").asText()),
                        new long[] {g.at("/zaehler/wert").asLong(), g.at("/nenner/wert").asLong()});
            }
        }
        out.put(YearMonth.of(2027, 11), new long[] {82_500, 306_000}); // Annahme
        for (JsonNode fall : r.at("/abnahmefaelle_ap18/faelle")) {
            JsonNode g = fall.path("gegeben");
            if (g.has("vergleich_dezember_2027")) {
                JsonNode d = g.path("vergleich_dezember_2027");
                out.put(YearMonth.of(2027, 12), new long[] {d.path("gemessen_kwh").asLong(), d.at("/bedingung/BZ-1_kg").asLong()});
            }
            if (g.has("januar_2028")) {
                out.put(YearMonth.of(2028, 1), new long[] {g.at("/januar_2028/kwh").asLong(), g.at("/januar_2028/kg").asLong()});
            }
            g.path("je_monat").fields().forEachRemaining(e -> out.put(YearMonth.parse(e.getKey()),
                    new long[] {e.getValue().path("kwh").asLong(), e.getValue().path("kg").asLong()}));
        }
        out.put(YearMonth.of(2029, 2), new long[] {79_200, 305_000}); // Annahme
        out.put(YearMonth.of(2029, 3), new long[] {84_030, 306_000}); // Annahme
        return out;
    }

    private static JsonNode referenzWelt;

    /** Die Referenzdatei, einmal gelesen (Maven läuft in {@code services/api}). */
    static synchronized JsonNode referenz() {
        if (referenzWelt == null) {
            try {
                referenzWelt = JSON.readTree(Path.of("../../docs/contracts/v2/uems-referenzunternehmen.json").toFile());
            } catch (java.io.IOException e) {
                throw new IllegalStateException("Referenzdatei nicht lesbar", e);
            }
        }
        return referenzWelt;
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

    // ========================= Runde 3: Demo-Füllung Auswerten (Konzept a1, Entscheid 12) =========================

    /** Der letzte Monat des Bühnen-Bestands: der Bühnen-Tag 30.04.2029 liegt im April, der März ist abgeschlossen. */
    private static final YearMonth BUEHNE_BIS = YearMonth.of(2029, 3);

    /**
     * KZ-0021 bis KZ-0023 rechnen mit passenden Zählern (Konzept a1 §4.7): die Montage je Stück mit dem Zähler der
     * Montage (AZ-2) statt dem Netzbezug von Halle 1 bzw. dem Spritzguss, und KZ-0022 - eine Montage gibt es in der
     * Verwaltung nicht - als Strom der Verwaltung (AZ-6) je m² Bezugsfläche. Über die Route „Berechnung ändern ab …“,
     * rückwirkend ab dem ersten Monat, damit der ganze Verlauf die neue Definition trägt. Idempotent: steht der Zähler
     * schon in der wirksamen Fassung, schreibt der Lauf nichts.
     */
    private void kennzahlenPassend() throws Exception {
        berechnungAb("KZ-0021", eingang("zaehler", "messstelle", "AZ-2"), eingang("nenner", "bezugsgroesse", "BZ-2"),
                "Zähler der Montage statt Netzbezug Halle 1 - der Zähler passt zur Kennzahl.");
        berechnungAb("KZ-0023", eingang("zaehler", "messstelle", "AZ-2"), eingang("nenner", "bezugsgroesse", "BZ-2"),
                "Zähler der Montage statt Spritzguss - der Zähler passt zur Kennzahl.");
        berechnungAb("KZ-0022", eingang("zaehler", "messstelle", "AZ-6"), eingang("nenner", "bezugsflaeche", "G-3"),
                "Zähler der Verwaltung je Quadratmeter - eine Montage gibt es in der Verwaltung nicht.");
        stammdaten("KZ-0022", "Stromeinsatz Verwaltung je m²",
                "Stromeinsatz der Verwaltung je Quadratmeter Bezugsfläche; erkennt Auffälligkeiten im Bürobetrieb.");
    }

    private void berechnungAb(String kennzeichen, Map<String, Object> zaehler, Map<String, Object> nenner,
            String begruendung) throws Exception {
        String id = kennzahlId(kennzeichen);
        if (id == null) {
            return;
        }
        for (JsonNode f : lies("/api/v1/kennzahlen/" + id + "/fassungen").path("fassungen")) {
            if (f.path("gueltig_bis").isNull() && f.path("aufgehoben_am").isNull()) {
                for (JsonNode e : f.path("eingaenge")) {
                    if ("zaehler".equals(e.path("rolle").asText())
                            && zaehler.get("kennzeichen").equals(e.path("kennzeichen").asText())) {
                        return; // schon passend
                    }
                }
            }
        }
        status("POST", "/api/v1/kennzahlen/" + id + "/fassungen", m("gueltig_ab", "2024-10-01",
                "begruendung", begruendung, "eingaenge", List.of(zaehler, nenner)));
    }

    private void stammdaten(String kennzeichen, String name, String zweck) throws Exception {
        for (JsonNode k : lies("/api/v1/kennzahlen").path("kennzahlen")) {
            if (kennzeichen.equals(k.path("kennzeichen").asText()) && !name.equals(k.path("name").asText())) {
                status("PUT", "/api/v1/kennzahlen/" + k.get("id").asText(), m("kennzeichen", kennzeichen, "name", name,
                        "verantwortlich_name", k.path("verantwortlich_name").asText(null), "zweck", zweck));
            }
        }
    }

    private String kennzahlId(String kennzeichen) throws Exception {
        for (JsonNode k : lies("/api/v1/kennzahlen").path("kennzahlen")) {
            if (kennzeichen.equals(k.path("kennzeichen").asText())) {
                return k.get("id").asText();
            }
        }
        return null;
    }

    /**
     * Der Bühnen-Bestand bis März 2029 (Entscheid A2): die Bühne steht am 30.04.2029 - Kennzahl-Vergleich, Energieziele
     * 2028/2029 und die Bewertung über ihre Datengrundlage (April 2028 bis März 2029) brauchen Werte dieser Monate.
     * <ul>
     *   <li><b>Ablesungen</b> über die echte Route, mit der Bühnen-Uhr am Ablese-Dienst - wie der Welt-Aufbau seine Uhren
     *       stellt. Die Route lehnt sonst jede Ablesung nach jetzt ab ({@code ZEITPUNKT_UNGUELTIG}).</li>
     *   <li><b>Bezugswerte</b> als direkter Stand mit der Erfassungszeit am Morgen nach dem Periodenende: keine Route kann
     *       sie schreiben - {@code bezugsgroesse_wert_abgeschlossen_chk} verlangt Periodenende ≤ {@code created_at}, und
     *       {@code created_at} setzt nur die Datenbank (die App-Rolle darf die Spalte nicht schreiben). Der Lauf schreibt
     *       dieselben Beträge wie die Route im jeweiligen Monat; ein späterer Lauf über die Route ist eine Wiederholung.</li>
     * </ul>
     * Die Flächen der echten Uhr zeigen davon nichts vor seiner Zeit (Stichtag-Grenze an Bezugswerten, Werten einer
     * Messstelle, Ablesungen und Lückenlauf). Idempotent: dieselbe Ablesung ist eine Wiederholung, ein Bezugswert wird nur
     * geschrieben, wenn seine Periode noch keinen hat.
     */
    private void buehnenBestand(JdbcTemplate root, UUID bz1) throws Exception {
        ablesungen.uhrStellen(Clock.fixed(Instant.parse(PruefumgebungAhrenberg.BUEHNE), ZoneOffset.UTC));
        try {
            Map<YearMonth, long[]> reihe = reihe(BUEHNE_BIS);
            long stand = 1_250_000;
            for (var m : reihe.entrySet()) {
                stand += m.getValue()[0];
                ablesung(m.getKey().plusMonths(1).atDay(1), stand);
                bezugswertStand(root, bz1, m.getKey(), m.getValue()[1]);
            }
            messreihe("HZ-1", 2_400_000, 210_000, BUEHNE_BIS);
            messreihe("AZ-2", 327_000, 27_000, BUEHNE_BIS);
            messreihe("AZ-3", 318_000, 18_000, BUEHNE_BIS);
            messreihe("AZ-4", 314_000, 14_000, BUEHNE_BIS);
            messreihe("AZ-5", 309_000, 9_000, BUEHNE_BIS);
            messreihe("AZ-6", 318_000, 18_000, BUEHNE_BIS);
            messreihe("AZ-8", 313_000, 13_000, BUEHNE_BIS);
            messreihe("MS-21", 1_200_000, 85_000, BUEHNE_BIS);
            messreihe("MS-22", 380_000, 12_000, BUEHNE_BIS);
        } finally {
            ablesungen.uhrStellen(Clock.systemUTC());
        }
        YearMonth ab = YearMonth.now(BERLIN);
        for (YearMonth mo = ab; !mo.isAfter(BUEHNE_BIS); mo = mo.plusMonths(1)) {
            bezugswertStand(root, bezugsgroesseId(root, "BZ-2"), mo, Math.round(40_000 * SAISON[mo.getMonthValue() - 1]));
            bezugswertStand(root, bezugsgroesseId(root, "BZ-3"), mo, Math.round(60 * SAISON[mo.getMonthValue() - 1]));
            bezugswertStand(root, bezugsgroesseId(root, "BZ-4"), mo, Math.round(GRADTAGE[mo.getMonthValue() - 1] * 7 + 500));
            bezugswertStand(root, bezugsgroesseId(root, "BZ-5"), mo, Math.round(GRADTAGE[mo.getMonthValue() - 1]));
        }
    }

    private static UUID bezugsgroesseId(JdbcTemplate root, String kennzeichen) {
        return root.queryForObject("SELECT id FROM bezugsgroesse WHERE tenant_id = ? AND kennzeichen = ?", UUID.class,
                TENANT, kennzeichen);
    }

    /**
     * Ein Monatswert als direkter Stand (siehe {@link #buehnenBestand}) - nur für einen Monat, den die echte Zeit noch
     * nicht abgeschlossen hat, und nur, wenn die Periode noch keinen Wert trägt. Erfasst „am Morgen danach“ von Ines
     * Kaltenbach, wie die Route es täte; Einheit, Wertart und Periodenart aus der Bezugsgröße.
     */
    private static void bezugswertStand(JdbcTemplate root, UUID bz, YearMonth monat, long wert) {
        if (!monat.isAfter(YearMonth.now(BERLIN).minusMonths(1))) {
            return; // abgeschlossen in echter Zeit: das schreibt die Route
        }
        Instant erfasst = monat.plusMonths(1).atDay(1).atTime(8, 0).atZone(BERLIN).toInstant();
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                + "periode_von, periode_bis, zeitzone, fassung, vorgang, status, betrag, herkunft_art, geliefert_text, "
                + "geliefert_einheit, actor_sub, actor_name, actor_rolle, actor_art, created_at) "
                + "SELECT b.tenant_id, b.id, b.wertart, b.einheit, b.periode_art, ?, ?, 'Europe/Berlin', 1, 'erstwert', "
                + "'wirksam', ?, 'eingabe', ?, b.einheit, ?, 'Ines Kaltenbach', 'energiemanager', 'kunde', ? "
                + "FROM bezugsgroesse b WHERE b.id = ? AND b.tenant_id = ? AND NOT EXISTS (SELECT 1 FROM "
                + "bezugsgroesse_wert w WHERE w.bezugsgroesse_id = b.id AND w.periode_von = ?)",
                java.sql.Date.valueOf(monat.atDay(1)), java.sql.Date.valueOf(monat.atEndOfMonth()),
                java.math.BigDecimal.valueOf(wert), zahl(wert), AhrenbergWelt.SEED_SUBJECTS.get("IK"),
                java.sql.Timestamp.from(erfasst), bz, TENANT, java.sql.Date.valueOf(monat.atDay(1)));
    }

    /**
     * BB-0001 Fassung 2 wie die Referenzwelt (Entscheid A2): der Welt-Aufbau schreibt beide Fassungen vereinfacht als
     * Verhältnis 0,2837 ({@code AhrenbergWelt.bezugsbasisFassung}), weil seine Welt keine Werte für die Referenzperiode
     * November 2026 bis Oktober 2027 hatte. Die Referenzwelt hat dort die Regression 10.523 kWh + 0,2343 kWh je kg; die
     * Energieziele 2028 und 2029 zeigen fest auf Fassung 2 und sind gegen sie bewertet. Ohne die Korrektur lägen die
     * Werte 2028 rund 9 % statt 3,4 % unter der Basis, und der März 2028 wäre nicht „außerhalb der Spanne“.
     *
     * <p>Direkter Stand wie im Welt-Aufbau: eine freigegebene Fassung ist eingefroren (Trigger
     * {@code bezugsbasis_fassung_eingefroren}), eine neue Fassung über die Route bekäme eine neue Nummer. Die Korrektur
     * läuft darum als Eigentümer in EINER Transaktion mit {@code session_replication_role = replica} und nur, solange
     * Fassung 2 noch das Verhältnis trägt (idempotent). Alle Zahlen kommen aus der Referenzdatei.
     */
    private void bezugsbasisReferenzwelt(JdbcTemplate root) {
        JsonNode f2 = referenz().at("/bezugsbasen/0/fassungen/1");
        JsonNode spanne = f2.path("spannweite");
        List<String> gruende = new ArrayList<>();
        f2.path("anpassungsgruende").forEach(g -> gruende.add(g.asText()));
        new org.springframework.transaction.support.TransactionTemplate(
                new org.springframework.jdbc.datasource.DataSourceTransactionManager(root.getDataSource()))
                .executeWithoutResult(t -> {
                    root.execute("SET LOCAL session_replication_role = replica");
                    int n = root.update("UPDATE bezugsbasis_fassung f SET referenzperiode = ?, methode = ?, datenlage = ?, "
                            + "basiswert = ?, koeffizienten = ?::jsonb, r2 = ?, streuung_prozent = ?, "
                            + "anpassungsgruende = ?::text[], begruendung = ? FROM bezugsbasis b "
                            + "WHERE b.id = f.bezugsbasis_id AND b.tenant_id = ? AND b.kennzeichen = 'BB-0001' "
                            + "AND f.fassung = 2 AND f.methode = 'verhaeltnis'",
                            f2.path("referenzperiode").asText(), f2.path("methode").asText(), f2.path("datenlage").asText(),
                            f2.path("basiswert").decimalValue(), f2.path("koeffizienten").toString(), f2.path("r2").decimalValue(),
                            f2.path("streuung_prozent").decimalValue(), "{" + String.join(",", gruende) + "}",
                            f2.at("/freigabe/begruendung").asText(), TENANT);
                    if (n == 1) {
                        root.update("UPDATE bezugsbasis_variable v SET spannweite_von = ?, spannweite_bis = ? "
                                + "FROM bezugsbasis_fassung f JOIN bezugsbasis b ON b.id = f.bezugsbasis_id "
                                + "WHERE v.fassung_id = f.id AND b.tenant_id = ? AND b.kennzeichen = 'BB-0001' "
                                + "AND f.fassung = 2 AND v.position = 1",
                                spanne.path("von").decimalValue(), spanne.path("bis").decimalValue(), TENANT);
                    }
                });
    }

    /**
     * Die Bezugsbasis einer Kennzahl, deren Berechnung sich geändert hat ({@link #kennzahlenPassend}), neu gefasst:
     * dieselbe Referenzperiode aus den neu gerechneten Werten, dasselbe „gilt ab“ - die neue Fassung ersetzt die alte ganz
     * (Anpassungsgrund „Grundlage korrigiert“). Über die Routen, wie {@link #bezugsbasisFuer}. Idempotent: nur, solange
     * die Bezugsbasis eine einzige Fassung hat.
     */
    private void bezugsbasisNeuGefasst(String kennzeichen, String nennerKennzeichen) throws Exception {
        String kid = kennzahlId(kennzeichen);
        if (kid == null) {
            return;
        }
        JsonNode basen = lies("/api/v1/kennzahlen/" + kid + "/bezugsbasen").path("bezugsbasen");
        if (basen.size() != 1 || basen.get(0).path("fassungen").size() != 1) {
            return;
        }
        JsonNode f1 = basen.get(0).path("fassungen").get(0);
        String basis = "/api/v1/kennzahlen/" + kid + "/bezugsbasen/" + basen.get(0).get("id").asText();
        if (roh("POST", basis + "/fassungen", m("referenzperiode", f1.path("referenzperiode").asText(),
                "methode", "verhaeltnis", "variablen", List.of(bezugsgroesseIdRoute(nennerKennzeichen)),
                "toleranz_prozent", "2.0", "wiedervorlage_monate", 12, "anpassungsgruende", List.of("grundlage_korrigiert"),
                "begruendung", "Neu gefasst: die Kennzahl rechnet jetzt mit dem passenden Zähler.",
                "gilt_ab", f1.path("gilt_ab").asText())) >= 400) {
            return;
        }
        roh("POST", basis + "/fassungen/2/beantragen", m("begruendung", "Zur Freigabe vorgelegt."));
        roh("POST", basis + "/fassungen/2/freigeben", m("begruendung", "Nach Prüfung freigegeben."));
    }

    private String bezugsgroesseIdRoute(String kennzeichen) throws Exception {
        for (JsonNode b : lies("/api/v1/bezugsgroessen").path("bezugsgroessen")) {
            if (kennzeichen.equals(b.path("kennzeichen").asText())) {
                return b.get("id").asText();
            }
        }
        throw new IllegalStateException("Bezugsgröße nicht gefunden: " + kennzeichen);
    }

    /** Wie im Portal eingetippt: die Zahl-Regel liest ab vier Stellen nur mit Tausenderpunkten ({@code BezugsdatenRegeln}). */
    private static String zahl(long n) {
        return String.format(Locale.GERMANY, "%,d", n);
    }

    private int status(String method, String path, Object body) throws Exception {
        var b = request(HttpMethod.valueOf(method), path).with(authentication(ines()))
                .contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        var r = mvc.perform(b).andReturn().getResponse();
        if (r.getStatus() >= 400 && r.getStatus() != 409) {
            throw new IllegalStateException(method + " " + path + " " + JSON.writeValueAsString(body) + " → " + r.getStatus() + " "
                    + r.getContentAsString(StandardCharsets.UTF_8));
        }
        return r.getStatus();
    }

    /** Wie {@link #status}, aber mit bestimmtem Nutzer und optionalem Mandanten-Umschalter (X-Tenant-Id). */
    private int status(String method, String path, Object body, Authentication auth, String tenant) throws Exception {
        var b = request(HttpMethod.valueOf(method), path).with(authentication(auth))
                .contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            b = b.content(JSON.writeValueAsString(body));
        }
        if (tenant != null) {
            b = b.header("X-Tenant-Id", tenant);
        }
        var r = mvc.perform(b).andReturn().getResponse();
        if (r.getStatus() >= 400 && r.getStatus() != 409) {
            throw new IllegalStateException(method + " " + path + " " + JSON.writeValueAsString(body) + " → " + r.getStatus()
                    + " " + r.getContentAsString(StandardCharsets.UTF_8));
        }
        return r.getStatus();
    }

    /** Wie {@link #status}, wirft aber nie — für Ablesungen und Werte, die auf einer bespielten Box kollidieren dürfen. */
    private int roh(String method, String path, Object body) throws Exception {
        var b = request(HttpMethod.valueOf(method), path).with(authentication(ines()))
                .contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        return mvc.perform(b).andReturn().getResponse().getStatus();
    }

    /** POST, das den angelegten Datensatz (mit {@code id}) zurückgibt; ein Fehler ist echt und bricht ab. */
    private JsonNode post(String path, Object body) throws Exception {
        var b = request(HttpMethod.POST, path).with(authentication(ines()))
                .contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        var r = mvc.perform(b).andReturn().getResponse();
        if (r.getStatus() >= 400) {
            throw new IllegalStateException("POST " + path + " " + JSON.writeValueAsString(body) + " → " + r.getStatus()
                    + " " + r.getContentAsString(StandardCharsets.UTF_8));
        }
        return JSON.readTree(r.getContentAsString(StandardCharsets.UTF_8));
    }

    /** PUT als Ines; ein Fehler ist echt und bricht ab (wie {@link #post}). */
    private JsonNode put(String path, Object body) throws Exception {
        var b = request(HttpMethod.PUT, path).with(authentication(ines()))
                .contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        var r = mvc.perform(b).andReturn().getResponse();
        if (r.getStatus() >= 400) {
            throw new IllegalStateException("PUT " + path + " " + JSON.writeValueAsString(body) + " → " + r.getStatus()
                    + " " + r.getContentAsString(StandardCharsets.UTF_8));
        }
        return JSON.readTree(r.getContentAsString(StandardCharsets.UTF_8));
    }

    /** GET als Ines, als Baum gelesen — für die Idempotenz-Prüfung (ist das Kennzeichen schon da?). */
    private JsonNode lies(String path) throws Exception {
        var r = mvc.perform(request(HttpMethod.GET, path).with(authentication(ines()))).andReturn().getResponse();
        return JSON.readTree(r.getContentAsString(StandardCharsets.UTF_8));
    }

    /** GET als bestimmter Nutzer, als Baum gelesen. */
    private JsonNode lies(String path, Authentication auth) throws Exception {
        var r = mvc.perform(request(HttpMethod.GET, path).with(authentication(auth))).andReturn().getResponse();
        return JSON.readTree(r.getContentAsString(StandardCharsets.UTF_8));
    }

    /** Eine JSON-Abbildung, die {@code null}-Werte auslässt (im Gegensatz zu {@link Map#of}) — Felder ohne Wert bleiben weg. */
    private static Map<String, Object> m(Object... kv) {
        Map<String, Object> o = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            if (kv[i + 1] != null) {
                o.put((String) kv[i], kv[i + 1]);
            }
        }
        return o;
    }

    /** Ines Kaltenbach (Energiemanager) mit dem Subject des lokalen Realms — wie die Welt 1.10. */
    private static Authentication ines() {
        Jwt jwt = Jwt.withTokenValue("rundgang").header("alg", "none").subject(AhrenbergWelt.SEED_SUBJECTS.get("IK"))
                .issuedAt(Instant.now()).expiresAt(Instant.now().plusSeconds(3600))
                .claim("tenant_id", TENANT.toString()).claim("realm_access", Map.of("roles", List.of()))
                .claim("name", "Ines Kaltenbach").claim("preferred_username", "ines").build();
        return new KeycloakRealmRoleConverter().convert(jwt);
    }

    /** Plattform-Betrieb (platform-admin) — der Leistungspreis ist admin-geschützt; der Mandant kommt über X-Tenant-Id (kein tenant-Claim). */
    private static Authentication plattformAdmin() {
        Jwt jwt = Jwt.withTokenValue("rundgang").header("alg", "none").subject("20000000-0000-0000-0000-0000000008ad")
                .issuedAt(Instant.now()).expiresAt(Instant.now().plusSeconds(3600))
                .claim("realm_access", Map.of("roles", List.of("platform-admin"))).claim("name", "Plattform-Betrieb")
                .claim("preferred_username", "plattform").build();
        return new KeycloakRealmRoleConverter().convert(jwt);
    }
}
