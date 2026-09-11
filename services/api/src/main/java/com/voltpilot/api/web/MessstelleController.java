package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.MessstelleAbgelehnt;
import com.voltpilot.api.uems.MessstelleService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.MessstelleDto;
import java.net.URI;
import java.util.LinkedHashMap;
import java.util.List;
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
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Messstellen des Kundenbereichs (UEMS AP-04 IP-3, Vertrag
 * {@code docs/contracts/v2/messstelle.md}). Die Arbeit macht {@link MessstelleService}.
 *
 * <p><b>Rechte:</b> bis AP-03 durchsetzt, gilt {@code authenticated()} (SecurityConfig) plus
 * die Mandanten-RLS wie unter {@code /api/v1/sites/**} — eine fremde Messstelle ist 404, nie
 * 403; der Plattform-Admin wählt den Kundenbereich über {@code X-Tenant-Id}. Jede Route nennt
 * im Kommentar ihre Kennung aus {@code docs/contracts/v2/rechte-matrix.json}, damit AP-03 sie
 * findet ({@code RechteKennungenDerRoutenTest} hält sie an die Matrix); eine eigene
 * Rechte-Annotation gibt es hier bewusst nicht.
 *
 * <p><b>Die Anfrage wird streng gelesen:</b> ein Feld, das es an der Route nicht gibt, ist 400
 * {@code anfrage_ungueltig} mit {@code feld} — nie still verworfen. Wer an {@code PUT} ein
 * Medium oder eine Hauptgröße schickt, soll nicht glauben, sie sei gespeichert; wer schon einen
 * Ort mitschickt (IP-7), ebenso nicht.
 */
@RestController
@RequestMapping("/api/v1/messstellen")
public class MessstelleController {

    private static final List<String> NIE_AENDERBAR = List.of("art", "medium", "hauptgroesse");

    private final MessstelleService messstellen;
    private final ObjectMapper streng;

    public MessstelleController(MessstelleService messstellen, ObjectMapper json) {
        this.messstellen = messstellen;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /** Recht: {@code messstelle.ansehen} (AP-04 §6.7). Das Register mit Filtern und Stichtag bringt IP-4. */
    @GetMapping
    public MessstelleDto.Liste alle() {
        return messstellen.alle();
    }

    /** Recht: {@code messstelle.bearbeiten} — der Vorschlag gehört zum Anlege-Dialog. */
    @GetMapping("/kennzeichen-vorschlag")
    public MessstelleDto.Vorschlag vorschlag() {
        return messstellen.vorschlag();
    }

    /** Recht: {@code messstelle.ansehen}. */
    @GetMapping("/{id}")
    public MessstelleDto.Messstelle eine(@PathVariable UUID id) {
        return messstellen.eine(id);
    }

    /** Recht: {@code messstelle.bearbeiten}. */
    @PostMapping
    public ResponseEntity<MessstelleDto.Messstelle> anlegen(
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        MessstelleDto.Anlegen anfrage = lies(body, MessstelleDto.Anlegen.class);
        MessstelleDto.Messstelle neu = messstellen.anlegen(anfrage, akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/messstellen/" + neu.id())).body(neu);
    }

    /** Recht: {@code messstelle.bearbeiten}. */
    @PutMapping("/{id}")
    public MessstelleDto.Messstelle bearbeiten(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return messstellen.bearbeiten(id, lies(body, MessstelleDto.Bearbeiten.class), akteur(auth));
    }

    /** Recht: {@code messstelle.bearbeiten}; mit einem Zeitpunkt vor jetzt zusätzlich {@code aenderung.rueckwirkend}. */
    @PostMapping("/{id}/anhalten")
    public MessstelleDto.Messstelle anhalten(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return messstellen.anhalten(id, uebergang(body), akteur(auth));
    }

    /** Recht: {@code messstelle.bearbeiten}; mit einem Zeitpunkt vor jetzt zusätzlich {@code aenderung.rueckwirkend}. */
    @PostMapping("/{id}/fortsetzen")
    public MessstelleDto.Messstelle fortsetzen(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return messstellen.fortsetzen(id, uebergang(body), akteur(auth));
    }

    /** Recht: {@code messstelle.bearbeiten}; mit einem Zeitpunkt vor jetzt zusätzlich {@code aenderung.rueckwirkend}. */
    @PostMapping("/{id}/archivieren")
    public MessstelleDto.Messstelle archivieren(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return messstellen.archivieren(id, uebergang(body), akteur(auth));
    }

    // ---------------------------------------------------------------- Gerüst

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    /** Anhalten, Fortsetzen und Archivieren gehen auch ohne Inhalt: dann gilt jetzt. */
    private MessstelleDto.Uebergang uebergang(JsonNode body) {
        return body == null || body.isNull() ? null : lies(body, MessstelleDto.Uebergang.class);
    }

    private <T> T lies(JsonNode body, Class<T> typ) {
        if (body == null || !body.isObject()) {
            throw MessstelleAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        try {
            return streng.treeToValue(body, typ);
        } catch (UnrecognizedPropertyException e) {
            String feld = pfad(e);
            throw MessstelleAbgelehnt.anfrage(feld, typ == MessstelleDto.Bearbeiten.class
                    && NIE_AENDERBAR.contains(feld)
                    ? "Art, Medium und Hauptgröße sind nie änderbar — eine andere Größe ist eine andere Messstelle."
                    : "„" + feld + "“ gibt es hier nicht.");
        } catch (JsonMappingException e) {
            String feld = pfad(e);
            throw MessstelleAbgelehnt.anfrage(feld, "„" + feld + "“ hat nicht die erwartete Form.");
        } catch (JsonProcessingException e) {
            throw MessstelleAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
    }

    /** {@code hauptgroesse.einheit}, {@code nebengroessen[1].wertart} — der Weg zum Feld. */
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
