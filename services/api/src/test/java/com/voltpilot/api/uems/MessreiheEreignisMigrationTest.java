package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.SeriesRepository;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.EreignisVokabular.Art;
import com.voltpilot.api.uems.EreignisVokabular.Grenzen;
import com.voltpilot.api.uems.EreignisVokabular.Urheber;
import com.voltpilot.api.uems.EreignisVokabular.Zeitform;
import com.voltpilot.api.uems.MessreiheEreignisRepository.Ausgang;
import com.voltpilot.api.uems.MessreiheEreignisRepository.Ergebnis;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
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
 * Die Migration {@code V20260911260000} (UEMS AP-07 IP-8) gegen eine echte TimescaleDB: die
 * Ereignis-Tabelle {@code messreihe_ereignis} — append-only, nie gelöscht, geschlossenes
 * Vokabular — und der Schreibweg der api ({@link MessreiheEreignisRepository}).
 *
 * <p>Der Prüfnachweis des Konzepts (§8 IP-8: „Migrationstest; Ereignis-Vektoren“): die
 * Migration legt nur daneben (die Bestands-Tabelle {@code device_measurement_event} bleibt
 * zeichengleich, nichts wird zurückgeschrieben); das Vokabular der Datenbank ist Zeile für Zeile
 * das von {@link EreignisVokabular} und die CHECKs urteilen wie die Klasse; JEDER Fall der
 * Vektor-Datei {@code events-vocabulary-vectors.json} läuft durch den Schreibweg und bekommt dort
 * dasselbe Urteil (jede der 28 Arten landet in der Tabelle); eine Wiederholung erzeugt keine
 * zweite Zeile, eine Fortschreibung eine weitere; der Zaun steht; niemand ändert, die App löscht
 * nie; Anlage, Box, Komponente und Datenaufzeichnung zu löschen lässt die Ereignisse stehen, nur
 * das Offboarding räumt sie. Keine Retention, keine Kompression: {@code DataRetentionPolicyTest}.
 *
 * <p>Beispielquelle ist die Vektor-Datei (ihr Kundenbereich, ihre Anlagen und Boxen aus
 * {@code kennungen}; Datenquellen und Messstellen mit Namen und Werten aus dem
 * Referenzunternehmen). Für die Datenbank bekommt jeder Fall eigene {@code ereignis_id}s (so
 * stört kein Fall den nächsten), Boxen ihre UUID aus {@code kennungen} und Komponenten eine
 * UUID je Kennzeichen — die Datenbank kennt für Komponenten kein Kennzeichen.
 */
@Testcontainers(disabledWithoutDocker = true)
class MessreiheEreignisMigrationTest {

    private static final String DIESE = "20260911260000";

    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final List<String> BEZUG = List.of("box", "datenquelle", "komponente", "messkanal",
            "messstelle");
    private static final List<String> CONSTRAINTS = List.of("messreihe_ereignis_art_chk",
            "messreihe_ereignis_urheber_chk", "messreihe_ereignis_zeit_chk",
            "messreihe_ereignis_bezug_chk", "messreihe_ereignis_nutzlast_chk",
            "messreihe_ereignis_aufgeloest_chk", "messreihe_ereignis_messkanal_chk",
            "messreihe_ereignis_bestand_chk", "messreihe_ereignis_tenant_fk");

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final UUID FREMD = UUID.fromString("4e070000-0000-0000-0000-000000000002");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JsonNode vektoren;
    private static JsonNode referenz;
    private static UUID kb;
    private static final Map<String, UUID> ANLAGEN = new LinkedHashMap<>();
    private static final Map<String, UUID> BOXEN = new LinkedHashMap<>();
    private static final Map<String, UUID> QUELLEN = new LinkedHashMap<>();
    private static final Map<String, UUID> MESSSTELLEN = new LinkedHashMap<>();

    private static List<String> bestandVorher;
    private static List<String> bestandNachher;
    private static long ereignisseNachDieser;

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static JdbcTemplate admin;
    private static MessreiheEreignisRepository ereignisse;

