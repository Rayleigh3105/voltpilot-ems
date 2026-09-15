package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.AnlageStandortRepository.Zuordnung;
import com.voltpilot.api.uems.OrtAenderungRepository.NeuerEintrag;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Intervall;
import com.voltpilot.api.uems.StandortRepository.NeuerStandort;
import com.voltpilot.api.uems.StandortRepository.Standort;
import com.voltpilot.api.uems.UnternehmenRepository.Unternehmen;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
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
 * Die Migration {@code V20260911100000} (UEMS AP-02 IP-2a) gegen eine echte
 * TimescaleDB: die vier ersten UEMS-Tabellen, ihr Mandantenzaun, ihre
 * Constraints und der Backfill — und dass {@code site} und {@code tenant} dabei
 * zeichengleich bleiben.
 *
 * <p>Der Prüfnachweis des Konzepts (§8 IP-2a), je Gruppe ein Test:
 * (a) der Zaun steht auf jeder neuen Tabelle (A14), (b) je Mandant genau ein
 * Unternehmen und ein erneuter Lauf legt nichts doppelt an, (c) {@code site}
 * bleibt zeichengleich, (d) das Überlappungsverbot — die Fälle der Familie
 * {@code ueberlappung} aus {@code docs/contracts/v2/ortsbaum-vectors.json}
 * gegen den Exklusions-Constraint, (e) die CHECKs, (f) Kurzzeichen je
 * Kundenbereich. Dazu die Folgen von ON DELETE RESTRICT und die Rechte der
 * App-Rolle. (Seit V20260911290000, AP-02 IP-9/W5, darf eine zugeordnete Anlage
 * gehen — ihre Zuordnung bleibt als Grabstein; die Einfüge-Hälfte des früheren
 * Fremdschlüssels auf {@code site} hält ein Trigger mit derselben Ablehnung.)
 *
 * <p>Beispielquelle ist allein das Referenzunternehmen
 * ({@code uems-referenzunternehmen.json}): Kundenbereich, Anlagen und
 * Standorte kommen mit ihren Kennzeichen und Werten aus der Datei, ST-3 aus
 * dem Szenario der Ortsbaum-Vektoren (das Referenzunternehmen lässt ihn aus).
 *
 * <p>Vorbild: {@code ComponentCapabilitiesRepairMigrationTest} — bis zur Fassung
 * davor migrieren, den Bestand säen, dann diese Fassung laufen lassen.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsStandortMigrationTest {

    /** Diese Fassung. Die davor wird aus dem Klassenpfad bestimmt, nicht hart verdrahtet. */
    private static final String DIESE = "20260911100000";
    private static final String DATEI = "V20260911100000__uems_unternehmen_standort.sql";

    private static final Path REFERENZ =
            Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");
    private static final Path ORTSBAUM =
            Path.of("..", "..", "docs", "contracts", "v2", "ortsbaum-vectors.json");

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final List<String> TABELLEN =
            List.of("unternehmen", "standort", "anlage_standort", "ort_aenderung");

    /** AP-02 E4, die zwölf Kundenwörter der Nutzung. */
    private static final List<String> NUTZUNG_KUNDENWOERTER = List.of("Produktion", "Montage",
            "Lager", "Logistik", "Büro", "Technik", "Außenfläche", "Werkstatt", "Labor", "Verkauf",
            "Sozialräume", "Sonstiges");

    /** „Datenstand am 20.02.2027 um 10:10 Uhr" — das Szenario der Ortsbaum-Vektoren. */
    private static final Instant JETZT = Instant.parse("2027-02-20T09:10:00Z");

    // Der Bestand VOR der Migration: Ahrenberg (Referenzunternehmen), ein
    // fremder Kundenbereich für den Zaun und zwei Namen am Rand der Namensregel.
    private static final UUID AHRENBERG = UUID.fromString("4e000000-0000-0000-0000-000000000001");
    private static final UUID FREMD = UUID.fromString("4e000000-0000-0000-0000-000000000002");
    private static final UUID LANGER_NAME = UUID.fromString("4e000000-0000-0000-0000-000000000003");
    private static final UUID LEERER_NAME = UUID.fromString("4e000000-0000-0000-0000-000000000004");
    private static final String LANGER_TENANT_NAME = "  " + "Kunststoffwerk Ahrenberg GmbH ".repeat(5);

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

    private static Map<String, String> siteVorher;
    private static Map<String, String> siteNachher;
    private static Map<String, String> tenantVorher;
    private static Map<String, String> tenantNachher;
    private static List<Map<String, Object>> unternehmenNachDerMigration;
    private static List<Map<String, Object>> protokollNachDerMigration;
    private static long standorteNachDerMigration;
    private static long zuordnungenNachDerMigration;

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static JdbcTemplate admin;
    private static UnternehmenRepository unternehmen;
    private static StandortRepository standorte;
    private static AnlageStandortRepository zuordnungen;
    private static OrtAenderungRepository aenderungen;

    private static Map<String, UUID> referenzStandorte;
    private static int probe;

    @BeforeAll
    static void migriereMitBestand() throws IOException {
        referenz = MAPPER.readTree(REFERENZ.toFile());
        ortsbaum = MAPPER.readTree(ORTSBAUM.toFile());
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));

        flyway().target(letzteFassungVorDieser()).load().migrate();
        saeBestand();
        siteVorher = schnappschuss("site");
        tenantVorher = schnappschuss("tenant");

        flyway().target(DIESE).load().migrate();
        siteNachher = schnappschuss("site");
        tenantNachher = schnappschuss("tenant");
        unternehmenNachDerMigration = root.queryForList(
                "SELECT tenant_id, name, zeitzone, kurzname, created_by FROM unternehmen");
        protokollNachDerMigration = root.queryForList("SELECT u.tenant_id, a.objekt_art, a.art, "
                + "a.alt, a.neu::text AS neu, a.gilt_ab, a.rueckwirkend, a.akteur_sub, "
                + "a.akteur_name FROM ort_aenderung a JOIN unternehmen u ON u.id = a.objekt_id");
        standorteNachDerMigration = root.queryForObject("SELECT count(*) FROM standort", Long.class);
        zuordnungenNachDerMigration =
                root.queryForObject("SELECT count(*) FROM anlage_standort", Long.class);

        // Was nach dieser Fassung noch liegt, läuft auch — die Tests prüfen den Endstand.
        flyway().load().migrate();

        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        unternehmen = new UnternehmenRepository(app);
        standorte = new StandortRepository(app);
        zuordnungen = new AnlageStandortRepository(app);
        aenderungen = new OrtAenderungRepository(app);
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ---- (b) Backfill -------------------------------------------------------

    @Test
    void derBackfillLegtJeMandantGenauEinUnternehmenAnUndSonstNichts() {
        assertThat(unternehmenNachDerMigration).extracting(r -> r.get("tenant_id"))
                .containsExactlyInAnyOrder(AHRENBERG, FREMD, LANGER_NAME, LEERER_NAME);

        Map<String, Object> ahrenberg = zeileVon(unternehmenNachDerMigration, AHRENBERG);
        assertThat(ahrenberg.get("name")).isEqualTo(referenz.at("/unternehmen/name").asText());
        assertThat(ahrenberg.get("zeitzone")).isEqualTo("Europe/Berlin");
        // Kurzname und Sitz trägt der Kunde nach (IP-4) — nichts wird geraten.
        assertThat(ahrenberg.get("kurzname")).isNull();
        assertThat(ahrenberg.get("created_by")).isNull();
        assertThat(unternehmenNachDerMigration).allSatisfy(
                r -> assertThat(r.get("zeitzone")).isEqualTo("Europe/Berlin"));

        // Der Name wird auf die Namensregel gebracht, nicht verworfen.
        String lang = (String) zeileVon(unternehmenNachDerMigration, LANGER_NAME).get("name");
        assertThat(lang).hasSize(119).isEqualTo(LANGER_TENANT_NAME.strip().substring(0, 119));
        assertThat(zeileVon(unternehmenNachDerMigration, LEERER_NAME).get("name"))
                .isEqualTo("Unternehmen");

        // NUR Unternehmen: Standorte und Zuordnungen legt die Bestandsübernahme an (IP-9).
        assertThat(standorteNachDerMigration).isZero();
        assertThat(zuordnungenNachDerMigration).isZero();

        // Und je Unternehmen genau ein Protokolleintrag — automatisch, nicht rückwirkend.
        assertThat(protokollNachDerMigration).hasSize(4).allSatisfy(e -> {
            assertThat(e.get("objekt_art")).isEqualTo("unternehmen");
            assertThat(e.get("art")).isEqualTo("angelegt");
            assertThat(e.get("alt")).isNull();
            assertThat(e.get("rueckwirkend")).isEqualTo(false);
            assertThat(e.get("akteur_sub")).isNull();
            assertThat(e.get("akteur_name")).isEqualTo("VoltPilot (Bestandsübernahme)");
        });
        assertThat(protokollNachDerMigration).extracting(e -> e.get("tenant_id"))
                .containsExactlyInAnyOrder(AHRENBERG, FREMD, LANGER_NAME, LEERER_NAME);
        assertThat((String) zeileVon(protokollNachDerMigration, AHRENBERG).get("neu"))
                .contains(referenz.at("/unternehmen/name").asText()).contains("Europe/Berlin");
    }

    @Test
    void einErneuterLaufLegtNichtsDoppeltAnUndUeberschreibtNichts() throws IOException {
        Map<UUID, UUID> vorher = unternehmenJeMandant();
        UUID spaet = neuerMandant("Kundenbereich nach der Einführung");
        assertThat(anzahl("SELECT count(*) FROM unternehmen WHERE tenant_id = ?", spaet)).isZero();

        fuehreDieseMigrationErneutAus();
        assertThat(anzahl("SELECT count(*) FROM unternehmen WHERE tenant_id = ?", spaet)).isOne();
        root.update("UPDATE unternehmen SET name = 'Umbenannt' WHERE tenant_id = ?", spaet);

        fuehreDieseMigrationErneutAus();
        // Je Mandant weiterhin genau eines, dieselben Zeilen, der geänderte Name bleibt.
        assertThat(anzahl("SELECT count(*) FROM tenant t WHERE "
                + "(SELECT count(*) FROM unternehmen u WHERE u.tenant_id = t.id) <> 1")).isZero();
        assertThat(unternehmenJeMandant()).containsAllEntriesOf(vorher);
        assertThat(root.queryForObject("SELECT name FROM unternehmen WHERE tenant_id = ?",
                String.class, spaet)).isEqualTo("Umbenannt");
        assertThat(anzahl("SELECT count(*) FROM unternehmen u WHERE (SELECT count(*) FROM "
                + "ort_aenderung a WHERE a.objekt_id = u.id AND a.art = 'angelegt') <> 1")).isZero();
    }

    // ---- (c) site bleibt zeichengleich --------------------------------------

    @Test
    void siteUndTenantBleibenZeichengleich() {
        // Der Schnappschuss ist nicht leer: der Bestand steht darin.
        assertThat(siteVorher.get("zeilen"))
                .contains(referenz.at("/anlagen/0/name").asText(), "Anlage des fremden Kundenbereichs");
        assertThat(siteVorher.get("spalten")).contains("latitude|numeric");

        assertThat(siteNachher).isEqualTo(siteVorher);
        assertThat(tenantNachher).isEqualTo(tenantVorher);
    }

    // ---- (a) der Mandantenzaun (A14) -----------------------------------------

    @Test
    void a14DerZaunStehtAufJederNeuenTabelle() {
        Map<String, UUID> st = referenzStandorte();
        UUID fremdesUnternehmen = unternehmenVon(FREMD);
        UUID fremderStandort = als(FREMD, () -> standorte.anlegen(probeStandort(
                FREMD, fremdesUnternehmen, p -> { p.kurzzeichen = "ST-1"; p.name = "Werk B"; })));
        UUID anlageA = neueAnlage(AHRENBERG, "Zaun-Probe Ahrenberg");
        UUID anlageB = neueAnlage(FREMD, "Zaun-Probe B");
        alsTue(AHRENBERG, () -> zuordnungen.zuordnen(
                AHRENBERG, anlageA, st.get("ST-1"), LocalDate.parse("2026-10-01"), null, null));
        alsTue(FREMD, () -> zuordnungen.zuordnen(
                FREMD, anlageB, fremderStandort, LocalDate.parse("2026-10-01"), null, null));

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

        // Der fremde Standort ist nicht da — die Route macht daraus 404, nie 403.
        alsTue(FREMD, () -> {
            assertThat(standorte.finde(st.get("ST-1"))).isEmpty();
            assertThat(standorte.finde(fremderStandort)).isPresent();
            assertThat(standorte.alle()).extracting(Standort::id)
                    .contains(fremderStandort).doesNotContainAnyElementsOf(st.values());
            assertThat(zuordnungen.fuerAnlage(anlageA)).isEmpty();
            assertThat(aenderungen.fuerObjekt("unternehmen", unternehmenVon(AHRENBERG))).isEmpty();
            assertThat(unternehmen.desKundenbereichs()).map(Unternehmen::id)
                    .contains(fremdesUnternehmen);
        });

        // Schreiben über den Zaun: die Policy (WITH CHECK) lehnt ab …
        abgelehntWegen("42501", "row-level security", () -> als(FREMD, () -> standorte.anlegen(
                probeStandort(AHRENBERG, unternehmenVon(AHRENBERG), p -> { }))));
        // … und die zusammengesetzten Fremdschlüssel, die ohne RLS prüfen, lassen
        // keine Zuordnung über die Mandantengrenze zu — weder die Anlage noch der Standort.
        // Die Anlage A HAT an dem Tag ein Intervall: trotzdem spricht der
        // Fremdschlüssel, nicht das Überlappungsverbot — die Ablehnung verrät B nichts über A.
        abgelehnt("23503", "anlage_standort_site_fk", () -> als(FREMD, () -> zuordnungen.zuordnen(
                FREMD, anlageA, fremderStandort, LocalDate.parse("2026-10-01"), null, null)));
        // (Eine Anlage ohne Intervall: sonst spräche das Überlappungsverbot zuerst.)
        UUID anlageOhneZuordnung = neueAnlage(FREMD, "Zaun-Probe B, noch nicht zugeordnet");
        abgelehnt("23503", "anlage_standort_standort_fk", () -> als(FREMD, () ->
                zuordnungen.zuordnen(FREMD, anlageOhneZuordnung, st.get("ST-1"),
                        LocalDate.parse("2026-10-01"), null, null)));
        // Auch am Unternehmen: B unter A's Unternehmen mit dem Namen von ST-1 — es
        // spricht der Fremdschlüssel, nicht die Namensregel, die A's Namen verriete.
        String nameVonSt1 = element(referenz.get("standorte"), "ST-1").get("name").asText();
        abgelehnt("23503", "standort_unternehmen_fk", () -> als(FREMD, () -> standorte.anlegen(
                probeStandort(FREMD, unternehmenVon(AHRENBERG), p -> p.name = nameVonSt1))));
    }

    // ---- (d) das Überlappungsverbot = der Vertrag ----------------------------

    /**
     * Die Listen-Fälle: Intervalle EINES Objekts, der Reihe nach eingetragen.
     * Die Datenbank muss dasselbe Urteil sprechen wie die Vektor-Datei (und
     * {@link OrtsbaumAbleitung#pruefeIntervalle}). Das Urteil hängt nicht an den
     * Eltern — {@code pruefeIntervalle} liest sie nicht —, aber eine Zeile von
     * {@code anlage_standort} braucht einen STANDORT: ST-x wird der Standort
     * dieses Kennzeichens, ein Gebäude/Bereich als Eltern bekommt ST-1 als
     * Stellvertreter.
     */
    @TestFactory
    Stream<DynamicTest> ueberlappungDieListenFaelleDerVektorDatei() {
        return faelle("ueberlappung", "liste").map(fall -> DynamicTest.dynamicTest(
                fall.get("name").asText(), () -> {
                    List<Intervall> intervalle = intervalle(fall.at("/input/intervalle"));
                    JsonNode erwartet = fall.get("expected");
                    String erwarteterGrund = text(erwartet.get("grund"));

                    OrtsbaumAbleitung.ListenErgebnis vertrag =
                            OrtsbaumAbleitung.pruefeIntervalle(intervalle);
                    assertThat(vertrag.gueltig()).isEqualTo(erwartet.get("gueltig").asBoolean());

                    UUID anlage = neueAnlage(AHRENBERG, "Überlappung · " + fall.get("name").asText());
                    String grund = als(AHRENBERG, () -> {
                        for (Intervall i : intervalle) {
                            PSQLException p = ablehnung(() -> eintragen(anlage, i));
                            if (p != null) {
                                return grundAus(p);
                            }
                        }
                        return null;
                    });
                    assertThat(grund).isEqualTo(erwarteterGrund);
                }));
    }

    /**
     * Die Eintrags-Fälle einer ANLAGE, die erlaubt sind: vom Stand des
     * Szenarios zum erwarteten Stand so, wie der Schreibweg es tun wird —
     * erst beenden/aufheben, dann eintragen. Die Datenbank nimmt die
     * anschließenden Intervalle (bis = Vortag, ab = Tag) an, und was sie danach
     * hält, ist genau die Intervall-Liste der Vektor-Datei. Abgelehnte
     * Eintrags-Fälle (z. B. {@code anlage-ist-bereits-zugeordnet}) sind Regeln
     * des Schreibwegs, keine der Datenbank.
     */
    @TestFactory
    Stream<DynamicTest> ueberlappungDieEintragsFaelleEinerAnlage() {
        return faelle("ueberlappung", "eintrag")
                .filter(fall -> fall.at("/input/objekt").asText().startsWith("AN-"))
                .filter(fall -> fall.at("/expected/erlaubt").asBoolean())
                .map(fall -> DynamicTest.dynamicTest(fall.get("name").asText(), () -> {
                    JsonNode anlageImSzenario = anlageImSzenario(fall.get("input"));
                    List<Intervall> vorher = intervalle(anlageImSzenario.get("zuordnungen"));
                    List<Intervall> nachher = intervalle(fall.at("/expected/intervalle"));
                    UUID anlage = neueAnlage(AHRENBERG, anlageImSzenario.get("name").asText());

                    alsTue(AHRENBERG, () -> {
                        vorher.forEach(i -> eintragen(anlage, i));
                        List<Zuordnung> ist = zuordnungen.fuerAnlage(anlage);
                        Set<UUID> getroffen = new HashSet<>();
                        List<Intervall> neu = new ArrayList<>();
                        for (Intervall soll : nachher) {
                            Optional<Zuordnung> zeile = ist.stream()
                                    .filter(z -> !getroffen.contains(z.id()) && !z.aufgehoben())
                                    .filter(z -> z.gueltigAb().equals(soll.ab()))
                                    .filter(z -> z.standortId().equals(standortFuer(soll.eltern())))
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
                        neu.forEach(i -> eintragen(anlage, i));
                    });

                    assertThat(alsIntervalle(anlage)).containsExactlyElementsOf(nachher);
                }));
    }

    @Test
    void einNeuesGueltigAbOhneDasLaufendeZuBeendenLehntDieDatenbankAb() {
        // A11 in der falschen Reihenfolge: erst eintragen, dann beenden — der
        // Constraint lässt den Tag, der zweimal belegt wäre, nicht zu.
        Map<String, UUID> st = referenzStandorte();
        UUID anlage = neueAnlage(AHRENBERG, referenz.at("/anlagen/1/name").asText());
        UUID laufend = als(AHRENBERG, () -> zuordnungen.zuordnen(AHRENBERG, anlage,
                st.get("ST-1"), LocalDate.parse("2026-10-01"), null, null));
        abgelehnt("23P01", "anlage_standort_keine_ueberlappung", () -> als(AHRENBERG, () ->
                zuordnungen.zuordnen(AHRENBERG, anlage, st.get("ST-3"),
                        LocalDate.parse("2027-03-01"), null, null)));
        // Und das Beenden auf einen Tag VOR dem Beginn ist kein Intervall.
        abgelehnt("23514", "anlage_standort_bis_nicht_vor_ab", () -> alsTue(AHRENBERG, () ->
                zuordnungen.beenden(laufend, LocalDate.parse("2026-09-30"))));
    }

    @Test
    void dieReferenzZuordnungenPassenInsSchema() {
        Map<String, UUID> st = referenzStandorte();
        for (JsonNode z : referenz.get("zuordnungen")) {
            if (!"anlage_standort".equals(z.get("art").asText())) {
                continue;
            }
            JsonNode anlageRef = element(referenz.get("anlagen"), z.get("von").asText());
            UUID anlage = neueAnlage(AHRENBERG, anlageRef.get("name").asText());
            // Tagesgenau wie die Spalte: die Referenzdatei schreibt den Tag selbst (AP-02 E9).
            LocalDate ab = LocalDate.parse(z.get("gueltig_ab").asText());
            alsTue(AHRENBERG, () -> zuordnungen.zuordnen(AHRENBERG, anlage,
                    st.get(z.get("nach").asText()), ab, null, null));
            assertThat(alsIntervalle(anlage))
                    .containsExactly(new Intervall(ab, null, z.get("nach").asText(), false));
        }
    }

    // ---- (e) die CHECKs ------------------------------------------------------

    @Test
    void dieReferenzStandortePassenUnverfaelschtInsSchema() {
        Map<String, UUID> st = referenzStandorte();
        JsonNode st1 = element(referenz.get("standorte"), "ST-1");
        Standort gelesen = als(AHRENBERG, () -> standorte.finde(st.get("ST-1"))).orElseThrow();
        assertThat(gelesen.name()).isEqualTo(st1.get("name").asText());
        assertThat(gelesen.kurzzeichen()).isEqualTo("ST-1");
        assertThat(gelesen.strasse()).isEqualTo(st1.at("/adresse/strasse").asText());
        assertThat(gelesen.plz()).isNull();
        assertThat(gelesen.ort()).isEqualTo(st1.at("/adresse/ort").asText());
        assertThat(gelesen.land()).isEqualTo("DE");
        assertThat(gelesen.zeitzone()).isEqualTo(st1.get("zeitzone").asText());
        assertThat(gelesen.nutzung()).containsExactly("produktion", "buero");
        assertThat(gelesen.notiz()).isEqualTo(st1.get("notiz").asText());
        assertThat(gelesen.lageBreitengrad()).isEqualByComparingTo("48.25");
        assertThat(gelesen.lageLaengengrad()).isEqualByComparingTo("11.43");
        assertThat(gelesen.zustand()).isEqualTo("aktiv");
        assertThat(gelesen.archiviertAm()).isNull();
        // ST-3 kommt ohne Adresse: ein Entwurf („es fehlt: Adresse"), kein erfundener Wert.
        assertThat(als(AHRENBERG, () -> standorte.finde(st.get("ST-3"))).orElseThrow().zustand())
                .isEqualTo("entwurf");

        // Das Vokabular trägt jede Nutzung des Referenzunternehmens — auch die der
        // Gebäude und Bereiche, die IP-2b mit derselben Funktion prüft.
        for (String liste : List.of("standorte", "gebaeude", "bereiche")) {
            for (JsonNode o : referenz.get(liste)) {
                List<String> codes = new ArrayList<>();
                o.path("nutzung").forEach(n -> codes.add(code(n.asText())));
                if (!codes.isEmpty()) {
                    assertThat(nutzungGueltig(codes)).as(o.get("kennzeichen").asText()).isTrue();
                }
            }
        }
    }

    @Test
    void dieChecksLehnenAbWasNichtImVokabularSteht() {
        UUID u = unternehmenVon(AHRENBERG);
        // Zeitzone: nur der DACH-Raum.
        chk("standort_zeitzone_chk", u, p -> p.zeitzone = "Europe/Paris");
        chk("standort_zeitzone_chk", u, p -> p.zeitzone = "UTC");
        erlaubt(u, p -> p.zeitzone = "Europe/Vienna");
        erlaubt(u, p -> p.zeitzone = "Europe/Zurich");
        // Land: DE · AT · CH, und die PLZ im Format ihres Landes.
        chk("standort_land_chk", u, p -> p.land = "FR");
        chk("standort_land_chk", u, p -> p.land = "de");
        chk("standort_plz_chk", u, p -> p.plz = "8010");
        chk("standort_plz_chk", u, p -> { p.land = "AT"; p.plz = "80100"; });
        chk("standort_plz_chk", u, p -> { p.land = null; p.plz = "84000"; });
        erlaubt(u, p -> { p.land = "AT"; p.plz = "4600"; });
        erlaubt(u, p -> { p.land = "CH"; p.plz = "8001"; });
        erlaubt(u, p -> p.plz = "01067");
        // Nutzung: geschlossen, ohne Wiederholung, nie leer; das Kundenwort ist kein Code.
        chk("standort_nutzung_chk", u, p -> p.nutzung = List.of("Büro"));
        chk("standort_nutzung_chk", u, p -> p.nutzung = List.of("hotel"));
        chk("standort_nutzung_chk", u, p -> p.nutzung = List.of("buero", "produktion", "buero"));
        chk("standort_nutzung_chk", u, p -> p.nutzung = List.of());
        erlaubt(u, p -> p.nutzung = NUTZUNG_KUNDENWOERTER.stream()
                .map(UemsStandortMigrationTest::code).toList());
        // Die Ränder, an denen SQL NULL statt false sagt — ein CHECK nähme NULL an.
        assertThat(root.queryForObject("SELECT uems_nutzung_gueltig(ARRAY['buero', NULL])",
                Boolean.class)).isFalse();
        assertThat(root.queryForObject("SELECT uems_nutzung_gueltig(ARRAY[['buero']])",
                Boolean.class)).isFalse();
        assertThat(root.queryForObject("SELECT uems_nutzung_gueltig('{}')", Boolean.class))
                .isFalse();
        assertThat(root.queryForObject("SELECT uems_nutzung_gueltig(NULL)", Boolean.class))
                .isTrue();
        // Name: 1–120 Zeichen, nie nur Leerzeichen.
        chk("standort_name_chk", u, p -> p.name = "");
        chk("standort_name_chk", u, p -> p.name = "   ");
        chk("standort_name_chk", u, p -> p.name = "W".repeat(121));
        erlaubt(u, p -> p.name = "W".repeat(120));
        // Notiz ≤ 500, Kurzzeichen ohne Randleerzeichen, Lage nur als Paar im Wertebereich.
        chk("standort_notiz_chk", u, p -> p.notiz = "n".repeat(501));
        chk("standort_notiz_chk", u, p -> p.notiz = "");
        chk("standort_kurzzeichen_chk", u, p -> p.kurzzeichen = " ST-9");
        chk("standort_kurzzeichen_chk", u, p -> p.kurzzeichen = "K".repeat(25));
        chk("standort_lage_chk", u, p -> p.breite = new BigDecimal("48.25"));
        chk("standort_lage_chk", u, p -> { p.breite = new BigDecimal("91"); p.laenge = BigDecimal.ONE; });
        // Zustand: kein „angehalten" am Objekt; „archiviert" nie ohne Zeitpunkt.
        chk("standort_zustand_chk", u, p -> p.zustand = "angehalten");
        chk("standort_zustand_chk", u, p -> p.zustand = "gueltig");
        chk("standort_archiv_chk", u, p -> p.zustand = "archiviert");

        // Das Unternehmen: dieselben Regeln, über den Weg, den IP-4 bearbeiten wird.
        unternehmenChk("unternehmen_name_chk", "name = ''");
        unternehmenChk("unternehmen_name_chk", "name = repeat('U', 121)");
        unternehmenChk("unternehmen_zeitzone_chk", "zeitzone = 'Europe/London'");
        unternehmenChk("unternehmen_kurzname_chk", "kurzname = repeat('K', 25)");
        unternehmenChk("unternehmen_sitz_land_chk", "sitz_land = 'IT'");
        unternehmenChk("unternehmen_sitz_plz_chk", "sitz_land = 'DE', sitz_plz = '8010'");
        unternehmenChk("unternehmen_sitz_plz_chk", "sitz_land = NULL, sitz_plz = '84000'");
        unternehmenChk("unternehmen_rechtsform_chk", "rechtsform = repeat('R', 41)");

        // Das Protokoll: geschlossene Arten, und „wer" ist nie leer.
        protokollChk("ort_aenderung_objekt_art_chk", "messstelle", "angelegt", "Ines Kaltenbach");
        protokollChk("ort_aenderung_art_chk", "standort", "umbenannt", "Ines Kaltenbach");
        protokollChk("ort_aenderung_akteur_chk", "standort", "angelegt", " ");
    }

    @Test
    void a16DieZeitzoneKommtVomUnternehmenUndIstAmStandortPflicht() {
        UUID u = unternehmenVon(AHRENBERG);
        String vorgabe = als(AHRENBERG, () -> unternehmen.desKundenbereichs()).orElseThrow().zeitzone();
        assertThat(vorgabe).isEqualTo(referenz.at("/unternehmen/zeitzone").asText());
        UUID lindach = erlaubt(u, p -> p.zeitzone = vorgabe);
        assertThat(als(AHRENBERG, () -> standorte.finde(lindach)).orElseThrow().zeitzone())
                .isEqualTo("Europe/Berlin");
        // Ein Standort in Österreich bekommt seine eigene („Werk Wels").
        erlaubt(u, p -> { p.land = "AT"; p.zeitzone = "Europe/Vienna"; });
        // Die Vorbelegung ist Sache des Schreibwegs — die Datenbank besteht darauf, dass sie da ist.
        abgelehnt("23502", null, () -> als(AHRENBERG, () -> standorte.anlegen(
                probeStandort(AHRENBERG, u, p -> p.zeitzone = null))));
    }

    // ---- (f) Kurzzeichen und Namen -------------------------------------------

    @Test
    void kurzzeichenSindEindeutigJeKundenbereichUndWerdenNieFrei() {
        UUID a = unternehmenVon(AHRENBERG);
        UUID b = unternehmenVon(FREMD);
        UUID kz1 = erlaubt(a, p -> { p.kurzzeichen = "KZ-1"; p.name = "Werk Kurz"; });
        // Dieselbe Kennung im selben Kundenbereich — auch in anderer Schreibweise.
        eindeutig("uq_standort_kurzzeichen", AHRENBERG, a, p -> p.kurzzeichen = "KZ-1");
        eindeutig("uq_standort_kurzzeichen", AHRENBERG, a, p -> p.kurzzeichen = "kz-1");
        // Ein anderer Kundenbereich hat seine eigene Zählung.
        als(FREMD, () -> standorte.anlegen(probeStandort(FREMD, b, p -> p.kurzzeichen = "KZ-1")));
        // Ein archivierter Standort behält sein Kurzzeichen — es wird nie wiederverwendet (E8).
        archiviere(kz1);
        eindeutig("uq_standort_kurzzeichen", AHRENBERG, a, p -> p.kurzzeichen = "KZ-1");

        // Der Name: eindeutig je Unternehmen unter den NICHT archivierten, ohne
        // Groß-/Kleinschreibung und Randleerzeichen; der archivierte gibt ihn frei.
        UUID erster = erlaubt(a, p -> p.name = "Werk Namensprobe");
        eindeutig("uq_standort_name_nicht_archiviert", AHRENBERG, a,
                p -> p.name = "  werk NAMENSPROBE ");
        archiviere(erster);
        erlaubt(a, p -> p.name = "Werk Namensprobe");
        // „Werk Kurz" ist archiviert — sein Name ist frei, sein Kurzzeichen nicht.
        erlaubt(a, p -> p.name = "Werk Kurz");
    }

    // ---- ON DELETE RESTRICT: das Offboarding räumt ausdrücklich ab ------------

    @Test
    void ohneOffboardingVerweigertDieDatenbankUndDasOffboardingRaeumtAusdruecklichAb() {
        UUID t = neuerMandant("Offboarding-Probe");
        UUID anlage = neueAnlage(t, "Anlage der Offboarding-Probe");
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name) "
                + "VALUES (?, 'Offboarding-Probe') RETURNING id", UUID.class, t);
        UUID s = als(t, () -> standorte.anlegen(probeStandort(t, u, p -> { })));
        alsTue(t, () -> zuordnungen.zuordnen(t, anlage, s, LocalDate.parse("2026-10-01"), null, null));
        alsTue(t, () -> aenderungen.eintragen(new NeuerEintrag(t, "standort", s, "angelegt", null,
                "{\"name\": \"Probe\"}", LocalDate.parse("2026-10-01"), false, null,
                "Jonas Wendlinger")));

        // Nie Kaskade: der Mandant geht nicht still.
        abgelehnt("23503", null, () -> root.update("DELETE FROM tenant WHERE id = ?", t));
        // Die zugeordnete Anlage darf gehen (W5, V20260911290000) — ihre Zuordnung bleibt
        // als Grabstein stehen, nie still mitgenommen.
        assertThat(root.update("DELETE FROM site WHERE id = ?", anlage)).isOne();
        assertThat(anzahl("SELECT count(*) FROM anlage_standort WHERE site_id = ?", anlage)).isOne();

        // Das Offboarding ist der eine Weg, auf dem ein Unternehmen endet.
        new TenantRepository(admin).offboard(t);
        assertThat(anzahl("SELECT count(*) FROM tenant WHERE id = ?", t)).isZero();
        for (String tabelle : List.of("unternehmen", "standort", "anlage_standort")) {
            assertThat(anzahl("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?", t))
                    .as(tabelle).isZero();
        }
        // Das Protokoll bleibt: append-only und ohne Fremdschlüssel.
        assertThat(anzahl("SELECT count(*) FROM ort_aenderung WHERE tenant_id = ?", t)).isOne();
    }

    // ---- Rechte: nie löschen, kein Intervall umschreiben, Protokoll unveränderlich

    @Test
    void dieAppRolleLoeschtNieUndSchreibtKeinIntervallUm() {
        Map<String, UUID> st = referenzStandorte();
        UUID anlage = neueAnlage(AHRENBERG, "Rechte-Probe");
        UUID z = als(AHRENBERG, () -> zuordnungen.zuordnen(AHRENBERG, anlage, st.get("ST-1"),
                LocalDate.parse("2026-10-01"), null, "ines.kaltenbach"));
        long eintrag = als(AHRENBERG, () -> aenderungen.eintragen(new NeuerEintrag(AHRENBERG,
                "anlage", anlage, "verschoben", null, "{\"standort\": \"ST-1\"}",
                LocalDate.parse("2026-10-01"), false, "ines.kaltenbach", "Ines Kaltenbach")));

        alsTue(AHRENBERG, () -> {
            for (String t : TABELLEN) {
                abgelehntWegen("42501", "permission denied", () -> app.update("DELETE FROM " + t));
            }
            // Das Unternehmen legt der Kunde nicht an (§4.1).
            abgelehntWegen("42501", "permission denied", () -> app.update(
                    "INSERT INTO unternehmen (tenant_id, name) VALUES (?, 'Zweites')", AHRENBERG));
            // Beginn, Anlage und Standort eines Intervalls bleiben; beenden und aufheben ja.
            abgelehntWegen("42501", "permission denied", () -> app.update(
                    "UPDATE anlage_standort SET gueltig_ab = gueltig_ab - 1 WHERE id = ?", z));
            abgelehntWegen("42501", "permission denied", () -> app.update(
                    "UPDATE anlage_standort SET standort_id = ? WHERE id = ?", st.get("ST-2"), z));
            assertThat(zuordnungen.beenden(z, LocalDate.parse("2027-02-28"))).isTrue();
            assertThat(zuordnungen.aufheben(z, JETZT)).isTrue();
            assertThat(zuordnungen.fuerAnlage(anlage)).singleElement()
                    .satisfies(r -> assertThat(r.aufgehoben()).isTrue());
            // Das Protokoll: anhängen ja, ändern nie.
            abgelehntWegen("42501", "permission denied", () -> app.update(
                    "UPDATE ort_aenderung SET art = 'bearbeitet' WHERE id = ?", eintrag));
            assertThat(aenderungen.fuerObjekt("anlage", anlage)).singleElement()
                    .satisfies(e -> assertThat(e.actorName()).isEqualTo("Ines Kaltenbach"));
        });
        // Auch der Eigentümer schreibt kein Protokoll um: der Trigger an der Datenbankgrenze.
        abgelehntWegen("P0001", "append-only", () -> root.update(
                "UPDATE ort_aenderung SET art = 'bearbeitet' WHERE id = ?", eintrag));
        abgelehntWegen("P0001", "append-only",
                () -> root.update("DELETE FROM ort_aenderung WHERE id = ?", eintrag));
    }

    // ---- Gerüst: Standorte ---------------------------------------------------

    /** ST-1/ST-2 aus dem Referenzunternehmen, ST-3 aus dem Ortsbaum-Szenario — einmal angelegt. */
    private static synchronized Map<String, UUID> referenzStandorte() {
        if (referenzStandorte == null) {
            UUID u = unternehmenVon(AHRENBERG);
            Map<String, UUID> m = new LinkedHashMap<>();
            for (JsonNode s : referenz.get("standorte")) {
                List<String> nutzung = new ArrayList<>();
                s.path("nutzung").forEach(n -> nutzung.add(code(n.asText())));
                JsonNode lage = s.path("lage");
                NeuerStandort neu = new NeuerStandort(AHRENBERG, u, s.get("name").asText(),
                        s.get("kennzeichen").asText(), text(s.at("/adresse/strasse")),
                        text(s.at("/adresse/plz")), text(s.at("/adresse/ort")),
                        text(s.at("/adresse/land")), s.get("zeitzone").asText(),
                        nutzung.isEmpty() ? null : nutzung, text(s.get("notiz")),
                        lage.isObject() ? lage.get("breitengrad").decimalValue() : null,
                        lage.isObject() ? lage.get("laengengrad").decimalValue() : null,
                        "aktiv", null);
                m.put(s.get("kennzeichen").asText(), als(AHRENBERG, () -> standorte.anlegen(neu)));
            }
            JsonNode st3 = element(ortsbaum.at("/szenarien/ahrenberg-vor-dem-umzug/orte"), "ST-3");
            m.put("ST-3", als(AHRENBERG, () -> standorte.anlegen(new NeuerStandort(AHRENBERG, u,
                    st3.get("name").asText(), "ST-3", null, null, null, null,
                    st3.get("zeitzone").asText(), null, null, null, null, "entwurf", null))));
            referenzStandorte = m;
        }
        return referenzStandorte;
    }

    private static UUID standortFuer(String eltern) {
        Map<String, UUID> st = referenzStandorte();
        return st.getOrDefault(eltern, st.get("ST-1"));
    }

    private static void eintragen(UUID anlage, Intervall i) {
        UUID id = zuordnungen.zuordnen(AHRENBERG, anlage, standortFuer(i.eltern()), i.ab(), i.bis(),
                null);
        if (i.aufgehoben()) {
            zuordnungen.aufheben(id, JETZT);
        }
    }

    private static List<Intervall> alsIntervalle(UUID anlage) {
        Map<UUID, String> kennzeichen = new LinkedHashMap<>();
        referenzStandorte().forEach((kz, id) -> kennzeichen.put(id, kz));
        return als(AHRENBERG, () -> zuordnungen.fuerAnlage(anlage)).stream()
                .map(z -> new Intervall(z.gueltigAb(), z.gueltigBis(),
                        kennzeichen.get(z.standortId()), z.aufgehoben()))
                .toList();
    }

    /** Ein Standort zum Variieren; Name und Kurzzeichen sind je Probe eindeutig. */
    private static final class Probe {
        String name;
        String kurzzeichen;
        String strasse = "Gewerbering 7";
        String plz;
        String ort = "Ahrenberg";
        String land = "DE";
        String zeitzone = "Europe/Berlin";
        List<String> nutzung;
        String notiz;
        BigDecimal breite;
        BigDecimal laenge;
        String zustand = "aktiv";
    }

    private static synchronized NeuerStandort probeStandort(UUID tenant, UUID unternehmenId,
            Consumer<Probe> aenderung) {
        probe++;
        Probe p = new Probe();
        p.name = "Probe " + probe;
        p.kurzzeichen = "P-" + probe;
        aenderung.accept(p);
        return new NeuerStandort(tenant, unternehmenId, p.name, p.kurzzeichen, p.strasse, p.plz,
                p.ort, p.land, p.zeitzone, p.nutzung, p.notiz, p.breite, p.laenge, p.zustand, null);
    }

    private static UUID erlaubt(UUID unternehmenId, Consumer<Probe> aenderung) {
        return als(AHRENBERG, () -> standorte.anlegen(probeStandort(AHRENBERG, unternehmenId, aenderung)));
    }

    private static void chk(String constraint, UUID unternehmenId, Consumer<Probe> aenderung) {
        abgelehnt("23514", constraint, () -> erlaubt(unternehmenId, aenderung));
    }

    private static void eindeutig(String index, UUID tenant, UUID unternehmenId,
            Consumer<Probe> aenderung) {
        abgelehnt("23505", index, () -> als(tenant, () ->
                standorte.anlegen(probeStandort(tenant, unternehmenId, aenderung))));
    }

    private static void archiviere(UUID standort) {
        alsTue(AHRENBERG, () -> assertThat(app.update("UPDATE standort SET zustand = 'archiviert', "
                + "archiviert_am = now(), archiviert_von = 'ines.kaltenbach' WHERE id = ?",
                standort)).isOne());
    }

    private static void unternehmenChk(String constraint, String zuweisung) {
        abgelehnt("23514", constraint, () -> alsTue(AHRENBERG,
                () -> app.update("UPDATE unternehmen SET " + zuweisung)));
    }

    private static void protokollChk(String constraint, String objektArt, String art, String wer) {
        abgelehnt("23514", constraint, () -> als(AHRENBERG, () -> aenderungen.eintragen(
                new NeuerEintrag(AHRENBERG, objektArt, UUID.randomUUID(), art, null, null,
                        LocalDate.parse("2026-10-01"), false, null, wer))));
    }

    private static boolean nutzungGueltig(List<String> codes) {
        return Boolean.TRUE.equals(root.query("SELECT uems_nutzung_gueltig(?)",
                ps -> ps.setArray(1, ps.getConnection().createArrayOf("text",
                        codes.toArray(String[]::new))),
                rs -> rs.next() ? rs.getBoolean(1) : null));
    }

    /** Kundenwort → Code: Kleinbuchstaben, ä→ae, ö→oe, ü→ue, ß→ss („Büro" → buero). */
    private static String code(String kundenwort) {
        return kundenwort.toLowerCase(Locale.ROOT).replace("ä", "ae").replace("ö", "oe")
                .replace("ü", "ue").replace("ß", "ss");
    }

    // ---- Gerüst: Mandanten, Anlagen, Unternehmen ----------------------------

    private static void saeBestand() {
        root.update("INSERT INTO tenant (id, name, created_at) VALUES (?, ?, ?)", AHRENBERG,
                referenz.at("/unternehmen/name").asText(),
                OffsetDateTime.parse(referenz.at("/unternehmen/kunde_seit").asText()));
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kundenbereich B')", FREMD);
        root.update("INSERT INTO tenant (id, name) VALUES (?, ?)", LANGER_NAME, LANGER_TENANT_NAME);
        root.update("INSERT INTO tenant (id, name) VALUES (?, '')", LEERER_NAME);
        for (JsonNode a : referenz.get("anlagen")) {
            root.update("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?)",
                    AHRENBERG, a.get("name").asText(), OffsetDateTime.parse(a.get("seit").asText()));
        }
        root.update("INSERT INTO site (tenant_id, name, latitude, longitude) "
                + "VALUES (?, 'Anlage des fremden Kundenbereichs', 53.55, 9.99)", FREMD);
    }

    private static UUID neuerMandant(String name) {
        return root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                name);
    }

    private static UUID neueAnlage(UUID tenant, String name) {
        return root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, ?) RETURNING id",
                UUID.class, tenant, name);
    }

    private static UUID unternehmenVon(UUID tenant) {
        return root.queryForObject("SELECT id FROM unternehmen WHERE tenant_id = ?", UUID.class,
                tenant);
    }

    private static Map<UUID, UUID> unternehmenJeMandant() {
        Map<UUID, UUID> m = new LinkedHashMap<>();
        root.query("SELECT tenant_id, id FROM unternehmen", rs -> {
            m.put(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class));
        });
        return m;
    }

    private static long anzahl(String sql, Object... args) {
        return root.queryForObject(sql, Long.class, args);
    }

    private static Map<String, Object> zeileVon(List<Map<String, Object>> zeilen, UUID tenant) {
        return zeilen.stream().filter(r -> tenant.equals(r.get("tenant_id"))).findFirst()
                .orElseThrow();
    }

    // ---- Gerüst: der Schnappschuss einer Bestandstabelle ---------------------

    /**
     * Alles, was eine Migration an einer Tabelle ändern könnte: Spalten (Name,
     * Typ, Pflicht, Vorgabe, Position), jede Zeile als Text, eigene Constraints,
     * Indexe, Policies, RLS-Schalter, eigene Trigger und Rechte. Nicht darin:
     * die internen Fremdschlüssel-Trigger, die JEDE Tabelle mit einem Verweis
     * auf {@code site} dort anlegt — sie gehören dem verweisenden Constraint.
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
        s.put("rechte", root.queryForObject("SELECT string_agg(grantee || ':' || privilege_type, "
                + "',' ORDER BY grantee, privilege_type) FROM information_schema.role_table_grants "
                + "WHERE table_schema = 'public' AND table_name = ?", String.class, tabelle));
        return s;
    }

    // ---- Gerüst: Vektor-Datei ------------------------------------------------

    private static Stream<JsonNode> faelle(String familie, String ableitung) {
        return StreamSupport.stream(ortsbaum.get("cases").spliterator(), false)
                .filter(c -> familie.equals(c.get("familie").asText()))
                .filter(c -> ableitung.equals(c.get("ableitung").asText()));
    }

    /** Die Anlage im Szenario des Falls — eine Überlagerung ersetzt die mit demselben Kennzeichen. */
    private static JsonNode anlageImSzenario(JsonNode input) {
        String objekt = input.get("objekt").asText();
        JsonNode ueber = input.at("/ueberlagerung/anlagen");
        if (ueber.isArray()) {
            for (JsonNode a : ueber) {
                if (objekt.equals(a.get("kennzeichen").asText())) {
                    return a;
                }
            }
        }
        return element(ortsbaum.at("/szenarien/" + input.get("szenario").asText() + "/anlagen"),
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

    /** Der Grund der Vektor-Datei zu einer Ablehnung des Constraints. */
    private static String grundAus(PSQLException p) {
        String constraint = p.getServerErrorMessage().getConstraint();
        if ("23P01".equals(p.getSQLState())
                && "anlage_standort_keine_ueberlappung".equals(constraint)) {
            return "ueberlappung";
        }
        if ("23514".equals(p.getSQLState())
                && "anlage_standort_bis_nicht_vor_ab".equals(constraint)) {
            return "bis_vor_ab";
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
        try (InputStream in = UemsStandortMigrationTest.class
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
