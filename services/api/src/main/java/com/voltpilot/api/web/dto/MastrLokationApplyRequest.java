package com.voltpilot.api.web.dto;

import jakarta.validation.Valid;
import java.util.List;

/**
 * Persist the customer-CONFIRMED selection of a Lokations-Suche preview (S2,
 * Abschnitt 5.3 point 4) - one transaction, idempotent on {@code (site_id,
 * registry_unit_id)} like the single-unit {@link MastrApplyRequest}. Reuses
 * its {@code PvApply}/{@code StorageApply} shapes: the confirmed values
 * travel back from the client exactly like the single-unit apply (registry
 * data is a customer-confirmed prefill, not re-fetched ground truth).
 */
public record MastrLokationApplyRequest(
        @Valid List<MastrApplyRequest.PvApply> pv,
        @Valid List<MastrApplyRequest.StorageApply> storage) {

    public boolean isEmpty() {
        return (pv == null || pv.isEmpty()) && (storage == null || storage.isEmpty());
    }
}
