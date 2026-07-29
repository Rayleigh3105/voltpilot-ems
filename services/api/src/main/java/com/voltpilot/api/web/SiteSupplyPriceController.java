package com.voltpilot.api.web;

import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.repo.SiteSupplyPriceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.SupplyPriceDto;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * The structured supply-price sheet ({@code site_supply_price}) maintenance
 * surface of one Anlage (report vp-nacht-bezug-e7 §3.1, Stufe 2): the operator
 * enters their Preisblatt components (Netzentgelt-Arbeitspreis, Stromsteuer,
 * Konzessionsabgabe, Umlagen, Vertriebsaufschlag), the USt rate and the
 * Preisblatt-Stand, so the optimizer prices grid import as
 * {@code (spot + Σ Komponenten) × (1+USt)} instead of bare spot.
 *
 * <p>Tenant-scoped like every {@code /api/v1/sites/**} route
 * ({@link SiteProfileController} / {@link SiteFlowController} pattern): NO
 * {@code @PreAuthorize} - authentication + Postgres RLS are the fence, so a
 * foreign site is 404 (never 403), and a Portal-Admin reaches any tenant's
 * sheet through the {@code X-Tenant-Id} switcher on the SAME RLS-scoped path.
 *
 * <p>PATCH SEMANTICS (consistent with the site-update {@code COALESCE}
 * pattern): a field ABSENT from the request body keeps its stored value; a
 * field PRESENT with an explicit value is written - and an explicit
 * {@code null} CLEARS the component to "unknown" (which suppresses the
 * composition again once the last component is cleared). {@code ustPct} is
 * {@code NOT NULL}; a present {@code null} there is ignored (kept/defaulted),
 * never a constraint violation.
 *
 * <p>This endpoint only makes a maintained sheet possible - the optimizer's
 * behaviour changes when a component is actually saved (Stufe-1 semantics: a
 * maintained row activates the composition), never on its own.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/supply-price")
public class SiteSupplyPriceController {

    /** JSON field -> DB column (the writable allowlist). */
    private static final Map<String, String> NUMERIC_FIELDS = Map.of(
            "netzentgeltArbeitspreisCt", "netzentgelt_arbeitspreis_ct",
            "stromsteuerCt", "stromsteuer_ct",
            "konzessionsabgabeCt", "konzessionsabgabe_ct",
            "umlagenCt", "umlagen_ct",
            "vertriebsaufschlagCt", "vertriebsaufschlag_ct");

    /** NUMERIC(6,3) upper bound for the component columns. */
    private static final BigDecimal COMPONENT_MAX = new BigDecimal("999.999");

    private final SiteSupplyPriceRepository supplyPrices;
    private final SiteRepository sites;

    public SiteSupplyPriceController(SiteSupplyPriceRepository supplyPrices, SiteRepository sites) {
        this.supplyPrices = supplyPrices;
        this.sites = sites;
    }

    @GetMapping
    public SupplyPriceDto get(@PathVariable UUID siteId) {
        requireSite(siteId);
        return supplyPrices.find(siteId);
    }

    @PutMapping
    public SupplyPriceDto put(@PathVariable UUID siteId,
            @RequestBody(required = false) Map<String, Object> body) {
        requireSite(siteId);
        UUID tenantId = TenantContext.get();
        if (tenantId == null) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Kein Mandant im Token.");
        }
        Map<String, Object> present = new LinkedHashMap<>();
        if (body != null) {
            for (Map.Entry<String, String> field : NUMERIC_FIELDS.entrySet()) {
                if (body.containsKey(field.getKey())) {
                    present.put(field.getValue(),
                            componentValue(field.getKey(), body.get(field.getKey())));
                }
            }
            if (body.containsKey("ustPct")) {
                Object raw = body.get("ustPct");
                if (raw != null) { // present-null on a NOT NULL column: keep/default
                    present.put("ust_pct", ustValue(raw));
                }
            }
            if (body.containsKey("komponentenStand")) {
                present.put("komponenten_stand", dateValue(body.get("komponentenStand")));
            }
        }
        return supplyPrices.upsert(siteId, tenantId, present);
    }

    /** RLS makes a foreign site invisible; that is a 404, not a 403. */
    private void requireSite(UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
    }

    /** A component value: null clears it; otherwise a non-negative ct/kWh amount. */
    private static BigDecimal componentValue(String field, Object raw) {
        if (raw == null) {
            return null;
        }
        BigDecimal v = number(raw, field);
        if (v.signum() < 0 || v.compareTo(COMPONENT_MAX) > 0) {
            throw badRequest("Bitte geben Sie " + field
                    + " als Betrag in ct/kWh zwischen 0 und 999,999 an.");
        }
        return v;
    }

    private static BigDecimal ustValue(Object raw) {
        BigDecimal v = number(raw, "ustPct");
        if (v.signum() < 0 || v.compareTo(new BigDecimal("100")) > 0) {
            throw badRequest("Der USt-Satz muss zwischen 0 und 100 % liegen.");
        }
        return v;
    }

    private static LocalDate dateValue(Object raw) {
        if (raw == null) {
            return null;
        }
        try {
            return LocalDate.parse(raw.toString());
        } catch (DateTimeParseException e) {
            throw badRequest("Der Preisblatt-Stand muss ein Datum (JJJJ-MM-TT) sein.");
        }
    }

    private static BigDecimal number(Object raw, String field) {
        if (raw instanceof Number n) {
            return new BigDecimal(n.toString());
        }
        try {
            return new BigDecimal(raw.toString().trim().replace(',', '.'));
        } catch (NumberFormatException e) {
            throw badRequest("Bitte geben Sie " + field + " als Zahl an.");
        }
    }

    private static ResponseStatusException badRequest(String message) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
    }

    /** German reasons reach the portal as {"message": ...} (MastrController pattern). */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
