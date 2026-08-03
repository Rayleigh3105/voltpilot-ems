package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.PositiveOrZero;

/**
 * Platform-admin request to register an edge release (OTA Stufe 0, D5).
 *
 * <p>{@code version} must be the release tag {@code edge-JJJJ.MM.N} - the
 * controller validates the shape rather than accepting any string, because the
 * register is the ONE place that makes „veraltet" well-defined and a stray SHA
 * in it would re-introduce exactly the unordered comparison the register
 * exists to remove.
 *
 * <p>{@code releaseSeq} may be omitted: it then continues the register
 * (max + 1). Passing it explicitly is allowed but must be strictly greater
 * than every existing entry - the ordering is monotonic by construction, so a
 * later release can never sort below an earlier one.
 */
public record CreateEdgeReleaseRequest(
        @NotBlank String version,
        @PositiveOrZero Long releaseSeq,
        String targetCommit,
        String notes) {
}
