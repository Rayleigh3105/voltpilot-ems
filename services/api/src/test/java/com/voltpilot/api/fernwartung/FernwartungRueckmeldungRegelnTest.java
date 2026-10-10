package com.voltpilot.api.fernwartung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.fernwartung.FernwartungRueckmeldung.Geprueft;
import com.voltpilot.api.fernwartung.FernwartungRueckmeldung.Ungueltig;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;

/**
 * Rein, ohne Datenbank und ohne Docker: die Rückmeldung des Tunnel-Dienstes
 * (Fenster-Schlüssel, Schritt 4) gegen den Vertragsvektor, den auch der
 * Tunnel-Dienst (Go, {@code TestVertragsvektorDerMeldung}) Byte für Byte
 * erzeugt - und die Zusage, dass die Meldung nur Anzeige ist.
 */
class FernwartungRueckmeldungRegelnTest {

    private static final Path VERTRAEGE = Path.of("..", "..", "docs", "contracts");
    private static final Path VEKTOR = VERTRAEGE.resolve("fernwartung-rueckmeldung-v1.example.json");
    private static final Path QUELLEN = Path.of("src", "main", "java", "com", "voltpilot", "api");
    private static final String MIGRATION = "/db/migration/V20261010203000__fernwartung_rueckmeldung.sql";

    private final ObjectMapper json = new ObjectMapper();

    // ── Vertragsvektor ────────────────────────────────────────────────────

    @Test
    void derVertragsvektorWirdStrengGelesenUndAngenommen() throws Exception {
        byte[] vektor = Files.readAllBytes(VEKTOR);
        Instant gemeldet = Instant.parse("2026-10-07T14:00:30Z");
        Geprueft g = FernwartungRueckmeldung.pruefe(FernwartungRueckmeldung.lies(vektor), gemeldet.plusSeconds(2));

        assertThat(g.gemeldetUm()).isEqualTo(gemeldet);
        assertThat(g.gestartetUm()).isEqualTo(Instant.parse("2026-10-07T09:15:00Z"));
        assertThat(g.schluesselausgabe()).isTrue();
        assertThat(g.boxen()).hasSize(2);
        assertThat(g.boxen().get(0).id()).isEqualTo(UUID.fromString("6f1d1c52-3c1a-4b8e-9a43-0c4f8a7c2d11"));
        assertThat(g.boxen().get(0).verbundenSeit()).isEqualTo(Instant.parse("2026-10-07T11:42:07Z"));
        assertThat(g.boxen().get(0).zuletztGefragtUm()).isEqualTo(Instant.parse("2026-10-07T14:00:12Z"));
        // null ist eine Aussage: nicht verbunden, seit dem Start nicht gefragt.
        assertThat(g.boxen().get(1).verbundenSeit()).isNull();
        assertThat(g.boxen().get(1).zuletztGefragtUm()).isNull();
        assertThat(g.fenster()).singleElement().satisfies(f -> {
            assertThat(f.id()).isEqualTo(UUID.fromString("c4d2e6f8-0a1b-4c3d-9e5f-7a8b9c0d1e44"));
            assertThat(f.schluesselAbgeholtUm()).isEqualTo(Instant.parse("2026-10-07T13:30:41Z"));
        });

        // Die Felder des Vektors sind genau die der Java-Form: ein neues Feld
        // braucht Vertrag, Go-Struktur und diese Form in derselben Änderung.
        JsonNode baum = json.readTree(vektor);
        assertThat(felder(baum)).containsExactlyInAnyOrderElementsOf(komponenten(FernwartungRueckmeldung.Meldung.class));
        assertThat(felder(baum.get("boxen").get(0)))
                .containsExactlyInAnyOrderElementsOf(komponenten(FernwartungRueckmeldung.BoxMeldung.class));
        assertThat(felder(baum.get("fenster").get(0)))
                .containsExactlyInAnyOrderElementsOf(komponenten(FernwartungRueckmeldung.FensterMeldung.class));

        // Die Meldung gehört zum Vektor des Soll-Stands: dieselben Kennungen.
        JsonNode soll = json.readTree(Files.readAllBytes(VERTRAEGE.resolve("fernwartung-soll-v1.example.json")));
        List<String> boxen = new ArrayList<>();
        soll.get("peers").forEach(p -> {
            if ("box".equals(p.get("art").asText())) {
                boxen.add(p.get("id").asText());
            }
        });
        assertThat(g.boxen()).extracting(b -> b.id().toString()).containsExactlyElementsOf(boxen);
        assertThat(g.fenster().get(0).id().toString()).isEqualTo(soll.get("fenster").get(0).get("id").asText());
    }

