package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.fernwartung.Akteur;
import com.voltpilot.api.werkstatt.LanNetz;
import com.voltpilot.api.werkstatt.WerkstattPruefungen;
import com.voltpilot.api.werkstatt.WerkstattRepository.Abnahme;
import com.voltpilot.api.werkstatt.WerkstattService;
import com.voltpilot.api.werkstatt.WerkstattService.Angelegt;
import com.voltpilot.api.werkstatt.WerkstattService.SchrittStand;
import com.voltpilot.api.werkstatt.WerkstattService.Stand;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
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
 * Die Werkstatt unter {@code /api/v1/admin/werkstatt} (Entscheid des Kapitäns
 * vom 26.10.2026, erster Schnitt aus dem Bericht voltpilot-box-einrichtung-portal):
 * das Register der Boxen, die gerade eingerichtet werden oder wurden, ihre
 * Schritte, ihr LAN-Netz (Entscheid 6a) und die Abnahme nach der
 * Werkstatt-Regel ({@code edge-light/docs/mango.md}).
 *
 * <p><b>Nur VoltPilot-Admins</b>, klassenweit {@code hasRole('platform-admin')},
 * wie die Fernwartung. Eine Box in der Werkstatt gehört noch keinem Mandanten;
 * die Tabellen liest und schreibt nur {@code WerkstattRepository} an der
 * BYPASSRLS-Rolle.
 *
 * <p>Tunnel-Schlüssel und Fenster legt die Seite über die Routen der
 * Fernwartung an; hier entsteht davon nichts. Keine Route nimmt ein Passwort
 * an: das Root-Passwort der Box entsteht im Browser und bleibt dort.
 */
@RestController
@RequestMapping("/api/v1/admin/werkstatt")
@PreAuthorize("hasRole('platform-admin')")
public class AdminWerkstattController {

    // ── Antworten ─────────────────────────────────────────────────────────

    public record SchrittDto(String am, String von) {
        static SchrittDto of(SchrittStand s) {
            return new SchrittDto(s.am(), s.von());
        }
    }

    /**
     * Ein Abnahmeprotokoll. {@code probe} trägt das Fenster der Werkstatt-Probe
     * und was der Tunnel-Dienst dazu gemeldet hatte ({@code schluesselAbgeholtUm}
     * null = keine Meldung nannte es abgeholt): Anzeige, kein Beweis.
     */
    public record AbnahmeDto(UUID id, String edgeRef, String hostSchluessel, String fassung, String tunnelAdresse,
            String lanNetz, List<String> pruefungen, JsonNode probe, String notiz, Instant erfasstAm,
            String erfasstVon) {
    }

    /** Eine Box des Registers; {@code abnahmen} neueste zuerst, leer = noch nicht abgenommen. */
    public record BoxDto(UUID id, String edgeRef, String boxArt, String lanNetz, Map<String, SchrittDto> schritte,
            String notiz, Instant angelegtAm, String angelegtVon, Instant geaendertAm, List<AbnahmeDto> abnahmen) {
    }

    /** Was die Seite vor allem anderen braucht: die geschlossene Liste der Prüfungen und den Vorschlag fürs LAN. */
    public record GrundlagenDto(List<String> pruefungen, String lanNetzVorschlag) {
    }

    // ── Anfragen ──────────────────────────────────────────────────────────

    /** {@code schritte}: was vor dem Aufnehmen schon erledigt war. */
    public record BoxRequest(@NotBlank String edgeRef, String boxArt, List<String> schritte,
            @Size(max = 500) String notiz) {
    }

    public record SchrittRequest(@NotNull Boolean erledigt) {
    }

    public record LanNetzRequest(@NotBlank String lanNetz) {
    }

    public record AbnahmeRequest(String hostSchluessel, String fassung, List<String> pruefungen,
            UUID probeFensterId, @Size(max = 500) String notiz) {
    }

    private final WerkstattService service;
    private final ObjectMapper json;

    public AdminWerkstattController(WerkstattService service, ObjectMapper json) {
        this.service = service;
        this.json = json;
    }

    @GetMapping("/grundlagen")
    public GrundlagenDto grundlagen() {
        return new GrundlagenDto(WerkstattPruefungen.ALLE, LanNetz.VORSCHLAG);
    }

    // ── Register ──────────────────────────────────────────────────────────

    @GetMapping("/boxen")
    public List<BoxDto> boxen() {
        return service.boxen().stream().map(this::boxDto).toList();
    }

    @GetMapping("/boxen/{ref}")
    public BoxDto box(@PathVariable String ref) {
        return boxDto(service.box(referenz(ref)));
    }

