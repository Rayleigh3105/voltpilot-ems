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
 * Die Migration {@code V20260912180000} und die MENGE je Viertelstunde (UEMS AP-08 IP-2) gegen
 * eine echte TimescaleDB — die Stelle, an der aus gespeicherten Messwerten Verbrauch wird.
 *
 * <p><b>Die Fälle sind die des Vertrags.</b> Gerechnet wird NICHT im Job, sondern in
 * {@link VerbrauchRegeln} (AP-08 IP-1, {@code docs/contracts/v2/verbrauch-vectors.json}, 23
 * handgerechnete Ahrenberg-Fälle mit Python-Zwilling). Dieser Test führt die Rohwerte der Fälle
 * F1, F6, F8, F15, F16 und F20 durch die ganze Strecke — Rohtabelle → Arbeitsliste →
 * Verdichtungs-Lauf → {@code messreihe_viertelstunde} — und vergleicht die geschriebene Zeile mit
 * den Zahlen der Vektor-Datei.
 *
 * <p><b>Was der Vertrag für die Viertelstunde sagt und was nicht.</b> F1, F8 und F15 tragen
 * Viertelstunden-Erwartungen; sie werden Zahl für Zahl geprüft. F16 und F20 tragen in der
 * Vektor-Datei ausschließlich Monats-, Tages- und Zeitraum-Erwartungen — das sind Perioden über
 * der Viertelstunde und damit <b>IP-5</b>. Von ihnen prüft dieses Paket die Viertelstunden-Hälfte:
 * bei F16 die Periodengrenze (P2: der Stand um Mitternacht schließt den Oktober UND eröffnet den
 * November), bei F20 die Lücke über die Tagesgrenze (sie erscheint nie als Null). Was hier NICHT
 * geprüft werden kann, weil es das Paket nicht baut, steht so im PR — geraten wird nichts.
 *
 * <p><b>Die vier Fallen, die keine Zeile verletzen darf:</b>
 *
 * <ol>
 *   <li>Eine Lücke ist nie eine Null (Plan-Abnahmen 1 und 2, F6 und F8).
 *   <li>Abdeckung ist nicht Vollständigkeit — und wird nie auf 100 % gerundet.
 *   <li>Eine Lücke beginnt ÜBER 2 × Kadenz, mit der Kadenz ZUM INTERVALL (IP-10).
 *   <li>Der Faktor der Fassung wirkt genau EINMAL — beim Erfassen, nicht hier.
 * </ol>
 *
 * <p><b>Die Arbeitsliste</b> wird hier direkt gefüllt (ein Eintrag je Viertelstunde, die einen
 * Rohwert hat). Dass der Eingangs-Zeiger und die Rückrechnung sie von selbst füllen, ist AP-07
 * IP-12 und steht in {@link UemsViertelstundeMigrationTest} — dieser Test fragt, was der Lauf
 * SCHREIBT, nicht wie die Intervalle zu ihm kommen.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsViertelstundeMengeTest {

    private static final String DIESE = "20260912180000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    /**
     * Die Uhr, mit der der Verdichtungs-Lauf hier fährt: sie liegt VOR jeder Frist der gesäten
     * Fälle, also ist kein Intervall geschlossen und keine Spätankunft im Spiel (AP-07 IP-13).
     * Dieser Test fragt, was der Lauf RECHNET; die Endgültigkeit prüft
     * {@code UemsEndgueltigkeitTagesklasseTest}.
     */
    private static final Instant JETZT = Instant.parse("2026-10-20T09:00:00Z");

    private static final UUID KB = UUID.fromString("4e0d0000-0000-0000-0000-000000000001");
    private static final UUID FREMD = UUID.fromString("4e0d0000-0000-0000-0000-000000000002");

    /**
     * Die Tabellen, die im Fingerabdruck vorkommen MÜSSEN — die Namen, die der Auftrag nennt:
     * die bestehenden Verdichtungen, das Cockpit, die Erlöse, der Fahrplan, der Verlauf und der
     * Registry-Push. Gemessen wird darüber hinaus JEDE Tabelle des Schemas (siehe
     * {@link #fingerabdruck()}) — diese Liste ist die Probe, dass die Messung sie auch erfasst.
     */
    private static final List<String> BESTAND = List.of(
            "device_measurement_sample", "device_measurement_event",
            "device_measurement_rollup_5m", "device_measurement_rollup_15m",
            "device_measurement_selection", "messreihe_ereignis", "measurement_point",
            "geraet", "geraet_komponente", "messstelle", "messstelle_quelle", "quelle_kadenz",
            "quelle_einstellung", "telemetry", "telemetry_v2", "schedule",
            "site_supply_price", "monthly_market_value", "entity_registry_state",
            "device_command_log", "site_plan_run");

    /**
     * Nicht Teil des Bestands-Fingerabdrucks: die Tabellen, die dieses Paket bearbeitet, und der
     * Laufzustand der Tagesklasse — {@code V20260912190000} (AP-07 IP-13) legt ihn MIT seiner
     * Startzeile an; das ist neuer Inhalt einer späteren Migration, kein Bestand. Alle anderen
     * später angelegten Tabellen misst {@link Bestandsschutz} mit: sie müssen leer bleiben.
     */
    private static final List<String> AUSNAHMEN = List.of("messreihe_viertelstunde%", "messreihe_tag_lauf");

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

    /** Die gesäten Rohwerte je Kanal — der Eingang des REINEN Zwillings für den Gegencheck. */
    private static final Map<String, List<VerbrauchRegeln.Rohwert>> SERIE = new LinkedHashMap<>();

    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;
    private static Map<String, String> fingerNachLauf;

    private static List<Map<String, Object>> zeilen;
    private static List<Map<String, Object>> zeilenNachWiederholung;
    private static int geschriebenBeimZweitenMal;
    private static Map<String, Object> endgueltigeVorher;
    private static Map<String, Object> endgueltigeNachher;
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
        fingerVorher = fingerabdruck();

        flyway().target(DIESE).load().migrate();
        fingerNachMigration = fingerabdruck();
        flyway().load().migrate();

        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        verdichter = new ViertelstundeVerdichter(admin, new MeasurementCatalog(new ObjectMapper()),
                new SpaetankunftMelder(), 500, 40, 200_000);

        arbeitFuellen();
        verdichtenBisLeer();
        zeilen = lese();

        // Wiederholbarkeit: dieselben Intervalle noch einmal durch den Lauf.
        arbeitFuellen();
        int zweitesMal = 0;
        while (true) {
            int[] r = verdichter.verdichteEinenStapel(JETZT);
            zweitesMal += r[1];
            if (r[0] == 0) {
                break;
            }
        }
        geschriebenBeimZweitenMal = zweitesMal;
        zeilenNachWiederholung = lese();

        // Eine ENDGÜLTIGE Zeile bleibt unberührt (die Grenze zu AP-07 IP-13): eine Zeile wird von
        // Hand auf endgueltig gestellt und ihre Menge verbogen — der Lauf darf sie nicht heilen.
        root.update("UPDATE messreihe_viertelstunde SET zustand = 'endgueltig', menge = 999.999, "
                + "menge_zustand = 'vollständig' WHERE entity_id = ? AND messkanal = ? "
                + "AND intervall_beginn = ?",
                IDS.get("F1"), "energy_kwh_f1", Timestamp.from(Instant.parse("2026-10-20T08:00:00Z")));
        endgueltigeVorher = eineZeile(IDS.get("F1"), "energy_kwh_f1", "2026-10-20T08:00:00Z");
        arbeitFuellen();
        verdichtenBisLeer();
        endgueltigeNachher = eineZeile(IDS.get("F1"), "energy_kwh_f1", "2026-10-20T08:00:00Z");
        root.update("UPDATE messreihe_viertelstunde SET zustand = 'vorlaeufig' WHERE entity_id = ? "
                + "AND messkanal = ?", IDS.get("F1"), "energy_kwh_f1");
        // … und wieder vorlaeufig heilt der Lauf sie von selbst — genau das ist der Unterschied.
        arbeitFuellen();
        verdichtenBisLeer();
        assertThat(eineZeile(IDS.get("F1"), "energy_kwh_f1", "2026-10-20T08:00:00Z").get("menge"))
                .asString().isEqualTo("36.000");

        // Abbruchsicherheit: das Schreiben scheitert mitten im Stapel.
        root.update("INSERT INTO messreihe_viertelstunde_arbeit (tenant_id, entity_id, messkanal, "
                + "intervall_beginn, grund) VALUES (?, ?, 'energy_kwh_f1', ?, 'eingang')",
                KB, IDS.get("F1"), Timestamp.from(Instant.parse("2026-10-20T08:15:00Z")));
        root.execute("REVOKE INSERT ON messreihe_viertelstunde FROM " + ADMIN_USER);
        try {
            verdichter.verdichteEinenStapel(JETZT);
            abbruchWarf = false;
        } catch (RuntimeException e) {
            abbruchWarf = true;
        }
        arbeitNachAbbruch = zahl("SELECT count(*) FROM messreihe_viertelstunde_arbeit");
        zeilenNachAbbruch = zahl("SELECT count(*) FROM messreihe_viertelstunde");
        root.execute("GRANT INSERT ON messreihe_viertelstunde TO " + ADMIN_USER);
        verdichtenBisLeer();

        fingerNachLauf = fingerabdruck();
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ================================================================ Die Migration

    @Test
    void dieMigrationLegtNurDanebenUndDerGanzeLaufLaesstDenBestandZeichengleich() {
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).as("nach der Migration")
                .isEmpty();
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachLauf)).as("nach dem ganzen Lauf")
                .isEmpty();
        assertThat(fingerVorher).as("gemessen wird jede Tabelle des Schemas")
                .hasSizeGreaterThan(100)
                .containsKeys(BESTAND.toArray(String[]::new));
    }

    /** Der Vergleich beißt noch: eine geänderte Bestandszeile und eine neue Tabelle mit Inhalt fallen auf. */
    @Test
    void derBestandsvergleichFaengtEineGeaenderteZeile() {
        Bestandsschutz.mutationsprobe(root, AUSNAHMEN, "measurement_point",
                "UPDATE measurement_point SET label = label || ' (Probe)'");
    }

    /** Was PR 698 schon anlegte, wird NICHT doppelt angelegt; ergänzt sind genau vier Spalten. */
    @Test
    void vierNeueSpaltenUndKeineDoppelte() {
        List<String> neu = root.queryForList("SELECT column_name FROM information_schema.columns "
                + "WHERE table_name = 'messreihe_viertelstunde' ORDER BY column_name", String.class);
        assertThat(neu).contains("menge", "menge_zustand", "kennzeichen", "faktor")
                // Abdeckung und Vorläufigkeit standen schon da (AP-07 IP-12) — kein zweites Mal.
                .contains("abdeckung_prozent", "erhalten", "erwartet", "zustand")
                .doesNotContain("abdeckung", "menge_2", "zustand_2");
        assertThat(neu.stream().filter(c -> c.startsWith("abdeckung")).toList())
                .as("genau EINE Abdeckungs-Spalte").hasSize(1);
    }

    /** Die Datenbankgrenze hält die Hausregeln — nicht nur der Java-Code. */
    @Test
    void dieDatenbankgrenzeWeistDasErfundeneAb() {
        // „keine Werte" und eine Menge schließen einander aus.
        assertThatThrownBy(() -> einfuegen("menge_zustand", "'keine Werte'", "menge", "7"))
                .hasMessageContaining("keine_werte_chk");
        // Ein fremdes Zustandswort wird VERWORFEN, nie aufgelöst.
        assertThatThrownBy(() -> einfuegen("menge_zustand", "'teilweise'"))
                .hasMessageContaining("menge_zustand_chk");
        // Kennzeichen sind eine LISTE von Sätzen, kein Objekt und keine leere Zeichenkette.
        assertThatThrownBy(() -> einfuegen("kennzeichen", "'{\"a\":1}'::jsonb"))
                .hasMessageContaining("kennzeichen_chk");
        assertThatThrownBy(() -> einfuegen("kennzeichen", "'[\"\"]'::jsonb"))
                .hasMessageContaining("kennzeichen_chk");
        assertThatThrownBy(() -> einfuegen("faktor", "0"))
                .hasMessageContaining("faktor_chk");
        // Und die Abdeckung wird auch hier nie auf 100 % gerundet (AP-07 IP-12, unverändert).
        assertThatThrownBy(() -> einfuegen("abdeckung_prozent", "100"))
                .hasMessageContaining("abdeckung_chk");
    }

    // ==================================================================== Die Vektoren

    /** F1 — die Grundregel: Menge = Stand(Ende) − Stand(Anfang), 15 von 15, 100 %. */
    @Test
    void f1DerNormalfallZaehlerstand() {
        Map<String, Object> z = eineZeile(IDS.get("F1"), "energy_kwh_f1", "2026-10-20T08:00:00Z");
        assertThat(z.get("menge")).asString().isEqualTo("36.000");
        assertThat(z.get("menge_zustand")).isEqualTo("vollständig");
        assertThat(z.get("erhalten")).isEqualTo(15);
        assertThat(z.get("erwartet")).isEqualTo(15);
        assertThat(z.get("abdeckung_prozent")).isEqualTo(100);
        assertThat(z.get("kennzeichen").toString()).isEqualTo("[]");
        assertThat(z.get("stand_anfang")).asString().isEqualTo("1062113.4");
        assertThat(z.get("stand_ende")).asString().isEqualTo("1062149.4");
        // Und die Stunde des Vertrags (144,0) ist IP-5 — hier steht sie als Summe ihrer vier
        // Viertelstunden, weil die Reihe lückenlos ist. Das ist eine PROBE, keine Periode.
        assertThat(summeDerVierViertelstunden(IDS.get("F1"), "energy_kwh_f1", "2026-10-20T08:00:00Z"))
                .isEqualByComparingTo("144.000");
    }

    /**
     * <b>Plan-Abnahme 1</b> (F6) — der Stand fällt von 6 184,37 auf 0,00: weder −6 184,37 noch
     * +6 184,37 werden Verbrauch. Gezählt wird, was vor und nach dem Sprung gemessen ist.
     */
    @Test
    void planAbnahme1EinZaehlerruecksprungErzeugtKeinenErfundenenVerbrauch() {
        Map<String, Object> z = eineZeile(IDS.get("F6"), "energy_kwh_f6", "2027-01-15T08:00:00Z");
        assertThat(z.get("menge")).as("11,22 vor dem Sprung + 3,06 danach").asString()
                .isEqualTo("14.280");
        assertThat(z.get("menge_zustand")).isEqualTo("unvollständig");
        assertThat(z.get("erhalten")).isEqualTo(15);
        assertThat(z.get("erwartet")).isEqualTo(15);
        assertThat(z.get("abdeckung_prozent")).as("die Abdeckung ist voll - die Menge trotzdem nicht")
                .isEqualTo(100);
        assertThat(z.get("kennzeichen").toString())
                .isEqualTo("[\"Rücksetzung 09:12 ohne Endstand — bis zu 1 Kadenz nicht gezählt\"]");
        BigDecimal menge = (BigDecimal) z.get("menge");
        assertThat(menge).as("weder der Rücksprung noch sein Betrag sind je Verbrauch")
                .isGreaterThan(BigDecimal.ZERO)
                .isLessThan(new BigDecimal("100"));
    }

    /**
     * <b>Plan-Abnahme 2</b> (F8) — Box Halle 2 fällt am 03.11. von 14:00 bis 17:31 aus. Die Lücke
     * erscheint nie als gemessener Stillstand: keine Viertelstunde der Ausfallzeit behauptet
     * 0 kWh, und die angeschnittenen Ränder sagen, was ihnen fehlt.
     */
    @Test
    void planAbnahme2EinBoxAusfallErscheintNieAlsGemessenerStillstand() {
        // 14:00–14:15: nur der EINE Stand um 14:00 — keine Menge bildbar (Vektor: menge null).
        Map<String, Object> rand = eineZeile(IDS.get("F8"), "energy_kwh_f8", "2026-11-03T13:00:00Z");
        assertThat(rand.get("menge")).as("keine Menge - und ganz sicher keine 0").isNull();
        assertThat(rand.get("menge_zustand")).isEqualTo("unvollständig");
        assertThat(rand.get("erhalten")).isEqualTo(1);
        assertThat(rand.get("erwartet")).isEqualTo(15);
        assertThat(rand.get("abdeckung_prozent")).isEqualTo(6);
        assertThat(rand.get("kennzeichen").toString())
                .isEqualTo("[\"nur ein Stand in der Periode — keine Menge bildbar\"]");

        // 14:15 bis 17:30: KEIN Rohwert, also KEINE Zeile. Der Vertrag sagt dazu „keine Werte",
        // die Strecke sagt „nichts" - beide sagen: keine Zahl. Eine 0 steht nirgends.
        for (int i = 0; i < 13; i++) {
            Instant beginn = Instant.parse("2026-11-03T13:15:00Z").plus(Duration.ofMinutes(15L * i));
            assertThat(vielleichtZeile(IDS.get("F8"), "energy_kwh_f8", beginn))
                    .as("Viertelstunde " + beginn + " im Ausfall").isNull();
        }
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde WHERE entity_id = '"
                + IDS.get("F8") + "' AND menge = 0")).as("keine einzige gemessene Null").isZero();
        // Und der Vertrag sagt für so eine Viertelstunde „keine Werte" mit menge null - nachgefragt
        // beim REINEN Zwilling, damit die fehlende Zeile keine stillschweigende Abweichung ist.
        VerbrauchRegeln.Ergebnis leer = zwilling("energy_kwh_f8", "2026-11-03T13:15:00Z", 60);
        assertThat(leer.menge()).isNull();
        assertThat(leer.zustand()).isEqualTo("keine Werte");

        // 17:30–17:45: der Anfang fehlt, 14 von 15, 93 % - die Menge ist der gemessene Teil.
        Map<String, Object> zurueck = eineZeile(IDS.get("F8"), "energy_kwh_f8", "2026-11-03T16:30:00Z");
        assertThat(zurueck.get("menge")).asString().isEqualTo("22.400");
        assertThat(zurueck.get("menge_zustand")).isEqualTo("unvollständig");
        assertThat(zurueck.get("erhalten")).isEqualTo(14);
        assertThat(zurueck.get("erwartet")).isEqualTo(15);
        assertThat(zurueck.get("abdeckung_prozent")).isEqualTo(93);
        assertThat(zurueck.get("kennzeichen").toString())
                .isEqualTo("[\"Anfang nicht gemessen (kein Stand an der Periodengrenze)\"]");
    }

    /**
     * F15 — dieselbe Messstelle, zwei Kadenzen. Die führende 60-s-Reihe hat ein Loch von genau
     * 2 × Kadenz (das ist KEINE Lücke, strikt {@code >}); die 15-min-Vergleichsreihe erwartet
     * genau EINEN Wert je Viertelstunde.
     */
    @Test
    void f15ZweiKadenzenAnDerselbenMessstelle() {
        Map<String, Object> schnell =
                eineZeile(IDS.get("F15A"), "energy_kwh_f15_60s", "2026-10-20T08:00:00Z");
        assertThat(schnell.get("menge")).asString().isEqualTo("24.000");
        assertThat(schnell.get("menge_zustand")).as("das Loch 10:06→10:08 ist GENAU 2 × Kadenz - "
                + "eine Lücke beginnt erst DARÜBER").isEqualTo("vollständig");
        assertThat(schnell.get("erhalten")).isEqualTo(14);
        assertThat(schnell.get("erwartet")).isEqualTo(15);
        assertThat(schnell.get("abdeckung_prozent")).as("vollständig bei 93 % - Abdeckung ist "
                + "NICHT Vollständigkeit").isEqualTo(93);
        assertThat(schnell.get("kennzeichen").toString()).isEqualTo("[]");

        Map<String, Object> langsam =
                eineZeile(IDS.get("F15B"), "energy_kwh_f15_15min", "2026-10-20T08:00:00Z");
        assertThat(langsam.get("kadenz_s")).isEqualTo(900);
        assertThat(langsam.get("menge")).asString().isEqualTo("24.000");
        assertThat(langsam.get("menge_zustand")).isEqualTo("vollständig");
        assertThat(langsam.get("erhalten")).isEqualTo(1);
        assertThat(langsam.get("erwartet")).isEqualTo(1);
        assertThat(langsam.get("abdeckung_prozent")).isEqualTo(100);

        // 10:15–10:30: ein Stand, aber keiner am Ende - volle Abdeckung, keine Menge.
        Map<String, Object> halb =
                eineZeile(IDS.get("F15B"), "energy_kwh_f15_15min", "2026-10-20T08:15:00Z");
        assertThat(halb.get("menge")).isNull();
        assertThat(halb.get("menge_zustand")).isEqualTo("unvollständig");
        assertThat(halb.get("erhalten")).isEqualTo(1);
        assertThat(halb.get("abdeckung_prozent")).isEqualTo(100);
        assertThat(halb.get("kennzeichen").toString())
                .isEqualTo("[\"nur ein Stand in der Periode — keine Menge bildbar\"]");

        // 10:30–10:45: die Ablesung fehlt ganz - keine Zeile. Der Vertrag sagt für sie
        // „unvollständig, keine Menge bildbar"; die fehlende Zeile behauptet nichts anderes.
        assertThat(vielleichtZeile(IDS.get("F15B"), "energy_kwh_f15_15min",
                Instant.parse("2026-10-20T08:30:00Z"))).isNull();
        VerbrauchRegeln.Ergebnis ausgefallen = zwilling("energy_kwh_f15_15min", "2026-10-20T08:30:00Z", 900);
        assertThat(ausgefallen.menge()).isNull();
        assertThat(ausgefallen.erhalten()).isZero();
        assertThat(ausgefallen.abdeckungProzent()).isZero();
    }

    /**
     * F16 — die Monatsgrenze. Die MONATSMENGE (55 100,0 kWh) ist eine Periode über der
     * Viertelstunde und damit IP-5; was IP-2 beweisen kann, ist P2: der Rohwert um Mitternacht
     * schließt den Oktober UND eröffnet den November — dieselbe Zahl zählt in beiden Nachbarn.
     */
    @Test
    void f16DieMonatsgrenzeGehoertBeidenNachbarn() {
        Map<String, Object> oktober =
                eineZeile(IDS.get("F16"), "energy_kwh_f16", "2026-10-31T22:45:00Z");
        Map<String, Object> november =
                eineZeile(IDS.get("F16"), "energy_kwh_f16", "2026-10-31T23:00:00Z");
        assertThat(oktober.get("stand_ende")).as("der Stand um 00:00 schließt die letzte "
                + "Oktober-Viertelstunde").isEqualTo(november.get("stand_anfang"));
        assertThat(((Timestamp) oktober.get("stand_ende_zeit")).toInstant())
                .isEqualTo(Instant.parse("2026-10-31T23:00:00Z"))
                .isEqualTo(((Timestamp) november.get("stand_anfang_zeit")).toInstant());
        assertThat(oktober.get("menge_zustand")).isEqualTo("vollständig");
        assertThat(november.get("menge_zustand")).isEqualTo("vollständig");
        assertThat(oktober.get("erhalten")).isEqualTo(15);
        assertThat(oktober.get("abdeckung_prozent")).isEqualTo(100);
        // 15 Minuten × 1,232662192394 kWh/min = 18,48993… → auf drei Stellen 18,490.
        assertThat(oktober.get("menge")).asString().isEqualTo("18.490");
        assertThat(november.get("menge")).asString().isEqualTo("18.490");
        // Die Grenze wird nicht doppelt gezählt: die 96 Viertelstunden des 31.10. tragen genau
        // den Zuwachs von Mitternacht zu Mitternacht.
        assertThat(admin.queryForObject("SELECT sum(menge) FROM messreihe_viertelstunde "
                + "WHERE entity_id = ? AND messkanal = 'energy_kwh_f16' "
                + "AND intervall_beginn >= ? AND intervall_beginn < ?", BigDecimal.class,
                IDS.get("F16"), Timestamp.from(Instant.parse("2026-10-30T23:00:00Z")),
                Timestamp.from(Instant.parse("2026-10-31T23:00:00Z"))))
                .as("1 440 Minuten × 1,232662192394, auf drei Stellen je Viertelstunde")
                .isEqualByComparingTo("1775.040");
    }

    /**
     * F20 — die Lücke 23:00–01:00 über die Tagesgrenze. Die Tageswerte des Vertrags sind IP-5;
     * hier steht die Viertelstunden-Hälfte: vor der Lücke vollständig, am Rand keine Menge, IN der
     * Lücke gar keine Zeile, danach wieder vollständig. Nirgends eine Null.
     */
    @Test
    void f20DieLueckeUeberDieTagesgrenzeIstNieEineNull() {
        Map<String, Object> davor = eineZeile(IDS.get("F20"), "energy_kwh_f20", "2026-10-20T20:45:00Z");
        assertThat(davor.get("menge")).asString().isEqualTo("24.000");
        assertThat(davor.get("menge_zustand")).isEqualTo("vollständig");

        Map<String, Object> rand = eineZeile(IDS.get("F20"), "energy_kwh_f20", "2026-10-20T21:00:00Z");
        assertThat(rand.get("menge")).isNull();
        assertThat(rand.get("menge_zustand")).isEqualTo("unvollständig");
        assertThat(rand.get("kennzeichen").toString())
                .isEqualTo("[\"nur ein Stand in der Periode — keine Menge bildbar\"]");

        // Die acht Viertelstunden zwischen 23:15 und 01:00 (Ortszeit) haben keinen Rohwert.
        for (int i = 0; i < 7; i++) {
            Instant beginn = Instant.parse("2026-10-20T21:15:00Z").plus(Duration.ofMinutes(15L * i));
            assertThat(vielleichtZeile(IDS.get("F20"), "energy_kwh_f20", beginn))
                    .as("Viertelstunde " + beginn + " in der Lücke").isNull();
        }

        Map<String, Object> danach = eineZeile(IDS.get("F20"), "energy_kwh_f20", "2026-10-20T23:00:00Z");
        assertThat(danach.get("menge")).asString().isEqualTo("24.000");
        assertThat(danach.get("menge_zustand")).isEqualTo("vollständig");
        assertThat(danach.get("stand_anfang")).asString().isEqualTo("404400.0");
        // Der Zuwachs ÜBER die Lücke (192,0 kWh) ist gemessen, aber keiner Viertelstunde
        // zuzuordnen - er steht in KEINER von ihnen. Verteilt wird nichts.
        assertThat(admin.queryForObject("SELECT coalesce(sum(menge), 0) FROM messreihe_viertelstunde "
                + "WHERE entity_id = ? AND messkanal = 'energy_kwh_f20' "
                + "AND intervall_beginn >= ? AND intervall_beginn < ?", BigDecimal.class,
                IDS.get("F20"), Timestamp.from(Instant.parse("2026-10-20T21:00:00Z")),
                Timestamp.from(Instant.parse("2026-10-20T23:00:00Z"))))
                .isEqualByComparingTo("0");
    }

    // ================================================================== Die vier Fallen

    /**
     * Falle 3 — die Lückenschwelle rechnet mit der Kadenz, die ZUM INTERVALL galt (IP-10), nie
     * mit der von „jetzt". Dieselbe Reihe, dasselbe Loch: mit 300 s keine Lücke, mit 60 s eine.
     */
    @Test
    void dieLueckenschwelleNimmtDieKadenzZumIntervall() {
        Map<String, Object> z = eineZeile(IDS.get("KAD"), "energy_kwh_kad", "2026-11-18T10:30:00Z");
        assertThat(z.get("kadenz_s")).as("ab 10:00 gilt 300 s").isEqualTo(300);
        assertThat(z.get("kadenz_herkunft")).isEqualTo("fassung");
        assertThat(z.get("menge")).asString().isEqualTo("15.000");
        assertThat(z.get("menge_zustand")).isEqualTo("vollständig");
        assertThat(z.get("kennzeichen").toString()).as("400 s < 2 × 300 s - keine Lücke")
                .isEqualTo("[]");

        // Mit der Kadenz von „jetzt" (60 s) wäre dasselbe Loch eine Lücke — der Beweis, dass die
        // Wahl der Fassung ergebnisrelevant ist und nicht bloß dekorativ.
        VerbrauchRegeln.Ergebnis mitSechzig = zwilling("energy_kwh_kad", "2026-11-18T10:30:00Z", 60);
        assertThat(mitSechzig.kennzeichen()).anySatisfy(k -> assertThat(k).startsWith("Lücke "));
        assertThat(VerbrauchRegeln.LUECKE_FAKTOR).isEqualTo(ZustandAbleitung.LUECKE_FAKTOR);
    }

    /** Falle 2 — Abdeckung ist nicht Vollständigkeit, und 100 % steht nur, wo es stimmt. */
    @Test
    void abdeckungIstNichtVollstaendigkeitUndNieAufHundertGerundet() {
        // vollständig bei 93 % (F15, das Loch von genau 2 × Kadenz).
        Map<String, Object> vollBei93 =
                eineZeile(IDS.get("F15A"), "energy_kwh_f15_60s", "2026-10-20T08:00:00Z");
        assertThat(vollBei93.get("menge_zustand")).isEqualTo("vollständig");
        assertThat(vollBei93.get("abdeckung_prozent")).isEqualTo(93);
        // unvollständig bei 100 % (F6, der Rücksprung).
        Map<String, Object> unvollBei100 = eineZeile(IDS.get("F6"), "energy_kwh_f6", "2027-01-15T08:00:00Z");
        assertThat(unvollBei100.get("menge_zustand")).isEqualTo("unvollständig");
        assertThat(unvollBei100.get("abdeckung_prozent")).isEqualTo(100);
        // Und nirgends steht 100 %, wo weniger ankam als erwartet.
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde "
                + "WHERE abdeckung_prozent = 100 AND erhalten < erwartet")).isZero();
    }

    /**
     * Falle 4 — der Faktor der Fassung wirkt GENAU EINMAL, nämlich beim Erfassen. An F1 hängt
     * eine Skalierung ×10, gültig zum Intervall: die Menge bleibt 36,0 (nicht 360,0), und die
     * Zeile sagt mit {@code faktor = 1}, womit sie gerechnet hat.
     */
    @Test
    void derFaktorDerFassungWirktGenauEinmalUndZwarNichtHier() {
        assertThat(zahl("SELECT count(*) FROM quelle_einstellung WHERE art = 'skalierung' "
                + "AND entity_id = '" + IDS.get("F1") + "'"))
                .as("die Fassung steht wirklich da und gilt zum Intervall").isEqualTo(1);
        Map<String, Object> z = eineZeile(IDS.get("F1"), "energy_kwh_f1", "2026-10-20T08:00:00Z");
        assertThat(z.get("menge")).as("nicht 360,0 - der Rohwert trägt den Faktor schon")
                .asString().isEqualTo("36.000");
        assertThat(z.get("faktor")).asString().isEqualTo("1");
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde WHERE faktor <> 1")).isZero();
        assertThat(ViertelstundeRegeln.FAKTOR_DER_FASSUNG).isEqualByComparingTo(BigDecimal.ONE);
    }

    // ============================================================ Grenzen und Betrieb

    /** Die Grenze zu AP-07 IP-13: eine ENDGÜLTIGE Zeile wird nie angefasst — auch nicht geheilt. */
    @Test
    void eineEndgueltigeZeileBleibtUnberuehrt() {
        assertThat(endgueltigeVorher).isEqualTo(endgueltigeNachher);
        assertThat(endgueltigeNachher.get("menge")).asString().isEqualTo("999.999");
        assertThat(endgueltigeNachher.get("zustand")).isEqualTo("endgueltig");
    }

    /** Der Lauf korrigiert nie: jede Zeile trägt Version 1 und den Zustand vorläufig. */
    @Test
    void derLaufSchreibtNurVorlaeufigUndNieEineZweiteVersion() {
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde WHERE version <> 1")).isZero();
        assertThat(zahl("SELECT count(*) FROM messreihe_viertelstunde WHERE zustand <> 'vorlaeufig'"))
                .isZero();
    }

    /** Wiederholbar: ein zweiter Lauf über dieselben Intervalle schreibt GAR NICHTS. */
    @Test
    void zweimalUeberDasselbeIntervallErgibtDasselbeUndSchreibtNichts() {
        assertThat(geschriebenBeimZweitenMal).isZero();
        assertThat(zeilenNachWiederholung).isEqualTo(zeilen);
    }

    /** Abbruchsicher: kein halbes Ergebnis, der Eintrag steht wieder in der Arbeitsliste. */
    @Test
    void einAbbruchLaesstNichtsHalbesZurueck() {
        assertThat(abbruchWarf).isTrue();
        assertThat(arbeitNachAbbruch).as("die Entnahme ist mit zurückgerollt").isEqualTo(1);
        assertThat(zeilenNachAbbruch).isEqualTo(zeilen.size());
    }

    /** Der Mandantenzaun gilt auch für die neuen Spalten — eine fremde Menge sieht niemand. */
    @Test
    void derZaunStehtAuchUeberDerMenge() {
        TenantContext.set(KB);
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_viertelstunde "
                + "WHERE menge IS NOT NULL", Long.class)).isPositive();
        TenantContext.set(FREMD);
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_viertelstunde "
                + "WHERE menge IS NOT NULL", Long.class)).isZero();
        TenantContext.set(KB);
        assertThatThrownBy(() -> app.update("UPDATE messreihe_viertelstunde SET menge = 1"))
                .hasMessageContaining("messreihe_viertelstunde");
    }

    /**
     * Eine Reihe ohne Regel von AP-08 (Zustands-, Bitfeld-, Textreihe) behauptet NICHTS: kein
     * Zustand, keine Kennzeichen, keine Menge — statt „unvollständig" zu raten.
     */
    @Test
    void eineReiheOhneRegelBehauptetKeinenZustand() {
        Map<String, Object> z = eineZeile(IDS.get("TXT"), "state_txt", "2026-11-18T09:00:00Z");
        assertThat(z.get("wertart")).isEqualTo("state");
        assertThat(z.get("menge")).isNull();
        assertThat(z.get("menge_zustand")).as("keine Aussage - nicht „unvollständig\"").isNull();
        assertThat(z.get("kennzeichen").toString()).isEqualTo("[]");
        assertThat(z.get("erhalten")).isEqualTo(3);
    }

    // ============================================================ Aufbau der Beispielwelt

    private static void stammdaten() {
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH')", KB);
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kundenbereich B')", FREMD);
        IDS.put("AN2", uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-2') RETURNING id", KB));
        IDS.put("BOX", uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, 'VP-BOX-HALLE-2', 'claimed') RETURNING id", KB, IDS.get("AN2")));

        for (String[] r : new String[][] {
                {"F1", "energy_kwh_f1", "60"}, {"F6", "energy_kwh_f6", "60"},
                {"F8", "energy_kwh_f8", "60"}, {"F15A", "energy_kwh_f15_60s", "60"},
                {"F15B", "energy_kwh_f15_15min", "900"}, {"F16", "energy_kwh_f16", "60"},
                {"F20", "energy_kwh_f20", "60"}, {"KAD", "energy_kwh_kad", "60"},
                {"TXT", "state_txt", "60"}}) {
            IDS.put(r[0], reihe(r[0], r[1], Integer.parseInt(r[2])));
        }

        // Die ZEITGÜLTIGE Kadenz der Reihe KAD (IP-10): bis 10:00 gilt 60 s, danach 300 s.
        UUID ms = uuid("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-0010', 'Kadenz-Probe', 'gemessen', "
                + "'Strom', 'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') RETURNING id", KB);
        UUID geraetKad = root.queryForObject("SELECT geraet_id FROM geraet_komponente "
                + "WHERE entity_id = ? AND gueltig_bis IS NULL", UUID.class, IDS.get("KAD"));
        UUID bindung = uuid("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, "
                + "richtung, entity_id, geraet_id, kanal, kanal_wertart, herleitung, rolle, "
                + "gueltig_ab, rueckwirkend, eingetragen_am, actor_sub, actor_name, actor_art) VALUES "
                + "(?, ?, 'Wirkenergie', 'Bezug', ?, ?, 'energy_kwh_kad', 'counter', 'zaehlerstand', "
                + "'fuehrend', '2024-03-12T00:00:00Z', false, now(), 'sub', 'Probe', 'kunde') "
                + "RETURNING id", KB, ms, IDS.get("KAD"), geraetKad);
        root.update("INSERT INTO quelle_kadenz (tenant_id, messstelle_quelle_id, erwartet_s, "
                + "herkunft, gueltig_ab, gueltig_bis, rueckwirkend, actor_sub, actor_name, actor_art) "
                + "VALUES (?, ?, 60, 'eintrag', '2024-03-12T00:00:00Z', '2026-11-18T10:00:00Z', "
                + "false, 'sub', 'Probe', 'kunde')", KB, bindung);
        root.update("INSERT INTO quelle_kadenz (tenant_id, messstelle_quelle_id, erwartet_s, "
                + "herkunft, gueltig_ab, rueckwirkend, actor_sub, actor_name, actor_art) "
                + "VALUES (?, ?, 300, 'eintrag', '2026-11-18T10:00:00Z', false, 'sub', 'Probe', "
                + "'kunde')", KB, bindung);

        // Die Falle mit dem Faktor: an F1 hängt eine Skalierung ×10, gültig zum Intervall. Sie
        // wirkt BEIM ERFASSEN (`angewendet`, quelle-einstellung.md §3) — der Rohwert trägt sie
        // also schon. Die Cloud darf sie nie ein zweites Mal anwenden.
        UUID geraetF1 = root.queryForObject("SELECT geraet_id FROM geraet_komponente "
                + "WHERE entity_id = ? AND gueltig_bis IS NULL", UUID.class, IDS.get("F1"));
        root.update("INSERT INTO quelle_einstellung (tenant_id, geraet_id, entity_id, kanal, art, "
                + "wert, anwendung, herkunft, gueltig_ab, rueckwirkend, actor_name, actor_art) "
                + "VALUES (?, ?, ?, 'energy_kwh_f1', 'skalierung', jsonb_build_object('faktor', 10), "
                + "'angewendet', 'verbindung', '2024-03-12T00:00:00Z', false, 'VoltPilot', "
                + "'voltpilot')", KB, geraetF1, IDS.get("F1"));
    }

    /** Eine Reihe: Komponente + Mess-Selektion (das zweite Glied der Kadenz-Kette). */
    private static UUID reihe(String name, String kanal, int kadenzS) {
        UUID entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, communication, connection_json, created_at) VALUES "
                + "(?, ?, 'grid-meter', ?, 'grid-meter', ?, 'modbus_tcp', "
                + "'{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, '2024-03-12T00:00:00Z') RETURNING id",
                KB, IDS.get("AN2"), name, IDS.get("BOX"));
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, "
                + "entity_id, point_key, enabled, cadence_s, desired_revision, enabled_at, "
                + "catalog_version, changed_by, apply_status, retention_class, long_term_strategy) "
                + "VALUES (?, ?, ?, ?, ?, true, ?, 1, '2024-03-12T00:00:00Z', '2026.09.11.1', "
                + "'test', 'pending_edge', 'live_power', 'fifteen_minute')",
                KB, IDS.get("AN2"), IDS.get("BOX"), entity, kanal, kadenzS);
        return entity;
    }

    private static void rohwerte() {
        // F1 — MS-06, 20.10.2026 10:00–11:00 (+02:00), 60 s, 2,4 kWh je Minute.
        reiheSaeen("energy_kwh_f1", IDS.get("F1"), "2026-10-20T08:00:00Z", 61,
                "1062113.4", "2.4", List.of());
        // F15 führend — dieselbe Stunde, aber der Wert 10:07 fehlt (Loch von genau 2 × Kadenz).
        reiheSaeen("energy_kwh_f15_60s", IDS.get("F15A"), "2026-10-20T08:00:00Z", 61,
                "400000.0", "1.6", List.of(7));
        // F15 Vergleich — der Abrechnungszähler mit 15-min-Ständen; die Ablesung 10:30 fehlt.
        for (String[] w : new String[][] {
                {"2026-10-20T08:00:00Z", "400000.0"}, {"2026-10-20T08:15:00Z", "400024.0"},
                {"2026-10-20T08:45:00Z", "400072.0"}, {"2026-10-20T09:00:00Z", "400096.0"}}) {
            einzeln("energy_kwh_f15_15min", IDS.get("F15B"), w[0], new BigDecimal(w[1]), "counter");
        }
        // F6 — Plan-Abnahme 1: der Stand fällt um 09:12 von 6 184,37 auf 0,00.
        reiheSaeen("energy_kwh_f6", IDS.get("F6"), "2027-01-15T08:00:00Z", 12,
                "6173.15", "1.02", List.of());
        reiheSaeen("energy_kwh_f6", IDS.get("F6"), "2027-01-15T08:12:00Z", 4,
                "0.0", "1.02", List.of());
        // F8 — Plan-Abnahme 2: Box Halle 2 fällt am 03.11. von 14:00 bis 17:31 aus.
        reiheSaeen("energy_kwh_f8", IDS.get("F8"), "2026-11-02T23:00:00Z", 841,
                "416856.0", "1.6", List.of());
        reiheSaeen("energy_kwh_f8", IDS.get("F8"), "2026-11-03T16:31:00Z", 390,
                "418537.6", "1.6", List.of());
        // F16 — die Monatsgrenze: der 31.10. und die erste Viertelstunde des Novembers. Der Stand
        // führt die Reihe des Vertrags fort (Beginn 01.10. 00:00 +02:00 mit 1 027 615,3).
        BigDecimal proMinute = new BigDecimal("1.232662192394");
        BigDecimal standAmDreissigsten =
                new BigDecimal("1027615.3").add(proMinute.multiply(BigDecimal.valueOf(43260)));
        reiheSaeen("energy_kwh_f16", IDS.get("F16"), "2026-10-30T23:00:00Z", 1456,
                standAmDreissigsten.toPlainString(), proMinute.toPlainString(), List.of());
        // F20 — die Lücke 23:00–01:00 über die Tagesgrenze.
        reiheSaeen("energy_kwh_f20", IDS.get("F20"), "2026-10-20T20:00:00Z", 61,
                "404112.0", "1.6", List.of());
        reiheSaeen("energy_kwh_f20", IDS.get("F20"), "2026-10-20T23:00:00Z", 61,
                "404400.0", "1.6", List.of());
        // KAD — vier Stände mit einem Loch von 400 s: mit 300 s Kadenz keine Lücke, mit 60 s eine.
        for (String[] w : new String[][] {
                {"2026-11-18T10:30:00Z", "1000.0"}, {"2026-11-18T10:35:00Z", "1005.0"},
                {"2026-11-18T10:41:40Z", "1012.0"}, {"2026-11-18T10:45:00Z", "1015.0"}}) {
            einzeln("energy_kwh_kad", IDS.get("KAD"), w[0], new BigDecimal(w[1]), "counter");
        }
        // Eine Zustandsreihe — AP-08 kennt für sie keine Regel.
        for (String[] w : new String[][] {
                {"2026-11-18T09:00:00Z", "betrieb"}, {"2026-11-18T09:05:00Z", "bereich"},
                {"2026-11-18T09:10:00Z", "betrieb"}}) {
            Instant t = Instant.parse(w[0]);
            root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, "
                    + "site_id, device_id, point_key, raw_text, quality, catalog_version, "
                    + "edge_sequence, aggregation_kind, entity_id, applied_revision, value_kind, "
                    + "role, delivery, delay_s) VALUES (?, ?, ?, ?, ?, 'state_txt', ?, 'good', "
                    + "'2026.09.11.1', ?, 'state', ?, 3, 'state', 'fuehrend', 'direkt', 2)",
                    Timestamp.from(t), Timestamp.from(t.plusSeconds(2)), KB, IDS.get("AN2"),
                    IDS.get("BOX"), w[1], t.getEpochSecond(), IDS.get("TXT"));
        }
    }

    /**
     * Ein Abschnitt der Vektor-Form {@code {von, kadenz 60 s, stand_von, zuwachs_je_kadenz}}:
     * {@code anzahl} Minutenwerte ab {@code von}, die Minuten in {@code ausgelassen} fehlen.
     */
    private static void reiheSaeen(String kanal, UUID entity, String von, int anzahl,
            String standVon, String zuwachs, List<Integer> ausgelassen) {
        Instant start = Instant.parse(von);
        BigDecimal stand = new BigDecimal(standVon);
        BigDecimal schritt = new BigDecimal(zuwachs);
        List<Object[]> stapel = new ArrayList<>();
        for (int i = 0; i < anzahl; i++) {
            if (ausgelassen.contains(i)) {
                continue;
            }
            Instant t = start.plus(Duration.ofMinutes(i));
            BigDecimal wert = stand.add(schritt.multiply(BigDecimal.valueOf(i)));
            stapel.add(zeilenwerte(kanal, entity, t, wert, "counter"));
            SERIE.computeIfAbsent(kanal, k -> new ArrayList<>())
                    .add(new VerbrauchRegeln.Rohwert(t, wert, true));
        }
        root.batchUpdate(ROH_SQL, stapel);
    }

    private static void einzeln(String kanal, UUID entity, String zeit, BigDecimal wert, String art) {
        Instant t = Instant.parse(zeit);
        root.update(ROH_SQL, zeilenwerte(kanal, entity, t, wert, art));
        SERIE.computeIfAbsent(kanal, k -> new ArrayList<>())
                .add(new VerbrauchRegeln.Rohwert(t, wert, true));
    }

    private static final String ROH_SQL =
            "INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, "
                    + "device_id, point_key, raw_numeric, quality, catalog_version, edge_sequence, "
                    + "aggregation_kind, entity_id, applied_revision, value_kind, role, delivery, "
                    + "delay_s) VALUES (?, ?, ?, ?, ?, ?, ?, 'good', '2026.09.11.1', ?, ?, ?, 3, "
                    + "?, 'fuehrend', 'direkt', 2)";

    private static Object[] zeilenwerte(String kanal, UUID entity, Instant t, BigDecimal wert,
            String art) {
        return new Object[] {Timestamp.from(t), Timestamp.from(t.plusSeconds(2)), KB, IDS.get("AN2"),
                IDS.get("BOX"), kanal, wert, t.getEpochSecond(), art, entity, art};
    }

    // ------------------------------------------------------------------------ Der Lauf

    /** Ein Eintrag je Viertelstunde, die mindestens einen Rohwert hat. */
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

    private static void verdichtenBisLeer() {
        while (verdichter.verdichteEinenStapel(JETZT)[0] > 0) {
            // weiter, bis die Arbeitsliste leer ist
        }
    }

    // ------------------------------------------------------------------------ Helfer

    /** Der REINE Zwilling zu derselben Viertelstunde — die Gegenprobe zur geschriebenen Zeile. */
    private static VerbrauchRegeln.Ergebnis zwilling(String kanal, String beginn, int kadenzS) {
        Instant von = Instant.parse(beginn);
        return VerbrauchRegeln.ergebnis("zaehlerstand", SERIE.get(kanal), von,
                von.plus(Duration.ofMinutes(15)), Duration.ofSeconds(kadenzS), List.of(),
                ViertelstundeRegeln.FAKTOR_DER_FASSUNG, null, null, false);
    }

    private static BigDecimal summeDerVierViertelstunden(UUID entity, String kanal, String beginn) {
        return admin.queryForObject("SELECT sum(menge) FROM messreihe_viertelstunde "
                + "WHERE entity_id = ? AND messkanal = ? AND intervall_beginn >= ? "
                + "AND intervall_beginn < ?", BigDecimal.class, entity, kanal,
                Timestamp.from(Instant.parse(beginn)),
                Timestamp.from(Instant.parse(beginn).plus(Duration.ofHours(1))));
    }

    private static void einfuegen(String... spalteUndWert) {
        List<String> spalten = new ArrayList<>(List.of("intervall_beginn", "tenant_id", "entity_id",
                "messkanal", "erhalten", "erwartet", "kadenz_s", "kadenz_herkunft", "endgueltig_ab"));
        List<String> werte = new ArrayList<>(List.of("'2026-12-01T10:30:00Z'", "'" + KB + "'",
                "'" + IDS.get("F1") + "'", "'probe'", "0", "5", "60", "'vorgabe'",
                "'2026-12-08T10:45:00Z'"));
        for (int i = 0; i < spalteUndWert.length; i += 2) {
            spalten.add(spalteUndWert[i]);
            werte.add(spalteUndWert[i + 1]);
        }
        root.update("INSERT INTO messreihe_viertelstunde (" + String.join(", ", spalten)
                + ") VALUES (" + String.join(", ", werte) + ")");
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

    private static Map<String, Object> eineZeile(UUID entity, String kanal, String beginn) {
        Map<String, Object> z = vielleichtZeile(entity, kanal, Instant.parse(beginn));
        if (z == null) {
            throw new AssertionError("kein Viertelstundenwert " + kanal + " " + beginn);
        }
        return z;
    }

    private static Map<String, Object> vielleichtZeile(UUID entity, String kanal, Instant beginn) {
        List<Map<String, Object>> treffer = admin.queryForList(
                "SELECT * FROM messreihe_viertelstunde WHERE entity_id = ? AND messkanal = ? "
                        + "AND intervall_beginn = ?", entity, kanal, Timestamp.from(beginn));
        return treffer.isEmpty() ? null : treffer.get(0);
    }

    /**
     * Der Inhalt JEDER Tabelle des Schemas als ein Wert — ändert sich irgendwo eine Zeile, ändert
     * er sich. Ausgenommen ist nur {@link #AUSNAHMEN}; was eine SPÄTERE Migration anlegt, misst
     * {@link Bestandsschutz} mit (leer oder Abweichung).
     */
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