    /** Und sonst nichts: kein Schlüssel, kein Fingerabdruck, keine Adresse, kein Name. */
    @Test
    void dieMeldungTraegtNurZustandUndDieKennungenDesPortals() throws Exception {
        String vektor = Files.readString(VEKTOR);
        assertThat(vektor).doesNotContain("ssh-rsa").doesNotContain("SHA256").doesNotContain("10.10.")
                .doesNotContain("edge-").doesNotContain("publicKey").doesNotContain("adresse")
                .doesNotContain("kennung");
        assertThat(komponenten(FernwartungRueckmeldung.BoxMeldung.class))
                .containsExactly("id", "verbundenSeit", "zuletztGefragtUm");
        assertThat(komponenten(FernwartungRueckmeldung.FensterMeldung.class))
                .containsExactly("id", "schluesselAbgeholtUm");
        assertThat(komponenten(FernwartungRueckmeldung.Meldung.class))
                .containsExactly("version", "gemeldetUm", "gestartetUm", "schluesselausgabe", "boxen", "fenster");
    }

    // ── Was die API abweist ───────────────────────────────────────────────

    @Test
    void eineMeldungInFalscherFormWirdAlsGanzesAbgewiesen() throws Exception {
        Instant jetzt = Instant.parse("2026-10-07T14:00:31Z");
        assertThatCode(() -> pruefe(m -> { }, jetzt)).doesNotThrowAnyException();

        abgewiesen(m -> m.put("version", 2), jetzt, "Version 2");
        abgewiesen(m -> m.remove("version"), jetzt, "Version null");
        abgewiesen(m -> m.put("version", "1"), jetzt, "vereinbarte Form");
        abgewiesen(m -> m.put("soll", "öffne ein Fenster"), jetzt, "vereinbarte Form");
        abgewiesen(m -> ((ObjectNode) m.get("boxen").get(0)).put("publicKey", "x"), jetzt, "vereinbarte Form");
        abgewiesen(m -> ((ObjectNode) m.get("fenster").get(0)).put("ende", "2026-10-08T00:00:00Z"), jetzt,
                "vereinbarte Form");
        for (String feld : List.of("gemeldetUm", "gestartetUm", "schluesselausgabe", "boxen", "fenster")) {
            abgewiesen(m -> m.remove(feld), jetzt, "fehlt ein Feld");
            abgewiesen(m -> m.putNull(feld), jetzt, "fehlt ein Feld");
        }
        abgewiesen(m -> m.put("gemeldetUm", "gestern"), jetzt, "vereinbarte Form");
        abgewiesen(m -> m.put("schluesselausgabe", "ja"), jetzt, "vereinbarte Form");

        // Kennungen: nur UUIDs, jede einmal.
        for (String id : new String[] {"", "b1", "6f1d1c52-3c1a-4b8e-9a43", "1-1-1-1-1",
                "6f1d1c52-3c1a-4b8e-9a43-0c4f8a7c2d11'; DROP TABLE fernwartung_zugang; --"}) {
            abgewiesen(m -> ((ObjectNode) m.get("boxen").get(0)).put("id", id), jetzt, "Box ohne gültige id");
            abgewiesen(m -> ((ObjectNode) m.get("fenster").get(0)).put("id", id), jetzt, "Fenster ohne gültige id");
        }
        abgewiesen(m -> ((ObjectNode) m.get("boxen").get(0)).remove("id"), jetzt, "Box ohne gültige id");
        abgewiesen(m -> ((ArrayNode) m.get("boxen")).add(m.get("boxen").get(0).deepCopy()), jetzt, "mehrfach");
        abgewiesen(m -> ((ArrayNode) m.get("fenster")).add(m.get("fenster").get(0).deepCopy()), jetzt, "mehrfach");
        abgewiesen(m -> ((ArrayNode) m.get("boxen")).addNull(), jetzt, "leere Box");
        abgewiesen(m -> ((ArrayNode) m.get("fenster")).addNull(), jetzt, "leeres Fenster");

        // Zeit: nichts liegt nach gemeldetUm, und gemeldetUm passt zur Uhr der API.
        abgewiesen(m -> ((ObjectNode) m.get("boxen").get(0)).put("verbundenSeit", "2026-10-07T14:00:31Z"), jetzt,
                "verbundenSeit nach gemeldetUm");
        abgewiesen(m -> ((ObjectNode) m.get("boxen").get(0)).put("zuletztGefragtUm", "2026-10-07T14:01:00Z"), jetzt,
                "zuletztGefragtUm nach gemeldetUm");
        abgewiesen(m -> ((ObjectNode) m.get("fenster").get(0)).put("schluesselAbgeholtUm", "2027-01-01T00:00:00Z"),
                jetzt, "schluesselAbgeholtUm nach gemeldetUm");
        abgewiesen(m -> m.put("gestartetUm", "2026-10-07T14:00:40Z"), jetzt, "gestartetUm nach gemeldetUm");
        Duration grenze = FernwartungRueckmeldung.MAX_UHRABWEICHUNG;
        assertThatCode(() -> pruefe(m -> { }, Instant.parse("2026-10-07T14:00:30Z").plus(grenze)))
                .as("genau an der Grenze").doesNotThrowAnyException();
        assertThatCode(() -> pruefe(m -> { }, Instant.parse("2026-10-07T14:00:30Z").minus(grenze)))
                .as("die Uhr des Servers geht vor, an der Grenze").doesNotThrowAnyException();
        abgewiesen(m -> { }, Instant.parse("2026-10-07T14:00:30Z").plus(grenze).plusSeconds(60),
                "Uhr des Wartungsservers weicht um 6 Minuten");
        abgewiesen(m -> { }, Instant.parse("2026-10-07T14:00:30Z").minus(grenze).minusSeconds(1),
                "Zeitabgleich des Wartungsservers");

        // Kein JSON, mehr als ein Dokument, ein Feld doppelt.
        for (String rumpf : new String[] {"", "null", "[]", "42", "{", "<meldung/>",
                Files.readString(VEKTOR) + "{}",
                "{\"version\":1,\"version\":1,\"gemeldetUm\":\"2026-10-07T14:00:30Z\"}"}) {
            assertThatThrownBy(() -> FernwartungRueckmeldung.pruefe(
                    FernwartungRueckmeldung.lies(rumpf.getBytes(StandardCharsets.UTF_8)), jetzt))
                    .as(rumpf.length() > 40 ? rumpf.substring(rumpf.length() - 40) : rumpf)
                    .isInstanceOf(Ungueltig.class);
        }
    }