    @BeforeAll
    static void migriereMitBestand() throws IOException {
        vektoren = MAPPER.readTree(Files.readString(V2.resolve("events-vocabulary-vectors.json")));
        referenz = MAPPER.readTree(Files.readString(V2.resolve("uems-referenzunternehmen.json")));
        JsonNode k = vektoren.path("kennungen");
        kb = UUID.fromString(k.at("/kundenbereich/KB-AHRENBERG").asText());
        k.path("anlagen").fields().forEachRemaining(f -> ANLAGEN.put(f.getKey(), UUID.fromString(f.getValue().asText())));
        k.path("boxen").fields().forEachRemaining(f -> BOXEN.put(f.getKey(), UUID.fromString(f.getValue().asText())));
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));

        flyway().target(letzteFassungVorDieser()).load().migrate();
        root.update("INSERT INTO tenant (id, name) VALUES (?, ?)", kb, referenz.at("/unternehmen/name").asText());
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kundenbereich B')", FREMD);
        ANLAGEN.forEach((kz, id) -> root.update("INSERT INTO site (id, tenant_id, name) VALUES (?, ?, ?)",
                id, kb, kz));
        // Der Bestand: eine Box mit einem Ereignis im heutigen Weg des Writers.
        UUID e2 = BOXEN.get("E-2");
        root.update("INSERT INTO device (id, tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, "
                + "'VP-BOX-E-2', 'claimed')", e2, kb, ANLAGEN.get("AN-2"));
        root.update("INSERT INTO device_measurement_event (occurred_at, tenant_id, site_id, device_id, "
                + "point_key, event_kind, previous_numeric, value_numeric, catalog_version, edge_sequence, "
                + "details) VALUES ('2026-11-02T08:12:00Z', ?, ?, ?, 'wago.750_494.k8.energy', "
                + "'counter_reset', 6184.37, 0, '2026.09.11.1', 48000, '{}')", kb, ANLAGEN.get("AN-2"), e2);
        bestandVorher = bestand();

        flyway().target(DIESE).load().migrate();
        bestandNachher = bestand();
        ereignisseNachDieser = root.queryForObject("SELECT count(*) FROM messreihe_ereignis", Long.class);

        flyway().load().migrate();
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        ereignisse = new MessreiheEreignisRepository(app);

        // Datenquellen und Messstellen der Fälle — Werte aus dem Referenzunternehmen.
        for (JsonNode q : referenz.path("datenquellen")) {
            String kz = q.path("kennzeichen").asText();
            if (List.of("DQ-3", "DQ-4").contains(kz)) {
                QUELLEN.put(kz, root.queryForObject("INSERT INTO data_source (tenant_id, site_id, "
                        + "kennzeichen, protokoll, adresse, kadenz_s) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
                        UUID.class, kb, ANLAGEN.get(q.path("anlage").asText()), kz,
                        q.path("protokoll").asText(), q.path("adresse").asText(), q.path("kadenz_s").asInt()));
            }
        }
        for (JsonNode m : referenz.path("messstellen")) {
            String kz = m.path("kennzeichen").asText();
            if (List.of("MS-06", "MS-10", "MS-12").contains(kz)) {
                JsonNode g = m.path("hauptgroesse");
                MESSSTELLEN.put(kz, root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, "
                        + "name, art, medium, groesse, richtung, einheit, wertart) VALUES (?,?,?,?,?,?,?,?,?) "
                        + "RETURNING id", UUID.class, kb, kz, m.path("name").asText(), m.path("art").asText(),
                        m.path("medium").asText(), g.path("groesse").asText(), g.path("richtung").asText(),
                        g.path("einheit").asText(), g.path("wertart").asText()));
            }
        }
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ---- die Migration legt nur daneben ---------------------------------------------------

    @Test
    void dieMigrationLegtNurDanebenUndIstEineHypertableOhneVorgabeIndex() {
        assertThat(bestandNachher).as("device_measurement_event zeichengleich").isEqualTo(bestandVorher)
                .hasSize(1);
        assertThat(ereignisseNachDieser).as("nichts zurückgeschrieben — der Bestand bleibt, wo er ist").isZero();
        assertThat(root.queryForObject("SELECT time_interval FROM timescaledb_information.dimensions "
                + "WHERE hypertable_name = 'messreihe_ereignis' AND column_name = 'zeit'", String.class))
                .isEqualTo("30 days");
        List<String> indizes = root.queryForList("SELECT indexdef FROM pg_indexes WHERE tablename = "
                + "'messreihe_ereignis' ORDER BY indexname", String.class);
        assertThat(indizes).hasSize(6).allSatisfy(i -> assertThat(i).contains("(tenant_id,"));
        assertThat(indizes).anySatisfy(i -> assertThat(i).contains("UNIQUE").contains("(tenant_id, meldung, zeit)"));
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'messreihe_ereignis'", Boolean.class)).isTrue();
        Map<String, Object> policy = root.queryForMap("SELECT qual, with_check FROM pg_policies "
                + "WHERE tablename = 'messreihe_ereignis'");
        assertThat(policy.get("qual")).asString().contains("NULLIF(current_setting('app.tenant_id'");
        assertThat(policy.get("with_check")).asString().contains("NULLIF(current_setting('app.tenant_id'");
        assertThat(root.queryForList("SELECT conname FROM pg_constraint WHERE conrelid = "
                + "'messreihe_ereignis'::regclass", String.class)).containsExactlyInAnyOrderElementsOf(CONSTRAINTS);
        // Kein Fremdschlüssel auf etwas Löschbares — nur RESTRICT auf den Mandanten.
        assertThat(root.queryForList("SELECT confrelid::regclass::text || ':' || confdeltype::text FROM pg_constraint "
                + "WHERE conrelid = 'messreihe_ereignis'::regclass AND contype = 'f'", String.class))
                .containsExactly("tenant:r");
    }

    // ---- das Vokabular der Datenbank ist das des Vertrags ------------------------------------

    @Test
    void dasVokabularDerDatenbankIstDasDerKlasse() {
        Map<String, Boolean> bestand = new LinkedHashMap<>();
        vektoren.path("vokabular").path("arten")
                .forEach(a -> bestand.put(a.path("art").asText(), a.path("bestand").asBoolean()));
        List<Map<String, Object>> zeilen = root.queryForList("SELECT art, array_to_string(urheber, ',') AS "
                + "urheber, zeitform, grenzen, offen_erlaubt, array_to_string(bezug_pflicht, ',') AS bp, "
                + "array_to_string(bezug_erlaubt, ',') AS be, array_to_string(pflicht, ',') AS p, "
                + "array_to_string(felder, ',') AS f, array_to_string(fortschreibbar, ',') AS fs, bestand "
                + "FROM messreihe_ereignis_vokabular()");
        assertThat(zeilen.stream().map(z -> (String) z.get("art")).toList())
                .containsExactlyElementsOf(Stream.of(Art.values()).map(Art::code).toList());
        for (Map<String, Object> z : zeilen) {
            Art art = Art.vonCode((String) z.get("art"));
            String a = art.code();
            assertThat(Set.copyOf(liste(z.get("urheber")))).as(a)
                    .isEqualTo(Set.copyOf(art.urheber().stream().map(Urheber::code).toList()));
            assertThat(z.get("zeitform")).as(a).isEqualTo(art.zeitform().name().toLowerCase(Locale.ROOT));
            assertThat(z.get("grenzen")).as(a)
                    .isEqualTo(art.grenzen() == null ? null : art.grenzen().name().toLowerCase(Locale.ROOT));
            assertThat(z.get("offen_erlaubt")).as(a).isEqualTo(art.offenErlaubt());
            assertThat(liste(z.get("bp"))).as(a).isEqualTo(art.bezugPflicht());
            assertThat(liste(z.get("be"))).as(a).isEqualTo(art.bezugErlaubt());
            assertThat(liste(z.get("p"))).as(a).isEqualTo(art.pflicht());
            assertThat(liste(z.get("f"))).as(a).isEqualTo(art.felder());
            assertThat(liste(z.get("fs"))).as(a).isEqualTo(art.fortschreibbar());
            assertThat(z.get("bestand")).as(a).isEqualTo(bestand.get(a));
        }
        // Der CHECK auf `art` nennt genau dieselben Wörter.
        String def = root.queryForObject("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                + "WHERE conname = 'messreihe_ereignis_art_chk' AND conrelid = 'messreihe_ereignis'::regclass",
                String.class);
        Matcher m = Pattern.compile("'([a-z_]+)'").matcher(def);
        List<String> woerter = new ArrayList<>();
        while (m.find()) {
            woerter.add(m.group(1));
        }
        assertThat(woerter).containsExactlyElementsOf(Stream.of(Art.values()).map(Art::code).toList());
        // …und der Bestand-CHECK genau die sechs Arten, die der Writer heute schreibt.
        String bestandDef = root.queryForObject("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                + "WHERE conname = 'messreihe_ereignis_bestand_chk' AND conrelid = 'messreihe_ereignis'::regclass",
                String.class);
        bestand.forEach((art, ja) -> {
            if (ja) {
                assertThat(bestandDef).as(art).contains("'" + art + "'");
            }
        });
    }

    /** Die CHECK-Funktionen urteilen für jede Art wie die Klasse: Urheber, Bezug, Nutzlast, Zeit. */
    @Test
    void dieDatenbankUrteiltWieDasVokabular() {
        Instant t = Instant.parse("2026-11-03T13:00:00Z");
        Instant[][] zeiten = {{null, null}, {t, null}, {t, t}, {t, t.plusSeconds(3600)},
                {t, t.minusSeconds(3600)}, {t.plusSeconds(60), t.plusSeconds(3600)}, {null, t}};
        for (Art art : Art.values()) {
            for (Urheber u : Urheber.values()) {
                assertThat(root.queryForObject("SELECT messreihe_ereignis_urheber_erlaubt(?, ?)",
                        Boolean.class, art.code(), u.code())).as(art + " von " + u)
                        .isEqualTo(art.urheber().contains(u));
                for (Instant[] z : zeiten) {
                    assertThat(root.queryForObject("SELECT messreihe_ereignis_zeit_erlaubt(?, ?, ?, ?, ?)",
                            Boolean.class, art.code(), u.code(), Timestamp.from(t), ts(z[0]), ts(z[1])))
                            .as(art + " " + u + " " + Arrays.toString(z)).isEqualTo(zeitErlaubt(art, u, t, z[0], z[1]));
                }
            }
            for (int maske = 0; maske < 32; maske++) {
                List<String> bezug = new ArrayList<>();
                ObjectNode kennungen = MAPPER.createObjectNode();
                String messkanal = null;
                for (int i = 0; i < 5; i++) {
                    if ((maske & (1 << i)) != 0) {
                        bezug.add(BEZUG.get(i));
                        if ("messkanal".equals(BEZUG.get(i))) {
                            messkanal = "Wirkenergie Bezug";
                        } else {
                            kennungen.put(BEZUG.get(i), "X-1");
                        }
                    }
                }
                Set<String> erlaubt = new LinkedHashSet<>(art.bezugPflicht());
                erlaubt.addAll(art.bezugErlaubt());
                assertThat(root.queryForObject("SELECT messreihe_ereignis_bezug_erlaubt(?, ?::jsonb, ?)",
                        Boolean.class, art.code(), kennungen.toString(), messkanal)).as(art + " " + bezug)
                        .isEqualTo(bezug.containsAll(art.bezugPflicht()) && erlaubt.containsAll(bezug));
            }
            assertThat(root.queryForObject("SELECT messreihe_ereignis_bezug_erlaubt(?, '{\"messkanal\":\"x\"}'"
                    + "::jsonb, NULL)", Boolean.class, art.code())).as(art + ": Kanal ist keine Kennung").isFalse();
            assertThat(root.queryForObject("SELECT messreihe_ereignis_bezug_erlaubt(?, '{\"box\":1}'::jsonb, NULL)",
                    Boolean.class, art.code())).as(art + ": Kennung ist Text").isFalse();

            ObjectNode pflicht = MAPPER.createObjectNode();
            art.pflicht().forEach(f -> pflicht.put(f, 1));
            assertThat(nutzlast(art, pflicht)).as(art + " Pflicht").isTrue();
            for (String f : art.pflicht()) {
                assertThat(nutzlast(art, pflicht.deepCopy().without(f))).as(art + " ohne " + f).isFalse();
            }
            for (String f : art.felder()) {
                assertThat(nutzlast(art, pflicht.deepCopy().put(f, 1))).as(art + " mit " + f).isTrue();
            }
            assertThat(nutzlast(art, pflicht.deepCopy().put("fremd", 1))).as(art + " fremd").isFalse();
            assertThat(root.queryForObject("SELECT messreihe_ereignis_nutzlast_erlaubt(?, '[]'::jsonb)",
                    Boolean.class, art.code())).isFalse();
        }
    }

    // ---- die Vektor-Fälle durch den Schreibweg --------------------------------------------

    @TestFactory
    List<DynamicTest> jederVektorFallLaeuftDurchDenSchreibweg() {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : vektoren.path("cases")) {
            String name = c.path("name").asText();
            JsonNode in = c.path("input");
            JsonNode soll = c.path("expected");
            boolean angenommen = "angenommen".equals(soll.path("urteil").asText());
            switch (c.path("pruefung").asText()) {
                case "ereignis" -> tests.add(DynamicTest.dynamicTest(name, () -> {
                    JsonNode e = fuerDieDatenbank(name, in.path("ereignis"));
                    Urheber u = Urheber.vonCode(in.path("urheber").asText());
                    urteilWieDieDatei(name, anhaengen(u, e), angenommen, soll);
                    if (angenommen) {
                        zeileWieGemeldet(e, u);
                    }
                }));
                case "fortschreibung" -> tests.add(DynamicTest.dynamicTest(name, () -> {
                    Urheber u = Urheber.vonCode(in.path("urheber").asText());
                    assertThat(anhaengen(u, fuerDieDatenbank(name, in.path("alt"))).ausgang())
                            .as(name + " erste Meldung").isEqualTo(Ausgang.ANGEHAENGT);
                    JsonNode neu = fuerDieDatenbank(name, in.path("neu"));
                    urteilWieDieDatei(name, anhaengen(u, neu), angenommen, soll);
                    assertThat(zeilen(neu)).as(name + " Meldungen").isEqualTo(angenommen ? 2 : 1);
                }));
                default -> {
                    // Ein Umschlag ist die Sache der Datenannahme; was er annimmt, landet je Ereignis.
                    if (angenommen) {
                        tests.add(DynamicTest.dynamicTest(name, () -> {
                            for (JsonNode ev : in.path("umschlag").path("events")) {
                                ObjectNode e = (ObjectNode) fuerDieDatenbank(name, ev);
                                e.put("box", in.path("umschlag").path("device_id").asText());
                                assertThat(anhaengen(Urheber.BOX, e).ausgang()).as(name)
                                        .isEqualTo(Ausgang.ANGEHAENGT);
                                zeileWieGemeldet(e, Urheber.BOX);
                            }
                        }));
                    }
                }
            }
        }
        tests.add(DynamicTest.dynamicTest("jede der 28 Arten steht in der Tabelle", () ->
                assertThat(root.queryForList("SELECT DISTINCT art FROM messreihe_ereignis WHERE tenant_id = ? "
                        + "AND NOT aus_bestand", String.class, kb))
                        .containsExactlyInAnyOrderElementsOf(Stream.of(Art.values()).map(Art::code).toList())));
        return tests;
    }

    // ---- Wiederholung und Fortschreibung ---------------------------------------------------

    @Test
    void eineWiederholungErzeugtKeineZweiteZeileEineFortschreibungEineWeitere() {
        JsonNode offen = fuerDieDatenbank("wiederholung", fall("uebergabe-dq3-offen-bis-zur-quittung")
                .at("/input/ereignis"));
        JsonNode zu = fuerDieDatenbank("wiederholung", fall("uebergabe-dq3-quittung-schliesst").at("/input/neu"));
        assertThat(anhaengen(Urheber.CLOUD, offen).ausgang()).isEqualTo(Ausgang.ANGEHAENGT);
        assertThat(anhaengen(Urheber.CLOUD, offen).ausgang()).isEqualTo(Ausgang.WIEDERHOLUNG);
        assertThat(zeilen(offen)).isOne();
        assertThat(anhaengen(Urheber.CLOUD, zu).ausgang()).isEqualTo(Ausgang.ANGEHAENGT);
        assertThat(anhaengen(Urheber.CLOUD, offen).ausgang()).as("die erste Meldung noch einmal")
                .isEqualTo(Ausgang.WIEDERHOLUNG);
        assertThat(anhaengen(Urheber.CLOUD, zu).ausgang()).isEqualTo(Ausgang.WIEDERHOLUNG);
        UUID id = UUID.fromString(offen.get("ereignis_id").asText());
        assertThat(als(kb, () -> ereignisse.meldungen(id))).as("die erste Meldung bleibt lesbar")
                .satisfiesExactly(
                        m -> assertThat(EreignisVokabular.gleich(m, offen)).isTrue(),
                        m -> assertThat(EreignisVokabular.gleich(m, zu)).isTrue());
        // Die Idempotenz steht in der Datenbank, nicht nur im Schreibweg: dieselbe Zeile zweimal.
        String zeile = "INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, von, "
                + "kennungen, nutzlast) VALUES ('2027-04-10T05:30:00Z', ?, ?, 'handover', 'cloud', "
                + "'2027-04-10T05:30:00Z', '{\"datenquelle\":\"DQ-3\"}', '{\"anlass\":\"uebergabe\","
                + "\"box_alt\":\"E-1\",\"box_neu\":\"E-2′\"}') ON CONFLICT DO NOTHING";
        UUID roh = UUID.randomUUID();
        assertThat(als(kb, () -> app.update(zeile, kb, roh))).isOne();
        assertThat(als(kb, () -> app.update(zeile, kb, roh))).isZero();
    }

    // ---- der Zaun, die Rechte, jede Regel ---------------------------------------------------

    @Test
    void derZaunStehtNiemandAendertUndDieAppLoeschtNie() {
        JsonNode e = fuerDieDatenbank("zaun", fall("sequenz-luecke-188-datenpakete").at("/input/ereignis"));
        assertThat(anhaengen(Urheber.WRITER, e).ausgang()).isEqualTo(Ausgang.ANGEHAENGT);
        UUID id = UUID.fromString(e.get("ereignis_id").asText());
        String zaehle = "SELECT count(*) FROM messreihe_ereignis WHERE ereignis_id = ?";
        assertThat(als(kb, () -> app.queryForObject(zaehle, Long.class, id))).isOne();
        assertThat(als(FREMD, () -> app.queryForObject(zaehle, Long.class, id))).as("fremd = nicht da").isZero();
        assertThat(app.queryForObject(zaehle, Long.class, id)).as("ohne Kundenbereich nichts").isZero();
        abgelehntWegen("42501", "row-level security", () -> als(FREMD, () -> app.update(
                "INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, kennungen, nutzlast) "
                        + "VALUES (now(), ?, ?, 'box_restart', 'box', '{\"box\":\"E-2\"}', '{}')", kb, UUID.randomUUID())));

        assertThat(recht(APP_USER, "SELECT")).isTrue();
        assertThat(recht(APP_USER, "INSERT")).isTrue();
        assertThat(recht(ADMIN_USER, "SELECT")).isTrue();
        assertThat(recht(ADMIN_USER, "DELETE")).as("nur fürs Offboarding").isTrue();
        // Seit AP-07 IP-13 (V20260912190000) darf die BYPASSRLS-Rolle auch ANHÄNGEN: der
        // Stundenlauf meldet die Spätankunft (`late_arrival`) als Hintergrund-Lauf OHNE
        // Mandanten-Kontext, und zwar in derselben Transaktion, in der er den Nachzügler
        // ablehnt. APPEND-ONLY bleibt trotzdem: UPDATE bekommt weiterhin niemand, und der
        // Trigger weist es auch dann ab.
        assertThat(recht(ADMIN_USER, "INSERT")).as("der Hintergrund-Lauf meldet").isTrue();
        for (String r : List.of("UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER")) {
            assertThat(recht(APP_USER, r)).as("App " + r).isFalse();
        }
        for (String r : List.of("UPDATE", "TRUNCATE")) {
            assertThat(recht(ADMIN_USER, r)).as("Admin " + r).isFalse();
        }
        abgelehntWegen("42501", "permission denied", () -> als(kb, () -> app.update(
                "UPDATE messreihe_ereignis SET bis = now() WHERE ereignis_id = ?", id)));
        abgelehntWegen("42501", "permission denied", () -> als(kb, () -> app.update(
                "DELETE FROM messreihe_ereignis WHERE ereignis_id = ?", id)));
        abgelehntWegen("42501", "permission denied", () -> admin.update(
                "UPDATE messreihe_ereignis SET bis = now() WHERE ereignis_id = ?", id));
        abgelehntWegen("P0001", "append-only", () -> root.update(
                "UPDATE messreihe_ereignis SET bis = now() WHERE ereignis_id = ?", id));
        assertThat(als(kb, () -> app.queryForObject(zaehle, Long.class, id))).isOne();
    }

    /** Jede Regel der Datenbank hat ihren benannten CHECK — eine unbekannte Art wird abgewiesen. */
    @Test
    void jedeRegelHatIhrenConstraint() {
        String basis = "INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, von, bis, "
                + "kennungen, device_id, messkanal, nutzlast, aus_bestand) VALUES ('2026-11-02T08:12:00Z', '"
                + kb + "', gen_random_uuid(), %s, %s, %s, %s, %s, %s, %s, %s, %s)";
        String k = "'{\"komponente\":\"" + UUID.randomUUID() + "\",\"box\":\"E-2\"}'";
        String stand = "'{\"stand_alt\":1,\"stand_neu\":0}'";
        abgelehnt("23514", "messreihe_ereignis_art_chk", () -> alsTue(kb, () -> app.update(String.format(basis,
                "'power_failure'", "'writer'", "NULL", "NULL", k, "NULL", "'Kanal'", stand, "false"))));
        abgelehnt("23514", "messreihe_ereignis_urheber_chk", () -> alsTue(kb, () -> app.update(String.format(basis,
                "'counter_reset'", "'box'", "NULL", "NULL", k, "NULL", "'Kanal'", stand, "false"))));
        abgelehnt("23514", "messreihe_ereignis_zeit_chk", () -> alsTue(kb, () -> app.update(String.format(basis,
                "'counter_reset'", "'writer'", "'2026-11-02T08:12:00Z'", "NULL", k, "NULL", "'Kanal'", stand,
                "false"))));
        abgelehnt("23514", "messreihe_ereignis_zeit_chk", () -> alsTue(kb, () -> app.update(String.format(basis,
                "'data_gap'", "'box'", "'2026-11-02T08:12:00Z'", "NULL", "'{\"box\":\"E-2\"}'", "NULL", "NULL",
                "'{\"erkannt_aus\":\"verdraengung\"}'", "false"))));
        abgelehnt("23514", "messreihe_ereignis_bezug_chk", () -> alsTue(kb, () -> app.update(String.format(basis,
                "'counter_reset'", "'writer'", "NULL", "NULL", k, "NULL", "NULL", stand, "false"))));
        abgelehnt("23514", "messreihe_ereignis_nutzlast_chk", () -> alsTue(kb, () -> app.update(String.format(basis,
                "'counter_reset'", "'writer'", "NULL", "NULL", k, "NULL", "'Kanal'",
                "'{\"stand_alt\":1,\"stand_neu\":0,\"ursache\":\"Wartung\"}'", "false"))));
        abgelehnt("23514", "messreihe_ereignis_aufgeloest_chk", () -> alsTue(kb, () -> app.update(String.format(basis,
                "'counter_reset'", "'writer'", "NULL", "NULL", "'{\"komponente\":\"K-5\"}'",
                "'" + BOXEN.get("E-2") + "'", "'Kanal'", stand, "false"))));
        abgelehnt("23514", "messreihe_ereignis_messkanal_chk", () -> alsTue(kb, () -> app.update(String.format(basis,
                "'counter_reset'", "'writer'", "NULL", "NULL", k, "NULL", "' '", stand, "false"))));
        // Der Bestandsweg: nur seine sechs Arten, die Box aufgelöst, sonst nichts.
        String box = "'{\"box\":\"" + BOXEN.get("E-2") + "\"}'";
        abgelehnt("23514", "messreihe_ereignis_bestand_chk", () -> alsTue(kb, () -> app.update(String.format(basis,
                "'sequence_gap'", "'writer'", "NULL", "NULL", box, "'" + BOXEN.get("E-2") + "'", "NULL",
                "'{\"strom\":\"events\",\"sequenz_erwartet\":1,\"sequenz_erhalten\":3,\"anzahl\":2}'", "true"))));
        abgelehnt("23514", "messreihe_ereignis_bestand_chk", () -> alsTue(kb, () -> app.update(String.format(basis,
                "'data_gap'", "'writer'", "NULL", "NULL", box, "'" + BOXEN.get("E-2") + "'", "NULL",
                "'{\"erkannt_aus\":\"verdraengung\"}'", "true"))));
        // So sieht eine Bestandszeile aus — angenommen.
        assertThat(als(kb, () -> app.update(String.format(basis, "'data_gap'", "'box'", "NULL", "NULL", box,
                "'" + BOXEN.get("E-2") + "'", "NULL", "'{\"erkannt_aus\":\"verdraengung\",\"erwartet_fehlend\":2}'",
                "true")))).isOne();
    }

    // ---- Löschen: nur das Offboarding ------------------------------------------------------

    @Test
    void anlageBoxKomponenteUndPurgeLassenDieEreignisseStehenNurDasOffboardingRaeumt() throws Exception {
        UUID w = UUID.randomUUID();
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Werkstatt Ereignisse')", w);
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Halle W') RETURNING id",
                UUID.class, w);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, 'VP-BOX-W', 'claimed') RETURNING id", UUID.class, w, site);
        UUID komponente = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, device_id, "
                + "role, label, entity_type) VALUES (?, ?, ?, 'grid-meter', 'Zähler W', 'grid-meter') RETURNING id",
                UUID.class, w, site, box);
        root.update("INSERT INTO device_measurement_event (occurred_at, tenant_id, site_id, device_id, "
                + "point_key, event_kind, catalog_version, edge_sequence) VALUES (now(), ?, ?, ?, 'p', "
                + "'state_change', '2026.09.11.1', 1)", w, site, box);
        ObjectNode reset = (ObjectNode) fall("ek3-zaehler-zurueckgesetzt").at("/input/ereignis").deepCopy();
        reset.put("ereignis_id", UUID.randomUUID().toString()).put("box", box.toString())
                .put("komponente", komponente.toString()).remove("messstelle");
        assertThat(als(w, () -> ereignisse.anhaengen(w, site, Urheber.WRITER, reset, null, null)).ausgang())
                .isEqualTo(Ausgang.ANGEHAENGT);
        assertThat(als(w, () -> app.update("INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, "
                + "urheber, site_id, kennungen, device_id, nutzlast, aus_bestand) VALUES (now(), ?, ?, 'data_gap', "
                + "'box', ?, jsonb_build_object('box', ?::text), ?, '{\"erkannt_aus\":\"verdraengung\"}', true)",
                w, UUID.randomUUID(), site, box.toString(), box))).isOne();
        String ereignisseVonW = "SELECT count(*) FROM messreihe_ereignis WHERE tenant_id = ?";
        assertThat(root.queryForObject(ereignisseVonW, Long.class, w)).isEqualTo(2);

        alsTue(w, () -> new SeriesRepository(app).purgeDeviceRecordings(box, site, null));
        assertThat(als(w, () -> app.update("DELETE FROM measurement_point WHERE id = ?", komponente))).isOne();
        // Unclaim baut die Box aus (AP-07 IP-11): der Bestand der Messwert-Strecke bleibt mit ihr.
        assertThat(als(w, () -> new DeviceRepository(app).ausbauen(box))).as("Unclaim").isTrue();
        assertThat(root.queryForObject("SELECT count(*) FROM device_measurement_event WHERE device_id = ?",
                Long.class, box)).as("der Bestand bleibt mit der ausgebauten Box").isOne();
        // Die Anlage ohne Belege wird wie im SiteController entfernt: erst ihre Serien, dann sie selbst.
        alsTue(w, () -> new SeriesRepository(app).deleteForSite(site));
        assertThat(als(w, () -> app.update("DELETE FROM site WHERE id = ?", site))).isOne();
        assertThat(root.queryForObject(ereignisseVonW, Long.class, w)).as("die Ereignisse bleiben").isEqualTo(2);
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE tenant_id = ? AND "
                + "device_id = ? AND (entity_id = ? OR aus_bestand)", Long.class, w, box, komponente))
                .as("mit ihrer Herkunft").isEqualTo(2);

        // Nie Kaskade vom Mandanten (W trägt auch andere RESTRICT-Zeilen, etwa den Geräte-Zähler).
        abgelehnt("23503", null, () -> root.update("DELETE FROM tenant WHERE id = ?", w));
        new TenantRepository(admin).offboard(w);
        assertThat(root.queryForObject(ereignisseVonW, Long.class, w)).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM tenant WHERE id = ?", Long.class, w)).isZero();

        // Ein Kundenbereich, der NUR Ereignisse hat: genau deren Fremdschlüssel hält ihn fest.
        UUID nurEreignisse = UUID.randomUUID();
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Nur Ereignisse')", nurEreignisse);
        root.update("INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, kennungen, nutzlast) "
                + "VALUES (now(), ?, ?, 'box_restart', 'box', '{\"box\":\"E-2\"}', '{}')", nurEreignisse, UUID.randomUUID());
        abgelehnt("23503", "messreihe_ereignis_tenant_fk",
                () -> root.update("DELETE FROM tenant WHERE id = ?", nurEreignisse));
        new TenantRepository(admin).offboard(nurEreignisse);
        assertThat(root.queryForObject(ereignisseVonW, Long.class, nurEreignisse)).isZero();
    }

    /**
     * Im Code gibt es keinen Weg, der eine Zeile ändert oder löscht: keine Zeile, die die Tabelle
     * nennt, trägt UPDATE, DELETE oder TRUNCATE; gelöscht wird nur über die Tabellenliste des
     * Offboardings, und die steht allein in {@code TenantRepository}.
     */
    @Test
    void keinSchreibwegAendertOderLoescht() throws IOException {
        List<Path> quellen = new ArrayList<>();
        for (Path wurzel : List.of(Path.of("src", "main", "java"),
                Path.of("..", "timescale-writer", "src", "main", "java"))) {
            try (Stream<Path> s = Files.walk(wurzel)) {
                s.filter(p -> p.toString().endsWith(".java")).forEach(quellen::add);
            }
        }
        List<String> loeschliste = new ArrayList<>();
        for (Path p : quellen) {
            String text = Files.readString(p);
            if (!text.contains("messreihe_ereignis")) {
                continue;
            }
            if (text.contains("deleteByTenant(con, \"messreihe_ereignis\"")) {
                loeschliste.add(p.getFileName().toString());
            }
            for (String zeile : text.split("\n")) {
                if (zeile.contains("messreihe_ereignis")) {
                    assertThat(zeile.toUpperCase(Locale.ROOT)).as(p + ": " + zeile.strip())
                            .doesNotContain("UPDATE ").doesNotContain("DELETE ").doesNotContain("TRUNCATE");
                }
            }
        }
        assertThat(loeschliste).containsExactly("TenantRepository.java");
    }

    // ---- Gerüst: Fälle ---------------------------------------------------------------------

    private static JsonNode fall(String name) {
        for (JsonNode c : vektoren.path("cases")) {
            if (c.path("name").asText().equals(name)) {
                return c;
            }
        }
        throw new AssertionError("kein Fall " + name);
    }

    /**
     * Ein Ereignis der Datei für die Datenbank: eigene {@code ereignis_id} je Fall, Boxen mit ihrer
     * UUID aus {@code kennungen}, Komponenten mit einer UUID je Kennzeichen. Datenquellen und
     * Messstellen behalten ihr Kennzeichen — der Schreibweg löst sie auf.
     */
    private static JsonNode fuerDieDatenbank(String fall, JsonNode ereignis) {
        ObjectNode e = ereignis.deepCopy();
        if (e.path("ereignis_id").isTextual()) {
            e.put("ereignis_id", uuid(fall + "|" + e.get("ereignis_id").asText()).toString());
        }
        for (String f : List.of("box", "box_alt", "box_neu", "zustaendige_box")) {
            if (BOXEN.containsKey(e.path(f).asText())) {
                e.put(f, BOXEN.get(e.get(f).asText()).toString());
            }
        }
        if (e.path("komponente").isTextual()) {
            e.put("komponente", komponente(e.get("komponente").asText()).toString());
        }
        return e;
    }

    private static UUID komponente(String kennzeichen) {
        return uuid("komponente|" + kennzeichen);
    }

    private static UUID uuid(String name) {
        return UUID.nameUUIDFromBytes(name.getBytes(StandardCharsets.UTF_8));
    }

    private static Ergebnis anhaengen(Urheber u, JsonNode e) {
        return als(kb, () -> ereignisse.anhaengen(kb, ANLAGEN.get("AN-1"), u, e, null, null));
    }

    private static void urteilWieDieDatei(String name, Ergebnis ist, boolean angenommen, JsonNode soll) {
        assertThat(ist.ausgang()).as(name + " " + ist).isEqualTo(angenommen ? Ausgang.ANGEHAENGT : Ausgang.VERWORFEN);
        assertThat(ist.grund() == null ? null : ist.grund().code()).as(name)
                .isEqualTo(soll.path("grund").isNull() ? null : soll.path("grund").asText());
    }

    private static long zeilen(JsonNode e) {
        return root.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE ereignis_id = ?", Long.class,
                UUID.fromString(e.get("ereignis_id").asText()));
    }

    /** Die gespeicherte Zeile trägt den Bezug wie gemeldet und aufgelöst, was eindeutig war. */
    private static void zeileWieGemeldet(JsonNode e, Urheber u) {
        Map<String, Object> z = root.queryForMap("SELECT art, urheber, kennungen::text AS kennungen, device_id, "
                + "data_source_id, entity_id, messstelle_id, messkanal FROM messreihe_ereignis "
                + "WHERE ereignis_id = ? ORDER BY eingang DESC LIMIT 1",
                UUID.fromString(e.get("ereignis_id").asText()));
        String a = e.get("art").asText();
        assertThat(z.get("art")).isEqualTo(a);
        assertThat(z.get("urheber")).isEqualTo(u.code());
        assertThat(z.get("device_id")).as(a).isEqualTo(e.has("box") ? UUID.fromString(e.get("box").asText()) : null);
        assertThat(z.get("entity_id")).as(a)
                .isEqualTo(e.has("komponente") ? UUID.fromString(e.get("komponente").asText()) : null);
        assertThat(z.get("data_source_id")).as(a).isEqualTo(QUELLEN.get(e.path("datenquelle").asText()));
        assertThat(z.get("messstelle_id")).as(a).isEqualTo(MESSSTELLEN.get(e.path("messstelle").asText()));
        assertThat(z.get("messkanal")).as(a).isEqualTo(e.path("messkanal").asText(null));
        for (String f : List.of("box", "datenquelle", "komponente", "messstelle")) {
            assertThat(z.get("kennungen").toString().contains("\"" + f + "\"")).as(a + " " + f).isEqualTo(e.has(f));
        }
    }

    private static boolean zeitErlaubt(Art art, Urheber u, Instant zeit, Instant von, Instant bis) {
        if (art.zeitform() == Zeitform.ZEITPUNKT) {
            return von == null && bis == null;
        }
        if (von == null || !von.equals(zeit)) {
            return false;
        }
        if (bis == null) {
            return art.offenErlaubt() && u != Urheber.BOX;
        }
        return art.grenzen() == Grenzen.HALBOFFEN ? bis.isAfter(von) : !bis.isBefore(von);
    }

    private static boolean nutzlast(Art art, JsonNode n) {
        return root.queryForObject("SELECT messreihe_ereignis_nutzlast_erlaubt(?, ?::jsonb)", Boolean.class,
                art.code(), n.toString());
    }

    private static List<String> liste(Object o) {
        return o == null || o.toString().isEmpty() ? List.of() : List.of(o.toString().split(","));
    }

    private static Timestamp ts(Instant t) {
        return t == null ? null : Timestamp.from(t);
    }

    private static boolean recht(String rolle, String recht) {
        return root.queryForObject("SELECT has_table_privilege(?, 'messreihe_ereignis', ?)", Boolean.class,
                rolle, recht);
    }

    private static List<String> bestand() {
        return root.queryForList("SELECT to_jsonb(e)::text FROM device_measurement_event e ORDER BY occurred_at",
                String.class);
    }

    // ---- Gerüst: Mandant, Ablehnung, Flyway -------------------------------------------------

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
            assertThat(p.getServerErrorMessage().getConstraint()).as(p.getMessage()).isEqualTo(constraint);
        }
    }

    private static void abgelehntWegen(String sqlState, String nachricht, Runnable arbeit) {
        PSQLException p = ablehnung(arbeit);
        assertThat((Object) p).as("die Datenbank muss ablehnen (" + nachricht + ")").isNotNull();
        assertThat(p.getSQLState()).as(p.getMessage()).isEqualTo(sqlState);
        assertThat(p.getMessage()).contains(nachricht);
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
