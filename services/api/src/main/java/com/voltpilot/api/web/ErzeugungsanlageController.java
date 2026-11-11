package com.voltpilot.api.web;

import com.voltpilot.api.erzeugungsanlage.ErzeugungsanlageService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.ErzeugungsanlagenDto;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
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
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Erzeugungsanlagen einer Anlage (Messkonzepte S1, NUR ANZEIGE): lesen mit Satz und Herkunft je EA, anlegen
 * (MaStR-Nachschlagen über die vorhandene Route {@code POST …/mastr-lookup}), Identität ändern, Fassung ab einem Tag,
 * Komponenten verweisen und lösen, aufheben. Fahrplan, Erlöse und Box rechnen weiter mit dem Satz der Anlage.
 *
 * <p>Mandantenbegrenzt wie jede {@code /api/v1/sites/**}-Route: Anmeldung, Postgres-RLS und der Standortzaun sind der
 * Zaun, eine fremde Anlage ist 404 (nie 403). Schreiben mit {@code geraet.einrichten} - demselben Recht wie das
 * Übernehmen aus dem Marktstammdatenregister ({@link MastrController}).
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/erzeugungsanlagen")
public class ErzeugungsanlageController {

    private final ErzeugungsanlageService service;
    private final Geltungsbereich geltungsbereich;

    public ErzeugungsanlageController(ErzeugungsanlageService service, Geltungsbereich geltungsbereich) {
        this.service = service;
        this.geltungsbereich = geltungsbereich;
    }

    @GetMapping
    public ErzeugungsanlagenDto lesen(@PathVariable UUID siteId,
            @RequestParam(name = "stichtag", required = false) String stichtag) {
        geltungsbereich.requireSite(siteId);
        return service.lesen(siteId, tag(stichtag));
    }

    @PostMapping
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
    public ResponseEntity<ErzeugungsanlagenDto> anlegen(@PathVariable UUID siteId,
            @RequestBody(required = false) ErzeugungsanlagenDto.Anlegen body, Authentication auth) {
        geltungsbereich.requireSite(siteId);
        return ResponseEntity.status(HttpStatus.CREATED).body(service.anlegen(siteId, body, akteur(auth)));
    }

    @PutMapping("/{eaId}")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
    public ErzeugungsanlagenDto bearbeiten(@PathVariable UUID siteId, @PathVariable UUID eaId,
            @RequestBody(required = false) ErzeugungsanlagenDto.Bearbeiten body, Authentication auth) {
        geltungsbereich.requireSite(siteId);
        return service.bearbeiten(siteId, eaId, body, akteur(auth));
    }

    @PostMapping("/{eaId}/fassungen")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
    public ErzeugungsanlagenDto fassung(@PathVariable UUID siteId, @PathVariable UUID eaId,
            @RequestBody(required = false) ErzeugungsanlagenDto.FassungSetzen body, Authentication auth) {
        geltungsbereich.requireSite(siteId);
        return service.fassungSetzen(siteId, eaId, body, akteur(auth));
    }

    @PostMapping("/{eaId}/komponenten")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
    public ErzeugungsanlagenDto verweisen(@PathVariable UUID siteId, @PathVariable UUID eaId,
            @RequestBody(required = false) ErzeugungsanlagenDto.Verweisen body, Authentication auth) {
        geltungsbereich.requireSite(siteId);
        return service.verweisen(siteId, eaId, body, akteur(auth));
    }

    @PostMapping("/{eaId}/komponenten/{verweisId}/loesen")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
    public ErzeugungsanlagenDto verweisLoesen(@PathVariable UUID siteId, @PathVariable UUID eaId,
            @PathVariable UUID verweisId, Authentication auth) {
        geltungsbereich.requireSite(siteId);
        return service.verweisLoesen(siteId, eaId, verweisId, akteur(auth));
    }

    @PostMapping("/{eaId}/aufheben")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
    public ErzeugungsanlagenDto aufheben(@PathVariable UUID siteId, @PathVariable UUID eaId, Authentication auth) {
        geltungsbereich.requireSite(siteId);
        return service.aufheben(siteId, eaId, akteur(auth));
    }

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    private static LocalDate tag(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        try {
            return LocalDate.parse(text.strip());
        } catch (DateTimeParseException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Der Stichtag ist ein Tag in der Form JJJJ-MM-TT.");
        }
    }

    /** Deutsche Gründe erreichen das Portal als {"message": ...} (Muster SiteEinspeiseverguetungController). */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
