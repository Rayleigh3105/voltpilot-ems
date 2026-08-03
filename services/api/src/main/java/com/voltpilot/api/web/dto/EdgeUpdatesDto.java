package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Der EINE Lese-Aggregat hinter {@code GET /api/v1/admin/edge-updates}: alles,
 * was die Plattform-Seite „Edge-Updates" (Scout §7.3) zeigt - Releases, der
 * aktive Rollout mit seinem Wellen-Board, die Flotten-Matrix und das Journal.
 *
 * <p>Er folgt der Disziplin von {@link AdminFleetDto}: server-seitig
 * aggregiert (keine Client-Schleife), und <b>was niemand gemessen hat, ist
 * {@code null} und trägt seinen Grund</b> - nie eine erfundene Null, nie ein
 * geratener Zustand.
 */
public record EdgeUpdatesDto(List<ReleaseDto> releases, RolloutDto activeRollout,
        List<FleetRowDto> fleet, List<EventDto> journal, KpiDto kpi) {

    /**
     * Ein Eintrag des Release-Registers, neueste zuerst.
     *
     * <p>{@code signed} ist die Bedingung für einen Rollout: nur ein signiertes
     * Release kann verteilt werden, weil nur dann Manifest-Bytes existieren,
     * die ein Gerät gegen seine eingebackene Wurzel prüfen kann. Ein
     * Stufe-0-Eintrag liest sich ehrlich als „nicht signiert".
     */
    public record ReleaseDto(long releaseSeq, String version, String targetCommit, String notes,
            boolean signed, String signingKeyId, Instant createdAt, int runningOnDevices) {
    }

    /**
     * Der aktive Rollout mit seinem Wellen-Board.
     *
     * <p>{@code canPromote}/{@code promoteBlockedReason}: die nächste Welle ist
     * gesperrt, bis das Bake-Kriterium erfüllt ist - und der GRUND steht dabei
     * (verbleibende Zeit bzw. fehlender Steuerzyklus). Ein deaktivierter Knopf
     * ohne Begründung ist eine Sackgasse.
     */
    public record RolloutDto(UUID id, String releaseVersion, long releaseSeq, String channel,
            String state, int currentWave, int waveCount, String haltedReason, String createdBy,
            Instant createdAt, boolean canPromote, String promoteBlockedReason,
            boolean autoAdvance, String advanceNote, List<WaveDto> waves) {
    }

    /** Eine Welle: ihre Geräte und ob sie vollständig bestätigt ist. */
    public record WaveDto(int index, String name, boolean released, boolean confirmed,
            List<WaveDeviceDto> devices) {
    }

    /**
     * Ein Gerät innerhalb einer Welle.
     *
     * <p>{@code bakeCycle} ist DREIWERTIG ({@code erfuellt}/{@code offen}/
     * {@code nicht_pruefbar}) - siehe {@code BakeGate}: auf einer Anlage, auf
     * der VoltPilot nicht steuert, ist ein echter Steuerzyklus strukturell
     * nicht zu belegen, und das wird gesagt statt unterstellt.
     */
    public record WaveDeviceDto(UUID deviceId, String label, String siteName, String tenantName,
            String state, String reason, Instant since, Long bakeRemainingMinutes,
            String bakeCycle, String bakeReason) {
    }

    /**
     * Eine Zeile der Flotten-Matrix: Anlage · Mandant · Ist · Soll · Zustand ·
     * seit · Grund (§7.1 Punkt 3).
     *
     * <p>{@code ist} ist der gemeldete Stempel VERBATIM ({@code null} =
     * unbekannt, NIE „veraltet"); {@code soll} ist {@code null}, wenn dem Gerät
     * nichts zugewiesen ist.
     */
    public record FleetRowDto(UUID deviceId, String label, UUID siteId, String siteName,
            UUID tenantId, String tenantName, String ist, String soll, Long sollSeq,
            String channel, boolean pinned, String state, String reason, Instant since,
            Instant reportedAt, UUID rolloutId, TrustDto trust) {
    }

    /**
     * Die VERTRAUENS-IDENTITÄT eines Geräts (OTA Stufe 4): TOFU-Abschluss und
     * Rotations-Stand, so wie das Gerät sie GEPRÜFT gemeldet hat.
     *
     * <p><b>{@code null} heißt „unbekannt", nie „nicht gekreuzt".</b> Ein
     * älterer Edge-Stand meldet den Block gar nicht - und Abwesenheit als
     * Befund zu rendern wäre genau die Sorte Behauptung, gegen die die ganze
     * Fläche gebaut ist. Ein Gerät MIT Block, dessen {@code rootKeyIds} LEER
     * ist, ist dagegen ein belegter Befund: das Image trägt (noch) keine
     * Wurzel, der Crossover steht also aus - der dokumentierte Vor-TOFU-
     * Zustand, kein Fehler.
     */
    public record TrustDto(List<String> rootKeyIds, List<String> trustSetKeyIds,
            String trustSetGeneratedAt, String trustSetError) {
    }

    /** Ein Eintrag des Audit-Journals. */
    public record EventDto(long id, Instant at, String actor, String event, UUID rolloutId,
            UUID deviceId, String detail) {
    }

    /**
     * Die Puls-Karte „Edge-Updates": {@code n/m aktuell · k Rollout aktiv ·
     * j fehlgeschlagen}.
     *
     * <p><b>Prozentzahlen immer über die ERREICHBARE Menge</b> (§7 Grundsatz):
     * {@code known} zählt die Geräte, die überhaupt einen Stand gemeldet haben -
     * ein Gerät ohne Meldung geht weder in den Zähler noch in den Nenner ein,
     * denn über sein Alter ist nichts bekannt.
     */
    public record KpiDto(int known, int upToDate, int unknown, int inRollout, int failed,
            String newestRelease) {
    }
}
