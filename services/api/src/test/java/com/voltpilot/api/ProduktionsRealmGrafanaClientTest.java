package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;
import org.testcontainers.containers.Container.ExecResult;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.images.builder.Transferable;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import org.testcontainers.utility.MountableFile;

/**
 * RL-P2a (RL-3 = B): der Client {@code grafana} in einem echten Keycloak — dieselbe Version wie
 * {@code deploy/keycloak/Dockerfile}, im Produktionsmodus ({@code start --import-realm}).
 *
 * <p>{@link ProduktionsRealmGrafanaDateiTest} prüft die Definition in den zwei Dateien; diese Klasse prüft, was
 * Keycloak daraus macht, und zwar auf beiden Wegen: am importierten Realm und an einem bestehenden Realm, in dem
 * {@code live-realm-grafana.sh} den Client anlegt. Der Vertrag (GitOps-Repository,
 * {@code infra/monitoring/grafana-zugang/README.md}) nennt vier Sollwerte, und alle vier stehen hier an echten
 * Token aus einer Anmeldung mit Authorization Code und PKCE:
 * <ol>
 *   <li>ID-Token eines {@code platform-admin}: {@code grafana_roles} enthält {@code platform-admin};</li>
 *   <li>ID-Token eines Kundenkontos: {@code grafana_roles} fehlt;</li>
 *   <li>Zugriffstoken beider: kein {@code realm_access};</li>
 *   <li>beide Token tragen {@code sub}.</li>
 * </ol>
 * Sollwert 3 ist der Grund für die Form des Clients: {@link KeycloakRealmRoleConverter} macht aus jedem Token des
 * Realms mit {@code platform-admin} unter {@code realm_access.roles} das Plattform-Konto. Die Tests reichen die
 * Token deshalb durch genau diesen Konverter — und, als Gegenprobe, das Token derselben Sitzung aus dem
 * Portal-Client.
 *
 * <p>Der Live-Realm ändert sich durch nichts hiervon. Den Handgriff beschreibt
 * {@code infra/prod/keycloak/live-realm-grafana.md}.
 */
@Testcontainers(disabledWithoutDocker = true)
class ProduktionsRealmGrafanaClientTest {

    private static final Path REALM = Path.of("..", "..", "infra", "prod", "keycloak", "voltpilot-realm.json");
    private static final Path SKRIPT = Path.of("..", "..", "infra", "prod", "keycloak", "live-realm-grafana.sh");
    private static final Path BLATT = Path.of("..", "..", "infra", "prod", "keycloak", "live-realm-grafana.md");
    private static final Path THEMA = Path.of("..", "..", "deploy", "keycloak", "themes", "voltpilot");
    private static final String ORIGIN = "http://localhost:5173";
    private static final String ADRESSE = "https://grafana.voltpilot.de/login/generic_oauth";
    private static final String API_SECRET = "api-geheimnis-nur-fuer-diesen-test";
    private static final String PORTAL_ADMIN_PASSWORT = "Betrieb-Anmeldung-2026";
    private static final String KC_ADMIN = "kcadmin";
    private static final String KC_ADMIN_PASSWORT = "kcadmin-nur-fuer-diesen-test";
    private static final String KONTO_PASSWORT = "Konto-Passwort-2026";
    private static final ObjectMapper JSON = new ObjectMapper();
    /** Was das API aus {@code platform-admin} macht — und was ein Token des Clients grafana nie ergeben darf. */
    private static final List<String> PLATTFORM = List.of("ROLE_platform-admin", "KONTO_plattform");
    /**
     * Stellt eine gerissene Verbindung nach: reicht jeden Aufruf an {@code kcadm.sh} durch und endet nach
     * {@code ABBRUCH_NACH} Aufrufen von {@code create} mit einem Fehler (wie in {@link ProduktionsRealmImportTest}).
     */
    private static final String KCADM_MIT_ABBRUCH = """
            #!/usr/bin/env bash
            if [[ "${1:-}" == create ]]; then
              n=$(( $(cat "$ZAEHLER" 2> /dev/null || echo 0) + 1 )); echo "$n" > "$ZAEHLER"
              if (( n > ABBRUCH_NACH )); then echo "Probe: Abbruch beim $n. create" >&2; exit 1; fi
            fi
            exec /opt/keycloak/bin/kcadm.sh "$@"
            """;

    @Container
    static final GenericContainer<?> KEYCLOAK =
            new GenericContainer<>(DockerImageName.parse("quay.io/keycloak/keycloak:26.0.5"))
                    .withCopyFileToContainer(MountableFile.forHostPath(REALM),
                            "/opt/keycloak/data/import/voltpilot-realm.json")
                    .withCopyFileToContainer(MountableFile.forHostPath(THEMA), "/opt/keycloak/themes/voltpilot")
                    .withCopyFileToContainer(MountableFile.forHostPath(SKRIPT), "/opt/keycloak/live-realm-grafana.sh")
                    .withCopyToContainer(Transferable.of(KCADM_MIT_ABBRUCH, 0755), "/opt/keycloak/kcadm-mit-abbruch.sh")
                    .withEnv("KC_BOOTSTRAP_ADMIN_USERNAME", KC_ADMIN)
                    .withEnv("KC_BOOTSTRAP_ADMIN_PASSWORD", KC_ADMIN_PASSWORT)
                    .withEnv("VP_PUBLIC_ORIGIN", ORIGIN)
                    .withEnv("VP_API_CLIENT_SECRET", API_SECRET)
                    .withEnv("VP_PORTAL_ADMIN_PASSWORD", PORTAL_ADMIN_PASSWORT)
                    .withCommand("start", "--import-realm", "--http-enabled=true", "--hostname-strict=false")
                    .withLogConsumer(new org.testcontainers.containers.output.Slf4jLogConsumer(
                            org.slf4j.LoggerFactory.getLogger("keycloak-grafana")))
                    .withExposedPorts(8080)
                    .waitingFor(Wait.forHttp("/realms/voltpilot").forPort(8080).forStatusCode(200)
                            .withStartupTimeout(Duration.ofMinutes(4)));

    private final HttpClient http = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();

    /** Der Client grafana, wie der Import ihn angelegt hat — gelesen, bevor ein Test den Realm anfasst. */
    private static Map<String, Object> importBild;

    @BeforeAll
    static void importiertenClientFesthalten() throws Exception {
        importBild = new ProduktionsRealmGrafanaClientTest().clientBild("voltpilot");
    }

    // --- Der importierte Realm ----------------------------------------------------------------------------

    @Test
    void keycloakNimmtDenClientAusDemImportUndErzeugtSeinGeheimnisSelbst() throws Exception {
        // Die Datei nennt kein Geheimnis (ProduktionsRealmGrafanaDateiTest); Keycloak erzeugt beim Import eines.
        String geheimnis = geheimnis("voltpilot");
        assertThat(geheimnis).hasSizeGreaterThanOrEqualTo(32).doesNotContain("${").doesNotContainIgnoringCase("change-me");

        // Der importierte Realm ist der Maßstab: an ihm endet pruefen mit Exit 0 und nennt, was es gelesen hat.
        ExecResult pruefen = skript("voltpilot", "pruefen");
        assertThat(pruefen.getExitCode()).as(ausgabe(pruefen)).isZero();
        assertThat(pruefen.getStdout())
                .contains("Sollwert 1: ID-Token des Kontos ")
                .contains("(platform-admin) traegt grafana_roles = [platform-admin]")
                .contains("Sollwert 2: ID-Token eines Kontos ohne platform-admin")
                .contains("(platform-admin) traegt weder realm_access noch resource_access, grafana_roles oder tenant_id")
                .contains("Sollwert 3: Zugriffstoken eines Kontos ohne platform-admin")
                .contains("(platform-admin) tragen sub")
                .contains("Client grafana im Realm voltpilot steht wie im Import.")
                .doesNotContain("ABWEICHUNG");
        assertThat(ausgabe(pruefen)).as("pruefen zeigt das Geheimnis nie").doesNotContain(geheimnis);

        // geheimnis schreibt den Wert und sonst nichts — auch nichts auf die Fehlerausgabe.
        ExecResult wert = skript("voltpilot", "geheimnis");
        assertThat(wert.getExitCode()).as(ausgabe(wert)).isZero();
        assertThat(wert.getStdout()).isEqualTo(geheimnis + "\n");
        assertThat(wert.getStderr()).isEmpty();

        // angleichen findet am Import nichts zu tun und lässt das Geheimnis stehen.
        ExecResult angleichen = skript("voltpilot", "angleichen");
        assertThat(angleichen.getExitCode()).as(ausgabe(angleichen)).isZero();
        assertThat(angleichen.getStdout()).contains("Client grafana war vorhanden")
                .doesNotContain("geloest").doesNotContain("in den Scope").doesNotContain("ACHTUNG");
        assertThat(ausgabe(angleichen)).doesNotContain(geheimnis);
        assertThat(geheimnis("voltpilot")).isEqualTo(geheimnis);
        assertThat(clientBild("voltpilot")).as("angleichen ändert am importierten Client nichts").isEqualTo(importBild);
    }

