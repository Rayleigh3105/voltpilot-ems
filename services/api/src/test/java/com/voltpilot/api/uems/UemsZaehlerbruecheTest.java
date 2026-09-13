package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.VerbrauchRegeln.Ereignis;
import com.voltpilot.api.uems.VerbrauchRegeln.Ergebnis;
import com.voltpilot.api.uems.VerbrauchRegeln.Rohwert;
import java.math.BigDecimal;
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
 * UEMS AP-08 IP-4 — Gerätegrenze (Z4), Rücksetzung (Z5), Überlauf (Z6) und Neustart (Z7) durch die
 * ganze Strecke: Rohtabelle + Ereignis-Tabelle → Arbeitsliste → Viertelstunde → Tag → Monat → Jahr,
 * gegen die Vektor-Fälle F4, F5, F6, F7, F12 und F22 aus {@code docs/contracts/v2/verbrauch-vectors.json}.
 *
 * <ul>
 *   <li><b>Je Bruch mit und ohne die Angabe, die ihn rechenbar macht:</b> Gerätegrenze mit (F4) und
 *       ohne Ablesestände (F5); Rücksetzung ohne (F6) und mit nachgetragenem Endstand (F12
 *       „Version 2"); Überlauf mit (F7) und ohne Deklaration; Neustart mit deklariertem (F22,
 *       120 s) und ohne bekannten Zählverlust (255 s). Fehlt die Angabe, gibt es keine Zahl dafür,
 *       sondern die benannte Unvollständigkeit.
 *   <li><b>Später eingegangen:</b> ein Endstand, den der Kunde nachträgt, rechnet die VORLÄUFIGE
 *       Viertelstunde und ihren Tag neu (Arbeitslisten-Grund {@code ereignis}); eine ENDGÜLTIGE
 *       bleibt Zeichen für Zeichen stehen (der Vorschlag ist AP-08 IP-14). Abbruchsicher: scheitert
 *       das Eintragen, bleibt der Zeiger stehen.
 *   <li><b>Genau auf der Grenze:</b> ein Zählerwechsel um 10:45 gehört zur Viertelstunde 10:30–10:45.
 *   <li><b>Fortpflanzung:</b> Tag, Monat und Jahr tragen dieselbe Menge, denselben Zustand und
 *       dieselben Kennzeichen wie die Regel über ALLE Rohwerte der Periode.
 *   <li>Wiederholbar, Mandantenzaun, und der Bestand ist vor und nach allem zeichengleich.
 * </ul>
 *
 * <p>Die Deklaration (Wertebereich, Höchstzuwachs, Neustart-Verlust) gehört AP-08 IP-7; bis dahin
 * ist {@code messreihe_zaehler_deklaration()} leer. Der Test ersetzt ihren Rumpf — genau die Tür,
 * die IP-7 füllt.
 *
 * <p>⚠ F7 rechnet in der Vektor-Datei mit dem Faktor 0,001; die Strecke speichert den Wert, wie die
 * Box ihn liefert (der Faktor wirkt beim Erfassen, {@link ViertelstundeRegeln#FAKTOR_DER_FASSUNG}),
 * darum steht die Menge hier in Impulsen und wird mit dem Faktor der Datei verglichen.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsZaehlerbruecheTest {

    private static final String DIESE = "20260912220000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final UUID KB = UUID.fromString("4e0e0000-0000-0000-0000-000000000007");
    private static final UUID FREMD = UUID.fromString("4e0e0000-0000-0000-0000-000000000008");
    private static final ZoneId ORT = ZoneId.of("Europe/Berlin");
    private static final Duration KADENZ = Duration.ofSeconds(60);

    /** Die erste Bildung: nach allen Rohwerten, alles noch vorläufig. */
    private static final Instant T0 = Instant.parse("2027-05-20T12:00:00Z");
    /** Der Nachtrag des Endstands (F12): die Januar-Viertelstunden sind noch vorläufig. */
    private static final Instant T1 = Instant.parse("2027-01-20T12:00:00Z");
    private static final Instant T2 = T1.plus(Duration.ofMinutes(10));
    private static final Instant T3 = T2.plus(Duration.ofMinutes(10));

    private static final List<String> BESTAND = List.of(
            "device_measurement_event", "device_measurement_rollup_5m", "device_measurement_rollup_15m",
            "device_measurement_selection", "measurement_point", "data_source", "standort", "unternehmen",
            "anlage_standort", "telemetry", "schedule");

    /**
     * Die Tabellen, die dieses Paket bearbeitet, und die Rohtabelle — nicht Teil des
     * Bestands-Fingerabdrucks. Die Rohtabelle wächst in diesem Test selbst; dass keine BESTEHENDE
     * Rohzeile sich ändert, prüft {@link #rohwerteFinger()} eigens.
     */
    private static final List<String> AUSNAHMEN = List.of("messreihe_%", "device_measurement_sample");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate admin;
    private static JdbcTemplate app;
    private static ViertelstundeVerdichter verdichter;
    private static TagVerdichter tage;
    private static PeriodeVerdichter perioden;
    private static ZeitraumMenge zeitraum;

    private static final Map<String, UUID> IDS = new LinkedHashMap<>();
    private static final Map<String, JsonNode> FAELLE = new LinkedHashMap<>();
    private static final Map<String, List<Rohwert>> ROH = new LinkedHashMap<>();
    private static final Map<String, List<Ereignis>> EREIGNISSE = new LinkedHashMap<>();

    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;
    private static Map<String, String> fingerNachAllem;
    private static String rohVorher;
    private static String rohNachAllem;

    private static Map<String, Object> f12Version1;
    private static Map<String, Object> f12Version2;
    private static Map<String, Object> f12TagVorher;
    private static Map<String, Object> f12TagNachher;
    private static Map<String, Object> endgueltigVorher;
    private static Map<String, Object> endgueltigNachher;
    private static int ereignisEintraegeF12;
    private static int ereignisEintraegeEndgueltig;
    private static int ereignisEintraegeFremd;
    private static int ereignisEintraegeTag;
    private static int zweiterLaufGeschrieben;
    private static int zweitesEintragen;
    private static boolean abbruchWarf;
    private static Object zeigerVorAbbruch;
    private static Object zeigerNachAbbruch;
    private static int eintraegeNachAbbruch;
    private static Map<String, Object> abbruchNachher;

    @BeforeAll
    static void bauenUndFahren() throws Exception {
        for (JsonNode fall : VerbrauchVectorsTest.lies(VerbrauchVectorsTest.VECTORS).path("cases")) {
            FAELLE.put(fall.path("name").asText().split("-")[0], fall);
        }
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();

        stammdaten();
        rohwerte();
        fingerVorher = fingerabdruck();
        rohVorher = rohwerteFinger();

        flyway().target(DIESE).load().migrate();
        fingerNachMigration = fingerabdruck();
        flyway().load().migrate();
        deklarieren();

        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        verdichter = new ViertelstundeVerdichter(admin, new MeasurementCatalog(new ObjectMapper()),
                new SpaetankunftMelder(), 500, 40, 200_000);
        EndgueltigkeitLauf endgueltigkeit = new EndgueltigkeitLauf(admin, 2000, 200);
        tage = new TagVerdichter(admin, 200, 40, 20_000, 200_000);
        perioden = new PeriodeVerdichter(admin, 50, 40, 2000);
        zeitraum = new ZeitraumMenge(app);

        // ---- 1. Die Brüche, die schon da sind, als die Rohwerte verdichtet werden -----------------
        EREIGNISSE.put("F4", ereignisseDerDatei("f4", null));
        grenze(KB, "F4", "2026-11-18T10:40:00+01:00", new BigDecimal("1083415.2"), BigDecimal.ZERO, null);
        EREIGNISSE.put("F5", ereignisseDerDatei("f5", null));
        grenze(KB, "F5", "2026-11-18T10:40:00+01:00", null, null, null);
        EREIGNISSE.put("F22", ereignisseDerDatei("f22", 120L));
        neustart(KB, IDS.get("DQ-F22"), "2027-05-12T10:22:00+02:00", null);
        EREIGNISSE.put("F22O", ereignisseDerDatei("f22", Ereignis.VERLUST_VORGABE));
        neustart(KB, IDS.get("DQ-F22O"), "2027-05-12T10:22:00+02:00", null);
        EREIGNISSE.put("GR", List.of(new Ereignis(Ereignis.GERAETEGRENZE, Instant.parse("2026-11-19T09:45:00Z"),
                "10:45", new BigDecimal("545"), BigDecimal.ZERO, 0)));
        grenze(KB, "GR", "2026-11-19T10:45:00+01:00", new BigDecimal("545"), BigDecimal.ZERO, null);
        for (String r : List.of("F6", "F7", "F7O", "F12", "F12E", "AB")) {
            EREIGNISSE.put(r, List.of());
        }

        arbeitFuellen();
        verdichtenBisLeer(T0);
        tagArbeitFuellen();
        tagLaufBisLeer(T0);
        periodenLaufBisLeer(T0);

        // ---- 2. F12: der Endstand kommt NACH der Verdichtung -------------------------------------
        f12Version1 = viertelstunde("F12", "2027-01-15T09:00:00+01:00");
        f12TagVorher = tag("F12", LocalDate.of(2027, 1, 15));
        // Alles bis Neujahr Fällige wird endgültig — darunter F12E (16.12.2026), NICHT F12 (15.01.2027).
        endgueltigkeit.umschalten(Instant.parse("2027-01-01T00:00:00Z"));
        endgueltigVorher = viertelstunde("F12E", "2026-12-16T09:00:00+01:00");
        verdichter.eintragenAusEingang(T1); // setzt den Zeiger
        tage.eintragenAusViertelstunden(T1);
        Instant eingang = T1.plus(Duration.ofMinutes(1));
        EREIGNISSE.put("F12", ereignisseDerDatei("f12", null));
        grenze(KB, "F12", "2027-01-15T09:12:00+01:00", new BigDecimal("6184.9"), BigDecimal.ZERO, eingang);
        grenze(KB, "F12E", "2026-12-16T09:12:00+01:00", new BigDecimal("6184.9"), BigDecimal.ZERO, eingang);
        // Der Zaun: ein Neustart eines FREMDEN Kundenbereichs, der dieselbe Datenquellen-Kennung nennt.
        neustart(FREMD, IDS.get("DQ-F22"), "2027-05-12T10:22:00+02:00", eingang);

        verdichter.eintragenAusEingang(T2);
        ereignisEintraegeF12 = arbeit("F12");
        ereignisEintraegeEndgueltig = arbeit("F12E");
        ereignisEintraegeFremd = arbeit("F22");
        verdichtenBisLeer(T2);
        tage.eintragenAusViertelstunden(T2);
        ereignisEintraegeTag = zahl("SELECT count(*) FROM messreihe_tag_arbeit WHERE grund = 'ereignis'");
        tagLaufBisLeer(T2);
        f12Version2 = viertelstunde("F12", "2027-01-15T09:00:00+01:00");
        f12TagNachher = tag("F12", LocalDate.of(2027, 1, 15));
        endgueltigNachher = viertelstunde("F12E", "2026-12-16T09:00:00+01:00");

        // ---- 3. Wiederholbar: alles noch einmal schreibt NICHTS ----------------------------------
        zweitesEintragen = verdichter.eintragenAusEingang(T2.plus(Duration.ofMinutes(3)));
        arbeitFuellen();
        zweiterLaufGeschrieben = verdichtenBisLeer(T2);

        // ---- 4. Abbruchsicher: scheitert das Eintragen, bleibt der Zeiger stehen -----------------
        grenze(KB, "AB", "2027-01-15T09:05:00+01:00", null, null, T2.plus(Duration.ofMinutes(4)));
        zeigerVorAbbruch = zeiger();
        root.execute("REVOKE INSERT ON messreihe_viertelstunde_arbeit FROM " + ADMIN_USER);
        try {
            verdichter.eintragenAusEingang(T3);
            abbruchWarf = false;
        } catch (RuntimeException e) {
            abbruchWarf = true;
        } finally {
            root.execute("GRANT INSERT ON messreihe_viertelstunde_arbeit TO " + ADMIN_USER);
        }
        zeigerNachAbbruch = zeiger();
        verdichter.eintragenAusEingang(T3);
        eintraegeNachAbbruch = arbeit("AB");
        verdichtenBisLeer(T3);
        abbruchNachher = viertelstunde("AB", "2027-01-15T09:00:00+01:00");

        fingerNachAllem = fingerabdruck();
        rohNachAllem = rohwerteFinger();
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ======================================================== Z4 Gerätegrenze (F4, F5)

    /** F4: mit Ablesestände — zwei unvollständige Viertelstunden, aber Stunde und Tag VOLLSTÄNDIG. */
    @Test
    void f4GeraetegrenzeMitAblesestaendenIstUeberDenWechselVollstaendig() {
        pruefeViertelstunde("F4", "f4", "Viertelstunde 10:30–10:45", BigDecimal.ONE);
        pruefeViertelstunde("F4", "f4", "Viertelstunde 10:45–11:00", BigDecimal.ONE);
        pruefeStunde("F4", "f4", "Stunde 10:00–11:00");
        pruefeTagGegenDatei("F4", "f4", LocalDate.of(2026, 11, 18), "Tag 18.11.2026");
    }

    /** F5: ohne Ablesestände — der Zuwachs am Wechsel wird nicht erfunden, Stunde und Tag sind unvollständig. */
    @Test
    void f5GeraetegrenzeOhneAblesestaendeErfindetKeinenZuwachs() {
        pruefeStunde("F5", "f5", "Stunde 10:00–11:00");
        pruefeTagGegenDatei("F5", "f5", LocalDate.of(2026, 11, 18), "Tag 18.11.2026");
    }

    /** Ein Zählerwechsel GENAU auf der Viertelstundengrenze gehört zur Viertelstunde davor ({@code (von, bis]}). */
    @Test
    void einWechselGenauAufDerGrenzeGehoertZurViertelstundeDavor() {
        Map<String, Object> davor = viertelstunde("GR", "2026-11-19T10:30:00+01:00");
        assertThat((BigDecimal) davor.get("menge")).isEqualByComparingTo("15");
        assertThat(davor.get("menge_zustand")).isEqualTo(VerbrauchRegeln.VOLLSTAENDIG);
        assertThat(kennzeichen(davor)).containsExactly("Gerätegrenze 10:45 mit Ablesestände");
        Map<String, Object> danach = viertelstunde("GR", "2026-11-19T10:45:00+01:00");
        assertThat((BigDecimal) danach.get("menge")).isEqualByComparingTo("15");
        assertThat(kennzeichen(danach)).isEmpty();
        pruefeGegenRegel("GR", davor, "2026-11-19T10:30:00+01:00", "2026-11-19T10:45:00+01:00");
    }

    // ============================================= Z5 Rücksetzung (F6, F12 Version 1 und 2)

    /** F6 (Plan-Abnahme 1): 14,28 kWh aus dem, was vor und nach dem Sprung gemessen ist — nie ±6 184,37. */
    @Test
    void f6RuecksetzungOhneEndstandIstUnvollstaendigOhneFiktivenVerbrauch() {
        pruefeViertelstunde("F6", "f6", "Viertelstunde 09:00–09:15", BigDecimal.ONE);
        pruefeTagGegenRegel("F6", LocalDate.of(2027, 1, 15));
    }

    /** F12 Version 1: vor dem Nachtrag ist es eine Rücksetzung ohne Endstand. */
    @Test
    void f12VorDemNachtragIstEsEineRuecksetzung() {
        vergleiche(erwartung("f12", "Viertelstunde 09:00–09:15 (Version 1)"), f12Version1, BigDecimal.ONE);
        assertThat(kennzeichen(f12TagVorher)).contains("Rücksetzung 09:12 ohne Endstand — bis zu 1 Kadenz nicht gezählt");
    }

    /**
     * F12 Version 2: der nachgetragene Endstand macht die Rücksetzung zur Gerätegrenze (E3) — die
     * VORLÄUFIGE Viertelstunde und ihr Tag werden neu gebildet. Die Versionsnummer bleibt 1: eine
     * Korrektur mit Version ist AP-08 IP-12 ff.
     */
    @Test
    void f12DerNachgetrageneEndstandRechnetDieVorlaeufigeViertelstundeNeu() {
        assertThat(ereignisEintraegeF12).as("der Bruch trägt seine Viertelstunde ein").isOne();
        vergleiche(erwartung("f12", "Viertelstunde 09:00–09:15 (Version 2)"), f12Version2, BigDecimal.ONE);
        assertThat(((Number) f12Version2.get("version")).intValue()).isOne();
        assertThat(f12Version2.get("zustand")).isEqualTo(ViertelstundeRegeln.VORLAEUFIG);
        assertThat(ereignisEintraegeTag).as("und seinen Tag").isPositive();
        assertThat(kennzeichen(f12TagNachher)).contains("Gerätegrenze 09:12 mit Ablesestände")
                .doesNotContain("Rücksetzung 09:12 ohne Endstand — bis zu 1 Kadenz nicht gezählt");
        pruefeTagGegenRegel("F12", LocalDate.of(2027, 1, 15));
    }

    /** Eine ENDGÜLTIGE Viertelstunde bleibt Zeichen für Zeichen stehen — der Nachtrag wird ein Vorschlag (IP-14). */
    @Test
    void eineEndgueltigeViertelstundeWirdVomNachtragNieAngefasst() {
        assertThat(ereignisEintraegeEndgueltig).as("eingetragen wird sie").isOne();
        assertThat(endgueltigVorher.get("zustand")).isEqualTo(ViertelstundeRegeln.ENDGUELTIG);
        assertThat(endgueltigNachher).isEqualTo(endgueltigVorher);
        assertThat(kennzeichen(endgueltigNachher))
                .containsExactly("Rücksetzung 09:12 ohne Endstand — bis zu 1 Kadenz nicht gezählt");
    }

    // ========================================================== Z6 Überlauf (F7, E4)

    /** F7: der deklarierte Überlauf ist lückenlos, der Sprung über dem Höchstzuwachs eine Rücksetzung. */
    @Test
    void f7DerDeklarierteUeberlaufIstLueckenlos() {
        BigDecimal faktor = FAELLE.get("f7").path("input").path("reihe").path("faktor").decimalValue();
        pruefeViertelstunde("F7", "f7", "Viertelstunde 10:00–10:15", faktor);
        pruefeViertelstunde("F7", "f7", "Viertelstunde 10:15–10:30", faktor);
    }

    /** E4: ohne Deklaration wird der Höchstwert nicht geraten — beide Sprünge sind Rücksetzungen, keine Zahl dafür. */
    @Test
    void ohneDeklarationIstAuchDerUeberlaufEineRuecksetzung() {
        Map<String, Object> q = viertelstunde("F7O", "2026-10-20T10:00:00+02:00");
        assertThat(q.get("menge_zustand")).isEqualTo(VerbrauchRegeln.UNVOLLSTAENDIG);
        assertThat(kennzeichen(q)).containsExactly("Rücksetzung 10:03 ohne Endstand — bis zu 1 Kadenz nicht gezählt");
        // Gezählt ist nur, was gemessen ist: 10:00–10:02 und 10:03–10:15 — der Zuwachs über das
        // Bereichsende (767) fehlt und wird nicht geschätzt.
        assertThat((BigDecimal) q.get("menge")).isEqualByComparingTo(new BigDecimal(11505 - 767));
        pruefeGegenRegel("F7O", q, "2026-10-20T10:00:00+02:00", "2026-10-20T10:15:00+02:00");
    }

    // ======================================================= Z7 Neustart (F22, verlust_s)

    /** F22: der deklarierte Zählverlust (120 s) steht im Kennzeichen; die Zahl wird nie hochgerechnet. */
    @Test
    void f22NeustartMitBekanntemZaehlverlust() {
        pruefeViertelstunde("F22", "f22", "Viertelstunde 10:15–10:30", BigDecimal.ONE);
        pruefeTagGegenRegel("F22", LocalDate.of(2027, 5, 12));
        assertThat(kennzeichen(tag("F22", LocalDate.of(2027, 5, 12))))
                .contains("Neustart 10:22: bis zu 120 s Zählung möglicherweise verloren");
    }

    /** Ohne bekannten Zählverlust: „bis zu 255 s" (AP-05), dieselbe Menge, derselbe Zustand. */
    @Test
    void ohneBekanntenZaehlverlustSindEsBisZu255Sekunden() {
        Map<String, Object> q = viertelstunde("F22O", "2027-05-12T10:15:00+02:00");
        Map<String, Object> mit = viertelstunde("F22", "2027-05-12T10:15:00+02:00");
        assertThat((BigDecimal) q.get("menge")).isEqualByComparingTo((BigDecimal) mit.get("menge"));
        assertThat(q.get("menge_zustand")).isEqualTo(VerbrauchRegeln.UNVOLLSTAENDIG);
        assertThat(kennzeichen(q)).containsExactly(
                "Lücke 10:20–10:26: Zuwachs 6.400 gemessen, nicht auf Viertelstunden verteilbar",
                "Neustart 10:22: bis zu 255 s Zählung möglicherweise verloren");
    }

    // ================================================== Fortpflanzung bis zum Jahr

    /** Tag, Monat und Jahr tragen die Brüche: dieselbe Menge, derselbe Zustand, dieselben Kennzeichen wie die Regel. */
    @Test
    void dieBruechePflanzenSichBisInsJahrFort() {
        pruefeTagGegenRegel("F7", LocalDate.of(2026, 10, 20));
        Map<String, Object> tag = tag("F7", LocalDate.of(2026, 10, 20));
        assertThat(kennzeichen(tag)).contains("Überlauf 10:03 (Wertebereich 65536)",
                "Rücksetzung 10:20 ohne Endstand — bis zu 1 Kadenz nicht gezählt");
        pruefePeriodeGegenRegel("F7", "monat", LocalDate.of(2026, 10, 1), LocalDate.of(2026, 11, 1));
        pruefePeriodeGegenRegel("F7", "jahr", LocalDate.of(2026, 1, 1), LocalDate.of(2027, 1, 1));
        pruefePeriodeGegenRegel("F4", "monat", LocalDate.of(2026, 11, 1), LocalDate.of(2026, 12, 1));
        pruefePeriodeGegenRegel("F4", "jahr", LocalDate.of(2026, 1, 1), LocalDate.of(2027, 1, 1));
        pruefePeriodeGegenRegel("F5", "jahr", LocalDate.of(2026, 1, 1), LocalDate.of(2027, 1, 1));
        pruefePeriodeGegenRegel("F22", "monat", LocalDate.of(2027, 5, 1), LocalDate.of(2027, 6, 1));
        pruefePeriodeGegenRegel("F22", "jahr", LocalDate.of(2027, 1, 1), LocalDate.of(2028, 1, 1));
        assertThat(kennzeichen(periode("F4", "jahr", LocalDate.of(2026, 1, 1))))
                .contains("Gerätegrenze 10:40 mit Ablesestände");
        assertThat(kennzeichen(periode("F5", "jahr", LocalDate.of(2026, 1, 1))))
                .contains("Gerätegrenze 10:40 ohne Ablesestände", VerbrauchRegeln.ZUWACHS_NICHT_MESSBAR);
        assertThat(kennzeichen(periode("F7", "jahr", LocalDate.of(2026, 1, 1))))
                .contains("Überlauf 10:03 (Wertebereich 65536)");
        assertThat(kennzeichen(periode("F22", "jahr", LocalDate.of(2027, 1, 1))))
                .contains("Neustart 10:22: bis zu 120 s Zählung möglicherweise verloren");
    }

    // ================================================ Wiederholbar, abbruchsicher, Zaun

    @Test
    void derZweiteLaufSchreibtNichts() {
        assertThat(zweitesEintragen).as("ein schon eingetragener Bruch trägt nichts mehr ein").isZero();
        assertThat(zweiterLaufGeschrieben).isZero();
    }

    @Test
    void scheitertDasEintragenBleibtDerZeigerStehen() {
        assertThat(abbruchWarf).isTrue();
        assertThat(zeigerNachAbbruch).isEqualTo(zeigerVorAbbruch);
        assertThat(eintraegeNachAbbruch).as("der nächste Lauf holt es nach").isOne();
        assertThat(kennzeichen(abbruchNachher)).contains("Gerätegrenze 09:05 ohne Ablesestände");
    }

    /** Ein Neustart eines FREMDEN Kundenbereichs trägt nichts ein und landet in keiner fremden Periode. */
    @Test
    void einFremderBruchWirktNieUeberDenZaun() {
        assertThat(ereignisEintraegeFremd).isZero();
        assertThat(kennzeichen(viertelstunde("F22", "2027-05-12T10:15:00+02:00")))
                .filteredOn(k -> k.startsWith("Neustart ")).hasSize(1);
        TenantContext.clear();
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_viertelstunde", Integer.class)).isZero();
        TenantContext.set(FREMD);
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_viertelstunde WHERE tenant_id = ?",
                Integer.class, KB)).isZero();
        TenantContext.set(KB);
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_viertelstunde WHERE tenant_id = ?",
                Integer.class, KB)).isPositive();
    }

    @Test
    void dieMigrationLegtNurDanebenUndDerGanzeLaufLaesstDenBestandZeichengleich() {
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).as("nach der Migration")
                .isEmpty();
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachAllem)).as("nach allen Läufen")
                .isEmpty();
        assertThat(fingerVorher).hasSizeGreaterThan(100).containsKeys(BESTAND.toArray(String[]::new));
        assertThat(rohNachAllem).as("keine Rohzeile ändert sich").isEqualTo(rohVorher);
    }

    /** Der Vergleich beißt noch: eine geänderte Bestandszeile und eine neue Tabelle mit Inhalt fallen auf. */
    @Test
    void derBestandsvergleichFaengtEineGeaenderteZeile() {
        Bestandsschutz.mutationsprobe(root, AUSNAHMEN, "measurement_point",
                "UPDATE measurement_point SET label = label || ' (Probe)'");
        Bestandsschutz.inhaltsprobe(root, UemsZaehlerbruecheTest::rohwerteFinger, "device_measurement_sample",
                "UPDATE device_measurement_sample SET catalog_version = catalog_version || '.probe'");
    }

    /** Die Migration: `ereignis` ist ein Grund beider Arbeitslisten, und die Deklaration antwortet LEER. */
    @Test
    void dieMigrationWeitetDieArbeitslistenUndDieDeklarationIstOhneIp7Leer() {
        assertThat(root.queryForObject("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                + "WHERE conname = 'messreihe_viertelstunde_arbeit_grund_chk'", String.class))
                .contains("'eingang'", "'rueckrechnung'", "'ereignis'");
        assertThat(root.queryForObject("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                + "WHERE conname = 'messreihe_tag_arbeit_grund_chk'", String.class))
                .contains("'viertelstunde'", "'frist'", "'rueckrechnung'", "'ereignis'");
        // Die Deklaration hat genau EINE Signatur (IP-7 ersetzt nur den Rumpf), und für eine Reihe ohne
        // Deklaration antwortet sie leer — kein Überlauf, Neustart „bis zu 255 s" (F7O, F22O).
        assertThat(zahl("SELECT count(*) FROM pg_proc WHERE proname = 'messreihe_zaehler_deklaration'")).isOne();
        assertThat(zahl("SELECT count(*) FROM messreihe_zaehler_deklaration('" + KB + "', '" + IDS.get("F7O")
                + "', 'energy_kwh_f7o', now())")).isZero();
    }

    // ==================================================================== Vergleiche

    private static void pruefeViertelstunde(String reihe, String fall, String name, BigDecimal faktor) {
        JsonNode soll = erwartung(fall, name);
        Map<String, Object> z = viertelstunde(reihe, soll.path("von").asText());
        vergleiche(soll, z, faktor);
    }

    private static void vergleiche(JsonNode soll, Map<String, Object> z, BigDecimal faktor) {
        String was = soll.path("name").asText();
        BigDecimal menge = (BigDecimal) z.get("menge");
        VerbrauchVectorsTest.zahl(was + " · menge", soll.path("menge"),
                menge == null ? null : menge.multiply(faktor));
        assertThat(z.get("menge_zustand")).as(was + " · zustand").isEqualTo(soll.path("zustand").asText());
        assertThat(((Number) z.get("erhalten")).intValue()).as(was + " · erhalten")
                .isEqualTo(soll.path("erhalten").asInt());
        assertThat(((Number) z.get("erwartet")).intValue()).as(was + " · erwartet")
                .isEqualTo(soll.path("erwartet").asInt());
        assertThat(((Number) z.get("abdeckung_prozent")).intValue()).as(was + " · abdeckung")
                .isEqualTo(soll.path("abdeckung_prozent").asInt());
        assertThat(kennzeichen(z)).as(was + " · kennzeichen").isEqualTo(texte(soll.path("kennzeichen")));
    }

    /** Die Stunde ist keine gespeicherte Periode — der freie Zeitraum bildet sie aus den Viertelstunden. */
    private static void pruefeStunde(String reihe, String fall, String name) {
        JsonNode soll = erwartung(fall, name);
        TenantContext.set(KB);
        ZeitraumMenge.Zeitraum z = zeitraum.zeitraum(KB, IDS.get(reihe), kanal(reihe),
                VerbrauchRegeln.zeit(soll.path("von").asText()), VerbrauchRegeln.zeit(soll.path("bis").asText()), T0);
        Ergebnis e = z.menge().ergebnis();
        VerbrauchVectorsTest.zahl(name + " · menge", soll.path("menge"), e.menge());
        assertThat(e.zustand()).as(name + " · zustand").isEqualTo(soll.path("zustand").asText());
        assertThat(z.erhalten()).isEqualTo(soll.path("erhalten").asInt());
        assertThat(z.erwartet()).isEqualTo(soll.path("erwartet").asInt());
        assertThat(z.abdeckungProzent()).isEqualTo(soll.path("abdeckung_prozent").asInt());
        assertThat(e.kennzeichen()).as(name + " · kennzeichen").isEqualTo(texte(soll.path("kennzeichen")));
    }

    private static void pruefeTagGegenDatei(String reihe, String fall, LocalDate tag, String name) {
        JsonNode soll = erwartung(fall, name);
        Map<String, Object> t = tag(reihe, tag);
        VerbrauchVectorsTest.zahl(name + " · menge", soll.path("menge"), (BigDecimal) t.get("menge"));
        assertThat(t.get("menge_zustand")).as(name + " · zustand").isEqualTo(soll.path("zustand").asText());
        assertThat(kennzeichen(t)).as(name + " · kennzeichen").isEqualTo(texte(soll.path("kennzeichen")));
        pruefeTagGegenRegel(reihe, tag);
    }

    /** Die gespeicherte Tagesmenge ist die Regel über ALLE Rohwerte des Tages (AUFGERUFEN, nicht nachgerechnet). */
    private static void pruefeTagGegenRegel(String reihe, LocalDate tag) {
        Map<String, Object> t = tag(reihe, tag);
        pruefeGegenRegel(reihe, t, tag.atStartOfDay(ORT).toOffsetDateTime().toString(),
                tag.plusDays(1).atStartOfDay(ORT).toOffsetDateTime().toString());
    }

    private static void pruefePeriodeGegenRegel(String reihe, String art, LocalDate von, LocalDate bis) {
        Map<String, Object> p = periode(reihe, art, von);
        assertThat(p).as(reihe + " " + art + " " + von).isNotNull();
        pruefeGegenRegel(reihe, p, von.atStartOfDay(ORT).toOffsetDateTime().toString(),
                bis.atStartOfDay(ORT).toOffsetDateTime().toString());
    }

    private static void pruefeGegenRegel(String reihe, Map<String, Object> zeile, String von, String bis) {
        Deklaration d = DEKLARATION.getOrDefault(reihe, new Deklaration(null, null));
        Ergebnis soll = VerbrauchRegeln.mengeZaehlerstand(ROH.get(reihe), VerbrauchRegeln.zeit(von),
                VerbrauchRegeln.zeit(bis), KADENZ, EREIGNISSE.get(reihe), BigDecimal.ONE, d.modul(), d.hoechst());
        String was = reihe + " " + von + "–" + bis;
        assertThat((BigDecimal) zeile.get("menge")).as(was + " · menge").usingComparator(BigDecimal::compareTo)
                .isEqualTo(soll.menge());
        assertThat(zeile.get("menge_zustand")).as(was + " · zustand").isEqualTo(soll.zustand());
        assertThat(kennzeichen(zeile)).as(was + " · kennzeichen").isEqualTo(soll.kennzeichen());
    }

    private static JsonNode erwartung(String fall, String name) {
        for (JsonNode e : FAELLE.get(fall).path("expected")) {
            if (e.path("name").asText().equals(name)) {
                return e;
            }
        }
        throw new AssertionError("keine Erwartung " + fall + " " + name);
    }

    private static List<String> texte(JsonNode array) {
        List<String> aus = new ArrayList<>();
        array.forEach(n -> aus.add(n.asText()));
        return aus;
    }

    private static List<String> kennzeichen(Map<String, Object> zeile) {
        return ViertelstundenTeile.kennzeichen(zeile.get("kennzeichen") == null ? null
                : String.valueOf(zeile.get("kennzeichen")));
    }

    private static Map<String, Object> viertelstunde(String reihe, String beginn) {
        return root.queryForMap("SELECT * FROM messreihe_viertelstunde WHERE entity_id = ? AND intervall_beginn = ?",
                IDS.get(reihe), Timestamp.from(VerbrauchRegeln.zeit(beginn)));
    }

    private static Map<String, Object> tag(String reihe, LocalDate tag) {
        return root.queryForMap("SELECT * FROM messreihe_tag WHERE entity_id = ? AND tag = ?",
                IDS.get(reihe), java.sql.Date.valueOf(tag));
    }

    private static Map<String, Object> periode(String reihe, String art, LocalDate tag) {
        List<Map<String, Object>> z = root.queryForList(
                "SELECT * FROM messreihe_periode WHERE entity_id = ? AND art = ? AND tag = ?",
                IDS.get(reihe), art, java.sql.Date.valueOf(tag));
        return z.isEmpty() ? null : z.get(0);
    }

    private static int arbeit(String reihe) {
        return root.queryForObject("SELECT count(*) FROM messreihe_viertelstunde_arbeit WHERE entity_id = ? "
                + "AND grund = 'ereignis'", Integer.class, IDS.get(reihe));
    }

    private static Object zeiger() {
        return root.queryForObject("SELECT zeitpunkt FROM messreihe_viertelstunde_lauf WHERE schluessel = 'zeiger'",
                Timestamp.class);
    }

    // ============================================================= Die Beispielwelt

    /** Wertebereich und Höchstzuwachs (Z6) bzw. Zählverlust (Z7), wie der Test sie deklariert. */
    private record Deklaration(BigDecimal modul, BigDecimal hoechst) {}

    private static final Map<String, Deklaration> DEKLARATION = Map.of(
            "F7", new Deklaration(new BigDecimal("65536"), new BigDecimal("1667")));

    private static final String[] REIHEN = {"F4", "F5", "F6", "F7", "F7O", "F12", "F12E", "F22", "F22O", "GR", "AB"};

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
        IDS.put("AN1", uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-1') RETURNING id", KB));
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, DATE '2024-01-01')", KB, IDS.get("AN1"), IDS.get("ST"));
        IDS.put("BOX", uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, 'VP-BOX-HALLE-1', 'claimed') RETURNING id", KB, IDS.get("AN1")));
        for (String r : REIHEN) {
            IDS.put(r, reihe(r));
        }
        // Die Datenquellen der Neustart-Reihen (die Box meldet device_restart je Datenquelle).
        for (String r : new String[] {"F22", "F22O"}) {
            IDS.put("DQ-" + r, uuid("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, adresse, "
                    + "kadenz_s) VALUES (?, ?, ?, 'modbus_tcp', '10.0.1.10:502', 60) RETURNING id",
                    KB, IDS.get("AN1"), "DQ-" + r));
            root.update("UPDATE measurement_point SET data_source_id = ? WHERE id = ?", IDS.get("DQ-" + r), IDS.get(r));
        }
        // Der fremde Kundenbereich braucht nur sich selbst: sein Neustart darf nirgends wirken.
        IDS.put("AN-F", uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'B-1') RETURNING id", FREMD));
    }

    private static String kanal(String reihe) {
        return "energy_kwh_" + reihe.toLowerCase();
    }

    private static UUID reihe(String name) {
        UUID entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, "
                + "communication, connection_json, created_at) VALUES (?, ?, 'grid-meter', ?, 'grid-meter', ?, "
                + "'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, '2024-03-12T00:00:00Z') RETURNING id",
                KB, IDS.get("AN1"), name, IDS.get("BOX"));
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, "
                + "'2024-03-12T00:00:00Z', '2026.09.11.1', 'test', 'pending_edge', 'live_power', 'fifteen_minute')",
                KB, IDS.get("AN1"), IDS.get("BOX"), entity, kanal(name));
        return entity;
    }

    /** Die Rohwerte der Vektor-Fälle — Zeichen für Zeichen die Eingänge der Datei. */
    private static void rohwerte() {
        String[][] quelle = {{"F4", "f4"}, {"F5", "f5"}, {"F6", "f6"}, {"F7", "f7"}, {"F7O", "f7"}, {"F12", "f12"},
            {"F22", "f22"}, {"F22O", "f22"}, {"AB", "f6"}};
        for (String[] q : quelle) {
            ROH.put(q[0], VerbrauchVectorsTest.rohwerte(FAELLE.get(q[1]).path("input").path("reihe")));
        }
        // F12E: dieselbe Rücksetzung einen Monat früher — sie ist endgültig, wenn der Endstand kommt.
        ROH.put("F12E", ROH.get("F12").stream()
                .map(r -> new Rohwert(r.zeit().minus(Duration.ofDays(30)), r.wert())).toList());
        // GR: Zählerwechsel GENAU um 10:45 — der alte zählt bis 10:44 (544), der neue ab 10:45 bei 0.
        List<Rohwert> gr = new ArrayList<>();
        Instant t = VerbrauchRegeln.zeit("2026-11-19T10:00:00+01:00");
        for (int i = 0; i <= 60; i++) {
            gr.add(new Rohwert(t.plusSeconds(60L * i), i < 45 ? new BigDecimal(500 + i) : new BigDecimal(i - 45)));
        }
        ROH.put("GR", gr);
        ROH.forEach((r, werte) -> saeen(r, werte));
    }

    private static final String ROH_SQL =
            "INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, point_key, "
                    + "raw_numeric, quality, catalog_version, edge_sequence, aggregation_kind, entity_id, "
                    + "applied_revision, value_kind, role, delivery, delay_s) VALUES (?, ?, ?, ?, ?, ?, ?, 'good', "
                    + "'2026.09.11.1', ?, 'counter', ?, 3, 'counter', 'fuehrend', 'direkt', 2)";

    private static void saeen(String reihe, List<Rohwert> werte) {
        List<Object[]> stapel = new ArrayList<>();
        for (Rohwert r : werte) {
            stapel.add(new Object[] {Timestamp.from(r.zeit()), Timestamp.from(r.zeit().plusSeconds(2)), KB,
                IDS.get("AN1"), IDS.get("BOX"), kanal(reihe), r.wert(), r.zeit().getEpochSecond(), IDS.get(reihe)});
        }
        root.batchUpdate(ROH_SQL, stapel);
    }

    /** Die Ereignisse eines Falls, wie die Regel sie bekommt (F12: samt dem Nachtrag der Version 2). */
    private static List<Ereignis> ereignisseDerDatei(String fall, Long verlust) {
        JsonNode f = FAELLE.get(fall);
        List<Ereignis> aus = new ArrayList<>(VerbrauchVectorsTest.ereignisse(f.path("input").path("reihe").path("ereignisse")));
        f.path("expected").forEach(e -> aus.addAll(VerbrauchVectorsTest.ereignisse(e.path("ereignisse_zusatz"))));
        return aus.stream().map(e -> verlust == null ? e : new Ereignis(e.art(), e.zeit(), e.uhrzeit(),
                e.endstand(), e.anfangsstand(), verlust)).toList();
    }

    /** Die Tür von AP-08 IP-7: F7 hat Wertebereich + Höchstzuwachs, F22 einen Neustart-Verlust von 120 s. */
    private static void deklarieren() {
        root.execute("CREATE OR REPLACE FUNCTION messreihe_zaehler_deklaration(p_tenant UUID, p_entity UUID, "
                + "p_messkanal TEXT, p_zeit TIMESTAMPTZ) RETURNS TABLE (wertebereich_modul NUMERIC, "
                + "hoechstzuwachs_je_kadenz NUMERIC, kadenz_s INTEGER, neustart_verlust_s INTEGER) "
                + "LANGUAGE sql STABLE PARALLEL SAFE AS $$ "
                + "SELECT 65536.000::numeric, 1667::numeric, 60, NULL::integer WHERE p_entity = '" + IDS.get("F7") + "' "
                + "UNION ALL SELECT NULL::numeric, NULL::numeric, NULL::integer, 120 WHERE p_entity = '"
                + IDS.get("F22") + "' $$");
    }

    private static void grenze(UUID tenant, String reihe, String zeit, BigDecimal endstand, BigDecimal anfangsstand,
            Instant eingang) {
        StringBuilder nutzlast = new StringBuilder("{\"anlass\":\"zaehlerwechsel\",\"einbau_alt\":\"Z-alt\","
                + "\"einbau_neu\":\"Z-neu\",\"eingetragen_am\":\"" + VerbrauchRegeln.zeit(zeit) + "\"");
        if (endstand != null) {
            nutzlast.append(",\"endstand\":").append(endstand.toPlainString())
                    .append(",\"anfangsstand\":").append(anfangsstand.toPlainString());
        }
        nutzlast.append('}');
        root.update("INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, site_id, kennungen, "
                + "entity_id, messkanal, nutzlast, eingang) VALUES (?, ?, gen_random_uuid(), 'device_boundary', 'kunde', "
                + "?, jsonb_build_object('komponente', ?::text), ?, ?, ?::jsonb, coalesce(?, now()))",
                Timestamp.from(VerbrauchRegeln.zeit(zeit)), tenant, IDS.get("AN1"), IDS.get(reihe).toString(),
                IDS.get(reihe), kanal(reihe), nutzlast.toString(), eingang == null ? null : Timestamp.from(eingang));
    }

    private static void neustart(UUID tenant, UUID quelle, String zeit, Instant eingang) {
        root.update("INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, site_id, kennungen, "
                + "data_source_id, nutzlast, eingang) VALUES (?, ?, gen_random_uuid(), 'device_restart', 'box', ?, "
                + "jsonb_build_object('box', 'E-1', 'datenquelle', ?::text), ?, '{}'::jsonb, coalesce(?, now()))",
                Timestamp.from(VerbrauchRegeln.zeit(zeit)), tenant, tenant.equals(KB) ? IDS.get("AN1") : IDS.get("AN-F"),
                quelle.toString(), quelle, eingang == null ? null : Timestamp.from(eingang));
    }

    // ================================================================== Die Läufe

    private static void arbeitFuellen() {
        root.update("""
                INSERT INTO messreihe_viertelstunde_arbeit (tenant_id, entity_id, messkanal, intervall_beginn, grund)
                SELECT DISTINCT s.tenant_id, s.entity_id, s.point_key,
                       to_timestamp(floor(extract(epoch FROM s.time) / 900) * 900), 'eingang'
                  FROM device_measurement_sample s
                 WHERE s.entity_id IS NOT NULL AND s.role IS DISTINCT FROM 'spiegel'
                ON CONFLICT DO NOTHING
                """);
    }

    private static void tagArbeitFuellen() {
        root.update("""
                INSERT INTO messreihe_tag_arbeit (tenant_id, entity_id, messkanal, utc_tag, grund)
                SELECT DISTINCT v.tenant_id, v.entity_id, v.messkanal,
                       (v.intervall_beginn AT TIME ZONE 'UTC')::date, 'viertelstunde'
                  FROM messreihe_viertelstunde v
                ON CONFLICT DO NOTHING
                """);
    }

    private static int verdichtenBisLeer(Instant jetzt) {
        int geschrieben = 0;
        while (true) {
            int[] r = verdichter.verdichteEinenStapel(jetzt);
            if (r[0] == 0) {
                return geschrieben;
            }
            geschrieben += r[1];
        }
    }

    private static void tagLaufBisLeer(Instant jetzt) {
        while (tage.bildeEinenStapel(jetzt)[0] > 0) {
            // weiter, bis die Liste leer ist
        }
    }

    private static void periodenLaufBisLeer(Instant jetzt) {
        while (perioden.bildeEinenStapel(jetzt)[0] > 0) {
            // weiter, bis die Liste leer ist
        }
    }

    // ===================================================================== Helfer

    private static UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
    }

    private static int zahl(String sql) {
        return root.queryForObject(sql, Integer.class);
    }

    private static Map<String, String> fingerabdruck() {
        return Bestandsschutz.fingerabdruck(root, AUSNAHMEN);
    }

    private static String rohwerteFinger() {
        return Bestandsschutz.inhalt(root, "device_measurement_sample", null);
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
