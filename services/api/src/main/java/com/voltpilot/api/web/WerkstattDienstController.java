package com.voltpilot.api.web;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.voltpilot.api.werkstatt.FreigabeRepository.Freigabe;
import com.voltpilot.api.werkstatt.FreigabeService;
import java.time.Instant;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der Baum des Werkstatt-Dienstes ({@code services/werkstatt-dienst}) unter
 * {@code /api/v1/werkstatt-dienst}: nur das Dienstkonto mit der Rolle
 * {@code werkstatt-dienst} (Keycloak-Client {@code voltpilot-werkstatt-dienst},
 * nur client_credentials). Bewusst ein EIGENER Baum außerhalb von
 * {@code /api/v1/admin/**}, wie beim Tunnel-Dienst: Die Rolle erreicht dort
 * nichts, und kein Admin- oder Kunden-Token erreicht diesen Baum
 * ({@code SecurityConfig}).
 *
 * <p>Der Dienst darf hier lesen, ob und welche Freigabe läuft. Freigeben,
 * Fenster öffnen, Kunden, Kopplung und Updates erreicht er nicht.
 */
@RestController
@RequestMapping("/api/v1/werkstatt-dienst")
@PreAuthorize("hasRole('werkstatt-dienst')")
public class WerkstattDienstController {

    /** Schema der Freigabe, wie der Dienst sie liest (Go: internal/freigabe, Schema). */
    public static final String SCHEMA = "vp-werkstatt-freigabe.v1";

    /** Das OpenWrt-Abbild im Format des Dienstes. */
    public record AbbildDto(String fassung, String datei, String sha256, String quelle) {
    }

    /** Die Edge-Light-Fassung im Format des Dienstes. */
    public record ProgrammDto(String fassung, String quelle,
            @JsonProperty("programm_sha256") String programmSha256,
            @JsonProperty("skripte_sha256") String skripteSha256) {
    }

    /**
     * Die laufende Freigabe, Feld für Feld wie die Datei der Werkstatt in V1a
     * ({@code freigabe.json}, Schema {@value #SCHEMA}): {@code erteilt_am} ist
     * der Beginn der Gültigkeit.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record FreigabeDto(String schema, String kennung, @JsonProperty("box_art") String boxArt,
            @JsonProperty("erteilt_von") String erteiltVon, @JsonProperty("erteilt_am") Instant erteiltAm,
            @JsonProperty("gueltig_bis") Instant gueltigBis, @JsonProperty("beendet_am") Instant beendetAm,
            int obergrenze, AbbildDto openwrt, @JsonProperty("edge_light") ProgrammDto edgeLight) {
        static FreigabeDto of(Freigabe f) {
            String von = f.erteiltVonName() == null || f.erteiltVonName().isBlank() ? f.erteiltVon() : f.erteiltVonName();
            return new FreigabeDto(SCHEMA, f.kennung(), f.boxArt(), von, f.gueltigAb(), f.gueltigBis(), f.beendetAm(),
                    f.obergrenze(),
                    new AbbildDto(f.openwrt().fassung(), f.openwrt().datei(), f.openwrt().sha256(), f.openwrt().quelle()),
                    new ProgrammDto(f.edgeLight().fassung(), f.edgeLight().quelle(), f.edgeLight().programmSha256(),
                            f.edgeLight().skripteSha256()));
        }
    }

    private final FreigabeService freigaben;

    public WerkstattDienstController(FreigabeService freigaben) {
        this.freigaben = freigaben;
    }

    /** Die laufende Freigabe einer Box-Art (Vorgabe mango); 404, wenn keine läuft. */
    @GetMapping("/freigabe")
    public FreigabeDto freigabe(@RequestParam(name = "boxArt", defaultValue = FreigabeService.MANGO) String boxArt) {
        return freigaben.laufend(boxArt).map(FreigabeDto::of).orElseThrow(() -> new ResponseStatusException(
                HttpStatus.NOT_FOUND, "Die Werkstatt ist für " + boxArt + " nicht freigegeben."));
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> handle(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
