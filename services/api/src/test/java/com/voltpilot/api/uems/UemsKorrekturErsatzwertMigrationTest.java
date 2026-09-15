package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.EreignisVokabular.Urheber;
import com.voltpilot.api.uems.MessreiheErsatzwertRepository.Anlage;
import com.voltpilot.api.uems.MessreiheErsatzwertRepository.Ersatzwert;
import com.voltpilot.api.uems.MessreiheKorrekturRepository.Korrektur;
import com.voltpilot.api.uems.MessreiheKorrekturRepository.Reihe;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
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
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Migration {@code V20260913190000} (UEMS AP-08 IP-12) gegen eine echte TimescaleDB: die Tabellen
 * {@code messreihe_ersatzwert} und {@code messreihe_korrektur}, ihr Vokabular
 * {@code messreihe_korrektur_vokabular()} und die Ereignis-Arten {@code substitute}/{@code correction}.
 *
 * <p>Der Prüfnachweis des Konzepts (§8 IP-12: „Migrationstest; Vokabular-Test zeilengleich“): die
 * Migration legt nur daneben (Bestandsschutz-Vergleich vor/nach, Mutationsprobe); die Wörter der
 * Datenbank sind Zeile für Zeile die der Vektor-Datei, und kein CHECK trägt eine eigene Liste; die
 * Unterscheidung von E7 — a–c verteilen genau den gemessenen Zuwachs einer Lücke, e–g stehen nur, wo
 * keiner gemessen ist — erzwingt die Datenbank; ein UPDATE scheitert für jede Rolle, auch für die
 * Verwaltung mit Recht; Rücknahme, Freigabe und Ablehnung sind Fortschreibungen; der Zaun hält; das
 * Offboarding räumt beide Tabellen. Die Rechenmethoden (IP-13) sind nicht Gegenstand — die Zahlen
 * der Beispiele sind die des Referenzfalls F11/F21 (MS-10, Box-Tausch Halle 2).
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsKorrekturErsatzwertMigrationTest {

    private static final String DIESE = "20260913190000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2",
            "events-vocabulary-vectors.json");
    private static final List<String> TABELLEN = List.of("messreihe_ersatzwert", "messreihe_korrektur");
    private static final List<String> VOKABULARE = List.of("ersatzwert_methode", "ersatzwert_status",
            "korrektur_art", "korrektur_status");
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final ObjectMapper JSON = new ObjectMapper();

    /** F11: der Zähler MS-10 zählte über den Box-Tausch weiter — 418 200,0 → 420 072,0 kWh. */
    private static final String KANAL = "Wirkenergie Bezug";
    private static final Instant LUECKE_VON = Instant.parse("2026-11-03T13:01:00Z");
    private static final Instant LUECKE_BIS = Instant.parse("2026-11-04T08:30:00Z");
    private static final Instant EW_VON = Instant.parse("2026-11-03T13:00:00Z");
    private static final BigDecimal STAND_VOR = new BigDecimal("418200.0");
    private static final BigDecimal STAND_NACH = new BigDecimal("420072.0");
    private static final BigDecimal ZUWACHS = new BigDecimal("1872.0");

    private static final ProtokollAkteur INES = new ProtokollAkteur("kc-ines-kaltenbach", "Ines Kaltenbach",
            "energiemanager", "kunde");
    private static final ProtokollAkteur JONAS = new ProtokollAkteur("kc-jonas-wendlinger", "Jonas Wendlinger",
            "kundenadministrator", "kunde");
    private static final ProtokollAkteur SYSTEM = new ProtokollAkteur(null, "Nachlieferung nach Endgültigkeit",
            "voltpilot_betrieb", "voltpilot");

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
    private static MessreiheErsatzwertRepository ersatzwerte;
    private static MessreiheKorrekturRepository korrekturen;
    private static MessreiheEreignisRepository ereignisse;
    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;
    private static UUID bestandA;

    /** Ein Kundenbereich mit einer Zählerreihe (Komponente K-8.1 · Wirkenergie Bezug) und ihrer Lücke. */
    private record Kunde(UUID tenant, UUID entity, UUID luecke) {
        Reihe reihe() {
            return new Reihe(entity, KANAL);
        }
    }

    @BeforeAll
    static void bestandUndMigration() throws IOException {
        vertrag = JSON.readTree(VEKTOREN.toFile());
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        ersatzwerte = new MessreiheErsatzwertRepository(app);
        korrekturen = new MessreiheKorrekturRepository(app);
        ereignisse = new MessreiheEreignisRepository(app);

        flyway().target(letzteFassungVorDieser()).load().migrate();
        // Der Bestand: ein Kundenbereich mit Unternehmen und einer geschlossenen Lücke MIT Zuwachs in
        // der Ereignis-Tabelle — die Tabelle, deren Vokabular diese Migration weitet.
        bestandA = root.queryForObject("INSERT INTO tenant (name) VALUES ('Kunststoffwerk Ahrenberg GmbH') "
                + "RETURNING id", UUID.class);
        root.update("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH', "
                + "'Europe/Berlin')", bestandA);
        luecke(bestandA, UUID.randomUUID(), UUID.randomUUID(), LUECKE_VON, LUECKE_BIS, ZUWACHS);
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());

        flyway().target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        flyway().load().migrate();
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ============================================================ Vokabular zeilengleich

    @Test
    void dieWoerterDerDatenbankSindZeileFuerZeileDieDerVektorDatei() {
        List<String> ausVertrag = new ArrayList<>();
        for (String vokabular : VOKABULARE) {
            int nr = 1;
            for (JsonNode w : vertrag.path("vokabular").path(vokabular)) {
                ausVertrag.add(zeile(vokabular, nr++, w));
            }
        }
        List<String> ausDatenbank = root.query("SELECT vokabular, nr, wort, buchstabe, zuwachs, bezug, zeitform, "
                + "array_to_string(folgt_auf, ',') AS folgt_auf, folgt_auf IS NULL AS ohne_folge, grund_pflicht, "
                + "ersatzwert, beleg_pflicht FROM messreihe_korrektur_vokabular()", (rs, n) -> String.join(", ",
                "'" + rs.getString("vokabular") + "'", String.valueOf(rs.getInt("nr")), "'" + rs.getString("wort") + "'",
                text(rs.getString("buchstabe")), text(rs.getString("zuwachs")), text(rs.getString("bezug")),
                text(rs.getString("zeitform")),
                rs.getBoolean("ohne_folge") ? "NULL" : "{" + rs.getString("folgt_auf") + "}",
                bool(rs.getObject("grund_pflicht")), bool(rs.getObject("ersatzwert")), bool(rs.getObject("beleg_pflicht"))));
        assertThat(ausDatenbank)
                .as("Der Vertrag hat sein Vokabular geändert — eine NEUE Migration ersetzt "
                        + "messreihe_korrektur_vokabular() durch diese Zeilen:\n"
                        + ausVertrag.stream().map(z -> "    (" + z + ")").collect(Collectors.joining(",\n")))
                .containsExactlyElementsOf(ausVertrag);
        // … und dieselben Wörter prüfen beide Java-Zwillinge in den Meldungen substitute/correction.
        assertThat(woerter("ersatzwert_methode")).containsExactlyElementsOf(EreignisVokabular.ERSATZWERT_METHODE);
        assertThat(woerter("ersatzwert_status")).containsExactlyElementsOf(EreignisVokabular.ERSATZWERT_STATUS);
        assertThat(woerter("korrektur_art")).containsExactlyElementsOf(EreignisVokabular.KORREKTUR_ART);
        assertThat(woerter("korrektur_status")).containsExactlyElementsOf(EreignisVokabular.KORREKTUR_STATUS);
        // E7: sieben Methoden, a–c verteilen einen gemessenen Zuwachs, f und g nie.
        assertThat(root.queryForList("SELECT buchstabe || ':' || coalesce(zuwachs, '-') FROM messreihe_korrektur_vokabular() "
                + "WHERE vokabular = 'ersatzwert_methode' ORDER BY nr", String.class))
                .containsExactly("a:gemessen", "b:gemessen", "c:gemessen", "d:-", "e:keiner", "f:keiner", "g:keiner");
    }

    @Test
    void jederCheckFragtDieEineStelleUndTraegtKeineEigeneListe() {
        List<String> alleWoerter = new ArrayList<>();
        VOKABULARE.forEach(v -> alleWoerter.addAll(woerter(v)));
        for (String tabelle : TABELLEN) {
            List<String> checks = root.queryForList("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                    + "WHERE conrelid = ?::regclass AND contype = 'c'", String.class, tabelle);
            assertThat(checks).as(tabelle).isNotEmpty();
            for (String def : checks) {
                for (String wort : alleWoerter) {
                    assertThat(def).as(tabelle + " trägt das Wort " + wort).doesNotContain("'" + wort + "'");
                }
            }
            assertThat(checks).as(tabelle + ": Status fragt die Funktion")
                    .anySatisfy(d -> assertThat(d).contains("messreihe_korrektur_wort"));
        }
    }

    @Test
    void dasEreignisVokabularKenntErsatzwertUndKorrektur() {
        assertThat(root.queryForList("SELECT art FROM messreihe_ereignis_vokabular()", String.class))
                // AP-10 IP-8 hängt verteilung_geaendert dahinter an — additiv, die Reihenfolge bleibt.
                .containsSubsequence("substitute", "correction")
                .containsExactlyElementsOf(Arrays.stream(EreignisVokabular.Art.values())
                        .map(EreignisVokabular.Art::code).toList());
        Map<String, Object> ew = root.queryForMap("SELECT array_to_string(urheber, ',') AS u, array_to_string(pflicht, ',') "
                + "AS p FROM messreihe_ereignis_vokabular() WHERE art = 'substitute'");
        assertThat(ew).containsEntry("u", "kunde").containsEntry("p", "ersatzwert,methode,status");
        Map<String, Object> k = root.queryForMap("SELECT array_to_string(urheber, ',') AS u, array_to_string(felder, ',') "
                + "AS f FROM messreihe_ereignis_vokabular() WHERE art = 'correction'");
        // AP-09 IP-7 hängt die Felder der Bezugsgröße an — additiv, `ersatzwert` bleibt vorn.
        assertThat(k).containsEntry("u", "cloud,kunde").containsEntry("f", "ersatzwert,fassung_alt,fassung_neu,import");
        // Jeder angenommene Fall der beiden Arten landet über den Schreibweg in der Tabelle.
        Kunde kb = kunde("Ereignisse Ersatzwert");
        int angehaengt = 0;
        for (JsonNode c : vertrag.path("cases")) {
            JsonNode e = c.path("input").path("ereignis");
            String art = e.path("art").asText();
            if (!List.of("substitute", "correction").contains(art)) {
                continue;
            }
            ObjectNode fuerDb = e.deepCopy();
            fuerDb.put("ereignis_id", UUID.randomUUID().toString());
            Urheber u = Urheber.vonCode(c.path("input").path("urheber").asText());
            MessreiheEreignisRepository.Ergebnis r = als(kb.tenant(), () -> ereignisse.anhaengen(kb.tenant(), null, u,
                    fuerDb, null, null));
            boolean angenommen = "angenommen".equals(c.path("expected").path("urteil").asText());
            assertThat(r.ausgang()).as(c.path("name").asText())
                    .isEqualTo(angenommen ? MessreiheEreignisRepository.Ausgang.ANGEHAENGT
                            : MessreiheEreignisRepository.Ausgang.VERWORFEN);
            angehaengt += angenommen ? 1 : 0;
        }
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE tenant_id = ? "
                + "AND art IN ('substitute', 'correction')", Integer.class, kb.tenant())).isEqualTo(angehaengt)
                // AP-09 IP-7: dazu die Berichtigung des Bezugsgrößen-Werts BK-2026-0001 (Bezug bezugsgroesse).
                .isEqualTo(8);
    }

    // ============================================================ E7 in der Datenbank

    @Test
    void aBisCVerteilenGenauDenGemessenenZuwachsIhrerLuecke() {
        Kunde k = kunde("E7 gemessen");
        // F11: EW-…-0001 verteilt 1 872,0 kWh gleichmäßig — die Zahlen SIND die der Lücke.
        Ersatzwert a = imZug(k, () -> ersatzwerte.erfassen(k.tenant(), verteilen(k, "gleichmaessig_verteilen"), INES, BERLIN));
        assertThat(a.kennung()).matches("EW-\\d{4}-0001");
        assertThat(a.status()).isEqualTo("wirksam");
        assertThat(a.anlage().zuwachs()).isEqualByComparingTo(ZUWACHS);
        assertThat(a.erfasser()).isEqualTo(INES);
        Ersatzwert b = imZug(k, () -> ersatzwerte.erfassen(k.tenant(), mitVorperiode(verteilen(k, "profil_vorperiode"),
                Instant.parse("2026-10-27T13:00:00Z")), INES, BERLIN));
        assertThat(b.kennung()).matches("EW-\\d{4}-0002");
        imZug(k, () -> ersatzwerte.erfassen(k.tenant(), mitVergleich(verteilen(k, "profil_vergleichsquelle")), INES, BERLIN));

        // Ein getippter Zuwachs ist nicht der gemessene — die Summe hat keine zweite Quelle.
        abgelehnt("messreihe_ersatzwert_zuwachs_gemessen", () -> imZug(k, () -> ersatzwerte.erfassen(k.tenant(),
                mitZuwachs(verteilen(k, "gleichmaessig_verteilen"), new BigDecimal("1900.0"), STAND_VOR,
                        new BigDecimal("420100.0")), INES, BERLIN)));
        // Nicht über die Viertelstunden der Lücke hinaus.
        abgelehnt("messreihe_ersatzwert_zuwachs_gemessen", () -> imZug(k, () -> ersatzwerte.erfassen(k.tenant(),
                mitZeitraum(verteilen(k, "gleichmaessig_verteilen"), Instant.parse("2026-11-03T12:45:00Z"), LUECKE_BIS),
                INES, BERLIN)));
        // Nicht an einer anderen Reihe, nicht ohne Lücke, nicht mit einer Lücke ohne Zuwachs.
        abgelehnt("messreihe_ersatzwert_zuwachs_gemessen", () -> imZug(k, () -> ersatzwerte.erfassen(k.tenant(),
                mitKanal(verteilen(k, "gleichmaessig_verteilen"), "Wirkenergie Abgabe"), INES, BERLIN)));
        abgelehnt("messreihe_ersatzwert_zuwachs_gemessen", () -> imZug(k, () -> ersatzwerte.erfassen(k.tenant(),
                mitLuecke(verteilen(k, "gleichmaessig_verteilen"), UUID.randomUUID()), INES, BERLIN)));
        UUID offen = luecke(k.tenant(), k.entity(), UUID.randomUUID(), Instant.parse("2026-11-06T10:00:00Z"),
                Instant.parse("2026-11-06T11:00:00Z"), null);
        abgelehnt("messreihe_ersatzwert_zuwachs_gemessen", () -> imZug(k, () -> ersatzwerte.erfassen(k.tenant(),
                mitZeitraum(mitLuecke(verteilen(k, "gleichmaessig_verteilen"), offen),
                        Instant.parse("2026-11-06T10:00:00Z"), Instant.parse("2026-11-06T11:00:00Z")), INES, BERLIN)));
        // b ohne Vorperiode, c ohne Vergleichsquelle: die Methode nennt, worauf sie sich stützt.
        abgelehnt("messreihe_ersatzwert_bezug_chk", () -> imZug(k, () -> ersatzwerte.erfassen(k.tenant(),
                verteilen(k, "profil_vorperiode"), INES, BERLIN)));
        abgelehnt("messreihe_ersatzwert_bezug_chk", () -> imZug(k, () -> ersatzwerte.erfassen(k.tenant(),
                verteilen(k, "profil_vergleichsquelle"), INES, BERLIN)));
        // Die Rechnung steht in der Zeile: Zuwachs = Stand danach − Stand davor, nie negativ.
        abgelehnt("messreihe_ersatzwert_zuwachs_chk", () -> alsTue(k.tenant(), () -> app.update(
                "INSERT INTO messreihe_ersatzwert (tenant_id, kennung, fassung, status, methode, entity_id, messkanal, "
                        + "von, bis, begruendung, zuwachs, einheit, vorperiode_von, actor_sub, actor_name, actor_rolle, "
                        + "actor_art) VALUES (?, 'EW-2026-0901', 1, 'wirksam', 'vorperiode_uebernehmen', ?, ?, ?, ?, ?, "
                        + "24.0, 'kWh', ?, ?, ?, ?, ?)",
                k.tenant(), k.entity(), KANAL, ts(Instant.parse("2026-11-10T08:00:00Z")),
                ts(Instant.parse("2026-11-10T09:00:00Z")), "Karte defekt, Vorwoche als Ersatz",
                ts(Instant.parse("2026-11-03T08:00:00Z")),
                INES.sub(), INES.name(), INES.rolle(), INES.art())));
        assertThat(zahl("messreihe_ersatzwert", k.tenant())).as("nur die drei gültigen").isEqualTo(3);
    }

    @Test
    void eBisGStehenNurWoKeinZuwachsGemessenIst() {
        Kunde k = kunde("E7 ohne Zuwachs");
        // Über die Lücke mit gemessenem Zuwachs: f, g UND e werden abgewiesen — der Zuwachs wird verteilt, nie ersetzt.
        abgelehnt("messreihe_ersatzwert_ohne_zuwachs", () -> imZug(k, () -> ersatzwerte.erfassen(k.tenant(),
                mitVorperiode(ohneZuwachs(k, "vorperiode_uebernehmen", EW_VON, LUECKE_BIS), Instant.parse("2026-10-27T13:00:00Z")),
                INES, BERLIN)));
        abgelehnt("messreihe_ersatzwert_ohne_zuwachs", () -> imZug(k, () -> ersatzwerte.erfassen(k.tenant(),
                mitVergleich(ohneZuwachs(k, "vergleichsquelle_uebernehmen", EW_VON, LUECKE_BIS)), INES, BERLIN)));
        abgelehnt("messreihe_ersatzwert_ohne_zuwachs", () -> imZug(k, () -> ersatzwerte.erfassen(k.tenant(),
                eingeben(ohneZuwachs(k, "wert_eingeben", EW_VON, Instant.parse("2026-11-03T13:15:00Z"))), INES, BERLIN)));
        // Die angeschnittene Viertelstunde am Ende der Lücke zählt mit, die danach nicht.
        abgelehnt("messreihe_ersatzwert_ohne_zuwachs", () -> imZug(k, () -> ersatzwerte.erfassen(k.tenant(),
                mitVorperiode(ohneZuwachs(k, "vorperiode_uebernehmen", Instant.parse("2026-11-04T08:15:00Z"),
                        Instant.parse("2026-11-04T08:45:00Z")), Instant.parse("2026-10-28T08:15:00Z")), INES, BERLIN)));
        Ersatzwert danach = imZug(k, () -> ersatzwerte.erfassen(k.tenant(), mitVorperiode(ohneZuwachs(k,
                "vorperiode_uebernehmen", LUECKE_BIS, Instant.parse("2026-11-04T08:45:00Z")),
                Instant.parse("2026-10-28T08:30:00Z")), INES, BERLIN));
        assertThat(danach.anlage().zuwachs()).isNull();
        // Eine Leistungsreihe ohne Lücken-Zuwachs: g und e stehen (e nur mit Beleg).
        Reihe leistung = new Reihe(k.entity(), "Wirkleistung");
        imZug(k, () -> ersatzwerte.erfassen(k.tenant(), mitVergleich(mitKanal(ohneZuwachs(k, "vergleichsquelle_uebernehmen",
                EW_VON, LUECKE_BIS), leistung.messkanal())), INES, BERLIN));
        Ersatzwert e = imZug(k, () -> ersatzwerte.erfassen(k.tenant(), eingeben(mitKanal(ohneZuwachs(k, "wert_eingeben",
                EW_VON, Instant.parse("2026-11-03T14:00:00Z")), leistung.messkanal())), INES, BERLIN));
        assertThat(e.anlage().betrag()).isEqualByComparingTo("96.0");
        abgelehnt("messreihe_ersatzwert_bezug_chk", () -> imZug(k, () -> ersatzwerte.erfassen(k.tenant(),
                mitBeleg(eingeben(mitKanal(ohneZuwachs(k, "wert_eingeben", EW_VON, Instant.parse("2026-11-03T14:00:00Z")),
                        leistung.messkanal())), null), INES, BERLIN)));
        // Eine offene Lücke hat noch keinen Zuwachs — sie hält e–g nicht auf.
        luecke(k.tenant(), k.entity(), UUID.randomUUID(), Instant.parse("2026-11-07T10:00:00Z"),
                Instant.parse("2026-11-07T11:00:00Z"), null);
        imZug(k, () -> ersatzwerte.erfassen(k.tenant(), mitVorperiode(ohneZuwachs(k, "vorperiode_uebernehmen",
                Instant.parse("2026-11-07T10:00:00Z"), Instant.parse("2026-11-07T11:00:00Z")),
                Instant.parse("2026-10-31T10:00:00Z")), INES, BERLIN));
        // f trägt keinen Zuwachs und keine Einheit; die Vorperiode liegt davor und im Raster.
        abgelehnt("messreihe_ersatzwert_bezug_chk", () -> imZug(k, () -> ersatzwerte.erfassen(k.tenant(),
                mitVorperiode(ohneZuwachs(k, "vorperiode_uebernehmen", Instant.parse("2026-11-08T10:00:00Z"),
                        Instant.parse("2026-11-08T11:00:00Z")), Instant.parse("2026-11-09T10:00:00Z")), INES, BERLIN)));
        assertThat(zahl("messreihe_ersatzwert", k.tenant())).isEqualTo(4);
    }

    @Test
    void dTraegtEinenAblesestandZurMinuteInSeinerViertelstunde() {
        Kunde k = kunde("E7 Ablesestand");
        // F12: der Endstand 6 184,90 der Rücksetzung 09:12 — in (09:00, 09:15].
        Ersatzwert d = imZug(k, () -> ersatzwerte.erfassen(k.tenant(), ablesestand(k, "2027-01-15T08:00:00Z",
                "2027-01-15T08:15:00Z", "2027-01-15T08:12:00Z"), INES, BERLIN));
        assertThat(d.anlage().endstand()).isEqualByComparingTo("6184.90");
        // Die Grenze gehört zur Viertelstunde davor (Wechsel um 09:15 → 09:00–09:15).
        imZug(k, () -> ersatzwerte.erfassen(k.tenant(), ablesestand(k, "2027-01-15T08:00:00Z", "2027-01-15T08:15:00Z",
                "2027-01-15T08:15:00Z"), INES, BERLIN));
        abgelehnt("messreihe_ersatzwert_zeitpunkt_chk", () -> imZug(k, () -> ersatzwerte.erfassen(k.tenant(),
                ablesestand(k, "2027-01-15T08:00:00Z", "2027-01-15T08:15:00Z", "2027-01-15T08:00:00Z"), INES, BERLIN)));
        abgelehnt("messreihe_ersatzwert_zeitpunkt_chk", () -> imZug(k, () -> ersatzwerte.erfassen(k.tenant(),
                ablesestand(k, "2027-01-15T08:00:00Z", "2027-01-15T08:30:00Z", "2027-01-15T08:12:00Z"), INES, BERLIN)));
        abgelehnt("messreihe_ersatzwert_zeitpunkt_chk", () -> imZug(k, () -> ersatzwerte.erfassen(k.tenant(),
                ablesestand(k, "2027-01-15T08:00:00Z", "2027-01-15T08:15:00Z", "2027-01-15T08:12:30Z"), INES, BERLIN)));
        Anlage ohneStand = ablesestand(k, "2027-01-15T08:00:00Z", "2027-01-15T08:15:00Z", "2027-01-15T08:12:00Z");
        abgelehnt("messreihe_ersatzwert_bezug_chk", () -> imZug(k, () -> ersatzwerte.erfassen(k.tenant(),
                new Anlage(ohneStand.methode(), ohneStand.entityId(), ohneStand.messkanal(), null, ohneStand.von(),
                        ohneStand.bis(), ohneStand.zeitpunkt(), ohneStand.begruendung(), null, null, null, null, null,
                        null, null, null, null, null, null), INES, BERLIN)));
        // Neben dem Raster, eine unbekannte Methode (E7 Option C „Wochentagsmittel“ nicht gewählt), zu kurze Begründung.
        abgelehnt("messreihe_ersatzwert_zeitraum_chk", () -> imZug(k, () -> ersatzwerte.erfassen(k.tenant(),
                ablesestand(k, "2027-01-15T08:01:00Z", "2027-01-15T08:16:00Z", "2027-01-15T08:12:00Z"), INES, BERLIN)));
        abgelehnt("messreihe_ersatzwert_methode_chk", () -> imZug(k, () -> ersatzwerte.erfassen(k.tenant(),
                mitMethode(ohneZuwachs(k, "vorperiode_uebernehmen", EW_VON, LUECKE_BIS), "wochentagsmittel"), INES, BERLIN)));
        abgelehnt("messreihe_ersatzwert_begruendung_chk", () -> imZug(k, () -> ersatzwerte.erfassen(k.tenant(),
                mitBegruendung(ablesestand(k, "2027-01-15T08:00:00Z", "2027-01-15T08:15:00Z", "2027-01-15T08:12:00Z"),
                        "Protokoll"), INES, BERLIN)));
        abgelehnt("messreihe_ersatzwert_anlage_chk", () -> imZug(k, () -> ersatzwerte.erfassen(k.tenant(),
                mitBegruendung(ablesestand(k, "2027-01-15T08:00:00Z", "2027-01-15T08:15:00Z", "2027-01-15T08:12:00Z"),
                        null), INES, BERLIN)));
    }

    // ============================================================ append-only und Fortschreibung

    @Test
    void einUpdateScheitertFuerJedeRolleUndEineRuecknahmeIstEineFortschreibung() {
        Kunde k = kunde("Append-only");
        Ersatzwert ew = imZug(k, () -> ersatzwerte.erfassen(k.tenant(), verteilen(k, "gleichmaessig_verteilen"), INES, BERLIN));
        Korrektur kor = imZug(k, () -> korrekturen.vorschlagen(k.tenant(), zumErsatzwert(k, ew), INES, BERLIN));
        for (String tabelle : TABELLEN) {
            String kennung = tabelle.equals("messreihe_ersatzwert") ? ew.kennung() : kor.kennung();
            verweigert(() -> alsTue(k.tenant(), () -> app.update("UPDATE " + tabelle + " SET status = status WHERE kennung = ?",
                    kennung)));
            verweigert(() -> alsTue(k.tenant(), () -> app.update("DELETE FROM " + tabelle + " WHERE kennung = ?", kennung)));
            verweigert(() -> admin.update("UPDATE " + tabelle + " SET status = status WHERE kennung = ?", kennung));
            // Der Schutz ist der TRIGGER: die Verwaltungsrolle MIT Recht und der Eigentümer scheitern auch.
            abgelehnt(tabelle + "_append_only", () -> zurueckgerollt(root, () -> {
                root.execute("GRANT UPDATE ON " + tabelle + " TO " + ADMIN_USER);
                root.execute("SET LOCAL ROLE " + ADMIN_USER);
                root.update("UPDATE " + tabelle + " SET begruendung = 'still überschrieben' WHERE kennung = ?", kennung);
            }));
            abgelehnt(tabelle + "_append_only", () -> root.update("UPDATE " + tabelle + " SET status = status "
                    + "WHERE kennung = ?", kennung));
            assertThat(root.queryForObject("SELECT has_table_privilege(?, ?, 'UPDATE')", Boolean.class, ADMIN_USER,
                    tabelle)).as("das GRANT der Probe ist zurückgerollt").isFalse();
        }

        // Die Korrektur: Vorschlag → freigegeben (zweite Person) → zurückgenommen. Jede Fassung eine Zeile.
        Korrektur frei = imZug(k, () -> korrekturen.freigeben(k.tenant(), kor.kennung(), null, JONAS));
        assertThat(frei.status()).isEqualTo("freigegeben");
        assertThat(frei.ersteller()).isEqualTo(INES);
        assertThat(frei.freigeber()).contains(JONAS);
        abgelehnt("messreihe_korrektur_status_folgt", () -> imZug(k, () -> korrekturen.ablehnen(k.tenant(), kor.kennung(),
                "Nach Freigabe nicht mehr ablehnbar", INES)));
        abgelehnt("messreihe_korrektur_begruendung_chk", () -> imZug(k, () -> korrekturen.zuruecknehmen(k.tenant(),
                kor.kennung(), null, INES)));
        Korrektur zurueck = imZug(k, () -> korrekturen.zuruecknehmen(k.tenant(), kor.kennung(),
                "Profil aus Netzbetreiber-Lastgang verfügbar", INES));
        assertThat(zurueck.fassungen()).extracting(MessreiheFassungen.Fassung::status)
                .containsExactly("vorschlag", "freigegeben", "zurueckgenommen");
        assertThat(zurueck.anlage()).as("Fassung 1 bleibt, wie sie war").isEqualTo(kor.anlage());

        // Der Ersatzwert: zurückgenommen, nie gelöscht; ein zweites Mal nicht.
        abgelehnt("messreihe_ersatzwert_begruendung_chk", () -> imZug(k, () -> ersatzwerte.zuruecknehmen(k.tenant(),
                ew.kennung(), "kurz", INES)));
        Ersatzwert weg = imZug(k, () -> ersatzwerte.zuruecknehmen(k.tenant(), ew.kennung(),
                "Profil aus Netzbetreiber-Lastgang verfügbar", INES));
        assertThat(weg.status()).isEqualTo("zurueckgenommen");
        assertThat(weg.anlage()).isEqualTo(ew.anlage());
        assertThat(weg.fassungen()).hasSize(2);
        abgelehnt("messreihe_ersatzwert_status_folgt", () -> imZug(k, () -> ersatzwerte.zuruecknehmen(k.tenant(),
                ew.kennung(), "Noch einmal zurückgenommen", INES)));
        // F21: der bessere Ersatz ist ein NEUER Ersatzwert — die nächste Kennung, derselbe Zeitraum.
        Ersatzwert besser = imZug(k, () -> ersatzwerte.erfassen(k.tenant(), mitVergleich(verteilen(k,
                "profil_vergleichsquelle")), INES, BERLIN));
        assertThat(besser.kennung()).isNotEqualTo(ew.kennung()).endsWith("-0002");
        assertThat(als(k.tenant(), () -> ersatzwerte.fuerReihe(k.tenant(), k.entity(), KANAL, EW_VON, LUECKE_BIS)))
                .extracting(Ersatzwert::kennung, Ersatzwert::status)
                .containsExactly(org.assertj.core.groups.Tuple.tuple(ew.kennung(), "zurueckgenommen"),
                        org.assertj.core.groups.Tuple.tuple(besser.kennung(), "wirksam"));

        // Lückenlos, der Anfang nur am Anfang, die Fortschreibung ohne anlegende Spalten, created_at nur von der DB.
        abgelehnt("messreihe_korrektur_fassung_lueckenlos", () -> alsTue(k.tenant(), () -> app.update(
                "INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, grund, actor_sub, actor_name, "
                        + "actor_rolle, actor_art) VALUES (?, ?, 9, 'zurueckgenommen', 'Übersprungene Fassung', ?, ?, ?, ?)",
                k.tenant(), kor.kennung(), INES.sub(), INES.name(), INES.rolle(), INES.art())));
        abgelehnt("messreihe_korrektur_anfang_chk", () -> alsTue(k.tenant(), () -> app.update(
                "INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, art, reihen, von, bis, begruendung, "
                        + "vorschau, actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, 'K-2026-0900', 1, "
                        + "'freigegeben', 'umklassifizierung', ?::jsonb, ?, ?, 'Gleich freigegeben', '[{}]', ?, ?, ?, ?)",
                k.tenant(), reihen(k.reihe()), ts(EW_VON), ts(LUECKE_BIS), INES.sub(), INES.name(), INES.rolle(), INES.art())));
        Ersatzwert neu = besser;
        abgelehnt("messreihe_ersatzwert_anlage_chk", () -> alsTue(k.tenant(), () -> app.update(
                "INSERT INTO messreihe_ersatzwert (tenant_id, kennung, fassung, status, methode, grund, actor_sub, "
                        + "actor_name, actor_rolle, actor_art) VALUES (?, ?, 2, 'zurueckgenommen', 'wert_eingeben', "
                        + "'Methode nachträglich getauscht', ?, ?, ?, ?)",
                k.tenant(), neu.kennung(), INES.sub(), INES.name(), INES.rolle(), INES.art())));
        verweigert(() -> alsTue(k.tenant(), () -> app.update(
                "INSERT INTO messreihe_ersatzwert (tenant_id, kennung, fassung, status, grund, actor_sub, actor_name, "
                        + "actor_rolle, actor_art, created_at) VALUES (?, ?, 2, 'zurueckgenommen', 'Rückdatiert zurückgenommen', "
                        + "?, ?, ?, ?, '2026-01-01T00:00:00Z')",
                k.tenant(), neu.kennung(), INES.sub(), INES.name(), INES.rolle(), INES.art())));
    }

    @Test
    void eineKorrekturBeginntAlsVorschlagUndIhreArtSagtWasSieBraucht() {
        Kunde k = kunde("Korrektur-Arten");
        // F10: der System-Vorschlag K-…-0001, Nachlieferung nach Endgültigkeit, 15 Viertelstunden — und abgelehnt.
        Korrektur f10 = imZug(k, () -> korrekturen.vorschlagen(k.tenant(), korrektur("nachlieferung_nach_endgueltigkeit",
                List.of(k.reihe()), EW_VON, Instant.parse("2026-11-03T16:45:00Z"), null, null), SYSTEM, BERLIN));
        assertThat(f10.kennung()).matches("K-\\d{4}-0001");
        assertThat(f10.status()).isEqualTo("vorschlag");
        assertThat(f10.ersteller().art()).isEqualTo("voltpilot");
        abgelehnt("messreihe_korrektur_begruendung_chk", () -> imZug(k, () -> korrekturen.ablehnen(k.tenant(),
                f10.kennung(), null, INES)));
        Korrektur abgelehnt = imZug(k, () -> korrekturen.ablehnen(k.tenant(), f10.kennung(),
                "Werte kommen doppelt, Box-Uhr falsch", INES));
        assertThat(abgelehnt.freigeber()).isEmpty();
        abgelehnt("messreihe_korrektur_status_folgt", () -> imZug(k, () -> korrekturen.freigeben(k.tenant(),
                f10.kennung(), null, JONAS)));

        // Mehrere Reihen; die Korrektur-Liste je Reihe findet sie.
        Reihe abgabe = new Reihe(k.entity(), "Wirkenergie Abgabe");
        Korrektur zwei = imZug(k, () -> korrekturen.vorschlagen(k.tenant(), korrektur("umklassifizierung",
                List.of(k.reihe(), abgabe), EW_VON, LUECKE_BIS, null, null), INES, BERLIN));
        assertThat(zwei.anlage().reihen()).containsExactly(k.reihe(), abgabe);
        assertThat(als(k.tenant(), () -> korrekturen.fuerReihe(k.tenant(), k.entity(), "Wirkenergie Abgabe")))
                .extracting(Korrektur::kennung).containsExactly(zwei.kennung());

        // Art ersatzwert: genau mit Ersatzwert, der in ihren Reihen und ihrem Zeitraum liegt.
        Ersatzwert ew = imZug(k, () -> ersatzwerte.erfassen(k.tenant(), verteilen(k, "gleichmaessig_verteilen"), INES, BERLIN));
        abgelehnt("messreihe_korrektur_art_merkmal_chk", () -> imZug(k, () -> korrekturen.vorschlagen(k.tenant(),
                korrektur("ersatzwert", List.of(k.reihe()), EW_VON, LUECKE_BIS, null, null), INES, BERLIN)));
        abgelehnt("messreihe_korrektur_art_merkmal_chk", () -> imZug(k, () -> korrekturen.vorschlagen(k.tenant(),
                korrektur("umklassifizierung", List.of(k.reihe()), EW_VON, LUECKE_BIS, null, ew.kennung()), INES, BERLIN)));
        abgelehnt("messreihe_korrektur_ersatzwert_passt", () -> imZug(k, () -> korrekturen.vorschlagen(k.tenant(),
                korrektur("ersatzwert", List.of(abgabe), EW_VON, LUECKE_BIS, null, ew.kennung()), INES, BERLIN)));
        abgelehnt("messreihe_korrektur_ersatzwert_passt", () -> imZug(k, () -> korrekturen.vorschlagen(k.tenant(),
                korrektur("ersatzwert", List.of(k.reihe()), Instant.parse("2026-11-03T14:00:00Z"), LUECKE_BIS, null,
                        ew.kennung()), INES, BERLIN)));
        abgelehnt("messreihe_korrektur_ersatzwert_fk", () -> imZug(k, () -> korrekturen.vorschlagen(k.tenant(),
                korrektur("ersatzwert", List.of(k.reihe()), EW_VON, LUECKE_BIS, null, "EW-2026-9999"), INES, BERLIN)));
        Korrektur zumEw = imZug(k, () -> korrekturen.vorschlagen(k.tenant(), zumErsatzwert(k, ew), INES, BERLIN));
        assertThat(zumEw.anlage().ersatzwertKennung()).isEqualTo(ew.kennung());

        // Wert berichtigt: nie ohne Beleg.
        abgelehnt("messreihe_korrektur_art_merkmal_chk", () -> imZug(k, () -> korrekturen.vorschlagen(k.tenant(),
                korrektur("wert_berichtigt", List.of(k.reihe()), EW_VON, LUECKE_BIS, null, null), INES, BERLIN)));
        imZug(k, () -> korrekturen.vorschlagen(k.tenant(), korrektur("wert_berichtigt", List.of(k.reihe()), EW_VON,
                LUECKE_BIS, "Netzrechnung November 2026, Position 4", null), INES, BERLIN));

        // Form: Reihen, Raster, Vorschau, Kennung, unbekannte Art.
        for (String kaputt : List.of("[]", "{}", "[{\"entity_id\": \"" + k.entity() + "\"}]",
                "[{\"entity_id\": \"" + k.entity().toString().toUpperCase() + "\", \"messkanal\": \"Wirkenergie Bezug\"}]",
                "[{\"entity_id\": \"" + k.entity() + "\", \"messkanal\": \" \"}]", "[42]",
                "[" + reihe(k.reihe()) + ", " + reihe(k.reihe()) + "]")) {
            abgelehnt("messreihe_korrektur_reihen_chk", () -> alsTue(k.tenant(), () -> einfuegen(k, "K-2026-0800",
                    "umklassifizierung", kaputt, EW_VON, LUECKE_BIS, "[{\"periode\": \"2026-11-03\"}]")));
        }
        abgelehnt("messreihe_korrektur_zeitraum_chk", () -> alsTue(k.tenant(), () -> einfuegen(k, "K-2026-0800",
                "umklassifizierung", reihen(k.reihe()), LUECKE_VON, LUECKE_BIS, "[{\"periode\": \"2026-11-03\"}]")));
        abgelehnt("messreihe_korrektur_vorschau_chk", () -> alsTue(k.tenant(), () -> einfuegen(k, "K-2026-0800",
                "umklassifizierung", reihen(k.reihe()), EW_VON, LUECKE_BIS, "[]")));
        abgelehnt("messreihe_korrektur_kennung_chk", () -> alsTue(k.tenant(), () -> einfuegen(k, "KOR-2026-1",
                "umklassifizierung", reihen(k.reihe()), EW_VON, LUECKE_BIS, "[{\"periode\": \"2026-11-03\"}]")));
        abgelehnt("messreihe_korrektur_art_chk", () -> alsTue(k.tenant(), () -> einfuegen(k, "K-2026-0800",
                "stille_neuberechnung", reihen(k.reihe()), EW_VON, LUECKE_BIS, "[{\"periode\": \"2026-11-03\"}]")));
    }

    @Test
    void dieKennungZaehltJeKundenbereichUndJahr() {
        Kunde a = kunde("Kennung A");
        Kunde b = kunde("Kennung B");
        String jahr = root.queryForObject("SELECT extract(year FROM now() AT TIME ZONE 'Europe/Berlin')::int::text",
                String.class);
        for (int i = 1; i <= 3; i++) {
            Ersatzwert ew = imZug(a, () -> ersatzwerte.erfassen(a.tenant(), verteilen(a, "gleichmaessig_verteilen"), INES, BERLIN));
            assertThat(ew.kennung()).isEqualTo(String.format("EW-%s-%04d", jahr, i));
        }
        assertThat(imZug(b, () -> ersatzwerte.erfassen(b.tenant(), verteilen(b, "gleichmaessig_verteilen"), INES, BERLIN))
                .kennung()).isEqualTo("EW-" + jahr + "-0001");
        assertThat(imZug(a, () -> korrekturen.vorschlagen(a.tenant(), korrektur("umklassifizierung", List.of(a.reihe()),
                EW_VON, LUECKE_BIS, null, null), INES, BERLIN)).kennung()).isEqualTo("K-" + jahr + "-0001");
        // Dieselbe Kennung zweimal anzulegen trifft den Primärschlüssel.
        abgelehnt("messreihe_korrektur_pk", () -> alsTue(a.tenant(), () -> einfuegen(a, "K-" + jahr + "-0001",
                "umklassifizierung", reihen(a.reihe()), EW_VON, LUECKE_BIS, "[{\"periode\": \"2026-11-03\"}]")));
    }

    // ============================================================ Zaun, Rechte, Offboarding

    @Test
    void derMandantenzaunHaelt() {
        Kunde a = kunde("Zaun A");
        Kunde b = kunde("Zaun B");
        Ersatzwert ewA = imZug(a, () -> ersatzwerte.erfassen(a.tenant(), verteilen(a, "gleichmaessig_verteilen"), INES, BERLIN));
        imZug(a, () -> korrekturen.vorschlagen(a.tenant(), zumErsatzwert(a, ewA), INES, BERLIN));
        for (String tabelle : TABELLEN) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = ?",
                    Boolean.class, tabelle)).as("ENABLE + FORCE an " + tabelle).isTrue();
            assertThat(root.queryForObject("SELECT count(*) FROM pg_policies WHERE tablename = ? AND qual LIKE "
                    + "'%NULLIF(current_setting(''app.tenant_id''%' AND with_check LIKE '%app.tenant_id%'", Long.class,
                    tabelle)).as("Policy mit USING und WITH CHECK an " + tabelle).isOne();
            assertThat(app.queryForObject("SELECT count(*) FROM " + tabelle, Long.class)).as("ohne Mandant: nichts").isZero();
            assertThat(als(b.tenant(), () -> app.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?",
                    Long.class, a.tenant()))).as("B sieht A nicht in " + tabelle).isZero();
            assertThat(root.queryForList("SELECT confrelid::regclass::text || ':' || confdeltype::text FROM pg_constraint "
                    + "WHERE conrelid = ?::regclass AND contype = 'f' ORDER BY 1", String.class, tabelle))
                    .as("kein Fremdschlüssel auf etwas Löschbares: " + tabelle)
                    .isSubsetOf("messreihe_ersatzwert:r", "tenant:r").contains("tenant:r");
        }
        assertThat(als(b.tenant(), () -> ersatzwerte.lies(b.tenant(), ewA.kennung()))).isEmpty();
        // B schreibt nie als A (eine Zeile ohne Lücke — die Lücke von A sähe B gar nicht erst) …
        verweigert(() -> imZug(b, () -> ersatzwerte.erfassen(a.tenant(), mitVorperiode(ohneZuwachs(a,
                "vorperiode_uebernehmen", Instant.parse("2026-11-10T08:00:00Z"), Instant.parse("2026-11-10T09:00:00Z")),
                Instant.parse("2026-11-03T08:00:00Z")), INES, BERLIN)));
        // … sieht A's Lücke nicht (die Summe hat keine fremde Quelle) …
        abgelehnt("messreihe_ersatzwert_zuwachs_gemessen", () -> imZug(b, () -> ersatzwerte.erfassen(b.tenant(),
                mitLuecke(verteilen(b, "gleichmaessig_verteilen"), a.luecke()), INES, BERLIN)));
        // … und verweist nicht auf A's Ersatzwert.
        abgelehnt("messreihe_korrektur_ersatzwert_fk", () -> imZug(b, () -> korrekturen.vorschlagen(b.tenant(),
                korrektur("ersatzwert", List.of(b.reihe()), EW_VON, LUECKE_BIS, null, ewA.kennung()), INES, BERLIN)));
        // Dieselbe Kennung darf B tragen.
        assertThat(imZug(b, () -> ersatzwerte.erfassen(b.tenant(), verteilen(b, "gleichmaessig_verteilen"), INES, BERLIN))
                .kennung()).isEqualTo(ewA.kennung());
    }

    @Test
    void dieRechteSindBeschnitten() {
        for (String tabelle : TABELLEN) {
            assertThat(rechte(APP_USER, tabelle)).as("App liest; anhängen nur spaltenweise: " + tabelle).isEqualTo("S");
            assertThat(rechte(ADMIN_USER, tabelle)).as("die Verwaltung liest und löscht (Offboarding): " + tabelle)
                    .isEqualTo("SD");
            assertThat(spalte(APP_USER, tabelle, "status", "INSERT")).isTrue();
            assertThat(spalte(APP_USER, tabelle, "created_at", "INSERT")).as("die Zeit setzt die Datenbank").isFalse();
            assertThat(root.queryForObject("SELECT has_any_column_privilege(?, ?, 'UPDATE')", Boolean.class, APP_USER,
                    tabelle)).isFalse();
            // Seit AP-08 IP-14 (V20260913224500) legt der Stundenlauf VORSCHLÄGE an: nur die Korrektur, nur die
            // anlegenden Spalten — ein Ersatzwert bleibt die Sache eines Menschen.
            assertThat(root.queryForObject("SELECT has_any_column_privilege(?, ?, 'INSERT')", Boolean.class, ADMIN_USER,
                    tabelle)).as("nur der Vorschlags-Lauf schreibt: " + tabelle)
                    .isEqualTo(tabelle.equals("messreihe_korrektur"));
            // Belege: keine Hypertable, keine Aufbewahrung.
            assertThat(root.queryForObject("SELECT count(*) FROM timescaledb_information.hypertables "
                    + "WHERE hypertable_name = ?", Long.class, tabelle)).isZero();
        }
        assertThat(spalte(APP_USER, "messreihe_korrektur", "ersatzwert_fassung", "INSERT")).isFalse();
    }

    @Test
    void dasOffboardingRaeumtBeideTabellenAb() {
        Kunde k = kunde("Offboarding");
        Kunde andere = kunde("Bleibt");
        for (Kunde x : List.of(k, andere)) {
            Ersatzwert ew = imZug(x, () -> ersatzwerte.erfassen(x.tenant(), verteilen(x, "gleichmaessig_verteilen"), INES, BERLIN));
            imZug(x, () -> ersatzwerte.zuruecknehmen(x.tenant(), ew.kennung(), "Zurückgenommen vor dem Offboarding", INES));
            imZug(x, () -> korrekturen.vorschlagen(x.tenant(), zumErsatzwert(x, ew), INES, BERLIN));
        }
        Map<String, Long> andereVorher = new LinkedHashMap<>();
        for (String tabelle : TABELLEN) {
            assertThat(zahl(tabelle, k.tenant())).as(tabelle).isPositive();
            andereVorher.put(tabelle, zahl(tabelle, andere.tenant()));
        }

        new TenantRepository(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW))).offboard(k.tenant());

        for (String tabelle : TABELLEN) {
            assertThat(zahl(tabelle, k.tenant())).as(tabelle).isZero();
            assertThat(zahl(tabelle, andere.tenant())).as("andere bleiben: " + tabelle).isEqualTo(andereVorher.get(tabelle));
        }
        assertThat(root.queryForObject("SELECT count(*) FROM tenant WHERE id = ?", Long.class, k.tenant())).isZero();
    }

    // ============================================================ Bestandsschutz

    @Test
    void dieMigrationLegtNurDanebenUndLaesstDenBestandZeichengleich() {
        assertThat(fingerVorher).hasSizeGreaterThan(100).doesNotContainKeys(TABELLEN.toArray(String[]::new));
        assertThat(fingerVorher.get("messreihe_ereignis")).as("es gibt Ereignis-Bestand").isNotEqualTo(Bestandsschutz.LEER);
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
        for (String tabelle : TABELLEN) {
            assertThat(fingerNachMigration).as(tabelle).containsEntry(tabelle, Bestandsschutz.LEER);
        }
        // Die Lücke von vorher trägt ihren Zuwachs und passt in das geweitete Vokabular — ein Ersatzwert darauf steht.
        Kunde bestand = new Kunde(bestandA, root.queryForObject("SELECT entity_id FROM messreihe_ereignis WHERE tenant_id = ?",
                UUID.class, bestandA), root.queryForObject("SELECT ereignis_id FROM messreihe_ereignis WHERE tenant_id = ?",
                UUID.class, bestandA));
        assertThat(imZug(bestand, () -> ersatzwerte.erfassen(bestandA, verteilen(bestand, "gleichmaessig_verteilen"),
                INES, BERLIN)).status()).isEqualTo("wirksam");
    }

    /** Der Vergleich beißt noch: eine geänderte Bestandszeile und eine neue Tabelle mit Inhalt fallen auf. */
    @Test
    void derBestandsvergleichFaengtEineGeaenderteZeile() {
        Bestandsschutz.mutationsprobe(root, List.of(), "unternehmen", "UPDATE unternehmen SET name = name || ' (Probe)'");
    }

    // ===================================================================== Gerüst

    /** Ein Kundenbereich mit einer Komponente und ihrer geschlossenen Lücke MIT Zuwachs (F11). */
    private static Kunde kunde(String name) {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
        UUID entity = UUID.randomUUID();
        UUID luecke = luecke(t, entity, UUID.randomUUID(), LUECKE_VON, LUECKE_BIS, ZUWACHS);
        return new Kunde(t, entity, luecke);
    }

    /**
     * Eine Lücke der Reihe (Komponente · Wirkenergie Bezug), gemeldet über den Schreibweg der
     * Ereignis-Tabelle — mit Zuwachs (geschlossen, F11: 418 200,0 → 420 072,0 kWh) oder offen ohne ihn.
     */
    private static UUID luecke(UUID tenant, UUID entity, UUID box, Instant von, Instant bis, BigDecimal zuwachs) {
        UUID id = UUID.randomUUID();
        ObjectNode e = JSON.createObjectNode()
                .put("ereignis_id", id.toString()).put("art", "data_gap")
                .put("von", von.toString()).put("box", box.toString())
                .put("komponente", entity.toString()).put("messkanal", KANAL).put("erkannt_aus", "kadenz");
        if (zuwachs == null) {
            e.putNull("bis");
        } else {
            e.put("bis", bis.toString()).put("zuwachs", zuwachs).put("einheit", "kWh")
                    .put("stand_vor", STAND_VOR).put("stand_nach", STAND_NACH);
        }
        MessreiheEreignisRepository.Ergebnis r = als(tenant, () ->
                new MessreiheEreignisRepository(app).anhaengen(tenant, null, Urheber.CLOUD, e, null, null));
        assertThat(r.ausgang()).as("Lücke angehängt: " + r).isEqualTo(MessreiheEreignisRepository.Ausgang.ANGEHAENGT);
        return id;
    }

    private static Anlage verteilen(Kunde k, String methode) {
        return new Anlage(methode, k.entity(), KANAL, null, EW_VON, LUECKE_BIS, null,
                "Box-Tausch nach Defekt; Energiekarte hat weitergezählt", null, k.luecke(), ZUWACHS, STAND_VOR, STAND_NACH,
                "kWh", null, null, null, null, null);
    }

    private static Anlage ohneZuwachs(Kunde k, String methode, Instant von, Instant bis) {
        return new Anlage(methode, k.entity(), KANAL, null, von, bis, null,
                "Karte ohne Zählerstand, Werte aus der Vorwoche übernommen", null, null, null, null, null, null, null,
                null, null, null, null);
    }

    private static Anlage ablesestand(Kunde k, String von, String bis, String zeitpunkt) {
        return new Anlage("ablesestand_nachtragen", k.entity(), KANAL, null, Instant.parse(von), Instant.parse(bis),
                Instant.parse(zeitpunkt), "Protokoll Elektro Brunner: Endstand vor dem Rücksetzen", null, null, null, null,
                null, "kWh", null, null, new BigDecimal("6184.90"), new BigDecimal("0.00"), null);
    }

    private static Anlage mitVorperiode(Anlage a, Instant vorperiode) {
        return new Anlage(a.methode(), a.entityId(), a.messkanal(), a.messstelleId(), a.von(), a.bis(), a.zeitpunkt(),
                a.begruendung(), a.beleg(), a.lueckeEreignisId(), a.zuwachs(), a.standVor(), a.standNach(), a.einheit(),
                vorperiode, a.vergleichQuelleId(), a.endstand(), a.anfangsstand(), a.betrag());
    }

    private static Anlage mitVergleich(Anlage a) {
        return new Anlage(a.methode(), a.entityId(), a.messkanal(), a.messstelleId(), a.von(), a.bis(), a.zeitpunkt(),
                a.begruendung(), a.beleg(), a.lueckeEreignisId(), a.zuwachs(), a.standVor(), a.standNach(), a.einheit(),
                a.vorperiodeVon(), UUID.randomUUID(), a.endstand(), a.anfangsstand(), a.betrag());
    }

    private static Anlage eingeben(Anlage a) {
        return new Anlage(a.methode(), a.entityId(), a.messkanal(), a.messstelleId(), a.von(), a.bis(), a.zeitpunkt(),
                a.begruendung(), "Netzrechnung November 2026, Lastgang-Anlage", a.lueckeEreignisId(), a.zuwachs(),
                a.standVor(), a.standNach(), "kWh", a.vorperiodeVon(), a.vergleichQuelleId(), a.endstand(),
                a.anfangsstand(), new BigDecimal("96.0"));
    }

    private static Anlage mitBeleg(Anlage a, String beleg) {
        return new Anlage(a.methode(), a.entityId(), a.messkanal(), a.messstelleId(), a.von(), a.bis(), a.zeitpunkt(),
                a.begruendung(), beleg, a.lueckeEreignisId(), a.zuwachs(), a.standVor(), a.standNach(), a.einheit(),
                a.vorperiodeVon(), a.vergleichQuelleId(), a.endstand(), a.anfangsstand(), a.betrag());
    }

    private static Anlage mitZuwachs(Anlage a, BigDecimal zuwachs, BigDecimal vor, BigDecimal nach) {
        return new Anlage(a.methode(), a.entityId(), a.messkanal(), a.messstelleId(), a.von(), a.bis(), a.zeitpunkt(),
                a.begruendung(), a.beleg(), a.lueckeEreignisId(), zuwachs, vor, nach, a.einheit(), a.vorperiodeVon(),
                a.vergleichQuelleId(), a.endstand(), a.anfangsstand(), a.betrag());
    }

    private static Anlage mitZeitraum(Anlage a, Instant von, Instant bis) {
        return new Anlage(a.methode(), a.entityId(), a.messkanal(), a.messstelleId(), von, bis, a.zeitpunkt(),
                a.begruendung(), a.beleg(), a.lueckeEreignisId(), a.zuwachs(), a.standVor(), a.standNach(), a.einheit(),
                a.vorperiodeVon(), a.vergleichQuelleId(), a.endstand(), a.anfangsstand(), a.betrag());
    }

    private static Anlage mitKanal(Anlage a, String kanal) {
        return new Anlage(a.methode(), a.entityId(), kanal, a.messstelleId(), a.von(), a.bis(), a.zeitpunkt(),
                a.begruendung(), a.beleg(), a.lueckeEreignisId(), a.zuwachs(), a.standVor(), a.standNach(), a.einheit(),
                a.vorperiodeVon(), a.vergleichQuelleId(), a.endstand(), a.anfangsstand(), a.betrag());
    }

    private static Anlage mitLuecke(Anlage a, UUID luecke) {
        return new Anlage(a.methode(), a.entityId(), a.messkanal(), a.messstelleId(), a.von(), a.bis(), a.zeitpunkt(),
                a.begruendung(), a.beleg(), luecke, a.zuwachs(), a.standVor(), a.standNach(), a.einheit(),
                a.vorperiodeVon(), a.vergleichQuelleId(), a.endstand(), a.anfangsstand(), a.betrag());
    }

    private static Anlage mitMethode(Anlage a, String methode) {
        return new Anlage(methode, a.entityId(), a.messkanal(), a.messstelleId(), a.von(), a.bis(), a.zeitpunkt(),
                a.begruendung(), a.beleg(), a.lueckeEreignisId(), a.zuwachs(), a.standVor(), a.standNach(), a.einheit(),
                a.vorperiodeVon(), a.vergleichQuelleId(), a.endstand(), a.anfangsstand(), a.betrag());
    }

    private static Anlage mitBegruendung(Anlage a, String begruendung) {
        return new Anlage(a.methode(), a.entityId(), a.messkanal(), a.messstelleId(), a.von(), a.bis(), a.zeitpunkt(),
                begruendung, a.beleg(), a.lueckeEreignisId(), a.zuwachs(), a.standVor(), a.standNach(), a.einheit(),
                a.vorperiodeVon(), a.vergleichQuelleId(), a.endstand(), a.anfangsstand(), a.betrag());
    }

    private static MessreiheKorrekturRepository.Anlage korrektur(String art, List<Reihe> reihen, Instant von, Instant bis,
            String beleg, String ersatzwert) {
        return new MessreiheKorrekturRepository.Anlage(art, reihen, von, bis,
                "Nachlieferung nach Endgültigkeit (Box Halle 2 repariert)", beleg, ersatzwert,
                JSON.createArrayNode().add(JSON.createObjectNode().put("periode", "2026-11-03T13:00:00Z")
                        .putNull("alt").put("neu", 24.0)));
    }

    private static MessreiheKorrekturRepository.Anlage zumErsatzwert(Kunde k, Ersatzwert ew) {
        return korrektur("ersatzwert", List.of(k.reihe()), ew.anlage().von(), ew.anlage().bis(), null, ew.kennung());
    }

    private static void einfuegen(Kunde k, String kennung, String art, String reihen, Instant von, Instant bis,
            String vorschau) {
        app.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, art, reihen, von, bis, "
                + "begruendung, vorschau, actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, 1, 'vorschlag', ?, "
                + "?::jsonb, ?, ?, 'Umklassifizierung mit Rechnung', ?::jsonb, ?, ?, ?, ?)", k.tenant(), kennung, art,
                reihen, ts(von), ts(bis), vorschau, INES.sub(), INES.name(), INES.rolle(), INES.art());
    }

    private static String reihe(Reihe r) {
        return JSON.createObjectNode().put("entity_id", r.entityId().toString()).put("messkanal", r.messkanal()).toString();
    }

    private static String reihen(Reihe r) {
        return "[" + reihe(r) + "]";
    }

    /** Eine Zeile des Vokabulars in der Form des VALUES-Blocks der Migration. */
    private static String zeile(String vokabular, int nr, JsonNode w) {
        return String.join(", ", "'" + vokabular + "'", String.valueOf(nr), "'" + w.path("code").asText() + "'",
                text(w.path("buchstabe")), text(w.path("zuwachs")), text(w.path("bezug")), text(w.path("zeit")),
                w.has("folgt_auf") ? "{" + String.join(",", texte(w.path("folgt_auf"))) + "}" : "NULL",
                bool(w.path("grund_pflicht")), bool(w.path("ersatzwert")), bool(w.path("beleg_pflicht")));
    }

    private static String text(JsonNode n) {
        return n.isMissingNode() || n.isNull() ? "NULL" : "'" + n.asText() + "'";
    }

    private static String text(String s) {
        return s == null ? "NULL" : "'" + s + "'";
    }

    private static String bool(JsonNode n) {
        return n.isMissingNode() || n.isNull() ? "NULL" : String.valueOf(n.asBoolean());
    }

    private static String bool(Object o) {
        return o == null ? "NULL" : o.toString();
    }

    private static List<String> texte(JsonNode liste) {
        List<String> aus = new ArrayList<>();
        liste.forEach(n -> aus.add(n.asText()));
        return aus;
    }

    private static List<String> woerter(String vokabular) {
        List<String> aus = new ArrayList<>();
        vertrag.path("vokabular").path(vokabular).forEach(w -> aus.add(w.path("code").asText()));
        assertThat(aus).as("Vokabular " + vokabular).isNotEmpty();
        return aus;
    }

    private static long zahl(String tabelle, UUID tenant) {
        return root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?", Long.class, tenant);
    }

    private static Timestamp ts(Instant t) {
        return Timestamp.from(t);
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

    /** Ein Schreibweg in EINER Transaktion der App-Rolle — so, wie Spring ihn mit {@code @Transactional} fährt. */
    private static <T> T imZug(Kunde k, Supplier<T> arbeit) {
        return als(k.tenant(), () -> new TransactionTemplate(new DataSourceTransactionManager(app.getDataSource()))
                .execute(status -> arbeit.get()));
    }

    private static void zurueckgerollt(JdbcTemplate db, Runnable arbeit) {
        new TransactionTemplate(new DataSourceTransactionManager(db.getDataSource())).executeWithoutResult(status -> {
            status.setRollbackOnly();
            arbeit.run();
        });
    }

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
