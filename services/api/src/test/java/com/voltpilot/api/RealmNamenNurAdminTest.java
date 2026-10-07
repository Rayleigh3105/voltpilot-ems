package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * Review Nachweisen r1, P0-1 (zusätzlich zum Code): Vor- und Nachname eines Kontos ändert nur die Administration, nicht
 * das Konto selbst über die Kontoseite ({@code …/realms/voltpilot/account}). Der Urheber im Protokoll kommt ohnehin aus
 * dem Spiegel {@code benutzer.anzeigename} bzw. {@code preferred_username} ({@code ProtokollAkteur}); die Sperre hält
 * den Namen im Token und auf der Kontoseite an dieselbe Hand. Rein - liest nur die Realm-Dateien.
 */
class RealmNamenNurAdminTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @ParameterizedTest
    @ValueSource(strings = {"../../infra/prod/keycloak/voltpilot-realm.json", "../../infra/local/keycloak/voltpilot-realm.json"})
    void vorUndNachnameAendertNurDieAdministration(String datei) throws Exception {
        JsonNode realm = JSON.readTree(Path.of(datei).toFile());
        List<JsonNode> profile = new ArrayList<>();
        realm.path("components").forEach(art -> art.forEach(c -> c.path("config").path("kc.user.profile.config")
                .forEach(v -> {
                    try {
                        profile.add(JSON.readTree(v.asText()));
                    } catch (Exception e) {
                        throw new IllegalStateException(e);
                    }
                })));
        assertThat(profile).as(datei + ": ein User-Profil").hasSize(1);
        for (String name : List.of("firstName", "lastName")) {
            JsonNode attribut = null;
            for (JsonNode a : profile.get(0).path("attributes")) {
                if (a.path("name").asText().equals(name)) attribut = a;
            }
            assertThat(attribut).as(datei + " " + name).isNotNull();
            List<String> edit = new ArrayList<>();
            attribut.at("/permissions/edit").forEach(r -> edit.add(r.asText()));
            assertThat(edit).as(datei + " " + name + " edit").containsExactly("admin");
        }
        assertThat(realm.path("editUsernameAllowed").asBoolean(false)).as(datei + " Anmeldename fest").isFalse();
    }
}
