package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Date;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Abzug des Unternehmens, seine Kostenstellen und die Kennzahlen (UEMS AP-12 IP-6, Vertrag {@code bericht} 1.1) —
 * die Referenzfälle B3, B11 und B15 aus {@code bericht-vectors.json} gegen die Datenbank auf dem neuesten Stand.
 *
 * <p><b>Vorrichtung</b> (alles aus {@code uems-referenzunternehmen.json}): Werk Ahrenberg (ST-1) und Werk Lindach (ST-2,
 * seit 15.10.2026) mit Gebäuden und Bereichen; die Netzbezugs-Zähler MS-01 · MS-10 · MS-16 mit ihren Oktober-Mengen, MS-19
 * (Ort: das Unternehmen) = MS-01 + MS-10 + MS-16 und MS-20 (Prozess P-1, ohne Ort) mit gespeicherter Herkunft; die
 * Tageswerte, die die Kostenstelle 4200 = MS-12 + MS-18 + 30 % MS-07 im Oktober auf 14 470 kWh bringen; die Kostenstellen
 * mit der Teilung 9000 → 9010/9020 zum 01.01.2027; KZ-0001 … KZ-0004 mit gespeicherten Werten — Zahlen, wie AP-11 sie
 * speichert (10 Nachkommastellen). Den Stück-Nenner (BZ-6/BZ-7) setzt der Test direkt (AP-12 §8.3 Punkt 2). Ein fremder
 * Kundenbereich mit derselben Kostenstelle 4200, derselben MS-12 und derselben KZ-0003 liegt daneben.
 */
