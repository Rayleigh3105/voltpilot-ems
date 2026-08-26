package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Der EINE Lese-Aggregat hinter {@code GET /api/v1/admin/edge-updates}: alles,
 * was die Plattform-Seite „Edge-Updates" (Scout §7.3) zeigt - Releases, der
 * die jüngsten Aktualisierungen mit ihren Geräten, die Flotte und das Journal.
 *
 * <p>Er folgt der Disziplin von {@link AdminFleetDto}: server-seitig
 * aggregiert (keine Client-Schleife), und <b>was niemand gemessen hat, ist
 * {@code null} und trägt seinen Grund</b> - nie eine erfundene Null, nie ein
 * geratener Zustand.
 */
public record EdgeUpdatesDto(List<ReleaseDto> releases, List<RolloutDto> rollouts,
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
     * Die laufende bzw. zuletzt gestartete Aktualisierung: EIN Release, die
     * gewaehlten Geraete, ihr Fortschritt.
     *
     * <p>Seit der Vereinfachung vom 26.08.2026 gibt es hier keine Wellen, keinen
     * Kanal, kein Bake-Kriterium und keinen Freigabe-Knopf mehr - der Admin
     * waehlt Release und Geraete, alles Weitere passiert von selbst. Was bleibt,
     * ist die Beobachtung.
     */
    public record RolloutDto(UUID id, String releaseVersion, long releaseSeq,
            String state, String createdBy, Instant createdAt,
            int total, int confirmed, int failed, List<RolloutDeviceDto> devices) {
    }

    /**
     * Ein Geraet dieser Aktualisierung.
     *
     * <p>{@code label}/{@code siteName} sind ein SCHNAPPSCHUSS vom Zeitpunkt der
     * Zuweisung ({@code null} + {@code removed} bei einem inzwischen entfernten
     * Geraet): die Frage lautet „wie hiess dieses Geraet, ALS es in die
     * Aktualisierung kam" - ein Fremdschluessel wuerde die Historie beim Unclaim
     * loeschen oder ihn blockieren.
     */
    public record RolloutDeviceDto(UUID deviceId, String label, String siteName,
            String tenantName, String state, String reason, Instant since, boolean removed) {
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
            String state, String reason, String blocker,
            Instant since, Instant reportedAt, UUID rolloutId, TrustDto trust) {
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
     * <p>Ein „Sie sind dran"-Zähler existiert bewusst NICHT mehr: seit der
     * Vereinfachung vom 26.08.2026 wartet nach dem Klick auf „Aktualisieren"
     * niemand mehr auf einen Menschen.
     */
    public record KpiDto(int known, int upToDate, int unknown, int inRollout, int failed,
            String newestRelease) {
    }
}