    /** Ins Register aufnehmen: 201 neu, 200 schon da (unverändert). */
    @PostMapping("/boxen")
    public ResponseEntity<BoxDto> anlegen(@Valid @RequestBody BoxRequest req, @AuthenticationPrincipal Jwt caller) {
        String edgeRef = referenz(req.edgeRef());
        if (!EdgeRef.isGeneratedFormat(edgeRef) && !service.referenzBekannt(edgeRef)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Die Referenz " + edgeRef + " ist weder eine Box-Referenz mit Prüfzeichen (edge-xxxxxxx) "
                            + "noch der Plattform als Gerät bekannt.");
        }
        Angelegt a = service.anlegen(edgeRef, req.boxArt(), req.schritte(), req.notiz(), Akteur.aus(caller));
        return ResponseEntity.status(a.neu() ? HttpStatus.CREATED : HttpStatus.OK).body(boxDto(a.stand()));
    }

    @PutMapping("/boxen/{ref}/schritte/{schritt}")
    public BoxDto schritt(@PathVariable String ref, @PathVariable String schritt,
            @Valid @RequestBody SchrittRequest req, @AuthenticationPrincipal Jwt caller) {
        return boxDto(service.schritt(referenz(ref), schritt, req.erledigt(), Akteur.aus(caller)));
    }

    @PutMapping("/boxen/{ref}/lan-netz")
    public BoxDto lanNetz(@PathVariable String ref, @Valid @RequestBody LanNetzRequest req,
            @AuthenticationPrincipal Jwt caller) {
        return boxDto(service.lanNetz(referenz(ref), req.lanNetz(), Akteur.aus(caller)));
    }

    // ── Abnahme ───────────────────────────────────────────────────────────

    /** Das Abnahmeprotokoll anlegen: 201. Die Regeln stehen an {@link WerkstattService#abnahme}. */
    @PostMapping("/boxen/{ref}/abnahme")
    public ResponseEntity<AbnahmeDto> abnahme(@PathVariable String ref, @Valid @RequestBody AbnahmeRequest req,
            @AuthenticationPrincipal Jwt caller) {
        Abnahme a = service.abnahme(referenz(ref), req.hostSchluessel(), req.fassung(), req.pruefungen(),
                req.probeFensterId(), req.notiz(), Akteur.aus(caller));
        return ResponseEntity.status(HttpStatus.CREATED).body(abnahmeDto(a));
    }

    // ── intern ────────────────────────────────────────────────────────────

    private BoxDto boxDto(Stand s) {
        Map<String, SchrittDto> schritte = new java.util.LinkedHashMap<>();
        s.schritte().forEach((k, v) -> schritte.put(k, SchrittDto.of(v)));
        return new BoxDto(s.box().id(), s.box().edgeRef(), s.box().boxArt(), s.box().lanNetz(), schritte,
                s.box().notiz(), s.box().angelegtAm(), name(s.box().angelegtVonName(), s.box().angelegtVon()),
                s.box().geaendertAm(), s.abnahmen().stream().map(this::abnahmeDto).toList());
    }

    private AbnahmeDto abnahmeDto(Abnahme a) {
        return new AbnahmeDto(a.id(), a.edgeRef(), a.hostSchluessel(), a.fassung(), a.tunnelAdresse(), a.lanNetz(),
                liste(a.pruefungenJson()), lies(a.probeJson()), a.notiz(), a.erfasstAm(),
                name(a.erfasstVonName(), a.erfasstVon()));
    }

    private JsonNode lies(String text) {
        try {
            return json.readTree(text == null ? "{}" : text);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            return json.createObjectNode();
        }
    }

    private List<String> liste(String text) {
        JsonNode n = lies(text);
        if (!n.isArray()) {
            return List.of();
        }
        List<String> l = new java.util.ArrayList<>();
        n.forEach(e -> l.add(e.asText()));
        return l;
    }

    private static String name(String anzeige, String sub) {
        return anzeige == null || anzeige.isBlank() ? sub : anzeige;
    }

    /** Dieselbe Schreibweise wie Kopplung und Fernwartung; falsches Prüfzeichen = Tippfehler. */
    private static String referenz(String roh) {
        if (roh == null || roh.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Die Box-Referenz fehlt.");
        }
        String ref = DeviceController.canonicalExternalRef(roh);
        if (EdgeRef.isGeneratedFormat(ref) && !EdgeRef.isValid(ref)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Das Prüfzeichen von " + ref + " stimmt nicht - bitte die Referenz an der Box prüfen.");
        }
        return ref;
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> handle(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
