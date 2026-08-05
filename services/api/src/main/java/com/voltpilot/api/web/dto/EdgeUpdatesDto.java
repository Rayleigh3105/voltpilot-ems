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
     *
     * <p>{@code label}/{@code siteName} sind {@code null}, wenn weder das Gerät
     * noch ein Namens-Schnappschuss existiert - eine UUID wird ausdrücklich NIE
     * geliefert (sie beantwortet die Frage der Zeile nicht). {@code removed}
     * sagt, dass dieses Gerät die Plattform inzwischen VERLASSEN hat: die
     * Wellen-Definition ist eingefroren, ein Unclaim + Re-Claim prägt aber eine
     * neue Geräte-Id - und „ist weg" ist etwas anderes als „meldet sich nicht".
     */
    public record WaveDeviceDto(UUID deviceId, String label, String siteName, String tenantName,
            String state, String reason, Instant since, Long bakeRemainingMinutes,
            String bakeCycle, String bakeReason, boolean removed) {
    }

    /**
     * Eine Zeile der Flotten-Matrix: Anlage · Mandant · Ist · Soll · Zustand ·
     * seit · Grund (§7.1 Punkt 3).
     *
     * <p>{@code ist} ist der gemeldete Stempel VERBATIM ({@code null} =
     * unbekannt, NIE „veraltet"); {@code soll} ist {@code null}, wenn dem Gerät
     * nichts zugewiesen ist.
     *
     * <p>{@code blocker} ist der maschinenlesbare Name einer STEHENDEN Sperre
     * ({@code otaapply.Blocker*}) - er trägt den HEBEL, den die Oberfläche
     * nennen kann, ohne den deutschen Grund nach Stichworten zu durchsuchen.
     * {@code null} heißt „kein Name gemeldet"; der Zustand {@code blockiert}
     * kann dann trotzdem gelten (ein älterer Edge-Stand meldet nur den Satz).
     *
     * <p>{@code label} ist der ANZEIGE-Name (Gerätename, sonst die Referenz),
     * {@code externalRef} die Referenz selbst - der geteilte Geräte-Drawer
     * zeigt beide, und die Referenz als „Name" auszugeben wäre auf einem
     * benannten Gerät schlicht falsch.
     */
    public record FleetRowDto(UUID deviceId, String label, String externalRef,
            UUID siteId, String siteName,
            UUID tenantId, String tenantName, String ist, String soll, Long sollSeq,
            String channel, boolean pinned, String state, String reason, String blocker,
            Instant since, Instant reportedAt, UUID rolloutId, TrustDto trust, ApplyDto apply) {
    }

    /**
     * Was mit dem ANWENDEN dieses Geräts gerade ist (Portal-Apply, §6/E3).
     *
     * <p>Er steht NEBEN {@code state}, nicht darin - dieselbe Begründung, aus
     * der {@code blocker} neben {@code reason} steht: {@code state} beantwortet
     * „was ist mit dem GERÄT", dieser Block „was ist mit der FREIGABE". Ein
     * Gerät kann gleichzeitig {@code wartet_auf_anwendung} sein und eine
     * Freigabe offen, abgeholt oder verfallen haben; jede Vermischung
     * verschluckte einen der beiden Sätze.
     *
     * <p>{@code canApply} ist die vom GERÄT gemeldete Fähigkeit und
     * DREIWERTIG: {@code null} = ein älterer Edge-Stand meldet sie nicht, also
     * unbekannt - NIE „geht nicht"; {@code false} = die Box sagt selbst, dass
     * dort gerade nichts angewandt werden kann (meist läuft kein
     * Aktualisierer); {@code true} = sie würde eine Freigabe aufgreifen. Sie
     * ist eine Fähigkeit, nie eine Erlaubnis.
     *
     * <p>{@code state}/{@code reason} beschreiben eine ERTEILTE Freigabe
     * ({@code erteilt} · {@code abgeholt} · {@code verfallen}) und sind
     * {@code null}, solange es keine gibt - über etwas, das nie erteilt wurde,
     * wird nichts behauptet.
     */
    public record ApplyDto(Boolean canApply, String state, String reason, String release,
            Instant requestedAt, String requestedBy) {
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
     *
     * <p>{@code waitingForAdmin} ist das „Sie sind dran"-Signal: Geräte im
     * Zustand {@code wartet_auf_anwendung}, plus eine freigebbare Welle. Ohne
     * es ist der EINZIGE Zustand, in dem sich ohne den Betreiber nie wieder
     * etwas bewegt, unsichtbar, bis jemand die Seite öffnet.
     */
    public record KpiDto(int known, int upToDate, int unknown, int inRollout, int failed,
            int waitingForAdmin, String newestRelease) {
    }
}
