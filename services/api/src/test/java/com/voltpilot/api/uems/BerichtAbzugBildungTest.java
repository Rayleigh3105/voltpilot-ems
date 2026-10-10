package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Abzug eines Standort-Berichts wird gebildet (UEMS AP-12 IP-5, Meilenstein 1 „Abzug existiert“): B1 Nr. 1 —
 * Monatsbericht Werk Ahrenberg Oktober 2026, Datenstand 10.11.2026 08:55 — aus dem, was gespeichert ist, gegen den Abzug
 * {@code BR-2026-0001/1} in {@code docs/contracts/v2/bericht-vectors.json}. Testcontainers, Docker nötig.
 *
 * <p>Die Daten sind die des Referenzunternehmens (1.4): Standort ST-1, Gebäude und Bereiche ab 01.10.2026, die Messstellen
 * MS-01 … MS-15 mit Ort, Stellung und führender Quelle, die Oktober-Monatswerte des Monatslaufs (01.11.2026 00:20,
 * endgültig ab 08.11.2026) und die gespeicherte Herkunft der beiden Reste MS-09 und MS-15. Ein fremder Kundenbereich mit
 * eigenem MS-01 liegt daneben.
 *
 * <p><b>Vollständig seit Vertrag 1.2</b> (Folgepaket {@code vp-uems-b12-tagesverlauf-speicher}, dritter Schnitt): der
 * Abzug ist byte-gleich zum Vektor — keine benannte Lücke mehr. Die frühere Liste (firstmate 001 = A) ist damit
 * abgearbeitet: Kennzahlen und Bezugsgrößen schloss AP-12 IP-6, Speicher-Paar, Tagesverlauf und Ort/Endgültigkeit je
 * Kennzahl dieses Paket. Es bleiben zwei benannte ABWEICHUNGEN des Vektors, die keine Lücken sind: die Kennzahl-Zahl
 * steht gespeichert mit zehn Nachkommastellen (der Vektor schreibt vier), und KZ-0005 heißt in der Referenzdatei
 * „Netzbezug je m² — Halle 2“, während der Vektor den Gedankenstrich ausließ.
 */