@Testcontainers(disabledWithoutDocker = true)
class BerichtAbzugUnternehmenTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");

    private static final UUID KB = UUID.fromString("93e99678-5bf3-55b4-9cb3-13e16fc4a25a");
    private static final UUID FREMD = UUID.fromString("5b0c7a6e-2f4d-4c1a-9e8b-3d2f1a0c9e77");
    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    private static final String KANAL = "energy_kwh";

    private static final LocalDate OKT_AB = LocalDate.parse("2026-10-01");
    private static final LocalDate OKT_BIS = LocalDate.parse("2026-10-31");
    private static final LocalDate LIN_AB = LocalDate.parse("2026-10-15");
    private static final Instant OKT_BEGINN = Instant.parse("2026-09-30T22:00:00Z");
    private static final Instant OKT_ENDE = Instant.parse("2026-10-31T23:00:00Z");
    private static final Instant OKT_ENDGUELTIG = Instant.parse("2026-11-07T23:00:00Z");
    private static final Instant MONATSLAUF = Instant.parse("2026-10-31T23:20:00Z");
    private static final Instant JAHR_BEGINN = Instant.parse("2025-12-31T23:00:00Z");
    private static final Instant JAHR_ENDE = Instant.parse("2026-12-31T23:00:00Z");
    private static final Instant JAHR_ENDGUELTIG = Instant.parse("2027-01-07T23:00:00Z");
    private static final Instant JAHRESLAUF = Instant.parse("2027-01-07T23:20:00Z");
    /** B3/B4: der Entwurf des Unternehmensberichts vom 10.11.2026 08:57 (MEZ). */
    private static final Instant DATENSTAND_OKTOBER = Instant.parse("2026-11-10T07:57:00Z");
    /** B3: K-2026-0007 ist freigegeben (12.11.2026), die Kaskade hat gerechnet. */
    private static final Instant KORREKTUR_GERECHNET = Instant.parse("2026-11-12T08:57:00Z");
    private static final Instant DATENSTAND_KORRIGIERT = Instant.parse("2026-11-12T09:00:00Z");
    /** B15: Freigabe am 12.01.2027 15:00 (MEZ). */
    private static final Instant DATENSTAND_JAHR = Instant.parse("2027-01-12T14:00:00Z");
    private static final Instant DATENSTAND_JANUAR = Instant.parse("2027-02-10T08:00:00Z");
    private static final String ANLASS = "K-2026-0007 (freigegeben 12.11.2026)";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static final Map<String, UUID> IDS = new LinkedHashMap<>();
    private static final Map<String, LocalDate> ORT_AB = new HashMap<>();
    private static final List<UUID> FREMDE = new ArrayList<>();
    private static JdbcTemplate root;
    private static DataSource app;
    private static DataSource admin;
    private static JsonNode vektoren;
    private static JsonNode referenz;
    private static BerichtAbzugBildung bildung;
    /** BR-2026-0002 Monatsbericht Unternehmen Oktober 2026 (B3). */
    private static UUID oktober;
    /** Jahresbericht Unternehmen 2026 (B11). */
    private static UUID jahr;
    /** Jahresbericht Werk Lindach 2026 (B15). */
    private static UUID lindach;
    /** Monatsbericht Unternehmen Januar 2027 (B11). */
    private static UUID januar;

    @BeforeAll
    static void aufbauen() throws Exception {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW))
                .load().migrate();
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        app = new TenantAwareDataSource(ds(APP_USER, APP_PW));
        admin = ds(ADMIN_USER, ADMIN_PW);
        vektoren = JSON.readTree(Files.readString(V2.resolve("bericht-vectors.json")));
        referenz = JSON.readTree(Files.readString(V2.resolve("uems-referenzunternehmen.json")));
        bildung = new BerichtAbzugBildung(new MeasurementCatalog(JSON), JSON,
                new BerichtRegelwerk("VoltPilot Test", Map.of("bericht", "1.1")));

        ahrenberg();
        fremderKundenbereich();
        oktober = bericht("BR-2026-0002", "monatsbericht_unternehmen", "unternehmen", IDS.get("U"), "monat", "2026-10");
        jahr = bericht("BR-2027-0001", "jahresbericht_unternehmen", "unternehmen", IDS.get("U"), "jahr", "2026");
        lindach = bericht("BR-2027-0002", "jahresbericht_standort", "standort", IDS.get("ST-2"), "jahr", "2026");
        januar = bericht("BR-2027-0003", "monatsbericht_unternehmen", "unternehmen", IDS.get("U"), "monat", "2027-01");
    }

    // =============================================================================== B3

    @Test
    void b3_derUnternehmensEntwurfNenntKostenstelle4200Mit14470_nachDerKorrekturMit14410() throws Exception {
        try (Connection con = root.getDataSource().getConnection()) {
            con.setAutoCommit(false);
            JdbcTemplate j = new JdbcTemplate(new SingleConnectionDataSource(con, true));
            try {
                BerichtAbzugBildung.Ergebnis vorher = bildung.bilden(con, oktober, DATENSTAND_OKTOBER, "anlegen");
                JsonNode k = kostenstelle(vorher.abzug(), "4200");
                assertThat(k.path("summe").path("menge").decimalValue()).as("B3: 4200 vorher").isEqualByComparingTo("14470");
                assertThat(k.path("name_zum_datenstand").asText()).isEqualTo("Montage");
                assertThat(quellen(k.path("gemessen").path("posten"))).containsExactly("MS-12", "MS-18");
                assertThat(posten(k.path("gemessen"), "MS-12").path("menge").decimalValue()).isEqualByComparingTo("6100");
                assertThat(saetze(posten(k.path("gemessen"), "MS-18"))).as("Verteilungs-Sätze zum Tag")
                        .containsExactly("2026-10-15…2026-10-31 100");
                JsonNode ms07 = posten(k.path("verteilt"), "MS-07");
                assertThat(ms07.path("menge").decimalValue()).isEqualByComparingTo("4770");
                assertThat(saetze(ms07)).containsExactly("2026-10-01…2026-10-31 30");
                assertThat(ms07.path("herkunft").path("satz").isObject()).as("Herkunft der verteilten Zahl").isTrue();
                // Q4 nach den Vektoren B3/B4 (firstmate 001): am Unternehmen nur Kennzahlen der Unternehmens-Ebene —
                // KZ-0001 und KZ-0002 haben Oktober-Werte und erscheinen trotzdem nicht unmittelbar.
                assertThat(quellen(vorher.abzug().path("kennzahlen"))).containsExactly("KZ-0003", "KZ-0004");
                assertThat(vierStellen(kennzahl(vorher.abzug(), "KZ-0003").path("wert"))).isEqualByComparingTo("0.2012");
                assertThat(entwurf(j)).isEqualTo(vorher.pruefsumme());

                korrigieren(j);
                BerichtAbzugBildung.Ergebnis nachher = bildung.bilden(con, oktober, DATENSTAND_KORRIGIERT, "kaskade");
                JsonNode k2 = kostenstelle(nachher.abzug(), "4200");
                assertThat(k2.path("summe").path("menge").decimalValue()).as("B3: 4200 nachher").isEqualByComparingTo("14410");
                JsonNode ms12 = posten(k2.path("gemessen"), "MS-12");
                assertThat(ms12.path("menge").decimalValue()).isEqualByComparingTo("6040");
                assertThat(ms12.path("version").asInt()).isEqualTo(2);
                JsonNode kz3 = kennzahl(nachher.abzug(), "KZ-0003");
                assertThat(vierStellen(kz3.path("wert"))).as("B3: KZ-0003 0.2012 → 0.2").isEqualByComparingTo("0.2");
                assertThat(kz3.path("version").asInt()).isEqualTo(2);
                assertThat(entwurf(j)).as("der Entwurf ist ersetzt").isEqualTo(nachher.pruefsumme())
                        .isNotEqualTo(vorher.pruefsumme());
                // Befund für IP-7: die Regel R1 (BerichtRegeln.abweichungen) vergleicht heute `werte` und `kennzahlen` —
                // B4 nennt am Unternehmen „2 Abweichungen (4200, KZ-0003)“; 4200 zählt erst, wenn R1 die Kostenstellen liest.
                assertThat(BerichtRegeln.abweichungen(vorher.abzug(), nachher.abzug()))
                        .extracting(BerichtRegeln.Abweichung::quelle).containsExactly("KZ-0003");
            } finally {
                con.rollback();
            }
        }
    }

    @Test
    void b3_dieQuellenDesUnternehmensEntwurfsSindDieDesVektors_bisAufBz1() throws Exception {
        BerichtAbzugBildung.Ergebnis e = alsAnwendung(KB, con -> bildung.zusammentragen(con, oktober, DATENSTAND_OKTOBER));
        Map<String, Set<String>> ist = new TreeMap<>();
        e.quellen().forEach(q -> ist.computeIfAbsent(q.bezug(), x -> new TreeSet<>()).add(q.kennzeichen()));
        Map<String, Set<String>> soll = vektorQuellen("B3", "BR-2026-0002");
        // Benannte Abweichung: BZ-1 (Nenner von KZ-0004) gruppiert B3 am Unternehmen mittelbar; B1 (BZ-4, BZ-6) und
        // BR-2026-0003 (BZ-7) gruppieren die Bezugsgrößen einer Kennzahl des Berichts unmittelbar — der Abzug folgt EINER Regel.
        assertThat(soll.get("mittelbar")).contains("BZ-1");
        soll.get("mittelbar").remove("BZ-1");
        soll.get("unmittelbar").add("BZ-1");
        assertThat(ist).isEqualTo(soll);
    }

    @Test
    void derUnternehmensAbzug_standortAbschnitteUnternehmensMessstellenZoneUndSchema() throws Exception {
        JsonNode abzug = alsVerwaltung(con -> bildung.zusammentragen(con, oktober, DATENSTAND_OKTOBER)).abzug();
        JsonNode kopf = abzug.path("kopf");
        assertThat(kopf.path("geltung").path("art").asText()).isEqualTo("unternehmen");
        assertThat(kopf.path("geltung").path("kennzeichen").asText()).isEqualTo("U");
        assertThat(kopf.path("geltung").path("name_zum_datenstand").asText()).isEqualTo("Kunststoffwerk Ahrenberg GmbH");
        assertThat(kopf.path("zeitraum").path("von").asText()).isEqualTo("2026-10-01T00:00:00+02:00");
        assertThat(kopf.path("zeitraum").path("zone").asText()).isEqualTo("Europe/Berlin");
        assertThat(quellen(abzug.path("werte"))).containsExactly("MS-01", "MS-10", "MS-16", "MS-19", "MS-20");
        assertThat(wert(abzug, "MS-19").path("ort_zum_datenstand").asText()).isEqualTo("U");
        assertThat(wert(abzug, "MS-20").path("ort_zum_datenstand").isNull()).as("Prozess-Messstelle ohne Ort").isTrue();
        assertThat(wert(abzug, "MS-19").path("formel").asText()).isEqualTo("MS-01 + MS-10 + MS-16");
        assertThat(abzug.path("zusammenfassung").path("netzbezug_kwh").decimalValue()).as("Netzbezug gesamt")
                .isEqualByComparingTo("174400");
        assertThat(abzug.path("zusammenfassung").has("einspeisung_kwh")).isFalse();
        assertThat(abzug.path("standorte")).hasSize(2);
        JsonNode st1 = abzug.path("standorte").get(0);
        assertThat(st1.path("kennzeichen").asText()).isEqualTo("ST-1");
        assertThat(st1.path("summen").path("netzbezug_kwh").decimalValue()).isEqualByComparingTo("165300");
        assertThat(texte(st1.path("messstellen"))).containsExactly("MS-01", "MS-10");
        JsonNode st2 = abzug.path("standorte").get(1);
        assertThat(st2.path("name_zum_datenstand").asText()).isEqualTo("Werk Lindach");
        assertThat(texte(st2.path("messstellen"))).containsExactly("MS-16");
        assertThat(quellen(abzug.path("kostenstellen"))).containsExactly("4100", "4200", "4300", "9000", "9100");
        assertThat(kostenstelle(abzug, "4300").path("summe").path("grund").asText()).as("keine Zuordnung, nie 0")
                .isEqualTo("keine_zuordnung");

        // Oktober und Lindach halten $defs/abzug 1.1 ganz. Jahr 2026 und Januar 2027 haben Messstellen ohne Zahl in der
        // Periode — Befund aus IP-5, nicht aus IP-6: ein Wert „keine Werte“ trägt weder Version noch berechnet_am, $defs/wert
        // verlangt beide. Als Ist-Zustand behauptet; alles, was IP-6 dazulegt (standorte, kostenstellen, kennzahlen), hält.
        for (UUID b : List.of(oktober, jahr, lindach, januar)) {
            Instant datenstand = b.equals(oktober) ? DATENSTAND_OKTOBER : b.equals(januar) ? DATENSTAND_JANUAR
                    : DATENSTAND_JAHR;
            BerichtAbzugBildung.Ergebnis e = alsVerwaltung(con -> bildung.zusammentragen(con, b, datenstand));
            List<String> verstoesse = UemsSchemaLaeufer.verstoesse(e.abzug(), schemaAbzug());
            if (b.equals(oktober) || b.equals(lindach)) {
                assertThat(verstoesse).as("$defs/abzug 1.1 " + e.kennung()).isEmpty();
            } else {
                assertThat(verstoesse).as("nur der benannte IP-5-Befund " + e.kennung()).isNotEmpty()
                        .allMatch(v -> v.matches("\\$\\.werte\\[\\d+\\]\\.(version|berechnet_am): Typ null passt nicht zu .*"));
            }
        }
    }

    // =============================================================================== B11

    @Test
    void b11_derJahresbericht2026ZeigtKostenstelle9000_derJanuar2027Erst9010Und9020() throws Exception {
        BerichtAbzugBildung.Ergebnis jahr2026 = alsVerwaltung(con -> bildung.zusammentragen(con, jahr, DATENSTAND_JAHR));
        assertThat(quellen(jahr2026.abzug().path("kostenstellen"))).as("B11: Berichte 2026 behalten 9000")
                .containsExactly("4100", "4200", "4300", "9000", "9100");
        JsonNode k9000 = kostenstelle(jahr2026.abzug(), "9000");
        assertThat(k9000.path("name_zum_datenstand").asText()).isEqualTo("Infrastruktur (Druckluft, Kühlung, PV)");
        assertThat(k9000.path("gueltig_bis").asText()).isEqualTo("2026-12-31");
        assertThat(k9000.path("summe").path("menge").isNumber()).as(k9000.toString()).isTrue();
        assertThat(k9000.path("summe").path("menge").decimalValue()).isEqualByComparingTo("1200");
        assertThat(jahr2026.quellen()).filteredOn(q -> "9000".equals(q.kennzeichen())).singleElement()
                .satisfies(q -> {
                    assertThat(q.art()).isEqualTo("kostenstelle");
                    assertThat(q.ersterTag()).isEqualTo(OKT_AB);
                    assertThat(q.letzterTag()).isEqualTo(LocalDate.parse("2026-12-31"));
                });

        BerichtAbzugBildung.Ergebnis januar2027 = alsVerwaltung(con -> bildung.zusammentragen(con, januar,
                DATENSTAND_JANUAR));
        assertThat(quellen(januar2027.abzug().path("kostenstellen"))).containsExactly("4100", "4200", "4300", "9010",
                "9020", "9100");
    }

    // =============================================================================== B15

    @Test
    void b15_derJahresberichtLindachNenntKz0002Mit05213_nurMitDenKennzahlTabellen() throws Exception {
        BerichtAbzugBildung.Ergebnis e = alsAnwendung(KB, con -> bildung.zusammentragen(con, lindach, DATENSTAND_JAHR));
        JsonNode abzug = e.abzug();
        assertThat(quellen(abzug.path("werte"))).containsExactly("MS-16", "MS-17", "MS-18");
        assertThat(wert(abzug, "MS-16").path("menge").decimalValue()).isEqualByComparingTo("51500");
        assertThat(wert(abzug, "MS-18").path("menge").decimalValue()).isEqualByComparingTo("19600");
        assertThat(abzug.path("kopf").path("vergleichszeitraeume").get(0).path("ergebnis").asText())
                .as("B15: Vorjahr — keine Werte, vor Bestehen").startsWith(ErgebnisZustand.KEINE_WERTE + " — ")
                .contains("15.10.2026");

        assertThat(quellen(abzug.path("kennzahlen"))).as("KZ-0002 gilt für G-5 im Werk Lindach").containsExactly("KZ-0002");
        JsonNode kz = abzug.path("kennzahlen").get(0);
        assertThat(vierStellen(kz.path("wert"))).as("B15: KZ-0002 Jahr = Σ MS-18 ÷ Σ BZ-7").isEqualByComparingTo("0.5213");
        assertThat(kz.path("einheit").asText()).isEqualTo("kWh/Stück");
        // K14: die Jahreszahl bildet AP-11 über die eigenen Monate und speichert keine Eingänge — der Nachweis nennt Zähler
        // und Nenner der Zeile an den Eingängen ihrer Definitions-Fassung, ohne Version.
        assertThat(kz.path("eingaenge")).hasSize(2);
        assertThat(kz.path("eingaenge").get(0).path("kennzeichen").asText()).isEqualTo("MS-18");
        assertThat(kz.path("eingaenge").get(0).path("wert").decimalValue()).isEqualByComparingTo("19600");
        assertThat(kz.path("eingaenge").get(0).has("version")).isFalse();
        assertThat(kz.path("eingaenge").get(1).path("art").asText()).isEqualTo("bezugsgroesse");
        assertThat(kz.path("eingaenge").get(1).path("kennzeichen").asText()).isEqualTo("BZ-7");
        assertThat(kz.path("eingaenge").get(1).path("wert").decimalValue()).isEqualByComparingTo("37600");

        // „nur mit den Kennzahlen“: ohne ihre Tabellen fehlt KZ-0002 — und der Abzug entsteht trotzdem.
        try (Connection con = root.getDataSource().getConnection()) {
            con.setAutoCommit(false);
            try (Statement st = con.createStatement()) {
                st.execute("ALTER TABLE kennzahl_wert RENAME TO kennzahl_wert_nicht_da");
                BerichtAbzugBildung.Ergebnis ohne = bildung.zusammentragen(con, lindach, DATENSTAND_JAHR);
                assertThat(ohne.abzug().path("kennzahlen")).isEmpty();
                assertThat(quellen(ohne.abzug().path("werte"))).containsExactly("MS-16", "MS-17", "MS-18");
            } finally {
                con.rollback();
            }
        }
    }

    // =============================================================================== Q4, Zaun

    @Test
    void ohneJedeAbwahlZeileSindAlleKennzahlenGewaehlt_eineAbwahlNimmtGenauDieseHeraus() throws Exception {
        assertThat(root.queryForObject("SELECT count(*) FROM bericht_kennzahl_abwahl", Long.class)).isZero();
        TenantContext.set(KB);
        try (Connection con = app.getConnection()) {
            con.setAutoCommit(false);
            try {
                assertThat(quellen(bildung.zusammentragen(con, oktober, DATENSTAND_OKTOBER).abzug().path("kennzahlen")))
                        .containsExactly("KZ-0003", "KZ-0004");
                try (PreparedStatement ps = con.prepareStatement("INSERT INTO bericht_kennzahl_abwahl (tenant_id, "
                        + "bericht_id, kennzahl_id, abgewaehlt_von_sub, abgewaehlt_von_name) "
                        + "VALUES (?, ?, ?, 'sub-jw', 'Jonas Wendlinger')")) {
                    ps.setObject(1, KB);
                    ps.setObject(2, oktober);
                    ps.setObject(3, IDS.get("KZ-0004"));
                    ps.executeUpdate();
                }
                BerichtAbzugBildung.Ergebnis ohne = bildung.zusammentragen(con, oktober, DATENSTAND_OKTOBER);
                assertThat(quellen(ohne.abzug().path("kennzahlen"))).containsExactly("KZ-0003");
                assertThat(ohne.quellen()).extracting(BerichtAbzugBildung.Quelle::kennzeichen)
                        .doesNotContain("KZ-0004", "BZ-1");
                assertThat(quellen(bildung.zusammentragen(con, jahr, DATENSTAND_JAHR).abzug().path("kostenstellen")))
                        .as("die Abwahl ist ein Merkmal DIESES Berichts").isNotEmpty();
            } finally {
                con.rollback();
            }
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void einFremderKundenbereichMischtSichNieEin_auchNichtAnDerVerwaltungsrolleOhneRls() throws Exception {
        String anwendung = alsAnwendung(KB, con -> bildung.zusammentragen(con, oktober, DATENSTAND_OKTOBER)).text();
        BerichtAbzugBildung.Ergebnis verwaltung = alsVerwaltung(con -> bildung.zusammentragen(con, oktober,
                DATENSTAND_OKTOBER));
        assertThat(verwaltung.text()).isEqualTo(anwendung);
        assertThat(quellen(kostenstelle(verwaltung.abzug(), "4200").path("gemessen").path("posten")))
                .containsExactly("MS-12", "MS-18");
        assertThat(verwaltung.quellen()).extracting(BerichtAbzugBildung.Quelle::objekt)
                .doesNotContainAnyElementsOf(FREMDE);
    }

    // =============================================================================== Vorrichtung

    private static void ahrenberg() throws Exception {
        root.update("INSERT INTO tenant (id, name) VALUES (?, ?)", KB, "Kunststoffwerk Ahrenberg GmbH");
        JsonNode u = referenz.path("unternehmen");
        IDS.put("U", uuid("INSERT INTO unternehmen (tenant_id, name, zeitzone, sitz_strasse, sitz_ort) "
                + "VALUES (?, ?, 'Europe/Berlin', ?, ?) RETURNING id", KB, u.path("name").asText(),
                u.path("sitz").path("strasse").asText(), u.path("sitz").path("ort").asText()));
        standort("ST-1", OKT_AB, LocalDate.parse("2024-03-12"), "AN-1", "AN-2");
        standort("ST-2", LIN_AB, LIN_AB, "AN-3");
        for (JsonNode b : referenz.path("bereiche")) {
            String eltern = b.path("eltern").asText();
            if (IDS.containsKey(eltern)) {
                ort("bereich", b, null, IDS.get(eltern), ORT_AB.get(eltern));
            }
        }
        for (String kz : List.of("MS-01", "MS-02", "MS-06", "MS-07", "MS-10", "MS-11", "MS-12", "MS-16", "MS-17", "MS-18",
                "MS-19", "MS-20")) {
            messstelle(eintrag("messstellen", kz));
        }
        for (String kz : List.of("MS-01", "MS-02", "MS-07", "MS-10", "MS-12", "MS-16", "MS-17", "MS-18")) {
            quelle(kz);
        }
        monat("MS-01", 128400);
        monat("MS-10", 36900);
        monat("MS-16", 9100);
        jahr("MS-16", 51500);
        jahr("MS-17", 24800);
        jahr("MS-18", 19600);
        berechnet("MS-19", 174400, new Object[] {"MS-01", 128400L, "1"}, new Object[] {"MS-10", 36900L, "1"},
                new Object[] {"MS-16", 9100L, "1"});
        berechnet("MS-20", 88630, new Object[] {"MS-06", 55100L, "1"}, new Object[] {"MS-07", 15900L, "0.7"},
                new Object[] {"MS-11", 22400L, "1"});
        // Die Tage der Kostenstelle 4200 im Oktober: MS-12 6 100 · MS-18 3 600 (ab 15.10.) · MS-07 15 900 (30 % = 4 770).
        for (LocalDate d = OKT_AB; !d.isAfter(OKT_BIS); d = d.plusDays(1)) {
            boolean letzter = d.equals(OKT_BIS);
            tag("MS-07", d, letzter ? 600 : 510);
            tag("MS-12", d, letzter ? 220 : 196);
            if (!d.isBefore(LIN_AB)) {
                tag("MS-18", d, letzter ? 224 : 211);
            }
        }
        // Die Kostenstelle 9000 im Jahr 2026 — Einspeisung Halle 1 ab November (nicht im Oktober, B3 zitiert sie nicht),
        // jeder verteilte Tag mit Wert (sonst ist der Posten unvollständig und zählt in keine Summe): 2 × 10 + 59 × 20 = 1 200.
        for (LocalDate d = LocalDate.parse("2026-11-01"); !d.isAfter(LocalDate.parse("2026-12-31")); d = d.plusDays(1)) {
            tag("MS-02", d, d.getDayOfMonth() == 1 ? 10 : 20);
        }

        IDS.put("P-1", uuid("INSERT INTO prozess (tenant_id, unternehmen_id, kennzeichen, name, gueltig_ab, created_by) "
                + "VALUES (?, ?, 'P-1', ?, ?, 'test') RETURNING id", KB, IDS.get("U"),
                eintrag("prozesse", "P-1").path("name").asText(), Date.valueOf(OKT_AB)));
        root.update("INSERT INTO messstelle_prozess (tenant_id, messstelle_id, prozess_id, gueltig_ab, created_by) "
                + "VALUES (?, ?, ?, ?, 'test')", KB, IDS.get("MS-20"), IDS.get("P-1"), Date.valueOf(OKT_AB));
        for (JsonNode k : referenz.path("kostenstellen")) {
            IDS.put(k.path("kennzeichen").asText(), uuid("INSERT INTO kostenstelle (tenant_id, unternehmen_id, kennzeichen, "
                    + "name, gueltig_ab, gueltig_bis, created_by) VALUES (?, ?, ?, ?, ?, ?, 'test') RETURNING id", KB,
                    IDS.get("U"), k.path("kennzeichen").asText(), k.path("name").asText(),
                    LocalDate.parse(k.path("gueltig_ab").asText()),
                    k.path("gueltig_bis").isNull() ? null : LocalDate.parse(k.path("gueltig_bis").asText())));
        }
        verteilung("MS-06", OKT_AB, null, "4100", 100);
        verteilung("MS-11", OKT_AB, null, "4100", 100);
        verteilung("MS-20", OKT_AB, null, "4100", 100);
        verteilung("MS-07", OKT_AB, null, "4100", 70, "4200", 30);
        verteilung("MS-12", OKT_AB, null, "4200", 100);
        verteilung("MS-18", LIN_AB, null, "4200", 100);
        verteilung("MS-02", LocalDate.parse("2026-11-01"), LocalDate.parse("2026-12-31"), "9000", 100);

        kennzahlen();
    }

    private static void kennzahlen() {
        bezugsgroesse("BZ-1", "prozess", "prozess_id", IDS.get("P-1"));
        bezugsgroesse("BZ-6", "gebaeude", "ort_id", IDS.get("G-2"));
        bezugsgroesse("BZ-7", "gebaeude", "ort_id", IDS.get("G-5"));
        kennzahl("KZ-0001", "quotient", "gebaeude", "ort_id", IDS.get("G-2"));
        kennzahl("KZ-0002", "quotient", "gebaeude", "ort_id", IDS.get("G-5"));
        kennzahl("KZ-0003", "zusammenfassung", "unternehmen", "unternehmen_id", IDS.get("U"));
        kennzahl("KZ-0004", "quotient", "prozess", "prozess_id", IDS.get("P-1"));
        root.update("INSERT INTO kennzahl_eingang (tenant_id, kennzahl_id, fassung_id, rechenform, position, rolle, art, "
                + "messstelle_id) VALUES (?, ?, ?, 'quotient', 0, 'zaehler', 'messstelle', ?)", KB, IDS.get("KZ-0002"),
                IDS.get("F:KZ-0002"), IDS.get("MS-18"));
        root.update("INSERT INTO kennzahl_eingang (tenant_id, kennzahl_id, fassung_id, rechenform, position, rolle, art, "
                + "bezugsgroesse_id) VALUES (?, ?, ?, 'quotient', 1, 'nenner', 'bezugsgroesse', ?)", KB,
                IDS.get("KZ-0002"), IDS.get("F:KZ-0002"), IDS.get("BZ-7"));

        UUID w1 = kennzahlWert(root, "KZ-0001", "monat", OKT_AB, OKT_BIS, 1, "0.1487804878", "6100", "41000", MONATSLAUF,
                null);
        eingang(root, w1, "KZ-0001", 0, "zaehler", "messstelle", "MS-12", "6100", null, null, "kWh", 1, null);
        eingang(root, w1, "KZ-0001", 1, "nenner", "bezugsgroesse", "BZ-6", "41000", null, null, "Stück", null, 1);
        UUID w2 = kennzahlWert(root, "KZ-0002", "monat", OKT_AB, OKT_BIS, 1, "0.5", "3600", "7200", MONATSLAUF, null);
        eingang(root, w2, "KZ-0002", 0, "zaehler", "messstelle", "MS-18", "3600", null, null, "kWh", 1, null);
        eingang(root, w2, "KZ-0002", 1, "nenner", "bezugsgroesse", "BZ-7", "7200", null, null, "Stück", null, 1);
        UUID w3 = kennzahlWert(root, "KZ-0003", "monat", OKT_AB, OKT_BIS, 1, "0.2012448133", "9700", "48200",
                MONATSLAUF, null);
        eingang(root, w3, "KZ-0003", 0, "paar", "kennzahl", "KZ-0001", "0.1487804878", "6100", "41000", "kWh/Stück", 1,
                null);
        eingang(root, w3, "KZ-0003", 1, "paar", "kennzahl", "KZ-0002", "0.5", "3600", "7200", "kWh/Stück", 1, null);
        UUID w4 = kennzahlWert(root, "KZ-0004", "monat", OKT_AB, OKT_BIS, 1, "0.2837067862", "88630", "312400",
                MONATSLAUF, null);
        eingang(root, w4, "KZ-0004", 0, "zaehler", "messstelle", "MS-20", "88630", null, null, "kWh", 1, null);
        eingang(root, w4, "KZ-0004", 1, "nenner", "bezugsgroesse", "BZ-1", "312400", null, null, "kg", null, 1);
        // K14: das Jahr als Σ ÷ Σ über die eigenen Monate — AP-11 IP-6 speichert dazu keine Eingänge.
        kennzahlWert(root, "KZ-0002", "jahr", LocalDate.parse("2026-01-01"), LocalDate.parse("2026-12-31"), 1,
                "0.5212765957", "19600", "37600", JAHRESLAUF, null);
    }

    /** B3: K-2026-0007 macht aus MS-12 am 18.10. 196 → 136 kWh (Oktober 6 040); die Kaskade zieht KZ-0001 und KZ-0003 nach. */
    private static void korrigieren(JdbcTemplate j) throws Exception {
        LocalDate tag = LocalDate.parse("2026-10-18");
        j.update("INSERT INTO messreihe_periode_version (tenant_id, ebene, entity_id, messkanal, messstelle_id, "
                + "periode_beginn, periode_ende, tag, zeitzone, version, menge, menge_zustand, kennzeichen, "
                + "abdeckung_prozent, zustand, korrekturen, ersatzwerte, anlass_kennung, anlass_fassung) "
                + "VALUES (?, 'tag', ?, ?, NULL, ?, ?, ?, 'Europe/Berlin', 2, 136, 'vollständig', ?::jsonb, 100, "
                + "'endgueltig', ARRAY['K-2026-0007'], ARRAY[]::text[], 'K-2026-0007', 2)", KB, IDS.get("K:MS-12"), KANAL,
                ts(beginn(tag)), ts(beginn(tag.plusDays(1))), Date.valueOf(tag),
                JSON.writeValueAsString(List.of(ErgebnisZustand.korrigiert(2))));
        UUID w1 = kennzahlWert(j, "KZ-0001", "monat", OKT_AB, OKT_BIS, 2, "0.1473170732", "6040", "41000",
                KORREKTUR_GERECHNET, ANLASS);
        eingang(j, w1, "KZ-0001", 0, "zaehler", "messstelle", "MS-12", "6040", null, null, "kWh", 2, null);
        eingang(j, w1, "KZ-0001", 1, "nenner", "bezugsgroesse", "BZ-6", "41000", null, null, "Stück", null, 1);
        UUID w3 = kennzahlWert(j, "KZ-0003", "monat", OKT_AB, OKT_BIS, 2, "0.2", "9640", "48200", KORREKTUR_GERECHNET,
                ANLASS);
        eingang(j, w3, "KZ-0003", 0, "paar", "kennzahl", "KZ-0001", "0.1473170732", "6040", "41000", "kWh/Stück", 2, null);
        eingang(j, w3, "KZ-0003", 1, "paar", "kennzahl", "KZ-0002", "0.5", "3600", "7200", "kWh/Stück", 1, null);
    }

    private static void standort(String kz, LocalDate orteAb, LocalDate anlagenAb, String... anlagen) {
        UUID st = uuid("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", KB, IDS.get("U"),
                eintrag("standorte", kz).path("name").asText(), kz);
        IDS.put(kz, st);
        for (String anlage : anlagen) {
            UUID site = uuid("INSERT INTO site (tenant_id, name) VALUES (?, ?) RETURNING id", KB, anlage);
            root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?, ?, ?, ?)",
                    KB, site, st, Date.valueOf(anlagenAb));
            IDS.put(anlage, site);
            IDS.put("BOX:" + anlage, uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                    + "VALUES (?, ?, ?, 'claimed') RETURNING id", KB, site, "VP-BOX-UNTERNEHMEN-" + anlage));
        }
        for (JsonNode g : referenz.path("gebaeude")) {
            if (kz.equals(g.path("standort").asText())) {
                ort("gebaeude", g, st, null, orteAb);
            }
        }
    }

    private static void ort(String art, JsonNode o, UUID elternStandort, UUID elternOrt, LocalDate ab) {
        UUID id = uuid("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, ?, ?, ?, 'aktiv') "
                + "RETURNING id", KB, art, o.path("name").asText(), o.path("kennzeichen").asText());
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, eltern_ort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, ?, ?)", KB, id, elternStandort, elternOrt, Date.valueOf(ab));
        IDS.put(o.path("kennzeichen").asText(), id);
        ORT_AB.put(o.path("kennzeichen").asText(), ab);
    }

    private static void messstelle(JsonNode m) {
        String kz = m.path("kennzeichen").asText();
        JsonNode h = m.path("hauptgroesse");
        UUID id = uuid("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, einheit, "
                + "wertart) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id", KB, kz, m.path("name").asText(),
                m.path("art").asText(), m.path("medium").asText(), h.path("groesse").asText(),
                h.path("richtung").asText(), h.path("einheit").asText(), h.path("wertart").asText());
        IDS.put(kz, id);
        JsonNode stellung = m.path("elektrische_stellung").path(0);
        LocalDate ab = "AN-3".equals(stellung.path("anlage").asText()) ? LIN_AB : OKT_AB;
        String ortArt = m.path("ort").path("art").asText();
        String ort = m.path("ort").path("kennzeichen").asText();
        switch (ortArt) {
            case "standort" -> root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, standort_id, gueltig_ab) "
                    + "VALUES (?, ?, ?, ?)", KB, id, IDS.get(ort), Date.valueOf(ab));
            case "gebaeude", "bereich" -> root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, "
                    + "gueltig_ab) VALUES (?, ?, ?, ?)", KB, id, IDS.get(ort), Date.valueOf(ab));
            case "unternehmen" -> root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, unternehmen_id, "
                    + "gueltig_ab) VALUES (?, ?, ?, ?)", KB, id, IDS.get("U"), Date.valueOf(ab));
            default -> {
                // „keiner“ — MS-20 ist eine Prozess-Messstelle ohne Ort.
            }
        }
        if (Set.of("Hauptzähler", "Erzeuger", "Speicher").contains(stellung.path("stellung").asText())) {
            root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, gueltig_ab) "
                    + "VALUES (?, ?, ?, ?, ?)", KB, id, IDS.get(stellung.path("anlage").asText()),
                    stellung.path("stellung").asText(), Date.valueOf(stellung.path("gueltig_ab").asText()));
        }
    }

    private static void quelle(String kz) {
        JsonNode m = eintrag("messstellen", kz);
        String anlage = m.path("elektrische_stellung").path(0).path("anlage").asText();
        UUID entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, "
                + "communication, connection_json, created_at) VALUES (?, ?, 'grid-meter', ?, 'grid-meter', ?, "
                + "'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, '2024-03-12T00:00:00Z') RETURNING id",
                KB, IDS.get(anlage), "K " + kz, IDS.get("BOX:" + anlage));
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, 'energy_kwh', true, 60, 1, "
                + "'2024-03-12T00:00:00Z', '2026.09.11.1', 'test', 'pending_edge', 'live_power', 'fifteen_minute')",
                KB, IDS.get(anlage), IDS.get("BOX:" + anlage), entity);
        IDS.put("K:" + kz, entity);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, entity);
        JsonNode h = m.path("hauptgroesse");
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_sub, "
                + "actor_name, actor_art) VALUES (?, ?, ?, ?, ?, ?, ?, 'counter', 'zaehlerstand', 'fuehrend', "
                + "'2024-03-12T00:00:00Z', true, now(), 'sub', 'Probe', 'kunde')", KB, IDS.get(kz),
                h.path("groesse").asText(), h.path("richtung").asText(), entity, geraet, KANAL);
    }

    /** Oktober 2026, gezählt, vollständig und endgültig. */
    private static void monat(String kz, long menge) {
        root.update("INSERT INTO messreihe_periode (tag, art, tenant_id, entity_id, messkanal, zeitzone, "
                + "zeitzone_herkunft, beginn, ende, stunden, teile_erwartet, teile_vorhanden, teile_endgueltig, wertart, "
                + "menge, menge_zustand, kennzeichen, erhalten, erwartet, abdeckung_prozent, zustand, endgueltig_ab, "
                + "version, berechnet_am) VALUES (DATE '2026-10-01', 'monat', ?, ?, ?, 'Europe/Berlin', 'standort', ?, ?, "
                + "745, 31, 31, 31, 'counter', ?, 'vollständig', '[]'::jsonb, 44700, 44700, 100, 'endgueltig', ?, 1, ?)",
                KB, IDS.get("K:" + kz), KANAL, ts(OKT_BEGINN), ts(OKT_ENDE), BigDecimal.valueOf(menge), ts(OKT_ENDGUELTIG),
                ts(MONATSLAUF));
    }

    /** Das Jahr 2026, gezählt, vollständig und endgültig. */
    private static void jahr(String kz, long menge) {
        root.update("INSERT INTO messreihe_periode (tag, art, tenant_id, entity_id, messkanal, zeitzone, "
                + "zeitzone_herkunft, beginn, ende, stunden, teile_erwartet, teile_vorhanden, teile_endgueltig, wertart, "
                + "menge, menge_zustand, kennzeichen, erhalten, erwartet, abdeckung_prozent, zustand, endgueltig_ab, "
                + "version, berechnet_am) VALUES (DATE '2026-01-01', 'jahr', ?, ?, ?, 'Europe/Berlin', 'standort', ?, ?, "
                + "8760, 12, 12, 12, 'counter', ?, 'vollständig', '[]'::jsonb, 525600, 525600, 100, 'endgueltig', ?, 1, ?)",
                KB, IDS.get("K:" + kz), KANAL, ts(JAHR_BEGINN), ts(JAHR_ENDE), BigDecimal.valueOf(menge),
                ts(JAHR_ENDGUELTIG), ts(JAHRESLAUF));
    }

    /** Ein gemessener, vollständiger, endgültiger Tageswert der Reihe einer Messstelle. */
    private static void tag(String kz, LocalDate tag, long menge) {
        int stunden = TagRegeln.stunden(tag, ZONE);
        int slots = stunden * 4;
        int erwartet = stunden * 60;
        root.update("INSERT INTO messreihe_tag (tag, tenant_id, entity_id, messkanal, zeitzone, zeitzone_herkunft, "
                + "beginn, ende, stunden, slots_erwartet, slots_vorhanden, slots_endgueltig, wertart, erhalten, erwartet, "
                + "abdeckung_prozent, rolle, zustand, endgueltig_ab, version, menge, menge_zustand, kennzeichen) "
                + "VALUES (?, ?, ?, ?, 'Europe/Berlin', 'vorgabe', ?, ?, ?, ?, ?, ?, 'counter', ?, ?, 100, 'fuehrend', "
                + "'endgueltig', ?, 1, ?, 'vollständig', '[]'::jsonb)", tag, KB, IDS.get("K:" + kz), KANAL,
                ts(beginn(tag)), ts(beginn(tag.plusDays(1))), stunden, slots, slots, slots, erwartet, erwartet,
                ts(beginn(tag.plusDays(1)).plus(java.time.Duration.ofDays(7))), BigDecimal.valueOf(menge));
    }

    /** Eine berechnete Messstelle (gewichtete Summe) mit ihrem Oktober-Wert und seiner gespeicherten Herkunft. */
    private static void berechnet(String kz, long menge, Object[]... eingaenge) {
        UUID fassung = uuid("INSERT INTO messstelle_formel_fassung (tenant_id, messstelle_id, nummer, formel_typ, herkunft, "
                + "actor_sub, actor_name, actor_art) VALUES (?, ?, 1, 'gewichtete_summe', 'anlage', 'sub-test', 'Test', "
                + "'kunde') RETURNING id", KB, IDS.get(kz));
        root.update("INSERT INTO messreihe_periode (tag, art, tenant_id, messstelle_id, formel_fassung_id, formel_typ, "
                + "zeitzone, zeitzone_herkunft, beginn, ende, stunden, menge, menge_zustand, kennzeichen, abdeckung_prozent, "
                + "zustand, endgueltig_ab, version, berechnet_am) VALUES (DATE '2026-10-01', 'monat', ?, ?, ?, "
                + "'gewichtete_summe', 'Europe/Berlin', 'standort', ?, ?, 745, ?, 'vollständig', '[]'::jsonb, 100, "
                + "'endgueltig', ?, 1, ?)", KB, IDS.get(kz), fassung, ts(OKT_BEGINN), ts(OKT_ENDE),
                BigDecimal.valueOf(menge), ts(OKT_ENDGUELTIG), ts(MONATSLAUF));
        int position = 0;
        for (Object[] e : eingaenge) {
            root.update("INSERT INTO bilanzwert_eingang (periode_beginn, tenant_id, messstelle_id, periode, version, "
                    + "position, eingang_messstelle_id, eingang_kennzeichen, vorzeichen, faktor, menge, menge_zustand, "
                    + "fassung, abdeckung_prozent, eingang_version, kennzeichen, berechnet_am) VALUES (?, ?, ?, 'monat', 1, "
                    + "?, ?, ?, '+', ?, ?, 'vollständig', 'endgueltig', 100, 1, '[]'::jsonb, ?)", ts(OKT_BEGINN), KB,
                    IDS.get(kz), position++, IDS.get((String) e[0]), e[0], new BigDecimal((String) e[2]),
                    BigDecimal.valueOf((Long) e[1]), ts(MONATSLAUF));
        }
    }

    /** Ein Satz in EINER Anweisung — die 100 % prüft die Datenbank zur Commit-Zeit. */
    private static void verteilung(String kz, LocalDate ab, LocalDate bis, Object... zielUndProzent) {
        StringBuilder sql = new StringBuilder("INSERT INTO messstelle_verteilung (tenant_id, messstelle_id, kostenstelle_id, "
                + "anteil_prozent, gueltig_ab, gueltig_bis, created_by) VALUES ");
        List<Object> args = new ArrayList<>();
        for (int i = 0; i < zielUndProzent.length; i += 2) {
            sql.append(i == 0 ? "" : ", ").append("(?, ?, ?, ?::numeric, ?, ?, 'test')");
            args.addAll(Arrays.asList(KB, IDS.get(kz), IDS.get((String) zielUndProzent[i]),
                    zielUndProzent[i + 1].toString(), ab, bis));
        }
        root.update(sql.toString(), args.toArray());
    }

    private static void bezugsgroesse(String kz, String geltungArt, String spalte, UUID objekt) {
        JsonNode bz = eintrag("bezugsgroessen", kz);
        IDS.put(kz, uuid("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, "
                + "geltung_art, " + spalte + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id", KB, kz,
                bz.path("name").asText(), bz.path("wertart").asText(), bz.path("einheit_code").asText(),
                bz.path("periode_code").isNull() ? null : bz.path("periode_code").asText(), geltungArt, objekt));
    }

    private static void kennzahl(String kz, String rechenform, String geltungArt, String spalte, UUID objekt) {
        JsonNode k = eintrag("kennzahlen", kz);
        UUID id = uuid("INSERT INTO kennzahl (tenant_id, kennzeichen, name, rechenform, geltung_art, " + spalte
                + ", verantwortlich_sub, verantwortlich_name) VALUES (?, ?, ?, ?, ?, ?, 'sub-ik', 'Ines Kaltenbach') "
                + "RETURNING id", KB, kz, k.path("name").asText(), rechenform, geltungArt, objekt);
        IDS.put(kz, id);
        IDS.put("F:" + kz, uuid("INSERT INTO kennzahl_fassung (tenant_id, kennzahl_id, nummer, rechenform, herkunft, "
                + "actor_sub, actor_name, actor_rolle, actor_art, einheit) VALUES (?, ?, 1, ?, 'anlage', 'sub-ik', "
                + "'Ines Kaltenbach', 'energiemanager', 'kunde', ?) RETURNING id", KB, id, rechenform,
                k.path("einheit").asText()));
    }

    /** Ein Kennzahl-Wert, wie AP-11 ihn speichert (append-only; Version ab 2 mit Anlass). */
    private static UUID kennzahlWert(JdbcTemplate j, String kz, String art, LocalDate von, LocalDate bis, int version,
            String wert, String zaehler, String nenner, Instant am, String anlass) {
        return j.queryForObject("INSERT INTO kennzahl_wert (tenant_id, kennzahl_id, periode_art, periode_von, "
                + "periode_bis, zeitzone, version, wert, zaehler, nenner, menge_zustand, kennzeichen, abdeckung_prozent, "
                + "zustand, endgueltig_ab, definition_fassung_id, berechnet_am, anlass_art, anlass_kennung) VALUES (?, ?, "
                + "?, ?, ?, 'Europe/Berlin', ?, ?::numeric, ?::numeric, ?::numeric, 'vollständig', ?::jsonb, 100, "
                + "'endgueltig', ?, ?, ?, ?, ?) RETURNING id", UUID.class, KB, IDS.get(kz), art, Date.valueOf(von),
                Date.valueOf(bis), version, wert, zaehler, nenner,
                "[\"" + KennzahlRegeln.BERECHNET_KENNZAHL + "\"]", ts(am), IDS.get("F:" + kz), ts(am),
                anlass == null ? null : "eingang", anlass);
    }

    private static void eingang(JdbcTemplate j, UUID wert, String kz, int position, String rolle, String art,
            String objekt, String betrag, String zaehler, String nenner, String einheit, Integer version,
            Integer fassung) {
        String spalte = switch (art) {
            case "messstelle" -> "messstelle_id";
            case "bezugsgroesse" -> "bezugsgroesse_id";
            default -> "eingang_kennzahl_id";
        };
        j.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + spalte + ", wert, zaehler, nenner, einheit, menge_zustand, abdeckung_prozent, version, fassung, "
                + "kennzeichen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::numeric, ?::numeric, ?::numeric, ?, 'vollständig', 100, "
                + "?, ?, '[]'::jsonb)", KB, wert, IDS.get(kz), position, rolle, art, objekt, IDS.get(objekt), betrag,
                zaehler, nenner, einheit, version, fassung);
    }

    /** Ein zweiter Kundenbereich mit derselben Kostenstelle 4200, derselben MS-12 und derselben KZ-0003. */
    private static void fremderKundenbereich() {
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kundenbereich B')", FREMD);
        UUID un = uuid("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, 'Fremd GmbH', 'Europe/Berlin') "
                + "RETURNING id", FREMD);
        UUID kst = uuid("INSERT INTO kostenstelle (tenant_id, unternehmen_id, kennzeichen, name, gueltig_ab, created_by) "
                + "VALUES (?, ?, '4200', 'Fremde Montage', DATE '2026-10-01', 'test') RETURNING id", FREMD, un);
        UUID ms = uuid("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, einheit, "
                + "wertart) VALUES (?, 'MS-12', 'Fremde Montage', 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                + "'Zählerstand') RETURNING id", FREMD);
        root.update("INSERT INTO messstelle_verteilung (tenant_id, messstelle_id, kostenstelle_id, anteil_prozent, "
                + "gueltig_ab, created_by) VALUES (?, ?, ?, 100, DATE '2026-10-01', 'test')", FREMD, ms, kst);
        UUID kz = uuid("INSERT INTO kennzahl (tenant_id, kennzeichen, name, rechenform, geltung_art, unternehmen_id, "
                + "verantwortlich_name) VALUES (?, 'KZ-0003', 'Fremde Kennzahl', 'quotient', 'unternehmen', ?, 'Fremd') "
                + "RETURNING id", FREMD, un);
        UUID fassung = uuid("INSERT INTO kennzahl_fassung (tenant_id, kennzahl_id, nummer, rechenform, herkunft, "
                + "actor_sub, actor_name, actor_rolle, actor_art, einheit) VALUES (?, ?, 1, 'quotient', 'anlage', "
                + "'sub-fremd', 'Fremd', 'energiemanager', 'kunde', 'kWh/Stück') RETURNING id", FREMD, kz);
        UUID w = uuid("INSERT INTO kennzahl_wert (tenant_id, kennzahl_id, periode_art, periode_von, periode_bis, zeitzone, "
                + "version, wert, zaehler, nenner, menge_zustand, kennzeichen, abdeckung_prozent, zustand, endgueltig_ab, "
                + "definition_fassung_id, berechnet_am) VALUES (?, ?, 'monat', DATE '2026-10-01', DATE '2026-10-31', "
                + "'Europe/Berlin', 1, 9.99, 999, 100, 'vollständig', '[]'::jsonb, 100, 'endgueltig', ?, ?, ?) "
                + "RETURNING id", FREMD, kz, ts(OKT_ENDGUELTIG), fassung, ts(MONATSLAUF));
        root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + "messstelle_id, wert, einheit, menge_zustand, abdeckung_prozent, version, kennzeichen) "
                + "VALUES (?, ?, ?, 0, 'zaehler', 'messstelle', 'MS-12', ?, 999, 'kWh', 'vollständig', 100, 1, "
                + "'[]'::jsonb)", FREMD, w, kz, ms);
        FREMDE.addAll(List.of(kst, ms, kz));
    }

    private static UUID bericht(String kennung, String vorlage, String geltungArt, UUID geltung, String zeitraumArt,
            String schluessel) {
        return uuid("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, geltung_art, " + geltungArt
                + "_id, zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_name) VALUES (?, ?, ?, 1, ?, ?, ?, ?, "
                + "'Europe/Berlin', 'Jonas Wendlinger') RETURNING id", KB, kennung, vorlage, geltungArt, geltung,
                zeitraumArt, schluessel);
    }

    // =============================================================================== Hilfen

    /** Die Quellen eines Berichts in einem Fall der Vektoren, je Bezug (die Zwillinge entfalten die Gruppen genauso). */
    private static Map<String, Set<String>> vektorQuellen(String fall, String kennung) {
        for (JsonNode c : vektoren.path("cases")) {
            if (!fall.equals(c.path("id").asText())) {
                continue;
            }
            for (JsonNode p : c.path("pruefungen")) {
                Map<String, Set<String>> aus = new TreeMap<>();
                for (JsonNode q : p.path("eingang").path("quellen")) {
                    if (kennung.equals(q.path("bericht").asText()) && q.path("nr").isNull()) {
                        q.path("objekte").forEach(o -> aus.computeIfAbsent(q.path("bezug").asText(), x -> new TreeSet<>())
                                .add(o.asText()));
                    }
                }
                if (!aus.isEmpty()) {
                    return aus;
                }
            }
        }
        throw new IllegalStateException(fall + " nennt keine Quellen für " + kennung);
    }

    private static JsonNode eintrag(String liste, String kennzeichen) {
        for (JsonNode e : referenz.path(liste)) {
            if (kennzeichen.equals(e.path("kennzeichen").asText())) {
                return e;
            }
        }
        throw new IllegalStateException(liste + " " + kennzeichen);
    }

    private static JsonNode kostenstelle(JsonNode abzug, String kennzeichen) {
        return finde(abzug.path("kostenstellen"), kennzeichen);
    }

    private static JsonNode kennzahl(JsonNode abzug, String kennzeichen) {
        return finde(abzug.path("kennzahlen"), kennzeichen);
    }

    private static JsonNode wert(JsonNode abzug, String kennzeichen) {
        return finde(abzug.path("werte"), kennzeichen);
    }

    private static JsonNode posten(JsonNode block, String kennzeichen) {
        return finde(block.path("posten"), kennzeichen);
    }

    private static JsonNode finde(JsonNode liste, String quelle) {
        for (JsonNode e : liste) {
            if (quelle.equals(e.path("quelle").asText())) {
                return e;
            }
        }
        throw new AssertionError(quelle + " fehlt in " + liste);
    }

    private static List<String> quellen(JsonNode liste) {
        List<String> aus = new ArrayList<>();
        liste.forEach(e -> aus.add(e.path("quelle").asText()));
        return aus;
    }

    private static List<String> saetze(JsonNode posten) {
        List<String> aus = new ArrayList<>();
        posten.path("saetze").forEach(s -> aus.add(s.path("von").asText() + "…" + s.path("bis").asText() + " "
                + s.path("anteil_prozent").decimalValue().stripTrailingZeros().toPlainString()));
        return aus;
    }

    private static List<String> texte(JsonNode liste) {
        List<String> aus = new ArrayList<>();
        liste.forEach(x -> aus.add(x.asText()));
        return aus;
    }

    private static BigDecimal vierStellen(JsonNode n) {
        return n.decimalValue().setScale(4, RoundingMode.HALF_UP);
    }

    private static String entwurf(JdbcTemplate j) {
        return j.queryForObject("SELECT pruefsumme FROM bericht_entwurf WHERE tenant_id = ? AND bericht_id = ?",
                String.class, KB, oktober);
    }

    private static JsonNode schemaAbzug() throws Exception {
        JsonNode schema = JSON.readTree(Files.readString(V2.resolve("bericht.schema.json")));
        ObjectNode wurzel = JSON.createObjectNode();
        wurzel.set("$defs", schema.path("$defs"));
        wurzel.put("$ref", "#/$defs/abzug");
        return wurzel;
    }

    private static Instant beginn(LocalDate tag) {
        return tag.atStartOfDay(ZONE).toInstant();
    }

    private static Timestamp ts(Instant t) {
        return Timestamp.from(t);
    }

    private static <T> T alsAnwendung(UUID tenant, MitVerbindung<T> f) throws Exception {
        TenantContext.set(tenant);
        try (Connection con = app.getConnection()) {
            return inTransaktion(con, f);
        } finally {
            TenantContext.clear();
        }
    }

    private static <T> T alsVerwaltung(MitVerbindung<T> f) throws Exception {
        try (Connection con = admin.getConnection()) {
            return inTransaktion(con, f);
        }
    }

    private static <T> T inTransaktion(Connection con, MitVerbindung<T> f) throws Exception {
        con.setAutoCommit(false);
        try {
            T t = f.mit(con);
            con.commit();
            return t;
        } catch (Exception e) {
            con.rollback();
            throw e;
        }
    }

    private static UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }

    @FunctionalInterface
    interface MitVerbindung<T> {
        T mit(Connection con) throws Exception;
    }
}