    @Test
    void mehrAlsZehntausendEintraegeNimmtDieApiNichtAn() throws Exception {
        Instant jetzt = Instant.parse("2026-10-07T14:00:31Z");
        Consumer<ObjectNode> voll = m -> {
            ArrayNode boxen = m.putArray("boxen");
            for (int i = 0; i < FernwartungRueckmeldung.MAX_EINTRAEGE; i++) {
                boxen.addObject().put("id", UUID.randomUUID().toString()).putNull("verbundenSeit")
                        .putNull("zuletztGefragtUm");
            }
        };
        assertThat(pruefe(voll, jetzt).boxen()).hasSize(FernwartungRueckmeldung.MAX_EINTRAEGE);
        abgewiesen(voll.andThen(m -> ((ArrayNode) m.get("boxen")).addObject()
                .put("id", UUID.randomUUID().toString()).putNull("verbundenSeit").putNull("zuletztGefragtUm")),
                jetzt, "mehr als 10000");
        // Leere Listen sind eine gültige Meldung: der Dienst kennt gerade nichts.
        Geprueft leer = pruefe(m -> {
            m.putArray("boxen");
            m.putArray("fenster");
        }, jetzt);
        assertThat(leer.boxen()).isEmpty();
        assertThat(leer.fenster()).isEmpty();
    }

