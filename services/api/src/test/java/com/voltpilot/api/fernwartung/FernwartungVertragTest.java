package com.voltpilot.api.fernwartung;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.web.AdminFernwartungController;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Rein, ohne Docker: die Fernwartung sagt in drei Dateien dasselbe - die
 * Migrationen (geschlossene Wörter der CHECKs), die Java-Formen und
 * {@code docs/contracts/openapi.yaml}.
 *
 * <p>Die Wortlisten gelten in ihrer JÜNGSTEN Fassung: V20261008213500 hat die
 * CHECKs aus V20261007163700 erweitert (Zustand {@code geloescht}, Aktion
 * {@code techniker_geloescht}), V20261009074500 die Aktionen noch einmal (SSH-
 * Schlüssel gesetzt und entfernt).
 */
class FernwartungVertragTest {

    private static final Path OPENAPI = Path.of("..", "..", "docs", "contracts", "openapi.yaml");
    private static final String ANLAGE = "/db/migration/V20261007163700__fernwartung.sql";
    private static final String MIGRATION = "/db/migration/V20261008213500__fernwartung_zugang_loeschen.sql";
    private static final String SSH = "/db/migration/V20261009074500__fernwartung_ssh_schluessel.sql";

    private static Map<String, Object> schemas;
    private static Map<String, Object> paths;
    private static String anlage;
    private static String migration;
    private static String ssh;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lade() throws IOException {
        try (InputStream in = Files.newInputStream(OPENAPI)) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
            paths = (Map<String, Object>) openapi.get("paths");
        }
        anlage = lies(ANLAGE);
        migration = lies(MIGRATION);
        ssh = lies(SSH);
    }

    private static String lies(String pfad) throws IOException {
        try (InputStream in = FernwartungVertragTest.class.getResourceAsStream(pfad)) {
            return new String(Objects.requireNonNull(in, pfad).readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    @Test
    void jedeRouteStehtImVertrag() {
        assertThat(paths).containsKeys(
                "/api/v1/admin/fernwartung",
                "/api/v1/admin/fernwartung/boxen",
                "/api/v1/admin/fernwartung/boxen/{ref}",
                "/api/v1/admin/fernwartung/boxen/{ref}/schluessel",
                "/api/v1/admin/fernwartung/boxen/{ref}/sperren",
                "/api/v1/admin/fernwartung/boxen/{ref}/entsperren",
                "/api/v1/admin/fernwartung/techniker",
                "/api/v1/admin/fernwartung/techniker/{id}",
                "/api/v1/admin/fernwartung/techniker/{id}/ssh-schluessel",
                "/api/v1/admin/fernwartung/techniker/{id}/sperren",
                "/api/v1/admin/fernwartung/techniker/{id}/entsperren",
                "/api/v1/admin/fernwartung/fenster",
                "/api/v1/admin/fernwartung/fenster/{id}/schliessen",
                "/api/v1/admin/fernwartung/protokoll",
                "/api/v1/fernwartung/soll");
    }

    @Test
    void dieFormenSindDieDerJavaSeite() {
        for (Object[] paar : new Object[][] {
                {"FernwartungBox", AdminFernwartungController.BoxDto.class},
                {"FernwartungTechniker", AdminFernwartungController.TechnikerDto.class},
                {"FernwartungFenster", AdminFernwartungController.FensterDto.class},
                {"FernwartungServer", AdminFernwartungController.ServerDto.class},
                {"FernwartungUebersicht", AdminFernwartungController.UebersichtDto.class},
                {"FernwartungProtokollEintrag", AdminFernwartungController.ProtokollDto.class},
                {"FernwartungSchluesselAntwort", AdminFernwartungController.SchluesselAntwortDto.class},
                {"FernwartungSoll", FernwartungService.Soll.class}}) {
            assertThat(map(schema((String) paar[0]), "properties").keySet()).as((String) paar[0])
                    .containsExactlyInAnyOrderElementsOf(komponenten((Class<?>) paar[1]));
        }
        // Ein Peer: jedes Feld der Java-Form steht im Vertrag, Pflicht sind alle
        // außer dem Zusatzfeld sshPublicKey (nur am Techniker mit SSH-Schlüssel).
        Map<String, Object> soll = map(schema("FernwartungSoll"), "properties");
        List<String> peerFelder = komponenten(FernwartungService.SollPeer.class);
        assertThat(map(map(map(soll, "peers"), "items"), "properties").keySet())
                .containsExactlyInAnyOrderElementsOf(peerFelder);
        assertThat(map(map(soll, "peers"), "items").get("required")).asList()
                .containsExactlyInAnyOrderElementsOf(peerFelder.stream()
                        .filter(f -> !"sshPublicKey".equals(f)).toList());
        assertThat(map(map(soll, "fenster"), "items").get("required"))
                .asList().containsExactlyInAnyOrderElementsOf(komponenten(FernwartungService.SollFenster.class));
    }

    @Test
    void dieProtokollAktionenSindInMigrationUndVertragDieselben() {
        List<String> ausMigration = woerter(ssh, "aktion IN");
        Map<String, Object> aktion = map(map(schema("FernwartungProtokollEintrag"), "properties"), "aktion");
        assertThat(aktion.get("enum")).asList().containsExactlyInAnyOrderElementsOf(ausMigration);
        // Erweitert, nichts weggenommen: jeder ältere Protokolleintrag bleibt gültig.
        assertThat(woerter(migration, "aktion IN")).containsAll(woerter(anlage, "aktion IN"))
                .contains("techniker_geloescht");
        assertThat(ausMigration).containsAll(woerter(migration, "aktion IN"))
                .contains("techniker_ssh_schluessel_gesetzt", "techniker_ssh_schluessel_entfernt");
    }

    /**
     * Der SSH-Schlüssel am Techniker-Zugang: eine Route zum Setzen und eine zum
     * Entfernen, dieselben Grenzen in Java ({@link SshSchluessel}), Migration
     * (grober CHECK) und Vertrag.
     */
    @Test
    void derSshSchluesselStehtInMigrationJavaUndVertragGleich() {
        Map<String, Object> route = map(paths, "/api/v1/admin/fernwartung/techniker/{id}/ssh-schluessel");
        assertThat(route).containsOnlyKeys("put", "delete");
        assertThat(map(map(route, "put"), "responses")).containsKeys("200", "400", "401", "403", "404");
        assertThat(map(map(route, "delete"), "responses")).containsKeys("200", "401", "403", "404");
        assertThat((String) map(route, "put").get("description"))
                .contains(SshSchluessel.TYP, SshSchluessel.ERZEUGEN, SshSchluessel.MIN_BITS + " bis "
                        + SshSchluessel.MAX_BITS + " Bit");

        // Der CHECK lässt genau die Zeilenlängen der Java-Grenzen zu: "ssh-rsa "
        // plus das Base64 eines Schlüssels mit 2048 bzw. 4096 Bit.
        Matcher laenge = Pattern.compile("length\\(ssh_public_key\\) BETWEEN (\\d+) AND (\\d+)").matcher(ssh);
        assertThat(laenge.find()).isTrue();
        java.math.BigInteger e = java.math.BigInteger.valueOf(65537);
        assertThat(Integer.parseInt(laenge.group(1)))
                .isEqualTo(SshTestSchluessel.rsa(java.math.BigInteger.valueOf(3), groesste(SshSchluessel.MIN_BITS))
                        .length())
                .isEqualTo(SshTestSchluessel.rsa(e, groesste(SshSchluessel.MIN_BITS)).length());
        assertThat(Integer.parseInt(laenge.group(2)))
                .isEqualTo(SshTestSchluessel.rsa(java.math.BigInteger.valueOf(0xFFFFFFFFL),
                        groesste(SshSchluessel.MAX_BITS)).length());
        assertThat(ssh).contains("'^ssh-rsa AAAAB3NzaC1yc2EA[A-Za-z0-9+/]+={0,2}$'")
                .contains("ssh_public_key IS NULL OR art = 'techniker'");
        assertThat(SshTestSchluessel.rsa(e, groesste(SshSchluessel.MIN_BITS))).startsWith("ssh-rsa AAAAB3NzaC1yc2EA");
        // Eine Spalte, kein neues Recht: die Tabellenrechte gelten weiter.
        assertThat(ssh).doesNotContainIgnoringCase("GRANT ").contains("ADD COLUMN IF NOT EXISTS ssh_public_key");
    }

    /** Die größte ungerade Zahl mit so vielen Bit. */
    private static java.math.BigInteger groesste(int bits) {
        return java.math.BigInteger.ONE.shiftLeft(bits).subtract(java.math.BigInteger.ONE);
    }

    /**
     * Löschen ist die eine DELETE-Route auf einem Zugang selbst, und der Zustand
     * {@code geloescht} verlässt die API nie: die Listen lassen gelöschte
     * Zugänge weg, also kennt der Vertrag für einen Zugang weiter nur
     * {@code aktiv} und {@code gesperrt} - die Datenbank einen dritten.
     */
    @Test
    void geloeschtIstEinZustandDerDatenbankUndKeinerDesVertrags() {
        assertThat(map(paths, "/api/v1/admin/fernwartung/techniker/{id}")).containsOnlyKeys("delete");
        Map<String, Object> antworten = map(map(map(paths, "/api/v1/admin/fernwartung/techniker/{id}"),
                "delete"), "responses");
        assertThat(antworten).containsKeys("204", "401", "403", "404", "409");

        assertThat(woerter(migration, "status IN")).containsExactly("aktiv", "gesperrt", "geloescht");
        for (String form : List.of("FernwartungTechniker", "FernwartungBox")) {
            assertThat(map(map(schema(form), "properties"), "status").get("enum")).as(form).asList()
                    .containsExactly("aktiv", "gesperrt");
        }
        // Ein Zustand, kein DELETE: die Migration vergibt kein neues Recht.
        assertThat(migration).doesNotContainIgnoringCase("GRANT ");
    }

    /** Die Wörter der ersten {@code <spalte> IN (...)}-Liste einer Migration. */
    private static List<String> woerter(String sql, String anfang) {
        Matcher m = Pattern.compile(Pattern.quote(anfang) + " \\(([^)]*)\\)", Pattern.DOTALL).matcher(sql);
        assertThat(m.find()).as(anfang).isTrue();
        return Pattern.compile("'([a-z_]+)'").matcher(m.group(1)).results().map(r -> r.group(1)).toList();
    }

    private static List<String> komponenten(Class<?> record) {
        return Arrays.stream(record.getRecordComponents()).map(c -> c.getName()).toList();
    }

    private static Map<String, Object> schema(String name) {
        return map(schemas, name);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Map<String, Object> m, String key) {
        Object v = m.get(key);
        assertThat(v).as(key).isInstanceOf(Map.class);
        return (Map<String, Object>) v;
    }
}
