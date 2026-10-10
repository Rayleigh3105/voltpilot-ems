package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * UEMS AP-20 IP-20 (E12 = A, BT6, schließt L-005 im Import): die Anmelde-Härtung steht im
 * PRODUKTIONS-Realm-Import {@code infra/prod/keycloak/voltpilot-realm.json}.
 *
 * <p>Geprüft wird OHNE laufendes Keycloak, rein an der Datei: Anmelde- und Admin-Ereignisse mit 90 Tagen
 * Aufbewahrung, die Passwort-Vorgabe (12 Zeichen, nicht der Benutzername, nicht die letzten drei) und der
 * bedingte zweite Faktor — Pflicht für {@code platform-admin} (das ist das Konto des VoltPilot-Betriebs:
 * {@code KeycloakRealmRoleConverter} macht aus genau dieser Rolle {@code KONTO_plattform}), für alle anderen
 * Konten wählbar. Der Passwort-Grant ist für {@code platform-admin} gesperrt; er wäre sonst ein Weg ohne zweiten
 * Faktor. Dass Keycloak die Datei so annimmt und so
 * handelt, zeigt {@link ProduktionsRealmImportTest} im Container.
 *
 * <p>Der Live-Realm ändert sich dadurch nicht ({@code --import-realm} überschreibt keinen bestehenden Realm);
 * den Handgriff des Betreibers beschreibt {@code infra/prod/keycloak/live-realm-import.md}.
 */
class ProduktionsRealmAnmeldungTest {

    private static final Path REALM = Path.of("..", "..", "infra", "prod", "keycloak", "voltpilot-realm.json");
    private static final long NEUNZIG_TAGE = 90L * 24 * 3600;
    private static final String BETRIEB = "platform-admin";
    private static final List<String> OTP = List.of("auth-otp-form", "direct-grant-validate-otp");

    private static JsonNode realm;
    private static final Map<String, JsonNode> ABLAEUFE = new HashMap<>();
    private static final Map<String, JsonNode> KONFIGURATIONEN = new HashMap<>();

    @BeforeAll
    static void lesen() throws Exception {
        realm = new ObjectMapper().readTree(REALM.toFile());
        realm.path("authenticationFlows").forEach(f -> ABLAEUFE.put(f.path("alias").asText(), f));
        realm.path("authenticatorConfig").forEach(c -> KONFIGURATIONEN.put(c.path("alias").asText(), c));
    }

    @Test
    void anmeldeUndAdminEreignisseWerdenNeunzigTageAufbewahrt() {
        assertThat(realm.path("eventsEnabled").asBoolean()).isTrue();
        assertThat(realm.path("eventsExpiration").asLong()).isEqualTo(NEUNZIG_TAGE);
        assertThat(realm.path("adminEventsEnabled").asBoolean()).isTrue();
        assertThat(realm.path("attributes").path("adminEventsExpiration").asText())
                .isEqualTo(Long.toString(NEUNZIG_TAGE));
        // Wer, was, wann — ohne den Inhalt der Änderung: die Darstellung eines angelegten Kontos gehört nicht
        // in ein Protokoll, das 90 Tage liegt.
        assertThat(realm.path("adminEventsDetailsEnabled").asBoolean()).isFalse();
    }

    @Test
    void diePasswortVorgabeIstZwoelfZeichenNichtDerBenutzernameNichtDieLetztenDrei() {
        List<String> teile = Arrays.asList(realm.path("passwordPolicy").asText().split(" and "));
        assertThat(teile).containsExactlyInAnyOrder("length(12)", "notUsername", "passwordHistory(3)");
    }

