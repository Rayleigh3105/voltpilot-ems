package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Date;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.UUID;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Bestandsschutz des Energiemanagements (UEMS AP-19 IP-25, NW-5, R15, Invariante 7): ein Bestandskunde, der kein
 * Dokument, keine Aufgabe und kein Audit anlegt, merkt nichts — der Rollout ändert keine Zeile seines Bestands, und die
 * AP-18-Maßnahmen und alle Stände von AP-12/16/17/18 bleiben byte-gleich, auch nach dem Tausch des Herkunft-CHECKs,
 * dem neuen Wort „Einsicht“, den getrennten Lese-Kennungen und der Vorlage Nr. 7.
 *
 * <p><b>Der Bestand</b> ist Werk Ahrenberg aus dem Demo-Seed ({@code infra/local/seed/ahrenberg.sql}, Fassung 1.4) auf
 * der Fassung VOR der ersten AP-19-Migration ({@link #ERSTE_AP19}), dazu je ein Stand jedes Vorgängers: ein
 * Monatsbericht (AP-12), eine energetische Bewertung (AP-16), ein Leistungsvergleich an der Energieleistungskennzahl
 * KZ-0004 mit freigegebener Bezugsbasis BB-0001 (AP-17) — alle drei mit Stand Nr. 1 und Prüfsumme, der Monatsbericht mit
 * einem protokollierten Abruf —, ein Energieziel und zwei Maßnahmen mit den Herkünften {@code von_hand} und
 * {@code energieziel}, eine davon mit Bewertung Stand Nr. 1 (AP-18). Danach laufen die Migrationen bis zur letzten von
 * AP-19 ({@link #LETZTE_AP19}, Abdruck für „genau diese Tabellen, Vokabulare und CHECKs“) und dann ALLE späteren.
 *
 * <p><b>Was sich außerhalb der neuen Tabellen ändern DARF, steht mit Namen da</b> — und keine Zeile gehört dazu:
 * {@link #GETAUSCHTE_CHECKS} (Herkunft der Maßnahme, Rolle am Abruf-Protokoll; beide validiert gegen den Bestand) und
 * {@link #GEWEITETE_VOKABULARE} (nur Wörter dazu, keines weg, keines umnummeriert). Die Rollen-Spalte und die getrennten
 * Lese-Kennungen liegen in {@code rechte-matrix.json}, nicht in der Datenbank — dass KA und EM jede Zelle behalten,
 * prüft {@code RechtMatrixApiTest} (R15 Schritt 3).
 *
 * <p><b>Kein Schalter, kein Läufer:</b> AP-19 hat keine Naht und schreibt nie von selbst — die Quelltext-Probe
 * {@link #keinSchalterKeinLaeuferKeineNaht()} hält das fest. Dass der Baustein „Energiemanagement“ ohne Inhalt nicht
 * erscheint (AP-13 E3), prüft {@code EnergiemanagementBaustein.test.tsx} an {@code energiemanagementBaustein}; hier steht
 * die Voraussetzung dafür: ohne AP-19-Eintrag sind alle AP-19-Tabellen leer.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsEnergiemanagementBestandsschutzTest {

    /** Die erste Migration von AP-19 (IP-5); der Bestand entsteht auf der Fassung davor. */
    private static final String ERSTE_AP19 = "20260925013500";
    /**
     * Die letzte Migration von AP-19 (IP-23, Sitzung, Beschlüsse, Folgen). „Genau diese Tabellen, Vokabulare und
     * CHECKs“ gelten für AP-19 und werden auf DIESEM Stand gemessen — spätere Programme (AP-20 ff.) legen danach eigene an
     * und haben dafür ihren eigenen Bestandsschutz. Der Rollout bis zum neuesten Stand prüft danach weiter, dass die
     * Bestandszeilen byte-gleich bleiben, die AP-19-Tabellen leer und kein Wort verschwindet.
     */
    private static final String LETZTE_AP19 = "20260925093000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final Path MIGRATIONEN = Path.of("src", "main", "resources", "db", "migration");
    private static final Path QUELLTEXT = Path.of("src", "main", "java", "com", "voltpilot", "api");
    private static final Path SEED = Path.of("..", "..", "infra", "local", "seed", "ahrenberg.sql");

    private static final UUID KB = UUID.fromString("20000000-0000-0000-0000-000000000001");
    private static final UUID UNTERNEHMEN = UUID.fromString("20000000-0000-0000-0000-000000000010");
    private static final UUID ST1 = UUID.fromString("20000000-0000-0000-0000-0000000000a1");
    /** Ines Kaltenbach im Seed — die Bezugsbasis bindet ihren Verantwortlichen per Fremdschlüssel an {@code benutzer}. */
    private static final String INES = "20000000-0000-0000-0000-0000000008a2";

    /** Die Tabellen, die AP-19 anlegt — bei einem Bestandskunden ohne Eintrag bleiben sie leer. */
    private static final List<String> NEUE_TABELLEN = List.of("energiemanagement_aenderung",
            "energiemanagement_anwendungsbereich", "energiemanagement_aufgabe", "energiemanagement_dokument",
            "energiemanagement_dokument_eintrag", "energiemanagement_dokument_fassung", "energiemanagement_einstellung",
            "energiemanagement_kennung_seq", "energiemanagement_person", "feststellung", "feststellung_eintrag",
            "feststellung_wirksamkeit", "internes_audit", "internes_audit_eintrag", "managementbewertung_beschluss",
            "managementbewertung_folge", "managementbewertung_sitzung");
    /** Die zwei CHECK-Tausche an fremden Tabellen (W1 an der Maßnahme, W10 am Abruf-Protokoll) — sonst keiner. */
    private static final Set<String> GETAUSCHTE_CHECKS = Set.of("massnahme.massnahme_herkunft_chk",
            "bericht_abruf.bericht_abruf_actor_rolle_chk");
    /** Die Vokabulare, die AP-19 als Vereinigung weitet: Herkunft (IP-17), Einsicht (IP-12), Vorlage Nr. 7 (IP-22). */
    private static final Set<String> GEWEITETE_VOKABULARE = Set.of("verbesserung_vokabular", "zugriff_rolle",
            "bericht_vokabular", "bericht_vorlage");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static Map<String, String> vorher;
    private static Map<String, String> bisAp19;
    private static Map<String, String> nachher;
    private static Map<String, TreeSet<String>> vokabulareVorher;
    private static Map<String, TreeSet<String>> vokabulareBisAp19;
    private static Map<String, String> checksVorher;
    private static Map<String, String> checksBisAp19;
    private static Map<String, String> checksNachher;

    @BeforeAll
    static void bestandUndRollout() throws Exception {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVor(ERSTE_AP19)).load().migrate();
        assertThat(tabelleDa("energiemanagement_dokument")).as("der Bestand entsteht vor AP-19").isFalse();
        bestand();
        jobsAus();
        vorher = Bestandsschutz.fingerabdruck(root, List.of());
        vokabulareVorher = vokabulare();
        checksVorher = checks();

        flyway().target(LETZTE_AP19).load().migrate();
        jobsAus();
        bisAp19 = Bestandsschutz.fingerabdruck(root, List.of());
        vokabulareBisAp19 = vokabulare();
        checksBisAp19 = checks();

        flyway().load().migrate();
        jobsAus();
        nachher = Bestandsschutz.fingerabdruck(root, List.of());
        checksNachher = checks();
    }

    // ============================================================ der Rollout

    @Test
    void derRolloutLaesstDenBestandByteGleich() {
        for (String t : List.of("kennzahl", "kennzahl_wert", "bezugsbasis_fassung", "bericht", "bericht_stand",
                "bericht_abruf", "energieziel", "massnahme", "massnahme_bewertung", "zugriff", "benutzer")) {
            assertThat(vorher.get(t)).as("der Bestand hat Zeilen in " + t).isNotEqualTo(Bestandsschutz.LEER);
        }
        assertThat(root.queryForObject("SELECT count(*) FROM bericht_stand WHERE tenant_id = ?", Integer.class, KB))
                .as("je ein Stand von AP-12, AP-16 und AP-17").isEqualTo(3);
        assertThat(Bestandsschutz.abweichungen(vorher, bisAp19)).as("AP-19: jede Bestandstabelle byte-gleich").isEmpty();
        assertThat(Bestandsschutz.abweichungen(vorher, nachher))
                .as("bis zum neuesten Stand: keine Maßnahme, kein Stand, kein Bericht ändert sich").isEmpty();
        assertThat(nachher.keySet()).containsAll(vorher.keySet());
    }

    @Test
    void dieNeuenTabellenSindDaUndLeer() {
        for (String tabelle : NEUE_TABELLEN) {
            assertThat(vorher).as(tabelle + " kommt erst mit AP-19").doesNotContainKey(tabelle);
            assertThat(nachher.get(tabelle)).as(tabelle + " nach dem Rollout (R15: nichts entsteht von selbst)")
                    .isEqualTo(Bestandsschutz.LEER);
        }
        try (var dateien = Files.list(MIGRATIONEN)) {
            assertThat(dateien.map(d -> d.getFileName().toString()))
                    .as("die letzte AP-19-Migration").anyMatch(n -> n.startsWith("V" + LETZTE_AP19 + "__"));
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        List<String> neu = new ArrayList<>(bisAp19.keySet());
        neu.removeAll(vorher.keySet());
        neu.removeIf(t -> t.startsWith(Bestandsschutz.KATALOG_METADATEN + "@"));
        assertThat(neu).as("AP-19 legt genau diese Tabellen an").containsExactlyInAnyOrderElementsOf(NEUE_TABELLEN);
        assertThat(nachher.keySet()).as("spätere Programme nehmen keine AP-19-Tabelle weg").containsAll(bisAp19.keySet());
        assertThat(root.queryForObject("SELECT count(*) FROM zugriff WHERE rolle = 'einsicht'", Integer.class))
                .as("„Einsicht“ ist eine Wahl, niemandem zugewiesen").isZero();
    }

    /**
     * Die CHECKs der Bestandstabellen: AP-19 tauscht genau zwei (W1, W10) — beide weiter, beide gegen den Bestand
     * validiert —, jeder andere steht Wort für Wort wie vorher. Gemessen auf {@link #LETZTE_AP19}; danach verschwindet
     * keiner der beiden.
     */
    @Test
    void nurDieZweiBenanntenChecksSindGetauscht() {
        assertThat(checksVorher).containsKeys(GETAUSCHTE_CHECKS.toArray(String[]::new));
        List<String> anders = new ArrayList<>();
        checksVorher.forEach((name, def) -> {
            if (!def.equals(checksBisAp19.get(name))) anders.add(name);
        });
        assertThat(anders).as("AP-19 tauscht genau diese CHECKs an Bestandstabellen")
                .containsExactlyInAnyOrderElementsOf(GETAUSCHTE_CHECKS);
        assertThat(checksBisAp19.get("massnahme.massnahme_herkunft_chk")).as("die Herkunft geweitet (W1)")
                .contains("verbesserung_wort").doesNotContain("NOT VALID");
        assertThat(checksBisAp19.get("bericht_abruf.bericht_abruf_actor_rolle_chk")).as("Einsicht am Abruf (W10)")
                .contains("'einsicht'").contains("'leser'").doesNotContain("NOT VALID");
        for (String name : GETAUSCHTE_CHECKS) {
            assertThat(checksNachher).as(name + " bleibt bis zum neuesten Stand").containsKey(name);
        }
        assertThat(root.queryForObject("SELECT count(*) FROM pg_constraint WHERE conname IN "
                + "('massnahme_herkunft_chk', 'bericht_abruf_actor_rolle_chk') AND NOT convalidated", Integer.class))
                .as("beide Tausche sind gegen den Bestand validiert").isZero();
    }

    /**
     * Die Wörter: AP-19 bringt sein eigenes Vokabular ({@code energiemanagement_vokabular()}) und weitet genau
     * {@link #GEWEITETE_VOKABULARE} als Vereinigung — jedes alte Wort steht nachher Zeile für Zeile, mit derselben Nummer.
     * Jedes andere Vokabular ist auf {@link #LETZTE_AP19} unverändert; danach verschwindet kein Wort.
     */
    @Test
    void vokabulareNurGeweitetNieVerengt() {
        assertThat(vokabulareVorher).as("der Bestand kennt die Vokabulare von AP-03/AP-12/AP-18")
                .containsKeys(GEWEITETE_VOKABULARE.toArray(String[]::new))
                .doesNotContainKey("energiemanagement_vokabular");
        List<String> neu = new ArrayList<>(vokabulareBisAp19.keySet());
        neu.removeAll(vokabulareVorher.keySet());
        assertThat(neu).as("AP-19 legt genau ein Vokabular an").containsExactly("energiemanagement_vokabular");
        assertThat(vokabulareBisAp19.get("energiemanagement_vokabular")).isNotEmpty();
        Map<String, TreeSet<String>> neuester = vokabulare();
        vokabulareVorher.forEach((funktion, alt) -> {
            TreeSet<String> ap19 = vokabulareBisAp19.get(funktion);
            if (GEWEITETE_VOKABULARE.contains(funktion)) {
                assertThat(ap19).as(funktion + ": Vereinigung — jedes alte Wort bleibt").containsAll(alt);
                assertThat(ap19.size()).as(funktion + ": AP-19 fügt Wörter hinzu").isGreaterThan(alt.size());
            } else {
                assertThat(ap19).as(funktion + ": AP-19 ändert kein Wort").isEqualTo(alt);
            }
            assertThat(neuester.get(funktion)).as(funktion + ": kein Wort verschwindet oder wird umnummeriert")
                    .containsAll(alt);
        });
        assertThat(vokabulareBisAp19.get("zugriff_rolle")).as("Einsicht als achte Rolle")
                .contains("(8,einsicht,unternehmen,t)");
    }

    /**
     * R15 Schritt 5: AP-19 hat keine Naht — kein Schalter, kein Läufer, kein Ereignis-Hörer in seinen Klassen, kein
     * Eintrag in {@code application.yml}. Jeder Eintrag entsteht durch eine Person über eine Route.
     */
    @Test
    void keinSchalterKeinLaeuferKeineNaht() throws IOException {
        Pattern ap19Klasse = Pattern.compile("(Energiemanagement|InternesAudit|Audit|Feststellung|Dokument|"
                + "Managementbewertung|Wiedervorlage|Verzeichnis)[A-Za-z]*\\.java");
        Pattern naht = Pattern.compile("@Scheduled|@Value\\(|@ConditionalOnProperty|@EventListener|"
                + "@TransactionalEventListener|@KafkaListener|uems\\.energiemanagement");
        List<Path> klassen;
        try (Stream<Path> alle = Files.walk(QUELLTEXT)) {
            klassen = alle.filter(p -> ap19Klasse.matcher(p.getFileName().toString()).matches()).toList();
        }
        assertThat(klassen).as("die AP-19-Klassen werden gefunden")
                .anyMatch(p -> p.endsWith("EnergiemanagementDokumentService.java"))
                .anyMatch(p -> p.endsWith("FeststellungController.java"));
        for (Path klasse : klassen) {
            assertThat(naht.matcher(Files.readString(klasse)).find()).as(klasse + " trägt keinen Schalter, keinen Läufer")
                    .isFalse();
        }
        for (String yml : List.of("application.yml", "application-prod.yml")) {
            Path datei = Path.of("src", "main", "resources", yml);
            if (Files.exists(datei)) {
                assertThat(Files.readString(datei)).as(yml + " kennt keinen Energiemanagement-Schalter")
                        .doesNotContainIgnoringCase("energiemanagement");
            }
        }
    }

    /** Beißt der Vergleich auf diesem Bestand? Die geplante Maßnahme (die bewertete schützt ihr Trigger) und ein Standort. */
    @Test
    void mutationsprobe() {
        Bestandsschutz.mutationsprobe(root, List.of(), "massnahme",
                "UPDATE massnahme SET titel = titel || ' (Probe)' WHERE kennzeichen = 'M-2027-0002'");
        Bestandsschutz.mutationsprobe(root, List.of(), "standort",
                "UPDATE standort SET name = name || ' (Probe)' WHERE id = '" + ST1 + "'");
    }

    // ============================================================ der Bestand (Fassung vor AP-19)

    private static void bestand() throws Exception {
        try (Connection con = ds(POSTGRES.getUsername(), POSTGRES.getPassword()).getConnection();
                Statement s = con.createStatement()) {
            s.execute(Files.readString(SEED));
        }
        assertThat(root.queryForObject("SELECT count(*) FROM standort WHERE tenant_id = ?", Integer.class, KB))
                .as("der Seed läuft auf der Fassung vor AP-19").isPositive();

        UUID kz4 = root.queryForObject("INSERT INTO kennzahl (tenant_id, kennzeichen, name, rechenform, geltung_art, "
                + "unternehmen_id, verantwortlich_sub, verantwortlich_name) VALUES (?, 'KZ-0004', 'Strom je Kilogramm "
                + "Spritzguss', 'quotient', 'unternehmen', ?, 'kc-ines-kaltenbach', 'Ines Kaltenbach') RETURNING id",
                UUID.class, KB, UNTERNEHMEN);
        UUID fassung = root.queryForObject("INSERT INTO kennzahl_fassung (tenant_id, kennzahl_id, nummer, rechenform, "
                + "herkunft, actor_sub, actor_name, actor_rolle, actor_art, einheit) VALUES (?, ?, 1, 'quotient', "
                + "'anlage', 'kc-ines-kaltenbach', 'Ines Kaltenbach', 'energiemanager', 'kunde', 'kWh/kg') RETURNING id",
                UUID.class, KB, kz4);
        root.update("INSERT INTO kennzahl_wert (tenant_id, kennzahl_id, periode_art, periode_von, periode_bis, zeitzone, "
                + "version, wert, zaehler, nenner, menge_zustand, richtung, kennzeichen, zustand, endgueltig_ab, "
                + "definition_fassung_id, berechnet_am) VALUES (?, ?, 'monat', ?, ?, 'Europe/Berlin', 1, 0.46, "
                + "189520, 412000, 'vollständig', NULL, '[]'::jsonb, 'endgueltig', ?, ?, ?)", KB, kz4,
                Date.valueOf("2026-12-01"), Date.valueOf("2026-12-31"),
                Timestamp.from(Instant.parse("2027-01-06T23:00:00Z")), fassung,
                Timestamp.from(Instant.parse("2027-01-01T01:20:00Z")));

        // AP-17: BB-0001 Fassung 1 freigegeben — die Energieleistungskennzahl.
        UUID bb1 = root.queryForObject("INSERT INTO bezugsbasis (tenant_id, kennzeichen, kennzahl_id, verantwortlich_sub, "
                + "verantwortlich_name, verantwortlich_konto, actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, "
                + "'BB-0001', ?, ?, 'Ines Kaltenbach', 'benutzer', ?, 'Ines Kaltenbach', 'energiemanager', 'kunde') "
                + "RETURNING id", UUID.class, KB, kz4, INES, INES);
        root.update("INSERT INTO bezugsbasis_fassung (tenant_id, bezugsbasis_id, fassung, referenzperiode, methode, "
                + "datenlage, gilt_ab, begruendung, actor_sub, actor_name, actor_rolle, actor_art, freigabe_status, "
                + "freigabe_sub, freigabe_name, freigabe_rolle, freigabe_art, freigabe_am, freigegeben_am) VALUES (?, ?, 1, "
                + "'2026-10/2026-10', 'verhaeltnis', 'vorlaeufig', '2026-11-01', 'Erste Energieleistungskennzahl: ein "
                + "abgeschlossener Monat — vorläufig.', ?, 'Ines Kaltenbach', 'energiemanager', 'kunde', "
                + "'freigegeben', ?, 'Ines Kaltenbach', 'energiemanager', 'kunde', '2026-11-12 10:00', "
                + "'2026-11-12 10:00')", KB, bb1, INES, INES);

        // AP-12, AP-16, AP-17: je ein Bericht mit Stand Nr. 1 und Prüfsumme; der Monatsbericht mit einem Abruf.
        UUID monat = root.queryForObject("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, geltung_art, "
                + "standort_id, zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_name) VALUES (?, 'BR-2026-0001', "
                + "'monatsbericht_standort', 1, 'standort', ?, 'monat', '2026-12', 'Europe/Berlin', 'Ines Kaltenbach') "
                + "RETURNING id", UUID.class, KB, ST1);
        UUID monatStand = stand(monat, "2027-01-08T10:00:00Z");
        root.update("INSERT INTO bericht_abruf (tenant_id, stand_id, format, actor_sub, actor_name, actor_rolle, "
                + "actor_art) VALUES (?, ?, 'pdf', 'sub-claudia', 'Claudia Berger', 'leser', 'kunde')", KB, monatStand);
        stand(berichtAmUnternehmen("BR-2027-0001", "energetische_bewertung", "datengrundlage", "2026-12", null),
                "2027-01-20T10:00:00Z");
        stand(berichtAmUnternehmen("BR-2027-0002", "leistungsvergleich", "monat", "2026-12", kz4),
                "2027-01-21T10:00:00Z");

        // AP-18: ein Energieziel und zwei Maßnahmen (Herkünfte von_hand und energieziel), eine bewertet.
        UUID ez = root.queryForObject("INSERT INTO energieziel (tenant_id, kennzeichen, kennzahl_id, bezugsbasis_id, fassung, "
                + "zielwert_prozent, zielperiode, wortlaut, begruendung, verantwortlich_sub, verantwortlich_name, "
                + "verantwortlich_konto, standort_id, actor_sub, actor_name, actor_rolle, actor_art, angelegt_am) VALUES "
                + "(?, 'EZ-2027-0001', ?, ?, 1, -5.0, '2027-01/2027-12', 'Fünf Prozent weniger Strom je Kilogramm.', "
                + "'Ziel aus der Energiepolitik.', '" + INES + "', 'Ines Kaltenbach', 'benutzer', NULL, '" + INES + "', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde', '2026-12-20T09:00:00Z') RETURNING id", UUID.class, KB, kz4, bb1);
        UUID m1 = massnahme("M-2027-0001", "Druckluft-Leckagen beheben", "von_hand", null, null);
        massnahme("M-2027-0002", "Zeitschaltung der Kühlung", "energieziel", "EZ-2027-0001", ez);
        root.update("UPDATE massnahme SET zustand = 'umgesetzt', umgesetzt_am = '2027-02-15', umgesetzt_begruendung = "
                + "'Umgesetzt wie geplant.', umgesetzt_gemeldet_am = '2027-02-15T12:00:00Z' WHERE id = ?", m1);
        root.update("INSERT INTO massnahme_bewertung (tenant_id, massnahme_id, ergebnis, begruendung, status, "
                + "freigabe_sub, freigabe_name, freigabe_rolle, freigabe_art, freigabe_am) VALUES (?, ?, 'nicht_messbar', "
                + "'Ohne Messstelle an der Druckluft ist keine Wirkung zu sehen.', 'bewertet', '" + INES + "', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde', '2027-06-15T10:00:00Z')", KB, m1);
        root.update("UPDATE massnahme SET zustand = 'bewertet' WHERE id = ?", m1);
    }

    private static UUID massnahme(String kennzeichen, String titel, String herkunft, String herkunftKennung,
            UUID energieziel) {
        return root.queryForObject("INSERT INTO massnahme (tenant_id, kennzeichen, titel, verantwortlich_sub, "
                + "verantwortlich_name, verantwortlich_konto, termin, standort_id, herkunft_art, herkunft_kennung, "
                + "energieziel_id, erwartete_wirkung_wortlaut, actor_sub, actor_name, actor_rolle, actor_art, angelegt_am) VALUES (?, ?, ?, "
                + "'" + INES + "', 'Ines Kaltenbach', 'benutzer', '2027-03-31', ?, ?, ?, ?, 'Weniger Grundlast.', '" + INES + "', "
                + "'Ines Kaltenbach', 'energiemanager', 'kunde', '2027-01-15T09:00:00Z') RETURNING id", UUID.class, KB,
                kennzeichen, titel, ST1, herkunft, herkunftKennung, energieziel);
    }

    private static UUID berichtAmUnternehmen(String kennung, String vorlage, String zeitraumArt, String schluessel,
            UUID kennzahl) {
        return root.queryForObject("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, geltung_art, "
                + "unternehmen_id, zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_name, kennzahl_id) "
                + "VALUES (?, ?, ?, 1, 'unternehmen', ?, ?, ?, 'Europe/Berlin', 'Ines Kaltenbach', ?) RETURNING id",
                UUID.class, KB, kennung, vorlage, UNTERNEHMEN, zeitraumArt, schluessel, kennzahl);
    }

    /** Stand Nr. 1, freigegeben am {@code am} (Muster {@code ManagementbewertungVorlageApiTest}). */
    private static UUID stand(UUID bericht, String am) {
        String abzug = "{\"bericht\":\"" + bericht + "\",\"nr\":1}";
        Timestamp t = Timestamp.from(Instant.parse(am));
        return root.queryForObject("INSERT INTO bericht_stand (tenant_id, bericht_id, nr, abzug, pruefsumme, datenstand, "
                + "freigegeben_am, freigeber_sub, freigeber_name, freigeber_rolle, darstellung, regelwerk, "
                + "vorlage_fassung) VALUES (?, ?, 1, ?, ?, ?, ?, '" + INES + "', 'Ines Kaltenbach', 'energiemanager', "
                + "'{}'::jsonb, '{}'::jsonb, 1) RETURNING id", UUID.class, KB, bericht, abzug,
                BerichtRegeln.pruefsumme(abzug), t, t);
    }

    /** Jede Vokabular-Funktion ohne Argument ({@code *_vokabular()}, {@code bericht_vorlage()}, {@code zugriff_rolle()}). */
    private static Map<String, TreeSet<String>> vokabulare() {
        Map<String, TreeSet<String>> aus = new TreeMap<>();
        for (String f : root.queryForList("SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
                + "WHERE n.nspname = 'public' AND p.pronargs = 0 AND p.proretset AND (p.proname LIKE '%\\_vokabular' "
                + "OR p.proname IN ('bericht_vorlage', 'zugriff_rolle'))", String.class)) {
            aus.put(f, new TreeSet<>(root.queryForList("SELECT v::text FROM " + f + "() v", String.class)));
        }
        return aus;
    }

    /** Jeder CHECK jeder Tabelle im Schema {@code public} als „tabelle.name“ → Definition. */
    private static Map<String, String> checks() {
        Map<String, String> aus = new TreeMap<>();
        root.query("SELECT c.relname, k.conname, pg_get_constraintdef(k.oid) AS def FROM pg_constraint k "
                + "JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace "
                + "WHERE n.nspname = 'public' AND k.contype = 'c'",
                rs -> {
                    aus.put(rs.getString(1) + "." + rs.getString(2), rs.getString(3));
                });
        return aus;
    }

    private static boolean tabelleDa(String tabelle) {
        return Boolean.TRUE.equals(root.queryForObject("SELECT to_regclass(?) IS NOT NULL", Boolean.class, tabelle));
    }

    private static void jobsAus() {
        root.queryForList("SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs "
                + "WHERE job_id >= 1000");
    }

    private static String letzteFassungVor(String version) throws IOException {
        BigInteger diese = new BigInteger(version);
        try (var dateien = Files.list(MIGRATIONEN)) {
            return dateien.map(p -> p.getFileName().toString())
                    .filter(n -> n.startsWith("V") && n.contains("__"))
                    .map(n -> n.substring(1, n.indexOf("__")))
                    .filter(v -> v.matches("[0-9]+") && new BigInteger(v).compareTo(diese) < 0)
                    .max(Comparator.comparing(BigInteger::new))
                    .orElseThrow();
        }
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