    /**
     * Die Route liest höchstens 2 MiB: Eine größere Meldung wird abgewiesen,
     * bevor irgendetwas geprüft oder gespeichert wird (der Dienst dahinter ist
     * hier gar nicht da).
     */
    @Test
    void eineZuGrosseMeldungWirdNichtGelesen() throws Exception {
        var route = new com.voltpilot.api.web.FernwartungRueckmeldungController(null);
        for (int zuviel : new int[] {1, 4096}) {
            var anfrage = new org.springframework.mock.web.MockHttpServletRequest("PUT",
                    "/api/v1/fernwartung/rueckmeldung");
            anfrage.setContent(new byte[FernwartungRueckmeldung.MAX_BYTES + zuviel]);
            assertThatThrownBy(() -> route.melden(anfrage, null))
                    .isInstanceOf(org.springframework.web.server.ResponseStatusException.class)
                    .hasMessageContaining("413").hasMessageContaining("größer als 2 MiB");
        }
        // Ohne Längenangabe (Stückübertragung) zählt, was tatsächlich kommt.
        var ohneLaenge = new org.springframework.mock.web.MockHttpServletRequest("PUT",
                "/api/v1/fernwartung/rueckmeldung") {
            @Override
            public long getContentLengthLong() {
                return -1;
            }
        };
        ohneLaenge.setContent(new byte[FernwartungRueckmeldung.MAX_BYTES + 1]);
        assertThatThrownBy(() -> route.melden(ohneLaenge, null)).hasMessageContaining("413");
    }

    // ── Nur Anzeige ───────────────────────────────────────────────────────

    /**
     * Die Zusage aus dem Auftrag: Was der Dienst meldet, fließt nie in den
     * Soll-Stand zurück. Strukturell heißt das: die Klassen, die den Soll-Stand
     * bilden und ausliefern, kennen weder die Klassen noch die Tabellen der
     * Rückmeldung. (Gegen die laufende API belegt es
     * {@code FernwartungApiTest.dieRueckmeldungIstAnzeigeUndAendertDenSollStandNie}.)
     */
    @Test
    void derSollStandKenntDieRueckmeldungNicht() throws Exception {
        for (String datei : List.of("fernwartung/FernwartungService.java", "fernwartung/FernwartungRepository.java",
                "web/FernwartungSollController.java")) {
            String code = ohneKommentare(Files.readString(QUELLEN.resolve(datei)));
            assertThat(code).as(datei).doesNotContainIgnoringCase("rueckmeldung");
        }
        // Umgekehrt schreibt die Rückmeldung nur ihre eigenen Tabellen: kein
        // Zugang, kein Fenster, kein Protokolleintrag entsteht aus einer Meldung.
        String repo = ohneKommentare(Files.readString(
                QUELLEN.resolve("fernwartung/FernwartungRueckmeldungRepository.java")));
        assertThat(repo).contains("INSERT INTO fernwartung_rueckmeldung_dienst",
                "INSERT INTO fernwartung_rueckmeldung_box", "INSERT INTO fernwartung_rueckmeldung_fenster");
        for (String tabelle : List.of("fernwartung_zugang", "fernwartung_fenster", "fernwartung_protokoll",
                "fernwartung_dienst_abruf")) {
            assertThat(repo).as(tabelle).doesNotContain("INSERT INTO " + tabelle + " ")
                    .doesNotContain("UPDATE " + tabelle + " ").doesNotContain("DELETE FROM");
        }
        for (String datei : List.of("fernwartung/FernwartungRueckmeldungService.java",
                "web/FernwartungRueckmeldungController.java")) {
            String code = ohneKommentare(Files.readString(QUELLEN.resolve(datei)));
            assertThat(code).as(datei).doesNotContain("FernwartungRepository").doesNotContain("FernwartungService ")
                    .doesNotContain("FernwartungService;");
        }
    }

