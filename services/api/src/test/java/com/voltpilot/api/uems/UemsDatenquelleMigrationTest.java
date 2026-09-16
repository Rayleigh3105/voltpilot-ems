package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.DatenquelleRegeln.Grund;
import com.voltpilot.api.uems.DatenquelleRegeln.Zeitraum;
import com.voltpilot.api.uems.DatenquelleRepository.Datenquelle;
import com.voltpilot.api.uems.DatenquelleRepository.NeueDatenquelle;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;
import java.util.stream.Collectors;
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
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Migration {@code V20260911150000} (UEMS AP-06 IP-2) gegen eine echte
 * TimescaleDB: Datenquelle, zeitgültige Zuständigkeit je Box, Kennzeichen-Zähler
 * und die zwei nullable Verweise {@code site.lead_device_id} und
 * {@code measurement_point.data_source_id}.
 *
 * <p>Der Prüfnachweis des Konzepts (AP-06 §8 IP-2), je Gruppe ein Test:
 * (a) der Zaun steht auf jeder neuen Tabelle, eine fremde Quelle ist nicht da
 * (→ 404), (b) die Überlappung — die Familie {@code zeitraeume} aus
 * {@code docs/contracts/v2/data-source-vectors.json} gegen die Exklusions-
 * Constraints, dazu die Fälle der Familie {@code antrag}, deren Grund die
 * Datenbank trägt (Eindeutigkeit je Box, A4 gleiche Adresse an zwei Boxen),
 * (c) das Unclaim läuft wie heute, die führende Box wird NULL und die
 * Zuständigkeit bleibt, (d) {@code site} und {@code measurement_point} sind
 * bis auf die neue Spalte zeichengleich, (e) die Referenz-Datenquellen DQ-1 …
 * DQ-7 mit ihren Zuständigkeiten passen ins Schema. Dazu Kennzeichen-Zähler,
 * CHECKs, Offboarding und die Rechte der App-Rolle.
 *
 * <p>Beispielquelle ist allein das Referenzunternehmen
 * ({@code uems-referenzunternehmen.json}): Anlagen, Boxen, Quellen und
 * Zeiträume kommen mit ihren Kennzeichen und Werten aus der Datei; die Fälle der
 * Vektor-Datei spielen je in einem eigenen Kundenbereich („Probe").
 *
 * <p>Vorbild: {@code UemsStandortMigrationTest} — bis zur Fassung davor
 * migrieren, den Bestand säen, dann diese Fassung laufen lassen.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsDatenquelleMigrationTest {

    /** Diese Fassung. Die davor wird aus dem Klassenpfad bestimmt, nicht hart verdrahtet. */
    private static final String DIESE = "20260911150000";
    private static final String DATEI = "V20260911150000__uems_datenquelle_zustaendigkeit.sql";

    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final Path REFERENZ = V2.resolve("uems-referenzunternehmen.json");
    private static final Path VEKTOREN = V2.resolve("data-source-vectors.json");

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final List<String> TABELLEN =
            List.of("data_source", "data_source_assignment", "data_source_kennzeichen_seq");

    /** Welcher Constraint welchen Grund des Vertrags trägt. */
    private static final Map<String, String> GRUND_DES_CONSTRAINTS = Map.of(
            "data_source_assignment_eine_box_je_zeitpunkt", "ueberschneidung",
            "data_source_assignment_nicht_leer", "leerer_zeitraum",
            "data_source_assignment_volle_minute", "keine_volle_minute",
            "data_source_assignment_ein_weg_je_box", "adresse_an_box_vergeben",
            "data_source_protokoll_chk", "protokoll_unbekannt");

    /**
     * Die Gründe eines Antrags (Vertrag §5), die die Datenbank selbst trägt — und was
     * sie dazu sagt. Ein Wechsel VOR einem geplanten ist in der Datenbank schlicht
     * eine Überschneidung mit ihm.
     */
    private static final Map<String, String> ANTRAG_IN_DER_DATENBANK = Map.of(
            "protokoll_unbekannt", "protokoll_unbekannt",
            "keine_volle_minute", "keine_volle_minute",
            "adresse_an_box_vergeben", "adresse_an_box_vergeben",
            "spaeterer_wechsel_geplant", "ueberschneidung");

    /**
     * Die übrigen Gründe prüft der Schreibweg mit {@link DatenquelleRegeln} (IP-3):
     * „jetzt" (rückwirkend), die Rolle einer Quelle, die Netzlage an einer ANDEREN
     * Box und die Prüfung von der Box gehören in keinen Constraint — die Datenbank
     * nimmt an.
     */
    private static final Set<String> ANTRAG_IM_SCHREIBWEG = Set.of("rueckwirkend", "steuerquelle",
            "schon_zustaendig", "netzlage_fehlt", "nur_ein_leser", "vergleich_bestaetigen",
            "pruefung_fehlt", "pruefung_gescheitert");

    // Der Bestand VOR der Migration: Ahrenberg (Referenzunternehmen) mit Anlagen,
    // Boxen und einer Komponente an Box Halle 1, dazu ein fremder Kundenbereich.
    private static final UUID AHRENBERG = UUID.fromString("4e060000-0000-0000-0000-000000000001");
    private static final UUID FREMD = UUID.fromString("4e060000-0000-0000-0000-000000000002");

    /** Ein Zeitpunkt nach allen Zeiträumen der Referenz, auf die volle Minute. */
    private static final Instant SPAETER = Instant.parse("2027-06-01T08:00:00Z");

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final AtomicInteger PROBE = new AtomicInteger();

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JsonNode referenz;
    private static JsonNode vektoren;

    private static final Map<String, UUID> ANLAGEN = new LinkedHashMap<>();
    private static final Map<String, UUID> BOXEN = new LinkedHashMap<>();
    private static UUID fremdeAnlage;
    private static UUID fremdeBox;
    private static UUID fremdeKomponente;

    private static Map<String, String> siteVorher;
    private static Map<String, String> siteNachher;
    private static Map<String, String> komponenteVorher;
    private static Map<String, String> komponenteNachher;
    private static Map<String, Long> zeilenNachDerMigration;

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static JdbcTemplate admin;
    private static DatenquelleRepository quellen;
    private static ZustaendigkeitRepository zustaendigkeiten;

    private static Map<String, UUID> referenzQuellen;

    @BeforeAll
    static void migriereMitBestand() throws IOException {
        referenz = MAPPER.readTree(REFERENZ.toFile());
        vektoren = MAPPER.readTree(VEKTOREN.toFile());
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));

        flyway().target(letzteFassungVorDieser()).load().migrate();
        saeBestand();
        siteVorher = schnappschuss("site", "lead_device_id", "site_lead_device_fk");
        komponenteVorher = schnappschuss("measurement_point", "data_source_id",
                "measurement_point_data_source_fk");

        flyway().target(DIESE).load().migrate();
        siteNachher = schnappschuss("site", "lead_device_id", "site_lead_device_fk");
        komponenteNachher = schnappschuss("measurement_point", "data_source_id",
                "measurement_point_data_source_fk");
        zeilenNachDerMigration = new LinkedHashMap<>();
        for (String t : TABELLEN) {
            zeilenNachDerMigration.put(t, anzahl("SELECT count(*) FROM " + t));
        }
        zeilenNachDerMigration.put("site.lead_device_id",
                anzahl("SELECT count(*) FROM site WHERE lead_device_id IS NOT NULL"));
        zeilenNachDerMigration.put("measurement_point.data_source_id",
                anzahl("SELECT count(*) FROM measurement_point WHERE data_source_id IS NOT NULL"));

        // Was nach dieser Fassung noch liegt, läuft auch — die Tests prüfen den Endstand.
        flyway().load().migrate();

        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        quellen = new DatenquelleRepository(app);
        zustaendigkeiten = new ZustaendigkeitRepository(app);
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ---- (d) die Bestandstabellen: EINE nullable Spalte, sonst zeichengleich ---

    @Test
    void siteUndMeasurementPointBleibenBisAufDieNeueSpalteZeichengleich() {
        // Der Schnappschuss ist nicht leer: der Bestand steht darin.
        assertThat(siteVorher.get("zeilen")).contains(
                referenz.at("/anlagen/0/name").asText(), "Anlage des fremden Kundenbereichs");
        assertThat(komponenteVorher.get("zeilen")).contains(BOXEN.get("E-1").toString());

        assertThat(siteNachher).isEqualTo(siteVorher);
        assertThat(komponenteNachher).isEqualTo(komponenteVorher);

        // Die neue Spalte: uuid, nullable, ohne Vorgabe, am Ende — und nur ihr Fremdschlüssel.
        assertThat(spalte("site", "lead_device_id")).isEqualTo("uuid|YES|");
        assertThat(spalte("measurement_point", "data_source_id")).isEqualTo("uuid|YES|");
        assertThat(constraint("site_lead_device_fk")).isEqualTo("FOREIGN KEY (lead_device_id, "
                + "tenant_id) REFERENCES device(id, tenant_id) ON DELETE SET NULL (lead_device_id)");
        assertThat(constraint("measurement_point_data_source_fk")).isEqualTo("FOREIGN KEY "
                + "(data_source_id, tenant_id) REFERENCES data_source(id, tenant_id) "
                + "ON DELETE RESTRICT");

        // Kein Backfill: der Bestand behält NULL, die neuen Tabellen sind leer (IP-4/IP-5).
        assertThat(zeilenNachDerMigration).allSatisfy((was, n) -> assertThat(n).as(was).isZero());
    }

    // ---- (a) der Mandantenzaun ------------------------------------------------

    @Test
    void derZaunStehtAufJederNeuenTabelleUndEineFremdeQuelleIstNichtDa() {
        Map<String, UUID> dq = referenzQuellen();
        UUID fremdeQuelle = als(FREMD, () -> quellen.anlegen(neueQuelle(FREMD, fremdeAnlage,
                "192.168.1.10:502"))).id();
        alsTue(FREMD, () -> zustaendigkeiten.eintragen(FREMD, fremdeQuelle, fremdeBox,
                Instant.parse("2026-10-01T06:00:00Z"), null, null).orElseThrow());

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
            assertThat(als(FREMD, () -> app.queryForObject(
                    "SELECT count(*) FROM " + t + " WHERE tenant_id <> ?", Long.class, FREMD)))
                    .as(t).isZero();
        }

        // Die fremde Quelle ist nicht da — die Route macht daraus 404, nie 403.
        alsTue(FREMD, () -> {
            assertThat(quellen.finde(dq.get("DQ-1"))).isEmpty();
            assertThat(quellen.finde(fremdeQuelle)).isPresent();
            assertThat(quellen.alle()).extracting(Datenquelle::id).containsExactly(fremdeQuelle);
            assertThat(zustaendigkeiten.fuerQuelle(dq.get("DQ-3"))).isEmpty();
            // An einer Quelle, die es für B nicht gibt, trägt B nichts ein (→ 404).
            assertThat(zustaendigkeiten.eintragen(FREMD, dq.get("DQ-3"), fremdeBox, SPAETER,
                    null, null)).isEmpty();
        });

        // Schreiben über den Zaun: die Policy lehnt ab — auch die Kennzeichen-Vergabe …
        abgelehntWegen("42501", "row-level security", () -> als(FREMD, () -> quellen.anlegen(
                neueQuelle(AHRENBERG, ANLAGEN.get("AN-1"), "192.168.10.99:502"))));
        abgelehntWegen("42501", "row-level security", () -> als(FREMD, () -> app.queryForObject(
                "SELECT uems_datenquelle_kennzeichen(?)", String.class, AHRENBERG)));
        // … und die zusammengesetzten Fremdschlüssel, die ohne RLS prüfen, lassen
        // keinen Verweis über die Mandantengrenze zu: nicht die Quelle eines
        // Zeitraums, nicht die Quelle einer Komponente, nicht die führende Box.
        abgelehnt("23503", "data_source_assignment_quelle_fk", () -> alsTue(FREMD, () ->
                app.update("INSERT INTO data_source_assignment (tenant_id, data_source_id, "
                        + "device_id, protokoll, adresse, effective_from) VALUES (?,?,?,?,?,?)",
                        FREMD, dq.get("DQ-3"), fremdeBox, "modbus_tcp", "192.168.10.31:502",
                        utc(SPAETER))));
        abgelehnt("23503", "measurement_point_data_source_fk", () -> alsTue(FREMD, () ->
                app.update("UPDATE measurement_point SET data_source_id = ? WHERE id = ?",
                        dq.get("DQ-1"), fremdeKomponente)));
        abgelehnt("23503", "site_lead_device_fk", () -> alsTue(FREMD, () ->
                app.update("UPDATE site SET lead_device_id = ? WHERE id = ?",
                        BOXEN.get("E-1"), fremdeAnlage)));
        // Die lesende Box hat keinen Fremdschlüssel; der Trigger lässt trotzdem nur
        // eine Box DESSELBEN Mandanten zu — eine fremde ist für A „nicht vorhanden".
        abgelehnt("23503", "data_source_assignment_box_fk", () -> alsTue(AHRENBERG, () ->
                zustaendigkeiten.eintragen(AHRENBERG, dq.get("DQ-2"), fremdeBox, SPAETER, null,
                        null)));
    }

    // ---- (b) die Zeiträume = der Vertrag --------------------------------------

    /**
     * Die Familie {@code zeitraeume}: die bestehenden Zeiträume einer Quelle, dann der
     * neue. Die Datenbank spricht dasselbe Urteil wie die Vektor-Datei (und
     * {@link DatenquelleRegeln#pruefeZeitraum}) — die anschließenden Zeiträume (Ende
     * alt = Beginn neu) und die Lücke nimmt sie an, die Überschneidung um eine Minute,
     * den zweiten offenen und den leeren lehnt sie ab.
     */
    @TestFactory
    Stream<DynamicTest> zeitraeumeDieFaelleDerVektorDatei() {
        return faelle("zeitraeume").map(fall -> DynamicTest.dynamicTest(
                fall.get("name").asText(), () -> {
                    JsonNode in = fall.get("input");
                    JsonNode erwartet = fall.get("expected");
                    String erwarteterGrund = text(erwartet.get("grund"));
                    List<Zeitraum> bestehend = zeitraeume(in.get("bestehend"));
                    Zeitraum neu = zeitraum(in.get("neu"));

                    DatenquelleRegeln.ZeitraumErgebnis vertrag =
                            DatenquelleRegeln.pruefeZeitraum(bestehend, neu, boxNamen(in));
                    assertThat(vertrag.gueltig()).isEqualTo(erwartet.get("gueltig").asBoolean());
                    assertThat(vertrag.grund() == null ? null : vertrag.grund().code())
                            .isEqualTo(erwarteterGrund);

                    Probe p = new Probe(in.get("boxen"));
                    JsonNode rq = element(referenz.get("datenquellen"), in.get("quelle").asText());
                    UUID quelle = als(p.tenant, () -> p.quelle(rq.get("protokoll").asText(),
                            adresseAusReferenz(rq)));
                    String grund = als(p.tenant, () -> {
                        bestehend.forEach(z -> p.eintragen(quelle, z));
                        PSQLException e = ablehnung(() -> p.eintragen(quelle, neu));
                        return e == null ? null : grundAus(e);
                    });
                    assertThat(grund).isEqualTo(erwarteterGrund);

                    List<Zeitraum> soll = new ArrayList<>(bestehend);
                    if (erwarteterGrund == null) {
                        soll.add(neu);
                    }
                    soll.sort(Comparator.comparing(Zeitraum::von));
                    assertThat(als(p.tenant, () -> p.zeitraeume(quelle)))
                            .containsExactlyElementsOf(soll);
                }));
    }

    /** Jeder Grund eines Antrags ist genau einem zugeteilt: der Datenbank oder dem Schreibweg. */
    @Test
    void jederGrundEinesAntragsHatGenauEinenTraeger() {
        Set<String> alle = DatenquelleRegeln.PRUEFREIHENFOLGE_ANTRAG.stream().map(Grund::code)
                .collect(Collectors.toSet());
        Set<String> zugeteilt = new HashSet<>(ANTRAG_IN_DER_DATENBANK.keySet());
        zugeteilt.addAll(ANTRAG_IM_SCHREIBWEG);
        assertThat(zugeteilt).isEqualTo(alle);
        assertThat(ANTRAG_IN_DER_DATENBANK.keySet()).doesNotContainAnyElementsOf(ANTRAG_IM_SCHREIBWEG);
    }

    /**
     * Die Familie {@code antrag}, so angewandt, wie der Schreibweg es tun wird: die
     * Quellen des Falls mit ihren Zeiträumen, dann für „anlegen" eine neue Quelle mit
     * einem offenen Zeitraum an der Ziel-Box, für „wechseln" erst den Zeitraum, der
     * den Zeitpunkt enthält, bei ihm beenden, dann den neuen ab ihm. Trägt die
     * Datenbank den Grund (Eindeutigkeit je Box, volle Minute, Protokoll), lehnt sie
     * ab; ein erlaubter Antrag hinterlässt genau die Zeiträume der Vektor-Datei —
     * darunter A4 (gleiche Adresse an zwei Boxen) und A8 (bestätigte Vergleichsquelle).
     */
    @TestFactory
    Stream<DynamicTest> antragWasDieDatenbankDavonTraegt() {
        return faelle("antrag").map(fall -> DynamicTest.dynamicTest(
                fall.get("name").asText(), () -> {
                    JsonNode in = fall.get("input");
                    JsonNode antrag = in.get("antrag");
                    JsonNode erwartet = fall.get("expected");
                    String grund = text(erwartet.get("grund"));
                    boolean erlaubt = "erlaubt".equals(erwartet.get("urteil").asText());
                    assertThat(grund == null || ANTRAG_IN_DER_DATENBANK.containsKey(grund)
                            || ANTRAG_IM_SCHREIBWEG.contains(grund)).as("Grund %s", grund).isTrue();
                    String soll = grund == null ? null : ANTRAG_IN_DER_DATENBANK.get(grund);

                    Probe p = new Probe(in.get("boxen"));
                    Map<String, UUID> ids = new LinkedHashMap<>();
                    alsTue(p.tenant, () -> {
                        for (JsonNode q : in.get("quellen")) {
                            UUID id = p.quelle(q.get("protokoll").asText(),
                                    q.get("adresse").asText());
                            ids.put(q.get("kennzeichen").asText(), id);
                            zeitraeume(q.get("zeitraeume")).forEach(z -> p.eintragen(id, z));
                        }
                    });

                    Instant t = instant(antrag.get("effective_from"));
                    Zeitraum neu = new Zeitraum(antrag.get("box").asText(), t, null);
                    String datenbank = als(p.tenant, () -> {
                        PSQLException e = ablehnung(() -> {
                            if ("anlegen".equals(antrag.get("art").asText())) {
                                JsonNode k = antrag.get("kandidat");
                                UUID id = p.quelle(k.get("protokoll").asText(),
                                        k.get("adresse").asText());
                                ids.put("neu", id);
                                p.eintragen(id, neu);
                            } else {
                                UUID id = ids.get(antrag.get("quelle").asText());
                                for (ZustaendigkeitRepository.Zeitraum z
                                        : zustaendigkeiten.fuerQuelle(id)) {
                                    if (p.alsVertrag(z).umfasst(t)) {
                                        zustaendigkeiten.beenden(z.id(), t);
                                    }
                                }
                                p.eintragen(id, neu);
                            }
                        });
                        return e == null ? null : grundAus(e);
                    });
                    assertThat(datenbank).isEqualTo(soll);

                    if (erlaubt) {
                        UUID id = ids.get("anlegen".equals(antrag.get("art").asText())
                                ? "neu" : antrag.get("quelle").asText());
                        assertThat(als(p.tenant, () -> p.zeitraeume(id)))
                                .containsExactlyElementsOf(zeitraeume(erwartet.get("zeitraeume")));
                    }
                }));
    }

    // ---- (e) das Referenzunternehmen passt ins Schema ---------------------------

    @Test
    void dieReferenzDatenquellenUndIhreZustaendigkeitenPassenUnverfaelschtInsSchema() {
        Map<String, UUID> dq = referenzQuellen();
        Map<String, List<Zeitraum>> perioden = referenzPerioden();
        // Der Zähler vergibt in der Reihenfolge der Referenz genau ihre Kennzeichen.
        assertThat(dq.keySet()).containsExactly("DQ-1", "DQ-2", "DQ-3", "DQ-4", "DQ-5", "DQ-6", "DQ-7");
        alsTue(AHRENBERG, () -> {
            for (JsonNode rq : referenz.get("datenquellen")) {
                String kz = rq.get("kennzeichen").asText();
                Datenquelle q = quellen.finde(dq.get(kz)).orElseThrow();
                assertThat(q.kennzeichen()).isEqualTo(kz);
                assertThat(q.siteId()).as(kz).isEqualTo(ANLAGEN.get(rq.get("anlage").asText()));
                assertThat(q.protokoll()).as(kz)
                        .isEqualTo(rq.get("protokoll").asText());
                assertThat(q.adresse()).as(kz).isEqualTo(adresseAusReferenz(rq));
                assertThat(q.geraeteIds()).as(kz).containsExactlyElementsOf(ganzzahlen(rq.get("geraete_ids")));
                assertThat(q.netz()).as(kz).isEqualTo(text(rq.get("netz")));
                assertThat(q.kadenzS()).as(kz).isEqualTo(rq.get("kadenz_s").asInt());
                assertThat(q.steuerquelle()).as(kz).isEqualTo(rq.get("steuerquelle").asBoolean());
                assertThat(q.mehrereLeser()).as(kz).isFalse();
                assertThat(q.name()).as(kz).isNull();
                assertThat(referenzZeitraeume(dq.get(kz))).as(kz)
                        .containsExactlyElementsOf(perioden.get(kz));
            }
        });
        assertThat(root.queryForObject("SELECT naechste_nummer FROM data_source_kennzeichen_seq "
                + "WHERE tenant_id = ?", Integer.class, AHRENBERG)).isEqualTo(8);

        // Die führende Box je Anlage (E3): die heute führende Box der Referenz.
        for (JsonNode b : referenz.get("boxen")) {
            if (b.get("ausgebaut_am").isNull()) {
                UUID anlage = ANLAGEN.get(b.get("fuehrend_fuer").asText());
                assertThat(root.queryForObject("SELECT lead_device_id FROM site WHERE id = ?",
                        UUID.class, anlage)).isEqualTo(BOXEN.get(b.get("kennzeichen").asText()));
            }
        }
    }

    /**
     * Die Familie {@code zustaendig} gegen die gespeicherten Zeiträume des
     * Referenzunternehmens: welche Box liest zum Messzeitpunkt? Die Datenbank
     * antwortet mit derselben halboffenen Grenze wie der Vertrag — 07:29:59 noch
     * die alte Box, 07:30:00 schon die neue.
     */
    @TestFactory
    Stream<DynamicTest> zustaendigDieHerkunftJeWertAusDenGespeichertenZeitraeumen() {
        Map<String, UUID> dq = referenzQuellen();
        Map<UUID, String> box = umgekehrt(BOXEN);
        return faelle("zustaendig").map(fall -> DynamicTest.dynamicTest(
                fall.get("name").asText(), () -> {
                    JsonNode in = fall.get("input");
                    UUID quelle = dq.get(in.get("quelle").asText());
                    List<Zeitraum> gespeichert = als(AHRENBERG, () -> referenzZeitraeume(quelle));
                    assertThat(gespeichert).containsExactlyElementsOf(zeitraeume(in.get("zeitraeume")));

                    List<String> ausDemVertrag = new ArrayList<>();
                    List<String> ausDerDatenbank = new ArrayList<>();
                    for (JsonNode zp : in.get("zeitpunkte")) {
                        Instant t = instant(zp);
                        ausDemVertrag.add(DatenquelleRegeln.zustaendigeBox(gespeichert, t));
                        List<UUID> lesend = als(AHRENBERG, () -> app.queryForList(
                                "SELECT device_id FROM data_source_assignment WHERE data_source_id = ? "
                                        + "AND tstzrange(effective_from, effective_to, '[)') @> ?::timestamptz",
                                UUID.class, quelle, utc(t)));
                        assertThat(lesend).hasSizeLessThanOrEqualTo(1);
                        ausDerDatenbank.add(lesend.isEmpty() ? null : box.get(lesend.get(0)));
                    }
                    List<String> erwartet = new ArrayList<>();
                    fall.at("/expected/boxen").forEach(b -> erwartet.add(text(b)));
                    assertThat(ausDemVertrag).isEqualTo(erwartet);
                    assertThat(ausDerDatenbank).isEqualTo(erwartet);
                }));
    }

    // ---- der Kennzeichen-Zähler ---------------------------------------------------

    @Test
    void kennzeichenLaufenJeKundenbereichWeiterUndUeberspringenBelegte() {
        // Vektor-Fall bestand-nummern-laufen-im-kundenbereich-weiter: der Zähler steht
        // bei 6, die nächsten zwei Quellen heißen DQ-6 und DQ-7.
        JsonNode fall = fall("bestand-nummern-laufen-im-kundenbereich-weiter");
        Probe lindach = new Probe(MAPPER.createArrayNode());
        root.update("INSERT INTO data_source_kennzeichen_seq (tenant_id, naechste_nummer) "
                + "VALUES (?, ?)", lindach.tenant, fall.at("/input/naechste_nummer").asInt());
        List<String> vergeben = new ArrayList<>();
        List<String> erwartet = new ArrayList<>();
        for (JsonNode v : fall.at("/expected/vorschlaege")) {
            erwartet.add(v.get("kennzeichen").asText());
            vergeben.add(als(lindach.tenant, () -> quellen.anlegen(neueQuelle(lindach.tenant,
                    lindach.site, v.get("adresse").asText()))).kennzeichen());
        }
        assertThat(vergeben).isEqualTo(erwartet).containsExactly("DQ-6", "DQ-7");

        // Je Kundenbereich: ein anderer beginnt bei DQ-1.
        Probe p = new Probe(MAPPER.createArrayNode());
        assertThat(als(p.tenant, () -> quellen.anlegen(neueQuelle(p.tenant, p.site,
                "192.168.10.21:502"))).kennzeichen()).isEqualTo("DQ-1");
        // Eine von Hand belegte Nummer wird übersprungen — nie ein zweites DQ-2.
        root.update("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, adresse, "
                + "kadenz_s) VALUES (?, ?, 'DQ-2', 'modbus_tcp', '192.168.10.30:502', 10)",
                p.tenant, p.site);
        assertThat(als(p.tenant, () -> quellen.anlegen(neueQuelle(p.tenant, p.site,
                "192.168.10.31:502"))).kennzeichen()).isEqualTo("DQ-3");
        // Ein gescheitertes Anlegen verbraucht keine Nummer (dieselbe Transaktion).
        abgelehnt("23514", "data_source_protokoll_chk", () -> als(p.tenant, () -> quellen.anlegen(
                new NeueDatenquelle(p.tenant, p.site, null, "profibus", "192.168.10.32:502",
                        List.of(1), null, false, false, 10, null))));
        assertThat(als(p.tenant, () -> quellen.anlegen(neueQuelle(p.tenant, p.site,
                "192.168.10.33:502"))).kennzeichen()).isEqualTo("DQ-4");
        assertThat(root.queryForObject("SELECT naechste_nummer FROM data_source_kennzeichen_seq "
                + "WHERE tenant_id = ?", Integer.class, p.tenant)).isEqualTo(5);

        // Eindeutig je Kundenbereich; die Form kennt nur Großbuchstaben.
        abgelehnt("23505", "uq_data_source_kennzeichen", () -> root.update("INSERT INTO "
                + "data_source (tenant_id, site_id, kennzeichen, protokoll, adresse, kadenz_s) "
                + "VALUES (?, ?, 'DQ-1', 'modbus_tcp', '192.168.10.40:502', 10)", p.tenant, p.site));
        abgelehnt("23514", "data_source_kennzeichen_chk", () -> root.update("INSERT INTO "
                + "data_source (tenant_id, site_id, kennzeichen, protokoll, adresse, kadenz_s) "
                + "VALUES (?, ?, 'dq-9', 'modbus_tcp', '192.168.10.41:502', 10)", p.tenant, p.site));
    }

    // ---- (c) Unclaim erhält die Geschichte und verlangt beendete Zuständigkeiten ---

    @Test
    void einUnclaimVerlangtBeendeteZustaendigkeitUndBehaeltIhreGeschichte() {
        Probe p = new Probe(boxen("E-1"));
        UUID box = p.boxen.get("E-1");
        Instant ab = Instant.now().minusSeconds(86400).truncatedTo(java.time.temporal.ChronoUnit.MINUTES);
        Instant uebergabe = ab.plusSeconds(3600);
        UUID quelle = als(p.tenant, () -> p.quelle("modbus_tcp", "192.168.10.21:502"));
        UUID zeitraum = als(p.tenant, () -> zustaendigkeiten.eintragen(p.tenant, quelle, box, ab,
                null, null)).orElseThrow();
        UUID komponente = p.komponente(box, quelle);
        // So wird IP-5 die Wahl speichern: die App-Rolle schreibt die Spalte.
        assertThat(als(p.tenant, () -> app.update(
                "UPDATE site SET lead_device_id = ? WHERE id = ?", box, p.site))).isOne();

        // Der Datenbank-Schritt des Unclaim (DeviceController#unclaim): seit AP-07 IP-11 wird die
        // Box ausgebaut statt gelöscht, und die Verweise, die das FK-SET-NULL löste, löst der Weg.
        DeviceRepository boxen = new DeviceRepository(app);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> als(p.tenant, () -> boxen.ausbauen(box)))
                .isInstanceOf(BoxKonflikt.class)
                .hasMessageContaining("409");
        UUID neueBox = p.box("E-1 (neu)");
        abgelehnt("23P01", "data_source_assignment_eine_box_je_zeitpunkt", () -> als(p.tenant, () ->
                zustaendigkeiten.eintragen(p.tenant, quelle, neueBox, uebergabe, null, null)));
        assertThat(als(p.tenant, () -> zustaendigkeiten.beenden(zeitraum, uebergabe))).isTrue();
        assertThat(als(p.tenant, () -> boxen.ausbauen(box))).isTrue();
        alsTue(p.tenant, () -> boxen.ausDerTopologieLoesen(box));

        assertThat(anzahl("SELECT count(*) FROM device WHERE id = ? AND ausgebaut_am IS NOT NULL", box)).isOne();
        // Die Anlage bleibt, nur ihre führende Box ist NULL — tenant_id bleibt stehen.
        assertThat(root.queryForMap("SELECT tenant_id, lead_device_id FROM site WHERE id = ?",
                p.site)).containsEntry("tenant_id", p.tenant).containsEntry("lead_device_id", null);
        // Die Komponente bleibt, ihre Box-Bindung fällt wie heute (SET NULL), ihre Quelle bleibt.
        assertThat(root.queryForMap("SELECT device_id, data_source_id FROM measurement_point "
                + "WHERE id = ?", komponente)).containsEntry("device_id", null)
                .containsEntry("data_source_id", quelle);
        // Die Zuständigkeit überlebt ihre Box: sie sagt weiter, wer gelesen hat.
        assertThat(als(p.tenant, () -> zustaendigkeiten.fuerQuelle(quelle))).singleElement()
                .isEqualTo(new ZustaendigkeitRepository.Zeitraum(zeitraum, quelle, box, ab, uebergabe));

        // Die neue Box (ein Re-Claim ist eine neue Kennung) liest erst, wenn der offene
        // Zeitraum der alten beendet ist — Ende alt = Beginn neu, nie still.
        alsTue(p.tenant, () -> {
            assertThat(zustaendigkeiten.eintragen(p.tenant, quelle, neueBox, uebergabe, null, null))
                    .isPresent();
        });
        // Und die Adresse der Quelle bleibt änderbar, obwohl eine Box ihrer Geschichte fehlt.
        assertThat(als(p.tenant, () -> app.update(
                "UPDATE data_source SET adresse = '192.168.10.22:502' WHERE id = ?", quelle)))
                .isOne();
        assertThat(root.queryForList("SELECT DISTINCT adresse FROM data_source_assignment "
                + "WHERE data_source_id = ?", String.class, quelle))
                .containsExactly("192.168.10.22:502");
    }

    @Test
    void eineAnlageMitFuehrenderBoxBleibtLoeschbar() {
        // site → device kaskadiert, device → site.lead_device_id setzt NULL: der Kreis
        // bricht das Löschen einer Anlage nicht.
        Probe p = new Probe(boxen("E-1"));
        UUID box = p.boxen.get("E-1");
        alsTue(p.tenant, () -> app.update("UPDATE site SET lead_device_id = ? WHERE id = ?",
                box, p.site));
        assertThat(als(p.tenant, () -> app.update("DELETE FROM site WHERE id = ?", p.site))).isOne();
        assertThat(anzahl("SELECT count(*) FROM device WHERE id = ?", box)).isZero();
    }

    // ---- ON DELETE RESTRICT: das Offboarding räumt ausdrücklich ab ----------------

    @Test
    void ohneOffboardingVerweigertDieDatenbankUndDasOffboardingRaeumtAusdruecklichAb() {
        Probe p = new Probe(boxen("E-1"));
        UUID box = p.boxen.get("E-1");
        UUID quelle = als(p.tenant, () -> p.quelle("modbus_tcp", "192.168.10.21:502"));
        alsTue(p.tenant, () -> zustaendigkeiten.eintragen(p.tenant, quelle, box,
                Instant.parse("2026-10-01T06:00:00Z"), null, null).orElseThrow());
        UUID komponente = p.komponente(box, quelle);
        alsTue(p.tenant, () -> app.update("UPDATE site SET lead_device_id = ? WHERE id = ?",
                box, p.site));

        // Nie Kaskade: weder der Mandant noch die Anlage noch die Quelle gehen still.
        abgelehnt("23503", null, () -> root.update("DELETE FROM tenant WHERE id = ?", p.tenant));
        abgelehnt("23503", "data_source_site_fk",
                () -> root.update("DELETE FROM site WHERE id = ?", p.site));
        abgelehnt("23503", null, () -> root.update("DELETE FROM data_source WHERE id = ?", quelle));

        new TenantRepository(admin).offboard(p.tenant);
        assertThat(anzahl("SELECT count(*) FROM tenant WHERE id = ?", p.tenant)).isZero();
        for (String t : TABELLEN) {
            assertThat(anzahl("SELECT count(*) FROM " + t + " WHERE tenant_id = ?", p.tenant))
                    .as(t).isZero();
        }
        assertThat(anzahl("SELECT count(*) FROM measurement_point WHERE id = ?", komponente)).isZero();
        assertThat(anzahl("SELECT count(*) FROM site WHERE id = ?", p.site)).isZero();
    }

    // ---- Rechte: nie löschen, kein Zeitraum umgeschrieben -------------------------

    @Test
    void dieAppRolleLoeschtNieUndSchreibtKeinenZeitraumUm() {
        Probe p = new Probe(boxen("E-1", "E-2"));
        Instant ab = Instant.parse("2026-10-01T06:00:00Z");
        UUID quelle = als(p.tenant, () -> p.quelle("modbus_tcp", "192.168.10.21:502"));
        UUID zeitraum = als(p.tenant, () -> zustaendigkeiten.eintragen(p.tenant, quelle,
                p.boxen.get("E-1"), ab, null, "ines.kaltenbach")).orElseThrow();

        alsTue(p.tenant, () -> {
            for (String t : TABELLEN) {
                abgelehntWegen("42501", "permission denied", () -> app.update("DELETE FROM " + t));
            }
            // Beginn, Box, Quelle und Weg eines Zeitraums bleiben; beenden ja.
            for (String zuweisung : List.of("effective_from = effective_from - interval '1 day'",
                    "device_id = '" + p.boxen.get("E-2") + "'", "data_source_id = gen_random_uuid()",
                    "adresse = '192.168.10.99:502'", "created_by = 'jemand'")) {
                abgelehntWegen("42501", "permission denied", () -> app.update(
                        "UPDATE data_source_assignment SET " + zuweisung + " WHERE id = ?", zeitraum));
            }
            assertThat(zustaendigkeiten.beenden(zeitraum, SPAETER)).isTrue();
            // Ein Ende rückt nie nach hinten, ein beendeter Zeitraum wird nie wieder offen.
            assertThat(zustaendigkeiten.beenden(zeitraum, SPAETER.plusSeconds(3600))).isFalse();
            assertThat(zustaendigkeiten.fuerQuelle(quelle)).singleElement()
                    .satisfies(z -> assertThat(z.effectiveTo()).isEqualTo(SPAETER));
            // Eine Quelle wird archiviert, nicht gelöscht.
            assertThat(app.update("UPDATE data_source SET archiviert_am = now(), "
                    + "archiviert_von = 'ines.kaltenbach' WHERE id = ?", quelle)).isOne();
            assertThat(quellen.finde(quelle)).get()
                    .satisfies(q -> assertThat(q.archiviertAm()).isNotNull());
        });
    }

    @Test
    void dieAdresseFolgtDerQuelleUndDieEindeutigkeitJeBoxGiltWeiter() {
        Probe p = new Probe(boxen("E-1", "E-2"));
        Instant ab = Instant.parse("2026-10-01T06:00:00Z");
        UUID a = als(p.tenant, () -> p.quelle("modbus_tcp", "192.168.10.30:502"));
        UUID b = als(p.tenant, () -> p.quelle("modbus_tcp", "192.168.10.31:502"));
        UUID c = als(p.tenant, () -> p.quelle("modbus_tcp", "192.168.10.30:502"));
        alsTue(p.tenant, () -> {
            p.eintragen(a, new Zeitraum("E-1", ab, null));
            p.eintragen(b, new Zeitraum("E-1", ab, null));
            // A4: dieselbe Adresse an einer ANDEREN Box ist eine andere Quelle.
            p.eintragen(c, new Zeitraum("E-2", ab, null));
        });
        // Wer A auf die Adresse von B stellt, stellt sie in A's Zeitraum an Box E-1 —
        // dort liest B diesen Weg schon: die Kaskade prüft die Eindeutigkeit neu.
        abgelehnt("23P01", "data_source_assignment_ein_weg_je_box", () -> alsTue(p.tenant, () ->
                app.update("UPDATE data_source SET adresse = '192.168.10.31:502' WHERE id = ?", a)));
        // Eine freie Adresse zieht in jeden Zeitraum der Quelle mit.
        assertThat(als(p.tenant, () -> app.update(
                "UPDATE data_source SET adresse = '192.168.10.32:502' WHERE id = ?", a))).isOne();
        assertThat(root.queryForList("SELECT DISTINCT protokoll || ' ' || adresse FROM "
                + "data_source_assignment WHERE data_source_id = ?", String.class, a))
                .containsExactly("modbus_tcp 192.168.10.32:502");
    }

    // ---- die CHECKs -----------------------------------------------------------------

    @Test
    void dieChecksLehnenAbWasNichtImVertragSteht() {
        Probe p = new Probe(boxen("E-1"));
        // Protokoll als Code, nie als Kundenwort; Adresse ohne Randleerzeichen.
        chk("data_source_protokoll_chk", p, "protokoll = 'OCPP 1.6J'");
        chk("data_source_adresse_chk", p, "adresse = ''");
        chk("data_source_adresse_chk", p, "adresse = ' 192.168.10.31:502'");
        chk("data_source_name_chk", p, "name = '   '");
        chk("data_source_name_chk", p, "name = repeat('x', 121)");
        chk("data_source_netz_chk", p, "netz = ' '");
        chk("data_source_kadenz_chk", p, "kadenz_s = 0");
        chk("data_source_kadenz_chk", p, "kadenz_s = 86401");
        chk("data_source_archiv_chk", p, "archiviert_von = 'ines.kaltenbach'");
        // Geräte-IDs: EINE Darstellung — aufsteigend, ohne Wiederholung, ohne leeres
        // Element, eindimensional ab 1, nicht negativ; „keine" ist '{}', nie NULL.
        for (String ids : List.of("'{2,1}'", "'{1,1}'", "'{-1}'", "'{1,NULL}'", "'{{1},{2}}'",
                "'[0:1]={1,2}'")) {
            chk("data_source_geraete_ids_chk", p, "geraete_ids = " + ids + "::integer[]");
        }
        abgelehnt("23502", null, () -> quelleVonHand(p, "geraete_ids = NULL"));
        // Die Ränder, die erlaubt sind.
        for (String ok : List.of("geraete_ids = '{}'", "geraete_ids = '{0,1,2,3}'",
                "kadenz_s = 86400", "kadenz_s = 1", "name = 'WAGO-Steuerung Halle 2'",
                "archiviert_am = now()")) {
            assertThat((Object) ablehnung(() -> quelleVonHand(p, ok))).as(ok).isNull();
        }

        // Zeiträume: auf die volle Minute (auch keine Millisekunde), mindestens eine Minute.
        UUID quelle = als(p.tenant, () -> p.quelle("modbus_tcp", "192.168.10.21:502"));
        UUID box = p.boxen.get("E-1");
        for (String[] fall : new String[][] {
                {"data_source_assignment_volle_minute", "2027-04-10T07:30:30+02:00", null},
                {"data_source_assignment_volle_minute", "2027-04-10T07:30:00.5+02:00", null},
                {"data_source_assignment_volle_minute", "2027-04-10T07:30:00+02:00",
                        "2027-04-12T16:00:01+02:00"},
                {"data_source_assignment_nicht_leer", "2027-04-10T07:30:00+02:00",
                        "2027-04-10T07:30:00+02:00"},
                {"data_source_assignment_nicht_leer", "2027-04-10T07:30:00+02:00",
                        "2027-04-10T07:29:00+02:00"}}) {
            abgelehnt("23514", fall[0], () -> alsTue(p.tenant, () -> zustaendigkeiten.eintragen(
                    p.tenant, quelle, box, OffsetDateTime.parse(fall[1]).toInstant(),
                    fall[2] == null ? null : OffsetDateTime.parse(fall[2]).toInstant(), null)));
        }
        // Eine volle Minute bleibt eine, in welcher Zone sie auch geschrieben ist — die
        // Regel rechnet in UTC (Nepal liegt eine Dreiviertelstunde neben der vollen Stunde).
        alsTue(p.tenant, () -> assertThat(zustaendigkeiten.eintragen(p.tenant, quelle, box,
                OffsetDateTime.parse("2027-04-10T07:30:00+05:45").toInstant(), null, null))
                .isPresent());
    }

    // ---- idempotent -----------------------------------------------------------------

    @Test
    void einErneuterLaufAendertNichts() throws IOException {
        Map<String, Map<String, String>> vorher = new LinkedHashMap<>();
        for (String t : alleBeruehrtenTabellen()) {
            vorher.put(t, schnappschuss(t, "", ""));
        }
        fuehreDieseMigrationErneutAus();
        for (String t : alleBeruehrtenTabellen()) {
            assertThat(schnappschuss(t, "", "")).as(t).isEqualTo(vorher.get(t));
        }
    }

    // ---- Gerüst: das Referenzunternehmen ------------------------------------------

    /** DQ-1 … DQ-7 mit ihren Zeiträumen und den führenden Boxen — einmal angelegt, als Erstes. */
    private static synchronized Map<String, UUID> referenzQuellen() {
        if (referenzQuellen == null) {
            Map<String, UUID> m = new LinkedHashMap<>();
            alsTue(AHRENBERG, () -> {
                for (JsonNode rq : referenz.get("datenquellen")) {
                    Datenquelle q = quellen.anlegen(new NeueDatenquelle(AHRENBERG,
                            ANLAGEN.get(rq.get("anlage").asText()), null,
                            rq.get("protokoll").asText(),
                            adresseAusReferenz(rq), ganzzahlen(rq.get("geraete_ids")),
                            text(rq.get("netz")), false, rq.get("steuerquelle").asBoolean(),
                            rq.get("kadenz_s").asInt(), null));
                    m.put(q.kennzeichen(), q.id());
                }
                for (JsonNode z : referenz.get("zuordnungen")) {
                    if ("datenquelle_box".equals(z.get("art").asText())) {
                        zustaendigkeiten.eintragen(AHRENBERG, m.get(z.get("von").asText()),
                                BOXEN.get(z.get("nach").asText()), instant(z.get("gueltig_ab")),
                                instant(z.get("gueltig_bis")), null).orElseThrow();
                    }
                }
                for (JsonNode b : referenz.get("boxen")) {
                    if (b.get("ausgebaut_am").isNull()) {
                        app.update("UPDATE site SET lead_device_id = ? WHERE id = ?",
                                BOXEN.get(b.get("kennzeichen").asText()),
                                ANLAGEN.get(b.get("fuehrend_fuer").asText()));
                    }
                }
            });
            referenzQuellen = m;
        }
        return referenzQuellen;
    }

    /** Die Zeiträume der Referenzdatei je Quelle, in der Reihenfolge ihres Beginns. */
    private static Map<String, List<Zeitraum>> referenzPerioden() {
        Map<String, List<Zeitraum>> m = new LinkedHashMap<>();
        for (JsonNode z : referenz.get("zuordnungen")) {
            if ("datenquelle_box".equals(z.get("art").asText())) {
                m.computeIfAbsent(z.get("von").asText(), k -> new ArrayList<>()).add(new Zeitraum(
                        z.get("nach").asText(), instant(z.get("gueltig_ab")),
                        instant(z.get("gueltig_bis"))));
            }
        }
        m.values().forEach(l -> l.sort(Comparator.comparing(Zeitraum::von)));
        return m;
    }

    private static List<Zeitraum> referenzZeitraeume(UUID quelle) {
        Map<UUID, String> box = umgekehrt(BOXEN);
        return zustaendigkeiten.fuerQuelle(quelle).stream()
                .map(z -> new Zeitraum(box.get(z.deviceId()), z.effectiveFrom(), z.effectiveTo()))
                .toList();
    }

    /** Wie {@code DatenquelleRegelnVectorsTest}: Host:Port, bei OCPP die Stations-Kennung selbst. */
    private static String adresseAusReferenz(JsonNode q) {
        if ("ocpp".equals(q.get("protokoll").asText())) {
            return q.get("adresse").asText();
        }
        return q.get("adresse").asText() + ":" + q.get("port").asInt();
    }

    // ---- Gerüst: ein eigener Kundenbereich je Fall ----------------------------------

    /**
     * Ein frischer Kundenbereich mit einer Anlage und den Boxen eines Falls — der
     * Kennzeichen-Zähler und die Eindeutigkeit je Box beginnen darin leer. Die
     * Boxen tragen die Kennzeichen des Falls (E-1, E-2′ …).
     */
    private static final class Probe {

        final int nr = PROBE.incrementAndGet();
        final UUID tenant;
        final UUID site;
        final Map<String, UUID> boxen = new LinkedHashMap<>();

        Probe(JsonNode boxenDesFalls) {
            tenant = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id",
                    UUID.class, "Probe " + nr);
            site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, ?) "
                    + "RETURNING id", UUID.class, tenant, "Probe-Anlage " + nr);
            boxenDesFalls.forEach(b -> box(b.get("kennzeichen").asText()));
        }

        UUID box(String kennzeichen) {
            return boxen.computeIfAbsent(kennzeichen, k -> root.queryForObject(
                    "INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                            + "RETURNING id", UUID.class, tenant, site, "probe-" + nr + "-" + k));
        }

        /** Eine Quelle an der Probe-Anlage; unter {@link #als} des Probe-Mandanten aufrufen. */
        UUID quelle(String protokoll, String adresse) {
            return quellen.anlegen(new NeueDatenquelle(tenant, site, null, protokoll, adresse,
                    List.of(1), null, false, false, 60, null)).id();
        }

        void eintragen(UUID quelle, Zeitraum z) {
            zustaendigkeiten.eintragen(tenant, quelle, box(z.box()), z.von(), z.bis(), null)
                    .orElseThrow();
        }

        Zeitraum alsVertrag(ZustaendigkeitRepository.Zeitraum z) {
            return new Zeitraum(umgekehrt(boxen).get(z.deviceId()), z.effectiveFrom(),
                    z.effectiveTo());
        }

        List<Zeitraum> zeitraeume(UUID quelle) {
            return zustaendigkeiten.fuerQuelle(quelle).stream().map(this::alsVertrag).toList();
        }

        /** Eine Komponente wie heute an ihrer Box — und neu an ihrer Quelle. */
        UUID komponente(UUID box, UUID quelle) {
            return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, "
                    + "label, entity_type, capabilities, device_id, data_source_id) VALUES "
                    + "(?, ?, 'pv-generation', 'Dach', 'producer', "
                    + "'{\"measure\":[{\"channel\":\"pv_power_kw\"}]}'::jsonb, ?, ?) RETURNING id",
                    UUID.class, tenant, site, box, quelle);
        }
    }

    private static JsonNode boxen(String... kennzeichen) {
        var arr = MAPPER.createArrayNode();
        for (String k : kennzeichen) {
            arr.addObject().put("kennzeichen", k);
        }
        return arr;
    }

    private static NeueDatenquelle neueQuelle(UUID tenant, UUID site, String adresse) {
        return new NeueDatenquelle(tenant, site, null, "modbus_tcp", adresse, List.of(1), null,
                false, false, 60, null);
    }

    /** Eine Quelle per Superuser mit einer abweichenden Zuweisung — für die CHECKs. */
    private static void quelleVonHand(Probe p, String zuweisung) {
        UUID id = root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, "
                + "protokoll, adresse, kadenz_s) VALUES (?, ?, ?, 'modbus_tcp', ?, 60) RETURNING id",
                UUID.class, p.tenant, p.site, "CHK-" + PROBE.incrementAndGet(),
                "10.0.0." + PROBE.get() + ":502");
        root.update("UPDATE data_source SET " + zuweisung + " WHERE id = ?", id);
    }

    private static void chk(String constraint, Probe p, String zuweisung) {
        abgelehnt("23514", constraint, () -> quelleVonHand(p, zuweisung));
    }

    // ---- Gerüst: Bestand ---------------------------------------------------------

    private static void saeBestand() {
        root.update("INSERT INTO tenant (id, name) VALUES (?, ?)", AHRENBERG,
                referenz.at("/unternehmen/name").asText());
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kundenbereich B')", FREMD);
        for (JsonNode a : referenz.get("anlagen")) {
            ANLAGEN.put(a.get("kennzeichen").asText(), root.queryForObject("INSERT INTO site "
                    + "(tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id", UUID.class,
                    AHRENBERG, a.get("name").asText(), OffsetDateTime.parse(a.get("seit").asText())));
        }
        for (JsonNode b : referenz.get("boxen")) {
            BOXEN.put(b.get("kennzeichen").asText(), root.queryForObject("INSERT INTO device "
                    + "(tenant_id, site_id, external_ref, created_at) VALUES (?, ?, ?, ?) "
                    + "RETURNING id", UUID.class, AHRENBERG,
                    ANLAGEN.get(b.get("heimat_anlage").asText()), b.get("seriennummer").asText(),
                    OffsetDateTime.parse(b.get("in_betrieb_ab").asText())));
        }
        // Eine Bestands-Komponente an Box Halle 1 — so, wie sie heute gebunden ist.
        root.update("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "capabilities, device_id) VALUES (?, ?, 'pv-generation', 'Dach Halle 1', "
                + "'producer', '{\"measure\":[{\"channel\":\"pv_power_kw\"}]}'::jsonb, ?)",
                AHRENBERG, ANLAGEN.get("AN-1"), BOXEN.get("E-1"));
        fremdeAnlage = root.queryForObject("INSERT INTO site (tenant_id, name, latitude, longitude) "
                + "VALUES (?, 'Anlage des fremden Kundenbereichs', 53.55, 9.99) RETURNING id",
                UUID.class, FREMD);
        fremdeBox = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) "
                + "VALUES (?, ?, 'VP-BOX-FREMD-0001') RETURNING id", UUID.class, FREMD, fremdeAnlage);
        fremdeKomponente = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, "
                + "role, label, entity_type, capabilities, device_id) VALUES (?, ?, "
                + "'pv-generation', 'Dach B', 'producer', "
                + "'{\"measure\":[{\"channel\":\"pv_power_kw\"}]}'::jsonb, ?) RETURNING id",
                UUID.class, FREMD, fremdeAnlage, fremdeBox);
    }

    private static List<String> alleBeruehrtenTabellen() {
        List<String> t = new ArrayList<>(TABELLEN);
        t.add("site");
        t.add("measurement_point");
        return t;
    }

    private static long anzahl(String sql, Object... args) {
        return root.queryForObject(sql, Long.class, args);
    }

    // ---- Gerüst: der Schnappschuss einer Tabelle --------------------------------

    /**
     * Alles, was eine Migration an einer Tabelle ändern könnte: Spalten (Name, Typ,
     * Pflicht, Vorgabe, Position), jede Zeile, eigene Constraints, Indexe, Policies,
     * RLS-Schalter, eigene Trigger und Rechte — OHNE die neue Spalte und ihren
     * Fremdschlüssel, die es vorher nicht gab. Nicht darin: die internen
     * Fremdschlüssel-Trigger, die jeder Verweis auf die Tabelle anlegt — sie gehören
     * dem verweisenden Constraint.
     */
    private static Map<String, String> schnappschuss(String tabelle, String neueSpalte,
            String neuerConstraint) {
        Map<String, String> s = new LinkedHashMap<>();
        s.put("spalten", root.queryForObject("SELECT string_agg(format('%s|%s|%s|%s|%s', "
                + "column_name, data_type, is_nullable, column_default, ordinal_position), "
                + "E'\\n' ORDER BY ordinal_position) FROM information_schema.columns "
                + "WHERE table_schema = 'public' AND table_name = ? AND column_name <> ?",
                String.class, tabelle, neueSpalte));
        s.put("zeilen", root.queryForObject("SELECT string_agg(z, E'\\n' ORDER BY z) FROM "
                + "(SELECT (to_jsonb(t) - ?::text)::text AS z FROM " + tabelle + " t) AS zeilen",
                String.class, neueSpalte));
        s.put("constraints", root.queryForObject("SELECT string_agg(conname || ':' || "
                + "pg_get_constraintdef(oid), E'\\n' ORDER BY conname) FROM pg_constraint "
                + "WHERE conrelid = ?::regclass AND conname <> ?", String.class, tabelle,
                neuerConstraint));
        s.put("indexe", root.queryForObject("SELECT string_agg(indexdef, E'\\n' ORDER BY indexname) "
                + "FROM pg_indexes WHERE schemaname = 'public' AND tablename = ?", String.class,
                tabelle));
        s.put("policies", root.queryForObject("SELECT string_agg(policyname || ':' || "
                + "coalesce(qual, '') || ':' || coalesce(with_check, ''), E'\\n' "
                + "ORDER BY policyname) FROM pg_policies WHERE tablename = ?", String.class,
                tabelle));
        s.put("rls", root.queryForObject("SELECT relrowsecurity || '/' || relforcerowsecurity "
                + "FROM pg_class WHERE oid = ?::regclass", String.class, tabelle));
        s.put("trigger", root.queryForObject("SELECT string_agg(tgname, ',' ORDER BY tgname) "
                + "FROM pg_trigger WHERE tgrelid = ?::regclass AND NOT tgisinternal",
                String.class, tabelle));
        s.put("rechte", root.queryForObject("SELECT string_agg(grantee || ':' || privilege_type, "
                + "',' ORDER BY grantee, privilege_type) FROM information_schema.role_table_grants "
                + "WHERE table_schema = 'public' AND table_name = ?", String.class, tabelle));
        s.put("spaltenrechte", root.queryForObject("SELECT string_agg(grantee || ':' || "
                + "column_name || ':' || privilege_type, ',' ORDER BY grantee, column_name, "
                + "privilege_type) FROM information_schema.column_privileges WHERE "
                + "table_schema = 'public' AND table_name = ? AND column_name <> ? AND grantee "
                + "IN (?, ?)", String.class, tabelle, neueSpalte, APP_USER, ADMIN_USER));
        return s;
    }

    /** Typ, Pflicht und Vorgabe einer Spalte. */
    private static String spalte(String tabelle, String spalte) {
        return root.queryForObject("SELECT format('%s|%s|%s', data_type, is_nullable, "
                + "column_default) FROM information_schema.columns WHERE table_schema = 'public' "
                + "AND table_name = ? AND column_name = ?", String.class, tabelle, spalte);
    }

    private static String constraint(String name) {
        return root.queryForObject("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                + "WHERE conname = ?", String.class, name);
    }

    // ---- Gerüst: Vektor-Datei ------------------------------------------------------

    private static Stream<JsonNode> faelle(String familie) {
        return StreamSupport.stream(vektoren.get("cases").spliterator(), false)
                .filter(c -> familie.equals(c.get("familie").asText()));
    }

    private static JsonNode fall(String name) {
        return StreamSupport.stream(vektoren.get("cases").spliterator(), false)
                .filter(c -> name.equals(c.get("name").asText())).findFirst()
                .orElseThrow(() -> new AssertionError(name + " fehlt in der Vektor-Datei"));
    }

    private static Map<String, String> boxNamen(JsonNode in) {
        Map<String, String> m = new LinkedHashMap<>();
        in.get("boxen").forEach(b -> m.put(b.get("kennzeichen").asText(), b.get("name").asText()));
        return m;
    }

    private static Zeitraum zeitraum(JsonNode z) {
        return new Zeitraum(z.get("box").asText(), instant(z.get("effective_from")),
                instant(z.get("effective_to")));
    }

    private static List<Zeitraum> zeitraeume(JsonNode liste) {
        List<Zeitraum> out = new ArrayList<>();
        liste.forEach(z -> out.add(zeitraum(z)));
        return out;
    }

    private static JsonNode element(JsonNode liste, String kennzeichen) {
        for (JsonNode e : liste) {
            if (kennzeichen.equals(e.get("kennzeichen").asText())) {
                return e;
            }
        }
        throw new AssertionError(kennzeichen + " fehlt in der Datei");
    }

    private static List<Integer> ganzzahlen(JsonNode liste) {
        List<Integer> out = new ArrayList<>();
        liste.forEach(n -> out.add(n.asInt()));
        return out;
    }

    private static Instant instant(JsonNode n) {
        String s = text(n);
        return s == null ? null : OffsetDateTime.parse(s).toInstant();
    }

    private static String text(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : n.asText();
    }

    private static OffsetDateTime utc(Instant t) {
        return t.atOffset(ZoneOffset.UTC);
    }

    private static <K, V> Map<V, K> umgekehrt(Map<K, V> m) {
        Map<V, K> out = new LinkedHashMap<>();
        m.forEach((k, v) -> out.put(v, k));
        return out;
    }

    // ---- Gerüst: Zaun und Ablehnungen ----------------------------------------------

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

    /** Der Grund der Vektor-Datei zu einer Ablehnung eines Constraints. */
    private static String grundAus(PSQLException p) {
        String grund = GRUND_DES_CONSTRAINTS.get(p.getServerErrorMessage().getConstraint());
        if (grund == null || !Set.of("23P01", "23514").contains(p.getSQLState())) {
            throw new AssertionError("unerwartete Ablehnung: " + p.getMessage(), p);
        }
        return grund;
    }

    // ---- Gerüst: Flyway ------------------------------------------------------------

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
        try (InputStream in = UemsDatenquelleMigrationTest.class
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
