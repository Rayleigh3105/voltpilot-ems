package com.voltpilot.api.uems;

import static java.util.concurrent.TimeUnit.SECONDS;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.MessstelleAenderungRepository.NeuerEintrag;
import com.voltpilot.api.uems.MessstelleRegeln.Groesse;
import com.voltpilot.api.uems.MessstelleRegeln.KennzeichenUrteil;
import com.voltpilot.api.uems.MessstelleRegeln.LebenszyklusEingang;
import com.voltpilot.api.uems.MessstelleRegeln.LebenszyklusErgebnis;
import com.voltpilot.api.uems.MessstelleRegeln.Vergeben;
import com.voltpilot.api.uems.MessstelleRegeln.Vorschlag;
import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import com.voltpilot.api.uems.MessstelleRepository.Nebengroesse;
import com.voltpilot.api.uems.MessstelleRepository.NeueMessstelle;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import java.util.stream.Collectors;
import java.util.stream.IntStream;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import org.postgresql.ds.PGSimpleDataSource;
import org.postgresql.util.PSQLException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Migration der Messstelle (AP-04 IP-2, {@code V20260911140000}) gegen eine echte
 * TimescaleDB auf FRISCHEM Volume: die ganze Migrationskette läuft von vorn.
 *
 * <p>Bewiesen wird, was der Konzept-Report als Prüfnachweis verlangt — RLS-Isolation
 * (eine fremde Messstelle ist unsichtbar), Kennzeichen-Eindeutigkeit einschließlich
 * archivierter UND früherer Kennzeichen, die Migration auf frischem Volume — und dazu:
 * die Kennzeichen-Fälle der Vektor-Datei {@code messstelle-vectors.json} spielen gegen die
 * Datenbank und bekommen dort dasselbe Urteil wie von {@link MessstelleRegeln}; der
 * Kennzeichen-Zähler vergibt je Mandant fortlaufend und unter Gleichzeitigkeit nie eine
 * Nummer doppelt; Katalog, Kennzeichen-Form und Vokabulare der CHECKs sagen dasselbe wie
 * die Regeln; das Protokoll ist append-only; niemand außer dem Offboarding löscht.
 *
 * <p>Beispiele aus dem Referenzunternehmen ({@code uems-referenzunternehmen.json}) mit
 * dessen Kennzeichen und Werten. Läuft nur mit Docker ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
class MessstelleMigrationTest {

    private static final String DIESE = "20260911140000";
    private static final String DATEI = "V20260911140000__uems_messstelle.sql";
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final Path REFERENZ = V2.resolve("uems-referenzunternehmen.json");
    private static final Path VEKTOREN = V2.resolve("messstelle-vectors.json");
    private static final Path SCHEMA = V2.resolve("messstelle.schema.json");

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final List<String> TABELLEN = List.of("messstelle", "messstelle_groesse",
            "messstelle_kennzeichen", "messstelle_kennzeichen_seq", "messstelle_aenderung");
    private static final List<String> FUNKTIONEN = List.of("messstelle_groesse_im_katalog",
            "messstelle_identitaet_bleibt", "messstelle_kennzeichen_belegen",
            "messstelle_groesse_pruefen", "messstelle_kennzeichen_seq_rueckt_vor");

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JsonNode referenz;
    private static JsonNode vektoren;
    private static JsonNode schema;

    private static String schemaVorher;
    private static String schemaNachher;
    private static List<String> historie;

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static JdbcTemplate admin;
    private static TransactionTemplate tx;
    private static MessstelleRepository messstellen;
    private static MessstelleAenderungRepository aenderungen;

