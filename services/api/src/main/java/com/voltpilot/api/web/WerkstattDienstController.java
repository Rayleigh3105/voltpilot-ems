package com.voltpilot.api.web;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.voltpilot.api.fernwartung.Akteur;
import com.voltpilot.api.werkstatt.EinloesungRepository;
import com.voltpilot.api.werkstatt.EinloesungService;
import com.voltpilot.api.werkstatt.FreigabeRepository.Freigabe;
import com.voltpilot.api.werkstatt.FreigabeService;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.CacheControl;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
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
 * <p>Der Dienst darf hier lesen, ob und welche Freigabe läuft; in einer
 * laufenden Freigabe Einmal-Codes für ungekoppelte Boxen holen; lesen, was eine
 * Box beim Einlösen gemeldet hat; und das Probe-Fenster schließen, das eine
 * Einlösung geöffnet hat - kein anderes. Freigeben, Fenster öffnen, Kunden,
 * Kopplung und Updates erreicht er nicht.
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

    /** Code holen: für genau diese Box; {@code tausch} nur für eine neu aufgespielte, ungekoppelte Box. */
    public record CodeRequest(String edgeRef, Boolean tausch) {
    }

    /** Der Code steht nur in dieser Antwort und nur einmal. */
    public record CodeDto(String code, String edgeRef, String freigabe, Instant gueltigBis, boolean tausch) {
    }

    /** Was eine Box beim Einlösen gemeldet hat und was sie bekam. */
    public record EinloesungDto(UUID id, String edgeRef, UUID freigabeId, String fassung, String geraeteSchluesselSha256,
            String wireguardSchluessel, String hostSchluessel, String tunnelAdresse, UUID fensterId, boolean tausch,
            Instant eingeloestAm) {
        static EinloesungDto of(EinloesungRepository.Einloesung e) {
            return new EinloesungDto(e.id(), e.edgeRef(), e.freigabeId(), e.fassung(), e.geraeteSchluesselSha256(),
                    e.wireguardSchluessel(), e.hostSchluessel(), e.tunnelAdresse(), e.fensterId(), e.tausch(),
                    e.eingeloestAm());
        }
    }

    /** Der festgehaltene Geräteschlüssel einer Box (D2). */
    public record FestgehaltenDto(String sha256, Instant festgehaltenAm, UUID einloesungId) {
    }

    /** Der Stand einer Box beim Einlösen: festgehalten oder nicht, und die Einlösungen, neueste zuerst. */
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record BoxStandDto(String edgeRef, FestgehaltenDto festgehalten, List<EinloesungDto> einloesungen) {
    }

    /** Ein geschlossenes Probe-Fenster. */
    public record FensterDto(UUID id, String edgeRef, UUID technikerId, Instant beginn, Instant ende,
            Instant geschlossenAm) {
    }

    private final FreigabeService freigaben;
    private final EinloesungService einloesung;

    public WerkstattDienstController(FreigabeService freigaben, EinloesungService einloesung) {
        this.freigaben = freigaben;
        this.einloesung = einloesung;
    }

    /** Die laufende Freigabe einer Box-Art (Vorgabe mango); 404, wenn keine läuft. */
    @GetMapping("/freigabe")
    public FreigabeDto freigabe(@RequestParam(name = "boxArt", defaultValue = FreigabeService.MANGO) String boxArt) {
        return freigaben.laufend(boxArt).map(FreigabeDto::of).orElseThrow(() -> new ResponseStatusException(
                HttpStatus.NOT_FOUND, "Die Werkstatt ist für " + boxArt + " nicht freigegeben."));
    }

    /** Einmal-Code holen: 201; 409 ohne laufende Freigabe, gekoppelt, mit Zertifikat, Obergrenze; 422 Kennung. */
    @PostMapping("/codes")
    public ResponseEntity<CodeDto> code(@RequestBody CodeRequest req, @AuthenticationPrincipal Jwt caller) {
        EinloesungService.Ausgabe a = einloesung.codeAusgeben(req == null ? null : req.edgeRef(),
                req != null && Boolean.TRUE.equals(req.tausch()), Akteur.aus(caller));
        return ResponseEntity.status(HttpStatus.CREATED).cacheControl(CacheControl.noStore())
                .body(new CodeDto(a.code(), a.edgeRef(), a.freigabe(), a.gueltigBis(), a.tausch()));
    }

    /** Was die Box beim Einlösen gemeldet hat (leer, solange sie nicht eingelöst hat). */
    @GetMapping("/einloesungen/{edgeRef}")
    public BoxStandDto einloesungen(@PathVariable String edgeRef) {
        FestgehaltenDto fest = einloesung.festgehalten(edgeRef)
                .map(f -> new FestgehaltenDto(f.geraeteSchluesselSha256(), f.festgehaltenAm(), f.einloesungId()))
                .orElse(null);
        return new BoxStandDto(edgeRef, fest, einloesung.einloesungen(edgeRef).stream().map(EinloesungDto::of).toList());
    }

    /** Das Probe-Fenster einer Einlösung schließen: 200; 404 für jedes andere Fenster; 409 schon zu. */
    @PostMapping("/fenster/{id}/schliessen")
    public FensterDto fensterSchliessen(@PathVariable UUID id, @AuthenticationPrincipal Jwt caller) {
        var f = einloesung.probeFensterSchliessen(id, Akteur.aus(caller));
        return new FensterDto(f.id(), f.edgeRef(), f.technikerId(), f.beginn(), f.ende(), f.geschlossenAm());
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> handle(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