    @Test
    void einKundenkontoBekommtWederRolleNochKundenbereichInsToken() throws Exception {
        String name = "kunde-" + kurz();
        kontoAnlegen("voltpilot", name, false);

        // Keycloak nimmt die Anmeldung an — abweisen wird Grafana, weil dem ID-Token die Rolle fehlt (Sollwert 2).
        Anmeldung anmeldung = anmelden("voltpilot", "grafana", ADRESSE, name, Map.of());
        assertThat(anmeldung.zweiterFaktor()).as("Kundenkonto: kein zweiter Faktor verlangt").isFalse();
        JsonNode token = tauschen("voltpilot", "grafana", geheimnis("voltpilot"), ADRESSE, anmeldung);
        JsonNode idToken = inhalt(token.path("id_token").asText());
        JsonNode zugriff = inhalt(token.path("access_token").asText());

        assertThat(idToken.has("grafana_roles")).as("Sollwert 2: " + idToken).isFalse();
        assertThat(zugriff.has("realm_access")).as("Sollwert 3: " + zugriff).isFalse();
        assertThat(zugriff.has("resource_access")).isFalse();
        assertThat(zugriff.has("grafana_roles")).isFalse();
        // Der Mapper für tenant_id hängt an den Clients des Portals, nicht an diesem: kein Kundenbereich im Token.
        assertThat(zugriff.has("tenant_id")).as(zugriff.toString()).isFalse();
        assertThat(idToken.has("tenant_id")).isFalse();
        assertThat(idToken.path("sub").asText()).as("Sollwert 4").isNotBlank().isEqualTo(zugriff.path("sub").asText());
        // Was Grafana für das Konto braucht, ist da (Scopes profile und email).
        assertThat(idToken.path("preferred_username").asText()).isEqualTo(name);
        assertThat(idToken.path("email").asText()).isEqualTo(name + "@beispiel.invalid");
        assertThat(zugriff.path("azp").asText()).isEqualTo("grafana");

        // Am API ist dieses Token kein Konto. Gegenprobe mit derselben Sitzung am Portal-Client: Kundenkonto.
        assertThat(rechteAmApi(token.path("access_token").asText())).isEmpty();
        assertThat(rechteAmApi(token.path("id_token").asText())).isEmpty();
        assertThat(rechteAmApi(portalToken("voltpilot", anmeldung))).contains("KONTO_benutzer")
                .doesNotContainAnyElementsOf(PLATTFORM);
    }

