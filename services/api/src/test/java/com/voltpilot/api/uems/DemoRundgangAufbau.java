package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneId;
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
        messstellenExtra();
        bezugsgroessenExtra();
        kostenstellen();
        kennzahlZwecke();
        System.out.println("Rundgang: Stammdaten, Netzanschlüsse, Messstellen, Bezugsgrößen, Kostenstellen und "
                + "Kennzahl-Zwecke ergänzt.");

        // Zweite Runde: die Flächen füllen (sonst „fehlt die Fläche" am echten Datum), jede Kennzahl mit eigener
        // Messgröße und eigener Einheit (statt sechsmal identisch kWh je kg), die energetische Bewertung mit echten
        // Zahlen (Hauptzähler + Abzweige je Energieeinsatz, Verantwortliche, Kriterien), die Verteilung auf
        // Kostenstellen, bestätigte Bezugsbasen, eine aktuelle energetische Bewertung, eine Verteilung-Korrektur,
        // ein Bezugsdaten-Import und eine befristete Einsicht.
        flaechen(root);
        kennzahlenDistinct();
        bewertung(root);
        verteilung();
        bezugsbasenBestaetigen();
        energetischeBewertungAktuell();
        korrektur();
        bezugsdatenImport();
        einsicht();
        KennzahlLauf.Lauf lauf2 = kennzahlen.lauf(Instant.now());
        System.out.println("Rundgang Runde 2: Flächen, distinkte Kennzahlen, Bewertung, Verteilung, Bezugsbasen, "
                + "energetische Bewertung, Korrektur, Import und Einsicht ergänzt. Kennzahlen: " + lauf2);
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
        netzanschluss(ST1, "NA-0001", "Haupteinspeisung Werk Ahrenberg", "51238401829", "Bayernwerk Netz GmbH",
                "630", "500", "2024-03-12", AN1, "500");
        netzanschluss(ST1, "NA-0002", "Netzanschluss Halle 2", "51238401830", "Bayernwerk Netz GmbH",
                "400", "315", "2026-10-01", AN2, "315");
        netzanschluss(ST2, "NA-0003", "Netzanschluss Werk Lindach", "51238401831", "LEW Verteilnetz GmbH",
                "250", "160", "2026-10-15", AN3, "160");
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
        YearMonth bis = YearMonth.now(BERLIN).minusMonths(1);
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
        kennzahlNeuFassen("KZ-0001", "kWh je Stück", List.of(eingang("zaehler", "messstelle", "MS-21"),
                eingang("nenner", "bezugsgroesse", "BZ-2")),
                "Stromeinsatz Montage je Stück: Netzbezug Halle 1 je Stückzahl Montage.");
        kennzahlNeuFassen("KZ-0002", "kWh je Stück", List.of(eingang("zaehler", "messstelle", "MS-22"),
                eingang("nenner", "bezugsgroesse", "BZ-2")),
                "Stromeinsatz Montage Lindach je Stück: Netzbezug Verwaltung je Stückzahl Montage.");
        kennzahlNeuFassen("KZ-0003", "kWh je Stück", List.of(eingang("zaehler", "messstelle", "MS-20"),
                eingang("nenner", "bezugsgroesse", "BZ-2")),
                "Stromeinsatz Montage je Stück (Unternehmen): Spritzguss je Stückzahl Montage.");
        kennzahlNeuFassen("KZ-0005", "kWh je m²", List.of(eingang("zaehler", "messstelle", "MS-21"),
                eingang("nenner", "bezugsflaeche", "G-1")),
                "Netzbezug je Quadratmeter: Strombezug Halle 1 je Bezugsfläche.");
        kennzahlNeuFassen("KZ-0006", "m³ je Kd", List.of(eingang("zaehler", "bezugsgroesse", "BZ-4"),
                eingang("nenner", "bezugsgroesse", "BZ-5")),
                "Gasbezug Verwaltung je Gradtag: Gasbezug je Gradtagzahl.");
    }

    private static Map<String, Object> eingang(String rolle, String art, String kennzeichen) {
        return m("rolle", rolle, "art", art, "kennzeichen", kennzeichen);
    }

    /** Eine neue Fassung mit anderen Eingängen — nur wenn die Kennzahl noch die alte Einheit zeigt (idempotent). */
    private void kennzahlNeuFassen(String kennzeichen, String zielEinheit, List<?> eingaenge, String begruendung)
            throws Exception {
        for (JsonNode k : lies("/api/v1/kennzahlen").path("kennzahlen")) {
            if (kennzeichen.equals(k.path("kennzeichen").asText())) {
                if (zielEinheit.equals(k.path("einheit_anzeige").asText())) {
                    return; // schon umgestellt
                }
                status("POST", "/api/v1/kennzahlen/" + k.get("id").asText() + "/fassungen",
                        m("gueltig_ab", LocalDate.now(BERLIN).toString(), "begruendung", begruendung, "eingaenge", eingaenge));
                return;
            }
        }
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
     * je Energieeinsatz ein Abzweig mit Ablesungen (die Anteile und K1…K6), Kriterien-Schwellen und eine
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
        stellung("MS-20", "Abzweig"); // Spritzguss hat bereits Ablesungen
        prozesseSetzen("MS-20", prozess.get("P-1"));
        abzweig("AZ-2", "Zähler Montage", prozess.get("P-2"), 27_000);
        abzweig("AZ-3", "Zähler Druckluft", prozess.get("P-3"), 18_000);
        abzweig("AZ-4", "Zähler Kühlung", prozess.get("P-4"), 14_000);
        abzweig("AZ-5", "Zähler Logistik", prozess.get("P-5"), 9_000);
        abzweig("AZ-6", "Zähler Verwaltung", prozess.get("P-6"), 18_000);
        abzweig("AZ-8", "Zähler Gebäudetechnik", prozess.get("P-8"), 13_000);
        verantwortlich(root, "EE-1", MD);
        verantwortlich(root, "EE-2", PH);
        verantwortlich(root, "EE-3", IK);
        verantwortlich(root, "EE-4", IK);
        verantwortlich(root, "EE-5", PH);
        verantwortlich(root, "EE-6", CB);
        verantwortlich(root, "EE-7", IK);
        verantwortlich(root, "EE-8", MD);
    }

    private void abzweig(String kennzeichen, String name, String prozessId, long proMonat) throws Exception {
        messstelle(kennzeichen, name, "Abzweig an der Anlage Werk Ahrenberg – Halle 1.", null, "G-1", "2024-03-12");
        stellung(kennzeichen, "Abzweig");
        prozesseSetzen(kennzeichen, prozessId);
        messreihe(kennzeichen, 300_000 + proMonat, proMonat);
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

    /** Zwei Bezugsbasen als „geprüft, bleibt" bestätigen, damit nicht alle fünf überfällig sind (drei bleiben es bewusst). */
    private void bezugsbasenBestaetigen() throws Exception {
        Set<String> ziel = Set.of("BB-0002", "BB-0005");
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
            if ("einsicht".equals(z.path("rolle").asText()) && z.path("beendet").isNull() && z.path("endet_am").isNull()) {
                return; // schon eine laufende Einsicht
            }
        }
        // Einsicht gilt mandantenweit (ohne Standort, „alle Standorte, auch künftige") und ist befristbar.
        var b = request(HttpMethod.POST, "/api/v1/zugriff").with(authentication(jw()))
                .contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(m("benutzer_sub", sub,
                        "rolle", "einsicht", "gueltig_bis", LocalDate.now(BERLIN).plusMonths(6).toString(),
                        "grund", grund)));
        mvc.perform(b); // best effort (409 bei Überschneidung ist in Ordnung)
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
        var b = request(HttpMethod.valueOf(method), path).with(authentication(ines()))
                .contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        var r = mvc.perform(b).andReturn().getResponse();
        if (r.getStatus() >= 400 && r.getStatus() != 409) {
            throw new IllegalStateException(method + " " + path + " " + JSON.writeValueAsString(body) + " → " + r.getStatus() + " "
                    + r.getContentAsString(StandardCharsets.UTF_8));
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

    /** GET als Ines, als Baum gelesen — für die Idempotenz-Prüfung (ist das Kennzeichen schon da?). */
    private JsonNode lies(String path) throws Exception {
        var r = mvc.perform(request(HttpMethod.GET, path).with(authentication(ines()))).andReturn().getResponse();
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
}
