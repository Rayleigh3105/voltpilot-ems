package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.measurement.MeasurementHistoryService;
import com.voltpilot.api.measurement.SpeicherklasseHistorie;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.VerbrauchRegeln.LueckenZuwachs;
import com.voltpilot.api.uems.VerbrauchRegeln.Rohwert;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Zuwachs über eine Lücke — GEMESSEN, aber NICHT VERTEILBAR (UEMS AP-08 IP-6, E2 = A), über
 * die echte Strecke: Box-Ausfall → Lücken-Melder (Nutzlast an {@code data_gap}) → Viertelstunden →
 * Tage → Monat/Jahr → freier Zeitraum → Verlaufs-Marker.
 *
 * <p>Drei Regeln, einzeln bewiesen: (1) die Viertelstunden der Lücke bekommen nichts — keine Zeile,
 * nie 0; (2) der Zuwachs zählt genau einmal je Stufe, im Zeitraum, der die Lücke GANZ enthält — ein
 * Zeitraum, der sie nur anschneidet, bekommt ihn nicht; (3) er trägt sein vertragliches Kennzeichen.
 * Dazu: die Monatsgrenze (erst das Jahr enthält die Lücke), der 25-Stunden-Tag, wiederholbar,
 * abbruchsicher, endgültige Zeilen unberührt, Mandantenzaun und der Bestands-Fingerabdruck.
 *
 * <p>Die Reihen lesen einen ECHTEN Katalog-Messwert in kWh ({@link #KANAL}), damit der Melder die
 * Einheit aus dem Katalog nachschlagen kann — ein Testkanal ohne Katalogeintrag bekommt (richtig)
 * keinen Zuwachs.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsLueckenZuwachsTest {

    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");

    private static final String DIESE = "20260913170000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final UUID KB = UUID.fromString("4e0e0000-0000-0000-0000-000000000007");
    private static final UUID FREMD = UUID.fromString("4e0e0000-0000-0000-0000-000000000008");

    /** Ein Zählerstand in kWh aus dem ausgelieferten Katalog. */
    private static final String KANAL = "deye.hybrid_1p.meter.generator-energy";

    /** Box-Ausfall F8: der letzte Wert 14:00 MEZ, die Box schweigt, 17:31 MEZ kommt sie zurück. */
    private static final Instant T_OFFEN = Instant.parse("2026-11-03T13:10:00Z");
    private static final Instant T_ABBRUCH = Instant.parse("2026-11-03T16:40:00Z");
    private static final Instant T_ZU = Instant.parse("2026-11-03T17:45:00Z");
    private static final Instant T_NOCHMAL = Instant.parse("2026-11-03T23:01:30Z");
    private static final Instant T_VORLAEUFIG = Instant.parse("2026-11-05T12:00:00Z");
    private static final Instant T_SPAETER = Instant.parse("2027-04-10T12:00:00Z");

    private static final List<String> BESTAND = List.of("device_measurement_event", "measurement_point",
            "device_measurement_selection", "device", "site", "unternehmen", "standort", "tenant");
    private static final List<String> AUSNAHMEN = List.of("messreihe_%", "device_measurement_sample");

    private static final String LUECKE_F8 = "Lücke 14:00–17:31: Zuwachs 337,6 kWh gemessen, nicht auf Viertelstunden verteilbar";
    private static final String LUECKE_F20 = "Lücke 23:00–01:00: Zuwachs 192,0 kWh gemessen, nicht auf Viertelstunden verteilbar";
    private static final String LUECKE_MG = "Lücke 23:00–01:00: Zuwachs 192,0 kWh gemessen, nicht auf Viertelstunden verteilbar";
    // Die zweite 02:30 des Tages — ohne MEZ wäre sie von der ersten nicht zu unterscheiden (E10).
    private static final String LUECKE_SZ = "Lücke 01:30–02:30 MEZ: Zuwachs 192,0 kWh gemessen, nicht auf Viertelstunden verteilbar";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Map<String, UUID> IDS = new LinkedHashMap<>();

    private static JdbcTemplate root;
    private static JdbcTemplate admin;
    private static JdbcTemplate app;
    private static LueckenMelder melder;
    private static ViertelstundeVerdichter verdichter;
    private static EndgueltigkeitLauf endgueltigkeit;
    private static TagVerdichter tage;
    private static PeriodeVerdichter perioden;
    private static ZeitraumMenge zeitraum;

    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;
    private static Map<String, String> fingerNachAllem;

    private static int geschlossenNachAbbruch;
    private static Instant offenNachAbbruch;
    private static JsonNode geschlossenNachT3;
    private static int kbEreignisseNachT3;
    private static int kbEreignisseNachNochmal;
    private static int kbEreignisseNachDrittemMal;
    private static JsonNode geschlossenNachNochmal;
    private static String endgueltigVorher;
    private static String endgueltigNachher;
    private static int endgueltigeZeilen;

    // =========================================================================== Aufbau

    @BeforeAll
    static void bauenUndFahren() throws Exception {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        stammdaten();
        rohwerteVorher();
        fingerVorher = fingerabdruck();
        flyway().target(DIESE).load().migrate();
        fingerNachMigration = fingerabdruck();
        flyway().load().migrate();

        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        MeasurementCatalog katalog = new MeasurementCatalog(new ObjectMapper());
        melder = new LueckenMelder(admin, katalog, 50, 40, 20_000);
        verdichter = new ViertelstundeVerdichter(admin, katalog, new SpaetankunftMelder(), 500, 40, 200_000);
        endgueltigkeit = new EndgueltigkeitLauf(admin, 2000, 200);
        tage = new TagVerdichter(admin, katalog, 200, 40, 20_000, 200_000);
        perioden = new PeriodeVerdichter(admin, katalog, 50, 40, 2000);
        zeitraum = new ZeitraumMenge(app, katalog);

        // ---- 1. Die Box fällt aus: der Melder öffnet die Lücke der Reihe (und die der Box) -----
        melder.lauf(T_OFFEN);

        // ---- 2. Die Box kehrt zurück — aber das Schließen scheitert: nichts Halbes bleibt --------
        rueckkehr(Instant.parse("2026-11-03T16:31:00Z"), Instant.parse("2026-11-03T17:44:00Z"));
        root.execute("REVOKE INSERT ON messreihe_ereignis FROM " + ADMIN_USER);
        try {
            melder.lauf(T_ABBRUCH);
        } finally {
            root.execute("GRANT INSERT ON messreihe_ereignis TO " + ADMIN_USER);
        }
        geschlossenNachAbbruch = root.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE tenant_id = ? "
                + "AND entity_id = ? AND art = 'data_gap' AND bis IS NOT NULL", Integer.class, KB, IDS.get("ZW"));
        offenNachAbbruch = root.queryForObject("SELECT luecke_seit FROM messreihe_luecke_stand WHERE tenant_id = ? "
                + "AND entity_id = ?", Timestamp.class, KB, IDS.get("ZW")).toInstant();

        // ---- 3. Der nächste fällige Lauf schließt — mit dem gemessenen Zuwachs ------------------
        melder.lauf(T_ZU);
        geschlossenNachT3 = geschlossen(KB, "ZW");
        kbEreignisseNachT3 = kbEreignisse();

        // ---- 4. Wiederholbar: dieselbe Lücke noch zweimal ansehen schreibt nichts ---------------
        rueckkehr(Instant.parse("2026-11-03T17:45:00Z"), Instant.parse("2026-11-03T23:00:00Z"));
        melder.lauf(T_NOCHMAL);
        kbEreignisseNachNochmal = kbEreignisse();
        melder.lauf(T_NOCHMAL);
        kbEreignisseNachDrittemMal = kbEreignisse();
        geschlossenNachNochmal = geschlossen(KB, "ZW");

        // ---- 5. Die Verdichtung: Viertelstunden, Tage, Monate, Jahre (vorläufig) -----------------
        verdichtenAlles(T_VORLAEUFIG);

        // ---- 6. Endgültig — und ein weiterer Durchgang rührt keine endgültige Zeile an ----------
        endgueltigkeit.umschalten(T_SPAETER);
        tage.eintragenAusFrist(T_SPAETER);
        tagLaufBisLeer(T_SPAETER);
        perioden.lauf(T_SPAETER);
        periodenLaufBisLeer(T_SPAETER);
        endgueltigeZeilen = root.queryForObject("SELECT (SELECT count(*) FROM messreihe_tag WHERE zustand = "
                + "'endgueltig') + (SELECT count(*) FROM messreihe_periode WHERE zustand = 'endgueltig')", Integer.class);
        endgueltigVorher = endgueltigeFinger();
        melder.lauf(T_SPAETER);
        verdichtenAlles(T_SPAETER);
        root.update("INSERT INTO messreihe_periode_arbeit (tenant_id, entity_id, messkanal, art, tag, grund) "
                + "SELECT tenant_id, entity_id, messkanal, art, tag, 'frist' FROM messreihe_periode "
                + "ON CONFLICT DO NOTHING");
        periodenLaufBisLeer(T_SPAETER);
        endgueltigNachher = endgueltigeFinger();

        fingerNachAllem = fingerabdruck();
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ============================================================= Die Nutzlast der Lücke

    /** Box-Ausfall F8: die Lücke der REIHE schließt mit Zuwachs, Einheit und beiden Ständen. */
    @Test
    void dieLueckeTraegtDenGemessenenZuwachs() {
        JsonNode l = geschlossenNachT3;
        assertThat(l).as("geschlossene Lücke der Reihe").isNotNull();
        assertThat(l.path("erkannt_aus").asText()).isEqualTo("kadenz");
        assertThat(l.path("zuwachs").decimalValue()).isEqualByComparingTo("337.6");
        assertThat(l.path("einheit").asText()).isEqualTo("kWh");
        assertThat(l.path("stand_vor").decimalValue()).isEqualByComparingTo("418200.0");
        assertThat(l.path("stand_nach").decimalValue()).isEqualByComparingTo("418537.6");
        assertThat(l.path("erwartet_fehlend").asLong()).isEqualTo(210);
        assertThat(l.has("nachgeliefert_am")).isFalse();
        Map<String, Object> zeile = root.queryForMap("SELECT von, bis FROM messreihe_ereignis WHERE tenant_id = ? "
                + "AND entity_id = ? AND art = 'data_gap' AND bis IS NOT NULL", KB, IDS.get("ZW"));
        assertThat(((Timestamp) zeile.get("von")).toInstant()).isEqualTo(Instant.parse("2026-11-03T13:01:00Z"));
        assertThat(((Timestamp) zeile.get("bis")).toInstant()).isEqualTo(Instant.parse("2026-11-03T16:31:00Z"));
    }

    /** Der Melder rechnet nichts selbst: seine Zahl IST die der Rechenregel über dieselben Werte. */
    @Test
    void derZuwachsDerMeldungIstDerDerRechenregel() {
        JsonNode l = geschlossenNachT3;
        LueckenZuwachs regel = VerbrauchRegeln.lueckenZuwachs(
                new Rohwert(Instant.parse("2026-11-03T13:00:00Z"), l.path("stand_vor").decimalValue()),
                new Rohwert(Instant.parse("2026-11-03T16:31:00Z"), l.path("stand_nach").decimalValue()),
                List.of(), Duration.ofSeconds(60), BigDecimal.ONE);
        assertThat(regel).isNotNull();
        assertThat(regel.zuwachs()).isEqualByComparingTo(l.path("zuwachs").decimalValue());
        assertThat(VerbrauchRegeln.kleinsterZeitraum(regel, Duration.ofSeconds(60), BERLIN))
                .isEqualTo(new VerbrauchRegeln.Zeitraum("tag", Instant.parse("2026-11-02T23:00:00Z"),
                        Instant.parse("2026-11-03T23:00:00Z")));
    }

    /** Box-Ausfall: dieselbe Zeit, aber die Lücke der BOX hat keinen Zählerstand und trägt nichts. */
    @Test
    void dieLueckeDerBoxTraegtKeinenZuwachs() {
        List<String> nutzlasten = root.queryForList("SELECT DISTINCT ON (ereignis_id) nutzlast::text FROM "
                + "messreihe_ereignis WHERE tenant_id = ? AND art = 'data_gap' AND entity_id IS NULL "
                + "AND zeit < '2026-11-03T18:00:00Z' ORDER BY ereignis_id, eingang DESC", String.class, KB);
        assertThat(nutzlasten).as("Lücke je Box aus dem Herzschlag").isNotEmpty();
        assertThat(nutzlasten).allSatisfy(n -> assertThat(n).doesNotContain("zuwachs"));
    }

    @Test
    void einAbbruchLaesstNichtsHalbesZurueck() {
        assertThat(geschlossenNachAbbruch).as("kein halbes Schließen").isZero();
        assertThat(offenNachAbbruch).as("die Lücke bleibt offen im Stand").isEqualTo(Instant.parse("2026-11-03T13:01:00Z"));
        assertThat(geschlossenNachT3).as("der nächste Lauf schließt sie").isNotNull();
    }

    @Test
    void zweimalUeberDieselbeLueckeErgibtDasselbeUndSchreibtNichts() {
        assertThat(kbEreignisseNachNochmal).as("zweiter Lauf").isEqualTo(kbEreignisseNachT3);
        assertThat(kbEreignisseNachDrittemMal).as("dritter Lauf").isEqualTo(kbEreignisseNachT3);
        assertThat(geschlossenNachNochmal).isEqualTo(geschlossenNachT3);
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE tenant_id = ? AND entity_id = ? "
                + "AND art = 'data_gap' AND jsonb_exists(nutzlast, 'zuwachs')", Integer.class, KB, IDS.get("ZW")))
                .as("genau EINE Meldung trägt den Zuwachs").isOne();
    }

    // ===================================================== Regel 1–3: genau einmal in der Bilanz

    /**
     * Der Zuwachs steht genau einmal in der Bilanz: die Viertelstunden der Lücke haben gar keine
     * Zeile (nie 0), die Stunde 17:00–18:00 schneidet die Lücke nur an und bekommt ihn nicht, der Tag
     * 03.11. enthält sie ganz und zählt ihn — mit dem Kennzeichen des Vertrags.
     */
    @Test
    void derZuwachsStehtGenauEinmalInDerBilanz() {
        UUID zw = IDS.get("ZW");
        // (1) die Viertelstunden der Lücke: keine Zeile, nirgends eine 0
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_viertelstunde WHERE entity_id = ? "
                + "AND intervall_beginn >= '2026-11-03T13:15:00Z' AND intervall_beginn < '2026-11-03T16:15:00Z' "
                + "AND (menge IS NOT NULL OR menge_zustand IS DISTINCT FROM 'keine Werte')",
                Integer.class, zw)).as("Viertelstunden in der Lücke: keine Werte").isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_viertelstunde WHERE entity_id = ? "
                + "AND menge = 0", Integer.class, zw)).as("nie 0 kWh").isZero();
        Map<String, Object> vs1400 = viertelstunde(zw, "2026-11-03T13:00:00Z");
        assertThat(vs1400.get("menge")).as("14:00–14:15: ein Stand, keine Menge").isNull();
        Map<String, Object> vs1730 = viertelstunde(zw, "2026-11-03T16:30:00Z");
        assertThat((BigDecimal) vs1730.get("menge")).isEqualByComparingTo("22.4");
        assertThat(String.valueOf(root.queryForObject("SELECT string_agg(kennzeichen::text, '|') FROM "
                + "messreihe_viertelstunde WHERE entity_id = ?", String.class, zw))).doesNotContain("Zuwachs");

        // (2) ein Zeitraum, der die Lücke nur anschneidet, bekommt ihn nicht
        TenantContext.set(KB);
        ZeitraumMenge.Zeitraum stunde = zeitraum.zeitraum(KB, zw, KANAL, Instant.parse("2026-11-03T16:00:00Z"),
                Instant.parse("2026-11-03T17:00:00Z"), T_VORLAEUFIG);
        assertThat(stunde.menge().ergebnis().menge()).isEqualByComparingTo("46.4");
        assertThat(stunde.menge().ergebnis().kennzeichen()).doesNotContain(LUECKE_F8)
                .contains(VerbrauchRegeln.ANFANG_NICHT_GEMESSEN);

        // (3) der kleinste ganz enthaltende Zeitraum zählt ihn — mit Kennzeichen
        Map<String, Object> tag = tag(zw, LocalDate.of(2026, 11, 3));
        assertThat((BigDecimal) tag.get("menge")).isEqualByComparingTo("2304.0");
        assertThat(tag.get("menge_zustand")).isEqualTo("vollständig");
        assertThat(kennzeichen(tag)).containsExactly(LUECKE_F8);

        // … und jeder gröbere Zeitraum, der sie enthält, trägt dieselbe gemessene Energie — nicht doppelt
        ZeitraumMenge.Zeitraum nachmittag = zeitraum.zeitraum(KB, zw, KANAL, Instant.parse("2026-11-03T13:00:00Z"),
                Instant.parse("2026-11-03T17:00:00Z"), T_VORLAEUFIG);
        assertThat(nachmittag.menge().ergebnis().kennzeichen()).containsExactly(LUECKE_F8);
        assertThat(nachmittag.menge().ergebnis().menge()).isEqualByComparingTo("384.0");
        assertThat(nachmittag.menge().ergebnis().zustand()).isEqualTo("vollständig");
    }

    /** F20 über die DB: beide Tage ohne Zuwachs, der Zwei-Tage-Zeitraum und der Oktober mit. */
    @Test
    void f20DieTageOhneDerZeitraumUndDerMonatMit() {
        UUID f20 = IDS.get("F20");
        Map<String, Object> t20 = tag(f20, LocalDate.of(2026, 10, 20));
        Map<String, Object> t21 = tag(f20, LocalDate.of(2026, 10, 21));
        assertThat((BigDecimal) t20.get("menge")).isEqualByComparingTo("2208.0");
        assertThat((BigDecimal) t21.get("menge")).isEqualByComparingTo("2208.0");
        assertThat(kennzeichen(t20)).containsExactly(VerbrauchRegeln.ENDE_NICHT_GEMESSEN);
        assertThat(kennzeichen(t21)).containsExactly(VerbrauchRegeln.ANFANG_NICHT_GEMESSEN);
        TenantContext.set(KB);
        ZeitraumMenge.Zeitraum beide = zeitraum.zeitraum(KB, f20, KANAL, Instant.parse("2026-10-19T22:00:00Z"),
                Instant.parse("2026-10-21T22:00:00Z"), T_VORLAEUFIG);
        assertThat(beide.menge().ergebnis().menge()).isEqualByComparingTo("4608.0");
        assertThat(beide.menge().ergebnis().zustand()).isEqualTo("vollständig");
        assertThat(beide.menge().ergebnis().kennzeichen()).containsExactly(LUECKE_F20);
        assertThat(kennzeichen(periode(f20, "monat", LocalDate.of(2026, 10, 1)))).contains(LUECKE_F20);
    }

    /** Über die Monatsgrenze: kein Tag, kein Monat — erst das Jahr 2026 enthält die Lücke ganz. */
    @Test
    void ueberDieMonatsgrenzeZaehltErstDasJahr() {
        UUID mg = IDS.get("MG");
        assertThat(kennzeichen(tag(mg, LocalDate.of(2026, 10, 31)))).doesNotContain(LUECKE_MG)
                .contains(VerbrauchRegeln.ENDE_NICHT_GEMESSEN);
        assertThat(kennzeichen(tag(mg, LocalDate.of(2026, 11, 1)))).doesNotContain(LUECKE_MG)
                .contains(VerbrauchRegeln.ANFANG_NICHT_GEMESSEN);
        Map<String, Object> oktober = periode(mg, "monat", LocalDate.of(2026, 10, 1));
        Map<String, Object> november = periode(mg, "monat", LocalDate.of(2026, 11, 1));
        Map<String, Object> jahr = periode(mg, "jahr", LocalDate.of(2026, 1, 1));
        assertThat(kennzeichen(oktober)).doesNotContain(LUECKE_MG).contains(VerbrauchRegeln.ENDE_NICHT_GEMESSEN);
        assertThat(kennzeichen(november)).doesNotContain(LUECKE_MG).contains(VerbrauchRegeln.ANFANG_NICHT_GEMESSEN);
        assertThat(kennzeichen(jahr)).contains(LUECKE_MG);
        // Monat Oktober + Monat November + Zuwachs = Jahr: die Energie steht genau einmal da
        BigDecimal summe = ((BigDecimal) oktober.get("menge")).add((BigDecimal) november.get("menge"))
                .add(new BigDecimal("192.0"));
        assertThat((BigDecimal) jahr.get("menge")).isEqualByComparingTo(summe);
        LueckenZuwachs l = new LueckenZuwachs(Instant.parse("2026-10-31T22:00:00Z"),
                Instant.parse("2026-11-01T00:00:00Z"), null, null, null);
        assertThat(VerbrauchRegeln.kleinsterZeitraum(l, Duration.ofSeconds(60), BERLIN).art())
                .isEqualTo("jahr");
    }

    /** Sommerzeit-Ende 25.10.2026: der Tag hat 25 Stunden und enthält die Lücke 01:30 MESZ – 02:30 MEZ ganz. */
    @Test
    void amFuenfundzwanzigStundenTagZaehltDerTag() {
        UUID sz = IDS.get("SZ");
        Map<String, Object> tag = tag(sz, LocalDate.of(2026, 10, 25));
        assertThat(((Number) tag.get("stunden")).intValue()).isEqualTo(25);
        assertThat((BigDecimal) tag.get("menge")).isEqualByComparingTo("2400.0");
        assertThat(tag.get("menge_zustand")).isEqualTo("vollständig");
        assertThat(kennzeichen(tag)).containsExactly(LUECKE_SZ);
        assertThat(kennzeichen(tag(sz, LocalDate.of(2026, 10, 24)))).doesNotContain(LUECKE_SZ);
        assertThat(kennzeichen(tag(sz, LocalDate.of(2026, 10, 26)))).doesNotContain(LUECKE_SZ);
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_viertelstunde WHERE entity_id = ? "
                + "AND intervall_beginn > '2026-10-24T23:30:00Z' AND intervall_beginn < '2026-10-25T01:15:00Z' "
                + "AND (menge IS NOT NULL OR menge_zustand IS DISTINCT FROM 'keine Werte')",
                Integer.class, sz)).as("die Viertelstunden der Lücke: keine Werte, nie eine Menge").isZero();
    }

    // ================================================================ Leser und Grenzen

    /**
     * Der Träger ({@link ReihenKontext}) bekommt die Zone des STANDORTS zum Tag (E10) — sonst die des
     * Unternehmens, sonst die Vorgabe — und die Einheit des Katalog-Messkanals. Die drei zugelassenen
     * Zonen zeigen dieselbe Wanduhr; dass eine andere Zone eine andere Uhrzeit spricht, hält
     * {@code ErgebnisZustandVectorsTest#einStandortAusserhalbVonBerlinZeigtSeineEigeneUhrzeit} fest.
     */
    @Test
    void derTraegerNimmtDieZoneDesStandortsUndDieEinheitDesKatalogs() {
        UUID zw = IDS.get("ZW");
        List<ReihenKontext.Zeitzone> gesehen = root.execute((java.sql.Connection con) -> {
            con.setAutoCommit(false);
            try {
                List<ReihenKontext.Zeitzone> aus = new ArrayList<>();
                ReihenKontext.Frage heute = new ReihenKontext.Frage(KB, zw, LocalDate.of(2026, 11, 3));
                aus.add(ReihenKontext.zeitzonen(con, List.of(heute)).get(0));
                try (var ps = con.prepareStatement("UPDATE standort SET zeitzone = 'Europe/Vienna' WHERE id = ?")) {
                    ps.setObject(1, IDS.get("ST"));
                    ps.executeUpdate();
                }
                aus.add(ReihenKontext.zeitzonen(con, List.of(heute)).get(0));
                // Vor der Zuordnung zum Standort gilt die Zone des Unternehmens.
                aus.add(ReihenKontext.zeitzonen(con,
                        List.of(new ReihenKontext.Frage(KB, zw, LocalDate.of(2023, 12, 31)))).get(0));
                return aus;
            } finally {
                con.rollback();
                con.setAutoCommit(true);
            }
        });
        assertThat(gesehen).extracting(ReihenKontext.Zeitzone::name, ReihenKontext.Zeitzone::herkunft).containsExactly(
                org.assertj.core.groups.Tuple.tuple("Europe/Berlin", TagRegeln.AUS_STANDORT),
                org.assertj.core.groups.Tuple.tuple("Europe/Vienna", TagRegeln.AUS_STANDORT),
                org.assertj.core.groups.Tuple.tuple("Europe/Berlin", TagRegeln.AUS_UNTERNEHMEN));
        assertThat(ReihenKontext.aus(new MeasurementCatalog(new ObjectMapper()), KANAL, gesehen.get(1).zone()))
                .isEqualTo(new ReihenKontext("kWh", ZoneId.of("Europe/Vienna")));
        assertThat(root.queryForObject("SELECT zeitzone FROM standort WHERE id = ?", String.class, IDS.get("ST")))
                .as("zurückgerollt").isEqualTo("Europe/Berlin");
    }

    /** Der Verlaufs-Marker nennt den Zuwachs mit dem Zusatz des Ereignis-Vertrags, Wort für Wort. */
    @Test
    void derMarkerSagtGemessenNichtVerteilbar() throws Exception {
        TenantContext.set(KB);
        List<SpeicherklasseHistorie.Ereignis> marken = new SpeicherklasseHistorie(app,
                new MeasurementCatalog(new ObjectMapper())).ereignisse(KB, IDS.get("ZW"), KANAL,
                Instant.parse("2026-11-03T00:00:00Z"), Instant.parse("2026-11-04T00:00:00Z"), 3600);
        SpeicherklasseHistorie.Ereignis luecke = marken.stream().filter(e -> "data_gap".equals(e.art()))
                .findFirst().orElseThrow();
        assertThat(luecke.zuwachs()).isNotNull();
        assertThat(luecke.zuwachs().menge()).isEqualByComparingTo("337.6");
        JsonNode vertrag = JSON.readTree(Files.readString(java.nio.file.Path.of("..", "..", "docs", "contracts", "v2",
                "events-vocabulary-vectors.json")));
        String zusatz = "";
        for (JsonNode a : vertrag.path("vokabular").path("arten")) {
            if ("data_gap".equals(a.path("art").asText())) {
                zusatz = a.path("zusaetze").path("zuwachs").asText();
            }
        }
        assertThat(MeasurementHistoryService.zuwachsSatz(luecke.zuwachs()))
                .isEqualTo(zusatz.replace("{zuwachs}", "337,6 kWh"));
    }

    @Test
    void endgueltigeZeilenBleibenUnberuehrt() {
        assertThat(endgueltigeZeilen).as("es gibt endgültige Tage und Perioden").isPositive();
        assertThat(endgueltigNachher).isEqualTo(endgueltigVorher);
        Bestandsschutz.inhaltsprobe(root, UemsLueckenZuwachsTest::endgueltigeFinger, "messreihe_periode",
                "UPDATE messreihe_periode SET berechnet_am = berechnet_am + interval '1 second' "
                        + "WHERE zustand = 'endgueltig'");
    }

    /** Ein anderer Kundenbereich sieht weder die Lücke noch den Tag — und seine eigene trägt SEINEN Zuwachs. */
    @Test
    void derMandantenzaunHaelt() {
        TenantContext.set(FREMD);
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE entity_id = ?", Integer.class,
                IDS.get("ZW"))).isZero();
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_tag WHERE entity_id = ?", Integer.class,
                IDS.get("ZW"))).isZero();
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE entity_id = ? AND "
                + "jsonb_exists(nutzlast, 'zuwachs')", Integer.class, IDS.get("FREMD"))).isOne();
        TenantContext.set(KB);
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE entity_id = ? AND "
                + "jsonb_exists(nutzlast, 'zuwachs')", Integer.class, IDS.get("ZW"))).isOne();
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE entity_id = ?", Integer.class,
                IDS.get("FREMD"))).isZero();
        JsonNode fremd = geschlossen(FREMD, "FREMD");
        assertThat(fremd.path("zuwachs").decimalValue()).isEqualByComparingTo("422");
        assertThat(fremd.path("stand_vor").decimalValue()).isEqualByComparingTo("2680");
    }

    @Test
    void dieMigrationWeitetNurDasVokabularUndDerBestandBleibtZeichengleich() {
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).as("nach der Migration").isEmpty();
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachAllem)).as("nach allen Läufen").isEmpty();
        assertThat(fingerVorher).hasSizeGreaterThan(100).containsKeys(BESTAND.toArray(String[]::new));
        String felder = root.queryForObject("SELECT array_to_string(felder, ',') || '|' || "
                + "array_to_string(fortschreibbar, ',') FROM messreihe_ereignis_vokabular() WHERE art = 'data_gap'",
                String.class);
        assertThat(felder).isEqualTo("erwartet_fehlend,nachgeliefert_am,fehlerklasse,ursache_ereignis,zuwachs,"
                + "einheit,stand_vor,stand_nach|bis,erwartet_fehlend,nachgeliefert_am,ursache_ereignis,zuwachs,"
                + "einheit,stand_vor,stand_nach");
    }

    // ============================================================ Aufbau der Beispielwelt

    private static void stammdaten() {
        for (UUID t : new UUID[] {KB, FREMD}) {
            root.update("INSERT INTO tenant (id, name) VALUES (?, ?)", t,
                    t.equals(KB) ? "Kunststoffwerk Ahrenberg GmbH" : "Kundenbereich B");
            IDS.put("U:" + t, uuid("INSERT INTO unternehmen (tenant_id, name, zeitzone) "
                    + "VALUES (?, ?, 'Europe/Berlin') RETURNING id", t, "U " + t));
        }
        IDS.put("ST", uuid("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id",
                KB, IDS.get("U:" + KB)));
        IDS.put("AN2", uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-2') RETURNING id", KB));
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, DATE '2024-01-01')", KB, IDS.get("AN2"), IDS.get("ST"));
        IDS.put("BOX", uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, 'VP-BOX-HALLE-2', 'claimed') RETURNING id", KB, IDS.get("AN2")));
        for (String r : new String[] {"ZW", "F20", "MG", "SZ"}) {
            IDS.put(r, reihe(KB, IDS.get("AN2"), IDS.get("BOX"), r));
        }
        IDS.put("AN-F", uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'B-1') RETURNING id", FREMD));
        IDS.put("BOX-F", uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, 'VP-BOX-B', 'claimed') RETURNING id", FREMD, IDS.get("AN-F")));
        IDS.put("FREMD", reihe(FREMD, IDS.get("AN-F"), IDS.get("BOX-F"), "FREMD"));
    }

    private static UUID reihe(UUID tenant, UUID site, UUID box, String name) {
        UUID entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, "
                + "communication, connection_json, created_at) VALUES (?, ?, 'grid-meter', ?, 'grid-meter', ?, "
                + "'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, '2024-03-12T00:00:00Z') RETURNING id",
                tenant, site, name, box);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, "
                + "'2024-03-12T00:00:00Z', '2026.09.11.1', 'test', 'pending_edge', 'live_power', 'fifteen_minute')",
                tenant, site, box, entity, KANAL);
        return entity;
    }

    /** Alles, was VOR dem Ausfall eingegangen ist — F8 bis 14:00, F20, die Monatsgrenze, der 25-Stunden-Tag. */
    private static void rohwerteVorher() throws Exception {
        JsonNode datei = VerbrauchVectorsTest.lies(VerbrauchVectorsTest.VECTORS);
        for (JsonNode fall : datei.path("cases")) {
            String name = fall.path("name").asText();
            if (name.startsWith("f8-")) {
                List<Rohwert> f8 = VerbrauchVectorsTest.rohwerte(fall.path("input").path("reihe"));
                F8.addAll(f8);
                saeen(KB, "ZW", f8.stream().filter(r -> !r.zeit().isAfter(Instant.parse("2026-11-03T13:00:00Z"))).toList());
            } else if (name.startsWith("f20-")) {
                saeen(KB, "F20", VerbrauchVectorsTest.rohwerte(fall.path("input").path("reihe")));
            }
        }
        saeen(KB, "MG", gleichmaessig(Instant.parse("2026-10-29T23:00:00Z"), Instant.parse("2026-11-01T23:00:00Z"),
                "300000", Instant.parse("2026-10-31T22:00:00Z"), Instant.parse("2026-11-01T00:00:00Z")));
        saeen(KB, "SZ", gleichmaessig(Instant.parse("2026-10-23T22:00:00Z"), Instant.parse("2026-10-26T23:00:00Z"),
                "500000", Instant.parse("2026-10-24T23:30:00Z"), Instant.parse("2026-10-25T01:30:00Z")));
        saeen(FREMD, "FREMD", fremd().stream().filter(r -> !r.zeit().isAfter(Instant.parse("2026-11-03T13:00:00Z")))
                .toList());
    }

    private static final List<Rohwert> F8 = new ArrayList<>();

    /** Die Rückkehr der Boxen: die Werte beider Kundenbereiche mit Messzeit in {@code [von, bis]}. */
    private static void rueckkehr(Instant von, Instant bis) {
        saeen(KB, "ZW", F8.stream().filter(r -> !r.zeit().isBefore(von) && !r.zeit().isAfter(bis)).toList());
        saeen(FREMD, "FREMD", fremd().stream().filter(r -> !r.zeit().isBefore(von) && !r.zeit().isAfter(bis)).toList());
    }

    /** Kundenbereich B: dieselbe Ausfallzeit, 2 kWh je Minute ab 1 000 — 14:00 = 2 680, 17:31 = 3 102. */
    private static List<Rohwert> fremd() {
        List<Rohwert> aus = new ArrayList<>();
        Instant t = Instant.parse("2026-11-02T23:00:00Z");
        for (long i = 0; !t.isAfter(Instant.parse("2026-11-03T23:00:00Z")); i++, t = t.plusSeconds(60)) {
            if (t.isAfter(Instant.parse("2026-11-03T13:00:00Z")) && t.isBefore(Instant.parse("2026-11-03T16:31:00Z"))) {
                continue;
            }
            aus.add(new Rohwert(t, BigDecimal.valueOf(1000 + 2 * i)));
        }
        return aus;
    }

    /** 1,6 kWh je Minute ab {@code start}; Werte STRENG zwischen {@code lueckeVor} und {@code lueckeNach} fehlen. */
    private static List<Rohwert> gleichmaessig(Instant von, Instant bis, String start, Instant lueckeVor,
            Instant lueckeNach) {
        List<Rohwert> aus = new ArrayList<>();
        Instant t = von;
        for (long i = 0; !t.isAfter(bis); i++, t = t.plusSeconds(60)) {
            if (t.isAfter(lueckeVor) && t.isBefore(lueckeNach)) {
                continue;
            }
            aus.add(new Rohwert(t, new BigDecimal(start).add(new BigDecimal("1.6").multiply(BigDecimal.valueOf(i)))));
        }
        return aus;
    }

    private static final String ROH_SQL =
            "INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, point_key, "
                    + "raw_numeric, quality, catalog_version, edge_sequence, aggregation_kind, entity_id, "
                    + "applied_revision, value_kind, role, delivery, delay_s) VALUES (?, ?, ?, ?, ?, ?, ?, 'good', "
                    + "'2026.09.11.1', ?, 'counter', ?, 3, 'counter', 'fuehrend', 'direkt', 2) ON CONFLICT DO NOTHING";

    private static void saeen(UUID tenant, String reihe, List<Rohwert> werte) {
        boolean kb = tenant.equals(KB);
        List<Object[]> stapel = new ArrayList<>();
        for (Rohwert r : werte) {
            stapel.add(new Object[] {Timestamp.from(r.zeit()), Timestamp.from(r.zeit().plusSeconds(2)), tenant,
                    kb ? IDS.get("AN2") : IDS.get("AN-F"), kb ? IDS.get("BOX") : IDS.get("BOX-F"), KANAL, r.wert(),
                    r.zeit().getEpochSecond(), IDS.get(reihe)});
            if (stapel.size() == 5000) {
                root.batchUpdate(ROH_SQL, stapel);
                stapel.clear();
            }
        }
        root.batchUpdate(ROH_SQL, stapel);
    }

    // ------------------------------------------------------------------------ Die Läufe

    private static void verdichtenAlles(Instant jetzt) {
        root.update("""
                INSERT INTO messreihe_viertelstunde_arbeit (tenant_id, entity_id, messkanal, intervall_beginn, grund)
                SELECT DISTINCT s.tenant_id, s.entity_id, s.point_key,
                       to_timestamp(floor(extract(epoch FROM s.time) / 900) * 900), 'eingang'
                  FROM device_measurement_sample s
                 WHERE s.entity_id IS NOT NULL AND s.role IS DISTINCT FROM 'spiegel'
                ON CONFLICT DO NOTHING
                """);
        while (verdichter.verdichteEinenStapel(jetzt)[0] > 0) {
            // weiter, bis die Liste leer ist
        }
        endgueltigkeit.umschalten(jetzt);
        root.update("""
                INSERT INTO messreihe_tag_arbeit (tenant_id, entity_id, messkanal, utc_tag, grund)
                SELECT DISTINCT v.tenant_id, v.entity_id, v.messkanal,
                       (v.intervall_beginn AT TIME ZONE 'UTC')::date, 'viertelstunde'
                  FROM messreihe_viertelstunde v
                ON CONFLICT DO NOTHING
                """);
        tagLaufBisLeer(jetzt);
        periodenLaufBisLeer(jetzt);
    }

    private static void tagLaufBisLeer(Instant jetzt) {
        while (tage.bildeEinenStapel(jetzt)[0] > 0) {
            // weiter
        }
    }

    private static void periodenLaufBisLeer(Instant jetzt) {
        while (perioden.bildeEinenStapel(jetzt)[0] > 0) {
            // weiter
        }
    }

    // ------------------------------------------------------------------------ Helfer

    /** Die jüngste GESCHLOSSENE Reihen-Lücke als Vertragsform (Nutzlast + Kennungen). */
    private static JsonNode geschlossen(UUID tenant, String reihe) {
        List<String> z = root.queryForList("SELECT nutzlast::text FROM messreihe_ereignis WHERE tenant_id = ? "
                + "AND entity_id = ? AND art = 'data_gap' AND bis IS NOT NULL ORDER BY eingang DESC LIMIT 1",
                String.class, tenant, IDS.get(reihe));
        try {
            return z.isEmpty() ? null : JSON.readTree(z.get(0));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static int kbEreignisse() {
        return root.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE tenant_id = ?", Integer.class, KB);
    }

    private static String endgueltigeFinger() {
        return Bestandsschutz.inhalt(root, "messreihe_tag", "t.zustand = 'endgueltig'") + ';'
                + Bestandsschutz.inhalt(root, "messreihe_periode", "t.zustand = 'endgueltig'");
    }

    private static Map<String, Object> viertelstunde(UUID entity, String beginn) {
        return root.queryForMap("SELECT * FROM messreihe_viertelstunde WHERE entity_id = ? AND intervall_beginn = ?",
                entity, Timestamp.from(Instant.parse(beginn)));
    }

    private static Map<String, Object> tag(UUID entity, LocalDate tag) {
        return root.queryForMap("SELECT * FROM messreihe_tag WHERE entity_id = ? AND tag = ?", entity,
                java.sql.Date.valueOf(tag));
    }

    private static Map<String, Object> periode(UUID entity, String art, LocalDate tag) {
        return root.queryForMap("SELECT * FROM messreihe_periode WHERE entity_id = ? AND art = ? AND tag = ?",
                entity, art, java.sql.Date.valueOf(tag));
    }

    private static List<String> kennzeichen(Map<String, Object> zeile) {
        return ViertelstundenTeile.kennzeichen(String.valueOf(zeile.get("kennzeichen")));
    }

    private static UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
    }

    private static Map<String, String> fingerabdruck() {
        return Bestandsschutz.fingerabdruck(root, AUSNAHMEN);
    }

    private static String letzteFassungVorDieser() {
        MigrationVersion diese = MigrationVersion.fromVersion(DIESE);
        return Arrays.stream(flyway().load().info().all())
                .map(MigrationInfo::getVersion)
                .filter(v -> v != null && v.compareTo(diese) < 0)
                .max(Comparator.naturalOrder())
                .orElseThrow()
                .getVersion();
    }

    private static FluentConfiguration flyway() {
        return Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW));
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
