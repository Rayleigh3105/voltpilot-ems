package com.voltpilot.api.web.dto;

import java.time.Instant;

/**
 * Ein Eintrag des Release-Registers (OTA Stufe 0, Captain-Entscheid D5).
 *
 * <p><b>{@code releaseSeq} ist DIE Ordnung</b> - eine monotone Ganzzahl, nie
 * ein String- oder SHA-Vergleich. Das ist der ganze Punkt des Registers: der
 * gestempelte Versionsstring einer Bestands-Edge ist eine 12-stellige Hex-SHA,
 * und darauf gibt es keine sinnvolle Reihenfolge (der frühere
 * Zahlenblock-Vergleich las {@code 665d59b8…} als 665 und {@code 3bf8c038…} als
 * 3). Wer „neuer" sagen will, vergleicht {@code releaseSeq}.
 *
 * <p>{@code version} ist das menschenlesbare Tag {@code edge-JJJJ.MM.N};
 * {@code targetCommit} die Papier-Spur ins Repo. Signatur-Felder kommen in
 * Stufe 1 additiv dazu.
 */
public record EdgeReleaseDto(long releaseSeq, String version, String targetCommit, String notes,
        Instant createdAt, String createdBy) {
}
