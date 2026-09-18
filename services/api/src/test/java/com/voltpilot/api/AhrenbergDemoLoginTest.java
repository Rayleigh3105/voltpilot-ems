package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * AP-00 IP-7: das lokale Realm kennt einen dritten Demo-Login {@code ahrenberg}.
 *
 * <p>Geprüft wird OHNE laufendes Keycloak — rein strukturell gegen
 * {@code infra/local/keycloak/voltpilot-realm.json} (dieselbe Datei importiert
 * {@code PortalApiTest} und ein Dutzend weitere Klassen in ihren
 * Keycloak-Testcontainer; der Maven-Testpfad hängt sie als {@code keycloak/}
 * an den Klassenpfad, siehe {@code services/api/pom.xml}).
 *
 * <p>Zwei Dinge hält diese Klasse zusammen, die sonst auseinanderlaufen: der
 * neue Login trägt GENAU die Pflichtfelder der bestehenden Demo-Logins, und
 * sein {@code tenant_id}-Attribut ist derselbe Kundenbereich, den
 * {@code infra/local/seed/ahrenberg.sql} anlegt. Die bestehenden Logins bleiben
 * unberührt — ihr Inhalt steht hier ausgeschrieben.
 */
class AhrenbergDemoLoginTest {

    private static final Path REALM =
            Path.of("..", "..", "infra", "local", "keycloak", "voltpilot-realm.json");
    private static final Path SEED = Path.of("..", "..", "infra", "local", "seed", "ahrenberg.sql");

    @Test
    void dasRealmIstGueltigesJsonUndKenntDenLoginAhrenberg() throws Exception {
        JsonNode realm = new ObjectMapper().readTree(REALM.toFile());

        List<String> namen = new ArrayList<>();
        realm.path("users").forEach(u -> namen.add(u.path("username").asText()));
        assertThat(namen).containsExactly("service-account-voltpilot-release-publisher",
                "service-account-voltpilot-api", "admin", "demo", "demo2", "ahrenberg");

        JsonNode a = benutzer(realm, "ahrenberg");
        JsonNode demo = benutzer(realm, "demo");
        // Dieselben Pflichtfelder wie die bestehenden Demo-Logins - kein Feld mehr, keines weniger.
        assertThat(feldnamen(a)).isEqualTo(feldnamen(demo));
        assertThat(a.path("enabled").asBoolean()).isTrue();
        assertThat(a.path("emailVerified").asBoolean()).isTrue();
        assertThat(a.path("email").asText()).isEqualTo("ahrenberg@voltpilot.local");
        assertThat(a.path("credentials").get(0).path("type").asText()).isEqualTo("password");
        assertThat(a.path("credentials").get(0).path("value").asText()).isEqualTo("ahrenberg");
        assertThat(a.path("credentials").get(0).path("temporary").asBoolean()).isFalse();
        assertThat(a.path("realmRoles")).singleElement()
                .satisfies(r -> assertThat(r.asText()).isEqualTo("operator"));
    }

    @Test
    void derLoginZeigtAufDenKundenbereichDesSeeds() throws Exception {
        JsonNode realm = new ObjectMapper().readTree(REALM.toFile());
        String ausDemRealm = benutzer(realm, "ahrenberg")
                .path("attributes").path("tenant_id").get(0).asText();

        // Die erste tenant-Zeile des Seeds ist der Kundenbereich, den er anlegt.
        Matcher m = Pattern.compile("INSERT INTO tenant[^']*'([0-9a-f-]{36})'")
                .matcher(Files.readString(SEED));
        assertThat(m.find()).as("der Seed legt einen Kundenbereich an").isTrue();
        assertThat(ausDemRealm).isEqualTo(m.group(1));
    }

    @Test
    void diebestehendenDemoLoginsBleibenUnveraendert() throws Exception {
        JsonNode realm = new ObjectMapper().readTree(REALM.toFile());
        assertThat(benutzer(realm, "demo").path("attributes").path("tenant_id").get(0).asText())
                .isEqualTo("00000000-0000-0000-0000-000000000001");
        assertThat(benutzer(realm, "demo").path("credentials").get(0).path("value").asText())
                .isEqualTo("demo");
        assertThat(benutzer(realm, "demo2").path("attributes").path("tenant_id").get(0).asText())
                .isEqualTo("10000000-0000-0000-0000-000000000001");
        assertThat(benutzer(realm, "demo2").path("credentials").get(0).path("value").asText())
                .isEqualTo("demo2");
        assertThat(benutzer(realm, "admin").path("realmRoles").get(0).asText()).isEqualTo("platform-admin");
    }

    private static JsonNode benutzer(JsonNode realm, String name) {
        for (JsonNode u : realm.path("users")) {
            if (name.equals(u.path("username").asText())) {
                return u;
            }
        }
        throw new AssertionError("Login " + name + " fehlt im Realm");
    }

    private static List<String> feldnamen(JsonNode u) {
        List<String> felder = new ArrayList<>();
        u.fieldNames().forEachRemaining(felder::add);
        return felder;
    }
}
