package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.MessstelleAbgelehnt;
import com.voltpilot.api.uems.MessstelleFormelAbgelehnt;
import com.voltpilot.api.uems.MessstelleFormelService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.MessstelleDto;
import com.voltpilot.api.web.dto.MessstelleFormelDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.net.URI;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die berechnete Messstelle (UEMS AP-10, Formel-Typ „gewichtete Summe"): anlegen mit ihren Termen,
 * die Formel (zu einem Tag) lesen, eine neue Fassung der Formel eintragen (AP-10 IP-3), und Live-Wert
 * und Verlauf lesen. Additiv neben {@link MessstelleController}
 * (dieselbe Basis {@code /api/v1/messstellen}, andere Routen); die Messstelle selbst liest man
 * über {@code GET /api/v1/messstellen/{id}} dort.
 *
 * <p>Der Mandant ist die RLS: eine fremde Messstelle ist 404, nie 403.
 */
@RestController
@RequestMapping("/api/v1/messstellen")
public class MessstelleFormelController {

    private final MessstelleFormelService formeln;
    private final ObjectMapper streng;

    public MessstelleFormelController(MessstelleFormelService formeln, ObjectMapper json) {
        this.formeln = formeln;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /**
     * Recht: {@code messstelle.formel} (AP-10 §4.10, E15 — bis AP-10 IP-3 stand hier
     * {@code messstelle.bearbeiten}). Legt eine berechnete Messstelle mit ihrer Formel an; die
     * Hauptgröße wird abgeleitet, die Terme sind Fassung 1 (gilt seit Beginn).
     */
    @PostMapping("/berechnet")
    @Recht(value = "messstelle.formel", ziel = RechtZiel.DIENST)
    public ResponseEntity<MessstelleDto.Messstelle> anlegen(
            @RequestBody(required = false) MessstelleFormelDto.Anlegen body, Authentication auth) {
        MessstelleDto.Messstelle neu = formeln.anlegen(body, akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/messstellen/" + neu.id())).body(neu);
    }

    /**
     * Recht: {@code messstelle.ansehen}. Die Formel einer berechneten Messstelle AN EINEM TAG: die
     * Terme der Fassung, die an dem Tag gilt, in Reihenfolge, und ihr Stand. Ohne {@code am}: heute —
     * dieselbe Antwort wie vor AP-10 IP-3; mit {@code am} zusätzlich {@code fassung_am}.
     */
    @GetMapping("/{id}/formel")
    public MessstelleFormelDto.Formel formel(@PathVariable UUID id,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate am) {
        return formeln.formel(id, am);
    }

    /**
     * Recht: {@code messstelle.formel} (AP-10 §4.10, E15); mit einem „gültig ab“ vor heute zusätzlich
     * {@code aenderung.rueckwirkend}. Trägt eine neue Fassung der Formel ab einem Tag ein: die laufende
     * endet am Vortag, alles davor bleibt, wie es war; beginnt sie nicht nach der jüngsten Fassung,
     * 422 {@code formel_fassung_ueberlappt}. Antwort 201: die Formel an ihrem ersten Tag.
     */
    @PostMapping("/{id}/formel/fassungen")
    @Recht(value = "messstelle.formel", ziel = RechtZiel.MESSSTELLE)
    public ResponseEntity<MessstelleFormelDto.Formel> fassungEintragen(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        MessstelleFormelDto.FassungEintragen a = lies(body);
        MessstelleFormelDto.Formel neu = formeln.fassungEintragen(id, a, akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/messstellen/" + id + "/formel?am=" + a.gueltigAb()))
                .body(neu);
    }

    /**
     * Recht: {@code messwerte.ansehen}. Der Live-Wert: gewichtete Summe der frischesten Eingänge;
     * {@code null}, wenn unvollständig.
     */
    @GetMapping("/{id}/wert")
    public MessstelleFormelDto.Wert wert(@PathVariable UUID id) {
        return formeln.wert(id);
    }

    /**
     * Recht: {@code messwerte.ansehen}. Der Verlauf: je 15-min-Bucket die Summe, wenn alle Terme
     * einen Wert haben, sonst {@code null}.
     */
    @GetMapping("/{id}/verlauf")
    public MessstelleFormelDto.Verlauf verlauf(@PathVariable UUID id,
            @RequestParam(name = "range", required = false) String range) {
        return formeln.verlauf(id, range);
    }

    /**
     * Die Fassung wird STRENG gelesen: ein Feld, das es nicht gibt, ist 400 — ein camelCase-Feld
     * ({@code gueltigAb}) wäre sonst still leer (snake_case wie {@code MessstelleFormelDto}).
     */
    private MessstelleFormelDto.FassungEintragen lies(JsonNode body) {
        if (body == null || !body.isObject()) {
            throw MessstelleFormelAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        try {
            return streng.treeToValue(body, MessstelleFormelDto.FassungEintragen.class);
        } catch (UnrecognizedPropertyException e) {
            throw MessstelleFormelAbgelehnt.anfrage(pfad(e), "„" + pfad(e) + "“ gibt es hier nicht.");
        } catch (JsonMappingException e) {
            throw MessstelleFormelAbgelehnt.anfrage(pfad(e), "„" + pfad(e) + "“ hat nicht die erwartete Form.");
        } catch (JsonProcessingException e) {
            throw MessstelleFormelAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
    }

    /** {@code terme[1].vorzeichen} — der Weg zum Feld. */
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

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    /** {@code {code, message, …Fakten}} — Code und Status wie der Formel-Vertrag sie nennt. */
    @ExceptionHandler(MessstelleFormelAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(MessstelleFormelAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Eine archivierte Messstelle bekommt keine neue Fassung — der Code des Messstellen-Vertrags. */
    @ExceptionHandler(MessstelleAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> messstelleAbgelehnt(MessstelleAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** {@code ?am=} kein Tag (JJJJ-MM-TT) oder eine ID ohne UUID-Form: dieselbe Form wie jede andere Ablehnung. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keinTag(MethodArgumentTypeMismatchException e) {
        return abgelehnt(MessstelleFormelAbgelehnt.anfrage(e.getName(), "am".equals(e.getName())
                ? "„am“ ist ein Tag (JJJJ-MM-TT)."
                : "„" + e.getName() + "“ hat nicht die erwartete Form."));
    }

    /** Kein lesbares JSON: dieselbe Form wie jede andere Ablehnung der Anfrage. */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(MessstelleFormelAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt."));
    }

    /** 401/403/404: ein deutscher {@code {message}}-Körper wie überall in der API. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> status(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
