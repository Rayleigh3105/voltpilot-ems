package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
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
 * Die Migration {@code V20260912190000} und die ENDGÜLTIGKEIT samt TAGESKLASSE (UEMS AP-07 IP-13)
 * gegen eine echte TimescaleDB — die Stelle, an der ein Viertelstundenwert ein VERSPRECHEN wird.
 *
 * <p><b>Der eine Satz, den dieser Test beweist:</b> ein endgültiger Wert ändert sich nie hinter
 * dem Rücken des Kunden, und ein zu spät eintreffender Messwert verschwindet trotzdem nicht.
 * <i>Speichern, melden, vorschlagen — nicht anwenden.</i>
 *
 * <p><b>Die Fälle des Konzepts:</b>
 *
 * <ul>
 *   <li><b>A4</b> (Nachlieferung nach Endgültigkeit): MS-10, 03.11.2026 14:00–14:15 ist seit dem
 *       10.11. endgültig; am 12.11. 09:02 kommt der Puffer der reparierten Box. Die Rohwerte
 *       werden gespeichert, der Viertelstundenwert bleibt ZEICHEN FÜR ZEICHEN stehen, es entsteht
 *       ein {@code late_arrival} und ein Eintrag in der Korrektur-Liste.
 *   <li><b>A8</b> (Datenstand): der Oktober 2026, Jahre später gelesen — jede Viertelstunde
 *       endgültig, Version 1, nicht nachgeliefert, ohne {@code late_arrival}, mit Herkunft,
 *       Abdeckung und Qualitätszählern; der Tageswert nennt seine Zeitzone und seine Grenze.
 *   <li><b>Die Zeitumstellung</b>: der 25.10.2026 hat <b>100</b> Viertelstunden, der 28.03.2027
 *       <b>92</b> — gerechnet von der Verbrauchsregel (AP-08 IP-1), nicht von diesem Paket.
 * </ul>
 *
 * <p><b>Was dieser Test NICHT prüft, weil das Paket es nicht baut:</b> die versionierte Korrektur
 * aus einem Vorschlag (AP-08 IP-12 ff. — hier entsteht nur die Liste), die Tages- und
 * Monatsmengen aus den Periodenständen (AP-08 IP-5 — die Tagesklasse trägt darum weder
 * {@code menge} noch {@code summe}) und jeden Lesepfad (IP-14).
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsEndgueltigkeitTagesklasseTest {

    private static final String DIESE = "20260912190000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final UUID KB = UUID.fromString("4e0e0000-0000-0000-0000-000000000001");
    private static final UUID FREMD = UUID.fromString("4e0e0000-0000-0000-0000-000000000002");

    private static final String FERTIG = "fertig";

    /** Die Uhr der ERSTEN Bildung: nach dem 12.11. — der November-Stoff ist damit fällig. */
    private static final Instant T_NOV = Instant.parse("2026-11-12T09:00:00Z");

    /** Und die Uhr nach dem 23-Stunden-Tag: der 28.03.2027 ist am 04.04. endgültig. */
    private static final Instant T_APR = Instant.parse("2027-04-10T09:00:00Z");

    /** Das Intervall von A4: 03.11.2026 14:00–14:15 Ortszeit. */
    private static final Instant A4_BEGINN = Instant.parse("2026-11-03T13:00:00Z");

    /** Seine Frist (E5): Intervallende + 7 Tage. */
    private static final Instant A4_FRIST = Instant.parse("2026-11-10T13:15:00Z");

    /** Und der Augenblick, in dem der Puffer der reparierten Box eintrifft (§4.8). */
    private static final Instant A4_NACHZUEGLER = Instant.parse("2026-11-12T08:02:00Z");

    /**
     * Die Tabellen, die im Fingerabdruck vorkommen MÜSSEN — nach dem Muster aus PR 698/700.
     * Gemessen wird darüber hinaus JEDE Tabelle des Schemas (siehe {@link #fingerabdruck()}).
     */
    private static final List<String> BESTAND = List.of(
            "device_measurement_event",
            "device_measurement_rollup_5m", "device_measurement_rollup_15m",
            "device_measurement_selection", "measurement_point", "messstelle", "geraet",
            "standort", "unternehmen", "anlage_standort", "telemetry", "telemetry_v2",
            "schedule", "site_supply_price", "entity_registry_state", "device_command_log");

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
    private static EndgueltigkeitLauf endgueltigkeit;
    private static TagVerdichter tage;

    private static final Map<String, UUID> IDS = new LinkedHashMap<>();

    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;
    private static Map<String, String> fingerNachAllem;

    private static int umgeschaltetNovember;
    private static int umgeschaltetZweitesMal;
    private static Map<String, Object> a4Vorher;
    private static Map<String, Object> a4Nachher;
    private static int spaetankuenfte;
    private static int spaetankuenfteZweitesMal;
    private static TagVerdichter.Lauf tagLaufNovember;
    private static int tagGeschriebenZweitesMal;
    private static boolean abbruchWarf;
    private static int tagArbeitNachAbbruch;
    private static boolean rueckrechnungFertig;
    private static int ausZeiger;
    private static Map<String, Object> offenVorher;
    private static Map<String, Object> offenTagVorher;
    private static String rohVorher;
    private static String rohNachAllem;

    // =========================================================================== Aufbau

    @BeforeAll
    static void bauenUndFahren() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();

        stammdaten();
        rohwerte();
        fingerVorher = fingerabdruck();
        rohVorher = rohwerteFinger();

        flyway().target(DIESE).load().migrate();
        fingerNachMigration = fingerabdruck();
        flyway().load().migrate();

        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        verdichter = new ViertelstundeVerdichter(admin, new MeasurementCatalog(new ObjectMapper()),
                new SpaetankunftMelder(), 500, 40, 200_000);
        endgueltigkeit = new EndgueltigkeitLauf(admin, 2000, 200);
        tage = new TagVerdichter(admin, 200, 40, 20_000, 200_000);

        // ---- 1. Die Viertelstunden bilden (alles, was bis hierher gesät ist) -------------
        arbeitFuellen();
        verdichtenBisLeer(T_NOV);

        // ---- 2. Der STUNDENLAUF: was fällig ist, wird endgültig --------------------------
        umgeschaltetNovember = endgueltigkeit.umschalten(T_NOV);
        // … und ein zweiter Lauf unmittelbar danach findet nichts mehr (Idempotenz).
        umgeschaltetZweitesMal = endgueltigkeit.umschalten(T_NOV);

        // ---- 3. Der TAGESLAUF, über seine EIGENEN Quellen ---------------------------------
        // Erst der Zeiger-Durchgang (der erste Lauf setzt den Zeiger nur), dann die einmalige
        // Rückrechnung — beide füllen die Arbeitsliste, gebildet wird daraus.
        tage.lauf(T_NOV);
        tage.rueckrechnenGanz(T_NOV, 200);
        rueckrechnungFertig = FERTIG.equals(tage.stand("rueckrechnung").notiz());
        tagLaufNovember = tagLaufBisLeer(T_NOV);

        // Und der Zeiger-Durchgang allein, eine Viertelstunde später: er findet die Zeilen,
        // die der Verdichtungs-Lauf geschrieben hat (er fragt `berechnet_am`).
        ausZeiger = tage.eintragenAusViertelstunden(T_NOV.plus(Duration.ofMinutes(15)));
        tagLaufBisLeer(T_NOV);

        // ---- 4. Festhalten, was NOCH NICHT fällig ist ------------------------------------
        offenVorher = eineVsZeile(IDS.get("OFFEN"), "energy_kwh_offen",
                Instant.parse("2026-11-11T13:00:00Z"));
        offenTagVorher = einTag(IDS.get("OFFEN"), "energy_kwh_offen", LocalDate.of(2026, 11, 11));

        // ---- 5. Wiederholbarkeit des Tageslaufs ------------------------------------------
        tagArbeitFuellenAus(Instant.parse("2026-10-01T00:00:00Z"),
                Instant.parse("2026-12-01T00:00:00Z"));
        tagGeschriebenZweitesMal = tagLaufBisLeer(T_NOV).geschrieben();

        // ---- 6. A4: der Puffer der reparierten Box kommt am 12.11. 09:02 -----------------
        a4Vorher = eineVsZeile(IDS.get("MS10"), "energy_kwh_ms10", A4_BEGINN);
        nachzuegler();
        arbeitFuellen();
        spaetankuenfte = verdichtenBisLeer(T_NOV).spaetankuenfte();
        a4Nachher = eineVsZeile(IDS.get("MS10"), "energy_kwh_ms10", A4_BEGINN);

        // … und noch einmal: dieselben Nachzügler legen keine zweite Meldung an.
        arbeitFuellen();
        spaetankuenfteZweitesMal = verdichtenBisLeer(T_NOV).spaetankuenfte();

        // ---- 7. Der 23-Stunden-Tag wird erst im April fällig -----------------------------
        endgueltigkeit.umschalten(T_APR);
        tagArbeitFuellenAus(Instant.parse("2027-03-27T00:00:00Z"),
                Instant.parse("2027-03-30T00:00:00Z"));
        tagLaufBisLeer(T_APR);

        // ---- 8. Abbruchsicherheit: das Schreiben der Tagesklasse scheitert ---------------
        tagArbeitFuellenAus(Instant.parse("2027-03-27T00:00:00Z"),
                Instant.parse("2027-03-30T00:00:00Z"));
        root.execute("REVOKE INSERT ON messreihe_tag FROM " + ADMIN_USER);
        try {
            tage.bildeEinenStapel(T_APR);
            abbruchWarf = false;
        } catch (RuntimeException e) {
            abbruchWarf = true;
        }
        tagArbeitNachAbbruch = zahl("SELECT count(*) FROM messreihe_tag_arbeit");
        root.execute("GRANT INSERT ON messreihe_tag TO " + ADMIN_USER);
        tagLaufBisLeer(T_APR);

        fingerNachAllem = fingerabdruck();
        rohNachAllem = rohwerteFinger();
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ================================================================ Die Migration

    /** Die Migration legt NUR daneben, und der ganze Lauf lässt den Bestand zeichengleich. */
    @Test
    void dieMigrationLegtNurDanebenUndDerGanzeLaufLaesstDenBestandZeichengleich() {
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).as("nach der Migration")
                .isEmpty();
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachAllem)).as("nach allen Läufen")
                .isEmpty();
        assertThat(fingerVorher).as("gemessen wird jede Tabelle des Schemas")
                .hasSizeGreaterThan(100)
                .containsKeys(BESTAND.toArray(String[]::new));
        assertThat(rohNachAllem)
                .as("und keine bestehende Rohzeile ändert sich — die Spätankunft SPEICHERT nur")
                .isEqualTo(rohVorher);
    }

    /** Der Vergleich beißt noch: eine geänderte Bestandszeile und eine neue Tabelle mit Inhalt fallen auf. */
    @Test
    void derBestandsvergleichFaengtEineGeaenderteZeile() {
        Bestandsschutz.mutationsprobe(root, AUSNAHMEN, "measurement_point",
                "UPDATE measurement_point SET label = label || ' (Probe)'");
    }

    /** Die Tagesklasse ist eine Hypertable mit RLS + FORCE und ohne Kompression (E7). */
    @Test
    void dieTagesklasseIstEineRlsHypertableOhneKompression() {
        assertThat(zahl("SELECT count(*) FROM timescaledb_information.hypertables "
                + "WHERE hypertable_name = 'messreihe_tag'")).isOne();
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity "
                + "FROM pg_class WHERE relname = 'messreihe_tag'", Boolean.class)).isTrue();
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity "
                + "FROM pg_class WHERE relname = 'messreihe_korrektur_vorschlag'", Boolean.class))
                .isTrue();
        // Die App-Rolle LIEST nur; geschrieben wird über die BYPASSRLS-Rolle.
        assertThat(rechte(APP_USER, "messreihe_tag")).containsExactly("SELECT");
        assertThat(rechte(APP_USER, "messreihe_korrektur_vorschlag")).containsExactly("SELECT");
        assertThat(rechte(APP_USER, "messreihe_tag_arbeit")).isEmpty();
        assertThat(rechte(APP_USER, "messreihe_tag_lauf")).isEmpty();
        // Und der Lauf darf melden — die EINE Weitung an einem bestehenden Recht.
        assertThat(rechte(ADMIN_USER, "messreihe_ereignis"))
                .as("append-only bleibt: INSERT und DELETE, nie UPDATE")
                .containsExactlyInAnyOrder("SELECT", "INSERT", "DELETE");
    }

    /** Die Datenbankgrenze hält die Hausregeln — nicht nur der Java-Code. */
    @Test
    void dieDatenbankgrenzeWeistDasErfundeneAb() {
        // Ein Tag hat 23, 24 oder 25 Stunden — nichts dazwischen.
        assertThatThrownBy(() -> tagEinfuegen("stunden", "26", "slots_erwartet", "104"))
                .hasMessageContaining("grenze_chk");
        // … und genau vier Slots je Stunde.
        assertThatThrownBy(() -> tagEinfuegen("slots_erwartet", "96", "stunden", "25"))
                .hasMessageContaining("grenze_chk");
        // Eine fremde Zeitzone wird VERWORFEN, nie aufgelöst.
        assertThatThrownBy(() -> tagEinfuegen("zeitzone", "'America/New_York'"))
                .hasMessageContaining("zeitzone_chk");
        // Eine Zeitzone ohne Herkunft gibt es nicht.
        assertThatThrownBy(() -> tagEinfuegen("zeitzone_herkunft", "'geraten'"))
                .hasMessageContaining("zeitzone_chk");
        // Ein endgültiger Tag hat keine offene Viertelstunde mehr.
        assertThatThrownBy(() -> tagEinfuegen("zustand", "'endgueltig'",
                "slots_vorhanden", "10", "slots_endgueltig", "9"))
                .hasMessageContaining("zustand_chk");
        // Die Abdeckung wird nie auf 100 % gerundet.
        assertThatThrownBy(() -> tagEinfuegen("abdeckung_prozent", "100",
                "erhalten", "5", "erwartet", "96"))
                .hasMessageContaining("abdeckung_chk");
    }

    /**
     * Die Tagesklasse trägt KEINE Summe der Viertelstunden-Mengen — und ihre Menge kam nicht mit dieser
     * Migration, sondern mit AP-08 IP-5 ({@code V20260912205000}), aus den Periodenständen gebildet. Die
     * Spalte {@code summe} (AP-08 IP-3) ist die Summe der guten MOMENTANWERTE; an einer Zählerreihe
     * weist die Datenbank sie ab.
     */
    @Test
    void dieTagesklasseTraegtKeineSummeUndIhreMengeKommtAusIp5() {
        List<String> spalten = root.queryForList("SELECT column_name FROM information_schema.columns "
                + "WHERE table_name = 'messreihe_tag' ORDER BY column_name", String.class);
        assertThatThrownBy(() -> root.update("UPDATE messreihe_tag SET summe = 1 WHERE wertart = 'counter'"))
                .as("eine Summe der Viertelstunden-Mengen gibt es nie").hasMessageContaining("summe_chk");
        assertThat(spalten)
                .as("einen Faktor gibt es nur an der Viertelstunde")
                .doesNotContain("faktor")
                .as("die Menge bildet AP-08 IP-5 aus den Periodenständen")
                .contains("menge", "menge_zustand", "kennzeichen", "kadenz_s")
                .as("die FAKTEN, aus denen IP-5 sie bildet, stehen da")
                .contains("stand_anfang", "stand_anfang_zeit", "stand_ende", "stand_ende_zeit",
                        "slots_erwartet", "slots_vorhanden", "slots_endgueltig", "zeitzone",
                        "zeitzone_herkunft", "beginn", "ende", "stunden");
    }

    // ============================================================== Der Stundenlauf

    /**
     * Der Stundenlauf schaltet um, was fällig ist — und ist danach still: ein zweiter Lauf
     * unmittelbar hinterher schreibt NICHTS (Idempotenz).
     */
    @Test
    void derStundenlaufIstIdempotent() {
        assertThat(umgeschaltetNovember).as("es gab Fälliges").isPositive();
        assertThat(umgeschaltetZweitesMal).as("und beim zweiten Mal nichts mehr").isZero();
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde "
                + "WHERE zustand = 'vorlaeufig' AND endgueltig_ab <= '" + T_NOV + "'"))
                .as("keine fällige Zeile bleibt vorläufig").isZero();
    }

    /**
     * Er fasst NIE an, was schon endgültig ist, und er fasst nie einen Wert an: {@code
     * berechnet_am} und jede Zahl der Zeile bleiben stehen. Geändert wird genau ein Wort.
     */
    @Test
    void derStundenlaufAendertGenauEinWort() {
        Map<String, Object> z = eineVsZeile(IDS.get("OKT"), "energy_kwh_okt",
                Instant.parse("2026-10-19T08:00:00Z"));
        assertThat(z.get("zustand")).isEqualTo("endgueltig");
        assertThat(z.get("version")).isEqualTo(1);
        assertThat(((Timestamp) z.get("berechnet_am")).toInstant())
                .as("nicht neu berechnet — nur niedergeschrieben").isEqualTo(T_NOV);
    }

    /** Was noch nicht fällig ist, bleibt vorläufig — die Frist ist auf die Sekunde genau. */
    @Test
    void wasNichtFaelligIstBleibtVorlaeufig() {
        assertThat(endgueltigkeit.umschalten(A4_FRIST.minusSeconds(1)))
                .as("eine Sekunde vor der Frist ist nichts fällig, was es nicht schon war")
                .isZero();
    }

    // ================================================================ A4: Spätankunft

    /**
     * <b>A4.</b> Der endgültige Viertelstundenwert bleibt ZEICHEN FÜR ZEICHEN stehen, obwohl 12
     * Rohwerte für sein Intervall nachgeliefert wurden. Das ist das Versprechen von E5.
     */
    @Test
    void a4EinEndgueltigerWertBleibtBeiNachlieferungUnveraendert() {
        assertThat(a4Vorher).isNotNull();
        assertThat(a4Vorher.get("zustand")).isEqualTo("endgueltig");
        assertThat(a4Nachher).as("Zeichen für Zeichen dieselbe Zeile").isEqualTo(a4Vorher);
        assertThat(a4Nachher.get("erhalten")).as("drei Werte waren da, drei bleiben es")
                .isEqualTo(3);
        assertThat(a4Nachher.get("version")).as("eine Korrektur macht AP-08, nicht dieser Lauf")
                .isEqualTo(1);
    }

    /** <b>A4.</b> Der zu späte Rohwert ist trotzdem GESPEICHERT — er verschwindet nie. */
    @Test
    void a4DerZuSpaeteRohwertBleibtGespeichert() {
        assertThat(zahl("SELECT count(*) FROM device_measurement_sample "
                + "WHERE entity_id = '" + IDS.get("MS10") + "' AND point_key = 'energy_kwh_ms10' "
                + "AND received_at > '" + A4_FRIST + "'"))
                .as("die 12 Nachzügler stehen in der Rohtabelle").isEqualTo(12);
    }

    /** <b>A4.</b> Er wird GEMELDET: {@code late_arrival}, Urheber {@code cloud}, mit Zählung. */
    @Test
    void a4DerZuSpaeteRohwertWirdGemeldet() {
        List<Map<String, Object>> meldungen = admin.queryForList(
                "SELECT * FROM messreihe_ereignis WHERE art = 'late_arrival' ORDER BY zeit");
        assertThat(meldungen).hasSize(1);
        Map<String, Object> m = meldungen.get(0);
        assertThat(m.get("urheber")).as("den Lauf fährt die api — Weg 2 heißt dort cloud")
                .isEqualTo("cloud");
        assertThat(((Timestamp) m.get("von")).toInstant()).isEqualTo(A4_BEGINN);
        assertThat(((Timestamp) m.get("bis")).toInstant())
                .isEqualTo(A4_BEGINN.plus(Duration.ofMinutes(15)));
        assertThat(m.get("entity_id")).isEqualTo(IDS.get("MS10"));
        assertThat(m.get("messkanal")).isEqualTo("energy_kwh_ms10");
        assertThat(m.get("nutzlast").toString())
                .contains("\"anzahl\": 12")
                .contains("\"eingangszeit\": \"2026-11-12T08:02:00Z\"");
    }

    /** <b>A4.</b> Und er wird VORGESCHLAGEN — die Liste, aus der AP-08 eine Korrektur macht. */
    @Test
    void a4DerZuSpaeteRohwertLandetInDerKorrekturListe() {
        List<Map<String, Object>> liste = admin.queryForList(
                "SELECT * FROM messreihe_korrektur_vorschlag");
        assertThat(liste).hasSize(1);
        Map<String, Object> v = liste.get(0);
        assertThat(v.get("grund")).isEqualTo("nachlieferung_nach_endgueltigkeit");
        assertThat(v.get("zustand")).as("AP-07 schreibt nur `offen`").isEqualTo("offen");
        assertThat(v.get("anzahl")).isEqualTo(12);
        assertThat(((Timestamp) v.get("intervall_beginn")).toInstant()).isEqualTo(A4_BEGINN);
        assertThat(((Timestamp) v.get("endgueltig_ab")).toInstant()).isEqualTo(A4_FRIST);
        assertThat(((Timestamp) v.get("letzte_eingangszeit")).toInstant())
                .isEqualTo(A4_NACHZUEGLER);
        assertThat(v.get("version_bezug")).as("der Vorschlag nennt die Fassung, die er meint")
                .isEqualTo(1);
        assertThat(v.get("ereignis_id")).as("Vorschlag und Meldung zeigen aufeinander")
                .isEqualTo(admin.queryForObject("SELECT ereignis_id FROM messreihe_ereignis "
                        + "WHERE art = 'late_arrival'", UUID.class));
        assertThat(spaetankuenfte).isOne();
    }

    /** <b>A4.</b> Ein zweiter Lauf über dieselben Nachzügler meldet NICHT noch einmal. */
    @Test
    void a4DieMeldungWiederholtSichNicht() {
        assertThat(spaetankuenfteZweitesMal)
                .as("gemeldet wird die Spätankunft weiterhin — sie ist ja noch da").isOne();
        assertThat(zahl("SELECT count(*) FROM messreihe_ereignis WHERE art = 'late_arrival'"))
                .as("aber es entsteht keine zweite Zeile: die Kennung ist abgeleitet").isOne();
        assertThat(zahl("SELECT count(*) FROM messreihe_korrektur_vorschlag"))
                .as("und kein zweiter Vorschlag").isOne();
    }

    /**
     * <b>A4.</b> Ein Intervall, das noch nicht fällig ist, wird von einer Nachlieferung sehr wohl
     * neu gerechnet — genau das ist der Unterschied, den E5 macht.
     */
    @Test
    void vorDerFristRechnetEineNachlieferungNochNeu() {
        // Die Momentaufnahme vom 12.11. — später (im April) ist auch dieses Intervall fällig.
        Map<String, Object> z = offenVorher;
        assertThat(z.get("zustand")).isEqualTo("vorlaeufig");
        assertThat(z.get("erhalten")).as("der nachgelieferte Wert ist mitgezählt").isEqualTo(4);
        assertThat(z.get("n_nachgeliefert")).isEqualTo(1);
        assertThat(zahl("SELECT count(*) FROM messreihe_korrektur_vorschlag "
                + "WHERE entity_id = '" + IDS.get("OFFEN") + "'"))
                .as("und es gibt keinen Vorschlag — es war ja nichts zu spät").isZero();
    }

    // ========================================================== A8: der Datenstand

    /**
     * <b>A8.</b> Der Oktober 2026, Jahre später gelesen: jede Viertelstunde ist endgültig,
     * Version 1, nicht nachgeliefert, und es gibt für den Oktober KEINE {@code late_arrival}.
     */
    @Test
    void a8DerOktoberIstEndgueltigUndReproduzierbar() {
        List<Map<String, Object>> okt = admin.queryForList(
                "SELECT * FROM messreihe_viertelstunde WHERE entity_id = ? AND messkanal = ? "
                        + "ORDER BY intervall_beginn", IDS.get("OKT"), "energy_kwh_okt");
        assertThat(okt).isNotEmpty();
        for (Map<String, Object> z : okt) {
            assertThat(z.get("zustand")).as(String.valueOf(z.get("intervall_beginn")))
                    .isEqualTo("endgueltig");
            assertThat(z.get("version")).isEqualTo(1);
            assertThat(z.get("n_nachgeliefert")).isEqualTo(0);
            assertThat(z.get("zustellart")).isEqualTo("direkt");
            // Herkunft, Abdeckung und Qualität sind da — das ist der Nachweis von A8.
            assertThat(z.get("box")).isNotNull();
            assertThat(z.get("katalog")).isNotNull();
            assertThat(z.get("rolle")).isEqualTo("fuehrend");
            assertThat(z.get("erwartet")).isEqualTo(15);
            assertThat(z.get("n_good")).isEqualTo(z.get("erhalten"));
        }
        assertThat(zahl("SELECT count(*) FROM messreihe_ereignis WHERE art = 'late_arrival' "
                + "AND von >= '2026-10-01' AND von < '2026-11-01'"))
                .as("für den Oktober gibt es keine Spätankunft").isZero();
    }

    /** <b>A8.</b> Und der Tageswert nennt die Grenze, mit der er gebildet wurde. */
    @Test
    void a8DerTageswertNenntSeineGrenzeUndSeineZeitzone() {
        Map<String, Object> t = einTag(IDS.get("OKT"), "energy_kwh_okt", LocalDate.of(2026, 10, 19));
        assertThat(t.get("zeitzone")).isEqualTo("Europe/Berlin");
        assertThat(t.get("zeitzone_herkunft")).as("aus dem STANDORT, nicht geraten")
                .isEqualTo("standort");
        assertThat(((Timestamp) t.get("beginn")).toInstant())
                .isEqualTo(Instant.parse("2026-10-18T22:00:00Z"));
        assertThat(((Timestamp) t.get("ende")).toInstant())
                .isEqualTo(Instant.parse("2026-10-19T22:00:00Z"));
        assertThat(((Number) t.get("stunden")).intValue()).isEqualTo(24);
        assertThat(((Number) t.get("slots_erwartet")).intValue()).isEqualTo(96);
        assertThat(t.get("zustand")).isEqualTo("endgueltig");
        assertThat(((Timestamp) t.get("endgueltig_ab")).toInstant())
                .isEqualTo(Instant.parse("2026-10-26T22:00:00Z"));
        assertThat(t.get("version")).isEqualTo(1);
        assertThat(t.get("rolle")).isEqualTo("fuehrend");
    }

    // ======================================================== Die Zeitumstellung

    /** Der <b>25-Stunden-Tag</b> (25.10.2026): 100 Viertelstunden, nicht 96. */
    @Test
    void derFuenfundzwanzigStundenTagHatHundertSlots() {
        Map<String, Object> t = einTag(IDS.get("SZ"), "energy_kwh_sz", LocalDate.of(2026, 10, 25));
        assertThat(((Number) t.get("stunden")).intValue()).isEqualTo(25);
        assertThat(((Number) t.get("slots_erwartet")).intValue()).isEqualTo(100);
        assertThat(((Number) t.get("slots_vorhanden")).intValue())
                .as("jede der 100 Viertelstunden hat einen Wert").isEqualTo(100);
        assertThat(((Timestamp) t.get("beginn")).toInstant())
                .isEqualTo(Instant.parse("2026-10-24T22:00:00Z"));
        assertThat(((Timestamp) t.get("ende")).toInstant())
                .as("25 Stunden später, nicht 24").isEqualTo(Instant.parse("2026-10-25T23:00:00Z"));
        assertThat(t.get("zustand")).isEqualTo("endgueltig");
        // Die Gegenprobe: genau so viele Viertelstundenwerte liegen in dieser Spanne.
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde WHERE entity_id = '"
                + IDS.get("SZ") + "' AND intervall_beginn >= '2026-10-24T22:00:00Z' "
                + "AND intervall_beginn < '2026-10-25T23:00:00Z'")).isEqualTo(100);
    }

    /** Der <b>23-Stunden-Tag</b> (28.03.2027): 92 Viertelstunden, nicht 96. */
    @Test
    void derDreiundzwanzigStundenTagHatZweiundneunzigSlots() {
        Map<String, Object> t = einTag(IDS.get("SZ"), "energy_kwh_sz", LocalDate.of(2027, 3, 28));
        assertThat(((Number) t.get("stunden")).intValue()).isEqualTo(23);
        assertThat(((Number) t.get("slots_erwartet")).intValue()).isEqualTo(92);
        assertThat(((Number) t.get("slots_vorhanden")).intValue()).isEqualTo(92);
        assertThat(((Timestamp) t.get("beginn")).toInstant())
                .isEqualTo(Instant.parse("2027-03-27T23:00:00Z"));
        assertThat(((Timestamp) t.get("ende")).toInstant())
                .as("23 Stunden später").isEqualTo(Instant.parse("2027-03-28T22:00:00Z"));
        assertThat(t.get("zustand")).isEqualTo("endgueltig");
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde WHERE entity_id = '"
                + IDS.get("SZ") + "' AND intervall_beginn >= '2027-03-27T23:00:00Z' "
                + "AND intervall_beginn < '2027-03-28T22:00:00Z'")).isEqualTo(92);
    }

    /** Die Nachbartage der Umstellung bleiben gewöhnliche 96-Slot-Tage. */
    @Test
    void dieNachbartageBleibenGewoehnlich() {
        assertThat(((Number) einTag(IDS.get("SZ"), "energy_kwh_sz", LocalDate.of(2026, 10, 24))
                .get("slots_erwartet")).intValue()).isEqualTo(96);
        assertThat(((Number) einTag(IDS.get("SZ"), "energy_kwh_sz", LocalDate.of(2027, 3, 29))
                .get("slots_erwartet")).intValue()).isEqualTo(96);
    }

    // ============================================================ Der Tageslauf

    /** Ein Tag mit einer noch vorläufigen Viertelstunde ist selbst vorläufig. */
    @Test
    void einTagMitVorlaeufigenViertelstundenIstSelbstVorlaeufig() {
        Map<String, Object> t = offenTagVorher;
        assertThat(t.get("zustand")).isEqualTo("vorlaeufig");
        assertThat(((Number) t.get("slots_endgueltig")).intValue()).isEqualTo(0);
        assertThat(((Number) t.get("slots_vorhanden")).intValue()).isPositive();
    }

    /** Der Tageslauf verdichtet, was die Viertelstunde trägt — und erfindet nichts dazu. */
    @Test
    void derTageswertVerdichtetDieFaktenDerViertelstunden() {
        Map<String, Object> t = einTag(IDS.get("OKT"), "energy_kwh_okt", LocalDate.of(2026, 10, 19));
        Map<String, Object> summen = admin.queryForMap(
                "SELECT sum(erhalten) e, sum(erwartet) w, sum(n_good) g, count(*) n, "
                        + "min(min_wert) mn, max(max_wert) mx "
                        + "FROM messreihe_viertelstunde WHERE entity_id = ? AND messkanal = ? "
                        + "AND intervall_beginn >= '2026-10-18T22:00:00Z' "
                        + "AND intervall_beginn < '2026-10-19T22:00:00Z'",
                IDS.get("OKT"), "energy_kwh_okt");
        assertThat(((Number) t.get("erhalten")).longValue())
                .isEqualTo(((Number) summen.get("e")).longValue());
        // Seit AP-08 IP-5 zählt eine Viertelstunde OHNE Zeile mit ihrer Erwartung (§4.5): der Tag
        // erwartet 1 440 Werte, nicht nur die der neun vorhandenen Viertelstunden.
        assertThat(((Number) summen.get("w")).longValue()).isEqualTo(135L);
        assertThat(((Number) t.get("erwartet")).longValue()).isEqualTo(1440L);
        assertThat(((Number) t.get("n_good")).longValue())
                .isEqualTo(((Number) summen.get("g")).longValue());
        assertThat(((Number) t.get("slots_vorhanden")).intValue())
                .isEqualTo(((Number) summen.get("n")).intValue());
        // Die Periodenstände stehen an den TAGESGRENZEN (AP-08 IP-5): gemessen wurde nur 10–12 Uhr,
        // also gibt es um Mitternacht keinen Stand — und keiner wird erfunden. Die Menge ist der
        // gemessene Teil, ausdrücklich unvollständig.
        assertThat(t.get("stand_anfang")).isNull();
        assertThat(t.get("stand_ende")).isNull();
        assertThat((BigDecimal) t.get("letzter_wert")).isGreaterThan((BigDecimal) t.get("erster_wert"));
        assertThat((BigDecimal) t.get("menge")).isEqualByComparingTo("288.0");
        assertThat(t.get("menge_zustand")).isEqualTo("unvollständig");
    }

    /** Wiederholbar: derselbe Tageslauf noch einmal schreibt NICHTS. */
    @Test
    void derTageslaufIstWiederholbar() {
        assertThat(tagLaufNovember.geschrieben()).as("beim ersten Mal entstanden Zeilen")
                .isPositive();
        assertThat(tagGeschriebenZweitesMal).as("beim zweiten Mal keine einzige").isZero();
    }

    /**
     * Die drei Quellen der Arbeitsliste tun wirklich etwas: die einmalige Rückrechnung läuft zu
     * Ende, und der Zeiger-Durchgang findet die Viertelstunden, die der Verdichtungs-Lauf
     * geschrieben hat (er fragt {@code berechnet_am}).
     */
    @Test
    void dieQuellenDerArbeitslisteFuellenSieWirklich() {
        assertThat(rueckrechnungFertig).as("die Rückrechnung meldet sich fertig").isTrue();
        assertThat(ausZeiger).as("und der Zeiger-Durchgang findet die neu gebildeten Tage")
                .isPositive();
    }

    /** Abbruchsicher: scheitert das Schreiben, bleibt die Arbeitsliste vollständig. */
    @Test
    void derTageslaufIstAbbruchsicher() {
        assertThat(abbruchWarf).as("der Abbruch wird nicht verschwiegen").isTrue();
        assertThat(tagArbeitNachAbbruch).as("die Entnahme rollt mit zurück").isPositive();
        assertThat(zahl("SELECT count(*) FROM messreihe_tag_arbeit"))
                .as("und danach ist sie ordentlich abgearbeitet").isZero();
    }

    /** Die Arbeitsliste trägt einen Tag höchstens EINMAL — sie kann nicht unbegrenzt wachsen. */
    @Test
    void dieArbeitslisteTraegtEinenTagHoechstensEinmal() {
        for (int i = 0; i < 3; i++) {
            root.update("INSERT INTO messreihe_tag_arbeit (tenant_id, entity_id, messkanal, "
                    + "utc_tag, grund) VALUES (?, ?, 'energy_kwh_okt', DATE '2026-10-19', "
                    + "'viertelstunde') ON CONFLICT DO NOTHING", KB, IDS.get("OKT"));
        }
        assertThat(zahl("SELECT count(*) FROM messreihe_tag_arbeit")).isOne();
        tagLaufBisLeer(T_APR);
        assertThat(zahl("SELECT count(*) FROM messreihe_tag_arbeit")).isZero();
    }

    // ============================================================== Der Mandantenzaun

    /** Ohne `app.tenant_id` sieht die App-Rolle NICHTS — in beiden neuen Tabellen. */
    @Test
    void ohneKundenbereichSiehtDieAppRolleNichts() {
        TenantContext.clear();
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_tag", Integer.class)).isZero();
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_korrektur_vorschlag",
                Integer.class)).isZero();
    }

    /** Und mit einem FREMDEN Kundenbereich sieht sie die Zeilen des anderen nicht. */
    @Test
    void einFremderKundenbereichSiehtNichts() {
        TenantContext.set(FREMD);
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_tag", Integer.class))
                .as("nur die eigene Zeile").isEqualTo(fremdeTage());
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_korrektur_vorschlag",
                Integer.class)).isZero();
        TenantContext.set(KB);
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_tag", Integer.class))
                .as("und der eigene Kundenbereich sieht die seinen").isPositive();
    }

    private static int fremdeTage() {
        return zahl("SELECT count(*) FROM messreihe_tag WHERE tenant_id = '" + FREMD + "'");
    }

    // ============================================================ Aufbau der Beispielwelt

    private static void stammdaten() {
        for (UUID t : new UUID[] {KB, FREMD}) {
            root.update("INSERT INTO tenant (id, name) VALUES (?, ?)", t,
                    t.equals(KB) ? "Kunststoffwerk Ahrenberg GmbH" : "Kundenbereich B");
            IDS.put("U:" + t, uuid("INSERT INTO unternehmen (tenant_id, name, zeitzone) "
                    + "VALUES (?, ?, 'Europe/Berlin') RETURNING id", t, "U " + t));
        }
        // Der Standort trägt die Zeitzone (AP-02) — und der Tageswert schreibt sie ab (W10).
        IDS.put("ST", uuid("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, "
                + "zeitzone, zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', "
                + "'aktiv') RETURNING id", KB, IDS.get("U:" + KB)));
        IDS.put("AN2", uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-2') RETURNING id", KB));
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, DATE '2024-01-01')", KB, IDS.get("AN2"), IDS.get("ST"));
        IDS.put("BOX", uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, 'VP-BOX-HALLE-2', 'claimed') RETURNING id", KB, IDS.get("AN2")));

        for (String[] r : new String[][] {
                {"MS10", "energy_kwh_ms10"}, {"OKT", "energy_kwh_okt"}, {"SZ", "energy_kwh_sz"},
                {"OFFEN", "energy_kwh_offen"}}) {
            IDS.put(r[0], reihe(KB, IDS.get("AN2"), IDS.get("BOX"), r[0], r[1]));
        }

        // Der fremde Kundenbereich — OHNE Standort, damit auch die Vorgabe-Zeitzone einmal
        // wirklich gefahren wird.
        IDS.put("AN-F", uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'B-1') RETURNING id",
                FREMD));
        IDS.put("BOX-F", uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, 'VP-BOX-B', 'claimed') RETURNING id", FREMD, IDS.get("AN-F")));
        IDS.put("FREMD", reihe(FREMD, IDS.get("AN-F"), IDS.get("BOX-F"), "FREMD",
                "energy_kwh_fremd"));
    }

    /** Eine Reihe: Komponente + Mess-Selektion (60 s Kadenz). */
    private static UUID reihe(UUID tenant, UUID site, UUID box, String name, String kanal) {
        UUID entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, communication, connection_json, created_at) VALUES "
                + "(?, ?, 'grid-meter', ?, 'grid-meter', ?, 'modbus_tcp', "
                + "'{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, '2024-03-12T00:00:00Z') RETURNING id",
                tenant, site, name, box);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, "
                + "entity_id, point_key, enabled, cadence_s, desired_revision, enabled_at, "
                + "catalog_version, changed_by, apply_status, retention_class, long_term_strategy) "
                + "VALUES (?, ?, ?, ?, ?, true, 60, 1, '2024-03-12T00:00:00Z', '2026.09.11.1', "
                + "'test', 'pending_edge', 'live_power', 'fifteen_minute')",
                tenant, site, box, entity, kanal);
        return entity;
    }

    private static void rohwerte() {
        // A4 — MS-10, 03.11.2026 14:00–14:15 Ortszeit: nur DREI Werte kommen pünktlich an
        // (die Box fällt um 14:03 aus); der Rest kommt am 12.11. — aber erst nach der ersten
        // Bildung, siehe nachzuegler().
        for (int i = 0; i < 3; i++) {
            roh(KB, IDS.get("AN2"), IDS.get("MS10"), "energy_kwh_ms10",
                    A4_BEGINN.plus(Duration.ofMinutes(i)), new BigDecimal(416856 + i),
                    A4_BEGINN.plus(Duration.ofMinutes(i)).plusSeconds(2), "direkt");
        }
        // OKT — der Oktober-Beleg von A8: zwei volle Stunden am 19.10.2026 (Ortszeit 10:00–12:00).
        for (int i = 0; i <= 120; i++) {
            Instant t = Instant.parse("2026-10-19T08:00:00Z").plus(Duration.ofMinutes(i));
            roh(KB, IDS.get("AN2"), IDS.get("OKT"), "energy_kwh_okt", t,
                    new BigDecimal("1062113.4").add(new BigDecimal("2.4")
                            .multiply(BigDecimal.valueOf(i))),
                    t.plusSeconds(2), "direkt");
        }
        // SZ — die Zeitumstellung: EIN Wert je Viertelstunde über den 24.–26.10.2026 und den
        // 27.–30.03.2027, damit jede Viertelstunde ihre Zeile bekommt und der Tag seine Slots
        // wirklich zählen kann.
        raster("2026-10-23T22:00:00Z", "2026-10-27T00:00:00Z");
        raster("2027-03-26T23:00:00Z", "2027-03-30T00:00:00Z");
        // OFFEN — ein Intervall, dessen Frist am 12.11. noch LÄUFT (11.11. 14:00–14:15):
        // drei pünktliche Werte, einer nachgeliefert. Er wird mitgerechnet.
        for (int i = 0; i < 3; i++) {
            Instant t = Instant.parse("2026-11-11T13:00:00Z").plus(Duration.ofMinutes(i));
            roh(KB, IDS.get("AN2"), IDS.get("OFFEN"), "energy_kwh_offen", t,
                    new BigDecimal(500 + i), t.plusSeconds(2), "direkt");
        }
        roh(KB, IDS.get("AN2"), IDS.get("OFFEN"), "energy_kwh_offen",
                Instant.parse("2026-11-11T13:03:00Z"), new BigDecimal(503),
                Instant.parse("2026-11-12T08:00:00Z"), "nachgeliefert");
        // Die Reihe des fremden Kundenbereichs — sie beweist den Zaun.
        for (int i = 0; i < 3; i++) {
            Instant t = Instant.parse("2026-10-19T08:00:00Z").plus(Duration.ofMinutes(i));
            roh(FREMD, IDS.get("AN-F"), IDS.get("FREMD"), "energy_kwh_fremd", t,
                    new BigDecimal(900 + i), t.plusSeconds(2), "direkt");
        }
    }

    /** Ein Wert je Viertelstunde über eine Spanne — so bekommt jeder Slot seine Zeile. */
    private static void raster(String von, String bis) {
        Instant t = Instant.parse(von);
        Instant ende = Instant.parse(bis);
        long i = 0;
        List<Object[]> stapel = new ArrayList<>();
        while (t.isBefore(ende)) {
            stapel.add(rohWerte(KB, IDS.get("AN2"), IDS.get("SZ"), "energy_kwh_sz", t,
                    new BigDecimal(200000 + i * 4), t.plusSeconds(2), "direkt"));
            t = t.plus(Duration.ofMinutes(15));
            i++;
        }
        root.batchUpdate(ROH_SQL, stapel);
    }

    /** Die 12 Nachzügler von A4 — Messzeit im Intervall, EINGANGSZEIT am 12.11. 09:02. */
    private static void nachzuegler() {
        for (int i = 3; i < 15; i++) {
            roh(KB, IDS.get("AN2"), IDS.get("MS10"), "energy_kwh_ms10",
                    A4_BEGINN.plus(Duration.ofMinutes(i)), new BigDecimal(416856 + i),
                    A4_NACHZUEGLER, "nachgeliefert");
        }
    }

    private static final String ROH_SQL =
            "INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, "
                    + "device_id, point_key, raw_numeric, quality, catalog_version, edge_sequence, "
                    + "aggregation_kind, entity_id, applied_revision, value_kind, role, delivery, "
                    + "delay_s) VALUES (?, ?, ?, ?, ?, ?, ?, 'good', '2026.09.11.1', ?, 'counter', "
                    + "?, 3, 'counter', 'fuehrend', ?, 2)";

    private static Object[] rohWerte(UUID tenant, UUID site, UUID entity, String kanal, Instant t,
            BigDecimal wert, Instant eingang, String zustellart) {
        return new Object[] {Timestamp.from(t), Timestamp.from(eingang), tenant, site,
                tenant.equals(KB) ? IDS.get("BOX") : IDS.get("BOX-F"), kanal, wert,
                t.getEpochSecond(), entity, zustellart};
    }

    private static void roh(UUID tenant, UUID site, UUID entity, String kanal, Instant t,
            BigDecimal wert, Instant eingang, String zustellart) {
        root.update(ROH_SQL, rohWerte(tenant, site, entity, kanal, t, wert, eingang, zustellart));
    }

    // ------------------------------------------------------------------------ Die Läufe

    /** Ein Eintrag je Viertelstunde, die mindestens einen Rohwert hat (wie in PR 700). */
    private static void arbeitFuellen() {
        root.update("""
                INSERT INTO messreihe_viertelstunde_arbeit
                       (tenant_id, entity_id, messkanal, intervall_beginn, grund)
                SELECT DISTINCT s.tenant_id, s.entity_id, s.point_key,
                       to_timestamp(floor(extract(epoch FROM s.time) / 900) * 900), 'eingang'
                  FROM device_measurement_sample s
                 WHERE s.entity_id IS NOT NULL AND s.role IS DISTINCT FROM 'spiegel'
                ON CONFLICT DO NOTHING
                """);
    }

    /** Ein Eintrag je Reihe und UTC-Tag einer Spanne — die Arbeitsliste des Tageslaufs. */
    private static void tagArbeitFuellenAus(Instant von, Instant bis) {
        root.update("""
                INSERT INTO messreihe_tag_arbeit (tenant_id, entity_id, messkanal, utc_tag, grund)
                SELECT DISTINCT v.tenant_id, v.entity_id, v.messkanal,
                       (v.intervall_beginn AT TIME ZONE 'UTC')::date, 'viertelstunde'
                  FROM messreihe_viertelstunde v
                 WHERE v.intervall_beginn >= ? AND v.intervall_beginn < ?
                ON CONFLICT DO NOTHING
                """, Timestamp.from(von), Timestamp.from(bis));
    }

    private static ViertelstundeVerdichter.Lauf verdichtenBisLeer(Instant jetzt) {
        int verdichtet = 0;
        int geschrieben = 0;
        int spaet = 0;
        while (true) {
            int[] r = verdichter.verdichteEinenStapel(jetzt);
            if (r[0] == 0) {
                break;
            }
            verdichtet += r[0];
            geschrieben += r[1];
            spaet += r[2];
        }
        return new ViertelstundeVerdichter.Lauf(0, 0, 0, false, verdichtet, geschrieben, spaet);
    }

    private static TagVerdichter.Lauf tagLaufBisLeer(Instant jetzt) {
        int gebildet = 0;
        int geschrieben = 0;
        while (true) {
            int[] r = tage.bildeEinenStapel(jetzt);
            if (r[0] == 0) {
                break;
            }
            gebildet += r[0];
            geschrieben += r[1];
        }
        return new TagVerdichter.Lauf(0, 0, 0, false, gebildet, geschrieben);
    }

    // ------------------------------------------------------------------------ Helfer

    private static Map<String, Object> eineVsZeile(UUID entity, String kanal, Instant beginn) {
        List<Map<String, Object>> treffer = admin.queryForList(
                "SELECT * FROM messreihe_viertelstunde WHERE entity_id = ? AND messkanal = ? "
                        + "AND intervall_beginn = ?", entity, kanal, Timestamp.from(beginn));
        return treffer.isEmpty() ? null : treffer.get(0);
    }

    private static Map<String, Object> einTag(UUID entity, String kanal, LocalDate tag) {
        List<Map<String, Object>> treffer = admin.queryForList(
                "SELECT * FROM messreihe_tag WHERE entity_id = ? AND messkanal = ? AND tag = ?",
                entity, kanal, java.sql.Date.valueOf(tag));
        if (treffer.isEmpty()) {
            throw new AssertionError("kein Tageswert " + kanal + " " + tag);
        }
        return treffer.get(0);
    }

    private static List<String> rechte(String rolle, String tabelle) {
        return root.queryForList("SELECT privilege_type FROM information_schema.table_privileges "
                + "WHERE grantee = ? AND table_name = ? ORDER BY privilege_type", String.class,
                rolle, tabelle);
    }

    private static void tagEinfuegen(String... spalteUndWert) {
        List<String> spalten = new ArrayList<>(List.of("tag", "tenant_id", "entity_id", "messkanal",
                "zeitzone", "zeitzone_herkunft", "beginn", "ende", "stunden", "slots_erwartet",
                "slots_vorhanden", "slots_endgueltig", "erhalten", "erwartet", "endgueltig_ab"));
        List<String> werte = new ArrayList<>(List.of("'2026-12-01'", "'" + KB + "'",
                "'" + IDS.get("OKT") + "'", "'probe'", "'Europe/Berlin'", "'standort'",
                "'2026-11-30T23:00:00Z'", "'2026-12-01T23:00:00Z'", "24", "96", "0", "0", "0", "0",
                "'2026-12-08T23:00:00Z'"));
        for (int i = 0; i < spalteUndWert.length; i += 2) {
            int vorhanden = spalten.indexOf(spalteUndWert[i]);
            if (vorhanden >= 0) {
                werte.set(vorhanden, spalteUndWert[i + 1]);
            } else {
                spalten.add(spalteUndWert[i]);
                werte.add(spalteUndWert[i + 1]);
            }
        }
        root.update("INSERT INTO messreihe_tag (" + String.join(", ", spalten) + ") VALUES ("
                + String.join(", ", werte) + ")");
    }

    private static UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
    }

    private static int zahl(String sql) {
        return root.queryForObject(sql, Integer.class);
    }

    /**
     * Der Inhalt JEDER Tabelle des Schemas als ein Wert — ändert sich irgendwo eine Zeile, ändert
     * er sich. Ausgenommen sind nur die Tabellen, die dieses Paket bearbeitet, und das
     * Migrations-Protokoll.
     */
    private static Map<String, String> fingerabdruck() {
        return Bestandsschutz.fingerabdruck(root, AUSNAHMEN);
    }

    /**
     * Der Fingerabdruck der PÜNKTLICHEN Rohwerte — alles, was vor der Frist von A4 eingegangen
     * ist. Er beweist, dass die Spätankunft keine bestehende Rohzeile anfasst: sie SPEICHERT, sie
     * ändert nie.
     */
    private static String rohwerteFinger() {
        return root.queryForObject(
                "SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), 'leer') FROM "
                        + "device_measurement_sample t WHERE t.received_at <= ?", String.class,
                Timestamp.from(A4_FRIST));
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
                .placeholders(Map.of(
                        "appDbUser", APP_USER, "appDbPassword", APP_PW,
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
