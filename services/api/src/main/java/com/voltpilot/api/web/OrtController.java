package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.OrtService;
import com.voltpilot.api.uems.OrtsbaumLesemodell.OrtsbaumAmStichtag;
import com.voltpilot.api.web.dto.OrtDto;
import com.voltpilot.api.web.dto.StandortDto;
import java.net.URI;
import java.time.LocalDate;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Gebäude und Bereiche eines Standorts (UEMS AP-02 IP-5): der Ortsbaum zum Stichtag, Anlegen,
 * Bearbeiten und die Fläche ab einem Tag. Die Arbeit macht {@link OrtService}; jede Regel
 * urteilt der Ortsbaum-Vertrag ({@code docs/contracts/v2/ortsbaum-vectors.json}). Die Anfrage
 * liest {@link OrtAnfrage} streng, eine Ablehnung ist {@code {code, message, …Fakten}}
 * ({@link OrtAbgelehntHandler}) — wie beim Standort (IP-4).
 *
 * <p><b>Rechte:</b> bis AP-03 durchsetzt, gilt {@code authenticated()} (SecurityConfig) plus die
 * Mandanten-RLS wie unter {@code /api/v1/standorte} — ein fremder Standort oder Ort ist 404, nie
 * 403 (A14); der Plattform-Admin wählt den Kundenbereich über {@code X-Tenant-Id}. Jede Route
 * nennt ihre Kennung aus {@code docs/contracts/v2/rechte-matrix.json}; eine Rechte-Annotation
 * gibt es hier bewusst nicht. Archivieren, Wiederherstellen und Löschen ohne Historie (IP-15) urteilt
 * derselbe Vertrag wie am Standort. Verschieben (IP-12) ist nicht hier — wer an {@code PUT} schon
 * einen Elternknoten schickt, bekommt 400 {@code anfrage_ungueltig}.
 */
@RestController
public class OrtController {

    private final OrtService orte;
    private final OrtAnfrage anfrage;

    public OrtController(OrtService orte, OrtAnfrage anfrage) {
        this.orte = orte;
        this.anfrage = anfrage;
    }

    // Rechte: heute lesend — keine eigene Kennung; ein Stichtag in der Vergangenheit
    // („Stand am") ist `aenderungsprotokoll.lesen`. Ohne Stichtag gilt heute in der Zeitzone
    // des Standorts.
    @GetMapping("/api/v1/standorte/{standortId}/orte")
    public OrtsbaumAmStichtag ortsbaum(@PathVariable UUID standortId,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE)
            LocalDate stichtag) {
        return orte.ortsbaum(standortId, stichtag).orElseThrow(
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Standort not found"));
    }

    // Rechte: `gebaeude.pflegen`; mit „gültig ab" vor heute zusätzlich `aenderung.rueckwirkend`.
    @PostMapping("/api/v1/standorte/{standortId}/orte")
    public ResponseEntity<OrtDto.Ort> anlegen(@PathVariable UUID standortId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        OrtDto.Ort neu = orte.anlegen(standortId, anfrage.lies(body, OrtDto.Anlegen.class, false),
                OrtAnfrage.akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/orte/" + neu.id())).body(neu);
    }

    // Rechte: `gebaeude.pflegen`.
    @PutMapping("/api/v1/orte/{ortId}")
    public OrtDto.Ort bearbeiten(@PathVariable UUID ortId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return orte.bearbeiten(ortId, anfrage.lies(body, OrtDto.Bearbeiten.class, false),
                OrtAnfrage.akteur(auth));
    }

    // Rechte: `gebaeude.pflegen`; mit „gültig ab" vor heute zusätzlich `aenderung.rueckwirkend`.
    @PutMapping("/api/v1/orte/{ortId}/flaeche")
    public OrtDto.Ort flaeche(@PathVariable UUID ortId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return orte.flaecheSetzen(ortId, anfrage.lies(body, OrtDto.Flaeche.class, false),
                OrtAnfrage.akteur(auth));
    }

    // Rechte: `gebaeude.pflegen`. Ohne Inhalt: es gibt nichts zu wählen — archiviert wird ab heute (IP-15).
    @PostMapping("/api/v1/orte/{ortId}/archivieren")
    public OrtDto.Ort archivieren(@PathVariable UUID ortId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        OrtAnfrage.leer(body);
        return orte.archivieren(ortId, OrtAnfrage.akteur(auth));
    }

    // Rechte: `gebaeude.pflegen`. Optional `{"name": …}` — das Umbenennen im selben Dialog (IP-15).
    @PostMapping("/api/v1/orte/{ortId}/wiederherstellen")
    public OrtDto.Ort wiederherstellen(@PathVariable UUID ortId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return orte.wiederherstellen(ortId, anfrage.lies(body, StandortDto.Wiederherstellen.class, true),
                OrtAnfrage.akteur(auth));
    }

    // Rechte: `gebaeude.pflegen`. Nur ohne Historie (E1) — sonst 409 `loeschen_gesperrt` (IP-15).
    @DeleteMapping("/api/v1/orte/{ortId}")
    public ResponseEntity<Void> loeschen(@PathVariable UUID ortId, Authentication auth) {
        orte.loeschen(ortId, OrtAnfrage.akteur(auth));
        return ResponseEntity.noContent().build();
    }
}
