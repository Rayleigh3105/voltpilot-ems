package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.voltpilot.api.uems.KorrekturPortalService;
import com.voltpilot.api.uems.KorrekturPortalService.Detail;
import com.voltpilot.api.uems.KorrekturPortalService.Eingabe;
import com.voltpilot.api.uems.KorrekturPortalService.Vorschau;
import com.voltpilot.api.uems.KorrekturFreigabeAbgelehnt;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/** UEMS: Portal-Lesewege und append-only Ersatzwerte, AP-08 IP-16. */
@RestController
@RequestMapping("/api/v1")
public class KorrekturPortalController {
    private final KorrekturPortalService dienst;
    private final ObjectMapper streng;
    public KorrekturPortalController(KorrekturPortalService dienst, ObjectMapper mapper) {
        this.dienst = dienst;
        this.streng = mapper.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .disable(com.fasterxml.jackson.databind.MapperFeature.ALLOW_COERCION_OF_SCALARS);
    }
    /** Recht: lesend, keine eigene Kennung; Mandant und Standort-Zaun, kein eigenes Schreibrecht. */
    @GetMapping("/standorte/{standortId}/korrekturen")
    public List<Detail> liste(@PathVariable UUID standortId, Authentication auth) {
        return dienst.liste(standortId, OrtAnfrage.akteur(auth));
    }
    /** Recht: lesend, keine eigene Kennung; alle betroffenen Standorte müssen sichtbar sein, sonst 404. */
    @GetMapping("/korrekturen/{kennung}")
    public Detail detail(@PathVariable String kennung, Authentication auth) {
        return dienst.detail(kennung, OrtAnfrage.akteur(auth));
    }
    /** Recht: lesend, keine eigene Kennung; nur Ereignisse der sichtbaren Quelle, keine fremden Messreihen. */
    @GetMapping("/messstellen/{kennzeichen}/ersatzwerte/luecken")
    public List<KorrekturPortalService.Luecke> luecken(@PathVariable String kennzeichen,
            @RequestParam UUID quelle_id, @RequestParam java.time.Instant von, @RequestParam java.time.Instant bis) {
        return dienst.luecken(kennzeichen, quelle_id, von, bis);
    }
    /** Recht: {@code ersatzwert.erfassen}; reine Vorschau, keine Einträge oder Probe-Schreibvorgänge. */
    @PostMapping("/messstellen/{kennzeichen}/ersatzwerte/vorschau")
    @Recht(value = "ersatzwert.erfassen", ziel = RechtZiel.DIENST)
    public Vorschau vorschau(@PathVariable String kennzeichen, @RequestBody JsonNode body, Authentication auth) {
        return dienst.vorschau(kennzeichen, eingabe(body), OrtAnfrage.akteur(auth));
    }
    /** Recht: {@code ersatzwert.erfassen}; genauer Standort und Rollen aus dem Zugriff-Kontext. */
    @PostMapping("/messstellen/{kennzeichen}/ersatzwerte")
    @Recht(value = "ersatzwert.erfassen", ziel = RechtZiel.DIENST)
    public Detail erfassen(@PathVariable String kennzeichen, @RequestBody JsonNode body, Authentication auth) {
        return dienst.erfassen(kennzeichen, eingabe(body), OrtAnfrage.akteur(auth));
    }
    /** Recht: {@code korrektur.freigeben}; dieselbe Zuständigkeit wie beim Prüfen des Vorschlags. */
    @PostMapping("/korrekturen/{kennung}/ablehnen")
    @Recht(value = "korrektur.freigeben", ziel = RechtZiel.DIENST)
    public Detail ablehnen(@PathVariable String kennung, @RequestBody JsonNode body, Authentication auth) {
        return dienst.ablehnen(kennung, grund(body), OrtAnfrage.akteur(auth));
    }
    /** Recht: {@code korrektur.zuruecknehmen}; Vier-Augen und eigener Vorgang für Bearbeiter. */
    @PostMapping("/ersatzwerte/{kennung}/zuruecknehmen")
    @Recht(value = "korrektur.zuruecknehmen", ziel = RechtZiel.DIENST)
    public KorrekturPortalService.ErsatzwertStand zuruecknehmen(@PathVariable String kennung, @RequestBody JsonNode body, Authentication auth) {
        return dienst.ersatzwertZuruecknehmen(kennung, grund(body), OrtAnfrage.akteur(auth));
    }
    private Eingabe eingabe(JsonNode body) {
        try { return streng.treeToValue(body, Eingabe.class); }
        catch (com.fasterxml.jackson.core.JsonProcessingException | IllegalArgumentException x) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Die Anfrage ist nicht vollständig oder nicht lesbar.");
        }
    }
    private static String grund(JsonNode body) {
        if (!body.isObject() || body.size() != 1 || !body.path("grund").isTextual())
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Bitte den Grund angeben.");
        return body.get("grund").asText();
    }
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> ungueltig(ResponseStatusException x) {
        String message = x.getReason() == null ? "Die Anfrage konnte nicht ausgeführt werden." : x.getReason();
        String code = message.matches("[a-z_]+") ? message : switch (x.getStatusCode().value()) {
            case 404 -> "nicht_gefunden";
            case 409 -> "status_passt_nicht";
            default -> "eingabe_ungueltig";
        };
        return ResponseEntity.status(x.getStatusCode()).body(Map.of("code", code, "message", message));
    }
    @ExceptionHandler(org.springframework.dao.DataIntegrityViolationException.class)
    public ResponseEntity<Map<String, Object>> gleichzeitig(org.springframework.dao.DataIntegrityViolationException x) {
        Throwable ursache = x.getMostSpecificCause();
        boolean gleichzeitig = ursache instanceof java.sql.SQLException sql && "23505".equals(sql.getSQLState());
        return ResponseEntity.status(gleichzeitig ? 409 : 422).body(Map.of("code", gleichzeitig ? "gleichzeitig" : "eingabe_ungueltig",
                "message", gleichzeitig ? "Der Vorgang wurde soeben geändert. Laden Sie neu." : "Die Eingabe passt nicht zu diesem Vorgang."));
    }
    @ExceptionHandler(KorrekturFreigabeAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(KorrekturFreigabeAbgelehnt x) {
        Map<String, Object> out = new LinkedHashMap<>(x.fakten());
        out.put("code", x.code()); out.put("message", x.getMessage());
        return ResponseEntity.status(x.status()).body(out);
    }
}
