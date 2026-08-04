package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.NotBlank;

/**
 * Das root-signierte Trust-Set hochladen (Captain-Order 04.08.2026:
 * Trust-Set-Bereitstellung beim Einrichten automatisieren).
 *
 * <p>{@code trustSet} sind die EXAKTEN Bytes von {@code trust-set.json},
 * {@code signature} die von {@code trust-set.json.sig}. Beide werden
 * unverändert abgelegt und unverändert wieder ausgeliefert: die Signatur der
 * kalten Wurzel geht über genau diese Bytes, jede Umformatierung machte sie
 * lautlos unprüfbar (deshalb: nie durch {@code jq}, nie neu serialisiert, nie
 * in eine {@code jsonb}-Spalte).
 *
 * <p>Beide sind Pflicht: ein Set ohne seine Signatur ist wertlos (das Gerät
 * lehnt fail-closed ab), eine Signatur ohne die Bytes, über die sie geht,
 * erst recht.
 */
public record SaveEdgeTrustSetRequest(
        @NotBlank String trustSet,
        @NotBlank String signature) {
}
