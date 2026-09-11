package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.DatenquelleAbgelehnt;
import com.voltpilot.api.uems.DatenquelleService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.DatenquelleDto;
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
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Datenquellen einer Anlage (UEMS AP-06 IP-3, Vertrag
 * {@code docs/contracts/v2/data-source-assignment.md}). Die Arbeit macht {@link DatenquelleService}.
 *
 * <p><b>Rechte:</b> bis AP-03 durchsetzt, gilt {@code authenticated()} (SecurityConfig) plus die
 * Mandanten-RLS wie unter {@code /api/v1/sites/**} — eine fremde Anlage, Quelle oder Box ist
 * 404, nie 403; der Plattform-Admin wählt den Kundenbereich über {@code X-Tenant-Id}. Eine
 * eigene Rechte-Annotation gibt es hier bewusst nicht. Jede Route nennt im Kommentar ihr Recht
 * nach AP-06 §4.8 — {@code datenquelle.ansehen}, {@code datenquelle.bearbeiten} und
 * {@code datenquelle.zustaendigkeit} stehen als Nachtrag in
 * {@code docs/contracts/v2/rechte-matrix.json} (die Zuständigkeit ohne Energiemanager,
 * Widerspruch W-R9); {@code RechteKennungenDerRoutenTest} hält jede genannte Kennung an die Matrix.
 *
 * <p><b>Die Anfrage wird streng gelesen:</b> ein Feld, das es an der Route nicht gibt, ist 400
 * {@code anfrage_ungueltig} mit {@code feld} — nie still verworfen (wer ein Prüfergebnis
 * mitschickt, soll nicht glauben, es zähle).
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/data-sources")
public class DatenquelleController {

    private final DatenquelleService datenquellen;
    private final ObjectMapper streng;

    public DatenquelleController(DatenquelleService datenquellen, ObjectMapper json) {
        this.datenquellen = datenquellen;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /** Recht: {@code datenquelle.ansehen} (AP-06 §4.8: alle Rollen des Standorts). */
    @GetMapping
    public DatenquelleDto.Liste alle(@PathVariable UUID siteId) {
        return datenquellen.alle(siteId);
    }

    /** Recht: {@code datenquelle.ansehen}. */
    @GetMapping("/{id}")
    public DatenquelleDto.Datenquelle eine(@PathVariable UUID siteId, @PathVariable UUID id) {
        return datenquellen.eine(siteId, id);
    }

    /** Recht: lesend ({@code aenderungsprotokoll.lesen}). Jüngster Eintrag zuerst. */
    @GetMapping("/{id}/history")
    public DatenquelleDto.Protokoll protokoll(@PathVariable UUID siteId, @PathVariable UUID id) {
        return datenquellen.protokoll(siteId, id);
    }

    /** Recht: {@code datenquelle.bearbeiten} (AP-06 §4.8). */
    @PostMapping
    public ResponseEntity<DatenquelleDto.Datenquelle> anlegen(@PathVariable UUID siteId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        DatenquelleDto.Datenquelle neu = datenquellen.anlegen(siteId,
                lies(body, DatenquelleDto.Anlegen.class), akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/sites/" + siteId + "/data-sources/" + neu.id()))
                .body(neu);
    }

    /** Recht: {@code datenquelle.bearbeiten} (AP-06 §4.8). */
    @PutMapping("/{id}")
    public DatenquelleDto.Datenquelle bearbeiten(@PathVariable UUID siteId, @PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return datenquellen.bearbeiten(siteId, id, lies(body, DatenquelleDto.Bearbeiten.class), akteur(auth));
    }

    /**
     * Recht: {@code datenquelle.bearbeiten} — die Erreichbarkeitsprüfung gehört zum Anlegen
     * (AP-06 §4.8). Ein gescheitertes Ergebnis ist ein ehrlicher Ausgang (200), kein Fehler.
     */
    @PostMapping("/{id}/reachability-check")
    public DatenquelleDto.Pruefergebnis pruefen(@PathVariable UUID siteId, @PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return datenquellen.pruefen(siteId, id, lies(body, DatenquelleDto.Pruefen.class), akteur(auth));
    }

    /**
     * Recht: {@code datenquelle.zustaendigkeit} (AP-06 §4.8; Steuerquelle nur Kundenadministrator
     * und in diesem Paket gesperrt — Grund {@code steuerquelle}).
     */
    @PostMapping("/{id}/assignments")
    public ResponseEntity<DatenquelleDto.Zugewiesen> zuweisen(@PathVariable UUID siteId,
            @PathVariable UUID id, @RequestBody(required = false) JsonNode body, Authentication auth) {
        DatenquelleDto.Zugewiesen z = datenquellen.zuweisen(siteId, id,
                lies(body, DatenquelleDto.Zuweisen.class), akteur(auth));
        return ResponseEntity.status(HttpStatus.CREATED).body(z);
    }

    // ---------------------------------------------------------------- Gerüst

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    private <T> T lies(JsonNode body, Class<T> typ) {
        if (body == null || !body.isObject()) {
            throw DatenquelleAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        try {
            return streng.treeToValue(body, typ);
        } catch (UnrecognizedPropertyException e) {
            String feld = pfad(e);
            throw DatenquelleAbgelehnt.anfrage(feld, "„" + feld + "“ gibt es hier nicht.");
        } catch (JsonMappingException e) {
            String feld = pfad(e);
            throw DatenquelleAbgelehnt.anfrage(feld, "„" + feld + "“ hat nicht die erwartete Form.");
        } catch (JsonProcessingException e) {
            throw DatenquelleAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
    }

    /** {@code geraeteIds[1]} — der Weg zum Feld. */
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

    /** {@code {code, message, …Fakten}} — Code und Status wie Vertrag bzw. Schnittstelle sie nennen. */
    @ExceptionHandler(DatenquelleAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(DatenquelleAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Kein lesbares JSON: dieselbe Form wie jede andere Ablehnung der Anfrage. */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(DatenquelleAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt."));
    }

    /** 404/503: ein deutscher {@code {message}}-Körper wie überall in der API. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> status(ResponseStatusException e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("message", e.getReason());
        return ResponseEntity.status(e.getStatusCode()).body(body);
    }
}
