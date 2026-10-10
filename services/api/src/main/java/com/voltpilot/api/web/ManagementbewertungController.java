package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.BerichtAbgelehnt;
import com.voltpilot.api.uems.EnergiemanagementAbgelehnt;
import com.voltpilot.api.uems.ManagementbewertungService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.ManagementbewertungDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.util.LinkedHashMap;
import java.util.Map;
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
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;

/**
 * UEMS AP-19 IP-23 (MG4–MG6, §5.5, §5.6): Sitzung, Beschlüsse und Folgen der Managementbewertung {@code BR-…} — der
 * Bericht der Vorlage {@code managementbewertung} (IP-22). Die Arbeit macht {@link ManagementbewertungService}.
 *
 * <p><b>Rechte:</b> Schreibrouten {@code energiemanagement.verwalten} am Unternehmen (403 {@code recht_fehlt};
 * „Einsicht“ schreibt nie); Lesen {@code energiemanagement.ansehen} als Kennung im Kommentar — Sichtbarkeit aus RLS und
 * dem Zaun des Berichts. Ein Bericht einer anderen Vorlage ist hier 404. Die Freigabe bleibt
 * {@code POST /api/v1/berichte/{kennung}/freigeben} — nur mit Sitzung, Leitung und Beschluss (422
 * {@code sitzung_fehlt} · {@code leitung_fehlt} · {@code beschluss_fehlt}).
 */
@RestController
@RequestMapping("/api/v1/energiemanagement/managementbewertungen/{kennung}")
public class ManagementbewertungController {

    private final ManagementbewertungService dienst;
    private final ObjectMapper streng;

    public ManagementbewertungController(ManagementbewertungService dienst, ObjectMapper json) {
        this.dienst = dienst;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS);
    }

    /**
     * Recht: {@code energiemanagement.ansehen}. Sitzung, Beschlüsse und ihre Folgen mit dem Zustand von heute — die Folgen
     * von Hand verknüpft und die Objekte, die den Beschluss selbst nennen (MG6).
     */
    @GetMapping
    public ManagementbewertungDto.Managementbewertung lesen(@PathVariable String kennung, Authentication auth) {
        return dienst.lesen(kennung, akteur(auth));
    }

    /**
     * Recht: {@code energiemanagement.verwalten} am Unternehmen. Hält die Sitzung fest (MG4): Tag (nie in der Zukunft),
     * Leitung (PA3, sonst 422 {@code leitung_fehlt}), Teilnehmende, wahlfrei Ort — bis zur Freigabe (409
     * {@code managementbewertung_freigegeben}); ein zweites Festhalten ersetzt die erste Angabe.
     */
    @PutMapping("/sitzung")
    @Recht(value = "energiemanagement.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public ManagementbewertungDto.Managementbewertung sitzung(@PathVariable String kennung,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return dienst.sitzung(kennung, lies(body, ManagementbewertungDto.SitzungFesthalten.class), akteur(auth));
    }

    /**
     * Recht: {@code energiemanagement.verwalten} am Unternehmen. Hält einen Beschluss fest (MG5) — nach der Sitzung (422
     * {@code sitzung_fehlt}), entschieden von der Leitung, bis zur Freigabe.
     */
    @PostMapping("/beschluesse")
    @Recht(value = "energiemanagement.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<ManagementbewertungDto.Managementbewertung> beschluss(@PathVariable String kennung,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return ResponseEntity.status(HttpStatus.CREATED).body(dienst.beschluss(kennung,
                lies(body, ManagementbewertungDto.BeschlussFesthalten.class), akteur(auth)));
    }

    /** Recht: {@code energiemanagement.verwalten} am Unternehmen. Ändert Beschluss {@code nr} — bis zur Freigabe (MG5). */
    @PutMapping("/beschluesse/{nr}")
    @Recht(value = "energiemanagement.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public ManagementbewertungDto.Managementbewertung beschlussAendern(@PathVariable String kennung,
            @PathVariable int nr, @RequestBody(required = false) JsonNode body, Authentication auth) {
        return dienst.beschlussAendern(kennung, nr, lies(body, ManagementbewertungDto.BeschlussFesthalten.class),
                akteur(auth));
    }

    /**
     * Recht: {@code energiemanagement.verwalten} am Unternehmen. Verknüpft eine Folge mit Beschluss {@code nr} (MG6) —
     * nach der Freigabe (409 {@code managementbewertung_nicht_freigegeben}), nur anhängen; der Stand ändert sich nicht.
     */
    @PostMapping("/beschluesse/{nr}/folgen")
    @Recht(value = "energiemanagement.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<ManagementbewertungDto.Managementbewertung> folge(@PathVariable String kennung,
            @PathVariable int nr, @RequestBody(required = false) JsonNode body, Authentication auth) {
        return ResponseEntity.status(HttpStatus.CREATED).body(dienst.folge(kennung, nr,
                lies(body, ManagementbewertungDto.FolgeVerknuepfen.class), akteur(auth)));
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

    /** Das Nein des Berichts (Kennung unbekannt, fremd, andere Vorlage: 404; Recht: 403) in derselben Form. */
    @ExceptionHandler(BerichtAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> bericht(BerichtAbgelehnt e) {
        return abgelehnt(new EnergiemanagementAbgelehnt(e.ablehnung().status(), e.ablehnung().code(), e.getMessage(),
                e.fakten()));
    }

    /** Eine Nr. im Pfad, die keine ist: dieselbe Antwort wie ein Beschluss, den es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineNr(MethodArgumentTypeMismatchException e) {
        return abgelehnt(new EnergiemanagementAbgelehnt(404, "nicht_gefunden", "Diesen Beschluss gibt es nicht.", null));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(EnergiemanagementAbgelehnt.anfrage(""));
    }
}
