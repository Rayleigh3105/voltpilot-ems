package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.EnergiemanagementAbgelehnt;
import com.voltpilot.api.uems.InternesAuditService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.InternesAuditDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.net.URI;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;

/**
 * UEMS AP-19 IP-18: internes Audit (IA1–IA5, §5.4, §5.6) — das Auditprogramm, planen, ändern, durchgeführt melden,
 * Hinweise festhalten, abschließen mit Kopie und Prüfsumme, absagen. Die Arbeit macht {@link InternesAuditService}.
 *
 * <p><b>Rechte:</b> Schreibrouten {@code energiemanagement.verwalten} am Unternehmen, das Abschließen
 * {@code energiemanagement.freigeben} (403 {@code recht_fehlt}; „Einsicht“ schreibt nie). Lesen
 * {@code energiemanagement.ansehen} als Kennung im Kommentar — die Sichtbarkeit kommt aus RLS und dem Standort-Zaun von
 * IP-16 (ein Audit ohne Standort sieht nur, wer unternehmensweit liest). Gelöscht wird nie.
 */
@RestController
@RequestMapping("/api/v1/energiemanagement/audits")
public class InternesAuditController {

    private final InternesAuditService dienst;
    private final ObjectMapper streng;

    public InternesAuditController(InternesAuditService dienst, ObjectMapper json) {
        this.dienst = dienst;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS);
    }

    /**
     * Recht: {@code energiemanagement.ansehen}. Das Auditprogramm am {@code tag} (Vorgabe heute): alle Audits und
     * „nächstes internes Audit fällig am …“ — letzter Durchführungstag + Rhythmus, beim Abruf (IA4).
     */
    @GetMapping
    public InternesAuditDto.Auditprogramm programm(@RequestParam(required = false) String tag) {
        return dienst.programm(tag(tag));
    }

    /**
     * Recht: {@code energiemanagement.verwalten} am Unternehmen. Plant ein Audit (IA1): Titel, Termin, Auditorin oder
     * Auditor, Unabhängigkeit (422 {@code unabhaengigkeit_fehlt}), was und woran, Verantwortlich; wahlfrei Standorte.
     */
    @PostMapping
    @Recht(value = "energiemanagement.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<InternesAuditDto.AuditMitVerlauf> planen(@RequestBody(required = false) JsonNode body,
            Authentication auth) {
        UUID id = dienst.planen(lies(body, InternesAuditDto.AuditStand.class), akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/energiemanagement/audits/" + id)).body(dienst.audit(id));
    }

    /** Recht: {@code energiemanagement.ansehen}. Das Audit mit Hinweisen, Abschluss und Verlauf; unbekannt 404. */
    @GetMapping("/{id}")
    public InternesAuditDto.AuditMitVerlauf audit(@PathVariable UUID id) {
        return dienst.audit(id);
    }

    /**
     * Recht: {@code energiemanagement.verwalten} am Unternehmen. Der ganze Stand, solange geplant (409
     * {@code audit_nicht_geplant}); ein anderer Termin braucht eine Begründung.
     */
    @PutMapping("/{id}")
    @Recht(value = "energiemanagement.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public InternesAuditDto.AuditMitVerlauf aendern(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        dienst.aendern(id, lies(body, InternesAuditDto.AuditStand.class), akteur(auth));
        return dienst.audit(id);
    }

    /** Recht: {@code energiemanagement.verwalten} am Unternehmen. Geplant → durchgeführt am Tag, nie in der Zukunft. */
    @PostMapping("/{id}/durchgefuehrt")
    @Recht(value = "energiemanagement.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public InternesAuditDto.AuditMitVerlauf durchgefuehrt(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        dienst.durchgefuehrt(id, lies(body, InternesAuditDto.Durchgefuehrt.class), akteur(auth));
        return dienst.audit(id);
    }

    /**
     * Recht: {@code energiemanagement.verwalten} am Unternehmen. Hält einen Hinweis am durchgeführten Audit fest —
     * Wortlaut, „festgestellt von“ (die Person, die prüft); eingetragen von dem Konto, das festhält (IA2, IA5).
     */
    @PostMapping("/{id}/hinweise")
    @Recht(value = "energiemanagement.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<InternesAuditDto.AuditMitVerlauf> hinweis(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        dienst.hinweis(id, lies(body, InternesAuditDto.HinweisFesthalten.class), akteur(auth));
        return ResponseEntity.status(HttpStatus.CREATED).body(dienst.audit(id));
    }

    /**
     * Recht: {@code energiemanagement.freigeben} am Unternehmen. Schließt das durchgeführte Audit ab (IA3): entschieden
     * von, Bericht als Verweis oder Zusammenfassung, die Kopie mit Prüfsumme; danach unveränderlich.
     */
    @PostMapping("/{id}/abschliessen")
    @Recht(value = "energiemanagement.freigeben", ziel = RechtZiel.UNTERNEHMEN)
    public InternesAuditDto.AuditMitVerlauf abschliessen(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        dienst.abschliessen(id, lies(body, InternesAuditDto.Abschliessen.class), akteur(auth));
        return dienst.audit(id);
    }

    /** Recht: {@code energiemanagement.verwalten} am Unternehmen. Sagt das geplante Audit ab, Begründung Pflicht. */
    @PostMapping("/{id}/absagen")
    @Recht(value = "energiemanagement.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public InternesAuditDto.AuditMitVerlauf absagen(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        dienst.absagen(id, lies(body, InternesAuditDto.Absagen.class), akteur(auth));
        return dienst.audit(id);
    }

    private static LocalDate tag(String tag) {
        if (tag == null || tag.isBlank()) {
            return null;
        }
        try {
            return LocalDate.parse(tag);
        } catch (DateTimeParseException e) {
            throw EnergiemanagementAbgelehnt.anfrage("tag");
        }
    }

    private <T> T lies(JsonNode body, Class<T> form) {
        if (body == null || body.isNull()) {
            body = streng.createObjectNode();
        }
        if (!body.isObject()) {
            throw EnergiemanagementAbgelehnt.anfrage("");
        }
        try {
            return streng.treeToValue(body, form);
        } catch (UnrecognizedPropertyException e) {
            throw EnergiemanagementAbgelehnt.anfrage(e.getPropertyName());
        } catch (com.fasterxml.jackson.core.JsonProcessingException | IllegalArgumentException e) {
            throw EnergiemanagementAbgelehnt.anfrage("");
        }
    }

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    /** {@code {code, message, …Fakten}} — wie jede Ablehnung der UEMS-Routen. */
    @ExceptionHandler(EnergiemanagementAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(EnergiemanagementAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie ein Audit, das es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(new EnergiemanagementAbgelehnt(404, "nicht_gefunden", "Dieses Audit gibt es nicht.", null));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(EnergiemanagementAbgelehnt.anfrage(""));
    }
}
