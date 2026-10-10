package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.MessstelleAbgelehnt;
import com.voltpilot.api.uems.MessstelleVorschlagService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.MessstelleVorschlagDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
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
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Vorschlagsliste der Bestandsübernahme je Standort (UEMS AP-04 IP-16, Konzept §5.15,
 * Entscheid E6, Abnahme A9; Portal-Hälfte: AP-01 IP-9b).
 *
 * <p>Zwei Routen: die Liste LIEST nur (bis zur Bestätigung entsteht nichts), die Übernahme legt
 * die ausgewählten Zeilen an — Messstelle, Ort, führende Quelle ab dem Verlaufsbeginn
 * (rückwirkend, Herkunft „Bestandsübernahme“) und Stellung, alles in EINER Transaktion.
 *
 * <p><b>Rechte:</b> es gilt {@code authenticated()} (SecurityConfig) plus die
 * Mandanten-RLS — ein fremder Standort ist 404, nie 403. Über jeder Route steht die Kennung, die
 * die Rechte-Matrix dafür vorsieht ({@code RechteKennungenDerRoutenTest} hält sie daran fest);
 * seit AP-03 IP-6 setzt {@code @Recht} sie vor dem Handler durch.
 * Die Freischaltung „nur mit Messen &amp; Auswerten“ (E6) hängt an den Funktions-Objekten aus
 * AP-01 IP-2 und kommt mit ihnen — hier wird keine zweite Sperre erfunden.
 */
@RestController
@RequestMapping("/api/v1/standorte/{id}/messstellen-vorschlag")
public class MessstelleVorschlagController {

    private final MessstelleVorschlagService vorschlaege;
    private final ObjectMapper streng;

    public MessstelleVorschlagController(MessstelleVorschlagService vorschlaege, ObjectMapper json) {
        this.vorschlaege = vorschlaege;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /** Recht: {@code messstelle.ansehen} — die Liste liest nur; nichts entsteht ungefragt (E6). */
    @GetMapping
    public MessstelleVorschlagDto.Liste liste(@PathVariable UUID id) {
        return vorschlaege.vorschlag(id);
    }

    /**
     * Recht: {@code messstelle.bearbeiten} und {@code messstelle.quelle}; die Bindung beginnt am
     * Beginn des Verlaufs, also zusätzlich {@code aenderung.rueckwirkend}.
     */
    @PostMapping("/uebernehmen")
    @Recht(value = "messstelle.bearbeiten", ziel = RechtZiel.STANDORT, variable = "id")
    public MessstelleVorschlagDto.Uebernommen uebernehmen(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return vorschlaege.uebernehmen(id, lies(body), akteur(auth));
    }

    // ---------------------------------------------------------------- Gerüst

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    private MessstelleVorschlagDto.Uebernehmen lies(JsonNode body) {
        if (body == null || !body.isObject()) {
            throw MessstelleAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        try {
            return streng.treeToValue(body, MessstelleVorschlagDto.Uebernehmen.class);
        } catch (UnrecognizedPropertyException e) {
            throw MessstelleAbgelehnt.anfrage(pfad(e), "„" + pfad(e) + "“ gibt es hier nicht.");
        } catch (JsonMappingException e) {
            throw MessstelleAbgelehnt.anfrage(pfad(e), "„" + pfad(e) + "“ hat nicht die erwartete Form.");
        } catch (JsonProcessingException e) {
            throw MessstelleAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
    }

    /** {@code vorschlaege[1].hauptgroesse.einheit} — der Weg zum Feld (wie MessstelleController). */
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

    /** {@code {code, message, …Fakten}} — wie die Messstellen-Schnittstelle. */
    @ExceptionHandler(MessstelleAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(MessstelleAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Kein lesbares JSON: dieselbe Form wie jede andere Ablehnung der Anfrage. */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(MessstelleAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt."));
    }

    /** 403/404: ein deutscher {@code {message}}-Körper wie überall in der API. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> status(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