    /** Rechte und RLS der drei Tabellen, wie die übrigen Fernwartungs-Tabellen. */
    @Test
    void dieMigrationVergibtNurWasDieRueckmeldungBraucht() throws Exception {
        String sql;
        try (InputStream in = getClass().getResourceAsStream(MIGRATION)) {
            sql = new String(Objects.requireNonNull(in, MIGRATION).readAllBytes(), StandardCharsets.UTF_8);
        }
        String ohne = sql.replaceAll("(?m)^\\s*--.*$", "");
        for (String tabelle : List.of("fernwartung_rueckmeldung_dienst", "fernwartung_rueckmeldung_box",
                "fernwartung_rueckmeldung_fenster")) {
            assertThat(ohne).contains("CREATE TABLE IF NOT EXISTS " + tabelle + " (")
                    .contains("ALTER TABLE " + tabelle + " ENABLE ROW LEVEL SECURITY;")
                    .contains("ALTER TABLE " + tabelle + " FORCE ROW LEVEL SECURITY;");
        }
        assertThat(ohne).contains("FROM ${appDbUser};").contains("FROM ${adminDbUser};")
                .contains("GRANT SELECT, INSERT, UPDATE ON fernwartung_rueckmeldung_dienst, "
                        + "fernwartung_rueckmeldung_box,\n    fernwartung_rueckmeldung_fenster TO ${adminDbUser};")
                .doesNotContain("DELETE").doesNotContain("TO ${appDbUser}");
        // Die angewandten Tabellen der Fernwartung fasst die Migration nicht an.
        assertThat(ohne).doesNotContain("ALTER TABLE fernwartung_zugang").doesNotContain("ALTER TABLE fernwartung_fenster")
                .doesNotContain("ALTER TABLE fernwartung_protokoll").doesNotContain("DROP ");
    }

    // ── Hilfen ────────────────────────────────────────────────────────────

    /** Der Vektor mit einer Änderung, gegen die Uhr {@code jetzt} geprüft. */
    private Geprueft pruefe(Consumer<ObjectNode> aenderung, Instant jetzt) throws IOException {
        ObjectNode meldung = (ObjectNode) json.readTree(Files.readAllBytes(VEKTOR));
        aenderung.accept(meldung);
        return FernwartungRueckmeldung.pruefe(FernwartungRueckmeldung.lies(json.writeValueAsBytes(meldung)), jetzt);
    }

    private void abgewiesen(Consumer<ObjectNode> aenderung, Instant jetzt, String grund) {
        assertThatThrownBy(() -> pruefe(aenderung, jetzt)).as(grund).isInstanceOf(Ungueltig.class)
                .hasMessageContaining(grund);
    }

    private static List<String> felder(JsonNode knoten) {
        List<String> namen = new ArrayList<>();
        knoten.fieldNames().forEachRemaining(namen::add);
        return namen;
    }

    private static List<String> komponenten(Class<?> record) {
        return Arrays.stream(record.getRecordComponents()).map(c -> c.getName()).toList();
    }

    private static String ohneKommentare(String quelle) {
        return quelle.replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("(?m)//.*$", "");
    }
}
