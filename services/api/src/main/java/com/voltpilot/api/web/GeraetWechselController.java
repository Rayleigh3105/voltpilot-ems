package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.MessstelleAbgelehnt;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.ZaehlerwechselService;
import com.voltpilot.api.uems.WechselzeitpunktService;
import com.voltpilot.api.web.dto.ZaehlerwechselDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.time.OffsetDateTime;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der Zählerwechsel am Gerät (UEMS AP-04 IP-17): „Gerät austauschen" auf der Geräteseite. Die
 * Arbeit macht {@link ZaehlerwechselService} — derselbe Vorgang, den
 * {@code POST /api/v1/messstellen/{id}/quellen/wechsel} aus der Sicht der Messstelle anstößt:
 * altes Gerät ausgebaut, neues eingebaut, Bindungen umgezogen, Ablesestände, Einstellungen,
 * Protokoll. Entweder alle Wirkungen landen oder keine.
 *
 * <p><b>Rechte:</b> bis AP-03 durchsetzt, gilt {@code authenticated()} (SecurityConfig) plus die
 * Mandanten-RLS wie unter {@code /api/v1/sites/**} — ein fremdes Gerät ist 404, nie 403; der
 * Plattform-Admin wählt den Kundenbereich über {@code X-Tenant-Id}. Jede Route nennt im Kommentar
 * ihre Kennung aus {@code docs/contracts/v2/rechte-matrix.json}
 * ({@code RechteKennungenDerRoutenTest} hält sie an die Matrix).
 *
 * <p>Eigener Controller statt {@link GeraetController}: der liest nur und kennt die Ablehnungen der
 * Messstellen-Schnittstelle nicht. Hier antworten sie in derselben Form wie überall im UEMS —
 * {@code {code, message, …Fakten}} mit dem Status des Vertrags.
 */
@RestController
public class GeraetWechselController {

    private final ZaehlerwechselService wechsel;
    private final ObjectMapper streng;
    private final WechselzeitpunktService berichtigung;

    public GeraetWechselController(ZaehlerwechselService wechsel, ObjectMapper json,
            WechselzeitpunktService berichtigung) {
        this.wechsel = wechsel;
        this.berichtigung = berichtigung;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /**
     * Recht: {@code geraet.einrichten} — das Kästchen tauschen ist Einrichten am Gerät; die
     * Quellenbindungen, die dabei umziehen, tragen zusätzlich {@code messstelle.quelle}, ein
     * Zeitpunkt vor jetzt außerdem {@code aenderung.rueckwirkend}.
     */
    @PostMapping("/api/v1/geraete/{id}/austausch")
    @Recht(value = "messstelle.quelle", ziel = RechtZiel.GERAET)
    @ResponseStatus(HttpStatus.CREATED)
    public ZaehlerwechselDto.Vorgang austausch(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return wechsel.amGeraet(id, lies(body), akteur(auth));
    }

    /** Recht: keine eigene Kennung — lesende Vorschau; derselbe Standort-Zaun wie am Gerät. */
    @GetMapping("/api/v1/geraete/{id}/austausch/vorschau")
    public ZaehlerwechselDto.Vorschau vorschau(@PathVariable UUID id,
            @RequestParam(required = false) OffsetDateTime zeitpunkt) {
        return wechsel.vorschau(id, zeitpunkt);
    }

    /** Recht: {@code messstelle.quelle} — dieselbe Kennung wie der ursprüngliche Wechsel. */
    @PostMapping("/api/v1/geraete/{id}/austausch/zeitpunkt")
    @Recht(value = "messstelle.quelle", ziel = RechtZiel.GERAET)
    public ZaehlerwechselDto.Berichtigt zeitpunkt(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return berichtigung.berichtigen(id, lies(body, ZaehlerwechselDto.Berichtigung.class), akteur(auth));
    }

    // ---------------------------------------------------------------- Gerüst

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    private ZaehlerwechselDto.Wechsel lies(JsonNode body) {
        return lies(body, ZaehlerwechselDto.Wechsel.class);
    }

    private <T> T lies(JsonNode body, Class<T> typ) {
        if (body == null || !body.isObject()) {
            throw MessstelleAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        try {
            return streng.treeToValue(body, typ);
        } catch (UnrecognizedPropertyException e) {
            String feld = pfad(e);
            throw MessstelleAbgelehnt.anfrage(feld, "„" + feld + "“ gibt es hier nicht.");
        } catch (JsonMappingException e) {
            String feld = pfad(e);
            throw MessstelleAbgelehnt.anfrage(feld, "„" + feld + "“ hat nicht die erwartete Form.");
        } catch (JsonProcessingException e) {
            throw MessstelleAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
    }

    private static String pfad(JsonMappingException e) {
        StringBuilder s = new StringBuilder();
        for (JsonMappingException.Reference r : e.getPath()) {
            if (r.getFieldName() != null) {
                s.append(s.isEmpty() ? "" : ".").append(r.getFieldName());
            } else if (r.getIndex() >= 0) {
                s.append('[').append(r.getIndex()).append(']');
            }
        }
        return s.toString();
    }

    /** {@code {code, message, …Fakten}} — Code und Status wie der Vertrag (bzw. die Schnittstelle) sie nennt. */
    @ExceptionHandler(MessstelleAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(MessstelleAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Eine Kennung, die keine ist: dieselbe Form wie jede andere Ablehnung der Anfrage. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineKennung(MethodArgumentTypeMismatchException e) {
        return abgelehnt(MessstelleAbgelehnt.anfrage(e.getName(),
                "„" + e.getName() + "“ hat nicht die erwartete Form."));
    }

    /** Kein lesbares JSON: dieselbe Form wie jede andere Ablehnung der Anfrage. */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(MessstelleAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt."));
    }

    /** 401/404: ein deutscher {@code {message}}-Körper wie überall in der API. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> status(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