    @Test
    void derBetriebBekommtDieRolleNurInsIdTokenUndNurMitZweitemFaktor() throws Exception {
        String name = "betrieb-" + kurz();
        kontoAnlegen("voltpilot", name, true);

        // Der Client hat keinen eigenen Anmelde-Ablauf: Es gilt der des Realms, und der verlangt von platform-admin
        // den zweiten Faktor. Die Hilfe richtet ihn ein, wie es die erste Anmeldung eines Betriebskontos tut.
        Anmeldung anmeldung = anmelden("voltpilot", "grafana", ADRESSE, name, Map.of());
        assertThat(anmeldung.zweiterFaktor()).as("platform-admin: zweiter Faktor verlangt").isTrue();
        String geheimnis = geheimnis("voltpilot");
        JsonNode token = tauschen("voltpilot", "grafana", geheimnis, ADRESSE, anmeldung);
        JsonNode idToken = inhalt(token.path("id_token").asText());
        JsonNode zugriff = inhalt(token.path("access_token").asText());

        assertThat(texte(idToken.path("grafana_roles"))).as("Sollwert 1: " + idToken).containsExactly("platform-admin");
        assertThat(zugriff.has("realm_access")).as("Sollwert 3: " + zugriff).isFalse();
        assertThat(zugriff.has("resource_access")).isFalse();
        assertThat(zugriff.has("grafana_roles")).as("die Rolle steht nur im ID-Token").isFalse();
        assertThat(zugriff.has("tenant_id")).isFalse();
        assertThat(idToken.path("sub").asText()).as("Sollwert 4").isNotBlank().isEqualTo(zugriff.path("sub").asText());

        // Der Kern des Vertrags: Dieses Zugriffstoken — Grafana bewahrt es auf — ist am API KEIN Plattform-Konto,
        // und das ID-Token auch nicht (das API liest grafana_roles nicht).
        assertThat(rechteAmApi(token.path("access_token").asText())).isEmpty();
        assertThat(rechteAmApi(token.path("id_token").asText())).isEmpty();
        // Auch das erneuerte Zugriffstoken nicht; Grafana erneuert es alle 15 Minuten.
        HttpResponse<String> erneuert = post(tokenUrl("voltpilot"), Map.of("grant_type", "refresh_token",
                "client_id", "grafana", "client_secret", geheimnis, "refresh_token", token.path("refresh_token").asText()));
        assertThat(erneuert.statusCode()).as(erneuert.body()).isEqualTo(200);
        String neu = JSON.readTree(erneuert.body()).path("access_token").asText();
        assertThat(inhalt(neu).has("realm_access")).isFalse();
        assertThat(rechteAmApi(neu)).isEmpty();
        // Und userinfo nennt die Rolle nicht (Grafana fragt dort nicht; der Mapper schreibt nur ins ID-Token).
        HttpResponse<String> userinfo = http.send(HttpRequest.newBuilder(
                        URI.create(basis() + "/realms/voltpilot/protocol/openid-connect/userinfo"))
                .header("Authorization", "Bearer " + token.path("access_token").asText()).GET().build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(userinfo.statusCode()).as(userinfo.body()).isEqualTo(200);
        assertThat(userinfo.body()).doesNotContain("grafana_roles").doesNotContain("realm_access").doesNotContain("platform-admin");

        // Gegenprobe: dieselbe Sitzung, Portal-Client (Scope roles, Full Scope an — ein Client nach Werksvorgabe).
        // Dessen Zugriffstoken IST am API das Plattform-Konto. Genau das darf in Grafanas Datenbank nicht liegen.
        String portal = portalToken("voltpilot", anmeldung);
        assertThat(texte(inhalt(portal).path("realm_access").path("roles"))).contains("platform-admin");
        assertThat(rechteAmApi(portal)).containsAll(PLATTFORM);
    }

    @Test
    void derClientKenntNurDenEinenWegUndDieEineAdresse() throws Exception {
        String name = "kunde-" + kurz();
        kontoAnlegen("voltpilot", name, false);
        String geheimnis = geheimnis("voltpilot");

        // Genau eine Rückruf-Adresse, zeichengleich: kein Platzhalter, kein anderes Schema, kein Zusatz.
        for (String andere : List.of("https://grafana.voltpilot.de/", ADRESSE + "/x", ADRESSE + "?x=1",
                ADRESSE.replace("https://", "http://"), ORIGIN + "/", "https://boese.invalid/login/generic_oauth")) {
            HttpResponse<String> r = get(authUrl("voltpilot", "grafana", andere, "v".repeat(50), Map.of()));
            assertThat(r.statusCode()).as(andere + " " + r.headers().firstValue("Location").orElse("")).isEqualTo(400);
        }

        // PKCE mit S256 ist Pflicht; ohne oder mit „plain“ gibt es keinen Code.
        assertThat(fehlerDerAnmeldung(name, Map.of("code_challenge", "", "code_challenge_method", "")))
                .contains("error=invalid_request").contains("code_challenge_method");
        assertThat(fehlerDerAnmeldung(name, Map.of("code_challenge", "a".repeat(43), "code_challenge_method", "plain")))
                .contains("error=invalid_request");
        // Nur der Standard Flow: kein Token und kein ID-Token direkt aus der Anmeldung.
        assertThat(fehlerDerAnmeldung(name, Map.of("response_type", "token", "nonce", "n")))
                .contains("error=unauthorized_client");
        assertThat(fehlerDerAnmeldung(name, Map.of("response_type", "code id_token", "nonce", "n")))
                .contains("error=unauthorized_client");
        // Der Scope roles lässt sich auch nicht anfordern: er hängt weder fest noch zur Wahl am Client.
        assertThat(fehlerDerAnmeldung(name, Map.of("scope", "openid roles"))).contains("error=invalid_scope");

        // Kein Passwort-Grant, kein Servicekonto.
        HttpResponse<String> passwort = post(tokenUrl("voltpilot"), Map.of("grant_type", "password", "client_id", "grafana",
                "client_secret", geheimnis, "username", name, "password", KONTO_PASSWORT));
        assertThat(passwort.statusCode()).as(passwort.body()).isEqualTo(400);
        assertThat(passwort.body()).contains("unauthorized_client").doesNotContain("access_token");
        HttpResponse<String> dienst = post(tokenUrl("voltpilot"), Map.of("grant_type", "client_credentials",
                "client_id", "grafana", "client_secret", geheimnis));
        assertThat(dienst.statusCode()).as(dienst.body()).isEqualTo(401);
        assertThat(dienst.body()).contains("unauthorized_client").doesNotContain("access_token");

        // Der Tausch des Codes braucht das Geheimnis UND den PKCE-Beweis; ein leeres Geheimnis ist keines.
        for (String falsch : new String[] {"falsches-geheimnis", "", null}) {
            Anmeldung a = anmelden("voltpilot", "grafana", ADRESSE, name, Map.of());
            HttpResponse<String> r = tausch("voltpilot", "grafana", falsch, ADRESSE, a.code(), a.verifier());
            assertThat(r.statusCode()).as("Geheimnis '" + falsch + "': " + r.body()).isEqualTo(401);
        }
        Anmeldung a = anmelden("voltpilot", "grafana", ADRESSE, name, Map.of());
        HttpResponse<String> ohneBeweis = tausch("voltpilot", "grafana", geheimnis, ADRESSE, a.code(), "x".repeat(50));
        assertThat(ohneBeweis.statusCode()).as(ohneBeweis.body()).isEqualTo(400);
        assertThat(ohneBeweis.body()).contains("PKCE");

        // Nach dem Abmelden führt Keycloak nur an dieselbe Adresse zurück (signout_redirect_url von Grafana).
        String abmelden = basis() + "/realms/voltpilot/protocol/openid-connect/logout?client_id=grafana&post_logout_redirect_uri=";
        HttpResponse<String> zurueck = get(abmelden + URLEncoder.encode(ADRESSE, StandardCharsets.UTF_8));
        assertThat(zurueck.statusCode()).as(zurueck.body()).isEqualTo(302);
        assertThat(zurueck.headers().firstValue("Location").orElse("")).isEqualTo(ADRESSE);
        assertThat(get(abmelden + URLEncoder.encode("https://boese.invalid/", StandardCharsets.UTF_8)).statusCode()).isEqualTo(400);
    }

    // --- Der bestehende Realm: das Skript des Blatts -------------------------------------------------------

    @Test
    void dasSkriptLegtDenClientImBestehendenRealmGleichDemImportAn() throws Exception {
        // Ein Realm wie der Live-Realm nach der Anmelde-Härtung: alles aus dem Import, nur der Client grafana fehlt.
        String alt = realmWieDerImportOhneDenClient();
        String betrieb = "betrieb-" + kurz();
        String kunde = "kunde-" + kurz();
        kontoAnlegen(alt, betrieb, true);
        kontoAnlegen(alt, kunde, false);

        ExecResult vorher = skript(alt, "pruefen");
        assertThat(vorher.getExitCode()).as(ausgabe(vorher)).isEqualTo(1);
        assertThat(vorher.getStdout()).contains("ABWEICHUNG Client grafana fehlt im Realm " + alt);
        ExecResult nochKeines = skript(alt, "geheimnis");
        assertThat(nochKeines.getExitCode()).isEqualTo(1);
        assertThat(nochKeines.getStdout()).isEmpty();

        ExecResult lauf = skript(alt, "angleichen");
        assertThat(lauf.getExitCode()).as(ausgabe(lauf)).isZero();
        assertThat(lauf.getStdout()).contains("Client grafana angelegt, noch ohne Rolle im Scope.")
                .contains("Realm-Rolle platform-admin in den Scope des Clients genommen.")
                .contains("Client grafana im Realm " + alt + " angelegt.")
                .doesNotContain("ACHTUNG");
        String geheimnis = geheimnis(alt);
        assertThat(geheimnis).as("Keycloak erzeugt das Geheimnis").hasSizeGreaterThanOrEqualTo(32);
        assertThat(ausgabe(lauf)).as("angleichen zeigt das Geheimnis nie").doesNotContain(geheimnis);

        // Ein zweiter Lauf legt nichts doppelt an und lässt das Geheimnis stehen — Grafana meldet sich weiter an.
        ExecResult nochmal = skript(alt, "angleichen");
        assertThat(nochmal.getExitCode()).as(ausgabe(nochmal)).isZero();
        assertThat(nochmal.getStdout()).contains("Client grafana war vorhanden").doesNotContain("geloest")
                .doesNotContain("in den Scope");
        assertThat(adminGet(alt, "/clients?clientId=grafana")).hasSize(1);
        assertThat(geheimnis(alt)).isEqualTo(geheimnis);

        ExecResult danach = skript(alt, "pruefen");
        assertThat(danach.getExitCode()).as(ausgabe(danach)).isZero();
        assertThat(danach.getStdout())
                .contains("Sollwert 1: ID-Token des Kontos")
                .contains("Sollwert 2: ID-Token eines Kontos ohne platform-admin")
                .contains("Client grafana im Realm " + alt + " steht wie im Import.");
        assertThat(ausgabe(danach)).doesNotContain(geheimnis);
        ExecResult wert = skript(alt, "geheimnis");
        assertThat(wert.getExitCode()).as(ausgabe(wert)).isZero();
        assertThat(wert.getStdout()).isEqualTo(geheimnis + "\n");
        // pruefen hat nur gelesen: Die Beispiel-Token stellt Keycloak aus, ohne ein Konto anzumelden. Bis hierher
        // gibt es im Realm keine Sitzung an diesem Client und kein einziges Anmelde-Ereignis.
        assertThat(adminGet(alt, "/client-session-stats")).isEmpty();
        assertThat(adminGet(alt, "/events?max=50")).isEmpty();

        // Live-Realm = Import: dieselbe Client-Definition, Feld für Feld, samt Mapper, Scopes und Scope-Zuordnung.
        assertThat(clientBild(alt)).isEqualTo(importBild);

        // Und dieselben Token: die vier Sollwerte an echten Anmeldungen im Realm, den das Skript ergänzt hat.
        Anmeldung alsBetrieb = anmelden(alt, "grafana", ADRESSE, betrieb, Map.of());
        assertThat(alsBetrieb.zweiterFaktor()).isTrue();
        JsonNode tokenBetrieb = tauschen(alt, "grafana", geheimnis, ADRESSE, alsBetrieb);
        assertThat(texte(inhalt(tokenBetrieb.path("id_token").asText()).path("grafana_roles")))
                .as("Sollwert 1").containsExactly("platform-admin");
        Anmeldung alsKunde = anmelden(alt, "grafana", ADRESSE, kunde, Map.of());
        JsonNode tokenKunde = tauschen(alt, "grafana", geheimnis, ADRESSE, alsKunde);
        assertThat(inhalt(tokenKunde.path("id_token").asText()).has("grafana_roles")).as("Sollwert 2").isFalse();
        for (JsonNode token : List.of(tokenBetrieb, tokenKunde)) {
            JsonNode zugriff = inhalt(token.path("access_token").asText());
            assertThat(zugriff.has("realm_access")).as("Sollwert 3: " + zugriff).isFalse();
            assertThat(zugriff.has("tenant_id")).isFalse();
            assertThat(zugriff.path("sub").asText()).as("Sollwert 4").isNotBlank()
                    .isEqualTo(inhalt(token.path("id_token").asText()).path("sub").asText());
            assertThat(rechteAmApi(token.path("access_token").asText())).isEmpty();
        }

        // Der Rückweg, wie er im Blatt steht: Der Client ist aus. Keycloak nimmt über ihn keine Anmeldung mehr an
        // und erneuert kein Token; das Geheimnis bleibt, und angleichen schaltet ihn wieder ein.
        ExecResult aus = angemeldet(rueckwegDesBlatts().replace("-r voltpilot", "-r " + alt));
        assertThat(aus.getExitCode()).as(ausgabe(aus)).isZero();
        assertThat(adminGet(alt, "/clients/" + clientId(alt, "grafana")).path("enabled").asBoolean()).isFalse();
        HttpResponse<String> seite = get(authUrl(alt, "grafana", ADRESSE, "v".repeat(50), Map.of()));
        assertThat(seite.statusCode()).as(seite.body()).isEqualTo(400);
        assertThat(seite.body()).doesNotContain("kc-form-login");
        HttpResponse<String> erneuern = post(tokenUrl(alt), Map.of("grant_type", "refresh_token", "client_id", "grafana",
                "client_secret", geheimnis, "refresh_token", tokenKunde.path("refresh_token").asText()));
        assertThat(erneuern.statusCode()).as(erneuern.body()).isBetween(400, 401);
        assertThat(erneuern.body()).doesNotContain("access_token");
        ExecResult abgeschaltet = skript(alt, "pruefen");
        assertThat(abgeschaltet.getExitCode()).as(ausgabe(abgeschaltet)).isEqualTo(1);
        assertThat(abgeschaltet.getStdout()).contains("ABWEICHUNG enabled: ist 'false', soll 'true'");
        ExecResult wiederAn = skript(alt, "angleichen");
        assertThat(wiederAn.getExitCode()).as(ausgabe(wiederAn)).isZero();
        assertThat(geheimnis(alt)).as("Grafana braucht keinen neuen Wert").isEqualTo(geheimnis);
        assertThat(clientBild(alt)).isEqualTo(importBild);
        tauschen(alt, "grafana", geheimnis, ADRESSE, anmelden(alt, "grafana", ADRESSE, kunde, Map.of()));
    }

    @Test
    void pruefenNenntJedeVerstellteStelleUndAngleichenZiehtSieZurueck() throws Exception {
        String alt = realmWieDerImportOhneDenClient();
        ExecResult lauf = skript(alt, "angleichen");
        assertThat(lauf.getExitCode()).as(ausgabe(lauf)).isZero();
        String geheimnis = geheimnis(alt);
        String id = clientId(alt, "grafana");

        // Der Client, wie ihn jemand in der Administration „repariert“ hätte: Full Scope an, der Scope roles dazu,
        // ein Mapper für realm_access, eine zweite Adresse mit Platzhalter, PKCE weg, weitere Wege zu einem Token.
        ObjectNode verstellt = (ObjectNode) adminGet(alt, "/clients/" + id);
        verstellt.put("fullScopeAllowed", true).put("directAccessGrantsEnabled", true);
        ((ArrayNode) verstellt.withArray("redirectUris")).add("https://grafana.voltpilot.de/*");
        ((ObjectNode) verstellt.path("attributes")).put("pkce.code.challenge.method", "")
                .put("oauth2.device.authorization.grant.enabled", "true");
        verstellt.putObject("authenticationFlowBindingOverrides").put("browser", ablaufId(alt, "browser"));
        assertThat(adminPut(alt, "/clients/" + id, verstellt.toString())).isEqualTo(204);
        assertThat(adminPut(alt, "/clients/" + id + "/default-client-scopes/" + scopeId(alt, "roles"), "")).isEqualTo(204);
        assertThat(adminPut(alt, "/clients/" + id + "/optional-client-scopes/" + scopeId(alt, "offline_access"), ""))
                .isEqualTo(204);
        assertThat(adminPost(alt, "/clients/" + id + "/protocol-mappers/models", JSON.writeValueAsString(Map.of(
                "name", "realm roles", "protocol", "openid-connect", "protocolMapper", "oidc-usermodel-realm-role-mapper",
                "config", Map.of("claim.name", "realm_access.roles", "multivalued", "true", "access.token.claim", "true")))))
                .isEqualTo(201);
        assertThat(adminPost(alt, "/clients/" + id + "/scope-mappings/realm", "[" + adminGet(alt, "/roles/operator") + "]"))
                .isEqualTo(204);

        ExecResult verstelltGeprueft = skript(alt, "pruefen");
        assertThat(verstelltGeprueft.getExitCode()).as(ausgabe(verstelltGeprueft)).isEqualTo(1);
        assertThat(verstelltGeprueft.getStdout())
                .contains("ABWEICHUNG fullScopeAllowed: ist 'true', soll 'false'")
                .contains("ABWEICHUNG directAccessGrantsEnabled: ist 'true', soll 'false'")
                .contains("ABWEICHUNG redirectUris: ist '")
                .contains("soll genau eine Adresse: '" + ADRESSE + "'")
                .contains("ABWEICHUNG attributes.pkce.code.challenge.method: ist '', soll 'S256'")
                .contains("ABWEICHUNG attributes.oauth2.device.authorization.grant.enabled: ist 'true', soll aus")
                .contains("ABWEICHUNG authenticationFlowBindingOverrides: der Client hat einen eigenen Anmelde-Ablauf")
                .contains("ABWEICHUNG Mapper 'realm roles' (oidc-usermodel-realm-role-mapper) ist zu viel")
                .contains("ABWEICHUNG Default Client Scope roles ist zu viel")
                .contains("ABWEICHUNG Optional Client Scopes: ist 'offline_access', soll keine")
                .contains("ABWEICHUNG Scope-Zuordnung: Realm-Rolle 'operator' ist zu viel")
                // Die Folge, an der es hängt: das Zugriffstoken des Betriebskontos trüge jetzt die Rolle.
                .contains("ABWEICHUNG Sollwert 3: Zugriffstoken des Kontos admin (platform-admin) traegt realm_access")
                .doesNotContain("steht wie im Import");

        ExecResult zurueck = skript(alt, "angleichen");
        assertThat(zurueck.getExitCode()).as(ausgabe(zurueck)).isZero();
        assertThat(zurueck.getStdout())
                .contains("Optional Client Scope offline_access vom Client geloest.")
                .contains("Default Client Scope roles vom Client geloest.")
                .contains("Weitere Ablaeufe und eigener Anmelde-Ablauf am Client zurueckgenommen.")
                .contains("Realm-Rolle operator aus dem Scope des Clients genommen.");
        ExecResult wiederGut = skript(alt, "pruefen");
        assertThat(wiederGut.getExitCode()).as(ausgabe(wiederGut)).isZero();
        assertThat(geheimnis(alt)).as("angleichen ändert das Geheimnis nie").isEqualTo(geheimnis);
        JsonNode danach = adminGet(alt, "/clients/" + id);
        assertThat(texte(danach.path("redirectUris"))).containsExactly(ADRESSE);
        assertThat(danach.path("webOrigins")).as("keine Web Origins, auch nicht aus der Adresse abgeleitet").isEmpty();
        assertThat(danach.path("protocolMappers")).hasSize(1);
        assertThat(danach.path("authenticationFlowBindingOverrides")).isEmpty();

        // Eine Client-Rolle im Scope nimmt angleichen nicht selbst heraus: Es sagt, wo sie steht, und lässt den Rest.
        String konto = clientId(alt, "account");
        assertThat(adminPost(alt, "/clients/" + id + "/scope-mappings/clients/" + konto,
                "[" + adminGet(alt, "/clients/" + konto + "/roles/view-profile") + "]")).isEqualTo(204);
        ExecResult verweigert = skript(alt, "angleichen");
        assertThat(verweigert.getExitCode()).as(ausgabe(verweigert)).isEqualTo(4);
        assertThat(verweigert.getStdout()).contains("Scope-Zuordnung: Client-Rollen sind zugeordnet, soll keine");
        assertThat(adminDelete(alt, "/clients/" + id + "/scope-mappings/clients/" + konto, "[{\"name\":\"view-profile\"}]"))
                .isEqualTo(204);

        // Eine Änderung, die am Client selbst nicht zu sehen ist: ein Rollen-Mapper im Scope profile des Realms.
        // Die Einstellungen des Clients stimmen weiter — die Beispiel-Token zeigen es trotzdem (Sollwert 3).
        String profil = scopeId(alt, "profile");
        assertThat(adminPost(alt, "/client-scopes/" + profil + "/protocol-mappers/models", JSON.writeValueAsString(Map.of(
                "name", "fremd", "protocol", "openid-connect", "protocolMapper", "oidc-usermodel-realm-role-mapper",
                "config", Map.of("claim.name", "realm_access.roles", "multivalued", "true", "access.token.claim", "true")))))
                .isEqualTo(201);
        ExecResult imScope = skript(alt, "pruefen");
        assertThat(imScope.getExitCode()).as(ausgabe(imScope)).isEqualTo(1);
        assertThat(imScope.getStdout())
                .contains("ABWEICHUNG Sollwert 3: Zugriffstoken des Kontos admin (platform-admin) traegt realm_access")
                .doesNotContain("ist zu viel").doesNotContain("steht wie im Import");
    }

    @Test
    void einAbgebrochenerLaufLaesstKeineRolleImToken() throws Exception {
        String alt = realmWieDerImportOhneDenClient();

        // Der Lauf reißt nach dem Anlegen des Clients ab (das zweite create wäre die Scope-Zuordnung).
        ExecResult abbruch = angemeldet("REALM=" + alt + " KCADM=/opt/keycloak/kcadm-mit-abbruch.sh ABBRUCH_NACH=1"
                + " ZAEHLER=/tmp/abbruch-" + kurz() + ".zahl bash -s angleichen < /opt/keycloak/live-realm-grafana.sh");
        assertThat(abbruch.getExitCode()).as(ausgabe(abbruch)).isNotZero();
        assertThat(abbruch.getStdout()).contains("Client grafana angelegt, noch ohne Rolle im Scope.")
                .doesNotContain("in den Scope des Clients genommen");
        assertThat(abbruch.getStderr()).contains("Probe: Abbruch beim 2. create");

        // Der halbe Stand ist der sichere: Der Client steht, aber keine Rolle ist in seinem Scope — das ID-Token
        // des Betriebskontos trägt grafana_roles nicht, niemand käme in Grafana hinein. pruefen sagt es.
        assertThat(adminGet(alt, "/clients/" + clientId(alt, "grafana") + "/scope-mappings").has("realmMappings")).isFalse();
        ExecResult halb = skript(alt, "pruefen");
        assertThat(halb.getExitCode()).as(ausgabe(halb)).isEqualTo(1);
        assertThat(halb.getStdout())
                .contains("ABWEICHUNG Scope-Zuordnung: Realm-Rolle platform-admin fehlt")
                .contains("ABWEICHUNG Sollwert 1: ID-Token des Kontos admin (platform-admin) traegt grafana_roles nicht, soll [platform-admin]")
                .doesNotContain("ABWEICHUNG Sollwert 3");

        // Der nächste Lauf holt nach, was fehlt, und legt nichts doppelt an.
        ExecResult zweiter = skript(alt, "angleichen");
        assertThat(zweiter.getExitCode()).as(ausgabe(zweiter)).isZero();
        assertThat(zweiter.getStdout()).contains("Client grafana war vorhanden")
                .contains("Realm-Rolle platform-admin in den Scope des Clients genommen.");
        ExecResult danach = skript(alt, "pruefen");
        assertThat(danach.getExitCode()).as(ausgabe(danach)).isZero();
        assertThat(clientBild(alt)).isEqualTo(importBild);
    }

    @Test
    void ohneAnmeldeHaertungOderOhneRolleSagtDasSkriptWasFehlt() throws Exception {
        // Ein Realm ohne die Anmelde-Härtung (eingebaute Abläufe): Der Client entsteht, aber pruefen endet nicht
        // mit Exit 0 — ohne den Ablauf des Realms fragte Keycloak ein Betriebskonto nicht nach dem zweiten Faktor.
        String ohneHaertung = "ohne-haertung-" + kurz();
        assertThat(adminPost("", "", JSON.writeValueAsString(Map.of("realm", ohneHaertung, "enabled", true)))).isEqualTo(201);
        assertThat(adminPost(ohneHaertung, "/roles", "{\"name\":\"platform-admin\"}")).isEqualTo(201);
        kontoAnlegen(ohneHaertung, "betrieb-alt", true);
        kontoAnlegen(ohneHaertung, "kunde-alt", false);
        ExecResult lauf = skript(ohneHaertung, "angleichen");
        assertThat(lauf.getExitCode()).as(ausgabe(lauf)).isZero();
        assertThat(lauf.getStdout())
                .contains("ACHTUNG: Der Realm " + ohneHaertung + " bindet den Browser-Ablauf voltpilot-browser nicht.");
        ExecResult pruefen = skript(ohneHaertung, "pruefen");
        assertThat(pruefen.getExitCode()).as(ausgabe(pruefen)).isEqualTo(1);
        assertThat(pruefen.getStdout())
                .contains("ABWEICHUNG Realm, browserFlow: ist 'browser', soll 'voltpilot-browser'")
                .contains("Sollwert 1: ID-Token des Kontos betrieb-alt (platform-admin) traegt grafana_roles = [platform-admin]")
                .doesNotContain("steht wie im Import");
        assertThat(pruefen.getStdout().lines().filter(z -> z.startsWith("ABWEICHUNG")).count())
                .as("der Client selbst steht richtig: " + pruefen.getStdout()).isEqualTo(1);

        // Ein Platzhalter ist kein Geheimnis (so stünde es nach einem Import mit „${VP_…}“ ohne gesetzte Variable):
        // geheimnis gibt ihn nicht aus, pruefen meldet ihn, ohne ihn zu zeigen.
        String id = clientId(ohneHaertung, "grafana");
        ObjectNode mitPlatzhalter = (ObjectNode) adminGet(ohneHaertung, "/clients/" + id);
        mitPlatzhalter.put("secret", "${VP_GRAFANA_CLIENT_SECRET}");
        assertThat(adminPut(ohneHaertung, "/clients/" + id, mitPlatzhalter.toString())).isEqualTo(204);
        ExecResult keines = skript(ohneHaertung, "geheimnis");
        assertThat(keines.getExitCode()).as(ausgabe(keines)).isEqualTo(1);
        assertThat(keines.getStdout()).isEmpty();
        assertThat(keines.getStderr()).contains("ist ein Platzhalter oder kuerzer als 24 Zeichen").doesNotContain("VP_GRAFANA");
        ExecResult gemeldet = skript(ohneHaertung, "pruefen");
        assertThat(gemeldet.getExitCode()).as(ausgabe(gemeldet)).isEqualTo(1);
        assertThat(gemeldet.getStdout()).contains("ABWEICHUNG Client-Geheimnis: ein Platzhalter oder kuerzer als 24 Zeichen");
        assertThat(ausgabe(gemeldet)).doesNotContain("VP_GRAFANA");

        // Ein Realm ohne die Rolle: angleichen ändert nichts.
        String ohneRolle = "ohne-rolle-" + kurz();
        assertThat(adminPost("", "", JSON.writeValueAsString(Map.of("realm", ohneRolle, "enabled", true)))).isEqualTo(201);
        ExecResult verweigert = skript(ohneRolle, "angleichen");
        assertThat(verweigert.getExitCode()).as(ausgabe(verweigert)).isEqualTo(3);
        assertThat(verweigert.getStdout())
                .contains("VERWEIGERT: Die Realm-Rolle platform-admin fehlt im Realm " + ohneRolle + ". Nichts wurde geaendert.");
        assertThat(adminGet(ohneRolle, "/clients?clientId=grafana")).isEmpty();

        // Ein Realm, den es nicht gibt (oder kcadm ohne Anmeldung): ein eigener Exit-Code, nicht „Client fehlt“.
        ExecResult keinRealm = skript("gibt-es-nicht-" + kurz(), "pruefen");
        assertThat(keinRealm.getExitCode()).as(ausgabe(keinRealm)).isEqualTo(5);
        assertThat(keinRealm.getStdout()).doesNotContain("ABWEICHUNG");
        assertThat(keinRealm.getStderr()).contains("FEHLER: kcadm liest den Realm");
    }

    // --- Hilfen -------------------------------------------------------------------------------------------

    /** Was eine Anmeldung im Browser ergab: der Code für den Tausch, der PKCE-Beweis und die Sitzung. */
    private record Anmeldung(String code, String verifier, Map<String, String> cookies, boolean zweiterFaktor) { }

    private static String basis() {
        return "http://" + KEYCLOAK.getHost() + ":" + KEYCLOAK.getMappedPort(8080);
    }

    private static String tokenUrl(String realm) {
        return basis() + "/realms/" + realm + "/protocol/openid-connect/token";
    }

    private static String kurz() {
        return UUID.randomUUID().toString().substring(0, 8);
    }

    private static String ausgabe(ExecResult r) {
        return r.getStdout() + r.getStderr();
    }

    private static List<String> texte(JsonNode liste) {
        List<String> alle = new ArrayList<>();
        liste.forEach(e -> alle.add(e.asText()));
        return alle;
    }

    /** Der Inhalt eines JWT, ohne die Unterschrift zu prüfen — die prüft das API, hier geht es um die Angaben. */
    private static JsonNode inhalt(String jwt) throws Exception {
        return JSON.readTree(Base64.getUrlDecoder().decode(jwt.split("\\.")[1]));
    }

    /**
     * Was das API aus diesem Token macht: derselbe Konverter wie in {@code SecurityConfig}. Leer heißt: weder eine
     * Rolle noch eine Kontoart — das Token ist dort kein Konto.
     */
    private static List<String> rechteAmApi(String jwt) throws Exception {
        Map<String, Object> angaben = JSON.convertValue(inhalt(jwt), new TypeReference<Map<String, Object>>() { });
        angaben.put("iat", Instant.ofEpochSecond(((Number) angaben.get("iat")).longValue()));
        angaben.put("exp", Instant.ofEpochSecond(((Number) angaben.get("exp")).longValue()));
        Jwt token = Jwt.withTokenValue(jwt).header("alg", "RS256").claims(c -> c.putAll(angaben)).build();
        return new KeycloakRealmRoleConverter().convert(token).getAuthorities().stream()
                .map(GrantedAuthority::getAuthority).toList();
    }

    private static String authUrl(String realm, String client, String adresse, String verifier,
            Map<String, String> zusatz) throws Exception {
        Map<String, String> q = new LinkedHashMap<>();
        q.put("client_id", client);
        q.put("redirect_uri", adresse);
        q.put("response_type", "code");
        q.put("scope", "openid profile email");
        q.put("state", "zustand");
        q.put("code_challenge", Base64.getUrlEncoder().withoutPadding().encodeToString(
                MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII))));
        q.put("code_challenge_method", "S256");
        q.putAll(zusatz);
        q.values().removeIf(String::isEmpty);
        return basis() + "/realms/" + realm + "/protocol/openid-connect/auth?" + formular(q);
    }

    /**
     * Authorization Code + PKCE wie Grafana ({@code scopes: openid profile email}, {@code use_pkce: true}):
     * Anmeldeseite holen, Formular abschicken, Weiterleitungen INNERHALB von Keycloak folgen. Verlangt Keycloak
     * die Einrichtung des zweiten Faktors, richtet die Hilfe ihn ein (TOTP mit dem Schlüssel der Seite). Zurück
     * kommt der Code aus der Weiterleitung an die Rückruf-Adresse.
     */
    private Anmeldung anmelden(String realm, String client, String adresse, String name, Map<String, String> zusatz)
            throws Exception {
        String verifier = UUID.randomUUID() + "-" + UUID.randomUUID();
        Map<String, String> cookies = new LinkedHashMap<>();
        HttpResponse<String> antwort = bisZurRueckleitung(realm, client, adresse, name, verifier, zusatz, cookies);
        boolean zweiterFaktor = false;
        if (antwort.statusCode() == 200 && antwort.body().contains("name=\"totpSecret\"")) {
            zweiterFaktor = true;
            String schluessel = attribut(markierung(antwort.body(), "input", "name=\"totpSecret\""), "value");
            String ziel = attribut(markierung(antwort.body(), "form", "id=\"kc-totp-settings-form\""), "action");
            antwort = innerhalbFolgen(mitCookies(HttpRequest.newBuilder(URI.create(ziel.replace("&amp;", "&")))
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .POST(HttpRequest.BodyPublishers.ofString(formular(Map.of("totp", totp(schluessel),
                            "totpSecret", schluessel, "userLabel", "Test")))), cookies), cookies);
        }
        String ort = antwort.headers().firstValue("Location").orElse("");
        assertThat(antwort.statusCode()).as(name + ": " + antwort.body()).isEqualTo(302);
        assertThat(ort).as(name).startsWith(adresse + "?").contains("code=").contains("state=zustand");
        return new Anmeldung(parameter(ort, "code"), verifier, cookies, zweiterFaktor);
    }

    /** Wie {@link #anmelden}, aber die Anfrage ist falsch: zurück kommt die Weiterleitung mit dem Fehler. */
    private String fehlerDerAnmeldung(String name, Map<String, String> zusatz) throws Exception {
        HttpResponse<String> r = get(authUrl("voltpilot", "grafana", ADRESSE, "v".repeat(50), zusatz));
        assertThat(r.statusCode()).as(name + " " + zusatz + ": " + r.body()).isEqualTo(302);
        String ort = r.headers().firstValue("Location").orElse("");
        assertThat(ort).startsWith(ADRESSE).doesNotContain("code=");
        return ort;
    }

    private HttpResponse<String> bisZurRueckleitung(String realm, String client, String adresse, String name,
            String verifier, Map<String, String> zusatz, Map<String, String> cookies) throws Exception {
        HttpResponse<String> seite = mitCookies(
                HttpRequest.newBuilder(URI.create(authUrl(realm, client, adresse, verifier, zusatz))).GET(), cookies);
        assertThat(seite.statusCode()).as(seite.body()).isEqualTo(200);
        String ziel = attribut(markierung(seite.body(), "form", "id=\"kc-form-login\""), "action");
        return innerhalbFolgen(mitCookies(HttpRequest.newBuilder(URI.create(ziel.replace("&amp;", "&")))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(formular(Map.of(
                        "username", name, "password", KONTO_PASSWORT, "credentialId", "")))), cookies), cookies);
    }

    private HttpResponse<String> innerhalbFolgen(HttpResponse<String> antwort, Map<String, String> cookies)
            throws Exception {
        for (int i = 0; i < 5 && antwort.statusCode() == 302; i++) {
            String ziel = antwort.headers().firstValue("Location").orElse("");
            if (!ziel.startsWith(basis())) {
                break;
            }
            antwort = mitCookies(HttpRequest.newBuilder(URI.create(ziel)).GET(), cookies);
        }
        return antwort;
    }

    /** Dieselbe Sitzung am Portal-Client: Keycloak leitet ohne neue Anmeldung weiter; zurück kommt das Zugriffstoken. */
    private String portalToken(String realm, Anmeldung sitzung) throws Exception {
        String verifier = UUID.randomUUID() + "-" + UUID.randomUUID();
        HttpResponse<String> r = mitCookies(HttpRequest.newBuilder(URI.create(
                authUrl(realm, "voltpilot-frontend", ORIGIN + "/", verifier, Map.of("scope", "openid")))).GET(),
                new LinkedHashMap<>(sitzung.cookies()));
        assertThat(r.statusCode()).as(r.body()).isEqualTo(302);
        String ort = r.headers().firstValue("Location").orElse("");
        assertThat(ort).startsWith(ORIGIN + "/").contains("code=");
        HttpResponse<String> token = tausch(realm, "voltpilot-frontend", null, ORIGIN + "/", parameter(ort, "code"), verifier);
        assertThat(token.statusCode()).as(token.body()).isEqualTo(200);
        return JSON.readTree(token.body()).path("access_token").asText();
    }

    private JsonNode tauschen(String realm, String client, String geheimnis, String adresse, Anmeldung anmeldung)
            throws Exception {
        HttpResponse<String> r = tausch(realm, client, geheimnis, adresse, anmeldung.code(), anmeldung.verifier());
        assertThat(r.statusCode()).as(r.body()).isEqualTo(200);
        return JSON.readTree(r.body());
    }

    /** Der Tausch Code gegen Token; {@code geheimnis} = null lässt das Feld ganz weg. */
    private HttpResponse<String> tausch(String realm, String client, String geheimnis, String adresse, String code,
            String verifier) throws Exception {
        Map<String, String> felder = new LinkedHashMap<>();
        felder.put("grant_type", "authorization_code");
        felder.put("client_id", client);
        if (geheimnis != null) {
            felder.put("client_secret", geheimnis);
        }
        felder.put("code", code);
        felder.put("redirect_uri", adresse);
        felder.put("code_verifier", verifier);
        return post(tokenUrl(realm), felder);
    }

    /** TOTP wie Keycloak es vorgibt (HmacSHA1, 6 Stellen, 30 Sekunden); der Schlüssel der Seite sind seine Bytes. */
    private static String totp(String schluessel) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA1");
        mac.init(new SecretKeySpec(schluessel.getBytes(StandardCharsets.UTF_8), "HmacSHA1"));
        byte[] h = mac.doFinal(ByteBuffer.allocate(8).putLong(System.currentTimeMillis() / 30_000).array());
        int o = h[h.length - 1] & 0x0f;
        int zahl = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
        return String.format("%06d", zahl % 1_000_000);
    }

    /** Das erste Element {@code <name …>}, dessen Attribute {@code merkmal} enthalten. */
    private static String markierung(String seite, String name, String merkmal) {
        Matcher m = Pattern.compile("<" + name + "\\b[^>]*>").matcher(seite);
        while (m.find()) {
            if (m.group().contains(merkmal)) {
                return m.group();
            }
        }
        throw new AssertionError("kein <" + name + "> mit " + merkmal + " in: " + seite);
    }

    private static String attribut(String element, String name) {
        Matcher m = Pattern.compile("\\b" + name + "=\"([^\"]*)\"").matcher(element);
        assertThat(m.find()).as(name + " in " + element).isTrue();
        return m.group(1);
    }

    private static String parameter(String url, String name) {
        for (String paar : URI.create(url).getRawQuery().split("&")) {
            String[] teile = paar.split("=", 2);
            if (teile[0].equals(name)) {
                return URLDecoder.decode(teile.length > 1 ? teile[1] : "", StandardCharsets.UTF_8);
            }
        }
        throw new AssertionError(name + " fehlt in " + url);
    }

    private HttpResponse<String> mitCookies(HttpRequest.Builder anfrage, Map<String, String> cookies)
            throws Exception {
        if (!cookies.isEmpty()) {
            anfrage.header("Cookie", cookies.entrySet().stream()
                    .map(e -> e.getKey() + "=" + e.getValue()).collect(Collectors.joining("; ")));
        }
        HttpResponse<String> r = http.send(anfrage.build(), HttpResponse.BodyHandlers.ofString());
        r.headers().allValues("Set-Cookie").forEach(c -> {
            String[] paar = c.split(";", 2)[0].split("=", 2);
            cookies.put(paar[0].trim(), paar.length > 1 ? paar[1] : "");
        });
        return r;
    }

    /**
     * Ein Realm wie der Live-Realm nach der Anmelde-Härtung und vor diesem Paket: der Import, nur ohne den Client
     * {@code grafana} und ohne dessen Scope-Zuordnung. Die Platzhalter ersetzt die Hilfe selbst — Keycloak tut das
     * nur beim Datei-Import, nicht über die Admin-API.
     */
    private String realmWieDerImportOhneDenClient() throws Exception {
        String name = "bestand-" + kurz();
        String text = Files.readString(REALM, StandardCharsets.UTF_8)
                .replace("${VP_PUBLIC_ORIGIN}", ORIGIN)
                .replace("${VP_PORTAL_ADMIN_PASSWORD}", KONTO_PASSWORT)
                .replaceAll("\\$\\{VP_[A-Z_]+(:[^}]*)?}", "geheimnis-nur-fuer-diesen-test");
        ObjectNode realm = (ObjectNode) JSON.readTree(text);
        realm.put("realm", name);
        ArrayNode clients = (ArrayNode) realm.path("clients");
        int vorher = clients.size();
        for (int i = clients.size() - 1; i >= 0; i--) {
            if ("grafana".equals(clients.get(i).path("clientId").asText())) {
                clients.remove(i);
            }
        }
        assertThat(clients).as("der Client grafana stand im Import").hasSize(vorher - 1);
        assertThat(realm.remove("scopeMappings")).as("die Scope-Zuordnung stand im Import").isNotNull();
        assertThat(adminPost("", "", realm.toString())).isEqualTo(201);
        assertThat(adminGet(name, "/clients?clientId=grafana")).isEmpty();
        assertThat(adminGet(name, "").path("browserFlow").asText()).isEqualTo("voltpilot-browser");
        return name;
    }

    /**
     * Die Client-Definition, wie Keycloak sie führt, ohne Ids und ohne das Geheimnis: Felder, Attribute, Mapper,
     * Client-Scopes und Scope-Zuordnung. Damit lassen sich der importierte und der vom Skript angelegte Client
     * Feld für Feld vergleichen.
     */
    private Map<String, Object> clientBild(String realm) throws Exception {
        String id = clientId(realm, "grafana");
        ObjectNode client = (ObjectNode) adminGet(realm, "/clients/" + id);
        client.remove(List.of("id", "secret", "access"));
        ObjectNode attribute = (ObjectNode) client.path("attributes");
        // Den Zeitpunkt des Geheimnisses führt Keycloak je Client. Die zwei Vorgaben zum Backchannel-Logout setzt
        // die Admin-API beim Anlegen, der Import nicht; ohne backchannel.logout.url sind sie wirkungslos.
        assertThat(attribute.has("backchannel.logout.url")).isFalse();
        attribute.remove("client.secret.creation.time");
        if (attribute.path("backchannel.logout.session.required").asText("true").equals("true")) {
            attribute.remove("backchannel.logout.session.required");
        }
        if (attribute.path("backchannel.logout.revoke.offline.tokens").asText("false").equals("false")) {
            attribute.remove("backchannel.logout.revoke.offline.tokens");
        }
        List<String> mapper = new ArrayList<>();
        client.path("protocolMappers").forEach(m -> {
            ((ObjectNode) m).remove("id");
            mapper.add(sortiert(m));
        });
        client.remove("protocolMappers");
        Map<String, Object> bild = new TreeMap<>();
        bild.put("mapper", mapper.stream().sorted().toList());
        bild.put("defaultClientScopes", texte(client.remove("defaultClientScopes")).stream().sorted().toList());
        bild.put("optionalClientScopes", texte(client.remove("optionalClientScopes")).stream().sorted().toList());
        bild.put("client", sortiert(client));
        JsonNode zuordnung = adminGet(realm, "/clients/" + id + "/scope-mappings");
        bild.put("scopeRealmRollen", zuordnung.path("realmMappings").findValuesAsText("name").stream().sorted().toList());
        bild.put("scopeClientRollen", zuordnung.has("clientMappings"));
        return bild;
    }

    /** JSON mit sortierten Schlüsseln, damit die Reihenfolge der Antwort keinen Unterschied vortäuscht. */
    private static String sortiert(JsonNode knoten) throws RuntimeException {
        try {
            return JSON.writer().with(com.fasterxml.jackson.databind.SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)
                    .writeValueAsString(JSON.treeToValue(knoten, Object.class));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private void kontoAnlegen(String realm, String name, boolean plattformAdmin) throws Exception {
        Map<String, Object> konto = new LinkedHashMap<>();
        konto.put("username", name);
        konto.put("email", name + "@beispiel.invalid");
        konto.put("firstName", "Test");
        konto.put("lastName", "Konto");
        konto.put("enabled", true);
        konto.put("emailVerified", true);
        konto.put("credentials", new Object[] {Map.of("type", "password", "value", KONTO_PASSWORT, "temporary", false)});
        if (!plattformAdmin && adminGet(realm, "").path("browserFlow").asText().startsWith("voltpilot-")) {
            // Ein Kundenkonto trägt seinen Kundenbereich als Attribut (das User-Profil des Imports lässt es zu).
            konto.put("attributes", Map.of("tenant_id", new String[] {UUID.randomUUID().toString()}));
        }
        assertThat(adminPost(realm, "/users", JSON.writeValueAsString(konto))).as(name).isEqualTo(201);
        if (plattformAdmin) {
            String id = adminGet(realm, "/users?exact=true&username=" + name).get(0).path("id").asText();
            assertThat(adminPost(realm, "/users/" + id + "/role-mappings/realm",
                    "[" + adminGet(realm, "/roles/platform-admin") + "]")).isEqualTo(204);
        }
    }

    private String clientId(String realm, String clientId) throws Exception {
        JsonNode liste = adminGet(realm, "/clients?clientId=" + clientId);
        assertThat(liste).as("Client " + clientId + " im Realm " + realm).hasSize(1);
        return liste.get(0).path("id").asText();
    }

    /** Das Client-Geheimnis, wie die Administration es zeigt (Clients › grafana › Credentials). */
    private String geheimnis(String realm) throws Exception {
        return adminGet(realm, "/clients/" + clientId(realm, "grafana") + "/client-secret").path("value").asText();
    }

    private String scopeId(String realm, String name) throws Exception {
        for (JsonNode s : adminGet(realm, "/client-scopes")) {
            if (name.equals(s.path("name").asText())) {
                return s.path("id").asText();
            }
        }
        throw new AssertionError("kein Client Scope " + name);
    }

    private String ablaufId(String realm, String alias) throws Exception {
        for (JsonNode f : adminGet(realm, "/authentication/flows")) {
            if (alias.equals(f.path("alias").asText())) {
                return f.path("id").asText();
            }
        }
        throw new AssertionError("kein Ablauf " + alias);
    }

    /**
     * Der Befehl unter „Zurück“, so wie er im Blatt steht. Dort umschließt ihn
     * {@code kubectl -n <namespace> exec deploy/keycloak -- bash -c '…'}; zurück kommt der Teil, den die Bash im Pod
     * ausführt.
     */
    private static String rueckwegDesBlatts() throws Exception {
        Pattern form = Pattern.compile("^\\s*kubectl -n <namespace> exec deploy/keycloak -- bash -c '(.* -s enabled=false)'\\s*$");
        List<String> befehle = new ArrayList<>();
        for (String zeile : Files.readAllLines(BLATT, StandardCharsets.UTF_8)) {
            Matcher m = form.matcher(zeile);
            if (m.matches()) {
                befehle.add(m.group(1));
            }
        }
        assertThat(befehle).as("Rückweg im Blatt: ein Befehl, der den Client abschaltet").hasSize(1);
        assertThat(befehle.get(0)).contains("-q clientId=grafana").contains("-r voltpilot");
        return befehle.get(0);
    }

    /**
     * Fährt das Skript, wie das Blatt es tut: über die Standardeingabe ({@code bash -s <modus> < skript}), nach
     * der Anmeldung von kcadm.
     */
    private ExecResult skript(String realm, String modus) throws Exception {
        return angemeldet("REALM=" + realm + " bash -s " + modus + " < /opt/keycloak/live-realm-grafana.sh");
    }

    /** Meldet kcadm im Container an (wie Schritt „Anmelden“ des Blatts) und fährt danach den Befehl. */
    private ExecResult angemeldet(String befehl) throws Exception {
        return KEYCLOAK.execInContainer("bash", "-c", "export HOME=/tmp && /opt/keycloak/bin/kcadm.sh config "
                + "credentials --server http://localhost:8080 --realm master --user " + KC_ADMIN + " --password "
                + KC_ADMIN_PASSWORT + " > /dev/null 2>&1 && " + befehl);
    }

    private String adminToken() throws Exception {
        HttpResponse<String> r = post(tokenUrl("master"), Map.of("grant_type", "password", "client_id", "admin-cli",
                "username", KC_ADMIN, "password", KC_ADMIN_PASSWORT));
        assertThat(r.statusCode()).as(r.body()).isEqualTo(200);
        return JSON.readTree(r.body()).path("access_token").asText();
    }

    /** Admin-REST: {@code realm} leer = die Realm-Liste selbst ({@code POST /admin/realms}). */
    private HttpRequest.Builder adminAnfrage(String realm, String pfad) throws Exception {
        String wurzel = basis() + "/admin/realms" + (realm.isEmpty() ? "" : "/" + realm);
        return HttpRequest.newBuilder(URI.create(wurzel + pfad)).header("Authorization", "Bearer " + adminToken());
    }

    private JsonNode adminGet(String realm, String pfad) throws Exception {
        HttpResponse<String> r = http.send(adminAnfrage(realm, pfad).GET().build(), HttpResponse.BodyHandlers.ofString());
        assertThat(r.statusCode()).as(pfad + " " + r.body()).isEqualTo(200);
        return JSON.readTree(r.body());
    }

    private int adminPost(String realm, String pfad, String body) throws Exception {
        return http.send(adminAnfrage(realm, pfad).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString()).statusCode();
    }

    private int adminPut(String realm, String pfad, String body) throws Exception {
        return http.send(adminAnfrage(realm, pfad).header("Content-Type", "application/json")
                .PUT(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString()).statusCode();
    }

    private int adminDelete(String realm, String pfad, String body) throws Exception {
        return http.send(adminAnfrage(realm, pfad).header("Content-Type", "application/json")
                .method("DELETE", HttpRequest.BodyPublishers.ofString(body)).build(),
                HttpResponse.BodyHandlers.ofString()).statusCode();
    }

    private HttpResponse<String> get(String url) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create(url)).GET().build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> post(String url, Map<String, String> felder) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create(url))
                        .header("Content-Type", "application/x-www-form-urlencoded")
                        .POST(HttpRequest.BodyPublishers.ofString(formular(felder))).build(),
                HttpResponse.BodyHandlers.ofString());
    }

    private static String formular(Map<String, String> felder) {
        return felder.entrySet().stream()
                .map(e -> URLEncoder.encode(e.getKey(), StandardCharsets.UTF_8) + "="
                        + URLEncoder.encode(e.getValue(), StandardCharsets.UTF_8))
                .collect(Collectors.joining("&"));
    }
}
