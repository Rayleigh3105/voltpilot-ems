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
 *
 * <p><b>Seit OTA Stufe 1</b> darf der Rumpf zusätzlich das signierte Release
 * tragen: {@code manifest} sind die EXAKTEN Bytes von {@code release.json},
 * {@code signature} die Bytes von {@code release.json.sig}. Sie werden
 * unverändert abgelegt (die Signatur geht über genau diese Bytes). Wird ein
 * Manifest mitgeschickt, GEWINNEN seine Angaben: Version, Sequenz und Commit
 * kommen dann daraus, und ein davon abweichender Wert im Rumpf ist ein Fehler
 * statt einer stillen Abweichung - das Register soll nie etwas anderes
 * behaupten als das, was unterschrieben wurde. Der fertige Rumpf entsteht
 * ohnehin aus {@code vp-ota sign} bzw. {@code vp-ota register}
 * (docs/ota-signing.md).
 */
public record CreateEdgeReleaseRequest(
        @NotBlank String version,
        @PositiveOrZero Long releaseSeq,
        String targetCommit,
        String notes,
        String manifest,
        String signature,
        String signingKeyId) {
}
