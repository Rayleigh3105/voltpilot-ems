package com.voltpilot.api.web;

import com.voltpilot.api.kundenbereich.KundeDatenBestandRepository;
import com.voltpilot.api.kundenbereich.KundenbereichEnde;
import com.voltpilot.api.web.dto.KundeLoeschbarkeitDto;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Was das sofortige Löschen eines Kundenbereichs umfasst (vp-kunde-sofort-loeschen-mit-daten): jeder
 * Kunde ist sofort löschbar, mit oder ohne Datenbestand - diese Route trägt nur noch die Fakten für
 * den Bestätigungs-Dialog. Nur lesend, nur {@code platform-admin}; der Löschweg selbst bleibt
 * {@code POST /api/v1/admin/tenants/{id}/delete} ({@link AdminController#deleteTenant}).
 *
 * <p>{@code GET /tenants/{tenantId}/loeschbarkeit} - ein Kunde mit den Folgen (Anlagen, nie
 * gemeldete Boxen, Personen) für den Bestätigungs-Dialog; bei Daten die Datenarten-Liste und der
 * Weg über den Gesamtabzug stehen dem Dialog damit zur Verfügung.
 */
@RestController
@RequestMapping("/api/v1/admin")
@PreAuthorize("hasRole('platform-admin')")
public class AdminKundeLoeschbarkeitController {

    private final KundeDatenBestandRepository bestand;

    public AdminKundeLoeschbarkeitController(KundeDatenBestandRepository bestand) {
        this.bestand = bestand;
    }

    @GetMapping("/tenants/{tenantId}/loeschbarkeit")
    public KundeLoeschbarkeitDto einer(@PathVariable UUID tenantId) {
        KundeDatenBestandRepository.Zeile zeile = bestand.fuerKunde(tenantId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Tenant not found"));
        KundeDatenBestandRepository.Folgen folgen = bestand.folgen(tenantId);
        KundenbereichEnde beendet = zeile.beendet().orElse(null);
        return new KundeLoeschbarkeitDto(zeile.tenantId(), zeile.datenarten(),
                beendet == null ? null : beendet.beendetAmTag().toString(),
                new KundeLoeschbarkeitDto.FolgenDto(folgen.anlagen(), folgen.boxen(), folgen.personen()));
    }
}
