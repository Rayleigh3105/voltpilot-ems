package com.voltpilot.api.web;

import com.voltpilot.api.topology.RollenKonflikt;

import com.voltpilot.api.uems.MessstelleFormelAbgelehnt;
import com.voltpilot.api.uems.MessstelleFormelService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.MessstelleDto;
import com.voltpilot.api.web.dto.MessstelleFormelDto;
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
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die berechnete Messstelle (UEMS AP-10, Formel-Typ „gewichtete Summe"): anlegen mit ihren Termen,
 * die Formel lesen, und Live-Wert und Verlauf lesen. Additiv neben {@link MessstelleController}
 * (dieselbe Basis {@code /api/v1/messstellen}, andere Routen); die Messstelle selbst liest man
 * über {@code GET /api/v1/messstellen/{id}} dort.
 *
 * <p>Der Mandant ist die RLS: eine fremde Messstelle ist 404, nie 403.
 */
@RestController
@RequestMapping("/api/v1/messstellen")
public class MessstelleFormelController {

    private final MessstelleFormelService formeln;

    public MessstelleFormelController(MessstelleFormelService formeln) {
        this.formeln = formeln;
    }

    /**
     * Recht: {@code messstelle.bearbeiten} (AP-04 §6.7). Legt eine berechnete Messstelle mit ihrer
     * Formel an; die Hauptgröße wird abgeleitet.
     */
    @PostMapping("/berechnet")
    public ResponseEntity<MessstelleDto.Messstelle> anlegen(
            @RequestBody(required = false) MessstelleFormelDto.Anlegen body, Authentication auth) {
        MessstelleDto.Messstelle neu = formeln.anlegen(body, akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/messstellen/" + neu.id())).body(neu);
    }

    /**
     * Recht: {@code messstelle.ansehen}. Die Formel einer berechneten Messstelle: ihre Terme in
     * Reihenfolge und ihr Stand.
     */
    @GetMapping("/{id}/formel")
    public MessstelleFormelDto.Formel formel(@PathVariable UUID id) {
        return formeln.formel(id);
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

    /** Kein lesbares JSON: dieselbe Form wie jede andere Ablehnung der Anfrage. */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(MessstelleFormelAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt."));
    }

    /** 401/403/404: ein deutscher {@code {message}}-Körper wie überall in der API. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> status(ResponseStatusException e) {
        if (e instanceof RollenKonflikt k) {
            return ResponseEntity.status(k.getStatusCode()).body(Map.of(
                    "code", k.code(), "message", k.getReason(), "halter", k.halter()));
        }
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
