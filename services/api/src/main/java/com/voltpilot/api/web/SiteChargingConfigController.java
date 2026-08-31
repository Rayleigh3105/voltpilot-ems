package com.voltpilot.api.web;

import com.voltpilot.api.chargers.ChargingConfigService;
import com.voltpilot.api.web.dto.ChargingConfigDto;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
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
 * Die Lastmanagement-Konfiguration einer Anlage: die Anschlussgrenze, die der
 * Aktivieren-Dialog der Steuerungs-Karte abfragt, und die Vorrang-Wahl je Säule
 * (Lastmanagement Stufe 3, PR 12).
 *
 * <p>Mandantenbezogen wie jede {@code /api/v1/sites/**}-Route: KEIN
 * {@code @PreAuthorize}, Authentifizierung + RLS sind der Zaun, eine fremde
 * Anlage ist 404, Admins über den {@code X-Tenant-Id}-Umschalter.
 *
 * <p><b>Es ist eine WUNSCH-Route, kein Steuerpfad.</b> Was hier gespeichert
 * wird, reist als retained Dokument zur Box; GERECHNET und DURCHGESETZT wird
 * dort (Konzept E1). Der Kunde besitzt genau die zwei Größen, die ihm gehören:
 * seinen Anschluss und die Frage, welches Fahrzeug zuerst laden soll -
 * Sicherheitsabstand, Mindestleistung und die höchste Gebäudelast bleiben „von
 * VoltPilot eingerichtet" auf der Box.
 *
 * <p><b>PATCH-Semantik:</b> ein abwesendes Feld behält den gespeicherten Wert.
 * Ein Dialog, der nur den Vorrang stellt, darf die Anschlussgrenze nicht
 * löschen.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}")
public class SiteChargingConfigController {

    /** Der Rumpf: beide Felder OPTIONAL (PATCH-Semantik). */
    public record SaveChargingConfigRequest(Double gridLimitKw,
            @Size(max = 64) List<@Size(max = 64) String> priorityChargePointIds,
            /*
             * Stufe 4: die QUELLEN-Wahl. Beide optional wie alles hier - ein
             * abwesendes Feld behält den gespeicherten Wert, und ein Dialog,
             * der nur die Priorität stellt, darf die Grenze nicht löschen.
             */
            @Size(max = 32) String surplusPolicy, @Size(max = 32) String storagePriority) {}

    /**
     * Der Rumpf des Anbinde-Assistenten: nur die Kennung ist Pflicht, alles
     * Weitere ist das, was der Betreiber zufällig schon weiß.
     */
    public record AdmitChargePointRequest(@NotBlank @Size(max = 64) String chargePointId,
            @Size(max = 120) String label, Double ratedKw, Integer connectors,
            /*
             * connection = WO die Saeule haengt (Cockpit Phase 1 / C1):
             * "haus" (hinter dem Hausanschluss, die Vorgabe des Dialogs) oder
             * "eigen" (eigener Netzanschluss/Zaehler). null = dazu wird nichts
             * gesagt; ein unbekanntes Wort ist eine BENANNTE Ablehnung, nie ein
             * stiller Rueckfall - siehe ChargingConfigService.admit.
             */
            @Size(max = 16) String connection,
            /*
             * source/minKw = die STEUERART dieser Saeule (P5). Beide optional:
             * null heisst „fuer sie aeussert sich das Portal nicht" und es gilt
             * der ANLAGEN-STANDARD (surplusPolicy oben).
             */
            @Size(max = 32) String source, Double minKw) {}

    /**
     * Der Rumpf der Steuerart je Säule (P5): beide Felder optional, aber nicht
     * beide zugleich leer - eine Anfrage, die nichts sagt, ist keine.
     */
    public record SaveChargePointSourceRequest(@Size(max = 32) String source, Double minKw) {}

    private final ChargingConfigService service;

    public SiteChargingConfigController(ChargingConfigService service) {
        this.service = service;
    }

    @GetMapping("/charging-config")
    public ChargingConfigDto read(@PathVariable UUID siteId) {
        return service.read(siteId);
    }

    @PutMapping("/charging-config")
    public ChargingConfigDto save(@PathVariable UUID siteId,
            @Valid @RequestBody SaveChargingConfigRequest req,
            @AuthenticationPrincipal Jwt caller) {
        return service.save(siteId, req.gridLimitKw(), req.priorityChargePointIds(),
                req.surplusPolicy(), req.storagePriority(),
                caller == null ? "unbekannt" : caller.getSubject());
    }

    /**
     * Trägt EINE Ladesäule in die Allowlist ein (Anbinde-Assistent, Schritt 1).
     *
     * <p><b>Es ist ein POST, kein PUT</b>, und das ist die Aussage: die Liste
     * fügt nur hinzu. Ein PUT lüde dazu ein, sie als Ganzes zu setzen - und
     * damit einen Eintrag durch WEGLASSEN zu entfernen. Eine Kennung
     * zurückzunehmen ist eine eigene, ausdrückliche Handlung (DELETE unten).
     */
    @PostMapping("/charging-config/charge-points")
    public ChargingConfigDto admit(@PathVariable UUID siteId,
            @Valid @RequestBody AdmitChargePointRequest req,
            @AuthenticationPrincipal Jwt caller) {
        return service.admit(siteId, req.chargePointId(), req.label(), req.ratedKw(),
                req.connectors(), req.source(), req.minKw(), req.connection(),
                caller == null ? "unbekannt" : caller.getSubject());
    }

    /**
     * Setzt die STEUERART einer eingetragenen Säule (P5, Steuerart je
     * Ladepunkt).
     *
     * <p>Sie gehört dem KUNDEN - es ist seine Anlage und seine Frage, woher der
     * Ladestrom kommen soll -, also steht sie hier und nicht hinter
     * {@code /admin/**}. Sie ändert keine Grenze: die physische Bahn bindet
     * unverändert, und die zwei komponieren most-restrictive-wins.
     */
    @PutMapping("/charging-config/charge-points/{chargePointId}/source")
    public ChargingConfigDto setChargePointSource(@PathVariable UUID siteId,
            @PathVariable String chargePointId,
            @Valid @RequestBody SaveChargePointSourceRequest req) {
        return service.setChargePointSource(siteId, chargePointId, req.source(), req.minKw());
    }

    /**
     * Nimmt EINE Ladepunkt-Kennung zurück (Captain-Order 24.08.2026).
     *
     * <p><b>Es ist ein DELETE auf GENAU EINE Kennung</b>, nie ein Setzen der
     * ganzen Liste: eine Rücknahme hat Folgen für eine laufende Anlage (die
     * Säule wird getrennt und ein Wiederverbinden abgewiesen), und die soll
     * niemand als Nebenwirkung eines Speicherns auslösen können.
     *
     * <p>Eine Kennung, die diese Anlage nicht (mehr) führt, ist ein 404 - nie
     * ein stiller Erfolg über etwas, das es nicht gab.
     */
    @DeleteMapping("/charging-config/charge-points/{chargePointId}")
    public ChargingConfigDto remove(@PathVariable UUID siteId,
            @PathVariable String chargePointId, @AuthenticationPrincipal Jwt caller) {
        return service.remove(siteId, chargePointId,
                caller == null ? "unbekannt" : caller.getSubject());
    }

    /** Jede Ablehnung erreicht die Oberfläche als deutscher {@code {message}}-Körper. */
    @ExceptionHandler(ResponseStatusException.class)
    ResponseEntity<Object> handle(ResponseStatusException e) {
        HttpStatus status = HttpStatus.valueOf(e.getStatusCode().value());
        String message = e.getReason() == null ? status.getReasonPhrase() : e.getReason();
        return ResponseEntity.status(status).body(java.util.Map.of("message", message));
    }
}
