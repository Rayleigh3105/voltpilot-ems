package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.repo.DeviceChargerStatusRepository;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.DayOfWeek;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
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
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Die MiSpeL-Welt der Demo-Umgebung (Captain 05.10.2026: „einen Demo-Zugang, wo alles mit Daten ausgefüllt ist“) —
 * kein Test, ein Werkzeug wie {@link com.voltpilot.api.uems.DemoRundgangAufbau}: nur mit {@code -Dmispel.jdbc=…}
 * aktiv, Aufruf über {@code infra/local/demo/demo.sh mispel}. Die vier Kundenbereiche und ihre Kundenadministratoren
 * legt das Skript über die Betreiber-Routen an; dieses Werkzeug füllt sie:
 * <ul>
 *   <li><b>Demo MiSpeL Gewerbe GmbH</b> ({@code mispel-gewerbe}): „Kühlhaus Seebach“ in der Abgrenzungsoption A1 seit
 *       01.10.2026 mit Z1/Z2, Werten des Messstellenbetreibers 01.–04.10. (CSV und MSCONS über den Import der
 *       Messstelle), Gerätewerten derselben Tage und dem Monatslauf Oktober; „Werk Talheim“ in der
 *       Ausschließlichkeitsoption mit MiSpeL-Check „lohnt sich“; „Autohaus Brenner“ im Händler-Modus (ungefördert) mit
 *       Netzladen und MiSpeL-Check „lohnt sich nicht“.</li>
 *   <li><b>Haus Kröger</b> ({@code haus-kroeger}): Einspeisevergütung, Pauschaloption vorgemerkt „Termin offen“,
 *       MiSpeL-Check Haushalt.</li>
 *   <li><b>Haus Sommer</b> ({@code haus-sommer}): Pauschaloption mit Jahreslauf (Rumpfjahr ab 01.10.2026) — ein
 *       Vorgriff auf die Zeit nach der EU-Genehmigung: die Fassung steht direkt in der Datenbank, weil die Route die
 *       Pauschaloption vor der Genehmigung zu Recht ablehnt.</li>
 *   <li><b>Haus Albers</b> ({@code haus-albers}): Wallbox mit Zurückspeisen ins Haus (V2H), Abgrenzungsoption A2,
 *       Fahrer-Einstellungen, Ladestand, Plan mit Zurückspeisen, Monatslauf und Messlatte „nur laden“.</li>
 * </ul>
 * Alle Kundenwege über die Routen des Portals (Anlage, Speicher, PV, Förderweg, Vormerkung, Zählerrollen, Strompreis,
 * MSB-Import, Ladepunkt-Fähigkeit, Fahrzeugfenster, Fahrer-Einstellungen) als der Kundenadministrator des Bereichs.
 * Direkt in die Datenbank geht nur, was im Betrieb die Box, der Optimierer oder ein Rechenlauf schreibt und lokal
 * keinen Weg hat: Box und Komponenten, Messstellen-Zuordnung, Viertelstunden-Rollups (sonst Telemetrie), Gerätewerte
 * (sonst der Schreiber), das Ergebnis des MiSpeL-Checks (sonst die Jahressimulation), Plan und Messlatte des
 * Fahrzeugs (sonst der Optimierer) und die Pauschal-Fassung (siehe oben). Die Rechenläufe (Monatslauf, Jahreslauf)
 * laufen über die echten Dienste.
 *
 * <p>Zeitachse: die Festlegung gilt ab 01.10.2026; Daten liegen für die vollen Tage 01.–04.10.2026. Der Oktober ist
 * darum „vorläufig“ (Zeitraum offen) — „endgültig“ gibt es erst nach Monatsende.
 *
 * <p>Idempotent: jeder Schritt prüft zuerst, ob er schon getan ist; ein zweiter Lauf schreibt nichts. Mit
 * {@code -Dmispel.wallbox=familienauto|golf} meldet das Werkzeug stattdessen nur den Ladestand der Wallbox neu (die
 * Karte braucht einen Ladestand jünger als fünf Minuten) und legt den Plan des Tages an, falls er fehlt
 * ({@code demo.sh wallbox}).
 */
