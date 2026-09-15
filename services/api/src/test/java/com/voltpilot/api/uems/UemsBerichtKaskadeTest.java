package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.measurement.MeasurementCatalog;
import java.lang.reflect.RecordComponent;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Kaskaden-Naht der Berichte gegen die echte Datenbank (UEMS AP-12 IP-8, Pfad 1) — Meilenstein 3 „Revision
 * ausgelöst“: ein Bericht merkt von selbst, dass sich unter ihm etwas geändert hat.
 *
 * <p>Wie in {@code UemsKennzahlKaskadeTest} läuft die Naht in EINER Transaktion der Verwaltungsrolle, wie ein Anlass der
 * Kaskade: erst die Monats-Version der Reihe von MS-12 (so, wie die Stufe sie schreibt), dann
 * {@link KorrekturKaskade#berichteBenachrichtigen} — die Stelle, an der die Kaskade entscheidet, welcher Bericht welchen
 * Weg geht. Die Bildung ist die echte {@link BerichtAbzugBildung}; die Stände entstehen mit denselben Anweisungen wie in
 * der Route ({@link BerichtRepository#standEinfrieren}).
 *
 * <p>⚠ Grenzen, benannt: der zweite betroffene Bericht in B3 ist im Vertrag der Unternehmensbericht BR-2026-0002 — seinen
 * Abzug bildet erst AP-12 IP-6. Die Anfrage an das Quellenverzeichnis prüft der Vertrags-Lauf
 * ({@link #b3UndB7BetroffeneWieDerVertrag_ueberDasQuellenverzeichnisDerDatenbank}) mit ihm; der Kaskaden-Lauf nimmt als
 * zweiten Bericht den Jahresbericht Werk Ahrenberg 2026. Die Bezugsgrößen trägt Pfad 1 erst mit AP-11 IP-9
 * ({@link #dieBezugsgroessenTraegtPfadEinsErstMitAp11Ip9_bisDahinPfadZwei}).
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsBerichtKaskadeTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");

    private static final String ENERGIE = "sunspec.model_203.totwhimp";
    private static final String KATALOG = "2026.09.11.1";
    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    private static final LocalDate OKT_1 = LocalDate.parse("2026-10-01");
    private static final LocalDate OKT_31 = LocalDate.parse("2026-10-31");
    private static final String K7 = "K-2026-0007";
    private static final String MONATSBERICHT = "monatsbericht_standort";
    private static final String JAHRESBERICHT = "jahresbericht_standort";

    /** Datenstand von Nr. 1: 10.11.2026 08:55 (MEZ) — freigegeben um 09:02. */
    private static final Instant DATENSTAND_NR1 = Instant.parse("2026-11-10T07:55:00Z");
    private static final Instant FREIGABE_NR1 = Instant.parse("2026-11-10T08:02:00Z");
    /** Die Kaskade von K-2026-0007: 12.11.2026 10:05:33 (MEZ, Referenzdatei 1.4). */
    private static final Instant T_KASKADE = Instant.parse("2026-11-12T09:05:33Z");
    /** Die Revision Nr. 2: 16.11.2026 14:20 (MEZ). */
    private static final Instant FREIGABE_NR2 = Instant.parse("2026-11-16T13:20:00Z");
    /** Der Zweig aus B7: die Rücknahme von K-2026-0007 (Fassung 3) am 24.11.2026. */
    private static final Instant T_RUECKNAHME = Instant.parse("2026-11-24T09:00:00Z");

    private static final ProtokollAkteur INES = new ProtokollAkteur("kc-ines-kaltenbach", "Ines Kaltenbach",
            "energiemanager", "kunde");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static final AtomicInteger NR = new AtomicInteger();
    private static DataSource rootDs;
    private static JdbcTemplate root;
    private static DataSource admin;
    private static JsonNode vektoren;
    private static BerichtAbzugBildung bildung;
    private static BerichtKaskade naht;

    /** Ein Kundenbereich: ST-1 mit Halle 2 (MS-10, MS-12), ST-2 mit der Montagehalle Lindach (MS-16, MS-18). */
    private record Welt(UUID mandant, UUID st1, UUID st2, Map<String, UUID> messstellen, Map<String, UUID> komponenten,
            Map<String, UUID> berichte) {}

    @FunctionalInterface
    private interface Schritt {
        void fahren(Connection con) throws SQLException;
    }

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
        rootDs = ds(POSTGRES.getUsername(), POSTGRES.getPassword());
        root = new JdbcTemplate(rootDs);
        admin = ds(ADMIN_USER, ADMIN_PW);
        vektoren = JSON.readTree(Files.readString(V2.resolve("bericht-vectors.json")));
        bildung = new BerichtAbzugBildung(new MeasurementCatalog(JSON), JSON, BerichtRegelwerk.heute(null, null, "ip8-test"));
        naht = new BerichtKaskade(bildung);
    }

    // ================================================================ B1/B2/B3: die Kaskade trifft, was zitiert

    /**
     * K-2026-0007 in EINER Transaktion der Kaskade: {@code betroffene} liefert drei Einträge für zwei Berichte — Nr. 1 und
     * Entwurf von BR-2026-0001, den Entwurf des Jahresberichts; Lindach nicht. Nr. 1 bekommt den Anstoß (eine Zeile, eine
     * Meldung {@code bericht_revision_angestossen}) und bleibt Byte für Byte, wie er war — dieselbe Prüfsumme, dieselben
     * Quellen. Beide Entwürfe sind neu gebildet (MS-12 = 6 040 kWh in Version 2, Datenstand 12.11.2026 10:05:33,
     * {@code gebildet_von} kaskade) und melden {@code bericht_entwurf_neu_gebildet} mit dem Anlass, den die Route liest. Ein
     * fremder Kundenbereich mit derselben Kennung bleibt unberührt.
     */
    @Test
    void b1B2B3DieKaskadeStoesstNummerEinsAnBildetDieEntwuerfeNeuUndNummerEinsBleibtByteGleich() throws Exception {
        Welt fremd = welt();
        anlegen(fremd, "BR-2026-0001", MONATSBERICHT, "monat", "2026-10", fremd.st1());
        freigeben(fremd, "BR-2026-0001", 1, DATENSTAND_NR1, FREIGABE_NR1);
        String fremdVorher = berichtsTabellen(fremd);

        Welt w = welt();
        anlegen(w, "BR-2026-0001", MONATSBERICHT, "monat", "2026-10", w.st1());
        anlegen(w, "BR-2027-0001", JAHRESBERICHT, "jahr", "2026", w.st1());
        anlegen(w, "BR-2026-0003", MONATSBERICHT, "monat", "2026-10", w.st2());
        freigeben(w, "BR-2026-0001", 1, DATENSTAND_NR1, FREIGABE_NR1);
        freigeben(w, "BR-2026-0003", 1, DATENSTAND_NR1, FREIGABE_NR1);
        Map<String, Object> nr1 = stand(w, "BR-2026-0001", 1);
        assertThat(wert((String) nr1.get("abzug"), "MS-12").path("menge").decimalValue())
                .as("Nr. 1 zitiert Version 1").isEqualByComparingTo(vektorWert("MS-12"));
        String staende = Bestandsschutz.inhalt(root, "bericht_stand", "t.tenant_id = ?", w.mandant());
        String standQuellen = Bestandsschutz.inhalt(root, "bericht_quelle", "t.tenant_id = ? AND t.stand_nr IS NOT NULL",
                w.mandant());
        String lindach = Bestandsschutz.inhalt(root, "bericht_entwurf", "t.bericht_id = ?",
                w.berichte().get("BR-2026-0003"));

        List<BerichteNaht.Bericht> treffer = new ArrayList<>();
        inDerKaskade(con -> {
            ms12Version(con, w, 2, "6040", List.of(K7), 2);
            treffer.addAll(naht.betroffene(con, k7(w, 2, KorrekturKaskade.FREIGEGEBEN, T_KASKADE)));
            KorrekturKaskade.berichteBenachrichtigen(con, naht, k7(w, 2, KorrekturKaskade.FREIGEGEBEN, T_KASKADE));
        });

        assertThat(treffer).as("B3: drei Einträge für zwei Berichte — Lindach bleibt unberührt").containsExactly(
                new BerichteNaht.Bericht("BR-2026-0001", BerichteNaht.Stand.FREIGEGEBEN),
                new BerichteNaht.Bericht("BR-2026-0001", BerichteNaht.Stand.ENTWURF),
                new BerichteNaht.Bericht("BR-2027-0001", BerichteNaht.Stand.ENTWURF));

        // Nr. 1 bleibt, wie er ist — Invariante 1.
        assertThat(Bestandsschutz.inhalt(root, "bericht_stand", "t.tenant_id = ?", w.mandant()))
                .as("jeder Stand Zeichen für Zeichen").isEqualTo(staende);
        assertThat(Bestandsschutz.inhalt(root, "bericht_quelle", "t.tenant_id = ? AND t.stand_nr IS NOT NULL",
                w.mandant())).as("die eingefrorenen Quellen").isEqualTo(standQuellen);
        assertThat(stand(w, "BR-2026-0001", 1).get("pruefsumme")).isEqualTo(nr1.get("pruefsumme"))
                .isEqualTo(BerichtRegeln.pruefsumme((String) nr1.get("abzug")));

        // … und bekommt den Anstoß.
        assertThat(anstoesse(w)).containsExactly(
                "BR-2026-0001 Nr. 1 | korrektur_freigegeben | K-2026-0007 Fassung 2 freigegeben | offen");
        List<JsonNode> angestossen = meldungen(w, BerichtKaskade.ANGESTOSSEN);
        assertThat(angestossen).hasSize(1);
        JsonNode a = angestossen.get(0);
        assertThat(a.path("bericht").asText()).isEqualTo("BR-2026-0001");
        assertThat(a.path("nr").asInt()).isEqualTo(1);
        assertThat(a.path("anstoss_art").asText()).isEqualTo("korrektur_freigegeben");
        assertThat(a.path("anlass_kennung").asText()).isEqualTo(K7);
        assertThat(a.path("anlass_fassung").asInt()).isEqualTo(2);
        assertThat(a.path("urheber").asText()).isEqualTo("cloud");
        assertThat(a.path("zeit").asText()).isEqualTo(T_KASKADE.toString());
        assertThat(root.queryForObject("SELECT ereignis_id FROM bericht_revision_anstoss WHERE tenant_id = ?", UUID.class,
                w.mandant())).hasToString(a.path("ereignis_id").asText());

        // B2: der Entwurf bildet sich neu — der Datenstand ist der der Kaskade, nicht der einer Freigabe.
        Map<String, Object> entwurf = entwurf(w, "BR-2026-0001");
        assertThat(entwurf.get("gebildet_von")).isEqualTo("kaskade");
        assertThat(((Timestamp) entwurf.get("datenstand")).toInstant()).isEqualTo(T_KASKADE);
        JsonNode ms12 = wert((String) entwurf.get("abzug"), "MS-12");
        assertThat(ms12.path("menge").decimalValue()).isEqualByComparingTo("6040");
        assertThat(ms12.path("version").asInt()).isEqualTo(2);
        assertThat(BerichtRegeln.abweichungen(JSON.readTree((String) nr1.get("abzug")),
                JSON.readTree((String) entwurf.get("abzug")))).as("der Vergleich Entwurf gegen Nr. 1 (R1)")
                .anySatisfy(x -> {
                    assertThat(x.quelle()).isEqualTo("MS-12");
                    assertThat(x.vorher()).isEqualByComparingTo(vektorWert("MS-12"));
                    assertThat(x.nachher()).isEqualByComparingTo("6040");
                });
        assertThat(root.queryForObject("SELECT version FROM bericht_quelle WHERE tenant_id = ? AND bericht_id = ? "
                + "AND stand_nr IS NULL AND kennzeichen = 'MS-12' AND bezug = 'unmittelbar'", Integer.class, w.mandant(),
                w.berichte().get("BR-2026-0001"))).as("das Quellenverzeichnis des Entwurfs").isEqualTo(2);
        assertThat(entwurf(w, "BR-2027-0001").get("gebildet_von")).isEqualTo("kaskade");
        assertThat(Bestandsschutz.inhalt(root, "bericht_entwurf", "t.bericht_id = ?", w.berichte().get("BR-2026-0003")))
                .as("Lindach: der Entwurf Zeichen für Zeichen").isEqualTo(lindach);

        List<JsonNode> neu = meldungen(w, BerichtKaskade.NEU_GEBILDET);
        assertThat(neu).extracting(n -> n.path("bericht").asText() + " | " + n.path("datenstand").asText() + " | "
                + n.path("anlass_kennung").asText() + " | " + n.path("urheber").asText()).containsExactly(
                        "BR-2026-0001 | 2026-11-12T09:05:33Z | K-2026-0007 | cloud",
                        "BR-2027-0001 | 2026-11-12T09:05:33Z | K-2026-0007 | cloud");
        assertThat(new BerichtRepository(root).anlassDerNeubildung(w.mandant(), "BR-2026-0001", T_KASKADE))
                .as("der Anlass, den der 409 entwurf_veraltet der Route nennt").isEqualTo(K7);

        assertThat(berichtsTabellen(fremd)).as("der fremde Kundenbereich").isEqualTo(fremdVorher);
    }

    // ================================================================ B7: Rücknahme und Idempotenz

    /**
     * B7, der Zweig: Nr. 2 ist freigegeben (sie erledigt den Anstoß an Nr. 1), dann wird K-2026-0007 zurückgenommen —
     * Version 3 = der Stand vor der Korrektur. Den Anstoß bekommt Nr. 2, der gültige Stand; Nr. 1 ist ersetzt und wird
     * nicht wieder gültig. Derselbe Anstoß zweimal — im nächsten Takt und zweimal in derselben Transaktion — bleibt EINE
     * Zeile mit EINER Meldung. Der Entwurf bildet sich bei jeder Wiederholung neu (sein Datenstand ist der seiner Bildung,
     * EW1); die Stände bleiben Zeichen für Zeichen.
     */
    @Test
    void b7DieRuecknahmeStoesstNummerZweiAnNummerEinsNichtUndZweimalBleibtEsEineZeile() throws Exception {
        Welt w = welt();
        anlegen(w, "BR-2026-0001", MONATSBERICHT, "monat", "2026-10", w.st1());
        freigeben(w, "BR-2026-0001", 1, DATENSTAND_NR1, FREIGABE_NR1);
        inDerKaskade(con -> {
            ms12Version(con, w, 2, "6040", List.of(K7), 2);
            KorrekturKaskade.berichteBenachrichtigen(con, naht, k7(w, 2, KorrekturKaskade.FREIGEGEBEN, T_KASKADE));
        });
        freigeben(w, "BR-2026-0001", 2, T_KASKADE, FREIGABE_NR2);
        String nr1Erledigt = "BR-2026-0001 Nr. 1 | korrektur_freigegeben | K-2026-0007 Fassung 2 freigegeben | erledigt "
                + "durch Nr. 2";
        assertThat(anstoesse(w)).containsExactly(nr1Erledigt);
        String staende = Bestandsschutz.inhalt(root, "bericht_stand", "t.tenant_id = ?", w.mandant());

        KorrekturKaskade.Betroffen ruecknahme = k7(w, 3, KorrekturKaskade.ZURUECKGENOMMEN, T_RUECKNAHME);
        inDerKaskade(con -> {
            ms12Version(con, w, 3, vektorWert("MS-12").toPlainString(), List.of(), 3);
            KorrekturKaskade.berichteBenachrichtigen(con, naht, ruecknahme);
        });
        assertThat(anstoesse(w)).containsExactly(nr1Erledigt,
                "BR-2026-0001 Nr. 2 | korrektur_zurueckgenommen | K-2026-0007 Fassung 3 zurueckgenommen | offen");
        assertThat(meldungen(w, BerichtKaskade.ANGESTOSSEN)).extracting(m -> m.path("nr").asInt() + " "
                + m.path("anstoss_art").asText()).containsExactly("1 korrektur_freigegeben", "2 korrektur_zurueckgenommen");
        JsonNode ms12 = wert((String) entwurf(w, "BR-2026-0001").get("abzug"), "MS-12");
        assertThat(ms12.path("menge").decimalValue()).isEqualByComparingTo(vektorWert("MS-12"));
        assertThat(ms12.path("version").asInt()).isEqualTo(3);
        String anstossZeilen = Bestandsschutz.inhalt(root, "bericht_revision_anstoss", "t.tenant_id = ?", w.mandant());
        String angestossen = Bestandsschutz.inhalt(root, "messreihe_ereignis", "t.tenant_id = ? AND t.art = ?",
                w.mandant(), BerichtKaskade.ANGESTOSSEN);

        inDerKaskade(con -> KorrekturKaskade.berichteBenachrichtigen(con, naht,
                k7(w, 3, KorrekturKaskade.ZURUECKGENOMMEN, T_RUECKNAHME.plusSeconds(300))));
        BerichteNaht.Bericht nr2 = new BerichteNaht.Bericht("BR-2026-0001", BerichteNaht.Stand.FREIGEGEBEN);
        inDerKaskade(con -> {
            naht.revisionAusloesen(con, nr2, ruecknahme);
            naht.revisionAusloesen(con, nr2, ruecknahme);
        });
        assertThat(Bestandsschutz.inhalt(root, "bericht_revision_anstoss", "t.tenant_id = ?", w.mandant()))
                .as("B7: derselbe Anstoß bleibt eine Zeile").isEqualTo(anstossZeilen);
        assertThat(Bestandsschutz.inhalt(root, "messreihe_ereignis", "t.tenant_id = ? AND t.art = ?", w.mandant(),
                BerichtKaskade.ANGESTOSSEN)).as("… mit einer Meldung").isEqualTo(angestossen);
        assertThat(((Timestamp) entwurf(w, "BR-2026-0001").get("datenstand")).toInstant())
                .as("der Entwurf dagegen hat den Datenstand seiner letzten Bildung").isEqualTo(T_RUECKNAHME.plusSeconds(300));
        assertThat(Bestandsschutz.inhalt(root, "bericht_stand", "t.tenant_id = ?", w.mandant()))
                .as("Nr. 1 und Nr. 2 Zeichen für Zeichen").isEqualTo(staende);
    }

    // ================================================================ keine halbe Wahrheit

    /**
     * Ein Fehler in der Bildung rollt die ganze Kaskade zurück: als das Quellenverzeichnis des Entwurfs an der Datenbank
     * scheitert, stehen die Version der Reihe, der Anstoß an Nr. 1, seine Meldung und der ersetzte Entwurf schon da —
     * danach ist die Datenbank Tabelle für Tabelle wie vorher. Der nächste Takt ohne den Fehler bildet alles vollständig.
     */
    @Test
    void einFehlerInDerBildungRolltDieGanzeKaskadeZurueck() throws Exception {
        Welt w = welt();
        anlegen(w, "BR-2026-0001", MONATSBERICHT, "monat", "2026-10", w.st1());
        freigeben(w, "BR-2026-0001", 1, DATENSTAND_NR1, FREIGABE_NR1);
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());
        root.execute("CREATE OR REPLACE FUNCTION test_bericht_kaskade_bricht() RETURNS trigger LANGUAGE plpgsql AS $$ "
                + "BEGIN RAISE EXCEPTION 'Quellenverzeichnis nicht schreibbar (MS-12 Version 2: %, Anstoß: %, Meldung: %, "
                + "Entwurf ersetzt: %)', "
                + "EXISTS (SELECT 1 FROM messreihe_periode_version WHERE tenant_id = NEW.tenant_id AND anlass_kennung = '"
                + K7 + "'), EXISTS (SELECT 1 FROM bericht_revision_anstoss WHERE tenant_id = NEW.tenant_id), "
                + "EXISTS (SELECT 1 FROM messreihe_ereignis WHERE tenant_id = NEW.tenant_id AND art = '"
                + BerichtKaskade.ANGESTOSSEN + "'), EXISTS (SELECT 1 FROM bericht_entwurf WHERE tenant_id = NEW.tenant_id "
                + "AND gebildet_von = 'kaskade'); END $$");
        root.execute("CREATE TRIGGER test_bericht_kaskade_bricht BEFORE INSERT ON bericht_quelle FOR EACH ROW "
                + "WHEN (NEW.stand_nr IS NULL AND NEW.tenant_id = '" + w.mandant() + "') "
                + "EXECUTE FUNCTION test_bericht_kaskade_bricht()");
        try {
            assertThatThrownBy(() -> inDerKaskade(con -> {
                ms12Version(con, w, 2, "6040", List.of(K7), 2);
                KorrekturKaskade.berichteBenachrichtigen(con, naht, k7(w, 2, KorrekturKaskade.FREIGEGEBEN, T_KASKADE));
            })).as("der Fehler kam NACH der Stufe, dem Anstoß, der Meldung und dem ersetzten Entwurf")
                    .hasStackTraceContaining("Quellenverzeichnis nicht schreibbar (MS-12 Version 2: t, Anstoß: t, "
                            + "Meldung: t, Entwurf ersetzt: t)");
        } finally {
            root.execute("DROP TRIGGER IF EXISTS test_bericht_kaskade_bricht ON bericht_quelle");
            root.execute("DROP FUNCTION IF EXISTS test_bericht_kaskade_bricht()");
        }
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of())))
                .as("nichts Halbes bleibt").isEmpty();

        inDerKaskade(con -> {
            ms12Version(con, w, 2, "6040", List.of(K7), 2);
            KorrekturKaskade.berichteBenachrichtigen(con, naht,
                    k7(w, 2, KorrekturKaskade.FREIGEGEBEN, T_KASKADE.plusSeconds(300)));
        });
        assertThat(anstoesse(w)).hasSize(1);
        assertThat(entwurf(w, "BR-2026-0001").get("gebildet_von")).isEqualTo("kaskade");
        assertThat(meldungen(w, BerichtKaskade.ANGESTOSSEN)).hasSize(1);
    }

    /**
     * Die Uhr: die Kaskade nimmt {@code jetzt} VOR ihrer Transaktion, die Versionen tragen {@code created_at} = Beginn der
     * Transaktion. Der Datenstand ist darum die spätere von beiden, auf die volle Sekunde AUFGERUNDET — mit {@code jetzt}
     * selbst würfe D2, und die Kaskade rollte in jedem Takt zurück.
     */
    @Test
    void derDatenstandLiegtNieVorDenVersionenDerKaskade() throws Exception {
        assertThat(BerichtKaskade.aufDieSekunde(T_KASKADE)).isEqualTo(T_KASKADE);
        assertThat(BerichtKaskade.aufDieSekunde(T_KASKADE.plusMillis(1))).isEqualTo(T_KASKADE.plusSeconds(1));
        Welt w = welt();
        Instant jetzt = Instant.now().minusSeconds(5).plusMillis(123);
        try (Connection con = admin.getConnection()) {
            con.setAutoCommit(false);
            try {
                ms12Version(con, w, 2, "6040", List.of(K7), 2);
                Instant gebildet;
                try (var ps = con.prepareStatement("SELECT created_at FROM messreihe_periode_version WHERE tenant_id = ?")) {
                    ps.setObject(1, w.mandant());
                    try (var rs = ps.executeQuery()) {
                        rs.next();
                        gebildet = rs.getTimestamp(1).toInstant();
                    }
                }
                Instant datenstand = BerichtKaskade.datenstand(con, k7(w, 2, KorrekturKaskade.FREIGEGEBEN, jetzt));
                assertThat(BerichtRegeln.d2(jetzt, List.of(gebildet), List.of(), false))
                        .as("die Falle: jetzt liegt vor der Version").isNotEmpty();
                assertThat(datenstand.getNano()).isZero();
                assertThat(datenstand).isAfterOrEqualTo(jetzt).isAfterOrEqualTo(gebildet);
                assertThat(BerichtRegeln.d2(datenstand, List.of(gebildet), List.of(), false)).isEmpty();
            } finally {
                con.rollback();
            }
        }
    }

    // ================================================================ Vertrag und Grenze

    /**
     * Die fünf Betroffenheits-Prüfungen aus B3 und B7 von {@code bericht-vectors.json} — diesmal nicht gegen die reine
     * Regel, sondern gegen das Quellenverzeichnis der Datenbank: Berichte, Stände (mit „ersetzt durch“) und Quellen
     * Zeile für Zeile aus dem Vektor, die Reihen über eine echte führende Quellenbindung. Je Prüfung ein eigener
     * Kundenbereich — alle tragen dieselben Kennungen, keiner mischt sich ein.
     */
    @TestFactory
    Stream<DynamicTest> b3UndB7BetroffeneWieDerVertrag_ueberDasQuellenverzeichnisDerDatenbank() {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode fall : vektoren.path("cases")) {
            if (!List.of("B3", "B7").contains(fall.path("id").asText())) {
                continue;
            }
            for (JsonNode p : fall.path("pruefungen")) {
                if ("betroffenheit".equals(p.path("regel").asText())) {
                    tests.add(DynamicTest.dynamicTest(fall.path("id").asText() + ": " + p.path("name").asText(),
                            () -> betroffenheitWieImVertrag(p)));
                }
            }
        }
        assertThat(tests).as("B3 zwei, B7 drei Prüfungen").hasSize(5);
        return tests.stream();
    }

    /**
     * Die Grenze von Pfad 1: {@code Betroffen} trägt noch keine Bezugsgrößen (AP-11 IP-9). Ein Bericht, der BZ-6 zitiert,
     * ist über Pfad 1 nur betroffen, wenn auch eine Messstelle trifft — eine Bezugsgrößen-Berichtigung erreicht ihn bis
     * dahin über den Strukturänderungs-Läufer (AP-12 IP-9). Kommt das Feld, wird dieser Test rot und die Bezugsgröße gehört
     * in {@link BerichtKaskade#betroffene}.
     */
    @Test
    void dieBezugsgroessenTraegtPfadEinsErstMitAp11Ip9_bisDahinPfadZwei() throws Exception {
        assertThat(Arrays.stream(KorrekturKaskade.Betroffen.class.getRecordComponents()).map(RecordComponent::getName))
                .as("AP-11 IP-9 bringt Betroffen.bezugsgroessen[] — dann trägt Pfad 1 die Bezugsgröße (bericht.md B1)")
                .doesNotContain("bezugsgroessen");
        Welt w = welt();
        anlegen(w, "BR-2026-0001", MONATSBERICHT, "monat", "2026-10", w.st1());
        root.update("INSERT INTO bericht_quelle (tenant_id, bericht_id, stand_nr, art, kennzeichen, objekt_id, bezug, "
                + "erster_tag, letzter_tag, fassung, name_zum_datenstand) VALUES (?, ?, NULL, 'bezugsgroesse', 'BZ-6', ?, "
                + "'unmittelbar', ?, ?, 1, 'Gutteile Montage Halle 2')", w.mandant(), w.berichte().get("BR-2026-0001"),
                UUID.nameUUIDFromBytes((w.mandant() + ":BZ-6").getBytes(StandardCharsets.UTF_8)), OKT_1, OKT_31);
        KorrekturKaskade.Betroffen nurBz = new KorrekturKaskade.Betroffen(w.mandant(), "BK-2026-0001", 2,
                KorrekturKaskade.FREIGEGEBEN, List.of(), OKT_1.atStartOfDay(ZONE).toInstant(),
                OKT_1.plusMonths(1).atStartOfDay(ZONE).toInstant(), ZONE, OKT_1, OKT_31, List.of("BZ-6"), List.of(), 0,
                T_KASKADE);
        KorrekturKaskade.Betroffen mitMessstelle = k7(w, 2, KorrekturKaskade.FREIGEGEBEN, T_KASKADE);
        try (Connection con = admin.getConnection()) {
            assertThat(naht.betroffene(con, nurBz)).as("BZ-6 allein erreicht Pfad 1 nicht").isEmpty();
            assertThat(naht.betroffene(con, mitMessstelle)).as("die Messstelle schon").isNotEmpty();
        }
    }

    // ================================================================ Hilfen: Vertrag

    private static void betroffenheitWieImVertrag(JsonNode p) throws Exception {
        JsonNode ein = p.path("eingang");
        int nr = NR.incrementAndGet();
        UUID t = uuid("INSERT INTO tenant (name) VALUES (?) RETURNING id", "Bericht-Vektor #" + nr);
        UUID u = uuid("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') RETURNING id", t,
                "Kunststoffwerk Ahrenberg GmbH");
        UUID anlage = anlage(t, "Vektor #" + nr);
        Welt w = new Welt(t, null, null, new LinkedHashMap<>(), new LinkedHashMap<>(), new LinkedHashMap<>());

        Map<String, UUID> entity = new LinkedHashMap<>();
        for (JsonNode bindung : ein.path("quellenbindung")) {
            String ms = bindung.path("messstellen").get(0).asText();
            messstelle(w, ms, anlage, null, "Hauptzähler", null);
            entity.put(bindung.path("entity").asText(), w.komponenten().get(ms));
        }
        Map<String, UUID> objekte = new LinkedHashMap<>();
        Map<String, TreeMap<Integer, Boolean>> staende = new LinkedHashMap<>();
        for (JsonNode q : ein.path("quellen")) {
            String kennung = q.path("bericht").asText();
            if (!w.berichte().containsKey(kennung)) {
                UUID st = uuid("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                        + "VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", t, u, "Werk " + kennung,
                        "ST-" + (w.berichte().size() + 1));
                w.berichte().put(kennung, uuid("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, "
                        + "geltung_art, standort_id, zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_name) VALUES "
                        + "(?, ?, ?, 1, 'standort', ?, 'monat', '2026-10', 'Europe/Berlin', 'Ines Kaltenbach') RETURNING id",
                        t, kennung, MONATSBERICHT, st));
            }
            if (!q.path("nr").isNull()) {
                staende.computeIfAbsent(kennung, k -> new TreeMap<>()).put(q.path("nr").asInt(),
                        q.path("ersetzt").asBoolean());
            }
            for (JsonNode o : q.path("objekte")) {
                String kz = o.asText();
                if (kz.startsWith("MS-") && !w.messstellen().containsKey(kz)) {
                    w.messstellen().put(kz, uuid("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, "
                            + "groesse, richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', "
                            + "'Bezug', 'kWh', 'Zählerstand') RETURNING id", t, kz, "Zähler " + kz));
                }
                objekte.computeIfAbsent(kz, k -> k.startsWith("MS-") ? w.messstellen().get(k)
                        : UUID.nameUUIDFromBytes((t + ":" + k).getBytes(StandardCharsets.UTF_8)));
            }
        }
        staende.forEach((kennung, nummern) -> nummern.forEach((n, ersetzt) -> {
            String abzug = BerichtRegeln.kanonisch(JSON.createObjectNode().set("kopf",
                    JSON.createObjectNode().put("bericht", kennung).put("nr", n)));
            root.update("INSERT INTO bericht_stand (tenant_id, bericht_id, nr, abzug, pruefsumme, datenstand, freigegeben_am, "
                    + "freigeber_sub, freigeber_name, freigeber_rolle, darstellung, regelwerk, vorlage_fassung) VALUES "
                    + "(?, ?, ?, ?, ?, ?, ?, 'kc-ines-kaltenbach', 'Ines Kaltenbach', 'energiemanager', '{}'::jsonb, "
                    + "'{}'::jsonb, 1)", t, w.berichte().get(kennung), n, abzug, BerichtRegeln.pruefsumme(abzug),
                    Timestamp.from(DATENSTAND_NR1.plus(Duration.ofDays(n))),
                    Timestamp.from(FREIGABE_NR1.plus(Duration.ofDays(n))));
        }));
        staende.forEach((kennung, nummern) -> nummern.forEach((n, ersetzt) -> {
            if (ersetzt) {
                root.update("UPDATE bericht_stand SET ersetzt_durch_nr = ? WHERE tenant_id = ? AND bericht_id = ? AND nr = ?",
                        n + 1, t, w.berichte().get(kennung), n);
            }
        }));
        for (JsonNode q : ein.path("quellen")) {
            for (JsonNode o : q.path("objekte")) {
                String kz = o.asText();
                String art = kz.startsWith("MS-") ? "messstelle" : kz.startsWith("KZ-") ? "kennzahl"
                        : kz.startsWith("BZ-") ? "bezugsgroesse" : "kostenstelle";
                root.update("INSERT INTO bericht_quelle (tenant_id, bericht_id, stand_nr, art, kennzeichen, objekt_id, bezug, "
                        + "erster_tag, letzter_tag, name_zum_datenstand) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", t,
                        w.berichte().get(q.path("bericht").asText()), q.path("nr").isNull() ? null : q.path("nr").asInt(),
                        art, kz, objekte.get(kz), q.path("bezug").asText(), LocalDate.parse(q.path("erster_tag").asText()),
                        LocalDate.parse(q.path("letzter_tag").asText()), kz);
            }
        }

        JsonNode bj = ein.path("betroffen");
        List<KorrekturKaskade.Reihe> reihen = new ArrayList<>();
        bj.path("reihen").forEach(r -> reihen.add(new KorrekturKaskade.Reihe(entity.get(r.path("entity").asText()), ENERGIE)));
        List<String> messstellen = new ArrayList<>();
        bj.path("messstellen").forEach(m -> messstellen.add(m.asText()));
        List<UUID> ereignisse = new ArrayList<>();
        bj.path("ereignisse").forEach(e -> ereignisse.add(UUID.fromString(e.asText())));
        KorrekturKaskade.Betroffen b = new KorrekturKaskade.Betroffen(t, bj.path("anlass").asText(),
                bj.path("fassung").asInt(), bj.path("status").asText(), reihen,
                OffsetDateTime.parse(bj.path("von").asText()).toInstant(),
                OffsetDateTime.parse(bj.path("bis").asText()).toInstant(), ZoneId.of(bj.path("zone").asText()),
                LocalDate.parse(bj.path("erster_tag").asText()), LocalDate.parse(bj.path("letzter_tag").asText()),
                messstellen, ereignisse, bj.path("versionen").asInt());

        List<List<String>> soll = new ArrayList<>();
        p.path("ergebnis").path("betroffene").forEach(x -> soll.add(List.of(x.get(0).asText(), x.get(1).asText())));
        try (Connection con = admin.getConnection()) {
            assertThat(naht.betroffene(con, b).stream().map(x -> List.of(x.kennung(), x.stand().name())).toList())
                    .isEqualTo(soll);
        }
        assertThat(BerichtRegeln.anstossArt(b)).isEqualTo(p.path("ergebnis").path("anstoss_art").asText());
    }

    private static BigDecimal vektorWert(String quelle) {
        return wert(vektoren.path("abzuege").path("BR-2026-0001/1"), quelle).path("menge").decimalValue();
    }

    private static JsonNode wert(String abzug, String quelle) {
        try {
            return wert(JSON.readTree(abzug), quelle);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static JsonNode wert(JsonNode abzug, String quelle) {
        for (JsonNode w : abzug.path("werte")) {
            if (quelle.equals(w.path("quelle").asText())) {
                return w;
            }
        }
        throw new AssertionError("kein Wert " + quelle + " im Abzug");
    }

    // ================================================================ Hilfen: Kaskade und Berichte

    /** EINE Transaktion wie ein Anlass der Kaskade: alles oder nichts, als Verwaltungsrolle. */
    private static void inDerKaskade(Schritt schritt) throws SQLException {
        try (Connection con = admin.getConnection()) {
            con.setAutoCommit(false);
            try {
                schritt.fahren(con);
                con.commit();
            } catch (SQLException | RuntimeException e) {
                con.rollback();
                throw e;
            }
        }
    }

    /** Eine Monats-Version der Reihe von MS-12, so wie die Monats-Stufe der Kaskade sie schreibt. */
    private static void ms12Version(Connection con, Welt w, int version, String menge, List<String> korrekturen,
            int fassung) throws SQLException {
        Instant b = OKT_1.atStartOfDay(ZONE).toInstant();
        Instant e = OKT_1.plusMonths(1).atStartOfDay(ZONE).toInstant();
        int minuten = (int) ChronoUnit.MINUTES.between(b, e);
        KaskadeStufen.Inhalt inhalt = new KaskadeStufen.Inhalt("counter", new BigDecimal(menge), "vollständig", List.of(),
                minuten, minuten, 100, null, null, null, null, null, null, null, null, null, null, null, "endgueltig");
        KaskadeStufen.periodeSchreiben(con, new KaskadeStufen.Periode(w.mandant(), "monat", w.komponenten().get("MS-12"),
                ENERGIE, null, b, e, OKT_1, ZONE), version, inhalt, korrekturen, List.of(), K7, fassung, null);
    }

    /** Was die Kaskade nach K-2026-0007 an die Nähte gibt: die Reihe von MS-12, der Oktober, der Zeitpunkt des Laufs. */
    private static KorrekturKaskade.Betroffen k7(Welt w, int fassung, String status, Instant jetzt) {
        return new KorrekturKaskade.Betroffen(w.mandant(), K7, fassung, status,
                List.of(new KorrekturKaskade.Reihe(w.komponenten().get("MS-12"), ENERGIE)),
                OKT_1.atStartOfDay(ZONE).toInstant(), OKT_1.plusMonths(1).atStartOfDay(ZONE).toInstant(), ZONE, OKT_1,
                OKT_31, List.of(), List.of(), 1, jetzt);
    }

    /** Bericht anlegen = Entwurf bilden (IP-5), zum Datenstand von Nr. 1. */
    private static void anlegen(Welt w, String kennung, String vorlage, String zeitraumArt, String schluessel,
            UUID standort) throws SQLException {
        UUID id = uuid("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, geltung_art, standort_id, "
                + "zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_name) VALUES (?, ?, ?, 1, 'standort', ?, ?, ?, "
                + "'Europe/Berlin', 'Ines Kaltenbach') RETURNING id", w.mandant(), kennung, vorlage, standort, zeitraumArt,
                schluessel);
        try (Connection con = rootDs.getConnection()) {
            bildung.bilden(con, id, DATENSTAND_NR1, "anlegen");
        }
        w.berichte().put(kennung, id);
    }

    /** Die Freigabe mit den Anweisungen der Route (F2, R2, R3): Kopie, Quellen, „ersetzt durch“, Anstöße erledigt. */
    private static void freigeben(Welt w, String kennung, int nr, Instant datenstand, Instant am) {
        BerichtRepository repo = new BerichtRepository(root);
        UUID bericht = w.berichte().get(kennung);
        UUID anlass = repo.anstoesse(w.mandant(), bericht).stream()
                .filter(a -> a.nr() == nr - 1 && "offen".equals(a.zustand()))
                .map(BerichtRepository.AnstossZeile::id).findFirst().orElse(null);
        assertThat(repo.standEinfrieren(w.mandant(), bericht, nr, datenstand, am, INES, "energiemanager", "{}", "{}", 1,
                anlass)).as("Nr. " + nr + " von " + kennung).isPresent();
        repo.quellenEinfrieren(w.mandant(), bericht, nr);
        if (nr > 1) {
            repo.ersetzen(w.mandant(), bericht, nr - 1, nr);
            repo.anstoesseErledigen(w.mandant(), bericht, nr);
        }
    }

    private static Map<String, Object> stand(Welt w, String kennung, int nr) {
        return root.queryForMap("SELECT abzug, pruefsumme FROM bericht_stand WHERE tenant_id = ? AND bericht_id = ? "
                + "AND nr = ?", w.mandant(), w.berichte().get(kennung), nr);
    }

    private static Map<String, Object> entwurf(Welt w, String kennung) {
        return root.queryForMap("SELECT abzug, pruefsumme, datenstand, gebildet_von FROM bericht_entwurf "
                + "WHERE tenant_id = ? AND bericht_id = ?", w.mandant(), w.berichte().get(kennung));
    }

    private static List<String> anstoesse(Welt w) {
        return root.queryForList("SELECT b.kennung || ' Nr. ' || s.nr || ' | ' || a.art || ' | ' || a.anlass_kennung "
                + "|| ' Fassung ' || a.anlass_fassung || ' ' || a.anlass_status || ' | ' || a.zustand "
                + "|| coalesce(' durch Nr. ' || a.erledigt_durch_nr, '') FROM bericht_revision_anstoss a "
                + "JOIN bericht_stand s ON s.id = a.stand_id AND s.tenant_id = a.tenant_id "
                + "JOIN bericht b ON b.id = s.bericht_id AND b.tenant_id = s.tenant_id "
                + "WHERE a.tenant_id = ? ORDER BY a.erkannt_am, b.kennung, s.nr", String.class, w.mandant());
    }

    /** Die Meldungen einer Art: Nutzlast plus Bezug, Urheber, Zeit und Kennung. */
    private static List<JsonNode> meldungen(Welt w, String art) throws Exception {
        List<JsonNode> aus = new ArrayList<>();
        for (Map<String, Object> z : root.queryForList("SELECT ereignis_id, kennungen::text AS kennungen, "
                + "nutzlast::text AS nutzlast, urheber, zeit FROM messreihe_ereignis WHERE tenant_id = ? AND art = ? "
                + "ORDER BY zeit, kennungen->>'bericht'", w.mandant(), art)) {
            ObjectNode n = (ObjectNode) JSON.readTree((String) z.get("nutzlast"));
            n.put("bericht", JSON.readTree((String) z.get("kennungen")).path("bericht").asText());
            n.put("urheber", (String) z.get("urheber"));
            n.put("zeit", ((Timestamp) z.get("zeit")).toInstant().toString());
            n.put("ereignis_id", z.get("ereignis_id").toString());
            aus.add(n);
        }
        return aus;
    }

    private static String berichtsTabellen(Welt w) {
        StringBuilder s = new StringBuilder();
        for (String tabelle : List.of("bericht_entwurf", "bericht_stand", "bericht_quelle", "bericht_revision_anstoss",
                "messreihe_ereignis", "messreihe_periode_version")) {
            s.append(tabelle).append(": ").append(Bestandsschutz.inhalt(root, tabelle, "t.tenant_id = ?", w.mandant()))
                    .append('\n');
        }
        return s.toString();
    }

    // ================================================================ Hilfen: Welt

    private static Welt welt() throws Exception {
        int nr = NR.incrementAndGet();
        UUID t = uuid("INSERT INTO tenant (name) VALUES (?) RETURNING id", "Bericht-Kaskade #" + nr);
        UUID u = uuid("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') RETURNING id", t,
                "Kunststoffwerk Ahrenberg GmbH");
        Welt w = new Welt(t, standort(t, u, "Werk Ahrenberg", "ST-1"), standort(t, u, "Werk Lindach", "ST-2"),
                new LinkedHashMap<>(), new LinkedHashMap<>(), new LinkedHashMap<>());
        UUID halle2 = gebaeude(t, w.st1(), "Halle 2", "G-2");
        UUID lindach = gebaeude(t, w.st2(), "Montagehalle Lindach", "G-5");
        UUID anlageHalle2 = anlage(t, "Halle 2 #" + nr);
        UUID anlageLindach = anlage(t, "Lindach #" + nr);
        messstelle(w, "MS-10", anlageHalle2, halle2, "Hauptzähler", null);
        messstelle(w, "MS-12", anlageHalle2, halle2, "Unterzähler", "MS-10");
        messstelle(w, "MS-16", anlageLindach, lindach, "Hauptzähler", null);
        messstelle(w, "MS-18", anlageLindach, lindach, "Unterzähler", "MS-16");
        monat(w, "MS-10", vektorWert("MS-10").toPlainString());
        monat(w, "MS-12", vektorWert("MS-12").toPlainString());
        monat(w, "MS-18", "3600");
        return w;
    }

    private static UUID standort(UUID t, UUID u, String name, String kurz) {
        return uuid("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", t, u, name, kurz);
    }

    private static UUID gebaeude(UUID t, UUID standort, String name, String kurz) {
        UUID g = uuid("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, 'gebaeude', ?, ?, 'aktiv') "
                + "RETURNING id", t, name, kurz);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2020-01-01')", t, g, standort);
        return g;
    }

    private static UUID anlage(UUID t, String name) {
        return uuid("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id", t, name,
                Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
    }

    /** Box, Komponente, Mess-Selektion, gemessene Messstelle mit führender Quelle, Stellung und (optional) Ort. */
    private static void messstelle(Welt w, String kennzeichen, UUID anlage, UUID ort, String stellung,
            String unterzaehlerVon) {
        UUID t = w.mandant();
        UUID box = uuid("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) RETURNING id", t, anlage,
                "VP-BERICHT-" + kennzeichen + "-" + UUID.randomUUID());
        UUID komponente = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, "
                + "communication, connection_json, created_at) VALUES (?, ?, 'modbus-generic', ?, 'modbus-generic', ?, "
                + "'modbus_tcp', '{\"unit_id\":1}'::jsonb, ?) RETURNING id", t, anlage, "Zähler " + kennzeichen, box,
                Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), ?, 'test', "
                + "'pending_edge', 'energy_counter', 'fifteen_minute')", t, anlage, box, komponente, ENERGIE, KATALOG);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ?", UUID.class,
                komponente);
        UUID messstelle = uuid("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, "
                + "einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') "
                + "RETURNING id", t, kennzeichen, "Zähler " + kennzeichen);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_name, actor_art) "
                + "VALUES (?,?,'Wirkenergie','Bezug',?,?,?,'counter','zaehlerstand','fuehrend',?,false,?,'test','voltpilot')",
                t, messstelle, komponente, geraet, ENERGIE, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")),
                Timestamp.from(Instant.parse("2020-01-01T00:01:00Z")));
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, unterzaehler_von, "
                + "gueltig_ab) VALUES (?,?,?,?,?,?)", t, messstelle, anlage, stellung,
                unterzaehlerVon == null ? null : w.messstellen().get(unterzaehlerVon), LocalDate.parse("2020-01-01"));
        if (ort != null) {
            root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, standort_id, ort_id, gueltig_ab) "
                    + "VALUES (?, ?, NULL, ?, DATE '2026-10-01')", t, messstelle, ort);
        }
        w.messstellen().put(kennzeichen, messstelle);
        w.komponenten().put(kennzeichen, komponente);
    }

    /** Der gemessene, endgültige Oktober der Reihe einer Messstelle (AP-08 IP-5) — Version 1 der Verdichtung. */
    private static void monat(Welt w, String kennzeichen, String menge) {
        Instant b = OKT_1.atStartOfDay(ZONE).toInstant();
        Instant e = OKT_1.plusMonths(1).atStartOfDay(ZONE).toInstant();
        int tage = OKT_1.lengthOfMonth();
        long stunden = ChronoUnit.HOURS.between(b, e);
        root.update("INSERT INTO messreihe_periode (tag, art, tenant_id, entity_id, messkanal, zeitzone, zeitzone_herkunft, "
                + "beginn, ende, stunden, teile_erwartet, teile_vorhanden, teile_endgueltig, wertart, menge, menge_zustand, "
                + "kennzeichen, erhalten, erwartet, abdeckung_prozent, zustand, endgueltig_ab, version) VALUES (?, 'monat', "
                + "?, ?, ?, 'Europe/Berlin', 'vorgabe', ?, ?, ?, ?, ?, ?, 'counter', ?::numeric, 'vollständig', '[]'::jsonb, "
                + "?, ?, 100, 'endgueltig', ?, 1)", OKT_1, w.mandant(), w.komponenten().get(kennzeichen), ENERGIE,
                Timestamp.from(b), Timestamp.from(e), stunden, tage, tage, tage, menge, stunden * 60, stunden * 60,
                Timestamp.from(e.plus(Duration.ofDays(7))));
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
}