    @BeforeAll
    static void migriereAufFrischemVolume() throws IOException {
        referenz = MAPPER.readTree(REFERENZ.toFile());
        vektoren = MAPPER.readTree(VEKTOREN.toFile());
        schema = MAPPER.readTree(SCHEMA.toFile());
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));

        flyway().target(letzteFassungVorDieser()).load().migrate();
        schemaVorher = schema(TABELLEN, FUNKTIONEN);
        flyway().target(DIESE).load().migrate();
        schemaNachher = schema(TABELLEN, FUNKTIONEN);
        // Was nach dieser Fassung noch liegt, läuft auch — die Tests prüfen den Endstand.
        flyway().load().migrate();
        historie = root.queryForList("SELECT version || ':' || success FROM flyway_schema_history "
                + "WHERE version IS NOT NULL", String.class);

        DataSource appDs = new TenantAwareDataSource(ds(APP_USER, APP_PW));
        app = new JdbcTemplate(appDs);
        tx = new TransactionTemplate(new DataSourceTransactionManager(appDs));
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        messstellen = new MessstelleRepository(app);
        aenderungen = new MessstelleAenderungRepository(app);
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ---- Migration auf frischem Volume ---------------------------------------

    @Test
    void dieMigrationLaeuftAufFrischemVolumeUndIstReinAdditiv() throws IOException {
        assertThat(historie).contains(DIESE + ":true");
        for (String t : TABELLEN) {
            assertThat(anzahl("SELECT count(*) FROM pg_tables WHERE schemaname = 'public' "
                    + "AND tablename = ?", t)).as(t).isOne();
        }
        // Ohne die fünf neuen Tabellen und ihre Funktionen ist das Schema zeichengleich:
        // keine bestehende Tabelle, Spalte, Constraint, Index, Policy, Trigger oder Recht
        // wurde berührt.
        assertThat(schemaVorher).contains("col:tenant.id|uuid").contains("con:site.");
        assertThat(schemaNachher).isEqualTo(schemaVorher);

        // Ein erneuter Lauf derselben Datei ändert nichts — auch nicht an den neuen Tabellen.
        String vorErneutemLauf = schema(List.of(), List.of());
        fuehreDieseMigrationErneutAus();
        assertThat(schema(List.of(), List.of())).isEqualTo(vorErneutemLauf);
    }

    // ---- RLS: die fremde Messstelle ist unsichtbar ----------------------------

    @Test
    void derZaunStehtAufJederNeuenTabelleUndDieFremdeMessstelleIstUnsichtbar() {
        UUID a = neuerMandant(referenz.at("/unternehmen/name").asText());
        UUID b = neuerMandant("Fremder Kundenbereich");
        JsonNode ms06 = referenzMessstelle("MS-06");
        Groesse nebengroesse06 = groesse(ms06.at("/nebengroessen/0"));
        UUID msA = legeWieReferenz(a, "MS-06").id();
        UUID msB = legeWieReferenz(b, "MS-06").id();
        for (UUID[] tm : new UUID[][] {{a, msA}, {b, msB}}) {
            alsTue(tm[0], () -> {
                assertThat(messstellen.nebengroesseHinzufuegen(tm[1], nebengroesse06)).isPresent();
                aenderungen.eintragen(eintrag(tm[0], tm[1], "angelegt", null, "{\"kennzeichen\": \"MS-06\"}"));
                tx.executeWithoutResult(s -> messstellen.anlegen(neueOhneKennzeichen(tm[0])));
            });
        }

        for (String t : TABELLEN) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity "
                    + "FROM pg_class WHERE relname = ?", Boolean.class, t)).as(t).isTrue();
            assertThat(anzahl("SELECT count(*) FROM pg_policies WHERE tablename = ? AND "
                    + "qual LIKE '%app.tenant_id%' AND with_check LIKE '%app.tenant_id%'", t))
                    .as(t).isOne();
            // Es gibt Zeilen auf beiden Seiten — sonst bewiese „0 Zeilen" nichts.
            assertThat(anzahl("SELECT count(DISTINCT tenant_id) FROM " + t)).as(t)
                    .isGreaterThanOrEqualTo(2);
            // Ohne app.tenant_id: null Zeilen (default-deny).
            assertThat(app.queryForObject("SELECT count(*) FROM " + t, Long.class)).as(t).isZero();
            // Mit Mandant: nur die eigenen.
            assertThat(als(b, () -> app.queryForObject(
                    "SELECT count(*) FROM " + t + " WHERE tenant_id <> ?", Long.class, b)))
                    .as(t).isZero();
        }

        // Die fremde Messstelle ist nicht da — die Route macht daraus 404, nie 403.
        alsTue(b, () -> {
            assertThat(messstellen.finde(msA)).isEmpty();
            assertThat(messstellen.finde(msB)).isPresent();
            assertThat(messstellen.alle()).extracting(Messstelle::id)
                    .contains(msB).doesNotContain(msA);
            assertThat(messstellen.nebengroessen(msA)).isEmpty();
            assertThat(aenderungen.fuerMessstelle(msA)).isEmpty();
            assertThat(messstellen.vergeben()).extracting(Vergeben::kennzeichen)
                    .containsExactlyInAnyOrder("MS-06", "MS-0001");
            // Nichts an ihr lässt sich ändern, und nichts lässt sich an sie hängen.
            assertThat(messstellen.kennzeichenAendern(msA, "MS-99")).isFalse();
            assertThat(messstellen.archivieren(msA, Instant.now())).isFalse();
            assertThat(messstellen.nebengroesseHinzufuegen(msA,
                    groesse(referenzMessstelle("MS-04").at("/nebengroessen/0")))).isEmpty();
        });
        assertThat(als(a, () -> messstellen.finde(msA)).orElseThrow().kennzeichen()).isEqualTo("MS-06");

        // Schreiben über den Zaun: die Policy (WITH CHECK) lehnt ab …
        abgelehntWegen("42501", "row-level security", () -> als(b, () -> messstellen.anlegen(
                wieReferenz(a, "MS-07", referenzMessstelle("MS-07")))));
        // … und die zusammengesetzten Fremdschlüssel, die ohne RLS prüfen, lassen keine
        // Nebengröße über die Mandantengrenze zu. A HAT diese Nebengröße schon: trotzdem
        // spricht der Fremdschlüssel, nicht die Eindeutigkeit — die Ablehnung verrät B
        // nichts über A.
        abgelehnt("23503", "messstelle_groesse_messstelle_fk", () -> alsTue(b, () -> app.update(
                "INSERT INTO messstelle_groesse (tenant_id, messstelle_id, medium, groesse, "
                        + "richtung, einheit, wertart) VALUES (?, ?, 'Strom', ?, ?, ?, ?)",
                b, msA, nebengroesse06.groesse(), nebengroesse06.richtung(),
                nebengroesse06.einheit(), nebengroesse06.wertart())));
    }

    @Test
    void zweiMandantenDuerfenDasselbeKennzeichenTragenUndZaehlenGetrennt() {
        UUID a = neuerMandant("Kennzeichen-Probe A");
        UUID b = neuerMandant("Kennzeichen-Probe B");
        assertThat(legeWieReferenz(a, "MS-01").kennzeichen()).isEqualTo("MS-01");
        assertThat(legeWieReferenz(b, "MS-01").kennzeichen()).isEqualTo("MS-01");
        for (UUID t : List.of(a, b)) {
            assertThat(als(t, () -> tx.execute(s -> messstellen.anlegen(neueOhneKennzeichen(t))))
                    .kennzeichen()).isEqualTo("MS-0001");
            assertThat(zaehler(t)).isOne();
        }
    }

    // ---- Kennzeichen: die Fälle der Vektor-Datei gegen die Datenbank ----------

    /**
     * Jeder Fall der Familie {@code kennzeichen_pruefen}: der Bestand des Falls wird
     * gespeichert (die Ahrenberg-Messstellen mit den Werten der Referenz), das Register
     * liefert genau die {@code vergeben}-Liste des Falls, die Regeln urteilen darauf wie
     * erwartet — und die Datenbank nimmt an oder lehnt ab wie das Urteil: Form 23514,
     * belegt 23505 (heute getragen: {@code messstelle_kennzeichen_eindeutig}; archiviert
     * getragen ebenso; früher getragen: {@code messstelle_kennzeichen_belegt}).
     */
    @TestFactory
    Stream<DynamicTest> kennzeichenPruefenDieFaelleDerVektorDateiGegenDieDatenbank() {
        return faelle("kennzeichen_pruefen").map(fall -> DynamicTest.dynamicTest(
                fall.get("name").asText(), () -> {
                    JsonNode in = fall.get("input");
                    JsonNode soll = fall.get("expected");
                    UUID t = neuerMandant("Kennzeichen-Fall " + fall.get("name").asText());
                    Map<String, UUID> traeger = speichereBelegung(t, in.get("vergeben"));

                    List<Vergeben> register = als(t, () -> messstellen.vergeben());
                    assertThat(new HashSet<>(register)).isEqualTo(vergebenAus(in.get("vergeben")));

                    String kandidat = in.get("kandidat").asText();
                    String fuer = text(in.get("fuer_messstelle"));
                    KennzeichenUrteil urteil = MessstelleRegeln.kennzeichenPruefen(kandidat, fuer, register);
                    assertThat(urteil.fehler() == null ? null : urteil.fehler().code())
                            .isEqualTo(text(soll.get("fehler")));
                    assertThat(urteil.bestehend()).isEqualTo(soll.get("bestehend").isNull()
                            ? null : vergeben(soll.get("bestehend")));

                    Runnable schreiben = fuer == null
                            ? () -> alsTue(t, () -> messstellen.anlegen(neueMitKennzeichen(t, kandidat)))
                            : () -> alsTue(t, () -> assertThat(messstellen.kennzeichenAendern(
                                    traeger.get(fuer), kandidat)).isTrue());
                    String fehler = text(soll.get("fehler"));
                    if (fehler == null) {
                        schreiben.run();
                        assertThat(als(t, () -> messstellen.vergeben()))
                                .extracting(Vergeben::kennzeichen).contains(kandidat);
                        if (fuer != null && !fuer.equals(kandidat)) {
                            // Das bisherige Kennzeichen bleibt ihr belegt — nie an eine andere.
                            abgelehnt("23505", "messstelle_kennzeichen_belegt", () -> alsTue(t,
                                    () -> messstellen.anlegen(neueMitKennzeichen(t, fuer))));
                        }
                    } else if ("kennzeichen_format".equals(fehler)) {
                        abgelehnt("23514", "messstelle_kennzeichen_format", schreiben);
                    } else {
                        assertThat(fehler).isEqualTo("kennzeichen_belegt");
                        abgelehnt("23505", soll.at("/bestehend/frueher").asBoolean()
                                ? "messstelle_kennzeichen_belegt"
                                : "messstelle_kennzeichen_eindeutig", schreiben);
                    }
                    // Was die Datenbank abgelehnt hat, hat sie auch nicht halb gespeichert.
                    if (fehler != null) {
                        assertThat(new HashSet<>(als(t, () -> messstellen.vergeben())))
                                .isEqualTo(vergebenAus(in.get("vergeben")));
                    }
                }));
    }

    /**
     * Jeder Fall der Familie {@code kennzeichen_vorschlag}: der Vorschlag des Registers ist
     * der des Falls, OHNE den Zähler zu bewegen — und die automatische Vergabe speichert
     * genau ihn und rückt den Zähler genau auf die Nummer des Falls.
     */
    @TestFactory
    Stream<DynamicTest> kennzeichenVorschlagDieFaelleDerVektorDateiGegenDieDatenbank() {
        return faelle("kennzeichen_vorschlag").map(fall -> DynamicTest.dynamicTest(
                fall.get("name").asText(), () -> {
                    JsonNode in = fall.get("input");
                    JsonNode soll = fall.get("expected");
                    UUID t = neuerMandant("Vorschlag-Fall " + fall.get("name").asText());
                    for (JsonNode k : in.get("belegt")) {
                        legeWieReferenz(t, k.asText());
                    }
                    int zaehler = in.get("zaehler").asInt();
                    if (zaehler > 0) {
                        // Die Vorgeschichte des Falls: so viele automatische Vergaben gab es.
                        alsTue(t, () -> app.update("INSERT INTO messstelle_kennzeichen_seq "
                                + "(tenant_id, zaehler) VALUES (?, ?)", t, zaehler));
                    }

                    Vorschlag vorschlag = als(t, () -> messstellen.vorschlag());
                    assertThat(vorschlag).isEqualTo(new Vorschlag(soll.get("kennzeichen").asText(),
                            soll.get("zaehler").asInt()));
                    assertThat(zaehler(t)).isEqualTo(zaehler == 0 ? null : zaehler);

                    Messstelle neu = als(t, () -> tx.execute(s -> messstellen.anlegen(neueOhneKennzeichen(t))));
                    assertThat(neu.kennzeichen()).isEqualTo(soll.get("kennzeichen").asText());
                    assertThat(zaehler(t)).isEqualTo(soll.get("zaehler").asInt());
                }));
    }

    @Test
    void derZaehlerRuecktNurVorUndNurMitEinemAutomatischenKennzeichen() {
        UUID t = neuerMandant("Zähler-Probe");
        assertThat(als(t, () -> tx.execute(s -> messstellen.anlegen(neueOhneKennzeichen(t))))
                .kennzeichen()).isEqualTo("MS-0001");
        // Ein eigenes Kennzeichen — auch eines in automatischer Form — bewegt den Zähler nicht.
        legeWieReferenz(t, "MS-01");
        alsTue(t, () -> messstellen.anlegen(neueMitKennzeichen(t, "MS-0002")));
        assertThat(zaehler(t)).isOne();
        // Der nächste Vorschlag überspringt die belegte Nummer; sie wird nie mehr vergeben.
        assertThat(als(t, () -> tx.execute(s -> messstellen.anlegen(neueOhneKennzeichen(t))))
                .kennzeichen()).isEqualTo("MS-0003");
        assertThat(zaehler(t)).isEqualTo(3);

        abgelehnt("23514", "messstelle_kennzeichen_seq_rueckt_nur_vor", () -> alsTue(t,
                () -> app.update("UPDATE messstelle_kennzeichen_seq SET zaehler = zaehler - 1")));
        assertThat(zaehler(t)).isEqualTo(3);
        UUID leer = neuerMandant("Zähler-Probe, noch ohne Vergabe");
        abgelehnt("23514", "messstelle_kennzeichen_seq_zaehler_chk", () -> alsTue(leer,
                () -> app.update("INSERT INTO messstelle_kennzeichen_seq (tenant_id, zaehler) "
                        + "VALUES (?, -1)", leer)));

        // Ohne Transaktion hielte die Sperre nicht bis zum Speichern — also keine Vergabe.
        assertThatThrownBy(() -> alsTue(t, () -> messstellen.anlegen(neueOhneKennzeichen(t))))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("Transaktion");
    }

    @Test
    void zweiGleichzeitigeVergabenBekommenZweiVerschiedeneNummern() throws Exception {
        UUID t = neuerMandant("Vergabe-Probe");
        CountDownLatch vergeben = new CountDownLatch(1);
        CountDownLatch weiter = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<String> erste = pool.submit(() -> als(t, () -> tx.execute(s -> {
                String k = messstellen.anlegen(neueOhneKennzeichen(t)).kennzeichen();
                vergeben.countDown();
                warte(weiter);
                return k;
            })));
            assertThat(vergeben.await(30, SECONDS)).isTrue();
            Future<String> zweite = pool.submit(() -> als(t,
                    () -> tx.execute(s -> messstellen.anlegen(neueOhneKennzeichen(t)).kennzeichen())));
            // Die zweite Vergabe wartet auf die Sperre des Zählers, solange die erste
            // nicht gespeichert ist — sichtbar als wartende Sitzung der App-Rolle.
            warteBis(() -> anzahl("SELECT count(*) FROM pg_stat_activity WHERE usename = ? "
                    + "AND wait_event_type = 'Lock'", APP_USER) == 1);
            assertThat(zweite.isDone()).isFalse();
            weiter.countDown();
            assertThat(erste.get(30, SECONDS)).isEqualTo("MS-0001");
            assertThat(zweite.get(30, SECONDS)).isEqualTo("MS-0002");
        } finally {
            pool.shutdownNow();
        }
        assertThat(zaehler(t)).isEqualTo(2);

        // Und acht zugleich: acht verschiedene Nummern, lückenlos fortlaufend.
        int n = 8;
        CyclicBarrier start = new CyclicBarrier(n);
        ExecutorService acht = Executors.newFixedThreadPool(n);
        try {
            List<Future<String>> vergaben = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                vergaben.add(acht.submit(() -> {
                    start.await(30, SECONDS);
                    return als(t, () -> tx.execute(
                            s -> messstellen.anlegen(neueOhneKennzeichen(t)).kennzeichen()));
                }));
            }
            List<String> kennzeichen = new ArrayList<>();
            for (Future<String> f : vergaben) {
                kennzeichen.add(f.get(60, SECONDS));
            }
            assertThat(kennzeichen).containsExactlyInAnyOrderElementsOf(IntStream.rangeClosed(3, 10)
                    .mapToObj(MessstelleRegeln::automatisch).toList());
        } finally {
            acht.shutdownNow();
        }
        assertThat(zaehler(t)).isEqualTo(10);
    }

    // ---- Das Referenzunternehmen passt in die Tabellen ------------------------

    @Test
    void ahrenbergsMessstellenPassenUnverfaelschtHineinUndDerEntwurfIstDerDesVertrags() {
        UUID t = neuerMandant(referenz.at("/unternehmen/name").asText());
        Map<String, UUID> ids = new LinkedHashMap<>();
        for (JsonNode ms : referenz.get("messstellen")) {
            String k = ms.get("kennzeichen").asText();
            UUID id = legeWieReferenz(t, k).id();
            ids.put(k, id);
            for (JsonNode ng : ms.get("nebengroessen")) {
                alsTue(t, () -> assertThat(messstellen.nebengroesseHinzufuegen(id, groesse(ng))).isPresent());
            }
        }
        // Jede Messstelle der Referenz genau einmal (Fassung 1.6: 23 mit MS-23).
        assertThat(ids).hasSize(referenz.get("messstellen").size());

        alsTue(t, () -> {
            Map<String, Messstelle> gespeichert = messstellen.alle().stream()
                    .collect(Collectors.toMap(Messstelle::kennzeichen, m -> m));
            assertThat(gespeichert.keySet()).isEqualTo(ids.keySet());
            for (JsonNode ms : referenz.get("messstellen")) {
                Messstelle m = gespeichert.get(ms.get("kennzeichen").asText());
                assertThat(m.name()).isEqualTo(ms.get("name").asText());
                assertThat(m.art()).isEqualTo(ms.get("art").asText());
                assertThat(m.medium()).isEqualTo(ms.get("medium").asText());
                assertThat(m.hauptgroesse()).isEqualTo(groesse(ms.get("hauptgroesse")));
                assertThat(m.archiviertAm()).isNull();
                assertThat(messstellen.nebengroessen(m.id())).extracting(Nebengroesse::groesse)
                        .containsExactlyElementsOf(StreamSupport.stream(
                                ms.get("nebengroessen").spliterator(), false)
                                .map(MessstelleMigrationTest::groesse).toList());
            }
            assertThat(messstellen.vergeben()).hasSize(ids.size())
                    .allSatisfy(v -> assertThat(v.frueher() || v.archiviert()).isFalse());
        });

        // Ahrenberg hat automatisch nummeriert (Vorschlag-Fall vorschlag-naechste-nummer):
        // der Zähler steht bei 21. Der Entwurf des Vertrags — frisch angelegt, Kennzeichen
        // vergeben, Hauptgröße gewählt, Name und Ort fehlen — ist genau so speicherbar, und
        // aus der gespeicherten Zeile urteilen die Regeln wie der Fall.
        alsTue(t, () -> app.update("INSERT INTO messstelle_kennzeichen_seq (tenant_id, zaehler) "
                + "VALUES (?, ?)", t, fall("kennzeichen_vorschlag", "vorschlag-naechste-nummer")
                .at("/input/zaehler").asInt()));
        JsonNode fall = fall("lebenszyklus", "neue-messstelle-ohne-name-und-ort");
        JsonNode in = fall.get("input");
        Messstelle entwurf = als(t, () -> tx.execute(s -> messstellen.anlegen(new NeueMessstelle(
                t, null, text(in.get("name")), in.get("art").asText(), in.get("medium").asText(),
                groesse(in.get("hauptgroesse")), null))));
        assertThat(entwurf.kennzeichen()).isEqualTo(in.get("kennzeichen").asText());
        assertThat(entwurf.name()).isNull();
        assertThat(entwurf.angehaltenAb() != null).isEqualTo(in.get("angehalten").asBoolean());
        assertThat(entwurf.archiviertAm() != null).isEqualTo(in.get("archiviert").asBoolean());
        LebenszyklusErgebnis e = MessstelleRegeln.lebenszyklus(new LebenszyklusEingang(
                entwurf.art(), entwurf.medium(), entwurf.kennzeichen(), entwurf.name(),
                entwurf.hauptgroesse(),
                // Ort, Formel und Eingänge haben noch keine Tabelle (IP-7, AP-10).
                in.get("ort_vorhanden").asBoolean(), in.get("formel_vorhanden").asBoolean(),
                in.get("eingaenge_eingerichtet").asBoolean(),
                entwurf.angehaltenAb() != null, entwurf.archiviertAm() != null, List.of(),
                OffsetDateTime.parse(in.get("jetzt").asText())));
        JsonNode soll = fall.get("expected");
        assertThat(e.lebenszyklus()).isEqualTo(soll.get("lebenszyklus").asText());
        assertThat(e.eingerichtet()).isEqualTo(soll.get("eingerichtet").asBoolean());
        assertThat(e.fehlt()).containsExactlyElementsOf(texte(soll.get("fehlt")));
        assertThat(e.quelleVorhanden()).isEqualTo(soll.get("quelle_vorhanden").asBoolean());
    }

    // ---- Nebengrößen (E1) ------------------------------------------------------

    @Test
    void nebengroessenJeMessstelleNachKatalogNieDoppeltUndNieDieHauptgroesse() {
        UUID t = neuerMandant("Nebengrößen-Probe");
        UUID ms06 = legeWieReferenz(t, "MS-06").id();
        UUID ms04 = legeWieReferenz(t, "MS-04").id();
        UUID ms21 = legeWieReferenz(t, "MS-21").id();
        Groesse leistung = groesse(referenzMessstelle("MS-06").at("/nebengroessen/0"));
        Groesse ladestand = groesse(referenzMessstelle("MS-04").at("/nebengroessen/0"));
        UUID ng06 = als(t, () -> messstellen.nebengroesseHinzufuegen(ms06, leistung)).orElseThrow();
        als(t, () -> messstellen.nebengroesseHinzufuegen(ms04, ladestand)).orElseThrow();

        // Dieselbe Größe ein zweites Mal: nie (je Größe höchstens eine führende Quelle).
        abgelehnt("23505", "messstelle_groesse_eindeutig",
                () -> alsTue(t, () -> messstellen.nebengroesseHinzufuegen(ms06, leistung)));
        // Die Hauptgröße als Nebengröße — auch mit anderer Wertart ist es dieselbe Größe.
        Groesse haupt06 = groesse(referenzMessstelle("MS-06").get("hauptgroesse"));
        abgelehnt("23505", "messstelle_groesse_nicht_hauptgroesse", () -> alsTue(t,
                () -> messstellen.nebengroesseHinzufuegen(ms06, new Groesse(haupt06.groesse(),
                        haupt06.richtung(), haupt06.einheit(), "Intervallmenge"))));
        // Nur, was im Katalog steht: kein Ladestand „Bezug", keine Wirkleistung am Gas.
        abgelehnt("23514", "messstelle_groesse_katalog", () -> alsTue(t,
                () -> messstellen.nebengroesseHinzufuegen(ms06, new Groesse(ladestand.groesse(),
                        "Bezug", ladestand.einheit(), ladestand.wertart()))));
        abgelehnt("23514", "messstelle_groesse_katalog",
                () -> alsTue(t, () -> messstellen.nebengroesseHinzufuegen(ms21, leistung)));
        // Das Medium der Nebengröße IST das der Messstelle: der Verweis hält es gleich.
        abgelehnt("23503", "messstelle_groesse_messstelle_fk", () -> alsTue(t, () -> app.update(
                "INSERT INTO messstelle_groesse (tenant_id, messstelle_id, medium, groesse, "
                        + "richtung, einheit, wertart) VALUES (?, ?, 'Gas', 'Volumen', 'Bezug', "
                        + "'m³', 'Zählerstand')", t, ms06)));

        // Die Größe einer Nebengröße ist nie änderbar; archivieren darf man sie.
        for (String zuweisung : List.of("groesse = 'Scheinleistung'", "richtung = 'Abgabe'",
                "wertart = 'Zählerstand'", "einheit = 'MW'", "medium = 'Gas'")) {
            abgelehnt("23514", "messstelle_groesse_unveraenderlich", () -> alsTue(t,
                    () -> app.update("UPDATE messstelle_groesse SET " + zuweisung + " WHERE id = ?", ng06)));
        }
        Instant archiviert = Instant.now().truncatedTo(ChronoUnit.MINUTES);
        alsTue(t, () -> {
            assertThat(messstellen.nebengroesseArchivieren(ng06, archiviert)).isTrue();
            assertThat(messstellen.nebengroesseArchivieren(ng06, archiviert)).isFalse();
            assertThat(messstellen.nebengroessen(ms06)).singleElement().satisfies(n -> {
                assertThat(n.groesse()).isEqualTo(leistung);
                assertThat(n.archiviertAm()).isEqualTo(archiviert);
            });
            assertThat(messstellen.nebengroessen(ms04)).extracting(Nebengroesse::groesse)
                    .containsExactly(ladestand);
            assertThat(messstellen.nebengroessen(ms21)).isEmpty();
        });
    }

    @Test
    void artMediumUndHauptgroesseSindNieAenderbarNameUndNotizSchon() {
        UUID t = neuerMandant("Identitäts-Probe");
        UUID ms06 = legeWieReferenz(t, "MS-06").id();
        for (String zuweisung : List.of("art = 'berechnet'", "medium = 'Gas'",
                "groesse = 'Blindenergie'", "richtung = 'Abgabe'", "einheit = 'kvarh'",
                "wertart = 'Intervallmenge'", "tenant_id = '" + neuerMandant("Anderer") + "'")) {
            abgelehnt("23514", "messstelle_identitaet_unveraenderlich", () -> alsTue(t,
                    () -> app.update("UPDATE messstelle SET " + zuweisung + " WHERE id = ?", ms06)));
        }
        alsTue(t, () -> {
            assertThat(app.update("UPDATE messstelle SET name = 'Spritzguss Halle 1', "
                    + "notiz = 'Zählerplatz UV-1' WHERE id = ?", ms06)).isOne();
            // Ein fehlender Name ist NULL, nie ein leerer.
            assertThat(app.update("UPDATE messstelle SET name = NULL WHERE id = ?", ms06)).isOne();
        });
        abgelehnt("23514", "messstelle_name_chk", () -> alsTue(t,
                () -> app.update("UPDATE messstelle SET name = '   ' WHERE id = ?", ms06)));
    }

    // ---- Die CHECKs sagen dasselbe wie die Regeln ----------------------------

    @Test
    void katalogFormUndVokabulareSagenDasselbeWieMessstelleRegeln() {
        // Der Katalog über das volle Kreuzprodukt der Vokabulare (plus eine Größe, die es
        // nicht gibt): die Datenbank-Funktion urteilt wie MessstelleRegeln.groessePruefen.
        List<String> medien = texte(vektoren.get("medien"));
        List<String> groessen = new ArrayList<>(StreamSupport.stream(
                vektoren.get("groessen_katalog").spliterator(), false)
                .map(g -> g.get("groesse").asText()).toList());
        groessen.add("Temperatur");
        List<String> richtungen = texte(schema.at("/$defs/richtung/enum"));
        List<String> einheiten = texte(schema.at("/$defs/einheit/enum"));
        List<String> wertarten = texte(schema.at("/$defs/wertart/enum"));
        List<Map<String, Object>> zeilen = root.queryForList("SELECT m, g, r, e, w, "
                + "messstelle_groesse_im_katalog(m, g, r, e, w) AS ok FROM unnest(?::text[]) m, "
                + "unnest(?::text[]) g, unnest(?::text[]) r, unnest(?::text[]) e, unnest(?::text[]) w",
                pgArray(medien), pgArray(groessen), pgArray(richtungen), pgArray(einheiten),
                pgArray(wertarten));
        assertThat(zeilen).hasSize(medien.size() * groessen.size() * richtungen.size()
                * einheiten.size() * wertarten.size());
        long erlaubt = 0;
        for (Map<String, Object> z : zeilen) {
            boolean regel = MessstelleRegeln.groessePruefen((String) z.get("m"), new Groesse(
                    (String) z.get("g"), (String) z.get("r"), (String) z.get("e"),
                    (String) z.get("w"))).fehler() == null;
            assertThat((Boolean) z.get("ok")).as(z.toString()).isEqualTo(regel);
            erlaubt += regel ? 1 : 0;
        }
        assertThat(erlaubt).isEqualTo(26);

        // Die Kennzeichen-Form: der CHECK trägt das Muster der Regeln wörtlich, und die
        // Regex-Maschine der Datenbank urteilt wie die von Java.
        assertThat(root.queryForObject("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                + "WHERE conname = 'messstelle_kennzeichen_format'", String.class))
                .contains("'" + MessstelleRegeln.KENNZEICHEN_MUSTER + "'");
        List<String> kandidaten = new ArrayList<>(List.of("", "M", "MS", "MS-0022", "E-HZ-01",
                "MS-0006/HALLE.1N", "MS-0006/HALLE.1NX", "ms-01", "MS 22", "HÄLLE-1", "MS_01",
                "MS-01\n", "ÉS-01", "MS–01", "１２"));
        faelle("kennzeichen_pruefen").forEach(f -> kandidaten.add(f.at("/input/kandidat").asText()));
        for (String k : kandidaten) {
            assertThat(root.queryForObject("SELECT ?::text ~ ?", Boolean.class, k,
                    MessstelleRegeln.KENNZEICHEN_MUSTER)).as("„" + k + "“")
                    .isEqualTo(MessstelleRegeln.kennzeichenFormatGueltig(k));
        }

        // Die Vokabulare: Art und Medium sind die geschlossenen Listen des Schemas — das
        // VOLLE Medium-Vokabular; dass der Dialog nur „Strom" anbietet, ist Sache der Fläche.
        UUID t = neuerMandant("Vokabular-Probe");
        JsonNode ms06 = referenzMessstelle("MS-06");
        for (String medium : MessstelleRegeln.MEDIEN) {
            assertThat(root.queryForObject("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                    + "WHERE conname = 'messstelle_medium_chk'", String.class))
                    .contains("'" + medium + "'");
        }
        assertThat(texte(schema.at("/$defs/medium/enum"))).isEqualTo(MessstelleRegeln.MEDIEN);
        for (String art : texte(schema.at("/$defs/art/enum"))) {
            alsTue(t, () -> messstellen.anlegen(new NeueMessstelle(t, "ART-" + art.toUpperCase(Locale.ROOT),
                    null, art, "Strom", groesse(ms06.get("hauptgroesse")), null)));
        }
        abgelehnt("23514", "messstelle_art_chk", () -> alsTue(t, () -> messstellen.anlegen(
                new NeueMessstelle(t, "ART-X", null, "geschaetzt", "Strom",
                        groesse(ms06.get("hauptgroesse")), null))));
        // „Öl" steht in keinem Vokabular. Postgres prüft CHECKs in der Reihenfolge ihrer
        // Namen: der Katalog (…_hauptgroesse_katalog) urteilt vor dem Medium-Vokabular
        // (…_medium_chk) — und kennt „Öl" ebenso wenig. Das Medium-Vokabular greift für
        // sich, sobald AP-09 Größen für Wärme, Kälte, Wasser oder Druckluft bringt.
        abgelehnt("23514", "messstelle_hauptgroesse_katalog", () -> alsTue(t, () -> messstellen.anlegen(
                new NeueMessstelle(t, "MED-X", null, "gemessen", "Öl",
                        groesse(ms06.get("hauptgroesse")), null))));
        abgelehnt("23514", "messstelle_hauptgroesse_katalog", () -> alsTue(t, () -> messstellen.anlegen(
                new NeueMessstelle(t, "KAT-X", null, "gemessen", "Wasser",
                        groesse(ms06.get("hauptgroesse")), null))));
    }

    // ---- Das Protokoll ist append-only ---------------------------------------

    @Test
    void dasAenderungsprotokollIstAppendOnlyUndNenntSeinenUrheber() {
        UUID t = neuerMandant(referenz.at("/unternehmen/name").asText());
        // Kennzeichen-Fall kuerzen-auf-eigenes-kennzeichen: MS-0006 wird MS-06, und die
        // Umbenennung steht im Protokoll — eingetragen von Ines Kaltenbach (Energiemanagerin).
        UUID ms = als(t, () -> messstellen.anlegen(wieReferenz(t, "MS-0006", referenzMessstelle("MS-06")))).id();
        alsTue(t, () -> assertThat(messstellen.kennzeichenAendern(ms, "MS-06")).isTrue());
        JsonNode ines = person("IK");
        long id = als(t, () -> aenderungen.eintragen(new NeuerEintrag(t, ms, "bearbeitet",
                "{\"kennzeichen\": \"MS-0006\"}", "{\"kennzeichen\": \"MS-06\"}",
                Instant.now().truncatedTo(ChronoUnit.MINUTES), false, null, "sub-ines",
                ines.get("name").asText(), rollenKennung(ines), "kunde")));
        alsTue(t, () -> assertThat(aenderungen.fuerMessstelle(ms)).singleElement().satisfies(e -> {
            assertThat(e.id()).isEqualTo(id);
            assertThat(e.art()).isEqualTo("bearbeitet");
            assertThat(e.altJson()).isEqualTo("{\"kennzeichen\": \"MS-0006\"}");
            assertThat(e.neuJson()).isEqualTo("{\"kennzeichen\": \"MS-06\"}");
            assertThat(e.actorName()).isEqualTo("Ines Kaltenbach");
            assertThat(e.actorRolle()).isEqualTo("energiemanager");
            assertThat(e.actorArt()).isEqualTo("kunde");
        }));

        // Nie ändern, nie löschen — die App-Rolle hat die Rechte nicht, die Admin-Rolle
        // auch nicht, und selbst der Eigentümer scheitert am Trigger.
        for (JdbcTemplate rolle : List.of(app, admin)) {
            abgelehntWegen("42501", "permission denied", () -> alsTue(t, () -> rolle.update(
                    "UPDATE messstelle_aenderung SET art = 'archiviert' WHERE id = ?", id)));
            abgelehntWegen("42501", "permission denied", () -> alsTue(t, () -> rolle.update(
                    "DELETE FROM messstelle_aenderung WHERE id = ?", id)));
        }
        abgelehntWegen("P0001", "append-only",
                () -> root.update("UPDATE messstelle_aenderung SET art = 'archiviert' WHERE id = ?", id));
        abgelehntWegen("P0001", "append-only",
                () -> root.update("DELETE FROM messstelle_aenderung WHERE id = ?", id));

        // Die Unterstützung und VoltPilot selbst tragen ein; ein Kunde ohne sub nicht.
        JsonNode brunner = person("TB");
        alsTue(t, () -> aenderungen.eintragen(new NeuerEintrag(t, ms, "angehalten", null, null,
                Instant.now().minus(1, ChronoUnit.HOURS), true, "Umbau", "sub-brunner",
                brunner.get("name").asText(), rollenKennung(brunner), "unterstuetzung")));
        admin.update("INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, art, gilt_ab, "
                + "rueckwirkend, actor_sub, actor_name, actor_art) VALUES (?, ?, 'angelegt', now(), "
                + "false, NULL, 'VoltPilot (Bestandsübernahme)', 'voltpilot')", t, ms);
        assertThat(als(t, () -> aenderungen.fuerMessstelle(ms))).hasSize(3);

        protokollChk("messstelle_aenderung_art_chk", "geloescht", "'sub-ines'", "'kunde'", "now()", false);
        protokollChk("messstelle_aenderung_actor_art_chk", "bearbeitet", "'sub-ines'", "'installateur'", "now()", false);
        protokollChk("messstelle_aenderung_actor_chk", "bearbeitet", "NULL", "'kunde'", "now()", false);
        protokollChk("messstelle_aenderung_actor_chk", "bearbeitet", "''", "'kunde'", "now()", false);
        // „rückwirkend" an einer Änderung, die erst später gilt: nie.
        // Die Rolle ist die KENNUNG des Rechte-Vertrags — genau seine sieben, nie das Kundenwort.
        String rollenChk = root.queryForObject("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                + "WHERE conname = 'messstelle_aenderung_actor_rolle_chk'", String.class);
        assertThat(rollenChk.split("'").length / 2).isEqualTo(RechteAbleitung.Rolle.values().length);
        for (RechteAbleitung.Rolle r : RechteAbleitung.Rolle.values()) {
            assertThat(rollenChk).contains("'" + r.code() + "'");
        }
        abgelehnt("23514", "messstelle_aenderung_actor_rolle_chk", () -> root.update(
                "INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, art, gilt_ab, "
                        + "rueckwirkend, actor_sub, actor_name, actor_rolle, actor_art) "
                        + "VALUES (?, ?, 'bearbeitet', now(), false, 'sub-ines', ?, ?, 'kunde')",
                t, ms, ines.get("name").asText(), ines.get("rolle").asText()));
        protokollChk("messstelle_aenderung_rueckwirkend_chk", "bearbeitet", "'sub-ines'", "'kunde'",
                "now() + interval '1 day'", true);
    }

    // ---- Rechte: nie löschen, das Offboarding räumt ausdrücklich ab ----------

    @Test
    void niemandLoeschtUndDasOffboardingRaeumtAusdruecklichAb() {
        // Die App-Rolle: nirgends DELETE, die Belegung nur lesen, das Protokoll nur
        // anfügen. Die Admin-Rolle behält DELETE auf den Stammdaten (das Offboarding
        // löscht über sie), am Protokoll nur lesen und anfügen.
        Map<String, String> appRechte = Map.of(
                "messstelle", "SIU", "messstelle_groesse", "SIU", "messstelle_kennzeichen_seq", "SIU",
                "messstelle_kennzeichen", "S", "messstelle_aenderung", "SI");
        Map<String, String> adminRechte = Map.of(
                "messstelle", "SIUD", "messstelle_groesse", "SIUD", "messstelle_kennzeichen_seq", "SIUD",
                "messstelle_kennzeichen", "SIUD", "messstelle_aenderung", "SI");
        for (String tabelle : TABELLEN) {
            assertThat(rechte(APP_USER, tabelle)).as("App-Rolle auf " + tabelle)
                    .isEqualTo(appRechte.get(tabelle));
            assertThat(rechte(ADMIN_USER, tabelle)).as("Admin-Rolle auf " + tabelle)
                    .isEqualTo(adminRechte.get(tabelle));
        }
        for (String rolle : List.of(APP_USER, ADMIN_USER)) {
            assertThat(root.queryForObject("SELECT has_sequence_privilege(?, "
                    + "'messstelle_aenderung_id_seq', 'USAGE')", Boolean.class, rolle)).as(rolle).isTrue();
        }

        UUID t = neuerMandant("Offboarding-Probe");
        UUID ms = legeWieReferenz(t, "MS-06").id();
        alsTue(t, () -> {
            messstellen.nebengroesseHinzufuegen(ms, groesse(referenzMessstelle("MS-06").at("/nebengroessen/0")));
            tx.executeWithoutResult(s -> messstellen.anlegen(neueOhneKennzeichen(t)));
            aenderungen.eintragen(eintrag(t, ms, "angelegt", null, "{\"kennzeichen\": \"MS-06\"}"));
        });
        // Die App-Rolle löscht nirgends und schreibt keine Belegung selbst.
        for (String tabelle : List.of("messstelle", "messstelle_groesse", "messstelle_kennzeichen",
                "messstelle_kennzeichen_seq")) {
            abgelehntWegen("42501", "permission denied",
                    () -> alsTue(t, () -> app.update("DELETE FROM " + tabelle)));
        }
        abgelehntWegen("42501", "permission denied", () -> alsTue(t, () -> app.update(
                "INSERT INTO messstelle_kennzeichen (tenant_id, kennzeichen, messstelle_id) "
                        + "VALUES (?, 'MS-77', ?)", t, ms)));
        abgelehntWegen("42501", "permission denied", () -> alsTue(t, () -> app.update(
                "UPDATE messstelle_kennzeichen SET kennzeichen = 'MS-77'")));

        // Nie Kaskade: weder der Mandant noch eine Messstelle mit Geschichte gehen still.
        abgelehnt("23503", null, () -> root.update("DELETE FROM tenant WHERE id = ?", t));
        abgelehnt("23503", null, () -> root.update("DELETE FROM messstelle WHERE id = ?", ms));

        // Das Offboarding ist der eine Weg, auf dem ein Kundenbereich endet.
        new TenantRepository(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW))).offboard(t);
        assertThat(anzahl("SELECT count(*) FROM tenant WHERE id = ?", t)).isZero();
        for (String tabelle : List.of("messstelle", "messstelle_groesse", "messstelle_kennzeichen",
                "messstelle_kennzeichen_seq")) {
            assertThat(anzahl("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?", t))
                    .as(tabelle).isZero();
        }
        // Das Protokoll bleibt: append-only und ohne Fremdschlüssel.
        assertThat(anzahl("SELECT count(*) FROM messstelle_aenderung WHERE tenant_id = ?", t)).isOne();
    }

    // ---- Gerüst: Referenz und Vektor-Datei -----------------------------------

    private static JsonNode referenzMessstelle(String kennzeichen) {
        for (JsonNode ms : referenz.get("messstellen")) {
            if (ms.get("kennzeichen").asText().equals(kennzeichen)) {
                return ms;
            }
        }
        return null;
    }

    private static JsonNode referenzMessstelleNachName(String name) {
        for (JsonNode ms : referenz.get("messstellen")) {
            if (ms.get("name").asText().equals(name)) {
                return ms;
            }
        }
        return null;
    }

    private static JsonNode person(String kuerzel) {
        for (JsonNode p : referenz.get("personen")) {
            if (p.get("kuerzel").asText().equals(kuerzel)) {
                return p;
            }
        }
        throw new AssertionError("keine Person " + kuerzel + " im Referenzunternehmen");
    }

    /** Die Rollen-Kennung des Rechte-Vertrags zum Kundenwort einer Person der Referenz. */
    private static String rollenKennung(JsonNode person) {
        String kundenwort = person.get("rolle").asText();
        return Arrays.stream(RechteAbleitung.Rolle.values())
                .filter(r -> r.kundenwort().equals(kundenwort)).findFirst()
                .orElseThrow(() -> new AssertionError("keine Rolle „" + kundenwort + "“"))
                .code();
    }

    private static Groesse groesse(JsonNode g) {
        return new Groesse(g.get("groesse").asText(), g.get("richtung").asText(),
                g.get("einheit").asText(), g.get("wertart").asText());
    }

    /** Eine Messstelle mit den Werten der Referenz — unter dem gegebenen Kennzeichen. */
    private static NeueMessstelle wieReferenz(UUID tenant, String kennzeichen, JsonNode ms) {
        return new NeueMessstelle(tenant, kennzeichen, ms.get("name").asText(), ms.get("art").asText(),
                ms.get("medium").asText(), groesse(ms.get("hauptgroesse")), null);
    }

    /**
     * Die Ahrenberg-Messstelle mit diesem Kennzeichen, unverfälscht — oder, wo die Referenz
     * es nicht kennt, eine frisch angelegte neue ohne Namen.
     */
    private static Messstelle legeWieReferenz(UUID tenant, String kennzeichen) {
        JsonNode ms = referenzMessstelle(kennzeichen);
        return als(tenant, () -> messstellen.anlegen(ms == null
                ? neueMitKennzeichen(tenant, kennzeichen) : wieReferenz(tenant, kennzeichen, ms)));
    }

    /**
     * Eine neue Messstelle wie im Lebenszyklus-Fall neue-messstelle-ohne-name-und-ort:
     * gemessen, Strom, die Hauptgröße des Falls, der Name fehlt noch.
     */
    private static NeueMessstelle neueMitKennzeichen(UUID tenant, String kennzeichen) {
        JsonNode in = fall("lebenszyklus", "neue-messstelle-ohne-name-und-ort").get("input");
        return new NeueMessstelle(tenant, kennzeichen, null, in.get("art").asText(),
                in.get("medium").asText(), groesse(in.get("hauptgroesse")), null);
    }

    private static NeueMessstelle neueOhneKennzeichen(UUID tenant) {
        return neueMitKennzeichen(tenant, null);
    }

    /**
     * Speichert den Bestand eines Kennzeichen-Falls: je Träger die Messstelle der Referenz
     * (gefunden über ihr heutiges Kennzeichen oder ihren Namen), angelegt unter ihrem
     * frühesten Kennzeichen, dann umbenannt bis zum heutigen, archiviert, wenn der Fall es
     * sagt. Liefert die Messstelle je heutigem Kennzeichen.
     */
    private static Map<String, UUID> speichereBelegung(UUID tenant, JsonNode vergeben) {
        Map<String, List<JsonNode>> jeTraeger = new LinkedHashMap<>();
        for (JsonNode v : vergeben) {
            jeTraeger.computeIfAbsent(v.get("messstelle").asText(), k -> new ArrayList<>()).add(v);
        }
        Instant archivZeit = OffsetDateTime.parse(fall("lebenszyklus", "ms-13-archiviert")
                .at("/input/fuehrende_quelle/0/gueltig_bis").asText()).toInstant();
        Map<String, UUID> ids = new LinkedHashMap<>();
        jeTraeger.forEach((traeger, eintraege) -> {
            JsonNode heute = eintraege.stream().filter(e -> !e.get("frueher").asBoolean())
                    .findFirst().orElseThrow();
            assertThat(heute.get("kennzeichen").asText()).isEqualTo(traeger);
            List<String> kennzeichen = new ArrayList<>(eintraege.stream()
                    .filter(e -> e.get("frueher").asBoolean())
                    .map(e -> e.get("kennzeichen").asText()).toList());
            kennzeichen.add(traeger);
            String name = heute.get("name").asText();
            JsonNode ms = Objects.requireNonNullElse(referenzMessstelle(traeger),
                    referenzMessstelleNachName(name));
            assertThat(ms).as("Träger " + traeger + " im Referenzunternehmen").isNotNull();
            assertThat(ms.get("name").asText()).as("Name wie in der Referenz").isEqualTo(name);
            UUID id = als(tenant, () -> messstellen.anlegen(
                    wieReferenz(tenant, kennzeichen.get(0), ms))).id();
            alsTue(tenant, () -> {
                for (String k : kennzeichen.subList(1, kennzeichen.size())) {
                    assertThat(messstellen.kennzeichenAendern(id, k)).isTrue();
                }
                if (heute.get("archiviert").asBoolean()) {
                    assertThat(messstellen.archivieren(id, archivZeit)).isTrue();
                }
            });
            ids.put(traeger, id);
        });
        return ids;
    }

    private static Set<Vergeben> vergebenAus(JsonNode liste) {
        Set<Vergeben> s = new HashSet<>();
        liste.forEach(v -> s.add(vergeben(v)));
        return s;
    }

    private static Vergeben vergeben(JsonNode v) {
        return new Vergeben(v.get("kennzeichen").asText(), v.get("messstelle").asText(),
                v.get("name").asText(), v.get("archiviert").asBoolean(), v.get("frueher").asBoolean());
    }

    private static Stream<JsonNode> faelle(String familie) {
        List<JsonNode> out = new ArrayList<>();
        vektoren.path("cases").path(familie).forEach(out::add);
        assertThat(out).as("Fälle der Familie " + familie).isNotEmpty();
        return out.stream();
    }

    private static JsonNode fall(String familie, String name) {
        return faelle(familie).filter(f -> f.get("name").asText().equals(name)).findFirst()
                .orElseThrow(() -> new AssertionError("kein Fall " + familie + "/" + name));
    }

    private static String text(JsonNode n) {
        return n == null || n.isNull() ? null : n.asText();
    }

    private static List<String> texte(JsonNode liste) {
        return StreamSupport.stream(liste.spliterator(), false).map(JsonNode::asText).toList();
    }

    private static NeuerEintrag eintrag(UUID t, UUID ms, String art, String alt, String neu) {
        JsonNode ines = person("IK");
        return new NeuerEintrag(t, ms, art, alt, neu, Instant.now().truncatedTo(ChronoUnit.MINUTES),
                false, null, "sub-ines", ines.get("name").asText(), rollenKennung(ines), "kunde");
    }

    // ---- Gerüst: Datenbank ---------------------------------------------------

    private static UUID neuerMandant(String name) {
        return root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
    }

    private static Integer zaehler(UUID tenant) {
        List<Integer> z = root.queryForList("SELECT zaehler FROM messstelle_kennzeichen_seq "
                + "WHERE tenant_id = ?", Integer.class, tenant);
        return z.isEmpty() ? null : z.get(0);
    }

    private static long anzahl(String sql, Object... args) {
        return root.queryForObject(sql, Long.class, args);
    }

    /** Die Tabellenrechte einer Rolle als Buchstaben: S(elect) I(nsert) U(pdate) D(elete). */
    private static String rechte(String rolle, String tabelle) {
        StringBuilder s = new StringBuilder();
        for (String[] r : new String[][] {{"S", "SELECT"}, {"I", "INSERT"}, {"U", "UPDATE"}, {"D", "DELETE"}}) {
            if (Boolean.TRUE.equals(root.queryForObject("SELECT has_table_privilege(?, ?, ?)",
                    Boolean.class, rolle, tabelle, r[1]))) {
                s.append(r[0]);
            }
        }
        return s.toString();
    }

    private static void protokollChk(String constraint, String art, String actorSub, String actorArt,
            String giltAb, boolean rueckwirkend) {
        UUID t = neuerMandant("Protokoll-Probe " + constraint);
        UUID ms = legeWieReferenz(t, "MS-06").id();
        abgelehnt("23514", constraint, () -> root.update("INSERT INTO messstelle_aenderung "
                + "(tenant_id, messstelle_id, art, gilt_ab, rueckwirkend, actor_sub, actor_name, "
                + "actor_art) VALUES (?, ?, ?, " + giltAb + ", ?, " + actorSub + ", 'Ines Kaltenbach', "
                + actorArt + ")", t, ms, art, rueckwirkend));
    }

    private static String pgArray(List<String> werte) {
        return werte.stream().map(w -> "\"" + w.replace("\\", "\\\\").replace("\"", "\\\"") + "\"")
                .collect(Collectors.joining(",", "{", "}"));
    }

    /**
     * Ein Abbild des öffentlichen Schemas — Spalten, Constraints, Indexe, Policies, RLS,
     * Trigger, Rechte und Funktionen —, ohne die genannten Tabellen und Funktionen.
     */
    private static String schema(List<String> ohneTabellen, List<String> ohneFunktionen) {
        String t = pgArray(ohneTabellen);
        String f = pgArray(ohneFunktionen);
        return root.queryForObject("SELECT string_agg(x, E'\\n' ORDER BY x) FROM ("
                + "SELECT 'col:' || table_name || '.' || column_name || '|' || data_type || '|' "
                + "|| is_nullable || '|' || coalesce(column_default, '') AS x "
                + "FROM information_schema.columns WHERE table_schema = 'public' "
                + "AND table_name::text <> ALL (?::text[]) "
                + "UNION ALL SELECT 'con:' || c.relname || '.' || k.conname || ':' "
                + "|| pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid "
                + "WHERE c.relnamespace = 'public'::regnamespace AND c.relname::text <> ALL (?::text[]) "
                + "UNION ALL SELECT 'idx:' || indexdef FROM pg_indexes WHERE schemaname = 'public' "
                + "AND tablename::text <> ALL (?::text[]) "
                + "UNION ALL SELECT 'pol:' || tablename || '.' || policyname || ':' || coalesce(qual, '') "
                + "|| ':' || coalesce(with_check, '') FROM pg_policies WHERE schemaname = 'public' "
                + "AND tablename::text <> ALL (?::text[]) "
                + "UNION ALL SELECT 'rls:' || relname || ':' || relrowsecurity || '/' || relforcerowsecurity "
                + "FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') "
                + "AND relname::text <> ALL (?::text[]) "
                + "UNION ALL SELECT 'trg:' || c.relname || '.' || g.tgname FROM pg_trigger g "
                + "JOIN pg_class c ON c.oid = g.tgrelid WHERE NOT g.tgisinternal "
                + "AND c.relnamespace = 'public'::regnamespace AND c.relname::text <> ALL (?::text[]) "
                + "UNION ALL SELECT 'grant:' || table_name || ':' || grantee || ':' || privilege_type "
                + "FROM information_schema.role_table_grants WHERE table_schema = 'public' "
                + "AND table_name::text <> ALL (?::text[]) "
                + "UNION ALL SELECT 'fn:' || p.oid::regprocedure::text || ':' || coalesce(p.proacl::text, '') "
                + "FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace "
                + "AND p.proname::text <> ALL (?::text[])) s",
                String.class, t, t, t, t, t, t, t, f);
    }

    // ---- Gerüst: Zaun, Warten und Ablehnungen --------------------------------

    private static <T> T als(UUID tenant, Supplier<T> arbeit) {
        UUID vorher = TenantContext.get();
        TenantContext.set(tenant);
        try {
            return arbeit.get();
        } finally {
            if (vorher == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(vorher);
            }
        }
    }

    private static void alsTue(UUID tenant, Runnable arbeit) {
        als(tenant, () -> {
            arbeit.run();
            return null;
        });
    }

    private static void warte(CountDownLatch latch) {
        try {
            assertThat(latch.await(30, SECONDS)).isTrue();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        }
    }

    private static void warteBis(BooleanSupplier bedingung) throws InterruptedException {
        long bis = System.nanoTime() + SECONDS.toNanos(30);
        while (!bedingung.getAsBoolean()) {
            assertThat(System.nanoTime()).as("Bedingung nicht binnen 30 s erfüllt").isLessThan(bis);
            Thread.sleep(50);
        }
    }

    /** Die Ablehnung der Datenbank — oder {@code null}, wenn sie annimmt. */
    private static PSQLException ablehnung(Runnable arbeit) {
        try {
            arbeit.run();
            return null;
        } catch (RuntimeException e) {
            for (Throwable t = e; t != null; t = t.getCause()) {
                if (t instanceof PSQLException p) {
                    return p;
                }
            }
            throw e;
        }
    }

    private static void abgelehnt(String sqlState, String constraint, Runnable arbeit) {
        PSQLException p = ablehnung(arbeit);
        assertThat((Object) p).as("die Datenbank muss ablehnen (" + constraint + ")").isNotNull();
        assertThat(p.getSQLState()).as(p.getMessage()).isEqualTo(sqlState);
        if (constraint != null) {
            assertThat(p.getServerErrorMessage().getConstraint()).as(p.getMessage())
                    .isEqualTo(constraint);
        }
    }

    private static void abgelehntWegen(String sqlState, String nachricht, Runnable arbeit) {
        PSQLException p = ablehnung(arbeit);
        assertThat((Object) p).as("die Datenbank muss ablehnen (" + nachricht + ")").isNotNull();
        assertThat(p.getSQLState()).as(p.getMessage()).isEqualTo(sqlState);
        assertThat(p.getMessage()).contains(nachricht);
    }

    // ---- Gerüst: Flyway ------------------------------------------------------

    private static String letzteFassungVorDieser() {
        MigrationVersion diese = MigrationVersion.fromVersion(DIESE);
        return Arrays.stream(flyway().load().info().all())
                .map(MigrationInfo::getVersion)
                .filter(v -> v != null && v.compareTo(diese) < 0)
                .max(Comparator.naturalOrder())
                .orElseThrow()
                .getVersion();
    }

    /** Dieselbe Datei noch einmal, wie Flyway sie ausführt (Platzhalter ersetzt). */
    private static void fuehreDieseMigrationErneutAus() throws IOException {
        String sql;
        try (InputStream in = MessstelleMigrationTest.class
                .getResourceAsStream("/db/migration/" + DATEI)) {
            sql = new String(Objects.requireNonNull(in, DATEI).readAllBytes(),
                    StandardCharsets.UTF_8);
        }
        root.execute(sql.replace("${appDbUser}", APP_USER).replace("${adminDbUser}", ADMIN_USER));
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