@Testcontainers(disabledWithoutDocker = true)
class BerichtAbzugBildungTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");

    private static final UUID KB = UUID.fromString("93e99678-5bf3-55b4-9cb3-13e16fc4a25a");
    private static final UUID FREMD = UUID.fromString("5b0c7a6e-2f4d-4c1a-9e8b-3d2f1a0c9e77");

    private static final Instant BEGINN = Instant.parse("2026-09-30T22:00:00Z");
    private static final Instant ENDE = Instant.parse("2026-10-31T23:00:00Z");
    private static final Instant ENDGUELTIG_AB = Instant.parse("2026-11-07T23:00:00Z");
    /** Der Monatslauf am 01.11.2026 00:20 (MEZ). */
    private static final Instant MONATSLAUF = Instant.parse("2026-10-31T23:20:00Z");
    /** Der Datenstand von Nr. 1: 10.11.2026 08:55 (MEZ). */
    private static final Instant DATENSTAND = Instant.parse("2026-11-10T07:55:00Z");
    /** Nach dem 29.01.2027 sind die Oktober-Rohwerte 90 Tage alt (AP-07) — der Zeitraum liegt jenseits der Frist. */
    private static final Instant NACH_DER_FRIST = Instant.parse("2027-02-01T08:00:00Z");

    /** B1 Nr. 1 — die fünf Stellen, die der Vektor über die Bildung hinaus nennt. */
    private static final List<String> QUELLEN_AP11 = List.of("BZ-4", "BZ-6", "KZ-0001", "KZ-0005");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static final Map<String, UUID> IDS = new LinkedHashMap<>();
    private static JdbcTemplate root;
    private static DataSource app;
    private static DataSource admin;
    private static JsonNode vektoren;
    private static JsonNode referenz;
    private static BerichtAbzugBildung bildung;
    private static UUID bericht;

    @FunctionalInterface
    interface MitVerbindung<T> {
        T mit(Connection con) throws Exception;
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
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        app = new TenantAwareDataSource(ds(APP_USER, APP_PW));
        admin = ds(ADMIN_USER, ADMIN_PW);
        vektoren = JSON.readTree(Files.readString(V2.resolve("bericht-vectors.json")));
        referenz = JSON.readTree(Files.readString(V2.resolve("uems-referenzunternehmen.json")));

        // Das Regelwerk des Vektors (seine Platzhalter) — so vergleicht der Abzug Byte für Byte; das echte prüft
        // dasRegelwerkNenntSoftwareUndDieSechsVertraege.
        JsonNode rw = soll().path("kopf").path("regelwerk");
        Map<String, String> vertraege = new LinkedHashMap<>();
        rw.path("vertraege").fields().forEachRemaining(e -> vertraege.put(e.getKey(), e.getValue().asText()));
        bildung = new BerichtAbzugBildung(new MeasurementCatalog(JSON), JSON,
                new BerichtRegelwerk(rw.path("software").asText(), vertraege));

        ahrenberg();
        fremderKundenbereich();
        bericht = uuid("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, geltung_art, standort_id, "
                + "zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_name) VALUES (?, 'BR-2026-0001', "
                + "'monatsbericht_standort', 1, 'standort', ?, 'monat', '2026-10', 'Europe/Berlin', 'Ines Kaltenbach') "
                + "RETURNING id", KB, IDS.get("ST-1"));
    }

    // =============================================================================== B1 Nr. 1

    @Test
    void b1NummerEinsIstByteGleichZumVektor_jedeLueckeAlsIstZustandBehauptet() throws Exception {
        BerichtAbzugBildung.Ergebnis ist = alsVerwaltung(con -> bildung.zusammentragen(con, bericht, DATENSTAND));
        JsonNode abzug = ist.abzug();
        ObjectNode soll = soll().deepCopy();

        // Die Lücken 1 und 2 aus AP-12 IP-5 sind geschlossen (AP-12 IP-6): der Kennzahlen-Abschnitt nennt KZ-0001 und
        // KZ-0005 mit ihrem Nachweis, das Quellenverzeichnis alle 19 Quellen — BZ-4, BZ-6, KZ-0001, KZ-0005 eingeschlossen.
        assertThat(texte(abzug.path("kopf").path("quellenverzeichnis"))).as("19 Quellen").hasSize(19)
                .containsAll(QUELLEN_AP11).containsExactlyElementsOf(texte(soll.path("kopf").path("quellenverzeichnis")));
        assertThat(abzug.path("kennzahlen")).extracting(k -> k.path("quelle").asText()).containsExactly("KZ-0001", "KZ-0005");

        // Abweichung a zum Vektor — die Zahl ist die gespeicherte von AP-11 (10 Nachkommastellen,
        // KennzahlRegeln.WERT_NACHKOMMASTELLEN); der Vektor schreibt sie auf 4 Stellen. Auf 4 Stellen gerundet gleich.
        for (int i = 0; i < 2; i++) {
            ObjectNode s = (ObjectNode) soll.path("kennzahlen").get(i);
            JsonNode ist0 = abzug.path("kennzahlen").get(i);
            assertThat(ist0.path("wert").decimalValue().scale()).isEqualTo(KennzahlRegeln.WERT_NACHKOMMASTELLEN);
            assertThat(ist0.path("wert").decimalValue().setScale(4, RoundingMode.HALF_UP))
                    .isEqualByComparingTo(s.path("wert").decimalValue());
            s.set("wert", ist0.path("wert"));
        }
        // Abweichung b — KZ-0005 heißt in der Referenzdatei 1.3 „Netzbezug je m² — Halle 2“, der Vektor schreibt
        // „Netzbezug je m² Halle 2“; der Abzug nennt den Namen zum Datenstand.
        assertThat(soll.path("kennzahlen").get(1).path("name_zum_datenstand").asText()).isEqualTo("Netzbezug je m² Halle 2");
        String kz0005 = kennzahlAusReferenz("KZ-0005").path("name").asText();
        assertThat(abzug.path("kennzahlen").get(1).path("name_zum_datenstand").asText()).isEqualTo(kz0005);
        ((ObjectNode) soll.path("kennzahlen").get(1)).put("name_zum_datenstand", kz0005);

        // Vertrag 1.2 — MS-04 („Laden / Entladen“) zeigt BEIDE Flüsse: laden 7 900 / entladen 7 100, abgeschrieben
        // aus messreihe_periode.menge_positiv/menge_negativ. Beide Zeilen tragen denselben Nachweis; es ist EINE
        // gemessene Reihe. Die Netto-Menge 800 steht in keiner von beiden — sie ist keine der zwei Richtungen.
        List<JsonNode> ms04 = zeilen(abzug, "MS-04");
        assertThat(ms04).hasSize(2);
        assertThat(ms04).extracting(w -> w.path("menge_art").asText()).containsExactly("laden", "entladen");
        assertThat(ms04.get(0).path("menge").decimalValue()).isEqualByComparingTo("7900");
        assertThat(ms04.get(1).path("menge").decimalValue()).isEqualByComparingTo("7100");
        assertThat(texte(ms04.get(0).path("kennzeichen"))).containsExactly(VerbrauchRegeln.AUS_LEISTUNG_INTEGRIERT);

        // Und die Zusammenfassung nennt beide Summen — 16 Zeilen, nicht 15.
        assertThat(abzug.path("zusammenfassung").path(BerichtAbzugBildung.SPEICHER_LADEN).asInt()).isEqualTo(7900);
        assertThat(abzug.path("zusammenfassung").path(BerichtAbzugBildung.SPEICHER_ENTLADEN).asInt()).isEqualTo(7100);
        assertThat(abzug.path("zusammenfassung").path("werte").asInt()).isEqualTo(16);

        // Der Tagesverlauf (1.2) steht in der Monatsvorlage: je Wert-Zeile ein Eintrag mit derselben Kennung.
        // Für Oktober 2026 hält das Referenzunternehmen keine Tageszeilen — die leere Liste IST die Lücke.
        assertThat(abzug.path("tagesverlauf")).hasSize(16);
        assertThat(abzug.path("tagesverlauf")).allSatisfy(t -> assertThat(t.path("tage")).isEmpty());
        assertThat(abzug.path("tagesverlauf").get(3).path("menge_art").asText()).isEqualTo("laden");

        // Ort und Endgültigkeit je Kennzahl (1.2) — B14 füllt damit die zwei Zellen der CSV.
        assertThat(abzug.path("kennzahlen")).allSatisfy(k -> {
            assertThat(k.path("ort_zum_datenstand").asText()).isEqualTo("G-2");
            assertThat(k.path("endgueltig_ab").asText()).isEqualTo("2026-11-08T00:00:00+01:00");
        });

        assertThat(ist.text()).as("B1 Nr. 1 — alles andere Byte für Byte").isEqualTo(BerichtRegeln.kanonisch(soll));
        assertThat(ist.pruefsumme()).isEqualTo(BerichtRegeln.pruefsumme(BerichtRegeln.kanonisch(soll)));
        assertThat(UemsSchemaLaeufer.verstoesse(abzug, schemaAbzug())).as("bericht.schema.json $defs/abzug").isEmpty();
    }

    /**
     * Der Tagesverlauf schreibt GESPEICHERTE Tageszeilen ab (1.2). Das Referenzunternehmen hält für Oktober 2026
     * keine — darum ist er in B1 je Zeile leer. Hier bekommt MS-12 zwei echte Tageszeilen, und der Abzug zeigt
     * genau sie: kein Tag ohne Zeile wird zur Null, und kein Tag außerhalb des Zeitraums rutscht herein.
     */
    @Test
    void derTagesverlaufZeigtDieGespeichertenTage_undNurSie() throws Exception {
        UUID entity = root.queryForObject("SELECT entity_id FROM messstelle_quelle WHERE tenant_id = ? "
                + "AND messstelle_id = ?", UUID.class, KB, IDS.get("MS-12"));
        try {
            tageszeile(entity, "2026-10-05", "210", "vollständig");
            tageszeile(entity, "2026-10-06", "185", "unvollständig");
            tageszeile(entity, "2026-11-01", "999", "vollständig");   // nach dem Zeitraum — darf NICHT erscheinen
            JsonNode abzug = alsVerwaltung(con -> bildung.zusammentragen(con, bericht, DATENSTAND)).abzug();
            JsonNode ms12 = null;
            for (JsonNode t : abzug.path("tagesverlauf")) {
                if ("MS-12".equals(t.path("quelle").asText())) {
                    ms12 = t;
                }
            }
            assertThat(ms12).isNotNull();
            assertThat(ms12.path("tage")).hasSize(2);
            assertThat(ms12.path("tage").get(0).path("tag").asText()).isEqualTo("2026-10-05");
            assertThat(ms12.path("tage").get(0).path("menge").decimalValue()).isEqualByComparingTo("210");
            assertThat(ms12.path("tage").get(1).path("zustand").asText()).isEqualTo("unvollständig");
            // Die 29 Tage ohne Zeile stehen nicht als 0 da — sie fehlen, und das ist die Lücke.
            assertThat(ms12.path("tage")).extracting(t -> t.path("tag").asText())
                    .doesNotContain("2026-10-07", "2026-11-01");
            assertThat(UemsSchemaLaeufer.verstoesse(abzug, schemaAbzug())).isEmpty();
        } finally {
            root.update("DELETE FROM messreihe_tag WHERE tenant_id = ? AND entity_id = ?", KB, entity);
        }
    }

    private static void tageszeile(UUID entity, String tag, String menge, String zustand) {
        root.update("INSERT INTO messreihe_tag (tag, tenant_id, entity_id, messkanal, zeitzone, zeitzone_herkunft, "
                + "beginn, ende, stunden, slots_erwartet, slots_vorhanden, slots_endgueltig, wertart, menge, "
                + "menge_zustand, kennzeichen, erhalten, erwartet, abdeckung_prozent, zustand, endgueltig_ab, "
                + "berechnet_am, version) VALUES (?::date, ?, ?, 'energy_kwh', 'Europe/Berlin', 'standort', "
                + "?::date AT TIME ZONE 'Europe/Berlin', (?::date + 1) AT TIME ZONE 'Europe/Berlin', 24, 96, 96, 96, "
                // messreihe_tag_frist_chk: endgueltig_ab IST das Periodenende + 7 Tage (AP-08), keine freie Angabe.
                + "'counter', ?::numeric, ?, '[]'::jsonb, 1440, 1440, 100, 'endgueltig', "
                + "((?::date + 1) AT TIME ZONE 'Europe/Berlin') + INTERVAL '7 days', ?, 1)",
                tag, KB, entity, tag, tag, menge, zustand, tag, Timestamp.from(MONATSLAUF));
    }

    @Test
    void neunzehnQuellen_imQuellenverzeichnisDesEntwurfs_jedeMitIhrerArt() throws Exception {
        alsVerwaltung(con -> bildung.bilden(con, bericht, DATENSTAND, "kaskade"));
        List<Map<String, Object>> zeilen = root.queryForList("SELECT art, kennzeichen, bezug, erster_tag, letzter_tag, "
                + "version, fassung, name_zum_datenstand, stand_nr FROM bericht_quelle WHERE tenant_id = ? "
                + "AND bericht_id = ? ORDER BY kennzeichen COLLATE \"C\"", KB, bericht);
        assertThat(zeilen).as("19 Quellen, je eine Zeile — die Eingänge der Reste und der Kennzahlen sind selbst Quellen")
                .extracting(z -> z.get("kennzeichen"))
                .containsExactlyElementsOf(texte(soll().path("kopf").path("quellenverzeichnis")));
        for (Map<String, Object> z : zeilen) {
            String kz = (String) z.get("kennzeichen");
            assertThat(z.get("bezug")).as(kz + " — B1 gruppiert alle 19 unmittelbar").isEqualTo("unmittelbar");
            assertThat(z.get("erster_tag").toString()).isEqualTo("2026-10-01");
            assertThat(z.get("letzter_tag").toString()).isEqualTo("2026-10-31");
            assertThat(z.get("stand_nr")).as("Quellen des Entwurfs").isNull();
            // {art, version, fassung}: Kennzahl-Version + Definitions-Fassung, Bezugsgrößen-Fassung, Stammdatum ohne.
            String[] soll = switch (kz) {
                case "BZ-4" -> new String[] {"stammdatum", null, null};
                case "BZ-6" -> new String[] {"bezugsgroesse", null, "1"};
                case "KZ-0001", "KZ-0005" -> new String[] {"kennzahl", "1", "1"};
                default -> new String[] {"messstelle", "1", null};
            };
            assertThat(z.get("art")).as(kz).isEqualTo(soll[0]);
            assertThat(z.get("version") == null ? null : z.get("version").toString()).as(kz + " Version").isEqualTo(soll[1]);
            assertThat(z.get("fassung") == null ? null : z.get("fassung").toString()).as(kz + " Fassung").isEqualTo(soll[2]);
        }
        assertThat(zeilen.stream().filter(z -> "MS-12".equals(z.get("kennzeichen"))).findFirst().orElseThrow()
                .get("name_zum_datenstand")).isEqualTo("Montage Linie M1");
    }

    @Test
    void ohneJedeZeileInDerAbwahlSindAlleKennzahlenGewaehlt_eineAbwahlLaesstEineWeg_wiederGewaehltIstSieDa()
            throws Exception {
        // firstmate 001: das FEHLEN einer Zeile heißt „gewählt“ — wer die Tabelle nicht schreibt, ändert nichts.
        assertThat(root.queryForObject("SELECT count(*) FROM bericht_kennzahl_abwahl", Long.class)).isZero();
        TenantContext.set(KB);
        try (Connection con = app.getConnection()) {
            con.setAutoCommit(false);
            try {
                assertThat(kennzahlen(bildung.zusammentragen(con, bericht, DATENSTAND))).containsExactly("KZ-0001", "KZ-0005");
                UUID abwahl;
                try (PreparedStatement ps = con.prepareStatement("INSERT INTO bericht_kennzahl_abwahl (tenant_id, bericht_id, "
                        + "kennzahl_id, abgewaehlt_von_sub, abgewaehlt_von_name) VALUES (?, ?, ?, 'sub-ik', 'Ines Kaltenbach') "
                        + "RETURNING id")) {
                    ps.setObject(1, KB);
                    ps.setObject(2, bericht);
                    ps.setObject(3, IDS.get("KZ-0005"));
                    try (ResultSet rs = ps.executeQuery()) {
                        rs.next();
                        abwahl = rs.getObject(1, UUID.class);
                    }
                }
                BerichtAbzugBildung.Ergebnis ohne = bildung.zusammentragen(con, bericht, DATENSTAND);
                assertThat(kennzahlen(ohne)).containsExactly("KZ-0001");
                assertThat(ohne.quellen()).extracting(BerichtAbzugBildung.Quelle::kennzeichen)
                        .doesNotContain("KZ-0005", "BZ-4").contains("MS-10", "BZ-6");
                try (PreparedStatement ps = con.prepareStatement("UPDATE bericht_kennzahl_abwahl SET aufgehoben_am = now() "
                        + "WHERE id = ?")) {
                    ps.setObject(1, abwahl);
                    ps.executeUpdate();
                }
                assertThat(kennzahlen(bildung.zusammentragen(con, bericht, DATENSTAND))).as("wieder gewählt")
                        .containsExactly("KZ-0001", "KZ-0005");
            } finally {
                con.rollback();
            }
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void ohneDieKennzahlTabellenEntstehtDerAbzugTrotzdem_ohneDieAbwahlTabelleSindAlleGewaehlt() throws Exception {
        BerichtAbzugBildung.Ergebnis mit = alsVerwaltung(con -> bildung.zusammentragen(con, bericht, DATENSTAND));
        try (Connection con = root.getDataSource().getConnection()) {
            con.setAutoCommit(false);
            JdbcTemplate j = new JdbcTemplate(new SingleConnectionDataSource(con, true));
            try {
                // Fehlt nur die Abwahl-Tabelle, sind alle Kennzahlen gewählt — auch eine, die dort abgewählt stand.
                j.update("INSERT INTO bericht_kennzahl_abwahl (tenant_id, bericht_id, kennzahl_id, abgewaehlt_von_name) "
                        + "VALUES (?, ?, ?, 'Ines Kaltenbach')", KB, bericht, IDS.get("KZ-0005"));
                j.execute("ALTER TABLE bericht_kennzahl_abwahl RENAME TO bericht_kennzahl_abwahl_nicht_da");
                assertThat(kennzahlen(bildung.zusammentragen(con, bericht, DATENSTAND))).containsExactly("KZ-0001", "KZ-0005");

                // Fehlen die Kennzahl-Tabellen, ist der Abschnitt leer — und alles andere ist derselbe Abzug.
                for (String t : List.of("kennzahl_wert_eingang", "kennzahl_wert", "kennzahl_eingang", "kennzahl_fassung",
                        "kennzahl")) {
                    j.execute("ALTER TABLE " + t + " RENAME TO " + t + "_nicht_da");
                }
                assertThat(BerichtKennzahlen.da(j, BerichtKennzahlen.TABELLEN)).isFalse();
                BerichtAbzugBildung.Ergebnis ohne = bildung.zusammentragen(con, bericht, DATENSTAND);
                assertThat(ohne.abzug().path("kennzahlen")).isEmpty();
                assertThat(ohne.quellen()).extracting(BerichtAbzugBildung.Quelle::art).containsOnly("messstelle");
                ObjectNode erwartet = mit.abzug().deepCopy();
                erwartet.putArray("kennzahlen");
                ArrayNode verzeichnis = ((ObjectNode) erwartet.path("kopf")).putArray("quellenverzeichnis");
                texte(mit.abzug().path("kopf").path("quellenverzeichnis")).stream()
                        .filter(q -> !QUELLEN_AP11.contains(q)).forEach(verzeichnis::add);
                assertThat(ohne.text()).as("derselbe Abzug ohne Kennzahlen und ohne ihre vier Quellen")
                        .isEqualTo(BerichtRegeln.kanonisch(erwartet));
            } finally {
                con.rollback();
            }
        }
        assertThat(root.queryForObject("SELECT to_regclass('kennzahl_wert') IS NOT NULL "
                + "AND to_regclass('bericht_kennzahl_abwahl') IS NOT NULL", Boolean.class)).as("zurückgerollt").isTrue();
    }

    @Test
    void d2JedeEinbezogeneBerechnungszeitLiegtVorDemDatenstand_sonstWirdNichtsGebildet() throws Exception {
        BerichtAbzugBildung.Ergebnis e = alsVerwaltung(con -> bildung.zusammentragen(con, bericht, DATENSTAND));
        assertThat(e.berechnetAm()).as("15 Werte und 2 Kennzahlen (AP-12 IP-6), je eine Berechnungszeit").hasSize(17)
                .containsOnly(MONATSLAUF);
        assertThat(BerichtRegeln.d2(e.datenstand(), e.berechnetAm(), List.of(), false)).isEmpty();
        for (JsonNode w : e.abzug().path("werte")) {
            assertThat(Instant.from(java.time.OffsetDateTime.parse(w.path("berechnet_am").asText())))
                    .isBeforeOrEqualTo(Instant.from(java.time.OffsetDateTime.parse(
                            e.abzug().path("kopf").path("datenstand").asText())));
        }

        // Ein Datenstand VOR dem Monatslauf (01.11. 00:10) verletzt D2 — und schreibt nichts.
        long vorher = root.queryForObject("SELECT count(*) FROM bericht_entwurf WHERE bericht_id = ? "
                + "AND datenstand = ?", Long.class, bericht, Timestamp.from(Instant.parse("2026-10-31T23:10:00Z")));
        assertThatThrownBy(() -> alsVerwaltung(con ->
                bildung.bilden(con, bericht, Instant.parse("2026-10-31T23:10:00Z"), "kaskade")))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("D2");
        assertThat(root.queryForObject("SELECT count(*) FROM bericht_entwurf WHERE bericht_id = ? AND datenstand = ?",
                Long.class, bericht, Timestamp.from(Instant.parse("2026-10-31T23:10:00Z")))).isEqualTo(vorher);
    }

    @Test
    void dieBildungBrauchtKeineRohdaten_einZeitraumJenseitsDerNeunzigTageLiefertDenselbenAbzug() throws Exception {
        String rohwerte = "SELECT count(*) FROM device_measurement_sample WHERE tenant_id = ? AND time < ?";
        Timestamp novemberAnfang = Timestamp.from(ENDE);
        BerichtAbzugBildung.Ergebnis mit = alsVerwaltung(con -> bildung.zusammentragen(con, bericht, DATENSTAND));
        if (root.queryForObject(rohwerte, Long.class, KB, novemberAnfang) > 0) {
            // Die Frist läuft ab: die Oktober-Rohwerte werden gelöscht, wie add_retention_policy es tut (90 Tage).
            root.update("DELETE FROM device_measurement_sample WHERE tenant_id = ? AND time < ?", KB, novemberAnfang);
        }
        assertThat(root.queryForObject(rohwerte, Long.class, KB, novemberAnfang)).as("keine Oktober-Rohwerte mehr").isZero();

        BerichtAbzugBildung.Ergebnis ohne = alsVerwaltung(con -> bildung.zusammentragen(con, bericht, DATENSTAND));
        assertThat(ohne.text()).as("derselbe Datenstand ohne Rohwerte: Byte für Byte").isEqualTo(mit.text());
        assertThat(ohne.pruefsumme()).isEqualTo(mit.pruefsumme());

        BerichtAbzugBildung.Ergebnis spaeter = alsVerwaltung(con -> bildung.zusammentragen(con, bericht, NACH_DER_FRIST));
        assertThat(spaeter.abzug().path("kopf").path("datenstand").asText()).isEqualTo("2027-02-01T09:00:00+01:00");
        ObjectNode gleich = spaeter.abzug().deepCopy();
        ((ObjectNode) gleich.path("kopf")).set("datenstand", mit.abzug().path("kopf").path("datenstand"));
        assertThat(BerichtRegeln.kanonisch(gleich)).as("jenseits der 90 Tage: derselbe Abzug, nur der Datenstand ist neu")
                .isEqualTo(mit.text());
    }

    @Test
    void derEntwurfWirdGeschrieben_alsAnwendungAngelegt_alsVerwaltungErsetzt_dieDatenbankPrueftDiePruefsumme()
            throws Exception {
        root.update("DELETE FROM bericht_quelle WHERE bericht_id = ? AND stand_nr IS NULL", bericht);
        root.update("DELETE FROM bericht_entwurf WHERE bericht_id = ?", bericht);

        BerichtAbzugBildung.Ergebnis angelegt = alsAnwendung(KB, con -> bildung.bilden(con, bericht, DATENSTAND, "anlegen"));
        Map<String, Object> e = root.queryForMap("SELECT abzug, pruefsumme, datenstand, gebildet_von, "
                + "bericht_pruefsumme(abzug) AS db FROM bericht_entwurf WHERE bericht_id = ?", bericht);
        assertThat(e.get("abzug")).isEqualTo(angelegt.text());
        assertThat(e.get("pruefsumme")).isEqualTo(angelegt.pruefsumme()).isEqualTo(e.get("db"));
        assertThat(e.get("gebildet_von")).isEqualTo("anlegen");
        assertThat(((Timestamp) e.get("datenstand")).toInstant()).isEqualTo(DATENSTAND);
        assertThat(quellenDesEntwurfs()).as("19 Quellen seit AP-12 IP-6").isEqualTo(19);

        Instant kaskade = Instant.parse("2026-11-12T09:05:33Z");
        BerichtAbzugBildung.Ergebnis neu = alsVerwaltung(con -> bildung.bilden(con, bericht, kaskade, "kaskade"));
        Map<String, Object> n = root.queryForMap("SELECT count(*) OVER () AS zeilen, pruefsumme, datenstand, "
                + "gebildet_von FROM bericht_entwurf WHERE bericht_id = ?", bericht);
        assertThat(n.get("zeilen")).as("genau ein Entwurf (EW1)").isEqualTo(1L);
        assertThat(n.get("gebildet_von")).isEqualTo("kaskade");
        assertThat(n.get("pruefsumme")).isEqualTo(neu.pruefsumme()).isNotEqualTo(angelegt.pruefsumme());
        assertThat(((Timestamp) n.get("datenstand")).toInstant()).isEqualTo(kaskade);
        assertThat(quellenDesEntwurfs()).as("ersetzt, nicht verdoppelt").isEqualTo(19);

        assertThatThrownBy(() -> alsVerwaltung(con -> bildung.bilden(con, bericht, kaskade, "freigabe")))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void einFremderKundenbereichMischtSichNieEin_auchNichtAnDerVerwaltungsrolleOhneRls() throws Exception {
        BerichtAbzugBildung.Ergebnis e = alsVerwaltung(con -> bildung.zusammentragen(con, bericht, DATENSTAND));
        assertThat(zeilen(e.abzug(), "MS-01").get(0).path("menge").decimalValue()).isEqualByComparingTo("128400");
        assertThat(e.text()).doesNotContain("Werk Fremd").doesNotContain("Fremder Netzbezug");
        Set<UUID> fremde = Set.copyOf(root.queryForList("SELECT id FROM messstelle WHERE tenant_id = ?", UUID.class, FREMD));
        assertThat(e.quellen()).extracting(BerichtAbzugBildung.Quelle::objekt).doesNotContainAnyElementsOf(fremde);
        assertThat(e.tenant()).isEqualTo(KB);
    }

    @Test
    void dasRegelwerkNenntSoftwareUndDieSechsVertraege() throws Exception {
        BerichtAbzugBildung echt = new BerichtAbzugBildung(new MeasurementCatalog(JSON), JSON,
                BerichtRegelwerk.heute("0.1.0-SNAPSHOT", null, "0f18bad9"));
        JsonNode rw = alsVerwaltung(con -> echt.zusammentragen(con, bericht, DATENSTAND)).abzug().path("kopf")
                .path("regelwerk");
        assertThat(rw.path("software").asText()).isEqualTo("voltpilot-api 0.1.0-SNAPSHOT (0f18bad9)");
        List<String> vertraege = new ArrayList<>();
        rw.path("vertraege").fieldNames().forEachRemaining(vertraege::add);
        List<String> imVektor = new ArrayList<>();
        soll().path("kopf").path("regelwerk").path("vertraege").fieldNames().forEachRemaining(imVektor::add);
        assertThat(vertraege).as("dieselben sechs Verträge wie der Vektor").containsExactlyInAnyOrderElementsOf(imVektor);
        BerichtRegelwerk.VERTRAEGE.forEach((k, v) -> assertThat(rw.path("vertraege").path(k).asText()).isEqualTo(v));
    }

    // =============================================================================== Das Referenzunternehmen

    private static void ahrenberg() throws Exception {
        root.update("INSERT INTO tenant (id, name) VALUES (?, ?)", KB, "Kunststoffwerk Ahrenberg GmbH");
        JsonNode u = referenz.path("unternehmen");
        UUID un = uuid("INSERT INTO unternehmen (tenant_id, name, zeitzone, sitz_strasse, sitz_ort) "
                + "VALUES (?, ?, 'Europe/Berlin', ?, ?) RETURNING id", KB, u.path("name").asText(),
                u.path("sitz").path("strasse").asText(), u.path("sitz").path("ort").asText());
        UUID st = uuid("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, ?, 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", KB, un, standort("ST-1").path("name").asText());
        IDS.put("ST-1", st);
        for (String anlage : List.of("AN-1", "AN-2")) {
            UUID site = uuid("INSERT INTO site (tenant_id, name) VALUES (?, ?) RETURNING id", KB, anlage);
            root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                    + "VALUES (?, ?, ?, DATE '2024-03-12')", KB, site, st);
            IDS.put(anlage, site);
            IDS.put("BOX:" + anlage, uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                    + "VALUES (?, ?, ?, 'claimed') RETURNING id", KB, site, "VP-BOX-BERICHT-" + anlage));
        }
        // Gebäude und Bereiche von ST-1, zugeordnet ab dem Beginn des Energiemanagements (01.10.2026).
        for (JsonNode g : referenz.path("gebaeude")) {
            if ("ST-1".equals(g.path("standort").asText())) {
                ort("gebaeude", g, st, null);
            }
        }
        for (JsonNode b : referenz.path("bereiche")) {
            if (IDS.containsKey(b.path("eltern").asText())) {
                ort("bereich", b, null, IDS.get(b.path("eltern").asText()));
            }
        }

        JsonNode werte = soll().path("werte");
        for (JsonNode m : referenz.path("messstellen")) {
            String kz = m.path("kennzeichen").asText();
            if (kz.compareTo("MS-01") >= 0 && kz.compareTo("MS-15") <= 0) {
                messstelle(m);
            }
        }
        for (JsonNode m : referenz.path("messstellen")) {
            String kz = m.path("kennzeichen").asText();
            if (kz.compareTo("MS-01") < 0 || kz.compareTo("MS-15") > 0 || !"gemessen".equals(m.path("art").asText())) {
                continue;
            }
            JsonNode q = m.path("fuehrende_quelle").get(0);
            String anlage = m.path("elektrische_stellung").get(0).path("anlage").asText();
            boolean gauge = "gauge".equals(q.path("kanal_wertart").asText());
            String kanal = gauge ? "power_kw" : "energy_kwh";
            UUID entity = komponente(anlage, kz);
            UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                    + "AND gueltig_bis IS NULL", UUID.class, entity);
            JsonNode h = m.path("hauptgroesse");
            root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                    + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_sub, "
                    + "actor_name, actor_art) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'fuehrend', '2024-03-12T00:00:00Z', true, "
                    + "now(), 'sub', 'Probe', 'kunde')", KB, IDS.get(kz), h.path("groesse").asText(),
                    h.path("richtung").asText(), entity, geraet, kanal, gauge ? "gauge" : "counter",
                    gauge ? "integration" : "zaehlerstand");
            if (gauge) {
                // Aus Leistung integriert: die Energie steht in `energie`, das Kennzeichen sagt es (AP-08).
                BigDecimal energie = "MS-04".equals(kz)
                        ? zahl(zeilen(soll(), kz).get(0).path("menge")).subtract(zahl(zeilen(soll(), kz).get(1).path("menge")))
                        : zahl(zeilen(soll(), kz).get(0).path("menge"));
                // MS-04 führt ZWEI Flüsse in einer Größe: die Verdichtung hat sie je Rohwert getrennt
                // (V20260918104000) und in der Periodenzeile abgelegt (V20260918101000) — 7 900 / 7 100,
                // netto 800. Genau diese zwei Zahlen schreibt der Abzug ab, er rechnet sie nicht aus.
                BigDecimal positiv = "MS-04".equals(kz) ? zahl(zeilen(soll(), kz).get(0).path("menge")) : null;
                BigDecimal negativ = "MS-04".equals(kz) ? zahl(zeilen(soll(), kz).get(1).path("menge")) : null;
                root.update("INSERT INTO messreihe_periode (tag, art, tenant_id, entity_id, messkanal, zeitzone, "
                        + "zeitzone_herkunft, beginn, ende, stunden, teile_erwartet, teile_vorhanden, teile_endgueltig, "
                        + "wertart, energie, menge_positiv, menge_negativ, menge_zustand, kennzeichen, erhalten, "
                        + "erwartet, abdeckung_prozent, zustand, endgueltig_ab, version, berechnet_am) "
                        + "VALUES (DATE '2026-10-01', 'monat', ?, ?, ?, "
                        + "'Europe/Berlin', 'standort', ?, ?, 745, 31, 31, 31, 'gauge', ?, ?, ?, 'vollständig', ?::jsonb, 44700, "
                        + "44700, 100, 'endgueltig', ?, 1, ?)", KB, entity, kanal, Timestamp.from(BEGINN),
                        Timestamp.from(ENDE), energie, positiv, negativ,
                        JSON.writeValueAsString(List.of(VerbrauchRegeln.AUS_LEISTUNG_INTEGRIERT)),
                        Timestamp.from(ENDGUELTIG_AB), Timestamp.from(MONATSLAUF));
            } else {
                root.update("INSERT INTO messreihe_periode (tag, art, tenant_id, entity_id, messkanal, zeitzone, "
                        + "zeitzone_herkunft, beginn, ende, stunden, teile_erwartet, teile_vorhanden, teile_endgueltig, "
                        + "wertart, menge, menge_zustand, kennzeichen, erhalten, erwartet, abdeckung_prozent, zustand, "
                        + "endgueltig_ab, version, berechnet_am) VALUES (DATE '2026-10-01', 'monat', ?, ?, ?, "
                        + "'Europe/Berlin', 'standort', ?, ?, 745, 31, 31, 31, 'counter', ?, 'vollständig', '[]'::jsonb, "
                        + "44700, 44700, 100, 'endgueltig', ?, 1, ?)", KB, entity, kanal, Timestamp.from(BEGINN),
                        Timestamp.from(ENDE), zahl(zeilen(soll(), kz).get(0).path("menge")),
                        Timestamp.from(ENDGUELTIG_AB), Timestamp.from(MONATSLAUF));
            }
            if ("MS-01".equals(kz)) {
                rohwerte(anlage, entity);
            }
        }

        // Die Reste und ihre gespeicherte Herkunft (AP-10 E3: die Eingänge je Tag aus der elektrischen Stellung).
        rest("MS-09", "MS-01", werte, List.of(
                new String[] {"MS-01", "zufluss", null}, new String[] {"MS-03", "zufluss", null},
                new String[] {"MS-04", "zufluss", "negativ"}, new String[] {"MS-02", "abfluss", null},
                new String[] {"MS-04", "abfluss", "positiv"}, new String[] {"MS-05", "zugeordnet", null},
                new String[] {"MS-06", "zugeordnet", null}, new String[] {"MS-07", "zugeordnet", null},
                new String[] {"MS-08", "zugeordnet", null}));
        rest("MS-15", "MS-10", werte, List.of(
                new String[] {"MS-10", "zufluss", null}, new String[] {"MS-11", "zugeordnet", null},
                new String[] {"MS-12", "zugeordnet", null}, new String[] {"MS-13", "zugeordnet", null},
                new String[] {"MS-14", "zugeordnet", null}));
        kennzahlenAnlegen();
    }

    /**
     * KZ-0001 und KZ-0005 (Geltung Halle 2) mit ihrem Oktober-Wert, wie AP-11 ihn speichert (10 Nachkommastellen), und ihre
     * Bezugsgrößen BZ-6 (Stück) und BZ-4 (Fläche, Stammdatum) — den Stück-Nenner setzt der Test direkt (AP-12 §8.3 Punkt 2).
     */
    private static void kennzahlenAnlegen() {
        UUID g2 = IDS.get("G-2");
        IDS.put("BZ-4", uuid("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, geltung_art, "
                + "ort_id) VALUES (?, 'BZ-4', ?, 'stammdatum', 'm²', 'gebaeude', ?) RETURNING id", KB,
                ausReferenz("bezugsgroessen", "BZ-4").path("name").asText(), g2));
        IDS.put("BZ-6", uuid("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, "
                + "geltung_art, ort_id) VALUES (?, 'BZ-6', ?, 'periodenwert', 'Stück', 'monat', 'gebaeude', ?) RETURNING id",
                KB, ausReferenz("bezugsgroessen", "BZ-6").path("name").asText(), g2));
        UUID w1 = kennzahlMitOktoberwert("KZ-0001", "0.1487804878", "6100", "41000");
        kennzahlEingang(w1, "KZ-0001", 0, "zaehler", "messstelle", "MS-12", "messstelle_id", "6100", "kWh", 1, null);
        kennzahlEingang(w1, "KZ-0001", 1, "nenner", "bezugsgroesse", "BZ-6", "bezugsgroesse_id", "41000", "Stück", null, 1);
        UUID w5 = kennzahlMitOktoberwert("KZ-0005", "11.9032258065", "36900", "3100");
        kennzahlEingang(w5, "KZ-0005", 0, "zaehler", "messstelle", "MS-10", "messstelle_id", "36900", "kWh", 1, null);
        kennzahlEingang(w5, "KZ-0005", 1, "nenner", "bezugsgroesse", "BZ-4", "bezugsgroesse_id", "3100", "m²", null, null);
    }

    /** Eine Quotienten-Kennzahl der Halle 2 mit Fassung 1 und ihrem endgültigen Oktober-Wert in Version 1. */
    private static UUID kennzahlMitOktoberwert(String kz, String wert, String zaehler, String nenner) {
        JsonNode k = kennzahlAusReferenz(kz);
        UUID id = uuid("INSERT INTO kennzahl (tenant_id, kennzeichen, name, rechenform, geltung_art, ort_id, "
                + "verantwortlich_sub, verantwortlich_name) VALUES (?, ?, ?, 'quotient', 'gebaeude', ?, 'sub-ik', "
                + "'Ines Kaltenbach') RETURNING id", KB, kz, k.path("name").asText(), IDS.get("G-2"));
        IDS.put(kz, id);
        UUID fassung = uuid("INSERT INTO kennzahl_fassung (tenant_id, kennzahl_id, nummer, rechenform, herkunft, actor_sub, "
                + "actor_name, actor_rolle, actor_art, einheit) VALUES (?, ?, 1, 'quotient', 'anlage', 'sub-ik', "
                + "'Ines Kaltenbach', 'energiemanager', 'kunde', ?) RETURNING id", KB, id, k.path("einheit").asText());
        return uuid("INSERT INTO kennzahl_wert (tenant_id, kennzahl_id, periode_art, periode_von, periode_bis, zeitzone, "
                + "version, wert, zaehler, nenner, menge_zustand, kennzeichen, abdeckung_prozent, zustand, endgueltig_ab, "
                + "definition_fassung_id, berechnet_am) VALUES (?, ?, 'monat', DATE '2026-10-01', DATE '2026-10-31', "
                + "'Europe/Berlin', 1, ?::numeric, ?::numeric, ?::numeric, 'vollständig', ?::jsonb, 100, 'endgueltig', ?, ?, ?) "
                + "RETURNING id", KB, id, wert, zaehler, nenner, "[\"" + KennzahlRegeln.BERECHNET_KENNZAHL + "\"]",
                Timestamp.from(ENDGUELTIG_AB), fassung, Timestamp.from(MONATSLAUF));
    }

    private static void kennzahlEingang(UUID wert, String kz, int position, String rolle, String art, String objekt,
            String spalte, String betrag, String einheit, Integer version, Integer fassung) {
        root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + spalte + ", wert, einheit, menge_zustand, abdeckung_prozent, version, fassung, kennzeichen) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::numeric, ?, 'vollständig', 100, ?, ?, '[]'::jsonb)", KB, wert,
                IDS.get(kz), position, rolle, art, objekt, IDS.get(objekt), betrag, einheit, version, fassung);
    }

    private static JsonNode kennzahlAusReferenz(String kennzeichen) {
        return ausReferenz("kennzahlen", kennzeichen);
    }

    private static JsonNode ausReferenz(String liste, String kennzeichen) {
        for (JsonNode e : referenz.path(liste)) {
            if (kennzeichen.equals(e.path("kennzeichen").asText())) {
                return e;
            }
        }
        throw new IllegalStateException(liste + " " + kennzeichen);
    }

    private static List<String> kennzahlen(BerichtAbzugBildung.Ergebnis e) {
        List<String> aus = new ArrayList<>();
        e.abzug().path("kennzahlen").forEach(k -> aus.add(k.path("quelle").asText()));
        return aus;
    }

    private static void ort(String art, JsonNode o, UUID elternStandort, UUID elternOrt) {
        UUID id = uuid("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, ?, ?, ?, 'aktiv') "
                + "RETURNING id", KB, art, o.path("name").asText(), o.path("kennzeichen").asText());
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, eltern_ort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, ?, DATE '2026-10-01')", KB, id, elternStandort, elternOrt);
        IDS.put(o.path("kennzeichen").asText(), id);
    }

    private static void messstelle(JsonNode m) {
        String kz = m.path("kennzeichen").asText();
        JsonNode h = m.path("hauptgroesse");
        UUID id = uuid("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, einheit, "
                + "wertart) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id", KB, kz, m.path("name").asText(),
                m.path("art").asText(), m.path("medium").asText(), h.path("groesse").asText(),
                h.path("richtung").asText(), h.path("einheit").asText(), h.path("wertart").asText());
        IDS.put(kz, id);
        JsonNode ort = m.path("ort");
        boolean amStandort = "standort".equals(ort.path("art").asText());
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, standort_id, ort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, ?, DATE '2026-10-01')", KB, id, amStandort ? IDS.get("ST-1") : null,
                amStandort ? null : IDS.get(ort.path("kennzeichen").asText()));
        JsonNode stellung = m.path("elektrische_stellung").get(0);
        if (Set.of("Hauptzähler", "Erzeuger", "Speicher").contains(stellung.path("stellung").asText())) {
            root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, gueltig_ab) "
                    + "VALUES (?, ?, ?, ?, ?)", KB, id, IDS.get(stellung.path("anlage").asText()),
                    stellung.path("stellung").asText(), LocalDate.parse(stellung.path("gueltig_ab").asText()));
        }
    }

    private static UUID komponente(String anlage, String name) {
        UUID entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, "
                + "communication, connection_json, created_at) VALUES (?, ?, 'grid-meter', ?, 'grid-meter', ?, "
                + "'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, '2024-03-12T00:00:00Z') RETURNING id",
                KB, IDS.get(anlage), "K " + name, IDS.get("BOX:" + anlage));
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, 'energy_kwh', true, 60, 1, "
                + "'2024-03-12T00:00:00Z', '2026.09.11.1', 'test', 'pending_edge', 'live_power', 'fifteen_minute')",
                KB, IDS.get(anlage), IDS.get("BOX:" + anlage), entity);
        return entity;
    }

    private static void rest(String kz, String hauptzaehler, JsonNode werte, List<String[]> eingaenge) {
        UUID fassung = uuid("INSERT INTO messstelle_formel_fassung (tenant_id, messstelle_id, nummer, formel_typ, herkunft, "
                + "actor_sub, actor_name, actor_art, rest_hauptzaehler_id) VALUES (?, ?, 1, 'rest', 'anlage', 'sub-test', "
                + "'Test', 'kunde', ?) RETURNING id", KB, IDS.get(kz), IDS.get(hauptzaehler));
        root.update("INSERT INTO messreihe_periode (tag, art, tenant_id, messstelle_id, formel_fassung_id, formel_typ, "
                + "zeitzone, zeitzone_herkunft, beginn, ende, stunden, menge, menge_zustand, kennzeichen, abdeckung_prozent, "
                + "zustand, endgueltig_ab, version, berechnet_am) VALUES (DATE '2026-10-01', 'monat', ?, ?, ?, 'rest', "
                + "'Europe/Berlin', 'standort', ?, ?, 745, ?, 'vollständig', ?::jsonb, 100, 'endgueltig', ?, 1, ?)",
                KB, IDS.get(kz), fassung, Timestamp.from(BEGINN), Timestamp.from(ENDE),
                zahl(zeilen(soll(), kz).get(0).path("menge")),
                zeilen(soll(), kz).get(0).path("kennzeichen").toString(), Timestamp.from(ENDGUELTIG_AB),
                Timestamp.from(MONATSLAUF));
        int position = 0;
        for (String[] e : eingaenge) {
            List<JsonNode> quelle = zeilen(soll(), e[0]);
            JsonNode zeile = e[2] == null ? quelle.get(0)
                    : quelle.get("positiv".equals(e[2]) ? 0 : 1); // MS-04: laden = positiv, entladen = negativ
            root.update("INSERT INTO bilanzwert_eingang (periode_beginn, tenant_id, messstelle_id, periode, version, "
                    + "position, eingang_messstelle_id, eingang_kennzeichen, rolle, anteil, menge, menge_zustand, fassung, "
                    + "abdeckung_prozent, eingang_version, kennzeichen, berechnet_am) VALUES (?, ?, ?, 'monat', 1, ?, ?, ?, "
                    + "?, ?, ?, 'vollständig', 'endgueltig', 100, 1, '[]'::jsonb, ?)", Timestamp.from(BEGINN), KB,
                    IDS.get(kz), position++, IDS.get(e[0]), e[0], e[1], e[2], zahl(zeile.path("menge")),
                    Timestamp.from(MONATSLAUF));
        }
    }

    /** Einige Oktober-Rohwerte an MS-01 — die Bildung darf sie nie brauchen. */
    private static void rohwerte(String anlage, UUID entity) {
        List<Object[]> stapel = new ArrayList<>();
        Instant t = Instant.parse("2026-10-15T00:00:00Z");
        for (int i = 0; i < 96; i++) {
            Instant zeit = t.plusSeconds(900L * i);
            stapel.add(new Object[] {Timestamp.from(zeit), Timestamp.from(zeit.plusSeconds(2)), KB, IDS.get(anlage),
                IDS.get("BOX:" + anlage), new BigDecimal(500_000 + i), zeit.getEpochSecond(), entity});
        }
        root.batchUpdate("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, "
                + "point_key, raw_numeric, quality, catalog_version, edge_sequence, aggregation_kind, entity_id, "
                + "applied_revision, value_kind, role, delivery, delay_s) VALUES (?, ?, ?, ?, ?, 'energy_kwh', ?, 'good', "
                + "'2026.09.11.1', ?, 'counter', ?, 3, 'counter', 'fuehrend', 'direkt', 2)", stapel);
    }

    /** Ein zweiter Kundenbereich mit eigenem Standort ST-1 und eigenem MS-01 — er darf nie im Abzug erscheinen. */
    private static void fremderKundenbereich() {
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kundenbereich B')", FREMD);
        UUID un = uuid("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, 'Fremd GmbH', 'Europe/Berlin') "
                + "RETURNING id", FREMD);
        UUID st = uuid("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, 'Werk Fremd', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", FREMD, un);
        UUID site = uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-1') RETURNING id", FREMD);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, DATE '2024-03-12')", FREMD, site, st);
        UUID box = uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, 'VP-BOX-FREMD', "
                + "'claimed') RETURNING id", FREMD, site);
        UUID entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, "
                + "communication, connection_json, created_at) VALUES (?, ?, 'grid-meter', 'K-F', 'grid-meter', ?, "
                + "'modbus_tcp', '{\"ip\":\"10.0.0.8\",\"unit_id\":1}'::jsonb, '2024-03-12T00:00:00Z') RETURNING id",
                FREMD, site, box);
        UUID ms = uuid("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, einheit, "
                + "wertart) VALUES (?, 'MS-01', 'Fremder Netzbezug', 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                + "'Zählerstand') RETURNING id", FREMD);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, DATE '2026-10-01')", FREMD, ms, st);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, entity);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_sub, "
                + "actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', 'Bezug', ?, ?, 'energy_kwh', 'counter', "
                + "'zaehlerstand', 'fuehrend', '2024-03-12T00:00:00Z', true, now(), 'sub', 'Probe', 'kunde')",
                FREMD, ms, entity, geraet);
        root.update("INSERT INTO messreihe_periode (tag, art, tenant_id, entity_id, messkanal, zeitzone, zeitzone_herkunft, "
                + "beginn, ende, stunden, teile_erwartet, teile_vorhanden, teile_endgueltig, wertart, menge, menge_zustand, "
                + "kennzeichen, erhalten, erwartet, abdeckung_prozent, zustand, endgueltig_ab, version, berechnet_am) "
                + "VALUES (DATE '2026-10-01', 'monat', ?, ?, 'energy_kwh', 'Europe/Berlin', 'standort', ?, ?, 745, 31, 31, "
                + "31, 'counter', 999, 'vollständig', '[]'::jsonb, 44700, 44700, 100, 'endgueltig', ?, 1, ?)",
                FREMD, entity, Timestamp.from(BEGINN), Timestamp.from(ENDE), Timestamp.from(ENDGUELTIG_AB),
                Timestamp.from(MONATSLAUF));
    }

    // =============================================================================== Hilfen

    private static JsonNode soll() {
        return vektoren.path("abzuege").path("BR-2026-0001/1");
    }

    private static JsonNode schemaAbzug() throws Exception {
        JsonNode schema = JSON.readTree(Files.readString(V2.resolve("bericht.schema.json")));
        ObjectNode wurzel = JSON.createObjectNode();
        wurzel.set("$defs", schema.path("$defs"));
        wurzel.put("$ref", "#/$defs/abzug");
        return wurzel;
    }

    private static JsonNode standort(String kennzeichen) {
        for (JsonNode s : referenz.path("standorte")) {
            if (kennzeichen.equals(s.path("kennzeichen").asText())) {
                return s;
            }
        }
        throw new IllegalStateException(kennzeichen);
    }

    private static List<JsonNode> zeilen(JsonNode abzug, String quelle) {
        List<JsonNode> aus = new ArrayList<>();
        abzug.path("werte").forEach(w -> {
            if (quelle.equals(w.path("quelle").asText())) {
                aus.add(w);
            }
        });
        return aus;
    }

    private static void ersetzeZeilen(ObjectNode abzug, String quelle, JsonNode durch) {
        ArrayNode neu = JSON.createArrayNode();
        boolean gesetzt = false;
        for (JsonNode w : abzug.path("werte")) {
            if (!quelle.equals(w.path("quelle").asText())) {
                neu.add(w);
            } else if (!gesetzt) {
                neu.add(durch);
                gesetzt = true;
            }
        }
        abzug.set("werte", neu);
    }

    private static List<String> texte(JsonNode liste) {
        List<String> aus = new ArrayList<>();
        liste.forEach(x -> aus.add(x.asText()));
        return aus;
    }

    private static BigDecimal zahl(JsonNode n) {
        return new BigDecimal(n.asText());
    }

    private long quellenDesEntwurfs() {
        return root.queryForObject("SELECT count(*) FROM bericht_quelle WHERE bericht_id = ? AND stand_nr IS NULL",
                Long.class, bericht);
    }

    private static <T> T alsAnwendung(UUID tenant, MitVerbindung<T> f) throws Exception {
        TenantContext.set(tenant);
        try (Connection con = app.getConnection()) {
            return inTransaktion(con, f);
        } finally {
            TenantContext.clear();
        }
    }

    private static <T> T alsVerwaltung(MitVerbindung<T> f) throws Exception {
        try (Connection con = admin.getConnection()) {
            return inTransaktion(con, f);
        }
    }

    private static <T> T inTransaktion(Connection con, MitVerbindung<T> f) throws Exception {
        con.setAutoCommit(false);
        try {
            T t = f.mit(con);
            con.commit();
            return t;
        } catch (Exception e) {
            con.rollback();
            throw e;
        }
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