    @Test
    void derBetriebMeldetSichNurMitZweitemFaktorAn() {
        // Browser: platform-admin -> OTP Pflicht (ohne eingerichtetes OTP verlangt Keycloak die Einrichtung).
        JsonNode browser = ablauf(realm.path("browserFlow").asText());
        assertThat(browser.path("topLevel").asBoolean()).isTrue();
        assertThat(unterablaeufe(browser)).filteredOn(f -> rollenBedingung(f, false))
                .singleElement().satisfies(f -> assertThat(otpPflicht(f)).isTrue());

        // Passwort-Grant: platform-admin -> kein Token, auch nicht mit Passwort allein. Ein REQUIRED
        // direct-grant-validate-otp ohne eingerichtetes OTP endet in Keycloak 26.0.5 mit HTTP 500
        // (ProduktionsRealmImportTest) — darum sperrt der Ablauf den Weg für Betriebskonten ganz.
        JsonNode grant = ablauf(realm.path("directGrantFlow").asText());
        assertThat(grant.path("topLevel").asBoolean()).isTrue();
        assertThat(unterablaeufe(grant)).filteredOn(f -> rollenBedingung(f, false))
                .singleElement().satisfies(f -> assertThat(hat(f, "deny-access-authenticator")).isTrue());
    }

    @Test
    void fuerAlleAnderenKontenIstDerZweiteFaktorWaehlbarNichtPflicht() {
        for (String bindung : List.of("browserFlow", "directGrantFlow")) {
            List<JsonNode> unter = unterablaeufe(ablauf(realm.path(bindung).asText()));
            // Genau ein Ablauf für alle anderen Konten: NICHT platform-admin UND das Konto hat OTP selbst
            // eingerichtet — dann OTP; sonst nichts.
            assertThat(unter).as(bindung).filteredOn(f -> rollenBedingung(f, true))
                    .singleElement().satisfies(f -> {
                        assertThat(hat(f, "conditional-user-configured")).isTrue();
                        assertThat(otpPflicht(f)).isTrue();
                    });
            // Jeder Ablauf, der OTP verlangt oder sperrt, hängt an der Rollen-Bedingung und steht im
            // Elternablauf als CONDITIONAL — nicht REQUIRED.
            for (JsonNode f : unter) {
                if (otpPflicht(f) || hat(f, "deny-access-authenticator")) {
                    assertThat(rollenBedingung(f, false) || rollenBedingung(f, true))
                            .as(f.path("alias").asText()).isTrue();
                    assertThat(eintragFuer(f.path("alias").asText()).path("requirement").asText())
                            .as(f.path("alias").asText()).isEqualTo("CONDITIONAL");
                }
            }
            JsonNode oben = ablauf(realm.path(bindung).asText());
            assertThat(otpPflicht(oben) || hat(oben, "deny-access-authenticator")).as(bindung).isFalse();
        }
        // Keine Pflicht-Aktion zum Einrichten von OTP für jedes neue Konto.
        realm.path("requiredActions").forEach(a -> {
            if ("CONFIGURE_TOTP".equals(a.path("alias").asText())) {
                assertThat(a.path("defaultAction").asBoolean()).isFalse();
            }
        });
    }

    @Test
    void jederVerweisImAblaufZeigtAufEtwasVorhandenes() {
        List<String> rollen = new ArrayList<>();
        realm.path("roles").path("realm").forEach(r -> rollen.add(r.path("name").asText()));
        assertThat(rollen).contains(BETRIEB);
        ABLAEUFE.values().forEach(f -> f.path("authenticationExecutions").forEach(e -> {
            if (e.path("authenticatorFlow").asBoolean()) {
                assertThat(ABLAEUFE).as(e.toString()).containsKey(e.path("flowAlias").asText());
            }
            if (e.hasNonNull("authenticatorConfig")) {
                JsonNode konfig = KONFIGURATIONEN.get(e.path("authenticatorConfig").asText());
                assertThat(konfig).as(e.toString()).isNotNull();
                assertThat(rollen).contains(konfig.path("config").path("condUserRole").asText());
            }
        }));
    }

