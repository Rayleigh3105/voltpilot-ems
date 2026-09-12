package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
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
 * Die Migration {@code V20260912170000} und der Verdichtungs-Lauf (UEMS AP-07 IP-12) gegen eine
 * echte TimescaleDB — der Prüfnachweis des Konzepts (§8 IP-12: „Regressionstest mit Vektor-Fällen
 * (A2, A5, A6, A12); {@code DataRetentionPolicyTest} erweitert; Rückrechnung auf Testcontainers").
 *
 * <p>Geprüft wird:
 *
 * <ul>
 *   <li>die Migration legt nur DANEBEN — jede bestehende Tabelle ist danach und nach dem ganzen
 *       Lauf zeichengleich (Fingerabdruck), Chunk 30 Tage, Aufbewahrung 3 653 Tage, keine
 *       Kompression, RLS + FORCE, beschnittene Rechte, Layout vorbereitet;
 *   <li><b>A5</b> Zählerwechsel IM Intervall: 10 von 15, Anker Z-5a <i>und</i> Z-5b, kein
 *       gerechneter Mengen-Unterschied über die Grenze;
 *   <li><b>A6</b> Box-Übergabe IM Intervall: 14 von 15, beide Boxen als Anker;
 *   <li><b>A12</b> ungeordnete Zustellung: Zeichen für Zeichen dasselbe Ergebnis wie geordnet;
 *   <li><b>A2</b> nach dem Rohdatenablauf trägt der Viertelstundenwert noch alles, was der
 *       Lesepfad braucht — Wert, Abdeckung, Qualitätszähler, Gerät + Einbau, Fassung, Box,
 *       Zustand, nachgeliefert, Version;
 *   <li>die Kadenz kommt aus der Fassung, die ZUM INTERVALL galt — nicht der von „jetzt";
 *   <li>die Abdeckung wird nie auf 100 % gerundet (Lauf UND Datenbankgrenze);
 *   <li>Wiederholbarkeit: ein zweiter Lauf über dieselben Intervalle schreibt gar nichts;
 *   <li>Abbruchsicherheit: scheitert das Schreiben, steht der Eintrag wieder in der Arbeitsliste
 *       und keine halbe Zeile in der Tabelle;
 *   <li>die Rückrechnung der letzten 90 Tage: in Scheiben, wiederaufnehmbar, mit Zahlen;
 *   <li>der Mandantenzaun.
 * </ul>
 *
 * <p><b>Zur Beispielquelle.</b> Zahlen, Kennzeichen und Uhrzeiten der Fälle stammen aus dem
 * Referenzunternehmen Ahrenberg (A5: MS-06/K-5, Z-5a → Z-5b um 10:40, Endstand 1 083 415,2; A6:
 * Übergabe um 07:30 mit Lücke bis 07:31). Der KALENDERTAG von A6 ist auf den Tag von A5 gelegt,
 * damit EIN {@code jetzt} das Rückrechnungs-Fenster von 90 Tagen über beide Fälle spannt — geprüft
 * wird die FORM des Falls, nicht sein Datum.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsViertelstundeMigrationTest {

    private static final String DIESE = "20260912170000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    /** Der Tag der Fälle und die Uhr des Laufs. */
    private static final Instant JETZT = Instant.parse("2026-11-18T12:00:00Z");

    private static final UUID KB = UUID.fromString("4e0c0000-0000-0000-0000-000000000001");
    private static final UUID FREMD = UUID.fromString("4e0c0000-0000-0000-0000-000000000002");

    /** Die Tabellen, die dieses Paket NICHT anfassen darf. */
    private static final List<String> BESTAND = List.of(
            "device_measurement_sample", "device_measurement_event",
            "device_measurement_rollup_5m", "device_measurement_rollup_15m",
            "device_measurement_selection", "messreihe_ereignis", "measurement_point",
            "geraet", "geraet_komponente", "messstelle", "messstelle_quelle", "quelle_kadenz",
            "telemetry", "telemetry_v2", "schedule");

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

    private static final Map<String, UUID> IDS = new LinkedHashMap<>();

    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;
    private static Map<String, String> fingerNachLauf;

    private static int ersterEingangsLauf;
    private static Instant zeigerNachErstemLauf;
    private static int rueckgerechnet;
    private static int scheiben;
    private static long rueckrechnungMs;
    private static int arbeitNachRueckrechnung;
    private static int verdichtet;
    private static int geschrieben;
    private static long verdichtungMs;
    private static int geschriebenBeimZweitenMal;
    private static int eingangNachtraeglich;

    private static List<Map<String, Object>> zeilen;
    private static List<Map<String, Object>> zeilenNachWiederholung;
    private static List<Map<String, Object>> zeilenNachRohdatenablauf;
    private static boolean abbruchWarf;
    private static int arbeitNachAbbruch;
    private static int zeilenNachAbbruch;

    // =========================================================================== Aufbau

    @BeforeAll
    static void bauenUndFahren() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();

        stammdaten();
        rohwerte();
        ereignisse();
        fingerVorher = fingerabdruck();

        flyway().target(DIESE).load().migrate();
        fingerNachMigration = fingerabdruck();
        flyway().load().migrate();

        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        verdichter = new ViertelstundeVerdichter(admin, new MeasurementCatalog(new ObjectMapper()),
                500, 40, 200_000);

        // 1. Der ERSTE Lauf überhaupt trägt nichts ein — er setzt nur den Zeiger; die
        //    Vergangenheit gehört der Rückrechnung.
        ersterEingangsLauf = verdichter.eintragenAusEingang(JETZT);
        zeigerNachErstemLauf = verdichter.stand("zeiger").zeitpunkt();

        // 2. Die Rückrechnung der letzten 90 Tage, Scheibe für Scheibe.
        long t0 = System.nanoTime();
        int summe = 0;
        int runden = 0;
        while (runden < 200) {
            ViertelstundeVerdichter.Scheibe s = verdichter.rueckrechnenEineScheibe(JETZT);
            summe += s.eingetragen();
            runden++;
            if (s.fertig()) {
                break;
            }
        }
        rueckrechnungMs = Duration.ofNanos(System.nanoTime() - t0).toMillis();
        rueckgerechnet = summe;
        scheiben = runden;
        arbeitNachRueckrechnung = zahl("SELECT count(*) FROM messreihe_viertelstunde_arbeit");

        // 3. Verdichten, bis die Arbeitsliste leer ist.
        t0 = System.nanoTime();
        while (true) {
            ViertelstundeVerdichter.Lauf l = verdichter.lauf(JETZT);
            verdichtet += l.verdichtet();
            geschrieben += l.geschrieben();
            if (l.verdichtet() == 0) {
                break;
            }
        }
        verdichtungMs = Duration.ofNanos(System.nanoTime() - t0).toMillis();
        zeilen = lese();

        // 4. Wiederholbarkeit: dieselben Intervalle noch einmal durch den Lauf.
        root.update("INSERT INTO messreihe_viertelstunde_arbeit (tenant_id, entity_id, messkanal, "
                + "intervall_beginn, grund) SELECT tenant_id, entity_id, messkanal, intervall_beginn, "
                + "'eingang' FROM messreihe_viertelstunde ON CONFLICT DO NOTHING");
        ViertelstundeVerdichter.Lauf zweiter = verdichter.lauf(JETZT);
        geschriebenBeimZweitenMal = zweiter.geschrieben();
        zeilenNachWiederholung = lese();

        // 5. Abbruchsicherheit: das Schreiben scheitert mitten im Stapel.
        root.update("INSERT INTO messreihe_viertelstunde_arbeit (tenant_id, entity_id, messkanal, "
                + "intervall_beginn, grund) VALUES (?, ?, 'energy_kwh_abbruch', ?, 'eingang')",
                KB, IDS.get("ABBRUCH"), Timestamp.from(Instant.parse("2026-06-01T09:00:00Z")));
        root.execute("REVOKE INSERT ON messreihe_viertelstunde FROM " + ADMIN_USER);
        try {
            verdichter.verdichteEinenStapel();
            abbruchWarf = false;
        } catch (RuntimeException e) {
            abbruchWarf = true;
        }
        arbeitNachAbbruch = zahl("SELECT count(*) FROM messreihe_viertelstunde_arbeit "
                + "WHERE messkanal = 'energy_kwh_abbruch'");
        zeilenNachAbbruch = zahl("SELECT count(*) FROM messreihe_viertelstunde "
                + "WHERE messkanal = 'energy_kwh_abbruch'");
        root.execute("GRANT INSERT ON messreihe_viertelstunde TO " + ADMIN_USER);
        verdichter.verdichteEinenStapel();

        // 6. Der EINGANGS-Weg: der nachgelieferte Rohwert (er liegt seit dem Aufbau in der
        //    Rohtabelle, seine EINGANGSZEIT ist aber JETZT − 5 min) holt SEIN Intervall über den
        //    Eingang zurück — ohne festes Fenster, §4.5 Nachlieferung Nr. 3.
        root.update("UPDATE messreihe_viertelstunde_lauf SET zeitpunkt = ? WHERE schluessel = 'zeiger'",
                Timestamp.from(JETZT.minus(Duration.ofMinutes(10))));
        eingangNachtraeglich = verdichter.eintragenAusEingang(JETZT);
        verdichter.verdichteEinenStapel();

        fingerNachLauf = fingerabdruck();

        // 7. A2: der Rohdatenablauf (Simulation des Chunk-Drops) — die Rohwerte des
        //    Zählerwechsel-Intervalls verschwinden.
        root.update("DELETE FROM device_measurement_sample WHERE entity_id = ?", IDS.get("K5"));
        zeilenNachRohdatenablauf = lese();
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ================================================================ Die Migration

    @Test
    void dieMigrationLegtNurDanebenUndDerGanzeLaufLaesstDenBestandZeichengleich() {
        assertThat(fingerNachMigration).as("nach der Migration").isEqualTo(fingerVorher);
        assertThat(fingerNachLauf).as("nach Rückrechnung, Verdichtung und Wiederholung")
                .isEqualTo(fingerVorher);
        assertThat(fingerVorher).containsKeys(BESTAND.toArray(String[]::new));
    }

    @Test
    void dieTabelleIstEineHypertableMitDreissigTageChunksUndZehnJahrenOhneKompression() {
        assertThat(root.queryForObject("SELECT time_interval FROM timescaledb_information.dimensions "
                + "WHERE hypertable_name = 'messreihe_viertelstunde' AND column_name = 'intervall_beginn'",
                String.class)).isEqualTo("30 days");
        assertThat(root.queryForObject("SELECT count(*) FROM timescaledb_information.jobs "
                + "WHERE proc_name = 'policy_retention' AND hypertable_name = 'messreihe_viertelstunde' "
                + "AND (config->>'drop_after')::interval = make_interval(days => 3653)", Long.class))
                .as("Aufbewahrung genau 3 653 Tage").isEqualTo(1L);
        assertThat(root.queryForObject("SELECT compression_enabled FROM "
                + "timescaledb_information.hypertables WHERE hypertable_name = 'messreihe_viertelstunde'",
                Boolean.class)).as("keine Kompression (RLS + FORCE, E7)").isFalse();
        // E7: das Layout ist VORBEREITET — abrufbar und genau die Ordnung des Unique-Index.
        Map<String, Object> layout = root.queryForMap(
                "SELECT * FROM messreihe_viertelstunde_kompression_layout()");
        assertThat(layout.get("segmentby")).isEqualTo("tenant_id, entity_id, messkanal");
        assertThat(layout.get("orderby")).isEqualTo("intervall_beginn DESC");
        assertThat(root.queryForList("SELECT indexdef FROM pg_indexes "
                + "WHERE tablename = 'messreihe_viertelstunde'", String.class))
                .anySatisfy(i -> assertThat(i).contains("UNIQUE")
                        .contains("(tenant_id, entity_id, messkanal, intervall_beginn)"));
    }

    @Test
    void derZaunStehtUndDieAppRolleDarfNurLesen() {
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'messreihe_viertelstunde'", Boolean.class)).isTrue();
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'messreihe_viertelstunde_arbeit'", Boolean.class)).isTrue();

        TenantContext.set(KB);
        long eigene = app.queryForObject("SELECT count(*) FROM messreihe_viertelstunde", Long.class);
        assertThat(eigene).as("der eigene Kundenbereich sieht seine Zeilen").isPositive();
        TenantContext.set(FREMD);
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_viertelstunde", Long.class))
                .as("ein fremder Kundenbereich sieht KEINE").isZero();

        TenantContext.set(KB);
        assertThatThrownBy(() -> app.update("INSERT INTO messreihe_viertelstunde (intervall_beginn, "
                + "tenant_id, entity_id, messkanal, erhalten, erwartet, kadenz_s, kadenz_herkunft, "
                + "endgueltig_ab) VALUES (?, ?, ?, 'x', 0, 0, 60, 'vorgabe', ?)",
                Timestamp.from(Instant.parse("2026-11-18T10:30:00Z")), KB, IDS.get("K5"),
                Timestamp.from(Instant.parse("2026-11-25T10:45:00Z"))))
                .hasMessageContaining("messreihe_viertelstunde");
        // Die Arbeitsliste und der Laufzustand gehören dem Lauf allein.
        assertThatThrownBy(() -> app.queryForObject(
                "SELECT count(*) FROM messreihe_viertelstunde_lauf", Long.class))
                .hasMessageContaining("messreihe_viertelstunde_lauf");
    }

    // ====================================================================== Die Fälle

    /**
     * A5 — Zählerwechsel MS-06 um 10:40: Viertelstundenwert 10:30–10:45 mit 10 von 15 und den
     * Ankern Z-5a UND Z-5b; die Menge über die Grenze bildet AP-08 aus End-/Anfangsstand — die
     * Strecke rechnet keine Differenz (es gibt gar keine Mengen-Spalte).
     */
    @Test
    void a5DerZaehlerwechselImIntervallNenntBeideEinbautenUndRechnetKeineDifferenz() {
        Map<String, Object> z = zeile(zeilen, IDS.get("K5"), "energy_kwh_k5", "2026-11-18T10:30:00Z");
        assertThat(z.get("wertart")).isEqualTo("counter");
        assertThat(z.get("erhalten")).isEqualTo(10);
        assertThat(z.get("erwartet")).isEqualTo(15);
        assertThat(z.get("abdeckung_prozent")).isEqualTo(66);
        assertThat(z.get("geraet_einbau")).isEqualTo(IDS.get("Z5A"));
        assertThat(z.get("geraet_einbau_2")).as("der zweite Anker steht da, obwohl Z-5b erst "
                + "um 10:47 liefert — die Gerätegrenze belegt ihn").isEqualTo(IDS.get("Z5B"));
        assertThat(z.get("geraet_einbau_weitere")).isEqualTo(0);
        // Z1: Stand(10:30) ist der letzte gute Wert in (10:29, 10:30] — Stand(10:45) gibt es
        // nicht, weil in (10:44, 10:45] nicht gemessen wurde. Nicht fortgeschrieben.
        assertThat(z.get("stand_anfang")).asString().isEqualTo("1083406.2");
        assertThat(z.get("stand_ende")).as("an dieser Periodengrenze wurde nicht gemessen").isNull();
        assertThat(z.get("letzter_wert")).asString().isEqualTo("1083415.2");
        assertThat(z.get("summe")).isNull();
        assertThat(z.get("mittel")).as("ein Zählerstand hat kein Mittel").isNull();
        // AP-08 IP-2 hat die Menge-Spalte nachgereicht: die Strecke rechnet weiterhin KEINE
        // Differenz selbst — sie ruft VerbrauchRegeln. Ueber die Geraetegrenze ohne Stand(Ende)
        // bleibt der Beitrag des Wechsels 0, und die Viertelstunde ist unvollstaendig.
        assertThat(z.get("menge")).as("nur der Zuwachs, den Z-5a gemessen hat - nichts ueber die "
                + "Grenze hinweg").asString().isEqualTo("9.000");
        assertThat(z.get("menge_zustand")).isEqualTo("unvollständig");
        assertThat(z.get("kennzeichen").toString()).contains("Ende nicht gemessen");
        assertThat(z.get("ereignisse").toString())
                .contains("\"data_gap\": 1").contains("\"device_boundary\": 1");
        // Das Folge-Intervall gehört schon Z-5b allein.
        Map<String, Object> danach = zeile(zeilen, IDS.get("K5"), "energy_kwh_k5", "2026-11-18T10:45:00Z");
        assertThat(danach.get("erhalten")).isEqualTo(13);
        assertThat(danach.get("geraet_einbau")).isEqualTo(IDS.get("Z5B"));
        assertThat(danach.get("geraet_einbau_2")).isNull();
    }

    /** A6 — Übergabe DQ-3 um 07:30: 14 von 15, beide Boxen als Anker, in der Reihenfolge der Zeit. */
    @Test
    void a6DieUebergabeImIntervallNenntBeideBoxen() {
        Map<String, Object> z = zeile(zeilen, IDS.get("DQ3K"), "power_kw_dq3", "2026-11-18T07:30:00Z");
        assertThat(z.get("erhalten")).isEqualTo(14);
        assertThat(z.get("erwartet")).isEqualTo(15);
        assertThat(z.get("abdeckung_prozent")).isEqualTo(93);
        assertThat(z.get("box")).as("die Box, die zuerst zuständig war").isEqualTo(IDS.get("BOX1"));
        assertThat(z.get("box_2")).as("die Box, die übernommen hat").isEqualTo(IDS.get("BOX2"));
        assertThat(z.get("box_weitere")).isEqualTo(0);
        assertThat(z.get("ereignisse").toString()).contains("\"handover\": 1");
        assertThat(z.get("wertart")).isEqualTo("gauge");
        assertThat(z.get("mittel")).isNotNull();
        assertThat(z.get("min_wert")).isNotNull();
        assertThat(z.get("max_wert")).isNotNull();
        assertThat(z.get("stand_anfang")).as("ein Momentanwert hat keinen Stand").isNull();
        // Das Intervall davor gehört Box Halle 1 allein.
        Map<String, Object> davor = zeile(zeilen, IDS.get("DQ3K"), "power_kw_dq3", "2026-11-18T07:15:00Z");
        assertThat(davor.get("box")).isEqualTo(IDS.get("BOX1"));
        assertThat(davor.get("box_2")).isNull();
    }

    /**
     * A12 — ungeordnete Zustellung: zwei Reihen mit denselben Werten, die eine in der Reihenfolge
     * der Messzeit eingetroffen, die andere durcheinander. Der Viertelstundenwert ist IDENTISCH —
     * er entsteht aus der MENGE der Rohwerte, nicht inkrementell.
     */
    @Test
    void a12DieUngeordneteZustellungErgibtDenselbenWert() {
        Map<String, Object> geordnet = zeile(zeilen, IDS.get("A12A"), "energy_kwh_a", "2026-11-18T09:30:00Z");
        Map<String, Object> durcheinander = zeile(zeilen, IDS.get("A12B"), "energy_kwh_b", "2026-11-18T09:30:00Z");
        for (String feld : List.of("wertart", "stand_anfang", "stand_ende", "mittel", "min_wert",
                "max_wert", "erster_wert", "letzter_wert", "erhalten", "erwartet",
                "abdeckung_prozent", "kadenz_s", "kadenz_herkunft", "n_good", "n_uncertain",
                "n_invalid", "n_stale", "n_device_error", "zustand", "version", "n_nachgeliefert",
                "zustellart")) {
            assertThat(durcheinander.get(feld)).as(feld).isEqualTo(geordnet.get(feld));
        }
        assertThat(geordnet.get("erhalten")).isEqualTo(15);
        assertThat(geordnet.get("abdeckung_prozent")).isEqualTo(100);
    }

    /**
     * A2 — nach dem Rohdatenablauf: der Viertelstundenwert trägt weiter alles, was der Lesepfad
     * (IP-14) und der Bericht brauchen. Kein Feld wird leer, nur weil die Rohwerte weg sind.
     */
    @Test
    void a2NachDemRohdatenablaufTraegtDerViertelstundenwertNochAlles() {
        assertThat(zahl("SELECT count(*) FROM device_measurement_sample WHERE entity_id = '"
                + IDS.get("K5") + "'")).as("die Rohwerte sind weg").isZero();
        Map<String, Object> z = zeile(zeilenNachRohdatenablauf, IDS.get("K5"), "energy_kwh_k5",
                "2026-11-18T10:30:00Z");
        assertThat(z).isNotNull();
        assertThat(z.get("letzter_wert")).asString().isEqualTo("1083415.2");
        assertThat(z.get("erhalten")).isEqualTo(10);
        assertThat(z.get("erwartet")).isEqualTo(15);
        assertThat(z.get("abdeckung_prozent")).isEqualTo(66);
        assertThat(z.get("n_good")).isEqualTo(10);
        assertThat(z.get("geraet_einbau")).isEqualTo(IDS.get("Z5A"));
        assertThat(z.get("box")).isEqualTo(IDS.get("BOX2"));
        assertThat(z.get("fassung")).isEqualTo(3L);
        assertThat(z.get("katalog")).isEqualTo("2026.09.11.1");
        assertThat(z.get("rolle")).isEqualTo("fuehrend");
        assertThat(z.get("zustand")).isEqualTo("vorlaeufig");
        assertThat(z.get("version")).isEqualTo(1);
        assertThat(z.get("n_nachgeliefert")).isEqualTo(0);
        assertThat(z.get("zustellart")).isEqualTo("direkt");
        assertThat(z.get("letzte_eingangszeit")).isNotNull();
    }

    // ============================================================ Die Regeln des Laufs

    /** Die Kadenz kommt aus der Fassung, die ZUM INTERVALL galt — nicht der von „jetzt". */
    @Test
    void dieAbdeckungFolgtDerZeitgueltigenKadenzNichtDerVonJetzt() {
        Map<String, Object> frueh = zeile(zeilen, IDS.get("KAD"), "power_kw_kad", "2026-11-18T06:00:00Z");
        assertThat(frueh.get("kadenz_s")).as("die Fassung von 06:00 gilt für 06:00").isEqualTo(60);
        assertThat(frueh.get("kadenz_herkunft")).isEqualTo("fassung");
        assertThat(frueh.get("erwartet")).isEqualTo(15);

        Map<String, Object> spaet = zeile(zeilen, IDS.get("KAD"), "power_kw_kad", "2026-11-18T11:00:00Z");
        assertThat(spaet.get("kadenz_s")).as("ab 10:00 gilt 300 s — die Vergangenheit behält ihre "
                + "alte Erwartung").isEqualTo(300);
        assertThat(spaet.get("erwartet")).isEqualTo(3);

        // Ohne Fassung greift die Kette von vor IP-10: die Mess-Selektion.
        Map<String, Object> ohne = zeile(zeilen, IDS.get("K5"), "energy_kwh_k5", "2026-11-18T10:30:00Z");
        assertThat(ohne.get("kadenz_herkunft")).isEqualTo("auswahl");
        assertThat(ohne.get("kadenz_s")).isEqualTo(60);
    }

    /** §4.9 Nr. 6: die Abdeckung wird nie auf 100 % gerundet — im Lauf und an der Datenbankgrenze. */
    @Test
    void dieAbdeckungWirdNieAufHundertProzentGerundet() {
        // 14 von 15 sind 93, nicht 100 (abgeschnitten, wie VerbrauchRegeln es rechnet).
        assertThat(zeile(zeilen, IDS.get("DQ3K"), "power_kw_dq3", "2026-11-18T07:30:00Z")
                .get("abdeckung_prozent")).isEqualTo(93);
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde "
                + "WHERE abdeckung_prozent = 100 AND erhalten < erwartet"))
                .as("keine einzige geschönte Zeile").isZero();
        assertThatThrownBy(() -> root.update("INSERT INTO messreihe_viertelstunde (intervall_beginn, "
                + "tenant_id, entity_id, messkanal, erhalten, erwartet, abdeckung_prozent, kadenz_s, "
                + "kadenz_herkunft, endgueltig_ab) VALUES (?, ?, ?, 'geschoent', 14, 15, 100, 60, "
                + "'vorgabe', ?)", Timestamp.from(Instant.parse("2026-11-18T10:30:00Z")), KB,
                IDS.get("K5"), Timestamp.from(Instant.parse("2026-11-25T10:45:00Z"))))
                .hasMessageContaining("messreihe_viertelstunde_abdeckung_chk");
    }

    /** E5: die Frist ist 7 Tage nach dem INTERVALLENDE — und die Datenbank lässt nichts anderes zu. */
    @Test
    void dieFristIstSiebenTageNachDemIntervallendeUndDerLaufSchreibtNurVorlaeufig() {
        assertThat(zeilen).allSatisfy(z -> {
            assertThat(z.get("zustand")).isEqualTo("vorlaeufig");
            assertThat(z.get("version")).isEqualTo(1);
            assertThat(((Timestamp) z.get("endgueltig_ab")).toInstant())
                    .isEqualTo(((Timestamp) z.get("intervall_beginn")).toInstant()
                            .plus(Duration.ofDays(7)).plus(Duration.ofMinutes(15)));
        });
        assertThatThrownBy(() -> root.update("INSERT INTO messreihe_viertelstunde (intervall_beginn, "
                + "tenant_id, entity_id, messkanal, erhalten, erwartet, kadenz_s, kadenz_herkunft, "
                + "endgueltig_ab) VALUES (?, ?, ?, 'frist', 1, 1, 60, 'vorgabe', ?)",
                Timestamp.from(Instant.parse("2026-11-18T10:30:00Z")), KB, IDS.get("K5"),
                Timestamp.from(Instant.parse("2026-11-25T10:30:00Z"))))
                .hasMessageContaining("endgueltig_ab_chk");
    }

    /**
     * ⚠ Die Grenze zu IP-13: eine ENDGÜLTIGE Zeile rührt dieser Lauf nie an — auch wenn neue
     * Rohwerte für ihr Intervall eintreffen. Das Umschalten und die Spätankunft sind IP-13.
     */
    @Test
    void einEndgueltigerWertWirdVomLaufNieMehrVeraendert() {
        root.update("UPDATE messreihe_viertelstunde SET zustand = 'endgueltig', erhalten = 99 "
                + "WHERE entity_id = ? AND messkanal = 'energy_kwh_a'", IDS.get("A12A"));
        root.update("INSERT INTO messreihe_viertelstunde_arbeit (tenant_id, entity_id, messkanal, "
                + "intervall_beginn, grund) SELECT tenant_id, entity_id, messkanal, intervall_beginn, "
                + "'eingang' FROM messreihe_viertelstunde WHERE entity_id = ? AND messkanal = "
                + "'energy_kwh_a' ON CONFLICT DO NOTHING", IDS.get("A12A"));
        verdichter.verdichteEinenStapel();
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde WHERE entity_id = '"
                + IDS.get("A12A") + "' AND erhalten <> 99")).isZero();
        root.update("UPDATE messreihe_viertelstunde SET zustand = 'vorlaeufig', erhalten = 15 "
                + "WHERE entity_id = ? AND messkanal = 'energy_kwh_a'", IDS.get("A12A"));
    }

    // ======================================================= Arbeitsliste und Lauf

    @Test
    void derErsteLaufSetztNurDenZeigerUndUeberlaesstDieVergangenheitDerRueckrechnung() {
        assertThat(ersterEingangsLauf).isZero();
        assertThat(zeigerNachErstemLauf).isEqualTo(JETZT.minus(ViertelstundeVerdichter.SICHERHEIT));
    }

    @Test
    void dieRueckrechnungLaeuftInScheibenUndIstDanachFertig() {
        assertThat(scheiben).as("90 Tage in Tagesscheiben, plus die Runde, die `fertig` setzt")
                .isBetween(90, 92);
        assertThat(rueckgerechnet).as("jedes Intervall genau einmal eingetragen")
                .isEqualTo(arbeitNachRueckrechnung);
        ViertelstundeVerdichter.Stand stand = verdichter.stand("rueckrechnung");
        assertThat(stand.notiz()).isEqualTo("fertig");
        assertThat(stand.zeitpunkt()).isEqualTo(ViertelstundeRegeln.beginn(
                JETZT.minus(ViertelstundeVerdichter.RUECKRECHNUNG_TIEFE)));
        // Wiederaufnehmbar: eine weitere Runde tut nichts mehr.
        assertThat(verdichter.rueckrechnenGanz(JETZT, 5)).isZero();
        System.out.printf("UEMS IP-12 Rückrechnung: %d Intervalle in %d Scheiben, %d ms; "
                + "Verdichtung: %d Intervalle, %d Zeilen, %d ms%n",
                rueckgerechnet, scheiben, rueckrechnungMs, verdichtet, geschrieben, verdichtungMs);
    }

    @Test
    void derLaufIstWiederholbarUndSchreibtBeimZweitenMalGarNichts() {
        assertThat(geschrieben).as("der erste Lauf schreibt").isPositive();
        assertThat(geschriebenBeimZweitenMal).as("der zweite schreibt keine einzige Zeile").isZero();
        assertThat(zeilenNachWiederholung).as("Zeichen für Zeichen dieselben Zeilen, "
                + "berechnet_am eingeschlossen").isEqualTo(zeilen);
    }

    @Test
    void einAbbruchLaesstNichtsHalbesUndVerliertKeinenEintrag() {
        assertThat(abbruchWarf).as("der Stapel scheitert").isTrue();
        assertThat(arbeitNachAbbruch).as("der Eintrag steht wieder in der Arbeitsliste").isEqualTo(1);
        assertThat(zeilenNachAbbruch).as("keine halbe Zeile").isZero();
        // …und nach dem zweiten Anlauf ist er da.
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde "
                + "WHERE messkanal = 'energy_kwh_abbruch'")).isEqualTo(1);
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde_arbeit "
                + "WHERE messkanal = 'energy_kwh_abbruch'")).isZero();
    }

    /**
     * Der EINGANGS-Weg: ein nachgelieferter Rohwert bringt SEIN Intervall zurück in die
     * Arbeitsliste, ganz ohne festes Fenster — und der Wert trägt seine Zustellart.
     */
    @Test
    void einNachgelieferterRohwertHoltSeinIntervallUeberDieEingangszeitZurueck() {
        assertThat(eingangNachtraeglich).isEqualTo(1);
        Map<String, Object> z = zeile(lese(), IDS.get("EINGANG"), "energy_kwh_eingang",
                "2026-11-18T08:00:00Z");
        assertThat(z).isNotNull();
        assertThat(z.get("n_nachgeliefert")).isEqualTo(1);
        assertThat(z.get("zustellart")).isEqualTo("nachgeliefert");
    }

    /** Die Arbeitsliste trägt ein Intervall höchstens EINMAL — sie kann nicht unbegrenzt wachsen. */
    @Test
    void dieArbeitslisteTraegtEinIntervallHoechstensEinmal() {
        Timestamp t = Timestamp.from(Instant.parse("2026-11-18T10:30:00Z"));
        root.update("INSERT INTO messreihe_viertelstunde_arbeit (tenant_id, entity_id, messkanal, "
                + "intervall_beginn, grund) VALUES (?, ?, 'doppelt', ?, 'eingang') "
                + "ON CONFLICT DO NOTHING", KB, IDS.get("K5"), t);
        root.update("INSERT INTO messreihe_viertelstunde_arbeit (tenant_id, entity_id, messkanal, "
                + "intervall_beginn, grund) VALUES (?, ?, 'doppelt', ?, 'rueckrechnung') "
                + "ON CONFLICT DO NOTHING", KB, IDS.get("K5"), t);
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde_arbeit "
                + "WHERE messkanal = 'doppelt'")).isEqualTo(1);
        root.update("DELETE FROM messreihe_viertelstunde_arbeit WHERE messkanal = 'doppelt'");
    }

    /** E6: JEDE Reihe bekommt Werte — auch die, für die AP-08 gar keine Rechenregel hat. */
    @Test
    void aucheineZustandsreiheBekommtIhrIntervallOhneErfundeneZahl() {
        Map<String, Object> z = zeile(zeilen, IDS.get("TXT"), "state_txt", "2026-11-18T09:00:00Z");
        assertThat(z).isNotNull();
        assertThat(z.get("wertart")).isEqualTo("state");
        assertThat(z.get("mittel")).as("kein Mittel über Zustände").isNull();
        assertThat(z.get("summe")).isNull();
        assertThat(z.get("stand_anfang")).isNull();
        assertThat(z.get("erster_text")).isEqualTo("betrieb");
        assertThat(z.get("letzter_text")).isEqualTo("stoerung");
        assertThat(z.get("erhalten")).isEqualTo(3);
        assertThat(z.get("erwartet")).isEqualTo(15);
        assertThat(z.get("abdeckung_prozent")).isEqualTo(20);
    }

    /** Was nicht `good` ist, wird GEZÄHLT, nicht gerechnet (§4.9 Nr. 6). */
    @Test
    void dieQualitaetszaehlerZaehlenWasNichtGutIst() {
        Map<String, Object> z = zeile(zeilen, IDS.get("QUAL"), "power_kw_qual", "2026-11-18T09:00:00Z");
        assertThat(z.get("n_good")).isEqualTo(2);
        assertThat(z.get("n_uncertain")).isEqualTo(1);
        assertThat(z.get("n_invalid")).isEqualTo(1);
        assertThat(z.get("n_stale")).isEqualTo(1);
        assertThat(z.get("n_device_error")).isEqualTo(1);
        assertThat(z.get("erhalten")).as("nur die guten zählen zur Abdeckung").isEqualTo(2);
        assertThat(z.get("min_wert")).as("die schlechten gehen in keine Rechnung ein")
                .asString().isEqualTo("10.0");
        assertThat(z.get("max_wert")).asString().isEqualTo("11.0");
    }

    /** Ein Spiegel liegt außerhalb der Reihe (§4.7 Nr. 4) und bildet nie ein Intervall. */
    @Test
    void einSpiegelBildetNieEinIntervall() {
        assertThat(zeilen).as("kein Intervall der Spiegel-Reihe")
                .noneSatisfy(z -> assertThat(z.get("messkanal")).isEqualTo("energy_kwh_spiegel"));
        assertThat(zahl("SELECT count(*) FROM device_measurement_sample "
                + "WHERE point_key = 'energy_kwh_spiegel'")).as("die Rohwerte bleiben natürlich")
                .isPositive();
    }

    // ================================================================== Die Vorrichtung

    private static void stammdaten() {
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH')", KB);
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kundenbereich B')", FREMD);
        IDS.put("AN2", uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-2') RETURNING id", KB));
        IDS.put("BOX1", box("VP-BOX-HALLE-1"));
        IDS.put("BOX2", box("VP-BOX-HALLE-2"));

        for (String[] k : new String[][] {
                {"K5", "grid-meter"}, {"A12A", "grid-meter"}, {"A12B", "grid-meter"},
                {"DQ3K", "grid-meter"}, {"TXT", "grid-meter"}, {"KAD", "grid-meter"},
                {"QUAL", "grid-meter"}, {"SPIEGEL", "grid-meter"}, {"ABBRUCH", "grid-meter"},
                {"EINGANG", "grid-meter"}}) {
            IDS.put(k[0], komponente(k[0], k[1]));
        }

        // Die zwei EINBAUTEN desselben Zählers GR-5 (A5): Z-5a bis 10:40, Z-5b ab 10:40.
        IDS.put("Z5A", uuid("INSERT INTO geraet (tenant_id, site_id, kennzeichen, einbau_kennzeichen, "
                + "geraeteart, eingebaut_am, ausgebaut_am) VALUES (?, ?, 'ZW-5', 'Z-5a', 'zaehler', "
                + "'2024-03-12T00:00:00Z', '2026-11-18T10:40:00Z') RETURNING id", KB, IDS.get("AN2")));
        IDS.put("Z5B", uuid("INSERT INTO geraet (tenant_id, site_id, kennzeichen, einbau_kennzeichen, "
                + "geraeteart, eingebaut_am) VALUES (?, ?, 'ZW-5', 'Z-5b', 'zaehler', "
                + "'2026-11-18T10:40:00Z') RETURNING id", KB, IDS.get("AN2")));

        // Die Mess-Selektion ist das zweite Glied der Vorgabe-Kette (60 s je Kanal).
        for (String[] k : new String[][] {
                {"K5", "energy_kwh_k5"}, {"A12A", "energy_kwh_a"}, {"A12B", "energy_kwh_b"},
                {"DQ3K", "power_kw_dq3"}, {"TXT", "state_txt"}, {"KAD", "power_kw_kad"},
                {"QUAL", "power_kw_qual"}, {"SPIEGEL", "energy_kwh_spiegel"},
                {"ABBRUCH", "energy_kwh_abbruch"}, {"EINGANG", "energy_kwh_eingang"}}) {
            root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, "
                    + "entity_id, point_key, enabled, cadence_s, desired_revision, enabled_at, "
                    + "catalog_version, changed_by, apply_status, retention_class, long_term_strategy) "
                    + "VALUES (?, ?, ?, ?, ?, true, 60, 1, '2024-03-12T00:00:00Z', '2026.09.11.1', "
                    + "'test', 'pending_edge', 'live_power', 'fifteen_minute')",
                    KB, IDS.get("AN2"), IDS.get("BOX2"), IDS.get(k[0]), k[1]);
        }

        // Die Datenquelle der Übergabe (A6) — sie trägt das handover-Ereignis.
        IDS.put("DQ3", uuid("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, "
                + "adresse, kadenz_s) VALUES (?, ?, 'DQ-3', 'modbus_tcp', '10.0.2.7:502', 60) "
                + "RETURNING id", KB, IDS.get("AN2")));
        root.update("UPDATE measurement_point SET data_source_id = ? WHERE id = ?",
                IDS.get("DQ3"), IDS.get("DQ3K"));

        // Die ZEITGÜLTIGE Kadenz (IP-10): bis 10:00 gilt 60 s, danach 300 s.
        UUID ms = uuid("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-0001', 'Kadenz-Probe', 'gemessen', "
                + "'Strom', 'Wirkleistung', 'Bezug', 'kW', 'Momentanwert') RETURNING id", KB);
        UUID geraetKad = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, IDS.get("KAD"));
        UUID bindung = uuid("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, "
                + "entity_id, geraet_id, kanal, kanal_wertart, herleitung, rolle, gueltig_ab, "
                + "rueckwirkend, eingetragen_am, actor_sub, actor_name, actor_art) VALUES "
                + "(?, ?, 'Wirkleistung', 'Bezug', ?, ?, 'power_kw_kad', 'gauge', 'momentanwert', "
                + "'fuehrend', '2024-03-12T00:00:00Z', false, now(), 'sub', 'Probe', 'kunde') RETURNING id",
                KB, ms, IDS.get("KAD"), geraetKad);
        root.update("INSERT INTO quelle_kadenz (tenant_id, messstelle_quelle_id, erwartet_s, herkunft, "
                + "gueltig_ab, gueltig_bis, rueckwirkend, actor_sub, actor_name, actor_art) VALUES "
                + "(?, ?, 60, 'eintrag', '2024-03-12T00:00:00Z', '2026-11-18T10:00:00Z', false, 'sub', "
                + "'Probe', 'kunde')", KB, bindung);
        root.update("INSERT INTO quelle_kadenz (tenant_id, messstelle_quelle_id, erwartet_s, herkunft, "
                + "gueltig_ab, rueckwirkend, actor_sub, actor_name, actor_art) VALUES "
                + "(?, ?, 300, 'eintrag', '2026-11-18T10:00:00Z', false, 'sub', 'Probe', 'kunde')",
                KB, bindung);
    }

    private static void rohwerte() {
        // A5 — zehn Minutenwerte 10:30…10:39 auf Z-5a, dann die Lücke des Zählerwechsels.
        for (int i = 0; i < 10; i++) {
            roh(IDS.get("K5"), "energy_kwh_k5", String.format("2026-11-18T10:3%d:00Z", i),
                    1083406.2 + i, IDS.get("Z5A"), IDS.get("BOX2"), "good", "counter", "direkt", null);
        }
        for (int i = 0; i < 13; i++) {
            roh(IDS.get("K5"), "energy_kwh_k5",
                    "2026-11-18T10:" + (47 + i) + ":00Z", 88231.0 + i,
                    IDS.get("Z5B"), IDS.get("BOX2"), "good", "counter", "direkt", null);
        }

        // A12 — dieselben 15 Werte, einmal geordnet, einmal durcheinander zugestellt.
        List<Integer> geordnet = new ArrayList<>();
        for (int i = 0; i < 15; i++) {
            geordnet.add(i);
        }
        List<Integer> wirr = new ArrayList<>(List.of(11, 9, 10, 0, 14, 3, 7, 1, 2, 13, 4, 8, 5, 12, 6));
        for (int i : geordnet) {
            roh(IDS.get("A12A"), "energy_kwh_a", minute("2026-11-18T09:30:00Z", i), 5000.0 + i,
                    IDS.get("Z5B"), IDS.get("BOX2"), "good", "counter", "direkt",
                    Instant.parse("2026-11-18T09:50:00Z").plusSeconds(i));
        }
        for (int n = 0; n < wirr.size(); n++) {
            int i = wirr.get(n);
            roh(IDS.get("A12B"), "energy_kwh_b", minute("2026-11-18T09:30:00Z", i), 5000.0 + i,
                    IDS.get("Z5B"), IDS.get("BOX2"), "good", "counter", "direkt",
                    Instant.parse("2026-11-18T09:50:00Z").plusSeconds(n));
        }

        // A6 — Box Halle 1 bis 07:29:50, Box Halle 2 ab 07:31:10.
        for (int i = 0; i < 15; i++) {
            roh(IDS.get("DQ3K"), "power_kw_dq3", sekunden("2026-11-18T07:15:50Z", i * 60), 40.0 + i,
                    null, IDS.get("BOX1"), "good", "gauge", "direkt", null);
        }
        for (int i = 0; i < 14; i++) {
            roh(IDS.get("DQ3K"), "power_kw_dq3", sekunden("2026-11-18T07:31:10Z", i * 60), 50.0 + i,
                    null, IDS.get("BOX2"), "good", "gauge", "direkt", null);
        }

        // Die zeitgültige Kadenz: je ein Wert im frühen und im späten Intervall.
        for (int i = 0; i < 15; i++) {
            roh(IDS.get("KAD"), "power_kw_kad", minute("2026-11-18T06:00:00Z", i), 12.0 + i,
                    null, IDS.get("BOX2"), "good", "gauge", "direkt", null);
        }
        for (int i = 0; i < 3; i++) {
            roh(IDS.get("KAD"), "power_kw_kad", minute("2026-11-18T11:00:00Z", i * 5), 20.0 + i,
                    null, IDS.get("BOX2"), "good", "gauge", "direkt", null);
        }

        // Eine Zustandsreihe (E6: auch sie bekommt ihr Intervall).
        for (String[] w : new String[][] {{"2026-11-18T09:01:00Z", "betrieb"},
                {"2026-11-18T09:05:00Z", "anlauf"}, {"2026-11-18T09:12:00Z", "stoerung"}}) {
            root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, "
                    + "device_id, point_key, raw_text, quality, catalog_version, edge_sequence, "
                    + "aggregation_kind, entity_id, device_install_id, applied_revision, value_kind, "
                    + "role, delivery, delay_s) VALUES (?, ?, ?, ?, ?, 'state_txt', ?, 'good', "
                    + "'2026.09.11.1', ?, 'state', ?, NULL, 3, 'state', 'fuehrend', 'direkt', 2)",
                    Timestamp.from(Instant.parse(w[0])), Timestamp.from(Instant.parse(w[0]).plusSeconds(2)),
                    KB, IDS.get("AN2"), IDS.get("BOX2"), w[1], Instant.parse(w[0]).getEpochSecond(),
                    IDS.get("TXT"));
        }

        // Die Qualitätszähler: zwei gute, je einer der vier anderen Arten.
        String[] q = {"good", "good", "uncertain", "invalid", "stale", "device_error"};
        for (int i = 0; i < q.length; i++) {
            roh(IDS.get("QUAL"), "power_kw_qual", minute("2026-11-18T09:00:00Z", i), 10.0 + i,
                    null, IDS.get("BOX2"), q[i], "gauge", "direkt", null);
        }

        // Ein Spiegel — außerhalb jeder Reihe.
        for (int i = 0; i < 5; i++) {
            roh(IDS.get("SPIEGEL"), "energy_kwh_spiegel", minute("2026-11-18T09:00:00Z", i), 7.0 + i,
                    null, IDS.get("BOX1"), "good", "counter", "direkt", null, "spiegel");
        }

        // Der nachgelieferte Wert: Messzeit am Morgen, EINGANGSZEIT erst kurz vor JETZT.
        roh(IDS.get("EINGANG"), "energy_kwh_eingang", "2026-11-18T08:00:30Z", 4711.0,
                IDS.get("Z5B"), IDS.get("BOX2"), "good", "counter", "nachgeliefert",
                JETZT.minus(Duration.ofMinutes(5)));

        // Die Reihe des Abbruch-Falls — AUSSERHALB der 90 Tage, damit nur der Abbruch-Test sie
        // anstoesst und die Rueckrechnung sie nicht schon nebenbei verdichtet.
        for (int i = 0; i < 4; i++) {
            roh(IDS.get("ABBRUCH"), "energy_kwh_abbruch", minute("2026-06-01T09:00:00Z", i), 3.0 + i,
                    IDS.get("Z5B"), IDS.get("BOX2"), "good", "counter", "direkt", null);
        }
    }

    private static void ereignisse() {
        // A5: die Gerätegrenze um 10:40 und die Lücke bis zum ersten Wert von Z-5b.
        root.update("INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, "
                + "site_id, kennungen, entity_id, messkanal, nutzlast) VALUES "
                + "('2026-11-18T10:40:00Z', ?, gen_random_uuid(), 'device_boundary', 'kunde', ?, "
                + "jsonb_build_object('komponente', ?::text), ?, 'energy_kwh_k5', "
                + "jsonb_build_object('anlass', 'zaehlerwechsel', 'einbau_alt', 'Z-5a', 'einbau_neu', "
                + "'Z-5b', 'eingetragen_am', '2026-11-18T11:05:00Z', 'endstand', '1083415.2', "
                + "'anfangsstand', '0.0'))",
                KB, IDS.get("AN2"), IDS.get("K5").toString(), IDS.get("K5"));
        root.update("INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, von, "
                + "bis, site_id, kennungen, device_id, entity_id, messkanal, nutzlast) VALUES "
                + "('2026-11-18T10:40:00Z', ?, gen_random_uuid(), 'data_gap', 'writer', "
                + "'2026-11-18T10:40:00Z', '2026-11-18T10:47:00Z', ?, "
                + "jsonb_build_object('box', ?::text, 'komponente', ?::text), ?, ?, 'energy_kwh_k5', "
                + "jsonb_build_object('erkannt_aus', 'kadenz'))",
                KB, IDS.get("AN2"), IDS.get("BOX2").toString(), IDS.get("K5").toString(),
                IDS.get("BOX2"), IDS.get("K5"));
        // A6: die Übergabe hängt an der DATENQUELLE, nicht an der Reihe.
        root.update("INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, von, "
                + "bis, site_id, kennungen, data_source_id, nutzlast) VALUES "
                + "('2026-11-18T07:30:00Z', ?, gen_random_uuid(), 'handover', 'cloud', "
                + "'2026-11-18T07:30:00Z', '2026-11-18T07:31:00Z', ?, "
                + "jsonb_build_object('datenquelle', ?::text), ?, "
                + "jsonb_build_object('anlass', 'uebergabe', 'box_alt', ?::text, 'box_neu', ?::text))",
                KB, IDS.get("AN2"), IDS.get("DQ3").toString(), IDS.get("DQ3"),
                IDS.get("BOX1").toString(), IDS.get("BOX2").toString());
    }

    // ------------------------------------------------------------------------ Helfer

    private static UUID box(String ref) {
        return uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, ?, 'claimed') RETURNING id", KB, IDS.get("AN2"), ref);
    }

    private static UUID komponente(String name, String art) {
        return uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "device_id, communication, connection_json, created_at) VALUES (?, ?, ?, ?, ?, ?, "
                + "'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, "
                + "'2024-03-12T00:00:00Z') RETURNING id",
                KB, IDS.get("AN2"), art, name, art, IDS.get("BOX2"));
    }

    private static void roh(UUID entity, String kanal, String zeit, double wert, UUID einbau, UUID box,
            String qualitaet, String art, String zustellart, Instant eingang) {
        roh(entity, kanal, zeit, wert, einbau, box, qualitaet, art, zustellart, eingang, "fuehrend");
    }

    private static void roh(UUID entity, String kanal, String zeit, double wert, UUID einbau, UUID box,
            String qualitaet, String art, String zustellart, Instant eingang, String rolle) {
        Instant t = Instant.parse(zeit);
        Instant e = eingang == null ? t.plusSeconds(2) : eingang;
        // Auf eine Nachkommastelle festgenagelt: sonst entscheidet die Binaerdarstellung eines
        // double, wie die Datenbank die Zahl ausgibt - und der Fall pruefte Rauschen statt Regel.
        double genau = Double.parseDouble(String.format(java.util.Locale.ROOT, "%.1f", wert));
        root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, "
                + "device_id, point_key, raw_numeric, quality, catalog_version, edge_sequence, "
                + "aggregation_kind, entity_id, device_install_id, applied_revision, value_kind, role, "
                + "delivery, delay_s) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026.09.11.1', ?, ?, ?, ?, 3, "
                + "?, ?, ?, ?)",
                Timestamp.from(t), Timestamp.from(e), KB, IDS.get("AN2"), box, kanal, genau, qualitaet,
                t.getEpochSecond(), art, entity, einbau, art, rolle, zustellart,
                (int) Duration.between(t, e).toSeconds());
    }

    private static String minute(String basis, int plus) {
        return Instant.parse(basis).plus(Duration.ofMinutes(plus)).toString();
    }

    private static String sekunden(String basis, int plus) {
        return Instant.parse(basis).plusSeconds(plus).toString();
    }

    private static UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
    }

    private static int zahl(String sql) {
        return root.queryForObject(sql, Integer.class);
    }

    private static List<Map<String, Object>> lese() {
        return admin.queryForList("SELECT * FROM messreihe_viertelstunde "
                + "ORDER BY entity_id, messkanal, intervall_beginn");
    }

    private static Map<String, Object> zeile(List<Map<String, Object>> alle, UUID entity, String kanal,
            String beginn) {
        Instant t = Instant.parse(beginn);
        return alle.stream()
                .filter(z -> entity.equals(z.get("entity_id")) && kanal.equals(z.get("messkanal"))
                        && t.equals(((Timestamp) z.get("intervall_beginn")).toInstant()))
                .findFirst()
                .orElseThrow(() -> new AssertionError("kein Viertelstundenwert " + kanal + " " + beginn));
    }

    /** Der Inhalt jeder Bestands-Tabelle als ein Wert — ändert sich eine Zeile, ändert er sich. */
    private static Map<String, String> fingerabdruck() {
        Map<String, String> aus = new LinkedHashMap<>();
        for (String tabelle : BESTAND) {
            aus.put(tabelle, root.queryForObject(
                    "SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), 'leer') FROM "
                            + tabelle + " t", String.class));
        }
        return aus;
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
