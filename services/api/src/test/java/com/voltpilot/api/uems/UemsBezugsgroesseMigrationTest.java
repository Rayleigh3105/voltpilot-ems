package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.file.Path;
import java.sql.Connection;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import java.util.stream.Collectors;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.postgresql.util.PSQLException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Tabellen der Bezugsgrößen (UEMS AP-09 IP-4, {@code V20260913104500}) gegen eine echte
 * TimescaleDB — die drei Abnahmepunkte des Reports und was das Hausmuster dazu verlangt:
 *
 * <ul>
 *   <li><b>Vokabulare zeilengleich:</b> {@code bezugsdaten_vokabular()} ist Zeile für Zeile die
 *       Vektor-Datei, jeder Vokabular-CHECK fragt nur sie, jedes Vertragswort ist speicherbar und
 *       ein fremdes nie; die Fassungs-, Perioden- und Zeitfälle der Vektoren stehen so in der
 *       Tabelle, wie der Vertrag sie rechnet.
 *   <li><b>Ein Wert wird nie überschrieben:</b> der Trigger lehnt JEDES UPDATE ab — auch der
 *       Verwaltungsrolle mit Recht und dem Eigentümer; eine Berichtigung ist Fassung n + 1.
 *   <li><b>Mandantenzaun:</b> RLS + FORCE, zusammengesetzte Verweise, ein fremder Kundenbereich
 *       sieht und erreicht nichts.
 *   <li>Kennzeichen-Verlauf, M1 (die Bedeutung eines Betrags bleibt nach dem ersten Wert — auch
 *       bei gleichzeitigem Schreiben), beschnittene Rechte, Offboarding aller vier Tabellen und der
 *       Bestandsschutz über {@link Bestandsschutz}.
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsBezugsgroesseMigrationTest {

    private static final String DIESE = "20260913104500";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2", "bezugsdaten-vectors.json");
    private static final Path REFERENZ = Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");
    private static final List<String> TABELLEN = List.of("bezugsgroesse", "bezugsgroesse_kennzeichen_verlauf",
            "bezugsgroesse_wert", "bezugsgroesse_aenderung");

    /** Die Listen-Vokabulare des Vertrags, die diese Tabellen speichern — in der Reihenfolge der Funktion. */
    private static final List<String> LISTEN = List.of("wertart", "geltung_art", "periode_art", "herkunft_art",
            "vorgang", "status");

    /** Jede Spalte, die ein Vertragswort trägt: Tabelle, Spalte, CHECK, Vokabular. */
    private static final List<List<String>> VOKABULAR_CHECKS = List.of(
            List.of("bezugsgroesse", "wertart", "bezugsgroesse_wertart_chk", "wertart"),
            List.of("bezugsgroesse", "einheit", "bezugsgroesse_einheit_chk", "einheiten"),
            List.of("bezugsgroesse", "periode_art", "bezugsgroesse_periode_art_chk", "periode_art"),
            List.of("bezugsgroesse", "geltung_art", "bezugsgroesse_geltung_art_chk", "geltung_art"),
            List.of("bezugsgroesse_wert", "wertart", "bezugsgroesse_wert_wertart_chk", "wertart"),
            List.of("bezugsgroesse_wert", "einheit", "bezugsgroesse_wert_einheit_chk", "einheiten"),
            List.of("bezugsgroesse_wert", "periode_art", "bezugsgroesse_wert_periode_art_chk", "periode_art"),
            List.of("bezugsgroesse_wert", "herkunft_art", "bezugsgroesse_wert_herkunft_art_chk", "herkunft_art"),
            List.of("bezugsgroesse_wert", "vorgang", "bezugsgroesse_wert_vorgang_chk", "vorgang"),
            List.of("bezugsgroesse_wert", "status", "bezugsgroesse_wert_status_chk", "status"));

    /**
     * Je Periodenart eine abgeschlossene Beispielperiode (erster und letzter Tag) — für Zeilen, deren
     * Erfassungszeit die Datenbank setzt. Kommt eine Periodenart in den Vertrag, fehlt sie hier, und
     * der Vokabular-Test sagt es: sie braucht dann auch ihre Form in bezugsgroesse_wert_genau_eine_periode_chk.
     */
    private static final Map<String, LocalDate[]> BEISPIELPERIODE = Map.of(
            "tag", new LocalDate[] {LocalDate.of(2025, 10, 26), LocalDate.of(2025, 10, 26)},
            "woche", new LocalDate[] {LocalDate.of(2025, 9, 29), LocalDate.of(2025, 10, 5)},
            "monat", new LocalDate[] {LocalDate.of(2025, 10, 1), LocalDate.of(2025, 10, 31)},
            "jahr", new LocalDate[] {LocalDate.of(2025, 1, 1), LocalDate.of(2025, 12, 31)});

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static JdbcTemplate admin;
    private static JsonNode vertrag;
    /** Der Bestand vor der Migration: zwei Kundenbereiche mit Unternehmen, Standort, Orten und Messstelle. */
    private static Kunde a;
    private static Kunde b;
    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;

    private record Kunde(UUID tenant, UUID unternehmen, UUID standort, UUID gebaeude, UUID bereich, UUID messstelle) {
    }

    @BeforeAll
    static void bestandUndMigration() throws IOException {
        vertrag = new ObjectMapper().readTree(VEKTOREN.toFile());
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        a = kunde("Kunststoffwerk Ahrenberg GmbH");
        b = kunde("Kundenbereich B");
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());

        flyway().target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        flyway().load().migrate();

        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ============================================================ Vokabulare zeilengleich

    @Test
    void dieVokabulareDerDatenbankSindZeileFuerZeileDieDesVertrags() {
        List<String> ausDemVertrag = new ArrayList<>();
        for (String liste : LISTEN) {
            int nr = 0;
            for (JsonNode wort : vertrag.path("vokabulare").path(liste)) {
                ausDemVertrag.add(zeile(liste, ++nr, wort.asText(), null));
            }
        }
        int nr = 0;
        for (Map.Entry<String, JsonNode> groesse : vertrag.path("einheiten").properties()) {
            for (JsonNode einheit : groesse.getValue()) {
                ausDemVertrag.add(zeile("einheiten", ++nr, einheit.asText(), groesse.getKey()));
            }
        }
        List<String> ausDerDatenbank = root.queryForList("SELECT format('(%L, %s, %L, %L)', v.vokabular, v.nr, "
                + "v.wort, v.groesse) FROM bezugsdaten_vokabular() WITH ORDINALITY AS v(vokabular, nr, wort, "
                + "groesse, stelle) ORDER BY v.stelle", String.class);

        assertThat(ausDemVertrag).as("der Vertrag hat Vokabulare — sonst bewiese Gleichheit nichts").hasSizeGreaterThan(30);
        assertThat(ausDerDatenbank)
                .as("bezugsdaten_vokabular() weicht von %s ab. Eine NEUE Migration ersetzt die Funktion mit diesem "
                        + "VALUES-Block (CREATE OR REPLACE FUNCTION, kein CHECK wird angefasst):%n%s",
                        VEKTOREN, String.join(",\n", ausDemVertrag))
                .containsExactlyElementsOf(ausDemVertrag);
    }

    @Test
    void jederVokabularCheckFragtDieEineStelleUndTraegtKeineEigeneListe() {
        for (List<String> c : VOKABULAR_CHECKS) {
            String def = root.queryForObject("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                    + "WHERE conname = ? AND conrelid = ?::regclass", String.class, c.get(2), c.get(0));
            assertThat(def).as(c.get(2))
                    .contains("bezugsdaten_wort('" + c.get(3) + "'::text, " + c.get(1) + ")")
                    .doesNotContain(" IN (").doesNotContain("ANY");
        }
        // Keine Spalte mit einem Vertragswort ohne ihren CHECK.
        assertThat(root.queryForList("SELECT table_name || '.' || column_name FROM information_schema.columns "
                + "WHERE table_schema = 'public' AND table_name IN ('bezugsgroesse', 'bezugsgroesse_kennzeichen_verlauf', "
                + "'bezugsgroesse_wert', 'bezugsgroesse_aenderung') AND column_name IN ('wertart', 'einheit', "
                + "'periode_art', 'geltung_art', 'herkunft_art', 'vorgang', 'status')", String.class))
                .containsExactlyInAnyOrderElementsOf(VOKABULAR_CHECKS.stream().map(c -> c.get(0) + "." + c.get(1)).toList());
    }

    @Test
    void jedesWortDesVertragsIstSpeicherbarUndEinFremdesNie() {
        Kunde k = a;
        for (String einheit : einheiten()) {
            zurueckgerollt(root, () -> bezugsgroesse(root, k, "E.1", "periodenwert", einheit, "monat", "unternehmen"));
        }
        // B13: „lbs" und „Paletten" werden nie geraten; ein Synonym ist kein Wort des Vokabulars.
        for (String fremd : List.of("lbs", "Paletten", "Stk", "KG", "kWh")) {
            abgelehnt("bezugsgroesse_einheit_chk", () -> zurueckgerollt(root,
                    () -> bezugsgroesse(root, k, "E.1", "periodenwert", fremd, "monat", "unternehmen")));
        }
        for (String wertart : liste("wertart")) {
            String periode = wertart.equals("periodenwert") ? "monat" : null;
            zurueckgerollt(root, () -> bezugsgroesse(root, k, "W.1", wertart, "kg", periode, "unternehmen"));
        }
        abgelehnt("bezugsgroesse_wertart_chk", () -> zurueckgerollt(root,
                () -> bezugsgroesse(root, k, "W.1", "zaehlerstand", "kg", null, "unternehmen")));
        for (String periode : liste("periode_art")) {
            assertThat(BEISPIELPERIODE).as("Beispielperiode für " + periode).containsKey(periode);
            zurueckgerollt(root, () -> {
                UUID bg = bezugsgroesse(root, k, "P.1", "periodenwert", "kg", periode, "unternehmen");
                wert(root, mit(erstwert(k, bg), "periode_art", periode,
                        "periode_von", BEISPIELPERIODE.get(periode)[0], "periode_bis", BEISPIELPERIODE.get(periode)[1]));
            });
        }
        abgelehnt("bezugsgroesse_periode_art_chk", () -> zurueckgerollt(root,
                () -> bezugsgroesse(root, k, "P.1", "periodenwert", "kg", "quartal", "unternehmen")));

        // E1: jedes Objekt, das es gibt; Prozess und Kostenstelle haben noch keine Tabelle und darum
        // keine Verweis-Spalte — „wählbar, sobald ihre Objekte gebaut sind".
        for (String geltung : liste("geltung_art")) {
            if (Set.of("prozess", "kostenstelle").contains(geltung)) {
                assertThat(root.queryForObject("SELECT to_regclass(?) IS NULL", Boolean.class, geltung))
                        .as("die Tabelle %s ist gebaut: bezugsgroesse bekommt ihre Verweis-Spalte, und "
                                + "bezugsgroesse_geltung_objekt_chk wird abgeschrieben", geltung).isTrue();
                abgelehnt("bezugsgroesse_geltung_objekt_chk", () -> zurueckgerollt(root,
                        () -> bezugsgroesse(root, k, "G.1", "periodenwert", "kg", "monat", geltung)));
            } else {
                zurueckgerollt(root, () -> bezugsgroesse(root, k, "G.1", "periodenwert", "kg", "monat", geltung));
            }
        }
        // „ort" steht im Referenzunternehmen an der Bezugsfläche (BZ-4), ist aber kein Wort des Vertrags.
        abgelehnt("bezugsgroesse_geltung_art_chk", () -> zurueckgerollt(root, () -> root.update(
                "INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, geltung_art, "
                        + "ort_id) VALUES (?, 'G.2', 'Fläche', 'periodenwert', 'm²', 'monat', 'ort', ?)",
                k.tenant(), k.gebaeude())));
        // Die Art des Orts muss passen: ein Bereich ist kein Gebäude.
        abgelehnt("bezugsgroesse_ort_fk", () -> zurueckgerollt(root, () -> root.update(
                "INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, geltung_art, "
                        + "ort_id) VALUES (?, 'G.3', 'Halle', 'periodenwert', 'kg', 'monat', 'gebaeude', ?)",
                k.tenant(), k.bereich())));

        // Die Wörter der Werte: jedes Wort von Herkunft, Vorgang und Status steht in einer speicherbaren Fassung.
        Set<String> gezeigt = new LinkedHashSet<>();
        List<Object[]> fassungen = List.of(
                new Object[] {"eingabe", "berichtigung", "wirksam", new BigDecimal("312900")},
                new Object[] {"import", "berichtigung", "vorschlag", new BigDecimal("312900")},
                new Object[] {"messkanal", "berichtigung", "abgelehnt", new BigDecimal("312900")},
                new Object[] {"import", "ruecknahme", "zurueckgenommen", null},
                new Object[] {"import", "ruecknahme", "wirksam", new BigDecimal("312400")});
        for (Object[] f : fassungen) {
            zurueckgerollt(root, () -> {
                UUID bg = bezugsgroesse(root, k, "F.1", "periodenwert", "kg", "monat", "unternehmen");
                wert(root, mit(erstwert(k, bg), "herkunft_art", f[0], "import_kennung",
                        f[0].equals("import") ? "I-2026-0001" : null));
                wert(root, mit(erstwert(k, bg), "fassung", 2, "ersetzt_fassung", 1, "vorgang", f[1], "status", f[2],
                        "betrag", f[3], "begruendung", "ERP-Nachbuchung vom 05.11.2026", "herkunft_art", f[0],
                        "import_kennung", f[0].equals("import") ? "I-2026-0003" : null));
            });
            gezeigt.addAll(List.of("erstwert", "wirksam", (String) f[0], (String) f[1], (String) f[2]));
        }
        assertThat(gezeigt).containsAll(liste("vorgang")).containsAll(liste("status"))
                .containsAll(liste("herkunft_art").stream().filter(h -> !h.equals("stammdatum_ap02")).toList());
        // E17/M4: die Bezugsfläche wird gelesen, nie gespeichert.
        abgelehnt("bezugsgroesse_wert_herkunft_gespeichert_chk", () -> zurueckgerollt(root, () -> wert(root,
                mit(erstwert(k, bezugsgroesse(root, k, "F.2", "periodenwert", "kg", "monat", "unternehmen")),
                        "herkunft_art", "stammdatum_ap02"))));
        abgelehnt("bezugsgroesse_wert_herkunft_art_chk", () -> zurueckgerollt(root, () -> wert(root,
                mit(erstwert(k, bezugsgroesse(root, k, "F.2", "periodenwert", "kg", "monat", "unternehmen")),
                        "herkunft_art", "csv"))));
        abgelehnt("bezugsgroesse_wert_status_chk", () -> zurueckgerollt(root, () -> {
            UUID bg = bezugsgroesse(root, k, "F.3", "periodenwert", "kg", "monat", "unternehmen");
            wert(root, erstwert(k, bg));
            wert(root, mit(erstwert(k, bg), "fassung", 2, "ersetzt_fassung", 1, "vorgang", "berichtigung",
                    "status", "vorlaeufig", "begruendung", "ERP-Nachbuchung vom 05.11.2026"));
        }));
        abgelehnt("bezugsgroesse_wert_vorgang_chk", () -> zurueckgerollt(root, () -> {
            UUID bg = bezugsgroesse(root, k, "F.3", "periodenwert", "kg", "monat", "unternehmen");
            wert(root, erstwert(k, bg));
            wert(root, mit(erstwert(k, bg), "fassung", 2, "ersetzt_fassung", 1, "vorgang", "freigabe",
                    "begruendung", "Freigabe durch Jonas Wendlinger"));
        }));
        // Ein Stammdatum hat keine Fassungen je Periode (S1) — seine Gültigkeiten kommen mit IP-6.
        abgelehnt("bezugsgroesse_wert_form_chk", () -> zurueckgerollt(root, () -> wert(root,
                mit(erstwert(k, bezugsgroesse(root, k, "S.1", "stammdatum", "Personen", null, "unternehmen")),
                        "wertart", "stammdatum", "einheit", "Personen", "periode_art", null))));
    }

    // ============================================================ die Vektoren in der Tabelle

    /**
     * Jede Fassungs-Prüfung der Vektor-Datei (F1–F4, C7) als Zeilen: was der Vertrag als Fassungen
     * rechnet, ist speicherbar; was er ablehnt, lehnt die Datenbank mit ihrem CHECK ab; und aus den
     * gespeicherten Zeilen folgen der wirksame Betrag und die Status-Lesart des Vertrags.
     *
     * <p>„wirksam bis Fassung n" ist die LESART des Vertrags, nie ein gespeichertes Wort: gespeichert
     * ist das Wort, das die Fassung bei ihrem Entstehen trug — eine Rücknahme ohne Betrag war
     * {@code zurueckgenommen}. Die Fälle hängen an Prozess P-1/P-2, die noch nicht gebaut sind; als
     * Geltungsbereich steht darum das Unternehmen (die Fassungs-Regeln hängen nicht daran).
     */
    @Test
    void dieFassungenDerVektorenStehenSoInDerTabelleWieDerVertragSieRechnet() {
        Kunde k = kunde("Fassungs-Vektoren");
        String zone = vertrag.path("zeitzone").asText();
        LocalDate von = LocalDate.of(2026, 10, 1);
        LocalDate bis = LocalDate.of(2026, 10, 31);
        int geprueft = 0;
        for (JsonNode fall : vertrag.path("cases")) {
            int nr = 0;
            for (JsonNode p : fall.path("pruefungen")) {
                if (!p.path("regel").asText().equals("fassung")) {
                    continue;
                }
                String kennzeichen = fall.path("id").asText() + "." + (++nr);
                String name = kennzeichen + " " + p.path("name").asText();
                assertThat(fall.path("wertart").asText()).isEqualTo("periodenwert");
                UUID bg = bezugsgroesse(root, k, kennzeichen, "periodenwert", fall.path("einheit").asText(),
                        fall.path("periode").asText(), "unternehmen");
                JsonNode vorgaenge = p.path("eingang").path("vorgaenge");
                JsonNode fassungen = p.path("ergebnis").path("fassungen");
                Map<String, Object> basis = mit(erstwert(k, bg), "einheit", fall.path("einheit").asText(),
                        "periode_art", fall.path("periode").asText(), "periode_von", von, "periode_bis", bis,
                        "zeitzone", zone);

                // Die abgelehnten Vorgänge — die Datenbank sagt dasselbe, BEVOR etwas gespeichert ist.
                String abgelehnt = p.path("ergebnis").path("abgelehnt").asText(null);
                if (abgelehnt != null) {
                    JsonNode v = vorgaenge.get(vorgaenge.size() - 1);
                    Map<String, Object> versuch = mit(fassung(basis, v, 2, 1, "wirksam", v.path("betrag").asText(null),
                            v.path("herkunft_art").asText()), "freigeber_sub", sub(v.path("freigeber").asText(null)),
                            "freigeber_name", v.path("freigeber").asText(null),
                            "freigeber_art", v.hasNonNull("freigeber") ? "kunde" : null);
                    String constraint = switch (abgelehnt) {
                        case "begruendung_zu_kurz" -> "bezugsgroesse_wert_begruendung_chk";
                        case "ersteller_gleich_freigeber" -> "bezugsgroesse_wert_freigeber_chk";
                        default -> throw new AssertionError("unbekannte Ablehnung " + abgelehnt + " in " + name);
                    };
                    abgelehnt(constraint, () -> zurueckgerollt(root, () -> {
                        wert(root, fassung(basis, vorgaenge.get(0), 1, null, "wirksam",
                                vorgaenge.get(0).path("betrag").asText(), vorgaenge.get(0).path("herkunft_art").asText()));
                        wert(root, versuch);
                    }));
                }

                for (int i = 0; i < fassungen.size(); i++) {
                    JsonNode f = fassungen.get(i);
                    JsonNode v = vorgaenge.get(i);
                    String status = f.path("status").asText();
                    String gespeichert = status.startsWith("wirksam bis")
                            ? (f.path("betrag").isNull() ? "zurueckgenommen" : "wirksam") : status;
                    Map<String, Object> zeile = fassung(basis, v, f.path("fassung").asInt(),
                            f.path("ersetzt_fassung").isNull() ? null : f.path("ersetzt_fassung").asInt(), gespeichert,
                            f.path("betrag").asText(null), f.path("herkunft_art").asText());
                    zeile.put("import_kennung", f.path("import_kennung").asText(null));
                    zeile.put("begruendung", f.path("begruendung").asText(null));
                    if (v.hasNonNull("freigeber") && !gespeichert.equals("vorschlag")) {
                        zeile.putAll(mit(Map.of(), "freigeber_sub", sub(v.path("freigeber").asText()),
                                "freigeber_name", v.path("freigeber").asText(), "freigeber_art", "kunde"));
                    }
                    assertThat(liste("status")).as(name).contains(gespeichert);
                    wert(root, zeile);
                }

                List<Map<String, Object>> zeilen = root.queryForList("SELECT fassung, betrag, status FROM "
                        + "bezugsgroesse_wert WHERE bezugsgroesse_id = ? ORDER BY fassung", bg);
                assertThat(zeilen).as(name).hasSize(fassungen.size());
                for (int i = 0; i < zeilen.size(); i++) {
                    assertThat(lesart(zeilen, i)).as(name + " Fassung " + (i + 1))
                            .isEqualTo(fassungen.get(i).path("status").asText());
                    betragGleich(name, (BigDecimal) zeilen.get(i).get("betrag"), fassungen.get(i).path("betrag"));
                }
                List<BigDecimal> wirksam = root.queryForList("SELECT betrag FROM bezugsgroesse_wert WHERE "
                        + "bezugsgroesse_id = ? AND status IN ('wirksam', 'zurueckgenommen') ORDER BY fassung DESC "
                        + "LIMIT 1", BigDecimal.class, bg);
                betragGleich(name + " wirksamer Betrag", wirksam.get(0), p.path("ergebnis").path("wirksamer_betrag"));
                geprueft++;
            }
        }
        assertThat(geprueft).as("Fassungs-Prüfungen der Vektor-Datei").isEqualTo(13);
    }

    /**
     * Die Perioden- und Zeitfälle (Z2–Z5, E16): jede Periode, die der Vertrag bildet, ist genau EINE
     * Periode der Tabelle — halboffen in Instanten dort, Tage mit letztem Tag einschließlich hier;
     * {@code periode_passt_nicht} und {@code periode_nicht_zu_ende} lehnt die Datenbank ab.
     */
    @Test
    void diePeriodenUndZeitpunkteDerVektorenSindGenauEinePeriodeDerTabelle() {
        Kunde k = kunde("Perioden-Vektoren");
        ZoneId zone = ZoneId.of(vertrag.path("zeitzone").asText());
        DateTimeFormatter tag = DateTimeFormatter.ofPattern("dd.MM.yyyy");
        int geprueft = 0;
        for (JsonNode fall : vertrag.path("cases")) {
            for (JsonNode p : fall.path("pruefungen")) {
                String regel = p.path("regel").asText();
                JsonNode e = p.path("eingang");
                JsonNode r = p.path("ergebnis");
                String name = fall.path("id").asText() + " " + p.path("name").asText();
                if (regel.equals("periode")) {
                    String art = e.path("periode_art").asText();
                    OffsetDateTime jetzt = OffsetDateTime.parse(e.path("jetzt").asText());
                    UUID bg = bezugsgroesse(root, k, "P" + (++geprueft), "periodenwert", "kg", art, "unternehmen");
                    String befund = r.path("befund").asText(null);
                    if (befund == null) {
                        OffsetDateTime anfang = OffsetDateTime.parse(r.path("von").asText());
                        OffsetDateTime ende = OffsetDateTime.parse(r.path("bis").asText());
                        assertThat(anfang.atZoneSameInstant(zone).toLocalTime()).as(name).isEqualTo("00:00");
                        LocalDate von = anfang.atZoneSameInstant(zone).toLocalDate();
                        LocalDate bis = ende.atZoneSameInstant(zone).toLocalDate().minusDays(1);
                        wert(root, periodenwert(k, bg, art, von, bis, jetzt));
                    } else if (befund.equals("periode_nicht_zu_ende")) {
                        YearMonth monat = YearMonth.parse(e.path("text").asText());
                        abgelehnt("bezugsgroesse_wert_abgeschlossen_chk", () -> wert(root,
                                periodenwert(k, bg, art, monat.atDay(1), monat.atEndOfMonth(), jetzt)));
                    } else {
                        assertThat(befund).as(name).isEqualTo("periode_passt_nicht");
                        LocalDate von;
                        LocalDate bis;
                        if (e.hasNonNull("von_text")) {
                            von = LocalDate.parse(e.path("von_text").asText(), tag);
                            bis = LocalDate.parse(e.path("bis_text").asText(), tag);
                        } else {
                            assertThat(e.path("deutung").asText()).as(name).isEqualTo("periodenbeginn");
                            von = LocalDate.parse(e.path("text").asText(), tag);
                            bis = von.plusMonths(1).minusDays(1);
                        }
                        // Die Form hängt nicht an der Uhr: erfasst nach dem Ende des Zeitraums, damit genau sie spricht.
                        OffsetDateTime danach = bis.plusDays(2).atStartOfDay(zone).toOffsetDateTime();
                        abgelehnt("bezugsgroesse_wert_genau_eine_periode_chk", () -> wert(root,
                                periodenwert(k, bg, art, von, bis, jetzt.isAfter(danach) ? jetzt : danach)));
                    }
                } else if (regel.equals("zeit") && r.hasNonNull("zeitpunkt")) {
                    OffsetDateTime zeitpunkt = OffsetDateTime.parse(r.path("zeitpunkt").asText());
                    UUID bg = bezugsgroesse(root, k, "Z" + (++geprueft), "stand", "m³", null, "messstelle");
                    wert(root, mit(erstwert(k, bg), "wertart", "stand", "einheit", "m³", "periode_art", null,
                            "periode_von", null, "periode_bis", null, "zeitpunkt", zeitpunkt, "created_at", zeitpunkt));
                    abgelehnt("bezugsgroesse_wert_volle_minute", () -> wert(root, mit(erstwert(k, bg),
                            "wertart", "stand", "einheit", "m³", "periode_art", null, "periode_von", null,
                            "periode_bis", null, "zeitpunkt", zeitpunkt.plusSeconds(30),
                            "created_at", zeitpunkt.plusMinutes(1))));
                }
            }
        }
        assertThat(geprueft).as("Perioden- und Zeitpunkt-Prüfungen der Vektor-Datei").isEqualTo(10);
    }

    @Test
    void dieBezugsgroessenDesReferenzunternehmensSprechenDasVokabularDerTabelle() throws IOException {
        Kunde k = kunde("Referenz");
        for (JsonNode bz : new ObjectMapper().readTree(REFERENZ.toFile()).path("bezugsgroessen")) {
            String kz = bz.path("kennzeichen").asText();
            String geltung = bz.path("geltung_art").asText();
            String periode = bz.path("periode_code").asText(null);
            if (bz.path("wertart").asText().equals("stammdatum")) {
                // BZ-4: die Bezugsfläche steht zeitgültig am Gebäude (AP-02) und wird gelesen (E17) — nie hier.
                assertThat(kz).isEqualTo("BZ-4");
                continue;
            }
            if (geltung.equals("prozess")) {
                abgelehnt("bezugsgroesse_geltung_objekt_chk", () -> bezugsgroesse(root, k, kz,
                        bz.path("wertart").asText(), bz.path("einheit_code").asText(), periode, geltung));
            } else {
                bezugsgroesse(root, k, kz, bz.path("wertart").asText(), bz.path("einheit_code").asText(), periode, geltung);
            }
        }
        assertThat(root.queryForList("SELECT kennzeichen FROM bezugsgroesse WHERE tenant_id = ?", String.class, k.tenant()))
                .containsExactly("BZ-5");
    }

    // ============================================================ nie überschrieben

    @Test
    void einUpdateAufEinenWertWirdVonJederRolleAbgelehntUndEineBerichtigungIstEineNeueFassung() {
        Kunde k = kunde("Fassungen");
        UUID bg = als(k.tenant(), () -> bezugsgroesse(app, k, "BZ-0002", "periodenwert", "Stück", "monat", "unternehmen"));
        Map<String, Object> erst = mit(erstwert(k, bg), "einheit", "Stück", "betrag", new BigDecimal("4820"));
        UUID f1 = als(k.tenant(), () -> wert(app, erst));

        // Die App-Rolle hat weder UPDATE noch DELETE …
        verweigert(() -> alsTue(k.tenant(), () -> app.update("UPDATE bezugsgroesse_wert SET betrag = 48200 WHERE id = ?", f1)));
        verweigert(() -> alsTue(k.tenant(), () -> app.update("DELETE FROM bezugsgroesse_wert WHERE id = ?", f1)));
        verweigert(() -> admin.update("UPDATE bezugsgroesse_wert SET betrag = 48200 WHERE id = ?", f1));
        // … aber der Schutz ist der TRIGGER: die Verwaltungsrolle MIT Recht und der Eigentümer scheitern auch.
        abgelehnt("bezugsgroesse_wert_append_only", () -> zurueckgerollt(root, () -> {
            root.execute("GRANT UPDATE ON bezugsgroesse_wert TO " + ADMIN_USER);
            root.execute("SET LOCAL ROLE " + ADMIN_USER);
            root.update("UPDATE bezugsgroesse_wert SET betrag = 48200 WHERE id = ?", f1);
        }));
        abgelehnt("bezugsgroesse_wert_append_only",
                () -> root.update("UPDATE bezugsgroesse_wert SET betrag = 48200 WHERE id = ?", f1));
        abgelehnt("bezugsgroesse_wert_append_only",
                () -> root.update("UPDATE bezugsgroesse_wert SET status = status WHERE id = ?", f1));
        assertThat(root.queryForObject("SELECT has_table_privilege(?, 'bezugsgroesse_wert', 'UPDATE')", Boolean.class,
                ADMIN_USER)).as("das GRANT der Probe ist zurückgerollt").isFalse();

        // Die Berichtigung (B5): Fassung 2 mit Begründung; Fassung 1 bleibt lesbar.
        als(k.tenant(), () -> wert(app, mit(erst, "fassung", 2, "ersetzt_fassung", 1, "vorgang", "berichtigung",
                "betrag", new BigDecimal("48200"), "begruendung", "Tippfehler — eine Null fehlte (Montagebericht Oktober)")));
        assertThat(als(k.tenant(), () -> app.queryForList("SELECT betrag FROM bezugsgroesse_wert WHERE bezugsgroesse_id = ? "
                + "ORDER BY fassung", BigDecimal.class, bg))).usingElementComparator(BigDecimal::compareTo)
                .containsExactly(new BigDecimal("4820"), new BigDecimal("48200"));
        // Lückenlos: keine übersprungene und keine doppelte Fassung.
        abgelehnt("bezugsgroesse_wert_fassung_lueckenlos", () -> alsTue(k.tenant(), () -> wert(app, mit(erst,
                "fassung", 4, "ersetzt_fassung", 2, "vorgang", "berichtigung", "begruendung", "noch eine Berichtigung"))));
        abgelehnt("bezugsgroesse_wert_fassung_lueckenlos", () -> alsTue(k.tenant(), () -> wert(app, mit(erst,
                "fassung", 2, "ersetzt_fassung", 1, "vorgang", "berichtigung", "begruendung", "noch eine Berichtigung"))));
        abgelehnt("bezugsgroesse_wert_begruendung_chk", () -> alsTue(k.tenant(), () -> wert(app, mit(erst,
                "fassung", 3, "ersetzt_fassung", 2, "vorgang", "berichtigung", "begruendung", null))));
        // Die Erfassungszeit setzt die Datenbank, nie die App.
        verweigert(() -> alsTue(k.tenant(), () -> wert(app, mit(erst, "fassung", 3, "ersetzt_fassung", 2,
                "vorgang", "berichtigung", "begruendung", "noch eine Berichtigung",
                "created_at", OffsetDateTime.parse("2030-01-01T00:00:00Z")))));

        // Belegung und Protokoll: nie geändert — auch nicht vom Eigentümer.
        alsTue(k.tenant(), () -> protokoll(app, k.tenant(), bg, "angelegt"));
        abgelehntMitMeldung("audit rows are append-only",
                () -> root.update("UPDATE bezugsgroesse_kennzeichen_verlauf SET belegt_am = now() WHERE bezugsgroesse_id = ?", bg));
        abgelehntMitMeldung("audit rows are append-only",
                () -> root.update("UPDATE bezugsgroesse_aenderung SET grund = 'x' WHERE bezugsgroesse_id = ?", bg));
    }

    // ============================================================ Mandantenzaun

    @Test
    void derMandantenzaunHaeltGegenEinenFremdenKundenbereich() {
        UUID bgA = als(a.tenant(), () -> bezugsgroesse(app, a, "BZ-0001", "periodenwert", "kg", "monat", "standort"));
        als(a.tenant(), () -> wert(app, erstwert(a, bgA)));
        alsTue(a.tenant(), () -> protokoll(app, a.tenant(), bgA, "angelegt"));

        for (String tabelle : TABELLEN) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = ?",
                    Boolean.class, tabelle)).as("ENABLE + FORCE an " + tabelle).isTrue();
            assertThat(root.queryForObject("SELECT count(*) FROM pg_policies WHERE tablename = ? AND qual LIKE "
                    + "'%app.tenant_id%' AND with_check LIKE '%app.tenant_id%'", Long.class, tabelle))
                    .as("Policy mit USING und WITH CHECK an " + tabelle).isOne();
            assertThat(app.queryForObject("SELECT count(*) FROM " + tabelle, Long.class)).as("ohne Mandant: nichts").isZero();
            assertThat(als(b.tenant(), () -> app.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?",
                    Long.class, a.tenant()))).as("B sieht A nicht in " + tabelle).isZero();
            assertThat(als(a.tenant(), () -> app.queryForObject("SELECT count(*) FROM " + tabelle, Long.class)))
                    .as("A sieht sich in " + tabelle).isPositive();
        }
        // B schreibt nie in A hinein — weder als A noch über einen Verweis auf A.
        verweigert(() -> alsTue(b.tenant(), () -> bezugsgroesse(app, a, "BZ-0009", "periodenwert", "kg", "monat", "standort")));
        abgelehnt("bezugsgroesse_standort_fk", () -> alsTue(b.tenant(), () -> app.update(
                "INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, geltung_art, "
                        + "standort_id) VALUES (?, 'BZ-0009', 'Fremd', 'periodenwert', 'kg', 'monat', 'standort', ?)",
                b.tenant(), a.standort())));
        abgelehnt("bezugsgroesse_wert_bedeutung_fk", () -> alsTue(b.tenant(), () -> wert(app, erstwert(b, bgA))));
        assertThat(als(b.tenant(), () -> app.update("UPDATE bezugsgroesse SET name = 'übernommen' WHERE id = ?", bgA)))
                .isZero();
        // Das Kennzeichen ist je Kundenbereich eindeutig: B darf dasselbe tragen, und die Ablehnung verrät nichts.
        als(b.tenant(), () -> bezugsgroesse(app, b, "BZ-0001", "periodenwert", "kg", "monat", "unternehmen"));
        assertThat(root.queryForObject("SELECT name FROM bezugsgroesse WHERE id = ?", String.class, bgA))
                .isEqualTo("Bezugsgröße BZ-0001");
    }

    @Test
    void dieRechteSindBeschnitten() {
        assertThat(rechte(APP_USER, "bezugsgroesse")).isEqualTo("SI");
        assertThat(rechte(APP_USER, "bezugsgroesse_kennzeichen_verlauf")).isEqualTo("S");
        assertThat(rechte(APP_USER, "bezugsgroesse_wert")).isEqualTo("S");
        assertThat(rechte(APP_USER, "bezugsgroesse_aenderung")).isEqualTo("SI");
        for (String tabelle : TABELLEN) {
            assertThat(rechte(ADMIN_USER, tabelle)).as("die Verwaltung liest und löscht (Offboarding): " + tabelle)
                    .isEqualTo("SD");
        }
        for (String spalte : List.of("kennzeichen", "name", "einheit", "geltung_art", "standort_id", "archiviert_am")) {
            assertThat(spalte(APP_USER, "bezugsgroesse", spalte, "UPDATE")).as(spalte).isTrue();
        }
        for (String spalte : List.of("id", "tenant_id", "ort_art", "created_at")) {
            assertThat(spalte(APP_USER, "bezugsgroesse", spalte, "UPDATE")).as(spalte).isFalse();
        }
        assertThat(spalte(APP_USER, "bezugsgroesse_wert", "betrag", "INSERT")).isTrue();
        assertThat(spalte(APP_USER, "bezugsgroesse_wert", "created_at", "INSERT")).isFalse();
        assertThat(root.queryForObject("SELECT has_any_column_privilege(?, 'bezugsgroesse_wert', 'UPDATE')",
                Boolean.class, APP_USER)).isFalse();
        for (String rolle : List.of(APP_USER, ADMIN_USER)) {
            assertThat(root.queryForObject("SELECT has_sequence_privilege(?, 'bezugsgroesse_aenderung_id_seq', 'USAGE')",
                    Boolean.class, rolle)).as("Sequenz-Recht " + rolle).isTrue();
        }
        verweigert(() -> alsTue(a.tenant(), () -> app.update("INSERT INTO bezugsgroesse_kennzeichen_verlauf "
                + "(tenant_id, kennzeichen, bezugsgroesse_id) VALUES (?, 'BZ-7777', ?)", a.tenant(), UUID.randomUUID())));
    }

    // ============================================================ Kennzeichen und Bedeutung

    @Test
    void einEinmalVergebenesKennzeichenBleibtBelegt() {
        Kunde k = kunde("Kennzeichen");
        UUID erste = als(k.tenant(), () -> bezugsgroesse(app, k, "BZ-0001", "periodenwert", "kg", "monat", "unternehmen"));
        alsTue(k.tenant(), () -> app.update("UPDATE bezugsgroesse SET kennzeichen = 'BZ-0010' WHERE id = ?", erste));
        assertThat(verlauf(k)).containsExactly("BZ-0001", "BZ-0010");

        abgelehnt("bezugsgroesse_kennzeichen_belegt", () -> alsTue(k.tenant(),
                () -> bezugsgroesse(app, k, "BZ-0001", "periodenwert", "kg", "monat", "unternehmen")));
        // Zurück zum EIGENEN früheren Kennzeichen: erlaubt, ohne neue Belegung.
        alsTue(k.tenant(), () -> app.update("UPDATE bezugsgroesse SET kennzeichen = 'BZ-0001', archiviert_am = now() "
                + "WHERE id = ?", erste));
        assertThat(verlauf(k)).containsExactly("BZ-0001", "BZ-0010");
        // Das früher getragene BZ-0010 bekommt keine andere — auch nicht, wenn die erste archiviert ist.
        abgelehnt("bezugsgroesse_kennzeichen_belegt", () -> alsTue(k.tenant(),
                () -> bezugsgroesse(app, k, "BZ-0010", "periodenwert", "kg", "monat", "unternehmen")));
        abgelehnt("bezugsgroesse_kennzeichen_eindeutig", () -> alsTue(k.tenant(),
                () -> bezugsgroesse(app, k, "BZ-0001", "periodenwert", "kg", "monat", "unternehmen")));
        abgelehnt("bezugsgroesse_kennzeichen_format", () -> alsTue(k.tenant(),
                () -> bezugsgroesse(app, k, "bz-0002", "periodenwert", "kg", "monat", "unternehmen")));
    }

    /** M1: alles außer Name und Kennzeichen ist nach dem ersten Wert unveränderlich — vorher nicht. */
    @Test
    void dieBedeutungEinesBetragsBleibtNachDemErstenWert() {
        Kunde k = kunde("Bedeutung");
        UUID bg = als(k.tenant(), () -> bezugsgroesse(app, k, "BZ-0001", "periodenwert", "t", "woche", "unternehmen"));
        // Vor dem ersten Wert: frei.
        alsTue(k.tenant(), () -> app.update("UPDATE bezugsgroesse SET einheit = 'kg', periode_art = 'monat', "
                + "geltung_art = 'standort', unternehmen_id = NULL, standort_id = ? WHERE id = ?", k.standort(), bg));
        als(k.tenant(), () -> wert(app, erstwert(k, bg)));

        abgelehnt("bezugsgroesse_wert_bedeutung_fk", () -> alsTue(k.tenant(),
                () -> app.update("UPDATE bezugsgroesse SET einheit = 't' WHERE id = ?", bg)));
        abgelehnt("bezugsgroesse_wert_periode_fk", () -> alsTue(k.tenant(),
                () -> app.update("UPDATE bezugsgroesse SET periode_art = 'jahr' WHERE id = ?", bg)));
        abgelehnt("bezugsgroesse_geltung_nach_erstem_wert", () -> alsTue(k.tenant(), () -> app.update(
                "UPDATE bezugsgroesse SET geltung_art = 'gebaeude', standort_id = NULL, ort_id = ? WHERE id = ?",
                k.gebaeude(), bg)));
        // Ein Wert zeigt nie eine andere Einheit als seine Bezugsgröße.
        abgelehnt("bezugsgroesse_wert_bedeutung_fk", () -> alsTue(k.tenant(), () -> wert(app, mit(erstwert(k, bg),
                "einheit", "t", "periode_von", LocalDate.of(2025, 9, 1), "periode_bis", LocalDate.of(2025, 9, 30)))));
        // Name und Kennzeichen bleiben änderbar.
        alsTue(k.tenant(), () -> app.update("UPDATE bezugsgroesse SET name = 'Produktionsmenge Spritzguss', "
                + "kennzeichen = 'BZ-1' WHERE id = ?", bg));
    }

    /**
     * Die Gleichzeitigkeit zu M1: ein erster Wert, der NOCH NICHT bestätigt ist, lässt die Änderung des
     * Geltungsbereichs warten (die Geltungs-Spalten sind Schlüssel-Spalten, siehe
     * bezugsgroesse_geltung_uq) — nach seiner Bestätigung lehnt der Trigger ab. Ohne das Warten sähe der
     * Trigger „kein Wert" und die Bezugsgröße wechselte ihr Objekt unter einem Wert.
     */
    @Test
    void derGeltungsbereichWartetAufEinenGleichzeitigenErstenWert() throws Exception {
        Kunde k = kunde("Gleichzeitig");
        UUID bg = als(k.tenant(), () -> bezugsgroesse(app, k, "BZ-0001", "periodenwert", "kg", "monat", "unternehmen"));
        DataSource roh = ds(APP_USER, APP_PW);
        ExecutorService zweite = Executors.newSingleThreadExecutor();
        try (Connection wertVerbindung = roh.getConnection(); Connection geltungVerbindung = roh.getConnection()) {
            JdbcTemplate wertSitzung = sitzung(wertVerbindung, k.tenant());
            JdbcTemplate geltungSitzung = sitzung(geltungVerbindung, k.tenant());
            wert(wertSitzung, erstwert(k, bg));

            Future<Integer> aenderung = zweite.submit(() -> geltungSitzung.update("UPDATE bezugsgroesse SET "
                    + "geltung_art = 'standort', unternehmen_id = NULL, standort_id = ? WHERE id = ?", k.standort(), bg));
            warteBis(() -> root.queryForObject("SELECT count(*) FROM pg_stat_activity WHERE usename = ? "
                    + "AND wait_event_type = 'Lock'", Integer.class, APP_USER) == 1);
            assertThat(aenderung.isDone()).as("die Änderung wartet auf den unbestätigten ersten Wert").isFalse();

            wertVerbindung.commit();
            abgelehnt("bezugsgroesse_geltung_nach_erstem_wert", () -> {
                try {
                    aenderung.get(20, TimeUnit.SECONDS);
                } catch (Exception e) {
                    throw new IllegalStateException(e.getCause() != null ? e.getCause() : e);
                }
            });
            geltungVerbindung.rollback();
        } finally {
            zweite.shutdownNow();
        }
        assertThat(root.queryForObject("SELECT geltung_art FROM bezugsgroesse WHERE id = ?", String.class, bg))
                .isEqualTo("unternehmen");
    }

    // ============================================================ Offboarding + Bestandsschutz

    /** PR 706: eine vergessene Tabelle lässt einen Kundenbereich nicht mehr löschen. Alle vier, Kinder zuerst. */
    @Test
    void dasOffboardingRaeumtAlleVierTabellenAb() {
        Kunde k = kunde("Offboarding");
        UUID bg = als(k.tenant(), () -> bezugsgroesse(app, k, "BZ-0001", "periodenwert", "kg", "monat", "gebaeude"));
        als(k.tenant(), () -> bezugsgroesse(app, k, "BZ-0002", "stand", "m³", null, "messstelle"));
        alsTue(k.tenant(), () -> app.update("UPDATE bezugsgroesse SET kennzeichen = 'BZ-0003' WHERE id = ?", bg));
        als(k.tenant(), () -> wert(app, erstwert(k, bg)));
        als(k.tenant(), () -> wert(app, mit(erstwert(k, bg), "fassung", 2, "ersetzt_fassung", 1, "vorgang", "ruecknahme",
                "status", "zurueckgenommen", "betrag", null, "begruendung", "Falsche Artikelgruppe exportiert")));
        alsTue(k.tenant(), () -> protokoll(app, k.tenant(), bg, "angelegt"));
        Map<String, Long> vorher = new LinkedHashMap<>();
        for (String tabelle : TABELLEN) {
            vorher.put(tabelle, zahl(tabelle, k.tenant()));
        }
        assertThat(vorher).as("jede Tabelle hat Zeilen des Kundenbereichs").allSatisfy((t, n) -> assertThat(n).isPositive());
        Map<String, Long> andere = new LinkedHashMap<>();
        for (String tabelle : TABELLEN) {
            andere.put(tabelle, root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id <> ?",
                    Long.class, k.tenant()));
        }

        new TenantRepository(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW))).offboard(k.tenant());

        for (String tabelle : List.of("bezugsgroesse_wert", "bezugsgroesse_kennzeichen_verlauf", "bezugsgroesse",
                "bezugsgroesse_aenderung", "messstelle", "ort", "standort", "unternehmen")) {
            assertThat(zahl(tabelle, k.tenant())).as(tabelle).isZero();
        }
        assertThat(root.queryForObject("SELECT count(*) FROM tenant WHERE id = ?", Long.class, k.tenant())).isZero();
        for (String tabelle : TABELLEN) {
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id <> ?", Long.class,
                    k.tenant())).as("andere Kundenbereiche bleiben: " + tabelle).isEqualTo(andere.get(tabelle));
        }
    }

    @Test
    void dieMigrationLegtNurDanebenUndLaesstDenBestandZeichengleich() {
        assertThat(fingerVorher).hasSizeGreaterThan(100).doesNotContainKeys(TABELLEN.toArray(String[]::new));
        assertThat(fingerVorher.get("standort")).as("es gibt Bestand").isNotEqualTo(Bestandsschutz.LEER);
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
        for (String tabelle : TABELLEN) {
            assertThat(fingerNachMigration).as(tabelle).containsEntry(tabelle, Bestandsschutz.LEER);
        }
    }

    /** Der Vergleich beißt noch: eine geänderte Bestandszeile und eine neue Tabelle mit Inhalt fallen auf. */
    @Test
    void derBestandsvergleichFaengtEineGeaenderteZeile() {
        Bestandsschutz.mutationsprobe(root, List.of(), "unternehmen", "UPDATE unternehmen SET name = name || ' (Probe)'");
    }

    // ===================================================================== Gerüst

    private static String zeile(String vokabular, int nr, String wort, String groesse) {
        return "('" + vokabular + "', " + nr + ", '" + wort.replace("'", "''") + "', "
                + (groesse == null ? "NULL" : "'" + groesse + "'") + ")";
    }

    private static List<String> liste(String vokabular) {
        List<String> aus = new ArrayList<>();
        vertrag.path("vokabulare").path(vokabular).forEach(w -> aus.add(w.asText()));
        assertThat(aus).as("Vokabular " + vokabular).isNotEmpty();
        return aus;
    }

    private static List<String> einheiten() {
        List<String> aus = new ArrayList<>();
        vertrag.path("einheiten").forEach(g -> g.forEach(e -> aus.add(e.asText())));
        return aus;
    }

    /** Die Status-Lesart des Vertrags aus gespeicherten Zeilen: eine wirksame Fassung mit späterer wirksamer ist „wirksam bis Fassung n". */
    private static String lesart(List<Map<String, Object>> zeilen, int i) {
        String status = (String) zeilen.get(i).get("status");
        if (!Set.of("wirksam", "zurueckgenommen").contains(status)) {
            return status;
        }
        for (int j = i + 1; j < zeilen.size(); j++) {
            if (Set.of("wirksam", "zurueckgenommen").contains((String) zeilen.get(j).get("status"))) {
                return "wirksam bis Fassung " + zeilen.get(j).get("fassung");
            }
        }
        return status;
    }

    private static void betragGleich(String name, BigDecimal gespeichert, JsonNode erwartet) {
        if (erwartet.isNull()) {
            assertThat(gespeichert).as(name).isNull();
        } else {
            assertThat(gespeichert).as(name).isEqualByComparingTo(erwartet.asText());
        }
    }

    private static Map<String, Object> fassung(Map<String, Object> basis, JsonNode vorgang, int fassung,
            Integer ersetzt, String status, String betrag, String herkunft) {
        String urheber = vorgang.path("urheber").asText();
        return mit(basis, "fassung", fassung, "ersetzt_fassung", ersetzt, "vorgang", vorgang.path("art").asText(),
                "status", status, "betrag", betrag == null ? null : new BigDecimal(betrag),
                "begruendung", vorgang.path("begruendung").asText(null), "herkunft_art", herkunft,
                "import_kennung", vorgang.path("import_kennung").asText(null),
                "actor_sub", sub(urheber), "actor_name", urheber, "actor_rolle", rolle(urheber),
                "created_at", OffsetDateTime.parse(vorgang.path("zeitpunkt").asText()));
    }

    /** „Ines Kaltenbach (Energiemanager)" → „sub-ines-kaltenbach". */
    private static String sub(String person) {
        return person == null ? null
                : "sub-" + person.replaceAll("\\s*\\(.*\\)", "").toLowerCase().replace(' ', '-');
    }

    private static String rolle(String person) {
        return person.contains("(Kundenadministrator)") ? "kundenadministrator" : "energiemanager";
    }

    private static Map<String, Object> periodenwert(Kunde k, UUID bg, String art, LocalDate von, LocalDate bis,
            OffsetDateTime erfasst) {
        return mit(erstwert(k, bg), "periode_art", art, "periode_von", von, "periode_bis", bis, "created_at", erfasst);
    }

    /** Ein Erstwert Oktober 2025 (abgeschlossen), 312 400 kg, eingegeben von Ines Kaltenbach. */
    private static Map<String, Object> erstwert(Kunde k, UUID bg) {
        return mit(Map.of(), "tenant_id", k.tenant(), "bezugsgroesse_id", bg, "wertart", "periodenwert",
                "einheit", "kg", "periode_art", "monat", "periode_von", LocalDate.of(2025, 10, 1),
                "periode_bis", LocalDate.of(2025, 10, 31), "zeitzone", "Europe/Berlin", "fassung", 1,
                "vorgang", "erstwert", "status", "wirksam", "betrag", new BigDecimal("312400"),
                "herkunft_art", "eingabe", "actor_sub", "sub-ines-kaltenbach", "actor_name", "Ines Kaltenbach",
                "actor_rolle", "energiemanager", "actor_art", "kunde");
    }

    private static Map<String, Object> mit(Map<String, Object> basis, Object... paare) {
        Map<String, Object> aus = new LinkedHashMap<>(basis);
        for (int i = 0; i < paare.length; i += 2) {
            aus.put((String) paare[i], paare[i + 1]);
        }
        return aus;
    }

    private static UUID wert(JdbcTemplate db, Map<String, Object> spalten) {
        String platzhalter = spalten.keySet().stream().map(s -> s.equals("kennzeichen") ? "CAST(? AS jsonb)" : "?")
                .collect(Collectors.joining(", "));
        return db.queryForObject("INSERT INTO bezugsgroesse_wert (" + String.join(", ", spalten.keySet()) + ") VALUES ("
                + platzhalter + ") RETURNING id", UUID.class, spalten.values().toArray());
    }

    private static UUID bezugsgroesse(JdbcTemplate db, Kunde k, String kennzeichen, String wertart, String einheit,
            String periodeArt, String geltungArt) {
        Map<String, Object> spalten = mit(Map.of(), "tenant_id", k.tenant(), "kennzeichen", kennzeichen,
                "name", "Bezugsgröße " + kennzeichen, "wertart", wertart, "einheit", einheit, "periode_art", periodeArt,
                "geltung_art", geltungArt);
        switch (geltungArt) {
            case "unternehmen" -> spalten.put("unternehmen_id", k.unternehmen());
            case "standort" -> spalten.put("standort_id", k.standort());
            case "gebaeude" -> spalten.put("ort_id", k.gebaeude());
            case "bereich" -> spalten.put("ort_id", k.bereich());
            case "messstelle" -> spalten.put("messstelle_id", k.messstelle());
            default -> { } // Prozess, Kostenstelle: noch kein Objekt
        }
        return db.queryForObject("INSERT INTO bezugsgroesse (" + String.join(", ", spalten.keySet()) + ") VALUES ("
                + String.join(", ", java.util.Collections.nCopies(spalten.size(), "?")) + ") RETURNING id",
                UUID.class, spalten.values().toArray());
    }

    private static void protokoll(JdbcTemplate db, UUID tenant, UUID bg, String art) {
        db.update("INSERT INTO bezugsgroesse_aenderung (tenant_id, bezugsgroesse_id, art, neu, gilt_ab, rueckwirkend, "
                + "actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, ?, '{\"name\":\"Produktionsmenge\"}', "
                + "date_trunc('minute', now()), false, 'sub-ines-kaltenbach', 'Ines Kaltenbach', 'energiemanager', 'kunde')",
                tenant, bg, art);
    }

    private static List<String> verlauf(Kunde k) {
        return root.queryForList("SELECT kennzeichen FROM bezugsgroesse_kennzeichen_verlauf WHERE tenant_id = ? "
                + "ORDER BY kennzeichen", String.class, k.tenant());
    }

    private static long zahl(String tabelle, UUID tenant) {
        return root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?", Long.class, tenant);
    }

    /** Ein Kundenbereich mit Unternehmen, Standort, Gebäude, Bereich und Messstelle — geschrieben wie der Bestand. */
    private static Kunde kunde(String name) {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, name);
        UUID st = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        UUID g = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) "
                + "VALUES (?, 'gebaeude', 'Halle 2', 'G-2', 'aktiv') RETURNING id", UUID.class, t);
        UUID be = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) "
                + "VALUES (?, 'bereich', 'Halle 1 Nord', 'B-1', 'aktiv') RETURNING id", UUID.class, t);
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-14', 'Ladepunkt Halle 2', 'gemessen', 'Strom', "
                + "'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, t);
        return new Kunde(t, u, st, g, be, ms);
    }

    private static JdbcTemplate sitzung(Connection verbindung, UUID tenant) throws java.sql.SQLException {
        verbindung.setAutoCommit(false);
        JdbcTemplate db = new JdbcTemplate(new SingleConnectionDataSource(verbindung, true));
        db.queryForObject("SELECT set_config('app.tenant_id', ?, false)", String.class, tenant.toString());
        return db;
    }

    private static void warteBis(BooleanSupplier bedingung) throws InterruptedException {
        for (int i = 0; i < 200 && !bedingung.getAsBoolean(); i++) {
            Thread.sleep(50);
        }
        assertThat(bedingung.getAsBoolean()).as("die zweite Sitzung wartet auf die Sperre").isTrue();
    }

    private static String rechte(String rolle, String tabelle) {
        StringBuilder s = new StringBuilder();
        for (String[] r : new String[][] {{"S", "SELECT"}, {"I", "INSERT"}, {"U", "UPDATE"}, {"D", "DELETE"},
                {"T", "TRUNCATE"}}) {
            if (Boolean.TRUE.equals(root.queryForObject("SELECT has_table_privilege(?, ?, ?)", Boolean.class, rolle,
                    tabelle, r[1]))) {
                s.append(r[0]);
            }
        }
        return s.toString();
    }

    private static boolean spalte(String rolle, String tabelle, String spalte, String recht) {
        return Boolean.TRUE.equals(root.queryForObject("SELECT has_column_privilege(?, ?, ?, ?)", Boolean.class,
                rolle, tabelle, spalte, recht));
    }

    private static void zurueckgerollt(JdbcTemplate db, Runnable arbeit) {
        new TransactionTemplate(new DataSourceTransactionManager(db.getDataSource())).executeWithoutResult(status -> {
            status.setRollbackOnly();
            arbeit.run();
        });
    }

    private static <T> T als(UUID tenant, Supplier<T> arbeit) {
        TenantContext.set(tenant);
        try {
            return arbeit.get();
        } finally {
            TenantContext.clear();
        }
    }

    private static void alsTue(UUID tenant, Runnable arbeit) {
        als(tenant, () -> {
            arbeit.run();
            return null;
        });
    }

    private static PSQLException psql(Runnable arbeit, String erwartet) {
        Throwable t = null;
        try {
            arbeit.run();
        } catch (Throwable e) {
            t = e;
        }
        assertThat(t).as("die Datenbank muss ablehnen (" + erwartet + ")").isNotNull();
        PSQLException p = null;
        for (Throwable c = t; c != null; c = c.getCause()) {
            if (c instanceof PSQLException pe) {
                p = pe;
            }
        }
        assertThat((Object) p).as("eine PSQLException: " + t).isNotNull();
        return p;
    }

    private static void abgelehnt(String constraint, Runnable arbeit) {
        PSQLException p = psql(arbeit, constraint);
        assertThat(p.getServerErrorMessage().getConstraint()).as(p.getMessage()).isEqualTo(constraint);
    }

    private static void abgelehntMitMeldung(String meldung, Runnable arbeit) {
        PSQLException p = psql(arbeit, meldung);
        assertThat(p.getMessage()).contains(meldung);
    }

    private static void verweigert(Runnable arbeit) {
        PSQLException p = psql(arbeit, "42501");
        assertThat(p.getSQLState()).as(p.getMessage()).isEqualTo("42501");
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
