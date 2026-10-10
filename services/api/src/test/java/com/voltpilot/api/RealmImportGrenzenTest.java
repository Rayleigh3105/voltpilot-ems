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
 * Ein frisches Keycloak (Neuaufbau, Wiederherstellung) muss die Realm-Datei importieren können. Keycloak speichert
 * Beschreibungen von Clients und Rollen in {@code VARCHAR(255)}; eine längere bricht den ganzen Import ab ("Value too
 * long for column DESCRIPTION", gesehen an der Produktionsprüfung 09.10.2026 mit Keycloak 26.0.5). Eine bestehende
 * Produktion merkt das nicht, weil {@code --import-realm} einen vorhandenen Realm überspringt. Rein - liest nur die
 * Realm-Dateien.
 */
class RealmImportGrenzenTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int KEYCLOAK_BESCHREIBUNG_MAX = 255;

    @ParameterizedTest
    @ValueSource(strings = {"../../infra/prod/keycloak/voltpilot-realm.json", "../../infra/local/keycloak/voltpilot-realm.json"})
    void jedeBeschreibungPasstInKeycloaksSpalte(String datei) throws Exception {
        JsonNode realm = JSON.readTree(Path.of(datei).toFile());
        List<String> zuLang = new ArrayList<>();
        realm.path("clients").forEach(c -> pruefe(zuLang, "Client " + c.path("clientId").asText(), c));
        realm.path("roles").path("realm").forEach(r -> pruefe(zuLang, "Rolle " + r.path("name").asText(), r));
        realm.path("roles").path("client").forEach(rollen -> rollen.forEach(
                r -> pruefe(zuLang, "Client-Rolle " + r.path("name").asText(), r)));
        assertThat(zuLang).as(datei).isEmpty();
    }

    private static void pruefe(List<String> zuLang, String was, JsonNode knoten) {
        int laenge = knoten.path("description").asText("").length();
        if (laenge > KEYCLOAK_BESCHREIBUNG_MAX) {
            zuLang.add(was + ": " + laenge + " Zeichen");
        }
    }
}
