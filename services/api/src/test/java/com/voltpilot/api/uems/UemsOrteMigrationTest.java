package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.FlaecheRepository.Flaeche;
import com.voltpilot.api.uems.OrtAenderungRepository.NeuerEintrag;
import com.voltpilot.api.uems.OrtRepository.NeuerOrt;
import com.voltpilot.api.uems.OrtRepository.Ort;
import com.voltpilot.api.uems.OrtZuordnungRepository.Zuordnung;
import com.voltpilot.api.uems.OrtsbaumAbleitung.ElternArt;
import com.voltpilot.api.uems.OrtsbaumAbleitung.FlaechenIntervall;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Intervall;
import com.voltpilot.api.uems.OrtsbaumAbleitung.ObjektArt;
import com.voltpilot.api.uems.StandortRepository.NeuerStandort;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.function.Supplier;
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
 * Die Migration {@code V20260911110000} (UEMS AP-02 IP-2b) gegen eine echte
 * TimescaleDB: Gebäude und Bereiche ({@code ort}), ihre zeitgültige Zuordnung
 * zum Elternknoten ({@code ort_zuordnung}) und die zeitgültige Bezugsfläche
 * ({@code flaeche_gueltigkeit}) — ihr Mandantenzaun, ihre Constraints, und dass
 * der Bestand dabei zeichengleich bleibt.
 *
 * <p>Der Prüfnachweis des Konzepts (§8 IP-2b), je Gruppe ein Test:
 * (a) der Zaun steht auf jeder neuen Tabelle (A14), (b) {@code tenant},
 * {@code site} und die vier Tabellen von IP-2a bleiben zeichengleich, ein
 * erneuter Lauf ändert nichts, (c) die Referenz-Orte und -Flächen passen
 * unverfälscht, samt der ganzen Zeitachse des Ortsbaum-Szenarios, (d) die
 * Art-Regel — die Tabelle {@code erlaubte_eltern} und die Fälle
 * {@code ziel_art_unzulaessig} aus {@code docs/contracts/v2/ortsbaum-vectors.json},
 * (e) das Überlappungsverbot — die Fälle der Familie {@code ueberlappung} gegen
 * die Zuordnung UND die Fläche, (f) die CHECKs, (g) Kurzzeichen je
 * Kundenbereich. Dazu das Protokoll ohne Weiten, das Offboarding über
 * ON DELETE RESTRICT und die Rechte der App-Rolle.
 *
 * <p>Beispielquelle ist allein das Referenzunternehmen
 * ({@code uems-referenzunternehmen.json}): Kundenbereich, Anlagen, Standorte,
 * Gebäude, Bereiche und Flächen kommen mit ihren Kennzeichen und Werten aus der
 * Datei, ST-3 und die Zeitachse ab dem Umzug aus den Szenarien der
 * Ortsbaum-Vektoren (das Referenzunternehmen lässt sie aus).
 *
 * <p>Vorbild: {@link UemsStandortMigrationTest} — bis zur Fassung davor
 * migrieren, den Bestand säen, dann diese Fassung laufen lassen.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsOrteMigrationTest {

    /** Diese Fassung. Die davor wird aus dem Klassenpfad bestimmt, nicht hart verdrahtet. */
    private static final String DIESE = "20260911110000";
    private static final String DATEI = "V20260911110000__uems_gebaeude_bereich_flaeche.sql";

    private static final Path REFERENZ =
            Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");
    private static final Path ORTSBAUM =
            Path.of("..", "..", "docs", "contracts", "v2", "ortsbaum-vectors.json");

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final List<String> TABELLEN =
            List.of("ort", "ort_zuordnung", "flaeche_gueltigkeit");
    /** Was vor dieser Fassung schon da war — es bleibt zeichengleich. */
    private static final List<String> BESTAND = List.of(
            "tenant", "site", "unternehmen", "standort", "anlage_standort", "ort_aenderung");

    /** AP-02 E4, die zwölf Kundenwörter der Nutzung. */
    private static final List<String> NUTZUNG_KUNDENWOERTER = List.of("Produktion", "Montage",
            "Lager", "Logistik", "Büro", "Technik", "Außenfläche", "Werkstatt", "Labor", "Verkauf",
            "Sozialräume", "Sonstiges");

    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    /** „Datenstand am 20.02.2027 um 10:10 Uhr" — das Szenario der Ortsbaum-Vektoren. */
    private static final Instant JETZT = Instant.parse("2027-02-20T09:10:00Z");

    private static final UUID AHRENBERG = UUID.fromString("4e000000-0000-0000-0000-000000000011");
    private static final UUID FREMD = UUID.fromString("4e000000-0000-0000-0000-000000000012");

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JsonNode referenz;
    private static JsonNode ortsbaum;

    private static final Map<String, Map<String, String>> BESTAND_VORHER = new LinkedHashMap<>();
    private static final Map<String, Map<String, String>> BESTAND_NACHHER = new LinkedHashMap<>();

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static JdbcTemplate admin;
    private static StandortRepository standorte;
    private static AnlageStandortRepository anlagenZuordnungen;
    private static OrtAenderungRepository aenderungen;
    private static OrtRepository orte;
    private static OrtZuordnungRepository zuordnungen;
    private static FlaecheRepository flaechen;

    /** ST-1/ST-2 aus dem Referenzunternehmen, ST-3 aus dem Ortsbaum-Szenario — vor der Migration gesät. */
    private static final Map<String, UUID> REFERENZ_STANDORTE = new LinkedHashMap<>();
    private static UUID fremderStandort;
    private static LocalDate ersterTag;
    private static Map<String, UUID> referenzOrte;
    private static int probe;

    @BeforeAll
    static void migriereMitBestand() throws IOException {
        referenz = MAPPER.readTree(REFERENZ.toFile());
        ortsbaum = MAPPER.readTree(ORTSBAUM.toFile());
        ersterTag = tagInBerlin(element(referenz.get("standorte"), "ST-1").get("aktiv_seit").asText());
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        standorte = new StandortRepository(app);
        anlagenZuordnungen = new AnlageStandortRepository(app);
        aenderungen = new OrtAenderungRepository(app);
        orte = new OrtRepository(app);
        zuordnungen = new OrtZuordnungRepository(app);
        flaechen = new FlaecheRepository(app);

        flyway().target(letzteFassungVorDieser()).load().migrate();
        saeBestand();
        BESTAND.forEach(t -> BESTAND_VORHER.put(t, schnappschuss(t)));

        flyway().target(DIESE).load().migrate();
        BESTAND.forEach(t -> BESTAND_NACHHER.put(t, schnappschuss(t)));

        // Was nach dieser Fassung noch liegt, läuft auch — die Tests prüfen den Endstand.
        flyway().load().migrate();
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ---- (b) der Bestand bleibt zeichengleich, ein erneuter Lauf ändert nichts

    @Test
    void derBestandBleibtZeichengleich() {
        // Die Schnappschüsse sind nicht leer: der Bestand steht darin.
        assertThat(BESTAND_VORHER.get("site").get("zeilen"))
                .contains(referenz.at("/anlagen/0/name").asText());
        assertThat(BESTAND_VORHER.get("standort").get("zeilen"))
                .contains(element(referenz.get("standorte"), "ST-1").get("name").asText());
        assertThat(BESTAND_VORHER.get("anlage_standort").get("zeilen")).isNotNull();
        assertThat(BESTAND_VORHER.get("ort_aenderung").get("zeilen")).isNotNull();

        for (String t : BESTAND) {
            assertThat(BESTAND_NACHHER.get(t)).as(t).isEqualTo(BESTAND_VORHER.get(t));
        }
    }

    @Test
    void einErneuterLaufAendertNichts() throws IOException {
        referenzOrte();
        Map<String, Map<String, String>> vorher = new LinkedHashMap<>();
        TABELLEN.forEach(t -> vorher.put(t, schnappschuss(t)));
        assertThat(vorher.get("ort").get("zeilen")).isNotNull();

        fuehreDieseMigrationErneutAus();
        for (String t : TABELLEN) {
            assertThat(schnappschuss(t)).as(t).isEqualTo(vorher.get(t));
        }
    }

    // ---- (a) der Mandantenzaun (A14) -----------------------------------------

    @Test
    void a14DerZaunStehtAufJederNeuenTabelle() {
        Map<String, UUID> o = referenzOrte();
        UUID st1 = REFERENZ_STANDORTE.get("ST-1");
        // Der fremde Kundenbereich hat seine eigenen Orte — und seine eigene Zählung (G-1).
        UUID fremdesGebaeude = neuerOrt(FREMD, p -> { p.name = "Halle B"; p.kurzzeichen = "G-1"; });
        UUID fremderBereich = neuerOrt(FREMD, p -> {
            p.art = "bereich";
            p.name = "Halle B Nord";
            p.kurzzeichen = "B-1";
        });
        alsTue(FREMD, () -> {
            zuordnungen.zuordnen(FREMD, fremdesGebaeude, fremderStandort, null, ersterTag, null, null);
            zuordnungen.zuordnen(FREMD, fremderBereich, null, fremdesGebaeude, ersterTag, null, null);
            flaechen.eintragen(FREMD, fremderStandort, null, 2000, ersterTag, null, null);
        });

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

        // Die fremden Orte sind nicht da — die Route macht daraus 404, nie 403.
        alsTue(FREMD, () -> {
            assertThat(orte.finde(o.get("G-1"))).isEmpty();
            assertThat(orte.finde(fremdesGebaeude)).isPresent();
            assertThat(orte.alle()).extracting(Ort::id)
                    .contains(fremdesGebaeude, fremderBereich)
                    .doesNotContainAnyElementsOf(o.values());
            assertThat(zuordnungen.fuerOrt(o.get("B-3"))).isEmpty();
            assertThat(flaechen.fuerOrt(o.get("G-2"))).isEmpty();
            assertThat(flaechen.fuerStandort(st1)).isEmpty();
        });

        // Schreiben über den Zaun: die Policy (WITH CHECK) lehnt ab …
        abgelehntWegen("42501", "row-level security",
                () -> als(FREMD, () -> orte.anlegen(probeOrt(AHRENBERG, p -> { }))));
        // … und die zusammengesetzten Fremdschlüssel, die ohne RLS prüfen, lassen
        // nichts über die Mandantengrenze zu — weder den Ort noch seinen Elternknoten.
        abgelehnt("23503", "ort_zuordnung_eltern_standort_fk", () -> alsTue(FREMD, () ->
                zuordnungen.zuordnen(FREMD, neuerOrt(FREMD, p -> { }), st1, null, ersterTag,
                        null, null)));
        abgelehnt("23503", "ort_zuordnung_eltern_ist_gebaeude_fk", () -> alsTue(FREMD, () ->
                zuordnungen.zuordnen(FREMD, neuerOrt(FREMD, p -> p.art = "bereich"), null,
                        o.get("G-1"), ersterTag, null, null)));
        // G-1 HAT an dem Tag ein Intervall, G-2 eine Fläche: trotzdem spricht der
        // Fremdschlüssel, nicht das Überlappungsverbot — die Ablehnung verrät B nichts über A.
        abgelehnt("23503", "ort_zuordnung_ort_fk", () -> alsTue(FREMD, () ->
                zuordnungen.zuordnen(FREMD, o.get("G-1"), fremderStandort, null, ersterTag, null,
                        null)));
        abgelehnt("23503", "flaeche_gueltigkeit_ort_fk", () -> alsTue(FREMD, () ->
                flaechen.eintragen(FREMD, null, o.get("G-2"), 3100, ersterTag, null, null)));
        abgelehnt("23503", "flaeche_gueltigkeit_standort_fk", () -> alsTue(FREMD, () ->
                flaechen.eintragen(FREMD, st1, null, 8450, ersterTag, null, null)));
    }

    // ---- (c) die Referenz passt unverfälscht ---------------------------------

    /**
     * G-1 … G-5 und B-1 … B-7 mit ihren Feldern, ihrem Elternknoten und ihren
     * Flächen, dazu die Flächen der Standorte — so, wie die Datei sie nennt. Die
     * Notiz eines Bereichs ist in der Referenz seine {@code beschreibung} (§4.1 B:
     * Notiz von Halle 2 Montage = „Montagelinie M1"); ein Gebäude hat dort keine.
     * Die Intervalle sind die {@code ort_eltern}-Zuordnungen der Datei — die Orte der
     * Bestandsanlage AN-1 ab 12.03.2024, alle anderen ab dem ersten Tag ihres
     * Standorts. Denselben Anfang (Tag und Elternknoten) hat das Szenario
     * {@code ahrenberg-bestand} der Ortsbaum-Vektoren; dessen spätere Umzüge nach
     * Werk Ahrenberg Nord lässt die Datei aus.
     */
    @Test
    void dieReferenzOrteUndFlaechenPassenUnverfaelschtInsSchema() {
        Map<String, UUID> o = referenzOrte();
        JsonNode szenario = ortsbaum.at("/szenarien/ahrenberg-bestand/orte");
        List<String> kennzeichen = new ArrayList<>();

        alsTue(AHRENBERG, () -> {
            for (JsonNode g : referenz.get("gebaeude")) {
                String kz = g.get("kennzeichen").asText();
                kennzeichen.add(kz);
                assertThat(orte.finde(o.get(kz))).contains(new Ort(o.get(kz), "gebaeude",
                        g.get("name").asText(), kz, nutzungscodes(g), g.get("baujahr").asInt(),
                        null, "aktiv", null));
                assertThat(alsIntervalle(o.get(kz))).isNotEmpty()
                        .containsExactlyElementsOf(ortIntervalleDerReferenz(kz));
                assertThat(anfang(ortIntervalleDerReferenz(kz)))
                        .isEqualTo(anfang(intervalle(element(szenario, kz).get("intervalle"))));
                assertThat(alsFlaechen(flaechen.fuerOrt(o.get(kz))))
                        .containsExactlyElementsOf(flaechenDerReferenz(g))
                        .containsExactlyElementsOf(flaechenIntervalle(element(szenario, kz)));
            }
            for (JsonNode b : referenz.get("bereiche")) {
                String kz = b.get("kennzeichen").asText();
                kennzeichen.add(kz);
                assertThat(orte.finde(o.get(kz))).contains(new Ort(o.get(kz), "bereich",
                        b.get("name").asText(), kz, nutzungscodes(b), null,
                        b.get("beschreibung").asText(), "aktiv", null));
                assertThat(alsIntervalle(o.get(kz))).isNotEmpty()
                        .containsExactlyElementsOf(ortIntervalleDerReferenz(kz));
                assertThat(anfang(ortIntervalleDerReferenz(kz)))
                        .isEqualTo(anfang(intervalle(element(szenario, kz).get("intervalle"))));
                // Kein Bereich der Referenz hat eine Fläche — also keine Zeile, nie eine 0.
                assertThat(flaechen.fuerOrt(o.get(kz))).isEmpty();
            }
            // Werk Ahrenberg trägt eine eigene Fläche; Werk Lindach keine (AP-02 A4) —
            // also keine Zeile, nie eine 0: Kennzahlen summieren dort die Gebäude.
            assertThat(flaechenDerReferenz(element(referenz.get("standorte"), "ST-1"))).isNotEmpty();
            for (JsonNode s : referenz.get("standorte")) {
                assertThat(alsFlaechen(flaechen.fuerStandort(
                        REFERENZ_STANDORTE.get(s.get("kennzeichen").asText()))))
                        .containsExactlyElementsOf(flaechenDerReferenz(s));
            }
            assertThat(orte.alle()).extracting(Ort::kurzzeichen).containsAll(kennzeichen);
        });
        assertThat(kennzeichen).isNotEmpty().containsExactlyInAnyOrderElementsOf(o.keySet());

        // A3: der Anbau von Halle 2 — die Referenz schreibt „bis = letzter Tag" wie
        // der Vertrag: 3 100 m² bis 31.12.2026, 3 400 m² ab 01.01.2027.
        assertThat(alsFlaechen(als(AHRENBERG, () -> flaechen.fuerOrt(o.get("G-2")))))
                .containsExactlyElementsOf(flaechenIntervalle(
                        element(ortsbaum.at("/szenarien/ahrenberg/orte"), "G-2")));
    }

    /**
     * Die ganze Zeitachse des Szenarios {@code ahrenberg}: Halle 2 zieht am
     * 01.03.2027 nach Werk Ahrenberg Nord (A1), Halle 2 Lager wird am 30.06.2027
     * archiviert und am 01.02.2028 wiederhergestellt (A8, die Lücke bleibt) —
     * als gespeicherte Intervalle. Auf einer eigenen Kopie des Baums, damit die
     * Referenz-Orte der anderen Tests unberührt bleiben.
     */
    @Test
    void dieGanzeZeitachseDesSzenariosPasstInsSchema() {
        JsonNode szenario = ortsbaum.at("/szenarien/ahrenberg/orte");
        Map<String, UUID> kopie = new LinkedHashMap<>();
        for (JsonNode o : szenario) {
            String art = o.get("art").asText();
            if (!"standort".equals(art)) {
                kopie.put(o.get("kennzeichen").asText(), neuerOrt(AHRENBERG, p -> {
                    p.art = art;
                    p.name = o.get("name").asText();
                }));
            }
        }
        alsTue(AHRENBERG, () -> {
            for (Map.Entry<String, UUID> e : kopie.entrySet()) {
                JsonNode o = element(szenario, e.getKey());
                for (Intervall i : intervalle(o.get("intervalle"))) {
                    UUID standort = REFERENZ_STANDORTE.get(i.eltern());
                    zuordnungen.zuordnen(AHRENBERG, e.getValue(), standort,
                            standort == null ? kopie.get(i.eltern()) : null, i.ab(), i.bis(), null);
                }
                for (FlaechenIntervall f : flaechenIntervalle(o)) {
                    flaechen.eintragen(AHRENBERG, null, e.getValue(), f.m2(), f.ab(), f.bis(), null);
                }
            }
        });

        Map<UUID, String> kz = new LinkedHashMap<>();
        REFERENZ_STANDORTE.forEach((k, id) -> kz.put(id, k));
        kopie.forEach((k, id) -> kz.put(id, k));
        for (Map.Entry<String, UUID> e : kopie.entrySet()) {
            JsonNode o = element(szenario, e.getKey());
            assertThat(als(AHRENBERG, () -> zuordnungen.fuerOrt(e.getValue())).stream()
                    .map(z -> new Intervall(z.gueltigAb(), z.gueltigBis(), kz.get(z.eltern())))
                    .toList()).as(e.getKey())
                    .containsExactlyElementsOf(intervalle(o.get("intervalle")));
            assertThat(alsFlaechen(als(AHRENBERG, () -> flaechen.fuerOrt(e.getValue()))))
                    .as(e.getKey()).containsExactlyElementsOf(flaechenIntervalle(o));
        }
        assertThat(kopie).containsKeys("G-2", "B-5");
    }

    // ---- (d) die Art-Regel = der Vertrag -------------------------------------

    /**
     * Die Tabelle {@code erlaubte_eltern} der Vektor-Datei, Zelle für Zelle gegen
     * die Datenbank: ein Gebäude hängt nur an einem Standort, ein Bereich an
     * einem Gebäude oder direkt am Standort, nie an einem Bereich. Der
     * Java-Zwilling ({@link OrtsbaumAbleitung#ERLAUBTE_ELTERN}) sagt dasselbe
     * wie die Datei. Ein Unternehmen als Elternknoten gibt es für einen Ort gar
     * nicht — dafür hat {@code ort_zuordnung} keine Spalte.
     */
    @TestFactory
    Stream<DynamicTest> dieArtRegelDieTabelleErlaubteElternDerVektorDatei() {
        JsonNode tabelle = ortsbaum.get("erlaubte_eltern");
        List<DynamicTest> tests = new ArrayList<>();
        for (String objekt : List.of("gebaeude", "bereich")) {
            for (String eltern : List.of("standort", "gebaeude", "bereich")) {
                boolean erlaubt = StreamSupport.stream(tabelle.get(objekt).spliterator(), false)
                        .anyMatch(n -> eltern.equals(n.asText()));
                assertThat(OrtsbaumAbleitung.ERLAUBTE_ELTERN.get(ObjektArt.valueOf(gross(objekt)))
                        .contains(ElternArt.valueOf(gross(eltern)))).isEqualTo(erlaubt);
                tests.add(DynamicTest.dynamicTest(objekt + " an " + eltern, () -> {
                    UUID kind = neuerOrt(AHRENBERG, p -> p.art = objekt);
                    Eltern e = switch (eltern) {
                        case "standort" -> new Eltern(REFERENZ_STANDORTE.get("ST-1"), null);
                        case "gebaeude" -> new Eltern(null, referenzOrte().get("G-1"));
                        default -> new Eltern(null, referenzOrte().get("B-1"));
                    };
                    PSQLException p = als(AHRENBERG, () -> ablehnung(() -> zuordnungen.zuordnen(
                            AHRENBERG, kind, e.standort(), e.gebaeude(), ersterTag, null, null)));
                    assertThat(p == null ? null : grundAus(p))
                            .isEqualTo(erlaubt ? null : "ziel_art_unzulaessig");
                }));
            }
        }
        return tests.stream();
    }

    /**
     * Die Eintrags-Fälle der Vektor-Datei mit dem Grund {@code ziel_art_unzulaessig}
     * ({@code bereich-nicht-in-einen-bereich}, {@code gebaeude-nur-an-einen-standort}),
     * so, wie der Schreibweg sie schreiben würde: erst das laufende Intervall am
     * Vortag beenden, dann das neue am unzulässigen Ziel — die Art-Regel spricht,
     * nicht das Überlappungsverbot. Alle anderen abgelehnten Eintrags-Fälle sind
     * Regeln des Schreibwegs, keine der Datenbank (Kopf der Migration).
     */
    @TestFactory
    Stream<DynamicTest> dieArtRegelDieEintragsFaelleMitUnzulaessigemZiel() {
        return faelle("ueberlappung", "eintrag")
                .filter(fall -> referenzOrte().containsKey(fall.at("/input/objekt").asText()))
                .filter(fall -> "ziel_art_unzulaessig".equals(text(fall.at("/expected/grund"))))
                .map(fall -> DynamicTest.dynamicTest(fall.get("name").asText(), () -> {
                    JsonNode input = fall.get("input");
                    JsonNode imSzenario = ortImSzenario(input);
                    LocalDate ab = LocalDate.parse(input.get("ab").asText());
                    UUID ort = neuerOrt(AHRENBERG, p -> {
                        p.art = imSzenario.get("art").asText();
                        p.name = imSzenario.get("name").asText();
                    });
                    String grund = als(AHRENBERG, () -> {
                        UUID laufend = intervalle(imSzenario.get("intervalle")).stream()
                                .map(i -> eintragen(ort, i)).reduce((a, b) -> b).orElseThrow();
                        assertThat(zuordnungen.beenden(laufend, ab.minusDays(1))).isTrue();
                        PSQLException p = ablehnung(() -> zuordnungen.zuordnen(AHRENBERG, ort,
                                null, referenzOrte().get(input.get("eltern").asText()), ab, null,
                                null));
                        return p == null ? null : grundAus(p);
                    });
                    assertThat(grund).isEqualTo("ziel_art_unzulaessig");
                }));
    }

    // ---- (e) das Überlappungsverbot = der Vertrag ----------------------------

    /**
     * Die Listen-Fälle: Intervalle EINES Orts, der Reihe nach eingetragen. Die
     * Datenbank muss dasselbe Urteil sprechen wie die Vektor-Datei (und
     * {@link OrtsbaumAbleitung#pruefeIntervalle}). Das Urteil hängt nicht an den
     * Eltern — {@code pruefeIntervalle} liest sie nicht —, aber eine Zeile braucht
     * einen gültigen: der Ort ist ein Bereich, ST-x wird der Standort, G-x das
     * Gebäude dieses Kennzeichens; ein Bereich als Eltern bekommt ST-1 als
     * Stellvertreter.
     */
    @TestFactory
    Stream<DynamicTest> ueberlappungDieListenFaelleGegenDieOrtZuordnung() {
        return faelle("ueberlappung", "liste").map(fall -> DynamicTest.dynamicTest(
                fall.get("name").asText(), () -> {
                    List<Intervall> intervalle = intervalle(fall.at("/input/intervalle"));
                    String erwartet = urteilDerVektorDatei(fall, intervalle);
                    UUID ort = neuerOrt(AHRENBERG, p -> {
                        p.art = "bereich";
                        p.name = "Überlappung · " + fall.get("name").asText();
                    });
                    assertThat(erstesUrteil(intervalle, i -> eintragen(ort, i))).isEqualTo(erwartet);
                }));
    }

    /**
     * Dieselben Listen-Fälle gegen die FLÄCHE (E3: je Objekt eine Fläche je Tag,
     * dieselbe Mechanik) — einmal an einem Standort, einmal an einem Gebäude, je
     * einer der zwei Exklusions-Constraints. Die Fälle tragen keine Fläche; das
     * Urteil hängt nicht an ihr — eingetragen wird die erste Fläche von Halle 2.
     */
    @TestFactory
    Stream<DynamicTest> ueberlappungDieListenFaelleGegenDieFlaeche() {
        int m2 = element(referenz.get("gebaeude"), "G-2").at("/bezugsflaechen/0/flaeche_m2").asInt();
        return faelle("ueberlappung", "liste").flatMap(fall -> {
            List<Intervall> intervalle = intervalle(fall.at("/input/intervalle"));
            String name = fall.get("name").asText();
            return Stream.of(
                    DynamicTest.dynamicTest(name + " · am Standort", () -> {
                        String erwartet = urteilDerVektorDatei(fall, intervalle);
                        UUID standort = probeStandort();
                        assertThat(erstesUrteil(intervalle,
                                i -> flaecheEintragen(standort, null, i, m2))).isEqualTo(erwartet);
                    }),
                    DynamicTest.dynamicTest(name + " · am Gebäude", () -> {
                        String erwartet = urteilDerVektorDatei(fall, intervalle);
                        UUID ort = neuerOrt(AHRENBERG, p -> { });
                        assertThat(erstesUrteil(intervalle,
                                i -> flaecheEintragen(null, ort, i, m2))).isEqualTo(erwartet);
                    }));
        });
    }

    /**
     * Die Eintrags-Fälle eines GEBÄUDES oder BEREICHS, die erlaubt sind — A1 als
     * Plan, rückwirkend ab dem ersten Tag des Ziels, ein Bereich direkt an den
     * Standort, die Korrektur ab Beginn: vom Stand des Szenarios zum erwarteten
     * Stand so, wie der Schreibweg es tun wird — erst beenden/aufheben, dann
     * eintragen. Die Datenbank nimmt die anschließenden Intervalle (bis = Vortag,
     * ab = Tag) an, und was sie danach hält, ist genau die Intervall-Liste der
     * Vektor-Datei.
     */
    @TestFactory
    Stream<DynamicTest> ueberlappungDieErlaubtenEintragsFaelleEinesOrts() {
        return faelle("ueberlappung", "eintrag")
                .filter(fall -> referenzOrte().containsKey(fall.at("/input/objekt").asText()))
                .filter(fall -> fall.at("/expected/erlaubt").asBoolean())
                .map(fall -> DynamicTest.dynamicTest(fall.get("name").asText(), () -> {
                    JsonNode imSzenario = ortImSzenario(fall.get("input"));
                    List<Intervall> vorher = intervalle(imSzenario.get("intervalle"));
                    List<Intervall> nachher = intervalle(fall.at("/expected/intervalle"));
                    UUID ort = neuerOrt(AHRENBERG, p -> {
                        p.art = imSzenario.get("art").asText();
                        p.name = imSzenario.get("name").asText();
                    });

                    alsTue(AHRENBERG, () -> {
                        vorher.forEach(i -> eintragen(ort, i));
                        List<Zuordnung> ist = zuordnungen.fuerOrt(ort);
                        Set<UUID> getroffen = new HashSet<>();
                        List<Intervall> neu = new ArrayList<>();
                        for (Intervall soll : nachher) {
                            Optional<Zuordnung> zeile = ist.stream()
                                    .filter(z -> !getroffen.contains(z.id()) && !z.aufgehoben())
                                    .filter(z -> z.gueltigAb().equals(soll.ab()))
                                    .filter(z -> z.eltern().equals(elternFuer(soll.eltern()).id()))
                                    .findFirst();
                            if (zeile.isEmpty()) {
                                neu.add(soll);
                                continue;
                            }
                            getroffen.add(zeile.get().id());
                            if (soll.aufgehoben()) {
                                assertThat(zuordnungen.aufheben(zeile.get().id(), JETZT)).isTrue();
                            } else if (!Objects.equals(zeile.get().gueltigBis(), soll.bis())) {
                                assertThat(zuordnungen.beenden(zeile.get().id(), soll.bis())).isTrue();
                            }
                        }
                        neu.forEach(i -> eintragen(ort, i));
                    });

                    assertThat(alsIntervalle(ort)).containsExactlyElementsOf(nachher);
                }));
    }

    @Test
    void einNeuesGueltigAbOhneDasLaufendeZuBeendenLehntDieDatenbankAb() {
        // A1 in der falschen Reihenfolge: erst eintragen, dann beenden — der
        // Constraint lässt den Tag, der zweimal belegt wäre, nicht zu.
        JsonNode halle2 = element(referenz.get("gebaeude"), "G-2");
        UUID ort = neuerOrt(AHRENBERG, p -> p.name = halle2.get("name").asText());
        LocalDate umzug = intervalle(element(ortsbaum.at("/szenarien/ahrenberg/orte"), "G-2")
                .get("intervalle")).get(1).ab();
        UUID laufend = als(AHRENBERG, () -> zuordnungen.zuordnen(AHRENBERG, ort,
                REFERENZ_STANDORTE.get("ST-1"), null, ersterTag, null, null));
        abgelehnt("23P01", "ort_zuordnung_keine_ueberlappung", () -> alsTue(AHRENBERG, () ->
                zuordnungen.zuordnen(AHRENBERG, ort, REFERENZ_STANDORTE.get("ST-3"), null, umzug,
                        null, null)));
        // Das Beenden auf einen Tag VOR dem Beginn ist kein Intervall.
        abgelehnt("23514", "ort_zuordnung_bis_nicht_vor_ab", () -> alsTue(AHRENBERG, () ->
                zuordnungen.beenden(laufend, ersterTag.minusDays(1))));

        // A3 in der falschen Reihenfolge: 3 400 m² ab dem Anbau, ohne die 3 100 m²
        // am Vortag zu beenden — zwei Flächen an einem Tag gibt es nicht.
        List<FlaechenIntervall> a3 = flaechenDerReferenz(halle2);
        UUID erste = als(AHRENBERG, () -> flaechen.eintragen(AHRENBERG, null, ort, a3.get(0).m2(),
                a3.get(0).ab(), null, null));
        abgelehnt("23P01", "flaeche_ort_keine_ueberlappung", () -> alsTue(AHRENBERG, () ->
                flaechen.eintragen(AHRENBERG, null, ort, a3.get(1).m2(), a3.get(1).ab(), null, null)));
        // Richtig herum geht es — und die Datenbank hält genau die Referenz.
        alsTue(AHRENBERG, () -> {
            assertThat(flaechen.beenden(erste, a3.get(0).bis())).isTrue();
            flaechen.eintragen(AHRENBERG, null, ort, a3.get(1).m2(), a3.get(1).ab(), null, null);
        });
        assertThat(alsFlaechen(als(AHRENBERG, () -> flaechen.fuerOrt(ort))))
                .containsExactlyElementsOf(a3);
    }

    // ---- (f) die CHECKs ------------------------------------------------------

    @Test
    void dieChecksLehnenAbWasNichtImVokabularSteht() {
        // Art: nur Gebäude und Bereich — der Standort hat seine eigene Tabelle.
        ortChk("ort_art_chk", p -> p.art = "standort");
        ortChk("ort_art_chk", p -> p.art = "Gebäude");
        ortChk("ort_art_chk", p -> p.art = "raum");
        neuerOrt(AHRENBERG, p -> p.art = "bereich");
        // Name: 1–120 Zeichen, nie nur Leerzeichen, nie fehlend.
        ortChk("ort_name_chk", p -> p.name = "");
        ortChk("ort_name_chk", p -> p.name = "   ");
        ortChk("ort_name_chk", p -> p.name = "H".repeat(121));
        neuerOrt(AHRENBERG, p -> p.name = "H".repeat(120));
        abgelehnt("23502", null, () -> neuerOrt(AHRENBERG, p -> p.name = null));
        // Kurzzeichen: ohne Randleerzeichen, höchstens 24.
        ortChk("ort_kurzzeichen_chk", p -> p.kurzzeichen = " G-9");
        ortChk("ort_kurzzeichen_chk", p -> p.kurzzeichen = "K".repeat(25));
        // Nutzung: dasselbe geschlossene Vokabular wie am Standort (uems_nutzung_gueltig).
        ortChk("ort_nutzung_chk", p -> p.nutzung = List.of("Büro"));
        ortChk("ort_nutzung_chk", p -> p.nutzung = List.of("hotel"));
        ortChk("ort_nutzung_chk", p -> p.nutzung = List.of("lager", "montage", "lager"));
        ortChk("ort_nutzung_chk", p -> p.nutzung = List.of());
        neuerOrt(AHRENBERG, p -> p.nutzung = NUTZUNG_KUNDENWOERTER.stream()
                .map(UemsOrteMigrationTest::code).toList());
        neuerOrt(AHRENBERG, p -> {
            p.art = "bereich";
            p.nutzung = List.of(code("Technik"), code("Außenfläche"));
        });
        // Baujahr: vierstellig ab 1800 (§4.1), und nur am Gebäude.
        ortChk("ort_baujahr_chk", p -> p.baujahr = 1799);
        ortChk("ort_baujahr_chk", p -> p.baujahr = 10000);
        neuerOrt(AHRENBERG, p -> p.baujahr = 1800);
        int baujahrHalle2 = element(referenz.get("gebaeude"), "G-2").get("baujahr").asInt();
        ortChk("ort_baujahr_nur_am_gebaeude", p -> {
            p.art = "bereich";
            p.baujahr = baujahrHalle2;
        });
        // Notiz ≤ 500, nie leer (keine Angabe ist NULL).
        ortChk("ort_notiz_chk", p -> p.notiz = "");
        ortChk("ort_notiz_chk", p -> p.notiz = "n".repeat(501));
        neuerOrt(AHRENBERG, p -> p.notiz = "n".repeat(500));
        // Zustand: kein „angehalten" am Ort; „archiviert" nie ohne Zeitpunkt.
        ortChk("ort_zustand_chk", p -> p.zustand = "angehalten");
        ortChk("ort_zustand_chk", p -> p.zustand = "gueltig");
        ortChk("ort_archiv_chk", p -> p.zustand = "archiviert");
        for (String zustand : List.of("entwurf", "eingerichtet", "aktiv")) {
            neuerOrt(AHRENBERG, p -> p.zustand = zustand);
        }
        UUID ort = neuerOrt(AHRENBERG, p -> { });
        abgelehnt("23514", "ort_archiv_chk", () -> alsTue(AHRENBERG, () -> app.update(
                "UPDATE ort SET archiviert_von = 'ines.kaltenbach' WHERE id = ?", ort)));
    }

    @Test
    void jedeZuordnungHatGenauEinenElternknotenUndJedeFlaecheGenauEinObjekt() {
        UUID st1 = REFERENZ_STANDORTE.get("ST-1");
        UUID g1 = referenzOrte().get("G-1");
        UUID bereich = neuerOrt(AHRENBERG, p -> p.art = "bereich");
        abgelehnt("23514", "ort_zuordnung_genau_ein_eltern", () -> alsTue(AHRENBERG, () ->
                zuordnungen.zuordnen(AHRENBERG, bereich, st1, g1, ersterTag, null, null)));
        abgelehnt("23514", "ort_zuordnung_genau_ein_eltern", () -> alsTue(AHRENBERG, () ->
                zuordnungen.zuordnen(AHRENBERG, bereich, null, null, ersterTag, null, null)));

        int m2 = element(referenz.get("gebaeude"), "G-2").at("/bezugsflaechen/0/flaeche_m2").asInt();
        abgelehnt("23514", "flaeche_gueltigkeit_genau_ein_objekt", () -> alsTue(AHRENBERG, () ->
                flaechen.eintragen(AHRENBERG, st1, bereich, m2, ersterTag, null, null)));
        abgelehnt("23514", "flaeche_gueltigkeit_genau_ein_objekt", () -> alsTue(AHRENBERG, () ->
                flaechen.eintragen(AHRENBERG, null, null, m2, ersterTag, null, null)));
        // Ganze m² größer als 0 — „nicht erhoben" ist keine Zeile, nie eine 0, nie NULL.
        abgelehnt("23514", "flaeche_gueltigkeit_m2_chk", () -> alsTue(AHRENBERG, () ->
                flaechen.eintragen(AHRENBERG, null, bereich, 0, ersterTag, null, null)));
        abgelehnt("23514", "flaeche_gueltigkeit_m2_chk", () -> alsTue(AHRENBERG, () ->
                flaechen.eintragen(AHRENBERG, null, bereich, -m2, ersterTag, null, null)));
        abgelehnt("23502", null, () -> alsTue(AHRENBERG, () -> app.update("INSERT INTO "
                + "flaeche_gueltigkeit (tenant_id, ort_id, m2, gueltig_ab) VALUES (?, ?, NULL, ?)",
                AHRENBERG, bereich, ersterTag)));
        // Auch ein Bereich trägt eine Fläche (E3: je Standort, Gebäude, Bereich).
        alsTue(AHRENBERG, () -> flaechen.eintragen(AHRENBERG, null, bereich, m2, ersterTag, null,
                null));
    }

    // ---- (g) Kurzzeichen und Namen -------------------------------------------

    @Test
    void kurzzeichenSindEindeutigJeKundenbereichUndWerdenNieFrei() {
        UUID kz1 = neuerOrt(AHRENBERG, p -> { p.kurzzeichen = "KZ-1"; p.name = "Halle Kurz"; });
        // Dieselbe Kennung im selben Kundenbereich — über Gebäude UND Bereiche, in jeder Schreibweise.
        eindeutig(AHRENBERG, p -> { p.art = "bereich"; p.kurzzeichen = "KZ-1"; });
        eindeutig(AHRENBERG, p -> p.kurzzeichen = "kz-1");
        // Ein anderer Kundenbereich hat seine eigene Zählung.
        neuerOrt(FREMD, p -> p.kurzzeichen = "KZ-1");
        // Ein archivierter Ort behält sein Kurzzeichen — es wird nie wiederverwendet (E8).
        archiviere(kz1);
        eindeutig(AHRENBERG, p -> p.kurzzeichen = "KZ-1");

        // Der Name: „Halle 1" darf an zwei Standorten vorkommen (§4.1). Die Eindeutigkeit
        // unter nicht archivierten GESCHWISTERN ist eine Aussage über einen Tag (der
        // Elternknoten ist zeitgültig) — sie prüft der Schreibweg (IP-5), kein Index.
        String halle1 = element(referenz.get("gebaeude"), "G-1").get("name").asText();
        UUID zweite = neuerOrt(AHRENBERG, p -> p.name = halle1);
        alsTue(AHRENBERG, () -> zuordnungen.zuordnen(AHRENBERG, zweite,
                REFERENZ_STANDORTE.get("ST-2"), null, ersterTagVon("ST-2"), null, null));
    }

    // ---- das Protokoll braucht kein Weiten -----------------------------------

    @Test
    void dasProtokollKenntGebaeudeBereichUndFlaecheOhneWeiten() {
        Map<String, UUID> o = referenzOrte();
        List<FlaechenIntervall> a3 = flaechenDerReferenz(element(referenz.get("gebaeude"), "G-2"));
        LocalDate archivtag = intervalle(element(ortsbaum.at("/szenarien/ahrenberg/orte"), "B-5")
                .get("intervalle")).get(0).bis().plusDays(1);
        alsTue(AHRENBERG, () -> {
            // A3: der Anbau von Halle 2, eingetragen im Januar mit „gilt ab" 01.01.2027.
            aenderungen.eintragen(new NeuerEintrag(AHRENBERG, "gebaeude", o.get("G-2"),
                    "flaeche_geaendert", "{\"m2\": " + a3.get(0).m2() + "}",
                    "{\"m2\": " + a3.get(1).m2() + "}", a3.get(1).ab(), true, "ines.kaltenbach",
                    "Ines Kaltenbach"));
            // A8: Halle 2 Lager wird archiviert.
            aenderungen.eintragen(new NeuerEintrag(AHRENBERG, "bereich", o.get("B-5"),
                    "archiviert", null, null, archivtag, false, "ines.kaltenbach",
                    "Ines Kaltenbach"));
            assertThat(aenderungen.fuerObjekt("gebaeude", o.get("G-2"))).singleElement()
                    .satisfies(e -> assertThat(e.art()).isEqualTo("flaeche_geaendert"));
            assertThat(aenderungen.fuerObjekt("bereich", o.get("B-5"))).singleElement()
                    .satisfies(e -> assertThat(e.giltAb()).isEqualTo(archivtag));
        });
    }

    // ---- ON DELETE RESTRICT: das Offboarding räumt ausdrücklich ab ------------

    @Test
    void ohneOffboardingVerweigertDieDatenbankUndDasOffboardingRaeumtAusdruecklichAb() {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES ('Offboarding-Probe') "
                + "RETURNING id", UUID.class);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name) "
                + "VALUES (?, 'Offboarding-Probe') RETURNING id", UUID.class, t);
        UUID s = als(t, () -> standorte.anlegen(new NeuerStandort(t, u, "Werk Probe", "ST-1",
                null, null, null, null, "Europe/Berlin", null, null, null, null, "entwurf", null)));
        UUID g = neuerOrt(t, p -> p.kurzzeichen = "G-1");
        UUID b = neuerOrt(t, p -> { p.art = "bereich"; p.kurzzeichen = "B-1"; });
        alsTue(t, () -> {
            zuordnungen.zuordnen(t, g, s, null, ersterTag, null, null);
            zuordnungen.zuordnen(t, b, null, g, ersterTag, null, null);
            flaechen.eintragen(t, s, null, 8450, ersterTag, null, null);
            flaechen.eintragen(t, null, g, 3100, ersterTag, null, null);
            aenderungen.eintragen(new NeuerEintrag(t, "gebaeude", g, "angelegt", null,
                    "{\"name\": \"Probe\"}", ersterTag, false, null, "Jonas Wendlinger"));
        });

        // Nie Kaskade: weder der Mandant noch ein Standort oder Gebäude mit Kindern gehen still.
        abgelehnt("23503", null, () -> root.update("DELETE FROM tenant WHERE id = ?", t));
        abgelehnt("23503", null, () -> root.update("DELETE FROM standort WHERE id = ?", s));
        abgelehnt("23503", null, () -> root.update("DELETE FROM ort WHERE id = ?", g));
        // Während der Laufzeit bleibt das Protokoll append-only — auch für Verwaltungsrolle und Eigentümer.
        abgelehntWegen("P0001", "append-only",
                () -> admin.update("DELETE FROM ort_aenderung WHERE tenant_id = ?", t));
        abgelehntWegen("P0001", "append-only",
                () -> root.update("DELETE FROM ort_aenderung WHERE tenant_id = ?", t));
        abgelehntWegen("P0001", "append-only",
                () -> root.update("UPDATE ort_aenderung SET tenant_id = tenant_id WHERE tenant_id = ?", t));

        // Das Offboarding ist der eine Weg, auf dem all das endet.
        new TenantRepository(admin).offboard(t);
        assertThat(anzahl("SELECT count(*) FROM tenant WHERE id = ?", t)).isZero();
        for (String tabelle : List.of("flaeche_gueltigkeit", "ort_zuordnung", "ort",
                "anlage_standort", "standort", "unternehmen")) {
            assertThat(anzahl("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?", t))
                    .as(tabelle).isZero();
        }
        // Das Protokoll geht nach der Mandantenzeile mit (AP-20 E10 = A, V20260925234500): ohne Fremdschlüssel,
        // aber nicht mehr übrig.
        assertThat(anzahl("SELECT count(*) FROM ort_aenderung WHERE tenant_id = ?", t)).isZero();
    }

    // ---- Rechte: nie löschen, weder Art noch Intervall noch Fläche umschreiben

    @Test
    void dieAppRolleLoeschtNieUndSchreibtWederArtNochIntervallNochFlaecheUm() {
        UUID st1 = REFERENZ_STANDORTE.get("ST-1");
        UUID gebaeude = neuerOrt(AHRENBERG, p -> { });
        UUID bereich = neuerOrt(AHRENBERG, p -> p.art = "bereich");
        JsonNode halle2 = element(referenz.get("gebaeude"), "G-2");
        List<FlaechenIntervall> a3 = flaechenDerReferenz(halle2);
        UUID z = als(AHRENBERG, () -> zuordnungen.zuordnen(AHRENBERG, gebaeude, st1, null,
                ersterTag, null, "ines.kaltenbach"));
        als(AHRENBERG, () -> zuordnungen.zuordnen(AHRENBERG, bereich, null, gebaeude, ersterTag,
                null, "ines.kaltenbach"));
        UUID f = als(AHRENBERG, () -> flaechen.eintragen(AHRENBERG, null, gebaeude,
                a3.get(0).m2(), a3.get(0).ab(), null, "ines.kaltenbach"));

        alsTue(AHRENBERG, () -> {
            for (String t : TABELLEN) {
                abgelehntWegen("42501", "permission denied", () -> app.update("DELETE FROM " + t));
            }
            // Die Art, der Mandant und die Herkunft eines Orts bleiben; Stammdaten und Archiv ja.
            abgelehntWegen("42501", "permission denied", () -> app.update(
                    "UPDATE ort SET art = 'bereich' WHERE id = ?", gebaeude));
            abgelehntWegen("42501", "permission denied", () -> app.update(
                    "UPDATE ort SET created_by = 'jemand' WHERE id = ?", gebaeude));
            assertThat(app.update("UPDATE ort SET name = ?, baujahr = ? WHERE id = ?",
                    halle2.get("name").asText(), halle2.get("baujahr").asInt(), gebaeude)).isOne();
            // Beginn, Ort und Elternknoten eines Intervalls bleiben; beenden und aufheben ja.
            abgelehntWegen("42501", "permission denied", () -> app.update(
                    "UPDATE ort_zuordnung SET gueltig_ab = gueltig_ab - 1 WHERE id = ?", z));
            abgelehntWegen("42501", "permission denied", () -> app.update(
                    "UPDATE ort_zuordnung SET eltern_standort_id = ? WHERE id = ?",
                    REFERENZ_STANDORTE.get("ST-2"), z));
            // Eine andere Zahl ist ein neues Intervall — m² wird nie umgeschrieben (E3).
            abgelehntWegen("42501", "permission denied", () -> app.update(
                    "UPDATE flaeche_gueltigkeit SET m2 = ? WHERE id = ?", a3.get(1).m2(), f));
            abgelehntWegen("42501", "permission denied", () -> app.update(
                    "UPDATE flaeche_gueltigkeit SET gueltig_ab = gueltig_ab + 1 WHERE id = ?", f));
            assertThat(flaechen.beenden(f, a3.get(0).bis())).isTrue();
            assertThat(flaechen.aufheben(f, JETZT)).isTrue();
            assertThat(flaechen.fuerOrt(gebaeude)).singleElement()
                    .satisfies(r -> assertThat(r.aufgehoben()).isTrue());
            LocalDate vorDemUmzug = intervalle(element(ortsbaum.at("/szenarien/ahrenberg/orte"),
                    "G-2").get("intervalle")).get(0).bis();
            assertThat(zuordnungen.beenden(z, vorDemUmzug)).isTrue();
            assertThat(zuordnungen.aufheben(z, JETZT)).isTrue();
        });

        // Auch der Eigentümer macht aus einem Elternknoten keinen Bereich und aus
        // einem Kind unter einem Gebäude kein Gebäude: die Fremdschlüssel halten die
        // Art fest (das Baujahr geht mit, sonst spräche zuerst dessen CHECK).
        abgelehnt("23503", "ort_zuordnung_eltern_ist_gebaeude_fk", () -> root.update(
                "UPDATE ort SET art = 'bereich', baujahr = NULL WHERE id = ?", gebaeude));
        abgelehnt("23503", "ort_zuordnung_unter_gebaeude_nur_bereich_fk", () -> root.update(
                "UPDATE ort SET art = 'gebaeude' WHERE id = ?", bereich));
    }

    // ---- Gerüst: die Referenz-Orte -------------------------------------------

    /**
     * G-1 … G-5 und B-1 … B-7 aus dem Referenzunternehmen, jeder am ersten Tag
     * seines Standorts an seinen Elternknoten gehängt, dazu alle Flächen der
     * Referenz (Standorte und Gebäude) — einmal angelegt.
     */
    private static synchronized Map<String, UUID> referenzOrte() {
        if (referenzOrte == null) {
            Map<String, UUID> m = new LinkedHashMap<>();
            alsTue(AHRENBERG, () -> {
                for (JsonNode g : referenz.get("gebaeude")) {
                    String kz = g.get("kennzeichen").asText();
                    UUID id = orte.anlegen(new NeuerOrt(AHRENBERG, "gebaeude",
                            g.get("name").asText(), kz, nutzungscodes(g),
                            g.get("baujahr").asInt(), null, "aktiv", null));
                    for (Intervall i : ortIntervalleDerReferenz(kz)) {
                        zuordnungen.zuordnen(AHRENBERG, id, REFERENZ_STANDORTE.get(i.eltern()), null,
                                i.ab(), i.bis(), null);
                    }
                    for (FlaechenIntervall f : flaechenDerReferenz(g)) {
                        flaechen.eintragen(AHRENBERG, null, id, f.m2(), f.ab(), f.bis(), null);
                    }
                    m.put(kz, id);
                }
                for (JsonNode b : referenz.get("bereiche")) {
                    String kz = b.get("kennzeichen").asText();
                    assertThat(b.get("eltern_art").asText()).isEqualTo("gebaeude");
                    UUID id = orte.anlegen(new NeuerOrt(AHRENBERG, "bereich",
                            b.get("name").asText(), kz, nutzungscodes(b), null,
                            b.get("beschreibung").asText(), "aktiv", null));
                    for (Intervall i : ortIntervalleDerReferenz(kz)) {
                        zuordnungen.zuordnen(AHRENBERG, id, null, m.get(i.eltern()), i.ab(), i.bis(), null);
                    }
                    m.put(kz, id);
                }
                for (JsonNode s : referenz.get("standorte")) {
                    UUID id = REFERENZ_STANDORTE.get(s.get("kennzeichen").asText());
                    for (FlaechenIntervall f : flaechenDerReferenz(s)) {
                        flaechen.eintragen(AHRENBERG, id, null, f.m2(), f.ab(), f.bis(), null);
                    }
                }
            });
            referenzOrte = m;
        }
        return referenzOrte;
    }

    /** Der Anfang einer Intervall-Liste: erster Tag und erster Elternknoten. */
    private static List<Object> anfang(List<Intervall> liste) {
        return List.of(liste.get(0).ab(), liste.get(0).eltern());
    }

    /** Die Intervalle eines Referenz-Orts, wie die Datei sie nennt ({@code ort_eltern}, tagesgenau). */
    private static List<Intervall> ortIntervalleDerReferenz(String kennzeichen) {
        List<Intervall> out = new ArrayList<>();
        for (JsonNode z : referenz.get("zuordnungen")) {
            if ("ort_eltern".equals(z.get("art").asText()) && kennzeichen.equals(z.get("von").asText())) {
                String bis = text(z.get("gueltig_bis"));
                out.add(new Intervall(LocalDate.parse(z.get("gueltig_ab").asText()),
                        bis == null ? null : LocalDate.parse(bis), text(z.get("nach"))));
            }
        }
        return out;
    }

    /** Der erste Tag eines Referenz-Standorts (Zeitachse: angelegt am …). */
    private static LocalDate ersterTagVon(String standort) {
        return tagInBerlin(element(referenz.get("standorte"), standort).get("aktiv_seit").asText());
    }

    /**
     * Die Flächen eines Referenz-Objekts, wie die Datenbank sie hält: die Datei
     * schreibt sie wie der Vertrag (Tag, LETZTER Tag einschließlich). Eine Fläche
     * ohne Zahl wäre „nicht erhoben" — keine Zeile.
     */
    private static List<FlaechenIntervall> flaechenDerReferenz(JsonNode objekt) {
        List<FlaechenIntervall> out = new ArrayList<>();
        for (JsonNode f : objekt.path("bezugsflaechen")) {
            if (f.path("flaeche_m2").isNull()) {
                continue;
            }
            String bis = text(f.get("gueltig_bis"));
            out.add(new FlaechenIntervall(LocalDate.parse(f.get("gueltig_ab").asText()),
                    bis == null ? null : LocalDate.parse(bis), f.get("flaeche_m2").asInt()));
        }
        return out;
    }

    /** Die Flächen eines Orts im Ortsbaum-Szenario. */
    private static List<FlaechenIntervall> flaechenIntervalle(JsonNode ort) {
        List<FlaechenIntervall> out = new ArrayList<>();
        for (JsonNode f : ort.path("flaechen")) {
            String bis = text(f.path("bis"));
            out.add(new FlaechenIntervall(LocalDate.parse(f.get("ab").asText()),
                    bis == null ? null : LocalDate.parse(bis), f.get("m2").asInt()));
        }
        return out;
    }

    private static List<FlaechenIntervall> alsFlaechen(List<Flaeche> zeilen) {
        return zeilen.stream().map(f -> new FlaechenIntervall(f.gueltigAb(), f.gueltigBis(), f.m2()))
                .toList();
    }

    private static List<String> nutzungscodes(JsonNode objekt) {
        List<String> codes = new ArrayList<>();
        objekt.path("nutzung").forEach(n -> codes.add(code(n.asText())));
        return codes.isEmpty() ? null : codes;
    }

    // ---- Gerüst: Intervalle und Eltern ---------------------------------------

    /** Die Eltern einer Zeile: ein Standort ODER ein Gebäude. */
    private record Eltern(UUID standort, UUID gebaeude) {

        UUID id() {
            return standort != null ? standort : gebaeude;
        }
    }

    /** ST-x → der Standort, G-x → das Gebäude; alles andere vertritt ST-1 (Listen-Fälle). */
    private static Eltern elternFuer(String kennzeichen) {
        UUID standort = REFERENZ_STANDORTE.get(kennzeichen);
        if (standort != null) {
            return new Eltern(standort, null);
        }
        for (JsonNode g : referenz.get("gebaeude")) {
            if (g.get("kennzeichen").asText().equals(kennzeichen)) {
                return new Eltern(null, referenzOrte().get(kennzeichen));
            }
        }
        return new Eltern(REFERENZ_STANDORTE.get("ST-1"), null);
    }

    private static UUID eintragen(UUID ort, Intervall i) {
        Eltern e = elternFuer(i.eltern());
        UUID id = zuordnungen.zuordnen(AHRENBERG, ort, e.standort(), e.gebaeude(), i.ab(), i.bis(),
                null);
        if (i.aufgehoben()) {
            zuordnungen.aufheben(id, JETZT);
        }
        return id;
    }

    private static void flaecheEintragen(UUID standort, UUID ort, Intervall i, int m2) {
        UUID id = flaechen.eintragen(AHRENBERG, standort, ort, m2, i.ab(), i.bis(), null);
        if (i.aufgehoben()) {
            flaechen.aufheben(id, JETZT);
        }
    }

    private static List<Intervall> alsIntervalle(UUID ort) {
        Map<UUID, String> kennzeichen = new LinkedHashMap<>();
        REFERENZ_STANDORTE.forEach((kz, id) -> kennzeichen.put(id, kz));
        referenzOrte().forEach((kz, id) -> kennzeichen.put(id, kz));
        return als(AHRENBERG, () -> zuordnungen.fuerOrt(ort)).stream()
                .map(z -> new Intervall(z.gueltigAb(), z.gueltigBis(),
                        kennzeichen.get(z.eltern()), z.aufgehoben()))
                .toList();
    }

    /** Das Urteil der Vektor-Datei — und der Java-Zwilling spricht dasselbe. */
    private static String urteilDerVektorDatei(JsonNode fall, List<Intervall> intervalle) {
        JsonNode erwartet = fall.get("expected");
        OrtsbaumAbleitung.ListenErgebnis vertrag = OrtsbaumAbleitung.pruefeIntervalle(intervalle);
        assertThat(vertrag.gueltig()).isEqualTo(erwartet.get("gueltig").asBoolean());
        String grund = text(erwartet.get("grund"));
        assertThat(vertrag.grund() == null ? null : vertrag.grund().name().toLowerCase(Locale.ROOT))
                .isEqualTo(grund);
        return grund;
    }

    /** Trägt der Reihe nach ein und nennt den Grund der ersten Ablehnung — oder {@code null}. */
    private static String erstesUrteil(List<Intervall> intervalle, Consumer<Intervall> eintrag) {
        return als(AHRENBERG, () -> {
            for (Intervall i : intervalle) {
                PSQLException p = ablehnung(() -> eintrag.accept(i));
                if (p != null) {
                    return grundAus(p);
                }
            }
            return null;
        });
    }

    // ---- Gerüst: Proben ------------------------------------------------------

    /** Ein Ort zum Variieren; Name und Kurzzeichen sind je Probe eindeutig. */
    private static final class OrtProbe {
        String art = "gebaeude";
        String name;
        String kurzzeichen;
        List<String> nutzung;
        Integer baujahr;
        String notiz;
        String zustand = "aktiv";
    }

    private static synchronized NeuerOrt probeOrt(UUID tenant, Consumer<OrtProbe> aenderung) {
        probe++;
        OrtProbe p = new OrtProbe();
        p.name = "Probe " + probe;
        p.kurzzeichen = "P-" + probe;
        aenderung.accept(p);
        return new NeuerOrt(tenant, p.art, p.name, p.kurzzeichen, p.nutzung, p.baujahr, p.notiz,
                p.zustand, null);
    }

    private static UUID neuerOrt(UUID tenant, Consumer<OrtProbe> aenderung) {
        return als(tenant, () -> orte.anlegen(probeOrt(tenant, aenderung)));
    }

    private static synchronized UUID probeStandort() {
        probe++;
        int n = probe;
        return als(AHRENBERG, () -> standorte.anlegen(new NeuerStandort(AHRENBERG,
                unternehmenVon(AHRENBERG), "Probe " + n, "P-" + n, null, null, null, null,
                "Europe/Berlin", null, null, null, null, "entwurf", null)));
    }

    private static void ortChk(String constraint, Consumer<OrtProbe> aenderung) {
        abgelehnt("23514", constraint, () -> neuerOrt(AHRENBERG, aenderung));
    }

    private static void eindeutig(UUID tenant, Consumer<OrtProbe> aenderung) {
        abgelehnt("23505", "uq_ort_kurzzeichen", () -> neuerOrt(tenant, aenderung));
    }

    private static void archiviere(UUID ort) {
        alsTue(AHRENBERG, () -> assertThat(app.update("UPDATE ort SET zustand = 'archiviert', "
                + "archiviert_am = now(), archiviert_von = 'ines.kaltenbach' WHERE id = ?",
                ort)).isOne());
    }

    /** Kundenwort → Code: Kleinbuchstaben, ä→ae, ö→oe, ü→ue, ß→ss („Büro" → buero). */
    private static String code(String kundenwort) {
        return kundenwort.toLowerCase(Locale.ROOT).replace("ä", "ae").replace("ö", "oe")
                .replace("ü", "ue").replace("ß", "ss");
    }

    private static String gross(String code) {
        return code.toUpperCase(Locale.ROOT);
    }

    // ---- Gerüst: der Bestand vor der Migration -------------------------------

    /**
     * Ahrenberg (Referenz) und ein fremder Kundenbereich, beide NACH dem Backfill
     * von IP-2a — ihre Unternehmen legt der Test an wie ein späterer Anlege-Weg.
     * Dazu die Anlagen, die Standorte ST-1/ST-2 (Referenz) und ST-3 (Szenario),
     * die Anlagen-Zuordnungen und je Standort ein Protokolleintrag: jede Tabelle
     * von IP-2a hat Zeilen, bevor diese Fassung läuft.
     */
    private static void saeBestand() {
        root.update("INSERT INTO tenant (id, name, created_at) VALUES (?, ?, ?)", AHRENBERG,
                referenz.at("/unternehmen/name").asText(),
                OffsetDateTime.parse(referenz.at("/unternehmen/kunde_seit").asText()));
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kundenbereich B')", FREMD);
        UUID ua = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, kurzname) "
                + "VALUES (?, ?, ?) RETURNING id", UUID.class, AHRENBERG,
                referenz.at("/unternehmen/name").asText(),
                referenz.at("/unternehmen/kurzname").asText());
        UUID ub = root.queryForObject("INSERT INTO unternehmen (tenant_id, name) "
                + "VALUES (?, 'Kundenbereich B') RETURNING id", UUID.class, FREMD);

        Map<String, UUID> anlagen = new LinkedHashMap<>();
        for (JsonNode a : referenz.get("anlagen")) {
            anlagen.put(a.get("kennzeichen").asText(), root.queryForObject(
                    "INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
                    UUID.class, AHRENBERG, a.get("name").asText(),
                    OffsetDateTime.parse(a.get("seit").asText())));
        }
        root.update("INSERT INTO site (tenant_id, name, latitude, longitude) "
                + "VALUES (?, 'Anlage des fremden Kundenbereichs', 53.55, 9.99)", FREMD);

        alsTue(AHRENBERG, () -> {
            for (JsonNode s : referenz.get("standorte")) {
                List<String> nutzung = nutzungscodes(s);
                JsonNode lage = s.path("lage");
                String kz = s.get("kennzeichen").asText();
                UUID id = standorte.anlegen(new NeuerStandort(AHRENBERG, ua,
                        s.get("name").asText(), kz, text(s.at("/adresse/strasse")),
                        text(s.at("/adresse/plz")), text(s.at("/adresse/ort")),
                        text(s.at("/adresse/land")), s.get("zeitzone").asText(), nutzung,
                        text(s.get("notiz")),
                        lage.isObject() ? lage.get("breitengrad").decimalValue() : null,
                        lage.isObject() ? lage.get("laengengrad").decimalValue() : null,
                        "aktiv", null));
                REFERENZ_STANDORTE.put(kz, id);
                // Roh: der Bestand entsteht auf der Fassung VOR dieser Migration, und die Spalten hießen dort
                // noch akteur_* (AP-03 IP-7 benennt sie in V20260916010000 um) — der Lesecode von heute passt nicht.
                root.update("INSERT INTO ort_aenderung (tenant_id, objekt_art, objekt_id, art, alt, neu, gilt_ab, "
                        + "rueckwirkend, akteur_sub, akteur_name) VALUES (?, 'standort', ?, 'angelegt', NULL, ?::jsonb, "
                        + "?, false, 'ines.kaltenbach', 'Ines Kaltenbach')", AHRENBERG, id,
                        "{\"name\": \"" + s.get("name").asText() + "\"}", tagInBerlin(s.get("aktiv_seit").asText()));
            }
            JsonNode st3 = element(ortsbaum.at("/szenarien/ahrenberg-vor-dem-umzug/orte"), "ST-3");
            REFERENZ_STANDORTE.put("ST-3", standorte.anlegen(new NeuerStandort(AHRENBERG, ua,
                    st3.get("name").asText(), "ST-3", null, null, null, null,
                    st3.get("zeitzone").asText(), null, null, null, null, "entwurf", null)));
            for (JsonNode z : referenz.get("zuordnungen")) {
                if ("anlage_standort".equals(z.get("art").asText())) {
                    anlagenZuordnungen.zuordnen(AHRENBERG, anlagen.get(z.get("von").asText()),
                            REFERENZ_STANDORTE.get(z.get("nach").asText()),
                            LocalDate.parse(z.get("gueltig_ab").asText()), null, null);
                }
            }
        });
        fremderStandort = als(FREMD, () -> standorte.anlegen(new NeuerStandort(FREMD, ub,
                "Werk B", "ST-1", null, null, null, null, "Europe/Berlin", null, null, null, null,
                "entwurf", null)));
    }

    private static UUID unternehmenVon(UUID tenant) {
        return root.queryForObject("SELECT id FROM unternehmen WHERE tenant_id = ?", UUID.class,
                tenant);
    }

    private static long anzahl(String sql, Object... args) {
        return root.queryForObject(sql, Long.class, args);
    }

    // ---- Gerüst: der Schnappschuss einer Tabelle -----------------------------

    /**
     * Alles, was eine Migration an einer Tabelle ändern könnte: Spalten (Name,
     * Typ, Pflicht, Vorgabe, Position), jede Zeile als Text, eigene Constraints,
     * Indexe, Policies, RLS-Schalter, eigene Trigger und Rechte (Tabelle UND
     * Spalte). Nicht darin: die internen Fremdschlüssel-Trigger, die JEDE Tabelle
     * mit einem Verweis auf {@code standort} dort anlegt — sie gehören dem
     * verweisenden Constraint.
     */
    private static Map<String, String> schnappschuss(String tabelle) {
        Map<String, String> s = new LinkedHashMap<>();
        s.put("spalten", root.queryForObject("SELECT string_agg(format('%s|%s|%s|%s|%s', "
                + "column_name, data_type, is_nullable, column_default, ordinal_position), "
                + "E'\\n' ORDER BY ordinal_position) FROM information_schema.columns "
                + "WHERE table_schema = 'public' AND table_name = ?", String.class, tabelle));
        s.put("zeilen", root.queryForObject("SELECT string_agg(t::text, E'\\n' ORDER BY t.id) "
                + "FROM " + tabelle + " t", String.class));
        s.put("constraints", root.queryForObject("SELECT string_agg(conname || ':' || "
                + "pg_get_constraintdef(oid), E'\\n' ORDER BY conname) FROM pg_constraint "
                + "WHERE conrelid = ?::regclass", String.class, tabelle));
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
        s.put("rechte", root.queryForObject("SELECT relacl::text FROM pg_class "
                + "WHERE oid = ?::regclass", String.class, tabelle));
        s.put("spaltenrechte", root.queryForObject("SELECT string_agg(attname || '=' || "
                + "attacl::text, ',' ORDER BY attnum) FROM pg_attribute WHERE attrelid = "
                + "?::regclass AND attacl IS NOT NULL", String.class, tabelle));
        return s;
    }

    // ---- Gerüst: Vektor-Datei ------------------------------------------------

    private static Stream<JsonNode> faelle(String familie, String ableitung) {
        return StreamSupport.stream(ortsbaum.get("cases").spliterator(), false)
                .filter(c -> familie.equals(c.get("familie").asText()))
                .filter(c -> ableitung.equals(c.get("ableitung").asText()));
    }

    /** Der Ort im Szenario des Falls — eine Überlagerung ersetzt den mit demselben Kennzeichen. */
    private static JsonNode ortImSzenario(JsonNode input) {
        String objekt = input.get("objekt").asText();
        JsonNode ueber = input.at("/ueberlagerung/orte");
        if (ueber.isArray()) {
            for (JsonNode o : ueber) {
                if (objekt.equals(o.get("kennzeichen").asText())) {
                    return o;
                }
            }
        }
        return element(ortsbaum.at("/szenarien/" + input.get("szenario").asText() + "/orte"),
                objekt);
    }

    private static JsonNode element(JsonNode liste, String kennzeichen) {
        for (JsonNode e : liste) {
            if (kennzeichen.equals(e.get("kennzeichen").asText())) {
                return e;
            }
        }
        throw new AssertionError(kennzeichen + " fehlt in der Datei");
    }

    private static List<Intervall> intervalle(JsonNode liste) {
        List<Intervall> out = new ArrayList<>();
        for (JsonNode i : liste) {
            String bis = text(i.path("bis"));
            out.add(new Intervall(LocalDate.parse(i.get("ab").asText()),
                    bis == null ? null : LocalDate.parse(bis), i.get("eltern").asText(),
                    i.path("aufgehoben").asBoolean(false)));
        }
        return out;
    }

    private static LocalDate tagInBerlin(String zeitpunkt) {
        return OffsetDateTime.parse(zeitpunkt).atZoneSameInstant(BERLIN).toLocalDate();
    }

    private static String text(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : n.asText();
    }

    // ---- Gerüst: Zaun und Ablehnungen ----------------------------------------

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
        String constraint = p.getServerErrorMessage().getConstraint();
        String zustand = p.getSQLState();
        if ("23P01".equals(zustand) && Set.of("ort_zuordnung_keine_ueberlappung",
                "flaeche_standort_keine_ueberlappung", "flaeche_ort_keine_ueberlappung")
                .contains(constraint)) {
            return "ueberlappung";
        }
        if ("23514".equals(zustand) && Set.of("ort_zuordnung_bis_nicht_vor_ab",
                "flaeche_gueltigkeit_bis_nicht_vor_ab").contains(constraint)) {
            return "bis_vor_ab";
        }
        if ("23503".equals(zustand) && Set.of("ort_zuordnung_eltern_ist_gebaeude_fk",
                "ort_zuordnung_unter_gebaeude_nur_bereich_fk").contains(constraint)) {
            return "ziel_art_unzulaessig";
        }
        throw new AssertionError("unerwartete Ablehnung: " + p.getMessage(), p);
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
        try (InputStream in = UemsOrteMigrationTest.class
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
