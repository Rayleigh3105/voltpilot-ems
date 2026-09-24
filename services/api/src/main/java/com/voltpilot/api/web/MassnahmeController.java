package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.KennzahlAbgelehnt;
import com.voltpilot.api.uems.MassnahmeService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.VerbesserungAbgelehnt;
import com.voltpilot.api.web.dto.MassnahmeDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import jakarta.servlet.http.HttpServletRequest;
import java.net.URI;
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
 * Maßnahmen (UEMS AP-18 IP-10, M1–M4, M6, M7, RE1–RE3): anlegen mit oder ohne Messgrundlage, lesen, ändern solange
 * geplant, Verantwortlicher, umgesetzt melden, verwerfen, Kommentare. Die Arbeit macht {@link MassnahmeService}; die
 * Wirkung liest IP-11, die Bewertung bringt IP-12.
 *
 * <p><b>Rechte:</b> Schreibrouten {@code verbesserung.verwalten} an der Geltung der Kennzahl bzw. am Standort der
 * Maßnahme (403 {@code recht_fehlt}); Lesen {@code verbesserung.ansehen} als Kennung im Kommentar — die Sichtbarkeit
 * kommt über {@code standort_id} (RLS) und die Kennzahl, außerhalb 404.
 */
@RestController
@RequestMapping("/api/v1/massnahmen")
public class MassnahmeController {

    private final MassnahmeService massnahmen;
    private final ObjectMapper streng;

    public MassnahmeController(MassnahmeService massnahmen, ObjectMapper json) {
        this.massnahmen = massnahmen;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /**
     * Recht: {@code verbesserung.ansehen} (Zaun über Standort und Kennzahl). Das Register; {@code zustand}
     * ({@code geplant · umgesetzt · bewertet · verworfen}), {@code ueberfaellig} ({@code true · false}, Operation
     * {@code frist} beim Abruf), {@code kennzahl} und {@code einsatz} (IDs) filtern.
     */
    @GetMapping
    public MassnahmeDto.Liste liste(@RequestParam(required = false) String zustand,
            @RequestParam(required = false) String ueberfaellig, @RequestParam(required = false) String kennzahl,
            @RequestParam(required = false) String einsatz, HttpServletRequest anfrage) {
        return massnahmen.liste(anfrage.getParameterMap().keySet(), zustand, ueberfaellig, kennzahl, einsatz);
    }

    /**
     * Recht: {@code verbesserung.verwalten} an der Geltung der Kennzahl bzw. am gewählten Standort. Legt M-JJJJ-nnnn
     * an; mit Messgrundlage die Ausgangslage als Kopie des Vergleich-Lesers mit Prüfsumme, ohne Messgrundlage ist
     * eine Zahl der erwarteten Wirkung 422 {@code ohne_messgrundlage}; der Verantwortliche ist ein aktives Konto
     * (422 {@code benutzer_unbekannt}).
     */
    @PostMapping
    @Recht(value = "verbesserung.verwalten", ziel = RechtZiel.DIENST)
    public ResponseEntity<MassnahmeDto.Massnahme> anlegen(@RequestBody(required = false) JsonNode body,
            Authentication auth) {
        MassnahmeDto.Massnahme neu = massnahmen.anlegen(lies(body, MassnahmeDto.Anlegen.class), akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/massnahmen/" + neu.id())).body(neu);
    }

    /** Recht: {@code verbesserung.ansehen}. Die Maßnahme mit Verlauf; außerhalb der Sicht 404. */
    @GetMapping("/{id}")
    public MassnahmeDto.Massnahme eine(@PathVariable UUID id) {
        return massnahmen.eine(id);
    }

    /**
     * Recht: {@code verbesserung.verwalten}. Titel, Termin und erwartete Wirkung, solange geplant (sonst 409
     * {@code massnahme_nicht_geplant}), mit Begründung — eine Zeile im Verlauf.
     */
    @PutMapping("/{id}")
    @Recht(value = "verbesserung.verwalten", ziel = RechtZiel.DIENST)
    public MassnahmeDto.Massnahme aendern(@PathVariable UUID id, @RequestBody(required = false) JsonNode body,
            Authentication auth) {
        return massnahmen.aendern(id, lies(body, MassnahmeDto.Aendern.class), akteur(auth));
    }

    /** Recht: {@code verbesserung.verwalten}. Setzt den Verantwortlichen (aktives Konto) mit Begründung. */
    @PutMapping("/{id}/verantwortlicher")
    @Recht(value = "verbesserung.verwalten", ziel = RechtZiel.DIENST)
    public MassnahmeDto.Massnahme verantwortlicher(@PathVariable UUID id, @RequestBody(required = false) JsonNode body,
            Authentication auth) {
        return massnahmen.verantwortlicher(id, lies(body, MassnahmeDto.Verantwortlicher.class), akteur(auth));
    }

    /** Recht: {@code verbesserung.verwalten}. Umgesetzt am Tag (nie in der Zukunft) mit Begründung — einmalig. */
    @PostMapping("/{id}/umgesetzt")
    @Recht(value = "verbesserung.verwalten", ziel = RechtZiel.DIENST)
    public MassnahmeDto.Massnahme umgesetzt(@PathVariable UUID id, @RequestBody(required = false) JsonNode body,
            Authentication auth) {
        return massnahmen.umgesetzt(id, lies(body, MassnahmeDto.Umgesetzt.class), akteur(auth));
    }

    /** Recht: {@code verbesserung.verwalten}. Verwirft die geplante Maßnahme mit Begründung — endgültig. */
    @PostMapping("/{id}/verwerfen")
    @Recht(value = "verbesserung.verwalten", ziel = RechtZiel.DIENST)
    public MassnahmeDto.Massnahme verwerfen(@PathVariable UUID id, @RequestBody(required = false) JsonNode body,
            Authentication auth) {
        return massnahmen.verwerfen(id, lies(body, MassnahmeDto.Verwerfen.class), akteur(auth));
    }

    /** Recht: {@code verbesserung.verwalten}. Ein Kommentar im Verlauf (geplant oder umgesetzt). */
    @PostMapping("/{id}/eintraege")
    @Recht(value = "verbesserung.verwalten", ziel = RechtZiel.DIENST)
    public ResponseEntity<MassnahmeDto.Massnahme> eintrag(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(massnahmen.eintrag(id, lies(body, MassnahmeDto.NeuerEintrag.class), akteur(auth)));
    }

    private <T> T lies(JsonNode body, Class<T> form) {
        if (body == null || body.isNull()) {
            body = streng.createObjectNode();
        }
        if (!body.isObject()) {
            throw VerbesserungAbgelehnt.anfrage("");
        }
        try {
            return streng.treeToValue(body, form);
        } catch (UnrecognizedPropertyException e) {
            throw VerbesserungAbgelehnt.anfrage(e.getPropertyName());
        } catch (com.fasterxml.jackson.core.JsonProcessingException | IllegalArgumentException e) {
            throw VerbesserungAbgelehnt.anfrage("");
        }
    }

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    /** {@code {code, message, …Fakten}} — wie jede Ablehnung der UEMS-Routen. */
    @ExceptionHandler(VerbesserungAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(VerbesserungAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Die Kennzahl bzw. der Standort lehnt ab (404 außerhalb der Sicht, 403 ohne Recht an der Geltung). */
    @ExceptionHandler(KennzahlAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> kennzahl(KennzahlAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie eine Maßnahme, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(new VerbesserungAbgelehnt(404, "nicht_gefunden", "Diese Maßnahme gibt es nicht.", null));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(VerbesserungAbgelehnt.anfrage(""));
    }
}
