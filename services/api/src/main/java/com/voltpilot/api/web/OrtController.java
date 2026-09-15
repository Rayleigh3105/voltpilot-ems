package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.OrtAbgelehnt;
import com.voltpilot.api.uems.OrtService;
import com.voltpilot.api.uems.OrtVerschiebenService;
import com.voltpilot.api.uems.OrtsbaumLesemodell.OrtsbaumAmStichtag;
import com.voltpilot.api.web.dto.OrtDto;
import com.voltpilot.api.web.dto.OrtVerschiebungDto;
import com.voltpilot.api.web.dto.StandortDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.net.URI;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
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
 * <p><b>Rechte:</b> es gilt {@code authenticated()} (SecurityConfig) plus die
 * Mandanten-RLS wie unter {@code /api/v1/standorte} — ein fremder Standort oder Ort ist 404, nie
 * 403 (A14); der Plattform-Admin wählt den Kundenbereich über {@code X-Tenant-Id}. Jede Route
 * nennt ihre Kennung aus {@code docs/contracts/v2/rechte-matrix.json}; seit AP-03 IP-6 setzt {@code @Recht} sie
 * vor dem Handler durch (403 {@code recht_fehlt}, außerhalb des Geltungsbereichs 404). Archivieren, Wiederherstellen
 * und Löschen ohne Historie (IP-15) urteilt
 * derselbe Vertrag wie am Standort. Verschieben (IP-12) hat eigene Routen mit Folgen-Vorschau
 * ({@link OrtVerschiebenService}) — wer an {@code PUT} einen Elternknoten schickt, bekommt 400
 * {@code anfrage_ungueltig}.
 */
@RestController
public class OrtController {

    private final OrtService orte;
    private final OrtVerschiebenService verschieben;
    private final OrtAnfrage anfrage;
    private final RechtPruefung rechte;

    public OrtController(OrtService orte, OrtVerschiebenService verschieben, OrtAnfrage anfrage, RechtPruefung rechte) {
        this.orte = orte;
        this.verschieben = verschieben;
        this.anfrage = anfrage;
        this.rechte = rechte;
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
    @Recht(value = "gebaeude.pflegen", ziel = RechtZiel.STANDORT)
    public ResponseEntity<OrtDto.Ort> anlegen(@PathVariable UUID standortId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        OrtDto.Anlegen a = anfrage.lies(body, OrtDto.Anlegen.class, false);
        rechte.rueckwirkend(a.gueltigAb());
        OrtDto.Ort neu = orte.anlegen(standortId, a, OrtAnfrage.akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/orte/" + neu.id())).body(neu);
    }

    // Rechte: `gebaeude.pflegen`.
    @PutMapping("/api/v1/orte/{ortId}")
    @Recht(value = "gebaeude.pflegen", ziel = RechtZiel.ORT)
    public OrtDto.Ort bearbeiten(@PathVariable UUID ortId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return orte.bearbeiten(ortId, anfrage.lies(body, OrtDto.Bearbeiten.class, false),
                OrtAnfrage.akteur(auth));
    }

    // Rechte: `gebaeude.pflegen`; mit „gültig ab" vor heute zusätzlich `aenderung.rueckwirkend`.
    @PutMapping("/api/v1/orte/{ortId}/flaeche")
    @Recht(value = "gebaeude.pflegen", ziel = RechtZiel.ORT)
    public OrtDto.Ort flaeche(@PathVariable UUID ortId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        OrtDto.Flaeche f = anfrage.lies(body, OrtDto.Flaeche.class, false);
        rechte.rueckwirkend(f.gueltigAb());
        return orte.flaecheSetzen(ortId, f, OrtAnfrage.akteur(auth));
    }

    // Rechte: `gebaeude.pflegen`. Ohne Inhalt: es gibt nichts zu wählen — archiviert wird ab heute (IP-15).
    @PostMapping("/api/v1/orte/{ortId}/archivieren")
    @Recht(value = "gebaeude.pflegen", ziel = RechtZiel.ORT)
    public OrtDto.Ort archivieren(@PathVariable UUID ortId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        OrtAnfrage.leer(body);
        return orte.archivieren(ortId, OrtAnfrage.akteur(auth));
    }

    // Rechte: `gebaeude.pflegen`. Optional `{"name": …}` — das Umbenennen im selben Dialog (IP-15).
    @PostMapping("/api/v1/orte/{ortId}/wiederherstellen")
    @Recht(value = "gebaeude.pflegen", ziel = RechtZiel.ORT)
    public OrtDto.Ort wiederherstellen(@PathVariable UUID ortId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return orte.wiederherstellen(ortId, anfrage.lies(body, StandortDto.Wiederherstellen.class, true),
                OrtAnfrage.akteur(auth));
    }

    // Rechte: `gebaeude.pflegen`. Nur ohne Historie (E1) — sonst 409 `loeschen_gesperrt` (IP-15).
    @DeleteMapping("/api/v1/orte/{ortId}")
    @Recht(value = "gebaeude.pflegen", ziel = RechtZiel.ORT)
    public ResponseEntity<Void> loeschen(@PathVariable UUID ortId, Authentication auth) {
        orte.loeschen(ortId, OrtAnfrage.akteur(auth));
        return ResponseEntity.noContent().build();
    }

    // Rechte: `gebaeude.pflegen` — die Vorschau gehört zum Dialog „Verschieben" (V2/V3); schreibt nichts.
    @GetMapping("/api/v1/orte/{ortId}/verschieben/vorschau")
    public OrtVerschiebungDto.Verschiebung verschiebenVorschau(@PathVariable UUID ortId,
            @RequestParam(required = false) String zielId,
            @RequestParam(required = false) String gueltigAb) {
        return verschieben.vorschau(ortId, uuid(zielId), tag(gueltigAb));
    }

    // Rechte: `gebaeude.pflegen`; mit „gültig ab" vor heute zusätzlich `aenderung.rueckwirkend` (IP-12, V4).
    @PostMapping("/api/v1/orte/{ortId}/verschieben")
    @Recht(value = "gebaeude.pflegen", ziel = RechtZiel.ORT)
    public OrtVerschiebungDto.Verschiebung verschieben(@PathVariable UUID ortId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        OrtVerschiebungDto.Anfrage a = anfrage.lies(body, OrtVerschiebungDto.Anfrage.class, false);
        // Das Recht auch am neuen Elternknoten (UEMS AP-03 IP-6) — er steht im Körper, nicht im Pfad.
        rechte.pruefenStandortOderOrt("gebaeude.pflegen", a.zielId(),
                () -> OrtAbgelehnt.anfrage("zielId", "Dieses Ziel gibt es nicht."));
        rechte.rueckwirkend(a.gueltigAb());
        return verschieben.verschieben(ortId, a, OrtAnfrage.akteur(auth));
    }

    private static UUID uuid(String roh) {
        if (roh == null || roh.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(roh);
        } catch (IllegalArgumentException e) {
            throw OrtAbgelehnt.anfrage("zielId", "„zielId“ hat nicht die erwartete Form.");
        }
    }

    private static LocalDate tag(String roh) {
        if (roh == null || roh.isBlank()) {
            return null;
        }
        try {
            return LocalDate.parse(roh);
        } catch (DateTimeParseException e) {
            throw OrtAbgelehnt.anfrage("gueltigAb", "„gueltigAb“ hat nicht die erwartete Form.");
        }
    }
}