@EnabledIfSystemProperty(named = "mispel.jdbc", matches = "jdbc:postgresql://.+")
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class DemoMispelAufbau {
    private static final String JDBC = System.getProperty("mispel.jdbc", "");
    private static final String EIGNER = System.getProperty("pruefumgebung.eigner", "voltpilot");
    private static final String EIGNER_PW = System.getProperty("pruefumgebung.eigner-passwort", "voltpilot_dev_pw");
    private static final String APP_PW = System.getProperty("pruefumgebung.app-passwort", "voltpilot_app_dev_pw");
    private static final String WALLBOX = System.getProperty("mispel.wallbox", "");
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final YearMonth OKTOBER = YearMonth.of(2026, 10);
    private static final LocalDate AB = LocalDate.of(2026, 10, 1);
    /** Die vollen Tage mit Daten: 01.–04.10.2026, halboffen bis 05.10. 00:00 Berlin. */
    private static final LocalDate BIS = LocalDate.of(2026, 10, 5);
    private static final int VIERTELSTUNDEN = 4 * 96;

    static final String GEWERBE = "Demo MiSpeL Gewerbe GmbH";
    static final String KROEGER = "Haus Kröger";
    static final String SOMMER = "Haus Sommer";
    static final String ALBERS = "Haus Albers";

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
    }

    @Autowired MockMvc mvc;
    @Autowired MispelAbgrenzungService abgrenzung;
    @Autowired MispelPauschalService pauschal;
    @Autowired DeviceChargerStatusRepository chargers;

    private JdbcTemplate root;
    private final List<String> geschrieben = new ArrayList<>();

    /** Ein Kundenbereich mit seinem Kundenadministrator (angelegt von demo.sh über die Betreiber-Routen). */
    private record Kunde(UUID tenant, String sub, String konto, String name) {}

    /** Je Viertelstunde 01.–04.10. (kWh): Netzbezug, Einspeisung, Laden und Entladen am Speicher bzw. Ladepunkt, PV, Last. */
    private record Reihe(double[] bezug, double[] abgabe, double[] laden, double[] entladen, double[] pv, double[] last) {}

    @Test
    void aufbauen() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(JDBC, EIGNER, EIGNER_PW));
        if (!WALLBOX.isEmpty()) {
            wallboxMelden(WALLBOX);
            return;
        }
        Kunde gewerbe = kunde(GEWERBE, "mispel-gewerbe");
        seebach(gewerbe);
        talheim(gewerbe);
        brenner(gewerbe);
        kroeger(kunde(KROEGER, "haus-kroeger"));
        sommer(kunde(SOMMER, "haus-sommer"));
        albers(kunde(ALBERS, "haus-albers"));
        System.out.println("MiSpeL-Demo: " + (geschrieben.isEmpty() ? "nichts zu tun, alles steht"
                : geschrieben.size() + " Schritte geschrieben: " + String.join(" · ", geschrieben)));
    }

    // ------------------------------------------------------------------ Gewerbe

    /** Abgrenzungsoption A1 seit 01.10.2026 (100 kWp, 65 kWh / 30 kW, Größe des Kundentyps a1 aus dem Konzept). */
    private void seebach(Kunde k) throws Exception {
        UUID s = anlage(k, "Kühlhaus Seebach", 48.05, 11.21, "direktvermarktung", "6.9", "dynamisch", true);
        UUID box = box(k, s, "VP-DEMO-SEEBACH");
        profil(k, s, "gewerbe");
        speicher(k, s, box, 65, 30);
        pv(k, s, "PV Dach Kühlhaus", 100);
        strompreis(k, s);
        UUID netz = komponente(k, s, box, "grid-meter", "Netzzähler", "power_kw");
        UUID speicher = komponente(k, s, box, "battery-hybrid", "Speicher Kühlhaus", "battery_power_kw");
        Map<String, UUID> ms = messstellen(k, s, box, Map.of(
                "MS-01", new String[] {"Bezug", "Hauptzähler", "netz", "sunspec.model_203.totwhimp"},
                "MS-02", new String[] {"Abgabe", "Hauptzähler", "netz", "sunspec.model_203.totwhexp"},
                "MS-03", new String[] {"Laden", "Speicher", "speicher", "battery.charge-energy"},
                "MS-04", new String[] {"Entladen", "Speicher", "speicher", "battery.discharge-energy"}),
                Map.of("netz", netz, "speicher", speicher), "Kühlhaus Seebach");
        String zp1 = "DE0001234500000000000000000011001";
        String zp2 = "DE0001234500000000000000000011002";
        rolle(k, ms.get("MS-01"), "Z1", zp1, "messstellenbetreiber");
        rolle(k, ms.get("MS-02"), "Z1", zp1, "messstellenbetreiber");
        rolle(k, ms.get("MS-03"), "Z2", zp2, "messstellenbetreiber");
        rolle(k, ms.get("MS-04"), "Z2", zp2, "messstellenbetreiber");
        foerderweg(k, s, m("foerderweg", "marktpraemie_abgrenzung", "formelsatz", "A1", "aw_regel", "viertelstunde",
                "einverstaendnis", true, "gueltig_ab", AB.toString(), "erstmalige_zuordnung", true, "netzladen", true,
                "direktvermarkter", "Nordstrom Direkt GmbH", "bilanzkreis_gesondert", true));
        Reihe r = gewerbeReihe(100, 65, 30, 4.0, true, true);
        msbEinlesen(k, ms.get("MS-01"), "msb-seebach-z1-2026-10-01-04.csv", csv(zp1, r.bezug(), r.abgabe(), 1.0));
        msbEinlesen(k, ms.get("MS-03"), "msb-seebach-z2-2026-10-01-04.edi", mscons(zp2, r.laden(), r.entladen()));
        // Gerätewerte der Box: am Speicherzähler (Entladen) misst sie 3,4 % mehr als der Messstellenbetreiber —
        // die gelbe Abgleichsampel aus BK-15.
        geraetewerte(k, s, box, netz, "sunspec.model_203.totwhimp", r.bezug(), 1.0);
        geraetewerte(k, s, box, netz, "sunspec.model_203.totwhexp", r.abgabe(), 1.0);
        geraetewerte(k, s, box, speicher, "battery.charge-energy", r.laden(), 1.0);
        geraetewerte(k, s, box, speicher, "battery.discharge-energy", r.entladen(), 1.034);
        rollups(k, s, r, 65);
        monatslauf(k, s, "A1", "Kühlhaus Seebach");
    }

    /** Ausschließlichkeitsoption: Netzladen gesperrt; der MiSpeL-Check rät zur Abgrenzungsoption (Kundentyp a4). */
    private void talheim(Kunde k) throws Exception {
        UUID s = anlage(k, "Werk Talheim", 49.08, 9.18, "direktvermarktung", "12.4", "fest", false);
        UUID box = box(k, s, "VP-DEMO-TALHEIM");
        profil(k, s, "gewerbe");
        speicher(k, s, box, 500, 250);
        pv(k, s, "PV Hallendach Talheim", 750);
        strompreis(k, s);
        UUID netz = komponente(k, s, box, "grid-meter", "Netzzähler", "power_kw");
        UUID speicher = komponente(k, s, box, "battery-hybrid", "Speicher Werk", "battery_power_kw");
        Map<String, UUID> ms = messstellen(k, s, box, Map.of(
                "MS-11", new String[] {"Bezug", "Hauptzähler", "netz", "sunspec.model_203.totwhimp"},
                "MS-12", new String[] {"Abgabe", "Hauptzähler", "netz", "sunspec.model_203.totwhexp"},
                "MS-13", new String[] {"Laden", "Speicher", "speicher", "battery.charge-energy"},
                "MS-14", new String[] {"Entladen", "Speicher", "speicher", "battery.discharge-energy"}),
                Map.of("netz", netz, "speicher", speicher), "Werk Talheim");
        String zp1 = "DE0001234500000000000000000012001";
        String zp2 = "DE0001234500000000000000000012002";
        rolle(k, ms.get("MS-11"), "Z1", zp1, "messstellenbetreiber");
        rolle(k, ms.get("MS-12"), "Z1", zp1, "messstellenbetreiber");
        rolle(k, ms.get("MS-13"), "Z2", zp2, "messstellenbetreiber");
        rolle(k, ms.get("MS-14"), "Z2", zp2, "messstellenbetreiber");
        foerderweg(k, s, m("foerderweg", "marktpraemie_ausschliesslichkeit", "gueltig_ab", AB.toString(),
                "erstmalige_zuordnung", true, "einverstaendnis", true));
        rollups(k, s, gewerbeReihe(750, 500, 250, 2.6, false, false), 500);
        check(k, s, "a4", "A1", new long[] {158, 1899, 8043}, List.of(
                posten("handel_saldierung", 1658, 2749, 8343, "Beispielrechnung a4 (Konzept § 3), realisiert"),
                posten("jahresmarktwert", 0, 0, 0, "anzulegender Wert über allen Monatsmarktwerten"),
                posten("zaehler_z2", -1000, -600, -300, "Schätzung"),
                posten("bilanzkreis", -500, -250, 0, "Schätzung")),
                List.of(basis("Speicher", 500, "kWh", "stammdaten", "Anlage"),
                        basis("PV-Leistung", 750, "kWp", "stammdaten", "Aufbau"),
                        basis("Anzulegender Wert", 12.4, "ct/kWh", "stammdaten", null),
                        basis("Formelsatz", "A1", null, "angenommen", "noch nicht gewählt")), null);
    }

    /** Händler-Modus (ungefördert): lädt aus dem Netz, „davon durch Netzladen … geschätzt“; Check „lohnt sich nicht“. */
    private void brenner(Kunde k) throws Exception {
        UUID s = anlage(k, "Autohaus Brenner", 48.37, 10.89, "direktvermarktung", "7.1", "dynamisch", true);
        UUID box = box(k, s, "VP-DEMO-BRENNER");
        profil(k, s, "gewerbe");
        komponente(k, s, box, "battery-hybrid", "Speicher Autohaus", "battery_power_kw");
        speicher(k, s, box, 65, 30);
        pv(k, s, "PV Ausstellungshalle", 100);
        strompreis(k, s);
        foerderweg(k, s, m("foerderweg", "ungefoerdert", "gueltig_ab", AB.toString(), "erstmalige_zuordnung", true,
                "einverstaendnis", true, "netzladen", true));
        rollups(k, s, gewerbeReihe(100, 65, 30, 3.0, true, false), 65);
        check(k, s, "a2", "A1", new long[] {-1321, -555, 691}, List.of(
                posten("handel_saldierung", 199, 330, 1001, "Beispielrechnung a2 (Konzept § 3), realisiert"),
                posten("jahresmarktwert", -420, -285, -110, "Beispielrechnung a2"),
                posten("zaehler_z2", -800, -450, -200, "Schätzung"),
                posten("bilanzkreis", -300, -150, 0, "Schätzung")),
                List.of(basis("Speicher", 65, "kWh", "stammdaten", "Anlage"),
                        basis("Jahresverbrauch", 60000, "kWh", "angenommen", "Konzept § 3 a2"),
                        basis("Formelsatz", "A1", null, "angenommen", "noch nicht gewählt")), null);
    }

    // ------------------------------------------------------------------ Haushalte

    /** Einspeisevergütung heute, Pauschaloption vorgemerkt „Termin offen“ (BK-27), Check Haushalt (Kundentyp c1). */
    private void kroeger(Kunde k) throws Exception {
        UUID s = anlage(k, "Haus Kröger", 53.08, 8.80, "eigenverbrauch", null, "fest", false);
        UUID box = box(k, s, "VP-DEMO-KROEGER");
        profil(k, s, "privat");
        komponente(k, s, box, "battery-hybrid", "Hausspeicher", "battery_power_kw");
        speicher(k, s, box, 10, 5);
        pv(k, s, "PV Dach", 9.2);
        foerderweg(k, s, m("foerderweg", "einspeiseverguetung", "gueltig_ab", AB.toString(),
                "erstmalige_zuordnung", true));
        if (zahl("SELECT count(*) FROM site_pauschal_vormerkung WHERE site_id = ?", s) == 0) {
            status(k, "PUT", "/api/v1/sites/" + s + "/foerderweg/pauschal-vormerkung", m("ein_betreiber", true,
                    "steckersolar_kwp", 0.8, "steckersolar_direktvermarktung", true,
                    "direktvermarkter", "Sonnenstrom Direkt eG", "bilanzkreis_gesondert", false));
            geschrieben.add("Haus Kröger: Pauschaloption vorgemerkt");
        }
        rollups(k, s, haushaltReihe(9.2, 10, 5, 0), 10);
        check(k, s, "c1", "P1", new long[] {-130, 25, 175}, List.of(
                posten("einspeisung_marktpraemie", -20, 0, 20, "Beispielrechnung c1 (Konzept § 3)"),
                posten("handel_pauschal", 60, 95, 130, "Beispielrechnung c1, gemessene Simulation"),
                posten("saldierung_pauschal", 0, 0, 25, "Beispielrechnung c1"),
                posten("direktvermarktungsentgelt", -120, -60, 0, "Schätzung"),
                posten("messstellenbetrieb", -50, -10, 0, "Schätzung")),
                List.of(basis("PV-Leistung", 10, "kWp", "stammdaten", "Aufbau mit Steckersolar"),
                        basis("Speicher", 10, "kWh", "stammdaten", "Anlage"),
                        basis("Anzulegender Wert", 8.18, "ct/kWh", "angenommen", "Einspeisevergütung + 0,4 ct, § 53 EEG"),
                        basis("Jahresverbrauch", 4500, "kWh", "angenommen", "Konzept § 3 c1")),
                "Information vor dem Wechsel: Die Pauschaloption ist erst ab dem Monatsersten nach der EU-Genehmigung "
                        + "anwendbar (Festlegung, Tenor Ziff. 9 b); gerechnet ist der Basisfall P1.");
    }

    /**
     * Pauschaloption mit Jahreslauf — Vorgriff auf die Zeit nach der EU-Genehmigung (siehe Klassenkommentar). Rumpfjahr
     * ab 01.10.2026, Werte der Tage 01.–04.10. über einen Leser aus derselben Reihe wie die Rollups.
     */
    private void sommer(Kunde k) throws Exception {
        UUID s = anlage(k, "Haus Sommer", 50.94, 6.96, "direktvermarktung", "8.18", "dynamisch", true);
        UUID box = box(k, s, "VP-DEMO-SOMMER");
        profil(k, s, "privat");
        komponente(k, s, box, "battery-hybrid", "Hausspeicher", "battery_power_kw");
        speicher(k, s, box, 10, 5);
        pv(k, s, "PV Dach", 9.8);
        UUID netz = komponente(k, s, box, "grid-meter", "Netzzähler", "power_kw");
        Map<String, UUID> ms = messstellen(k, s, box, Map.of(
                "MS-01", new String[] {"Bezug", "Hauptzähler", "netz", "sunspec.model_203.totwhimp"},
                "MS-02", new String[] {"Abgabe", "Hauptzähler", "netz", "sunspec.model_203.totwhexp"}),
                Map.of("netz", netz), "Haus Sommer");
        String zp1 = "DE0001234500000000000000000021001";
        rolle(k, ms.get("MS-01"), "Z1", zp1, "geraet");
        rolle(k, ms.get("MS-02"), "Z1", zp1, "geraet");
        Integer fassung = root.queryForObject("SELECT count(*) FROM site_foerderweg WHERE site_id = ?", Integer.class, s);
        if (fassung == 0) {
            root.update("INSERT INTO site_foerderweg (tenant_id, site_id, foerderweg, formelsatz, einverstaendnis, "
                    + "aw_regel, gueltig_ab, created_by, direktvermarkter, bilanzkreis_gesondert) VALUES (?, ?, "
                    + "'marktpraemie_pauschal', NULL, true, 'viertelstunde', ?, 'demo-mispel (Vorgriff EU-Genehmigung)', "
                    + "'Sonnenstrom Direkt eG', false)", k.tenant(), s, java.sql.Date.valueOf(AB));
            root.update("UPDATE site SET plant_kind = 'direktvermarktung', netzladen_erlaubt = true WHERE id = ?", s);
            geschrieben.add("Haus Sommer: Pauschal-Fassung ab 01.10.2026 (Vorgriff)");
        }
        Reihe r = haushaltReihe(9.8, 10, 5, 1);
        rollups(k, s, r, 10);
        Map<String, double[]> werte = Map.of("MS-01", r.bezug(), "MS-02", r.abgabe());
        pauschal.leserSetzen(new ReihenLeser(werte));
        TenantContext.set(k.tenant());
        try {
            MispelPauschalService.Lauf l = pauschal.jahreslauf(s, 2026, new MispelPauschalService.Vorgaben("P1",
                    Map.of("Pinst", new BigDecimal("9.8"), "SKinst", new BigDecimal("10")), Set.of(), null, AB, null,
                    null));
            if (l.neu()) {
                geschrieben.add("Haus Sommer: Jahreslauf 2026 " + l.gruende());
            }
        } finally {
            TenantContext.clear();
        }
    }

    /**
     * Wallbox „Garage“ mit Zurückspeisen ins Haus (BK-41 A, BK-41c A/A/A): Abgrenzungsoption A2 (Z1 am Netz, Z2 am
     * Ladepunkt), kein stationärer Speicher.
     */
    private void albers(Kunde k) throws Exception {
        UUID s = anlage(k, "Haus Albers", 52.37, 9.73, "direktvermarktung", "8.18", "dynamisch", true);
        UUID box = box(k, s, "VP-DEMO-ALBERS");
        profil(k, s, "privat");
        pv(k, s, "PV Dach", 9.9);
        strompreis(k, s);
        UUID netz = komponente(k, s, box, "grid-meter", "Netzzähler", "power_kw");
        UUID wallbox = komponente(k, s, box, "ev-charger", "Wallbox Garage", "power_kw");
        Map<String, UUID> ms = messstellen(k, s, box, Map.of(
                "MS-01", new String[] {"Bezug", "Hauptzähler", "netz", "sunspec.model_203.totwhimp"},
                "MS-02", new String[] {"Abgabe", "Hauptzähler", "netz", "sunspec.model_203.totwhexp"},
                "MS-03", new String[] {"Laden", "Speicher", "wallbox", "ev.charge-energy"},
                "MS-04", new String[] {"Entladen", "Speicher", "wallbox", "ev.discharge-energy"}),
                Map.of("netz", netz, "wallbox", wallbox), "Haus Albers");
        String zp1 = "DE0001234500000000000000000031001";
        String zp2 = "DE0001234500000000000000000031002";
        rolle(k, ms.get("MS-01"), "Z1", zp1, "messstellenbetreiber");
        rolle(k, ms.get("MS-02"), "Z1", zp1, "messstellenbetreiber");
        rolle(k, ms.get("MS-03"), "Z2", zp2, "messstellenbetreiber");
        rolle(k, ms.get("MS-04"), "Z2", zp2, "messstellenbetreiber");
        String lp = "/api/v1/sites/" + s + "/ladepunkte/" + wallbox;
        if (zahl("SELECT count(*) FROM ladepunkt_faehigkeit WHERE komponente_id = ?", wallbox) == 0) {
            status(k, "PUT", lp + "/faehigkeit", m("nutzbarkeit", "bidirektional", "v2h", true, "v2g", true,
                    "rueckspeisung_bei_einspeisung_unterbunden", false, "rueckspeiseleistung_kw", 11,
                    "gueltig_ab", AB.toString()));
            geschrieben.add("Haus Albers: Wallbox bidirektional (V2H/V2G) ab 01.10.2026");
        }
        if (zahl("SELECT count(*) FROM ladepunkt_fahrzeugfenster WHERE komponente_id = ?", wallbox) == 0) {
            List<Map<String, Object>> anwesenheit = new ArrayList<>();
            for (int tag = 1; tag <= 5; tag++) {
                anwesenheit.add(m("wochentag", tag, "ankunft", "17:45", "abfahrt", "07:15", "abfahrt_soc_pct", 80));
            }
            status(k, "PUT", lp + "/fahrzeugfenster", m("mindest_soc_pct", 40, "kapazitaet_kwh", 64,
                    "anwesenheit", anwesenheit));
            geschrieben.add("Haus Albers: Fahrzeugfenster");
        }
        if (zahl("SELECT count(*) FROM ladepunkt_fahrer_einstellung WHERE komponente_id = ?", wallbox) == 0) {
            status(k, "PUT", lp + "/fahrer-einstellungen", m("rueckspeisen", "v2h", "reserve_pct", 40,
                    "vollzyklen_je_tag", 1, "abfahrten", List.of(m("wochentage", List.of(1, 2, 3, 4, 5),
                            "abfahrt", "07:15", "abfahrt_soc_pct", 80))));
            geschrieben.add("Haus Albers: Fahrer-Einstellungen Ins Haus, Reserve 40 %, Abfahrt Mo–Fr 07:15 80 %");
        }
        // „Smart“: die Anlage lädt mit Sonne zuerst (Kunden-Einstellung im Rahmen der Ladepunkte); ohne sie stünde
        // der Ladepunkt auf „Schnell“, und das hält das Zurückspeisen an (BK-41c-3 A).
        if (zahl("SELECT count(*) FROM site_charging_config WHERE site_id = ? AND surplus_policy = 'sonne_zuerst'", s)
                == 0) {
            status(k, "PUT", "/api/v1/sites/" + s + "/charging-config", m("gridLimitKw", 32.0,
                    "surplusPolicy", "sonne_zuerst"));
            geschrieben.add("Haus Albers: Laden mit Sonne zuerst");
        }
        foerderweg(k, s, m("foerderweg", "marktpraemie_abgrenzung", "formelsatz", "A2", "aw_regel", "viertelstunde",
                "einverstaendnis", true, "gueltig_ab", AB.toString(), "erstmalige_zuordnung", true, "netzladen", true,
                "direktvermarkter", "Sonnenstrom Direkt eG", "bilanzkreis_gesondert", false));
        Reihe r = albersReihe();
        msbEinlesen(k, ms.get("MS-01"), "msb-albers-z1-2026-10-01-04.csv", csv(zp1, r.bezug(), r.abgabe(), 1.0));
        msbEinlesen(k, ms.get("MS-03"), "msb-albers-z2-2026-10-01-04.csv", csv(zp2, r.laden(), r.entladen(), 1.0));
        rollups(k, s, r, 0);
        monatslauf(k, s, "A2", "Haus Albers");
        messlatte(k, s, wallbox, r, AB.atStartOfDay(BERLIN).toInstant(), BIS.atStartOfDay(BERLIN).toInstant());
        ladestand(k, s, box, wallbox, "familienauto", true);
        planDesTages(k, s, wallbox);
    }

    /** {@code demo.sh wallbox}: Ladestand jetzt (jünger als fünf Minuten) und der Plan des Tages, falls er fehlt. */
    private void wallboxMelden(String auto) throws Exception {
        Kunde k = kunde(ALBERS, "haus-albers");
        UUID s = root.queryForObject("SELECT id FROM site WHERE tenant_id = ? AND name = ?", UUID.class, k.tenant(), ALBERS);
        UUID box = root.queryForObject("SELECT id FROM device WHERE site_id = ? AND external_ref = 'VP-DEMO-ALBERS'",
                UUID.class, s);
        UUID wallbox = root.queryForObject("SELECT id FROM measurement_point WHERE site_id = ? AND label = 'Wallbox Garage'",
                UUID.class, s);
        ladestand(k, s, box, wallbox, auto, false);
        planDesTages(k, s, wallbox);
        Instant jetzt = Instant.now();
        messlatte(k, s, wallbox, albersReihe(), BIS.atStartOfDay(BERLIN).toInstant(),
                jetzt.minusSeconds(jetzt.getEpochSecond() % 900));
        System.out.println("MiSpeL-Demo: Wallbox Garage meldet " + ("golf".equals(auto)
                ? "einen Golf ohne Rückspeise-Funktion" : "das Familienauto mit 62 %") + ". " + geschrieben);
    }

    // ------------------------------------------------------------------ Bausteine über die Routen

    private Kunde kunde(String name, String konto) {
        UUID t = root.queryForObject("SELECT id FROM tenant WHERE name = ?", UUID.class, name);
        String sub = root.queryForObject("SELECT sub FROM benutzer WHERE tenant_id = ? AND email = ?", String.class, t,
                konto + "@demo.example");
        return new Kunde(t, sub, konto, name);
    }

    /** Die Anlage über {@code POST /api/v1/sites} bzw. die von demo.sh angelegte, Stammdaten über {@code PUT}. */
    private UUID anlage(Kunde k, String name, double lat, double lon, String art, String aw, String tarif,
            boolean netzladen) throws Exception {
        List<UUID> ids = root.queryForList("SELECT id FROM site WHERE tenant_id = ? AND name = ?", UUID.class, k.tenant(),
                name);
        Map<String, Object> body = m("name", name, "biddingZone", "DE-LU", "latitude", lat, "longitude", lon,
                "plantKind", art, "anzulegenderWertCtKwh", aw == null ? null : new BigDecimal(aw), "tarifArt", tarif,
                "tarifParamCtKwh", "fest".equals(tarif) ? new BigDecimal("31.5") : null, "netzladenErlaubt", netzladen);
        if (ids.isEmpty()) {
            JsonNode neu = antwort(k, "POST", "/api/v1/sites", body);
            geschrieben.add(name + ": Anlage angelegt");
            return UUID.fromString(neu.get("id").asText());
        }
        UUID id = ids.get(0);
        Map<String, Object> ist = root.queryForMap("SELECT plant_kind, anzulegender_wert_ct_kwh, tarif_art, latitude, "
                + "netzladen_erlaubt FROM site WHERE id = ?", id);
        boolean gleich = art.equals(ist.get("plant_kind")) && tarif.equals(ist.get("tarif_art"))
                && Boolean.valueOf(netzladen).equals(ist.get("netzladen_erlaubt"))
                && ist.get("latitude") != null
                && (aw == null ? ist.get("anzulegender_wert_ct_kwh") == null
                        : ist.get("anzulegender_wert_ct_kwh") != null
                                && new BigDecimal(aw).compareTo((BigDecimal) ist.get("anzulegender_wert_ct_kwh")) == 0);
        if (!gleich) {
            status(k, "PUT", "/api/v1/sites/" + id, body);
            geschrieben.add(name + ": Stammdaten");
        }
        return id;
    }

    /** Der Speicher, dem steuernden Gerät (der Box) zugeordnet — sonst warnt die Einstellungsseite „keinem Gerät zugeordnet“. */
    private void speicher(Kunde k, UUID s, UUID box, int kwh, int kw) throws Exception {
        if (zahl("SELECT count(*) FROM asset WHERE site_id = ? AND type = 'battery' AND device_id = ?", s, box) == 0) {
            status(k, "PUT", "/api/v1/sites/" + s + "/battery", m("capacityKwh", kwh, "maxChargeKw", kw,
                    "maxDischargeKw", kw, "roundtripEfficiencyPct", 90, "deviceId", box));
            geschrieben.add("Speicher " + kwh + " kWh");
        }
    }

    /** Das Profil der Anlage (Ton und Voreinstellungen des Portals): privat oder gewerbe. */
    private void profil(Kunde k, UUID s, String profil) throws Exception {
        if (zahl("SELECT count(*) FROM site WHERE id = ? AND profil = ?", s, profil) == 0) {
            status(k, "PUT", "/api/v1/sites/" + s + "/anwendungs-preset", m("profil", profil));
            geschrieben.add("Profil " + profil);
        }
    }

    private void pv(Kunde k, UUID s, String name, double kwp) throws Exception {
        Integer n = root.queryForObject("SELECT count(*) FROM asset WHERE site_id = ? AND type = 'pv' "
                + "AND pv_capacity_kwp > 0", Integer.class, s);
        if (n == 0) {
            status(k, "POST", "/api/v1/sites/" + s + "/measurement-points", m("role", "pv-generation", "label", name,
                    "capacityKwp", kwp));
            geschrieben.add("PV " + kwp + " kWp");
        }
    }

    /** Umlagen und Netzentgelt (Arbeitspreis) — die Grundlage der Saldierung in der Monatskarte. */
    private void strompreis(Kunde k, UUID s) throws Exception {
        Integer n = root.queryForObject("SELECT count(*) FROM site_supply_price WHERE site_id = ?", Integer.class, s);
        if (n == 0) {
            status(k, "PUT", "/api/v1/sites/" + s + "/supply-price", m("umlagenCt", 2.946,
                    "netzentgeltArbeitspreisCt", 4.0, "stromsteuerCt", 2.05, "konzessionsabgabeCt", 1.66,
                    "vertriebsaufschlagCt", 1.5));
            geschrieben.add("Strompreis-Bestandteile");
        }
    }

    private void foerderweg(Kunde k, UUID s, Map<String, Object> body) throws Exception {
        if (zahl("SELECT count(*) FROM site_foerderweg WHERE site_id = ?", s) == 0) {
            status(k, "PUT", "/api/v1/sites/" + s + "/foerderweg", body);
            geschrieben.add("Förderweg " + body.get("foerderweg"));
        }
    }

    private void rolle(Kunde k, UUID ms, String rolle, String zp, String wertequelle) throws Exception {
        if (zahl("SELECT count(*) FROM messstelle_zaehlerrolle WHERE messstelle_id = ?", ms) == 0) {
            status(k, "PUT", "/api/v1/messstellen/" + ms + "/zaehlerrolle", m("rolle", rolle, "zaehlpunkt", zp,
                    "messstellenbetreiber", "Stadtwerke Demo Messstellenbetrieb", "eichstatus", "eichrechtskonform",
                    "eichfrist_bis", "2034-12-31", "wertequelle", wertequelle, "gueltig_ab", AB.toString()));
            geschrieben.add("Zählerrolle " + rolle);
        }
    }

    /** Werte des Messstellenbetreibers über den Import der Messstelle; dieselbe Datei zweimal legt nichts neu an. */
    private void msbEinlesen(Kunde k, UUID ms, String name, String inhalt) throws Exception {
        String art = name.endsWith(".csv") ? "text/csv" : "application/edifact";
        var b = multipart("/api/v1/messstellen/" + ms + "/msb-werte")
                .file(new MockMultipartFile("datei", name, art, inhalt.getBytes(StandardCharsets.UTF_8)))
                .with(authentication(auth(k)));
        var r = mvc.perform(b).andReturn().getResponse();
        assertThat(r.getStatus()).as(name + " " + r.getContentAsString(StandardCharsets.UTF_8)).isEqualTo(200);
        JsonNode j = JSON.readTree(r.getContentAsString(StandardCharsets.UTF_8));
        if (j.path("neu").asBoolean(false)) {
            geschrieben.add("MSB-Import " + name);
        }
    }

    private void monatslauf(Kunde k, UUID s, String formelsatz, String name) {
        TenantContext.set(k.tenant());
        try {
            MispelAbgrenzungService.Lauf l = abgrenzung.monatslauf(s, OKTOBER,
                    MispelAbgrenzungService.Vorgaben.von(formelsatz, "viertelstunde"));
            if (l.neu()) {
                geschrieben.add(name + ": Monatslauf Oktober " + l.gruende());
            }
        } finally {
            TenantContext.clear();
        }
    }

    // ------------------------------------------------------------------ direkt (kein Weg ohne Box/Optimierer)

    private UUID box(Kunde k, UUID s, String ref) {
        List<UUID> ids = root.queryForList("SELECT id FROM device WHERE external_ref = ?", UUID.class, ref);
        if (!ids.isEmpty()) {
            return ids.get(0);
        }
        geschrieben.add("Box " + ref);
        return root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, "
                + "'claimed') RETURNING id", UUID.class, k.tenant(), s, ref);
    }

    private UUID komponente(Kunde k, UUID s, UUID box, String typ, String name, String kanal) {
        List<UUID> ids = root.queryForList("SELECT id FROM measurement_point WHERE site_id = ? AND label = ?", UUID.class,
                s, name);
        if (!ids.isEmpty()) {
            return ids.get(0);
        }
        geschrieben.add("Komponente " + name);
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "device_id, control, communication, connection_json, capabilities, created_at) VALUES (?, ?, ?, ?, ?, "
                + "?, false, 'modbus_tcp', '{\"ip\":\"10.0.0.22\",\"unit_id\":1}'::jsonb, ?::jsonb, '2026-09-01') "
                + "RETURNING id", UUID.class, k.tenant(), s, typ, name, typ, box,
                "{\"measure\":[{\"channel\":\"" + kanal + "\",\"unit\":\"kW\"}]}");
    }

    /** Messstellen mit Stellung in der Anlage und Quelle an der Komponente (wie die Einrichtung über die Box). */
    private Map<String, UUID> messstellen(Kunde k, UUID s, UUID box, Map<String, String[]> def,
            Map<String, UUID> komponenten, String ort) {
        Map<String, UUID> out = new LinkedHashMap<>();
        for (String kz : def.keySet().stream().sorted().toList()) {
            String[] d = def.get(kz);
            List<UUID> ids = root.queryForList("SELECT id FROM messstelle WHERE tenant_id = ? AND kennzeichen = ?",
                    UUID.class, k.tenant(), kz);
            if (!ids.isEmpty()) {
                out.put(kz, ids.get(0));
                continue;
            }
            String name = switch (d[0]) {
                case "Bezug" -> "Netz Bezug " + ort;
                case "Abgabe" -> "Netz Einspeisung " + ort;
                case "Laden" -> (d[2].equals("wallbox") ? "Wallbox Laden " : "Speicher Laden ") + ort;
                default -> (d[2].equals("wallbox") ? "Wallbox Entladen " : "Speicher Entladen ") + ort;
            };
            UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                    + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', ?, 'kWh', "
                    + "'Zählerstand') RETURNING id", UUID.class, k.tenant(), kz, name, d[0]);
            root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, gueltig_ab) "
                    + "VALUES (?, ?, ?, ?, ?::date)", k.tenant(), ms, s, d[1], AB.toString());
            UUID komponente = komponenten.get(d[2]);
            root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                    + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                    + "retention_class, long_term_strategy) SELECT ?, site_id, ?, ?, ?, true, 60, 1, "
                    + "'2026-10-01'::timestamptz, '2026.09.11.1', 'demo-mispel', 'pending_edge', 'energy_counter', "
                    + "'fifteen_minute' FROM measurement_point WHERE id = ? ON CONFLICT DO NOTHING", k.tenant(), box,
                    komponente, d[3], komponente);
            UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                    + "AND gueltig_bis IS NULL", UUID.class, komponente);
            root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                    + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_sub, "
                    + "actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', ?, ?, ?, ?, 'counter', 'zaehlerstand', "
                    + "'fuehrend', '2026-10-01'::timestamptz, false, now(), ?, 'Demo-Einrichtung', 'kunde')",
                    k.tenant(), ms, d[0], komponente, geraet, d[3], k.sub());
            geschrieben.add("Messstelle " + kz + " " + ort);
            out.put(kz, ms);
        }
        return out;
    }

    /**
     * Gerätewerte wie der Schreiber sie ablegt: Zählerstände je Minute an der Quelle der Messstelle; die Verdichtung zur
     * Viertelstunde macht der Läufer der api ({@code ViertelstundeVerdichter}) selbst.
     */
    private void geraetewerte(Kunde k, UUID s, UUID box, UUID komponente, String kanal, double[] kwh, double faktor) {
        Integer n = root.queryForObject("SELECT count(*) FROM device_measurement_sample WHERE entity_id = ? "
                + "AND point_key = ?", Integer.class, komponente, kanal);
        if (n > 0) {
            return;
        }
        UUID einbau = root.queryForObject("SELECT id FROM geraet_komponente WHERE entity_id = ? AND gueltig_bis IS NULL",
                UUID.class, komponente);
        double stand = 100_000;
        Instant beginn = AB.atStartOfDay(BERLIN).toInstant();
        Instant jetzt = Instant.now();
        List<Object[]> zeilen = new ArrayList<>();
        long seq = 1;
        for (int q = 0; q < VIERTELSTUNDEN; q++) {
            double jeMinute = kwh[q] * faktor / 15.0;
            for (int min = 0; min < 15; min++) {
                Instant t = beginn.plus(Duration.ofMinutes(15L * q + min));
                zeilen.add(new Object[] {Timestamp.from(t), Timestamp.from(jetzt), k.tenant(), s, box, kanal, stand, stand,
                        seq++, komponente, einbau});
                stand += jeMinute;
            }
        }
        zeilen.add(new Object[] {Timestamp.from(BIS.atStartOfDay(BERLIN).toInstant()), Timestamp.from(jetzt), k.tenant(),
                s, box, kanal, stand, stand, seq, komponente, einbau});
        root.batchUpdate("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, "
                + "point_key, raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, aggregation_kind, "
                + "entity_id, device_install_id, applied_revision, value_kind, role, delivery, delay_s) VALUES (?, ?, ?, ?, "
                + "?, ?, ?, ?, 'good', '2026.09.11.1', ?, 'counter', ?, ?, 1, 'counter', 'fuehrend', 'direkt', 5)",
                zeilen);
        geschrieben.add("Gerätewerte " + kanal);
    }

    /** Viertelstunden-Rollups wie aus der Telemetrie der Box (Muster der Dev-Saat V20260706030000), dazu 1 h und 1 Tag. */
    private void rollups(Kunde k, UUID s, Reihe r, double speicherKwh) {
        Integer n = root.queryForObject("SELECT count(*) FROM telemetry_rollup_15m WHERE site_id = ?", Integer.class, s);
        if (n > 0) {
            return;
        }
        Instant beginn = AB.atStartOfDay(BERLIN).toInstant();
        List<Object[]> zeilen = new ArrayList<>();
        double soc = 30;
        for (int q = 0; q < VIERTELSTUNDEN; q++) {
            if (speicherKwh > 0) {
                soc = Math.max(5, Math.min(100, soc + 100 * (r.laden()[q] * 0.95 - r.entladen()[q] / 0.95) / speicherKwh));
            }
            Double socWert = speicherKwh > 0 ? round(soc, 2) : null;
            zeilen.add(new Object[] {Timestamp.from(beginn.plus(Duration.ofMinutes(15L * q))), k.tenant(), s,
                    round(r.pv()[q], 6), round(r.last()[q], 6), round(r.bezug()[q], 6), round(r.abgabe()[q], 6),
                    speicherKwh > 0 ? round(r.laden()[q], 6) : 0.0, speicherKwh > 0 ? round(r.entladen()[q], 6) : 0.0,
                    socWert, socWert, socWert});
        }
        root.batchUpdate("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh, grid_import_kwh, "
                + "grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, soc_min_pct, soc_max_pct, soc_last_pct, "
                + "n_samples) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 90) ON CONFLICT (site_id, bucket) DO NOTHING",
                zeilen);
        for (String[] stufe : new String[][] {{"telemetry_rollup_1h", "time_bucket('1 hour', bucket)"},
                {"telemetry_rollup_1d", "time_bucket('1 day', bucket, 'Europe/Berlin')"}}) {
            root.update("INSERT INTO " + stufe[0] + " (bucket, tenant_id, site_id, pv_kwh, load_kwh, grid_import_kwh, "
                    + "grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, soc_min_pct, soc_max_pct, soc_last_pct, "
                    + "n_samples) SELECT " + stufe[1] + ", tenant_id, site_id, sum(pv_kwh), sum(load_kwh), "
                    + "sum(grid_import_kwh), sum(grid_export_kwh), sum(battery_charge_kwh), sum(battery_discharge_kwh), "
                    + "min(soc_min_pct), max(soc_max_pct), last(soc_last_pct, bucket), sum(n_samples) "
                    + "FROM telemetry_rollup_15m WHERE site_id = ? GROUP BY 1, 2, 3 ON CONFLICT (site_id, bucket) DO NOTHING",
                    s);
        }
        geschrieben.add("Rollups 01.–04.10.");
    }

    /** Ergebnis des MiSpeL-Checks in der Form des Vertrags ({@code docs/contracts/v2/mispel-check.md}). */
    private void check(Kunde k, UUID s, String typ, String formelsatz, long[] differenz, List<Map<String, Object>> posten,
            List<Map<String, Object>> datenbasis, String hinweis) throws Exception {
        int n = root.update("INSERT INTO site_mispel_check (site_id, tenant_id, stand, stand_seit, formelsatz, fenster_von, "
                + "fenster_bis, differenz_niedrig_eur, differenz_mittel_eur, differenz_hoch_eur, posten, datenbasis, "
                + "hinweis) VALUES (?, ?, 'fertig', '2026-10-03T03:00:00Z', ?, '2025-10-01', '2026-09-30', ?, ?, ?, "
                + "?::jsonb, ?::jsonb, ?) ON CONFLICT (site_id) DO NOTHING", s, k.tenant(), formelsatz, differenz[0],
                differenz[1], differenz[2], JSON.writeValueAsString(posten), JSON.writeValueAsString(datenbasis), hinweis);
        if (n > 0) {
            geschrieben.add("MiSpeL-Check " + typ);
        }
    }

    /**
     * Je Viertelstunde eine Zeile wie der Optimierer ({@code persistence.messlatte_rows}): gegenüber „nur laden“ kauft
     * das Haus abends die zurückgegebene Menge weniger, lädt sie nachts ÷ 0,9 nach (Wirkungsgrad hin und zurück) und
     * zahlt 2 ct je zurückgegebener kWh Akku-Verschleiß; Preise = Börse + Haushaltsbestandteile.
     */
    private void messlatte(Kunde k, UUID s, UUID wallbox, Reihe r, Instant von, Instant bis) {
        List<Object[]> zeilen = new ArrayList<>();
        UUID plan = UUID.nameUUIDFromBytes(("messlatte-" + s).getBytes(StandardCharsets.UTF_8));
        Instant beginn = AB.atStartOfDay(BERLIN).toInstant();
        double[] anteil = new double[VIERTELSTUNDEN];
        for (int tag = 0; tag < 4; tag++) {
            double ab = 0;
            double nacht = 0;
            for (int q = tag * 96; q < tag * 96 + 96; q++) {
                ab += r.entladen()[q];
                nacht += (q % 96) < 22 ? r.laden()[q] : 0;
            }
            for (int q = tag * 96; q < tag * 96 + 96; q++) {
                anteil[q] = (q % 96) < 22 && nacht > 0 ? Math.min(1, ab / 0.9 / nacht) * r.laden()[q] : 0;
            }
        }
        for (Instant t = von; t.isBefore(bis); t = t.plus(Duration.ofMinutes(15))) {
            int q = (int) (Duration.between(beginn, t).toMinutes() / 15) % VIERTELSTUNDEN;
            double preis = spotCt(t) / 100 + 0.1311;
            double ab = r.entladen()[q];
            double nachladen = anteil[q];
            zeilen.add(new Object[] {wallbox, Timestamp.from(t), k.tenant(), s, plan, Timestamp.from(t),
                    round(ab * preis, 5), round(ab, 4), round(-nachladen * preis, 5), round(nachladen, 4), 0.0, 0.0,
                    round(-ab * 0.02, 5), round(ab, 4)});
        }
        int[] n = root.batchUpdate("INSERT INTO ladepunkt_messlatte (komponente_id, zeit, tenant_id, site_id, plan_id, "
                + "generated_at, weniger_gekauft_eur, weniger_gekauft_kwh, mehr_geladen_eur, mehr_geladen_kwh, "
                + "ins_netz_verkauft_eur, ins_netz_verkauft_kwh, akku_verschleiss_eur, rueckgespeist_kwh) VALUES (?, ?, ?, "
                + "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (komponente_id, zeit) DO NOTHING", zeilen);
        int neu = 0;
        for (int i : n) {
            neu += Math.max(i, 0);
        }
        if (neu > 0) {
            geschrieben.add("Messlatte „nur laden“ " + neu + " Viertelstunden");
        }
    }

    /**
     * Der Herzschlag der Wallbox (sonst {@code ChargerStatusListener} über MQTT): angesteckt seit 17:42, Ladestand 62 %
     * mit eigener Uhr „jetzt“ — {@code golf} = ein Auto, das keinen bidirektionalen Modus anfordert.
     */
    private void ladestand(Kunde k, UUID s, UUID box, UUID wallbox, String auto, boolean nurWennLeer) {
        if (nurWennLeer) {
            Integer n = root.queryForObject("SELECT count(*) FROM device_charge_connector WHERE device_id = ?", Integer.class,
                    box);
            if (n > 0) {
                return;
            }
        }
        boolean golf = "golf".equals(auto);
        Instant jetzt = Instant.now();
        Instant seit = ZonedDateTime.now(BERLIN).with(LocalTime.of(17, 42)).toInstant();
        if (seit.isAfter(jetzt)) {
            seit = seit.minus(Duration.ofDays(1));
        }
        var stecker = new DeviceChargerStatusRepository.ConnectorRow(1, "SuspendedEV", false, 0.0, null, null, null, 0.0,
                null, golf ? 48.0 : 62.0, null, null, null, seit, 0.0, jetzt, false, null, jetzt, !golf);
        var saeule = new DeviceChargerStatusRepository.ChargePointRow("WALLBOX-GARAGE", "Wallbox Garage", false, true,
                "Demo", golf ? "V2H 11 (Golf angesteckt)" : "V2H 11", "1.0", true, null, jetzt, "haus", List.of(stecker));
        var budget = new DeviceChargerStatusRepository.BudgetRow(true, true, null, 32.0, 10.0, 1.4, 11.0, 0.0, 0.0, 0.0,
                1.2, 1.2, "grid", null, false, 32.0, 4.2, null, true, null, null, 1, "sonne_zuerst", "car", false, 0.0, null, null,
                false, null, null, null, null, null,
                null); // storageRelease (main, Sonne + Speicher): die MiSpeL-Demo fährt keine Freigabe
        TenantContext.set(k.tenant());
        try {
            chargers.replaceForDevice(box, k.tenant(), s, jetzt, budget, List.of(saeule));
        } finally {
            TenantContext.clear();
        }
        root.update("UPDATE device_charge_point SET entity_id = ? WHERE device_id = ? AND charge_point_id = 'WALLBOX-GARAGE'",
                wallbox, box);
        geschrieben.add("Wallbox Garage: Ladestand " + (golf ? "48 % (Golf)" : "62 % (Familienauto)"));
    }

    /**
     * Der Plan des Tages, wie der Optimierer ihn für ein Fahrzeug ablegt (MP-41c, {@code persistence_v2}): alle
     * Viertelstunden des Fensters als {@code setpoint_kw} mit {@code fahrzeug_rueckspeisen}, −kW wo zurückgespeist wird
     * (heute 18:00–21:30 ans Haus, ≈ 9 kWh), sonst 0. Nur, wenn heute noch kein Plan steht; die Zeilen vor dem Lauf,
     * damit ein abgebrochener Lauf keinen leeren Plan sichtbar macht.
     */
    private void planDesTages(Kunde k, UUID s, UUID wallbox) {
        ZonedDateTime heute = ZonedDateTime.now(BERLIN).toLocalDate().atStartOfDay(BERLIN);
        if (zahl("SELECT count(*) FROM site_plan_run WHERE site_id = ? AND generated_at >= ?", s,
                Timestamp.from(heute.toInstant())) > 0) {
            return;
        }
        Instant erstellt = heute.with(LocalTime.of(13, 0)).toInstant();
        if (erstellt.isAfter(Instant.now())) {
            erstellt = Instant.now().minusSeconds(Instant.now().getEpochSecond() % 900);
        }
        UUID plan = UUID.nameUUIDFromBytes(("plan-" + s + "-" + heute.toLocalDate()).getBytes(StandardCharsets.UTF_8));
        List<Object[]> slots = new ArrayList<>();
        ZonedDateTime von = ZonedDateTime.ofInstant(erstellt, BERLIN);
        double[] ab = {2.8, 2.8, 2.6, 2.6, 2.4, 2.4, 2.6, 2.6, 2.6, 2.4, 2.4, 2.2, 2.0, 2.0}; // 18:00–21:30, kW
        for (int i = 0; i < 96; i++) {
            ZonedDateTime t = von.plusMinutes(15L * i);
            int idx = (int) Duration.between(heute.with(LocalTime.of(18, 0)), t).toMinutes() / 15;
            boolean zurueck = t.toLocalDate().equals(heute.toLocalDate()) && !t.isBefore(heute.with(LocalTime.of(18, 0)))
                    && idx < ab.length;
            slots.add(new Object[] {Timestamp.from(t.toInstant()), k.tenant(), s, plan, Timestamp.from(erstellt),
                    wallbox.toString(), "setpoint_kw", zurueck ? -ab[idx] : 0.0, "fahrzeug_rueckspeisen"});
        }
        root.batchUpdate("INSERT INTO entity_plan_slot (time, tenant_id, site_id, plan_id, generated_at, entity_id, command, "
                + "target_value, reason_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", slots);
        root.update("INSERT INTO site_plan_run (plan_id, tenant_id, site_id, generated_at, horizon_slots, slot_minutes) "
                + "VALUES (?, ?, ?, ?, 96, 15)", plan, k.tenant(), s, Timestamp.from(erstellt));
        geschrieben.add("Plan des Tages " + heute.toLocalDate() + " (Zurückspeisen 18:00–21:30)");
    }

    // ------------------------------------------------------------------ Reihen 01.–04.10.2026

    /**
     * Ein Gewerbe mit Speicher. {@code netzladen}: lädt 06:00–07:00 vor dem Preistal der Demo-Preise aus dem Netz (Platz
     * für den Sonnenstrom des Tages bleibt) und gibt
     * 18:00–22:00 zur Abendspitze ab; {@code insNetz}: mit voller Leistung über den eigenen Verbrauch hinaus ins Netz
     * (Abgrenzungsoption: rot wird saldiert), sonst nur in den eigenen Verbrauch (Händler-Modus: keine Saldierung).
     */
    private static Reihe gewerbeReihe(double kwp, double kwh, double kw, double lastKwh, boolean netzladen,
            boolean insNetz) {
        Reihe r = leer();
        double soc = 0.3 * kwh;
        for (int i = 0; i < VIERTELSTUNDEN; i++) {
            double h = (i % 96) / 4.0;
            double pv = sonne(i) * kwp * 0.25 * tagesfaktor(i);
            double last = lastKwh * (h >= 6 && h < 19 ? 1.25 : 0.7);
            double laden = 0;
            double entladen = 0;
            double ueber = pv - last;
            if (ueber > 0) {
                laden = Math.min(Math.min(ueber, kw * 0.25), kwh - soc);
            } else if (netzladen && h >= 6 && h < 7) {
                laden = Math.min(kw * 0.25, kwh - soc);
            }
            if (laden <= 0 && ((netzladen && h >= 18 && h < 22) || (!netzladen && ueber < 0 && h >= 16))) {
                entladen = Math.min(Math.min(insNetz ? kw * 0.25 : Math.max(-ueber, 0), kw * 0.25), soc - 0.1 * kwh);
            }
            laden = Math.max(laden, 0);
            entladen = Math.max(entladen, 0);
            soc += laden * 0.95 - entladen / 0.95;
            double netz = last - pv + laden - entladen;
            r.pv()[i] = pv;
            r.last()[i] = last;
            r.laden()[i] = laden;
            r.entladen()[i] = entladen;
            r.bezug()[i] = Math.max(netz, 0);
            r.abgabe()[i] = Math.max(-netz, 0);
        }
        return r;
    }

    /** Ein Haushalt (≈ 12,5 kWh am Tag) mit Speicher, der nur Sonnenstrom lädt. */
    private static Reihe haushaltReihe(double kwp, double kwh, double kw, int variante) {
        Reihe r = leer();
        double soc = 0.2 * kwh;
        for (int i = 0; i < VIERTELSTUNDEN; i++) {
            double h = (i % 96) / 4.0;
            double pv = sonne(i) * kwp * 0.25 * tagesfaktor(i + 96 * variante);
            double last = 0.08 + (h >= 6 && h < 8 ? 0.12 : 0) + (h >= 11.5 && h < 13 ? 0.1 : 0)
                    + (h >= 17 && h < 22 ? 0.2 : 0);
            double ueber = pv - last;
            double laden = ueber > 0 ? Math.min(Math.min(ueber, kw * 0.25), kwh - soc) : 0;
            double entladen = ueber < 0 ? Math.min(Math.min(-ueber, kw * 0.25), soc - 0.05 * kwh) : 0;
            laden = Math.max(laden, 0);
            entladen = Math.max(entladen, 0);
            soc += laden * 0.95 - entladen / 0.95;
            double netz = last - pv + laden - entladen;
            r.pv()[i] = pv;
            r.last()[i] = last;
            r.laden()[i] = laden;
            r.entladen()[i] = entladen;
            r.bezug()[i] = Math.max(netz, 0);
            r.abgabe()[i] = Math.max(-netz, 0);
        }
        return r;
    }

    /**
     * Haus Albers ohne stationären Speicher: das Familienauto (64 kWh) ist Mo–Fr ab 17:45 bis 07:15 angesteckt, am
     * Wochenende ganztags außer Samstag 10–14 Uhr. Es lädt nachts 01:00–05:15 mit 3,7 kW und am Wochenende mit
     * Sonnenstrom, und gibt 18:00–21:30 ans Haus ab, nie mehr als das Haus braucht (Zurückspeisen „Ins Haus“).
     */
    private static Reihe albersReihe() {
        Reihe r = leer();
        for (int i = 0; i < VIERTELSTUNDEN; i++) {
            double h = (i % 96) / 4.0;
            DayOfWeek tag = AB.plusDays(i / 96).getDayOfWeek();
            boolean wochenende = tag == DayOfWeek.SATURDAY || tag == DayOfWeek.SUNDAY;
            boolean angesteckt = wochenende ? !(tag == DayOfWeek.SATURDAY && h >= 10 && h < 14) : (h >= 17.75 || h < 7.25);
            double pv = sonne(i) * 9.9 * 0.25 * tagesfaktor(i + 192);
            double last = 0.09 + (h >= 6 && h < 8 ? 0.12 : 0) + (h >= 17 && h < 22 ? 0.22 : 0);
            double laden = 0;
            double entladen = 0;
            if (angesteckt && h >= 1 && h < 5.25) {
                laden = 3.7 * 0.25;
            } else if (angesteckt && wochenende && pv - last > 0.2) {
                laden = Math.min(pv - last, 11 * 0.25);
            } else if (angesteckt && h >= 18 && h < 21.5) {
                entladen = Math.min(Math.max(last - pv, 0), 2.8 * 0.25);
            }
            double netz = last - pv + laden - entladen;
            r.pv()[i] = pv;
            r.last()[i] = last;
            r.laden()[i] = laden;
            r.entladen()[i] = entladen;
            r.bezug()[i] = Math.max(netz, 0);
            r.abgabe()[i] = Math.max(-netz, 0);
        }
        return r;
    }

    private static Reihe leer() {
        return new Reihe(new double[VIERTELSTUNDEN], new double[VIERTELSTUNDEN], new double[VIERTELSTUNDEN],
                new double[VIERTELSTUNDEN], new double[VIERTELSTUNDEN], new double[VIERTELSTUNDEN]);
    }

    /** Sonnenbogen Anfang Oktober (Berlin): Aufgang ≈ 07:20, Untergang ≈ 18:50, Mitte der Viertelstunde. */
    private static double sonne(int i) {
        double h = (i % 96) / 4.0 + 0.125;
        return h <= 7.33 || h >= 18.83 ? 0 : Math.pow(Math.sin(Math.PI * (h - 7.33) / 11.5), 1.3) * 0.62;
    }

    /** Bewölkung je Tag (fest, damit jeder Lauf dieselben Werte schreibt). */
    private static double tagesfaktor(int i) {
        double[] f = {0.85, 0.45, 0.95, 0.6, 0.75, 0.5, 0.9};
        return f[(i / 96) % f.length];
    }

    /** Ein Spot-Preis-Modell (ct/kWh) wie die Dev-Saat, nur für die Beträge der Messlatte. */
    private static double spotCt(Instant t) {
        ZonedDateTime z = t.atZone(BERLIN);
        double h = z.getHour() + z.getMinute() / 60.0;
        return 10 + 6 * Math.sin((h - 15) / 24.0 * 2 * Math.PI);
    }

    // ------------------------------------------------------------------ Dateien des Messstellenbetreibers

    /** CSV des Messstellenbetreibers ({@code MsbWerteCsv}), Beginn der Viertelstunde in Ortszeit. */
    private static String csv(String zp, double[] bezug, double[] abgabe, double faktor) {
        StringBuilder s = new StringBuilder("# Lastgang des Messstellenbetreibers (Demo), Beginn der Viertelstunde\n"
                + "zeitstempel;zaehlpunkt;richtung;kwh\n");
        DateTimeFormatter f = DateTimeFormatter.ISO_OFFSET_DATE_TIME;
        ZonedDateTime t = AB.atStartOfDay(BERLIN);
        for (int i = 0; i < VIERTELSTUNDEN; i++, t = t.plusMinutes(15)) {
            String ts = t.toOffsetDateTime().format(f);
            s.append(ts).append(';').append(zp).append(";bezug;")
                    .append(String.format(Locale.GERMANY, "%.3f", bezug[i] * faktor)).append('\n');
            s.append(ts).append(';').append(zp).append(";abgabe;")
                    .append(String.format(Locale.GERMANY, "%.3f", abgabe[i] * faktor)).append('\n');
        }
        return s.toString();
    }

    /** MSCONS 2.5 wie {@code MsbBeispiel}, Zeitpunkte in UTC: Laden = Bezug (1-1:1.29.0), Entladen = Abgabe (1-1:2.29.0). */
    private static String mscons(String zp, double[] bezug, double[] abgabe) {
        ZonedDateTime von = AB.atStartOfDay(BERLIN);
        ZonedDateTime bis = BIS.atStartOfDay(BERLIN);
        List<String> seg = new ArrayList<>();
        seg.add("UNH+1+MSCONS:D:04B:UN:2.5");
        seg.add("BGM+7+MSI" + von.toLocalDate().toString().replace("-", "") + "+9");
        seg.add("DTM+137:" + MsbBeispiel.zeit(bis.plusDays(1), false) + ":303");
        seg.add("RFF+Z13:13025");
        seg.add("NAD+MS+9900000000003::293");
        seg.add("CTA+IC+:Stadtwerke Demo Messstellenbetrieb");
        seg.add("COM+messwerte@msb.example:EM");
        seg.add("NAD+MR+9900000000010::293");
        seg.add("UNS+D");
        seg.add("NAD+DP");
        seg.add("LOC+172+" + zp);
        seg.add("DTM+163:" + MsbBeispiel.zeit(von, false) + ":303");
        seg.add("DTM+164:" + MsbBeispiel.zeit(bis, false) + ":303");
        seg.add("RFF+MG:1ESY1160000001");
        double[][] reihen = {bezug, abgabe};
        for (int n = 1; n <= 2; n++) {
            seg.add("LIN+" + n);
            seg.add("PIA+5+" + MsbBeispiel.obis(n == 1 ? "bezug" : "abgabe").replace(":", "?:") + ":SRW");
            ZonedDateTime t = von;
            for (int i = 0; i < VIERTELSTUNDEN; i++, t = t.plusMinutes(15)) {
                seg.add("QTY+220:" + String.format(Locale.ROOT, "%.3f", reihen[n - 1][i]));
                seg.add("DTM+163:" + MsbBeispiel.zeit(t, false) + ":303");
                seg.add("DTM+164:" + MsbBeispiel.zeit(t.plusMinutes(15), false) + ":303");
            }
        }
        seg.add("UNT+" + (seg.size() + 1) + "+1");
        StringBuilder s = new StringBuilder("UNA:+.? 'UNB+UNOC:3+9900000000003:500+9900000000010:500+")
                .append(MsbBeispiel.zeit(bis, false), 2, 8).append(':').append("0605+DEMO4711++TL'\n");
        seg.forEach(x -> s.append(x).append("'\n"));
        return s.append("UNZ+1+DEMO4711'\n").toString();
    }

    // ------------------------------------------------------------------ Hilfen

    private static Map<String, Object> posten(String art, long niedrig, long mittel, long hoch, String herkunft) {
        return m("art", art, "niedrig_eur", niedrig, "mittel_eur", mittel, "hoch_eur", hoch, "herkunft", herkunft);
    }

    private static Map<String, Object> basis(String angabe, Object wert, String einheit, String herkunft, String quelle) {
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("angabe", angabe);
        o.put("wert", wert);
        o.put("einheit", einheit);
        o.put("herkunft", herkunft);
        o.put("quelle", quelle);
        return o;
    }

    private int zahl(String sql, Object... args) {
        Integer n = root.queryForObject(sql, Integer.class, args);
        return n == null ? 0 : n;
    }

    private static double round(double v, int stellen) {
        return BigDecimal.valueOf(v).setScale(stellen, RoundingMode.HALF_UP).doubleValue();
    }

    private int status(Kunde k, String method, String path, Object body) throws Exception {
        var b = request(HttpMethod.valueOf(method), path).with(authentication(auth(k)))
                .contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        var r = mvc.perform(b).andReturn().getResponse();
        if (r.getStatus() >= 400) {
            throw new IllegalStateException(method + " " + path + " " + JSON.writeValueAsString(body) + " → " + r.getStatus()
                    + " " + r.getContentAsString(StandardCharsets.UTF_8));
        }
        return r.getStatus();
    }

    private JsonNode antwort(Kunde k, String method, String path, Object body) throws Exception {
        var b = request(HttpMethod.valueOf(method), path).with(authentication(auth(k)))
                .contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        var r = mvc.perform(b).andReturn().getResponse();
        if (r.getStatus() >= 400) {
            throw new IllegalStateException(method + " " + path + " → " + r.getStatus() + " "
                    + r.getContentAsString(StandardCharsets.UTF_8));
        }
        return JSON.readTree(r.getContentAsString(StandardCharsets.UTF_8));
    }

    /** Eine JSON-Abbildung, die {@code null}-Werte auslässt. */
    private static Map<String, Object> m(Object... kv) {
        Map<String, Object> o = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            if (kv[i + 1] != null) {
                o.put((String) kv[i], kv[i + 1]);
            }
        }
        return o;
    }

    /** Der Kundenadministrator des Bereichs mit dem Subject seines Kontos im lokalen Realm. */
    private static Authentication auth(Kunde k) {
        Jwt jwt = Jwt.withTokenValue("demo-mispel").header("alg", "none").subject(k.sub())
                .issuedAt(Instant.now()).expiresAt(Instant.now().plusSeconds(3600))
                .claim("tenant_id", k.tenant().toString()).claim("realm_access", Map.of("roles", List.of()))
                .claim("name", "Demo Kundenadministrator").claim("preferred_username", k.konto()).build();
        return new KeycloakRealmRoleConverter().convert(jwt);
    }

    /** Liest die Werte der Messstellen aus der Reihe der Saat — für den Jahreslauf der Pauschaloption (Haus Sommer). */
    private static final class ReihenLeser extends MispelZaehlerLeser {
        private final Map<String, double[]> werte;

        ReihenLeser(Map<String, double[]> werte) {
            super(null, null);
            this.werte = werte;
        }

        @Override
        public Map<Instant, Menge> lesen(String kennzeichen, Instant von, Instant bis) {
            Map<Instant, Menge> out = new LinkedHashMap<>();
            double[] w = werte.get(kennzeichen);
            Instant beginn = AB.atStartOfDay(BERLIN).toInstant();
            Instant ende = BIS.atStartOfDay(BERLIN).toInstant();
            for (Instant t = von.isBefore(beginn) ? beginn : von; t.isBefore(bis) && t.isBefore(ende);
                    t = t.plus(Duration.ofMinutes(15))) {
                int q = (int) (Duration.between(beginn, t).toMinutes() / 15);
                out.put(t, new Menge(BigDecimal.valueOf(w[q]).setScale(3, RoundingMode.HALF_UP), true));
            }
            return out;
        }
    }
}
