package com.voltpilot.api.web;

import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.verbraucher.RanglisteAbleitung;
import com.voltpilot.api.verbraucher.RanglisteService;
import com.voltpilot.api.verbraucher.SteuerartService;
import com.voltpilot.api.verbraucher.SteuerartWunsch;
import com.voltpilot.api.verbraucher.VerbraucherService;
import com.voltpilot.api.web.dto.VerbraucherDto;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Zone „Verbraucher" einer Anlage (Konzept
 * {@code vp-verbrauchsmgmt-konzept-v1} §6, Paket P1).
 *
 * <p>Mandantenbezogen wie jede {@code /api/v1/sites/**}-Route
 * ({@link SiteConsumerController}, {@link SiteChargerController}): KEIN
 * {@code @PreAuthorize}, Authentifizierung + Postgres-RLS sind der Zaun, eine
 * fremde Anlage ist 404 (nie 403), und ein Admin erreicht sie ueber den
 * {@code X-Tenant-Id}-Umschalter auf demselben RLS-Pfad.
 *
 * <p><b>Seit Paket P2 gibt es GENAU EINEN Schreibweg der Steuerart</b>
 * ({@code PUT .../verbraucher/{entityId}/steuerart}). Er schreibt kein neues
 * Format: er stellt ein {@code consumer_profile} sicher, legt die
 * Requirement-Projektion (§3.3) als neue Policy-Fassung ab und aktiviert sie
 * ueber den BESTEHENDEN Pfad - mit dessen Kompilierung, V-5-Pruefung, Flag-Toren
 * und Audit-Spur. Eine Komponente, die hier nicht schreibbar ist, sagt das in
 * ihren {@code optionen}, statt eine Auswahl anzubieten, die der Server danach
 * ablehnt.
 *
 * <p>Was seit Paket P4 dazu gekommen ist, ist die REIHENFOLGE bei knapper
 * Leistung ({@code PUT /rangliste}), und auch sie schreibt kein neues Format:
 * sie projiziert auf {@code default_service_rank}, {@code storage_relation} und
 * die Speicher-Frage des Ladeparks ({@link RanglisteService}). Der
 * ANLAGEN-STANDARD der Ladepunkte bleibt bewusst ungeschrieben (Paket P5).
 *
 * <p>Eine Anlage ohne steuerbares Geraet bekommt eine wohlgeformte LEERE
 * Antwort - der Normalzustand vieler Anlagen, kein Fehler.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}")
public class SiteVerbraucherController {

    /**
     * Der Rumpf der Rangliste: die Liste FLACH, ein Geraet je Eintrag, von oben
     * nach unten. Eine Gruppe gleichrangiger Ladepunkte schickt der Client als
     * ihre Mitglieder hintereinander - der Server gruppiert beim Lesen wieder.
     */
    public record RanglisteRequest(
            @Size(max = 200) List<@NotNull @Valid RanglisteEintragRequest> eintraege) {}

    /**
     * Ein Platz. {@code art} ist {@code speicher} (dann ohne {@code entityId}),
     * {@code ladepunkt} oder {@code verbraucher}.
     *
     * <p><b>⚠ Bei einem Geraet wird die Art nicht gegengeprueft</b> - ob eine
     * Komponente fuer den Kunden ein „Ladepunkt" heisst, ist eine Frage der
     * Darstellung und darf sich aendern, ohne einen aelteren Client
     * auszusperren. Entscheidend ist die Kennung; nur der Speicher-Platz braucht
     * sein Wort, weil er keine Kennung hat.
     */
    public record RanglisteEintragRequest(@NotNull @Size(max = 32) String art, UUID entityId) {}

    private final SiteRepository sites;
    private final VerbraucherService verbraucher;
    private final RanglisteService rangliste;
    private final SteuerartService steuerarten;

    public SiteVerbraucherController(SiteRepository sites, VerbraucherService verbraucher,
            RanglisteService rangliste, SteuerartService steuerarten) {
        this.sites = sites;
        this.verbraucher = verbraucher;
        this.rangliste = rangliste;
        this.steuerarten = steuerarten;
    }

    @GetMapping("/verbraucher")
    public VerbraucherDto verbraucher(@PathVariable UUID siteId) {
        requireSite(siteId);
        return verbraucher.forSite(siteId);
    }

    /**
     * Setzt die Steuerart EINER Komponente (Paket P2).
     *
     * <p>Der Rumpf ist die SPIEGELFORM der gelesenen Steuerart
     * ({@link SteuerartWunsch}), damit der Rundlauf pruefbar bleibt: was der
     * Dialog schickt, liest die Projektion danach wieder aus. Die Antwort
     * traegt die Steuerart, wie sie JETZT gilt, plus das Ergebnis der
     * Aktivierung - eine abgelehnte Aktivierung ist kein Fehler, sondern ein
     * benannter Ausgang ({@code aktiv:false} mit Grund und Satz), und der
     * Entwurf bleibt gespeichert.
     */
    @PutMapping("/verbraucher/{entityId}/steuerart")
    public SteuerartService.Ergebnis setzeSteuerart(@PathVariable UUID siteId,
            @PathVariable UUID entityId, @RequestBody SteuerartWunsch wunsch,
            @AuthenticationPrincipal Jwt jwt) {
        requireSite(siteId);
        return steuerarten.setze(siteId, entityId, wunsch, jwt == null ? null : jwt.getSubject());
    }

    /**
     * Setzt die Reihenfolge bei knapper Leistung und liefert die Zone zurueck,
     * wie sie danach GELESEN wird (die Normalform - siehe
     * {@code RanglisteProjektion}).
     */
    @PutMapping("/rangliste")
    public VerbraucherDto rangliste(@PathVariable UUID siteId,
            @Valid @RequestBody RanglisteRequest req, @AuthenticationPrincipal Jwt caller) {
        requireSite(siteId);
        // ⚠ Die LEERE Liste wird bewusst NICHT per Bean-Validation abgelehnt:
        // sie feuerte vor dem Dienst und der Kunde bekaeme ein nacktes 400
        // statt des deutschen Satzes, den `RanglisteAbleitung.pruefe` dafuer
        // hat. Eine Kunden-Flaeche braucht die Auskunft, nicht die Zahl.
        List<RanglisteAbleitung.Wunsch> wunsch = new ArrayList<>();
        for (RanglisteEintragRequest e : req.eintraege() == null ? List.<RanglisteEintragRequest>of()
                : req.eintraege()) {
            wunsch.add(new RanglisteAbleitung.Wunsch(e.art(), e.entityId()));
        }
        return rangliste.speichere(siteId, wunsch,
                caller == null ? "unbekannt" : caller.getSubject());
    }

    private void requireSite(UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
    }

    /**
     * Jede Ablehnung kommt als deutscher Satz an - die Rangliste ist eine
     * Kunden-Flaeche, ein nacktes 400 waere dort keine Auskunft (dieselbe
     * Disziplin wie auf {@code SiteChargingConfigController}).
     */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<java.util.Map<String, String>> handle(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(java.util.Map.of("message", e.getReason() == null ? "" : e.getReason()));
    }
}
