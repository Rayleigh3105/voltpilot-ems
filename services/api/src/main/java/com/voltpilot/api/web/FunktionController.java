package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.FunktionAbgelehnt;
import com.voltpilot.api.uems.FunktionService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.FunktionDto;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Funktionen je Standort (UEMS AP-01 IP-3, E6 = C): lesend beide Funktionen je Standort mit Zustand, „es
 * fehlt“ und der Teilnahme je Anlage samt Prüfliste; schreibend „Steuern &amp; Optimieren“ je Anlage (starten ·
 * anhalten · fortsetzen · beenden) und für den ganzen Standort (anhalten · fortsetzen · beenden aller
 * Teilnahmen); dazu „Messen &amp; Auswerten“ je Standort einrichten (AP-01 IP-9a). Die Arbeit macht
 * {@link FunktionService}, die Regel {@code FunktionZustandAbleitung}; Starten und Fortsetzen prüfen die Liste in
 * derselben Transaktion erneut (R1/R2).
 *
 * <p><b>Rechte:</b> bis AP-03 durchsetzt, gilt {@code authenticated()} (SecurityConfig) plus die Mandanten-RLS —
 * eine fremde Anlage und ein fremder Standort sind 404 {@code nicht_gefunden}, nie 403. Ein 409 nennt den Grund
 * des Vertrags (bei offener Prüfliste mit {@code fehlt} und {@code wege}); das ist keine Zugriffs-Ablehnung.
 * Jede Route nennt im Kommentar ihre Kennung aus {@code docs/contracts/v2/rechte-matrix.json}.
 *
 * <p>Die Anfrage ist {@code {"aktion": "…"}} — ein anderes Feld, eine fehlende oder unbekannte Aktion sind 400
 * {@code anfrage_ungueltig}, geprüft NACH dem Mandantenzaun.
 */
@RestController
public class FunktionController {

    private final FunktionService dienst;

    public FunktionController(FunktionService dienst) {
        this.dienst = dienst;
    }

    /** Recht: heute lesend — keine eigene Kennung (wie das Standort-Lesemodell). */
    @GetMapping("/api/v1/funktionen")
    public FunktionDto.Funktionen funktionen() {
        return dienst.uebersicht();
    }

    /**
     * Recht: {@code steuerung.starten_beenden} für starten und beenden, {@code steuerung.anhalten_fortsetzen} für
     * anhalten und fortsetzen — eingetragen, nicht durchgesetzt.
     */
    @PutMapping("/api/v1/sites/{siteId}/funktionen/steuern")
    public FunktionDto.SteuernErgebnis steuernAnlage(@PathVariable UUID siteId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return dienst.steuernAnlage(siteId, aktion(body), akteur(auth));
    }

    /**
     * Recht: {@code steuerung.anhalten_fortsetzen} für anhalten und fortsetzen, {@code steuerung.starten_beenden}
     * für beenden — eingetragen, nicht durchgesetzt.
     */
    @PutMapping("/api/v1/standorte/{standortId}/funktionen/steuern")
    public FunktionDto.SteuernErgebnis steuernStandort(@PathVariable UUID standortId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return dienst.steuernStandort(standortId, aktion(body), akteur(auth));
    }

    /**
     * Recht: {@code funktion.messen_einrichten} — eingetragen, nicht durchgesetzt. Legt „Messen &amp; Auswerten“ des
     * Standorts im Entwurf an (AP-01 IP-9a, Schritt 1 des Assistenten); ein zweites Mal ist 409.
     */
    @PutMapping("/api/v1/standorte/{standortId}/funktionen/messen")
    public FunktionDto.MessenErgebnis messenStandort(@PathVariable UUID standortId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return dienst.messenStandort(standortId, aktion(body), akteur(auth));
    }

    /** Die Aktion aus {@code {"aktion": "…"}}; {@code null}, wenn die Anfrage nicht genau so aussieht. */
    private static String aktion(JsonNode body) {
        if (body == null || !body.isObject() || body.size() != 1) {
            return null;
        }
        for (Iterator<Map.Entry<String, JsonNode>> it = body.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> f = it.next();
            if (!"aktion".equals(f.getKey()) || !f.getValue().isTextual()) {
                return null;
            }
            return f.getValue().asText();
        }
        return null;
    }

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    /** {@code {code, message, fehlt, wege}}. */
    @ExceptionHandler(FunktionAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(FunktionAbgelehnt e) {
        return ResponseEntity.status(e.status()).body(e.body());
    }

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie eine, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(FunktionAbgelehnt.nichtGefunden("Nicht gefunden."));
    }

    /** Kein lesbares JSON: dieselbe Form wie jede andere Ablehnung der Anfrage. */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(FunktionAbgelehnt.anfrage("Die Anfrage ist nicht lesbar — erwartet ist {\"aktion\": …}."));
    }
}
