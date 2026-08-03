package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.EdgeReleaseRepository;
import com.voltpilot.api.web.dto.CreateEdgeReleaseRequest;
import com.voltpilot.api.web.dto.EdgeReleaseDto;
import jakarta.validation.Valid;
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
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Das Release-Register der Edge-Flotte: {@code GET/POST
 * /api/v1/admin/edge-releases} (OTA Stufe 0, Captain-Entscheid D5).
 *
 * <p><b>Warum es überhaupt existiert:</b> vor diesem Register hatte die Cloud
 * keinen Soll-Stand. Der Flotten-Puls verglich den gemeldeten Stand gegen das
 * FLOTTEN-MAXIMUM, also las sich „alle gleich alt" als „alle aktuell", und die
 * Ordnung selbst verglich 12-stellige Hex-SHAs als Zahlenblöcke - auf SHAs ist
 * das eine Zufallsordnung. Mit dem Register ist „veraltet" wohldefiniert:
 * {@code release_seq} ist eine monotone Ganzzahl und der EINZIGE Vergleich.
 *
 * <p><b>Sicherheits-Disziplin, übernommen statt neu erfunden:</b> die Route
 * liegt unter {@code /api/v1/admin/**} und die Klasse trägt
 * {@code @PreAuthorize("hasRole('platform-admin')")} wie
 * {@link AdminController} und {@link AdminFleetController} - ein Kunden-Token
 * bekommt 403, ein anonymer Aufruf 401. Die RLS-Umgehung steckt ausschließlich
 * in {@link EdgeReleaseRepository} an der dedizierten BYPASSRLS-Rolle
 * {@code voltpilot_admin}; das Register ist mandantenfrei, die Rolle liefert
 * hier die Schreibberechtigung, die die App-Rolle bewusst nicht hat.
 *
 * <p><b>Seit OTA Stufe 1</b> darf ein Eintrag zusätzlich das SIGNIERTE Release
 * tragen (Manifest-Bytes + abgetrennte Signatur, Migration V20260804000000).
 * Die api prüft die Signatur bewusst NICHT - siehe {@code readSigned}. Und es
 * gibt weiterhin KEINEN Schreibpfad zu irgendeinem Gerät: Stufe 0 heißt
 * „Sehen", Stufe 1 „Vertrauen"; verteilt wird erst in Stufe 2.
 */
@RestController
@RequestMapping("/api/v1/admin/edge-releases")
@PreAuthorize("hasRole('platform-admin')")
public class AdminEdgeReleaseController {

    /**
     * Das Versionsschema aus D5: {@code edge-JJJJ.MM.N}. Bewusst eng - der
     * Sinn des Registers ist eine wohldefinierte Ordnung, und ein hier
     * eingetragener nackter Commit-SHA wäre genau der unvergleichbare Wert,
     * den es ablöst. (Ein GERÄT darf durchaus eine SHA melden; die Oberfläche
     * zeigt sie dann ehrlich als „nicht registriert".)
     */
    private static final Pattern VERSION = Pattern.compile("^edge-\\d{4}\\.\\d{2}\\.\\d+$");

    private final EdgeReleaseRepository releases;
    private final ObjectMapper json;

    public AdminEdgeReleaseController(EdgeReleaseRepository releases, ObjectMapper json) {
        this.releases = releases;
        this.json = json;
    }

    /** Das Register, NEUESTE zuerst - der erste Eintrag ist der Soll-Stand. */
    @GetMapping
    public List<EdgeReleaseDto> list() {
        return releases.findAll();
    }

    @PostMapping
    public ResponseEntity<EdgeReleaseDto> create(@Valid @RequestBody CreateEdgeReleaseRequest req,
            @AuthenticationPrincipal Jwt caller) {
        Signed signed = readSigned(req);
        String version = signed == null ? req.version().trim() : signed.release();
        if (!VERSION.matcher(version).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Die Version muss dem Schema edge-JJJJ.MM.N folgen (z. B. edge-2026.08.0).");
        }
        if (releases.findByVersion(version).isPresent()) {
            // Bewusst 409 statt einer idempotenten 200: ein Release entsteht
            // EINMAL und von Hand. Ein stilles „ist schon da" würde einen
            // abweichenden Commit im Body verschlucken - und das Register ist
            // die Papier-Spur, die genau das beantworten soll.
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Release '" + version + "' ist bereits registriert.");
        }
        Long max = releases.maxSeq();
        long seq;
        // Bewusst NICHT als Ternaer mit gemischtem Long/long: der bedingte
        // Operator vereinheitlicht dann auf den primitiven Typ und entpackt
        // das Long - ein fehlendes releaseSeq waere eine NullPointerException
        // statt „setz die Sequenz fort".
        Long wanted = req.releaseSeq();
        if (signed != null) {
            wanted = signed.releaseSeq();
        }
        if (wanted == null) {
            seq = max == null ? 1L : max + 1L;
        } else {
            seq = wanted;
            if (max != null && seq <= max) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "release_seq muss groesser als die hoechste vergebene Nummer (" + max
                                + ") sein - die Reihenfolge ist monoton.");
            }
        }
        String commit = signed == null ? blankToNull(req.targetCommit()) : signed.targetCommit();
        EdgeReleaseDto created = releases.insert(seq, version, commit, blankToNull(req.notes()),
                caller == null ? null : caller.getSubject(),
                signed == null ? null : req.manifest(),
                signed == null ? null : req.signature(),
                signed == null ? null : signed.signingKeyId());
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    /** Die Angaben, die AUS dem signierten Manifest kommen. */
    private record Signed(String release, long releaseSeq, String targetCommit,
            String signingKeyId) {
    }

    /**
     * Liest ein mitgeschicktes signiertes Release - oder {@code null}, wenn der
     * Rumpf keines trägt (der Stufe-0-Handpfad bleibt unverändert gültig).
     *
     * <p><b>Was hier NICHT passiert: die Signatur wird nicht geprüft.</b> Das
     * ist Absicht. Der einzige Verifizierer, auf den es ankommt, ist das GERÄT -
     * es trägt die eingebackene Wurzel, und nur dort hat eine Prüfung eine
     * Wirkung. Eine zweite Vertrauensentscheidung in der Cloud bräuchte einen
     * zweiten Trust-Store, der auseinanderlaufen kann, und ein Register, das ein
     * Manifest „segnet", erzeugt Sicherheitsgefühl an einer Stelle, die nichts
     * garantieren kann.
     *
     * <p>Geprüft wird nur WIDERSPRUCHSFREIHEIT: das Register darf nie etwas
     * anderes behaupten als das, was unterschrieben wurde. Deshalb GEWINNEN die
     * Manifest-Angaben, und ein davon abweichender Wert im Rumpf ist ein Fehler
     * statt einer stillen Abweichung.
     */
    private Signed readSigned(CreateEdgeReleaseRequest req) {
        String manifest = req.manifest();
        String signature = req.signature();
        if (blankToNull(manifest) == null && blankToNull(signature) == null) {
            return null;
        }
        if (blankToNull(manifest) == null || blankToNull(signature) == null) {
            // Eine Signatur ohne die Bytes, über die sie geht, ist wertlos;
            // Bytes ohne Signatur wären ein Release, das sich signiert NENNT.
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Manifest und Signatur gehoeren zusammen - es wurde nur eines von beiden geschickt.");
        }

        JsonNode m = parse(manifest, "Manifest");
        JsonNode s = parse(signature, "Signaturdatei");

        String release = text(m, "release");
        String keyId = text(m, "signing_key_id");
        JsonNode seqNode = m.get("release_seq");
        if (release == null || keyId == null || seqNode == null || !seqNode.canConvertToLong()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Das Manifest traegt nicht release, release_seq und signing_key_id.");
        }
        // Die key_id steht an zwei Stellen (im signierten Manifest und in der
        // .sig, die den Schluessel auswaehlt). Laufen sie auseinander, gehoeren
        // die beiden Dateien nicht zusammen - ein Eintrag daraus waere eine
        // Luege, die im Register niemand mehr bemerkt.
        String sigKeyId = text(s, "key_id");
        if (!keyId.equals(sigKeyId)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Manifest und Signatur nennen verschiedene Schluessel ('" + keyId + "' vs '"
                            + sigKeyId + "') - sie gehoeren nicht zusammen.");
        }
        if (!"release".equals(text(s, "domain"))) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Die Signaturdatei ist nicht fuer ein Release ausgestellt.");
        }

        requireSame("version", blankToNull(req.version()), release);
        requireSame("signingKeyId", blankToNull(req.signingKeyId()), keyId);
        requireSame("targetCommit", blankToNull(req.targetCommit()), text(m, "target_commit"));
        if (req.releaseSeq() != null && req.releaseSeq() != seqNode.asLong()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "releaseSeq widerspricht dem signierten Manifest (" + req.releaseSeq()
                            + " vs " + seqNode.asLong() + ").");
        }
        return new Signed(release, seqNode.asLong(), text(m, "target_commit"), keyId);
    }

    private static void requireSame(String field, String given, String signedValue) {
        if (given != null && !given.equals(signedValue)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    field + " widerspricht dem signierten Manifest ('" + given + "' vs '"
                            + signedValue + "').");
        }
    }

    private JsonNode parse(String raw, String what) {
        try {
            return json.readTree(raw);
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    what + " ist kein gueltiges JSON.");
        }
    }

    private static String text(JsonNode n, String field) {
        JsonNode v = n.get(field);
        return v == null || !v.isTextual() ? null : v.asText();
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }

    /**
     * Jede Ablehnung erreicht die Oberfläche als deutscher {@code {message}}
     * -Körper statt als nackter Status (das Muster von
     * {@link AdminOptimizerController}).
     */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> handle(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
