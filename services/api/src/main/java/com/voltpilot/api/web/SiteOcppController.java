package com.voltpilot.api.web;

import com.voltpilot.api.ocpp.OcppActionPolicy;
import com.voltpilot.api.ocpp.OcppRepository;
import com.voltpilot.api.ocpp.OcppTransactionEconomicsService;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.web.dto.OcppDto;
import java.time.Instant;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Tenant-scoped, strictly read-only OCPP 1.6 data API. There is intentionally
 * no POST/PUT/DELETE mapping in this controller: Slice 10 never contacts a
 * station; the dependent command-gateway PR owns that boundary.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/ocpp")
// AP-03 IP-3: or a customer account without realm role (KONTO_benutzer, KeycloakRealmRoleConverter).
// AP-03 IP-7: or a partner account in an accepted Unterstützung (KONTO_partner) — the gate is coarse; @Recht and the
// level from the Zuweisung decide (a partner without Unterstützung never gets past ZugriffFilter: 404).
@PreAuthorize("hasAnyRole('operator', 'admin', 'site-admin', 'platform-admin') or hasAuthority('KONTO_benutzer') "
        + "or hasAuthority('KONTO_partner')")
public class SiteOcppController {
    private final Geltungsbereich geltungsbereich;
    private final OcppRepository ocpp;
    private final OcppActionPolicy policy;
    private final OcppTransactionEconomicsService economics;

    public SiteOcppController(Geltungsbereich geltungsbereich, OcppRepository ocpp, OcppActionPolicy policy,
            OcppTransactionEconomicsService economics) {
        this.geltungsbereich = geltungsbereich;
        this.ocpp = ocpp;
        this.policy = policy;
        this.economics = economics;
    }

    @GetMapping("/stations")
    public List<OcppDto.Station> stations(@PathVariable UUID siteId) {
        requireSite(siteId);
        return ocpp.stations(siteId);
    }

    @GetMapping("/events")
    public List<OcppDto.ProtocolEvent> events(@PathVariable UUID siteId,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to,
            @RequestParam(required = false) String action,
            @RequestParam(required = false) String messageType,
            @RequestParam(defaultValue = "200") int limit) {
        requireSite(siteId);
        return ocpp.events(siteId, from, to, action, messageType, limit);
    }

    @GetMapping("/gaps")
    public List<OcppDto.DataGap> gaps(@PathVariable UUID siteId,
            @RequestParam(defaultValue = "200") int limit) {
        requireSite(siteId);
        return ocpp.gaps(siteId, limit);
    }

    @GetMapping("/transactions")
    public List<OcppDto.Transaction> transactions(@PathVariable UUID siteId,
            @RequestParam(defaultValue = "200") int limit) {
        requireSite(siteId);
        return ocpp.transactions(siteId, limit);
    }

    /**
     * „Ladungen" mit Herkunft und Geld (Konzept „Ein Ort fürs Laden" e1,
     * Scheibe 2): die beendeten Ladungen ALLER Ladepunkte der Anlage in einem
     * Kalendermonat (Europe/Berlin, Vorgabe der laufende Monat), mit Menge,
     * anteiligem Sonnenanteil und Euro auf derselben Preisgrundlage wie die
     * Erlöse - site-weit wie {@link #transactions}, der Aufrufer filtert nach
     * Ladepunkt über das Feld {@code chargePointId} im Ergebnis.
     */
    @GetMapping("/transactions/economics")
    public List<OcppDto.TransactionEconomics> transactionEconomics(@PathVariable UUID siteId,
            @RequestParam(required = false) String month) {
        requireSite(siteId);
        return economics.forMonth(siteId, parseMonth(month));
    }

    private static YearMonth parseMonth(String raw) {
        if (raw == null || raw.isBlank()) {
            return YearMonth.now(ZoneId.of("Europe/Berlin"));
        }
        try {
            return YearMonth.parse(raw);
        } catch (DateTimeParseException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "month muss „yyyy-MM“ sein.");
        }
    }

    @GetMapping("/meter-values")
    public List<OcppDto.MeterSample> meterValues(@PathVariable UUID siteId,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to,
            @RequestParam(required = false) String pointKey,
            @RequestParam(required = false) Integer transactionId,
            @RequestParam(defaultValue = "1000") int limit) {
        requireSite(siteId);
        return ocpp.meterSamples(siteId, from, to, pointKey, transactionId, limit);
    }

    @GetMapping("/configuration")
    public List<OcppDto.Configuration> configuration(@PathVariable UUID siteId,
            @RequestParam(required = false) String chargePointId) {
        requireSite(siteId);
        return ocpp.configurations(siteId, chargePointId);
    }

    @GetMapping("/action-permissions")
    public OcppDto.ActionPermissions permissions(@PathVariable UUID siteId, Authentication auth) {
        requireSite(siteId);
        return policy.permissions(auth, siteId);
    }

    private void requireSite(UUID siteId) {
        geltungsbereich.requireSite(siteId);
    }
}
