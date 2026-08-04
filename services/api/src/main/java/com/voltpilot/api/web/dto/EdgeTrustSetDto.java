package com.voltpilot.api.web.dto;

import java.time.Instant;

/**
 * Das aktuell gültige root-signierte Trust-Set - die ADMIN-Sicht (die
 * öffentliche Ausliefer-Sicht ist {@link PublicTrustSetDto} und trägt bewusst
 * nur die zwei Dateien).
 *
 * <p>{@code trustSet} sind die EXAKTEN Bytes von {@code trust-set.json},
 * {@code signature} die der abgetrennten {@code trust-set.json.sig}. Sie reisen
 * unverändert - die Signatur der kalten Wurzel geht über genau diese Bytes.
 *
 * <p>{@code keyIds} (sortiert, komma-getrennt) und {@code signingKeyId} sind
 * ABGELEITET und nur für die Anzeige da: welchen RELEASE-Schlüsseln die Flotte
 * mit diesem Set traut, und welcher WURZEL-Schlüssel das unterschrieben hat.
 * Die Wahrheit bleiben die Bytes. {@code generatedAt} ist das, was das Dokument
 * ÜBER SICH SELBST behauptet (im Kontrakt optional, also {@code null}-fähig) -
 * {@code uploadedAt} ist, wann es hier ankam.
 */
public record EdgeTrustSetDto(String trustSet, String signature, String keyIds,
        String signingKeyId, String generatedAt, Instant uploadedAt, String uploadedBy) {
}
