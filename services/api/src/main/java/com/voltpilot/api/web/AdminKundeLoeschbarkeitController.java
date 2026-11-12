package com.voltpilot.api.web;

import com.voltpilot.api.kundenbereich.KundeDatenBestandRepository;
import com.voltpilot.api.kundenbereich.KundenbereichEnde;
import com.voltpilot.api.web.dto.KundeLoeschbarkeitDto;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Löschbarkeit eines Kundenbereichs (vp-kunde-sofort-loeschen): WANN der Betreiber löschen darf
 * — sofort (keine Daten, {@code KundeDatenBestand}) oder nach der Frist (IP-18) — und was das Löschen
 * umfasst. Nur lesend, nur {@code platform-admin}; der Löschweg selbst bleibt
 * {@code POST /api/v1/admin/tenants/{id}/delete} ({@link AdminController#deleteTenant}).
 *
 * <ul>
 *   <li>{@code GET /tenants/loeschbarkeit} — alle Kunden in EINEM Abruf, für die Kundenliste (Badge
 *       „beendet · sofort löschbar" und das Zeilen-Menü), ohne die Folgen.</li>
 *   <li>{@code GET /tenants/{tenantId}/loeschbarkeit} — ein Kunde mit den Folgen (Anlagen, nie
 *       gemeldete Boxen, Personen) für den Bestätigungs-Dialog; bei Daten die Datenarten-Liste,
 *       das „löschbar ab" und der Weg über den Gesamtabzug stehen dem Dialog damit zur Verfügung.</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/v1/admin")
@PreAuthorize("hasRole('platform-admin')")
public class AdminKundeLoeschbarkeitController {

    private final KundeDatenBestandRepository bestand;

    public AdminKundeLoeschbarkeitController(KundeDatenBestandRepository bestand) {
        this.bestand = bestand;
    }

    @GetMapping("/tenants/loeschbarkeit")
    public List<KundeLoeschbarkeitDto> alle() {
        return bestand.fuerAlle().stream().map(z -> dto(z, null)).toList();
    }

    @GetMapping("/tenants/{tenantId}/loeschbarkeit")
    public KundeLoeschbarkeitDto einer(@PathVariable UUID tenantId) {
        KundeDatenBestandRepository.Zeile zeile = bestand.fuerKunde(tenantId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Tenant not found"));
        KundeDatenBestandRepository.Folgen folgen = bestand.folgen(tenantId);
        return dto(zeile, new KundeLoeschbarkeitDto.FolgenDto(folgen.anlagen(), folgen.boxen(), folgen.personen()));
    }

    private static KundeLoeschbarkeitDto dto(KundeDatenBestandRepository.Zeile zeile,
            KundeLoeschbarkeitDto.FolgenDto folgen) {
        KundenbereichEnde beendet = zeile.beendet().orElse(null);
        boolean fristAbgelaufen = beendet != null && beendet.fristAbgelaufen(LocalDate.now(KundenbereichEnde.ZONE));
        return new KundeLoeschbarkeitDto(zeile.tenantId(), zeile.sofortLoeschbar(), zeile.datenarten(),
                beendet == null ? null : beendet.beendetAmTag().toString(),
                beendet == null ? null : beendet.loeschungFruehestens().toString(), fristAbgelaufen, folgen);
    }
}
