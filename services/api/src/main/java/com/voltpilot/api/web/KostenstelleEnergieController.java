package com.voltpilot.api.web;

import com.voltpilot.api.uems.BilanzAbgelehnt;
import com.voltpilot.api.uems.KostenstelleEnergieService;
import com.voltpilot.api.uems.MessstelleAbgelehnt;
import com.voltpilot.api.web.dto.KostenstelleEnergieDto;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Kostenstellen-Sicht (UEMS AP-10 IP-11): gemessen · verteilt · berechnet · nicht verteilt je Periode.
 *
 * <p><b>Rechte:</b> es gilt {@code authenticated()} (SecurityConfig) plus die Mandantengrenze aus dem JWT. Die Kennung
 * steht an der Route ({@code RechteKennungenDerRoutenTest} hält sie an die Matrix); gelesen wird über die Geltung
 * Unternehmen der Kostenstelle ({@link RechtPruefung#pruefenLesen}, AP-03 R-A1).
 */
@RestController
@RequestMapping("/api/v1/unternehmen/kostenstellen")
public class KostenstelleEnergieController {

    private final KostenstelleEnergieService dienst;
    private final RechtPruefung rechte;

    public KostenstelleEnergieController(KostenstelleEnergieService dienst, RechtPruefung rechte) {
        this.dienst = dienst;
        this.rechte = rechte;
    }

    /**
     * Recht: {@code messstelle.ansehen} (AP-10 §4.10: „Lesen der Bilanz, Verteilung und Herkunft“). Die Periode
     * {@code tag} · {@code monat} (Vorgabe) · {@code jahr}, die {@code am} enthält (Vorgabe: heute in der Zeitzone des
     * Unternehmens); {@code version} optional — je Tag die höchste Version bis dahin, ohne Angabe die neueste.
     * Geltung Unternehmen (AP-03 R-A1, §4.9): die Bilanz sieht nur eine unternehmensweite Rolle; jedes andere Konto
     * bekommt Status und Körper einer Kostenstelle, die es nicht gibt.
     */
    @GetMapping("/{id}/energie")
    public KostenstelleEnergieDto.Energie energie(@PathVariable UUID id,
            @RequestParam(required = false) String periode,
            @RequestParam(required = false) String am,
            @RequestParam(required = false) String version) {
        return dienst.energie(id, periode, tag(am), version, k -> rechte.pruefenLesen(RechtZiel.UNTERNEHMEN, k,
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Kostenstelle nicht gefunden.")));
    }

    private static LocalDate tag(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        try {
            return LocalDate.parse(text.strip());
        } catch (DateTimeParseException e) {
            throw BilanzAbgelehnt.anfrage("am", "„am“ ist ein Tag (JJJJ-MM-TT).");
        }
    }

    /** {@code {code, message, …Fakten}} — dieselbe Form wie die Bilanz-Routen. */
    @ExceptionHandler(BilanzAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(BilanzAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Eine Ablehnung aus dem Lese-Modell „Werte je Messstelle“, das diese Sicht aufruft. */
    @ExceptionHandler(MessstelleAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> messstelle(MessstelleAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** 404: ein deutscher {@code {message}}-Körper wie überall in der API. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> status(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
