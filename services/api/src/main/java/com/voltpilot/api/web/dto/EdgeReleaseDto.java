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
 * {@code targetCommit} die Papier-Spur ins Repo.
 *
 * <p><b>Seit OTA Stufe 1</b> trägt ein Eintrag zusätzlich die Signatur:
 * {@code manifest} sind die EXAKTEN Bytes des signierten {@code release.json},
 * {@code signature} die abgetrennte Signaturdatei daneben, {@code signingKeyId}
 * der Schlüssel, der unterschrieben hat. Die Bytes reisen unverändert durch -
 * die Signatur geht über sie, jede Umformung machte sie unprüfbar. Alle drei
 * sind {@code null} bei einem Stufe-0-Eintrag; das liest sich ehrlich als
 * „nicht signiert", nie als „geprüft".
 *
 * <p>Die api prüft die Signatur NICHT (siehe Migration V20260804000000): der
 * einzige Verifizierer, auf den es ankommt, ist das Gerät mit seiner
 * eingebackenen Wurzel.
 */
public record EdgeReleaseDto(long releaseSeq, String version, String targetCommit, String notes,
        Instant createdAt, String createdBy, String manifest, String signature,
        String signingKeyId,
        // Geräte & Updates G4 (additiv): „Was ist neu" - die Box-Änderungen seit
        // dem letzten Tag derselben Linie (CI); null = keine Angabe.
        java.util.List<String> aenderungen) {

    /** Die Vor-G4-Form ohne Änderungsliste. */
    public EdgeReleaseDto(long releaseSeq, String version, String targetCommit, String notes,
            Instant createdAt, String createdBy, String manifest, String signature,
            String signingKeyId) {
        this(releaseSeq, version, targetCommit, notes, createdAt, createdBy, manifest, signature,
                signingKeyId, null);
    }
}