    @Test
    void keinImportiertesKontoBrichtDieVorgabeUndKeinTextSprengtEineSpalte() {
        // Keycloak prüft die Vorgabe schon beim Import: ein Konto mit kurzem Klartext-Passwort bricht den Start
        // eines frischen Realms ab (so geschehen mit den früheren Demo-Konten demo/demo und demo2/demo2).
        realm.path("users").forEach(u -> u.path("credentials").forEach(c -> {
            String wert = c.path("value").asText();
            if (!wert.matches("\\$\\{[A-Z_]+}")) {
                assertThat(wert).as(u.path("username").asText()).hasSizeGreaterThanOrEqualTo(12)
                        .isNotEqualToIgnoringCase(u.path("username").asText());
            }
        }));
        // Beschreibungen und Namen landen in Spalten mit 255 Zeichen; länger bricht den Import ebenfalls ab
        // (so geschehen mit der Beschreibung des Clients voltpilot-release-publisher, 281 Zeichen).
        List<String> zuLang = new ArrayList<>();
        sammleZuLang(realm, "", zuLang);
        assertThat(zuLang).isEmpty();
    }

    // --- Hilfen -------------------------------------------------------------------------------------------

    private static JsonNode ablauf(String alias) {
        assertThat(ABLAEUFE).as("Ablauf " + alias).containsKey(alias);
        return ABLAEUFE.get(alias);
    }

    /** Alle Unterabläufe unterhalb eines Ablaufs, in beliebiger Tiefe. */
    private static List<JsonNode> unterablaeufe(JsonNode f) {
        List<JsonNode> alle = new ArrayList<>();
        f.path("authenticationExecutions").forEach(e -> {
            if (e.path("authenticatorFlow").asBoolean()) {
                JsonNode kind = ablauf(e.path("flowAlias").asText());
                alle.add(kind);
                alle.addAll(unterablaeufe(kind));
            }
        });
        return alle;
    }

    private static boolean otpPflicht(JsonNode f) {
        for (JsonNode e : f.path("authenticationExecutions")) {
            if (OTP.contains(e.path("authenticator").asText()) && "REQUIRED".equals(e.path("requirement").asText())) {
                return true;
            }
        }
        return false;
    }

    private static boolean rollenBedingung(JsonNode f, boolean verneint) {
        for (JsonNode e : f.path("authenticationExecutions")) {
            if ("conditional-user-role".equals(e.path("authenticator").asText())
                    && "REQUIRED".equals(e.path("requirement").asText())) {
                JsonNode c = KONFIGURATIONEN.get(e.path("authenticatorConfig").asText()).path("config");
                if (BETRIEB.equals(c.path("condUserRole").asText())
                        && Boolean.parseBoolean(c.path("negate").asText()) == verneint) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean hat(JsonNode f, String authenticator) {
        for (JsonNode e : f.path("authenticationExecutions")) {
            if (authenticator.equals(e.path("authenticator").asText())
                    && "REQUIRED".equals(e.path("requirement").asText())) {
                return true;
            }
        }
        return false;
    }

    private static JsonNode eintragFuer(String flowAlias) {
        for (JsonNode f : ABLAEUFE.values()) {
            for (JsonNode e : f.path("authenticationExecutions")) {
                if (flowAlias.equals(e.path("flowAlias").asText())) {
                    return e;
                }
            }
        }
        throw new AssertionError("kein Eintrag verweist auf " + flowAlias);
    }

    private static void sammleZuLang(JsonNode n, String pfad, List<String> zuLang) {
        if (n.isObject()) {
            n.fields().forEachRemaining(e -> {
                if (List.of("name", "description", "alias", "displayName").contains(e.getKey())
                        && e.getValue().isTextual() && e.getValue().asText().length() > 255) {
                    zuLang.add(pfad + "/" + e.getKey() + " (" + e.getValue().asText().length() + ")");
                }
                sammleZuLang(e.getValue(), pfad + "/" + e.getKey(), zuLang);
            });
        } else if (n.isArray()) {
            for (int i = 0; i < n.size(); i++) {
                sammleZuLang(n.get(i), pfad + "[" + i + "]", zuLang);
            }
        }
    }
}
