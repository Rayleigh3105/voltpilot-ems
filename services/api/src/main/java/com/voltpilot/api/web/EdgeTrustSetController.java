package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.EdgeTrustSetRepository;
import com.voltpilot.api.web.dto.EdgeTrustSetDto;
import com.voltpilot.api.web.dto.SaveEdgeTrustSetRequest;
import jakarta.validation.Valid;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die EINE Autorität für das aktuelle root-signierte Trust-Set - damit eine
 * NEUE Box beim Einrichten in die Vertrauenskette kommt, ohne dass jemand zwei
 * Dateien von Hand kopiert (Captain-Order 04.08.2026, nachdem der erste
 * Live-Rollout genau daran scheiterte: „Das Vertrauens-Set oder seine Signatur
 * fehlt.").
 *
 * <h2>Die Vertrauensgrenze - das Wichtigste an dieser Klasse</h2>
 *
 * <ul>
 *   <li><b>Die Installation ist ein sanktionierter TOFU-Moment.</b> Eine Box,
 *       die gerade eingerichtet wird, vertraut ihrem Installationskanal per
 *       Definition - sie hat sich soeben ihre IMAGES darüber geholt. Das
 *       AKTUELLE root-signierte Trust-Set über denselben Kanal auszuliefern
 *       fügt KEIN neues Vertrauen hinzu: die Box prüft die ROOT-Signatur
 *       weiterhin selbst gegen ihre EINGEBACKENE Wurzel, der Kanal
 *       transportiert nur öffentliches Material.</li>
 *   <li><b>Der spätere Austausch bleibt out-of-band.</b> Eine LAUFENDE Box
 *       holt sich NIE ein Trust-Set über das Netz - das wäre der
 *       Widerrufs-Anker über genau den Kanal, den er widerruft (die offene
 *       Rotations-Entscheidung aus Stufe 4 bleibt offen). Es gibt deshalb
 *       keinen Downlink und keinen Geräte-Abruf; der Core kennt diese Route
 *       nicht. {@code update.sh} DARF ein fehlendes Set erkennen und den Weg
 *       nennen - es lädt keines herunter.</li>
 * </ul>
 *
 * <h2>Warum die api die Signatur NICHT prüft</h2>
 *
 * Dieselbe Doktrin wie beim Release-Register ({@link AdminEdgeReleaseController}):
 * der einzige Verifizierer, auf den es ankommt, ist das GERÄT mit seiner
 * eingebackenen Wurzel. Eine zweite Vertrauensentscheidung in der Cloud
 * bräuchte einen zweiten Trust-Store, der auseinanderlaufen kann, und eine
 * Ablage, die ein Dokument „segnet", erzeugt Sicherheitsgefühl an einer Stelle,
 * die nichts garantieren kann. Geprüft wird deshalb ausschließlich die FORM
 * (siehe {@link #inspect}) - ein formal kaputtes Set würde die Box nur mit
 * einem unnötigen Umweg erreichen.
 *
 * <h2>Drei Routen, drei Rechte - und warum sie in EINER Klasse liegen</h2>
 *
 * Die Trust-Set-Logik soll genau EINMAL existieren; die Rechte hängen deshalb
 * pro Methode, nicht an der Klasse (das Muster von
 * {@link AdminEdgeReleaseController}, dort mit derselben Begründung: eine neu
 * hinzugefügte Methode soll nicht versehentlich in den Geltungsbereich einer
 * Rolle rutschen). Eine künftige Methode OHNE Annotation fällt auf die
 * Filterkette zurück - und die verlangt für {@code /api/v1/admin/**} mindestens
 * eine der beiden Rollen bzw. für alles andere Authentifizierung; nur der EINE
 * exakte Pfad {@code /api/v1/edge/trust-set} ist dort freigegeben, kein
 * Platzhalter.
 */
@RestController
public class EdgeTrustSetController {

    /**
     * Hochladen darf der Plattform-Admin UND das eng geschnittene
     * Veröffentlichungs-Konto: das Trust-Set entsteht in derselben Zeremonie
     * wie ein Release-Schlüssel, und die Automatik soll es aktuell halten
     * können, ohne dass ein Admin-Token in CI liegt. Mehr erreicht diese Rolle
     * dadurch nicht - sie kann weiterhin keinen Rollout starten und kein Gerät
     * adressieren (nachgewiesen in {@code AdminApiTest}).
     */
    private static final String PUBLISH = "hasAnyRole('platform-admin','edge-release-publisher')";

    /** Die Form einer {@code key_id} - wörtlich {@code otaverify.keyIDRe}. */
    private static final Pattern KEY_ID = Pattern.compile("^[a-z0-9][a-z0-9._-]{0,63}$");

    /** Der EINZIGE akzeptierte Algorithmus - ein anderer ist eine Ablehnung, nie ein Fallback. */
    private static final String ALG = "ed25519";

    /** Die Domain, für die eine Trust-Set-Signatur ausgestellt sein MUSS. */
    private static final String DOMAIN = "trust-set";

    /** Ed25519: 32-Byte-Öffentlichschlüssel, 64-Byte-Signaturen. */
    private static final int PUBLIC_KEY_BYTES = 32;
    private static final int SIGNATURE_BYTES = 64;

    /** Grober Riegel gegen einen missbrauchten Upload - ein reales Set ist wenige hundert Bytes. */
    private static final int MAX_DOCUMENT_BYTES = 64 * 1024;

    private final EdgeTrustSetRepository trustSets;
    private final ObjectMapper json;

    public EdgeTrustSetController(EdgeTrustSetRepository trustSets, ObjectMapper json) {
        this.trustSets = trustSets;
        this.json = json;
    }

    /**
     * Der ÖFFENTLICHE Ausliefer-Endpunkt, Teil 1: {@code trust-set.json}.
     *
     * <p><b>Bewusst unauthentifiziert</b> - eine Box, die gerade eingerichtet
     * wird, hat noch kein Token (dieselbe Lage wie beim Enrollment, das aus
     * demselben Grund offen ist). Es wird ausschließlich ÖFFENTLICHES
     * Schlüsselmaterial herausgegeben: die {@code .pub}-Teile der
     * Release-Schlüssel und eine Signatur darüber. Wer sie abruft, erfährt
     * nichts, was nicht ohnehin im Git nachlesbar ist
     * ({@code edge-app/ota/trust-set.json}) - genau dadurch ist überprüfbar,
     * welchen Schlüsseln die Flotte traut.
     *
     * <p>Solange nichts hochgeladen ist: <b>404</b>. Der Installer degradiert
     * darauf mit einer lauten Warnung und dem Handpfad, statt die Installation
     * zu verweigern - eine Box ohne Trust-Set funktioniert vollständig, sie
     * kann nur (noch) kein Release anwenden.
     */
    @GetMapping("/api/v1/edge/trust-set/trust-set.json")
    public ResponseEntity<byte[]> publicTrustSetFile() {
        return raw(trustSets.current().map(EdgeTrustSetDto::trustSet).orElse(null));
    }

    /** Der öffentliche Ausliefer-Endpunkt, Teil 2: {@code trust-set.json.sig}. */
    @GetMapping("/api/v1/edge/trust-set/trust-set.json.sig")
    public ResponseEntity<byte[]> publicTrustSetSignature() {
        return raw(trustSets.current().map(EdgeTrustSetDto::signature).orElse(null));
    }

    /**
     * Die ROHEN Bytes ausliefern - der ganze Punkt der beiden Routen oben.
     *
     * <p><b>Zwei Entscheidungen, beide tragend:</b>
     *
     * <ul>
     *   <li><b>Zwei Datei-Routen statt eines JSON-Umschlags.</b> In einem
     *       Umschlag stünde das Dokument als JSON-ZEICHENKETTE, also escaped -
     *       und der Abnehmer ist ein Shell-Installer, der es dann von Hand
     *       dekodieren müsste. Genau dort entstehen die stillen
     *       Byte-Abweichungen, an denen die Signatur scheitert. So schreibt
     *       der Installer schlicht, was er lädt ({@code curl -o}), und die
     *       Routen heißen wie die Zieldateien.</li>
     *   <li><b>{@code byte[]}, nicht {@code String}.</b> Ein {@code String}
     *       -Rumpf mit {@code produces=application/json} kann vom
     *       Jackson-Konverter als JSON-Zeichenkette SERIALISIERT werden
     *       (Anführungszeichen + Escapes drumherum) - dieselbe Klasse Fehler,
     *       gegen die {@code text} statt {@code jsonb} in der Migration
     *       schützt. {@code byte[]} geht über den ByteArray-Konverter und
     *       kommt unverändert heraus; {@code AdminApiTest} liest die Bytes
     *       zurück und vergleicht sie Zeichen für Zeichen.</li>
     * </ul>
     */
    private static ResponseEntity<byte[]> raw(String document) {
        if (document == null) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok()
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                .body(document.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    /** Die Betreiber-Sicht: was gilt gerade, wer hat es wann hochgeladen. */
    @GetMapping("/api/v1/admin/edge-trust-set")
    @PreAuthorize("hasRole('platform-admin')")
    public ResponseEntity<EdgeTrustSetDto> current() {
        return trustSets.current().map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /**
     * Das aktuelle Trust-Set setzen bzw. ersetzen (eine Rotation ist genau
     * das: ein neues, frisch root-signiertes Set).
     *
     * <p><b>{@code PUT}, weil es einen SINGLETON gibt</b> - „das aktuelle Set"
     * ist eine Ressource, kein Verlauf. Wiederholtes Hochladen derselben Bytes
     * ist damit idempotent (ein erneut gestarteter Automatik-Lauf darf nicht
     * rot werden), und ein Verlauf entsteht dort, wo er hingehört: als
     * reviewbarer Commit in {@code edge-app/ota/}.
     */
    @PutMapping("/api/v1/admin/edge-trust-set")
    @PreAuthorize(PUBLISH)
    public EdgeTrustSetDto save(@Valid @RequestBody SaveEdgeTrustSetRequest req,
            @AuthenticationPrincipal Jwt caller) {
        Inspected in = inspect(req.trustSet(), req.signature());
        return trustSets.replace(req.trustSet(), req.signature(), String.join(",", in.keyIds()),
                in.signingKeyId(), in.generatedAt(),
                caller == null ? null : caller.getSubject());
    }

    /** Was sich AUS den beiden Dokumenten ablesen lässt. */
    private record Inspected(List<String> keyIds, String signingKeyId, String generatedAt) {
    }

    /**
     * Die FORM prüfen - nicht die Signatur (siehe Klassendoku).
     *
     * <p>Vier Dinge, und jedes hat einen Grund:
     *
     * <ol>
     *   <li><b>Beide Dokumente parsen</b> und tragen die Felder, die der
     *       Verifizierer auf dem Gerät braucht. Ein Set, das dort nicht
     *       einlesbar ist, fiele sonst erst auf der Box auf - und dort ist die
     *       Rückmeldung teuer.</li>
     *   <li><b>Der Algorithmus ist fest verdrahtet.</b> Ein anderer Wert im
     *       {@code alg}-Feld ist eine Ablehnung, kein Fallback (die klassische
     *       JWT-{@code alg}-Lücke).</li>
     *   <li><b>Die Domain muss {@code trust-set} sein.</b> Ohne diese Prüfung
     *       ginge eine RELEASE-Signatur als Trust-Set-Signatur durch - genau
     *       die Verwechslung, gegen die die Domain-Trennung gebaut ist.</li>
     *   <li><b>Der signierende (WURZEL-)Schlüssel darf NICHT im Set stehen.</b>
     *       Das ist der Invariant, den schon {@code vp-ota trust-set}
     *       erzwingt: stünde die Wurzel im Set, könnte ein Trust-Set die
     *       Wurzel ERWEITERN - genau die Vertrauensübernahme, gegen die die
     *       Trennung kalt/heiß gebaut ist.</li>
     * </ol>
     *
     * <p><b>Ausdrücklich NICHT geprüft: dass die {@code key_id}s der beiden
     * Dateien übereinstimmen.</b> Beim RELEASE ist das richtig (Manifest und
     * Signatur nennen denselben Release-Schlüssel), hier wäre es genau falsch
     * herum: die Signatur nennt den WURZEL-Schlüssel, das Set die
     * RELEASE-Schlüssel. Sie müssen sich UNTERSCHEIDEN - siehe Punkt 4.
     */
    private Inspected inspect(String trustSet, String signature) {
        if (trustSet.length() > MAX_DOCUMENT_BYTES || signature.length() > MAX_DOCUMENT_BYTES) {
            throw bad("Trust-Set bzw. Signatur sind unplausibel gross.");
        }
        JsonNode set = parse(trustSet, "Das Trust-Set");
        JsonNode sig = parse(signature, "Die Signaturdatei");

        requireMajorOne(set, "Das Trust-Set");
        requireMajorOne(sig, "Die Signaturdatei");

        // --- die Signatur ----------------------------------------------------
        if (!ALG.equals(text(sig, "alg"))) {
            throw bad("Die Signatur nennt den Algorithmus '" + text(sig, "alg")
                    + "' - akzeptiert wird ausschliesslich " + ALG + ".");
        }
        if (!DOMAIN.equals(text(sig, "domain"))) {
            throw bad("Die Signaturdatei ist fuer '" + text(sig, "domain")
                    + "' ausgestellt, nicht fuer ein Trust-Set.");
        }
        String signingKeyId = text(sig, "key_id");
        if (signingKeyId == null || !KEY_ID.matcher(signingKeyId).matches()) {
            throw bad("Die Signaturdatei traegt keine gueltige key_id.");
        }
        requireBase64(text(sig, "signature"), SIGNATURE_BYTES, "Die Signatur");

        // --- das Set ---------------------------------------------------------
        JsonNode keys = set.get("keys");
        if (keys == null || !keys.isArray() || keys.isEmpty()) {
            // Ein LEERES Set waere kein Widerruf, sondern ein Set, dem kein
            // einziges Release mehr entspricht - die Box lehnte danach jedes
            // Release ab. Ein Widerruf ist ein Set OHNE den betroffenen
            // Schluessel, nicht eines ohne Schluessel.
            throw bad("Das Trust-Set nennt keinen einzigen Schluessel.");
        }
        List<String> keyIds = new ArrayList<>();
        for (JsonNode k : keys) {
            String id = text(k, "key_id");
            if (id == null || !KEY_ID.matcher(id).matches()) {
                throw bad("Das Trust-Set enthaelt einen Schluessel ohne gueltige key_id.");
            }
            if (keyIds.contains(id)) {
                throw bad("Die key_id '" + id + "' kommt im Trust-Set doppelt vor.");
            }
            if (!ALG.equals(text(k, "alg"))) {
                throw bad("Schluessel '" + id + "' nennt den Algorithmus '" + text(k, "alg")
                        + "' - akzeptiert wird ausschliesslich " + ALG + ".");
            }
            requireBase64(text(k, "public_key"), PUBLIC_KEY_BYTES,
                    "Der oeffentliche Schluessel '" + id + "'");
            keyIds.add(id);
        }
        if (keyIds.contains(signingKeyId)) {
            throw bad("Der signierende Schluessel '" + signingKeyId + "' steht selbst im "
                    + "Trust-Set - eine Wurzel gehoert nach rootkeys.json, nie ins Set, sonst "
                    + "koennte ein Trust-Set die Wurzel erweitern.");
        }

        keyIds.sort(String::compareTo);
        return new Inspected(keyIds, signingKeyId, text(set, "generated_at"));
    }

    /**
     * Nur die MAJOR-Stelle vergleichen - wörtlich {@code otaverify.checkMajor}:
     * eine additive Erweiterung (1.1) muss ein Gerät der Version 1.0 nicht
     * aussperren.
     */
    private static void requireMajorOne(JsonNode doc, String what) {
        String v = text(doc, "schema_version");
        if (v == null || !(v.equals("1") || v.startsWith("1."))) {
            throw bad(what + " traegt keine unterstuetzte schema_version (erwartet 1.x).");
        }
    }

    private static void requireBase64(String value, int expectedBytes, String what) {
        if (value == null) {
            throw bad(what + " fehlt.");
        }
        byte[] raw;
        try {
            raw = Base64.getDecoder().decode(value);
        } catch (IllegalArgumentException e) {
            throw bad(what + " ist kein gueltiges Base64.");
        }
        if (raw.length != expectedBytes) {
            throw bad(what + " hat " + raw.length + " statt " + expectedBytes + " Bytes.");
        }
    }

    private JsonNode parse(String raw, String what) {
        try {
            JsonNode node = json.readTree(raw);
            if (node == null || !node.isObject()) {
                throw bad(what + " ist kein JSON-Objekt.");
            }
            return node;
        } catch (ResponseStatusException e) {
            throw e;
        } catch (Exception e) {
            throw bad(what + " ist kein gueltiges JSON.");
        }
    }

    private static String text(JsonNode n, String field) {
        JsonNode v = n == null ? null : n.get(field);
        return v == null || !v.isTextual() ? null : v.asText();
    }

    private static ResponseStatusException bad(String message) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
    }

    /**
     * Jede Ablehnung erreicht die Oberfläche als deutscher {@code {message}}
     * -Körper statt als nackter Status (das Muster von
     * {@link AdminEdgeReleaseController}).
     */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> handle(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
